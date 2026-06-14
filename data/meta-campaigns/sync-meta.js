'use strict';
/*
 * sync-meta.js — pull Futureproof's own Meta ad data via the Graph API (durable
 * System User token, no per-session OAuth), normalize into this folder, then
 * ingest angle history into the bot's brain.
 *
 * Replaces the fragile mcp.facebook.com OAuth path. Token: META_ACCESS_TOKEN in
 * /workspace/.env (System User, ads_read, never expires).
 *
 *   node /workspace/data/meta-campaigns/sync-meta.js
 *   META_SYNC_ACCOUNTS="act_123,act_456" node sync-meta.js   # override targets
 *
 * Then ingest-to-brain.js runs automatically at the end.
 */
require('dotenv').config({ path: '/workspace/.env', override: true });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fetch = require('node-fetch');

const TOKEN = process.env.META_ACCESS_TOKEN;
const GV = 'v22.0';
const DIR = __dirname;
const RAW = path.join(DIR, '_raw');
// Default targets: the Futureproof-vertical accounts. Override via env.
const DEFAULT_ACCOUNTS = ['act_1304449637472685', 'act_1722596645390790']; // Futureproof, Futureproof Reserve
const ACCOUNTS = (process.env.META_SYNC_ACCOUNTS || DEFAULT_ACCOUNTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

if (!TOKEN) { console.error('[sync-meta] META_ACCESS_TOKEN missing in /workspace/.env'); process.exit(1); }

const TRANSIENT = new Set([1, 2, 4, 17, 341, 368]); // unknown/temp/rate-limit codes — retry
async function graph(pathQ, attempt = 0) {
  const sep = pathQ.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/${GV}/${pathQ}${sep}access_token=${TOKEN}`;
  let d;
  try {
    const r = await fetch(url, { timeout: 30000 });
    d = await r.json();
  } catch (e) {
    if (attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); return graph(pathQ, attempt + 1); }
    throw e;
  }
  if (d.error) {
    if (TRANSIENT.has(d.error.code) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      return graph(pathQ, attempt + 1);
    }
    throw new Error(`graph ${d.error.code}/${d.error.error_subcode || 0}: ${d.error.message}`);
  }
  return d;
}
// Follow cursor pagination, cap to maxRows so a huge account can't run away.
async function graphAll(pathQ, maxRows = 400) {
  let out = [];
  let d = await graph(pathQ);
  out = out.concat(d.data || []);
  while (d.paging && d.paging.next && out.length < maxRows) {
    const r = await fetch(d.paging.next, { timeout: 30000 });
    d = await r.json();
    if (d.error) break;
    out = out.concat(d.data || []);
  }
  return out.slice(0, maxRows);
}

function writeAtomic(file, text) {
  const tmp = path.join(DIR, file + '.tmp');
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, path.join(DIR, file));
}

// Heuristic angle tag from a campaign/ad name. Their convention is
// str_<concept>_<audience>_[vNN]_<buyer>_<date>; the concept tokens are the angle.
function angleTag(name) {
  if (!name) return 'untagged';
  let s = name.toLowerCase()
    .replace(/\[.*?\]/g, ' ')           // drop [v26] etc.
    .replace(/\b\d{1,2}june|\b\d{4}-\d\d-\d\d/g, ' ') // drop dates
    .replace(/\bstr\b|\btb\b|\bhv\b|\bcc\b|\bscale\b/g, ' '); // drop buyer/setup codes
  const toks = s.split(/[^a-z0-9+]+/).filter((t) => t && t.length > 1 && !/^v?\d+$/.test(t));
  return toks.slice(0, 3).join('-') || 'untagged';
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function conversions(actions) {
  if (!Array.isArray(actions)) return null;
  const buy = actions.find((a) => /purchase|complete_registration|lead/.test(a.action_type || ''));
  return buy ? num(buy.value) : null;
}

async function fetchHooks(adIds) {
  // Batch-fetch creative for specific ad ids (?ids=a,b,c). Returns {ad_id: {name, hook, format}}.
  const out = {};
  for (let i = 0; i < adIds.length; i += 50) {
    const chunk = adIds.slice(i, i + 50);
    let d; try { d = await graph(`?ids=${chunk.join(',')}&fields=name,effective_status,creative{body,title,object_story_spec}`); } catch { continue; }
    for (const id of Object.keys(d)) {
      const a = d[id]; const cr = (a && a.creative) || {}; const spec = cr.object_story_spec || {};
      const hook = (cr.body || cr.title || (spec.link_data && spec.link_data.message) || (spec.video_data && spec.video_data.message) || '').trim();
      out[id] = { name: a.name, hook, format: spec.video_data ? 'video' : (spec.link_data ? 'link' : ''), status: a.effective_status };
    }
  }
  return out;
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true, mode: 0o700 });
  const acctMeta = {};
  try { (await graphAll('me/adaccounts?fields=name,account_status,currency&limit=50')).forEach((a) => { acctMeta[a.id] = a.name; }); } catch (e) { console.error('[sync-meta] adaccounts list:', e.message); }

  const campaigns = [], ads = [], performance = [];

  for (const act of ACCOUNTS) {
    const acctName = acctMeta[act] || act;
    console.log(`[sync-meta] ${acctName} (${act})`);
    try {
      // 1. Campaigns — the angle lives in the campaign NAME (str_<concept>_<audience>...).
      const camps = await graphAll(`${act}/campaigns?fields=name,status,objective,daily_budget,lifetime_budget,start_time,stop_time&limit=100`, 300);
      fs.writeFileSync(path.join(RAW, `${act}.campaigns.json`), JSON.stringify(camps, null, 1));
      const campById = {};
      for (const c of camps) {
        campById[c.id] = c;
        campaigns.push({
          account: acctName, id: c.id, name: c.name, status: c.status, objective: c.objective,
          budget: num(c.daily_budget) ? num(c.daily_budget) / 100 : (num(c.lifetime_budget) ? num(c.lifetime_budget) / 100 : null),
          start: c.start_time || null, stop: c.stop_time || null,
        });
      }

      // 2. Ad-level insights = where the spend is. Drive everything off the top spenders.
      const ins = await graphAll(`${act}/insights?level=ad&fields=ad_id,campaign_id,spend,impressions,cpm,ctr,clicks,actions&date_preset=last_30d&sort=spend_descending&limit=300`, 400);
      fs.writeFileSync(path.join(RAW, `${act}.insights.json`), JSON.stringify(ins, null, 1));

      // 3. Creative hooks only for the ads that actually spent (top 150).
      const topAdIds = ins.filter((p) => num(p.spend)).slice(0, 150).map((p) => p.ad_id);
      const hooks = await fetchHooks(topAdIds);

      for (const p of ins) {
        const cname = (campById[p.campaign_id] || {}).name || '';
        performance.push({
          account: acctName, ad_id: p.ad_id, campaign_id: p.campaign_id, days: 30,
          spend: num(p.spend), impressions: num(p.impressions), cpm: num(p.cpm), ctr: num(p.ctr),
          clicks: num(p.clicks), conversions: conversions(p.actions),
        });
        const h = hooks[p.ad_id];
        if (h) ads.push({
          account: acctName, id: p.ad_id, campaign_id: p.campaign_id, name: h.name,
          hook_text: h.hook, format: h.format, angle_tag: angleTag(cname), status: h.status,
        });
      }
    } catch (e) { console.error(`[sync-meta] ${act} FAILED: ${e.message}`); }
  }

  // Group by angle_tag (derived from campaign name), summing real ad-level spend.
  const campNameById = {}; campaigns.forEach((c) => { campNameById[c.id] = c.name; });
  const adById = {}; ads.forEach((a) => { adById[a.id] = a; });
  const byAngle = {};
  for (const p of performance) {
    const tag = angleTag(campNameById[p.campaign_id] || '');
    const g = (byAngle[tag] = byAngle[tag] || { spend: 0, ctrSum: 0, ctrN: 0, conv: 0, ads: 0, sample: '' });
    g.ads++; g.spend += p.spend || 0;
    if (p.ctr != null) { g.ctrSum += p.ctr; g.ctrN++; }
    g.conv += p.conversions || 0;
    if (!g.sample && adById[p.ad_id] && adById[p.ad_id].hook_text) g.sample = adById[p.ad_id].hook_text.slice(0, 120);
  }
  const angleLines = Object.entries(byAngle)
    .sort((x, y) => y[1].spend - x[1].spend)
    .map(([tag, g]) => {
      const ctr = g.ctrN ? (g.ctrSum / g.ctrN).toFixed(2) : 'n/a';
      const verdict = g.spend > 5000 && g.ctrN && g.ctrSum / g.ctrN >= 10 ? 'WINNER (scaled)' : g.spend > 5000 ? 'SCALED' : g.spend > 500 ? 'TESTING' : 'small';
      return `- [${tag}] "${g.sample || '(no creative text)'}" — $${Math.round(g.spend)} spend, avg CTR ${ctr}%, ${g.conv || 0} conv across ${g.ads} ads → ${verdict}`;
    });

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  writeAtomic('campaigns.json', JSON.stringify(campaigns, null, 1));
  writeAtomic('ads.json', JSON.stringify(ads, null, 1));
  writeAtomic('performance.json', JSON.stringify(performance, null, 1));
  writeAtomic('angles-log.md', `# Meta own-campaign angle log (synced ${stamp} UTC)\n\nAccounts: ${ACCOUNTS.map((a) => acctMeta[a] || a).join(', ')}\nLast-30-day spend by angle (highest first):\n\n${angleLines.join('\n') || '_(no data)_'}\n`);

  console.log(`[sync-meta] wrote ${campaigns.length} campaigns, ${ads.length} ads, ${performance.length} perf rows, ${angleLines.length} angle groups`);

  // Ingest into the brain (idempotent).
  try {
    execFileSync('node', [path.join(DIR, 'ingest-to-brain.js')], { stdio: 'inherit', timeout: 180000 });
  } catch (e) { console.error('[sync-meta] ingest step failed:', e.message); }
})().catch((e) => { console.error('[sync-meta] FATAL:', e.message); process.exit(1); });
