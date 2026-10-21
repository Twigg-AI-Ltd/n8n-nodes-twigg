# Changelog

## 0.1.1 (2026-10-21)

- First release published from GitHub Actions with npm provenance, which n8n requires to verify a
  community node. No other changes from 0.1.0.

## 0.1.0 (2026-10-21)

First public release. Requires n8n 2.16 or later; tested on 2.16 and 2.44.

### Nodes

- **Twigg AI Agent.** An AI agent whose model and memory are Twigg: connect tools, pick the model,
  namespace and Chat ID in its settings, and each conversation is kept on Twigg. No Chat Model or
  Memory node. n8n runs the tool nodes, which show up in the execution as usual. Works with a Chat
  Trigger in Streaming mode, and as a tool of another agent.
- **Twigg Chat Model.** A chat model sub-node for n8n's AI Agent and LLM chains, for workflows that
  keep n8n's agent. Twigg holds the conversation, so no Memory node is needed.
- **Twigg.** Chat Get, Open, Get History, Delete (reset a conversation), Abort and Import All; Model
  Get Many.
- **Twigg API credential** with a connection test.

### Conversations

- Memory survives restarts, scaling and queue mode, with no database to set up.
- Switch the model at any time, across providers, with the history and past tool calls intact.
- A tool call that never got its result (for example a stopped execution) is closed on the next
  message instead of blocking the conversation.
- Two messages at once on one chat are answered in turn.
- Turns that fail at the model provider for a passing reason are retried without storing the message
  twice.
- Safe retries: each turn carries an idempotency key, so a retry returns the stored reply.
- A model refusal fails the run by default rather than reaching the user (Options → On Refusal).
- **Namespace** defaults to `n8n`, so one context budget and retention policy covers everything from
  n8n. See "Recommended Twigg settings" in the README.

### Moving from a Memory node

- **Use External Memory** on the Twigg AI Agent: connect the Memory node you used before, and each
  conversation moves to Twigg the first time it gets a message. The old memory is only read.
- **Twigg → Chat → Import All** moves every conversation at once, reports each chat's status, stops if
  the Twigg balance runs out, and can be re-run safely.

### Examples

- A support bot, a WhatsApp lead qualifier and a Telegram bot, each built on the Twigg AI Agent, on
  the Twigg Chat Model, and with a classic Memory node for comparison (`examples/`).
