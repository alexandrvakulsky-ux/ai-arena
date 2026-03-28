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
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com; " +
    "font-src fonts.gstatic.com; " +
    "connect-src 'self'"
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT         = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || null;

// Random session token — generated fresh on each server start, never contains the password.
// Invalidates automatically on redeploy, so stolen tokens expire with each release.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

// ── Model config ──
const MODELS = {
  claude: 'claude-opus-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
};
const MAX_TOKENS        = 1000;
const TIMEOUT_MS        = 30000;
const MAX_QUESTION_LEN  = 2000;

// ── In-memory rate limiter (no extra package needed) ──
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

// ── Timeout helper ──
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
  ]);
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  if (req.headers['x-app-token'] === SESSION_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Lockout tracker — 5 wrong attempts → 15 min ban per IP ──
const LOCKOUT_MAX      = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const lockoutStore     = new Map();       // ip → { attempts, lockedUntil }

function getLockout(ip) {
  const rec = lockoutStore.get(ip);
  if (!rec || !rec.lockedUntil) return null;
  if (Date.now() < rec.lockedUntil) return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
  lockoutStore.delete(ip); // expired
  return null;
}

function recordFailure(ip) {
  const rec = lockoutStore.get(ip) || { attempts: 0, lockedUntil: null };
  rec.attempts++;
  if (rec.attempts >= LOCKOUT_MAX) {
    rec.lockedUntil = Date.now() + LOCKOUT_DURATION;
    rec.attempts    = 0;
  }
  lockoutStore.set(ip, rec);
}

function clearLockout(ip) { lockoutStore.delete(ip); }

// ── Auth endpoints ──
app.post('/api/auth', rateLimit(60_000, 10), (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true, token: SESSION_TOKEN });

  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  const minsLeft = getLockout(ip);
  if (minsLeft) return res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.` });

  const { password } = req.body;
  if (typeof password !== 'string') return res.status(400).json({ ok: false, error: 'Invalid input' });

  if (password === APP_PASSWORD) {
    clearLockout(ip);
    res.json({ ok: true, token: SESSION_TOKEN });
  } else {
    recordFailure(ip);
    const locked = getLockout(ip);
    if (locked) return res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${locked} minute${locked === 1 ? '' : 's'}.` });
    const remaining = LOCKOUT_MAX - (lockoutStore.get(ip)?.attempts || 0);
    res.status(401).json({ ok: false, error: `Wrong password. ${remaining} attempt${remaining === 1 ? '' : 's'} left before lockout.` });
  }
});

app.get('/api/verify', requireAuth, (_req, res) => res.json({ ok: true }));

// ── Model callers ──
async function callClaude(prompt, maxTokens = MAX_TOKENS) {
  const res = await withTimeout(fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELS.claude,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }), TIMEOUT_MS);
  const data = await res.json();
  if (data.error) throw new Error('Claude API error');
  return data.content[0].text;
}

async function callOpenAI(prompt, maxTokens = MAX_TOKENS) {
  const res = await withTimeout(fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELS.openai,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }), TIMEOUT_MS);
  const data = await res.json();
  if (data.error) throw new Error('OpenAI API error');
  return data.choices[0].message.content;
}

async function callGemini(prompt, maxTokens = MAX_TOKENS) {
  const res = await withTimeout(fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${process.env.GOOGLE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  ), TIMEOUT_MS);
  const data = await res.json();
  if (data.error) throw new Error('Gemini API error');
  return data.candidates[0].content.parts[0].text;
}

// ── /api/ask — round 1: all 3 models answer in parallel ──
app.post('/api/ask', requireAuth, rateLimit(60_000, 20), async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });
  if (question.length > MAX_QUESTION_LEN) return res.status(400).json({ error: `question must be under ${MAX_QUESTION_LEN} characters` });

  const [claude, openai, gemini] = await Promise.allSettled([
    callClaude(question),
    process.env.OPENAI_API_KEY ? callOpenAI(question) : Promise.reject(new Error('No OpenAI key configured')),
    process.env.GOOGLE_API_KEY ? callGemini(question) : Promise.reject(new Error('No Gemini key configured')),
  ]);

  res.json({
    claude: claude.status === 'fulfilled' ? claude.value : null,
    openai: openai.status === 'fulfilled' ? openai.value : null,
    gemini: gemini.status === 'fulfilled' ? gemini.value : null,
    errors: {
      claude: claude.status === 'rejected' ? claude.reason.message : null,
      openai: openai.status === 'rejected' ? openai.reason.message : null,
      gemini: gemini.status === 'rejected' ? gemini.reason.message : null,
    },
  });
});

