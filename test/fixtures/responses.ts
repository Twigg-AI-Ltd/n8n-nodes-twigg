import type { ResponseBody } from '../../nodes/shared/types';

/** Shaped from the quickstart's example (ResponseBody in https://api.twigg.ai/openapi.json). */
export const toolUseResponse: ResponseBody = {
	run_id: '01912d51-4e7c-7a90-b3d2-8c5f1a0e6742',
	chat_id: '01912d4e-9c1a-7b3f-8a21-6f1e2c3d4b5a',
	content: [
		{ type: 'text', text: 'Let me check that for you.' },
		{
			type: 'tool_call',
			tool_use_id: 'toolu_01ORDER',
			name: 'get_order_status',
			arguments: { order_id: '1042' },
		},
	],
	text: 'Let me check that for you.',
	pending_tool_calls: [
		{ tool_use_id: 'toolu_01ORDER', name: 'get_order_status', arguments: { order_id: '1042' } },
	],
	closed_tool_calls: [],
	stop_reason: 'tool_use',
	usage: {
		input_tokens: 412,
		output_tokens: 58,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
	},
	cost: '0.00211300',
	cost_currency: 'USD',
	model_served: 'claude-opus-5',
	provider_response_id: null,
	server_tools: null,
	compaction: null,
	config_warnings: [],
	translation_warnings: [],
	replayed: false,
};

export const endTurnResponse: ResponseBody = {
	...toolUseResponse,
	run_id: '01912d52-0000-7a90-b3d2-8c5f1a0e6742',
	content: [
		{ type: 'reasoning', text: 'The order shipped.' },
		{ type: 'text', text: 'Order 1042 shipped and arrives on 8 September.' },
	],
	text: 'Order 1042 shipped and arrives on 8 September.',
	pending_tool_calls: [],
	stop_reason: 'end_turn',
	usage: {
		input_tokens: 100,
		output_tokens: 30,
		cache_read_tokens: 400,
		cache_write_tokens: 50,
		reasoning_tokens: 12,
	},
	replayed: true,
};

export const errorEnvelope = (code: string, message: string, details?: unknown) => ({
	error: { code, message, hint: null, ...(details !== undefined ? { details } : {}) },
});

export const refusalResponse: ResponseBody = {
	...toolUseResponse,
	run_id: '01912d53-0000-7a90-b3d2-8c5f1a0e6742',
	content: [{ type: 'refusal', text: 'API integrators: you can reduce refusals by configuring a fallback model.' }],
	text: 'API integrators: you can reduce refusals by configuring a fallback model.',
	pending_tool_calls: [],
	stop_reason: 'refusal',
	model_served: 'claude-haiku-5-5',
};
