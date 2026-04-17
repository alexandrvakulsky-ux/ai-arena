/**
 * Facebook Ad Library Scraper — HTML Relay Store Extraction
 *
 * The official Ad Library API doesn't return ads for some advertisers
 * (known Meta bug: pages with prior policy violations get suppressed).
 * This module loads the Ad Library website via Puppeteer and extracts
 * ad data from the server-rendered Relay store JSON in the HTML.
 *
 * Yields ~30 ads per page load from datacenter IPs. Pagination beyond
 * that requires residential proxies (GraphQL gets rate-limited on DC IPs).
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '.cache');
const VIDEO_URLS_FILE = path.join(CACHE_DIR, '_video_urls.json');
const MAX_ADS_DEFAULT = 1500;
const PAGE_NAV_DELAY_MIN = 1500;
const PAGE_NAV_DELAY_MAX = 3000;
const MAX_RETRIES = 2;

// ── Browser management ──

let _browser = null;

async function getBrowser(proxy) {
  if (_browser && _browser.isConnected()) return _browser;
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080'
  ];
  if (proxy) args.push(`--proxy-server=${proxy}`);

  _browser = await puppeteer.launch({ headless: true, args });
  return _browser;
}

async function closeBrowser() {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}

function randomDelay() {
  return PAGE_NAV_DELAY_MIN + Math.random() * (PAGE_NAV_DELAY_MAX - PAGE_NAV_DELAY_MIN);
}

// ── Video URL index ──

function loadVideoIndex() {
  try {
    if (fs.existsSync(VIDEO_URLS_FILE)) return JSON.parse(fs.readFileSync(VIDEO_URLS_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveVideoIndex(index) {
  try { fs.writeFileSync(VIDEO_URLS_FILE, JSON.stringify(index)); } catch {}
}

// ── Ad normalization ──

function normalizeScrapedAd(node) {
  if (!node || !node.ad_archive_id) return null;
  const snap = node.snapshot || {};
  const id = String(node.ad_archive_id);

  const bodyText = snap.body?.text || snap.body?.markup || (typeof snap.body === 'string' ? snap.body : '') || '';
  const images = (snap.images || []).map(i => i.original_image_url || '').filter(Boolean);
  const videos = snap.videos || [];
  const cards = (snap.cards || []).filter(c => c && (c.title || c.body));

  const videoHd = videos[0]?.video_hd_url || null;
  const videoSd = videos[0]?.video_sd_url || null;
  const videoThumb = videos[0]?.video_preview_image_url || null;

  let adFormat = 'image';
  const fmt = (snap.display_format || '').toUpperCase();
  if (fmt === 'VIDEO' || videoHd || videoSd) adFormat = 'video';
  else if (fmt === 'DCO' || cards.length > 1) adFormat = 'carousel';

  function normDate(d) {
    if (!d) return null;
    if (typeof d === 'number') return d < 1e10 ? new Date(d * 1000).toISOString().slice(0, 10) : new Date(d).toISOString().slice(0, 10);
    return d;
  }
  const startDate = normDate(node.start_date || node.ad_delivery_start_time || null);
  const endDate = normDate(node.end_date || node.ad_delivery_stop_time || null);
  const isActive = node.is_active !== undefined ? !!node.is_active : !endDate;
  const daysRunning = startDate
    ? Math.max(0, Math.round((new Date(endDate || Date.now()) - new Date(startDate)) / 86400000))
    : 0;

  const platforms = [];
  const pp = node.publisher_platform || node.publisher_platforms;
  if (Array.isArray(pp)) platforms.push(...pp.map(p => String(p).toLowerCase()));
  else if (typeof pp === 'string') platforms.push(pp.toLowerCase());

  return {
    id,
    page_name: snap.page_name || 'Unknown',
    page_id: String(snap.page_id || node.page_id || ''),
    body: bodyText,
    title: snap.title || '',
    description: snap.link_description || '',
    caption: snap.caption || '',
    snapshot_url: `https://www.facebook.com/ads/library/?id=${id}`,
    platforms,
    audience: null,
    languages: snap.page_categories || [],
    started: startDate,
    stopped: endDate || null,
    created: startDate,
    days_running: daysRunning,
    is_active: isActive,
    ad_format: adFormat,
    cta_text: snap.cta_text || '',
    link_url: snap.link_url || '',
    page_avatar_url: snap.page_profile_picture_url || '',
    _images: images,
    _video_hd_url: videoHd,
    _video_sd_url: videoSd,
    _video_thumb_url: videoThumb,
    _carousel_cards: cards.length > 1 ? cards : undefined,
    _collation_count: node.collation_count || 1,
    preview_cached: fs.existsSync(path.join(CACHE_DIR, `${id}.jpg`)) ||
                    fs.existsSync(path.join(CACHE_DIR, id, 'creative.jpg'))
  };
}

// ── Relay JSON extraction from SSR HTML ──

/**
 * Extract the Relay store JSON from the page's script tags.
 * Returns { ads, count, cursor, hasNext } or throws on blocked detection.
 */
