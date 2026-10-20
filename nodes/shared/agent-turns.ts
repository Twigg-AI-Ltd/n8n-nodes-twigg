import type { EngineRequest, EngineResponse, IDataObject, ITaskData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { AgentTool } from './agent-tools';
import type { ResponseBody, SubmittedToolResult } from './types';

/**
 * How the Twigg AI Agent runs tools: it hands Twigg's tool calls to the n8n engine as an
 * EngineRequest, the engine executes the tool nodes (so they appear in the run with their own
 * input and output), then calls the agent again with an EngineResponse holding the results. The
 * request's metadata comes back unchanged, so per-item progress travels in it.
 */

export type AgentItemState = {
	/** Twigg turns submitted so far for this item (the first message plus each round of tool results). */
	turns: number;
	/** Set once the item has its final reply. */
	output?: string;
	/** Set instead of `output` when the item failed and the node continues on fail. */
	error?: string;
	/** Tool results to send with the next round that the engine will not produce (unknown tools). */
	pendingResults?: SubmittedToolResult[];
};

export type AgentMetadata = {
	twiggAgent: { items: Record<number, AgentItemState> };
};

export type ToolActionMetadata = { itemIndex: number; toolName: string };

export function readMetadata(response: EngineResponse | undefined): AgentMetadata {
	const metadata = response?.metadata as Partial<AgentMetadata> | undefined;
	return { twiggAgent: { items: { ...(metadata?.twiggAgent?.items ?? {}) } } };
}

function toolArguments(raw: unknown): IDataObject {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return { input: raw as string };
		}
	}
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as IDataObject) : { input: value as string };
}

/**
 * Turns the tool calls in a Twigg response into engine actions. A call for a tool that is not
 * connected (the model invented a name, or the tool was removed) gets an error result instead,
 * sent with the next round so the model can recover.
 */
export function toolCallActions(
	body: ResponseBody,
	itemIndex: number,
	tools: AgentTool[],
): { actions: EngineRequest<ToolActionMetadata>['actions']; unknownTools: SubmittedToolResult[] } {
	const actions: EngineRequest<ToolActionMetadata>['actions'] = [];
	const unknownTools: SubmittedToolResult[] = [];
	for (const block of body.content) {
		if (block.type !== 'tool_call') continue;
		const tool = tools.find((t) => t.definition.name === block.name);
		if (!tool) {
			unknownTools.push({
				type: 'tool_result',
				tool_use_id: block.tool_use_id,
				tool_name: block.name,
				text: `There is no tool named '${block.name}'. Available tools: ${tools.map((t) => t.definition.name).join(', ') || 'none'}.`,
				is_error: true,
			});
			continue;
		}
		const input = toolArguments(block.arguments);
		actions.push({
			actionType: 'ExecutionNodeAction',
			nodeName: tool.nodeName,
			input: tool.fromToolkit ? { ...input, tool: block.name } : input,
			type: NodeConnectionTypes.AiTool,
			id: block.tool_use_id,
			metadata: { itemIndex, toolName: block.name },
		});
	}
	return { actions, unknownTools };
}

/**
 * What a tool node produced, as the text Twigg stores. Tool nodes usually return one item of
 * `{ response: "..." }`; that is unwrapped so the model reads the text itself.
 */
export function toolResultText(data: ITaskData | undefined): { text: string; isError: boolean } {
	const items = (data?.data?.ai_tool?.[0] ?? []).map((item) => item?.json).filter((json) => json !== undefined);
	if (items.length === 1) {
		const only = items[0] as IDataObject;
		const keys = Object.keys(only);
		if (keys.length === 1 && keys[0] === 'response') {
			const response = only.response;
			return { text: typeof response === 'string' ? response : JSON.stringify(response), isError: false };
		}
		if (keys.length >= 1 && keys.includes('error') && keys.every((k) => k === 'error' || k === 'errorType')) {
			return { text: JSON.stringify(only), isError: true };
		}
		return { text: JSON.stringify(only), isError: false };
	}
	if (items.length > 1) return { text: JSON.stringify(items), isError: false };
	if (data?.error) return { text: JSON.stringify({ error: data.error.message ?? 'Tool failed' }), isError: true };
	return { text: '', isError: false };
}

/** The tool results the engine produced for one item, in Twigg's shape. */
export function toolResultsFor(response: EngineResponse | undefined, itemIndex: number): SubmittedToolResult[] {
	const results: SubmittedToolResult[] = [];
	for (const entry of response?.actionResponses ?? []) {
		const metadata = entry.action.metadata as Partial<ToolActionMetadata> | undefined;
		if (metadata?.itemIndex !== itemIndex) continue;
		const { text, isError } = toolResultText(entry.data);
		results.push({
			type: 'tool_result',
			tool_use_id: entry.action.id,
			tool_name: metadata.toolName ?? entry.action.nodeName,
			text,
			is_error: isError,
		});
	}
	return results;
}

/** The reply text of a finished turn. */
export function replyText(body: ResponseBody): string {
	return body.content
		.filter((block) => block.type === 'text' || block.type === 'refusal')
		.map((block) => (block as { text: string }).text)
		.join('\n\n');
}
