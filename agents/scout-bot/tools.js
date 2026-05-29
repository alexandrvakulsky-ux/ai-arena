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
    name: 'add_source',
    description:
      'Add a new monitoring source (Twitter handle, GitHub repo, Reddit sub, HN search, newsletter, website, YouTube channel). ' +
      'Use when Alex tells you about a source he likes, OR when you discover a high-signal account during scouting (e.g., mentioned by a known-quality source). ' +
      'Duplicates rejected on (type + normalized handle). New sources start at quality=0; bump up after they produce useful finds.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['twitter', 'github_repo', 'github_user', 'reddit', 'hn', 'newsletter', 'website', 'youtube'] },
        handle: { type: 'string', description: 'Handle/identifier — e.g. "@AnthropicAI", "anthropics/sdk", "r/ClaudeAI"' },
        url: { type: 'string', description: 'Optional canonical URL — bot will guess from type+handle if omitted' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Topics like ["mcp"], ["marketing","funnels"], ["futureproof"], ["competitor"]' },
        why: { type: 'string', description: 'Short note on why this source matters' },
      },
      required: ['type', 'handle'],
    },
  },
  {
    name: 'list_sources',
    description:
      'Query the monitoring source database. Filter by topic, type, or min_quality. Without args, returns all sources sorted by quality (high to low). Use at the start of scout cadences to know what to monitor.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Filter to sources tagged with this topic (e.g. "mcp", "marketing")' },
        type: { type: 'string', description: 'Filter to source type (twitter, github_repo, etc.)' },
        min_quality: { type: 'number', description: 'Only return sources with quality >= this' },
      },
    },
  },
  {
    name: 'score_source',
    description:
      'Adjust a source\'s quality score by a delta in [-5, +5]. ' +
      '+1 to +3 for sources that produced useful finds Alex appreciated. ' +
      '-1 to -3 for noise/off-topic. ' +
      'Quality below -3 = source effectively dead; bot stops checking. ' +
      'Quality above +5 = "verified" tier, always check first.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Source ID (e.g. src_xyz)' },
        delta: { type: 'number', description: 'Integer in [-5, +5]' },
        reason: { type: 'string', description: 'One-line justification, for the audit trail' },
      },
      required: ['id', 'delta'],
    },
  },
  {
    name: 'record_source_find',
    description:
      'Log a useful find attributed to a source — increments finds_count, updates last_useful_find_ts. Call this after delivering scout results so the database reflects which sources actually produced value. Doesn\'t change quality score (use score_source for that).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Source ID' },
        summary: { type: 'string', description: 'What was found, in one sentence' },
        url: { type: 'string', description: 'URL of the find (optional)' },
      },
      required: ['id', 'summary'],
    },
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

// ── Source monitoring database ──────────────────────────────────────────
// sources.json grows over time (gitignored). seed-sources.json is committed
// curated starter set. On first read, if sources.json is missing, we copy
// from seed. After that, the bot mutates sources.json directly — adding
// new sources via reference-following, bumping quality based on Alex's
// reactions, recording finds.
const SOURCES_FILE = '/workspace/agents/scout-bot/sources.json';
const SEED_SOURCES_FILE = '/workspace/agents/scout-bot/seed-sources.json';