async function extractRelayData(page) {
  return page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script')];
    const adScript = scripts.find(s => s.textContent.includes('ad_archive_id'));

    if (!adScript) {
      // Check if we're blocked vs. legitimately no ads
      const bodyText = document.body.innerText || '';
      const isBlocked = !bodyText.includes('Ad Library') || bodyText.includes('log in') || bodyText.includes('CAPTCHA');
      const noResults = bodyText.includes('No ads match') || bodyText.includes('0 results');
      return { ads: [], count: 0, cursor: null, hasNext: false, blocked: isBlocked, empty: noResults };
    }

    const text = adScript.textContent;
    const mainIdx = text.indexOf('"ad_library_main"');
    if (mainIdx === -1) return { ads: [], count: 0, cursor: null, hasNext: false, blocked: false, empty: false };

    // Balanced-brace parser to find the containing JSON object
    let depth = 0, start = mainIdx;
    for (let i = mainIdx; i >= 0; i--) {
      if (text[i] === '}') depth++;
      if (text[i] === '{') { depth--; if (depth < 0) { start = i; break; } }
    }
    depth = 0;
    let end = start;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }

    try {
      const data = JSON.parse(text.substring(start, end));
      const main = data.ad_library_main;
      const conn = main?.search_results_connection || main?.search_results;
      if (!conn) return { ads: [], count: 0, cursor: null, hasNext: false, blocked: false, empty: false };

      const edges = conn.edges || [];
      const allAds = [];
      for (const edge of edges) {
        const node = edge.node || edge;
        const collated = node.collated_results || [node];
        for (const ad of collated) {
          if (ad.ad_archive_id) allAds.push(ad);
        }
      }

      return {
        ads: allAds,
        count: conn.count || 0,
        cursor: conn.page_info?.end_cursor || null,
        hasNext: conn.page_info?.has_next_page || false,
        blocked: false,
        empty: false
      };
    } catch {
      return { ads: [], count: 0, cursor: null, hasNext: false, blocked: false, empty: false };
    }
  });
}

/**
 * Dismiss cookie consent wall if present.
 */
async function dismissCookieWall(page) {
  for (let i = 0; i < 3; i++) {
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, div[role=button], [data-cookiebanner="accept_button"]')];
      const allow = btns.find(b => /allow|accept|agree/i.test(b.textContent));
      if (allow) { allow.click(); return true; }
      return false;
    });
    if (!clicked) break;
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Main scraper ──

/**
 * Scrape ads for a single page from the Ad Library website.
 * @param {string} pageId - Facebook page ID
 * @param {object} options - { maxAds, country, proxy }
 * @returns {Promise<Array>} Array of normalized ad objects
 */
async function scrapePageAds(pageId, options = {}) {
  const maxAds = options.maxAds || MAX_ADS_DEFAULT;
  const country = options.country || 'US';
  const proxy = options.proxy || null;

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`   [scraper] Retry ${attempt}/${MAX_RETRIES} for page ${pageId}...`);
      await new Promise(r => setTimeout(r, 5000));
    }
    try {
      return await _scrapePageAdsOnce(pageId, { maxAds, country, proxy });
    } catch (err) {
      lastError = err;
      if (err.message.includes('blocked')) break; // Don't retry if blocked
    }
  }
  console.error(`   [scraper] Failed after retries for page ${pageId}: ${lastError?.message}`);
  return [];
}

