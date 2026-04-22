# Session — 2026-04-22 (afternoon) — Ad Spy: per-competitor architecture + coverage audit

## Summary
Day-2 of the Ad Spy refactor cascade. Started with user complaint "only 30 DS
ads in 3 days, that's BS." Ended with full per-competitor lazy-fetch
architecture, coverage audit script, and 5.3× more ads visible (Nebula 19 →
100 active in 3d, total feed 49 → 2,146).

The morning session (separate file `2026-04-22-ad-spy-audit-click-affordance.md`)
fixed video buttons + click affordance + ad ID + sidebar counts. This file
covers the afternoon's deeper structural rewrite.

## The big shift

The mega-refresh model was fundamentally broken:
- One refresh iterates all 24 competitors in a single transaction
- Hangs on Meta API rate limits (no per-page timeouts)
- Wipes the global `_ads_cache.json` every cycle
- ANY single competitor failing wipes data for ALL of them
- Background runs even when nobody's using the app

We replaced it with **per-competitor lazy fetch**:
- `.cache/comp/{slug}.json` per competitor, independent 4h TTL
- `getCompetitorAds(comp)` — stale-while-revalidate per competitor
- `/api/ads/new?group=X` only fetches that group's competitors
- `/api/ads/new?competitor=X` fetches just that one
- Sidebar counts use `loadAllCompCachesFromDisk()` — never triggers SC fetch
- Migration: legacy `_ads_cache.json` split into per-competitor files on first startup

Result: idle = $0, active = SC tokens only for what user views, no cascading
failures.

## Cascade of bugs we hit and fixed (in order of discovery)

### 1. Meta API rate-limit (error 613) silently wipes data
Force-refresh during rate limit returned 0 ads from Meta for 19 of 24
competitors. SC was throttled. Fallback to Puppeteer → 30 ads per page.
Cache went from 66K ads to 302.

**Fix:** SC retry on empty first response (3 attempts → 6 attempts with
exponential backoff). Per-competitor rollback: if fresh fetch returns <20%
of prev cache, revert to prev for that competitor. Eventually replaced the
whole bulk-refresh path with per-competitor.

### 2. ScrapeCreators flakiness — empty-response 0/29/0 pattern
Same SC endpoint + page returns 0, then 30, then 0 on consecutive calls.
First impl gave up after first empty response.

**Fix:** retry empty responses up to 6× with backoff. Verified: Guardio
went from "no SC data" to 275 ads after retries fired.

### 3. SC back-to-back requests return empty (the Nebula hidden bug)
Nebula has 5 page_ids. Refresh fetched them sequentially with no delay.
2-3 of them returned empty even though SC has full data when probed alone.
Same code path also dropped Finelo + Liven page_ids.

**Fix:** 1.5s delay between page_ids within `fetchCompetitorFresh`. Verified:
Nebula went from 3/5 to 5/5 page_id coverage. Active ads in 3d: 19 → 100.

### 4. Per-competitor cache treats empty-but-cached as missing
After SC returns 0 for a competitor and we save the empty result, next
request thought "no cache" and blocked on fresh fetch again. 1-min lag
on every "warm" call.

**Fix:** changed `hasData` check to `hasCacheEntry` (timestamp > 0). Empty
cached result is still a cache hit until TTL expires.

### 5. ad_format defaults to 'image' for fresh ads (separate, morning)
`normalizeAd` reads meta.json once at ad-creation. Puppeteer writes meta.json
later, but cache stays with stale ad_format='image' forever.

**Fix:** `applyLatestMeta(ads)` re-reads meta.json + video_urls.json at
response time. Universal helper called by every endpoint. Invariant counts
adForList sites vs applyLatestMeta sites — must match.

### 6. Recurring "video button" complaints traced to format detection
Each "fix" added a flaky check on top of unreliable detection. Real fix:
make whole image area clickable to FB Ad Library, regardless of detected
format. User can always reach the ad. Play button only when we have
confirmed video URL cached.

## Files Changed

### ad-spy/server.js
- New: per-competitor cache infrastructure (~200 lines)
- New: `fetchCompetitorFresh` returns per-page status (not a flat array)
- New: `mergeFreshWithPrev` falls back to prev cache per page_id
- New: `getCompetitorAds(comp)` with stale-while-revalidate + rollback
- New: `getManyCompetitorsAds(comps)` parallel with concurrency cap 2
- New: `loadAllCompCachesFromDisk()` for sidebar counts (never fetches)
- New: `applyLatestMeta(ads)` — single response-time enrichment helper
- New: `migrateLegacyCache()` runs once on first startup
- 1.5s delay between page_ids inside `fetchCompetitorFresh`
- 6-retry SC empty-response with exponential backoff (was 3)
- `/api/refresh` now invalidates per-competitor caches, supports `?competitor=` and `?group=`
- Watchlist add/remove no longer wipes global cache; deletes per-comp file on remove
- Startup: no auto-fetch; lazy on first user request
- Dead code: `_fetchAllAdsFresh`, `_refreshAdsInBackground` (kept for diff size; remove later)

