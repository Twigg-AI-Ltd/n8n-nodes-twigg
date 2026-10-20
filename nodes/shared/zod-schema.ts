/**
 * Converts a Zod schema to JSON Schema without importing Zod.
 *
 * The SDK's `getParametersJsonSchema` only converts a tool's schema when it passes
 * `instanceof ZodSchema` against the SDK's own copy of Zod. Tools built by n8n (Calculator,
 * HTTP Request, Code, ...) come from n8n's copy, so the check fails and the Zod object itself is
 * returned, which serialises into `_def` noise the model cannot read. This module reads the
 * schema's definition structurally, so it works whichever copy built it. Community nodes cannot
 * have runtime dependencies, hence the hand-written walk.
 */

type JsonSchema = Record<string, unknown>;

type ZodLike = {
	_def?: ZodDef;
	_zod?: unknown;
	safeParse: (value: unknown) => unknown;
	toJSONSchema?: () => unknown;
	'~standard'?: { jsonSchema?: { input?: (options: { target: string }) => unknown } };
};

type ZodCheck = { kind: string; value?: unknown; inclusive?: boolean; regex?: RegExp };

type ZodDef = {
	typeName?: string;
	description?: string;
	[key: string]: unknown;
};

/** Anything with Zod's parse API, from any copy or major version of Zod. */
export function isZodSchema(value: unknown): value is ZodLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { safeParse?: unknown }).safeParse === 'function'
	);
}

const MAX_DEPTH = 32;

export function zodToJsonSchema(schema: ZodLike): JsonSchema {
	// Zod 4 can describe itself; prefer that over walking its internals.
	const standard = schema['~standard']?.jsonSchema?.input;
	if (typeof standard === 'function') {
		const converted = standard({ target: 'draft-07' });
		if (isObject(converted)) return converted;
	}
	if (typeof schema.toJSONSchema === 'function') {
		const converted = schema.toJSONSchema();
		if (isObject(converted)) return converted;
	}
	return convert(schema, 0);
}

