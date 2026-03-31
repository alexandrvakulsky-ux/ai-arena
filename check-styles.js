#!/usr/bin/env node
// Static consistency checker for public/index.html
// Catches CSS conflicts before they hit the browser.
// Run: node check-styles.js

const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

let errors = 0;
function fail(msg) { console.error('✗', msg); errors++; }
function ok(msg)   { console.log ('✓', msg); }

// ── 1. Extract CSS block ──────────────────────────────────────────────────────
const cssMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!cssMatch) { fail('No <style> block found'); process.exit(1); }
const css = cssMatch[1];

// Parse CSS into { selector -> { prop -> value } }
function parseCss(src) {
  const rules = {};
  // Strip comments
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Match selector { declarations }
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const selectors = m[1].trim().split(',').map(s => s.trim());
    const decls = {};
    m[2].split(';').forEach(d => {
      const [prop, ...rest] = d.split(':');
      if (prop && rest.length) decls[prop.trim()] = rest.join(':').trim();
    });
    selectors.forEach(sel => {
      if (!rules[sel]) rules[sel] = {};
      Object.assign(rules[sel], decls);
    });
  }
  return rules;
}

const rules = parseCss(css);

// ── 2. Find all multi-class element combos in HTML ───────────────────────────
const classAttrRe = /class="([^"]+)"/g;
const combos = new Set();
let ma;
while ((ma = classAttrRe.exec(html)) !== null) {
  const classes = ma[1].split(/\s+/).filter(Boolean);
  if (classes.length > 1) combos.add(classes.join(' '));
}

// ── 3. Check: conflicting property between co-applied classes ─────────────────
// For each combo, find properties declared in more than one of the classes.
// Flag as error when the values differ (one overrides the other).
const VISUAL_PROPS = new Set([
  'font-size','font-weight','font-family','line-height','color',
  'background','background-color','border','border-radius',
  'padding','margin','display','opacity','text-align',
]);

combos.forEach(combo => {
  const classes = combo.split(' ');
  const propSources = {}; // prop -> [{ cls, value }]
  classes.forEach(cls => {
    const r = rules[`.${cls}`];
    if (!r) return;
    Object.entries(r).forEach(([prop, val]) => {
      if (!VISUAL_PROPS.has(prop)) return;
      if (!propSources[prop]) propSources[prop] = [];
      propSources[prop].push({ cls, val });
    });
  });
  Object.entries(propSources).forEach(([prop, sources]) => {
    if (sources.length < 2) return;
    const vals = new Set(sources.map(s => s.val));
    if (vals.size > 1) {
      const detail = sources.map(s => `.${s.cls}: ${s.val}`).join(' vs ');
      fail(`Conflicting "${prop}" on [${combo}] — ${detail}`);
    }
  });
});

// ── 4. Check: font-size px values in reasonable range ────────────────────────
const fontRe = /font-size:\s*([^;]+);/g;
let fm;
while ((fm = fontRe.exec(css)) !== null) {
  const val = fm[1].trim();
  const px = val.match(/^(\d+(?:\.\d+)?)px$/);
  if (px && (parseFloat(px[1]) < 10 || parseFloat(px[1]) > 48)) {
    fail(`Suspicious font-size: "${val}"`);
  }
}

// ── 5. Check: .jsb class overrides ───────────────────────────────────────────
// Any class that co-appears with .jsb in the HTML and re-declares a .jsb prop.
const jsbProps = rules['.jsb'] || {};
combos.forEach(combo => {
  if (!combo.includes('jsb')) return;
  const classes = combo.split(' ').filter(c => c !== 'jsb');
  classes.forEach(cls => {
    const r = rules[`.${cls}`];
    if (!r) return;
    Object.keys(r).forEach(prop => {
      if (jsbProps[prop] && r[prop] !== jsbProps[prop]) {
        fail(`.${cls} overrides .jsb "${prop}": ${jsbProps[prop]} → ${r[prop]}`);
      }
    });
  });
});

// ── 6. Check: dead CSS (classes in CSS not used in HTML or JS) ───────────────
const skipPrefixes = ['jsb','conv-','hv-','model-','history-','judge-','gate-','sf-','status-','score-','toggle-','pdf-','resp-','card-'];
Object.keys(rules).forEach(sel => {
  if (!sel.startsWith('.')) return;
  const cls = sel.slice(1);
  if (skipPrefixes.some(p => cls.startsWith(p))) return;
  if (sel.includes(':') || sel.includes('>') || sel.includes(' ') || sel.includes('[')) return;
  // Check static class attributes AND dynamic JS className assignments
  const inHtml = new RegExp(`class="[^"]*\\b${cls}\\b`).test(html);
  const inJs   = new RegExp(`className[^=]*=.*['"\`][^'"\`]*\\b${cls}\\b`).test(html);
  if (!inHtml && !inJs) fail(`Dead CSS: "${sel}" defined but never used`);
});

// ── 7. Check: IDs in JS that don't exist in HTML ─────────────────────────────
// Skip template literals (contain ${ }) — those are dynamic
const getByIdRe = /getElementById\(['"`]([^'"`]+)['"`]\)/g;
let gm;
while ((gm = getByIdRe.exec(html)) !== null) {
  const id = gm[1];
  if (id.includes('${')) continue;
  if (!new RegExp(`id="${id}"`).test(html)) {
    fail(`getElementById("${id}") — element not found in HTML`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
if (errors === 0) {
  ok(`All checks passed`);
} else {
  console.error(`\n${errors} issue(s) found`);
  process.exit(1);
}
