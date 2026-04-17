# Session — 2026-04-17 — Ad Spy v3: Stale Cache, Videos, Competitor Groups

## Summary
Major fix + feature session for Ad Spy. Resolved "black loading screen" by making cache stale-while-revalidate, fixed a critical data-loss bug that was hiding 90% of competitors' recent ads, re-worked sidebar into collapsible competitor groups ("Digital Security" + "Genesis"), seeded 14 new Genesis competitors (quiz-funnel brands), and added video URL extraction so play buttons actually work on video-format ads.

## Ad Spy Container (unchanged)
- **Container:** `ad-spy` on Hetzner (135.181.153.92)
- **Ports:** 3001 (app), 2223 (SSH)
- **Workspace:** `/srv/ad-spy` bind-mounted to `/workspace`
- **Access:** `http://135.181.153.92:3001`
- **Password:** in `/workspace/.env` as `APP_PASSWORD`

## What Shipped

### 1. Stale-while-revalidate cache (fixes black loading screen)
**Problem:** After 8h cache TTL expired, `getAllAds()` blocked for 5-10 min fetching everything fresh. User saw black "Loading..." screen.

**Fix:** `_fetchAllAdsFresh()` extracted as separate function. `getAllAds()` now returns stale cache immediately and kicks off a background refresh (`_refreshAdsInBackground()`). On server startup, stale cache is loaded from disk instead of discarded. First request returns in <100ms with existing data.

### 2. Fixed SC fetch data-loss bug (the "only Clario has new ads" issue)
**Problem:** User reported only Clario showing recent ads, everyone else appeared months stale. Root cause was a cascade:
- `SC_REFETCH_INTERVAL = 24h` — ScrapeCreators fetches throttled to once per day
- When SC throttled, code fell back to Puppeteer (~30 ads) instead of the previous 486+ SC ads
- Cache rebuilt from scratch each refresh, so previous SC data was LOST
- Result: Guardio had 486 ads yesterday, 112 today; Cloaked 285 → 36; Malwarebytes 279 → 30

**Fixes:**
- Reduced `SC_REFETCH_INTERVAL` from 24h to 4h
- Added `prevScAds` map: on fresh fetch, if SC throttled for a page, reuse the previous cache's SC ads instead of falling to Puppeteer
- Fixed `_source` tagging — was hardcoded to 'scrapecreators' based on whether API key existed; now reflects actual source used

### 3. Fixed Unix timestamp date bug (Malwarebytes dates broken)
**Problem:** Malwarebytes ads had `started: 1773385200` (raw Unix seconds) instead of `"2026-04-16"` ISO date. Date filtering silently failed.

**Fix:** Added `normDate()` helper in `scrape-ad-library.js` that converts Unix timestamps (seconds or ms) to ISO date strings. Already existed for the ScrapeCreators path; was missing in the Puppeteer scraper path.

### 4. Video URL extraction + play button fixes
**Problem:** Ads marked as `ad_format: 'video'` but no play button showing. Puppeteer was detecting video format from DOM but not capturing the actual video URL for playback.

**Fixes in `extract-previews.js`:**
- Response interceptor now also captures `video/*` and `.mp4` URLs from fbcdn
- DOM extraction reads `<video>` src attribute
- Captured URLs saved to `_video_urls.json` (primary + secondary quality)
- `extractAd()` no longer skips video ads that already have `meta.json` but no video URL — re-extracts them

**Fix in `public/index.html`:**
- Play button now shows for any `ad_format === 'video'` ad, not just ones with cached URLs
- If video URL missing, clicking play opens Facebook Ad Library in a new tab instead of failing silently
- Tooltip indicates whether inline play is available

**Fix in `server.js`:**
- `triggerImageExtraction()` now also queues video-format ads missing URLs for Puppeteer re-extraction
- `run()` in extract-previews.js was also filtering these out — fixed

### 5. New ads cutoff: 14 days → 3 days
Per user request, New Ads tab now shows only ads started in last 3 days. Ads older than that are filtered out as not useful for signal.

### 6. Puppeteer extraction prioritization
New ads (<3 days) are now first in the Puppeteer queue, then older ads by score. Previously it was pure score-based, so brand-new low-score ads never got screenshotted.

