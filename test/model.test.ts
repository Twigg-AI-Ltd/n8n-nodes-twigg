import type { Message, Tool } from '@n8n/ai-node-sdk';
import { describe, expect, it } from 'vitest';

import { TwiggChatModel } from '../nodes/LmChatTwigg/TwiggChatModel';
import type { TwiggModelSettings } from '../nodes/LmChatTwigg/TwiggChatModel';
import { TwiggClient } from '../nodes/shared/client';
import type { HttpRequestSpec } from '../nodes/shared/client';
import type { CreateResponseRequest, ResponseBody } from '../nodes/shared/types';
import { endTurnResponse, toolUseResponse } from './fixtures/responses';

function harness(responses: ResponseBody[], settingsOverrides: Partial<TwiggModelSettings> = {}) {
	const calls: HttpRequestSpec[] = [];
	const warnings: string[] = [];
	const client = new TwiggClient({
		request: async (spec) => {
			calls.push(spec);
			const body = responses.shift();
			if (!body) throw new Error('no scripted response');
			return { statusCode: 200, headers: {}, body };
		},
		sleep: async () => {},
	});
	const settings: TwiggModelSettings = {
		model: 'claude-haiku-5-5',
		externalId: 'wa:+447700900123',
		chat: { namespace: 'n8n-dev', title: 'wa:+447700900123' },
		pendingToolCallWindowSeconds: 60,
		idempotencyScope: ['exec-1', 'node-1', 0],
		...settingsOverrides,
	};
	const model = new TwiggChatModel(client, settings, {
		warn: (message) => warnings.push(message),
		toJsonSchema: (tool) => tool.inputSchema as Record<string, unknown>,
	});
	return { model, calls, warnings, requestAt: (i: number) => calls[i].body as CreateResponseRequest };
}

const system: Message = { role: 'system', content: [{ type: 'text', text: 'Keep replies short.' }] };
const user: Message = { role: 'user', content: [{ type: 'text', text: 'Where is my order 1042?' }] };
const orderTool: Tool = {
	type: 'function',
	name: 'get_order_status',
	description: 'Look up an order by number',
	inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
};

describe('TwiggChatModel', () => {
	it('runs a full tool round the way the Agent drives it', async () => {
		const { model, calls, requestAt } = harness([toolUseResponse, endTurnResponse]);
		const bound = model.withTools([orderTool]);

		const first = await bound.generate([system, user]);
		expect(first.finishReason).toBe('tool-calls');
		const toolCall = first.message.content.find((b) => b.type === 'tool-call');
		expect(toolCall).toMatchObject({ toolCallId: 'toolu_01ORDER', toolName: 'get_order_status' });

		expect(calls[0].path).toBe('/api/v1/chats/external/wa%3A%2B447700900123/responses');
		const request1 = requestAt(0);
		expect(request1).toMatchObject({
			model: 'claude-haiku-5-5',
			stream: false,
			system: 'Keep replies short.',
			input: [{ type: 'prompt', text: 'Where is my order 1042?' }],
			wait_for_pending_tool_calls: 60,
			chat: { namespace: 'n8n-dev', title: 'wa:+447700900123' },
		});
		expect(request1.tools).toEqual([
			{
				name: 'get_order_status',
				description: 'Look up an order by number',
				input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
			},
		]);
		expect(request1.idempotency_key).toMatch(/^[0-9a-f]{64}$/);

		// The Agent appends its tool-call message and the tool result, then calls again.
		const second = await bound.generate([
			system,
			user,
			first.message,
			{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_01ORDER', result: '{"status":"shipped"}' }] },
		]);
		expect(second.finishReason).toBe('stop');
		const request2 = requestAt(1);
		expect(request2.input).toEqual([
			{
				type: 'tool_result',
				tool_use_id: 'toolu_01ORDER',
				tool_name: 'get_order_status',
				text: '{"status":"shipped"}',
				is_error: false,
			},
		]);
		expect(request2.system).toBe('Keep replies short.');
		expect(request2.tools).toHaveLength(1);
		expect(request2.idempotency_key).not.toBe(request1.idempotency_key);
	});

	it('names a tool result from an earlier response even when the call message lacks the id', async () => {
		const { model } = harness([toolUseResponse, endTurnResponse]);
		await model.generate([user]);
		// A conversation where the assistant message was rebuilt without tool-call blocks.
		const request = model.buildRequest([
			user,
			{ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
			{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_01ORDER', result: 'ok' }] },
		]);
		expect(request.input[0]).toMatchObject({ type: 'tool_result', tool_name: 'get_order_status' });
	});

	it('shares that memory across withTools clones', async () => {
		const { model } = harness([toolUseResponse]);
		await model.withTools([orderTool]).generate([user]);
		const clone = model.withTools([orderTool]);
		const request = clone.buildRequest([
			user,
			{ role: 'assistant', content: [] },
			{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_01ORDER', result: 'ok' }] },
		]);
		expect(request.input[0]).toMatchObject({ tool_name: 'get_order_status' });
	});

	it('keys identical submissions identically and distinct ones distinctly', () => {
		const { model } = harness([]);
		const a = model.buildRequest([system, user]);
		const b = model.buildRequest([system, user]);
		const c = model.buildRequest([system, { role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
		const d = model.buildRequest([{ role: 'system', content: [{ type: 'text', text: 'Other prompt' }] }, user]);
		expect(a.idempotency_key).toBe(b.idempotency_key);
		expect(c.idempotency_key).not.toBe(a.idempotency_key);
		expect(d.idempotency_key).not.toBe(a.idempotency_key);

		const other = harness([], { idempotencyScope: ['exec-2', 'node-1', 0] });
		expect(other.model.buildRequest([system, user]).idempotency_key).not.toBe(a.idempotency_key);
	});

	it('applies max tokens, reasoning effort and the pending window, omitting what is unset', () => {
		const { model } = harness([], {
			maxTokens: 500,
			reasoningEffort: 'low',
			pendingToolCallWindowSeconds: undefined,
			chat: {},
		});
		const request = model.buildRequest([user]);
		expect(request).toMatchObject({ max_tokens: 500, reasoning_effort: 'low' });
		expect(request).not.toHaveProperty('wait_for_pending_tool_calls');
		expect(request).not.toHaveProperty('chat');
		expect(request).not.toHaveProperty('system');
		expect(request).not.toHaveProperty('tools');

		const perCall = model.buildRequest([user], { maxTokens: 50 });
		expect(perCall.max_tokens).toBe(50);
	});

	it('warns once when a Memory node replays history', async () => {
		const { model, warnings, requestAt } = harness([endTurnResponse, endTurnResponse]);
		const replayed: Message[] = [
			system,
			{ role: 'user', content: [{ type: 'text', text: 'Hi' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
			{ role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
		];
		await model.generate(replayed);
		await model.generate(replayed);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/Memory node/);
		expect(requestAt(0).input).toEqual([{ type: 'prompt', text: 'What is my name?' }]);
	});

	it('streams the same result as chunks', async () => {
		const { model } = harness([endTurnResponse]);
		const chunks = [];
		for await (const chunk of model.stream([user])) chunks.push(chunk);
		expect(chunks.map((c) => c.type)).toEqual(['content', 'text-delta', 'finish']);
	});
});
