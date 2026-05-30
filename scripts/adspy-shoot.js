#!/usr/bin/env node
'use strict';
/*
 * adspy-shoot.js — capture engine for the ad-spy design pipeline.
 * RUNS INSIDE the ad-spy container (uses its already-installed Puppeteer +
 * Chrome, and its outbound internet so CDN-based mockups actually style).
 *
 * Usage (inside ad-spy):  node adspy-shoot.js <job.json>
 * Job shape:
 * {
 *   "outDir": "/tmp/adspy-shoot/out",
 *   "viewports": [{"label":"desktop","w":1440,"h":900},{"label":"mobile","w":390,"h":844}],
 *   "fullPage": true,
 *   "settleMs": 1500,
 *   "targets": [
 *     {"label":"live","url":"http://localhost:3001","login":true},
 *     {"label":"draft-a","file":"/tmp/adspy-shoot/drafts/draft-a.html"}
 *   ]
 * }
 * Writes <outDir>/<label>_<viewport>.png. The login password is read from the
 * server process env (/proc/1/environ) inside the container and never printed.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function appPassword() {
  // ad-spy loads APP_PASSWORD via dotenv from /workspace/.env; fall back to pid1 env.
  try {
    const line = fs.readFileSync('/workspace/.env', 'utf8').split('\n')
      .map((l) => l.replace(/\r$/, '').replace(/^export\s+/, ''))
      .find((l) => l.startsWith('APP_PASSWORD='));
    if (line) return line.slice('APP_PASSWORD='.length).trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through */ }
  try {
    const hit = fs.readFileSync('/proc/1/environ', 'utf8').split('\0')
      .find((s) => s.startsWith('APP_PASSWORD='));
    if (hit) return hit.slice('APP_PASSWORD='.length);
  } catch { /* none */ }
  return null;
}

async function hideGate(page) {
  // Mockups are clones of the gated app and ship a static #gate overlay whose
  // dismiss JS was stripped; remove it so the dashboard underneath is captured.
  await page.evaluate(() => {
    const btn = document.getElementById('btnEnter'); // runs the clone's own reveal onclick
    if (btn) try { btn.click(); } catch { /* ignore */ }
    const g = document.getElementById('gate');
    if (g) g.style.display = 'none';
    const app = document.getElementById('app');
    if (app) { app.classList.remove('hidden'); app.style.display = app.style.display || 'flex'; }
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
  });
}

// Returns {ok, reason}. Asserts the gate is gone AND the dashboard is actually
// visible — so a still-gated or blank page is never captured as the reference.
async function doLogin(page) {
  const pw = appPassword();
  if (!pw) return { ok: false, reason: 'no APP_PASSWORD available (required for login target)' };
  try {
    await page.waitForSelector('#pwInput', { timeout: 8000 });
    await page.type('#pwInput', pw, { delay: 8 });
    await page.evaluate(() => (typeof checkPw === 'function' ? checkPw() : null));
    await page.waitForFunction(() => {
      const g = document.getElementById('gate');
      const app = document.getElementById('app');
      const gateGone = !g || getComputedStyle(g).display === 'none';
      const appShown = app && getComputedStyle(app).display !== 'none' && app.offsetHeight > 0;
      return gateGone && appShown;
    }, { timeout: 12000 });
    log('login OK (gate cleared, app visible)');
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'login failed: ' + e.message }; }
}

async function settle(page, ms) {
  // give lazy data fetches / fonts / Tailwind JIT time to paint
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  fs.mkdirSync(job.outDir, { recursive: true });
  const fullPage = job.fullPage !== false;
  const settleMs = job.settleMs == null ? 1500 : job.settleMs;
  const viewports = job.viewports || [
    { label: 'desktop', w: 1440, h: 900 },
    { label: 'mobile', w: 390, h: 844 },
  ];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const out = [];
  let failed = 0;
  try {
    for (const t of job.targets) {
      const url = t.url || ('file://' + path.resolve(t.file));
      for (const vp of viewports) {
        const page = await browser.newPage();
        await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
        log(`shoot ${t.label} @ ${vp.label} -> ${url}`);
        let ok = true, reason = null;
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        } catch (e) { ok = false; reason = 'goto failed: ' + e.message; }
        if (ok && t.login) { const r = await doLogin(page); ok = r.ok; reason = r.reason || null; }
        else if (ok && t.hideGate) { await hideGate(page); }
        const file = path.join(job.outDir, `${t.label}_${vp.label}.png`);
        if (ok) {
          await settle(page, settleMs);
          await page.screenshot({ path: file, fullPage });
          out.push({ label: t.label, viewport: vp.label, file, ok: true });
        } else {
          failed++;
          out.push({ label: t.label, viewport: vp.label, file: null, ok: false, reason });
          log(`  FAIL ${t.label}/${vp.label}: ${reason}`);
        }
        await page.close();
      }
    }
  } finally { await browser.close(); }
  log(`done: ${out.filter((o) => o.ok).length}/${out.length} shots in ${job.outDir}`);
  process.stdout.write(JSON.stringify(out));
  if (failed) process.exit(2); // loud: a required capture failed
}

function log(m) { process.stderr.write('[adspy-shoot] ' + m + '\n'); }
main().catch((e) => { log('FATAL ' + e.stack); process.exit(1); });
