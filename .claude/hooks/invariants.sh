#!/bin/bash
# Stop-hook regression guard. Each invariant is one grep. Exit 2 blocks Claude
# from claiming done until the regression is fixed.
#
# HOW TO ADD NEW INVARIANTS:
# Each time a bug recurs, add one check() line naming the file + pattern that
# proves the fix is still in place. The goal: the same bug cannot silently
# come back.
#
# Events: runs on every Stop (after Claude finishes a response).
# Output format: stderr message is fed back into Claude's next turn as context.

set +e  # don't exit on first failure — collect all

FAILURES=()

check() {
  local name="$1" file="$2" pattern="$3" reason="$4"
  if [ ! -f "$file" ]; then return 0; fi  # file missing — skip (may not exist in all projects)
  if ! grep -qE "$pattern" "$file" 2>/dev/null; then
    FAILURES+=("❌ $name
   File: $file
   Reason: $reason
   Pattern expected: $pattern")
  fi
}

# Check_not: invariant that a pattern must NOT appear (regression if it does)
check_not() {
  local name="$1" file="$2" pattern="$3" reason="$4"
  if [ ! -f "$file" ]; then return 0; fi
  if grep -qE "$pattern" "$file" 2>/dev/null; then
    FAILURES+=("❌ $name
   File: $file
   Reason: $reason
   Forbidden pattern found: $pattern")
  fi
}

# ── Ad Spy invariants (deployed at /srv/ad-spy) ─────────────────────────────

check "adspy:every-ad-card-clickable-to-fb" \
  "/srv/ad-spy/public/index.html" \
  "click-overlay\"[^>]*href=\"\\\$\\{adLibUrl\\}\"" \
  "Every ad card image area must be clickable -> opens FB Ad Library. Now implemented as an <a class=\"click-overlay\"> anchor (P0.4 keyboard-accessible). Guarantees users can always view the original ad even if Puppeteer hasn't detected format yet. Structural fix for recurring 'no play button' bug (2026-04-22)."

check "adspy:video-play-btn-when-playable" \
  "/srv/ad-spy/public/index.html" \
  "canPlayInline \? .*play-btn|canPlayInline \? \`<button" \
  "Inline play button must render whenever ad has a cached video URL (canPlayInline=has_video). Previously required ad_format='video' too, but Puppeteer lags in writing meta.json so 46 of 47 videos lost their button silently. has_video alone is the source of truth (2026-04-24)."

check_not "adspy:play-btn-not-format-gated" \
  "/srv/ad-spy/public/index.html" \
  "isVideoFormat && canPlayInline \? " \
  "Play button render MUST NOT be gated on ad_format==='video' alongside has_video. ad_format is often 'image' for fresh ads even when video URL is captured. Use canPlayInline alone. Recurring bug since 2026-04-17; this guard blocks its return (2026-04-24)."

check "adspy:video-index-populated-on-sc-fetch" \
  "/srv/ad-spy/server.js" \
  "videoIdxDirty|backfillVideoIndex" \
  "When SC fetch captures _video_hd_url/_video_sd_url on an ad, it MUST also write to _video_urls.json. Otherwise has_video=true in API response but /api/video-proxy returns 404 = play button shows but video doesn't play (2026-04-24 bug)."

check "adspy:video-pause-on-scroll" \
  "/srv/ad-spy/public/index.html" \
  "intersectionRatio < 0\\.5 && !vid\\.paused" \
  "Inline video player must pause when scrolled out of view (>50% off-screen). Otherwise multiple background videos play simultaneously as user scrolls, wasting bandwidth + browser resources (2026-04-25)."

check "adspy:sanity-check-script" \
  "/srv/ad-spy/scripts/sanity-check.js" \
  "function check\\(comp\\)|deepChecks" \
  "Cache-reasonability autotest must exist. Runs on Stop hook (free, cache-only) and on demand with --deep (video-proxy verify + FB cross-check). Catches dead page_ids, stale data, broken video proxy before user notices (2026-04-25)."

check "adspy:ad-contract-decouples-fetch-render" \
  "/srv/ad-spy/lib/ad-contract.js" \
  "RENDER_FIELDS|toRenderAd|validateBatch" \
  "Ad contract module MUST exist. It's the single boundary between fetch and render — frontend reads only contract fields, fetch sources can change freely. Without this, every fetch refactor risks breaking renderer (recurring 'video button broke' class of bug). See lib/ad-contract.js header for the rule (2026-04-26)."

check "adspy:adForList-uses-contract" \
  "/srv/ad-spy/server.js" \
  "toRenderAd|require\\('./lib/ad-contract'\\)" \
  "adForList serializer must delegate to lib/ad-contract.toRenderAd. Without this, fetch internals leak into API responses and frontend (re-couples render to fetch internals)."

check "adspy:cache-write-enforces-min-fields" \
  "/srv/ad-spy/server.js" \
  "CACHE_MIN_FIELDS|cache-enforce" \
  "saveCompCache must validate ads against CACHE_MIN_FIELDS (id, page_id, _competitor) at write time. Without write-time enforcement, a buggy fetch source poisons the cache silently and only surfaces at render — opposite of the contract's intent (2026-04-26)."

check "adspy:adIndex-stays-in-sync" \
  "/srv/ad-spy/server.js" \
  "rebuildAdIndex\\(\\)" \
  "rebuildAggregateCache must call rebuildAdIndex so /api/preview can find newly-fetched ads' _images URLs. Without this, the by-id lookup goes stale and on-demand CDN fetch returns 404 even though CDN URL is valid (stuck-spinner bug 2026-04-26)."

check "adspy:frontend-uses-contract-urls" \
  "/srv/ad-spy/public/index.html" \
  "ad\\.image_proxy_url|ad\\.video_proxy_url" \
  "Frontend must use ad.image_proxy_url / ad.video_proxy_url from the contract, not hardcoded paths. Falls back to /api/preview/.../creative if unset, but the canonical source is the contract field. Decouples URL structure from frontend (2026-04-26)."

check "adspy:sc-deep-pagination-cap" \
  "/srv/ad-spy/server.js" \
  "MAX_SC_PAGES_PER_PAGEID = ([0-9]{2,})" \
  "SC pagination cap MUST be ≥50 (we use 100). Old 25-page cap missed 1100+ ads on Cloaked, 500+ on Guardio because high-volume competitors paginate way past 25 pages on SC. Cost guard is in the constant comment header (2026-04-26)."

check "adspy:sc-refetch-interval-le-4h" \
  "/srv/ad-spy/server.js" \
  "SC_REFETCH_INTERVAL = [1-4] \* 60 \* 60 \* 1000" \
  "SC_REFETCH_INTERVAL must be <= 4h. 24h caused data loss: SC-sourced ads got wiped on cache rebuild (bug fixed 2026-04-17). NOTE: SC_REFETCH_INTERVAL is a tombstone constant; the active knob is COMP_TTL_MS — see adspy:comp-ttl-le-8h"

# 2026-05-12 — Cap the active per-comp cache TTL. The architectural fix from
# 2026-04-17 (per-competitor caching with mergeFreshWithPrev) means the
# original 24h-data-wipe bug can't recur. But an inflated TTL still erodes
# data freshness — the daily brief and "last 24h" view assume cache is at
# most ~half a day stale. 8h is the current balance between cost ($) and
# freshness; do not push past without explicit conversation about both.
check "adspy:comp-ttl-le-8h" \
  "/srv/ad-spy/server.js" \
  "COMP_TTL_MS = [1-8] \* 60 \* 60 \* 1000" \
  "COMP_TTL_MS must be <= 8h. Higher values silently age the brief's '24h delta' view + risk the '[adspy] is showing yesterday's data' regression. If a future change needs longer TTL, also update the brief's freshness assumptions (2026-05-12)"

check "adspy:puppeteer-date-normalization" \
  "/srv/ad-spy/scrape-ad-library.js" \
  "function normDate" \
  "Puppeteer scraper must normalize Unix timestamps to ISO dates. Without this, Malwarebytes dates were raw seconds and date filter silently failed (bug fixed 2026-04-17)"

check "adspy:extraction-prioritizes-fresh-ads" \
  "/srv/ad-spy/server.js" \
  "fresh <3d prioritized first" \
  "Image/video extraction must prioritize new ads (<3 days) before falling back to score-based order. Otherwise brand-new ads never get screenshots (bug fixed 2026-04-17)"

check "adspy:video-url-capture-in-puppeteer" \
  "/srv/ad-spy/extract-previews.js" \
  "videoUrls\.push|video/|\.mp4" \
  "Puppeteer preview extractor must capture mp4 / video responses, or play buttons will open blank players (bug fixed 2026-04-17)"

check "adspy:images-use-data-src-lazy" \
  "/srv/ad-spy/public/index.html" \
  "data-src=\"\\\$\\{ad\\.image_proxy_url|data-src=\"/api/preview" \
  "Card images must use data-src (not src=) so IntersectionObserver controls loading. URL can be ad.image_proxy_url (contract) or /api/preview/{id}/creative (fallback). Without data-src, every page open hits server with 50 parallel image requests (bug fixed 2026-04-17, contract version 2026-04-26)"

check_not "adspy:no-eager-image-loading" \
  "/srv/ad-spy/public/index.html" \
  "_isFirstPage \? 'src' : 'data-src'" \
  "Must not revert to eager-loading first page images — that was the 'slow page open' bug"

check "adspy:idle-mode-startup" \
  "/srv/ad-spy/server.js" \
  "Idle mode|isActivelyUsed|markUserActivity|idle = \\\$0" \
  "Server must not auto-run Puppeteer / SC refresh on startup when cache exists. Wait for first user activity (token-burn fix 2026-04-17)"

check_not "adspy:no-setInterval-money-burner" \
  "/srv/ad-spy/server.js" \
  "setInterval\(" \
  "setInterval is forbidden in server.js — it would call paid APIs (SC, Claude) on a timer regardless of user activity, breaking the 'idle = \$0' rule. Use user-triggered logic instead (cost rule 2026-04-22)"

check_not "adspy:no-page-screenshot-fallback" \
  "/srv/ad-spy/extract-previews.js" \
  "page\.screenshot\(" \
  "Do not save page.screenshot as creative.jpg — it captures the Facebook Ad Library UI chrome (Finland dropdown, search filters, empty content) which users see as broken previews. Leave creative.jpg missing so /api/preview returns 404 and frontend shows 'View on Facebook' fallback (UX fix 2026-04-22)"

check "adspy:paid-audit-killswitch" \
  "/srv/ad-spy/server.js" \
  "AD_SPY_DISABLE_PAID_AUDITS" \
  "Daily audits ($~1/day) must have a kill-switch env var. Set AD_SPY_DISABLE_PAID_AUDITS=1 to disable when running cheap (cost rule 2026-04-22)"

check "adspy:fetchAdsForPage-has-hard-timeout" \
  "/srv/ad-spy/server.js" \
  "FETCH_PAGE_BUDGET_MS|deadline = Date\.now\(\)" \
  "fetchAdsForPage must have a hard total-time budget. Without it, slow Meta API could hang a single page_id for 25*30s=12 min, stalling background refresh (hang fixed 2026-04-22)"

check "adspy:preserve-prev-cache-on-refresh" \
  "/srv/ad-spy/server.js" \
  "preserved.*ads from previous cache|cache-merge" \
  "_fetchAllAdsFresh must merge prev cache entries not re-fetched this cycle. Without this, capped pagination or partial failures drop historical ads (data-preservation fix 2026-04-22)"

check "adspy:rollback-bad-refreshes-per-competitor" \
  "/srv/ad-spy/server.js" \
  "comp-protect|cache-protect" \
  "When a refresh returns <20% of prev cache count for a competitor, system must roll back to prev data for that competitor. Without this, a bad refresh silently destroys historical data (rate-limit resilience fix 2026-04-22)"

check "adspy:per-competitor-cache-architecture" \
  "/srv/ad-spy/server.js" \
  "COMP_CACHE_DIR|getCompetitorAds|loadCompCache" \
  "Per-competitor cache architecture must be in place. Each competitor has its own .cache/comp/{slug}.json file with independent 4h TTL. Replaces the mega-refresh that hung on Meta API rate limits and corrupted the whole dataset when any one competitor failed (architecture rewrite 2026-04-22)"

check "adspy:disk-only-sidebar-counts" \
  "/srv/ad-spy/server.js" \
  "loadAllCompCachesFromDisk" \
  "Sidebar per-competitor/per-group counts must be computed from disk-only reads, never triggering SC fetches. Otherwise viewing sidebar counts would fetch every competitor, defeating the lazy-fetch purpose (perf rule 2026-04-22)"

check "adspy:per-page-id-merge" \
  "/srv/ad-spy/server.js" \
  "mergeFreshWithPrev" \
  "When a competitor's fresh fetch is missing any page_id (SC returned empty), merge in prev cache entries for that page_id. Without this, Nebula loses 3/5 page_ids silently each refresh (coverage fix 2026-04-22)"

check "adspy:delay-between-page-ids" \
  "/srv/ad-spy/server.js" \
  "back-to-back requests|between page_ids" \
  "Must have a delay between SC calls for different page_ids within one competitor. Back-to-back requests return empty. Verified Nebula goes 3/5 -> 5/5 with 1.5s delay (2026-04-22)"

check "adspy:applyLatestMeta-defined" \
  "/srv/ad-spy/server.js" \
  "function applyLatestMeta" \
  "Response-time enrichment helper must exist. Refreshes ad.has_video + ad.ad_format from their sources of truth (_video_urls.json, meta.json) because cache entries are created before Puppeteer post-processing. Single helper enforces the same update logic across all endpoints (universal fix 2026-04-22)"

# Check: every adForList caller must be preceded by applyLatestMeta.
# Implementation: count adForList call sites vs applyLatestMeta call sites in
# the same file. Must be >=1 applyLatestMeta for each unique call-site region.
# Simpler: require at least 2 applyLatestMeta calls (one per endpoint). New
# endpoints adding adForList must also add applyLatestMeta or this fails.
_adforlist_calls=$(grep -c "\.map(adForList)" /srv/ad-spy/server.js 2>/dev/null || echo 0)
# Count call sites only, not the function definition
_applymeta_calls=$(grep -c "^\s*applyLatestMeta(" /srv/ad-spy/server.js 2>/dev/null || echo 0)
if [ "$_adforlist_calls" -gt 0 ] && [ "$_applymeta_calls" -lt "$_adforlist_calls" ]; then
  FAILURES+=("❌ adspy:applyLatestMeta-called-for-every-adForList
   File: /srv/ad-spy/server.js
   Reason: found $_adforlist_calls adForList() calls but only $_applymeta_calls applyLatestMeta() calls. Every endpoint that serializes ads via adForList must first call applyLatestMeta(ads) to refresh post-cache fields. Otherwise ad_format/has_video go stale forever (universal response-time enrichment rule 2026-04-22)")
fi

check "adspy:daily-audit-runs-on-activity" \
  "/srv/ad-spy/server.js" \
  "maybeRunDailyAudit|verify-video-detection\.js" \
  "Daily video-detection audit must run on first user activity each day. Without it, detection drift goes unnoticed (audit infrastructure 2026-04-22)"

check "adspy:coverage-audit-self-heals" \
  "/srv/ad-spy/server.js" \
  "verify-competitor-coverage\.js|auto-recovered" \
  "Coverage audit must run automatically AND auto-recover any recoverable gaps (force-refresh competitors with empty page_ids). Manual scripts are not enough — user shouldn't have to run anything (automation rule 2026-04-22)"

# 2026-05-04 — verify-video-detection.js silently failed for ~2 weeks because
# it was reading the legacy _ads_cache.json that migrateLegacyCache deletes.
# Daily video-drift audit produced nothing. Locking in the per-comp loader so
# this doesn't recur after any future refactor.
check_not "adspy:video-audit-uses-legacy-cache" \
  "/srv/ad-spy/scripts/verify-video-detection.js" \
  "_ads_cache\.json" \
  "verify-video-detection.js must NOT reference _ads_cache.json — that file is deleted by migrateLegacyCache. Read per-competitor caches via _watchlist.json + comp/{slug}.json instead (matches verify-competitor-coverage.js)"

check "adspy:video-audit-uses-per-comp-caches" \
  "/srv/ad-spy/scripts/verify-video-detection.js" \
  "WATCHLIST_FILE|COMP_CACHE_DIR" \
  "verify-video-detection.js must load ads by walking per-competitor caches (the post-2026-04-22 architecture). Otherwise the daily video-drift audit silently no-ops and detection bugs go unnoticed for weeks (P1 fix 2026-05-04)"

# 2026-05-05 — Daily competitive brief feature (generate-brief.js).
# Pin the cost-control + correctness contracts so the new feature can't
# silently regress: no setInterval (idle=$0 rule), prompt caching wired,
# kill switch reachable, daily-fire gate aligned with maybeRunDailyAudit.
check_not "adspy:brief-no-setinterval" \
  "/srv/ad-spy/scripts/generate-brief.js" \
  "setInterval" \
  "generate-brief.js must NOT use setInterval — violates the idle=\$0 cost rule. Use the date-stamp gate via maybeRunDailyBrief() in server.js instead (cost-control 2026-05-05)"

check "adspy:brief-uses-prompt-caching" \
  "/srv/ad-spy/scripts/generate-brief.js" \
  "cache_control.*ephemeral" \
  "generate-brief.js must include cache_control: {type: 'ephemeral'} on the system prompt. Without prompt caching the per-day cost is 4-5x higher and manual /api/brief/regenerate refreshes pay full input cost. First codebase use of caching — keep it (cost-control 2026-05-05)"

check "adspy:brief-respects-kill-switch" \
  "/srv/ad-spy/server.js" \
  "AD_SPY_DISABLE_BRIEF" \
  "server.js must check AD_SPY_DISABLE_BRIEF env var as a kill switch in maybeRunDailyBrief (and the brief endpoints). Mirrors AD_SPY_DISABLE_PAID_AUDITS pattern. Cost-control insurance for when ad-spy stays online but Alex doesn't want to spend on briefs (2026-05-05)"

check "adspy:brief-fires-on-user-activity" \
  "/srv/ad-spy/server.js" \
  "maybeRunDailyBrief\\(\\)" \
  "server.js must call maybeRunDailyBrief() from markUserActivity(). This is the daily-fire trigger; without it the brief never auto-generates and the Today tab is permanently stale (architectural rule 2026-05-05)"

# 2026-05-11 — Cross-page association endpoint exposes cluster data
# (which page_ids share a destination domain, including ad operator's
# identity hints). Must stay behind requireAuth — competitors could use
# this to map our watchlist + un-tracked persona signals.
check "adspy:clusters-endpoint-auth-gated" \
  "/srv/ad-spy/server.js" \
  "app\\.get\\('/api/clusters', requireAuth" \
  "GET /api/clusters must be guarded by requireAuth — this endpoint surfaces persona-cluster intelligence (which un-tracked FB pages share a domain with which tracked competitors). Exposing publicly would leak the operator-identity-mapping signal (security rule 2026-05-11)"

check "adspy:clusters-reads-per-comp-caches" \
  "/srv/ad-spy/scripts/find-page-clusters.js" \
  "lib/cache-walk|COMP_CACHE_DIR|/workspace/\\.cache/comp" \
  "find-page-clusters.js must read per-competitor caches (post-2026-04-22 architecture), not any legacy global ad cache. The canonical loader is lib/cache-walk.js (introduced 2026-05-11); direct path use is also accepted for backward compatibility (2026-05-11)"

# 2026-05-11 — Brief gate self-heal: if the process restarts during the 90s
# delay window between marking the stamp and spawning the script, today's
# brief silently never generates. Self-heal: on next-day startup, if the
# stamp says today but the brief file is missing, clear the stamp so the
# next user activity retries.
check "adspy:brief-gate-self-heals-from-restart" \
  "/srv/ad-spy/server.js" \
  "stamp claims today but brief file missing" \
  "maybeRunDailyBrief() must detect 'stamp written but brief file missing' and clear the stamp. Otherwise a Railway redeploy or OOM during the 90s delay silently skips the day's brief (P1 fix 2026-05-11)"

# 2026-05-12 — SC cost optimizations triggered by 25k-credit single-day
# overage. Three structural pieces protect against regression:
#
# (a) Shared SC tracking module so both server runtime fetches and audit
#     fetches count into the same file. Without this, audit-script credit
#     spend becomes invisible.
check "adspy:sc-tracking-used-by-server" \
  "/srv/ad-spy/server.js" \
  "lib/sc-tracking" \
  "server.js must require lib/sc-tracking for SC call counting + quiet detection. Re-implementing the counter in server.js leaves audit-script spend invisible (2026-05-12)"

check "adspy:sc-tracking-used-by-audit" \
  "/srv/ad-spy/scripts/verify-competitor-coverage.js" \
  "lib/sc-tracking" \
  "verify-competitor-coverage.js must require lib/sc-tracking so its SC calls are counted alongside server's. Without this, the audit script could silently use 100s of credits unseen (2026-05-12)"

# (b) Quiet-page-aware fetch: page_ids that have been empty 3+ times in a
#     row must skip the 6-retry empty-response policy. Otherwise chronically
#     empty pages (KnowBe4 etc.) burn 7 SC calls per refresh returning nothing.
check "adspy:sc-fetch-respects-quiet-pages" \
  "/srv/ad-spy/server.js" \
  "isPageQuiet" \
  "fetchAdsViaScrapeCreators must check isPageQuiet(pageId) and skip retries on quiet pages. Without this, chronically-empty page_ids burn 7 SC calls per refresh × multiple refreshes/day (2026-05-12)"

# (c) Coverage audit must skip probes for page_ids with healthy recent cache.
#     Without this, the daily audit re-probes everything regardless of cache
#     state — wasteful at scale (e.g., ~84 SC calls/day for confirmed-healthy
#     page_ids that don't need confirmation).
check "adspy:coverage-audit-skips-healthy" \
  "/srv/ad-spy/scripts/verify-competitor-coverage.js" \
  "skippedHealthy|HEALTHY_AD_THRESHOLD" \
  "verify-competitor-coverage.js must skip probes for page_ids with healthy recent cache (≥20 ads + cache <7d old). Without this, the daily audit re-probes 80+ healthy page_ids that need no confirmation (2026-05-12)"

# 2026-05-25 — Access log middleware. Without it we cannot answer "did anyone
# visit?" after the fact — only inferred from secondary signals (SC counter,
# brief-stamp date) which underreport silent visits (/health probes, scanner
# traffic, auth-failures from invalid keys). Middleware writes JSONL to
# _access.log; /api/access-stats + /api/access-log expose it. Both endpoints
# are auth-gated.
check "adspy:access-log-middleware-present" \
  "/srv/ad-spy/server.js" \
  "ACCESS_LOG_FILE|fs\\.appendFile.*_access\\.log" \
  "server.js must include the lightweight access-log middleware (writes JSONL line per request to .cache/_access.log). Without it, request-level visibility is gone and we're back to 'we can't tell if anyone used it' (2026-05-25)"

check "adspy:access-log-endpoints-auth-gated" \
  "/srv/ad-spy/server.js" \
  "app\\.get\\('/api/access-(stats|log)', requireAuth" \
  "/api/access-stats and /api/access-log must stay behind requireAuth — they expose IPs, paths, and user-agents of every visitor (2026-05-25)"

# Access log gets pushed to GitHub daily (logs/access.jsonl) so it's
# backed up off-host + readable without SSH. Same daily-gate pattern as
# brief + audit. Fires from markUserActivity().
check "adspy:access-log-pushed-daily" \
  "/srv/ad-spy/server.js" \
  "maybeRunDailyLogPush\\(\\)" \
  "server.js must call maybeRunDailyLogPush() from markUserActivity() so the access log gets backed up to GitHub. Without it, log is local-only and dies with the container (2026-05-25)"

# 2026-05-26 — Completeness audit. Daily SC search-by-name across all
# 24 brands, classifies returned ads by (page_id, landing domain) to
# find untracked pages running ads to brands we track. ~$0.30/day.
check "adspy:weekly-discovery-runs" \
  "/srv/ad-spy/server.js" \
  "maybeRunWeeklyDiscovery\\(\\)" \
  "server.js must call maybeRunWeeklyDiscovery() from markUserActivity(). This is the combined weekly completeness audit + auto-add pass — brands don't launch persona pages daily, so finding and acting MUST happen on the same cadence or we're either burning credits unnecessarily or sitting on stale findings (2026-05-26 → consolidated 2026-05-26)"

check "adspy:completeness-uses-sc-tracking" \
  "/srv/ad-spy/scripts/completeness-audit.js" \
  "lib/sc-tracking" \
  "completeness-audit.js must require lib/sc-tracking so its SC calls count toward the daily total in /api/sc-cost. Otherwise audit spend is invisible (2026-05-26)"

# 2026-05-26 — Weekly auto-add. The completeness audit surfaces untracked
# pages; the auto-add script applies thresholds and grows the watchlist
# without manual intervention. Two structural guards:
#
# (a) Auto-add must skip major media outlets — they're sponsored-content
#     placements, not brand personas. Tracking them would flood the cache
#     with their entire unrelated ad output.
check "adspy:auto-add-skips-media-outlets" \
  "/srv/ad-spy/scripts/auto-add-pages.js" \
  "MEDIA_OUTLET_BLOCKLIST" \
  "auto-add-pages.js must maintain a media-outlet blocklist (BuzzFeed, Reader's Digest, etc.). These are paid sponsored-content placements, not brand-operator pages — adding them to a brand's watchlist would track their entire publishing operation (2026-05-26)"

# (b) Auto-add must apply spam-name filter (fiction/novel/dating pages
#     that keyword-stuff a brand into otherwise-unrelated copy).
check "adspy:auto-add-spam-filtered" \
  "/srv/ad-spy/scripts/auto-add-pages.js" \
  "BLOCKLIST_NAME_TERMS|looksSpam" \
  "auto-add-pages.js must skip pages whose names match fiction/novel/drama/etc. blocklist patterns. These keyword-stuff brand names into ad copy; adding them pollutes the cache (2026-05-26)"

# 2026-05-26 — FB token health monitor. The token died silently for 2
# weeks before anyone noticed (password change / Meta security event).
# This check is gated to fire every ~6h and writes a dead-flag file +
# loud log line on failure. Exposed via /api/token-health.
check "adspy:fb-token-monitored" \
  "/srv/ad-spy/server.js" \
  "maybeCheckFbToken\\(\\)" \
  "server.js must call maybeCheckFbToken() from markUserActivity(). Without it the FB token dies silently and /api/discover breaks for weeks (2026-05-26)"

check "adspy:token-health-endpoint-exists" \
  "/srv/ad-spy/server.js" \
  "/api/token-health" \
  "server.js must expose /api/token-health so token state is queryable without log-scraping. Without the endpoint, the dead-flag file is hidden inside the container (2026-05-26)"

# ── AI Arena invariants ──────────────────────────────────────────────────────

# (none yet — add as bugs recur)

# ── Report ───────────────────────────────────────────────────────────────────

if [ ${#FAILURES[@]} -eq 0 ]; then
  exit 0
fi

echo "" >&2
echo "🛑 REGRESSION GUARD — ${#FAILURES[@]} invariant(s) failed:" >&2
echo "" >&2
for f in "${FAILURES[@]}"; do
  echo "$f" >&2
  echo "" >&2
done
echo "These were bugs we specifically fixed before. Restoring the missing code is required before claiming done." >&2
echo "Invariants live in /workspace/.claude/hooks/invariants.sh — add new ones when bugs recur." >&2
exit 2
