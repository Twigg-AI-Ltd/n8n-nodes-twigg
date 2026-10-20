import { getParametersJsonSchema, supplyModel } from '@n8n/ai-node-sdk';
import type { INodeType, INodeTypeDescription, ISupplyDataFunctions, SupplyData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { TwiggChatModel } from './TwiggChatModel';
import { resolveChatId } from '../shared/chat-id';
import { DEFAULT_RETRY_POLICY, TwiggClient } from '../shared/client';
import { chatTitleFor, resolveExternalId } from '../shared/ids';
import { DEFAULT_MODEL, loadModelOptions } from '../shared/models';
import { DEFAULT_TIMEOUT_MS, loadCredentials, makeN8nRequest } from '../shared/n8n-request';
import type { ReasoningEffort } from '../shared/types';

type ModelOptions = {
	namespace?: string;
	hashChatId?: boolean;
	onRefusal?: 'error' | 'returnText';
	maxTokens?: number;
	reasoningEffort?: 'default' | ReasoningEffort;
	pendingToolCallWindow?: number;
	waitBudget?: number;
	timeout?: number;
};

export class LmChatTwigg implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Twigg Chat Model',
		name: 'lmChatTwigg',
		icon: { light: 'file:twigg.svg', dark: 'file:twigg.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{ $parameter["model"] }}',
		description:
			'Any model with conversation memory kept by Twigg. Connect it to an AI Agent instead of a Memory node.',
		defaults: {
			name: 'Twigg Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/Twigg-AI-Ltd/n8n-nodes-twigg#readme',
					},
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'twiggApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'Twigg stores the whole conversation on its servers, trims old tool output and compacts long chats, so do not connect a Memory node to the Agent.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				description:
					'The model that answers. Every model shares the same conversation, so it can be changed at any time. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: DEFAULT_MODEL,
			},
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '={{ $json.sessionId }}',
				required: true,
				description:
					'What identifies this conversation: the chat ID from a Chat Trigger, a Telegram chat ID, a phone number, a ticket number. Each distinct value is its own conversation on Twigg.',
				hint: 'The default reads the sessionId field that the Chat Trigger node outputs',
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Hash Chat ID',
						name: 'hashChatId',
						type: 'boolean',
						default: false,
						description:
							'Whether to send a SHA-256 hash of the chat ID to Twigg instead of the ID itself. Turn on when the ID is personal data such as a phone number, since IDs appear in request logs.',
					},
					{
						displayName: 'Max Wait for a Busy Chat (Seconds)',
						name: 'waitBudget',
						type: 'number',
						default: 120,
						typeOptions: { minValue: 0 },
						description:
							'How long to keep waiting when another message is still being answered on the same chat, or Twigg asks to slow down, before the node fails',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						default: -1,
						description: 'The maximum number of tokens the model may generate per reply. -1 uses the model maximum.',
					},
					{
						displayName: 'Namespace',
						name: 'namespace',
						type: 'string',
						default: '',
						placeholder: 'e.g. support-bot',
						description:
							'The Twigg namespace new chats are created in. Namespaces carry their own instructions, tools and context budgets, configured in the Twigg console. Lowercase letters, digits, - and _, with / between levels.',
					},
					{
						displayName: 'On Refusal',
						name: 'onRefusal',
						type: 'options',
						default: 'error',
						description:
							'What happens when the model declines to answer. The refusal text can be a notice meant for developers, so by default the node fails rather than send it to the user as the reply.',
						options: [
							{
								name: 'Fail the Run',
								value: 'error',
								description:
									"Stop with an error that includes the refusal; handle it with an error workflow or the node's On Error setting",
							},
							{
								name: 'Return Refusal Text',
								value: 'returnText',
								description: 'Give the refusal to the Agent as the reply',
							},
						],
					},
					{
						displayName: 'Pending Tool Call Window (Seconds)',
						name: 'pendingToolCallWindow',
						type: 'number',
						default: 60,
						typeOptions: { minValue: 0, maxValue: 600 },
						description:
							'When a new message arrives while a tool from the previous message is still running, wait up to this long for the tool result instead of abandoning the tool call. 0 turns the wait off.',
					},
					{
						displayName: 'Reasoning Effort',
						name: 'reasoningEffort',
						type: 'options',
						default: 'default',
						description: 'How much the model thinks before answering, on models that support it',
						options: [
							{ name: 'Extra High', value: 'x_high' },
							{ name: 'High', value: 'high' },
							{ name: 'Low', value: 'low' },
							{ name: 'Max', value: 'max' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'Model Default', value: 'default' },
							{ name: 'Off', value: 'off' },
						],
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 320000,
						description:
							'Maximum time one request may take, in milliseconds. Twigg itself answers within about 280 seconds, so keep this above 280000.',
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await loadCredentials(this);
		const model = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as ModelOptions;

		const rawChatId = resolveChatId(this, itemIndex);
		const { id: externalId, hashed } = resolveExternalId(rawChatId, options.hashChatId === true);

		const client = new TwiggClient(
			{
				request: makeN8nRequest(this, credentials.baseUrl!, options.timeout ?? DEFAULT_TIMEOUT_MS),
				log: (message, meta) => this.logger.debug(message, meta),
			},
			{
				...DEFAULT_RETRY_POLICY,
				waitBudgetSeconds: options.waitBudget ?? DEFAULT_RETRY_POLICY.waitBudgetSeconds,
			},
		);

		const chat: { namespace?: string; title?: string } = {};
		if (options.namespace && options.namespace.trim() !== '') chat.namespace = options.namespace.trim();
		if (!hashed) {
			const title = chatTitleFor(rawChatId);
			if (title !== undefined) chat.title = title;
		}

		const pendingWindow = options.pendingToolCallWindow ?? 60;
		const chatModel = new TwiggChatModel(
			client,
			{
				model,
				externalId,
				chat,
				maxTokens: options.maxTokens !== undefined && options.maxTokens > 0 ? options.maxTokens : undefined,
				reasoningEffort:
					options.reasoningEffort && options.reasoningEffort !== 'default' ? options.reasoningEffort : undefined,
				pendingToolCallWindowSeconds: pendingWindow > 0 ? pendingWindow : undefined,
				onRefusal: options.onRefusal ?? 'error',
				idempotencyScope: [this.getExecutionId(), this.getNode().id, itemIndex],
			},
			{
				warn: (message, meta) => this.logger.warn(message, meta),
				toJsonSchema: (tool) => getParametersJsonSchema(tool) as Record<string, unknown>,
			},
		);

		return supplyModel(this, chatModel);
	}
}
