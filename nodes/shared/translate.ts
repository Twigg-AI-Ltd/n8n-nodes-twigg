import type {
	ContentFile,
	ContentToolCall,
	ContentToolResult,
	FinishReason,
	GenerateResult,
	Message,
	MessageContent,
	StreamChunk,
	Tool,
} from '@n8n/ai-node-sdk';

import type {
	ResponseBody,
	ResponseContent,
	StopReason,
	SubmittedMedia,
	SubmittedPart,
	ToolDefinition,
} from './types';

/** A problem with the conversation n8n handed over, before any request is made. */
export class TwiggTranslateError extends Error {
	constructor(
		message: string,
		readonly description?: string,
	) {
		super(message);
		this.name = 'TwiggTranslateError';
	}
}

export type SplitConversation = {
	/** All system messages joined; sent as the per-request `system` prompt. */
	system: string | undefined;
	/** Messages after the last assistant message: the new user message, or this round's tool results. */
	tail: Message[];
	/** Tool names by tool call id, from every assistant message in the list. */
	toolNamesById: Map<string, string>;
	/** True when the list holds a completed earlier turn, i.e. a Memory node replayed history. */
	replayedHistory: boolean;
};

function textOf(content: MessageContent[]): string {
	return content
		.filter((block): block is Extract<MessageContent, { type: 'text' }> => block.type === 'text')
		.map((block) => block.text)
		.join('\n\n');
}

/**
 * Twigg keeps the transcript, so each call sends only what is new: everything after the last
 * assistant message. On the first call of a run that is the user's message; on later calls in
 * the same run it is the tool results the Agent produced.
 */
export function splitConversation(messages: Message[]): SplitConversation {
	const systemParts: string[] = [];
	const toolNamesById = new Map<string, string>();
	let lastAssistant = -1;
	let replayedHistory = false;

	messages.forEach((message, index) => {
		if (message.role === 'system') {
			const text = textOf(message.content);
			if (text.trim() !== '') systemParts.push(text);
		} else if (message.role === 'assistant') {
			lastAssistant = index;
			for (const block of message.content) {
				if (block.type === 'tool-call' && block.toolCallId) {
					toolNamesById.set(block.toolCallId, block.toolName);
				}
			}
		} else if (message.role === 'user' && lastAssistant >= 0) {
			// A user message after an assistant message is a completed earlier turn.
			replayedHistory = true;
		}
	});

	const tail = messages.slice(lastAssistant + 1).filter((message) => message.role !== 'system');
	return {
		system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
		tail,
		toolNamesById,
		replayedHistory,
	};
}

function toSubmittedMedia(block: ContentFile): SubmittedMedia | undefined {
	let data: string;
	if (typeof block.data === 'string') {
		data = block.data.startsWith('data:') ? block.data.slice(block.data.indexOf(',') + 1) : block.data;
	} else if (block.data) {
		data = Buffer.from(block.data).toString('base64');
	} else {
		return undefined;
	}
	if (data === '') return undefined;
	const filename = block.providerMetadata?.filename;
	return {
		mime: block.mediaType ?? 'application/octet-stream',
		data_base64: data,
		filename: typeof filename === 'string' ? filename : undefined,
	};
}

function toolResultText(block: ContentToolResult): string {
	const result: unknown = block.result;
	if (typeof result === 'string') return result;
	if (result === undefined || result === null) return '';
	if (Array.isArray(result)) {
		// Tool results converted from content blocks arrive as a list; keep their text readable.
		const texts = result
			.filter((item): item is { type: 'text'; text: string } => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && typeof (item as { text?: unknown }).text === 'string')
			.map((item) => item.text);
		if (texts.length === result.length) return texts.join('\n');
	}
	return JSON.stringify(result);
}

/**
 * Builds the `input` parts for one request from the new messages. Tool names are required by
 * Twigg on every tool result; they come from the assistant message that made the call, or from
 * `knownToolNames` (tool calls this model instance returned earlier in the execution).
 */
export function buildInputParts(
	tail: Message[],
	toolNamesById: Map<string, string>,
	knownToolNames: Map<string, string> = new Map(),
): SubmittedPart[] {
	const parts: SubmittedPart[] = [];
	for (const message of tail) {
		if (message.role === 'user') {
			const media = message.content
				.filter((block): block is ContentFile => block.type === 'file')
				.map(toSubmittedMedia)
				.filter((item): item is SubmittedMedia => item !== undefined);
			const text = textOf(message.content);
			if (text === '' && media.length === 0) continue;
			parts.push({ type: 'prompt', text, ...(media.length > 0 ? { media } : {}) });
		} else if (message.role === 'tool') {
			for (const block of message.content) {
				if (block.type !== 'tool-result') continue;
				const toolName =
					toolNamesById.get(block.toolCallId) ?? knownToolNames.get(block.toolCallId) ?? message.name;
				if (!toolName) {
					throw new TwiggTranslateError(
						`Tool result ${block.toolCallId} has no matching tool call`,
						'Twigg needs the tool name with every tool result. The conversation n8n passed has a tool result whose tool call is not in it.',
					);
				}
				parts.push({
					type: 'tool_result',
					tool_use_id: block.toolCallId,
					tool_name: toolName,
					text: toolResultText(block),
					is_error: block.isError === true,
				});
			}
		}
	}
	if (parts.length === 0) {
		throw new TwiggTranslateError(
			'Nothing new to send to Twigg',
			'The conversation has no user message or tool result after the last assistant message. Twigg already holds everything before it, so there is nothing to submit.',
		);
	}
	return parts;
}

