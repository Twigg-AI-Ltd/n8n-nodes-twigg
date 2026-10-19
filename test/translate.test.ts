import type { Message, Tool } from '@n8n/ai-node-sdk';
import { describe, expect, it } from 'vitest';

import {
	buildInputParts,
	cleanInputSchema,
	mapStopReason,
	splitConversation,
	toGenerateResult,
	toStreamChunks,
	toToolDefinitions,
	TwiggTranslateError,
} from '../nodes/shared/translate';
import { endTurnResponse, toolUseResponse } from './fixtures/responses';

const system: Message = { role: 'system', content: [{ type: 'text', text: 'You are a support bot.' }] };
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const assistantText = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const assistantToolCall: Message = {
	role: 'assistant',
	content: [
		{ type: 'text', text: 'Let me check.' },
		{ type: 'tool-call', toolCallId: 'toolu_01ORDER', toolName: 'get_order_status', input: '{"order_id":"1042"}' },
	],
};
const toolResult: Message = {
	role: 'tool',
	name: 'get_order_status',
	content: [{ type: 'tool-result', toolCallId: 'toolu_01ORDER', result: { status: 'shipped' } }],
};

describe('splitConversation', () => {
	it('sends the user message on the first call of a run', () => {
		const split = splitConversation([system, user('Where is my order 1042?')]);
		expect(split.system).toBe('You are a support bot.');
		expect(split.tail).toEqual([user('Where is my order 1042?')]);
		expect(split.replayedHistory).toBe(false);
	});

	it('sends only the tool results after a tool call round', () => {
		const split = splitConversation([system, user('Where is my order?'), assistantToolCall, toolResult]);
		expect(split.tail).toEqual([toolResult]);
		expect(split.toolNamesById.get('toolu_01ORDER')).toBe('get_order_status');
		expect(split.replayedHistory).toBe(false);
	});

	it('detects replayed history from a Memory node and still sends only the tail', () => {
		const split = splitConversation([system, user('Hi'), assistantText('Hello!'), user('What is my name?')]);
		expect(split.replayedHistory).toBe(true);
		expect(split.tail).toEqual([user('What is my name?')]);
	});

	it('joins several system messages and never sends them as parts', () => {
		const formatting: Message = { role: 'system', content: [{ type: 'text', text: 'Reply in JSON.' }] };
		const split = splitConversation([system, formatting, user('Hi')]);
		expect(split.system).toBe('You are a support bot.\n\nReply in JSON.');
		expect(split.tail).toEqual([user('Hi')]);
	});
});

describe('buildInputParts', () => {
	it('builds prompt parts with text and attachments', () => {
		const withFile: Message = {
			role: 'user',
			content: [
				{ type: 'text', text: 'What is this?' },
				{ type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
				{ type: 'file', mediaType: 'image/jpeg', data: new Uint8Array([255, 216, 255]), providerMetadata: { filename: 'a.jpg' } },
			],
		};
		expect(buildInputParts([withFile], new Map())).toEqual([
			{
				type: 'prompt',
				text: 'What is this?',
				media: [
					{ mime: 'image/png', data_base64: 'iVBORw0KGgo=', filename: undefined },
					{ mime: 'image/jpeg', data_base64: '/9j/', filename: 'a.jpg' },
				],
			},
		]);
	});

	it('builds tool results with the tool name from the matching call', () => {
		expect(buildInputParts([toolResult], new Map([['toolu_01ORDER', 'get_order_status']]))).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'toolu_01ORDER',
				tool_name: 'get_order_status',
				text: '{"status":"shipped"}',
				is_error: false,
			},
		]);
	});

	it('falls back to names this model returned earlier, then the message name, then fails', () => {
		const anonymous: Message = {
			role: 'tool',
			content: [{ type: 'tool-result', toolCallId: 'toolu_X', result: 'oops', isError: true }],
		};
		const fromKnown = buildInputParts([anonymous], new Map(), new Map([['toolu_X', 'lookup']]));
		expect(fromKnown[0]).toMatchObject({ tool_name: 'lookup', text: 'oops', is_error: true });

		const named = { ...anonymous, name: 'lookup_by_name' };
		expect(buildInputParts([named], new Map())[0]).toMatchObject({ tool_name: 'lookup_by_name' });

		expect(() => buildInputParts([anonymous], new Map())).toThrow(TwiggTranslateError);
	});

	it('renders list-shaped tool results as readable text', () => {
		const listResult: Message = {
			role: 'tool',
			name: 't',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'id',
					result: [
						{ type: 'text', text: 'line one' },
						{ type: 'text', text: 'line two' },
					],
				},
			],
		};
		expect(buildInputParts([listResult], new Map())[0]).toMatchObject({ text: 'line one\nline two' });
	});

	it('refuses to send an empty submission', () => {
		expect(() => buildInputParts([], new Map())).toThrow(/Nothing new/);
		expect(() => buildInputParts([{ role: 'user', content: [] }], new Map())).toThrow(/Nothing new/);
	});
});

