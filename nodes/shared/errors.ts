import type { ErrorBody } from './types';

/**
 * One failure the Twigg API reported, with the API's own code, hint and details kept so the
 * n8n error view can show them. `status` is also exposed so n8n's LLM retry handler can tell
 * retryable failures from final ones.
 */
export class TwiggApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly hint: string | null;
	readonly details: unknown;
	readonly retryAfterSeconds: number | undefined;

	constructor(
		status: number,
		body: ErrorBody,
		options: { retryAfterSeconds?: number; cause?: unknown } = {},
	) {
		super(body.message);
		this.name = 'TwiggApiError';
		this.status = status;
		this.code = body.code;
		this.hint = body.hint ?? null;
		this.details = body.details;
		this.retryAfterSeconds = options.retryAfterSeconds;
		if (options.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}

	/** A one-paragraph explanation for the n8n error panel. */
	get description(): string {
		const lines = [`Twigg returned HTTP ${this.status} (${this.code}).`];
		if (this.hint) lines.push(this.hint);
		if (this.details !== undefined && this.details !== null) {
			lines.push(`Details: ${JSON.stringify(this.details)}`);
		}
		return lines.join(' ');
	}
}

/** Reads the error envelope out of a non-2xx body, tolerating bodies that are not one. */
export function errorBodyFrom(status: number, body: unknown): ErrorBody {
	if (typeof body === 'object' && body !== null && 'error' in body) {
		const inner = (body as { error: unknown }).error;
		if (typeof inner === 'object' && inner !== null && 'code' in inner && 'message' in inner) {
			return inner as ErrorBody;
		}
	}
	if (typeof body === 'string' && body.trim() !== '') {
		return { code: `http_${status}`, message: body.slice(0, 500) };
	}
	return { code: `http_${status}`, message: `Twigg responded with HTTP ${status}` };
}

/**
 * The model declined to answer. Twigg returns this as a normal 200 response, often with a
 * provider notice meant for developers rather than end users, so by default the node fails the
 * run with it instead of handing it to the Agent as the reply.
 */
export class TwiggRefusalError extends Error {
	/** 400 so n8n's LLM retry handler does not retry: a retry would replay the same stored refusal. */
	readonly status = 400;
	readonly code = 'refusal';

	constructor(
		readonly refusalText: string,
		readonly runId: string,
		readonly modelServed: string | null,
	) {
		super(modelServed ? `The model refused to answer (${modelServed})` : 'The model refused to answer');
		this.name = 'TwiggRefusalError';
	}

	get description(): string {
		const lines = [
			`Twigg run ${this.runId} ended with stop reason "refusal".`,
			"Set the Twigg Chat Model's On Refusal option to Return Refusal Text to pass it to the Agent instead.",
		];
		if (this.refusalText.trim() !== '') lines.push(`Refusal: ${this.refusalText.trim()}`);
		return lines.join(' ');
	}
}
