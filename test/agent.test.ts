import type { EngineRequest, EngineResponse, IExecuteFunctions, INodeExecutionData, ITaskData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TwiggAgent } from '../nodes/TwiggAgent/TwiggAgent.node';
import type { CreateResponseRequest, ResponseBody } from '../nodes/shared/types';
import { endTurnResponse, refusalResponse, toolUseResponse } from './fixtures/responses';

type Tool = { name: string; description?: string; schema?: unknown };

/** A stand-in for n8n's execute context: scripted Twigg responses, recorded requests. */
function harness({
	responses,
	items = [{ json: { chatInput: 'Where is my order 1042?', sessionId: 'web-1' } }],
	tools = [] as Array<{ node: string; tool: Tool | { tools: Tool[] } }>,
	options = {} as Record<string, unknown>,
	continueOnFail = false,
	useExternalMemory = false,
	memory = undefined as unknown,
	otherRoutes = (() => undefined) as (req: { method: string; url: string; body?: unknown }) => { statusCode: number; body: unknown } | undefined,
}: {
	responses: ResponseBody[];
	items?: INodeExecutionData[];
	tools?: Array<{ node: string; tool: Tool | { tools: Tool[] } }>;
	options?: Record<string, unknown>;
	continueOnFail?: boolean;
	useExternalMemory?: boolean;
	memory?: unknown;
	otherRoutes?: (req: { method: string; url: string; body?: unknown }) => { statusCode: number; body: unknown } | undefined;
}) {
	/** Calls to /responses; everything else (chat lookups, imports) goes to `otherCalls`. */
	const requests: Array<{ url: string; body: CreateResponseRequest }> = [];
	const otherCalls: Array<{ method: string; url: string; body?: unknown }> = [];
	const warnings: string[] = [];
	const params: Record<string, unknown> = {
		model: 'claude-haiku-5-5',
		systemMessage: 'Be brief.',
		options,
		useExternalMemory,
	};
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			if (name === 'text') return items[itemIndex].json.chatInput;
			if (name === 'chatId') return items[itemIndex].json.sessionId;
			return params[name] ?? fallback;
		},
		getCredentials: async () => ({ apiKey: 'tw_test', baseUrl: 'https://api.twigg.ai' }),
		getNode: () => ({ id: 'node-1', name: 'Twigg AI Agent' }),
		getExecutionId: () => 'exec-1',
		getInputConnectionData: async (type: string) => (type === 'ai_memory' ? memory : tools.map((t) => t.tool)),
		getParentNodes: () => tools.map((t) => ({ name: t.node, disabled: false })),
		getChatTrigger: () => null,
		continueOnFail: () => continueOnFail,
		logger: { debug: () => {}, info: () => {}, warn: (message: string) => warnings.push(message) },
		helpers: {
			httpRequestWithAuthentication: async (
				_cred: string,
				req: { method: string; url: string; body: CreateResponseRequest },
			) => {
				if (!req.url.endsWith('/responses')) {
					otherCalls.push({ method: req.method, url: req.url, body: req.body });
					const routed = otherRoutes(req);
					if (!routed) throw new Error(`unexpected request ${req.method} ${req.url}`);
					return { headers: {}, ...routed };
				}
				requests.push({ url: req.url, body: req.body });
				const body = responses.shift();
				if (!body) throw new Error('no scripted response');
				return { statusCode: 200, headers: {}, body };
			},
		},
	} as unknown as IExecuteFunctions;
	const node = new TwiggAgent();
	return {
		requests,
		otherCalls,
		warnings,
		run: async (response?: EngineResponse) => await node.execute.call(ctx, response),
	};
}

const lookupOrder: Tool = {
	name: 'lookup_order',
	description: 'Look up an order',
	schema: z.object({ order_id: z.string() }),
};

function toolOutput(json: Record<string, unknown>): ITaskData {
	return { data: { ai_tool: [[{ json }]] } } as unknown as ITaskData;
}

function respond(request: EngineRequest, results: ITaskData[]): EngineResponse {
	return {
		actionResponses: request.actions.map((action, i) => ({ action, data: results[i] })),
		metadata: request.metadata,
	} as EngineResponse;
}

const toolCall = (id: string, name: string, args: unknown): ResponseBody => ({
	...toolUseResponse,
	content: [{ type: 'tool_call', tool_use_id: id, name, arguments: args as Record<string, unknown> }],
});

