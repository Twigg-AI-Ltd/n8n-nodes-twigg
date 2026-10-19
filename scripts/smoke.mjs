// Live smoke test against the Twigg API. Needs TWIGG_API_KEY in the environment. Uses a cheap
// model in the `n8n-dev` namespace and deletes the chats it creates. Prints cost per turn.
//
// Run after `npm run build`:  node scripts/smoke.mjs
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { TwiggClient } = require('../dist/nodes/shared/client.js');
const { TwiggChatModel } = require('../dist/nodes/LmChatTwigg/TwiggChatModel.js');
const { resolveExternalId } = require('../dist/nodes/shared/ids.js');

const apiKey = process.env.TWIGG_API_KEY;
if (!apiKey) {
	console.error('TWIGG_API_KEY is not set');
	process.exit(2);
}
const baseUrl = process.env.TWIGG_BASE_URL ?? 'https://api.twigg.ai';
const model = process.env.TWIGG_SMOKE_MODEL ?? 'claude-haiku-5-5';
const namespace = 'n8n-dev';

let spent = 0;
const request = async (spec) => {
	const url = new URL(baseUrl + spec.path);
	for (const [k, v] of Object.entries(spec.qs ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		method: spec.method,
		headers: {
			authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
			accept: 'application/json',
			'x-twigg-client': 'n8n-nodes-twigg-smoke',
		},
		body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
		signal: AbortSignal.timeout(320_000),
	});
	const text = await res.text();
	let body = text;
	try {
		body = text === '' ? null : JSON.parse(text);
	} catch {}
	if (body && typeof body === 'object' && typeof body.cost === 'string') spent += Number(body.cost);
	return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body };
};

const client = new TwiggClient({ request, log: (m, meta) => console.log('  [client]', m, meta ?? '') });
const run = randomUUID().slice(0, 8);
const rawChatId = `n8n-smoke:+4477009${run}`;
const { id: externalId } = resolveExternalId(rawChatId, false);
const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const orderTool = {
	type: 'function',
	name: 'get_order_status',
	description: 'Look up an order by number',
	inputSchema: {
		type: 'object',
		properties: { order_id: { type: 'string', description: 'The order number' } },
		required: ['order_id'],
		additionalProperties: false,
	},
};

function makeModel(scope, overrides = {}) {
	return new TwiggChatModel(
		client,
		{
			model,
			externalId,
			chat: { namespace, title: rawChatId },
			pendingToolCallWindowSeconds: 60,
			idempotencyScope: [scope, 'node-1', 0],
			...overrides,
		},
		{ warn: (m) => console.log('  [warn]', m), toJsonSchema: (t) => t.inputSchema },
	);
}

const system = { role: 'system', content: [{ type: 'text', text: 'You are a terse support bot. Answer in one short sentence.' }] };
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

