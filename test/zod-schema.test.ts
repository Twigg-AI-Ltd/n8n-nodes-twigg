import { getParametersJsonSchema } from '@n8n/ai-node-sdk';
import type { Tool } from '@n8n/ai-node-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toToolDefinitions } from '../nodes/shared/translate';
import { isZodSchema, zodToJsonSchema } from '../nodes/shared/zod-schema';

// The SDK loads Zod's CommonJS build; this file imports the ESM build. That is two copies of Zod,
// the same split as between n8n's own tools and a community node's SDK in a real install.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdkZod = require(require.resolve('zod', { paths: [require.resolve('@n8n/ai-node-sdk')] })) as typeof z;

/** The schema n8n's Calculator tool has: LangChain's string-tool wrapper. */
const calculatorSchema = z
	.object({ input: z.string().optional() })
	.transform((value) => value.input);

const calculatorTool: Tool = {
	type: 'function',
	name: 'Calculator',
	description: 'Useful for getting the result of a math expression.',
	inputSchema: calculatorSchema as unknown as Record<string, unknown>,
};

describe('tool schemas from another copy of Zod', () => {
	it('reproduces the SDK handing back the Zod object unconverted', () => {
		expect(calculatorSchema instanceof sdkZod.ZodSchema).toBe(false);
		expect(isZodSchema(getParametersJsonSchema(calculatorTool))).toBe(true);
	});

	it('sends the Calculator a real JSON schema', () => {
		const [definition] = toToolDefinitions([calculatorTool], (tool) =>
			getParametersJsonSchema(tool) as Record<string, unknown>,
		);
		expect(definition.input_schema).toEqual({
			type: 'object',
			properties: { input: { type: 'string' } },
			additionalProperties: false,
		});
	});

	it('leaves schemas the SDK did convert alone', () => {
		const tool: Tool = { ...calculatorTool, inputSchema: sdkZod.object({ input: sdkZod.string() }) as unknown as Record<string, unknown> };
		const [definition] = toToolDefinitions([tool], (t) => getParametersJsonSchema(t) as Record<string, unknown>);
		expect(definition.input_schema).toMatchObject({
			type: 'object',
			properties: { input: { type: 'string' } },
			required: ['input'],
		});
	});
});

describe('zodToJsonSchema', () => {
	it('converts the types n8n tools are built from', () => {
		const schema = z
			.object({
				query: z.string().min(1).max(200).describe('What to search for'),
				limit: z.number().int().min(1).max(50).default(10),
				ratio: z.number().gt(0),
				exact: z.boolean().optional(),
				mode: z.enum(['fast', 'thorough']),
				kind: z.literal('search'),
				tags: z.array(z.string()).max(5),
				filters: z.record(z.string()),
				after: z.date().nullable(),
				email: z.string().email(),
				target: z.union([z.string(), z.number()]),
				nested: z.object({ id: z.string() }).passthrough(),
			})
			.describe('Search the catalogue');

		expect(zodToJsonSchema(schema)).toEqual({
			type: 'object',
			description: 'Search the catalogue',
			properties: {
				query: { type: 'string', minLength: 1, maxLength: 200, description: 'What to search for' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
				ratio: { type: 'number', exclusiveMinimum: 0 },
				exact: { type: 'boolean' },
				mode: { type: 'string', enum: ['fast', 'thorough'] },
				kind: { type: 'string', const: 'search' },
				tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
				filters: { type: 'object', additionalProperties: { type: 'string' } },
				after: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
				email: { type: 'string', format: 'email' },
				target: { anyOf: [{ type: 'string' }, { type: 'number' }] },
				nested: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: true },
			},
			required: ['query', 'ratio', 'mode', 'kind', 'tags', 'filters', 'after', 'email', 'target', 'nested'],
			additionalProperties: false,
		});
	});

	it('handles recursive schemas without looping forever', () => {
		type Node = { name: string; children: Node[] };
		const node: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(node) }));
		expect(() => JSON.stringify(zodToJsonSchema(node as never))).not.toThrow();
	});

	it('turns shapes it does not know into an open schema, never Zod internals', () => {
		const odd = { safeParse: () => ({}), _def: { typeName: 'ZodSomethingNew', secret: 'internal' } };
		expect(zodToJsonSchema(odd)).toEqual({});
	});
});
