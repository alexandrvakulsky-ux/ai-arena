---
name: sync-meta
description: Pull Futureproof's own Meta ad-campaign data via the meta-ads MCP, normalize it into /workspace/data/meta-campaigns/, and ingest tested angles into the bot's vector memory so vector_search can answer "what did we test / what worked". Use when the user says /sync-meta, "sync meta", "pull our campaign data", "what angles have we tested", or wants own-campaign performance.
---

# sync-meta — own-campaign feedback loop

Goal: turn Futureproof's live Meta ad data into (a) structured JSON on disk and
(b) recallable angle history in the scout-bot brain. This runs in a **server
Claude Code session** where the `meta-ads` MCP is authenticated (user scope).
There is NO desktop/scp bridge — everything is written locally on the server.

## Preconditions
1. meta-ads MCP must be live. Load its tools (ToolSearch `meta-ads`). If only
   `authenticate`/`complete_authentication` appear, the token is dead — run the
   auth flow (see ~/.claude memory `meta-ads-mcp-selfheal`) before continuing.
   FB rotates edge IPs; if calls fail "Unable to connect", re-run
   `/usr/local/bin/init-firewall.sh`.
2. Target accounts: only `is_queryable: true` AND `is_ads_mcp_enabled: true`
   accounts can be pulled. The main **Futureproof** account is ACTIVE but not
   yet MCP-enabled (Meta rollout) — it will start syncing automatically once
   Meta enables it; until then use **Futureproof Reserve / Boundly /
   Powerplay_2** (JorefilLimited business).

## Steps (in-session)
1. `mcp__meta-ads__ads_get_ad_accounts` → keep accounts where
   `is_queryable && is_ads_mcp_enabled`. By default sync the JorefilLimited
   (Futureproof) accounts; the user may name others.
2. For each target account, `mcp__meta-ads__ads_get_ad_entities`:
   - `level: "campaign"`, fields `["id","name","status","objective","daily_budget","lifetime_budget","start_time","stop_time"]`
   - `level: "ad"`, fields `["id","name","campaign_id","status","creative{body,title}","ad_creative"]`
   - insights `level: "ad"`, `date_preset: "last_30d"`, fields `["ad_id","campaign_id","spend","impressions","cpm","ctr","actions","clicks"]`
     (use `ads_insights_performance_trend` / the insights tool if entity-level insights are thin).
   Save each raw MCP response verbatim under `/workspace/data/meta-campaigns/_raw/`
   (`accounts.json`, `<acct>.campaigns.json`, `<acct>.ads.json`, `<acct>.insights.json`).
3. Normalize into the four canonical files (atomic: write `*.tmp`, then rename):
   - `campaigns.json`  — `[{account, id, name, status, objective, budget, start, stop}]`
   - `ads.json`        — `[{account, id, campaign_id, name, hook_text, format, angle_tag, status}]`
     (`hook_text` = creative body/title; `angle_tag` = your 2-4 word classification
     of the angle, e.g. "data-broker-exposure", "romance-scam", "fake-alert-villain")
   - `performance.json`— `[{account, ad_id, campaign_id, days, spend, impressions, cpm, ctr, conversions}]`
   - `angles-log.md`   — human log, one bullet per distinct angle:
     `- [angle_tag] "<representative hook>" — spend $X, CTR Y%, CPM $Z over N days → VERDICT (winner/test/dead)`
4. Ingest into the brain so the bot can recall it:
   `node /workspace/data/meta-campaigns/ingest-to-brain.js`
   (stores each angles-log bullet + each ad's hook into the shared vector store
   under source `meta-campaign`; idempotent — clears prior meta-campaign rows first).
5. Verify: `node -e "console.log(require('fs').readFileSync('/workspace/data/meta-campaigns/campaigns.json','utf8').slice(0,200))"`
   and a `vector_search`-style recall for a known angle.

## Notes
- Don't invent numbers — if an insight field is missing for an ad, leave it null,
  don't guess. The angles-log VERDICT is your judgment from the real spend/CTR.
- This data is shared (both Alex and Lera benefit from "what worked"), source
  `meta-campaign` is NOT owner-only.
- Daily automation (out of scope until manual proves stable): a cron running
  `claude -p "/sync-meta"` headless. Note it; don't set it up unasked.
