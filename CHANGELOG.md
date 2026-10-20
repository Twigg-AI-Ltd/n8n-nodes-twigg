# Changelog

## Unreleased

- Tools attached to the Agent now reach the model with their real input schema. n8n's own tools (Calculator, HTTP Request, ...) were sent as unconverted Zod objects.
- A model refusal fails the run by default instead of becoming the reply. Options → On Refusal → Return Refusal Text keeps the old behaviour.

## 0.1.0

- Twigg Chat Model sub-node for AI Agents and LLM chains: conversation kept by Twigg, no Memory node.
- Twigg action node: Chat Get / Open / Get History / Delete / Abort, Model Get Many.
- Twigg API credential with connection test.
