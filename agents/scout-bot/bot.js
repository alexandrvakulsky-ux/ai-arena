#!/usr/bin/env node
/**
 * Scout Bot — Alex's AI Chief of Staff on Telegram.
 *
 * What it does:
 *  - Long-polls Telegram for incoming messages from one authorized chat.
 *  - Five proactive cadences (UTC; container runs UTC):
 *      * Mon-Fri 7:00  — daily one-question check-in
 *      * Mon       9:00 — MCP integrations scout
 *      * Thu       9:00 — Futureproof marketing intel scout
 *      * Sun       17:00 — weekly wrap-up question
 *      * Anytime   — ad-hoc Q&A
 *  - Per-chat conversation history (last ~40 turns).
 *  - Curated long-term memory (memory.md) + auto-grown journal (journal.md).
 *  - Reads ad-spy + ai-arena snapshot data so questions are grounded.
 *  - Commands: /help, /clear, /snooze, /quiet, /normal, /status, /memory.
 *
 * Costs (idle = $0):
 *  - Daily check-in × 5/week × ~$0.05 = $0.25/wk
 *  - Mon/Thu scout × 2 × ~$0.30 = $0.60/wk
 *  - Sunday wrap × 1 × ~$0.10 = $0.10/wk
 *  - Ad-hoc replies vary; typical ~$2/wk
 *  - Roughly $12-15/month at moderate use.
 */

// override: true is critical — the Claude Code Remote runtime leaks empty
// values for ANTHROPIC_API_KEY + TELEGRAM_BOT_TOKEN into the process env,
// and dotenv refuses to overwrite existing values unless told to.
require('dotenv').config({ path: '/workspace/.env', override: true });
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { execSync } = require('child_process');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASSPHRASE = process.env.TELEGRAM_PASSPHRASE || 'futureproof-scout';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!TOKEN) { console.error('[scout-bot] TELEGRAM_BOT_TOKEN missing — exiting'); process.exit(0); }
if (!ANTHROPIC_KEY) { console.error('[scout-bot] ANTHROPIC_API_KEY missing — exiting'); process.exit(1); }

const BOT_DIR = '/workspace/agents/scout-bot';
const AUTH_FILE = path.join(BOT_DIR, '.authorized_chat.txt');
const STATE_FILE = path.join(BOT_DIR, '.bot-state.json');
const CHATS_DIR = path.join(BOT_DIR, 'chats');
const MEMORY_FILE = path.join(BOT_DIR, 'memory.md');
const JOURNAL_FILE = path.join(BOT_DIR, 'journal.md');
fs.mkdirSync(CHATS_DIR, { recursive: true });

const TG = `https://api.telegram.org/bot${TOKEN}`;
const MODEL = 'claude-opus-4-6';
const MAX_HISTORY_TURNS = 20;
const HISTORY_KEEP = 40;

// ── State (mode + snooze) ────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { mode: 'normal', snooze_until_ts: 0, last_fired_keys: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function isSnoozed() {
  return loadState().snooze_until_ts > Date.now();
}
function inMode(name) {
  return loadState().mode === name;
}
function snoozeFor(ms) {
  const s = loadState();
  s.snooze_until_ts = Date.now() + ms;
  saveState(s);
}
function setMode(mode) {
  const s = loadState();
  s.mode = mode;
  saveState(s);
}
function markFired(key) {
  const s = loadState();
  s.last_fired_keys[key] = Date.now();
  saveState(s);
}
function alreadyFired(key) {
  const s = loadState();
  return !!s.last_fired_keys[key];
}

// ── Auth ─────────────────────────────────────────────────────────────────
function authorizedChatId() {
  try { return parseInt(fs.readFileSync(AUTH_FILE, 'utf8').trim(), 10); }
  catch { return null; }
}
function setAuthorizedChatId(id) {
  fs.writeFileSync(AUTH_FILE, String(id));
  console.log(`[scout-bot] authorized chat_id=${id}`);
}

// ── Telegram client ──────────────────────────────────────────────────────
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

// ── History / Memory / Journal ───────────────────────────────────────────
function chatHistoryFile(chat_id) { return path.join(CHATS_DIR, `${chat_id}.json`); }
function loadHistory(chat_id) {
  try {
    const raw = JSON.parse(fs.readFileSync(chatHistoryFile(chat_id), 'utf8'));
    // Filter out turns with empty/missing content — Anthropic API rejects
    // those with "user messages must have non-empty content". Defensive:
    // covers historic poisoning by forwarded-media messages that slipped
    // through before the extractMessageContent fix.
    return raw.filter(turn =>
      turn && typeof turn.content === 'string' && turn.content.trim().length > 0
    );
  } catch { return []; }
}
function saveHistory(chat_id, history) {
  fs.writeFileSync(chatHistoryFile(chat_id), JSON.stringify(history.slice(-HISTORY_KEEP), null, 2));
}

