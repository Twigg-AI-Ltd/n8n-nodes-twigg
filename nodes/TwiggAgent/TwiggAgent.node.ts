import type {
	EngineRequest,
	EngineResponse,
	IExecuteFunctions,
	INode,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { collectTools } from '../shared/agent-tools';
import type { AgentItemState, ToolActionMetadata } from '../shared/agent-turns';
import { readMetadata, replyText, toolCallActions, toolResultsFor } from '../shared/agent-turns';
import { resolveChatId } from '../shared/chat-id';
import { DEFAULT_RETRY_POLICY, TwiggClient } from '../shared/client';
import { TwiggApiError, TwiggRefusalError } from '../shared/errors';
import { buildIdempotencyKey, chatTitleFor, resolveExternalId } from '../shared/ids';
import { DEFAULT_MODEL, loadModelOptions } from '../shared/models';
import { DEFAULT_TIMEOUT_MS, loadCredentials, makeN8nRequest } from '../shared/n8n-request';
import type { CreateResponseRequest, ReasoningEffort, SubmittedPart } from '../shared/types';

type AgentOptions = {
	namespace?: string;
	hashChatId?: boolean;
	maxIterations?: number;
	maxTokens?: number;
	reasoningEffort?: 'default' | ReasoningEffort;
	onRefusal?: 'error' | 'returnText';
	pendingToolCallWindow?: number;
	waitBudget?: number;
	timeout?: number;
};

export class TwiggAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Twigg AI Agent',
		name: 'twiggAgent',
		icon: { light: 'file:twigg.svg', dark: 'file:twigg.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{ $parameter["model"] }}',
		description:
			'An AI agent whose model and memory are Twigg: connect tools, pick a model, and each conversation is kept on Twigg',
		defaults: {
			name: 'Twigg AI Agent',
		},
		inputs: [
			NodeConnectionTypes.Main,
			{ type: NodeConnectionTypes.AiTool, displayName: 'Tool', required: false },
		],
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
				displayName:
					'Twigg runs the model and keeps the conversation, so this agent has no Chat Model or Memory input. Connect tools below and choose the model here.',
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
				displayName: 'Prompt (User Message)',
				name: 'text',
				type: 'string',
				required: true,
				default: '={{ $json.chatInput }}',
				typeOptions: { rows: 2 },
				description: 'The message the agent answers',
				hint: 'The default reads the chatInput field that the Chat Trigger node outputs',
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
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				default: 'You are a helpful assistant.',
				typeOptions: { rows: 4 },
				description: 'Instructions sent with every message. Not stored as conversation history, so it can be changed at any time.',
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
						displayName: 'Max Iterations',
						name: 'maxIterations',
						type: 'number',
						default: 10,
						typeOptions: { minValue: 1 },
						description: 'How many rounds of tool calls the agent may make for one message before it stops',
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
							'The Twigg namespace new chats are created in. Namespaces carry their own instructions, tools, context budgets and retention, configured in the Twigg console. Lowercase letters, digits, - and _, with / between levels.',
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
								description: 'Output the refusal as the reply',
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

	/**
	 * Called once per message, then again each time the engine has run the tool calls this node
	 * asked for (`response` holds their results). Each item is its own conversation turn.
	 */
	async execute(
		this: IExecuteFunctions,
		response?: EngineResponse,
	): Promise<INodeExecutionData[][] | EngineRequest> {
		const items = this.getInputData();
		const credentials = await loadCredentials(this);
		// The engine passes a response object on the first call too; only results mean a resumed run.
		const resumed = (response?.actionResponses?.length ?? 0) > 0;
		const metadata = readMetadata(resumed ? response : undefined);
		const state = metadata.twiggAgent.items;
		const actions: EngineRequest<ToolActionMetadata>['actions'] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const current: AgentItemState = state[itemIndex] ?? { turns: 0 };
			if (current.output !== undefined || current.error !== undefined) continue;

			let input: SubmittedPart[];
			if (!resumed) {
				const text = String(this.getNodeParameter('text', itemIndex, '') ?? '');
				if (text.trim() === '') {
					throw new NodeOperationError(this.getNode(), 'The prompt is empty', {
						description:
							"Set 'Prompt (User Message)' to the message to answer, such as {{ $json.chatInput }} from a Chat Trigger.",
						itemIndex,
					});
				}
				input = [{ type: 'prompt', text }];
			} else {
				input = [...(current.pendingResults ?? []), ...toolResultsFor(response, itemIndex)];
				if (input.length === 0) continue;
			}

			try {
				const result = await runTurns(this, itemIndex, current, input, credentials.baseUrl!);
				state[itemIndex] = result.state;
				actions.push(...result.actions);
			} catch (error) {
				if (!this.continueOnFail()) throw toNodeError(this.getNode(), error, itemIndex);
				state[itemIndex] = { turns: current.turns, error: (error as Error).message };
			}
		}

		if (actions.length > 0) {
			return { actions, metadata } as EngineRequest;
		}

		return [
			items.map((_, itemIndex) => {
				const itemState = state[itemIndex];
				const json = itemState?.error !== undefined ? { error: itemState.error } : { output: itemState?.output ?? '' };
				return { json, pairedItem: { item: itemIndex } };
			}),
		];
	}
}

