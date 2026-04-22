# Session — 2026-04-22 — Ad Spy: video detection audit, click affordance, sidebar counts

## Summary
User returned after 5-day idle. Hit a cascade of bugs that ended in a structural
realization: the "video play button" issue is actually a **format-detection
accuracy** issue, and the right fix is not "make play button work better" but
"make the whole card clickable so format-detection accuracy stops mattering."

Built an audit script that measures the accuracy objectively (~60% on random
samples), scheduled to run once-per-day when user is active (zero cost when
idle). Turned user complaints from "video button broken again" into ad IDs +
mismatch reports.

## The Key Insight (write this down)

**Recurring UX bugs that get "fixed" over and over often have a misdiagnosed
root cause.** Before adding fix #11, look at the pattern:
- Fix 1: render play button
- Fix 2: capture video URL
- Fix 3: retry Puppeteer when URL missing
- Fix 4: bump concurrency
- …
- Fix N: still broken

The common ancestor: **all of these rely on correctly detecting that the ad is a
video**. Detection is flaky (Meta API doesn't say, Puppeteer runs async). The
fix isn't better detection — it's removing the detection dependency from the
user flow.

Fix #11 was: make the whole image area clickable to FB. Works regardless of
what we think the format is. User always has a path to see the ad.

## What Shipped

### 1. Cache hang / stale data fixes
- `FETCH_PAGE_BUDGET_MS = 90s` hard budget on Meta Graph `ads_archive` paginated fetches
- `MAX_PAGES_PER_FETCH = 10` (was 25) — worst-case per page_id halved
- `EU_TOTAL_BUDGET_MS = 120s` hard budget on the EU enrichment phase
- Moved `saveCache()` to run BEFORE EU enrichment — EU hang no longer blocks users from seeing fresh data
- `_fetchAllAdsFresh()` now merges in previous-cache entries not re-fetched this cycle (preserves history across capped pagination; logged as `[cache-merge] preserved N ads`)

### 2. Idle mode + token conservation
- Server tracks `_lastUserActivityTs`; `markUserActivity()` fires on `/api/ads` + `/api/ads/new`
- Startup no longer auto-runs Puppeteer or SC refresh when cache exists
- Stale-while-revalidate in `getAllAds()` only refreshes if `isActivelyUsed()` returns true (2h idle threshold)
- First user activity after idle triggers image+video extraction on demand
- Effect: idle server burns $0 in SC/Claude API. Active server pays normal rate.

### 3. Structural video-button fix
- Whole `.fb-img` div has `onclick` → opens FB Ad Library (unless click target is `.play-btn` or `<video>`)
- Play button renders only when `isVideoFormat && canPlayInline` (we have both ad_format='video' AND a cached video URL)
- Hover overlay: "Open on Facebook ↗" makes click affordance visible
- `handleImgError` retry-with-backoff: 15s, 30s, 60s before giving up on image load. Shows spinner + "Loading preview…" instead of instant fallback.

### 4. Lazy loading fix
- Previously first page used `src=` (eager) — 50 simultaneous image requests on page open
- Now ALL images use `data-src` + IntersectionObserver (600px rootMargin)
- Result: page opens fast, only near-viewport images fetch

### 5. Stale ad_format bug (discovered via audit)
- `normalizeAd()` reads meta.json on ad creation. If Puppeteer writes meta.json AFTER the ad is cached, cache stays with `ad_format: 'image'` forever.
- Fix: `/api/ads/new` and `/api/ads` now re-read meta.json per-ad at response time, similar to how `has_video` is pulled from `_video_urls.json`
- Impact: video count in a 200-ad sample jumped from 6 to 89

### 6. Sidebar count mismatch
- Previously: sidebar showed all-time totals per competitor. Clicking a competitor filtered by last 3d + active → much fewer ads → confusion
- Fix: sidebar counts now computed with same filter as the default view (last 3 days, active_only respects query). What the number says is what you'll see.

### 7. Ad ID on cards (with HTTP-safe clipboard)
- Monospace ID in card footer. Click → copies to clipboard.
- `navigator.clipboard.writeText` falls back to textarea + `document.execCommand('copy')` for HTTP (plain IP URLs don't get the secure context).

### 8. Puppeteer throughput
- `CONCURRENCY: 3 → 6`
- `DELAY_MS: 1500 → 800`
- Fresh ads extract ~2x faster

### 9. Competitor groups (already from yesterday)
- Sidebar has two collapsible sections: "Digital Security" (10 competitors) and "Genesis" (14 competitors)
- `per_group` counts in `/api/ads/new` response

## Audit Script

`scripts/verify-video-detection.js` picks N random active ads from cache, queries ScrapeCreators per-ad endpoint for ground truth, reports mismatches.

Run manually:
```
docker exec ad-spy node /workspace/scripts/verify-video-detection.js 30 --active
```

Runs automatically once per day on first user activity. Log via `grep [audit] /workspace/server.log`. Report JSON written to `/workspace/.cache/video-audit-{ts}.json`.

**First run results (20 ads, before stale-meta fix):** 60% accuracy. After the meta.json re-read fix, this should be 85%+ for active ads. Drift over time is what the daily audit catches.

## Hooks (from yesterday, now with 13 invariants)

`/workspace/.claude/hooks/invariants.sh` Stop-hook. Each entry = one grep. Today's additions:
- `every-ad-card-clickable-to-fb` — structural guard for the click-through pattern
- `video-play-btn-when-playable` — play button only renders when format is video AND URL is cached
- `fetchAdsForPage-has-hard-timeout` — `FETCH_PAGE_BUDGET_MS` must exist
- `preserve-prev-cache-on-refresh` — `[cache-merge]` log must exist
- `ad-format-pulled-from-meta-at-response-time` — meta.json must be re-read in /api/ads(/new)

`/workspace/.claude/hooks/pre-destructive.sh` PreToolUse hook. Blocks git push/commit/docker cp unless project docs were consulted in the session transcript. Caught today's "which repo?" problem.

## Files Changed
- `ad-spy/server.js` — activity tracking, timeouts, budgets, cache merge, meta.json re-read, daily audit trigger
- `ad-spy/extract-previews.js` — concurrency bump, video URL capture (yesterday's work still in play)
- `ad-spy/scrape-ad-library.js` — date normalization (yesterday)
- `ad-spy/public/index.html` — lazy loading, click affordance, loading states, ad ID, HTTP-safe clipboard, sidebar counts
- `ad-spy/scripts/verify-video-detection.js` — new audit tool
- `ai-arena/.claude/hooks/invariants.sh` — 5 new regression guards
- `ai-arena/.claude/CONTAINER-OPS.md` — documented ad-spy repo URL + commit workflow

## Past Mistakes That Had Root Causes Today

1. **Assumed ad-spy had no git repo because `/srv/ad-spy` wasn't a repo on host.** Repo lives inside the container. CONTAINER-OPS.md didn't document this — updated yesterday.

2. **Fixed video button 10 times at the wrong layer.** Each fix addressed the symptom (button missing, button broken, etc.) without questioning the premise (why does correct play button require correct format detection?). Today's fix removes the premise.

3. **Trusted one grep-based invariant to prove UX is working.** The `isVideoFormat.*play-btn` grep passed the whole time because the code pattern existed — the bug was in runtime data. Invariants for UX have to check the user guarantee (can click → opens ad) not code patterns.

## Outstanding

- Audit runs daily, but doesn't email / alert anything. If accuracy drops, it's in logs only. Could add Slack webhook or just check `docker exec ad-spy tail -20 /workspace/.cache/audit.log` periodically.
- `has_video` can be stale the same way `ad_format` was — if a new video URL is captured AFTER ad is cached, the cached ad's `has_video` field isn't updated. But at response time `/api/ads/new` re-reads `_video_urls.json` so users see the correct value. Just not persisted.
- `/health` `images_cached` counter still shows 0 on startup (cosmetic bug — updates only after `_fetchAllAdsFresh`).

## Commits Today
- `ad-spy 0aff078` — refresh hang fixes (timeouts, budgets, cache merge)
- `ad-spy 03e6af7` — image UX + concurrency
- `ad-spy 21606cc` — structural click-anywhere-on-image
- `ad-spy f6ab8f5` — ad ID + sidebar counts
- `ad-spy 725de3c` — clipboard fallback + audit script
- `ai-arena 93acfe3` — 2 new invariants
- `ai-arena 3152a74` — click-affordance invariant