// Extract a usable text payload from a Telegram message. Handles:
//  - plain text (.text)
//  - captions on photos/videos/documents (.caption)
//  - forwards (prepends "[Forwarded from X]" header)
//  - empty messages (stickers, voice, location, polls, etc.) → returns null
function extractMessageContent(msg) {
  const parts = [];
  if (msg.forward_from_chat) {
    const src = msg.forward_from_chat.title || msg.forward_from_chat.username || 'a chat';
    parts.push(`[Forwarded from ${src}]`);
  } else if (msg.forward_from) {
    const src = msg.forward_from.first_name || msg.forward_from.username || 'someone';
    parts.push(`[Forwarded from ${src}]`);
  } else if (msg.forward_sender_name) {
    parts.push(`[Forwarded from ${msg.forward_sender_name}]`);
  }
  if (msg.text && msg.text.trim()) parts.push(msg.text.trim());
  if (msg.caption && msg.caption.trim()) parts.push(msg.caption.trim());

  // If we only have the [Forwarded from X] header and nothing else, there's
  // no real content — return null so caller can reply "no text seen".
  const hasRealText = parts.some(p => !p.startsWith('[Forwarded'));
  if (!hasRealText) return null;
  return parts.join('\n');
}

function loadMemory() {
  try { return fs.readFileSync(MEMORY_FILE, 'utf8'); }
  catch { return '(no memory yet)'; }
}
function loadJournalTail(maxLines = 80) {
  try {
    const all = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n');
    return all.slice(-maxLines).join('\n');
  } catch { return '(no journal entries yet)'; }
}
function appendJournal(entry) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  fs.appendFileSync(JOURNAL_FILE, `\n[${stamp}] ${entry}\n`);
}

// ── Context loaders (ad-spy + ai-arena snapshot for grounded questions) ─
let _contextCache = { ts: 0, data: '' };
function loadContextSnapshot() {
  // Cache for 30 min — multiple chats during a session don't refetch.
  if (Date.now() - _contextCache.ts < 30 * 60 * 1000) return _contextCache.data;

  const parts = [];

  // ad-spy via docker exec (sibling container)
  try {
    const health = JSON.parse(execSync(
      `docker exec ad-spy curl -sm 3 http://localhost:3001/health`,
      { timeout: 5000 }
    ).toString());
    parts.push(`ad-spy: ${health.competitors} competitors tracked, ${health.ads} ads, ${health.images_cached} images cached, uptime ${Math.round(health.uptime / 3600)}h`);
  } catch (e) { /* ad-spy down or unreachable — skip */ }

  // ai-arena local
  try {
    const aiHealth = JSON.parse(execSync(
      `curl -sm 3 http://localhost:3000/health`,
      { timeout: 5000 }
    ).toString());
    parts.push(`ai-arena: ${aiHealth.status}, uptime ${Math.round(aiHealth.uptime / 3600)}h`);
  } catch (e) { /* ai-arena down — skip */ }

  const data = parts.length > 0 ? parts.join('\n') : '(no live system data available right now)';
  _contextCache = { ts: Date.now(), data };
  return data;
}