describe('TwiggAgent', () => {
	it('answers directly when the model needs no tools', async () => {
		const { run, requests } = harness({ responses: [endTurnResponse] });
		const out = (await run()) as INodeExecutionData[][];
		expect(out[0]).toEqual([{ json: { output: 'Order 1042 shipped and arrives on 8 September.' }, pairedItem: { item: 0 } }]);
		expect(requests[0].url).toBe('https://api.twigg.ai/api/v1/chats/external/web-1/responses');
		expect(requests[0].body).toMatchObject({
			model: 'claude-haiku-5-5',
			system: 'Be brief.',
			input: [{ type: 'prompt', text: 'Where is my order 1042?' }],
			stream: false,
		});
	});

	it('treats an empty engine response as the first call', async () => {
		const { run, requests } = harness({ responses: [endTurnResponse] });
		const out = (await run({ actionResponses: [], metadata: {} } as EngineResponse)) as INodeExecutionData[][];
		expect(requests).toHaveLength(1);
		expect(out[0][0].json.output).toMatch(/1042/);
	});

	it('hands tool calls to the engine and sends the results back to Twigg', async () => {
		const { run, requests } = harness({
			responses: [toolCall('toolu_1', 'lookup_order', { order_id: '1042' }), endTurnResponse],
			tools: [{ node: 'Lookup Order', tool: lookupOrder }],
		});

		const request = (await run()) as EngineRequest;
		expect(request.actions).toEqual([
			{
				actionType: 'ExecutionNodeAction',
				nodeName: 'Lookup Order',
				input: { order_id: '1042' },
				type: 'ai_tool',
				id: 'toolu_1',
				metadata: { itemIndex: 0, toolName: 'lookup_order' },
			},
		]);
		expect(requests[0].body.tools).toEqual([
			{
				name: 'lookup_order',
				description: 'Look up an order',
				input_schema: {
					type: 'object',
					properties: { order_id: { type: 'string' } },
					required: ['order_id'],
					additionalProperties: false,
				},
			},
		]);

		const out = (await run(respond(request, [toolOutput({ response: '{"status":"shipped"}' })]))) as INodeExecutionData[][];
		expect(requests[1].body.input).toEqual([
			{ type: 'tool_result', tool_use_id: 'toolu_1', tool_name: 'lookup_order', text: '{"status":"shipped"}', is_error: false },
		]);
		expect(requests[1].body.idempotency_key).not.toBe(requests[0].body.idempotency_key);
		expect(out[0][0].json).toEqual({ output: 'Order 1042 shipped and arrives on 8 September.' });
	});

	it('marks a failed tool as an error result', async () => {
		const { run, requests } = harness({
			responses: [toolCall('toolu_1', 'lookup_order', { order_id: '1042' }), endTurnResponse],
			tools: [{ node: 'Lookup Order', tool: lookupOrder }],
		});
		const request = (await run()) as EngineRequest;
		await run(respond(request, [toolOutput({ error: 'Shop API is down (HTTP 503)' })]));
		expect(requests[1].body.input[0]).toMatchObject({ type: 'tool_result', is_error: true });
	});

	it('runs toolkit tools on the toolkit node, naming the tool', async () => {
		const { run } = harness({
			responses: [toolCall('toolu_1', 'search_issues', '{"query":"login bug"}')],
			tools: [
				{ node: 'GitHub MCP', tool: { tools: [{ name: 'search_issues', schema: { type: 'object', properties: { query: { type: 'string' } } } }] } },
			],
		});
		const request = (await run()) as EngineRequest;
		expect(request.actions[0]).toMatchObject({
			nodeName: 'GitHub MCP',
			input: { query: 'login bug', tool: 'search_issues' },
		});
	});

	it('answers a call to a tool that does not exist so the model can recover', async () => {
		const { run, requests } = harness({
			responses: [toolCall('toolu_1', 'delete_everything', {}), endTurnResponse],
			tools: [{ node: 'Lookup Order', tool: lookupOrder }],
		});
		const out = (await run()) as INodeExecutionData[][];
		expect(requests[1].body.input[0]).toMatchObject({ tool_use_id: 'toolu_1', is_error: true });
		expect((requests[1].body.input[0] as { text: string }).text).toMatch(/no tool named 'delete_everything'.*lookup_order/);
		expect(out[0][0].json.output).toMatch(/1042/);
	});

	it('keeps each item to its own conversation and answers them in order', async () => {
		const { run, requests } = harness({
			items: [
				{ json: { chatInput: 'Hi', sessionId: 'a' } },
				{ json: { chatInput: 'Where is 1042?', sessionId: 'b' } },
			],
			responses: [
				{ ...endTurnResponse, content: [{ type: 'text', text: 'Hello!' }] },
				toolCall('toolu_b', 'lookup_order', { order_id: '1042' }),
				endTurnResponse,
			],
			tools: [{ node: 'Lookup Order', tool: lookupOrder }],
		});
		const request = (await run()) as EngineRequest;
		expect(request.actions.map((a) => a.metadata)).toEqual([{ itemIndex: 1, toolName: 'lookup_order' }]);
		const out = (await run(respond(request, [toolOutput({ response: 'shipped' })]))) as INodeExecutionData[][];
		expect(requests.map((r) => r.url.split('/external/')[1])).toEqual(['a/responses', 'b/responses', 'b/responses']);
		expect(out[0].map((i) => i.json.output)).toEqual(['Hello!', 'Order 1042 shipped and arrives on 8 September.']);
	});

	it('stops after the maximum number of tool rounds', async () => {
		const loop = toolCall('toolu_x', 'lookup_order', { order_id: '1' });
		const { run } = harness({
			responses: [loop, loop, loop],
			tools: [{ node: 'Lookup Order', tool: lookupOrder }],
			options: { maxIterations: 1 },
		});
		let request = (await run()) as EngineRequest;
		request = (await run(respond(request, [toolOutput({ response: 'x' })]))) as EngineRequest;
		await expect(run(respond(request, [toolOutput({ response: 'x' })]))).rejects.toThrow(/Stopped after 1 rounds/);
	});

	it('fails on a refusal by default and returns it when asked to', async () => {
		await expect(harness({ responses: [refusalResponse] }).run()).rejects.toThrow(/refused to answer/);
		const out = (await harness({ responses: [refusalResponse], options: { onRefusal: 'returnText' } }).run()) as INodeExecutionData[][];
		expect(out[0][0].json.output).toMatch(/fallback model/);
	});

	it('outputs the error per item when continuing on fail', async () => {
		const { run } = harness({ responses: [refusalResponse], continueOnFail: true });
		const out = (await run()) as INodeExecutionData[][];
		expect(out[0][0].json).toEqual({ error: 'The model refused to answer (claude-haiku-5-5)' });
	});
});

