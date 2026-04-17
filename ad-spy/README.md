# Ad Spy

Facebook Ad Library intelligence tool. Tracks competitor ads, discovers new competitors, caches creatives locally.

## Architecture

```
Browser → Express server (port 3001) → Meta Ad Library API (free)
                                      → ScrapeCreators API (fallback, paid)
                                      → Puppeteer scraper (fallback, free)
                                      → Claude API (angle categorization, paid)
```

### Data flow

1. **Meta Ad Library API** fetches ads for tracked competitors (8h cache TTL)
2. **Smart fallback detection** triggers ScrapeCreators or Puppeteer when API is suppressing results (policy violations, zero returns)
3. **EU enrichment** fetches reach, targeting, payer data from 6 EU countries (skips pages known to have no EU ads)
4. **Image pipeline**: ScrapeCreators ads have CDN URLs → downloaded at scrape time. API ads → Puppeteer screenshots in background (3 concurrent tabs)
5. **On-demand image proxy**: when browser requests an uncached image, server fetches from fbcdn and caches before serving
6. **Angle categorization**: Claude API labels each ad's messaging angle on-demand (lazy, per-page, cached in `_angles.json`)
7. **Discovery**: searches 30 keywords across Ad Library, groups by page, filters by relevance (12h cache)

### Files

| File | Purpose |
|------|---------|
| `server.js` | Express server, API endpoints, scraping orchestration, image proxy |
| `public/index.html` | Single-page frontend (vanilla JS, no build step) |
| `scrape-ad-library.js` | Puppeteer-based Ad Library scraper (Relay store extraction) |
| `scrape-http.js` | Plain HTTP scraper (requires residential proxy, not yet integrated) |
| `extract-previews.js` | Background Puppeteer job for screenshot extraction |
| `Dockerfile` | Node 20 + Chrome + SSH |

### Endpoints

**Ads:**
- `GET /api/ads?page=1&limit=50&competitor=X&sort=score&active_only=true` — paginated ad list (Top Performers)
- `GET /api/ads/new?page=1&limit=50&active_only=true` — ads from last 14 days, sorted by potential (velocity × variant count)
- `POST /api/refresh` — clear cache and re-fetch all ads (no UI button, use curl)

**Discovery:**
- `GET /api/discover?q=keyword&min_active=10` — manual keyword search
- `GET /api/discover/auto` — cached broad scan across 30 security keywords (12h cache)

**Watchlist:**
- `GET /api/competitors` — current tracked competitors
- `POST /api/watchlist/add` — `{page_id, page_name}` → add to tracking
- `POST /api/watchlist/remove` — `{page_id}` → remove from tracking