// ── Claude API ───────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const memory = loadMemory();
  const journal = loadJournalTail(60);
  const snapshot = loadContextSnapshot();
  return `You are Alex's AI Chief of Staff on Telegram. You're his daily-ish proactive advisor for three projects:
- **Futureproof** (active priority) — consumer cybersecurity SaaS in development
- **ad-spy** — FB Ad Library intelligence tool, runs at http://135.181.153.92:3001
- **ai-arena** — multi-model comparison app, runs at http://135.181.153.92:3000

Your role split:
1. **Learn the project deeply** — every interaction, build understanding of what Alex is shipping, struggling with, deciding. Ask follow-up questions that reference what he told you previously.
2. **Make it better with AI** — discover MCPs, integrations, marketing/funnel intel. Always tie finds to his specific context.

Your style:
- Casual, conversational — this is Telegram, not email. Short messages beat walls of text.
- Curious — ALWAYS ask a follow-up question after answering. You want to understand more.
- Reference past context — "you mentioned X two days ago, did it ship?" beats neutral "any updates?"
- Opinionated about finds — say "try #2 first because Y" not "here are 5 options".
- Concrete over generic — concrete URLs, concrete suggestions for Futureproof, never vague advice.
- Match the user's brevity — Alex types short, you reply short.

Cadences you fire on (you don't need to remember the schedule, it's handled by code):
- Mon-Fri 7am UTC: one-question daily check-in
- Mon 9am UTC: MCP scout + weekly planning
- Thu 9am UTC: Futureproof intel scout + mid-week pulse
- Sun 5pm UTC: weekly wrap-up

When user asks for engineering / code changes:
- If it's small + you can answer with a quick suggestion, just suggest.
- If it requires actually editing code in /workspace (ai-arena, ad-spy, etc.), draft a self-contained Claude Code prompt and present it like:
\`\`\`claude-code-prompt
[full prompt with file paths, what to do, verification steps]
\`\`\`
Tell Alex to paste it into Claude Code Desktop. v1 of this bot is NOT autonomous — it suggests, Alex executes.

When you learn new context about Alex's projects, include a line prefixed "MEMORY_UPDATE:" — the system strips these from your reply and appends to memory.md. Example:
  MEMORY_UPDATE: Alex shipped the data-broker exposure widget on 2026-05-26.

Memory (long-term curated context):
${memory}

Journal (recent chronological log of what Alex told you):
${journal}

Live system snapshot:
${snapshot}

You have web_search — use it when you need current info, but don't over-search. If you already know the answer, just say it.`;
}

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

async function generateReply(chat_id, userMessage, systemOverride = null) {
  let history = loadHistory(chat_id);
  history.push({ role: 'user', content: userMessage, ts: Date.now() });
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
        system: systemOverride || buildSystemPrompt(),
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      }),
      timeout: 90000,
    });
    data = await r.json();
  } catch (err) {
    console.error('[anthropic] fetch error:', err.message);
    return 'hit a network issue talking to Claude — try again?';
  }
  if (data.error) {
    console.error('[anthropic] error:', JSON.stringify(data.error).slice(0, 200));
    return `Claude API error: ${data.error.message || 'unknown'}`;
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

// ── Slash + natural-language command parsing ─────────────────────────────
function parseSnoozeText(text) {
  // Accepts: "/snooze 3d", "snooze 3 days", "snooze me for a week"
  const lower = text.toLowerCase();
  if (!lower.includes('snooze')) return null;
  const m = lower.match(/(\d+)\s*(d|day|days|h|hour|hours|w|week|weeks)/);
  if (!m) return 24 * 3600 * 1000; // default 1 day
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit.startsWith('h')) return n * 3600 * 1000;
  if (unit.startsWith('w')) return n * 7 * 24 * 3600 * 1000;
  return n * 24 * 3600 * 1000;
}

async function handleSlashCommand(chat_id, text) {
  if (text === '/start') {
    await sendMessage(chat_id, `Hey. I check in Mon-Fri mornings with a single question, plus a Monday MCP scout and Thursday Futureproof intel sweep. Sunday I ask how the week went. Ping me anytime in between.\n\nCommands: /help`);
    return true;
  }
  if (text === '/help') {
    await sendMessage(chat_id,
      `Commands\n` +
      `/help — this\n` +
      `/status — current mode + snooze state\n` +
      `/clear — wipe conversation (keeps memory)\n` +
      `/snooze 3d — no proactive pings for N days/hours/weeks (default 1d)\n` +
      `/quiet — drop daily check-ins, keep Mon/Thu/Sun only\n` +
      `/normal — restore Mon-Fri + weekly cadence\n` +
      `/memory — show current long-term memory file\n` +
      `\nNatural language works too — try "snooze for a week" or "less".`
    );
    return true;
  }
  if (text === '/status') {
    const s = loadState();
    const snoozeStr = s.snooze_until_ts > Date.now()
      ? `snoozed until ${new Date(s.snooze_until_ts).toISOString().slice(0, 16)} UTC`
      : 'active';
    await sendMessage(chat_id, `Mode: ${s.mode}\nState: ${snoozeStr}\nJournal entries today: ${(loadJournalTail(200).match(new RegExp('\\[' + new Date().toISOString().slice(0,10) + ' ', 'g')) || []).length}`);
    return true;
  }
  if (text === '/clear') {
    try { fs.unlinkSync(chatHistoryFile(chat_id)); } catch {}
    await sendMessage(chat_id, `Conversation cleared. Memory + journal preserved.`);
    return true;
  }
  if (text === '/quiet') {
    setMode('quiet');
    await sendMessage(chat_id, `Switched to quiet mode — only Mon (MCP) + Thu (Futureproof) + Sun wrap. No daily pings.`);
    return true;
  }
  if (text === '/normal') {
    setMode('normal');
    await sendMessage(chat_id, `Back to normal — Mon-Fri daily check-ins + weekly scouts + Sun wrap.`);
    return true;
  }
  if (text === '/memory') {
    const mem = loadMemory();
    await sendMessage(chat_id, mem.length > 3500 ? mem.slice(0, 3500) + '\n…(truncated; see memory.md)' : mem);
    return true;
  }
  if (text.startsWith('/snooze')) {
    const ms = parseSnoozeText(text);
    snoozeFor(ms);
    const until = new Date(Date.now() + ms).toISOString().slice(0, 16);
    await sendMessage(chat_id, `Snoozed proactive pings until ${until} UTC. You can still message me anytime.`);
    return true;
  }
  return false;
}

