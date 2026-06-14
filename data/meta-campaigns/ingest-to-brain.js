'use strict';
/*
 * ingest-to-brain.js — push the normalized Meta campaign data into the scout-bot
 * vector store so vector_search/recall can answer "what angles have we tested,
 * what worked". Idempotent: clears prior source:'meta-campaign' rows first.
 *
 * Run after /sync-meta has written angles-log.md + ads.json. Reuses the bot's
 * vectorstore (OpenAI embeddings + AES-256-GCM at rest) — needs OPENAI_API_KEY
 * and BRAIN_ENC_KEY from /workspace/.env.
 *
 *   node /workspace/data/meta-campaigns/ingest-to-brain.js
 */
require('dotenv').config({ path: '/workspace/.env', override: true });
const fs = require('fs');
const path = require('path');
const vectorstore = require('/workspace/agents/scout-bot/vectorstore');

const DIR = __dirname;
const SOURCE = 'meta-campaign';

function readMaybe(f) { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return null; } }
function readJson(f) { try { return JSON.parse(readMaybe(f) || 'null'); } catch (e) { console.error(`[ingest] bad JSON in ${f}: ${e.message}`); return null; } }

(async () => {
  if (!vectorstore.enabled()) { console.error('[ingest] OPENAI_API_KEY missing — cannot embed'); process.exit(1); }

  const angles = readMaybe('angles-log.md');
  const ads = readJson('ads.json') || [];
  if (!angles && !ads.length) { console.error('[ingest] nothing to ingest (no angles-log.md / ads.json)'); process.exit(1); }

  const removed = vectorstore.purgeSource(SOURCE);
  console.log(`[ingest] cleared ${removed} prior ${SOURCE} rows`);

  let n = 0;
  // One row per non-empty angles-log bullet (the verdict lines — the gold).
  if (angles) {
    for (const line of angles.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))) {
      const text = '[Meta own-campaign angle] ' + line.replace(/^- /, '');
      if (await vectorstore.store('assistant', text, 'alex', { source: SOURCE, kind: 'angle' })) n++;
    }
  }
  // One row per ad with a real hook, so "have we run X hook?" recalls it.
  for (const a of ads) {
    const hook = (a.hook_text || '').trim();
    if (!hook) continue;
    const text = `[Meta own ad · ${a.account || '?'} · ${a.angle_tag || 'untagged'} · ${a.status || '?'}] ${hook}`;
    if (await vectorstore.store('assistant', text, 'alex', { source: SOURCE, kind: 'ad', ad_id: a.id })) n++;
  }
  console.log(`[ingest] stored ${n} ${SOURCE} rows into the brain`);
})().catch((e) => { console.error('[ingest] FAILED:', e.message); process.exit(1); });