async function _scrapePageAdsOnce(pageId, { maxAds, country, proxy }) {
  const browser = await getBrowser(proxy);
  const page = await browser.newPage();
  const collectedAds = new Map();
  const videoIndex = loadVideoIndex();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setCookie({ name: 'datr', value: 'abc123', domain: '.facebook.com', path: '/' });

    // Also intercept GraphQL for any pagination that works
    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/graphql')) return;
      try {
        const text = await response.text();
        const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.errors) return;
            const nodes = [];
            findAdNodesInObj(data, nodes);
            for (const node of nodes) {
              const ad = normalizeScrapedAd(node);
              if (ad && !collectedAds.has(ad.id)) {
                collectedAds.set(ad.id, ad);
                if (ad._video_hd_url || ad._video_sd_url) {
                  videoIndex[ad.id] = { hd: ad._video_hd_url, sd: ad._video_sd_url, thumb: ad._video_thumb_url };
                }
              }
            }
          } catch {}
        }
      } catch {}
    });

    const baseUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&view_all_page_id=${pageId}&search_type=page&media_type=all`;

    console.log(`   [scraper] Loading Ad Library for page ${pageId}...`);
    await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    await dismissCookieWall(page);
    await new Promise(r => setTimeout(r, 2000));

    // Verify we're on the right page (not redirected to login/CAPTCHA)
    const currentUrl = page.url();
    if (!currentUrl.includes('ads/library')) {
      throw new Error(`Datacenter IP blocked — redirected to ${currentUrl.substring(0, 60)}`);
    }

    // Extract from server-rendered HTML
    const htmlData = await extractRelayData(page);

    if (htmlData.blocked) {
      throw new Error('Datacenter IP blocked — add residential proxy for this scraper');
    }

    if (htmlData.empty) {
      console.log(`   [scraper] Page ${pageId}: no ads found (legitimate empty)`);
      return [];
    }

    console.log(`   [scraper] HTML extraction: ${htmlData.ads.length} ads (total: ${htmlData.count}, hasNext: ${htmlData.hasNext})`);

    // Normalize and collect
    for (const adNode of htmlData.ads) {
      const ad = normalizeScrapedAd(adNode);
      if (ad && !collectedAds.has(ad.id)) {
        collectedAds.set(ad.id, ad);
        if (ad._video_hd_url || ad._video_sd_url) {
          videoIndex[ad.id] = { hd: ad._video_hd_url, sd: ad._video_sd_url, thumb: ad._video_thumb_url };
        }
      }
    }

    // Scroll for more if not at limit (GraphQL interception may catch some)
    if (htmlData.hasNext && collectedAds.size < maxAds) {
      let prevCount = collectedAds.size;
      let staleCount = 0;

      for (let i = 0; i < 10 && collectedAds.size < maxAds; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 3000));

        if (collectedAds.size === prevCount) {
          staleCount++;
          if (staleCount >= 3) break; // Rate-limited on GraphQL
        } else {
          staleCount = 0;
          prevCount = collectedAds.size;
        }
      }
    }

    saveVideoIndex(videoIndex);

    const ads = [...collectedAds.values()];
    console.log(`   [scraper] Done: ${ads.length} ads scraped for page ${pageId} (of ${htmlData.count} total)`);
    return ads;

  } finally {
    await page.close();
  }
}

/**
 * Walk a JSON object tree looking for ad nodes (objects with ad_archive_id).
 */
function findAdNodesInObj(obj, results, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== 'object') return;
  if (obj.ad_archive_id) { results.push(obj); return; }
  if (Array.isArray(obj.collated_results)) {
    for (const item of obj.collated_results) findAdNodesInObj(item, results, depth + 1);
  }
  if (Array.isArray(obj.edges)) {
    for (const edge of obj.edges) {
      findAdNodesInObj(edge?.node || edge, results, depth + 1);
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) findAdNodesInObj(item, results, depth + 1);
  } else {
    for (const key of Object.keys(obj)) {
      if (key === '__typename' || key === 'extensions') continue;
      findAdNodesInObj(obj[key], results, depth + 1);
    }
  }
}

module.exports = { scrapePageAds, closeBrowser };