### 7. Sidebar grouping: Digital Security + Genesis
**Feature:** Sidebar now renders two collapsible sections:
- **Digital Security** — original 10 competitors (Guardio, Cloaked, Clario, Malwarebytes, Control+, LifeLock, Privacyhawk, Omniwatch, KnowBe4, Alert Marko)
- **Genesis** — 14 quiz-funnel competitors (parent company's frenemies)

**Changes:**
- Added `group` field to competitor schema with migration for old watchlists
- `/api/competitors` returns `{competitors, groups}`
- `/api/ads` + `/api/ads/new` accept `group` query param
- Responses include `per_group` counts alongside `per_competitor`
- `/api/watchlist/add` accepts `group` in body
- Frontend: collapsible sections (state persisted in localStorage), "All in {group}" sub-item at top of each, Discover Track button gets a group dropdown

### 8. Genesis competitors seeded
Found via Facebook Ad Library search + ScrapeCreators ad lookup. 14 brands across 27 FB pages:

| Brand | Pages | Type |
|---|---|---|
| BetterMe | 119863333184039, 109270228169203 | direct |
| Lumi | 104907949030478 | direct |
| MaxBeauty | 382371498288525 | direct |
| Muscle Booster | 106059717857087 | direct |
| Muses Academy | 124567837295981 | direct |
| Nebula | 751887504682676, 109487742231872, 104774471654720, 832418213281812, 676777215516877 | direct |
| Paw Champ | 100762915095571 | direct |
| Relatio | 314199355102814 | direct |
| Coursiv | 106196845908636 | direct |
| Finelo | 112617294780590, 477248708798413, 105988468846056 | direct |
| KetoGo | 112614681513601 | direct |
| Ultiself | 111072584908248, 195635673633360 | direct |
| Wisey | 113150981164572 | direct |
| Liven | 103537499312980, 827576157111385, 913441275180639, 744053238798373, 920427391146014 | creative |

**Trick for future page discovery:** When FB Ad Library search returns only persona pages and no official brand page, ask user for a specific Ad Library ID (e.g. `4014598175337048`). Look it up via ScrapeCreators: `GET api.scrapecreators.com/v1/facebook/adLibrary/ad?id={libraryId}` — returns `snapshot.page_id` and `page_name` directly.

## Files Changed
- `server.js` — stale-while-revalidate, SC preservation, group support, image extraction priority
- `extract-previews.js` — video URL capture, video re-extraction logic
- `scrape-ad-library.js` — date normalization fix
- `public/index.html` — grouped sidebar, group selector in Discover, play button for all video-format ads
- `.cache/_watchlist.json` — 24 competitors across 2 groups (was 10)

## Key Fixes That Affected Data
- `rm /workspace/.cache/_ads_cache.json` + `rm /workspace/.cache/_sc_fetch_log.json` — forced full fresh fetch from ScrapeCreators for all suppressed competitors. Without this, old throttle log would have kept stale data for 4 more hours.

## Testing Evidence
After fixes, new ads (last 3 days) went from 60 (all Clario) to 116+ across 5 Digital Security competitors:
- Guardio: 39 new ads (newest 2026-04-16)
- Cloaked: 9 new ads
- Clario: 61 new ads
- Malwarebytes: 4 new ads (was 0 due to timestamp bug)
- LifeLock: 3 new ads

Video URL coverage went from 35/58 video ads (60%) on initial check; all missing ones queued for re-extraction.

## Pending / Known Issues
- Genesis competitors pull fresh data on next cycle — counts for new Genesis brands only appear after the background refresh pulls SC data for the 14 new pages (~5-10 min after restart)
- `images_cached` counter in `/health` is 0 until `_fetchAllAdsFresh()` completes — it doesn't update from disk cache on startup. Purely cosmetic.
- No way yet to batch-remove competitors from a group via UI (remove button exists on Discover tab only, per-page)

## Infra Note
Ad Spy container does not have its own git repo. Source code is now copied into `ai-arena/ad-spy/` for versioning alongside the main project. To deploy: `docker cp ai-arena/ad-spy/*.js ad-spy:/workspace/ && docker restart ad-spy`.