/** Keys that describe a schema document rather than the object it describes. */
const SCHEMA_META_KEYS = new Set(['$schema', '$id', 'title']);

export function cleanInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (!SCHEMA_META_KEYS.has(key)) cleaned[key] = value;
	}
	if (cleaned.type === undefined) cleaned.type = 'object';
	if (cleaned.type === 'object' && cleaned.properties === undefined) cleaned.properties = {};
	return cleaned;
}

/**
 * Converts the tools the Agent bound into Twigg tool definitions. `toJsonSchema` is the SDK's
 * converter, injected so this module stays free of runtime dependencies.
 */
export function toToolDefinitions(
	tools: Tool[],
	toJsonSchema: (tool: Extract<Tool, { type: 'function' }>) => Record<string, unknown>,
): ToolDefinition[] {
	const definitions: ToolDefinition[] = [];
	for (const tool of tools) {
		if (tool.type !== 'function') continue;
		const definition: ToolDefinition = {
			name: tool.name,
			description: tool.description ?? null,
			input_schema: cleanInputSchema(toJsonSchema(tool)),
		};
		if (tool.strict !== undefined) definition.strict = tool.strict;
		definitions.push(definition);
	}
	return definitions;
}

export function mapStopReason(reason: StopReason): FinishReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'max_tokens':
			return 'length';
		case 'tool_use':
			return 'tool-calls';
		case 'refusal':
			return 'content-filter';
		case 'aborted':
			return 'other';
		default:
			return 'other';
	}
}

function toolCallInput(args: ResponseContent & { type: 'tool_call' }): string {
	return typeof args.arguments === 'string' ? args.arguments : JSON.stringify(args.arguments);
}

export function toMessageContent(content: ResponseContent[]): MessageContent[] {
	const blocks: MessageContent[] = [];
	for (const block of content) {
		switch (block.type) {
			case 'text':
			case 'refusal':
				blocks.push({ type: 'text', text: block.text });
				break;
			case 'reasoning':
				if (block.text !== '') blocks.push({ type: 'reasoning', text: block.text });
				break;
			case 'tool_call': {
				const toolCall: ContentToolCall = {
					type: 'tool-call',
					toolCallId: block.tool_use_id,
					toolName: block.name,
					input: toolCallInput(block),
				};
				blocks.push(toolCall);
				break;
			}
			default:
				break;
		}
	}
	return blocks;
}

/** What the Agent sees about the turn besides the message, under `response_metadata.twigg`. */
export function responseMetadata(body: ResponseBody): Record<string, unknown> {
	return {
		run_id: body.run_id,
		chat_id: body.chat_id,
		stop_reason: body.stop_reason,
		cost: body.cost,
		cost_currency: body.cost_currency,
		model_served: body.model_served,
		replayed: body.replayed,
		compaction: body.compaction ?? null,
		config_warnings: body.config_warnings ?? [],
		translation_warnings: body.translation_warnings ?? [],
		closed_tool_calls: body.closed_tool_calls ?? [],
	};
}

export function toGenerateResult(body: ResponseBody): GenerateResult {
	const usage = body.usage;
	const promptTokens = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
	return {
		id: body.run_id,
		finishReason: mapStopReason(body.stop_reason),
		message: {
			id: body.run_id,
			role: 'assistant',
			content: toMessageContent(body.content),
		},
		usage: {
			promptTokens,
			completionTokens: usage.output_tokens,
			totalTokens: promptTokens + usage.output_tokens,
			inputTokenDetails: { cacheRead: usage.cache_read_tokens },
			outputTokenDetails: { reasoning: usage.reasoning_tokens },
		},
		providerMetadata: { twigg: responseMetadata(body) },
	};
}

/**
 * The same result as a short stream: one delta per text block, one tool-call delta per call,
 * then `finish`. Reasoning is passed as a content block since the adapter has no reasoning delta.
 */
export function toStreamChunks(result: GenerateResult): StreamChunk[] {
	const chunks: StreamChunk[] = [];
	for (const block of result.message.content) {
		if (block.type === 'text') {
			chunks.push({ type: 'text-delta', id: result.id, delta: block.text });
		} else if (block.type === 'tool-call') {
			chunks.push({
				type: 'tool-call-delta',
				id: block.toolCallId,
				name: block.toolName,
				argumentsDelta: block.input,
			});
		} else if (block.type === 'reasoning') {
			chunks.push({ type: 'content', content: block, id: result.id });
		}
	}
	chunks.push({ type: 'finish', finishReason: result.finishReason ?? 'stop', usage: result.usage });
	return chunks;
}
