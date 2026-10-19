import { describe, expect, it } from 'vitest';

import { parseRetryAfter, TwiggClient } from '../nodes/shared/client';
import type { HttpRequestSpec, HttpResponse } from '../nodes/shared/client';
import { TwiggApiError } from '../nodes/shared/errors';
import type { CreateResponseRequest } from '../nodes/shared/types';
import { endTurnResponse, errorEnvelope, toolUseResponse } from './fixtures/responses';

type Scripted = HttpResponse | ((spec: HttpRequestSpec) => HttpResponse);

function scriptedClient(script: Scripted[], policyOverrides = {}) {
	const calls: HttpRequestSpec[] = [];
	const sleeps: number[] = [];
	const client = new TwiggClient(
		{
			request: async (spec) => {
				calls.push(spec);
				const next = script.shift();
				if (!next) throw new Error('script exhausted');
				return typeof next === 'function' ? next(spec) : next;
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		},
		{ waitBudgetSeconds: 120, timeoutRetries: 2, maxBackoffSeconds: 30, ...policyOverrides },
	);
	return { client, calls, sleeps };
}

const ok = (body: unknown, statusCode = 200, headers: Record<string, unknown> = {}): HttpResponse => ({
	statusCode,
	headers,
	body,
});

const request: CreateResponseRequest = {
	model: 'claude-haiku-5-5',
	input: [{ type: 'prompt', text: 'Where is my order 1042?' }],
	stream: false,
	idempotency_key: 'n8n-exec-8812',
};

describe('parseRetryAfter', () => {
	it('reads seconds and HTTP dates', () => {
		expect(parseRetryAfter('7')).toBe(7);
		expect(parseRetryAfter('0.5')).toBe(0.5);
		const now = Date.parse('2026-10-19T20:00:00Z');
		expect(parseRetryAfter('Mon, 19 Oct 2026 20:00:30 GMT', now)).toBe(30);
		expect(parseRetryAfter('garbage')).toBeUndefined();
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});
});

describe('createResponseByExternalId', () => {
	it('posts to the percent-encoded external id route and returns the body', async () => {
		const { client, calls } = scriptedClient([ok(toolUseResponse)]);
		const body = await client.createResponseByExternalId('wa:+447700900123', request);
		expect(body).toEqual(toolUseResponse);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('POST');
		expect(calls[0].path).toBe('/api/v1/chats/external/wa%3A%2B447700900123/responses');
		expect(calls[0].body).toBe(request);
	});

	it('waits on chat_busy for Retry-After seconds, then succeeds', async () => {
		const { client, calls, sleeps } = scriptedClient([
			ok(errorEnvelope('chat_busy', 'busy'), 409, { 'retry-after': '3' }),
			ok(errorEnvelope('chat_busy', 'busy', { retry_after_secs: 5 }), 409),
			ok(endTurnResponse),
		]);
		const body = await client.createResponseByExternalId('x', request);
		expect(body.replayed).toBe(true);
		expect(calls).toHaveLength(3);
		expect(sleeps).toEqual([3000, 5000]);
	});

	it('honours Retry-After on tool_calls_pending, 429 and 503, and backs off without one', async () => {
		const { client, sleeps } = scriptedClient([
			ok(errorEnvelope('tool_calls_pending', 'pending'), 409, { 'Retry-After': '2' }),
			ok(errorEnvelope('rate_limited', 'slow down'), 429),
			ok(errorEnvelope('unavailable', 'later'), 503),
			ok(toolUseResponse),
		]);
		await client.createResponseByExternalId('x', request);
		// 2 s from the header, then 2^1 and 2^2 seconds of backoff.
		expect(sleeps).toEqual([2000, 2000, 4000]);
	});

	it('gives up when the next wait would exceed the budget, with the API error intact', async () => {
		const { client, calls, sleeps } = scriptedClient(
			[
				ok(errorEnvelope('chat_busy', 'busy'), 409, { 'retry-after': '8' }),
				ok(errorEnvelope('chat_busy', 'still busy', { retry_after_secs: 8 }), 409),
			],
			{ waitBudgetSeconds: 10 },
		);
		const error = await client.createResponseByExternalId('x', request).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TwiggApiError);
		const apiError = error as TwiggApiError;
		expect(apiError.status).toBe(409);
		expect(apiError.code).toBe('chat_busy');
		expect(apiError.message).toBe('still busy');
		expect(apiError.retryAfterSeconds).toBe(8);
		expect(sleeps).toEqual([8000]);
		expect(calls).toHaveLength(2);
	});

	it('retries 504 response_timeout with the same key, up to the limit', async () => {
		const timeout = () => ok(errorEnvelope('response_timeout', 'still running'), 504);
		const { client, calls } = scriptedClient([timeout(), timeout(), ok(endTurnResponse)]);
		const body = await client.createResponseByExternalId('x', request);
		expect(body.run_id).toBe(endTurnResponse.run_id);
		expect(calls).toHaveLength(3);
		expect(calls.every((c) => (c.body as CreateResponseRequest).idempotency_key === 'n8n-exec-8812')).toBe(true);

		const exhausted = scriptedClient([timeout(), timeout(), timeout()]);
		const error = await exhausted.client.createResponseByExternalId('x', request).catch((e: unknown) => e);
		expect((error as TwiggApiError).status).toBe(504);
		expect(exhausted.calls).toHaveLength(3);
	});

	it('never retries a 504 without an idempotency key', async () => {
		const { client, calls } = scriptedClient([ok(errorEnvelope('response_timeout', 'running'), 504)]);
		const unkeyed: CreateResponseRequest = { model: request.model, input: request.input, stream: false };
		const error = await client.createResponseByExternalId('x', unkeyed).catch((e: unknown) => e);
		expect((error as TwiggApiError).code).toBe('response_timeout');
		expect(calls).toHaveLength(1);
	});

	it('throws every other error at once with code, hint and details', async () => {
		const { client, calls } = scriptedClient([
			{
				statusCode: 409,
				headers: {},
				body: {
					error: {
						code: 'idempotency_key_reused',
						message: 'key belongs to an earlier run',
						hint: 'use a new key',
						details: { run_id: 'run-1' },
					},
				},
			},
		]);
		const error = (await client.createResponseByExternalId('x', request).catch((e: unknown) => e)) as TwiggApiError;
		expect(error.code).toBe('idempotency_key_reused');
		expect(error.hint).toBe('use a new key');
		expect(error.details).toEqual({ run_id: 'run-1' });
		expect(error.description).toContain('HTTP 409');
		expect(error.description).toContain('use a new key');
		expect(calls).toHaveLength(1);
	});

	it('copes with non-envelope error bodies', async () => {
		const { client } = scriptedClient([{ statusCode: 502, headers: {}, body: '<html>bad gateway</html>' }]);
		const error = (await client.createResponseByExternalId('x', request).catch((e: unknown) => e)) as TwiggApiError;
		expect(error.status).toBe(502);
		expect(error.code).toBe('http_502');
		expect(error.message).toContain('bad gateway');
	});
});

