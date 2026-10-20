import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

import { TwiggClient } from './client';
import { loadCredentials, makeN8nRequest } from './n8n-request';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

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
			description: `${model.name}: ${model.rates?.input ?? '?'} in / ${model.rates?.output ?? '?'} out per million tokens`,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
