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
  "onclick=.*window\.open.*adLibUrl" \
  "Every ad card image area must be clickable -> opens FB Ad Library. Guarantees users can always view the original ad even if Puppeteer hasn't detected format yet. Structural fix for recurring 'no play button' bug (2026-04-22)."

check "adspy:video-play-btn-when-playable" \
  "/srv/ad-spy/public/index.html" \
  "isVideoFormat && canPlayInline" \
  "Inline play button must render when ad is video-format AND has cached video URL. If just video-format but no URL, click-through to FB (which handles the playback) takes over instead of showing a broken button."

check "adspy:sc-refetch-interval-le-4h" \
  "/srv/ad-spy/server.js" \
  "SC_REFETCH_INTERVAL = [1-4] \* 60 \* 60 \* 1000" \
  "SC_REFETCH_INTERVAL must be <= 4h. 24h caused data loss: SC-sourced ads got wiped on cache rebuild (bug fixed 2026-04-17)"

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
  "data-src=\"/api/preview" \
  "Card images must use data-src (not src=) so IntersectionObserver controls loading. Without this, every page open hits the server with 50 parallel image requests (bug fixed 2026-04-17)"

check_not "adspy:no-eager-image-loading" \
  "/srv/ad-spy/public/index.html" \
  "_isFirstPage \? 'src' : 'data-src'" \
  "Must not revert to eager-loading first page images — that was the 'slow page open' bug"

check "adspy:idle-mode-startup" \
  "/srv/ad-spy/server.js" \
  "Idle mode|isActivelyUsed|markUserActivity" \
  "Server must not auto-run Puppeteer / SC refresh on startup when cache exists. Wait for first user activity (token-burn fix 2026-04-17)"

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