describe('TwiggAgent with Use External Memory', () => {
	const oldMemory = {
		chatHistory: {
			getMessages: async () => [
				{ getType: () => 'human', content: "I'm Priya, order 1042" },
				{ getType: () => 'ai', content: 'Thanks Priya, it has shipped.' },
			],
		},
	};
	const notFound = { statusCode: 404, body: { error: { code: 'not_found', message: 'not found' } } };

	it('imports the old conversation before the first message of a new chat', async () => {
		const { run, requests, otherCalls } = harness({
			responses: [endTurnResponse],
			useExternalMemory: true,
			memory: oldMemory,
			otherRoutes: (req) =>
				req.method === 'GET' ? notFound : { statusCode: 201, body: { chat_id: 'c1', created_chat: true, imported_parts: 2 } },
		});
		await run();
		expect(otherCalls.map((c) => `${c.method} ${c.url.split('/api/v1')[1]}`)).toEqual([
			'GET /chats/external/web-1',
			'POST /chats/external/web-1/import',
		]);
		expect(otherCalls[1].body).toEqual({
			chat: { namespace: 'n8n', title: 'web-1' },
			parts: [
				{ type: 'prompt', text: "I'm Priya, order 1042" },
				{ type: 'message', text: 'Thanks Priya, it has shipped.' },
			],
		});
		expect(requests).toHaveLength(1);
	});

	it('leaves a chat that already has history on Twigg alone', async () => {
		const { run, otherCalls } = harness({
			responses: [endTurnResponse],
			useExternalMemory: true,
			memory: oldMemory,
			otherRoutes: () => ({ statusCode: 200, body: { id: 'c1', length: 12 } }),
		});
		await run();
		expect(otherCalls.map((c) => c.method)).toEqual(['GET']);
	});

	it('answers anyway when the API has no import endpoint yet', async () => {
		const { run, warnings, requests } = harness({
			responses: [endTurnResponse],
			useExternalMemory: true,
			memory: oldMemory,
			otherRoutes: () => notFound,
		});
		const out = (await run()) as INodeExecutionData[][];
		expect(out[0][0].json.output).toMatch(/1042/);
		expect(requests).toHaveLength(1);
		expect(warnings.join(' ')).toMatch(/not available on this Twigg API yet/);
	});

	it('does not look anything up when external memory is off', async () => {
		const { run, otherCalls } = harness({ responses: [endTurnResponse], memory: oldMemory });
		await run();
		expect(otherCalls).toEqual([]);
	});
});
