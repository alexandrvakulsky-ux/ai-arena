---
name: sync-meta
description: Pull Futureproof's own Meta ad-campaign performance (spend, CTR, conversions, hooks, angles) and ingest it into the bot's vector memory so vector_search answers "what did we test / what worked / best angle by spend". Use when the user says /sync-meta, "sync meta", "pull our campaign data", "what angles have we tested", "best performing hook".
---

# sync-meta — own-campaign feedback loop (Meta Graph API)

Turns Futureproof's live Meta ad data into structured JSON on disk + recallable
angle history in the scout-bot brain. Server-side, fully durable — **no MCP, no
per-session OAuth**.

## Why Graph API, not the Meta MCP
The hosted `mcp.facebook.com/ads` MCP needs an interactive `/mcp` browser auth
every session and its token dies in minutes (Desktop app can't even run `/mcp`).
We use a **System User token** instead (`META_ACCESS_TOKEN` in `/workspace/.env`,
`ads_read`, never expires) and hit `graph.facebook.com` directly. Set once, works
forever, headless, cron-able. `graph.facebook.com` is in the firewall allowlist.

## Run it
```
node /workspace/data/meta-campaigns/sync-meta.js
```
That single command does everything:
1. Lists ad accounts, then for each target (default: Futureproof + Futureproof
   Reserve; override `META_SYNC_ACCOUNTS="act_x,act_y"`) pulls campaigns, ad-level
   insights (last 30d, top spenders), and creative hooks for the spenders.
2. Writes `campaigns.json`, `ads.json`, `performance.json`, `angles-log.md`
   (atomic) — angle = derived from the campaign name; spend/CTR/conv from real
   ad-level insights.
3. Auto-runs `ingest-to-brain.js` → angle verdicts + ad hooks into the shared
   vector store (source `meta-campaign`, idempotent) so `vector_search` recalls them.

Transient Meta errors (code 1/2/4/17/341/368) auto-retry with backoff.

## After running
- `head -20 /workspace/data/meta-campaigns/angles-log.md` — spend-ranked angle verdicts.
- Bot can now answer "best data-leak angle by spend", "which hook hit highest CTR",
  "have we tested X" from its memory.

## Token refresh
System User tokens don't expire, but if calls start returning `code 190`
(invalid/expired token), regenerate in **business.facebook.com → Business
Settings → System Users → [user] → Generate token** (App with `ads_read`, expiry
Never) and replace `META_ACCESS_TOKEN` in `/workspace/.env`.

## Automation (when ready)
Add to the 30-min ingest loop or a daily cron: `node /workspace/data/meta-campaigns/sync-meta.js`.
Currently manual — note it, don't enable unasked.
