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
const FormData = require('form-data');
let YoutubeTranscript;
try { YoutubeTranscript = require('youtube-transcript').YoutubeTranscript; } catch {}
const vectorstore = require('./vectorstore');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASSPHRASE = process.env.TELEGRAM_PASSPHRASE || 'futureproof-scout';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
// fetch() error messages can embed the full Telegram URL (which contains the bot token);
// strip the token from anything we log.
const redact = (s) => String(s == null ? '' : s).split(TOKEN || '\0impossible\0').join('***');
// Strip unpaired UTF-16 surrogates (e.g. an emoji cut in half) — a lone surrogate makes the
// JSON body invalid for the Anthropic API ("no low surrogate in string").
const stripSurrogates = (s) => String(s == null ? '' : s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

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
const MODEL = 'claude-fable-5'; // chat answers — most capable tier (Alex: complex questions need complex answers)
const CADENCE_MODEL = 'claude-sonnet-4-6'; // proactive openers — cheaper than Fable, user won't notice
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

// ── Multi-user (Alex=CEO + Lera, his wife), ONE shared brain ──────────────────
const USERS_FILE = path.join(BOT_DIR, '.authorized_users.json');
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch {
    const legacy = authorizedChatId(); // migrate the single-chat file
    const seed = legacy ? { [legacy]: 'alex' } : {};
    if (legacy) { try { fs.writeFileSync(USERS_FILE, JSON.stringify(seed, null, 2)); } catch {} }
    return seed;
  }
}
function saveUsers(u) { try { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); } catch {} }
function userLabel(chat_id) { return loadUsers()[chat_id] || null; }
function enrollUser(chat_id) {
  const u = loadUsers();
  if (u[chat_id]) return u[chat_id];
  const taken = Object.values(u);
  const label = !taken.includes('alex') ? 'alex' : !taken.includes('lera') ? 'lera' : 'guest';
  u[chat_id] = label; saveUsers(u);
  console.log(`[scout-bot] enrolled chat ${chat_id} as ${label}`);
  return label;
}
// Per-reply principal. Passed explicitly through generateReply/mediationBlock/cadence
// so concurrent handlers + the multi-user cadence loop never read each other's value.
// (A module global here used to let Alex's owner-only DM persona leak into Lera's reply.)
function mediationBlock(userLabel = 'alex') {
  const who = userLabel === 'lera' ? "Lera (Valeria, Alex's wife)" : userLabel === 'alex' ? 'Alex (CEO)' : userLabel;
  return `

═══ SHARED SECOND BRAIN — TWO PRINCIPALS ═══
You serve TWO people at Futureproof who share THIS SAME memory + knowledge base:
- Alex — CEO (product, architecture, roadmap, technical, partnerships)
- Lera (Valeria) — Alex's wife (marketing, ads, copy, messaging, campaigns, funnel, creative, pricing)
You are currently talking to: ${who}.

SILENT MEDIATION (critical): when their views/instructions differ, do NOT surface the conflict
("Alex said X but Lera said Y"). Internally synthesize both like a consultant, form your own
recommendation, and only escalate if you genuinely cannot reconcile — and then come WITH a
proposed resolution, never just "you disagree".

DOMAIN WEIGHT MATRIX (apply subtly in internal reasoning; NEVER expose the numbers):
- Marketing / ads / copy / funnel / creative: Lera 70%, Alex 30%
- Pricing / monetization: Lera 60%, Alex 40%
- Product / architecture / roadmap / tech: Alex 70%, Lera 30%
Weights reflect expertise, not hierarchy. Her marketing/funnel research feeds his product
decisions; his product insight feeds her marketing. One brain, two perspectives. Attribute what
you learn to who said it. Both share the brain — EXCEPT Alex's private Slack DMs, which only
Alex can recall (their substance still informs the brain's context, but Lera cannot surface them).`;
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
// ── Whisper voice transcription ──────────────────────────────────────────
// Telegram voice messages arrive as .ogg/opus files. We fetch the file
// via Telegram's getFile API and POST it to OpenAI's Whisper endpoint.
// Returns the transcribed text or null on any failure (caller falls back
// to "I can't read voice yet" reply).
async function transcribeVoice(fileId) {
  if (!OPENAI_KEY) {
    console.error('[voice] OPENAI_API_KEY missing — cannot transcribe');
    return null;
  }
  try {
    const fileRes = await tg('getFile', { file_id: fileId });
    if (!fileRes.ok || !fileRes.result?.file_path) {
      console.error('[voice] getFile failed:', JSON.stringify(fileRes).slice(0, 200));
      return null;
    }
    const audioUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileRes.result.file_path}`;
    const audioRes = await fetch(audioUrl, { timeout: 30000 });
    if (!audioRes.ok) {
      console.error('[voice] file download failed:', audioRes.status);
      return null;
    }
    const audioBuf = await audioRes.buffer();

    const form = new FormData();
    form.append('file', audioBuf, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...form.getHeaders() },
      body: form,
      timeout: 60000,
    });
    if (!whisperRes.ok) {
      console.error('[voice] Whisper error:', whisperRes.status, (await whisperRes.text()).slice(0, 200));
      return null;
    }
    const data = await whisperRes.json();
    console.log(`[voice] transcribed ${audioBuf.length}b → ${(data.text || '').length} chars`);
    return data.text || null;
  } catch (err) {
    console.error('[voice] transcribeVoice error:', redact(err.message));
    return null;
  }
}

// ── YouTube transcript fetch ─────────────────────────────────────────────
// Detects YouTube URLs in user messages and pulls captions via the
// youtube-transcript npm package (pure Node, no yt-dlp/system deps).
// Failures degrade gracefully — the URL just stays as a URL in the
// message; Claude can still respond to it.
const YT_URL_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/g;
function extractYouTubeIds(text) {
  if (!text) return [];
  const ids = new Set();
  let m;
  YT_URL_REGEX.lastIndex = 0;
  while ((m = YT_URL_REGEX.exec(text)) !== null) ids.add(m[1]);
  return [...ids];
}
async function fetchYouTubeTranscript(videoId) {
  if (!YoutubeTranscript) {
    console.error('[yt] youtube-transcript package not installed');
    return null;
  }
  try {
    const parts = await YoutubeTranscript.fetchTranscript(videoId);
    const text = parts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
    console.log(`[yt] ${videoId} → ${text.length} chars`);
    return text;
  } catch (err) {
    console.error(`[yt] ${videoId} fetch failed:`, err.message);
    return null;
  }
}

// Download a Telegram file (by file_id) and return it base64-encoded.
async function downloadTelegramFileB64(fileId) {
  try {
    const fileRes = await tg('getFile', { file_id: fileId });
    if (!fileRes.ok || !fileRes.result.file_path) return null;
    const url = `https://api.telegram.org/file/bot${TOKEN}/${fileRes.result.file_path}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.buffer()).toString('base64');
  } catch (err) { console.error('[pdf] download error:', redact(err.message)); return null; }
}

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

