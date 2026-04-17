/**
 * Background job: extracts ad creative assets from Facebook ad snapshots.
 * For each ad, captures:
 *   - Page avatar (small image)
 *   - Main creative (largest image from CDN)
 *   - CTA label and destination URL
 *   - Ad format detection (image/video/carousel)
 *   - Metadata JSON
 *
 * All assets saved to .cache/{adId}/ — zero runtime dependency on Facebook URLs.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_DIR = path.join(__dirname, '.cache');
const VIDEO_URLS_FILE = path.join(CACHE_DIR, '_video_urls.json');
const DELAY_MS = 1500;
const CONCURRENCY = 3;

function loadVideoIndex() {
  try { return fs.existsSync(VIDEO_URLS_FILE) ? JSON.parse(fs.readFileSync(VIDEO_URLS_FILE, 'utf8')) : {}; } catch { return {}; }
}
function saveVideoIndex(idx) {
  try { fs.writeFileSync(VIDEO_URLS_FILE, JSON.stringify(idx)); } catch {}
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
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

async function extractAd(browser, ad) {
  const adDir = path.join(CACHE_DIR, ad.id);
  const metaPath = path.join(adDir, 'meta.json');

  if (!ad.snapshot_url) return 'no-snapshot';

  // Skip if already fully extracted — unless it's a video ad with no captured video URL
  if (fs.existsSync(metaPath)) {
    if (ad.ad_format !== 'video') return 'cached';
    const idx = loadVideoIndex();
    if (idx[ad.id] && (idx[ad.id].hd || idx[ad.id].sd)) return 'cached';
    // else: fall through to re-extract for video URL capture
  }

  fs.mkdirSync(adDir, { recursive: true });

  const page = await browser.newPage();
  try {
    await page.setCookie({ name: 'datr', value: 'abc123', domain: '.facebook.com', path: '/' });
    await page.setViewport({ width: 500, height: 900 });

    // Intercept all fbcdn images + videos
    const mediaUrls = [];
    const videoUrls = [];
    page.on('response', response => {
      const url = response.url();
      const type = response.headers()['content-type'] || '';
      const size = parseInt(response.headers()['content-length'] || '0');
      if (type.includes('image/') && url.includes('fbcdn') && !url.includes('rsrc.php')) {
        mediaUrls.push({ url, size, type });
      }
      if ((type.includes('video/') || /\.mp4(\?|$)/i.test(url)) && url.includes('fbcdn')) {
        videoUrls.push({ url, size, type });
      }
    });

    await page.goto(ad.snapshot_url, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    // Dismiss cookie wall
    for (let i = 0; i < 3; i++) {
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, div[role=button]')];
        const allow = btns.find(b => b.textContent.includes('Allow all cookies'));
        if (allow) { allow.click(); return true; }
        return false;
      });
      if (!clicked) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    await new Promise(r => setTimeout(r, 3000));

    // Extract structured data from DOM
    const domData = await page.evaluate(() => {
      const content = document.querySelector('#content') || document.body;

      // Page avatar — small circular image in header
      const avatarImg = content.querySelector('img[class*="img"]');
      const avatar = avatarImg?.src || '';

      // CTA button
      const ctaEl = content.querySelector('a[role="button"], div[role="button"] span');
      const ctaLabel = ctaEl?.textContent?.trim() || '';

      // Destination URL
      const linkEl = content.querySelector('a[href*="l.facebook.com"], a[rel="nofollow"]');
      const destUrl = linkEl?.href || '';

      // Detect format
      const hasVideo = !!content.querySelector('video');
      const carouselItems = content.querySelectorAll('[data-carousel-item], [aria-roledescription="slide"]');
      const hasCarousel = carouselItems.length > 1;

      let format = 'image';
      if (hasCarousel) format = 'carousel';
      else if (hasVideo) format = 'video';

      // Capture video src from <video> and <source> tags
      const videoEl = content.querySelector('video');
      const videoSrc = videoEl?.src || videoEl?.querySelector('source')?.src || '';

      // All images in content area (for carousel detection)
      const allImgs = [...content.querySelectorAll('img')].map(i => ({
        src: i.src, w: i.naturalWidth, h: i.naturalHeight
      })).filter(i => i.src && i.w > 50);

      return { avatar, ctaLabel, destUrl, format, imgCount: allImgs.length, videoSrc };
    });

    // If video detected, save URL(s) to the video index
    if (domData.format === 'video') {
      // Prefer largest intercepted mp4, fallback to DOM src
      const byBitrate = videoUrls.slice().sort((a, b) => b.size - a.size);
      const primary = byBitrate[0]?.url || domData.videoSrc || '';
      const secondary = byBitrate[1]?.url || '';
      if (primary && primary.includes('fbcdn')) {
        const idx = loadVideoIndex();
        if (!idx[ad.id] || (!idx[ad.id].hd && !idx[ad.id].sd)) {
          idx[ad.id] = {
            hd: byBitrate[0]?.size > (byBitrate[1]?.size || 0) ? primary : (secondary || primary),
            sd: secondary || primary,
            thumb: null
          };
          saveVideoIndex(idx);
        }
      }
    }

    // Download avatar (small image, usually the first/smallest fbcdn image)
    const avatarCandidates = mediaUrls.filter(m => m.size > 500 && m.size < 50000).sort((a, b) => a.size - b.size);
    if (avatarCandidates.length > 0) {
      try {
        const buf = await download(avatarCandidates[0].url);
        if (buf.length > 500) fs.writeFileSync(path.join(adDir, 'avatar.jpg'), buf);
      } catch {}
    }

    // Download main creative (largest image)
    const creativeCandidates = mediaUrls.filter(m => m.size > 10000).sort((a, b) => b.size - a.size);
    let mainSaved = false;
    if (creativeCandidates.length > 0) {
      try {
        const buf = await download(creativeCandidates[0].url);
        if (buf.length > 10000) {
          fs.writeFileSync(path.join(adDir, 'creative.jpg'), buf);
          mainSaved = true;
        }
      } catch {}
    }

    // Fallback: screenshot if no creative image was captured
    if (!mainSaved) {
      await page.evaluate(() => { document.querySelectorAll('[role=dialog]').forEach(d => d.remove()); });
      await page.screenshot({
        path: path.join(adDir, 'creative.jpg'),
        clip: { x: 0, y: 0, width: 500, height: 500 },
        type: 'jpeg', quality: 85
      });
    }

    // Also keep backward-compatible flat file
    const creativePath = path.join(adDir, 'creative.jpg');
    if (fs.existsSync(creativePath)) {
      fs.copyFileSync(creativePath, path.join(CACHE_DIR, `${ad.id}.jpg`));
    }

    // Save metadata
    const meta = {
      id: ad.id,
      page_name: ad.page_name || '',
      ad_format: domData.format,
      cta_label: domData.ctaLabel,
      destination_url: domData.destUrl,
      has_avatar: fs.existsSync(path.join(adDir, 'avatar.jpg')),
      has_creative: fs.existsSync(path.join(adDir, 'creative.jpg')),
      extracted_at: new Date().toISOString()
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    return 'ok';
  } catch (err) {
    return 'error: ' + err.message;
  } finally {
    await page.close();
  }
}

async function run(ads) {
  if (!ads || !ads.length) return;

  const vidIdx = loadVideoIndex();
  const uncached = ads.filter(a => {
    if (!a.snapshot_url) return false;
    const hasMeta = fs.existsSync(path.join(CACHE_DIR, a.id, 'meta.json'));
    if (!hasMeta) return true;
    // Re-extract video ads that still need a video URL
    if (a.ad_format === 'video' && !vidIdx[a.id] && !a._video_hd_url && !a._video_sd_url) return true;
    return false;
  });
  if (!uncached.length) { console.log('   All previews cached'); return; }

  console.log(`   Extracting ${uncached.length} ad previews...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    console.error('   Chrome not available:', err.message);
    return;
  }

  let done = 0, ok = 0, fail = 0;
  // Process in batches of CONCURRENCY
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(ad => extractAd(browser, ad)));
    for (const r of results) {
      done++;
      const v = r.status === 'fulfilled' ? r.value : 'error';
      if (v === 'ok') ok++;
      else if (v !== 'cached') fail++;
    }
    if (done % 30 === 0 || done === uncached.length) {
      console.log(`   Previews: ${done}/${uncached.length} (${ok} ok, ${fail} failed)`);
    }
    if (i + CONCURRENCY < uncached.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  await browser.close();
  console.log(`   ✓ Preview extraction done: ${ok} new, ${fail} failed`);
}

module.exports = { run };
