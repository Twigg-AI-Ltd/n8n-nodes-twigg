"""Builds the example workflows. Each scenario comes three ways that share the same trigger, prompt
and tools: on the Twigg node's Agent (examples/twigg-agent), on n8n's AI Agent with the Twigg Chat Model
(examples/twigg), and classic: n8n's AI Agent with an OpenAI Chat Model and a Memory node
(examples/without-twigg).

Usage: python3 scripts/build-examples.py examples [--dev]
--dev writes node types as CUSTOM.* (how `n8n-node dev` registers the package) for local testing.
"""
import json
import sys
import uuid
from pathlib import Path

OUT = Path(sys.argv[1])
DEV = "--dev" in sys.argv
TWIGG_PREFIX = "CUSTOM" if DEV else "@twigg/n8n-nodes-twigg"


def nid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "twigg-example/" + name))


def node(name, type_, version, position, parameters=None, **extra):
    n = {"id": nid(name), "name": name, "type": type_, "typeVersion": version, "position": position,
         "parameters": parameters or {}}
    n.update(extra)
    return n


def sticky(name, content, position, width, height, color=None):
    params = {"content": content, "width": width, "height": height}
    if color:
        params["color"] = color
    return node(name, "n8n-nodes-base.stickyNote", 1, position, params)


def code_tool(name, tool_name, description, schema, js, position):
    return node(name, "@n8n/n8n-nodes-langchain.toolCode", 1.3, position, {
        "name": tool_name,
        "description": description,
        "language": "javaScript",
        "jsCode": js,
        "specifyInputSchema": True,
        "schemaType": "manual",
        "inputSchema": json.dumps(schema, indent=2),
    })


def twigg_model(position, chat_id, namespace, hash_id=False):
    return node("Twigg Chat Model", f"{TWIGG_PREFIX}.lmChatTwigg", 1, position, {
        "model": "claude-haiku-5-5",
        "chatId": chat_id,
        "namespace": namespace,
        "options": {"hashChatId": True} if hash_id else {},
    })


def agent_node(variant, name, position, text, system, chat_id, namespace, hash_id=False):
    """The agent: the Twigg node's Agent for the twigg-agent variant, n8n's AI Agent otherwise."""
    if variant == "agent":
        return node(name, f"{TWIGG_PREFIX}.twigg", 2, position, {
            "resource": "agent", "operation": "sendMessage", "model": "claude-haiku-5-5", "text": text, "chatId": chat_id, "namespace": namespace,
            "systemMessage": system, "options": {"hashChatId": True} if hash_id else {}})
    params = {"options": {"systemMessage": system}}
    if text != "={{ $json.chatInput }}":
        params.update({"promptType": "define", "text": text})
    return node(name, "@n8n/n8n-nodes-langchain.agent", 3.1, position, params)


VARIANT_LABELS = {"agent": "Twigg Agent", "twigg": "Twigg Chat Model"}


def openai_model(position):
    return node("OpenAI Chat Model", "@n8n/n8n-nodes-langchain.lmChatOpenAi", 1.3, position, {
        "model": {"__rl": True, "mode": "list", "value": "gpt-5-mini"},
        "options": {},
    })


def simple_memory(position, window=10, key=None):
    params = {"contextWindowLength": window}
    if key:
        params.update({"sessionIdType": "customKey", "sessionKey": key})
    return node("Simple Memory", "@n8n/n8n-nodes-langchain.memoryBufferWindow", 1.4, position, params)


def postgres_memory(position, key, window=10):
    return node("Postgres Chat Memory", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.4, position, {
        "sessionIdType": "customKey",
        "sessionKey": key,
        "contextWindowLength": window,
    })


def link(conns, src, dst, kind="main", src_index=0):
    conns.setdefault(src, {}).setdefault(kind, [])
    while len(conns[src][kind]) <= src_index:
        conns[src][kind].append([])
    conns[src][kind][src_index].append({"node": dst, "type": kind, "index": 0})


def workflow(name, nodes, conns, tags_note=None):
    return {"name": name, "nodes": nodes, "connections": conns, "settings": {"executionOrder": "v1"},
            "pinData": {}, "meta": {"templateCredsSetupCompleted": False}}


# ---------------------------------------------------------------------------------------------
# Shared tools. The order and help-centre tools return realistically large payloads: that is the
# tool output which, replayed on every turn, makes classic memory grow.