describe('tools', () => {
	it('converts function tools and drops provider tools', () => {
		const tools: Tool[] = [
			{
				type: 'function',
				name: 'get_order_status',
				description: 'Look up an order',
				inputSchema: {
					$schema: 'http://json-schema.org/draft-07/schema#',
					type: 'object',
					properties: { order_id: { type: 'string' } },
					required: ['order_id'],
					additionalProperties: false,
				},
				strict: true,
			},
			{ type: 'provider', name: 'web_search' },
			{ type: 'function', name: 'noop', inputSchema: {} },
		];
		const definitions = toToolDefinitions(tools, (tool) => tool.inputSchema as Record<string, unknown>);
		expect(definitions).toEqual([
			{
				name: 'get_order_status',
				description: 'Look up an order',
				input_schema: {
					type: 'object',
					properties: { order_id: { type: 'string' } },
					required: ['order_id'],
					additionalProperties: false,
				},
				strict: true,
			},
			{ name: 'noop', description: null, input_schema: { type: 'object', properties: {} } },
		]);
	});

	it('strips schema metadata keys only', () => {
		expect(cleanInputSchema({ $id: 'x', title: 't', type: 'object', properties: { a: { title: 'keep' } } })).toEqual({
			type: 'object',
			properties: { a: { title: 'keep' } },
		});
	});
});

describe('response mapping', () => {
	it('maps a tool_use turn to a tool-call message', () => {
		const result = toGenerateResult(toolUseResponse);
		expect(result.id).toBe(toolUseResponse.run_id);
		expect(result.finishReason).toBe('tool-calls');
		expect(result.message).toEqual({
			id: toolUseResponse.run_id,
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Let me check that for you.' },
				{ type: 'tool-call', toolCallId: 'toolu_01ORDER', toolName: 'get_order_status', input: '{"order_id":"1042"}' },
			],
		});
		expect(result.usage).toEqual({
			promptTokens: 412,
			completionTokens: 58,
			totalTokens: 470,
			inputTokenDetails: { cacheRead: 0 },
			outputTokenDetails: { reasoning: 0 },
		});
		expect(result.providerMetadata).toMatchObject({
			twigg: { run_id: toolUseResponse.run_id, chat_id: toolUseResponse.chat_id, cost: '0.00211300', replayed: false },
		});
	});

	it('maps an end_turn with reasoning and cached tokens', () => {
		const result = toGenerateResult(endTurnResponse);
		expect(result.finishReason).toBe('stop');
		expect(result.message.content).toEqual([
			{ type: 'reasoning', text: 'The order shipped.' },
			{ type: 'text', text: 'Order 1042 shipped and arrives on 8 September.' },
		]);
		expect(result.usage).toMatchObject({ promptTokens: 550, completionTokens: 30, totalTokens: 580 });
		expect(result.usage?.inputTokenDetails).toEqual({ cacheRead: 400 });
		expect(result.usage?.outputTokenDetails).toEqual({ reasoning: 12 });
		expect(result.providerMetadata).toMatchObject({ twigg: { replayed: true } });
	});

	it('keeps unparsable tool arguments as the raw string and maps refusals to text', () => {
		const result = toGenerateResult({
			...toolUseResponse,
			content: [
				{ type: 'refusal', text: 'I cannot help with that.' },
				{ type: 'tool_call', tool_use_id: 'id', name: 'x', arguments: '{"cut' },
			],
			stop_reason: 'refusal',
		});
		expect(result.finishReason).toBe('content-filter');
		expect(result.message.content).toEqual([
			{ type: 'text', text: 'I cannot help with that.' },
			{ type: 'tool-call', toolCallId: 'id', toolName: 'x', input: '{"cut' },
		]);
	});

	it('maps every stop reason', () => {
		expect(mapStopReason('end_turn')).toBe('stop');
		expect(mapStopReason('stop_sequence')).toBe('stop');
		expect(mapStopReason('max_tokens')).toBe('length');
		expect(mapStopReason('tool_use')).toBe('tool-calls');
		expect(mapStopReason('refusal')).toBe('content-filter');
		expect(mapStopReason('aborted')).toBe('other');
	});

	it('turns a result into text, tool-call and finish chunks', () => {
		const chunks = toStreamChunks(toGenerateResult(toolUseResponse));
		expect(chunks).toEqual([
			{ type: 'text-delta', id: toolUseResponse.run_id, delta: 'Let me check that for you.' },
			{ type: 'tool-call-delta', id: 'toolu_01ORDER', name: 'get_order_status', argumentsDelta: '{"order_id":"1042"}' },
			{ type: 'finish', finishReason: 'tool-calls', usage: expect.objectContaining({ totalTokens: 470 }) },
		]);
	});
});
