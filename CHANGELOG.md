# Changelog

## 0.2.1 (2026-10-27)

- The Twigg node's codex `nodeVersion` is back to `"1.0"`, as n8n's verification review asked. It is
  the codex schema version, not the node's version (still 2). No other changes.

## 0.2.0 (2026-10-26)

Changes asked for in n8n's community node verification review.

- **The Twigg AI Agent is now the Agent resource of the Twigg node**, so the package has one action
  node (n8n allows one per package). Its parameters, behaviour and output are unchanged. The Twigg
  node is now version 2, with Agent as its default resource; version 1 Twigg nodes in existing
  workflows keep working as before.
- **Breaking:** workflows that use the separate Twigg AI Agent node (`twiggAgent`) need it replaced
  with a Twigg node set to Agent → Send Message, with the same settings and connections.
- Removed the unsupported `subcategories` field from the `.node.json` codex files.
- Clearer messages: a refusal now points at the On Refusal option of whichever node failed, an empty
  Chat ID on the Twigg node says how to set it, and some wording no longer says "error".

## 0.1.2 (2026-10-21)

- The package's author email is now info@twigg.ai. No code changes.

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
