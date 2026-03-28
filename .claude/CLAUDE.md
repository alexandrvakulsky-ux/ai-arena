# AI Arena

Multi-model AI comparison app. Sends a user question to Claude, GPT-4o, and Gemini in parallel, then uses a 3-round Propose→Challenge→Revise protocol to synthesize the best answer with neutral cross-model scoring.

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
- `APP_PASSWORD` — password gate for the UI

## Models in use
- Claude: `claude-opus-4-6` (synthesis uses extended thinking, budget 8000 tokens)
- OpenAI: `gpt-4o`
- Gemini: `gemini-2.5-flash`

## API endpoints
- `POST /api/ask` — runs all 3 models in parallel, returns `{ claude, openai, gemini, errors }`
- `POST /api/synthesize` — 3-round P→C→R protocol, returns synthesis with averaged scores
- `POST /api/auth` — password check, returns SESSION_TOKEN
- `GET /api/verify` — validates stored token via x-app-token header

## Synthesis protocol (3 rounds)
1. `/api/ask` — all 3 models answer in parallel
2. Challenge round — all 3 models score + critique anonymized responses (A/B/C) in parallel
3. Revise round — Claude synthesizes with extended thinking using all challenges as context
- Scores averaged across all 3 judges, substituted into Claude's output
- Hard output format: `Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10` then `## ✨ Synthesized Answer`

## Security
- SESSION_TOKEN auth (random 32 bytes, regenerates on restart)
- 5 wrong attempts → 15 min IP lockout
- Rate limiting: 10/min on auth, 20/min on API calls
- DOMPurify on all markdown output, security headers on all routes

## Git workflow
- Auto-commit + push on every file edit (Claude Code PostToolUse hook)
- Auto git pull on every Claude Code session start (SessionStart hook)
- Always work on `main` branch directly

## Memory instructions
At the end of any session where significant changes were made, update the memory files in:
`C:\Users\Alex\.claude\projects\C--Users-Alex-Downloads-ai-arena-ai-arena\memory\`

Update whichever files are affected:
- `project_aiarena.md` — stack, models, workflow changes
- `project_aiarena_prompt.md` — synthesis protocol or prompt changes
- `project_aiarena_design.md` — UI/frontend changes
- `project_aiarena_security.md` — security changes
- `project_claudecode_settings.md` — hooks or Claude Code config changes

Always update `MEMORY.md` index if files are added or renamed.
