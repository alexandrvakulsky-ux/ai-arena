require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { scrapePageAds, closeBrowser } = require('./scrape-ad-library');

const app = express();
const PORT = process.env.PORT || 3001;
const APP_PASSWORD = process.env.APP_PASSWORD || null;
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const FB_TOKEN = process.env.FB_ACCESS_TOKEN || null;
const SCRAPECREATORS_KEY = process.env.SCRAPECREATORS_KEY || null;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;
const CACHE_DIR = path.join(__dirname, '.cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
app.use('/cache', express.static(CACHE_DIR));

// ── Tracked competitors (persisted to disk) ──
const WATCHLIST_FILE = path.join(CACHE_DIR, '_watchlist.json');
const GROUPS = ['Digital Security', 'Genesis'];
const DEFAULT_GROUP = 'Digital Security';

const DEFAULT_COMPETITORS = [
  { name: 'Guardio', page_ids: ['158998401556095', '111528308485597', '819741011218433', '460540013819263'], type: 'direct', group: 'Digital Security' },
  { name: 'Cloaked', page_ids: ['227489754460079'], type: 'direct', group: 'Digital Security' },
  { name: 'Clario', page_ids: ['238758245984539', '217094471491676'], type: 'indirect', group: 'Digital Security' },
  { name: 'Malwarebytes', page_ids: ['101480776638'], type: 'direct', group: 'Digital Security' },
  { name: 'Control+', page_ids: ['554471337751787'], type: 'direct', group: 'Digital Security' },
  { name: 'LifeLock by Norton', page_ids: ['20225782952'], type: 'direct', group: 'Digital Security' },
  { name: 'Privacyhawk', page_ids: ['151020227103200'], type: 'direct', group: 'Digital Security' },
  { name: 'Omniwatch', page_ids: ['100703373114790'], type: 'direct', group: 'Digital Security' },
  { name: 'KnowBe4', page_ids: ['167390746617042'], type: 'direct', group: 'Digital Security' },
  { name: 'Alert Marko', page_ids: ['723094277553642'], type: 'creative', group: 'Digital Security' },
];

function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      const list = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
      // Migrate: any competitor without group defaults to Digital Security
      let migrated = false;
      for (const c of list) {
        if (!c.group) { c.group = DEFAULT_GROUP; migrated = true; }
      }
      if (migrated) try { fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2)); } catch {}
      return list;
    }
  } catch {}
  return DEFAULT_COMPETITORS;
}
function saveWatchlist(list) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
}
let COMPETITORS = loadWatchlist();

// ── Auth ──
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.headers['x-app-token'] === SESSION_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/auth', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, token: SESSION_TOKEN });
  const { password } = req.body;
  if (typeof password !== 'string') return res.status(400).json({ ok: false, error: 'Invalid input' });
  if (password === APP_PASSWORD) return res.json({ ok: true, token: SESSION_TOKEN });
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

app.get('/api/verify', requireAuth, (_req, res) => res.json({ ok: true }));
// Track image cache count incrementally instead of scanning fs on every health check
let _imageCacheCount = 0;
function updateImageCacheCount() {
  if (!adCache.data) return;
  let c = 0;
  adCache.data.forEach(a => {
    if (fs.existsSync(path.join(CACHE_DIR, a.id, 'creative.jpg')) || fs.existsSync(path.join(CACHE_DIR, `${a.id}.jpg`))) c++;
  });
  _imageCacheCount = c;
}

app.get('/health', (_req, res) => {
  const total = adCache.data ? adCache.data.length : 0;
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), competitors: COMPETITORS.length, ads: total, images_cached: _imageCacheCount, images_missing: total - _imageCacheCount });
});

// ── Ad Library API ──
const API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';
const AD_FIELDS = [
  'id', 'ad_creation_time', 'ad_delivery_start_time', 'ad_delivery_stop_time',
  'ad_creative_bodies', 'ad_creative_link_captions', 'ad_creative_link_descriptions',
  'ad_creative_link_titles', 'ad_snapshot_url', 'page_id', 'page_name',
  'publisher_platforms', 'estimated_audience_size', 'languages'
].join(',');

const COUNTRIES = ['US'];
const EU_COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'NL', 'PL'];
const EU_FIELDS = 'id,eu_total_reach,target_ages,target_gender,target_locations,beneficiary_payers';

function normalizeDate(d) {
  if (!d) return null;
  if (typeof d === 'number') return d < 1e10 ? new Date(d * 1000).toISOString().slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  return d;
}

function calcDaysRunning(start, stop) {
  if (!start) return 0;
  const s = normalizeDate(start);
  const e = normalizeDate(stop) || Date.now();
  return Math.max(0, Math.round((new Date(e) - new Date(s)) / 86400000));
}

function scoreAd(ad) {
  const days = ad.days_running;
  const platforms = (ad.platforms || []).length;
  const isActive = !ad.stopped;

  // Longevity: 40% — max at 90+ days
  const longevity = Math.min(days / 90, 1) * 40;
  // Cross-platform: 20% — max at 3+ platforms
  const crossPlatform = Math.min(platforms / 3, 1) * 20;
  // Active bonus: 15%
  const activeBonus = isActive ? 15 : 0;
  // Cross-page presence (filled in at competitor level)
  const crossPage = (ad._crossPageScore || 0) * 15;
  // Recency: 10% — newer start date gets higher score
  const daysSinceStart = Math.max(0, Math.round((Date.now() - new Date(ad.started || 0)) / 86400000));
  const recency = daysSinceStart < 365 ? (1 - daysSinceStart / 365) * 10 : 0;

  return Math.round(longevity + crossPlatform + activeBonus + crossPage + recency);
}

function normalizeAd(raw) {
  // Check cached meta for format info
  let adFormat = 'image';
  const metaPath = path.join(CACHE_DIR, String(raw.id), 'meta.json');
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.ad_format) adFormat = meta.ad_format;
    }
  } catch {}

  const ad = {
    id: raw.id,
    page_name: raw.page_name || 'Unknown',
    page_id: raw.page_id,
    body: (raw.ad_creative_bodies || [])[0] || '',
    title: (raw.ad_creative_link_titles || [])[0] || '',
    description: (raw.ad_creative_link_descriptions || [])[0] || '',
    caption: (raw.ad_creative_link_captions || [])[0] || '',
    snapshot_url: raw.ad_snapshot_url || null,
    platforms: raw.publisher_platforms || [],
    audience: raw.estimated_audience_size || null,
    languages: raw.languages || [],
    started: raw.ad_delivery_start_time || null,
    stopped: raw.ad_delivery_stop_time || null,
    created: raw.ad_creation_time || null,
    days_running: calcDaysRunning(raw.ad_delivery_start_time, raw.ad_delivery_stop_time),
    is_active: !raw.ad_delivery_stop_time,
    ad_format: adFormat,
  };
  ad.score = scoreAd(ad);
  return ad;
}

