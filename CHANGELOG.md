# Changelog

## Unreleased

- **Twigg AI Agent** node: an AI agent with a Tool input and no Chat Model or Memory input. Twigg runs the model and keeps the conversation; n8n runs the tool nodes. Examples in `examples/twigg-agent/`.
- Tools attached to the Agent now reach the model with their real input schema. n8n's own tools (Calculator, HTTP Request, ...) were sent as unconverted Zod objects.
- Example workflows for a support bot, a WhatsApp lead qualifier and a Telegram bot, each with a classic Memory-node version for comparison, and recommended Twigg settings in the README.
- The published package no longer includes TypeScript declaration files, which n8n's community package scanner rejects.
- A model refusal fails the run by default instead of becoming the reply. Options → On Refusal → Return Refusal Text keeps the old behaviour.

## 0.1.0

- Twigg Chat Model sub-node for AI Agents and LLM chains: conversation kept by Twigg, no Memory node.
- Twigg action node: Chat Get / Open / Get History / Delete / Abort, Model Get Many.
- Twigg API credential with connection test.
