#!/usr/bin/env node
/**
 * Save a compact conversation summary from a Claude Code JSONL session file.
 * Strips tool calls, thinking blocks, and metadata — keeps only user/assistant text.
 * Output: /workspace/.claude/sessions/YYYY-MM-DD-{sessionId}.md (committed to git for cross-device sync)
 *
 * Called by the Stop hook in .claude/settings.json.
 * Receives JSON on stdin: { session_id, transcript_path }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SESSIONS_DIR = '/workspace/.claude/sessions';
const REPO_DIR = '/workspace';
const MAX_ASSISTANT_CHARS = 800;

function extractText(content) {
  if (!Array.isArray(content)) return String(content || '').trim();
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text || '')
    .join(' ')
    .trim();
}

async function main() {
  let input = {};
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
    if (raw) input = JSON.parse(raw);
  } catch {}

  // Resolve the JSONL file
  let jsonlPath = input.transcript_path;
  if (!jsonlPath && input.session_id) {
    jsonlPath = path.join(
      os.homedir(),
      `.claude/projects/-workspace/${input.session_id}.jsonl`
    );
  }
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    // Fallback: newest JSONL in project dir
    const dir = path.join(os.homedir(), '.claude/projects/-workspace');
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) { console.log('No session file found.'); return; }
    jsonlPath = path.join(dir, files[0].name);
  }

  const sessionId = path.basename(jsonlPath, '.jsonl').slice(0, 8);
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');

  // Extract ai-title if present
  let title = '';
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'ai-title') { title = entry.title || ''; break; }
    } catch {}
  }

  // Extract user/assistant messages in order
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.role === 'user') {
        // Skip tool result messages (only user-typed text)
        const content = entry.message.content;
        if (Array.isArray(content) && content.every(c => c.type === 'tool_result')) continue;
        const text = extractText(content);
        if (text) messages.push({ role: 'User', text });
      } else if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
        const text = extractText(entry.message.content);
        if (text) {
          const truncated = text.length > MAX_ASSISTANT_CHARS
            ? text.slice(0, MAX_ASSISTANT_CHARS) + '…'
            : text;
          messages.push({ role: 'Claude', text: truncated });
        }
      }
    } catch {}
  }

  if (messages.length < 2) {
    console.log('Session too short to save.');
    return;
  }

  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const outFile = path.join(SESSIONS_DIR, `${date}-${sessionId}.md`);

  const header = [
    `# Session ${sessionId} — ${date}`,
    title ? `\n_${title}_` : '',
    `\n_${messages.filter(m => m.role === 'User').length} exchanges · saved from ${path.basename(jsonlPath)}_`,
    ''
  ].filter(Boolean).join('\n');

  const body = messages.map(m => `**${m.role}:** ${m.text}`).join('\n\n');
  const output = header + '\n' + body + '\n';

  fs.writeFileSync(outFile, output);

  const origSize = fs.statSync(jsonlPath).size;
  const newSize = Buffer.byteLength(output);
  console.log(
    `Session saved: ${path.basename(outFile)} ` +
    `(${Math.round(origSize / 1024)}KB → ${Math.round(newSize / 1024)}KB, ` +
    `${Math.round((1 - newSize / origSize) * 100)}% smaller)`
  );
}

main().catch(err => { console.error('save-session error:', err.message); });