async function fetchAdsForPage(pageId, country = 'US') {
  const params = new URLSearchParams({
    access_token: FB_TOKEN,
    ad_reached_countries: `['${country}']`,
    search_page_ids: pageId,
    ad_type: 'ALL',
    fields: AD_FIELDS,
    limit: '100'
  });

  const allAds = [];
  let url = `${API_BASE}?${params}`;
  let pages = 0;

  while (url && pages < 25) {
    const res = await fetch(url, { timeout: 30000 });
    const data = await res.json();
    if (data.error) break;
    if (data.data) allAds.push(...data.data);
    url = data.paging?.next || null;
    pages++;
  }

  return allAds;
}

// ── EU data enrichment (reach, targeting, payer info) ──
async function fetchEuDataForPage(pageId) {
  const euData = new Map();
  for (const country of EU_COUNTRIES) {
    const params = new URLSearchParams({
      access_token: FB_TOKEN,
      ad_reached_countries: `['${country}']`,
      search_page_ids: pageId,
      ad_type: 'ALL',
      ad_active_status: 'active',
      fields: EU_FIELDS,
      limit: '100'
    });
    let url = `${API_BASE}?${params}`;
    let pages = 0;
    while (url && pages < 3) {
      try {
        const res = await fetch(url, { timeout: 15000 });
        const data = await res.json();
        if (data.error) break;
        for (const ad of (data.data || [])) {
          if (!euData.has(ad.id)) {
            euData.set(ad.id, {
              eu_total_reach: ad.eu_total_reach || 0,
              target_ages: ad.target_ages || null,
              target_gender: ad.target_gender || null,
              target_locations: ad.target_locations || null,
              beneficiary_payers: ad.beneficiary_payers || null
            });
          } else {
            const existing = euData.get(ad.id);
            existing.eu_total_reach = Math.max(existing.eu_total_reach, ad.eu_total_reach || 0);
          }
        }
        url = data.paging?.next || null;
      } catch { break; }
      pages++;
    }
  }
  return euData;
}

// ── ScrapeCreators fallback (scrapes Ad Library website via commercial API) ──
const VIDEO_URLS_FILE = path.join(CACHE_DIR, '_video_urls.json');

function loadVideoIndex() {
  try { return fs.existsSync(VIDEO_URLS_FILE) ? JSON.parse(fs.readFileSync(VIDEO_URLS_FILE, 'utf8')) : {}; } catch { return {}; }
}
function saveVideoIndex(idx) {
  try { fs.writeFileSync(VIDEO_URLS_FILE, JSON.stringify(idx)); } catch {}
}

// Track when we last fetched each page via ScrapeCreators (avoid re-fetching every 8h)
const SC_FETCH_LOG_FILE = path.join(CACHE_DIR, '_sc_fetch_log.json');
let scFetchLog = {};
try { if (fs.existsSync(SC_FETCH_LOG_FILE)) scFetchLog = JSON.parse(fs.readFileSync(SC_FETCH_LOG_FILE, 'utf8')); } catch {}
const SC_REFETCH_INTERVAL = 4 * 60 * 60 * 1000; // Only re-fetch via SC every 4h

async function fetchAdsViaScrapeCreators(pageId) {
  if (!SCRAPECREATORS_KEY) return null;
  const allAds = [];
  let cursor = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ pageId });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(
      `https://api.scrapecreators.com/v1/facebook/adLibrary/company/ads?${params}`,
      { headers: { 'x-api-key': SCRAPECREATORS_KEY }, timeout: 30000 }
    );
    const data = await res.json();
    if (data.error) { console.error(`   [scrapecreators] Error: ${data.error}`); break; }

    const results = data.results || data.searchResults || [];
    allAds.push(...results);
    cursor = data.cursor || null;
    pages++;
    if (pages > 25) break; // Safety cap
  } while (cursor);

  return allAds;
}

function normalizeScrapeCreatorsAd(raw) {
  // ScrapeCreators returns the same schema as the Ad Library's internal JSON
  const snap = raw.snapshot || raw;
  const id = String(raw.ad_archive_id || raw.id || '');
  if (!id) return null;

  const bodyText = snap.body?.text || (typeof snap.body === 'string' ? snap.body : '') || '';
  let images = (snap.images || []).map(i => i.original_image_url || '').filter(Boolean);
  const videos = snap.videos || [];
  const cards = (snap.cards || []).filter(c => c && (c.title || c.body || c.original_image_url));
  const videoHd = videos[0]?.video_hd_url || null;
  const videoSd = videos[0]?.video_sd_url || null;

  // For carousels with no main image, use first card's image
  if (images.length === 0 && cards.length > 0) {
    const cardImgs = cards.map(c => c.original_image_url || c.image_url || '').filter(Boolean);
    if (cardImgs.length > 0) images = cardImgs;
  }
  const videoThumb = videos[0]?.video_preview_image_url || null;

  let adFormat = 'image';
  const fmt = (snap.display_format || '').toUpperCase();
  if (fmt === 'VIDEO' || videoHd || videoSd) adFormat = 'video';
  else if (fmt === 'DCO' || cards.length > 1) adFormat = 'carousel';

  const startDate = normalizeDate(raw.start_date || raw.ad_delivery_start_time || null);
  const endDate = normalizeDate(raw.end_date || raw.ad_delivery_stop_time || null);

  return {
    id,
    page_name: snap.page_name || raw.page_name || 'Unknown',
    page_id: String(snap.page_id || raw.page_id || ''),
    body: bodyText,
    title: snap.title || '',
    description: snap.link_description || '',
    caption: snap.caption || '',
    snapshot_url: `https://www.facebook.com/ads/library/?id=${id}`,
    platforms: Array.isArray(raw.publisher_platform) ? raw.publisher_platform.map(p => String(p).toLowerCase()) : [],
    audience: null,
    languages: [],
    started: startDate,
    stopped: endDate || null,
    created: startDate,
    days_running: calcDaysRunning(startDate, endDate),
    is_active: raw.is_active !== undefined ? !!raw.is_active : !endDate,
    ad_format: adFormat,
    cta_text: snap.cta_text || '',
    link_url: snap.link_url || '',
    _images: images,
    _video_hd_url: videoHd,
    _video_sd_url: videoSd,
    _video_thumb_url: videoThumb,
  };
}

// ── Persistent disk cache for API results ──
const AD_CACHE_FILE = path.join(CACHE_DIR, '_ads_cache.json');
const CACHE_TTL = 8 * 60 * 60 * 1000; // 8 hours
let adCache = { data: null, timestamp: 0 };

