require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || null;

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
async function callClaude(prompt, maxTokens = 1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Claude: ${data.error.message}`);
  return data.content[0].text;
}

// ── OpenAI ──
async function callOpenAI(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  return data.choices[0].message.content;
}

// ── Gemini ──
async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1000 },
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message}`);
  return data.candidates[0].content.parts[0].text;
}

// ── /api/ask  — run all 3 models in parallel ──
app.post('/api/ask', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question is required' });

  const [claude, openai, gemini] = await Promise.allSettled([
    callClaude(question),
    process.env.OPENAI_API_KEY ? callOpenAI(question) : Promise.reject(new Error('No OpenAI key configured')),
    process.env.GOOGLE_API_KEY ? callGemini(question) : Promise.reject(new Error('No Gemini key configured')),
  ]);

  res.json({
    claude:  claude.status  === 'fulfilled' ? claude.value  : null,
    openai:  openai.status  === 'fulfilled' ? openai.value  : null,
    gemini:  gemini.status  === 'fulfilled' ? gemini.value  : null,
    errors: {
      claude:  claude.status  === 'rejected' ? claude.reason.message  : null,
      openai:  openai.status  === 'rejected' ? openai.reason.message  : null,
      gemini:  gemini.status  === 'rejected' ? gemini.reason.message  : null,
    },
  });
});

// ── /api/synthesize  — Claude judges + synthesizes ──
app.post('/api/synthesize', requireAuth, async (req, res) => {
  const { question, responses } = req.body;
  if (!question || !responses) return res.status(400).json({ error: 'question and responses required' });

  const prompt = `You are a fact-checker. A user asked:

"${question}"

The three models responded:

--- CLAUDE ---
${responses.claude || '[No response]'}

--- CHATGPT ---
${responses.openai || '[No response]'}

--- GEMINI ---
${responses.gemini || '[No response]'}

Output exactly in this format — first line is scores, then the synthesized answer. No other sections.

Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10

## ✨ Synthesized Answer

[answer]

Scoring (factual completeness and accuracy only, not style): 9–10 = accurate and complete; 7–8 = mostly right, minor omissions; 5–6 = partial or mixed; 3–4 = thin or off-target; 1–2 = wrong or irrelevant; 0 = no response.

Rules for the answer:
- Answer directly as the expert. No mention of models or this process.
- One short intro sentence, then ## / ### and bullets only where they add clarity.
- If the question involves options, metrics, or tradeoffs, include one concise markdown table.
- Every sentence must carry factual payload. No hedging, no filler.`;

  try {
    const synthesis = await callClaude(prompt, 1800);
    res.json({ synthesis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 AI Arena running at http://localhost:${PORT}\n`);
});