// ── /api/synthesize — propose → challenge → revise ──
app.post('/api/synthesize', requireAuth, rateLimit(60_000, 20), async (req, res) => {
  const { question, responses } = req.body;
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });
  if (question.length > MAX_QUESTION_LEN) return res.status(400).json({ error: `question must be under ${MAX_QUESTION_LEN} characters` });
  if (!responses || typeof responses !== 'object') return res.status(400).json({ error: 'responses is required' });

  // Validate response values are strings
  const safeResponses = {
    claude: typeof responses.claude === 'string' ? responses.claude.slice(0, 4000) : null,
    openai: typeof responses.openai === 'string' ? responses.openai.slice(0, 4000) : null,
    gemini: typeof responses.gemini === 'string' ? responses.gemini.slice(0, 4000) : null,
  };

  // Randomize model → label so no model can identify its own response
  const models   = ['claude', 'openai', 'gemini'];
  const shuffled = [...models].sort(() => Math.random() - 0.5);
  const labelOf  = {};
  const modelOf  = {};
  shuffled.forEach((model, i) => {
    const label  = String.fromCharCode(65 + i);
    labelOf[model] = label;
    modelOf[label] = model;
  });

  const responseBlock = `--- Response ${labelOf['claude']} ---
${safeResponses.claude || '[No response]'}

--- Response ${labelOf['openai']} ---
${safeResponses.openai || '[No response]'}

--- Response ${labelOf['gemini']} ---
${safeResponses.gemini || '[No response]'}`;

  // ── Round 2: Challenge — all 3 models score + critique in parallel ──
  const challengePrompt = `A user asked: "${question}"

Three AI responses (identities hidden):

${responseBlock}

Score each response on factual accuracy and completeness (not style). Then identify the single biggest weakness or error in each. Be specific and critical — do not be agreeable or sycophantic.

Output exactly in this format:
Scores: ${labelOf['claude']}=X/10, ${labelOf['openai']}=X/10, ${labelOf['gemini']}=X/10
Response ${labelOf['claude']} weakness: [specific flaw, or "none" if solid]
Response ${labelOf['openai']} weakness: [specific flaw, or "none" if solid]
Response ${labelOf['gemini']} weakness: [specific flaw, or "none" if solid]`;

  const [claudeChallenge, openaiChallenge, geminiChallenge] = await Promise.allSettled([
    callClaude(challengePrompt, 400),
    process.env.OPENAI_API_KEY ? callOpenAI(challengePrompt, 400) : Promise.reject(new Error('No OpenAI key')),
    process.env.GOOGLE_API_KEY ? callGemini(challengePrompt, 400) : Promise.reject(new Error('No Gemini key')),
  ]);

  function parseScores(text) {
    if (!text) return null;
    const m = text.match(/^Scores:\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10/im);
    if (!m) return null;
    return { [m[1]]: parseInt(m[2]), [m[3]]: parseInt(m[4]), [m[5]]: parseInt(m[6]) };
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

  const judgeOutputs = [
    claudeChallenge, openaiChallenge, geminiChallenge,
  ].map(r => {
    const text = r.status === 'fulfilled' ? r.value : null;
    return { scores: parseScores(text), challenges: parseChallenges(text) };
  });

  const avgFor = (label) => {
    const vals = judgeOutputs.map(j => j.scores?.[label]).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : '?';
  };

  const finalScores = {
    claude: avgFor(labelOf['claude']),
    openai: avgFor(labelOf['openai']),
    gemini: avgFor(labelOf['gemini']),
  };

  const challengeContext = judgeOutputs
    .map((j, i) => {
      const entries = Object.entries(j.challenges);
      if (!entries.length) return null;
      return `Evaluator ${i + 1}: ${entries.map(([label, flaw]) => `Response ${label}: ${flaw}`).join(' | ')}`;
    })
    .filter(Boolean)
    .join('\n');

  // ── Round 3: Revise — Claude synthesizes with full challenge context ──
  const synthesisPrompt = `A user asked: "${question}"

Three AI responses (identities hidden):

${responseBlock}

Independent evaluators identified these weaknesses:
${challengeContext || 'No significant weaknesses identified.'}

Using the strongest elements from each response and addressing the valid challenges, synthesize the definitive best answer. Do not mention this evaluation process.

Output exactly in this format:
Scores: ${labelOf['claude']}=X/10, ${labelOf['openai']}=X/10, ${labelOf['gemini']}=X/10

## ✨ Synthesized Answer

[answer]

Scoring (factual completeness and accuracy only): 9–10 = accurate and complete; 7–8 = mostly right, minor omissions; 5–6 = partial or mixed; 3–4 = thin or off-target; 1–2 = wrong or irrelevant; 0 = no response.

Rules:
- Answer directly as the expert. No mention of models or this process.
- One short intro sentence, then ## / ### and bullets only where they add clarity.
- If the question involves options, metrics, or tradeoffs, include one concise markdown table.
- Every sentence must carry factual payload. No hedging, no filler.`;

  try {
    const claudeSynthesis = await callClaude(synthesisPrompt, 1800);
    const scoresLine = `Scores: Claude=${finalScores.claude}/10, ChatGPT=${finalScores.openai}/10, Gemini=${finalScores.gemini}/10`;
    const synthesis  = claudeSynthesis.replace(/^Scores:.*$/im, scoresLine);
    res.json({ synthesis });
  } catch {
    res.status(500).json({ error: 'Synthesis failed' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Arena running at http://localhost:${PORT}\n`);
});