// Load cache from disk on startup — always load even if stale (stale-while-revalidate)
try {
  if (fs.existsSync(AD_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(AD_CACHE_FILE, 'utf8'));
    if (saved.timestamp && saved.data) {
      adCache = saved;
      // Backfill _group on cached ads based on competitor lookup
      const compGroupMap = {};
      for (const c of COMPETITORS) compGroupMap[c.name] = c.group || DEFAULT_GROUP;
      for (const ad of adCache.data) {
        if (!ad._group) ad._group = compGroupMap[ad._competitor] || DEFAULT_GROUP;
      }
      if (adCache.data && Object.keys(anglesCache).length > 0) applyAngles(adCache.data);
      const ageH = Math.round((Date.now() - saved.timestamp) / 3600000);
      const fresh = Date.now() - saved.timestamp < CACHE_TTL;
      console.log(`   Cache loaded: ${saved.data.length} ads (${ageH}h old${fresh ? '' : ', stale — will refresh on first request'})`);
    }
  }
} catch {}

function saveCache() {
  try { fs.writeFileSync(AD_CACHE_FILE, JSON.stringify({ data: adCache.data, timestamp: adCache.timestamp })); } catch {}
}

// ── Angle categorization via Claude API ──
const ANGLES_CACHE_FILE = path.join(CACHE_DIR, '_angles.json');
let anglesCache = {};
try { if (fs.existsSync(ANGLES_CACHE_FILE)) anglesCache = JSON.parse(fs.readFileSync(ANGLES_CACHE_FILE, 'utf8')); } catch {}
function saveAnglesCache() { try { fs.writeFileSync(ANGLES_CACHE_FILE, JSON.stringify(anglesCache)); } catch {} }

// Categorize a small batch of ads on-demand (called when serving a page)
let _categorizing = false;
let _lastCategorizeTime = 0;
const CATEGORIZE_COOLDOWN = 10000; // Min 10s between Claude calls

function categorizePageAds(ads) {
  if (!ANTHROPIC_KEY || _categorizing) return;
  if (Date.now() - _lastCategorizeTime < CATEGORIZE_COOLDOWN) return;
  const uncategorized = ads.filter(a => !anglesCache[a.id] && a.body && a.body.length > 20);
  if (uncategorized.length === 0) return;

  // Fire and forget — don't block the response
  _categorizing = true;
  _lastCategorizeTime = Date.now();
  _categorizeAdsBatch(uncategorized).then(() => { _categorizing = false; }).catch(() => { _categorizing = false; });
}

