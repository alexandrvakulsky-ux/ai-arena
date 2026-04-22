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

check "adspy:video-play-btn-all-video-format" \
  "/srv/ad-spy/public/index.html" \
  "isVideoFormat.*play-btn" \
  "Play button must render for every ad with ad_format==='video' (bug fixed 2026-04-17)"

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