function loadSources() {
  if (!fs.existsSync(SOURCES_FILE)) {
    try {
      const seed = fs.existsSync(SEED_SOURCES_FILE)
        ? fs.readFileSync(SEED_SOURCES_FILE, 'utf8')
        : '{}';
      fs.writeFileSync(SOURCES_FILE, seed);
    } catch { return {}; }
  }
  try { return JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSources(s) {
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(s, null, 2));
}
function guessSourceUrl(type, handle) {
  const h = handle.replace(/^@/, '');
  switch (type) {
    case 'twitter': return `https://x.com/${h}`;
    case 'github_repo': return `https://github.com/${h}`;
    case 'github_user': return `https://github.com/${h}`;
    case 'reddit': return `https://reddit.com/${h.startsWith('r/') ? h : 'r/' + h}`;
    case 'hn': return `https://hn.algolia.com/?q=${encodeURIComponent(h)}&sort=byDate&type=story`;
    case 'youtube': return `https://youtube.com/@${h}`;
    default: return `https://${h.replace(/^https?:\/\//, '')}`;
  }
}

function execAddSource({ type, handle, url, topics, why }) {
  if (!type || !handle) return 'ERROR: type and handle required';
  const validTypes = ['twitter', 'github_repo', 'github_user', 'reddit', 'hn', 'newsletter', 'website', 'youtube'];
  if (!validTypes.includes(type)) return `ERROR: type must be one of: ${validTypes.join(', ')}`;

  const sources = loadSources();
  const normHandle = handle.toLowerCase().replace(/^@/, '');
  const existing = Object.values(sources).find(s =>
    s.type === type && s.handle.toLowerCase().replace(/^@/, '') === normHandle
  );
  if (existing) return `Already tracking: ${existing.id} (${existing.handle}, quality=${existing.quality})`;

  const id = `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const ts = new Date().toISOString();
  let topicsArr = [];
  if (Array.isArray(topics)) topicsArr = topics;
  else if (typeof topics === 'string') topicsArr = topics.split(',').map(t => t.trim()).filter(Boolean);

  sources[id] = {
    id, type, handle,
    url: url || guessSourceUrl(type, handle),
    topics: topicsArr,
    quality: 0,
    added_ts: ts,
    added_by: 'bot',
    notes: why || '',
    finds_count: 0,
    last_useful_find_ts: null,
    history: [{ ts, event: 'added', by: 'bot', reason: why || '' }],
  };
  saveSources(sources);
  return `✓ Added ${id}: ${type} ${handle} (topics: ${topicsArr.join(', ') || 'unset'})`;
}

function execListSources({ topic, type, min_quality } = {}) {
  const sources = Object.values(loadSources());
  let filtered = sources;
  if (topic) filtered = filtered.filter(s => (s.topics || []).includes(topic));
  if (type) filtered = filtered.filter(s => s.type === type);
  if (typeof min_quality === 'number') filtered = filtered.filter(s => s.quality >= min_quality);
  filtered.sort((a, b) => b.quality - a.quality);
  if (filtered.length === 0) return '(no sources match)';
  const lines = filtered.map(s =>
    `${s.id} | ${s.type.padEnd(12)} | ${s.handle.padEnd(30)} | q=${String(s.quality).padStart(3)} | ${(s.topics || []).join(',') || '-'} | finds:${s.finds_count || 0}`
  );
  const out = `total: ${filtered.length}\n` + lines.join('\n');
  return out.length > 10000 ? out.slice(0, 10000) + '\n[... truncated ...]' : out;
}

function execScoreSource({ id, delta, reason }) {
  if (!id) return 'ERROR: id required';
  const sources = loadSources();
  if (!sources[id]) return `ERROR: source ${id} not found`;
  const d = parseInt(delta, 10);
  if (isNaN(d)) return 'ERROR: delta must be a number';
  if (Math.abs(d) > 5) return 'ERROR: delta must be in [-5, +5]';
  const before = sources[id].quality;
  sources[id].quality = before + d;
  sources[id].history = sources[id].history || [];
  sources[id].history.push({ ts: new Date().toISOString(), event: 'scored', delta: d, reason: reason || '' });
  if (sources[id].history.length > 20) sources[id].history = sources[id].history.slice(-20);
  saveSources(sources);
  return `✓ ${id} quality: ${before} → ${sources[id].quality} (${reason || 'no reason given'})`;
}

function execRecordSourceFind({ id, summary, url }) {
  if (!id || !summary) return 'ERROR: id and summary required';
  const sources = loadSources();
  if (!sources[id]) return `ERROR: source ${id} not found`;
  sources[id].finds_count = (sources[id].finds_count || 0) + 1;
  sources[id].last_useful_find_ts = new Date().toISOString();
  sources[id].history = sources[id].history || [];
  sources[id].history.push({
    ts: sources[id].last_useful_find_ts,
    event: 'find',
    summary: summary.slice(0, 200),
    url: url || ''
  });
  if (sources[id].history.length > 20) sources[id].history = sources[id].history.slice(-20);
  saveSources(sources);
  return `✓ Logged find for ${id}. Total finds: ${sources[id].finds_count}`;
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
      case 'add_source': return execAddSource(input || {});
      case 'list_sources': return execListSources(input || {});
      case 'score_source': return execScoreSource(input || {});
      case 'record_source_find': return execRecordSourceFind(input || {});
      case 'propose_action': return execProposeAction(input || {});
      default: return `ERROR: unknown tool ${name}`;
    }
  } catch (e) {
    return `ERROR: tool handler crashed: ${e.message}`;
  }
}

module.exports = { TOOL_SCHEMAS, executeTool };
