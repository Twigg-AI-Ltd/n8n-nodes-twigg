# n8n-nodes-twigg

AI agents for n8n whose model and memory are [Twigg](https://twigg.ai). Twigg keeps each
conversation on its servers, fits it to the model's context window, trims old tool output and
compacts long chats, and runs any of its models on the same history. No Memory node and no
database: the conversation survives restarts, queue mode and scaling.

Two ways to use it:

- **Trigger → Twigg AI Agent**, with your tools connected. One node in place of n8n's AI Agent,
  Chat Model and Memory: pick the model, namespace and Chat ID in its settings.
- **Trigger → AI Agent → Twigg Chat Model.** Keep n8n's AI Agent (and its output parsers, fallback
  model and other options) and swap only the model and memory.

> Requires n8n 2.16 or later (the first release that ships `@n8n/ai-node-sdk`). The Twigg AI Agent
> uses n8n's engine to run tools and has been tested on n8n 2.44.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `n8n-nodes-twigg`.

## Credentials

One credential, **Twigg API**, holding an API key from the
[Twigg console](https://twigg.ai/dashboard). The connection test lists your models. Leave the base
URL at `https://api.twigg.ai` unless Twigg gave you another host.

## Nodes

### Twigg AI Agent

Use it where you would use n8n's AI Agent. It has one sub-node input, **Tool**: connect any n8n tool
(Calculator, HTTP Request, Code, Workflow, MCP Client, app tools). There is no Chat Model or Memory
input; Twigg runs the model and keeps the conversation.

| Parameter | What it does |
|---|---|
| **Model** | The model that answers, from the live list on your key. Change it at any time; the history stays. |
| **Prompt (User Message)** | The message to answer. Defaults to `{{ $json.chatInput }}` from a Chat Trigger. |
| **Chat ID** | What identifies the conversation, as on the Twigg Chat Model below. |
| **Namespace** | Where new chats are created on Twigg. Defaults to `n8n`, so one budget and retention policy in the Twigg console covers everything from n8n. A chat stays in the namespace it was created in. |
| **System Message** | Instructions sent with every message, not stored as history. |
| **Import History From Old Memory** | Off by default. When on, the agent gets a **Memory (Import)** input: see below. |
| **Options** | Hash Chat ID, Max Iterations (tool rounds per message, default 10), and the same Maximum Number of Tokens, Reasoning Effort, On Refusal, Pending Tool Call Window, Max Wait and Timeout options as the Twigg Chat Model. |

The output is `{ "output": "<reply>" }`, the same field n8n's AI Agent produces, so a Chat Trigger,
Respond to Webhook or messaging node after it works unchanged.

When the model calls tools, the agent hands the calls to n8n, which runs the tool nodes (they show up
in the execution with their own input and output), and sends the results back to Twigg under the same
tool call ids. Each input item is its own conversation turn.

To move a workflow over: add a Twigg AI Agent, connect the same trigger, tools and output, copy the
system message, set the Chat ID to what the Memory node used as its session key, and delete the old
AI Agent and Chat Model nodes.

#### Bringing old conversations along

Turn on **Import History From Old Memory** and connect the Memory node your old agent used (Postgres,
Redis, MongoDB and so on) to the **Memory (Import)** input. Each conversation then moves over by itself
the first time it gets a message: if Twigg has no history for that Chat ID yet, the agent reads the
session's full history from the Memory node, imports it, and answers. The old memory is only read,
never changed, so you can switch back at any time. Once your active conversations have moved, turn the
option off and delete the Memory node.

If the import fails for any reason, the message is still answered (without the old history) and the
reason is logged. To move every conversation at once instead, use **Twigg → Chat → Import History**.

> The import endpoint is rolling out on the Twigg API. Until it is live, the agent answers without
> importing and logs that the import is not available yet.

### Twigg Chat Model (sub-node)

Connect it to the **Chat Model** input of an AI Agent (or an LLM chain). Do **not** connect a
Memory node: Twigg already holds the conversation. If one is attached, the node ignores the history it
replays (only the new message is sent) and logs a warning.

| Parameter | What it does |
|---|---|
| **Model** | The model that answers, from the live list on your key. Every model shares the same conversation, so you can switch at any time and the history stays. |
| **Chat ID** | What identifies the conversation. Defaults to `{{ $json.sessionId }}`, which a Chat Trigger provides. For a messaging bot use the sender's id, such as the Telegram chat id or phone number. Each distinct value is its own conversation. |
| **Namespace** | Where new chats are created on Twigg, with the instructions, budgets and retention you configure in the console. Defaults to `n8n`. |
| **Options → Hash Chat ID** | Sends a SHA-256 hash of the Chat ID instead of the raw value. Turn it on when the id is personal data (a phone number), because ids appear in request logs. The Twigg action node has the same switch; keep them in step. |
| **Options → Maximum Number of Tokens** | Output ceiling per reply. |
| **Options → Reasoning Effort** | Thinking budget on models that support it. |
| **Options → On Refusal** | What happens when the model declines to answer. **Fail the Run** (default) stops with an error that includes the refusal, so a provider notice never reaches your users as a reply; **Return Refusal Text** passes it to the Agent instead. |
| **Options → Pending Tool Call Window** | When a new message arrives while a tool from the previous message is still running, wait up to this long (default 60 s) for the tool result instead of abandoning the call. |
| **Options → Max Wait for a Busy Chat** | How long to keep waiting (default 120 s) when another reply is still being generated on the same chat, or Twigg asks to slow down. |
| **Options → Timeout** | HTTP timeout. Twigg answers within about 280 s, so keep it above that. |

#### How it works

- **Send only what's new.** On every call the node sends Twigg the messages after the last
  assistant message: the user's new message, or the tool results the Agent just produced. The
  system prompt and the Agent's tools are sent with every request and are not stored as history.
- **Tool calls.** When the model wants a tool, the node returns the call to the Agent, the Agent
  runs the tool, and the result goes back to Twigg on the next call under the same tool call id.
  A tool call that never gets a result (an interrupted execution) is closed by Twigg on the next
  message, so a conversation never gets stuck on it.
- **Safe retries.** Each submission carries an idempotency key derived from the n8n execution,
  the node, the item, the chat and the content. If the Agent or n8n retries, Twigg returns the
  stored reply instead of running the turn again. A turn that outlasts the request (`504`) is
  retried with the same key, which fetches the result.
- **Two messages at once.** If a second message arrives while a reply is still being generated,
  the node waits (honouring Twigg's `Retry-After`) and then sends it, up to the busy-wait budget.
- **Streaming.** The node works with the Agent's streaming mode but delivers each reply in one
  piece, because Twigg's replay-on-retry only exists for non-streaming turns.

### Twigg (action node)

Operations on the conversations the Twigg AI Agent and Twigg Chat Model keep, addressed by the same
Chat ID.

| Resource | Operation | Use it to |
|---|---|---|
| Chat | Get | Look up the chat record (Twigg id, namespace, length, timestamps). |
| Chat | Open | Create the chat before the first message, with a namespace and title. |
| Chat | Get History | Read the stored conversation, oldest first, one item per part. |
| Chat | Delete | Reset a conversation ("start over"): deletes the chat and its history, and the next message starts fresh. |
| Chat | Abort | Stop a reply that is being generated. |
| Chat | Import History | Move conversations out of an n8n Memory node in one go: one conversation per input item (see below). |
| Model | Get Many | List the models on your key, with prices. |

**Import History** gets a **Memory** input. Feed it one item per old session, for example a Postgres
node running `SELECT DISTINCT session_id FROM n8n_chat_histories`, set the connected Memory node's
session key to `{{ $json.session_id }}`, and run it once. Chats that already have history on Twigg are
left alone, so running it twice is safe. Each output item reports `imported`, `skipped` (already had
history) or `empty`. Simple Memory cannot be imported: it lives in the n8n process and has nothing
stored to read.

## Example: Telegram bot with memory

1. **Telegram Trigger** (message).
2. **AI Agent** with the prompt set to `{{ $json.message.text }}` and a system message.
3. **Twigg Chat Model** connected to the Agent's model input, Chat ID `{{ $json.message.chat.id }}`,
   Namespace `telegram-bot`.
4. **Telegram → Send message** with `{{ $json.output }}` back to `{{ $('Telegram Trigger').item.json.message.chat.id }}`.

To give users a `/reset` command, add an IF on the text and a **Twigg → Chat → Delete** node with the
same Chat ID.

The full version is [`examples/twigg/telegram-bot.json`](examples/twigg/telegram-bot.json).
[`examples/`](examples/README.md) has importable workflows for a website support bot, a WhatsApp lead
qualifier and this Telegram bot, each next to the same bot built with a Memory node, plus how to move an
existing workflow over in three steps.

## Recommended Twigg settings

Out of the box Twigg keeps every message and every tool result, and compacts only when a chat nears the
model's context window (up to a million tokens on current models). For bots that call tools or run long
conversations, give the namespace a context budget and a retention policy so old tool output is trimmed
and the cost per message levels off. Set them in the [Twigg console](https://twigg.ai/dashboard) or with
the Twigg CLI (`npx twigg config apply`):

```yaml
# twigg.config.yaml
version: 1
namespaces:
  support-bot:                      # the Namespace set on the Twigg Chat Model
    budgets:
      default: { version: 3, headroom: 0.1, history_mode: summarize, max_history_tokens: 32000 }
    retention:
      version: 3
      media: { default: 0, rules: [] }
      tools:
        default:
          result: { mode: over, over: 300, to: 120, keep: head_and_tail }   # trim long old tool results
          arguments: { mode: keep }
        rules: []
        errors: null
        mark_truncations: true
      text: { prompt: { mode: keep }, message: { mode: keep } }
      reasoning: 0.3
      verbatim_within: 0.15         # the most recent share of the budget is never trimmed
      anchor_parts: 0
```

Trimming only starts once a budget is set: "recent" is measured as a share of the budget, so without one
the whole conversation counts as recent.

## Errors

API failures surface with Twigg's error code and hint, for example `payment_required` (top up in the
console), `validation_error` (a tool schema the model cannot take) or `external_id_namespace_mismatch`
(the chat exists in another namespace; leave Namespace empty or use a different Chat ID prefix).

## Development

```bash
npm install
npm test        # unit tests, no network
npm run lint
npm run build
```

Set `TWIGG_API_KEY` to run the live smoke test in `scripts/smoke.mjs` (creates and deletes chats in
the `n8n-dev` namespace with a cheap model).

## License

[MIT](LICENSE.md)