describe('chat and model routes', () => {
	it('maps each operation to its route and status', async () => {
		const { client, calls } = scriptedClient([
			ok([{ name: 'claude-haiku-5-5' }]),
			ok({ id: 'c1' }),
			ok({ id: 'c1' }, 201),
			ok({ id: 'c1' }, 200),
			ok(null, 204),
			ok({ data: [], first_ordinal: null, last_ordinal: null, has_more: false }),
			ok({ chat_id: 'c1', run_id: 'r1', status: 'aborting' }, 202),
		]);
		expect(await client.listModels()).toEqual([{ name: 'claude-haiku-5-5' }]);
		expect(await client.getChatByExternalId('a b')).toEqual({ id: 'c1' });
		expect(await client.openChatByExternalId('x', { namespace: 'n8n-dev' })).toEqual({ chat: { id: 'c1' }, created: true });
		expect(await client.openChatByExternalId('x')).toEqual({ chat: { id: 'c1' }, created: false });
		await client.deleteChatByExternalId('x');
		await client.getHistoryByExternalId('x', { limit: 20, include: 'none', after_ordinal: 5 });
		expect(await client.abortByExternalId('x')).toEqual({ chat_id: 'c1', run_id: 'r1', status: 'aborting' });

		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /api/v1/models',
			'GET /api/v1/chats/external/a%20b',
			'PUT /api/v1/chats/external/x',
			'PUT /api/v1/chats/external/x',
			'DELETE /api/v1/chats/external/x',
			'GET /api/v1/chats/external/x/history',
			'POST /api/v1/chats/external/x/abort',
		]);
		expect(calls[2].body).toEqual({ namespace: 'n8n-dev' });
		expect(calls[5].qs).toEqual({ limit: 20, include: 'none', after_ordinal: 5 });
	});

	it('turns an unexpected status into a TwiggApiError', async () => {
		const { client } = scriptedClient([ok(errorEnvelope('not_found', 'no such chat'), 404)]);
		const error = (await client.getChatByExternalId('x').catch((e: unknown) => e)) as TwiggApiError;
		expect(error.status).toBe(404);
		expect(error.code).toBe('not_found');
	});
});
