import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	ISupplyDataFunctions,
} from 'n8n-workflow';

import type { HttpRequestFn } from './client';

export const CREDENTIAL_NAME = 'twiggApi';
export const DEFAULT_BASE_URL = 'https://api.twigg.ai';
/** Named in requests so Twigg can tell this integration apart in its logs. */
export const CLIENT_HEADER = 'n8n-nodes-twigg';

/**
 * A non-streaming turn can take up to about 280 s on the API side before it returns
 * `504 response_timeout`; the HTTP timeout sits above that so the API's own answer wins.
 */
export const DEFAULT_TIMEOUT_MS = 320_000;

type RequestContext = IExecuteFunctions | ISupplyDataFunctions | ILoadOptionsFunctions;

export type TwiggCredentials = { apiKey: string; baseUrl?: string };

export function normaliseBaseUrl(baseUrl: string | undefined): string {
	const value = (baseUrl ?? '').trim();
	if (value === '') return DEFAULT_BASE_URL;
	return value.replace(/\/+$/, '');
}

export async function loadCredentials(ctx: RequestContext): Promise<TwiggCredentials> {
	const raw = (await (ctx as RequestContext).getCredentials(CREDENTIAL_NAME)) as IDataObject;
	return { apiKey: String(raw.apiKey ?? ''), baseUrl: normaliseBaseUrl(raw.baseUrl as string | undefined) };
}

/**
 * Builds the request function the client uses, on top of n8n's authenticated helper.
 * HTTP errors are not thrown by the helper (`ignoreHttpStatusErrors`) so the client can read
 * the status, the error envelope and `Retry-After` itself.
 */
export function makeN8nRequest(ctx: RequestContext, baseUrl: string, timeoutMs: number): HttpRequestFn {
	return async (spec) => {
		const options: IHttpRequestOptions = {
			method: spec.method,
			url: `${baseUrl}${spec.path}`,
			headers: { 'x-twigg-client': CLIENT_HEADER, accept: 'application/json' },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: timeoutMs,
		};
		if (spec.qs) {
			const qs: IDataObject = {};
			for (const [key, value] of Object.entries(spec.qs)) {
				if (value !== undefined) qs[key] = value;
			}
			options.qs = qs;
		}
		if (spec.body !== undefined) options.body = spec.body as IDataObject;

		const response = (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			CREDENTIAL_NAME,
			options,
		)) as IN8nHttpFullResponse;

		return {
			statusCode: response.statusCode,
			headers: (response.headers ?? {}) as Record<string, unknown>,
			body: response.body,
		};
	};
}