async function _categorizeAdsBatch(ads) {
  const adList = ads.map((a, idx) => `[${idx}] (${a._competitor}) ${(a.body || '').substring(0, 200)}`).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You analyze Facebook ads for cybersecurity/privacy products. For each ad below, return a JSON array where each element has:
- "i": the ad index number
- "angle": a 2-4 word label for the messaging angle (e.g. "Phone Spying Fear", "Wi-Fi Security", "Bank Scam Alert", "Identity Theft", "Data Broker Exposure", "VPN Privacy", "Password Security", "Device Protection", "Dark Web Alert", "App Permissions")
- "status": one of "scaling" (many variants/aggressive push), "testing" (few variants), "proven" (running long), "generic" (standard/boring copy)

Only return the JSON array, nothing else.

Ads:
${adList}`
        }]
      }),
      timeout: 30000
    });

    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    try {
      const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]');
      for (const item of parsed) {
        const ad = ads[item.i];
        if (ad && item.angle) {
          anglesCache[ad.id] = { angle: item.angle, status: item.status || 'testing', ts: Date.now() };
        }
      }
    } catch {}

    saveAnglesCache();
    // Apply to in-memory cache so next request gets them
    if (adCache.data) applyAngles(adCache.data);
    console.log(`   [angles] ${ads.length} ads categorized on-demand`);
  } catch (err) {
    console.error(`   [angles] Error: ${err.message}`);
  }
}

function applyAngles(ads) {
  for (const ad of ads) {
    const cached = anglesCache[ad.id];
    if (cached) {
      ad.angle = cached.angle;
      ad.angle_status = cached.status;
    }
  }

  // Compute variant velocity per angle per competitor
  const angleGroups = {};
  for (const ad of ads) {
    if (!ad.angle || !ad.is_active) continue;
    const key = `${ad._competitor}::${ad.angle}`;
    if (!angleGroups[key]) angleGroups[key] = { count: 0, newest: null, oldest: null };
    const g = angleGroups[key];
    g.count++;
    const started = ad.started ? new Date(ad.started) : null;
    if (started) {
      if (!g.newest || started > g.newest) g.newest = started;
      if (!g.oldest || started < g.oldest) g.oldest = started;
    }
  }

  // Update status based on variant velocity
  for (const ad of ads) {
    if (!ad.angle || !ad.is_active) continue;
    const key = `${ad._competitor}::${ad.angle}`;
    const g = angleGroups[key];
    if (!g) continue;

    const daySpan = g.oldest && g.newest ? Math.max(1, (g.newest - g.oldest) / 86400000) : 1;
    ad.angle_variant_count = g.count;
    ad.angle_velocity = Math.round(g.count / daySpan * 7 * 10) / 10; // variants per week

    // Override status with data-driven assessment
    if (g.count >= 10 && ad.angle_velocity >= 3) ad.angle_status = 'scaling';
    else if (g.count >= 5 && ad.days_running >= 30) ad.angle_status = 'proven';
    else if (g.count <= 3 && ad.days_running <= 14) ad.angle_status = 'testing';
  }
}

// ── Smart fallback detection: is the Meta API suppressing this competitor? ──
const SUPPRESSION_MARKERS = [
  'without a disclaimer',
  'without a required disclaimer',
  'content was removed',
  'this ad was removed',
  'violated our advertising policies'
];

function detectApiSuppression(ads, totalCount, comp) {
  // Search-only competitor (no page IDs) — can't fallback
  if (comp.page_ids.length === 0) return { triggered: false };

  // Signal 1: Very few or zero ads from API — always try fallback
  if (totalCount < 5) return { triggered: true, reason: `only ${totalCount} ads from API` };

  // Signal 2: Most ads are policy-removed junk
  const removedCount = ads.filter(a => {
    const body = (a.body || '').toLowerCase();
    return SUPPRESSION_MARKERS.some(m => body.includes(m));
  }).length;
  const removedPct = ads.length > 0 ? removedCount / ads.length : 0;
  if (removedPct > 0.5) {
    return { triggered: true, reason: `${Math.round(removedPct * 100)}% of ads are policy-removed` };
  }

  // Signal 3: All ads inactive but competitor is known active (has multiple page IDs = serious advertiser)
  const activeCount = ads.filter(a => a.is_active).length;
  if (ads.length > 0 && activeCount === 0 && ads.length < 50) {
    return { triggered: true, reason: `0 active ads out of ${ads.length} — likely suppressed` };
  }

  // Signal 4: Low count with suspicious ratio (few ads but all very old)
  if (totalCount < 20 && ads.length > 0) {
    const avgDays = ads.reduce((s, a) => s + (a.days_running || 0), 0) / ads.length;
    if (avgDays > 365) {
      return { triggered: true, reason: `only ${totalCount} ads, avg ${Math.round(avgDays)} days old — stale results` };
    }
  }

  return { triggered: false };
}

let _bgRefreshInProgress = false;

async function getAllAds() {
  if (adCache.data && Date.now() - adCache.timestamp < CACHE_TTL) return adCache.data;

  // Stale-while-revalidate: if we have stale data, return it and refresh in background
  if (adCache.data && !_bgRefreshInProgress) {
    _bgRefreshInProgress = true;
    _refreshAdsInBackground().finally(() => { _bgRefreshInProgress = false; });
    return adCache.data;
  }
  // If background refresh is already running, return whatever we have
  if (adCache.data && _bgRefreshInProgress) return adCache.data;

  // No cache at all — must fetch synchronously (first ever load)
  return _fetchAllAdsFresh();
}

async function _refreshAdsInBackground() {
  try {
    console.log('   [bg-refresh] Starting background refresh...');
    const result = await _fetchAllAdsFresh();
    console.log(`   [bg-refresh] Done — ${result.length} ads cached`);
    // After refresh, kick off image extraction prioritizing new ads
    triggerImageExtraction(result).catch(() => {});
  } catch (err) {
    console.error('   [bg-refresh] Failed:', err.message);
  }
}

// Prioritize image extraction: new ads (last 3 days) first by newest, then rest by score
async function triggerImageExtraction(ads) {
  const previews = require('./extract-previews');
  // Fast CDN precache for anything with _images
  const withImages = ads.filter(a => a._images && a._images.length > 0).sort((a, b) => b.score - a.score).slice(0, 500);
  if (withImages.length > 0) precacheImages(withImages).catch(() => {});

  const videoIdx = loadVideoIndex();
  const needPreview = ads.filter(a => {
    if (!a.snapshot_url || !a.is_active) return false;
    const hasImg = fs.existsSync(path.join(CACHE_DIR, a.id, 'creative.jpg')) || fs.existsSync(path.join(CACHE_DIR, `${a.id}.jpg`));
    const needsImg = !hasImg;
    const needsVideoUrl = a.ad_format === 'video' && !videoIdx[a.id] && !a._video_hd_url && !a._video_sd_url;
    return needsImg || needsVideoUrl;
  });
  const cutoff = Date.now() - 3 * 86400000;
  const newAds = needPreview.filter(a => new Date(a.started || 0) > cutoff)
    .sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0));
  const oldAds = needPreview.filter(a => new Date(a.started || 0) <= cutoff)
    .sort((a, b) => b.score - a.score);
  const ordered = [...newAds, ...oldAds];
  if (ordered.length > 0) console.log(`   [puppeteer] ${ordered.length} ads need screenshots (${newAds.length} fresh <3d prioritized first)`);
  previews.run(ordered).catch(() => {});
}

async function _fetchAllAdsFresh() {
  const allAds = new Map();
  // Preserve previous cache's SC-sourced ads so we don't lose them when SC is throttled
  const prevScAds = new Map();
  if (adCache.data) {
    for (const ad of adCache.data) {
      if (ad._source === 'scrapecreators' || ad._source === 'scrapecreators-cached') prevScAds.set(ad.id, ad);
    }
  }

  for (const comp of COMPETITORS) {
    let compTotal = 0;
    for (const pageId of comp.page_ids) {
      for (const country of COUNTRIES) {
        try {
          const raw = await fetchAdsForPage(pageId, country);
          let newCount = 0;
          for (const ad of raw) {
            if (!allAds.has(ad.id)) {
              const normalized = normalizeAd(ad);
              normalized._competitor = comp.name;
              normalized._competitorType = comp.type;
              normalized._group = comp.group || DEFAULT_GROUP;
              allAds.set(ad.id, normalized);
              newCount++;
            }
          }
          compTotal += newCount;
          if (raw.length > 0) console.log(`   ${comp.name} page ${pageId} (${country}): ${raw.length} fetched, ${newCount} new`);
        } catch (err) {
          console.error(`   ${comp.name} page ${pageId} (${country}): ERROR - ${err.message}`);
        }
      }
    }
    // Analyze API result quality to detect suppression
    const compAds = [...allAds.values()].filter(a => a._competitor === comp.name);
    const suppression = detectApiSuppression(compAds, compTotal, comp);
    console.log(`   → ${comp.name}: ${compTotal} total ads (API)${suppression.triggered ? ' ⚠ ' + suppression.reason : ''}`);

    // Fallback: if API results look suppressed or incomplete
    if (suppression.triggered && comp.page_ids.length > 0) {
      const videoIndex = loadVideoIndex();
      let fallbackTotal = 0;

      for (const pageId of comp.page_ids) {
        let fallbackAds = null;

        // Priority 1: ScrapeCreators commercial API (full pagination, all ads)
        const scLastFetch = scFetchLog[pageId] || 0;
        const scFresh = Date.now() - scLastFetch < SC_REFETCH_INTERVAL;
        let usedSource = null;

        if (SCRAPECREATORS_KEY && !scFresh) {
          try {
            console.log(`   ${comp.name}: API returned only ${compTotal}, trying ScrapeCreators...`);
            const raw = await fetchAdsViaScrapeCreators(pageId);
            if (raw && raw.length > 0) {
              fallbackAds = raw.map(normalizeScrapeCreatorsAd).filter(Boolean);
              usedSource = 'scrapecreators';
              console.log(`   ${comp.name}: ScrapeCreators returned ${fallbackAds.length} ads for page ${pageId}`);
            }
            scFetchLog[pageId] = Date.now();
            try { fs.writeFileSync(SC_FETCH_LOG_FILE, JSON.stringify(scFetchLog)); } catch {}
          } catch (err) {
            console.error(`   ${comp.name}: ScrapeCreators error - ${err.message}`);
          }
        } else if (scFresh) {
          // SC throttled — reuse previous cache's SC ads for this page to avoid data loss
          const reused = [...prevScAds.values()].filter(a => a.page_id === pageId);
          if (reused.length > 0) {
            fallbackAds = reused;
            usedSource = 'scrapecreators-cached';
            console.log(`   ${comp.name}: SC throttled (${Math.round((Date.now() - scLastFetch) / 3600000)}h ago), reusing ${reused.length} previous SC ads for page ${pageId}`);
          }
        }

        // Priority 2: Puppeteer HTML scraper (only if no SC data, fresh or cached)
        if (!fallbackAds || fallbackAds.length === 0) {
          try {
            console.log(`   ${comp.name}: No SC data, trying Puppeteer scraper...`);
            fallbackAds = await scrapePageAds(pageId);
            usedSource = 'puppeteer';
          } catch (err) {
            console.error(`   ${comp.name}: Puppeteer scraper error - ${err.message}`);
            fallbackAds = [];
          }
        }

        // Merge fallback results
        let newCount = 0;
        for (const ad of fallbackAds) {
          if (ad && ad.id && !allAds.has(ad.id)) {
            ad._competitor = comp.name;
            ad._competitorType = comp.type;
            ad._group = comp.group || DEFAULT_GROUP;
            ad._source = usedSource || 'puppeteer';
            ad.score = scoreAd(ad);
            allAds.set(ad.id, ad);
            newCount++;
            if (ad._video_hd_url || ad._video_sd_url) {
              videoIndex[ad.id] = { hd: ad._video_hd_url, sd: ad._video_sd_url, thumb: ad._video_thumb_url };
            }
          }
        }
        fallbackTotal += newCount;
        if (newCount > 0) console.log(`   ${comp.name}: fallback found ${newCount} additional ads for page ${pageId}`);
      }

      if (fallbackTotal > 0) saveVideoIndex(videoIndex);
    }
  }

  // Clean up browser after all scraping is done
  closeBrowser().catch(() => {});

  // Calculate cross-page scores
  const pageCountByComp = {};
  for (const ad of allAds.values()) {
    const key = ad._competitor;
    if (!pageCountByComp[key]) pageCountByComp[key] = new Set();
    pageCountByComp[key].add(ad.page_id);
  }
  for (const ad of allAds.values()) {
    const pages = pageCountByComp[ad._competitor]?.size || 1;
    ad._crossPageScore = Math.min(pages / 4, 1);
    ad.score = scoreAd(ad);
  }

  // EU data enrichment — only query pages known to have EU ads (or never checked)
  const EU_LOG_FILE = path.join(CACHE_DIR, '_eu_pages.json');
  let euPageLog = {};
  try { if (fs.existsSync(EU_LOG_FILE)) euPageLog = JSON.parse(fs.readFileSync(EU_LOG_FILE, 'utf8')); } catch {}

  const uniquePages = new Set();
  for (const ad of allAds.values()) {
    if (ad.is_active && ad.page_id) uniquePages.add(ad.page_id);
  }

  const pagesToCheck = [...uniquePages].filter(pid => {
    const log = euPageLog[pid];
    if (!log) return true; // Never checked
    if (log.hasData) return true; // Has EU ads, re-fetch
    if (Date.now() - log.ts > 7 * 24 * 60 * 60 * 1000) return true; // Re-check weekly
    return false; // Known to have no EU ads, skip
  });

  if (pagesToCheck.length > 0) {
    console.log(`   Fetching EU data for ${pagesToCheck.length} pages (skipping ${uniquePages.size - pagesToCheck.length} known-empty)...`);
    for (const pageId of pagesToCheck) {
      try {
        const euData = await fetchEuDataForPage(pageId);
        euPageLog[pageId] = { ts: Date.now(), hasData: euData.size > 0 };
        if (euData.size > 0) {
          let enriched = 0;
          for (const [adId, eu] of euData) {
            const ad = allAds.get(adId);
            if (ad) {
              ad.eu_total_reach = eu.eu_total_reach;
              ad.target_ages = eu.target_ages;
              ad.target_gender = eu.target_gender;
              ad.target_locations = eu.target_locations;
              ad.beneficiary_payers = eu.beneficiary_payers;
              enriched++;
            }
          }
          if (enriched > 0) console.log(`   EU data: ${enriched} ads enriched for page ${pageId}`);
        }
      } catch {}
    }
    try { fs.writeFileSync(EU_LOG_FILE, JSON.stringify(euPageLog)); } catch {}
  } else {
    console.log('   EU data: all pages checked recently, skipping');
    // Still apply cached EU data from the ad objects (already in allAds from previous cache)
  }

  const result = [...allAds.values()];

  adCache.data = result;
  adCache.timestamp = Date.now();
  rebuildAdIndex();
  saveCache();
  updateImageCacheCount();

  // Batch download images for scraped ads in background (non-blocking)
  const needsDownload = result.filter(a =>
    (a._images?.length > 0 || a._video_thumb_url) &&
    !fs.existsSync(path.join(CACHE_DIR, a.id, 'creative.jpg')) &&
    !fs.existsSync(path.join(CACHE_DIR, `${a.id}.jpg`))
  );
  if (needsDownload.length > 0) {
    console.log(`   [precache] Downloading images for ${needsDownload.length} ads...`);
    precacheImages(needsDownload).catch(() => {});
  }

  return result;
}

// ── API Endpoints ──

app.get('/api/competitors', requireAuth, (_req, res) => {
  res.json({ competitors: COMPETITORS, groups: GROUPS });
});

// ── Discovery: search for potential competitors by keyword ──
const DISCOVER_CACHE_FILE = path.join(CACHE_DIR, '_discover_cache.json');
const DISCOVER_TTL = 12 * 60 * 60 * 1000; // 12 hours
let discoverCache = { data: null, timestamp: 0 };
try {
  if (fs.existsSync(DISCOVER_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DISCOVER_CACHE_FILE, 'utf8'));
    if (saved.timestamp && Date.now() - saved.timestamp < DISCOVER_TTL) discoverCache = saved;
  }
} catch {}

// ── Discovery shared helpers ──
const RELEVANCE_TERMS = ['security', 'cybersecurity', 'malware', 'virus', 'vpn', 'identity theft', 'data breach', 'phishing', 'ransomware', 'spyware', 'antivirus', 'dark web', 'data leak', 'password manager', 'browser protection', 'scam protection', 'online protection', 'digital security', 'privacy protection', 'ad blocker', 'hacker', 'cyber threat', 'encryption', 'fraud protection', 'identity protection', 'online safety'];
const BLOCKLIST_TERMS = ['novel', 'fiction', 'story', 'stories', 'chapter', 'book', 'read', 'reading', 'romance', 'love', 'dating', 'recipe', 'cooking', 'game', 'gaming', 'casino', 'bet', 'horoscope', 'zodiac', 'manga', 'anime', 'comic', 'poem', 'wattpad', 'fanfic'];
const AUTO_DISCOVER_QUERIES = [
  'protect your phone', 'protect your device', 'online scam', 'identity theft',
  'VPN', 'antivirus app', 'password manager', 'data breach alert',
  'browser extension security', 'ad blocker', 'malware protection',
  'dark web scan', 'credit monitoring', 'fraud alert', 'cyber attack',
  'phishing email', 'secure browsing', 'digital privacy', 'tracker blocker',
  'Norton', 'McAfee', 'Bitdefender', 'Kaspersky', 'Surfshark', 'ExpressVPN',
  'Aura identity', 'DeleteMe', 'Incogni', 'Total AV', 'Avast'
];

async function searchAdLibrary(queries, maxPages = 3) {
  const pageMap = new Map();
  for (const q of queries) {
    let url = `${API_BASE}?${new URLSearchParams({
      access_token: FB_TOKEN, search_terms: q, ad_type: 'ALL',
      ad_reached_countries: "['US']", ad_active_status: 'active',
      fields: 'page_id,page_name,publisher_platforms,ad_creative_bodies,ad_delivery_start_time',
      limit: '100'
    })}`;
    let pages = 0;
    while (url && pages < maxPages) {
      try {
        const r = await fetch(url, { timeout: 20000 });
        const d = await r.json();
        if (d.error) break;
        for (const ad of (d.data || [])) {
          const pid = ad.page_id;
          if (!pid) continue;
          if (!pageMap.has(pid)) pageMap.set(pid, { page_name: ad.page_name, ads: [], platforms: new Set(), bodies: new Set(), queries: new Set() });
          const pg = pageMap.get(pid);
          pg.ads.push(ad);
          pg.queries.add(q);
          (ad.publisher_platforms || []).forEach(p => pg.platforms.add(p));
          const body = (ad.ad_creative_bodies || [])[0] || '';
          if (body.length > 20) pg.bodies.add(body.substring(0, 80));
        }
        url = d.paging?.next || null;
      } catch { break; }
      pages++;
    }
  }
  return pageMap;
}

function filterAndRankPages(pageMap, minActive) {
  const watchedIds = new Set(COMPETITORS.flatMap(c => c.page_ids));
  const results = [];
  for (const [pid, pg] of pageMap) {
    if (pg.ads.length < minActive) continue;
    const allText = (pg.page_name + ' ' + pg.ads.map(a => ((a.ad_creative_bodies || [])[0] || '')).join(' ')).toLowerCase();
    const pageLower = pg.page_name.toLowerCase();
    if (BLOCKLIST_TERMS.some(t => pageLower.includes(t) || allText.split(' ').filter(w => w === t).length > 3)) continue;
    if (!RELEVANCE_TERMS.some(t => allText.includes(t))) continue;

    const dates = pg.ads.map(a => a.ad_delivery_start_time).filter(Boolean).sort();
    const last30 = pg.ads.filter(a => a.ad_delivery_start_time && (Date.now() - new Date(a.ad_delivery_start_time)) < 30 * 86400000).length;
    results.push({
      page_id: pid, page_name: pg.page_name, active_ads: pg.ads.length,
      platforms: [...pg.platforms], unique_angles: pg.bodies.size, new_last_30d: last30,
      oldest_ad: dates[0] || null, newest_ad: dates[dates.length - 1] || null,
      sample_texts: [...pg.bodies].slice(0, 5), matched_queries: [...pg.queries],
      is_tracked: watchedIds.has(pid)
    });
  }
  return results.sort((a, b) => b.active_ads - a.active_ads);
}

// ── Manual keyword search ──
app.get('/api/discover', requireAuth, async (req, res) => {
  const { q, min_active = '10' } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: 'Search query required (min 2 chars)' });
  if (!FB_TOKEN) return res.status(500).json({ error: 'FB_ACCESS_TOKEN not configured' });
  try {
    const pageMap = await searchAdLibrary([q], 5);
    const results = filterAndRankPages(pageMap, parseInt(min_active) || 10);
    const totalAds = [...pageMap.values()].reduce((s, p) => s + p.ads.length, 0);
    res.json({ query: q, total_ads_scanned: totalAds, pages_found: pageMap.size, results_above_min: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto-discover: cached broad scan ──
app.get('/api/discover/auto', requireAuth, async (req, res) => {
  if (!FB_TOKEN) return res.status(500).json({ error: 'FB_ACCESS_TOKEN not configured' });
  if (discoverCache.data && Date.now() - discoverCache.timestamp < DISCOVER_TTL) {
    const watchedIds = new Set(COMPETITORS.flatMap(c => c.page_ids));
    for (const r of discoverCache.data.results) r.is_tracked = watchedIds.has(r.page_id);
    return res.json(discoverCache.data);
  }
  try {
    const pageMap = await searchAdLibrary(AUTO_DISCOVER_QUERIES, 3);
    const results = filterAndRankPages(pageMap, 5);
    const response = {
      total_ads_scanned: [...pageMap.values()].reduce((s, p) => s + p.ads.length, 0),
      pages_found: pageMap.size, results_above_min: results.length,
      queries_run: AUTO_DISCOVER_QUERIES.length, cached_at: new Date().toISOString(), results
    };
    discoverCache = { data: response, timestamp: Date.now() };
    try { fs.writeFileSync(DISCOVER_CACHE_FILE, JSON.stringify(discoverCache)); } catch {}
    res.json(response);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Watchlist management ──
app.post('/api/watchlist/add', requireAuth, express.json(), (req, res) => {
  const { page_id, page_name, type = 'discovered', group } = req.body;
  if (!page_id || !page_name) return res.status(400).json({ error: 'page_id and page_name required' });
  const resolvedGroup = GROUPS.includes(group) ? group : DEFAULT_GROUP;

  // Check if already tracked
  if (COMPETITORS.some(c => c.page_ids.includes(page_id))) {
    return res.json({ ok: true, message: 'Already tracked' });
  }

  // Check if this page_name already exists (merge page IDs)
  const existing = COMPETITORS.find(c => c.name.toLowerCase() === page_name.toLowerCase());
  if (existing) {
    existing.page_ids.push(page_id);
  } else {
    COMPETITORS.push({ name: page_name, page_ids: [page_id], type, group: resolvedGroup });
  }

  saveWatchlist(COMPETITORS);

  // Clear ad cache so next fetch includes the new competitor
  adCache.data = null;
  adCache.timestamp = 0;

  res.json({ ok: true, competitors: COMPETITORS.length });
});

app.post('/api/watchlist/remove', requireAuth, express.json(), (req, res) => {
  const { page_id } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id required' });

  const idx = COMPETITORS.findIndex(c => c.page_ids.includes(page_id));
  if (idx === -1) return res.json({ ok: true, message: 'Not tracked' });

  const comp = COMPETITORS[idx];
  comp.page_ids = comp.page_ids.filter(id => id !== page_id);
  if (comp.page_ids.length === 0) COMPETITORS.splice(idx, 1);

  saveWatchlist(COMPETITORS);
  adCache.data = null;
  adCache.timestamp = 0;

  res.json({ ok: true, competitors: COMPETITORS.length });
});

// Strip heavy fields for list responses — frontend doesn't need internal data
function adForList(ad) {
  const o = {
    id: ad.id, page_name: ad.page_name, body: ad.body, title: ad.title,
    caption: ad.caption, platforms: ad.platforms, started: ad.started,
    stopped: ad.stopped, days_running: ad.days_running, is_active: ad.is_active,
    ad_format: ad.ad_format, score: ad.score, has_video: ad.has_video,
    _competitor: ad._competitor
  };
  if (ad.eu_total_reach) o.eu_total_reach = ad.eu_total_reach;
  if (ad.target_ages) o.target_ages = ad.target_ages;
  if (ad.target_gender) o.target_gender = ad.target_gender;
  if (ad.beneficiary_payers) o.beneficiary_payers = ad.beneficiary_payers;
  if (ad.angle) o.angle = ad.angle;
  if (ad.angle_status) o.angle_status = ad.angle_status;
  if (ad.angle_variant_count) o.angle_variant_count = ad.angle_variant_count;
  if (ad.angle_velocity) o.angle_velocity = ad.angle_velocity;
  return o;
}

app.get('/api/ads', requireAuth, async (req, res) => {
  if (!FB_TOKEN) return res.status(500).json({ error: 'FB_ACCESS_TOKEN not configured' });

  try {
    const allAds = await getAllAds();
    const { competitor, group, sort = 'score', active_only, page = '1', limit = '50' } = req.query;

    let ads = [...allAds];
    if (group) ads = ads.filter(a => (a._group || DEFAULT_GROUP).toLowerCase() === group.toLowerCase());
    if (competitor) ads = ads.filter(a => a._competitor.toLowerCase() === competitor.toLowerCase());
    if (active_only === 'true') ads = ads.filter(a => a.is_active);

    if (sort === 'score') ads.sort((a, b) => b.score - a.score);
    else if (sort === 'newest') ads.sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0));
    else if (sort === 'days') ads.sort((a, b) => b.days_running - a.days_running);

    // Competitor diversity: when not filtered to one competitor, interleave
    if (!competitor && sort === 'score') {
      ads = diversifyResults(ads);
    }

    // Annotate with video availability
    const vidIdx = loadVideoIndex();
    for (const ad of ads) {
      ad.has_video = !!(vidIdx[ad.id] || ad._video_hd_url || ad._video_sd_url);
    }

    const total = ads.length;
    const activeCount = ads.filter(a => a.is_active).length;
    const avgScore = total ? Math.round(ads.reduce((s, a) => s + a.score, 0) / total) : 0;

    // Paginate
    const p = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(200, Math.max(10, parseInt(limit) || 50));
    const start = (p - 1) * lim;
    const rawPage = ads.slice(start, start + lim);
    const pageAds = rawPage.map(adForList);

    // Trigger on-demand angle categorization for this page (non-blocking)
    categorizePageAds(rawPage);

    // Count per competitor and group (from full set)
    const compCounts = {};
    const groupCounts = {};
    for (const a of allAds) {
      compCounts[a._competitor] = (compCounts[a._competitor] || 0) + 1;
      const g = a._group || DEFAULT_GROUP;
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    }

    res.json({
      ads: pageAds,
      page: p,
      limit: lim,
      has_more: start + lim < total,
      stats: {
        total,
        active: activeCount,
        avg_score: avgScore,
        top_score: total ? ads[0].score : 0,
        per_competitor: compCounts,
        per_group: groupCounts
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ads/new', requireAuth, async (req, res) => {
  if (!FB_TOKEN) return res.status(500).json({ error: 'FB_ACCESS_TOKEN not configured' });

  try {
    const allAds = await getAllAds();
    const { competitor, group, active_only } = req.query;

    let ads = [...allAds];
    if (group) ads = ads.filter(a => (a._group || DEFAULT_GROUP).toLowerCase() === group.toLowerCase());
    if (competitor) ads = ads.filter(a => a._competitor.toLowerCase() === competitor.toLowerCase());
    if (active_only === 'true') ads = ads.filter(a => a.is_active);

    // New = started in last 3 days
    const cutoff = Date.now() - 3 * 86400000;
    ads = ads.filter(a => new Date(a.started || 0) > cutoff);
    ads.sort((a, b) => {
      const potA = (a.angle_velocity || 0) * (a.angle_variant_count || 1);
      const potB = (b.angle_velocity || 0) * (b.angle_variant_count || 1);
      if (potA !== potB) return potB - potA; // Higher potential first
      return new Date(b.started || 0) - new Date(a.started || 0); // Then newest
    });

    const vidIdx = loadVideoIndex();
    for (const ad of ads) {
      ad.has_video = !!(vidIdx[ad.id] || ad._video_hd_url || ad._video_sd_url);
    }

    const { page = '1', limit = '50' } = req.query;
    const total = ads.length;
    const p = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(200, Math.max(10, parseInt(limit) || 50));
    const start = (p - 1) * lim;

    const rawPageNew = ads.slice(start, start + lim);
    categorizePageAds(rawPageNew);

    // Count per competitor and group (from full set, not just new)
    const compCounts = {};
    const groupCounts = {};
    for (const a of allAds) {
      compCounts[a._competitor] = (compCounts[a._competitor] || 0) + 1;
      const g = a._group || DEFAULT_GROUP;
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    }

    res.json({
      ads: rawPageNew.map(adForList),
      page: p, limit: lim, has_more: start + lim < total,
      stats: { total, new_last_7d: ads.filter(a => new Date(a.started || 0) > Date.now() - 7 * 86400000).length, per_competitor: compCounts, per_group: groupCounts }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Competitor diversity: interleave results so one competitor doesn't dominate ──
function diversifyResults(ads) {
  const result = [];
  const remaining = [...ads];
  const compCount = {};

  while (remaining.length > 0) {
    let picked = false;
    for (let i = 0; i < remaining.length; i++) {
      const comp = remaining[i]._competitor;
      const count = compCount[comp] || 0;
      // Allow max 3 from same competitor before requiring a different one
      if (count < 3 || remaining.every(a => (compCount[a._competitor] || 0) >= 3)) {
        result.push(remaining[i]);
        compCount[comp] = count + 1;
        remaining.splice(i, 1);
        picked = true;
        break;
      }
    }
    if (!picked) {
      // Reset counts and continue
      Object.keys(compCount).forEach(k => compCount[k] = 0);
    }
  }
  return result;
}

// ── Preview proxy — on-demand image fetching + caching ──
// In-flight download tracker to avoid duplicate fetches
const _downloading = new Set();
// Fast lookup index: adId → ad object (rebuilt when cache changes)
let _adIndex = new Map();
function rebuildAdIndex() {
  _adIndex = new Map();
  if (adCache.data) adCache.data.forEach(a => _adIndex.set(a.id, a));
}

function serveImage(filePath, res) {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(filePath).pipe(res);
}

app.get('/api/preview/:adId/creative', async (req, res) => {
  const adId = req.params.adId;
  const adDir = path.join(CACHE_DIR, adId);
  const file = path.join(adDir, 'creative.jpg');
  const flat = path.join(CACHE_DIR, `${adId}.jpg`);

  // 1. Serve from cache
  if (fs.existsSync(file)) return serveImage(file, res);
  if (fs.existsSync(flat)) return serveImage(flat, res);

  // 2. On-demand fetch from CDN URL (scraped ads have _images or _video_thumb_url)
  if (!_downloading.has(adId)) {
    if (_adIndex.size === 0 && adCache.data) rebuildAdIndex();
    const ad = _adIndex.get(adId);
    const imgUrl = ad?._images?.[0] || ad?._video_thumb_url;
    if (imgUrl && imgUrl.includes('fbcdn.net')) {
      _downloading.add(adId);
      try {
        const upstream = await fetch(imgUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000, redirect: 'follow'
        });
        if (upstream.ok) {
          const buf = await upstream.buffer();
          if (buf.length > 2000) {
            fs.mkdirSync(adDir, { recursive: true });
            fs.writeFileSync(file, buf);
            fs.writeFileSync(flat, buf);
            _downloading.delete(adId);
            return serveImage(file, res);
          }
        }
      } catch {}
      _downloading.delete(adId);
    }
  }

  // 3. Not available
  res.status(404).json({ error: 'Not cached' });
});

app.get('/api/preview/:adId/avatar', (req, res) => {
  const file = path.join(CACHE_DIR, req.params.adId, 'avatar.jpg');
  if (fs.existsSync(file)) return serveImage(file, res);
  res.status(404).json({ error: 'Not cached' });
});

app.get('/api/preview/:adId/meta', (req, res) => {
  const file = path.join(CACHE_DIR, req.params.adId, 'meta.json');
  if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  res.status(404).json({ error: 'Not cached' });
});

// Backward compatible
app.get('/api/preview/:adId', (req, res) => {
  const file = path.join(CACHE_DIR, req.params.adId, 'creative.jpg');
  if (fs.existsSync(file)) return serveImage(file, res);
  const flat = path.join(CACHE_DIR, `${req.params.adId}.jpg`);
  if (fs.existsSync(flat)) return serveImage(flat, res);
  res.status(404).json({ error: 'Not cached' });
});

// ── Video proxy (streams fbcdn video server-side, supports Range for Safari) ──
// No requireAuth — browser <video> tags can't send custom headers
app.get('/api/video-proxy/:adId', async (req, res) => {
  const adId = req.params.adId;

  // Look up video URL from index — never accept URLs from client
  const videoIndexPath = path.join(CACHE_DIR, '_video_urls.json');
  let videoUrls;
  try {
    videoUrls = JSON.parse(fs.readFileSync(videoIndexPath, 'utf8'));
  } catch { return res.status(500).json({ error: 'Video index not available' }); }

  const entry = videoUrls[adId];
  if (!entry) return res.status(404).json({ error: 'No video URL for this ad' });

  // Prefer SD (faster, less bandwidth) unless HD requested
  const quality = req.query.quality === 'hd' ? 'hd' : 'sd';
  const fbcdnUrl = (quality === 'hd' && entry.hd) ? entry.hd : (entry.sd || entry.hd);
  if (!fbcdnUrl) return res.status(404).json({ error: 'No video URL available' });

  // Validate URL is actually fbcdn
  if (!fbcdnUrl.includes('.fbcdn.net/')) return res.status(400).json({ error: 'Invalid video source' });

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
    const rangeHeader = req.headers['range'];
    if (rangeHeader) headers['Range'] = rangeHeader;

    const upstream = await fetch(fbcdnUrl, { headers, timeout: 30000, redirect: 'follow' });

    if (upstream.status === 403 || upstream.status === 404) {
      return res.status(410).json({ error: 'Video URL expired' });
    }

    res.status(rangeHeader ? 206 : 200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    upstream.body.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch video: ' + err.message });
  }
});

// Serve cached video files
app.get('/api/preview/:adId/video', (req, res) => {
  const file = path.join(CACHE_DIR, req.params.adId, 'video.mp4');
  if (fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    return fs.createReadStream(file).pipe(res);
  }
  res.status(404).json({ error: 'Not cached' });
});

// ── Cache refresh trigger ──
app.post('/api/refresh', requireAuth, async (_req, res) => {
  adCache.data = null;
  adCache.timestamp = 0;
  try {
    const ads = await getAllAds();
    res.json({ ok: true, total: ads.length });
    // Precache images in background after responding
    const withImages = ads.filter(a => a._images && a._images.length > 0).sort((a, b) => b.score - a.score).slice(0, 500);
    if (withImages.length > 0) precacheImages(withImages).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fast image precacher: download creative images directly from CDN URLs ──
async function precacheImages(ads) {
  const https = require('https');
  const http = require('http');

  function dl(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 10000 }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return dl(res.headers.location).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  let cached = 0, skipped = 0, failed = 0;
  // Process in batches of 5 for speed
  for (let i = 0; i < ads.length; i += 5) {
    const batch = ads.slice(i, i + 5);
    await Promise.allSettled(batch.map(async (ad) => {
      const adDir = path.join(CACHE_DIR, ad.id);
      const creativePath = path.join(adDir, 'creative.jpg');
      const flatPath = path.join(CACHE_DIR, `${ad.id}.jpg`);

      // Skip if already cached
      if (fs.existsSync(creativePath) || fs.existsSync(flatPath)) { skipped++; return; }

      // Try _images array first (direct CDN URL from scraper data)
      const imgUrl = (ad._images && ad._images[0]) || null;
      if (!imgUrl) { skipped++; return; }

      try {
        const buf = await dl(imgUrl);
        if (buf.length > 5000) {
          fs.mkdirSync(adDir, { recursive: true });
          fs.writeFileSync(creativePath, buf);
          fs.writeFileSync(flatPath, buf);
          cached++;
        } else { failed++; }
      } catch { failed++; }
    }));
  }
  if (cached > 0) console.log(`   [precache] ${cached} images downloaded, ${skipped} already cached, ${failed} failed`);
}

const server = app.listen(PORT, () => {
  console.log(`\n🔍 Ad Spy running at http://localhost:${PORT}`);
  console.log(`   Tracking ${COMPETITORS.length} competitors`);
  if (!FB_TOKEN) console.warn('⚠️  FB_ACCESS_TOKEN not set');
  else {
    console.log('   FB token configured ✓');
    console.log(`   Fallback: ${SCRAPECREATORS_KEY ? 'ScrapeCreators API ✓' : 'Puppeteer scraper (add SCRAPECREATORS_KEY for full coverage)'}`);

    // Pre-fetch data on startup if cache is stale or empty
    if (!adCache.data || Date.now() - adCache.timestamp > CACHE_TTL) {
      console.log('   Fetching ads in background...');
      getAllAds()
        .then(async ads => {
          console.log(`   ✓ ${ads.length} ads cached and ready`);
          triggerImageExtraction(ads).catch(() => {});
        })
        .catch(err => console.error('   ✗ Background fetch failed:', err.message));
    } else {
      console.log(`   ✓ ${adCache.data.length} ads ready from cache`);
      triggerImageExtraction(adCache.data).catch(() => {});
    }
  }
  console.log('');
});

process.on('SIGTERM', () => { closeBrowser().catch(() => {}); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { closeBrowser().catch(() => {}); server.close(() => process.exit(0)); });
