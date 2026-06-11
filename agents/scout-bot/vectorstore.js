'use strict';
/*
 * vectorstore.js — dependency-light semantic memory for the second-brain bot.
 * OpenAI embeddings via the REST API (node-fetch, OPENAI_API_KEY) + a JSONL store
 * + in-JS cosine recall. No native modules (deliberately not better-sqlite3) and
 * no build step — matches the bot's no-build philosophy. Shared across users;
 * every entry tagged with {user}. Most memories are recallable by everyone, but
 * owner-only sources (Slack DMs) are returned only when recall is called isOwner.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const DIR = path.join(__dirname, 'memory');
const STORE = path.join(DIR, 'vectors.jsonl');
const MODEL = 'text-embedding-3-small';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ── At-rest encryption (AES-256-GCM per record) ─────────────────────────
// Meeting transcripts + Slack content must not be readable if the file leaks
// (git mishap, backup, mirror). Key lives in /workspace/.env (chmod 600) —
// protects against file-level leaks, NOT a full host compromise that also
// grabs .env. Lines are "enc1:" + base64(iv[12] | gcmTag[16] | ciphertext);
// legacy plaintext JSON lines still parse (pre-migration back-compat).
const ENC_KEY = process.env.BRAIN_ENC_KEY && /^[0-9a-f]{64}$/i.test(process.env.BRAIN_ENC_KEY)
  ? Buffer.from(process.env.BRAIN_ENC_KEY, 'hex') : null;
if (!ENC_KEY) console.error('[vectorstore] BRAIN_ENC_KEY missing/invalid — storing PLAINTEXT');

function encLine(obj) {
  const json = JSON.stringify(obj);
  if (!ENC_KEY) return json;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decLine(line) {
  if (!line.startsWith('enc1:')) return JSON.parse(line); // legacy plaintext
  if (!ENC_KEY) throw new Error('encrypted record but BRAIN_ENC_KEY not set');
  const buf = Buffer.from(line.slice(5), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

function enabled() { return !!OPENAI_KEY; }

async function embed(text) {
  if (!OPENAI_KEY) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: String(text).slice(0, 8000) }),
      timeout: 20000,
    });
    const d = await r.json();
    if (!d.data || !d.data[0]) { console.error('[vectorstore] embed error:', JSON.stringify(d).slice(0, 160)); return null; }
    return d.data[0].embedding;
  } catch (e) { console.error('[vectorstore] embed exception:', e.message); return null; }
}

// Strip unpaired UTF-16 surrogates (e.g. an emoji cut in half by slicing). A lone
// surrogate makes the JSON body invalid and breaks the Anthropic API call
// ("The request body is not valid JSON: no low surrogate in string").
function clean(s) {
  return String(s == null ? '' : s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Store a memory. tags is free-form metadata; {user} attributes who said it.
async function store(role, content, user, tags = {}) {
  if (!content || !content.trim()) return false;
  const embedding = await embed(content);
  if (!embedding) return false; // no silent fake vectors
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(STORE, encLine({
      ts: new Date().toISOString(), user: user || 'unknown', role, content: clean(content.slice(0, 4000)),
      tags, embedding,
    }) + '\n', { mode: 0o600 });
    return true;
  } catch (e) { console.error('[vectorstore] store error:', e.message); return false; }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Sources visible ONLY to the owner (Slack DMs/group DMs — private to the installer).
// Channel content (source 'slack') stays shared with the team.
const OWNER_ONLY_SOURCES = new Set(['slack-dm']);

// Recall top-k semantically similar memories. Shared store, but owner-only sources
// (Slack DMs) are excluded unless opts.isOwner is true. Safe default: restricted.
async function recall(query, limit = 5, opts = {}) {
  if (!OPENAI_KEY || !fs.existsSync(STORE)) return [];
  const q = await embed(query);
  if (!q) return [];
  let rows = [];
  try { rows = fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean).map((l) => decLine(l)); }
  catch (e) { console.error('[vectorstore] read error:', e.message); return []; }
  if (!opts.isOwner) rows = rows.filter((r) => !(r.tags && OWNER_ONLY_SOURCES.has(r.tags.source)));
  return rows
    .map((r) => ({ ts: r.ts, user: r.user, role: r.role, content: clean(r.content), score: cosine(q, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((r) => r.score > 0.25);
}

const RECALL_RE = /\b(recall|remember|meeting|decided?|discuss)\b|what did (i|we)|when did (i|we)|last time|вирішил|обговор|домовил|пам'?ята|нагада|мітинг|зустріч|коли ми|що (ми|казав|було|вирішил|обговор|домовил|таке|це)|розкажи|розпов|хто так|решил|обсужда|договорил|помн|напомн|совещани|встреч|что (мы|говорил|было|решил|обсужда|такое|это)|кто так|расскажи|tell me about/i;
function looksLikeRecall(text) { return RECALL_RE.test(text || ''); }

module.exports = { enabled, embed, store, recall, looksLikeRecall };
