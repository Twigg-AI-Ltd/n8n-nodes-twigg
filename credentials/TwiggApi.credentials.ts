import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TwiggApi implements ICredentialType {
	name = 'twiggApi';

	displayName = 'Twigg API';

	documentationUrl = 'https://twigg.ai/docs/quickstart';

	icon = { light: 'file:../icons/twigg.svg', dark: 'file:../icons/twigg.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'An API key from the Twigg console (https://twigg.ai/dashboard)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.twigg.ai',
			description: 'Leave as is unless Twigg gave you a different API host',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl?.replace(/\\/+$/, "") || "https://api.twigg.ai"}}',
			url: '/api/v1/models',
			method: 'GET',
		},
	};
}