ORDERS_JS = r"""
// Demo data. In production this would be an HTTP Request to your shop's API.
const id = String(query.order_id || '').replace(/[^0-9]/g, '');
const orders = {
  '1042': { status: 'shipped', carrier: 'DPD', eta: '2026-10-24', items: ['Trail running shoes (UK 8)', 'Merino socks x3'] },
  '1043': { status: 'processing', carrier: null, eta: '2026-10-27', items: ['Waterproof jacket (M)'] },
  '1044': { status: 'delivered', carrier: 'Royal Mail', eta: '2026-10-15', items: ['Headtorch', 'Spare batteries'] },
};
const order = orders[id];
if (!order) return JSON.stringify({ error: `No order ${id} found. Ask the customer to check the number.` });
// Real order APIs return far more than the agent needs: full tracking history, addresses, line detail.
const events = Array.from({ length: 18 }, (_, i) => ({
  at: `2026-10-${String(10 + Math.floor(i / 2)).padStart(2, '0')}T${String(6 + i).padStart(2, '0')}:15:00Z`,
  location: ['Leeds hub', 'Manchester depot', 'Birmingham sort centre', 'Local delivery office'][i % 4],
  event: ['Label created', 'Collected', 'In transit', 'Arrived at depot', 'Sorted', 'Out for delivery'][i % 6],
  scan_id: `SCN-${id}-${1000 + i}`,
}));
return JSON.stringify({ order_id: id, ...order, tracking_events: events,
  shipping_address: { line1: '14 Park Row', city: 'Leeds', postcode: 'LS1 5HD', country: 'GB' },
  payment: { method: 'card', last4: '4242', captured: true, amount_gbp: 129.0 } });
"""

HELP_JS = r"""
// Demo knowledge base. In production this would be a vector store or help-centre search.
const q = String(query.query || '').toLowerCase();
const articles = {
  returns: 'Returns policy. You can return unworn items within 30 days of delivery for a full refund. Start a return from your account page or reply with your order number. We email a prepaid label within one working day. Refunds reach your card 3-5 working days after the parcel arrives at our warehouse. Sale items can be returned for store credit only. Footwear must be returned in its original box. ',
  delivery: 'Delivery. Standard UK delivery is free over £50 and takes 2-4 working days. Next-day delivery costs £6.95 if ordered before 2pm. We ship to the EU in 4-7 working days for £12.95. Tracking links are emailed at dispatch. Parcels are left in a safe place if nobody is home unless you opt out at checkout. ',
  sizing: 'Sizing. Our footwear runs true to size; if you are between sizes choose the larger. Jackets are cut for layering, so most customers take their usual size. Socks: S fits UK 3-5, M fits UK 6-8, L fits UK 9-11. ',
};
const key = Object.keys(articles).find((k) => q.includes(k.slice(0, 5))) || 'delivery';
// Help-centre pages are long; the whole page comes back, as it does from most search tools.
return `${articles[key].repeat(12)}\n\n(Source: help centre article "${key}")`;
"""

AVAIL_JS = r"""
// Demo calendar. In production: Google Calendar / Cal.com node or an HTTP Request.
const day = String(query.day || 'any').toLowerCase();
const slots = { monday: ['10:00', '14:30'], tuesday: ['09:00', '11:00', '16:00'], wednesday: [], thursday: ['13:00'], friday: ['10:30', '15:00'] };
if (day in slots) return JSON.stringify({ day, free_slots: slots[day] });
return JSON.stringify({ free_slots_this_week: slots });
"""

SAVE_LEAD_JS = r"""
// Demo CRM write. In production: HubSpot / Pipedrive / Airtable node or an HTTP Request.
const lead = { name: query.name, company: query.company, team_size: query.team_size, budget: query.budget,
  meeting: query.meeting || null, saved_at: new Date().toISOString() };
return JSON.stringify({ ok: true, lead_id: 'L-' + Math.abs([...JSON.stringify(lead)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)), lead });
"""

SUPPORT_PROMPT = (
    "You are the customer support assistant for Trailhead Outdoor, an online outdoor-gear shop. "
    "Be friendly and brief: at most three sentences. Use lookup_order for anything about an order, "
    "search_help_center for policies (returns, delivery, sizing), and the calculator for any arithmetic. "
    "Never invent order details."
)

LEAD_PROMPT = (
    "You qualify inbound sales leads for Twigg Analytics over WhatsApp. Keep every reply under 40 words. "
    "Find out, one question at a time: the person's name, company, team size and monthly budget. "
    "When you have all four, offer a demo using check_availability, and once they pick a slot call save_lead "
    "with everything you collected. Do not ask for anything they already told you."
)

