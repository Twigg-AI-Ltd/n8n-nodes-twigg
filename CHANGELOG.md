# Changelog

## Unreleased

- Existing conversations from n8n Memory nodes: **Use External Memory** on the Twigg AI Agent moves each conversation to Twigg on its first message; **Twigg → Chat → Import All** moves them all at once, reports each chat's status, stops if the balance runs out, and can be re-run safely. Uses the Twigg import endpoint, which is not live yet: until then the agent answers without importing.
- **Namespace** is now a visible setting on the Twigg AI Agent and Twigg Chat Model, defaulting to `n8n`.
- Model prices in the model list read `$0.105` instead of `0.105000000000`.
- **Twigg AI Agent** node: an AI agent with a Tool input and no Chat Model or Memory input. Twigg runs the model and keeps the conversation; n8n runs the tool nodes. Examples in `examples/twigg-agent/`.
- Tools attached to the Agent now reach the model with their real input schema. n8n's own tools (Calculator, HTTP Request, ...) were sent as unconverted Zod objects.
- Example workflows for a support bot, a WhatsApp lead qualifier and a Telegram bot, each with a classic Memory-node version for comparison, and recommended Twigg settings in the README.
- The published package no longer includes TypeScript declaration files, which n8n's community package scanner rejects.
- A model refusal fails the run by default instead of becoming the reply. Options → On Refusal → Return Refusal Text keeps the old behaviour.

## 0.1.0

- Twigg Chat Model sub-node for AI Agents and LLM chains: conversation kept by Twigg, no Memory node.
- Twigg action node: Chat Get / Open / Get History / Delete / Abort, Model Get Many.
- Twigg API credential with connection test.
