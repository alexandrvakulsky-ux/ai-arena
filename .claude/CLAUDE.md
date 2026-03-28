# AI Arena

Multi-model AI comparison app. Sends a user question to Claude, GPT-4o, and Gemini in parallel, then uses Claude to synthesize and score all three responses.

## Stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** Vanilla JS/HTML (`public/index.html`) — no build step, no framework
- **Deploy:** Railway (auto-deploys from `main` branch via `railway.toml`)
- **Local dev:** `npm start` → http://localhost:3000

## Environment variables
Required in `.env` (never committed to git):
- `ANTHROPIC_API_KEY` — Claude API
- `OPENAI_API_KEY` — GPT-4o
- `GOOGLE_API_KEY` — Gemini
- `APP_PASSWORD` — optional password gate for the UI

## Models in use
- Claude: `claude-opus-4-5` (also used for synthesis/scoring)
- OpenAI: `gpt-4o`
- Gemini: `gemini-2.5-flash-preview-04-17`

## API endpoints
- `POST /api/ask` — runs all 3 models in parallel, returns `{ claude, openai, gemini, errors }`
- `POST /api/synthesize` — Claude scores all 3 responses and returns a synthesized answer
- `POST /api/auth` — password check, returns base64 token

## Synthesis prompt rules
- First line of output must be: `Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10`
- Synthesized answer header must be exactly: `## ✨ Synthesized Answer`
- No analysis block — scores are displayed as pill badges on response card headers

## Git workflow
- Auto-commit + push happens on every file edit (Claude Code hook)
- Auto git pull happens on every Claude Code session start
- Always work on `main` branch directly