TELEGRAM_PROMPT = (
    "You are a helpful personal assistant on Telegram. Keep replies short. Remember what the user tells "
    "you about themselves and use it."
)


def support_bot(variant):
    nodes, conns = [], {}
    nodes.append(node("When chat message received", "@n8n/n8n-nodes-langchain.chatTrigger", 1.5, [0, 0], {
        "public": True, "mode": "hostedChat",
        "initialMessages": "Hi! I'm the Trailhead Outdoor assistant. Ask me about an order, returns or delivery.",
        "options": {"title": "Trailhead Outdoor support", "subtitle": "Usually answers in a few seconds"},
    }, webhookId=nid(f"support-{variant}-chat")))
    nodes.append(agent_node(variant, "Support Agent", [300, 0], "={{ $json.chatInput }}", SUPPORT_PROMPT,
                            "={{ $json.sessionId }}", "support-bot"))
    nodes.append(code_tool("Lookup Order", "lookup_order", "Look up an order by its number. Returns status, items, tracking and shipping details.",
                           {"type": "object", "properties": {"order_id": {"type": "string", "description": "The order number, e.g. 1042"}}, "required": ["order_id"]},
                           ORDERS_JS, [420, 260]))
    nodes.append(code_tool("Search Help Center", "search_help_center", "Search the help centre for policy articles: returns, delivery, sizing.",
                           {"type": "object", "properties": {"query": {"type": "string", "description": "What to search for"}}, "required": ["query"]},
                           HELP_JS, [580, 260]))
    nodes.append(node("Calculator", "@n8n/n8n-nodes-langchain.toolCalculator", 1, [740, 260]))
    link(conns, "When chat message received", "Support Agent")
    for t in ("Lookup Order", "Search Help Center", "Calculator"):
        link(conns, t, "Support Agent", "ai_tool")

    if variant == "agent":
        nodes.append(sticky("Note", (
            "## Support bot on the Twigg Agent\n"
            "**Chat Trigger → Twigg (Agent)**, with tools. No Chat Model, no Memory node.\n\n"
            "1. Open **Support Agent**, add your Twigg API key and pick a model.\n"
            "2. Click **Open chat** on the trigger and talk to it. Try order 1042.\n\n"
            "Twigg runs the model and keeps each conversation (by the chat's `sessionId`), so it survives "
            "restarts and queue mode. Change the model any time: the history stays."), [-420, -40], 380, 360, 4))
    elif variant == "twigg":
        nodes.append(twigg_model([120, 260], "={{ $json.sessionId }}", "support-bot"))
        link(conns, "Twigg Chat Model", "Support Agent", "ai_languageModel")
        nodes.append(sticky("Note", (
            "## Support bot with Twigg\n"
            "**Chat Trigger → AI Agent → Twigg Chat Model.** No Memory node.\n\n"
            "1. Open **Twigg Chat Model** and add your Twigg API key.\n"
            "2. Click **Open chat** on the trigger and talk to it. Try order 1042.\n\n"
            "Twigg keeps each conversation (by the chat's `sessionId`) on its servers, so it survives "
            "restarts and queue mode, and old tool output is compacted instead of replayed forever. "
            "Change the model any time: the history stays."), [-420, -40], 380, 380, 4))
    else:
        nodes.append(openai_model([100, 260]))
        nodes.append(simple_memory([260, 260]))
        link(conns, "OpenAI Chat Model", "Support Agent", "ai_languageModel")
        link(conns, "Simple Memory", "Support Agent", "ai_memory")
        nodes.append(sticky("Note", (
            "## Support bot, classic setup (for comparison)\n"
            "OpenAI Chat Model + **Simple Memory** (last 10 messages).\n\n"
            "- Simple Memory lives in the n8n process: a restart wipes every conversation, and in queue "
            "mode each worker has its own copy.\n"
            "- Only the last 10 messages are kept, so early facts (a name, an order number) are forgotten.\n\n"
            "See `../twigg/support-bot.json` for the same bot on Twigg."), [-420, -40], 380, 360, 3))
    return workflow(f"Support bot ({VARIANT_LABELS.get(variant, 'classic: OpenAI + Simple Memory')})", nodes, conns)


