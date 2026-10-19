# n8n-nodes-twigg

Twigg as the chat model for n8n AI Agents. [Twigg](https://twigg.ai) keeps each conversation on
its servers, fits it to the model's context window, trims old tool output and compacts long chats,
and runs any of its models on the same history. With this package the Agent needs no Memory node:
the conversation survives restarts, queue mode and scaling, with no database to set up.

**Trigger → AI Agent → Twigg Chat Model.** That is the whole workflow for a WhatsApp, Telegram,
website or support bot with persistent memory.

> Requires n8n 2.16 or later (the first release that ships `@n8n/ai-node-sdk`, which chat model
> community nodes are built on).

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
and install `n8n-nodes-twigg`.

## Credentials

One credential, **Twigg API**, holding an API key from the
[Twigg console](https://twigg.ai/dashboard). The connection test lists your models. Leave the base
URL at `https://api.twigg.ai` unless Twigg gave you another host.

## Nodes

### Twigg Chat Model (sub-node)

Connect it to the **Chat Model** input of an AI Agent (or an LLM chain). Do **not** connect a
Memory node: Twigg already holds the conversation, and a Memory node would send it twice. The node
logs a warning when it notices replayed history.

| Parameter | What it does |
|---|---|
| **Model** | The model that answers, from the live list on your key. Every model shares the same conversation, so you can switch at any time and the history stays. |
| **Chat ID** | What identifies the conversation. Defaults to `{{ $json.sessionId }}`, which a Chat Trigger provides. For a messaging bot use the sender's id, such as the Telegram chat id or phone number. Each distinct value is its own conversation. |
| **Options → Namespace** | The Twigg namespace new chats are created in. Namespaces carry instructions, saved tools and context budgets you configure in the console. |
| **Options → Hash Chat ID** | Sends a SHA-256 hash of the Chat ID instead of the raw value. Turn it on when the id is personal data (a phone number), because ids appear in request logs. The Twigg action node has the same switch; keep them in step. |
| **Options → Maximum Number of Tokens** | Output ceiling per reply. |
| **Options → Reasoning Effort** | Thinking budget on models that support it. |
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

Operations on the conversations the Chat Model keeps, addressed by the same Chat ID.

| Resource | Operation | Use it to |
|---|---|---|
| Chat | Get | Look up the chat record (Twigg id, namespace, length, timestamps). |
| Chat | Open | Create the chat before the first message, with a namespace and title. |
| Chat | Get History | Read the stored conversation, oldest first, one item per part. |
| Chat | Delete | Reset a conversation ("start over"): deletes the chat and its history, and the next message starts fresh. |
| Chat | Abort | Stop a reply that is being generated. |
| Model | Get Many | List the models on your key, with prices. |

## Example: Telegram bot with memory

1. **Telegram Trigger** (message).
2. **AI Agent** with the prompt set to `{{ $json.message.text }}` and a system message.
3. **Twigg Chat Model** connected to the Agent's model input, Chat ID `{{ $json.message.chat.id }}`,
   Namespace `telegram-bot`.
4. **Telegram → Send message** with `{{ $json.output }}` back to `{{ $('Telegram Trigger').item.json.message.chat.id }}`.

To give users a `/reset` command, add an IF on the text and a **Twigg → Chat → Delete** node with the
same Chat ID.

`examples/agent-with-calculator.json` is an importable workflow (Manual Trigger → AI Agent → Twigg Chat
Model + Calculator tool). Run it twice with different messages to see the second run remember the first.

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
