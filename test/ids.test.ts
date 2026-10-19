import { describe, expect, it } from 'vitest';

import {
	buildIdempotencyKey,
	encodeExternalId,
	externalIdProblem,
	hashExternalId,
	isValidIdempotencyKey,
	normaliseIdempotencyKey,
	resolveExternalId,
} from '../nodes/shared/ids';

describe('external ids', () => {
	it('accepts the ids the spec allows', () => {
		for (const id of ['wa:+447700900123', 'support:+447700900123', 'ticket-42', 'A.b_c~d', 'x'.repeat(255)]) {
			expect(externalIdProblem(id), id).toBeNull();
		}
	});

	it('rejects what the spec forbids', () => {
		expect(externalIdProblem('')).toMatch(/empty/);
		expect(externalIdProblem('x'.repeat(256))).toMatch(/255/);
		expect(externalIdProblem('has space')).toMatch(/printable ASCII/);
		expect(externalIdProblem('café')).toMatch(/printable ASCII/);
		expect(externalIdProblem('a/b')).toMatch(/must not contain/);
		expect(externalIdProblem('a%2Fb')).toMatch(/must not contain/);
		expect(externalIdProblem('a?b')).toMatch(/must not contain/);
		expect(externalIdProblem('a#b')).toMatch(/must not contain/);
		expect(externalIdProblem('a\\b')).toMatch(/must not contain/);
		expect(externalIdProblem('.hidden')).toMatch(/dot/);
	});

	it('percent-encodes the path segment, including +', () => {
		expect(encodeExternalId('wa:+447700900123')).toBe('wa%3A%2B447700900123');
	});

	it('hashes deterministically under a recognisable prefix', () => {
		const hashed = hashExternalId('+447700900123');
		expect(hashed).toMatch(/^h:[0-9a-f]{64}$/);
		expect(hashExternalId('+447700900123')).toBe(hashed);
		expect(hashExternalId('+447700900124')).not.toBe(hashed);
		expect(externalIdProblem(hashed)).toBeNull();
	});

	it('keeps valid ids raw unless hashing is requested, and hashes invalid ones', () => {
		expect(resolveExternalId('  wa:+447700900123 ', false)).toEqual({ id: 'wa:+447700900123', hashed: false });
		expect(resolveExternalId('wa:+447700900123', true)).toEqual({
			id: hashExternalId('wa:+447700900123'),
			hashed: true,
		});
		expect(resolveExternalId('has space/slash', false)).toEqual({
			id: hashExternalId('has space/slash'),
			hashed: true,
		});
	});
});

describe('idempotency keys', () => {
	it('builds a valid, deterministic key from the submission', () => {
		const key = buildIdempotencyKey(['exec-1', 'node-1', 0, 'wa:+44', [{ type: 'prompt', text: 'hi' }]]);
		expect(isValidIdempotencyKey(key)).toBe(true);
		expect(key).toHaveLength(64);
		expect(buildIdempotencyKey(['exec-1', 'node-1', 0, 'wa:+44', [{ type: 'prompt', text: 'hi' }]])).toBe(key);
		expect(buildIdempotencyKey(['exec-2', 'node-1', 0, 'wa:+44', [{ type: 'prompt', text: 'hi' }]])).not.toBe(key);
	});

	it('keeps valid caller keys and hashes invalid ones', () => {
		expect(normaliseIdempotencyKey('n8n-exec-8812')).toBe('n8n-exec-8812');
		expect(normaliseIdempotencyKey('wa:+447700900123')).toMatch(/^[0-9a-f]{64}$/);
		expect(isValidIdempotencyKey('x'.repeat(129))).toBe(false);
	});
});
