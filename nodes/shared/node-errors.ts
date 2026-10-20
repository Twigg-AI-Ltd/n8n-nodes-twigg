import type { INode, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { TwiggApiError } from './errors';

/** n8n error types for the editor's error panel, keeping Twigg's code, hint and details. */
export function toNodeError(node: INode, error: unknown, itemIndex: number): NodeOperationError | NodeApiError {
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
