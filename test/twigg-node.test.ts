import type { IExecuteFunctions, INodeExecutionData, NodeExecutionHint } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Twigg } from '../nodes/Twigg/Twigg.node';

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
		expect(hints[0].message).toMatch(/1 of 2 chats were not imported\. See the error on each failed item/);
	});

	it('says plainly when the API has no import endpoint yet', async () => {
		const { run } = importAllHarness(['a'], () => ({ statusCode: 404, body: { error: { code: 'not_found', message: 'not found' } } }));
		await expect(run()).rejects.toThrow(/history import isn't available yet/);
	});
});
