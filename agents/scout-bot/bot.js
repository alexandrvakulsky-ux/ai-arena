#!/usr/bin/env node
/**
 * Scout Bot — Alex's proactive Telegram agent.
 *
 * What it does:
 *  - Long-polls Telegram for incoming messages.
 *  - On Mon 09:00 local time: pings Alex with an MCP scouting prompt.
 *  - On Thu 09:00 local time: pings Alex with a Futureproof scouting prompt.
 *  - Replies to ad-hoc messages using Claude Opus + web_search tool.
 *  - Persists per-chat conversation history + accumulates project memory.
 *  - Locks to a single authorized chat_id via passphrase (TOFU).
 *
 * Cost: ~$0 idle. Each Mon+Thu fire ~$0.30. Each interactive reply ~$0.10.
 *
 * Setup:
 *   1. Create a bot via @BotFather → /newbot → save token.
 *   2. Add TELEGRAM_BOT_TOKEN + TELEGRAM_PASSPHRASE to /workspace/.env.
 *   3. Start: `node /workspace/agents/scout-bot/bot.js` (auto-deploy.sh handles it).
 *   4. In Telegram, message the bot the passphrase. Done.
 *
 * Safe-by-design:
 *  - Refuses to start without TELEGRAM_BOT_TOKEN.
 *  - Only one chat_id authorized at a time (first to send passphrase wins;
 *    delete .authorized_chat.txt to re-authorize a different chat).
 *  - No setInterval that calls paid APIs on a timer — Mon/Thu firing is
 *    gated to exact match at top of hour. All paid calls are user- or
 *    schedule-triggered, never idle polling.
 */

require('dotenv').config({ path: '/workspace/.env' });
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASSPHRASE = process.env.TELEGRAM_PASSPHRASE || 'futureproof-scout';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!TOKEN) { console.error('[scout-bot] TELEGRAM_BOT_TOKEN missing — exiting'); process.exit(0); }
if (!ANTHROPIC_KEY) { console.error('[scout-bot] ANTHROPIC_API_KEY missing — exiting'); process.exit(1); }

const BOT_DIR = '/workspace/agents/scout-bot';
const AUTH_FILE = path.join(BOT_DIR, '.authorized_chat.txt');
const CHATS_DIR = path.join(BOT_DIR, 'chats');
const MEMORY_FILE = path.join(BOT_DIR, 'memory.md');
fs.mkdirSync(CHATS_DIR, { recursive: true });

const TG = `https://api.telegram.org/bot${TOKEN}`;
const MODEL = 'claude-opus-4-6';
const MAX_HISTORY_TURNS = 20;
const HISTORY_KEEP = 40; // cap stored history at 40 turns

// ── Auth ─────────────────────────────────────────────────────────────────
function authorizedChatId() {
  try { return parseInt(fs.readFileSync(AUTH_FILE, 'utf8').trim(), 10); }
  catch { return null; }
}
function setAuthorizedChatId(id) {
  fs.writeFileSync(AUTH_FILE, String(id));
  console.log(`[scout-bot] authorized chat_id=${id}`);
}

// ── Telegram client (raw, no SDK) ────────────────────────────────────────
async function tg(method, params) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    timeout: 35000,
  });
  return r.json();
}
async function sendMessage(chat_id, text) {
  // Telegram has a 4096-char limit per message — split if needed.
  const chunks = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let cut = remaining.lastIndexOf('\n', 4000);
    if (cut < 2000) cut = 4000;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  for (const chunk of chunks) {
    await tg('sendMessage', { chat_id, text: chunk });
  }
}

// ── Conversation history ────────────────────────────────────────────────
function chatHistoryFile(chat_id) {
  return path.join(CHATS_DIR, `${chat_id}.json`);
}
function loadHistory(chat_id) {
  try { return JSON.parse(fs.readFileSync(chatHistoryFile(chat_id), 'utf8')); }
  catch { return []; }
}
function saveHistory(chat_id, history) {
  fs.writeFileSync(chatHistoryFile(chat_id), JSON.stringify(history.slice(-HISTORY_KEEP), null, 2));
}

// ── Memory ──────────────────────────────────────────────────────────────
function loadMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf8'); }
  catch { return '(no memory file yet — get to know Alex from this conversation)'; }
}

