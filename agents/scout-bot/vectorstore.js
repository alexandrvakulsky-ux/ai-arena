'use strict';
/*
 * vectorstore.js — dependency-light semantic memory for the second-brain bot.
 * OpenAI embeddings via the REST API (node-fetch, OPENAI_API_KEY) + a JSONL store
 * + in-JS cosine recall. No native modules (deliberately not better-sqlite3) and
 * no build step — matches the bot's no-build philosophy. Shared across users;
 * every entry tagged with {user} so both Alex (CEO) and CMO (wife) recall everything.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DIR = path.join(__dirname, 'memory');
const STORE = path.join(DIR, 'vectors.jsonl');
const MODEL = 'text-embedding-3-small';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

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

// Store a memory. tags is free-form metadata; {user} attributes who said it.
async function store(role, content, user, tags = {}) {
  if (!content || !content.trim()) return false;
  const embedding = await embed(content);
  if (!embedding) return false; // no silent fake vectors
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(STORE, JSON.stringify({
      ts: new Date().toISOString(), user: user || 'unknown', role, content: content.slice(0, 4000),
      tags, embedding,
    }) + '\n');
    return true;
  } catch (e) { console.error('[vectorstore] store error:', e.message); return false; }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Recall top-k semantically similar memories. Shared store — does NOT filter by user.
async function recall(query, limit = 5) {
  if (!OPENAI_KEY || !fs.existsSync(STORE)) return [];
  const q = await embed(query);
  if (!q) return [];
  let rows = [];
  try { rows = fs.readFileSync(STORE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { console.error('[vectorstore] read error:', e.message); return []; }
  return rows
    .map((r) => ({ ts: r.ts, user: r.user, role: r.role, content: r.content, score: cosine(q, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((r) => r.score > 0.25);
}

const RECALL_RE = /what did i (say|mention|tell|decide|think|ask)|when did (i|we)|remember when|did i (say|tell|mention)|what (did|have) we (say|said|discuss|decide)|recall|last time/i;
function looksLikeRecall(text) { return RECALL_RE.test(text || ''); }

module.exports = { enabled, embed, store, recall, looksLikeRecall };