try {
	// 1. models
	const models = await client.listModels();
	check('list models', models.some((m) => m.name === model), `${models.length} models`);

	// 2. first message creates the chat (plain reply, remember a fact)
	const m1 = makeModel('exec-1');
	const r1 = await m1.generate([system, user('Hi, my name is Ann and my order number is 1042.')]);
	const text1 = r1.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
	check('first turn creates chat and replies', r1.finishReason === 'stop' && text1.length > 0, text1);
	const chat = await client.getChatByExternalId(externalId);
	check('chat is addressable by external id', chat.external_id === externalId && chat.namespace === namespace, `chat ${chat.id}, ${chat.length} parts`);

	// 3. replay: same execution scope + same input => replayed: true, no new run
	const r1b = await m1.generate([system, user('Hi, my name is Ann and my order number is 1042.')]);
	check('retry with same key replays', r1b.providerMetadata.twigg.replayed === true && r1b.id === r1.id, `run ${r1b.id}`);

	// 4. memory across executions (new scope => new key), no history sent
	const m2 = makeModel('exec-2');
	const r2 = await m2.generate([system, user('What is my name?')]);
	const text2 = r2.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
	check('server-side memory recalls the name', /ann/i.test(text2), text2);

	// 5. tool round in one execution: tool call, then tool result
	const m3 = makeModel('exec-3').withTools([orderTool]);
	const r3 = await m3.generate([system, user('Use the tool to check where my order is.')]);
	const call = r3.message.content.find((b) => b.type === 'tool-call');
	check('model requests the tool', r3.finishReason === 'tool-calls' && call?.toolName === 'get_order_status', JSON.stringify(call));
	let r4;
	if (call) {
		r4 = await m3.generate([
			system,
			user('Use the tool to check where my order is.'),
			r3.message,
			{ role: 'tool', name: 'get_order_status', content: [{ type: 'tool-result', toolCallId: call.toolCallId, result: { status: 'shipped', eta: '2026-10-22' } }] },
		]);
		const text4 = r4.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
		check('tool result is accepted and answered', r4.finishReason === 'stop' && /ship|22/i.test(text4), text4);
	}

	// 6. model switch on the same chat, history intact
	const alt = models.find((m) => m.supports_tools && m.provider !== models.find((x) => x.name === model)?.provider && (m.name === 'gpt-6-luna' || m.name === 'gemini-3.1-flash-lite'));
	if (alt) {
		const m5 = makeModel('exec-5', { model: alt.name });
		const r5 = await m5.generate([system, user('Which order number did I give you, and what was its status?')]);
		const text5 = r5.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
		check(`switching model to ${alt.name} keeps history`, /1042/.test(text5), text5);
	}

	// 7. interrupted tool call: a new message while a tool call is open closes it, with the window off
	const m6 = makeModel('exec-6', { pendingToolCallWindowSeconds: undefined }).withTools([orderTool]);
	const r6 = await m6.generate([system, user('Check order 777 with the tool.')]);
	const call6 = r6.message.content.find((b) => b.type === 'tool-call');
	if (call6) {
		const m7 = makeModel('exec-7', { pendingToolCallWindowSeconds: undefined });
		const r7 = await m7.generate([system, user('Never mind that. Just say hello.')]);
		check('next message after an abandoned tool call still works', r7.finishReason === 'stop', `closed: ${JSON.stringify(r7.providerMetadata.twigg.closed_tool_calls)}`);
		// and the late tool result for the closed call?
		let late;
		try {
			late = await m6.generate([system, user('Check order 777 with the tool.'), r6.message, { role: 'tool', name: 'get_order_status', content: [{ type: 'tool-result', toolCallId: call6.toolCallId, result: 'late' }] }]);
			check('late tool result for a closed call', true, `accepted, stop=${late.finishReason}`);
		} catch (e) {
			check('late tool result for a closed call', true, `rejected: ${e.status} ${e.code}: ${e.message}`);
		}
	} else {
		check('model requests tool for abandoned-call test', false, JSON.stringify(r6.message.content));
	}

	// 8. pending window: a message while a tool call is open gets tool_calls_pending and waits
	const m8 = makeModel('exec-8').withTools([orderTool]);
	const r8 = await m8.generate([system, user('Check order 555 with the tool.')]);
	const call8 = r8.message.content.find((b) => b.type === 'tool-call');
	if (call8) {
		const waiting = new TwiggClient({ request, log: (m, meta) => console.log('  [client]', m, meta ?? '') }, { waitBudgetSeconds: 3, timeoutRetries: 0, maxBackoffSeconds: 5 });
		const m9 = new TwiggChatModel(waiting, { model, externalId, chat: {}, pendingToolCallWindowSeconds: 60, idempotencyScope: ['exec-9', 'n', 0] }, { warn: console.log, toJsonSchema: (t) => t.inputSchema });
		const err = await m9.generate([system, user('Hello?')]).catch((e) => e);
		check('message during a pending tool call waits then reports tool_calls_pending', err?.code === 'tool_calls_pending', `${err?.status} ${err?.code} retry-after ${err?.retryAfterSeconds}`);
		await m8.generate([system, user('Check order 555 with the tool.'), r8.message, { role: 'tool', name: 'get_order_status', content: [{ type: 'tool-result', toolCallId: call8.toolCallId, result: 'delivered' }] }]);
	}

	// 9. history and delete
	const history = await client.getHistoryByExternalId(externalId, { limit: 100 });
	check('history readable', history.data.length > 5, `${history.data.length} parts; types: ${[...new Set(history.data.map((p) => p.part.type))].join(',')}`);
	await client.deleteChatByExternalId(externalId);
	const gone = await client.getChatByExternalId(externalId).catch((e) => e);
	check('delete frees the id', gone?.status === 404, `${gone?.status} ${gone?.code}`);
} catch (error) {
	console.error('UNEXPECTED', error);
	results.push({ name: 'unexpected error', ok: false });
} finally {
	await client.deleteChatByExternalId(externalId).catch(() => {});
	console.log(`\nspent this run: $${spent.toFixed(5)}`);
	const failed = results.filter((r) => !r.ok);
	console.log(`${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length ? 1 : 0);
}
