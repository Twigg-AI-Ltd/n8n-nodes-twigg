import type {
	ChatModel,
	ChatModelConfig,
	GenerateResult,
	Message,
	StreamChunk,
	Tool,
} from '@n8n/ai-node-sdk';

import type { TwiggClient } from '../shared/client';
import { buildIdempotencyKey } from '../shared/ids';
import {
	buildInputParts,
	splitConversation,
	toGenerateResult,
	toStreamChunks,
	toToolDefinitions,
} from '../shared/translate';
import type { CreateResponseRequest, ReasoningEffort, ToolDefinition } from '../shared/types';

export type TwiggModelSettings = {
	model: string;
	/** The id in the URL path, already validated or hashed. */
	externalId: string;
	/** Sent as `chat` on every request; ignored by the API once the chat exists. */
	chat?: { namespace?: string; title?: string };
	maxTokens?: number;
	reasoningEffort?: ReasoningEffort;
	/** `wait_for_pending_tool_calls`, in seconds. Omitted when undefined. */
	pendingToolCallWindowSeconds?: number;
	/** What makes an idempotency key unique to this n8n run: execution id, node id, item index. */
	idempotencyScope: unknown[];
};

export type TwiggModelHooks = {
	warn: (message: string, meta?: Record<string, unknown>) => void;
	toJsonSchema: (tool: Extract<Tool, { type: 'function' }>) => Record<string, unknown>;
};

/** State shared by every `withTools` clone of a model within one execution. */
type SharedState = {
	/** Tool names by tool call id, from the responses this model already returned. */
	toolNamesById: Map<string, string>;
	warnedReplayedHistory: boolean;
};

/**
 * The Twigg chat model as n8n's AI node SDK sees it. It implements the SDK's `ChatModel`
 * interface directly (rather than extending its base class) so this file has no runtime import
 * of the SDK and the logic can be unit-tested on its own.
 */
export class TwiggChatModel implements ChatModel {
	readonly provider = 'twigg';
	readonly modelId: string;
	readonly defaultConfig?: ChatModelConfig;

	constructor(
		private readonly client: TwiggClient,
		private readonly settings: TwiggModelSettings,
		private readonly hooks: TwiggModelHooks,
		private readonly tools: Tool[] = [],
		private readonly shared: SharedState = { toolNamesById: new Map(), warnedReplayedHistory: false },
	) {
		this.modelId = settings.model;
	}

	withTools(tools: Tool[]): ChatModel {
		return new TwiggChatModel(this.client, this.settings, this.hooks, [...this.tools, ...tools], this.shared);
	}

	/** The request this conversation state produces, without sending it. Exposed for tests. */
	buildRequest(messages: Message[], config?: ChatModelConfig): CreateResponseRequest {
		const { system, tail, toolNamesById, replayedHistory } = splitConversation(messages);
		if (replayedHistory && !this.shared.warnedReplayedHistory) {
			this.shared.warnedReplayedHistory = true;
			this.hooks.warn(
				'Twigg Chat Model received earlier conversation turns, which usually means a Memory node is connected to the Agent. Twigg stores the conversation itself; remove the Memory node to avoid sending history twice.',
			);
		}
		const input = buildInputParts(tail, toolNamesById, this.shared.toolNamesById);
		const tools: ToolDefinition[] = toToolDefinitions(this.tools, this.hooks.toJsonSchema);

		const request: CreateResponseRequest = {
			model: this.settings.model,
			input,
			stream: false,
		};
		if (system !== undefined) request.system = system;
		if (tools.length > 0) request.tools = tools;
		const maxTokens = config?.maxTokens ?? this.settings.maxTokens;
		if (maxTokens !== undefined && maxTokens > 0) request.max_tokens = maxTokens;
		if (this.settings.reasoningEffort !== undefined) request.reasoning_effort = this.settings.reasoningEffort;
		if (this.settings.pendingToolCallWindowSeconds !== undefined) {
			request.wait_for_pending_tool_calls = this.settings.pendingToolCallWindowSeconds;
		}
		if (this.settings.chat && Object.keys(this.settings.chat).length > 0) request.chat = this.settings.chat;

		// Same scope + same submission => same key => a retry replays the stored result.
		request.idempotency_key = buildIdempotencyKey([
			...this.settings.idempotencyScope,
			this.settings.externalId,
			request.model,
			request.system ?? null,
			request.tools ?? null,
			request.max_tokens ?? null,
			request.reasoning_effort ?? null,
			input,
		]);
		return request;
	}

	async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> {
		const request = this.buildRequest(messages, config);
		const body = await this.client.createResponseByExternalId(this.settings.externalId, request);
		for (const block of body.content) {
			if (block.type === 'tool_call') this.shared.toolNamesById.set(block.tool_use_id, block.name);
		}
		return toGenerateResult(body);
	}

	async *stream(messages: Message[], config?: ChatModelConfig): AsyncIterable<StreamChunk> {
		const result = await this.generate(messages, config);
		yield* toStreamChunks(result);
	}
}