When user asks for engineering / code changes / server actions:
- If it's small + answerable with a quick suggestion, just suggest.
- If it requires actually editing code, running a shell command, restarting services, or pushing commits — call the propose_action tool. It queues the work for Alex to approve in Claude Code Desktop. Be PRECISE in the plan (exact file paths, exact strings to find/replace, exact commands) so Claude Code can execute without coming back to you. After calling propose_action, tell Alex in your reply what you queued and that it'll surface in his next Claude Code session.

When you learn new context about Alex's projects, include a line prefixed "MEMORY_UPDATE:" — the system strips these from your reply and appends to memory.md. Example:
  MEMORY_UPDATE: Alex shipped the data-broker exposure widget on 2026-05-26.

Memory (long-term curated context):
${memory}

Journal (recent chronological log of what Alex told you):
${journal}

Live system snapshot:
${snapshot}

You have web_search — use it when you need current info, but don't over-search. If you already know the answer, just say it.

You also have READ-ONLY server tools — use them when Alex asks about server state or live data:
- query_adspy(path) — GET an ad-spy endpoint. E.g. "/health" for ad/competitor counts, "/api/sc-cost" for SC credit usage, "/api/access-stats" for visitor activity.
- query_aiarena(path) — GET an ai-arena endpoint. "/health" works.
- vector_search(query) — semantic search your second-brain (Slack channels, meeting summaries, decisions). Use it whenever asked about a past discussion/decision/meeting, or you need internal Futureproof/Genesis context.
- firecrawl_scrape(url) — read any web page as clean markdown (competitor landing pages, articles, docs).
- read_file(path) — read a file under /workspace. .env and credential files are denied. Use for code, configs, journal.md, memory.md, cached data, etc.
- list_directory(path) — list a /workspace or /tmp directory.
- tail_log(name, lines) — tail server.log, scout-bot.log, auto-deploy.log, or supervisor.log.
- git_head_info() — current branch + last commit summary.

