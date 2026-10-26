import type { TwiggClient } from './client';
import { TwiggApiError } from './errors';
import type { ImportHistoryResponse, ImportPart, OpenChatRequest } from './types';

/**
 * Moving a conversation out of an n8n Memory node into Twigg. Used by the Twigg agent's
 * "Use External Memory" (once per chat, before its first message on Twigg) and in bulk by the Twigg
 * node's Import All. The old memory is only read, never changed, so a workflow can always switch back.
 *
 * Twigg repairs what it can (unmatched tool results, unanswered calls, odd tool names) and reports it
 * in warnings; this side only makes sure a request is accepted: within the part cap and field limits.
 */

/** Parts per import. Only an empty chat can be imported into, so a longer history keeps its newest parts. */
export const MAX_IMPORT_PARTS = 500;
const TEXT_LIMIT = 500_000;
const TOOL_TEXT_LIMIT = 1_000_000;
const ID_LIMIT = 256;
const NAME_LIMIT = 128;
const TRUNCATED = '\n[truncated on import]';

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

function clip(text: string, limit: number): string {
	return text.length <= limit ? text : text.slice(0, limit - TRUNCATED.length) + TRUNCATED;
}

/** Tool call arguments as the endpoint takes them: a JSON object, within the size limit. */
function importArguments(raw: unknown): Record<string, unknown> | string {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			value = { input: value };
		}
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) value = { input: value };
	const object = value as Record<string, unknown>;
	return JSON.stringify(object).length <= TOOL_TEXT_LIMIT ? object : { note: 'arguments too large to import' };
}

type ToolCall = { id: string; name: string; arguments: unknown };

/** Tool calls on an AI message, in LangChain's shape or OpenAI's (`additional_kwargs.tool_calls`). */
function toolCallsOf(message: StoredMessage): ToolCall[] {
	const calls: ToolCall[] = [];
	const langchain = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const call of langchain as Array<{ id?: string; name?: string; args?: unknown }>) {
		if (typeof call?.name !== 'string') continue;
		calls.push({ id: call.id ?? '', name: call.name, arguments: call.args ?? {} });
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
 * onto import parts, within the endpoint's field limits. System messages are left out: the system
 * prompt is sent with each request instead of stored. Tool results whose call is not in the history
 * are left out too.
 */
export function toImportParts(messages: unknown[]): ImportPart[] {
	const parts: ImportPart[] = [];
	/** Tool calls by their original id: the id sent to Twigg (replaced when too long) and the tool name. */
	const calls = new Map<string, { id: string; name: string }>();
	let generated = 0;

	for (const raw of messages) {
		if (typeof raw !== 'object' || raw === null) continue;
		const outer = raw as StoredMessage;
		const message: StoredMessage =
			outer.data && !outer.getType && !outer._getType ? { ...outer.data, type: outer.type } : outer;
		const type = messageType(message).toLowerCase();
		const text = textOf(message.content).trim();

		if (type === 'human' || type === 'user') {
			if (text !== '') parts.push({ type: 'prompt', text: clip(text, TEXT_LIMIT) });
		} else if (type === 'ai' || type === 'assistant') {
			if (text !== '') parts.push({ type: 'message', text: clip(text, TEXT_LIMIT) });
			for (const call of toolCallsOf(message)) {
				const name = call.name.slice(0, NAME_LIMIT);
				if (name === '') continue;
				const id = call.id && call.id.length <= ID_LIMIT ? call.id : `imported_call_${++generated}`;
				if (call.id) calls.set(call.id, { id, name });
				parts.push({ type: 'tool_call', tool_use_id: id, name, arguments: importArguments(call.arguments) });
			}
		} else if (type === 'tool') {
			const call = calls.get(message.tool_call_id ?? '');
			if (!call) continue;
			parts.push({
				type: 'tool_result',
				tool_use_id: call.id,
				tool_name: (message.name || call.name).slice(0, NAME_LIMIT),
				text: clip(text, TOOL_TEXT_LIMIT),
			});
		}
	}
	return parts;
}

/** The newest parts that fit one import, and how many older ones were left out. */
export function capParts(parts: ImportPart[]): { parts: ImportPart[]; leftOut: number } {
	const leftOut = Math.max(0, parts.length - MAX_IMPORT_PARTS);
	return { parts: leftOut > 0 ? parts.slice(leftOut) : parts, leftOut };
}

/** True when the API has no import endpoint (it answers an unknown route with 404). */
export function isImportUnavailable(error: unknown): boolean {
	return error instanceof TwiggApiError && [404, 405, 501].includes(error.status);
}

export type ImportOutcome =
	| { status: 'imported'; sent: number; leftOut: number; response: ImportHistoryResponse }
	| { status: 'skipped'; sent: number; leftOut: number; response: ImportHistoryResponse }
	| { status: 'empty'; sent: 0; leftOut: 0 };

/** Reads the memory's session and imports it into the chat, which Twigg only does if the chat is empty. */
export async function importFromMemory(
	client: TwiggClient,
	externalId: string,
	chat: OpenChatRequest,
	memory: unknown,
): Promise<ImportOutcome> {
	const { parts, leftOut } = capParts(toImportParts(await readMemoryMessages(memory)));
	if (parts.length === 0) return { status: 'empty', sent: 0, leftOut: 0 };
	const { body } = await client.importHistoryByExternalId(externalId, {
		...(Object.keys(chat).length > 0 ? { chat } : {}),
		parts,
	});
	return { status: body.skipped ? 'skipped' : 'imported', sent: parts.length, leftOut, response: body };
}

/** Whether the chat has no history on Twigg yet, so an import would apply. */
export async function chatIsEmpty(client: TwiggClient, externalId: string): Promise<boolean> {
	const chat = await client.findChatByExternalId(externalId);
	return !chat?.length;
}
