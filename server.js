require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const crypto  = require('crypto');

const app = express();

// ── Security headers ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com; " +
    "font-src fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self'"
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use('/api/transcribe', express.raw({ type: 'audio/*', limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT         = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || null;
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const MAX_QUESTION_LEN = 2000;

['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'APP_PASSWORD'].forEach(k => {
  if (!process.env[k]) console.warn(`⚠️  ${k} not set`);
});

// ── Provider registry ──
// Each provider knows how to build a request, parse the response, and report errors.
// Adding a new model = add an entry here; no other code changes needed.
const PROVIDERS = {
  claude: {
    model:      'claude-opus-4-6',
    envKey:     'ANTHROPIC_API_KEY',
    maxTokens:  2000,
    timeoutMs:  45000,
    thinkingTimeoutMs: 90000,
    async call(prompt, messages, { maxTokens, thinking, thinkingBudget, signal } = {}) {
      const tokens = maxTokens ?? this.maxTokens;
      const body = {
        model: this.model,
        max_tokens: thinking ? thinkingBudget + tokens : tokens,
        messages,
      };
      if (thinking) body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };

      const res = await fetchJSON('https://api.anthropic.com/v1/messages', {
        headers: {
          'x-api-key': process.env[this.envKey],
          'anthropic-version': '2023-06-01',
        },
        body,
        timeoutMs: thinking ? this.thinkingTimeoutMs : this.timeoutMs,
        signal,
      });
      if (res.error) throw new Error(res.error.message || 'Claude API error');
      const textBlock = res.content?.find(b => b.type === 'text');
      if (!textBlock) throw new Error('Claude returned no text block');
      return textBlock.text;
    },
  },

  openai: {
    model:     'gpt-4o',
    envKey:    'OPENAI_API_KEY',
    maxTokens: 2000,
    timeoutMs: 45000,
    async call(prompt, messages, { maxTokens, signal } = {}) {
      const res = await fetchJSON('https://api.openai.com/v1/chat/completions', {
        headers: { Authorization: `Bearer ${process.env[this.envKey]}` },
        body: {
          model: this.model,
          max_tokens: maxTokens ?? this.maxTokens,
          messages,
        },
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (res.error) throw new Error(res.error.message || 'OpenAI API error');
      return res.choices[0].message.content;
    },
  },

  gemini: {
    model:     'gemini-2.5-flash',
    envKey:    'GOOGLE_API_KEY',
    maxTokens: 4096,
    timeoutMs: 60000,
    async call(prompt, messages, { maxTokens, signal } = {}) {
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: m.content }],
      }));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${process.env[this.envKey]}`;
      const res = await fetchJSON(url, {
        body: { contents, generationConfig: { maxOutputTokens: maxTokens ?? this.maxTokens } },
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (res.error) throw new Error(res.error.message || 'Gemini API error');
      const candidate = res.candidates?.[0];
      if (!candidate) throw new Error('Gemini returned no candidates');
      const text = candidate.content?.parts?.[0]?.text || '';
      if (candidate.finishReason === 'MAX_TOKENS') return text + '\n\n*[Response truncated — hit token limit]*';
      if (candidate.finishReason === 'SAFETY')     throw new Error('Gemini blocked the response (safety filter)');
      return text;
    },
  },
};

const MODEL_NAMES = Object.keys(PROVIDERS);

// ── Shared helpers ──

async function fetchJSON(url, { headers = {}, body, timeoutMs = 45000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).reduce((acc, t) => {
    if (t && typeof t.question === 'string' && typeof t.synthesis === 'string') {
      acc.push({ question: t.question.slice(0, 500), synthesis: t.synthesis.slice(0, 2000) });
    }
    return acc;
  }, []);
}

function buildMessages(history, prompt) {
  const messages = history.flatMap(t => [
    { role: 'user',      content: t.question },
    { role: 'assistant', content: t.synthesis },
  ]);
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function callModel(name, prompt, { maxTokens, history = [], thinking = false, thinkingBudget = 8000, signal } = {}) {
  const provider = PROVIDERS[name];
  if (!process.env[provider.envKey]) return Promise.reject(new Error(`${provider.envKey} not configured`));
  const messages = buildMessages(history, prompt);
  return provider.call(prompt, messages, { maxTokens, thinking, thinkingBudget, signal });
}

// ── Rate limiter ──
const rateLimitStore = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const ip  = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = rateLimitStore.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count++;
    rateLimitStore.set(ip, rec);
    if (rec.count > max) return res.status(429).json({ error: 'Too many requests — slow down.' });
    next();
  };
}

// ── Auth ──
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.headers['x-app-token'] === SESSION_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

const LOCKOUT_MAX      = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;
const lockoutStore     = new Map();

function getLockout(ip) {
  const rec = lockoutStore.get(ip);
  if (!rec?.lockedUntil) return null;
  if (Date.now() < rec.lockedUntil) return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  lockoutStore.delete(ip);
  return null;
}

function recordFailure(ip) {
  const rec = lockoutStore.get(ip) || { attempts: 0, lockedUntil: null };
  rec.attempts++;
  if (rec.attempts >= LOCKOUT_MAX) {
    rec.lockedUntil = Date.now() + LOCKOUT_DURATION;
    rec.attempts = 0;
  }
  lockoutStore.set(ip, rec);
}

app.post('/api/auth', rateLimit(60_000, 10), (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, token: SESSION_TOKEN });
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const minsLeft = getLockout(ip);
  if (minsLeft) return res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${minsLeft} min.` });

  const { password } = req.body;
  if (typeof password !== 'string') return res.status(400).json({ ok: false, error: 'Invalid input' });

  if (password === APP_PASSWORD) {
    lockoutStore.delete(ip);
    return res.json({ ok: true, token: SESSION_TOKEN });
  }
  recordFailure(ip);
  const locked = getLockout(ip);
  if (locked) return res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${locked} min.` });
  const remaining = LOCKOUT_MAX - (lockoutStore.get(ip)?.attempts || 0);
  res.status(401).json({ ok: false, error: `Wrong password. ${remaining} attempt${remaining === 1 ? '' : 's'} left.` });
});

app.get('/api/verify', requireAuth, (_req, res) => res.json({ ok: true }));

// Health check — no auth, used by Railway and UptimeRobot
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── /api/ask — all models answer in parallel ──
app.post('/api/ask', requireAuth, rateLimit(60_000, 20), async (req, res) => {
  const { question, history: rawHistory, stream } = req.body;
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });
  if (question.length > MAX_QUESTION_LEN)        return res.status(400).json({ error: `question must be under ${MAX_QUESTION_LEN} characters` });

  const history = sanitizeHistory(rawHistory);
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  const calls = Object.fromEntries(
    MODEL_NAMES.map(name => [name, callModel(name, question, { history, signal: ac.signal })])
  );

  if (!stream) {
    const results = await Promise.allSettled(Object.values(calls));
    const out = {}, errors = {};
    MODEL_NAMES.forEach((name, i) => {
      out[name]    = results[i].status === 'fulfilled' ? results[i].value : null;
      errors[name] = results[i].status === 'rejected'  ? results[i].reason.message : null;
    });
    return res.json({ ...out, errors });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  let finished = 0;
  for (const [model, promise] of Object.entries(calls)) {
    promise
      .then(text => { if (!res.writableEnded) res.write(JSON.stringify({ model, text }) + '\n'); })
      .catch(err => { if (!res.writableEnded) res.write(JSON.stringify({ model, error: err.message }) + '\n'); })
      .finally(() => { if (++finished === MODEL_NAMES.length) res.end(); });
  }
});

// ── /api/synthesize — propose → challenge → revise ──
app.post('/api/synthesize', requireAuth, rateLimit(60_000, 20), async (req, res) => {
  const { question, responses } = req.body;
  if (!question || typeof question !== 'string')  return res.status(400).json({ error: 'question is required' });
  if (question.length > MAX_QUESTION_LEN)         return res.status(400).json({ error: `question must be under ${MAX_QUESTION_LEN} characters` });
  if (!responses || typeof responses !== 'object') return res.status(400).json({ error: 'responses is required' });

  const safe = Object.fromEntries(
    MODEL_NAMES.map(name => [name, typeof responses[name] === 'string' ? responses[name].slice(0, 4000) : null])
  );

  // Blind labels: shuffle so no model can identify its own response
  const shuffled = [...MODEL_NAMES].sort(() => Math.random() - 0.5);
  const labelOf = {}, modelOf = {};
  shuffled.forEach((name, i) => {
    const label = String.fromCharCode(65 + i);
    labelOf[name] = label;
    modelOf[label] = name;
  });

  const responseBlock = MODEL_NAMES
    .map(name => `--- Response ${labelOf[name]} ---\n${safe[name] || '[No response]'}`)
    .join('\n\n');

  const labelsStr = MODEL_NAMES.map(n => `${labelOf[n]}=X/10`).join(', ');
  const weaknessLines = MODEL_NAMES.map(n =>
    `Response ${labelOf[n]} weakness: [specific flaw, or "none" if solid]`
  ).join('\n');

  // ── Round 2: Challenge ──
  const challengePrompt = `A user asked: "${question}"