Use these tools when answering "what's running", "show me X", "how much credit left", "what's in the latest brief", "what did I journal yesterday", etc. Don't ask Alex to do it — just check and report.

For ANYTHING requiring write/edit/run/push capability on the server, use propose_action(). Examples:
- "Fix the typo in README" → propose_action with action_type=edit_file, plan including exact path + old_str + new_str
- "Restart ad-spy" → propose_action with action_type=shell, plan including the exact pkill+nohup commands
- "Push that change" → propose_action with action_type=git_branch_and_push
The proposal sits in /workspace/agents/scout-bot/pending-actions.jsonl. When Alex next opens Claude Code on Hetzner, Claude surfaces it for his approval and executes.

═══ MONITORING SOURCE DATABASE ═══

You maintain a growing database of accounts/repos/feeds to monitor for MCP and Futureproof intel. Tools: add_source, list_sources, score_source, record_source_find.

Workflow:
- AT THE START of every scout cadence (Mon MCP / Thu Futureproof), call list_sources(topic) to see what you're tracking. Bias your web_search toward known-quality sources (quality >= 3) first.
- WHEN YOU FIND a useful item attributable to a source, call record_source_find(id, summary, url) — this builds the productivity log per source.
- WHEN ALEX REACTS to a find ("loved this one", "skip @X they're noisy"), call score_source(id, delta, reason). +1 to +3 for hits, -1 to -3 for misses. Quality < -3 means stop checking.
- WHEN YOU DISCOVER a new high-signal account (mentioned by a known-quality source, or someone Alex talks about positively), call add_source. Don't ask Alex first — adding is cheap and reversible. Just add it.
- WHEN ALEX TELLS YOU about an account he follows ("@X is great" or "you should follow @Y"), call add_source AND tell him you did it.

The database is the system's growing intelligence — references → new sources → quality scoring → verified-tier (q≥5) sources scouted first. Treat it as a network you're cultivating, not a static list.

Output style for scout reports:
- Each find should cite the source ID and handle, e.g. "[src_seed_swyx | @swyx] retweeted a thread about new MCP server X..."
- At the end of the scout, briefly note: "Source updates this cycle: added @NewSource (mentioned by @swyx), bumped @ProductiveAccount to q=4 after 3 hits." That keeps the database growth visible.`;
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
    let existing = '';
    try { existing = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch {}
    const fresh = memUpdates.filter(u => !existing.includes(u)); // skip already-recorded lines
    if (fresh.length > 0) {
      const date = new Date().toISOString().slice(0, 10);
      const append = `\n\n## Updates ${date}\n` + fresh.map(u => `- ${u}`).join('\n');
      fs.appendFileSync(MEMORY_FILE, append);
      const dup = memUpdates.length - fresh.length;
      console.log(`[scout-bot] appended ${fresh.length} memory update(s)${dup ? ` (${dup} dup skipped)` : ''}`);
    }
  }
  return remaining.join('\n').trim();
}

// Custom tools the bot can call (read-only — query ad-spy, query ai-arena,
// read files, list dirs, git status, tail logs). See tools.js.
const { TOOL_SCHEMAS: BOT_TOOLS, executeTool } = require('./tools');
const MAX_TOOL_ITERATIONS = 8;

