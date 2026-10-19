import { sleep as n8nSleep } from 'n8n-workflow';

import { errorBodyFrom, TwiggApiError } from './errors';
import { encodeExternalId } from './ids';
import type {
	AbortAccepted,
	CatalogueModel,
	ChatSummary,
	CreateResponseRequest,
	HistoryPageResponse,
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
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	waitBudgetSeconds: 120,
	timeoutRetries: 2,
	maxBackoffSeconds: 30,
};

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
		let waitedSeconds = 0;
		let waits = 0;
		let timeoutRetries = 0;

		for (;;) {
			const response = await this.request({ method: 'POST', path, body: request });
			if (response.statusCode === 200) return response.body as ResponseBody;

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
				error.status === 504 &&
				error.code === 'response_timeout' &&
				request.idempotency_key &&
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
