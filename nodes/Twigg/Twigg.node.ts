import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { TwiggClient } from '../shared/client';
import { importFromMemory, isImportUnavailable } from '../shared/history-import';
import { chatTitleFor, resolveExternalId } from '../shared/ids';
import { DEFAULT_NAMESPACE } from '../shared/models';
import { DEFAULT_TIMEOUT_MS, loadCredentials, makeN8nRequest } from '../shared/n8n-request';
import { toNodeError } from '../shared/node-errors';
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
		description: 'Look up, read, import, reset or abort the conversations Twigg keeps for your agents',
		defaults: {
			name: 'Twigg',
		},
		// Import History reads from an n8n Memory node, so that operation gets a Memory input.
		inputs: `={{ $parameter.resource === 'chat' && $parameter.operation === 'importHistory' ? ['main', { type: 'ai_memory', displayName: 'Memory', required: true, maxConnections: 1 }] : ['main'] }}`,
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
						name: 'Import History',
						value: 'importHistory',
						description:
							'Copy a conversation from an n8n Memory node into Twigg, if the chat has no history on Twigg yet',
						action: 'Import a chat history from memory',
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
				displayName:
					'Imports one conversation per input item. Feed it one item per old session, for example from a Postgres node running SELECT DISTINCT session_id FROM n8n_chat_histories, and set the connected Memory node\'s session key to the same field. A chat that already has history on Twigg is left as it is, so running this twice is safe. The old memory is only read.',
				name: 'importNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['importHistory'] } },
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				displayOptions: { show: { resource: ['chat'] }, hide: { operation: ['importHistory'] } },
				description: 'The same Chat ID the Twigg AI Agent or Twigg Chat Model uses for this conversation',
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.session_id }}',
				required: true,
				displayOptions: { show: { resource: ['chat'], operation: ['importHistory'] } },
				description:
					'The Chat ID the conversation will have on Twigg: the value your Twigg AI Agent or Twigg Chat Model uses as Chat ID, usually the old session ID',
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
				default: DEFAULT_NAMESPACE,
				displayOptions: { show: { resource: ['chat'], operation: ['open', 'importHistory'] } },
				description:
					'The namespace to create the chat in: the same Namespace your Twigg AI Agent or Twigg Chat Model uses',
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
				const wrapped = toNodeError(this.getNode(), error, itemIndex);
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

function chatIdFor(ctx: IExecuteFunctions, itemIndex: number): { id: string; raw: string; hashed: boolean } {
	const raw = ctx.getNodeParameter('chatId', itemIndex) as unknown;
	if (raw === '' || raw === undefined || raw === null) {
		throw new NodeOperationError(ctx.getNode(), 'Chat ID is empty', { itemIndex });
	}
	const hash = ctx.getNodeParameter('hashChatId', itemIndex, false) as boolean;
	return { ...resolveExternalId(String(raw), hash), raw: String(raw) };
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
	const chatId = chatIdFor(ctx, itemIndex);
	const externalId = chatId.id;

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
		case 'importHistory': {
			const memory = await ctx.getInputConnectionData(NodeConnectionTypes.AiMemory, itemIndex);
			if (!memory) {
				throw new NodeOperationError(ctx.getNode(), 'No Memory node connected', {
					description: 'Connect the Memory node your old agent used to the Memory input.',
					itemIndex,
				});
			}
			const namespace = String(ctx.getNodeParameter('namespace', itemIndex, DEFAULT_NAMESPACE) ?? '').trim();
			const title = chatId.hashed ? undefined : chatTitleFor(chatId.raw);
			try {
				const outcome = await importFromMemory(
					client,
					externalId,
					{ ...(namespace ? { namespace } : {}), ...(title ? { title } : {}) },
					memory,
				);
				return [
					{
						chat_id: externalId,
						status: outcome.status,
						messages_read: outcome.parts,
						...(outcome.status === 'empty' ? {} : (outcome.response as unknown as IDataObject)),
					},
				];
			} catch (error) {
				throw isImportUnavailable(error)
					? new NodeOperationError(ctx.getNode(), "Twigg's history import isn't available yet", {
							description:
								'This Twigg API does not have the import endpoint yet. Nothing was changed; run this again once it is live.',
							itemIndex,
						})
					: toNodeError(ctx.getNode(), error, itemIndex);
			}
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