Three AI responses (identities hidden):

${responseBlock}

Score each response on factual accuracy and completeness (not style). Then identify the single biggest weakness or error in each. Be specific and critical — do not be agreeable or sycophantic.

Output exactly in this format:
Scores: ${labelsStr}
${weaknessLines}`;

  const challengeResults = await Promise.allSettled(
    MODEL_NAMES.map(name => callModel(name, challengePrompt, { maxTokens: 600 }))
  );

  const judgeOutputs = challengeResults.map(r => {
    const text = r.status === 'fulfilled' ? r.value : null;
    return { scores: parseScores(text), challenges: parseChallenges(text) };
  });

  const avgFor = (label) => {
    const vals = judgeOutputs.map(j => j.scores?.[label]).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : '?';
  };

  const finalScores = Object.fromEntries(MODEL_NAMES.map(n => [n, avgFor(labelOf[n])]));

  const challengeContext = judgeOutputs
    .map((j, i) => {
      const entries = Object.entries(j.challenges);
      return entries.length
        ? `Evaluator ${i + 1}: ${entries.map(([l, flaw]) => `Response ${l}: ${flaw}`).join(' | ')}`
        : null;
    })
    .filter(Boolean).join('\n');

  // ── Round 3: Revise ──
  const displayNames = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' };
  const synthesisPrompt = `A user asked: "${question}"