def lead_qualifier(variant):
    nodes, conns = [], {}
    nodes.append(node("Incoming WhatsApp message", "n8n-nodes-base.webhook", 2.2, [0, 0], {
        "httpMethod": "POST", "path": f"lead-qualifier-{variant}", "responseMode": "responseNode", "options": {},
    }, webhookId=nid(f"lead-{variant}-webhook")))
    sender = "={{ $('Incoming WhatsApp message').item.json.body.from }}"
    nodes.append(agent_node(variant, "Lead Agent", [300, 0], "={{ $json.body.text }}", LEAD_PROMPT,
                            sender, "lead-qualifier", hash_id=True))
    nodes.append(code_tool("Check Availability", "check_availability", "Free demo slots this week. Optionally filter by weekday.",
                           {"type": "object", "properties": {"day": {"type": "string", "description": "Weekday, e.g. tuesday, or 'any'"}}},
                           AVAIL_JS, [460, 260]))
    nodes.append(code_tool("Save Lead", "save_lead", "Save a qualified lead and their booked demo slot to the CRM.",
                           {"type": "object", "properties": {
                               "name": {"type": "string"}, "company": {"type": "string"},
                               "team_size": {"type": "number"}, "budget": {"type": "string"},
                               "meeting": {"type": "string", "description": "Booked slot, e.g. 'tuesday 11:00'"}},
                            "required": ["name", "company", "team_size", "budget"]},
                           SAVE_LEAD_JS, [620, 260]))
    nodes.append(node("Reply", "n8n-nodes-base.respondToWebhook", 1.5, [640, 0], {
        "respondWith": "json", "responseBody": "={{ { \"to\": $('Incoming WhatsApp message').item.json.body.from, \"reply\": $json.output } }}",
        "options": {}}))
    link(conns, "Incoming WhatsApp message", "Lead Agent")
    link(conns, "Lead Agent", "Reply")
    for t in ("Check Availability", "Save Lead"):
        link(conns, t, "Lead Agent", "ai_tool")

    if variant == "agent":
        nodes.append(sticky("Note", (
            "## Lead qualifier on the Twigg Agent\n"
            "Point your WhatsApp provider (Twilio, 360dialog, WhatsApp Cloud API) at this webhook, "
            "or test with:\n`POST {\"from\": \"+447700900123\", \"text\": \"Hi\"}`\n\n"
            "**Chat ID** is the sender's phone number, so each person is one conversation. "
            "**Hash Chat ID** is on: Twigg only ever sees a hash of the number.\n\n"
            "No database, no Memory node, no Chat Model node."), [-420, -40], 380, 380, 4))
    elif variant == "twigg":
        nodes.append(twigg_model([120, 260], sender, "lead-qualifier", hash_id=True))
        link(conns, "Twigg Chat Model", "Lead Agent", "ai_languageModel")
        nodes.append(sticky("Note", (
            "## Lead qualifier with Twigg\n"
            "Point your WhatsApp provider (Twilio, 360dialog, WhatsApp Cloud API) at this webhook, "
            "or test with:\n`POST {\"from\": \"+447700900123\", \"text\": \"Hi\"}`\n\n"
            "**Chat ID** is the sender's phone number, so each person is one conversation. "
            "**Hash Chat ID** is on: Twigg only ever sees a hash of the number.\n\n"
            "No database, no Memory node. Leads come back days later and the agent still knows them."),
            [-420, -40], 380, 400, 4))
    else:
        nodes.append(openai_model([100, 260]))
        nodes.append(postgres_memory([260, 260], sender))
        link(conns, "OpenAI Chat Model", "Lead Agent", "ai_languageModel")
        link(conns, "Postgres Chat Memory", "Lead Agent", "ai_memory")
        nodes.append(sticky("Note", (
            "## Lead qualifier, classic setup (for comparison)\n"
            "OpenAI Chat Model + **Postgres Chat Memory** keyed by phone number.\n\n"
            "Needs a Postgres (or Supabase) database and credential; n8n creates the "
            "`n8n_chat_histories` table. Phone numbers are stored in plain text. The window keeps "
            "the last 10 messages, so details given early in a long chat drop out.\n\n"
            "See `../twigg/lead-qualifier.json` for the same flow on Twigg."), [-420, -40], 380, 380, 3))
    return workflow(f"WhatsApp lead qualifier ({VARIANT_LABELS.get(variant, 'classic: OpenAI + Postgres memory')})", nodes, conns)


