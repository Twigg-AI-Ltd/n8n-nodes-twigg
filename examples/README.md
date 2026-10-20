# Example workflows

Each scenario comes twice: once on Twigg, and once the way most n8n bots are built today (OpenAI
Chat Model plus a Memory node). The trigger, prompt and tools are identical, so the only difference
is where the conversation lives. Import a file with **Workflows → Import from File**.

| Scenario | Twigg | Classic, for comparison |
|---|---|---|
| Website support bot: Chat Trigger, order lookup, help-centre search, calculator | [`twigg/support-bot.json`](twigg/support-bot.json) | [`without-twigg/support-bot.json`](without-twigg/support-bot.json) (Simple Memory) |
| WhatsApp lead qualifier: webhook keyed by phone number, calendar check, CRM save | [`twigg/lead-qualifier.json`](twigg/lead-qualifier.json) | [`without-twigg/lead-qualifier.json`](without-twigg/lead-qualifier.json) (Postgres memory) |
| Telegram bot with a `/reset` command | [`twigg/telegram-bot.json`](twigg/telegram-bot.json) | [`without-twigg/telegram-bot.json`](without-twigg/telegram-bot.json) (Postgres memory + SQL reset) |
| Smallest possible: Manual Trigger, Agent, Calculator | [`agent-with-calculator.json`](agent-with-calculator.json) | |

The tools are Code tools returning demo data, so the support bot and lead qualifier run as soon as
the credentials are set. Each workflow has a sticky note with what to set up. The Telegram bots need a
bot token.

## Moving an existing workflow to Twigg

1. Delete the Memory node attached to the AI Agent.
2. Replace the Chat Model node with **Twigg Chat Model** and add your Twigg API key.
3. Set **Chat ID** to whatever the Memory node used as its session key: `{{ $json.sessionId }}`
   for a Chat Trigger, the chat id or phone number for a messaging app.

Prompt, tools and the rest of the workflow stay as they are.

## What the comparison shows

We ran each pair side by side on n8n 2.44.4 with the same scripted conversations.

| | Twigg | Simple Memory | Postgres Chat Memory |
|---|---|---|---|
| Recalls a name, order number and allergy from the first message, 10 turns later | Yes | No: lost after the 10-message window | Same window limit |
| After an n8n restart | Remembers | Forgets everything | Remembers |
| Queue mode, turns landing on different workers | Remembers | Forgets from the second message | Remembers |
| Setup | API key + Chat ID | None | Database, credential, table |
| Switching model mid-conversation, including tool-call history (Claude, Gemini, GPT, DeepSeek) | History kept; other models' reasoning artifacts are stripped instead of replayed | Tied to one provider's message format | Tied to one provider's message format |
| A tool call that never got its result (stopped execution) | Next message closes it and carries on | | |

Old tool output is kept in full by default on Twigg as well. To trim it, give the namespace a
retention policy and a context budget: see **Recommended Twigg settings** in the main README.
