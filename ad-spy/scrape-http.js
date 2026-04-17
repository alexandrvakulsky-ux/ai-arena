/**
 * Facebook Ad Library Scraper — Plain HTTP / No Browser
 *
 * Fetches the Ad Library HTML via plain HTTP GET and extracts the Relay
 * store JSON. No Puppeteer/Chrome needed.
 *
 * REQUIRES residential proxy — datacenter IPs get a JS challenge (403)
 * that only a browser can solve. With residential IPs, the SSR HTML
 * comes back clean with the full Relay store.
 *
 * This is 10-50x cheaper to run than the Puppeteer approach at scale.
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '.cache');
const VIDEO_URLS_FILE = path.join(CACHE_DIR, '_video_urls.json');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

// ── Relay JSON extraction ──

function extractRelayData(html) {
  // Find the script tag containing search_results_connection
  const marker = 'search_results_connection';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;

  // Walk backwards to find the containing object with ad_library_main
  const mainMarker = '"ad_library_main"';
  const mainIdx = html.lastIndexOf(mainMarker, idx);
  if (mainIdx === -1) return null;

  // Walk back further to find the opening brace
  let depth = 0, start = mainIdx;
  for (let i = mainIdx; i >= 0; i--) {
    if (html[i] === '}') depth++;
    if (html[i] === '{') { depth--; if (depth < 0) { start = i; break; } }
  }

  // Walk forward to find matching close
  depth = 0;
  let end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }

  try {
    const data = JSON.parse(html.substring(start, end));
    const conn = data.ad_library_main?.search_results_connection;
    if (!conn) return null;

    const edges = conn.edges || [];
    const ads = [];
    for (const edge of edges) {
      const node = edge.node || edge;
      const collated = node.collated_results || [node];
      for (const ad of collated) {
        if (ad.ad_archive_id) ads.push(ad);
      }
    }

    return {
      ads,
      count: conn.count || 0,
      cursor: conn.page_info?.end_cursor || null,
      hasNext: conn.page_info?.has_next_page || false
    };
  } catch {
    return null;
  }
}

// ── Ad normalization (same schema as scrape-ad-library.js) ──

function normalizeAd(node) {
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

  const startDate = node.start_date || node.ad_delivery_start_time || null;
  const endDate = node.end_date || node.ad_delivery_stop_time || null;

  return {
    id,
    page_name: snap.page_name || 'Unknown',
    page_id: String(snap.page_id || node.page_id || ''),
    body: bodyText,
    title: snap.title || '',
    description: snap.link_description || '',
    caption: snap.caption || '',
    snapshot_url: `https://www.facebook.com/ads/library/?id=${id}`,
    platforms: Array.isArray(node.publisher_platform) ? node.publisher_platform.map(p => String(p).toLowerCase()) : [],
    audience: null,
    languages: snap.page_categories || [],
    started: startDate,
    stopped: endDate || null,
    created: startDate,
    days_running: startDate ? Math.max(0, Math.round((new Date(endDate || Date.now()) - new Date(startDate)) / 86400000)) : 0,
    is_active: node.is_active !== undefined ? !!node.is_active : !endDate,
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
    preview_cached: fs.existsSync(path.join(CACHE_DIR, `${id}.jpg`)) || fs.existsSync(path.join(CACHE_DIR, id, 'creative.jpg'))
  };
}

// ── Main scraper ──

/**
 * Fetch one page of ads via plain HTTP.
 * @param {string} pageId
 * @param {object} options - { cursor, country, proxy }
 * @returns {{ ads: Array, cursor: string|null, hasNext: boolean, count: number }}
 */
async function fetchAdLibraryPage(pageId, options = {}) {
  const url = new URL('https://www.facebook.com/ads/library/');
  url.searchParams.set('active_status', 'active');
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('country', options.country || 'ALL');
  url.searchParams.set('view_all_page_id', pageId);
  url.searchParams.set('search_type', 'page');
  url.searchParams.set('media_type', 'all');
  if (options.cursor) url.searchParams.set('after', options.cursor);

  const fetchOpts = { headers: BROWSER_HEADERS, redirect: 'follow', timeout: 20000 };

  // Proxy support via agent
  if (options.proxy) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    fetchOpts.agent = new HttpsProxyAgent(options.proxy);
  }

  const res = await fetch(url.toString(), fetchOpts);

  if (res.status === 403) {
    throw new Error('BLOCKED: JS challenge returned (datacenter IP). Use residential proxy.');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const html = await res.text();

  if (html.includes('executeChallenge') || html.includes('checkpoint')) {
    throw new Error('BLOCKED: JS challenge / checkpoint. Use residential proxy.');
  }

  if (!html.includes('search_results_connection') && !html.includes('ad_archive_id')) {
    if (html.includes('No ads match') || html.length < 5000) {
      return { ads: [], cursor: null, hasNext: false, count: 0 };
    }
    throw new Error('Unexpected HTML response — no Relay data found');
  }

  const data = extractRelayData(html);
  if (!data) throw new Error('Failed to parse Relay store from HTML');

  return data;
}

/**
 * Scrape all ads for a page with full cursor pagination.
 * Requires residential proxy to work from datacenter IPs.
 * @param {string} pageId
 * @param {object} options - { maxAds, country, proxy }
 * @returns {Promise<Array>} Normalized ad objects
 */
async function scrapeAllAdsHttp(pageId, options = {}) {
  const maxAds = options.maxAds || 2000;
  const collectedAds = new Map();
  const videoIndex = JSON.parse(fs.readFileSync(VIDEO_URLS_FILE, 'utf8').catch ? '{}' : fs.existsSync(VIDEO_URLS_FILE) ? fs.readFileSync(VIDEO_URLS_FILE, 'utf8') : '{}');
  let cursor = null;
  let pageNum = 0;

  do {
    const delay = 1000 + Math.random() * 1500;
    if (pageNum > 0) await new Promise(r => setTimeout(r, delay));

    const result = await fetchAdLibraryPage(pageId, { ...options, cursor });
    pageNum++;

    for (const adNode of result.ads) {
      const ad = normalizeAd(adNode);
      if (ad && !collectedAds.has(ad.id)) {
        collectedAds.set(ad.id, ad);
        if (ad._video_hd_url || ad._video_sd_url) {
          videoIndex[ad.id] = { hd: ad._video_hd_url, sd: ad._video_sd_url, thumb: ad._video_thumb_url };
        }
      }
    }

    cursor = result.hasNext ? result.cursor : null;
    console.log(`   [http-scraper] Page ${pageNum}: ${result.ads.length} ads (total: ${collectedAds.size}/${result.count})`);

    if (collectedAds.size >= maxAds) break;
    if (pageNum > 50) break; // Safety cap
  } while (cursor);

  try { fs.writeFileSync(VIDEO_URLS_FILE, JSON.stringify(videoIndex)); } catch {}

  return [...collectedAds.values()];
}

module.exports = { fetchAdLibraryPage, scrapeAllAdsHttp };
