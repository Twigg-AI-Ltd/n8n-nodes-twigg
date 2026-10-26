import type {
	EngineRequest,
	EngineResponse,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { agentProperties, executeAgent } from './agent';
import { TwiggClient } from '../shared/client';
import { TwiggApiError } from '../shared/errors';
import { importFromMemory, isImportUnavailable, MAX_IMPORT_PARTS } from '../shared/history-import';
import { chatTitleFor, resolveExternalId } from '../shared/ids';
import { DEFAULT_NAMESPACE, loadModelOptions } from '../shared/models';
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
		// Version 2 added the Agent resource and made it the default.
		version: [1, 2],
		defaultVersion: 2,
		subtitle: '={{ $parameter["resource"] === "agent" ? $parameter["model"] : $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'An AI agent whose model and memory are Twigg, and the operations on the conversations Twigg keeps for your agents',
		defaults: {
			name: 'Twigg',
		},
		// The agent takes tools, plus an External Memory input while "Use External Memory" is on.
		// Import All reads from an n8n Memory node, so that operation gets an External Memory input too.
		inputs: `={{ ((resource, operation, useExternalMemory) => {
			const memory = { type: 'ai_memory', displayName: 'External Memory', required: true, maxConnections: 1 };
			if (resource === 'agent') return ['main', { type: 'ai_tool', displayName: 'Tool', required: false }, ...(useExternalMemory ? [memory] : [])];
			if (resource === 'chat' && operation === 'importAll') return ['main', memory];
			return ['main'];
		})($parameter.resource, $parameter.operation, $parameter.useExternalMemory) }}`,
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
				displayOptions: { show: { '@version': [1] } },
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Agent', value: 'agent' },
					{ name: 'Chat', value: 'chat' },
					{ name: 'Model', value: 'model' },
				],
				default: 'agent',
				displayOptions: { show: { '@version': [{ _cnd: { gte: 2 } }] } },
			},
			...agentProperties,
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
						name: 'Import All',
						value: 'importAll',
						description:
							'Move every conversation from an external Memory node to Twigg, one per input item. Chats already on Twigg are skipped, so it is safe to run again.',
						action: 'Import all chats from external memory',
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
					'Imports one conversation per input item. Feed it one item per session, for example from a Postgres node running SELECT DISTINCT session_id FROM n8n_chat_histories, and set the external Memory node to Define Below with its key set to the same field. Chats already on Twigg are skipped and not charged again, so if some fail (for example when the balance runs out), fix the cause and run it again. The external memory is only read.',
				name: 'importNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['importAll'] } },
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				displayOptions: { show: { resource: ['chat'] }, hide: { operation: ['importAll'] } },
				description: 'The same Chat ID the agent or Twigg Chat Model uses for this conversation',
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.session_id }}',
				required: true,
				displayOptions: { show: { resource: ['chat'], operation: ['importAll'] } },
				description:
					'The Chat ID the conversation will have on Twigg: the value your Twigg agent or Twigg Chat Model uses as Chat ID, usually the old session ID',
			},
			{
				displayName: 'Remove Memory Node Suffix',
				name: 'stripMemorySuffix',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['chat'], operation: ['importAll'] } },
				description:
					'Whether to remove the "__&lt;memory node name&gt;" that n8n adds to session IDs from a Chat Trigger, so each chat gets the same Chat ID your agent uses (the plain session ID)',
			},
			{
				displayName: 'Hash Chat ID',
				name: 'hashChatId',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['chat'] } },
				description:
					'Whether the chat ID is hashed before use. Must match the "Hash Chat ID" option of the agent or Twigg Chat Model that uses this chat.',
			},
			{
				displayName: 'Namespace',
				name: 'namespace',
				type: 'string',
				default: DEFAULT_NAMESPACE,
				displayOptions: { show: { resource: ['chat'], operation: ['open', 'importAll'] } },
				description:
					'The namespace to create the chat in: the same Namespace your Twigg agent or Twigg Chat Model uses',
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

	methods = {
		loadOptions: {
			getModels: loadModelOptions,
		},
	};

	async execute(this: IExecuteFunctions, response?: EngineResponse): Promise<INodeExecutionData[][] | EngineRequest> {
		const resource = this.getNodeParameter('resource', 0) as string;
		if (resource === 'agent') {
			return await executeAgent.call(this, response);
		}

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentials = await loadCredentials(this);
		const client = new TwiggClient({
			request: makeN8nRequest(this, credentials.baseUrl!, DEFAULT_TIMEOUT_MS),
			log: (message, meta) => this.logger.debug(message, meta),
		});
		const operation = this.getNodeParameter('operation', 0) as string;

		if (resource === 'chat' && operation === 'importAll') {
			return [await importAll(this, client, items.length)];
		}

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

function chatIdFor(
	ctx: IExecuteFunctions,
	itemIndex: number,
	adjust: (raw: string) => string = (raw) => raw,
): { id: string; raw: string; hashed: boolean } {
	const value = ctx.getNodeParameter('chatId', itemIndex) as unknown;
	if (value === '' || value === undefined || value === null) {
		throw new NodeOperationError(ctx.getNode(), 'Chat ID is empty', {
			description: "Set 'Chat ID' to the conversation's ID, such as {{ $json.sessionId }} from a Chat Trigger.",
			itemIndex,
		});
	}
	const raw = adjust(String(value));
	const hash = ctx.getNodeParameter('hashChatId', itemIndex, false) as boolean;
	return { ...resolveExternalId(raw, hash), raw };
}

/**
 * n8n's Memory nodes (v1.4+) store a Chat Trigger session as `<sessionId>__<node name>`, with the
 * name's other characters turned into `_`. The agent's Chat ID is the plain session ID, so the
 * suffix comes off: the connected Memory node's own name first, then any trailing node-name-like part.
 */
export function withoutMemorySuffix(sessionId: string, memoryNodeNames: string[]): string {
	for (const name of memoryNodeNames) {
		const suffix = `__${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
		if (sessionId.endsWith(suffix) && sessionId.length > suffix.length) return sessionId.slice(0, -suffix.length);
	}
	const at = sessionId.lastIndexOf('__');
	if (at > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(sessionId.slice(at + 2))) return sessionId.slice(0, at);
	return sessionId;
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

type ImportStatus = 'imported' | 'skipped' | 'empty' | 'failed' | 'not_attempted';

/** Errors after which every remaining import would fail the same way, so the run stops sending. */
const STOP_CODES: Record<string, string> = {
	payment_required: 'The Twigg balance ran out. Top up in the Twigg console, then run this again.',
	http_401: 'Twigg rejected the API key. Check the Twigg credential, then run this again.',
};

/**
 * Import All: one conversation per input item, then a summary on the node. Per-chat problems don't
 * fail the node; each item reports its status. A re-run only imports what is left, because Twigg
 * skips (and doesn't charge for) chats that already have history.
 */
async function importAll(ctx: IExecuteFunctions, client: TwiggClient, itemCount: number): Promise<INodeExecutionData[]> {
	const output: INodeExecutionData[] = [];
	const counts: Record<ImportStatus, number> = { imported: 0, skipped: 0, empty: 0, failed: 0, not_attempted: 0 };
	let stopped: { code: string; message: string } | undefined;
	let cost = 0;
	let truncated = 0;

	const memoryNodeNames = ctx
		.getParentNodes(ctx.getNode().name, { connectionType: NodeConnectionTypes.AiMemory, depth: 1 })
		.map((node) => node.name);

	for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
		let chatId = '';
		let json: IDataObject;
		try {
			const strip = ctx.getNodeParameter('stripMemorySuffix', itemIndex, true) === true;
			const sessionId = String(ctx.getNodeParameter('chatId', itemIndex, '') ?? '');
			const resolved = chatIdFor(ctx, itemIndex, strip ? (raw) => withoutMemorySuffix(raw, memoryNodeNames) : undefined);
			chatId = resolved.id;
			const source = sessionId !== resolved.raw ? { memory_session_id: sessionId } : {};
			if (stopped) {
				json = { chat_id: chatId, ...source, status: 'not_attempted', error: stopped };
			} else {
				const memory = await ctx.getInputConnectionData(NodeConnectionTypes.AiMemory, itemIndex);
				if (!memory) {
					throw new NodeOperationError(ctx.getNode(), 'No external memory connected', {
						description: 'Connect the Memory node your old agent used to the External Memory input.',
						itemIndex,
					});
				}
				const namespace = String(ctx.getNodeParameter('namespace', itemIndex, DEFAULT_NAMESPACE) ?? '').trim();
				const title = resolved.hashed ? undefined : chatTitleFor(resolved.raw);
				const outcome = await importFromMemory(
					client,
					chatId,
					{ ...(namespace ? { namespace } : {}), ...(title ? { title } : {}) },
					memory,
				);
				json = { chat_id: chatId, ...source, status: outcome.status, messages_read: outcome.sent };
				if (outcome.status !== 'empty') {
					Object.assign(json, outcome.response as unknown as IDataObject, { chat_id: chatId, ...source, status: outcome.status });
					cost += Number(outcome.response.cost ?? 0) || 0;
				}
				if (outcome.leftOut > 0) {
					json.older_messages_left_out = outcome.leftOut;
					truncated += 1;
				}
			}
		} catch (error) {
			if (isImportUnavailable(error)) {
				throw new NodeOperationError(ctx.getNode(), "Twigg's history import isn't available yet", {
					description:
						'This Twigg API does not have the import endpoint yet. Nothing was changed; run this again once it is live.',
					itemIndex,
				});
			}
			if (error instanceof NodeOperationError && error.message === 'No external memory connected') {
				throw toNodeError(ctx.getNode(), error, itemIndex);
			}
			const code = error instanceof TwiggApiError ? error.code : 'error';
			const message = error instanceof TwiggApiError ? error.description : (error as Error).message;
			json = { chat_id: chatId, status: 'failed', error: { code, message } };
			if (STOP_CODES[code]) stopped = { code, message: STOP_CODES[code] };
		}
		counts[json.status as ImportStatus] += 1;
		output.push({ json, pairedItem: { item: itemIndex } });
	}

	ctx.addExecutionHints(...importHints(counts, itemCount, stopped, cost, truncated));
	return output;
}

function importHints(
	counts: Record<ImportStatus, number>,
	total: number,
	stopped: { code: string; message: string } | undefined,
	cost: number,
	truncated: number,
): Array<{ message: string; type: 'info' | 'warning'; location: 'outputPane' }> {
	const done = counts.imported + counts.skipped + counts.empty;
	const tally = [
		counts.imported && `${counts.imported} imported`,
		counts.skipped && `${counts.skipped} already on Twigg`,
		counts.empty && `${counts.empty} empty`,
	]
		.filter(Boolean)
		.join(', ');
	const costNote = cost > 0 ? ` Import charge: $${Number(cost.toPrecision(4))}.` : '';
	const hints: Array<{ message: string; type: 'info' | 'warning'; location: 'outputPane' }> = [];

	if (done === total) {
		hints.push({
			type: 'info',
			location: 'outputPane',
			message: `All ${total} existing chats are on Twigg (${tally}).${costNote} You're safe to detach the external memory now.`,
		});
	} else {
		const notDone = counts.failed + counts.not_attempted;
		const reason = stopped ? ` ${stopped.message}` : ' Each item that was not imported says why.';
		hints.push({
			type: 'warning',
			location: 'outputPane',
			message: `${notDone} of ${total} chats were not imported.${reason} Running this again is safe: chats already on Twigg are skipped and not charged again, so only these are imported.${tally ? ` So far: ${tally}.` : ''}${costNote} Keep the external memory attached until every chat is on Twigg.`,
		});
	}
	if (truncated > 0) {
		hints.push({
			type: 'info',
			location: 'outputPane',
			message: `${truncated} chat${truncated === 1 ? ' was' : 's were'} longer than ${MAX_IMPORT_PARTS} messages; the oldest messages beyond that were left out (see older_messages_left_out).`,
		});
	}
	return hints;
}
