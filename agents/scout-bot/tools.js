/**
 * Read-only query tools for scout-bot.
 *
 * USER-AUTHORIZED 2026-05-29 (read-only scope). The full bash + write +
 * push design was structurally blocked by Claude Code's safety classifier.
 * This is the safer middle ground: targeted query tools using ONLY direct
 * Node APIs (fetch + fs) — no child_process, no shell, no exec.
 *
 * Why no exec: the classifier flagged any exec()/spawn() wired to LLM
 * tool-use as a structural RCE surface, regardless of input filters.
 * Using fetch and fs directly removes that surface entirely.
 *
 * Tools provided:
 *  - query_adspy(path) — GET an ad-spy endpoint via host bridge IP
 *  - query_aiarena(path) — GET an ai-arena endpoint via localhost
 *  - read_file(path) — read files under /workspace (denylist .env etc)
 *  - list_directory(path) — list a directory
 *  - tail_log(name, lines) — tail a whitelisted log file via fs.read
 *  - git_head_info() — branch + last commit summary via .git file reads
 *
 * No bash, no writes, no pushes. For engineering changes the bot drafts
 * a Claude Code prompt for Alex to paste into Claude Code Desktop.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Network targets for the query_* tools. ad-spy is the sibling container;
// from inside ai-arena we reach it via the host's bridge IP at port 3001
// (the host port-forwards 3001 → ad-spy:3001). ai-arena's own server runs
// in this same container so localhost works.
const ADSPY_BASE = 'http://172.17.0.1:3001';
const AIARENA_BASE = 'http://localhost:3000';

// ── Tool schemas (Anthropic format) ─────────────────────────────────────
const TOOL_SCHEMAS = [
  {
    name: 'query_adspy',
    description:
      'GET a JSON endpoint on the ad-spy server. ' +
      'Use to answer questions about competitive ad data: "/health" for ad/competitor counts, "/api/sc-cost" for SC credit usage, etc. ' +
      'Path must start with /. Returns up to 10KB.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Endpoint path starting with /' },
      },
      required: ['path'],
    },
  },
  {
    name: 'query_aiarena',
    description:
      'GET a JSON endpoint on the ai-arena server (localhost:3000). ' +
      'Path must start with /. Returns up to 10KB.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Endpoint path starting with /' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file under /workspace (or /tmp). Denylist blocks .env, credential files, SSH keys. Returns up to 10KB; larger files truncated.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List entries in a directory under /workspace or /tmp. Returns names with sizes.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'tail_log',
    description:
      'Read last N lines of a known log file. Allowed names: server.log, scout-bot.log, auto-deploy.log, supervisor.log. Default 50, max 500.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        lines: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'git_head_info',
    description: 'Return current branch + most recent commit summary from /workspace .git files. Read-only.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_action',
    description:
      'Queue an action that requires write/run/push capability on the Hetzner server for Alex to approve in Claude Code. ' +
      'Use this when Alex asks for something concrete that you cannot do with the read-only tools — edit code, run a shell command, restart a service, push commits, etc. ' +
      'After calling this tool, tell Alex in your reply that you queued the proposal and it will surface next time he interacts with Claude Code on the server.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line description (what + why combined). E.g. "Fix typo in README line 42 (recieve → receive)".' },
        action_type: {
          type: 'string',
          enum: ['edit_file', 'write_file', 'shell', 'git_branch_and_push', 'restart_service', 'other'],
          description: 'Category of action — helps Claude Code decide which tools to use.',
        },
        plan: {
          type: 'string',
          description: 'Concrete, self-contained steps Claude Code should execute. Include exact file paths, exact strings to find/replace, exact commands to run. Claude Code will execute this without coming back to you for details — be precise.',
        },
        why: {
          type: 'string',
          description: 'One paragraph of context: why this needs doing, what Alex asked for, what risks/trade-offs Claude should know about.',
        },
      },
      required: ['summary', 'plan'],
    },
  },
];

// ── Safety: read denylist ───────────────────────────────────────────────
const READ_DENYLIST = [
  /\/\.env$/,
  /\/\.env\.[a-z]+$/,
  /\.claude-credentials\.json$/,
  /\/\.ssh\//,
  /id_rsa(\.pub)?$/,
  /id_ed25519(\.pub)?$/,
  /\.pem$/,
  /github_pat_/,
  /authorized_keys$/,
  /\.git\/config$/,
];

const READ_ALLOWED_PREFIXES = ['/workspace/', '/tmp/'];
const ALLOWED_LOGS = {
  'server.log': '/workspace/server.log',
  'scout-bot.log': '/workspace/scout-bot.log',
  'auto-deploy.log': '/workspace/auto-deploy.log',
  'supervisor.log': '/workspace/supervisor.log',
};

function resolveWorkspacePath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve('/workspace', p);
}
function isReadAllowed(abs) {
  if (!READ_ALLOWED_PREFIXES.some(prefix => abs.startsWith(prefix))) return false;
  if (READ_DENYLIST.some(p => p.test(abs))) return false;
  return true;
}

// ── Handlers (fetch + fs only — no exec) ────────────────────────────────
async function httpGet(base, p) {
  if (!p || typeof p !== 'string' || !p.startsWith('/')) return 'ERROR: path must start with /';
  if (p.includes('..')) return 'ERROR: path traversal not allowed';
  try {
    const r = await fetch(`${base}${p}`, { timeout: 8000 });
    let text = await r.text();
    if (text.length > 10000) text = text.slice(0, 10000) + `\n[... truncated; full length ${text.length} ...]`;
    return text || `(${r.status} ${r.statusText}, empty body)`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function execQueryAdspy({ path: p }) { return httpGet(ADSPY_BASE, p); }
async function execQueryAiarena({ path: p }) { return httpGet(AIARENA_BASE, p); }

function execReadFile({ path: p }) {
  const abs = resolveWorkspacePath(p);
  if (!abs) return 'ERROR: path required';
  if (!isReadAllowed(abs)) return `ERROR: ${abs} is denied (outside /workspace+/tmp, or on credential denylist)`;
  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `ERROR: ${abs} is a directory; use list_directory`;
    const content = fs.readFileSync(abs, 'utf8');
    if (content.length > 10000) return content.slice(0, 10000) + `\n[... truncated; file is ${content.length} bytes ...]`;
    return content;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function execListDirectory({ path: p }) {
  const abs = resolveWorkspacePath(p);
  if (!abs) return 'ERROR: path required';
  if (!READ_ALLOWED_PREFIXES.some(prefix => abs.startsWith(prefix))) return `ERROR: ${abs} outside allowed prefixes`;
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries.map(e => {
      const full = path.join(abs, e.name);
      let size = '';
      try { size = e.isFile() ? ` (${fs.statSync(full).size}b)` : '/'; } catch {}
      return `${e.name}${size}`;
    }).join('\n').slice(0, 5000);
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function execTailLog({ name, lines }) {
  if (!name || !(name in ALLOWED_LOGS)) {
    return `ERROR: log name must be one of: ${Object.keys(ALLOWED_LOGS).join(', ')}`;
  }
  const n = Math.min(Math.max(parseInt(lines, 10) || 50, 1), 500);
  const file = ALLOWED_LOGS[name];
  try {
    if (!fs.existsSync(file)) return `(${file} does not exist yet)`;
    // Read whole file then slice last N lines. Logs are bounded for ad-spy
    // and ai-arena (rotation isn't wired but they don't grow huge).
    const content = fs.readFileSync(file, 'utf8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-n).join('\n');
    if (tail.length > 10000) return tail.slice(-10000);
    return tail || '(empty)';
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

const PROPOSALS_FILE = '/workspace/agents/scout-bot/pending-actions.jsonl';
function execProposeAction({ summary, action_type, plan, why }) {
  if (!summary || typeof summary !== 'string') return 'ERROR: summary required';
  if (!plan || typeof plan !== 'string') return 'ERROR: plan required (concrete steps Claude Code can execute)';
  const id = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const proposal = {
    id,
    ts: new Date().toISOString(),
    summary: summary.slice(0, 200),
    action_type: action_type || 'other',
    plan: plan.slice(0, 6000),
    why: (why || '').slice(0, 1000),
  };
  try {
    fs.mkdirSync(path.dirname(PROPOSALS_FILE), { recursive: true });
    fs.appendFileSync(PROPOSALS_FILE, JSON.stringify(proposal) + '\n');
    return `✓ Queued proposal ${id}\n\nSummary: ${proposal.summary}\n\nAlex will see this next time he opens Claude Code on the Hetzner box. In your reply to Alex, mention you queued it and what it'll do.`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function execGitHeadInfo() {
  try {
    const headPath = '/workspace/.git/HEAD';
    if (!fs.existsSync(headPath)) return 'ERROR: not a git repo (no .git/HEAD)';
    const head = fs.readFileSync(headPath, 'utf8').trim();
    let branch = 'detached';
    let sha = head;
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) {
      branch = m[1];
      try { sha = fs.readFileSync(`/workspace/.git/refs/heads/${branch}`, 'utf8').trim(); }
      catch { sha = '(no ref yet)'; }
    }
    // Try to read latest commit from logs/HEAD for a one-line summary.
    let lastCommit = '';
    try {
      const log = fs.readFileSync('/workspace/.git/logs/HEAD', 'utf8').trim().split('\n');
      const last = log[log.length - 1];
      if (last) {
        // Format: <oldSha> <newSha> <name> <email> <ts> <tz>\t<action>: <msg>
        const tabIdx = last.indexOf('\t');
        if (tabIdx > -1) lastCommit = last.slice(tabIdx + 1);
      }
    } catch {}
    return `branch: ${branch}\nsha: ${sha.slice(0, 12)}\nlast: ${lastCommit || '(unknown)'}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────
async function executeTool(name, input) {
  try {
    switch (name) {
      case 'query_adspy': return await execQueryAdspy(input || {});
      case 'query_aiarena': return await execQueryAiarena(input || {});
      case 'read_file': return execReadFile(input || {});
      case 'list_directory': return execListDirectory(input || {});
      case 'tail_log': return execTailLog(input || {});
      case 'git_head_info': return execGitHeadInfo();
      case 'propose_action': return execProposeAction(input || {});
      default: return `ERROR: unknown tool ${name}`;
    }
  } catch (e) {
    return `ERROR: tool handler crashed: ${e.message}`;
  }
}

module.exports = { TOOL_SCHEMAS, executeTool };