async function generateReply(chat_id, userMessage, systemOverride = null, attachment = null, userLabel = 'alex') {
  let history = loadHistory(chat_id);
  history.push({ role: 'user', content: userMessage, ts: Date.now() });
  // Build messages from stored history (plain text turns only).
  let messages = history.slice(-MAX_HISTORY_TURNS).map(({ role, content }) => ({ role, content }));
  // The API requires the first message to be `user`. A cadence opener is stored as a
  // lone `assistant` turn, so a fresh chat (or a slice that starts mid-pair) can lead
  // with assistant → 400 "first message must be user". Drop leading non-user turns.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  // If this turn carries a file (e.g. a PDF), make the latest user turn multimodal
  // for THIS call only — the base64 is never stored in history (so it isn't re-sent later).
  if (attachment && messages.length) {
    const last = messages[messages.length - 1];
    last.content = [attachment, { type: 'text', text: typeof last.content === 'string' ? last.content : userMessage }];
  }

  // Agentic loop: call API, execute any tool_use blocks, feed results
  // back, repeat until Claude stops calling tools (final answer).
  let finalText = '';
  let lastText = '';
  // Build the static system + tools ONCE and mark them for prompt caching, so the big
  // system prompt + tools schema aren't re-billed at full price across tool-loop iterations
  // (or across back-to-back messages within the cache TTL). Same model, same output, ~90% off
  // the cached input tokens.
  const sysText = (systemOverride || buildSystemPrompt()) + mediationBlock(userLabel);
  const sysBlocks = [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }];
  const toolsArr = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ...BOT_TOOLS,
  ];
  toolsArr[toolsArr.length - 1] = { ...toolsArr[toolsArr.length - 1], cache_control: { type: 'ephemeral' } };
  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
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
          max_tokens: 3000,
          system: sysBlocks,
          messages,
          tools: toolsArr,
        }),
        timeout: 120000,
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

    const content = data.content || [];
    // Filter to OUR tool uses (not web_search — that's server-side).
    const ourTools = new Set(BOT_TOOLS.map(t => t.name));
    const toolUses = content.filter(c => c.type === 'tool_use' && ourTools.has(c.name));
    const textBlocks = content.filter(c => c.type === 'text');
    if (textBlocks.length) lastText = textBlocks.map(c => c.text).join('\n\n'); // keep latest interim text

    if (toolUses.length === 0) {
      // No more tool calls — this is the final response.
      finalText = textBlocks.map(c => c.text).join('\n\n');
      break;
    }

    // Append assistant's tool_use turn (full content array — required).
    messages.push({ role: 'assistant', content });

    // Execute each tool, build tool_result blocks.
    const toolResults = [];
    for (const t of toolUses) {
      console.log(`[tool] ${t.name}(${JSON.stringify(t.input).slice(0, 100)})`);
      const result = await executeTool(t.name, t.input, { isOwner: userLabel === 'alex' });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: t.id,
        content: stripSurrogates(typeof result === 'string' ? result : JSON.stringify(result)),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) {
    // Used all tool steps without concluding — force ONE final text answer.
    // messages still contains assistant tool_use blocks, so we MUST keep `tools`
    // (+ the web-search beta header) or the API 400s on tool blocks that reference
    // absent tools. tool_choice:'none' is the supported way to forbid new tool calls.
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
          max_tokens: 1500,
          system: sysBlocks,
          messages,
          tools: toolsArr,
          tool_choice: { type: 'none' },
        }),
        timeout: 60000,
      });
      const d = await r.json();
      if (!d.error) finalText = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n\n').trim();
    } catch (e) { console.error('[anthropic] final-answer fallback failed:', e.message); }
    if (!finalText) finalText = lastText || "ran out of tool steps before I could finish — try narrowing the question?";
  }
  const cleanReply = processMemoryUpdates(finalText);

  // Persist ONLY the simple text turns to disk (not the tool calls).
  // This keeps history serializable and avoids re-feeding stale tool
  // results on the next turn.
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

  // ── Voice transcription via Whisper ───────────────────────────────────
  // Telegram voice / audio messages have no msg.text. We transcribe them
  // to text BEFORE extractMessageContent runs, then synthesize msg.text
  // so the rest of the handler treats them as normal text input.
  if ((msg.voice || msg.audio) && OPENAI_KEY) {
    const fileId = (msg.voice || msg.audio).file_id;
    await tg('sendChatAction', { chat_id, action: 'typing' });
    await sendMessage(chat_id, '🎤 transcribing...');
    const transcript = await transcribeVoice(fileId);
    if (transcript && transcript.trim()) {
      msg.text = `[voice] ${transcript.trim()}`;
    } else {
      await sendMessage(chat_id, `Couldn't transcribe that voice message. Try sending text, or check that the OPENAI_API_KEY is set correctly.`);
      return;
    }
  } else if ((msg.voice || msg.audio) && !OPENAI_KEY) {
    await sendMessage(chat_id, `Got a voice message but OPENAI_API_KEY isn't set — can't transcribe. Set it in /workspace/.env and restart bot.`);
    return;
  }

  // ── PDF documents → Claude reads them natively (text, tables, layout) ──
  let pdfBlock = null;
  const doc = msg.document;
  if (doc && (/application\/pdf/.test(doc.mime_type || '') || /\.pdf$/i.test(doc.file_name || ''))) {
    if ((doc.file_size || 0) > 18 * 1024 * 1024) {
      await sendMessage(chat_id, `That PDF is too big (Telegram caps bot downloads at ~20MB). Send a smaller file or a link.`);
      return;
    }
    await tg('sendChatAction', { chat_id, action: 'typing' });
    await sendMessage(chat_id, '📄 reading PDF...');
    const b64 = await downloadTelegramFileB64(doc.file_id);
    if (!b64) { await sendMessage(chat_id, `Couldn't download that PDF — try again?`); return; }
    pdfBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 }, cache_control: { type: 'ephemeral' } };
    const cap = (msg.caption || '').trim();
    msg.text = `[PDF: ${doc.file_name || 'document'}]` + (cap ? ` ${cap}` : ` Read this and tell me what matters.`);
    msg.caption = '';
  }

  // Extract usable content (text, caption, forwarded metadata). Returns
  // null for empty/media-only messages (stickers, photo without caption, etc).
  let content = extractMessageContent(msg);
  const text = content || ''; // for command parsing / passphrase check
  const isEmpty = content === null;

  let label = userLabel(chat_id);
  if (!label) {
    if (text.includes(PASSPHRASE)) {
      label = enrollUser(chat_id);
      const who = label === 'lera' ? 'Lera (marketing lead)' : label === 'alex' ? 'CEO' : 'guest';
      await sendMessage(chat_id, `Authorized as ${who}. We share one second brain — memory, ad-spy/ai-arena tools, and find history are common to both you and ${label === 'alex' ? 'Lera' : 'Alex'}. Ping me anytime, send voice notes or YouTube links, ask "what did we decide about X". Type /help for commands.`);
      return;
    }
    return; // unknown chat, no passphrase — ignore
  }

  // Empty / media-only messages (sticker, photo no caption, etc): be polite.
  if (isEmpty) {
    await sendMessage(chat_id, `Got a message with no text I can read (sticker, photo without caption, etc.). What did you want to discuss about it? I can process text, captions, voice notes, and YouTube links.`);
    return;
  }

  // ── YouTube transcript inlining ───────────────────────────────────────
  // Detects YouTube URLs in the message, fetches captions, inlines into
  // the content so Claude can summarize / discuss the video directly.
  // Caps each transcript at 6000 chars to keep token use bounded.
  const ytIds = extractYouTubeIds(content);
  if (ytIds.length > 0 && YoutubeTranscript) {
    await tg('sendChatAction', { chat_id, action: 'typing' });
    await sendMessage(chat_id, `📺 fetching transcript${ytIds.length > 1 ? `s for ${ytIds.length} videos` : ''}...`);
    for (const id of ytIds) {
      const transcript = await fetchYouTubeTranscript(id);
      if (transcript) {
        const trimmed = transcript.length > 6000 ? transcript.slice(0, 6000) + ` [... ${transcript.length - 6000} more chars truncated]` : transcript;
        content += `\n\n[YouTube transcript for video ${id}]\n${trimmed}`;
      } else {
        content += `\n\n[YouTube ${id}: transcript unavailable — captions may be disabled]`;
      }
    }
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
  if (content.length > 5 && content.length < 2000) appendJournal(`${label}: ${content.slice(0, 500)}`);

  // Shared semantic memory: store every message; recall on recall-style questions.
  if (vectorstore.enabled()) {
    vectorstore.store('user', content, label).catch(() => {});
    if (vectorstore.looksLikeRecall(text)) {
      const hits = await vectorstore.recall(content, 3, { isOwner: label === 'alex' });
      if (hits.length) content += `\n\n[Recalled from shared second-brain memory]\n` + hits.map((hh) => `- (${hh.user}) ${hh.content}`).join('\n');
    }
  }

  // Strip unpaired UTF-16 surrogates before they reach the Anthropic API.
  content = stripSurrogates(content);

  await tg('sendChatAction', { chat_id, action: 'typing' });
  const reply = await generateReply(chat_id, content, null, pdfBlock, label);
  if (reply && reply.trim()) {
    appendJournal(`bot: ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);
    await sendMessage(chat_id, reply);
  }
}

// ── Long-poll loop ──────────────────────────────────────────────────────
// Per-chat serialization: two rapid messages from the same chat must not both
// loadHistory→append→saveHistory concurrently (last writer wins, turns lost).
// Each chat gets a promise chain so its handlers run strictly in order; different
// chats still run in parallel.
const chatQueues = new Map();
function enqueue(chat_id, fn) {
  const prev = chatQueues.get(chat_id) || Promise.resolve();
  const next = prev.then(fn).catch(e => console.error('[handler]', e && e.message ? e.message : e));
  // Store the SAME promise we compare against in finally — comparing against `next`
  // (a different promise than the one stored) made the delete dead code → unbounded leak.
  const stored = next.finally(() => { if (chatQueues.get(chat_id) === stored) chatQueues.delete(chat_id); });
  chatQueues.set(chat_id, stored);
  return next;
}
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`, { timeout: 35000 });
    const data = await r.json();
    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          const cid = update.message.chat && update.message.chat.id;
          enqueue(cid, () => handleMessage(update.message));
        }
      }
    } else if (data.error_code) {
      console.error('[poll] tg error:', JSON.stringify(data).slice(0, 200));
      await new Promise(r => setTimeout(r, 10000));
    }
  } catch (err) {
    if (err.code !== 'ETIMEDOUT') console.error('[poll]', redact(err.message));
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

  'mcp-scout': `It's Monday. Generate the opening message for the MCP scout cadence. First, call list_sources(topic='mcp') to see what you're already monitoring — surface 1-2 high-quality sources you'll check ("checking @swyx, modelcontextprotocol/servers, r/ClaudeAI today"). Then ask Alex ONE planning question (what category he's hungry for, or any new account he wants you to add). For THIS message just write the opener — no actual web_search yet. Output ONLY the message text.`,

  'futureproof-scout': `It's Thursday. Generate the opener for the Futureproof intel cadence. First call list_sources(topic='futureproof') and list_sources(topic='marketing') to acknowledge what you're tracking. Then ask Alex 2-3 prep one-liners: biggest blocker, competitor to look at, what tested last week. Output ONLY the opener, ready to send.`,

  'sunday-wrap': `It's Sunday 5pm. Generate a soft weekly wrap-up message. Reference the journal entries from this past week if any. Ask: "what shipped this week?", "what's on your mind for next?", and one specific reference back to something he mentioned earlier in the week if possible. Output ONLY the message text, conversational, max 4 short sentences.`,
};