/**
 * Submits one item's input to Twigg and keeps going while it can do so without the engine:
 * until the model either answers or calls tools the engine has to run.
 */
async function runTurns(
	ctx: IExecuteFunctions,
	itemIndex: number,
	previous: AgentItemState,
	firstInput: SubmittedPart[],
	baseUrl: string,
): Promise<{ state: AgentItemState; actions: EngineRequest<ToolActionMetadata>['actions'] }> {
	const options = ctx.getNodeParameter('options', itemIndex, {}) as AgentOptions;
	const model = ctx.getNodeParameter('model', itemIndex) as string;
	const systemMessage = String(ctx.getNodeParameter('systemMessage', itemIndex, '') ?? '');
	const maxIterations = options.maxIterations ?? 10;

	const rawChatId = resolveChatId(ctx, itemIndex);
	const { id: externalId, hashed } = resolveExternalId(rawChatId, options.hashChatId === true);
	const chat: { namespace?: string; title?: string } = {};
	if (options.namespace && options.namespace.trim() !== '') chat.namespace = options.namespace.trim();
	if (!hashed) {
		const title = chatTitleFor(rawChatId);
		if (title !== undefined) chat.title = title;
	}

	const client = new TwiggClient(
		{
			request: makeN8nRequest(ctx, baseUrl, options.timeout ?? DEFAULT_TIMEOUT_MS),
			log: (message, meta) => ctx.logger.debug(message, meta),
		},
		{ ...DEFAULT_RETRY_POLICY, waitBudgetSeconds: options.waitBudget ?? DEFAULT_RETRY_POLICY.waitBudgetSeconds },
	);
	const tools = await collectTools(ctx, itemIndex);
	const pendingWindow = options.pendingToolCallWindow ?? 60;

	let turns = previous.turns;
	let input = firstInput;
	for (;;) {
		if (turns > maxIterations) {
			throw new NodeOperationError(ctx.getNode(), `Stopped after ${maxIterations} rounds of tool calls`, {
				description:
					'The model kept calling tools. Raise Options → Max Iterations if this task needs more steps, or tighten the system message.',
				itemIndex,
			});
		}
		const request: CreateResponseRequest = { model, input, stream: false };
		if (systemMessage.trim() !== '') request.system = systemMessage;
		if (tools.length > 0) request.tools = tools.map((tool) => tool.definition);
		if (options.maxTokens !== undefined && options.maxTokens > 0) request.max_tokens = options.maxTokens;
		if (options.reasoningEffort && options.reasoningEffort !== 'default') request.reasoning_effort = options.reasoningEffort;
		if (pendingWindow > 0) request.wait_for_pending_tool_calls = pendingWindow;
		if (Object.keys(chat).length > 0) request.chat = chat;
		// Same execution, node, item and turn => same key => a retry replays the stored result.
		request.idempotency_key = buildIdempotencyKey([
			ctx.getExecutionId(),
			ctx.getNode().id,
			itemIndex,
			turns,
			externalId,
			request.model,
			request.system ?? null,
			request.tools ?? null,
			input,
		]);

		const body = await client.createResponseByExternalId(externalId, request);
		turns += 1;

		if (body.stop_reason === 'refusal' && options.onRefusal !== 'returnText') {
			const refusal = new TwiggRefusalError(replyText(body), body.run_id, body.model_served);
			throw new NodeOperationError(ctx.getNode(), refusal.message, { description: refusal.description, itemIndex });
		}

		const { actions, unknownTools } = toolCallActions(body, itemIndex, tools);
		if (actions.length > 0) {
			return { state: { turns, pendingResults: unknownTools.length > 0 ? unknownTools : undefined }, actions };
		}
		if (unknownTools.length > 0) {
			// Only invented tools: answer them straight away so the model can try again.
			input = unknownTools;
			continue;
		}
		return { state: { turns, output: replyText(body) }, actions: [] };
	}
}

/** n8n error types for the editor's error panel, keeping Twigg's code, hint and details. */
function toNodeError(node: INode, error: unknown, itemIndex: number): NodeOperationError | NodeApiError {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) return error;
	if (error instanceof TwiggApiError) {
		return new NodeApiError(node, { code: error.code, message: error.message } as JsonObject, {
			message: error.message,
			description: error.description,
			httpCode: String(error.status),
			itemIndex,
		});
	}
	return new NodeOperationError(node, error as Error, { itemIndex });
}
