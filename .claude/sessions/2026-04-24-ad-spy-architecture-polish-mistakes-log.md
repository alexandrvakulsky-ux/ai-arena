# Session — 2026-04-24 — Ad Spy: persona audit, design pass, MISTAKES.md

## Summary
Long session. Started with "BetterMe and Paw Champ still undercount," ended with per-competitor persona audit framework, a visible UI redesign, and a permanent MISTAKES.md to stop the "fix-same-bug-5-times" cycle.

## Final state
- **2,773 active ads from last 3 days** across 19 competitors (up from 49 at the worst point earlier today)
- Genesis: 2,622 | Digital Security: 151
- Top advertisers: Liven 989, Nebula 367, Muscle Booster 257, Relatio 243, BetterMe 195, Paw Champ 149

## What shipped

### 1. Persona audit framework
- `scripts/find-missing-personas.js` — derives brand domain from cached `link_url`s, searches FB for more pages, verifies each via SC's `link_url` match
- `scripts/apply-persona-additions.js` — applies audit report to watchlist + invalidates affected caches
- First run: 33 verified persona pages added across 11 competitors (Finelo +8, Coursiv +5, Muses +5, etc.)
- Watchlist hot-reload (mtime check in `markUserActivity`) — new page_ids take effect without server restart

### 2. Visible redesign (2 agent-led passes)
- First pass: design system doc + P0 a11y (focus-visible, WCAG AA contrast, tabular-nums) + P1 polish (color-mix tints, unified radii, button padding consolidation, angle-zone left-stripe) + P2 (responsive sidebar, reduced-motion). Invariant updated for anchor-based click target.
- Second pass (after user said "doesn't look different"): sidebar avatars with deterministic brand color, pill-badge counts, activity dots, 3px active bar, group headers as real two-line headings. Ad cards: killed white FB-style header, status badge (🔥/⚡/✓/🧪) + days-running badge on image, platform icons, bolder body, lift-on-hover. Top stats replaced with 4 metric tiles.
- `DESIGN.md` + `DESIGN_PRINCIPLES.md` committed to ad-spy repo

### 3. Ad card text clamp fixed properly
Was: infinite expand on click → grid blowout. Now: 3-line clamp with gradient fade + "Show more" pill → expands to scrollable 200px-max-height → card stays bounded.

### 4. BetterMe + Paw Champ recovered
- BetterMe 2 → 12 page_ids (persona audit). 28 → 195 active-in-3d.
- Paw Champ 1 → 8 page_ids. 0 → 149 active-in-3d.
- Root cause fixed: watchlist wasn't hot-reloading after JSON edits. Now it does.

### 5. Video play button fix (Nth time, but the right one)
After N failed fixes, diagnosed with live data: 110 of 200 ads have cached video URLs, but only 32 have `ad_format='video'`. Render required both → 78 videos lost play button. Fix: `canPlayInline` alone drives the render. `ad_format` is unused in this decision.

### 6. Puppeteer page-screenshot fallback removed
Was capturing FB Ad Library UI chrome (Finland dropdown, search filters) as ad creatives. Deleted 4,808 bogus screenshots from cache; they re-extract cleanly now.

### 7. Documentation refresh
- `ad-spy/README.md` rewritten to match per-competitor architecture (was documenting the defunct mega-refresh)
- `ai-arena/.claude/CONTAINER-OPS.md` updated with per-competitor refresh commands + persona audit scripts
- New: `ad-spy/MISTAKES.md` — structural log of 6 recurring bug classes with wrong-diagnoses, root premises, permanent fixes, and the invariants that block regression
- New: `ai-arena/.claude/rules/pattern-recognition.md` — meta-rule telling future sessions to read MISTAKES.md before patching a familiar-feeling bug

## Invariants: now at 19
Every fix added this session has a corresponding Stop-hook invariant. Notable new ones:
- `no-page-screenshot-fallback` — forbids `page.screenshot(` in extract-previews.js
- `no-setInterval-money-burner` — cost rule guard
- `play-btn-not-format-gated` — check_not that blocks the recurring video-button regression
- `delay-between-page-ids` — 1.5s between SC calls to avoid empty-response flakiness
- `per-competitor-cache-architecture` — architectural guard

## The big lesson

Each session I patched the same bugs at the wrong layer. The videos example: fixed 5 times, each time adjusting a signal (render code, URL capture, Puppeteer concurrency, meta.json re-read, click fallback) instead of questioning the premise (`ad_format === 'video'` is required).

`MISTAKES.md` documents the pattern so I catch it next time. The invariants make regression executable — not just documented, but enforced.

## Today's commits (chronological)

**ad-spy:**
- `0aff078` refresh hang fixes
- `03e6af7` image UX + concurrency
- `21606cc` click-anywhere-on-image
- `f6ab8f5` ad ID + sidebar counts
- `725de3c` clipboard fallback + audit script
- `76660ac` meta.json re-read + daily audit
- `3e63acc` applyLatestMeta helper
- `b5be752` SC empty-response retry
- `25029e4` per-competitor rollback
- `a6eaa3c` per-competitor lazy-fetch architecture
- `3201ba6` Nebula coverage fix (delay + page-id merge)
- `8b7a3a7` auto-run coverage audit + auto-recover
- `1ad5d06` cost rule kill switch
- `48c9bf5` remove puppeteer page-screenshot fallback
- `6b19264` BetterMe pages + Discover dropdown polish + DESIGN.md
- `55b8b64` apply DESIGN.md improvements (P0/P1/P2)
- `059778e` visible redesign (avatars, badges, metric tiles)
- `6b8e8e0` ad card text UX + Paw Champ personas + watchlist hot-reload
- `b77c6a5` persona audit scripts + 33 pages
- `9365cff` README rewrite
- `e22c8b9` video play button root-cause fix
- `1a448c0` MISTAKES.md

**ai-arena:**
- `93acfe3`, `3152a74`, `7ae8e66`, `cd953e3`, `4ebbf20`, `9758a99`, `204110a`, `311f274`, `c47d847`, `8270ad3`, `f685d50`, `0a8a59e`, `66900a7` — invariants, hooks, session notes, rules, docs

## Outstanding for future sessions
- Remove dead code `_fetchAllAdsFresh`, `_refreshAdsInBackground` from server.js (~250 lines, kept for diff size during architecture rewrite — now safe to delete)
- P0.3 full conversion of `<div onclick>` to `<button>` for remaining surfaces (most done, verify all)
- Activity-dot on sidebar needs `stats.per_competitor_last_new` from server — UI is ready, backend field not yet shipped
- Consider: optional toggle for "all active ads" vs "new in 3 days" — user has asked indirectly a few times
- Control+, Privacyhawk, KnowBe4, Alert Marko — all return 0 from SC. Investigate if page_ids are still live on FB Ad Library
