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
const MODEL = 'claude-opus-4-8'; // chat answers — Fable 5 dropped 2026-06-11 (geo-restricted outside US)
const CADENCE_MODEL = 'claude-sonnet-4-6'; // proactive openers — cheaper than Opus, user won't notice
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
// Strip raw model scaffolding that must never reach the user. The scout cadence
// prompts tell the model to "call list_sources(...)", but the cadence API call
// passes NO tools, so the model emits fake <tool_call>/<tool_response> text into
// the reply. Belt-and-suspenders: also catch function_calls/invoke/tool_use forms.
function stripToolScaffolding(text) {
  if (!text) return '';
  return String(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(/<\/?antml:[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendMessage(chat_id, text) {
  text = stripToolScaffolding(text);
  if (!text) { console.log('[send] suppressed empty message (was only scaffolding)'); return; }
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
// Persist the most-recent voice note per chat so a failed transcription can be
// recovered later via /retranscribe — Whisper is the flaky part; the audio is
// cheap to keep. One file per chat, overwritten each time.
const VOICE_DIR = path.join(__dirname, '.voice');
try { fs.mkdirSync(VOICE_DIR, { recursive: true }); } catch {}
const voicePath = (chatId) => path.join(VOICE_DIR, `${chatId}.ogg`);

// Retry a transient-failing async op with exponential backoff. Retries only on
// network blips / 5xx / rate-limit; fails fast on permanent errors (marked
// .permanent, e.g. 400/401/413 auth/bad-request/too-large). backoff 1s/3s/8s.
const TRANSIENT_RE = /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|502|503|504|429/i;
async function withRetry(fn, { retries = 3, delays = [1000, 3000, 8000], label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (err && err.permanent) throw err;
      if (!TRANSIENT_RE.test(String(err && err.message))) throw err; // permanent → fail fast
      if (attempt === retries) break;
      const wait = delays[Math.min(attempt, delays.length - 1)];
      console.log(`[voice] ${label} retry ${attempt + 1}/${retries} after ${wait}ms (${redact(err.message)})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// POST an audio buffer to Whisper → text. Throws on failure, marking
// permanent (non-retryable) for 400/401/413 so withRetry won't spin on them.
async function whisperFromBuffer(audioBuf) {
  const form = new FormData();
  form.append('file', audioBuf, { filename: 'voice.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, ...form.getHeaders() },
    body: form,
    timeout: 60000,
  });
  if (!res.ok) {
    const err = new Error(`Whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if ([400, 401, 413].includes(res.status)) err.permanent = true;
    throw err;
  }
  const data = await res.json();
  return data.text || null;
}

async function transcribeVoice(fileId, chatId) {
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
    const audioBuf = await withRetry(async () => {
      const audioRes = await fetch(audioUrl, { timeout: 30000 });
      if (!audioRes.ok) throw new Error(`file download HTTP ${audioRes.status}`);
      return await audioRes.buffer();
    }, { label: 'download' });
    // Persist BEFORE transcribing so a Whisper failure is still recoverable.
    if (chatId != null) { try { fs.writeFileSync(voicePath(chatId), audioBuf); } catch {} }

    const text = await withRetry(() => whisperFromBuffer(audioBuf), { label: 'whisper' });
    console.log(`[voice] transcribed ${audioBuf.length}b → ${(text || '').length} chars`);
    return text;
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
// STABLE half of the system prompt: frozen instructions + curated memory. This
// is the prompt-cache prefix — it changes only when memory.md is appended (a few
// times a day), so it caches and is reused across messages. The volatile context
// (journal + live snapshot, which change every message) lives in a SEPARATE
// uncached block via buildVolatileContext() — keeping them out of here is what
// makes the cache actually hit. (Before: journal/snapshot baked in here meant the
// cached prefix differed every call → cache written ×1.25 every time, never read.)
function buildSystemStable() {
  const memory = loadMemory();
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

You have web_search — use it when you need current info, but don't over-search. If you already know the answer, just say it.

You also have READ-ONLY server tools — use them when Alex asks about server state or live data:
- query_adspy(path) — GET an ad-spy endpoint. E.g. "/health" for ad/competitor counts, "/api/sc-cost" for SC credit usage, "/api/access-stats" for visitor activity. AUDIENCE-OPPORTUNITY SCANNER — use proactively for product/market research: "/api/opportunities" = competitors' best scaling angles (by ad-longevity) + newly-discovered adjacent advertisers targeting our 55+ safety audience (staged for review); "/api/opportunities/trajectory?app_id=<storeId>&store=ios" = an app's store-rank trend + Sonar monthly revenue estimate. When Alex asks "what adjacent products are scaling / worth launching", "who's winning this audience", "how much does X make" — pull from these, don't guess.
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

// VOLATILE half: journal (grows every message) + live system snapshot. Goes in
// an UNCACHED system block AFTER the cached prefix, so its constant churn never
// invalidates the cache.
function buildVolatileContext() {
  return `

═══ LIVE CONTEXT (changes frequently — not cached) ═══
Journal (recent chronological log of what Alex told you):
${loadJournalTail(60)}

Live system snapshot:
${loadContextSnapshot()}`;
}

// Full prompt (stable + volatile) — used by the cadence path where it's a single
// one-shot call so the split doesn't help.
function buildSystemPrompt() { return buildSystemStable() + buildVolatileContext(); }

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

  // Prompt-cache the conversation-history prefix: without this, the whole
  // (up-to-20-turn) history is re-billed as uncached input every turn. Put the
  // breakpoint on the last message's last content block; tool-loop messages
  // append AFTER it as an uncached suffix (normal growing-suffix pattern), and
  // the next turn reads this prefix from cache. Same 1h TTL as tools+system so
  // the TTL-ordering rule holds. Purely additive — does not touch memory or
  // message content, only tags the last block for caching.
  if (messages.length) {
    const last = messages[messages.length - 1];
    if (typeof last.content === 'string' && last.content.trim()) {
      last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    } else if (Array.isArray(last.content) && last.content.length) {
      const i = last.content.length - 1;
      last.content[i] = { ...last.content[i], cache_control: { type: 'ephemeral', ttl: '1h' } };
    }
    // else: empty string content — leave untouched (an empty cached text block would 400)
  }

  // Agentic loop: call API, execute any tool_use blocks, feed results
  // back, repeat until Claude stops calling tools (final answer).
  let finalText = '';
  let lastText = '';
  // Build the static system + tools ONCE and mark them for prompt caching, so the big
  // system prompt + tools schema aren't re-billed at full price across tool-loop iterations
  // (or across back-to-back messages within the cache TTL). Same model, same output, ~90% off
  // the cached input tokens.
  // Prompt-cache layout: stable prefix (instructions + memory + per-user mediation)
  // gets the cache breakpoint (1h TTL — the bot's traffic is bursty with gaps);
  // volatile context (journal + snapshot) trails in an uncached block so its
  // every-message churn doesn't invalidate the cached prefix. systemOverride
  // (creative briefs) is one-shot, so it's a single cached block.
  const sysBlocks = systemOverride
    ? [{ type: 'text', text: systemOverride + mediationBlock(userLabel), cache_control: { type: 'ephemeral', ttl: '1h' } }]
    : [
        { type: 'text', text: buildSystemStable() + mediationBlock(userLabel), cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: buildVolatileContext() },
      ];
  const toolsArr = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ...BOT_TOOLS,
  ];
  // 1h TTL to MATCH the system block. Tools render before system; a longer-TTL
  // block (system 1h) must not follow a shorter-TTL one (tools 5m) or the API
  // 400s ("ttl='1h' must not come after ttl='5m'"). Same TTL = valid.
  toolsArr[toolsArr.length - 1] = { ...toolsArr[toolsArr.length - 1], cache_control: { type: 'ephemeral', ttl: '1h' } };
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
          // Creative briefs run long (10 hooks + snapshot); 3000 truncated them
          // mid-hook. 8000 gives a full reply with headroom.
          max_tokens: 8000,
          system: sysBlocks,
          messages,
          tools: toolsArr,
        }),
        timeout: 120000,
      });
      data = await r.json();
      if (data && data.usage) {
        const u = data.usage;
        console.log(`[cache] read=${u.cache_read_input_tokens || 0} write=${u.cache_creation_input_tokens || 0} uncached_in=${u.input_tokens || 0} out=${u.output_tokens || 0}`);
      }
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
          max_tokens: 4000, // long-output headroom (see above)
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
      `/retranscribe — re-run Whisper on your last voice note (if it failed)\n` +
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
  if (text === '/retranscribe') {
    const p = voicePath(chat_id);
    if (!fs.existsSync(p)) {
      await sendMessage(chat_id, `No saved voice note to re-transcribe. Send a voice message first — I keep the last one per chat.`);
      return true;
    }
    await tg('sendChatAction', { chat_id, action: 'typing' });
    await sendMessage(chat_id, '🎤 re-transcribing your last voice note…');
    try {
      const textOut = await withRetry(() => whisperFromBuffer(fs.readFileSync(p)), { label: 'whisper' });
      if (textOut && textOut.trim()) {
        await sendMessage(chat_id, `🎤 Recovered:\n\n${textOut.trim()}\n\n(Resend or reply to act on it.)`);
      } else {
        await sendMessage(chat_id, `Re-transcription came back empty — the audio may be silent or corrupt.`);
      }
    } catch (e) {
      await sendMessage(chat_id, `Re-transcription still failing: ${redact(e.message)}. Try again in a moment.`);
    }
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
    const transcript = await transcribeVoice(fileId, chat_id);
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

  // ── Photos → Claude vision + swipe-file ─────────────────────────────────
  // Forwarded ad screenshots are the swipe-file workflow: Claude breaks down
  // the hook mechanics and the analysis is stored to vector memory (source:
  // 'swipe') so "what's in our swipe file about guilt angles?" works later.
  let imageBlock = null;
  if (!pdfBlock && Array.isArray(msg.photo) && msg.photo.length) {
    const ph = msg.photo[msg.photo.length - 1]; // sizes are ascending — take largest
    await tg('sendChatAction', { chat_id, action: 'typing' });
    const b64 = await downloadTelegramFileB64(ph.file_id);
    if (b64) {
      imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
      const cap = (msg.caption || '').trim();
      msg.text = cap || '[Screenshot received — if this is an ad creative, do a swipe-file breakdown.]';
      msg.caption = '';
    } else {
      await sendMessage(chat_id, `Couldn't download that photo — try again?`);
      return;
    }
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
    await sendMessage(chat_id, `Got a message with no content I can read (sticker, contact card, etc.). I can process text, captions, voice notes, photos/ad screenshots, PDFs and YouTube links.`);
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
  // Creative questions get Lera's locked style + Genesis patterns appended to
  // the system prompt; unrelated chats skip it (token hygiene). Images always
  // get the skill + swipe instructions — most forwarded images ARE ad creatives.
  const SWIPE_SPEC = imageBlock ? `

═══ IMAGE / SWIPE-FILE PROTOCOL ═══
If the attached image is an ad creative (or social post used as an ad): start your reply with the literal tag "SWIPE:" then break it down — (1) hook mechanic: format, emotional trigger, social mechanic (tag-bait / debate-bait / voyeur); (2) why it works or doesn't vs our locked style; (3) 1-2 adaptations bridged to the data-leak topic in Lera's locked POV style. Keep it tight. If the image is NOT an ad, skip the tag and just answer normally.` : '';
  const sysOv = (CREATIVE_RE.test(content) || imageBlock) ? buildSystemPrompt() + creativeSkillBlock() + SWIPE_SPEC : null;
  const reply = await generateReply(chat_id, content, sysOv, pdfBlock || imageBlock, label);
  if (reply && reply.trim()) {
    appendJournal(`bot: ${reply.slice(0, 200)}${reply.length > 200 ? '…' : ''}`);
    // Swipe-file: persist ad breakdowns to shared vector memory for later recall.
    if (imageBlock && /^SWIPE:/m.test(reply) && vectorstore.enabled()) {
      vectorstore.store('assistant', reply.slice(0, 3500), label, { source: 'swipe' }).catch(() => {});
    }
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
let _pollFails = 0;            // consecutive transient failures
let _lastPollOk = Date.now();  // last healthy getUpdates
const POLL_WEDGE_MS = 2 * 60 * 1000;
// Exponential backoff with jitter, capped at 30s, scaled by consecutive fails.
async function backoffPoll() {
  const base = Math.min(30000, 500 * Math.pow(2, Math.min(_pollFails, 6)));
  await new Promise(r => setTimeout(r, base + Math.floor(Math.random() * 500)));
}
async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30`, { timeout: 35000 });
    const data = await r.json();
    if (data.ok && Array.isArray(data.result)) {
      _pollFails = 0; _lastPollOk = Date.now();
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          const cid = update.message.chat && update.message.chat.id;
          enqueue(cid, () => handleMessage(update.message));
        }
      }
    } else if (data.error_code) {
      // Real API/config errors (409 conflict, 401 bad token) — always surface.
      console.error('[poll] tg error:', JSON.stringify(data).slice(0, 200));
      _pollFails++;
      await backoffPoll();
      return setImmediate(poll);
    }
  } catch (err) {
    _pollFails++;
    // Transient long-poll drops (ECONNRESET/502/timeout) are normal for
    // getUpdates. Stay quiet except for the first blip or a genuine wedge
    // (no successful poll in >2min = something actually stuck).
    const wedged = Date.now() - _lastPollOk > POLL_WEDGE_MS;
    if (_pollFails === 1 || wedged) {
      console.error(`[poll] ${wedged ? 'WEDGED >2min — ' : 'transient (quieted) — '}${redact(err.message)} (fail #${_pollFails})`);
    }
    await backoffPoll();
    return setImmediate(poll);
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
  // Lera's daily creative brief (act_mq8a2xpk_a18d + amendments _e2lw, _zjii).
  // days array = Mon-Sat; 06:00 UTC = 09:00 Kyiv (summer). handler routes it to
  // the agentic fireCreativeTrends instead of the plain single-call cadence.
  { days: [1, 2, 3, 4, 5, 6], hour: 6, key: 'creative-trends', handler: 'creative-trends' },
  // Tue 07:00 UTC (10:00 Kyiv) — an hour after the daily brief so they don't stack
  { day: 2, hour: 7, key: 'reddit-stories', handler: 'reddit-stories' },
  // Mondays 10:00 UTC — handler self-gates to the FIRST Monday of the month
  { day: 1, hour: 10, key: 'angle-whitespace', handler: 'angle-whitespace' },
  // Daily 08:00 UTC — proactive prompt-cache/cost drift check (deterministic,
  // only messages Alex if the hit ratio is low). Catches it before the bill does.
  { days: [0, 1, 2, 3, 4, 5, 6], hour: 8, key: 'cost-pulse', handler: 'cost-pulse' },
];

const PROMPTS = {
  'daily-checkin': `Generate a SHORT daily check-in question to Alex. Reference yesterday's journal entries if relevant. ONE focused question, max 2 sentences before it. Examples of good openers:\n- "Yesterday you said X — did it ship?"\n- "Two days back you flagged the funnel issue. Where's that now?"\n- "What's the top thing today?"\n\nMake it specific to context if you have it, generic if not. Output ONLY the message text — no preamble, no markdown, ready to send to Telegram as-is.`,

  'mcp-scout': `It's Monday. Write the opening message for the MCP scout cadence. Mention 1-2 high-quality sources you regularly check (e.g. "checking @swyx, modelcontextprotocol/servers, r/ClaudeAI today"). Then ask Alex ONE planning question (what category he's hungry for, or any new account he wants you to add). Do NOT call any tools — this is just the opener text. Output ONLY the message text, ready to send to Telegram.`,

  'futureproof-scout': `It's Thursday. Write the opener for the Futureproof intel cadence. Briefly acknowledge what you track (Futureproof + marketing sources). Then ask Alex 2-3 prep one-liners: biggest blocker, competitor to look at, what tested last week. Do NOT call any tools — this is just the opener text. Output ONLY the opener, ready to send.`,

  'sunday-wrap': `It's Sunday 5pm. Generate a soft weekly wrap-up message. Reference the journal entries from this past week if any. Ask: "what shipped this week?", "what's on your mind for next?", and one specific reference back to something he mentioned earlier in the week if possible. Output ONLY the message text, conversational, max 4 short sentences.`,
};

// ── Lera's daily creative-trends brief ──────────────────────────────────
// Unlike plain cadences (one cheap Sonnet call), this needs the agentic tool
// loop: query_adspy for fresh competitor creatives + web_search for viral
// trends, then 10 trend-anchored hooks in Lera's locked style. Spec from
// pending actions act_mq8a2xpk_a18d + amendments act_mq8a56rb_e2lw (broad
// 25-65+ audience w/ hypothesis notes) + act_mq8a7jg3_zjii (every hook must
// derive from an observed trend and cite it inline).
const SENT_HOOKS_FILE = path.join(BOT_DIR, 'sent-hooks.json');
// Creative-hooks skill (act_mq96hyix_6636): Lera's locked style + Genesis patterns
// in one file instead of fragmented memory lines. Appended to the system prompt
// ONLY for ads/creative-related messages (and always for the creative-trends
// cadence) to keep tokens out of unrelated conversations.
const CREATIVE_SKILL_FILE = path.join(BOT_DIR, 'skills', 'creative-hooks.md');
function creativeSkillBlock() {
  try { return '\n\n═══ SKILL: CREATIVE HOOKS ═══\n' + fs.readFileSync(CREATIVE_SKILL_FILE, 'utf8'); }
  catch { return ''; }
}
// EN + UA/RU roots — Lera writes in Ukrainian/Russian. No \b around Cyrillic
// (word boundaries don't work with non-ASCII).
const CREATIVE_RE = /\b(ads?|creatives?|hooks?|campaign|trend|angle)\b|кре(о|атив)|хук|реклам|тренд|оголошен|заголовк|креатив/i;
const CREATIVE_TRENDS_SPEC = `

═══ TASK: DAILY CREATIVE-TRENDS BRIEF FOR LERA ═══
Generate Lera's daily creative brief for Futureproof (data-leak / email-leak / accounts-leak topic). Use your tools — do not skip steps:

STEP 1 — Competitor trend scan: call query_adspy('/api/ads/new?nofetch=1&compact=1&limit=80') (and '/api/brief/today' if it returns data). Each ad is compact: c=competitor, g=group, h=hook text, f=format, d=days_running, a=active(1/0); stats.per_competitor/per_group give counts. Look at fresh ads across ALL tracked competitors — Digital Security (Cloaked, Guardio, Aura, Norton, Incogni...) AND Genesis-vertical brands (incl. Deepstash). Identify 2-4 recurring patterns: hook formats (POV/confession/listicle/UGC), themes, visual mechanics, emotional angles. Note which competitor and roughly how many ads share each pattern.

STEP 2 — Pop/viral trend scan: web_search for current viral trends from the last 7 days (meme formats, TikTok/IG formats, big pop-culture or news moments). Keep ONLY trends that can be credibly bridged to the data-leak topic.

MANDATORY BRIDGING RULE (Lera, act_mq8dzzm5_pf2h): naming a trend without bridged hook examples is NOT allowed. For EVERY pop-culture trend cited in the snapshot, include 2-3 ready-to-shoot hook/headline examples bridging it to the data-leak/email-leak/account-leak angle, in Lera's locked dark-POV confession style, each with its one-line audience-skew hypothesis. Competitor-derived patterns follow the same rule: pattern → 2-3 bridged hooks. The 10 daily hooks may be drawn from these bridged examples.

STEP 3 — Write EXACTLY 10 hooks/POVs in Lera's locked style (dark/provocative honest-leak confession + POV formats — her creative direction is in your memory). Broad 25-65+ audience; do NOT split into demographic segments. EVERY hook must: (a) cite its trend source inline — "[from: Incogni 'price of your data' series]" or "[from: <meme/format name>]"; (b) end with a one-line hypothesis about expected audience skew — "hypothesis: meme-native, skews 25-40" / "hypothesis: family-protection angle, strongest 50+". Mix ≈5-6 competitor-derived / ≈4-5 pop-trend-derived (flex if one source is dry today).

STEP 4 — Do NOT repeat or closely paraphrase any previously sent hook (list below), and avoid re-flagging the same competitor pattern more than 2 days running.

OUTPUT — one compact Telegram message, no walls of text:
• Trend snapshot: 3-5 bullets — each bullet = trend/pattern + its 2-3 bridged hook examples (never a bare trend name)
• Then the 10 numbered hooks (1. … 10.), each with its [from: …] tag + hypothesis line.`;

function loadSentHooks() {
  try { return JSON.parse(fs.readFileSync(SENT_HOOKS_FILE, 'utf8')); } catch { return []; }
}
function appendSentHooks(lines) {
  if (!lines.length) return;
  const all = loadSentHooks().concat(lines);
  try { fs.writeFileSync(SENT_HOOKS_FILE, JSON.stringify(all.slice(-400), null, 2)); }
  catch (e) { console.error('[creative-trends] sent-hooks save failed:', e.message); }
}

// Shared runner for Lera's agentic creative briefs (creative-trends, reddit
// stories, angle whitespace). Builds spec + prior-hooks dedup, serializes
// through the per-chat queue, journals, extracts numbered hooks into the
// shared sent-hooks.json pool, sends.
async function fireLeraBrief(key, spec, opener) {
  const entry = Object.entries(loadUsers()).find(([, label]) => label === 'lera');
  if (!entry) { console.log(`[${key}] skipped — Lera not enrolled`); return; }
  const [chat_id] = entry;
  console.log(`[${key}] firing for lera (chat ${chat_id})`);

  const prior = loadSentHooks().slice(-60);
  const fullSpec = spec +
    `\n\nPREVIOUSLY SENT HOOKS (do not repeat or closely paraphrase):\n` +
    (prior.length ? prior.map(h => `- ${h}`).join('\n') : '(none yet — first run)');

  // Serialize through the same per-chat queue as live handlers — generateReply
  // does loadHistory→save and must not race an in-flight message from Lera.
  await enqueue(Number(chat_id), async () => {
    const reply = await generateReply(
      chat_id,
      opener,
      buildSystemPrompt() + creativeSkillBlock() + fullSpec,
      null,
      'lera'
    );
    if (!reply || !reply.trim()) { console.log(`[${key}] empty reply — nothing sent`); return; }
    appendJournal(`bot→lera (${key}): ${reply.slice(0, 200)}…`);
    const hookLines = reply.split('\n').map(l => l.trim()).filter(l => /^\d{1,2}[.)]\s/.test(l));
    appendSentHooks(hookLines);
    try { await sendMessage(chat_id, reply); }
    catch (err) { console.error(`[${key}] send failed:`, err.message); }
  });
}

async function fireCreativeTrends() {
  return fireLeraBrief('creative-trends', CREATIVE_TRENDS_SPEC, 'Generate my daily creative-trends brief.');
}

// Weekly Reddit horror-story miner: real victims' stories in the audience's own
// words → POV confession material. reddit.com is already in the egress allowlist.
const REDDIT_STORIES_SPEC = `

═══ TASK: WEEKLY REDDIT STORY MINE FOR LERA ═══
Mine real data-leak / scam victim stories from Reddit and turn them into ad material. Steps:

STEP 1 — reddit_fetch(subreddit) for each of: Scams, IdentityTheft, privacy (top of the week). Pick the 5-8 most emotionally charged self-post STORIES (not advice threads) by title + selftext preview + comment count.
STEP 2 — reddit_fetch(permalink) on the 3-4 strongest stories to read the full post + top comments. Capture the victims' OWN phrasing — exact words carry the emotion. (Do NOT use firecrawl for reddit — it rejects the domain.)
STEP 3 — Distill 4-5 recurring STORY ARCHETYPES (who + what happened + emotional core + 1 short real-language quote fragment each).
STEP 4 — Write EXACTLY 8 hooks/POVs in Lera's locked style, each derived from an archetype, tagged [from: r/Scams — <archetype>], each ending with a one-line audience-skew hypothesis. Broad 25-65+. Meta-safe wording per the skill.

OUTPUT — one compact Telegram message:
• 4-5 archetype bullets (story core + real quote fragment)
• Then the 8 numbered hooks (1. … 8.).`;

async function fireRedditStories() {
  return fireLeraBrief('reddit-stories', REDDIT_STORIES_SPEC, 'Generate my weekly Reddit story-mine brief.');
}

// Monthly white-space angle matrix: where competitors crowd vs which
// emotion×mechanic cells nobody tests. Fires on the FIRST Monday only —
// the weekly scheduler grid has no day-of-month, so the handler self-gates.
const ANGLE_WHITESPACE_SPEC = `

═══ TASK: MONTHLY ANGLE WHITE-SPACE MATRIX FOR LERA ═══
Map the competitive angle landscape and find UNTESTED territory. Steps:

STEP 1 — query_adspy('/api/ads?nofetch=1&compact=1&limit=80&sort=impressions') and query_adspy('/api/ads/new?nofetch=1&compact=1&limit=80'). Each ad is compact: c=competitor, g=group, h=hook text, f=format, d=days_running, a=active(1/0); stats.per_competitor/per_group give per-brand counts for the matrix.
STEP 2 — Build a matrix: EMOTION (fear / shame / curiosity / guilt / humor / hope / anger / nostalgia) × MECHANIC (POV confession / tag-a-friend / moral-debate bait / voyeur visual / listicle / UGC testimonial / fake-alert villain / data-shock stat). For each cell note which competitors run it and how heavily (ad counts, days running).
STEP 3 — Identify: (a) 3-4 SATURATED cells (don't fight there without a twist), (b) 4-5 EMPTY or near-empty cells = white space.
STEP 4 — For each white-space cell: one-line why it's plausibly untested (hard to pass review? hard to produce? genuinely bad?) + 1 example hook in Lera's locked style bridged to the data-leak topic, with audience-skew hypothesis.

OUTPUT — one compact Telegram message: the matrix summary (saturated vs empty), then numbered white-space opportunities (1. … 5.) each with its example hook.`;

async function fireAngleWhitespace() {
  if (new Date().getUTCDate() > 7) { console.log('[angle-whitespace] skipped — not the first Monday'); return; }
  return fireLeraBrief('angle-whitespace', ANGLE_WHITESPACE_SPEC, 'Generate my monthly angle white-space analysis.');
}

// Proactive cost monitor — catches prompt-cache drift before Anthropic's email
// does. Deterministic (no model call): parses recent [cache] usage logs; if the
// cache hit ratio is low despite real volume, pings Alex with the numbers.
function fireCostPulse() {
  let lines;
  try { lines = fs.readFileSync('/workspace/scout-bot.log', 'utf8').split('\n'); }
  catch { return; }
  const re = /\[cache\] read=(\d+) write=(\d+) uncached_in=(\d+) out=(\d+)/;
  let read = 0, write = 0, unc = 0, n = 0;
  for (const l of lines.slice(-3000)) { // recent window
    const m = l.match(re);
    if (m) { read += +m[1]; write += +m[2]; unc += +m[3]; n++; }
  }
  const cacheableIn = read + write + unc;
  if (n < 10 || cacheableIn < 50000) { console.log(`[cost-pulse] n=${n} cacheableIn=${cacheableIn} — too little data, skip`); return; }
  const ratio = read / cacheableIn;
  console.log(`[cost-pulse] calls=${n} hit_ratio=${(ratio * 100).toFixed(0)}% read=${read} write=${write} uncached=${unc}`);
  if (ratio < 0.30) {
    const owner = Object.entries(loadUsers()).find(([, l]) => l === 'alex');
    if (owner) sendMessage(owner[0], `⚠️ Cost pulse: prompt-cache hit ratio dropped to ${(ratio * 100).toFixed(0)}% over the last ${n} calls (read ${(read / 1000).toFixed(0)}k / write ${(write / 1000).toFixed(0)}k / uncached ${(unc / 1000).toFixed(0)}k tokens). Something may be invalidating the cache prefix — worth a look before the spend climbs.`).catch(() => {});
  }
}

async function fireCadence(cadence) {
  if (cadence.handler === 'creative-trends') return fireCreativeTrends();
  if (cadence.handler === 'reddit-stories') return fireRedditStories();
  if (cadence.handler === 'angle-whitespace') return fireAngleWhitespace();
  if (cadence.handler === 'cost-pulse') return fireCostPulse();
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
      const dayMatch = Array.isArray(c.days) ? c.days.includes(day) : c.day === day;
      if (!dayMatch || c.hour !== hour) continue;
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
// One-shot manual cadence trigger for testing: FIRE_NOW=<cadence-key> fires that
// cadence ~5s after boot in THIS instance (never start a second process — two
// long-pollers on one Telegram token fight over getUpdates).
if (process.env.FIRE_NOW) {
  const c = CADENCES.find(x => x.key === process.env.FIRE_NOW);
  if (c) setTimeout(() => fireCadence(c).catch(e => console.error('[fire-now]', e.message)), 5000);
  else console.error(`[fire-now] unknown cadence key: ${process.env.FIRE_NOW}`);
}
