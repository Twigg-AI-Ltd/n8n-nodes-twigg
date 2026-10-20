import { describe, expect, it } from 'vitest';

import { MAX_IMPORT_PARTS, readMemoryMessages, toImportParts } from '../nodes/shared/history-import';
import { formatRate } from '../nodes/shared/models';

/** A LangChain-style stored message: a class instance with getType(). */
const msg = (type: string, fields: Record<string, unknown>) => ({ getType: () => type, ...fields });

describe('toImportParts', () => {
	it('maps a conversation with a tool round', () => {
		const parts = toImportParts([
			msg('system', { content: 'You are a support bot.' }),
			msg('human', { content: 'Where is order 1042?' }),
			msg('ai', { content: '', tool_calls: [{ id: 'call_1', name: 'lookup_order', args: { order_id: '1042' } }] }),
			msg('tool', { content: '{"status":"shipped"}', tool_call_id: 'call_1', name: 'lookup_order' }),
			msg('ai', { content: [{ type: 'text', text: 'It has shipped.' }] }),
		]);
		expect(parts).toEqual([
			{ type: 'prompt', text: 'Where is order 1042?' },
			{ type: 'tool_call', tool_use_id: 'call_1', name: 'lookup_order', arguments: { order_id: '1042' } },
			{ type: 'tool_result', tool_use_id: 'call_1', tool_name: 'lookup_order', text: '{"status":"shipped"}' },
			{ type: 'message', text: 'It has shipped.' },
		]);
	});

	it('reads serialised messages and OpenAI-style tool calls', () => {
		const parts = toImportParts([
			{ type: 'human', data: { content: 'Hi' } },
			{
				type: 'ai',
				data: {
					content: 'Checking.',
					additional_kwargs: { tool_calls: [{ id: 'c9', function: { name: 'search', arguments: '{"q":"x"}' } }] },
				},
			},
			{ type: 'tool', data: { content: 'found', tool_call_id: 'c9' } },
		]);
		expect(parts).toEqual([
			{ type: 'prompt', text: 'Hi' },
			{ type: 'message', text: 'Checking.' },
			{ type: 'tool_call', tool_use_id: 'c9', name: 'search', arguments: '{"q":"x"}' },
			{ type: 'tool_result', tool_use_id: 'c9', tool_name: 'search', text: 'found' },
		]);
	});

	it('drops empty messages and tool results without a call, and fills in missing call ids', () => {
		const parts = toImportParts([
			msg('human', { content: '   ' }),
			msg('tool', { content: 'orphan', tool_call_id: 'nope' }),
			msg('ai', { content: '', tool_calls: [{ name: 'ping', args: {} }] }),
		]);
		expect(parts).toEqual([{ type: 'tool_call', tool_use_id: 'imported_call_1', name: 'ping', arguments: {} }]);
	});

	it('keeps the newest parts when the history is over the import cap', () => {
		const many = Array.from({ length: MAX_IMPORT_PARTS + 5 }, (_, i) => msg('human', { content: `m${i}` }));
		const parts = toImportParts(many);
		expect(parts).toHaveLength(MAX_IMPORT_PARTS);
		expect(parts[0]).toEqual({ type: 'prompt', text: 'm5' });
	});
});

describe('readMemoryMessages', () => {
	it('reads the full chat history, not the windowed memory load', async () => {
		const memory = {
			chatHistory: { getMessages: async () => ['a', 'b', 'c'] },
			loadMemoryVariables: async () => ({ chat_history: ['c'] }),
		};
		expect(await readMemoryMessages(memory)).toEqual(['a', 'b', 'c']);
	});

	it('falls back to the memory load when there is no chat history', async () => {
		expect(await readMemoryMessages({ loadMemoryVariables: async () => ({ history: ['x'] }) })).toEqual(['x']);
	});

	it('refuses something that is not a memory', async () => {
		await expect(readMemoryMessages({})).rejects.toThrow(/not a chat memory/);
	});
});

describe('formatRate', () => {
	it('shows prices the way people read them', () => {
		expect(formatRate('10.500000000000')).toBe('$10.5');
		expect(formatRate('0.262500000000')).toBe('$0.2625');
		expect(formatRate('0.105000000000')).toBe('$0.105');
		expect(formatRate('0.875700000000')).toBe('$0.8757');
		expect(formatRate(null)).toBe('?');
		expect(formatRate('n/a')).toBe('?');
	});
});