Three AI responses (identities hidden):

${responseBlock}

Independent evaluators identified these weaknesses:
${challengeContext || 'No significant weaknesses identified.'}

Using the strongest elements from each response and addressing the valid challenges, synthesize the definitive best answer. Do not mention this evaluation process.

Output exactly in this format:
Scores: ${labelsStr}

## ✨ Synthesized Answer

[answer]

Scoring (factual completeness and accuracy only): 9–10 = accurate and complete; 7–8 = mostly right, minor omissions; 5–6 = partial or mixed; 3–4 = thin or off-target; 1–2 = wrong or irrelevant; 0 = no response.

Rules:
- Answer directly as the expert. No mention of models or this process.
- One short intro sentence, then ## / ### and bullets only where they add clarity.
- If the question involves options, metrics, or tradeoffs, include one concise markdown table.
- Every sentence must carry factual payload. No hedging, no filler.`;

  try {
    const synthesis = await callModel('claude', synthesisPrompt, { maxTokens: 1800, thinking: true, thinkingBudget: 8000 });
    const scoresLine = `Scores: ${MODEL_NAMES.map(n => `${displayNames[n]}=${finalScores[n]}/10`).join(', ')}`;
    res.json({ synthesis: synthesis.replace(/^Scores:.*$/im, scoresLine) });
  } catch {
    res.status(500).json({ error: 'Synthesis failed' });
  }
});

// ── Score / challenge parsers ──
function parseScores(text) {
  if (!text) return null;
  const m = text.match(/^Scores:\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10/im);
  return m ? { [m[1]]: +m[2], [m[3]]: +m[4], [m[5]]: +m[6] } : null;
}

function parseChallenges(text) {
  if (!text) return {};
  const result = {};
  for (const line of text.split('\n')) {
    const m = line.match(/Response ([A-C]) weakness:\s*(.+)/i);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

// ── /api/transcribe — voice → text via OpenAI Whisper ──
app.post('/api/transcribe', requireAuth, rateLimit(60_000, 20), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'No audio data received' });

  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const fieldHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`;
  const modelField = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`;

  const formBody = Buffer.concat([
    Buffer.from(fieldHeader),
    req.body,
    Buffer.from(modelField),
  ]);

  try {
    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: formBody,
    });
    const data = await whisperRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message || 'Whisper API error' });
    res.json({ text: data.text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n🚀 AI Arena running at http://localhost:${PORT}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
