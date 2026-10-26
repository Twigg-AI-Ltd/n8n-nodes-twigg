import type { IExecuteFunctions, INode, INodeExecutionData, INodeTypes, NodeExecutionHint } from 'n8n-workflow';
import { NodeHelpers, Workflow } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Twigg, withoutMemorySuffix } from '../nodes/Twigg/Twigg.node';

type Api = (req: { method: string; url: string; body?: unknown }) => { statusCode: number; body: unknown };

/** The Twigg node's Import All with a stand-in n8n context and API. */
function importAllHarness(sessions: string[], api: Api) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const hints: NodeExecutionHint[] = [];
	const items: INodeExecutionData[] = sessions.map((session_id) => ({ json: { session_id } }));
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) =>
			({
				resource: 'chat',
				operation: 'importAll',
				chatId: items[itemIndex].json.session_id,
				hashChatId: false,
				namespace: 'n8n',
			})[name] ?? fallback,
		getCredentials: async () => ({ apiKey: 'tw_test', baseUrl: 'https://api.twigg.ai' }),
		getNode: () => ({ id: 'node-1', name: 'Twigg' }),
		getParentNodes: () => [{ name: 'Postgres Chat Memory', disabled: false }],
		getInputConnectionData: async () => ({
			chatHistory: { getMessages: async () => [{ getType: () => 'human', content: 'Hello again' }] },
		}),
		addExecutionHints: (...added: NodeExecutionHint[]) => hints.push(...added),
		continueOnFail: () => false,
		logger: { debug: () => {}, warn: () => {} },
		helpers: {
			httpRequestWithAuthentication: async (_cred: string, req: { method: string; url: string; body?: unknown }) => {
				calls.push(req);
				return { headers: {}, ...api(req) };
			},
		},
	} as unknown as IExecuteFunctions;
	return { calls, hints, run: async () => (await new Twigg().execute.call(ctx))[0] };
}

const imported = (id: string) => ({
	statusCode: 201,
	body: { chat_id: id, created_chat: true, imported_parts: 1, dropped_parts: 0, cost: '0.0001', cost_currency: 'USD', warnings: [] },
});
const statuses = (out: INodeExecutionData[]) => out.map((i) => `${i.json.chat_id}:${i.json.status}`);

describe('Twigg node: Import All', () => {
	it('imports every session and says the external memory can go', async () => {
		const { run, calls, hints } = importAllHarness(['web-1', 'web-2'], (req) =>
			req.url.includes('web-1') ? imported('c1') : { statusCode: 200, body: { chat_id: 'c2', skipped: true, existing_parts: 12 } },
		);
		const out = await run();
		expect(calls[0].body).toEqual({
			chat: { namespace: 'n8n', title: 'web-1' },
			parts: [{ type: 'prompt', text: 'Hello again' }],
		});
		expect(statuses(out)).toEqual(['web-1:imported', 'web-2:skipped']);
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({ type: 'info', location: 'outputPane' });
		expect(hints[0].message).toMatch(/All 2 existing chats are on Twigg \(1 imported, 1 already on Twigg\).*safe to detach the external memory/);
	});

	it('stops when the balance runs out and reports what was not imported', async () => {
		const { run, calls, hints } = importAllHarness(['a', 'b', 'c', 'd'], (req) =>
			req.url.includes('/a/')
				? imported('ca')
				: { statusCode: 402, body: { error: { code: 'payment_required', message: 'Balance too low', hint: 'Top up' } } },
		);
		const out = await run();
		expect(calls).toHaveLength(2);
		expect(statuses(out)).toEqual(['a:imported', 'b:failed', 'c:not_attempted', 'd:not_attempted']);
		expect(out[1].json.error).toMatchObject({ code: 'payment_required' });
		expect(hints[0].type).toBe('warning');
		expect(hints[0].message).toMatch(/3 of 4 chats were not imported\. The Twigg balance ran out/);
		expect(hints[0].message).toMatch(/Running this again is safe/);
		expect(hints[0].message).toMatch(/Keep the external memory attached/);
	});

	it('carries on past a chat-specific failure', async () => {
		const { run, hints } = importAllHarness(['a', 'b'], (req) =>
			req.url.includes('/a/')
				? { statusCode: 409, body: { error: { code: 'external_id_namespace_mismatch', message: 'Other namespace' } } }
				: imported('cb'),
		);
		const out = await run();
		expect(statuses(out)).toEqual(['a:failed', 'b:imported']);
		expect(hints[0].message).toMatch(/1 of 2 chats were not imported\. Each item that was not imported says why/);
	});

	it('says plainly when the API has no import endpoint yet', async () => {
		const { run } = importAllHarness(['a'], () => ({ statusCode: 404, body: { error: { code: 'not_found', message: 'not found' } } }));
		await expect(run()).rejects.toThrow(/history import isn't available yet/);
	});
});

describe('withoutMemorySuffix', () => {
	it("takes off the suffix n8n's Memory nodes add to Chat Trigger sessions", () => {
		expect(withoutMemorySuffix('a1b2c3__Postgres_Chat_Memory', ['Postgres Chat Memory'])).toBe('a1b2c3');
		expect(withoutMemorySuffix('a1b2c3__My_old_memory', ['Postgres Chat Memory'])).toBe('a1b2c3');
		expect(withoutMemorySuffix('447700900123', ['Postgres Chat Memory'])).toBe('447700900123');
		expect(withoutMemorySuffix('__Postgres_Chat_Memory', ['Postgres Chat Memory'])).toBe('__Postgres_Chat_Memory');
	});

	it('gives Import All the plain session ID as the Chat ID', async () => {
		const { run, calls } = importAllHarness(['web-1__Postgres_Chat_Memory'], () => imported('c1'));
		const out = await run();
		expect(calls[0].url).toMatch(/\/chats\/external\/web-1\/import$/);
		expect(out[0].json).toMatchObject({ chat_id: 'web-1', memory_session_id: 'web-1__Postgres_Chat_Memory', status: 'imported' });
	});
});

describe('Twigg node: inputs', () => {
	/** Works out the node's inputs with n8n's own helper, the way the editor does, for the given parameters. */
	const inputsFor = (parameters: INode['parameters']) => {
		const twigg = new Twigg();
		const node: INode = { id: 'node-1', name: 'Twigg', type: 'twigg', typeVersion: 2, position: [0, 0], parameters };
		const nodeTypes = { getByName: () => twigg, getByNameAndVersion: () => twigg, getKnownTypes: () => ({}) } as INodeTypes;
		const workflow = new Workflow({ nodes: [node], connections: {}, active: false, nodeTypes });
		const inputs = NodeHelpers.getNodeInputs(workflow, node, twigg.description, { throwOnExpressionError: true });
		return inputs.map((input) => (typeof input === 'string' ? input : input.type));
	};

	it('gives the agent a Tool input, and External Memory only while Use External Memory is on', () => {
		expect(inputsFor({ resource: 'agent', operation: 'sendMessage', useExternalMemory: false })).toEqual(['main', 'ai_tool']);
		expect(inputsFor({ resource: 'agent', operation: 'sendMessage', useExternalMemory: true })).toEqual(['main', 'ai_tool', 'ai_memory']);
	});

	it('gives Import All an External Memory input and every other operation only main', () => {
		expect(inputsFor({ resource: 'chat', operation: 'importAll' })).toEqual(['main', 'ai_memory']);
		expect(inputsFor({ resource: 'chat', operation: 'get', useExternalMemory: true })).toEqual(['main']);
		expect(inputsFor({ resource: 'model', operation: 'getAll' })).toEqual(['main']);
	});
});