### ad-spy/scripts/verify-competitor-coverage.js (new)
Per-competitor coverage audit. For every page_id, probes SC and compares
with cache. Flags gaps as recoverable (SC has data, cache missed it) or
genuinely empty (nothing SC can give us). Pinpoints "Nebula has too few"
into "Nebula page_ids X and Y are missing from cache."

### ad-spy/scripts/verify-video-detection.js (from morning, still valid)
Random-sample audit comparing our `ad_format`/`has_video` to SC ground truth.
Auto-runs once per day on first user activity.

### ad-spy/public/index.html (morning)
- Whole image area clickable (opens FB Ad Library)
- Play button only renders when `isVideoFormat && canPlayInline`
- Loading-spinner placeholder + 3-attempt retry before fallback to FB link
- Ad ID in card footer with HTTP-safe clipboard (`document.execCommand` fallback)
- Sidebar counts filtered to match displayed view (last 3d + active_only)

### ai-arena/.claude/hooks/invariants.sh
Now at 18 invariants. New ones today:
- `every-ad-card-clickable-to-fb` — structural click affordance
- `applyLatestMeta-defined` + counter check that adForList calls match applyLatestMeta calls
- `daily-audit-runs-on-activity`
- `rollback-bad-refreshes-per-competitor` (updated for new path)
- `per-competitor-cache-architecture` — guards COMP_CACHE_DIR + getCompetitorAds + loadCompCache
- `disk-only-sidebar-counts` — guards loadAllCompCachesFromDisk usage
- `per-page-id-merge` — guards mergeFreshWithPrev
- `delay-between-page-ids` — guards the 1.5s pause that fixed Nebula

### ai-arena/.claude/CONTAINER-OPS.md
- Documented Ad Spy repo URL inside container (`/workspace`, SSH deploy key)
- Operations runbook section: audit commands, force-refresh, cost knobs

## Final Ad Counts (sanity check at session end)

| Group | Active in last 3d |
|---|---|
| Digital Security | 99 |
| Genesis | 2,056 |
| **Total** | **2,146** |

24/24 per-competitor cache files on disk. 18 competitors actively returning
ads from SC. 4 are genuinely empty on SC side (Control+, Privacyhawk, KnowBe4,
Alert Marko) — not a bug; SC just doesn't have data for those page_ids
right now.

## Key Insight (write this on a sticky note)

**When the same UX bug "keeps coming back," the real bug is upstream of all
the layers you keep patching.**

Today's video-button saga: each "fix" addressed the symptom (button missing,
button broken, etc.) without questioning the premise (why does correct play
button require correct format detection?). The fix was to remove the premise
— make the whole card clickable so detection accuracy stops mattering.

Same with the cache: each refresh-fix addressed the symptom (rate limit, SC
flakiness, partial failure) without questioning the premise (why are all 24
competitors entangled in one transaction?). The fix was per-competitor
isolation.

## Commits Today (afternoon)
- `ad-spy 76660ac` — meta.json re-read + daily audit
- `ad-spy 3e63acc` — applyLatestMeta universal helper
- `ad-spy b5be752` — SC empty-response retry
- `ad-spy 25029e4` — per-competitor rollback (in old architecture)
- `ad-spy a6eaa3c` — per-competitor lazy-fetch architecture (the big one)
- `ad-spy 3201ba6` — Nebula coverage fix: delay between page_ids + page-level merge
- `ai-arena 9758a99` — invariant for rollback protection
- `ai-arena 7ae8e66` — invariants for per-comp architecture
- `ai-arena 204110a` — invariants for coverage-gap fixes

## Outstanding for Future Sessions

- Remove dead code in server.js: `_fetchAllAdsFresh`, `_refreshAdsInBackground` (~250 lines)
- Some competitors return 0 from SC (Control+, Privacyhawk, KnowBe4, Alert Marko) — investigate if these page_ids are still active on FB
- Frontend doesn't surface "this competitor's data is stale" — add a subtle indicator
- Rollback threshold (20% drop) could be tuned per-competitor based on historical variance
- The audit script could trigger auto-recovery for recoverable gaps instead of just reporting them
