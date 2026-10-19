import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { TwiggClient } from '../shared/client';
import { TwiggApiError } from '../shared/errors';
import { resolveExternalId } from '../shared/ids';
import { DEFAULT_TIMEOUT_MS, loadCredentials, makeN8nRequest } from '../shared/n8n-request';
import type { HistoryPart } from '../shared/types';

type HistoryOptions = {
	limit?: number;
	include?: 'stubs' | 'none' | 'full';
	beforeOrdinal?: number;
	afterOrdinal?: number;
};

export class Twigg implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Twigg',
		name: 'twigg',
		icon: { light: 'file:twigg.svg', dark: 'file:twigg.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Look up, read, reset or abort the conversations the Twigg Chat Model keeps',
		defaults: {
			name: 'Twigg',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'twiggApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Chat', value: 'chat' },
					{ name: 'Model', value: 'model' },
				],
				default: 'chat',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['chat'] } },
				options: [
					{
						name: 'Abort',
						value: 'abort',
						description: 'Stop the reply that is being generated on a chat',
						action: 'Abort the running reply on a chat',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a chat and its history, so the next message starts a fresh conversation',
						action: 'Delete a chat',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Get a chat by its chat ID',
						action: 'Get a chat',
					},
					{
						name: 'Get History',
						value: 'history',
						description: 'Read the stored conversation, oldest first',
						action: 'Get the history of a chat',
					},
					{
						name: 'Open',
						value: 'open',
						description: 'Create the chat if it does not exist yet, otherwise get it',
						action: 'Open a chat',
					},
				],
				default: 'get',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['model'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List the models available to your API key, with prices',
						action: 'Get many models',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				displayOptions: { show: { resource: ['chat'] } },
				description: 'The same chat ID the Twigg Chat Model node uses for this conversation',
			},
			{
				displayName: 'Hash Chat ID',
				name: 'hashChatId',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['chat'] } },
				description:
					'Whether the chat ID is hashed before use. Must match the "Hash Chat ID" option on the Twigg Chat Model node.',
			},
			{
				displayName: 'Namespace',
				name: 'namespace',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['open'] } },
				description: 'The namespace to create the chat in. Ignored when the chat already exists.',
			},
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['open'] } },
				description: 'A title for the chat, shown in the Twigg console. Ignored when the chat already exists.',
			},
			{
				displayName: 'Options',
				name: 'historyOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['chat'], operation: ['history'] } },
				options: [
					{
						displayName: 'After Ordinal',
						name: 'afterOrdinal',
						type: 'number',
						default: 0,
						description:
							'Return the parts newer than this ordinal (the last_ordinal of a page you already have). 0 means not set.',
					},
					{
						displayName: 'Attachments',
						name: 'include',
						type: 'options',
						default: 'stubs',
						options: [
							{ name: 'Descriptors Only', value: 'stubs' },
							{ name: 'None', value: 'none' },
							{ name: 'Full (Base64, Max 20 Parts)', value: 'full' },
						],
						description: 'How much of each attachment to return',
					},
					{
						displayName: 'Before Ordinal',
						name: 'beforeOrdinal',
						type: 'number',
						default: 0,
						description:
							'Return the parts older than this ordinal (the first_ordinal of a page you already have). 0 means not set.',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 100 },
						default: 50,
						description: 'Max number of results to return',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await loadCredentials(this);
		const client = new TwiggClient({
			request: makeN8nRequest(this, credentials.baseUrl!, DEFAULT_TIMEOUT_MS),
			log: (message, meta) => this.logger.debug(message, meta),
		});
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const results = await runOperation(this, client, resource, operation, itemIndex);
				for (const json of results) {
					returnData.push({ json, pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				const wrapped = toNodeError(this, error, itemIndex);
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: wrapped.message, description: wrapped.description ?? undefined },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw wrapped;
			}
		}

		return [returnData];
	}
}

function toNodeError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): NodeOperationError | NodeApiError {
	if (error instanceof TwiggApiError) {
		return new NodeApiError(ctx.getNode(), { message: error.message, code: error.code } as JsonObject, {
			message: error.message,
			description: error.description,
			httpCode: String(error.status),
			itemIndex,
		});
	}
	if (error instanceof NodeOperationError || error instanceof NodeApiError) return error;
	return new NodeOperationError(ctx.getNode(), error as Error, { itemIndex });
}

function chatIdFor(ctx: IExecuteFunctions, itemIndex: number): string {
	const raw = ctx.getNodeParameter('chatId', itemIndex) as unknown;
	if (raw === '' || raw === undefined || raw === null) {
		throw new NodeOperationError(ctx.getNode(), 'Chat ID is empty', { itemIndex });
	}
	const hash = ctx.getNodeParameter('hashChatId', itemIndex, false) as boolean;
	return resolveExternalId(String(raw), hash).id;
}

function historyPartJson(part: HistoryPart): IDataObject {
	const { part: body, ...rest } = part;
	return { ...rest, ...body } as IDataObject;
}

async function runOperation(
	ctx: IExecuteFunctions,
	client: TwiggClient,
	resource: string,
	operation: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	if (resource === 'model' && operation === 'getAll') {
		const models = await client.listModels();
		return models as unknown as IDataObject[];
	}

	if (resource !== 'chat') {
		throw new NodeOperationError(ctx.getNode(), `Unknown resource "${resource}"`, { itemIndex });
	}
	const externalId = chatIdFor(ctx, itemIndex);

	switch (operation) {
		case 'get':
			return [(await client.getChatByExternalId(externalId)) as unknown as IDataObject];
		case 'open': {
			const namespace = (ctx.getNodeParameter('namespace', itemIndex, '') as string).trim();
			const title = (ctx.getNodeParameter('title', itemIndex, '') as string).trim();
			const { chat, created } = await client.openChatByExternalId(externalId, {
				...(namespace ? { namespace } : {}),
				...(title ? { title } : {}),
			});
			return [{ ...(chat as unknown as IDataObject), created }];
		}
		case 'delete':
			await client.deleteChatByExternalId(externalId);
			return [{ deleted: true, chat_id: externalId }];
		case 'abort': {
			const accepted = await client.abortByExternalId(externalId);
			return [accepted as unknown as IDataObject];
		}
		case 'history': {
			const options = ctx.getNodeParameter('historyOptions', itemIndex, {}) as HistoryOptions;
			const page = await client.getHistoryByExternalId(externalId, {
				limit: options.limit ?? 50,
				include: options.include,
				before_ordinal: options.beforeOrdinal ? options.beforeOrdinal : undefined,
				after_ordinal: options.afterOrdinal ? options.afterOrdinal : undefined,
			});
			return page.data.map(historyPartJson);
		}
		default:
			throw new NodeOperationError(ctx.getNode(), `Unknown operation "${operation}"`, { itemIndex });
	}
}
