import { sleep as n8nSleep } from 'n8n-workflow';

import { errorBodyFrom, TwiggApiError } from './errors';
import { encodeExternalId } from './ids';
import type {
	AbortAccepted,
	CatalogueModel,
	ChatSummary,
	CreateResponseRequest,
	HistoryPageResponse,
	ImportHistoryRequest,
	ImportHistoryResponse,
	OpenChatRequest,
	ResponseBody,
} from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type HttpRequestSpec = {
	method: HttpMethod;
	/** Path under the base URL, starting with `/`. */
	path: string;
	qs?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
};

export type HttpResponse = {
	statusCode: number;
	headers: Record<string, unknown>;
	body: unknown;
};

/** The one seam between this client and n8n's authenticated request helper. */
export type HttpRequestFn = (spec: HttpRequestSpec) => Promise<HttpResponse>;

export type RetryPolicy = {
	/** Total seconds the client may spend waiting on `chat_busy`, `tool_calls_pending`, 429 and 503. */
	waitBudgetSeconds: number;
	/** How many times a `504 response_timeout` is retried with the same idempotency key. */
	timeoutRetries: number;
	/** Longest single wait when the API sends no Retry-After. */
	maxBackoffSeconds: number;
	/** How many times a turn that failed at the model provider (overloaded, unavailable) is retried. */
	providerRetries: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	waitBudgetSeconds: 120,
	timeoutRetries: 2,
	maxBackoffSeconds: 30,
	providerRetries: 2,
};

/**
 * How long a new message waits for an unanswered tool call from the previous one. In n8n a stopped
 * execution never delivers its result, so a long window only delays the reply.
 */
export const DEFAULT_PENDING_TOOL_CALL_WINDOW = 15;

/** Provider failures (`502 external_service_error`) worth retrying, by `details.kind`. */
const TRANSIENT_PROVIDER_FAILURES = new Set(['overloaded', 'unavailable', 'rate_limited', 'timeout', 'server_error']);

/** The failed run to retry, when a turn failed at the provider for a reason that usually passes. */
function retryableRun(error: unknown): string | undefined {
	if (!(error instanceof TwiggApiError) || error.status !== 502 || error.code !== 'external_service_error') return undefined;
	const details = error.details as { kind?: unknown; run_id?: unknown } | undefined;
	if (typeof details?.run_id !== 'string' || !TRANSIENT_PROVIDER_FAILURES.has(String(details.kind))) return undefined;
	return details.run_id;
}

export type ClientDeps = {
	request: HttpRequestFn;
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string, meta?: Record<string, unknown>) => void;
};

const RETRY_AFTER_CODES = new Set(['chat_busy', 'tool_calls_pending', 'rate_limited', 'unavailable']);

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === wanted) {
			if (Array.isArray(value)) return String(value[0]);
			if (value !== undefined && value !== null) return String(value);
		}
	}
	return undefined;
}