**Media:**
- `GET /api/preview/:adId/creative` — ad image (on-demand fetch + disk cache, uses `fs.createReadStream` not `sendFile`)
- `GET /api/preview/:adId/avatar` — page avatar
- `GET /api/video-proxy/:adId` — video stream with Range support (no auth — browser `<video>` can't send headers)

**System:**
- `GET /health` — uptime, ad count, image cache stats
- `POST /api/auth` — password auth → session token

## Setup

```bash
cp .env.example .env   # Add FB_ACCESS_TOKEN, SCRAPECREATORS_KEY, APP_PASSWORD, ANTHROPIC_API_KEY
npm install
npm start              # http://localhost:3001
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FB_ACCESS_TOKEN` | Yes | Graph API token with `ads_read` permission (also has Marketing API access to Futureproof account) |
| `SCRAPECREATORS_KEY` | No | API key for ScrapeCreators fallback |
| `ANTHROPIC_API_KEY` | No | Claude API for angle categorization |
| `APP_PASSWORD` | No | Password gate for the web UI (empty = no auth) |
| `PORT` | No | Default 3001 |

### Docker

```bash
docker build -t ad-spy .
docker run -d --init --name ad-spy -p 3001:3001 -p 2223:22 \
  -v /srv/ad-spy:/workspace \
  -v ad-spy-puppeteer-cache:/home/node/.cache/puppeteer \
  ad-spy bash -c "sudo /usr/sbin/sshd -o 'UsePAM yes' 2>/dev/null; cd /workspace && node server.js 2>&1 | tee /workspace/server.log"
```

**Note:** Do NOT run `npm install` in the container CMD — install separately via `docker run --rm -u root -v /srv/ad-spy:/workspace ad-spy npm install`. The node user can't write to the root-owned bind mount.

## Smart fallback detection

When Meta API results look suppressed, ScrapeCreators is used automatically:
- API returns < 5 ads (including 0)
- \> 50% of returned ads are policy-removed ("ran without a disclaimer")
- 0 active ads out of < 50 total
- < 20 ads with average age > 1 year

Search-only competitors (no page IDs) are excluded from fallback.

## Cost controls

| Service | Trigger | Limit |
|---------|---------|-------|
| ScrapeCreators | Suppressed competitors on cache refresh | Skip pages fetched in last 24h (`_sc_fetch_log.json`) |
| Claude API (angles) | User views a page with uncategorized ads | 10s cooldown between calls, results cached permanently |
| EU enrichment | Cache refresh | Skip pages known to have no EU ads, re-check weekly (`_eu_pages.json`) |
| Meta API | Cache refresh (8h) + discovery (12h) | Free, no limits |

## Frontend

Vanilla JS, no framework. Two tabs:
- **New Ads** (default) — ads from last 14 days, sorted by potential (angle velocity × variant count)
- **Discover** — auto-scans 30 keywords on open, shows pages with 5+ active ads in security/privacy space

Key patterns:
- **Server-side pagination** — 50 ads per request
- **Intersection Observer** — images lazy-load 600px before scroll container edge
- **First page eager loading** — first batch uses `src` directly (no observer race condition)
- **Sentinel infinite scroll** — next page loads when sentinel enters viewport
- **JSON prefetch** — page N+1 fetched in background while browsing page N
- **No HTML caching** — `Cache-Control: no-cache` on HTML to prevent stale frontend

### Card data

Each ad card shows:
- Page name, ad body text (collapsible at 200 chars), creative image
- **Angle zone**: messaging angle label + status badge (scaling/proven/testing/generic) + velocity (/wk)
- Competitor name, days active, platform tags
- EU reach + targeting (when available)
- Ad Library link, video play button (when video URL exists)

## Cache directory (`.cache/`)

| File | TTL | Purpose |
|------|-----|---------|
| `_ads_cache.json` | 8h | Full ad data |
| `_angles.json` | Permanent | Claude angle categorization results |
| `_video_urls.json` | Permanent | fbcdn video URL index |
| `_watchlist.json` | Permanent | Tracked competitors list |
| `_discover_cache.json` | 12h | Discovery auto-scan results |
| `_sc_fetch_log.json` | 24h per page | ScrapeCreators fetch timestamps |
| `_eu_pages.json` | 7d per page | EU data availability log |
| `{adId}/creative.jpg` | Permanent | Cached ad images |
| `{adId}/avatar.jpg` | Permanent | Cached page avatars |
| `{adId}/meta.json` | Permanent | Extracted metadata |

## Known issues

- Express 5 `res.sendFile()` broken with absolute paths — all image serving uses `fs.createReadStream().pipe(res)` instead
- Video play buttons only appear for ads with actual video URLs in the index (not just `ad_format=video`)
- `scrape-http.js` exists but is not integrated — needs residential proxy to bypass Facebook's JS challenge on datacenter IPs

## Access

- **URL**: http://135.181.153.92:3001
- **Password**: set via `APP_PASSWORD` env var
- **SSH**: port 2223, key-only auth
- **GitHub**: github.com/alexandrvakulsky-ux/ad-spy (private)
- **Deploy key**: `/tmp/ad-spy-deploy-key-v2` on host → copy to `/tmp/dk` in container