// ── Anthropic API ───────────────────────────────────────────────────────
function buildSystemPrompt() {
  const memory = loadMemory();
  return `You are Alex's scout agent on Telegram. You proactively check in twice a week:
- **Monday morning** — MCP integration scouting (find new + notable MCP servers)
- **Thursday morning** — Futureproof marketing intel (FB ads, funnels, CX, design — for his cybersecurity SaaS)

Outside of those scheduled fires, you're his general-purpose assistant for anything related to his projects. He can ping you anytime.

Your style:
- Casual, conversational — this is Telegram, not email. Multiple short messages beat one wall of text.
- Curious — ask follow-up questions about what he's working on, what's blocking him, what's surprising.
- Opinionated when sharing finds — don't list neutrally. Tell him which one to try first and why.
- Always tie suggestions to his specific projects (Futureproof, ad-spy, ai-arena).
- When you discover something cool, include "Intended use for you:" — that's the format he wants. Suggest a concrete way it'd plug into HIS work, not a generic use case.
- Use Markdown sparingly — Telegram's Markdown support is limited. Plain text + line breaks usually reads better.

Memory (what you know about Alex and his projects):
${memory}

When you learn new context about Alex's projects in conversation, mention it explicitly in your response with the prefix "MEMORY_UPDATE:" on its own line — the system parses these out, appends to memory.md, and removes them from your reply before sending to Alex. Example:
  MEMORY_UPDATE: Alex is now testing the data-broker-exposure landing variant for Futureproof.

You have access to web_search. Use it when you need current information — releases, posts, examples. Don't search for things you already know.`;
}

// Strip MEMORY_UPDATE lines from agent output, append them to memory.md.
function processMemoryUpdates(replyText) {
  const lines = replyText.split('\n');
  const memUpdates = [];
  const remaining = [];
  for (const line of lines) {
    const m = line.match(/^MEMORY_UPDATE:\s*(.+)$/);
    if (m) memUpdates.push(m[1]);
    else remaining.push(line);
  }
  if (memUpdates.length > 0) {
    const date = new Date().toISOString().slice(0, 10);
    const append = `\n\n## Updates ${date}\n` + memUpdates.map(u => `- ${u}`).join('\n');
    fs.appendFileSync(MEMORY_FILE, append);
    console.log(`[scout-bot] appended ${memUpdates.length} memory update(s)`);
  }
  return remaining.join('\n').trim();
}

async function generateReply(chat_id, userMessage) {
  let history = loadHistory(chat_id);
  history.push({ role: 'user', content: userMessage, ts: Date.now() });

  // Anthropic format: only role + content, last N turns
  const messages = history.slice(-MAX_HISTORY_TURNS).map(({ role, content }) => ({ role, content }));

  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: buildSystemPrompt(),
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      }),
      timeout: 90000,
    });
    data = await r.json();
  } catch (err) {
    console.error('[anthropic] fetch error:', err.message);
    return 'sorry, hit a network issue talking to Claude. try again?';
  }

  if (data.error) {
    console.error('[anthropic] error:', JSON.stringify(data.error).slice(0, 200));
    return `sorry, Claude API returned an error: ${data.error.message || 'unknown'}. try again?`;
  }

  const rawReply = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n\n');

  const cleanReply = processMemoryUpdates(rawReply);

  history.push({ role: 'assistant', content: cleanReply, ts: Date.now() });
  saveHistory(chat_id, history);

  return cleanReply;
}

// ── Incoming message handler ────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id = msg.chat.id;
  const text = msg.text || '';

  // Auth gate
  const authed = authorizedChatId();
  if (authed === null) {
    if (text.includes(PASSPHRASE)) {
      setAuthorizedChatId(chat_id);
      await sendMessage(chat_id, `Authorized. Locked to this chat from now on.\n\nI'll ping you Mon + Thu mornings with scouting reports. In between, message me anything about your projects — I'll use web search and remember what you tell me.\n\nFirst question: what's the most pressing thing on your plate this week?`);
      return;
    }
    return; // silent reject — don't leak that this is even an auth gate
  }
  if (chat_id !== authed) return; // silent reject for unauthorized chats

  // Quick commands
  if (text === '/start') {
    await sendMessage(chat_id, 'Hey — I scout MCP releases Mondays and Futureproof intel Thursdays. Ask me anything in between.');
    return;
  }
  if (text === '/help') {
    await sendMessage(chat_id, 'Commands:\n/start — re-introduce myself\n/help — this\n/clear — wipe conversation history (keeps memory)\n\nOtherwise just talk to me.');
    return;
  }
  if (text === '/clear') {
    try { fs.unlinkSync(chatHistoryFile(chat_id)); } catch {}
    await sendMessage(chat_id, 'Conversation history cleared. Memory of your projects is preserved.');
    return;
  }

  // Normal flow — show typing indicator, generate, reply
  await tg('sendChatAction', { chat_id, action: 'typing' });
  const reply = await generateReply(chat_id, text);
  if (reply && reply.trim()) await sendMessage(chat_id, reply);
}