async function fireCadence(cadence) {
  if (isSnoozed()) {
    console.log(`[cadence] ${cadence.key} skipped — bot is snoozed`);
    return;
  }
  if (cadence.mode && !inMode(cadence.mode)) {
    console.log(`[cadence] ${cadence.key} skipped — mode is ${loadState().mode}, requires ${cadence.mode}`);
    return;
  }

  const users = Object.entries(loadUsers()); // [chat_id, label]
  if (!users.length) {
    console.log(`[cadence] ${cadence.key} skipped — no authorized users`);
    return;
  }
  const instructions = PROMPTS[cadence.prompt];

  // Fire to EACH user separately, addressing the opener to the right person via
  // mediationBlock(label) — otherwise the shared memory.md context makes the model
  // address the wrong person.
  for (const [chat_id, label] of users) {
    console.log(`[cadence] firing ${cadence.key} for ${label} (chat ${chat_id})`);

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
          model: CADENCE_MODEL,
          max_tokens: 400,
          system: [{ type: 'text', text: buildSystemPrompt() + mediationBlock(label), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: instructions }],
        }),
        timeout: 30000,
      });
      const data = await r.json();
      if (data.error) { console.error('[cadence] api error:', data.error); continue; }
      openerText = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n\n').trim();
      openerText = processMemoryUpdates(openerText);
    } catch (err) { console.error('[cadence]', err.message); continue; }

    if (!openerText) continue;

    // Inject into THIS user's history + send, serialized through the SAME per-chat
    // queue as live message handlers. Number(chat_id): loadUsers() keys are strings
    // but poll() enqueues numeric chat ids, and a Map treats "123" and 123 as distinct
    // keys — without the cast the cadence write races an in-flight handleMessage and
    // one clobbers the other's history (the lost-update bug the queue exists to stop).
    await enqueue(Number(chat_id), async () => {
      const history = loadHistory(chat_id);
      history.push({ role: 'assistant', content: openerText, ts: Date.now() });
      saveHistory(chat_id, history);
      appendJournal(`bot→${label} (${cadence.key}): ${openerText.slice(0, 200)}${openerText.length > 200 ? '…' : ''}`);
      try { await sendMessage(chat_id, openerText); }
      catch (err) { console.error('[cadence] send failed:', err.message); }
    });
  }
}

function startScheduler() {
  console.log(`[scheduler] cadences: ${CADENCES.length} configured`);
  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    // Fire in a 0–5 min window, not exactly minute 0: a synchronous stall (the two
    // execSync calls in loadContextSnapshot can block ~10s) or timer drift can skip
    // the single minute-0 tick entirely. The per-day fireKey dedup prevents re-firing.
    if (minute > 5) return;

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
