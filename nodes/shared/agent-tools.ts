import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { cleanInputSchema } from './translate';
import type { ToolDefinition } from './types';
import { isZodSchema, zodToJsonSchema } from './zod-schema';

/** A tool connected to the Twigg AI Agent: what Twigg is told, and which n8n node runs it. */
export type AgentTool = {
	definition: ToolDefinition;
	/** The node the engine executes for this tool. */
	nodeName: string;
	/** Toolkit tools (MCP Client and similar) share one node and are picked by a `tool` field. */
	fromToolkit: boolean;
};

/** The parts of a LangChain tool this node reads. Duck-typed: no LangChain dependency. */
type ConnectedTool = {
	name: string;
	description?: string;
	schema?: unknown;
};

function isToolkit(value: unknown): value is { tools: ConnectedTool[] } {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { tools?: unknown }).tools) &&
		typeof (value as { name?: unknown }).name !== 'string'
	);
}

function isTool(value: unknown): value is ConnectedTool {
	return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string';
}

export function toolInputSchema(schema: unknown): Record<string, unknown> {
	if (isZodSchema(schema)) return cleanInputSchema(zodToJsonSchema(schema));
	if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
		return cleanInputSchema(schema as Record<string, unknown>);
	}
	return { type: 'object', properties: {} };
}

/**
 * Pairs the connected tools with the nodes that provide them. `getInputConnectionData` returns one
 * entry per connected node, in the same order as `getParentNodes` lists them, which is also how
 * n8n's AI Agent attributes tools; a toolkit entry expands into several tools on one node.
 */
export function pairToolsWithNodes(connected: unknown[], parentNodeNames: string[]): AgentTool[] {
	const tools: AgentTool[] = [];
	connected.forEach((entry, index) => {
		const members = isToolkit(entry) ? entry.tools : [entry];
		for (const tool of members) {
			if (!isTool(tool)) continue;
			tools.push({
				definition: {
					name: tool.name,
					description: tool.description ?? null,
					input_schema: toolInputSchema(tool.schema),
				},
				nodeName: parentNodeNames[index] ?? tool.name,
				fromToolkit: isToolkit(entry),
			});
		}
	});
	return tools;
}

export async function collectTools(ctx: IExecuteFunctions, itemIndex: number): Promise<AgentTool[]> {
	const raw = await ctx.getInputConnectionData(NodeConnectionTypes.AiTool, itemIndex);
	const connected = Array.isArray(raw) ? raw : raw ? [raw] : [];
	const parentNodeNames = ctx
		.getParentNodes(ctx.getNode().name, { connectionType: NodeConnectionTypes.AiTool, depth: 1 })
		.filter((node) => !node.disabled)
		.map((node) => node.name);

	const tools = pairToolsWithNodes(connected, parentNodeNames);
	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.definition.name)) {
			throw new NodeOperationError(ctx.getNode(), `Two connected tools are both named '${tool.definition.name}'`, {
				description: 'Rename one of them: the model picks tools by name.',
				itemIndex,
			});
		}
		seen.add(tool.definition.name);
	}
	return tools;
}