/** Retry-After as seconds. Accepts a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

function retryAfterFrom(response: HttpResponse, details: unknown): number | undefined {
	const fromHeader = parseRetryAfter(headerValue(response.headers, 'retry-after'));
	if (fromHeader !== undefined) return fromHeader;
	if (typeof details === 'object' && details !== null && 'retry_after_secs' in details) {
		const secs = (details as { retry_after_secs: unknown }).retry_after_secs;
		if (typeof secs === 'number') return secs;
	}
	return undefined;
}

const defaultSleep = async (ms: number) => await n8nSleep(ms);

export class TwiggClient {
	private readonly request: HttpRequestFn;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (message: string, meta?: Record<string, unknown>) => void;

	constructor(
		deps: ClientDeps,
		readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	) {
		this.request = deps.request;
		this.sleep = deps.sleep ?? defaultSleep;
		this.log = deps.log ?? (() => {});
	}

	private async call<T>(spec: HttpRequestSpec, okStatuses: number[]): Promise<{ status: number; body: T }> {
		const response = await this.request(spec);
		if (okStatuses.includes(response.statusCode)) {
			return { status: response.statusCode, body: response.body as T };
		}
		throw this.toError(response);
	}

	private toError(response: HttpResponse): TwiggApiError {
		const body = errorBodyFrom(response.statusCode, response.body);
		return new TwiggApiError(response.statusCode, body, {
			retryAfterSeconds: retryAfterFrom(response, body.details),
		});
	}

	async listModels(): Promise<CatalogueModel[]> {
		const { body } = await this.call<CatalogueModel[]>({ method: 'GET', path: '/api/v1/models' }, [200]);
		return body;
	}

	async getChatByExternalId(externalId: string): Promise<ChatSummary> {
		const { body } = await this.call<ChatSummary>(
			{ method: 'GET', path: `/api/v1/chats/external/${encodeExternalId(externalId)}` },
			[200],
		);
		return body;
	}

	/** The chat, or null when no chat holds this external id. */
	async findChatByExternalId(externalId: string): Promise<ChatSummary | null> {
		const response = await this.request({
			method: 'GET',
			path: `/api/v1/chats/external/${encodeExternalId(externalId)}`,
		});
		if (response.statusCode === 200) return response.body as ChatSummary;
		if (response.statusCode === 404) return null;
		throw this.toError(response);
	}

	async openChatByExternalId(
		externalId: string,
		request: OpenChatRequest = {},
	): Promise<{ chat: ChatSummary; created: boolean }> {
		const { status, body } = await this.call<ChatSummary>(
			{ method: 'PUT', path: `/api/v1/chats/external/${encodeExternalId(externalId)}`, body: request },
			[200, 201],
		);
		return { chat: body, created: status === 201 };
	}

	async deleteChatByExternalId(externalId: string): Promise<void> {
		await this.call<unknown>(
			{ method: 'DELETE', path: `/api/v1/chats/external/${encodeExternalId(externalId)}` },
			[204],
		);
	}

	async getHistoryByExternalId(
		externalId: string,
		qs: {
			before_ordinal?: number;
			after_ordinal?: number;
			limit?: number;
			include?: 'stubs' | 'none' | 'full';
		} = {},
	): Promise<HistoryPageResponse> {
		const { body } = await this.call<HistoryPageResponse>(
			{ method: 'GET', path: `/api/v1/chats/external/${encodeExternalId(externalId)}/history`, qs },
			[200],
		);
		return body;
	}

	async abortByExternalId(externalId: string): Promise<AbortAccepted> {
		const { body } = await this.call<AbortAccepted>(
			{ method: 'POST', path: `/api/v1/chats/external/${encodeExternalId(externalId)}/abort` },
			[202],
		);
		return body;
	}

	/**
	 * Submits one turn and waits for the JSON result, retrying the cases the API documents as
	 * retryable: `chat_busy` and `tool_calls_pending` (another turn or an unanswered tool call on
	 * the chat), 429 and 503 (all honouring Retry-After, within the wait budget), and
	 * `504 response_timeout` when the request carried an idempotency key, so the retry fetches the
	 * result of the turn that is still running instead of sending the message again.
	 */
	async createResponseByExternalId(
		externalId: string,
		request: CreateResponseRequest,
	): Promise<ResponseBody> {
		const path = `/api/v1/chats/external/${encodeExternalId(externalId)}/responses`;
		let attempt = request;
		for (let retries = 0; ; retries++) {
			const outcome = await this.callWithWaits<ResponseBody>(
				{ method: 'POST', path, body: attempt },
				[200],
				Boolean(attempt.idempotency_key),
			).then(
				({ body }) => ({ body, failure: undefined }),
				(failure: unknown) => ({ body: undefined, failure }),
			);
			if (outcome.body) return outcome.body;

			// The provider failed after Twigg stored the input. Retry that run rather than resending
			// the input (which would add it to the history twice), as the API documents for retry_of.
			const runId = retryableRun(outcome.failure);
			if (!runId || retries >= this.policy.providerRetries) throw outcome.failure;
			this.log('Twigg: model provider failed, retrying the run', { runId, attempt: retries + 1 });
			await this.sleep(Math.min(2 ** (retries + 1), this.policy.maxBackoffSeconds) * 1000);
			attempt = {
				...request,
				input: [],
				retry_of: runId,
				...(request.idempotency_key ? { idempotency_key: `${request.idempotency_key}.r${retries + 1}` } : {}),
			};
		}
	}

	/**
	 * Imports past conversation into an empty chat: 201 when stored, 200 with `skipped` when the chat
	 * already had history. Waits out `chat_busy` and 503 like a turn does.
	 */
	async importHistoryByExternalId(
		externalId: string,
		request: ImportHistoryRequest,
	): Promise<{ status: number; body: ImportHistoryResponse }> {
		return await this.callWithWaits<ImportHistoryResponse>(
			{ method: 'POST', path: `/api/v1/chats/external/${encodeExternalId(externalId)}/import`, body: request },
			[200, 201],
			false,
		);
	}

	/** One request, waiting and retrying while the API says to come back later. */
	private async callWithWaits<T>(
		spec: HttpRequestSpec,
		okStatuses: number[],
		retryTimeouts: boolean,
	): Promise<{ status: number; body: T }> {
		let waitedSeconds = 0;
		let waits = 0;
		let timeoutRetries = 0;

		for (;;) {
			const response = await this.request(spec);
			if (okStatuses.includes(response.statusCode)) {
				return { status: response.statusCode, body: response.body as T };
			}

			const error = this.toError(response);

			if (RETRY_AFTER_CODES.has(error.code) || error.status === 429 || error.status === 503) {
				const wait = error.retryAfterSeconds ?? Math.min(2 ** waits, this.policy.maxBackoffSeconds);
				if (waitedSeconds + wait > this.policy.waitBudgetSeconds) {
					this.log('Twigg: giving up waiting', { code: error.code, waitedSeconds, wait });
					throw error;
				}
				this.log('Twigg: waiting before retry', { code: error.code, wait, waitedSeconds });
				await this.sleep(wait * 1000);
				waitedSeconds += wait;
				waits += 1;
				continue;
			}

			if (
				retryTimeouts &&
				error.status === 504 &&
				error.code === 'response_timeout' &&
				timeoutRetries < this.policy.timeoutRetries
			) {
				timeoutRetries += 1;
				this.log('Twigg: turn outlasted the request, fetching its result', { attempt: timeoutRetries });
				await this.sleep(1000);
				continue;
			}

			throw error;
		}
	}
}
