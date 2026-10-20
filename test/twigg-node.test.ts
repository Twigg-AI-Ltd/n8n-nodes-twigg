import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Twigg } from '../nodes/Twigg/Twigg.node';

/** The Twigg node's Import History operation with a stand-in n8n context and API. */
function importHarness(api: (req: { method: string; url: string; body?: unknown }) => { statusCode: number; body: unknown }) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const items: INodeExecutionData[] = [{ json: { session_id: 'web-1' } }, { json: { session_id: 'web-2' } }];
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) =>
			({
				resource: 'chat',
				operation: 'importHistory',
				chatId: items[itemIndex].json.session_id,
				hashChatId: false,
				namespace: 'n8n',
			})[name] ?? fallback,
		getCredentials: async () => ({ apiKey: 'tw_test', baseUrl: 'https://api.twigg.ai' }),
		getNode: () => ({ id: 'node-1', name: 'Twigg' }),
		getInputConnectionData: async () => ({
			chatHistory: { getMessages: async () => [{ getType: () => 'human', content: 'Hello again' }] },
		}),
		continueOnFail: () => false,
		logger: { debug: () => {}, warn: () => {} },
		helpers: {
			httpRequestWithAuthentication: async (_cred: string, req: { method: string; url: string; body?: unknown }) => {
				calls.push(req);
				return { headers: {}, ...api(req) };
			},
		},
	} as unknown as IExecuteFunctions;
	return { calls, run: async () => await new Twigg().execute.call(ctx) };
}

describe('Twigg node: Import History', () => {
	it('imports each session and reports what happened', async () => {
		const { run, calls } = importHarness((req) =>
			req.url.includes('web-1')
				? { statusCode: 201, body: { chat_id: 'c1', created_chat: true, imported_parts: 1 } }
				: { statusCode: 200, body: { chat_id: 'c2', skipped: true } },
		);
		const out = await run();
		expect(calls.map((c) => c.url.split('/api/v1')[1])).toEqual([
			'/chats/external/web-1/import',
			'/chats/external/web-2/import',
		]);
		expect(calls[0].body).toEqual({
			chat: { namespace: 'n8n', title: 'web-1' },
			parts: [{ type: 'prompt', text: 'Hello again' }],
		});
		expect(out[0].map((i) => [i.json.chat_id, i.json.status])).toEqual([
			['c1', 'imported'],
			['c2', 'skipped'],
		]);
	});

	it('says plainly when the API has no import endpoint yet', async () => {
		const { run } = importHarness(() => ({ statusCode: 404, body: { error: { code: 'not_found', message: 'not found' } } }));
		await expect(run()).rejects.toThrow(/history import isn't available yet/);
	});
});
