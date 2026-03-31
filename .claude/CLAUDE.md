# AI Arena

Multi-model AI comparison app. Sends a user question to Claude, GPT-4o, and Gemini in parallel, then uses a 3-round Propose→Challenge→Revise protocol to synthesize the best answer with neutral cross-model scoring.

## Stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** Vanilla JS/HTML (`public/index.html`) — no build step, no framework
- **Deploy:** Railway (auto-deploys from `main` branch via `railway.toml`)
- **Local dev:** `npm start` → http://localhost:3000

## Dev container (Cursor / VS Code) — Windows, Mac, Linux
Setup matches [Anthropic’s Claude Code devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer): **Claude Code is pre-installed in the image** — you do **not** run `npm install` for it. After the container is created, **post-create** runs **`npm install` only for this app** (Express, etc.).

**Works on all devices.** `~/.claude` is stored in a named Docker volume (`claude-code-config-ai-arena`) — no Windows/Mac path differences. On first run, `post-create.sh` auto-clones the `claude-sync` private repo into the volume so your Claude config, memory, and session history are available immediately.

**Typical flow (Claude Code–first):**
1. Open the repo in Cursor/VS Code → **Reopen in Container** (rebuild only if Dockerfile changed).
2. Terminal: `claude` — or **Run Task → “Claude Code (terminal)”**.
3. **Run Task → “Start AI Arena”** or `npm start` — app on port **3000** (forwarded automatically).
4. Put API keys in **`.env`** (auto-created from `.env.example` on first run).

**First time on a new device (SSH key not yet set up):** The claude-sync clone step will be skipped — add your API keys to `.env` manually, then run `git clone git@github.com:alexandrvakulsky-ux/claude-sync.git ~/.claude` once SSH is configured.

You normally **do not** need to touch `node_modules` or global npm yourself; if dependencies look wrong, **Run Task → “Install dependencies”**.

**Firewall / “EAI_AGAIN” / GitHub `curl` timeout:** The container runs a strict egress firewall (`postStartCommand`). **`node` is only allowed passwordless `sudo` for two commands** — not arbitrary `iptables`. If **`sudo` asks for a password**, you ran something other than these (or the image is outdated — **rebuild** the dev container).

- **`sudo /usr/local/bin/reset-iptables-policies.sh`** — emergency: set IPv4 default policies to **ACCEPT** (fixes “stuck DROP” after Ctrl+C). *Requires image with this script; otherwise skip to the next line.*
- **`sudo /usr/local/bin/init-firewall.sh`** — apply the full allowlist (also resets policies to ACCEPT at the start of the script).

If a firewall run was **interrupted**, use **reset** then **init-firewall**, or run **init-firewall** alone if your `init-firewall.sh` is already the latest from this repo. DNS must match **`/etc/resolv.conf`** for **EAI_AGAIN** fixes.

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
- Headers: CSP, HSTS, X-Frame-Options, Permissions-Policy, Referrer-Policy, X-Permitted-Cross-Domain-Policies
- Missing API keys logged as warnings on startup (not silent failures)

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
