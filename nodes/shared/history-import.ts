import type { TwiggClient } from './client';
import { TwiggApiError } from './errors';
import type { ImportHistoryResponse, ImportPart, OpenChatRequest } from './types';

/**
 * Moving a conversation out of an n8n Memory node into Twigg. Used lazily by the Twigg AI Agent
 * (once per chat, on its first message) and in bulk by the Twigg node's Import History operation.
 * The old memory is only read, never changed, so a workflow can always switch back.
 */

/** The import endpoint's per-request cap; older parts beyond it are left out. */
export const MAX_IMPORT_PARTS = 2000;

type StoredMessage = {
	getType?: () => string;
	_getType?: () => string;
	type?: string;
	role?: string;
	content?: unknown;
	name?: string;
	tool_calls?: unknown;
	tool_call_id?: string;
	additional_kwargs?: { tool_calls?: unknown };
	data?: StoredMessage;
};

/**
 * Every stored message of the memory's session. Reads the chat history directly: the memory's own
 * load applies its context window ("last 10 messages"), which would import only the tail.
 */
export async function readMemoryMessages(memory: unknown): Promise<unknown[]> {
	const history = (memory as { chatHistory?: { getMessages?: () => Promise<unknown[]> } } | null)?.chatHistory;
	if (history && typeof history.getMessages === 'function') {
		return (await history.getMessages()) ?? [];
	}
	const load = (memory as { loadMemoryVariables?: (values: object) => Promise<Record<string, unknown>> } | null)
		?.loadMemoryVariables;
	if (typeof load === 'function') {
		const variables = await load.call(memory, {});
		const messages = Object.values(variables).find(Array.isArray);
		if (messages) return messages;
	}
	throw new Error('The connected node is not a chat memory: it has no chat history to read');
}

function messageType(message: StoredMessage): string {
	for (const read of [message.getType, message._getType]) {
		if (typeof read === 'function') {
			try {
				return String(read.call(message));
			} catch {
				// Fall back to the plain fields below.
			}
		}
	}
	return String(message.type ?? message.role ?? '');
}

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => (typeof block === 'string' ? block : (block as { text?: unknown })?.text))
			.filter((text): text is string => typeof text === 'string')
			.join('\n\n');
	}
	return '';
}

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> | string };

/** Tool calls on an AI message, in LangChain's shape or OpenAI's (`additional_kwargs.tool_calls`). */
function toolCallsOf(message: StoredMessage): ToolCall[] {
	const calls: ToolCall[] = [];
	const langchain = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const call of langchain as Array<{ id?: string; name?: string; args?: unknown }>) {
		if (typeof call?.name !== 'string') continue;
		calls.push({ id: call.id ?? '', name: call.name, arguments: (call.args as Record<string, unknown>) ?? {} });
	}
	if (calls.length > 0) return calls;
	const openai = message.additional_kwargs?.tool_calls;
	for (const call of (Array.isArray(openai) ? openai : []) as Array<{
		id?: string;
		function?: { name?: string; arguments?: string };
	}>) {
		if (typeof call?.function?.name !== 'string') continue;
		calls.push({ id: call.id ?? '', name: call.function.name, arguments: call.function.arguments ?? '{}' });
	}
	return calls;
}

/**
 * Maps stored chat messages (LangChain message objects, or their serialised `{ type, data }` form)
 * onto import parts. System messages are left out: Twigg sends the system prompt with each request
 * instead of storing it. Tool results whose call is not in the history are left out too.
 */
export function toImportParts(messages: unknown[]): ImportPart[] {
	const parts: ImportPart[] = [];
	const toolNames = new Map<string, string>();
	let generated = 0;

	for (const raw of messages) {
		if (typeof raw !== 'object' || raw === null) continue;
		const outer = raw as StoredMessage;
		const message: StoredMessage = outer.data && !outer.getType && !outer._getType ? { ...outer.data, type: outer.type } : outer;
		const type = messageType(message).toLowerCase();
		const text = textOf(message.content).trim();

		if (type === 'human' || type === 'user') {
			if (text !== '') parts.push({ type: 'prompt', text });
		} else if (type === 'ai' || type === 'assistant') {
			if (text !== '') parts.push({ type: 'message', text });
			for (const call of toolCallsOf(message)) {
				const id = call.id || `imported_call_${++generated}`;
				toolNames.set(id, call.name);
				parts.push({ type: 'tool_call', tool_use_id: id, name: call.name, arguments: call.arguments });
			}
		} else if (type === 'tool') {
			const id = message.tool_call_id ?? '';
			const toolName = toolNames.get(id);
			if (!toolName) continue;
			parts.push({ type: 'tool_result', tool_use_id: id, tool_name: message.name ?? toolName, text });
		}
	}
	return parts.length > MAX_IMPORT_PARTS ? parts.slice(parts.length - MAX_IMPORT_PARTS) : parts;
}

/** True when the API has no import endpoint yet (it answers an unknown route with 404). */
export function isImportUnavailable(error: unknown): boolean {
	return error instanceof TwiggApiError && [404, 405, 501].includes(error.status);
}

export type ImportOutcome =
	| { status: 'imported'; parts: number; response: ImportHistoryResponse }
	| { status: 'skipped'; parts: number; response: ImportHistoryResponse }
	| { status: 'empty'; parts: 0 };

/** Reads the memory's session and imports it into the chat, which Twigg only does if the chat is empty. */
export async function importFromMemory(
	client: TwiggClient,
	externalId: string,
	chat: OpenChatRequest,
	memory: unknown,
	idempotencyKey?: string,
): Promise<ImportOutcome> {
	const parts = toImportParts(await readMemoryMessages(memory));
	if (parts.length === 0) return { status: 'empty', parts: 0 };
	const { body } = await client.importHistoryByExternalId(externalId, {
		...(Object.keys(chat).length > 0 ? { chat } : {}),
		parts,
		...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
	});
	return body.skipped
		? { status: 'skipped', parts: parts.length, response: body }
		: { status: 'imported', parts: parts.length, response: body };
}

/** Whether the chat has no history on Twigg yet, so an import would apply. */
export async function chatIsEmpty(client: TwiggClient, externalId: string): Promise<boolean> {
	const chat = await client.findChatByExternalId(externalId);
	return !chat?.length;
}
