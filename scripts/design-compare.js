#!/usr/bin/env node
'use strict';
/*
 * design-compare.js — zero-dependency pixel-diff + report engine for the ad-spy
 * design pipeline. Self-contained PNG codec via Node's built-in zlib (no deps).
 * Capture lives in adspy-shoot.js (Puppeteer inside ad-spy). See skill: adspy-design-pipeline.
 *
 * Commands:
 *   diff <ref.png> <test.png> <out-diff.png> [--threshold=0.1]
 *       prints JSON stats {width,height,changed,total,pct}.
 *   compare-shots <config.json>
 *       diffs pre-captured <shotsDir>/<label>_<viewport>.png pairs, writes report.html.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// PNG codec (8-bit, color type 2/RGB or 6/RGBA, non-interlaced)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Decode -> { width, height, data: Buffer RGBA (4 bytes/px) }
function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + file);
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    if (off + 12 + len > b.length) break; // truncated (e.g. partial docker cp)
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  if (interlace !== 0) throw new Error('interlaced PNG unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error('unsupported color type ' + colorType);
  if (!idat.length) throw new Error('no IDAT (truncated/empty PNG?): ' + file);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    raw.copy(cur, 0, p, p + stride); p += stride;
    unfilter(ft, cur, prev, channels);
    for (let x = 0; x < width; x++) {
      const si = x * channels, di = (y * width + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

function unfilter(ft, cur, prev, bpp) {
  const len = cur.length;
  if (ft === 0) return;
  for (let i = 0; i < len; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = cur[i];
    if (ft === 1) v += a;
    else if (ft === 2) v += b;
    else if (ft === 3) v += (a + b) >> 1;
    else if (ft === 4) v += paeth(a, b, c);
    else throw new Error('bad filter ' + ft);
    cur[i] = v & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

// Encode RGBA buffer -> PNG file (filter 0 per scanline).
function encodePNG(file, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 6 });
  fs.writeFileSync(file, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// ---------------------------------------------------------------------------
// Pixel diff
// ---------------------------------------------------------------------------

function diff(refPath, testPath, outPath, threshold = 0.1) {
  const a = decodePNG(refPath), b = decodePNG(testPath);
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const W = Math.max(a.width, b.width), H = Math.max(a.height, b.height);
  const out = Buffer.alloc(W * H * 4, 0);
  const cut = threshold * 255 * Math.sqrt(3);
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x >= w || y >= h) { // outside overlap = size mismatch region
        out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; out[o + 3] = 255; changed++;
        continue;
      }
      const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4;
      const dr = a.data[ia] - b.data[ib];
      const dg = a.data[ia + 1] - b.data[ib + 1];
      const db = a.data[ia + 2] - b.data[ib + 2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist > cut) {
        out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; out[o + 3] = 255; changed++;
      } else { // faded grayscale of test for context
        const g = (b.data[ib] * 0.3 + b.data[ib + 1] * 0.59 + b.data[ib + 2] * 0.11);
        const v = Math.round(255 - (255 - g) * 0.25);
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
      }
    }
  }
  encodePNG(outPath, W, H, out);
  const total = W * H;
  return { width: W, height: H, changed, total, pct: +(100 * changed / total).toFixed(2) };
}

// ---------------------------------------------------------------------------
// Orchestration + report
// ---------------------------------------------------------------------------

// Diff + report over PNGs already captured by adspy-shoot.js
// (<shotsDir>/<label>_<viewport>.png). No capture here.
function compareShots(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const runDir = cfg.runDir || path.dirname(configPath);
  const shotsDir = cfg.shotsDir || path.join(runDir, 'shots');
  const viewports = cfg.viewports;
  const refLabel = typeof cfg.reference === 'string' ? cfg.reference : cfg.reference.label;
  const cands = cfg.candidates.map((c) => (typeof c === 'string' ? c : c.label));
  const results = { name: cfg.name, runDir, viewports, reference: refLabel, rows: [] };
  for (const vp of viewports) {
    const refPng = path.join(shotsDir, `${refLabel}_${vp.label}.png`);
    if (!fs.existsSync(refPng)) throw new Error('missing reference shot: ' + refPng);
    for (const cand of cands) {
      const testPng = path.join(shotsDir, `${cand}_${vp.label}.png`);
      if (!fs.existsSync(testPng)) { log(`skip ${cand}/${vp.label}: no shot`); continue; }
      const diffPng = path.join(shotsDir, `${cand}_${vp.label}_diff.png`);
      const stats = diff(refPng, testPng, diffPng, cfg.threshold || 0.1);
      results.rows.push({
        candidate: cand, viewport: vp.label,
        ref: path.relative(runDir, refPng), test: path.relative(runDir, testPng),
        diff: path.relative(runDir, diffPng), stats,
      });
      log(`${cand}/${vp.label}: ${stats.pct}% differs from ${refLabel}`);
    }
  }
  const reportPath = path.join(runDir, 'report.html');
  fs.writeFileSync(reportPath, buildReport(results, cfg));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(results, null, 2));
  results.report = reportPath;
  return results;
}

function buildReport(r, cfg) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const cands = [...new Set(r.rows.map((x) => x.candidate))];
  let sections = '';
  for (const vp of r.viewports) {
    let rows = '';
    for (const cand of cands) {
      const row = r.rows.find((x) => x.candidate === cand && x.viewport === vp.label);
      if (!row) continue;
      rows += `
      <h3>${esc(cand)} <span class="pct">${row.stats.pct}% differs</span></h3>
      <div class="grid">
        <figure><figcaption>reference · ${esc(r.reference)}</figcaption><img src="${esc(row.ref)}"></figure>
        <figure><figcaption>candidate · ${esc(cand)}</figcaption><img src="${esc(row.test)}"></figure>
        <figure><figcaption>diff (magenta = changed)</figcaption><img src="${esc(row.diff)}"></figure>
      </div>`;
    }
    sections += `<section><h2>${esc(vp.label)} · ${vp.w}×${vp.h}</h2>${rows}</section>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name || 'design compare')}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0d0d14;color:#e8e8f0;font:14px/1.5 system-ui,sans-serif}
  header{padding:20px 28px;border-bottom:1px solid #262635;position:sticky;top:0;background:#0d0d14;z-index:2}
  h1{margin:0;font-size:18px}
  .meta{color:#8a8aa0;font-size:12px;margin-top:4px}
  section{padding:18px 28px;border-bottom:1px solid #1c1c28}
  h2{font-size:15px;color:#a8a8ff;text-transform:uppercase;letter-spacing:.06em}
  h3{font-size:14px;margin:20px 0 8px}
  .pct{color:#ff5cff;font-weight:600;margin-left:8px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;align-items:start}
  figure{margin:0;background:#15151f;border:1px solid #262635;border-radius:8px;overflow:hidden}
  figcaption{padding:6px 10px;font-size:11px;color:#9a9ab0;border-bottom:1px solid #262635}
  img{display:block;width:100%;height:auto}
</style></head><body>
<header><h1>${esc(r.name || 'design compare')}</h1>
<div class="meta">reference: <b>${esc(r.reference)}</b> · candidates: ${esc(cands.join(', '))} · threshold ${cfg.threshold || 0.1}</div></header>
${sections}
</body></html>`;
}

function log(m) { process.stderr.write('[design-compare] ' + m + '\n'); }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args) {
  const flags = {}, pos = [];
  for (const a of args) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2]; else if (a.startsWith('--')) flags[a.slice(2)] = true; else pos.push(a);
  }
  return { flags, pos };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  if (cmd === 'diff') {
    const [ref, test, out] = pos;
    console.log(JSON.stringify(diff(ref, test, out, flags.threshold ? +flags.threshold : 0.1)));
  } else if (cmd === 'compare-shots') {
    const res = compareShots(pos[0]);
    console.log(JSON.stringify({ report: res.report, rows: res.rows.map((x) => ({ candidate: x.candidate, viewport: x.viewport, pct: x.stats.pct })) }, null, 2));
  } else {
    process.stderr.write('usage: design-compare.js <diff|compare-shots> ...\n');
    process.exit(2);
  }
}

main();
