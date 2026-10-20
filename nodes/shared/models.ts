import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { TwiggClient } from './client';
import { loadCredentials, makeN8nRequest } from './n8n-request';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

/** Chats from n8n land here unless a node says otherwise, so one budget and retention policy covers them. */
export const DEFAULT_NAMESPACE = 'n8n';

/** A per-million-token rate for display: `"10.500000000000"` becomes `$10.5`. */
export function formatRate(rate: string | number | null | undefined): string {
	const value = Number(rate);
	if (rate === null || rate === undefined || rate === '' || !Number.isFinite(value)) return '?';
	return `$${Number(value.toPrecision(4))}`;
}

/** The model dropdown: tool-capable models on the credential's key, with their prices. */
export async function loadModelOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await loadCredentials(this);
	const client = new TwiggClient({
		request: makeN8nRequest(this, credentials.baseUrl!, 30_000),
	});
	const models = await client.listModels();
	return models
		.filter((model) => model.supports_tools)
		.map((model) => ({
			name: `${model.display_name} (${model.provider_label})`,
			value: model.name,
			description: `${model.name}: ${formatRate(model.rates?.input)} in / ${formatRate(model.rates?.output)} out per million tokens`,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