function isObject(value: unknown): value is JsonSchema {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defOf(schema: unknown): ZodDef | undefined {
	if (!isObject(schema)) return undefined;
	const def = (schema as { _def?: unknown })._def;
	return isObject(def) ? (def as ZodDef) : undefined;
}

/** Optional fields are left out of `required`; a default makes a field optional on input. */
function isOptional(schema: unknown): boolean {
	const typeName = defOf(schema)?.typeName;
	if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
	if (typeName === 'ZodEffects') return isOptional(defOf(schema)?.schema);
	return false;
}

function convert(schema: unknown, depth: number): JsonSchema {
	const def = defOf(schema);
	// Unknown shapes (including Zod 4 internals) become "anything" rather than leaking into the request.
	if (!def || depth > MAX_DEPTH) return {};
	const result = convertDef(def, depth + 1);
	if (typeof def.description === 'string' && result.description === undefined) {
		result.description = def.description;
	}
	return result;
}

function convertDef(def: ZodDef, depth: number): JsonSchema {
	switch (def.typeName) {
		case 'ZodString': {
			const result: JsonSchema = { type: 'string' };
			for (const check of (def.checks as ZodCheck[] | undefined) ?? []) {
				if (typeof check.value === 'number') {
					if (check.kind === 'min' || check.kind === 'length') result.minLength = check.value;
					if (check.kind === 'max' || check.kind === 'length') result.maxLength = check.value;
				}
				if (check.kind === 'email') result.format = 'email';
				if (check.kind === 'url') result.format = 'uri';
				if (check.kind === 'uuid') result.format = 'uuid';
				if (check.kind === 'datetime') result.format = 'date-time';
				if (check.kind === 'regex' && check.regex instanceof RegExp) result.pattern = check.regex.source;
			}
			return result;
		}
		case 'ZodNumber': {
			const checks = (def.checks as ZodCheck[] | undefined) ?? [];
			const result: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
			for (const check of checks) {
				if (typeof check.value !== 'number') continue;
				if (check.kind === 'min') result[check.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = check.value;
				if (check.kind === 'max') result[check.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = check.value;
			}
			return result;
		}
		case 'ZodBigInt':
			return { type: 'integer' };
		case 'ZodBoolean':
			return { type: 'boolean' };
		case 'ZodDate':
			return { type: 'string', format: 'date-time' };
		case 'ZodNull':
			return { type: 'null' };
		case 'ZodAny':
		case 'ZodUnknown':
			return {};
		case 'ZodLiteral': {
			const value = def.value;
			const type = value === null ? 'null' : typeof value;
			return ['string', 'number', 'boolean', 'null'].includes(type) ? { type, const: value } : { const: value };
		}
		case 'ZodEnum':
			return { type: 'string', enum: def.values as unknown[] };
		case 'ZodNativeEnum': {
			const values = Object.entries((def.values as Record<string, unknown>) ?? {})
				// TypeScript numeric enums map names to numbers and numbers back to names; keep the values.
				.filter(([key]) => Number.isNaN(Number(key)))
				.map(([, value]) => value);
			return { enum: values };
		}
		case 'ZodObject': {
			const shape = typeof def.shape === 'function' ? (def.shape as () => unknown)() : def.shape;
			const properties: JsonSchema = {};
			const required: string[] = [];
			for (const [key, field] of Object.entries(isObject(shape) ? shape : {})) {
				properties[key] = convert(field, depth);
				if (!isOptional(field)) required.push(key);
			}
			const result: JsonSchema = { type: 'object', properties };
			if (required.length > 0) result.required = required;
			const catchall = defOf(def.catchall);
			if (catchall && catchall.typeName !== 'ZodNever') {
				result.additionalProperties = convert(def.catchall, depth);
			} else {
				result.additionalProperties = def.unknownKeys === 'passthrough';
			}
			return result;
		}
		case 'ZodArray': {
			const result: JsonSchema = { type: 'array', items: convert(def.type, depth) };
			if (isObject(def.minLength) && typeof def.minLength.value === 'number') result.minItems = def.minLength.value;
			if (isObject(def.maxLength) && typeof def.maxLength.value === 'number') result.maxItems = def.maxLength.value;
			if (isObject(def.exactLength) && typeof def.exactLength.value === 'number') {
				result.minItems = def.exactLength.value;
				result.maxItems = def.exactLength.value;
			}
			return result;
		}
		case 'ZodTuple': {
			const items = ((def.items as unknown[]) ?? []).map((item) => convert(item, depth));
			return { type: 'array', items, minItems: items.length, maxItems: items.length };
		}
		case 'ZodRecord':
			return { type: 'object', additionalProperties: convert(def.valueType, depth) };
		case 'ZodUnion':
		case 'ZodDiscriminatedUnion': {
			const options = def.options instanceof Map ? [...def.options.values()] : (def.options as unknown[]) ?? [];
			return { anyOf: options.map((option) => convert(option, depth)) };
		}
		case 'ZodIntersection':
			return { allOf: [convert(def.left, depth), convert(def.right, depth)] };
		case 'ZodNullable':
			return { anyOf: [convert(def.innerType, depth), { type: 'null' }] };
		case 'ZodOptional':
		case 'ZodReadonly':
		case 'ZodCatch':
			return convert(def.innerType, depth);
		case 'ZodDefault': {
			const result = convert(def.innerType, depth);
			try {
				const value = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : undefined;
				if (value !== undefined) result.default = value;
			} catch {
				// A default that cannot be computed up front is simply not advertised.
			}
			return result;
		}
		case 'ZodBranded':
			return convert(def.type, depth);
		case 'ZodEffects':
			// Refinements and transforms: the model supplies the input side.
			return convert(def.schema, depth);
		case 'ZodPipeline':
			return convert(def.in, depth);
		case 'ZodLazy':
			return typeof def.getter === 'function' ? convert((def.getter as () => unknown)(), depth) : {};
		default:
			return {};
	}
}
