import type { IExecuteFunctions, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Reads the Chat ID parameter. When it resolves to nothing, falls back to the sessionId of a
 * Chat Trigger in the workflow, the way n8n's own memory nodes do, before failing with an
 * explanation.
 */
export function resolveChatId(ctx: IExecuteFunctions | ISupplyDataFunctions, itemIndex: number): string {
	let raw = ctx.getNodeParameter('chatId', itemIndex, '') as unknown;
	if (raw === '' || raw === undefined || raw === null) {
		try {
			const chatTrigger = ctx.getChatTrigger();
			if (chatTrigger) {
				raw = ctx.evaluateExpression(`{{ $('${chatTrigger.name}').first().json.sessionId }}`, itemIndex);
			}
		} catch {
			// No chat trigger, or its data is not available: fall through to the error below.
		}
	}
	if (raw === '' || raw === undefined || raw === null) {
		throw new NodeOperationError(ctx.getNode(), 'No Chat ID found', {
			description:
				"Set 'Chat ID' to what identifies the conversation, such as {{ $json.sessionId }} from a Chat Trigger, or the sender's id from your messaging platform.",
			itemIndex,
		});
	}
	if (typeof raw === 'object') {
		throw new NodeOperationError(ctx.getNode(), 'Chat ID must be text or a number', {
			description: `Chat ID resolved to ${JSON.stringify(raw)}. Point it at a single field, such as {{ $json.sessionId }}.`,
			itemIndex,
		});
	}
	return String(raw);
}
