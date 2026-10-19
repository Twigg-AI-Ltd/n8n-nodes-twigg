import { describe, expect, it } from 'vitest';

import { makeN8nRequest, normaliseBaseUrl } from '../nodes/shared/n8n-request';

describe('normaliseBaseUrl', () => {
	it('defaults and strips trailing slashes', () => {
		expect(normaliseBaseUrl(undefined)).toBe('https://api.twigg.ai');
		expect(normaliseBaseUrl('  ')).toBe('https://api.twigg.ai');
		expect(normaliseBaseUrl('https://api.example.test/')).toBe('https://api.example.test');
	});
});

describe('makeN8nRequest', () => {
	it('calls the authenticated helper with full-response, non-throwing options', async () => {
		const seen: unknown[] = [];
		const ctx = {
			helpers: {
				httpRequestWithAuthentication: async function (this: unknown, credential: string, options: unknown) {
					seen.push({ credential, options });
					return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
				},
			},
		};
		const request = makeN8nRequest(ctx as never, 'https://api.twigg.ai', 1234);
		const response = await request({
			method: 'GET',
			path: '/api/v1/chats/external/x/history',
			qs: { limit: 5, include: undefined },
		});
		expect(response).toEqual({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } });
		expect(seen[0]).toEqual({
			credential: 'twiggApi',
			options: {
				method: 'GET',
				url: 'https://api.twigg.ai/api/v1/chats/external/x/history',
				headers: { 'x-twigg-client': 'n8n-nodes-twigg', accept: 'application/json' },
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: 1234,
				qs: { limit: 5 },
			},
		});
	});
});
