#!/usr/bin/env node
// Take a screenshot of the app for visual verification.
// Usage: node screenshot.js [url] [outfile]
// Default: http://localhost:3000 → /tmp/screenshot.png

const puppeteer = require('/usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer');

const url  = process.argv[2] || 'http://localhost:3000';
const out  = process.argv[3] || '/tmp/screenshot.png';

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  console.log(`Screenshot saved: ${out}`);
})().catch(err => { console.error(err.message); process.exit(1); });
