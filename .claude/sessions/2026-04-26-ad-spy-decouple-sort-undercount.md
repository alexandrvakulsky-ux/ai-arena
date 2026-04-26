# Session — 2026-04-26 — Ad Spy: ad-contract decoupling, DS undercount fixes, sort UX

## Summary
Long session focused on architectural cleanup + visible UX improvements + chasing real DS undercount bugs.

Started with "DS shows 90 ads, has to be wrong." Ended with:
- 1,548 → ~3,000+ DS ads (Cloaked +720, Guardio +610, Control+ +196)
- Architectural decoupling layer (`lib/ad-contract.js`) so future fetch refactors can't break the renderer
- Sort by EU-impressions / date launched in the UI
- Stats bar simplified to one number + sort dropdown
- 6 dead CSS classes removed
- Stuck "Loading preview..." spinner fixed (3 separate bugs)
- 26 invariants enforce all of the above

## What Shipped (chronological)

### 1. Sanity autotest (Stop hook, free, every response)
`scripts/sanity-check.js` — checks every competitor against thresholds (≥30 ads, ≥1 active in 3d, ≤7d stale, ≥50% page_id coverage). `--deep` mode adds video-proxy probes + FB web cross-check.

Wired into Stop hook so every Claude response surfaces critical/warning/ok summary. Zero cost (cache-only).

### 2. Video pause-on-scroll
IntersectionObserver on inline `<video>` pauses when <50% on screen. Cleans up on emptied event.

### 3. Ad-contract architecture (`lib/ad-contract.js`)
The fix for the recurring "fetch broke the video button" pattern.
- `RENDER_FIELDS` defines what the frontend can read
- `toRenderAd(rawAd)` is the single fetch→render transformer (adds derived `video_proxy_url`, `image_proxy_url`, `has_video`)
- `validate()` for sanity-check
- Three layers of enforcement: write-time (saveCompCache `CACHE_MIN_FIELDS`), read-time (toRenderAd + validate), Stop-hook (invariants)

`adForList` in server delegates to `toRenderAd`. Frontend uses `ad.image_proxy_url` / `ad.video_proxy_url` from the contract instead of building paths from `ad.id`.

### 4. DS undercount investigation + fixes
Cross-checked our cache vs SC live AND FB Ad Library web (Puppeteer scrape). Found:
- **Cloaked: 279 → 999 ads** (FB web shows 1,400). Root cause: SC pagination capped at 25 pages — Cloaked has 100+ pages of data. Bumped cap 25→100→200.
- **Guardio: 621 → 1,230 ads** (over FB web's 1,146 — we capture cross-linked page_ids).
- **Control+ recovered earlier**: 0 → 196 (had a dead page_id `554471337751787`; replaced with `389115614281537` = Control+ Anti-Scam → controlplus.app).
- **Clario investigation: not undercounted.** SC live deep-paginated total = 117 (matches cache exactly). FB web shows 105. Brand simply runs fewer ads than user expected.
- **KnowBe4 + Alert Marko**: page_ids genuinely return 0 from SC. Marked KNOWN_QUIET in sanity-check. FB SPA blocks scraping for replacement IDs.

### 5. Sort UX
- Default sort: **impressions (eu_total_reach desc)**, fallback to date for null EU
- Sort dropdown: "Impressions (EU reach)" / "Date launched (newest)"
- Backend keeps `days` and `score` modes available via `sort=` param but UI doesn't expose them

### 6. Stats bar simplified
- Removed: avg_score, top_score, active count, this-week count, 4-tile metric panel
- Now: `2,773 ads` + sort dropdown
- Removed 6 dead CSS classes (~33 lines): `.metric*`, `.btn-reset`, `.card-comp`, `.card-foot-top`, `.dur`, `.loading-more`

### 7. "Launched X ago" indicator on cards
Image badge (top-left) now reads: `today` / `1d ago` / `12d ago` / `3mo ago` / `2y ago`. Was just `12d`.

### 8. server.js simplification (-22%)
Subagent pass removed 430 lines of dead code from the architecture rewrite:
- `_fetchAllAdsFresh`, `_refreshAdsInBackground`, `_bgRefreshInProgress`
- Meta-API path: `fetchAdsForPage`, `normalizeAd`, `MAX_PAGES_PER_FETCH`, `AD_FIELDS`, `COUNTRIES`
- EU enrichment: `fetchEuDataForPage`, `EU_COUNTRIES`, `EU_FIELDS`, `EU_TOTAL_BUDGET_MS`
- Suppression detection: `detectApiSuppression`, `SUPPRESSION_MARKERS`
- Legacy SC throttle: `scFetchLog`, `SC_FETCH_LOG_FILE`, `prevScAds`

`loadVideoIndex` now memoized with mtime invalidation (was re-reading 50× per page response).

### 9. Stuck "Loading preview..." spinner — fixed 3 bugs
1. **No cache-bust on retry**: same URL → browser served cached 404 → `onerror` never fired again → spinner stuck forever. Fix: `?r=N` cache-buster.
2. **15s+30s+60s backoff**: 105 seconds of stuck spinner. Reduced to 4s+8s+16s = 28s total.
3. **`display: none` during retry**: some browsers skip fetches on hidden images (especially `loading="lazy"`). Removed.

Bonus: spinner has `pointer-events: none` so users can click through to FB while loading.

## Invariants now at 26
Every fix this session has a corresponding Stop-hook regression guard.

## Today's Commits

**ad-spy:**
- `5dea964` — ad-contract decoupling layer + DS gap fix + FB web verify
- `09b8fa9` — SC cap 25 → 100 (recovered 1,600 ads)
- `dcbe989` — SC cap 100 → 200 (Cloaked plateau)
- `ef3fb5b` — close decoupling gaps (write-time enforcement, contract URLs in frontend)
- `21359ae` — simplify server.js (-430 lines, -22%)
- `6b252ba` — sort by impressions/date + simplify stats bar + remove unused CSS
- `90b281c` — drop Days running + Score from sort dropdown
- `583e32a` — fix stuck loading spinner

**ai-arena:**
- `52008e6` — ad-contract invariants
- `c21678d` — SC pagination cap invariant
- `d2f0b87` — write-time enforcement + frontend contract URL invariants
- `d7b0a17` — wire sanity-check into Stop hook + 3 new invariants
- `620245b` — session save + video-index invariant

## The lesson worth remembering

When a UX bug "keeps coming back" (video button broke 5+ times, image stuck 2+ times), the real bug is upstream of the layer you keep patching. The fix is to remove the dependency on the flaky signal:
- Video button: was gated on `ad_format === 'video'` (Puppeteer-detected, async, lagging). Now gated on `has_video` (instant ground truth).
- Image loading: was retrying same URL (cached 404 replay). Now cache-busts.
- Fetch breaking render: was 5 places knew render shape. Now one contract.

Pattern documented in `MISTAKES.md` (entries #1, #5, #7, #8 added this session).

## Outstanding
- KnowBe4 + Alert Marko page_ids still need manual replacement (can't auto-discover via FB SPA)
- EU enrichment removed; existing ads keep their `eu_total_reach` but no fresh data flows. Sort by impressions works on cached data only. If you want live EU data refresh, would need a per-competitor enrichment pass.
- The "View on Facebook" fallback after 28s of failed retries means cards with no extracted creative show as plain links. Acceptable but a lot of cards may end up like this for newly-fetched ads. Watch and tune retry window if needed.
