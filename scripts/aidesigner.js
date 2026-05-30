#!/usr/bin/env node
'use strict';
/*
 * aidesigner.js — efficient AIDesigner CLI (ai-arena; api.aidesigner.ai reachable).
 * Drives generate/refine/get_canvas over the MCP-HTTP API so design HTML goes
 * STRAIGHT TO A FILE and never enters the model's context. Returns only metadata
 * JSON ({run_id, canvas_id, file, bytes, credits...}). Auth reuses the headersHelper.
 *
 *   node aidesigner.js credits
 *   node aidesigner.js list
 *   node aidesigner.js canvas <id> <out.html>          # fetch a specific canvas
 *   node aidesigner.js latest <out.html>               # best-effort newest (see note)
 *   node aidesigner.js gen <out.html> --prompt-file=P [--repo-file=R] [--brand=ID]
 *        [--viewport=desktop|mobile] [--mode=clone|enhance|inspire --url=U]
 *   node aidesigner.js refine <out.html> --run=RUN_ID --feedback-file=F
 *        [--repo-file=R] [--brand=ID] [--target=CANVAS_ID] [--viewport=...]
 *
 * HTML never round-trips through model output — that's the whole point.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENDPOINT = 'https://api.aidesigner.ai/api/v1/mcp';
const HEADERS_HELPER = process.env.AIDESIGNER_HEADERS_HELPER || '/home/node/.claude/scripts/aidesigner-headers.sh';

function fail(msg) { process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n'); process.exit(1); }
function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function authHeader() {
  try {
    const h = JSON.parse(execSync(`bash ${HEADERS_HELPER}`, { encoding: 'utf8' }));
    if (!h.Authorization) throw new Error('no Authorization');
    return h.Authorization;
  } catch (e) { fail('auth helper failed: ' + e.message); }
}

let _id = 0;
function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params });
  return new Promise((resolve) => {
    const req = https.request(new URL(ENDPOINT), {
      method: 'POST',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('data:')) text = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        let json; try { json = JSON.parse(text); } catch { return resolve({ error: { message: 'bad json: ' + text.slice(0, 160) } }); }
        resolve(json);
      });
    });
    req.on('error', (e) => resolve({ error: { message: String(e.message) } }));
    req.write(body); req.end();
  });
}

// Returns the raw content blocks (array of {type,text}).
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r.error) fail(name + ' error: ' + (r.error.message || JSON.stringify(r.error)));
  return (r.result && r.result.content) || [];
}

// From content blocks, separate the metadata JSON (has run_id/usage) from the HTML.
function splitGenResult(content) {
  let meta = {}, html = null;
  for (const c of content) {
    const t = c.text || '';
    if (/^\s*<(!doctype|html)/i.test(t)) { html = t; continue; }
    try { const j = JSON.parse(t); if (j.run_id || j.canvas_delivery || j.usage) meta = j; } catch { /* not json */ }
    if (!html) { const m = t.match(/<(?:!doctype|html)[\s\S]*<\/html>/i); if (m) html = m[0]; }
  }
  return { meta, html };
}

function extractCanvasHtml(text) {
  if (/^\s*<(!doctype|html)/i.test(text)) return text;
  try { const j = JSON.parse(text); const html = (j.canvas && (j.canvas.html || j.canvas.content)) || j.html; if (typeof html === 'string') return html; } catch { /* */ }
  const m = text.match(/<(?:!doctype|html)[\s\S]*<\/html>/i); return m ? m[0] : null;
}

function writeHtml(outPath, html) {
  if (!html || html.length < 200 || !/<html|<!doctype/i.test(html)) fail('invalid/empty HTML (len ' + (html ? html.length : 0) + ')');
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, html);
  return html.length;
}

function readFileArg(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { fail('cannot read ' + f + ': ' + e.message); } }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {}, pos = [];
  for (const a of rest) { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) flags[m[1]] = m[2]; else if (a.startsWith('--')) flags[a.slice(2)] = true; else pos.push(a); }

  if (cmd === 'credits') {
    const text = await callTool('get_credit_status', {});
    let c; try { c = JSON.parse(text[0] && text[0].text || '{}'); } catch { c = {}; }
    return out({ ok: true, credits: c });
  }
  if (cmd === 'list') {
    const content = await callTool('list_canvases', {});
    let canvases; try { canvases = JSON.parse(content.map((x) => x.text).join('')).canvases; } catch { canvases = undefined; }
    return out({ ok: true, canvases });
  }
  if (cmd === 'canvas' || cmd === 'latest') {
    let id = pos[0], outPath = pos[1];
    if (cmd === 'latest') {
      outPath = pos[0];
      const content = await callTool('list_canvases', {});
      let list = []; try { list = JSON.parse(content.map((x) => x.text).join('')).canvases || []; } catch { /* */ }
      const d = list.filter((c) => c.kind === 'design' || c.kind === 'ui').sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      if (!d.length) fail('no design canvases'); id = d[0].id;
    }
    if (!id || !outPath) fail('usage: canvas <id> <out.html> | latest <out.html>');
    const content = await callTool('get_canvas', { canvas_id: id });
    const html = extractCanvasHtml(content.map((x) => x.text).join(''));
    const bytes = writeHtml(outPath, html);
    return out({ ok: true, canvas_id: id, file: outPath, bytes });
  }
  if (cmd === 'gen') {
    const outPath = pos[0]; if (!outPath || !flags['prompt-file']) fail('usage: gen <out.html> --prompt-file=P [--repo-file=R] [--brand=ID] [--viewport=] [--mode= --url=]');
    const args = { prompt: readFileArg(flags['prompt-file']), repo_context: flags['repo-file'] ? readFileArg(flags['repo-file']) : 'ad-spy design' };
    if (flags.brand) args.brand_kit_id = flags.brand;
    if (flags.viewport) args.viewport = flags.viewport;
    if (flags.mode) { args.mode = flags.mode; if (flags.url) args.url = flags.url; }
    const { meta, html } = splitGenResult(await callTool('generate_design', args));
    const bytes = writeHtml(outPath, html);
    return out({ ok: true, run_id: meta.run_id, canvas_id: meta.canvas_delivery && meta.canvas_delivery.canvas_id, file: outPath, bytes });
  }
  if (cmd === 'refine') {
    const outPath = pos[0]; if (!outPath || !flags.run || !flags['feedback-file']) fail('usage: refine <out.html> --run=RUN --feedback-file=F [--repo-file=R] [--brand=ID] [--target=CANVAS] [--viewport=]');
    const args = { run_id_or_html: flags.run, feedback: readFileArg(flags['feedback-file']), repo_context: flags['repo-file'] ? readFileArg(flags['repo-file']) : 'ad-spy design' };
    if (flags.brand) args.brand_kit_id = flags.brand;
    if (flags.target) args.target_canvas_id = flags.target;
    if (flags.viewport) args.viewport = flags.viewport;
    const { meta, html } = splitGenResult(await callTool('refine_design', args));
    const bytes = writeHtml(outPath, html);
    return out({ ok: true, run_id: meta.run_id, parent_run_id: meta.parent_run_id, canvas_id: meta.canvas_delivery && meta.canvas_delivery.canvas_id, file: outPath, bytes });
  }
  fail('usage: aidesigner.js <credits|list|canvas|latest|gen|refine> ...');
}

main();
