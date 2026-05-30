#!/usr/bin/env node
'use strict';
/*
 * aidesigner-fetch.js — pull AIDesigner canvas HTML straight from the API to a
 * file, so design HTML NEVER round-trips through the model's output (the single
 * biggest token sink in the loop). Runs in ai-arena (api.aidesigner.ai is
 * reachable). Auth reuses the headersHelper that already mints/caches tokens.
 *
 *   node aidesigner-fetch.js list                 # newest-first canvases (JSON)
 *   node aidesigner-fetch.js canvas <id> <out.html>
 *   node aidesigner-fetch.js latest <out.html>    # newest design/ui canvas
 *
 * Prints one-line JSON {ok,...}. Exits non-zero on any failure / bad HTML.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENDPOINT = 'https://api.aidesigner.ai/api/v1/mcp';
const HEADERS_HELPER = process.env.AIDESIGNER_HEADERS_HELPER
  || '/home/node/.claude/scripts/aidesigner-headers.sh';

function fail(msg) { process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n'); process.exit(1); }
function out(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function authHeader() {
  try {
    const raw = execSync(`bash ${HEADERS_HELPER}`, { encoding: 'utf8' });
    const h = JSON.parse(raw);
    if (!h.Authorization) throw new Error('no Authorization in helper output');
    return h.Authorization;
  } catch (e) { fail('auth helper failed: ' + e.message); }
}

let _id = 0;
function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params });
  return new Promise((resolve) => {
    const u = new URL(ENDPOINT);
    const req = https.request(u, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('data:')) { // SSE framing
          text = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        }
        let json; try { json = JSON.parse(text); } catch { return resolve({ error: 'bad json: ' + text.slice(0, 120) }); }
        resolve(json);
      });
    });
    req.on('error', (e) => resolve({ error: String(e.message) }));
    req.write(body); req.end();
  });
}

// tools/call -> merged text content
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  if (r.error) fail(name + ' rpc error: ' + (r.error.message || JSON.stringify(r.error)));
  const content = (r.result && r.result.content) || [];
  return content.map((c) => c.text || '').join('');
}

// design canvases return a JSON wrapper holding the HTML; extract it.
function extractHtml(text) {
  if (/^\s*<(!doctype|html)/i.test(text)) return text;
  try {
    const j = JSON.parse(text);
    const html = (j.canvas && (j.canvas.html || j.canvas.content)) || j.html || j.content;
    if (typeof html === 'string') return html;
  } catch { /* not json */ }
  const m = text.match(/<(?:!doctype|html)[\s\S]*<\/html>/i); // last resort: carve it out
  return m ? m[0] : null;
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);

  if (cmd === 'list') {
    const text = await callTool('list_canvases', {});
    let canvases; try { canvases = JSON.parse(text).canvases; } catch { canvases = undefined; }
    return out({ ok: true, canvases });
  }

  if (cmd === 'canvas' || cmd === 'latest') {
    let canvasId = a1, outPath = a2;
    if (cmd === 'latest') {
      outPath = a1;
      const text = await callTool('list_canvases', {});
      let list; try { list = JSON.parse(text).canvases || []; } catch { list = []; }
      const design = list.filter((c) => c.kind === 'design' || c.kind === 'ui');
      if (!design.length) fail('no design/ui canvases found');
      canvasId = design[0].id; // list_canvases is newest-first
    }
    if (!canvasId || !outPath) fail('usage: canvas <id> <out.html>  |  latest <out.html>');
    const text = await callTool('get_canvas', { canvas_id: canvasId });
    const html = extractHtml(text);
    if (!html || html.length < 200 || !/<html|<!doctype/i.test(html)) fail('canvas HTML invalid/empty (len ' + (html ? html.length : 0) + ')');
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, html);
    return out({ ok: true, canvas_id: canvasId, file: outPath, bytes: html.length });
  }

  fail('usage: aidesigner-fetch.js <list|canvas|latest> ...');
}

main();
