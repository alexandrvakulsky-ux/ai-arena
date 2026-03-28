require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || null;

// ── Model config ──
const MODELS = {
  claude: 'claude-opus-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
};
const MAX_TOKENS  = 1000;
const TIMEOUT_MS  = 30000;

// ── Timeout helper ──
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
  ]);
}

// ── Auth ──
function requireAuth(req, res, next) {
  if (!APP_PASSWORD) return next();
  const token = req.headers['x-app-token'];
  if (token && Buffer.from(token, 'base64').toString() === APP_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/auth', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    res.json({ ok: true, token: Buffer.from(password).toString('base64') });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// ── Claude ──
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
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content[0].text;
}

// ── OpenAI ──
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
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  return data.choices[0].message.content;
}

// ── Gemini ──
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
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  return data.candidates[0].content.parts[0].text;
}

// ── /api/ask — round 1: all 3 models answer in parallel ──
app.post('/api/ask', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });

  const [claude, openai, gemini] = await Promise.allSettled([
    callClaude(question),
    process.env.OPENAI_API_KEY  ? callOpenAI(question)  : Promise.reject(new Error('No OpenAI key configured')),
    process.env.GOOGLE_API_KEY  ? callGemini(question)  : Promise.reject(new Error('No Gemini key configured')),
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
app.post('/api/synthesize', requireAuth, async (req, res) => {
  const { question, responses } = req.body;
  if (!question || !responses) return res.status(400).json({ error: 'question and responses required' });

  // Randomize model → label so no model can identify its own response
  const models = ['claude', 'openai', 'gemini'];
  const shuffled = [...models].sort(() => Math.random() - 0.5);
  const labelOf = {};  // labelOf['claude'] = 'A'
  const modelOf = {};  // modelOf['A'] = 'claude'
  shuffled.forEach((model, i) => {
    const label = String.fromCharCode(65 + i);
    labelOf[model] = label;
    modelOf[label] = model;
  });

  const responseBlock = `--- Response ${labelOf['claude']} ---
${responses.claude || '[No response]'}

--- Response ${labelOf['openai']} ---
${responses.openai || '[No response]'}

--- Response ${labelOf['gemini']} ---
${responses.gemini || '[No response]'}`;

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

  // Parse scores from challenge round
  function parseScores(text) {
    if (!text) return null;
    const m = text.match(/^Scores:\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10,\s*([A-C])=(\d+)\/10/im);
    if (!m) return null;
    return { [m[1]]: parseInt(m[2]), [m[3]]: parseInt(m[4]), [m[5]]: parseInt(m[6]) };
  }

  // Parse weaknesses from challenge round
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
    { text: claudeChallenge.status  === 'fulfilled' ? claudeChallenge.value  : null },
    { text: openaiChallenge.status  === 'fulfilled' ? openaiChallenge.value  : null },
    { text: geminiChallenge.status  === 'fulfilled' ? geminiChallenge.value  : null },
  ].map(j => ({ scores: parseScores(j.text), challenges: parseChallenges(j.text) }));

  // Average scores across all 3 judges
  const avgFor = (label) => {
    const vals = judgeOutputs.map(j => j.scores?.[label]).filter(v => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : '?';
  };

  const finalScores = {
    claude: avgFor(labelOf['claude']),
    openai: avgFor(labelOf['openai']),
    gemini: avgFor(labelOf['gemini']),
  };

  // Build challenge context for synthesis prompt
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

    // Substitute averaged cross-model scores for Claude's own scores
    const scoresLine = `Scores: Claude=${finalScores.claude}/10, ChatGPT=${finalScores.openai}/10, Gemini=${finalScores.gemini}/10`;
    const synthesis = claudeSynthesis.replace(/^Scores:.*$/im, scoresLine);

    res.json({ synthesis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Arena running at http://localhost:${PORT}\n`);
});
