#!/usr/bin/env node
'use strict';
/*
 * webvizio.js — Webvizio REST relay, RUN INSIDE the ad-spy container.
 * The ai-arena container is firewalled off app.webvizio.com, so the registered
 * @webvizio/mcp-server is dead there; ad-spy has open internet. Invoke via the
 * `wv` wrapper (resolves the key, copies this in, copies screenshots back).
 *
 * Auth: WEBVIZIO_API_KEY env. Project: WEBVIZIO_PROJECT env or default below.
 * All output is one-line JSON on stdout (except `shot`, which writes a PNG).
 *
 *   node webvizio.js projects
 *   node webvizio.js tasks                 # open tasks (closed ones drop off)
 *   node webvizio.js task <uuid>
 *   node webvizio.js prompt <uuid>
 *   node webvizio.js logs <uuid>
 *   node webvizio.js shot <uuid> <out.png>
 *   node webvizio.js close <uuid>
 *   node webvizio.js pull <outDir>         # tasks + prompts + screenshots -> outDir/
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.webvizio.com/api/mcp/v1';
const KEY = process.env.WEBVIZIO_API_KEY || '';
const PROJECT = process.env.WEBVIZIO_PROJECT || '826083f4-89c2-460a-8f8e-1aede04c40f2';
if (!KEY) { fail('no WEBVIZIO_API_KEY in env'); }

function fail(msg) { process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n'); process.exit(1); }
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

// Returns { status, json|text|buffer }. binary=true keeps raw bytes (screenshots).
function req(method, p, body, binary) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + p);
    const headers = { Authorization: 'Bearer ' + KEY, Accept: binary ? '*/*' : 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    else headers['Content-Length'] = 0;
    const r = https.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary) return resolve({ status: res.statusCode, buffer: buf });
        const text = buf.toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', (e) => resolve({ status: 0, text: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
}

async function setProject() {
  const r = await req('POST', '/set-project', { uuid: PROJECT });
  if (r.status !== 200) fail('set-project failed: ' + r.status + ' ' + (r.text || ''));
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);

  if (cmd === 'projects') {
    const r = await req('GET', '/projects');
    return out({ ok: r.status === 200, projects: r.json });
  }
  if (cmd === 'tasks') {
    await setProject();
    const r = await req('GET', '/tasks');
    return out({ ok: r.status === 200, project: PROJECT, count: (r.json || []).length, tasks: r.json });
  }
  if (cmd === 'task') {
    if (!a1) fail('usage: task <uuid>');
    await setProject();
    const r = await req('GET', '/task/' + a1);
    return out({ ok: r.status === 200, task: r.json });
  }
  if (cmd === 'prompt') {
    if (!a1) fail('usage: prompt <uuid>');
    await setProject();
    const r = await req('GET', '/task/' + a1 + '/prompt');
    return out({ ok: r.status === 200, prompt: r.json !== undefined ? r.json : r.text });
  }
  if (cmd === 'logs') {
    if (!a1) fail('usage: logs <uuid>');
    await setProject();
    const r = await req('GET', '/task/' + a1 + '/console-logs');
    return out({ ok: r.status === 200, logs: r.json !== undefined ? r.json : r.text });
  }
  if (cmd === 'shot') {
    if (!a1 || !a2) fail('usage: shot <uuid> <out.png>');
    await setProject();
    const r = await req('GET', '/task/' + a1 + '/screenshot', null, true);
    if (r.status !== 200 || !r.buffer || !r.buffer.length) fail('screenshot failed: ' + r.status);
    fs.mkdirSync(path.dirname(a2), { recursive: true });
    fs.writeFileSync(a2, r.buffer);
    return out({ ok: true, file: a2, bytes: r.buffer.length });
  }
  if (cmd === 'close') {
    if (!a1) fail('usage: close <uuid>');
    await setProject();
    const r = await req('POST', '/task/' + a1 + '/close');
    return out({ ok: r.status === 200, status: r.status, body: r.json !== undefined ? r.json : r.text });
  }
  if (cmd === 'pull') {
    const dir = a1 || '/tmp/wv-pull';
    fs.mkdirSync(dir, { recursive: true });
    await setProject();
    const tr = await req('GET', '/tasks');
    if (tr.status !== 200) fail('tasks failed: ' + tr.status);
    const tasks = tr.json || [];
    const enriched = [];
    for (const t of tasks) {
      const uuid = t.uuid;
      const pr = await req('GET', '/task/' + uuid + '/prompt');
      const sh = await req('GET', '/task/' + uuid + '/screenshot', null, true);
      let shotFile = null;
      if (sh.status === 200 && sh.buffer && sh.buffer.length) {
        shotFile = path.join(dir, uuid + '.png');
        fs.writeFileSync(shotFile, sh.buffer);
      }
      enriched.push({ uuid, number: t.number, title: t.title, priority: t.priority,
        prompt: pr.json !== undefined ? pr.json : pr.text, screenshot: shotFile });
    }
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(enriched, null, 2));
    return out({ ok: true, dir, count: enriched.length, tasks: enriched.map((t) => ({ uuid: t.uuid, number: t.number, title: t.title, screenshot: t.screenshot })) });
  }

  fail('usage: webvizio.js <projects|tasks|task|prompt|logs|shot|close|pull> ...');
}

main();