// ── Incoming message handler ────────────────────────────────────────────
async function handleMessage(msg) {
  const chat_id = msg.chat.id;
  // Extract usable content (text, caption, forwarded metadata). Returns
  // null for empty/media-only messages (stickers, voice, etc).
  const content = extractMessageContent(msg);
  const text = content || ''; // for command parsing / passphrase check
  const isEmpty = content === null;

  const authed = authorizedChatId();
  if (authed === null) {
    if (text.includes(PASSPHRASE)) {
      setAuthorizedChatId(chat_id);
      await sendMessage(chat_id, `Authorized — locked to this chat.\n\nI'm your AI Chief of Staff for Futureproof, ad-spy, and ai-arena. Cadence:\n- Mon-Fri 7am UTC: short daily check-in\n- Mon 9am: MCP scout + planning\n- Thu 9am: Futureproof intel\n- Sun 5pm: weekly wrap-up\n- Anytime: ping me a question\n\nFirst question: what's the most pressing thing on your plate this week?\n\nType /help for commands.`);
      return;
    }
    return;
  }
  if (chat_id !== authed) return;

  // Empty / media-only messages: be polite, don't pass to API.
  if (isEmpty) {
    await sendMessage(chat_id, `Got a message with no text I can read (sticker, voice, photo without caption, etc.). What did you want to discuss about it? I can only process text + captions right now.`);
    return;
  }

  // Slash + natural-language snooze
  if (text.startsWith('/')) {
    const handled = await handleSlashCommand(chat_id, text);
    if (handled) return;
  }
  if (/^snooze\b|^less$|^pause$|^stop pings/i.test(text)) {
    if (/^less$|^quiet/i.test(text)) {
      setMode('quiet');
      await sendMessage(chat_id, `Got it — quiet mode (weekly only).`);
      return;
    }
    const ms = parseSnoozeText(text) || 24 * 3600 * 1000;
    snoozeFor(ms);
    const until = new Date(Date.now() + ms).toISOString().slice(0, 16);
    await sendMessage(chat_id, `Snoozed until ${until} UTC.`);
    return;
  }

  // Capture short user content to journal so future questions can reference it.
  // Use `content` (extracted, includes forward headers) — never empty here.
  if (content.length > 5 && content.length < 2000) appendJournal(`Alex: ${content.slice(0, 500)}`);

  await tg('sendChatAction', { chat_id, action: 'typing' });
  const reply = await generateReply(chat_id, content);
  if (reply && reply.trim()) {
    appendJournal(`bot: ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);
    await sendMessage(chat_id, reply);
  }
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
      console.error('[poll] tg error:', JSON.stringify(data).slice(0, 200));
      await new Promise(r => setTimeout(r, 10000));
    }
  } catch (err) {
    if (err.code !== 'ETIMEDOUT') console.error('[poll]', err.message);
    await new Promise(r => setTimeout(r, 5000));
  }
  setImmediate(poll);
}

// ── Proactive cadences ──────────────────────────────────────────────────
// Cadences map weekday → array of {hour_utc, key_prefix, opener_prompt, mode_required}.
// mode_required: if set, only fires when state.mode matches.
const CADENCES = [
  { day: 1, hour: 7, key: 'daily-mon', prompt: 'daily-checkin', mode: 'normal' },
  { day: 2, hour: 7, key: 'daily-tue', prompt: 'daily-checkin', mode: 'normal' },
  { day: 3, hour: 7, key: 'daily-wed', prompt: 'daily-checkin', mode: 'normal' },
  { day: 4, hour: 7, key: 'daily-thu', prompt: 'daily-checkin', mode: 'normal' },
  { day: 5, hour: 7, key: 'daily-fri', prompt: 'daily-checkin', mode: 'normal' },
  { day: 1, hour: 9, key: 'mcp-scout', prompt: 'mcp-scout' },         // any mode
  { day: 4, hour: 9, key: 'futureproof-scout', prompt: 'futureproof-scout' },
  { day: 0, hour: 17, key: 'sunday-wrap', prompt: 'sunday-wrap' },
];

const PROMPTS = {
  'daily-checkin': `Generate a SHORT daily check-in question to Alex. Reference yesterday's journal entries if relevant. ONE focused question, max 2 sentences before it. Examples of good openers:\n- "Yesterday you said X — did it ship?"\n- "Two days back you flagged the funnel issue. Where's that now?"\n- "What's the top thing today?"\n\nMake it specific to context if you have it, generic if not. Output ONLY the message text — no preamble, no markdown, ready to send to Telegram as-is.`,

  'mcp-scout': `It's Monday. Generate the opening message for the MCP scout cadence. Briefly acknowledge it's Monday and you're about to scout MCP releases for the past week. Ask Alex ONE planning-style question first (e.g., "what category are you hungry for?" or "any specific problem you wish an MCP solved?"). After he answers (in a later message), you'll actually do the scouting with web_search. For THIS message just write the opener. Output ONLY the message text, ready to send.`,

  'futureproof-scout': `It's Thursday. Generate the opening message for the Futureproof intel scout cadence. Ask Alex 2-3 quick prep questions (max 3, one-liners): blocker, competitor to look at, what tested last week. Output ONLY the opener message, ready to send.`,

  'sunday-wrap': `It's Sunday 5pm. Generate a soft weekly wrap-up message. Reference the journal entries from this past week if any. Ask: "what shipped this week?", "what's on your mind for next?", and one specific reference back to something he mentioned earlier in the week if possible. Output ONLY the message text, conversational, max 4 short sentences.`,
};

async function fireCadence(cadence) {
  const chat_id = authorizedChatId();
  if (!chat_id) {
    console.log(`[cadence] ${cadence.key} skipped — no authorized chat`);
    return;
  }
  if (isSnoozed()) {
    console.log(`[cadence] ${cadence.key} skipped — bot is snoozed`);
    return;
  }
  if (cadence.mode && !inMode(cadence.mode)) {
    console.log(`[cadence] ${cadence.key} skipped — mode is ${loadState().mode}, requires ${cadence.mode}`);
    return;
  }

  console.log(`[cadence] firing ${cadence.key}`);
  const instructions = PROMPTS[cadence.prompt];

  // Generate the opener via Claude (it'll be context-aware via system prompt).
  // We feed instructions as a "user" message so Claude treats it as a task spec,
  // but the response goes BACK to Alex on Telegram — so we strip "Alex" prefix etc.
  // To avoid polluting history, we don't save this synthetic user turn.
  let openerText = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: instructions }],
      }),
      timeout: 30000,
    });
    const data = await r.json();
    if (data.error) {
      console.error('[cadence] api error:', data.error);
      return;
    }
    openerText = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n\n').trim();
    openerText = processMemoryUpdates(openerText);
  } catch (err) {
    console.error('[cadence]', err.message);
    return;
  }

  if (!openerText) return;

  // Inject into conversation history as if assistant said it (so Alex's reply
  // continues the conversation in the normal generateReply flow).
  const history = loadHistory(chat_id);
  history.push({ role: 'assistant', content: openerText, ts: Date.now() });
  saveHistory(chat_id, history);
  appendJournal(`bot (${cadence.key}): ${openerText.slice(0, 200)}${openerText.length > 200 ? '…' : ''}`);

  try {
    await sendMessage(chat_id, openerText);
  } catch (err) {
    console.error('[cadence] send failed:', err.message);
  }
}

function startScheduler() {
  console.log(`[scheduler] cadences: ${CADENCES.length} configured`);
  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    if (minute !== 0) return;

    const today = now.toISOString().slice(0, 10);

    for (const c of CADENCES) {
      if (c.day !== day || c.hour !== hour) continue;
      const fireKey = `${c.key}-${today}`;
      if (alreadyFired(fireKey)) continue;
      markFired(fireKey);
      fireCadence(c).catch(e => console.error('[cadence-loop]', e.message));
    }
  }, 60 * 1000);
}

// ── Boot ────────────────────────────────────────────────────────────────
console.log(`[scout-bot] starting (model=${MODEL}, passphrase=${PASSPHRASE.slice(0, 3)}***)`);
const authed = authorizedChatId();
console.log(`[scout-bot] authorized chat_id: ${authed || '(none — first /start with passphrase wins)'}`);
console.log(`[scout-bot] mode: ${loadState().mode}, snoozed: ${isSnoozed()}`);
poll();
startScheduler();