// ── Long-poll loop ──────────────────────────────────────────────────────
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`, { timeout: 35000 });
    const data = await r.json();
    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch(e => console.error('[handler]', e.message));
        }
      }
    } else if (data.error_code) {
      console.error('[poll] telegram error:', JSON.stringify(data).slice(0, 200));
      await new Promise(r => setTimeout(r, 10000));
    }
  } catch (err) {
    if (err.code !== 'ETIMEDOUT') console.error('[poll]', err.message);
    await new Promise(r => setTimeout(r, 5000));
  }
  setImmediate(poll);
}

// ── Mon + Thu proactive scout fire ──────────────────────────────────────
// Checks time once per minute. Fires at exactly Mon/Thu 09:00 local time.
// "lastFiredKey" prevents double-fire within the same hour if minute=0 hits twice.
let lastFiredKey = '';
const SCOUTS = {
  1: { // Monday
    name: 'MCP scout',
    opener: `Monday morning. About to scout MCP releases for the past week.\n\nBefore I dig in — what are you actively building on right now? Affects what I prioritize. Boring database wrappers I'll skip regardless, but is there a category you're hungry for? (browser automation, marketing analytics, design tools, etc.)\n\nGimme a sentence or two and I'll go scout.`,
  },
  4: { // Thursday
    name: 'Futureproof scout',
    opener: `Thursday morning. Futureproof intel check-in.\n\nThree quick things before I go scout:\n\n1. What's the biggest blocker on Futureproof this week? (positioning, funnel, CX, design — pick whichever)\n2. Any competitor you want me to look at more closely?\n3. Anything you tested last week — did it work?\n\nDon't need essays. One-liners are fine. Then I'll dig.`,
  },
};

const FIRE_HOUR_UTC = parseInt(process.env.SCOUT_FIRE_HOUR_UTC || '9', 10);
function startScheduler() {
  console.log(`[scheduler] will fire scouts at ${FIRE_HOUR_UTC}:00 UTC on Mon + Thu`);
  setInterval(async () => {
    const now = new Date();
    // Use UTC consistently — container is UTC, simpler than juggling local TZ.
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();

    if (hour !== FIRE_HOUR_UTC || minute !== 0) return;
    if (!SCOUTS[day]) return;
    const key = `${now.toISOString().slice(0, 10)}-${hour}`;
    if (lastFiredKey === key) return;

    const chat_id = authorizedChatId();
    if (!chat_id) {
      console.log(`[scheduler] day=${day} matched but no authorized chat yet — skipping`);
      return;
    }

    lastFiredKey = key;
    const scout = SCOUTS[day];
    console.log(`[scheduler] firing ${scout.name} → chat ${chat_id}`);

    // Inject the opener into history as if assistant said it, then send.
    const history = loadHistory(chat_id);
    history.push({ role: 'assistant', content: scout.opener, ts: Date.now() });
    saveHistory(chat_id, history);
    try {
      await sendMessage(chat_id, scout.opener);
    } catch (e) {
      console.error('[scheduler] sendMessage failed:', e.message);
    }
  }, 60000); // every minute — cheap, no paid API calls
}

// ── Boot ────────────────────────────────────────────────────────────────
console.log(`[scout-bot] starting (model=${MODEL}, passphrase=${PASSPHRASE.slice(0, 3)}***)`);
const authed = authorizedChatId();
console.log(`[scout-bot] authorized chat_id: ${authed || '(none — first /start with passphrase wins)'}`);
poll();
startScheduler();
