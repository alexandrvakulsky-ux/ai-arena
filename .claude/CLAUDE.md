# AI Arena

Multi-model AI comparison app. Sends a user question to Claude, GPT-4o, and Gemini in parallel, then uses a 3-round Propose→Challenge→Revise protocol to synthesize the best answer with neutral cross-model scoring.

## Stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** Vanilla JS/HTML (`public/index.html`) — no build step, no framework
- **Deploy:** Railway (auto-deploys from `main` branch via `railway.toml`)
- **Local dev:** `npm start` → http://localhost:3000

## Dev container
Image includes: Claude Code CLI, Puppeteer MCP server (screenshots), Chrome. `postCreateCommand` runs `npm install` for this app, copies `.env.example`, and clones `claude-sync` config repo.

**Flow:**
1. Open in Cursor/VS Code → **Reopen in Container** (rebuild if Dockerfile changed).
2. `claude` in terminal or **Run Task → Claude Code**.
3. `npm start` or **Run Task → Start AI Arena** — port 3000 forwarded automatically.
4. API keys go in `.env` (auto-created from `.env.example` on first run).
**If firewall breaks (`EAI_AGAIN` / timeouts):**
- `sudo /usr/local/bin/reset-iptables.sh` — emergency unlock
- `sudo /usr/local/bin/init-firewall.sh` — re-apply the full allowlist

These are the only two commands that work without a password. If `sudo` asks for a password, the image is outdated — rebuild the container.

## Environment variables
Required in `.env` (never committed to git):
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

## Synthesis protocol (3 rounds)
1. `/api/ask` — all 3 models answer in parallel
2. Challenge — all 3 score + critique anonymized responses (A/B/C)
3. Revise — Claude synthesizes with extended thinking using all challenges
- Scores averaged across judges, substituted into output
- Format: `Scores: Claude=X/10, ChatGPT=X/10, Gemini=X/10` then `## ✨ Synthesized Answer`

## Security
- SESSION_TOKEN auth (random 32 bytes, regenerates on restart)
- 5 wrong attempts → 15 min IP lockout
- Rate limiting: 10/min auth, 20/min API
- DOMPurify on markdown, CSP + HSTS + security headers
- Missing API keys logged as warnings on startup

## Git workflow
- Auto-commit + push on every file edit (Claude Code PostToolUse hook)
- Auto git pull on session start (SessionStart hook)
- Work on `main` branch directly
- Before any major change, create a checkpoint tag: `git tag checkpoint-<short-description>`
- To roll back: `git log --oneline` to find the commit, `git revert <hash>` to undo safely

## How to work

**Before starting:**
- Read relevant files fully before editing — never modify code you haven't read
- For non-trivial tasks, create a checkpoint tag first
- If the request is ambiguous, ask one clarifying question before starting

**While working:**
- Smallest change that solves the problem — no refactoring or cleanup beyond what was asked
- No new npm dependencies without explicit approval
- No TypeScript, no build steps — keep it vanilla JS/Node

**After finishing — feedback loop (priority):**
- Gather evidence before asking for feedback — don't ask "does it look right?" blind:
  - UI/frontend change → take a Puppeteer screenshot and show it
  - API/backend change → run `npm test` and show results
  - Full flow change → use Puppeteer to walk through the actual interaction
- If Puppeteer or the server isn't running, say so and ask the user to start it — don't skip
- After showing evidence: "Does this match what you expected, or should I adjust anything?"
- Skip only for trivial fixes where the outcome is self-evident

**Never:**
- Change the synthesis output format (`Scores: Claude=X/10...` + `## ✨ Synthesized Answer`) — frontend parses it exactly
- Log request bodies or expose API keys
- Add comments or annotations to code you didn't change
- Guess at missing context — ask instead

## Proactive tooling suggestions (part of every session)
This is a core responsibility, not optional. Regularly research (Twitter/X, GitHub) what Claude Code power users are doing to improve their workflows. Bring up a suggestion when:
- We just finished a task that was harder than it needed to be
- A gap in verification, testing, or deployment visibility becomes apparent
- A relevant new tool or technique surfaces that fits this stack

When suggesting: name the tool, explain the specific gap it fills in *this* project, and offer to set it up. Don't dump lists — one sharp suggestion at the right moment. Areas to watch:
- Visual verification (Puppeteer, browser automation)
- API/endpoint testing and monitoring
- Deployment visibility (Railway logs, health checks, uptime)
- Error tracking and observability (Sentry, logging)
- Workflow automation (hooks, MCP servers, slash commands)

## Learning rules
When the user corrects my approach or confirms something worked well, update this file immediately to lock in the lesson.
