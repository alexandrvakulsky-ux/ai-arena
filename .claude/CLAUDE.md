# AI Arena

Multi-model AI comparison app. Sends a user question to Claude, GPT-4o, and Gemini in parallel, then uses a 3-round Propose→Challenge→Revise protocol to synthesize the best answer with neutral cross-model scoring.

## Stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** Vanilla JS/HTML (`public/index.html`) — no build step, no framework
- **Deploy:** Railway (auto-deploys from `main` branch via `railway.toml`)
- **Local dev:** `npm start` → http://localhost:3000

## Environment variables
Required in `.env` (never committed):
- `ANTHROPIC_API_KEY` — Claude API
- `OPENAI_API_KEY` — GPT-4o
- `GOOGLE_API_KEY` — Gemini
- `APP_PASSWORD` — password gate for the UI

## Models (PROVIDERS registry in server.js)
- Claude: `claude-opus-4-6` — 2000 tokens, 45s timeout (90s with thinking)
- OpenAI: `gpt-4o` — 2000 tokens, 45s timeout
- Gemini: `gemini-2.5-flash` — 2000 tokens, 60s timeout

Adding a model = add one entry to `PROVIDERS` in `server.js`.

## API endpoints
- `POST /api/ask` — all 3 models in parallel; `stream: true` for NDJSON progressive delivery
- `POST /api/synthesize` — 3-round P→C→R protocol, returns synthesis with averaged scores
- `POST /api/auth` — password check → SESSION_TOKEN
- `GET /api/verify` — validates token via x-app-token header

## Synthesis protocol
1. `/api/ask` — all 3 models answer in parallel
2. Challenge — all 3 score + critique anonymized responses (A/B/C)
3. Revise — Claude synthesizes with extended thinking using all challenges
- Scores averaged across judges, substituted into output
- **Output format is fixed** (frontend parses it exactly):
  `Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10` then `## ✨ Synthesized Answer`

## Proactive tooling suggestions
Research (Twitter/X, GitHub) what Claude Code power users are doing. Suggest one sharp tool when:
- A task was harder than it needed to be
- A gap in verification, testing, or deployment visibility appears
- A relevant new technique surfaces for this stack

## Verification after every HTML/CSS change
After touching `public/index.html`, always:
1. `node check-styles.js` — catches CSS conflicts, dead classes, missing IDs. Fix all failures.
2. `node screenshot.js` — take a screenshot and show it to confirm the UI looks right before asking the user.

`screenshot.js` requires the container to be rebuilt with the Dockerfile fix (libpango-1.0-0 + libcairo2 now included). If Chrome fails to launch, say so and skip to check-styles only.

## Learning rules
When the user corrects my approach or confirms something worked well, update the relevant rules file immediately to lock in the lesson.
