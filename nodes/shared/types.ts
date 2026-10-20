/**
 * Hand-written subset of the Twigg API v1 shapes (https://api.twigg.ai/openapi.json).
 * Only the fields this package reads or writes are listed.
 */

export type SubmittedMedia = {
	mime: string;
	data_base64: string;
	filename?: string | null;
};

export type SubmittedPrompt = {
	type: 'prompt';
	text: string;
	media?: SubmittedMedia[];
};

export type SubmittedToolResult = {
	type: 'tool_result';
	tool_use_id: string;
	tool_name: string;
	text: string;
	is_error?: boolean;
	media?: SubmittedMedia[];
};

export type SubmittedPart = SubmittedPrompt | SubmittedToolResult;

export type ToolDefinition = {
	name: string;
	description?: string | null;
	input_schema: Record<string, unknown>;
	strict?: boolean | null;
};

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'x_high' | 'max';

export type OpenChatRequest = {
	namespace?: string | null;
	title?: string | null;
	description?: string | null;
	user_metadata?: Record<string, unknown>;
};

export type CreateResponseRequest = {
	model: string;
	input: SubmittedPart[];
	stream: false;
	system?: string;
	tools?: ToolDefinition[];
	max_tokens?: number;
	reasoning_effort?: ReasoningEffort;
	wait_for_pending_tool_calls?: number;
	idempotency_key?: string;
	chat?: OpenChatRequest;
	user_metadata?: Record<string, unknown>;
};

export type StopReason =
	| 'end_turn'
	| 'max_tokens'
	| 'tool_use'
	| 'stop_sequence'
	| 'refusal'
	| 'aborted';

export type ResponseToolCall = {
	type: 'tool_call';
	tool_use_id: string;
	name: string;
	arguments: Record<string, unknown> | string;
};

export type ResponseContent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'refusal'; text: string }
	| ResponseToolCall;

export type PendingToolCall = {
	tool_use_id: string;
	name: string;
	arguments: Record<string, unknown> | string;
};

export type Usage = {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
};

export type ResponseBody = {
	run_id: string;
	chat_id: string;
	content: ResponseContent[];
	text: string;
	pending_tool_calls: PendingToolCall[];
	closed_tool_calls: string[];
	stop_reason: StopReason;
	usage: Usage;
	cost: string | null;
	cost_currency: string;
	model_served: string | null;
	provider_response_id: string | null;
	server_tools: unknown;
	compaction: unknown;
	config_warnings: unknown[];
	translation_warnings: unknown[];
	replayed: boolean;
};

export type ErrorBody = {
	code: string;
	message: string;
	hint?: string | null;
	details?: unknown;
};

export type ErrorEnvelope = { error: ErrorBody };

export type CatalogueModel = {
	id: string;
	name: string;
	display_name: string;
	provider: string;
	provider_label: string;
	context_window: number;
	max_output_tokens: number;
	supports_reasoning: boolean;
	supports_tools: boolean;
	rates?: { input?: string | null; output?: string | null; currency?: string } | null;
};

export type ChatSummary = {
	id: string;
	external_id: string | null;
	namespace: string | null;
	title: string | null;
	description: string | null;
	user_metadata: Record<string, unknown>;
	length: number;
	created_at: string;
	updated_at: string;
};

export type HistoryPart = {
	id: string;
	ordinal: number;
	role: 'user' | 'assistant';
	created_at: string;
	part: Record<string, unknown> & { type: string };
	user_metadata?: unknown;
	media?: unknown[] | null;
};

export type HistoryPageResponse = {
	data: HistoryPart[];
	first_ordinal: number | null;
	last_ordinal: number | null;
	has_more: boolean;
};

export type AbortAccepted = {
	chat_id: string;
	run_id: string;
	status: string;
};

/** History import: POST /api/v1/chats/external/{external_id}/import. */
export type ImportPart =
	| { type: 'prompt'; text: string; created_at?: string }
	| { type: 'message'; text: string; created_at?: string }
	| {
			type: 'tool_call';
			tool_use_id: string;
			name: string;
			arguments: Record<string, unknown> | string;
			created_at?: string;
	  }
	| {
			type: 'tool_result';
			tool_use_id: string;
			tool_name: string;
			text?: string;
			is_error?: boolean;
			created_at?: string;
	  };

/** No other fields: the endpoint refuses unknown ones (including idempotency_key) with 422. */
export type ImportHistoryRequest = {
	chat?: OpenChatRequest;
	parts: ImportPart[];
};

export type ImportWarning = {
	code:
		| 'empty_part_dropped'
		| 'unmatched_tool_result'
		| 'duplicate_tool_result'
		| 'empty_tool_result_filled'
		| 'duplicate_tool_call'
		| 'tool_call_closed'
		| 'tool_name_rewritten'
		| 'tool_results_moved_first'
		| 'leading_assistant'
		| string;
	part_index?: number;
	message: string;
};

/** 201 with what was stored and charged, or 200 with `skipped` when the chat already had history. */
export type ImportHistoryResponse = {
	chat_id: string;
	skipped?: boolean;
	existing_parts?: number;
	created_chat?: boolean;
	imported_parts?: number;
	dropped_parts?: number;
	closed_tool_calls?: string[];
	estimated_tokens?: number;
	cost?: string;
	cost_currency?: string;
	warnings?: ImportWarning[];
};
