import { createHash } from 'node:crypto';

/**
 * External id rules from the Twigg spec: unique per organisation, case-sensitive, printable
 * ASCII without spaces, 1-255 characters, no `%` `/` `\` `?` `#`, no leading `.`.
 */
const EXTERNAL_ID_FORBIDDEN = /[%/\\?#]/;
const PRINTABLE_ASCII_NO_SPACE = /^[\x21-\x7e]+$/;

export function externalIdProblem(id: string): string | null {
	if (id.length === 0) return 'is empty';
	if (id.length > 255) return 'is longer than 255 characters';
	if (!PRINTABLE_ASCII_NO_SPACE.test(id)) {
		return 'must be printable ASCII without spaces';
	}
	if (EXTERNAL_ID_FORBIDDEN.test(id)) {
		return 'must not contain %, /, \\, ? or #';
	}
	if (id.startsWith('.')) return 'must not start with a dot';
	return null;
}

export function isValidExternalId(id: string): boolean {
	return externalIdProblem(id) === null;
}

/**
 * Turns any chat id into a valid, non-identifying external id: a SHA-256 of the raw value,
 * hex-encoded, under a short prefix so hashed ids are recognisable in the console.
 */
export function hashExternalId(raw: string, prefix = 'h'): string {
	return `${prefix}:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}

/**
 * Resolves the id that goes in the URL path. Hashing is applied when asked for, or when the raw
 * value would not be accepted as an external id (so a session id with spaces or a slash still
 * addresses a stable chat instead of failing).
 */
export function resolveExternalId(raw: string, hash: boolean): { id: string; hashed: boolean } {
	const trimmed = raw.trim();
	if (hash || !isValidExternalId(trimmed)) {
		return { id: hashExternalId(trimmed), hashed: true };
	}
	return { id: trimmed, hashed: false };
}

/** Chat titles are 1-50 characters in the Twigg spec; a raw chat id is shown as the title when it fits. */
export const CHAT_TITLE_MAX_LENGTH = 50;

export function chatTitleFor(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (trimmed === '') return undefined;
	return trimmed.length <= CHAT_TITLE_MAX_LENGTH ? trimmed : `${trimmed.slice(0, CHAT_TITLE_MAX_LENGTH - 1)}…`;
}

/** `encodeURIComponent` already covers `+` → `%2B` and every character the spec forbids. */
export function encodeExternalId(id: string): string {
	return encodeURIComponent(id);
}

/**
 * Idempotency keys allow only letters, digits and `-._~`, at most 128 characters. Building the
 * key from a hash of what identifies this submission makes retries of the same submission
 * replay the stored result and makes distinct submissions distinct.
 */
export function buildIdempotencyKey(parts: unknown[]): string {
	return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9\-._~]{1,128}$/;

export function isValidIdempotencyKey(key: string): boolean {
	return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/** Keeps a caller-supplied key when it is valid and hashes it into a valid one otherwise. */
export function normaliseIdempotencyKey(key: string): string {
	return isValidIdempotencyKey(key) ? key : buildIdempotencyKey([key]);
}