def telegram_bot(variant):
    nodes, conns = [], {}
    nodes.append(node("Telegram Trigger", "n8n-nodes-base.telegramTrigger", 1.2, [0, 100], {
        "updates": ["message"], "additionalFields": {}}, webhookId=nid(f"telegram-{variant}")))
    nodes.append(node("Is /reset?", "n8n-nodes-base.if", 2.2, [220, 100], {
        "conditions": {"options": {"caseSensitive": False, "leftValue": "", "typeValidation": "loose", "version": 2},
                       "conditions": [{"id": nid(f"reset-cond-{variant}"), "leftValue": "={{ $json.message.text }}",
                                       "rightValue": "/reset", "operator": {"type": "string", "operation": "equals"}}],
                       "combinator": "and"},
        "options": {}}))
    chat_id = "={{ $('Telegram Trigger').item.json.message.chat.id }}"
    nodes.append(agent_node(variant, "Assistant", [480, 200], "={{ $json.message.text }}", TELEGRAM_PROMPT,
                            chat_id, "telegram-bot"))
    nodes.append(node("Send reply", "n8n-nodes-base.telegram", 1.2, [820, 200], {
        "chatId": "={{ $('Telegram Trigger').item.json.message.chat.id }}", "text": "={{ $json.output }}",
        "additionalFields": {"appendAttribution": False}}))
    nodes.append(node("Confirm reset", "n8n-nodes-base.telegram", 1.2, [820, -60], {
        "chatId": "={{ $('Telegram Trigger').item.json.message.chat.id }}",
        "text": "Done, I've forgotten our conversation. What can I do for you?",
        "additionalFields": {"appendAttribution": False}}))
    link(conns, "Telegram Trigger", "Is /reset?")
    link(conns, "Is /reset?", "Assistant", src_index=1)
    link(conns, "Assistant", "Send reply")

    if variant in ("agent", "twigg"):
        nodes.append(node("Forget conversation", f"{TWIGG_PREFIX}.twigg", 1, [480, -60], {
            "resource": "chat", "operation": "delete", "chatId": chat_id}))
        link(conns, "Is /reset?", "Forget conversation", src_index=0)
        link(conns, "Forget conversation", "Confirm reset")
        holder = "Assistant"
        if variant == "twigg":
            nodes.append(twigg_model([480, 420], chat_id, "telegram-bot"))
            link(conns, "Twigg Chat Model", "Assistant", "ai_languageModel")
            holder = "Twigg Chat Model"
        nodes.append(sticky("Note", (
            f"## Telegram bot on the {VARIANT_LABELS[variant]}\n"
            "1. Add your Telegram bot token to the trigger and the two Telegram nodes.\n"
            f"2. Add your Twigg API key to **{holder}** and **Forget conversation**.\n\n"
            "Each Telegram chat is its own conversation (Chat ID = the Telegram chat id). "
            "`/reset` deletes it on Twigg; the next message starts fresh."), [-420, -40], 380, 320, 4))
    else:
        nodes.append(node("Forget conversation", "n8n-nodes-base.postgres", 2.6, [480, -60], {
            "operation": "executeQuery",
            "query": "DELETE FROM n8n_chat_histories WHERE session_id = $1",
            "options": {"queryReplacement": "={{ String($json.message.chat.id) }}"}}))
        link(conns, "Is /reset?", "Forget conversation", src_index=0)
        link(conns, "Forget conversation", "Confirm reset")
        nodes.append(openai_model([400, 420]))
        nodes.append(postgres_memory([560, 420], chat_id))
        link(conns, "OpenAI Chat Model", "Assistant", "ai_languageModel")
        link(conns, "Postgres Chat Memory", "Assistant", "ai_memory")
        nodes.append(sticky("Note", (
            "## Telegram bot, classic setup (for comparison)\n"
            "OpenAI + **Postgres Chat Memory**, plus a raw SQL `DELETE` for `/reset`.\n\n"
            "You need a Postgres database and credential, and the reset query has to match the table "
            "and session id format the memory node uses.\n\n"
            "See `../twigg/telegram-bot.json` for the same bot on Twigg."), [-420, -40], 380, 320, 3))
    return workflow(f"Telegram bot ({VARIANT_LABELS.get(variant, 'classic: OpenAI + Postgres memory')})", nodes, conns)


for variant, folder in (("agent", "twigg-agent"), ("twigg", "twigg"), ("classic", "without-twigg")):
    (OUT / folder).mkdir(parents=True, exist_ok=True)
    for fname, build in (("support-bot", support_bot), ("lead-qualifier", lead_qualifier), ("telegram-bot", telegram_bot)):
        (OUT / folder / f"{fname}.json").write_text(json.dumps(build(variant), indent=2, ensure_ascii=False) + "\n")
print("wrote", sorted(str(p.relative_to(OUT)) for p in OUT.rglob("*.json")))
