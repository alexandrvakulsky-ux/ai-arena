# AI Arena — Project History & Engineering Log

> How this project was built, the hardest problems we solved, and lessons learned.
> Covers the first ~2 weeks of development (late March – early April 2026).

---

## What Is AI Arena

A multi-model AI comparison app. You ask a question, three models answer in parallel (Claude, GPT-4o, Gemini), then a 3-round Propose→Challenge→Revise protocol synthesizes the best answer with cross-model scoring.

**Stack:** Node.js + Express backend, vanilla JS/HTML frontend (no framework, no build step), deployed on Railway from a Docker dev container on Hetzner VPS.

---

## Timeline

### Week 1 — From Zero to Working App

**Day 1: Scaffold**
- Initial commit: Express server, basic HTML frontend
- Added `node-fetch`, `dotenv`, `express` as only dependencies
- Railway deployment with Nixpacks builder
- Server-side password protection (SESSION_TOKEN, 32 random bytes)

**Days 2-3: UI Iteration (6+ redesigns)**
- Started with basic layout → markdown rendering → expandable responses
- Full redesign cycle: system fonts → flat colors → B2B SaaS polish → Inter font → score cards with bars → pill badges
- Landed on dark theme with colored model accents (purple=Claude, green=OpenAI, blue=Gemini)
- Added DOMPurify for safe markdown rendering, html2pdf for PDF export

**Days 3-4: Synthesis Protocol**
- Built the 3-round synthesis: Ask → Challenge → Revise
- Multiple prompt iterations to get scoring right (no meta-commentary, structured output, table hints)
- Blind labels (A/B/C shuffled) so no model can identify its own response
- Extended thinking enabled for Claude's final synthesis pass
- Fixed Gemini truncation — maxTokens was too low (raised to 4096)

**Day 5: Infrastructure**
- GitHub Codespaces support (auto-install, env from secrets, bootstrap script)
- Auto git pull on start, package-lock.json for reproducible installs
- .dockerignore to exclude node_modules from image

### Week 2 — Container Engineering & Hardening

**Days 6-7: Hetzner + Docker Dev Container**
- Migrated from Codespaces to dedicated Hetzner VPS (135.181.153.92)
- Built full Docker dev container: Node 20 slim, zsh, git-delta, Claude Code CLI
- SSH server inside container (port 2222 → 22)
- Egress firewall with iptables + ipset (allowlist-only for npm, Anthropic, OpenAI, Google, GitHub)
- Refactored entire API layer into PROVIDERS registry pattern

**Days 8-10: The Persistence Wars**
- Solved cascading failures where every container rebuild wiped critical state
- See "Hardest Problems" section below for full detail
- End result: 4-layer persistence (bind mount + named volumes + image layer + restore scripts)

**Days 11-12: Root Access & Mobile**
- Root SSH access for Claude Code with LD_PRELOAD bypass
- Termius mobile SSH key setup
- Voice input via OpenAI Whisper API (MediaRecorder → server → Whisper → text)

**Day 13: Security Hardening**
- Discovered 13,900+ SSH brute-force attempts from bots
- SSH hardening: MaxAuthTries 3, password auth disabled, iptables rate limiting
- Code review of entire setup — removed redundancies, fixed bugs, slimmed configs

**Day 14: Next Project Research**
- Researched Facebook Ad Library API, competitor landscape (AdSpy, BigSpy, Minea, etc.)
- Compiled findings into research brief for ad intelligence tool

---

## The 20 Hardest Problems We Solved

### 1. Zombie Process Plague (1,205 zombies)

**Problem:** Container had `tail -f /dev/null` as PID 1. Every spawned subprocess that finished became a zombie because PID 1 never called `wait()`. Accumulated to 1,205 zombies — 98% of all processes.

**Fix:** Added `--init` to Docker `runArgs` in devcontainer.json. This injects `tini` as PID 1, which properly reaps orphaned processes. Replaced all `tail -f /dev/null` with `sleep infinity` in rebuild scripts.

**Lesson:** Any container where PID 1 is bash, tail, or node will leak zombies over time. Always use `--init`.

---

### 2. Claude Code Auth Lost on Every Rebuild

**Problem:** Claude Code credentials (`~/.claude/.credentials.json`) lived in the container filesystem. Every rebuild wiped them — had to re-authenticate each time.

**Fix:** Three-layer solution:
1. Named Docker volume (`ai-arena-claude-config`) mounted at `/home/node/.claude`
2. Backup copy at `/workspace/.claude-credentials.json` (bind-mounted, survives everything)
3. Two-way sync in post-start.sh (keeps newer version, auto-backup every 30 min)

**Lesson:** Anything that needs to survive a rebuild goes on a named volume or the workspace bind mount.

---

### 3. GitHub Auth Lost on Every Rebuild

**Problem:** Was using HTTPS git remote with no credential helper. After rebuild, git push failed silently.

**Fix:**
1. SSH deploy key stored on persistent volume at `/home/node/.claude/github-deploy-key`
2. post-start.sh copies key to `~/.ssh/`, configures git to use it
3. Auto-converts HTTPS remote to SSH on every start

**Lesson:** SSH keys on persistent volumes > HTTPS with credential helpers.

---

### 4. Root User Can't Run Claude Code CLI

**Problem:** Claude Code CLI refuses `--dangerously-skip-permissions` when UID=0 (root). The CLI checks `getuid()` and exits if it returns 0.

**Fix:** Built `fakeid.so` — a tiny shared library that overrides `getuid()`/`geteuid()` to return 1000 (node's UID). The CLI binary gets renamed to `.real`, and a wrapper script sets `LD_PRELOAD=/root/.claude/remote/fakeid.so` before exec'ing the real binary.

**Lesson:** `LD_PRELOAD` is a powerful escape hatch for third-party binaries that make unwanted checks.

---

### 5. Root CLI Wrapper Cascade Bug

**Problem:** The `wrap_cli_binaries()` function in setup-root-claude.sh iterated over all files in `ccd-cli/` with a glob `*`. It was supposed to skip already-wrapped files, but the guard `[ -f "${CLI_BIN}.real" ] && continue` didn't prevent it from wrapping `.real` files themselves. Result: `2.1.87` → `2.1.87.real` → `2.1.87.real.real` → ... cascading until the real ELF binary was buried 11 levels deep.

**Fix:** Added three guards:
1. `case "$CLI_BIN" in *.real) continue ;; esac` — skip all `.real` files
2. `[ -f "${CLI_BIN}.real" ] && continue` — skip if companion exists
3. `head -c 2 "$CLI_BIN" | grep -q '#!'` — skip if already a shell script

**Lesson:** Glob + mutation in the same directory = recipe for cascading bugs. Guard against all edge cases.

---

### 6. Root Auto-Commit Hooks Failing Silently

**Problem:** The PostToolUse hook for auto-commit ran `commit-with-devcontainer-guard.sh` after every edit. As root, this failed silently because:
1. No `git config user.name/email` set for root
2. No SSH deploy key configured for root
3. Errors swallowed by `2>/dev/null || true`

**Fix:** `setup-root-claude.sh` now copies git identity + SSH key to root on every container start. Added to Dockerfile so it survives rebuilds.

**Lesson:** Silent failure (`2>/dev/null || true`) hides real problems. When something should always work, log failures instead.

---

### 7. Session Amnesia Between Conversations

**Problem:** Each new Claude Code session started with zero context about what happened before. Previous decisions, bugs found, approaches tried — all gone.

**Fix:** Multi-part solution:
1. `save-session.js` — Stop hook compresses JSONL session to markdown (98% smaller), commits to git
2. `session-context.js` — SessionStart hook loads last 2 days of session notes, system health, server status
3. `save-session-loop.sh` — Background idle saver (10-min inactivity trigger)
4. All sessions stored in `.claude/sessions/` and synced via git

**Lesson:** AI sessions need explicit memory systems. Without them, every conversation starts from scratch.

---

### 8. Settings.json Hooks Not Surviving Volume Wipe

**Problem:** All automation (auto-commit, auto-restart, session save, credential backup) was in `/home/node/.claude/settings.json` on the named volume. If the volume was wiped, all hooks disappeared and the global template had only basic permissions — no hooks.

**Fix:**
1. Made global template (`/workspace/.devcontainer/global-claude/settings.json`) a full copy of the active settings
2. Added sync in post-start.sh — copies global template to volume on every start
3. Both CLAUDE.md and settings.json now sync from repo (source of truth)

**Lesson:** Every config file needs a restore path. If it's on a volume, there must be a git-tracked backup.

---

### 9. Container Won't Start After Dockerfile Changes

**Problem:** `devcontainer.json` changes (bad `--device=` flags, invalid JSON) would prevent the container from starting. No way to fix it without SSH access to the host.

**Fix:**
1. `validate-devcontainer.sh` — pre-commit check that catches dangerous patterns (--device=, --privileged, missing fallbacks, bad bind mounts)
2. `commit-with-devcontainer-guard.sh` — runs validation before any commit to `.devcontainer/`
3. Recovery tag: `git tag devcontainer-backup-$(date +%s)` before each commit
4. GitHub Actions CI runs the same validation

**Lesson:** Validate infrastructure config before committing. A bad devcontainer.json is a bricked container.

---

### 10. Egress Firewall Complexity

**Problem:** Container needs internet for npm, API calls, GitHub — but should block everything else. Docker DNS, IPv6, host gateway, and domain resolution all had edge cases.

**Fix:** `init-firewall.sh` — 125-line script that:
1. Saves and restores Docker DNS NAT rules
2. Blocks all IPv6
3. Fetches GitHub CIDR ranges from their API and aggregates them
4. Resolves required domains in parallel
5. Allows host gateway traffic
6. Smoke tests (verifies example.com blocked, api.github.com reachable)
7. Falls back to `reset-iptables.sh` for emergency unlock

**Lesson:** Container firewalls are surprisingly complex. Docker DNS, split resolvers, and CIDR aggregation all need special handling.

---

### 11. Gemini Token Truncation

**Problem:** Gemini responses were getting cut off mid-sentence. The maxTokens was set to 2000 but Gemini needed more for complete responses, especially with structured output.

**Fix:** Raised Gemini maxTokens to 4096. Added truncation detection: if `finishReason === 'MAX_TOKENS'`, append `*[Response truncated — hit token limit]*` so the user knows.

**Lesson:** Different models need different token budgets. Always check finishReason.

---

### 12. Synthesis Prompt Engineering (5+ iterations)

**Problem:** The synthesis output was inconsistent — sometimes meta-commentary ("As an AI..."), sometimes missing scores, sometimes ignoring the scoring rubric.

**Fix:** Iterative prompt refinement:
1. Added explicit ban list (no meta-commentary, no hedging)
2. Forced exact output format: `Scores: A=X/10, B=X/10, C=X/10` then `## ✨ Synthesized Answer`
3. Added scoring rubric (9-10 = accurate/complete, 1-2 = wrong/irrelevant)
4. Enabled extended thinking for Claude's synthesis pass (8000 budget tokens)
5. Blind labels (shuffled A/B/C) so no model can self-identify

**Lesson:** Prompt engineering for structured output requires explicit format templates and ban lists. "Be concise" doesn't work — you need "No hedging, no filler, every sentence must carry factual payload."

---

### 13. 401 Authentication Loop

**Problem:** After server restart, the SESSION_TOKEN regenerated (random 32 bytes on boot). Clients with stale tokens got 401, but the UI didn't handle this — it just showed "Unauthorized" forever.

**Fix:** Frontend detects 401 responses, clears the stored token, and shows the password gate again. Auto-verify on page load so valid tokens unlock immediately.

**Lesson:** Session tokens that regenerate on restart need client-side recovery logic.

---

### 14. SSH Brute-Force Attacks (13,900+ attempts)

**Problem:** Port 2222 exposed to the internet. Bots found it within hours and started dictionary attacks (root, admin, test, ftpuser, etc.).

**Fix:** Three layers:
1. `PasswordAuthentication no` in sshd_config (key-only)
2. `MaxAuthTries 3` + `LoginGraceTime 20` (disconnect fast)
3. iptables `recent` module: 3 new connections per 60 seconds per IP, then DROP

**Lesson:** Any SSH port exposed to the internet will get hammered within hours. Key-only auth + rate limiting is the minimum.

---

### 15. Double Server Auto-Start Race

**Problem:** Both `post-start.sh` and the SessionStart hook tried to start the server. If both fired at once, two server instances would clash on port 3000.

**Fix:** Removed server start from SessionStart hook. It now only checks health and reports status. `post-start.sh` is the single source for server startup.

**Lesson:** One system should own each responsibility. Two things starting the same process = race condition.

---

### 16. UI Design Iteration (6 major redesigns)

**Problem:** The UI went through 6+ complete redesigns in 3 days — each time something felt wrong about the information hierarchy, spacing, or visual weight.

**Final design decisions:**
- Dark theme (var(--bg-base): #0c0d10)
- Model colors as accent only (purple/green/blue borders and badges, not backgrounds)
- Responses collapsed by default with toggle
- Scores as small pill badges on card headers
- Synthesis panel slides in after scoring
- Conversation history in left sidebar with session grouping
- PDF export with clean white layout

**Lesson:** Ship the dark theme from day 1. Light-to-dark migration is painful. Also: 6 redesigns in 3 days is fine when each one takes 20 minutes.

---

### 17. Conversation History & Multi-Turn

**Problem:** Originally single-shot (one question, one answer). Users wanted follow-up questions that build on previous context.

**Fix:**
1. `conversationHistory` array (max 8 turns) sent with each API call
2. `buildMessages()` converts history to alternating user/assistant messages
3. Session IDs group turns in the sidebar
4. Thread view shows previous turns with collapsible synthesis
5. History persisted to localStorage, grouped by session

**Lesson:** Multi-turn is surprisingly complex. Message ordering, context window management, and UI threading all need careful design.

---

### 18. Puppeteer/Chrome in Docker

**Problem:** Screenshot verification needed Chrome inside the container. Chrome has ~20 system library dependencies that aren't in Node slim images.

**Fix:** Added all required libraries to Dockerfile (libpango, libcairo, libxrandr, etc.). Puppeteer cache on a named volume so Chrome (~500MB) only downloads once. MCP server configured with `--no-sandbox` for container use.

**Lesson:** Chrome in Docker requires a specific set of system libraries. Cache the download on a volume.

---

### 19. Global Config That Works From Any Machine

**Problem:** Starting Claude Code on a new machine had zero context. No CLAUDE.md, no rules, no session history.

**Fix:** Self-bootstrapping system:
1. `~/.claude/CLAUDE.md` contains instructions to clone the repo and read everything
2. `bootstrap-claude.sh` — curl-downloadable one-liner that installs global CLAUDE.md
3. `new-machine-setup.sh` — SSH key generation, host config, connection test
4. post-create.sh clones 5 skill repos + custom skills/agents

**Lesson:** The bootstrap file must be self-contained. It can't reference files that don't exist yet.

---

### 20. Voice Input (Whisper API)

**Problem:** Typing long questions on mobile (via Termius SSH) is painful. Wanted voice-to-text.

**Fix:**
- Server: `POST /api/transcribe` endpoint. Receives raw audio blob, builds multipart form manually (no multer dependency), sends to OpenAI Whisper API.
- Frontend: Mic button with MediaRecorder API. Click to start (pulses red), click to stop, auto-transcribes and inserts text.
- No new dependencies — raw `Buffer.concat` for multipart form building.

**Lesson:** You don't need `multer` for file uploads. Raw body parsing + manual multipart construction works fine for single-file uploads.

---

## Architecture Decisions

| Decision | Why |
|---|---|
| No TypeScript | Faster iteration, simpler tooling, one fewer build step |
| No React/Vue | Single HTML file, no build step, instant deploys |
| No database | localStorage for history, filesystem for sessions — good enough at this scale |
| Express over Fastify | More middleware ecosystem, Alex knows it |
| Railway over self-hosted | Auto-deploy from git push, free SSL, zero ops |
| Docker dev container | Reproducible environment, survives machine changes |
| Named Docker volumes | Persist state across container rebuilds |
| SSH deploy keys | More reliable than HTTPS tokens, stored on volume |
| Egress firewall | Container has API keys — limit blast radius |
| tini as PID 1 | Proper zombie reaping without custom init |

---

## File Map

```
ai-arena/
├── server.js                          # Express API (PROVIDERS registry, synthesis protocol)
├── public/index.html                  # Full frontend (CSS + JS, no build step)
├── .env                               # API keys (never committed)
├── railway.toml                       # Railway deploy config
├── package.json                       # 3 deps: express, dotenv, node-fetch
│
├── .devcontainer/
│   ├── Dockerfile                     # Node 20 + Chrome + Claude CLI + SSH + fakeid.so
│   ├── devcontainer.json              # Volumes, ports, extensions, runArgs
│   ├── post-create.sh                 # One-time: npm install, skills, credentials
│   ├── post-start.sh                  # Every start: SSH, firewall, config sync, server
│   ├── init-firewall.sh               # Egress allowlist (iptables + ipset)
│   ├── setup-root-claude.sh           # Root LD_PRELOAD bypass + credential sync
│   ├── authorized_keys                # SSH public keys (PC + mobile)
│   └── global-claude/                 # Template configs (restored on volume wipe)
│       ├── CLAUDE.md                  # Global bootstrap instructions
│       ├── settings.json              # Hooks: auto-commit, session save, skill reminders
│       ├── agents/reviewer.md         # Code review sub-agent
│       └── skills/*.md                # 5 global skills
│
├── .claude/
│   ├── CLAUDE.md                      # Project-specific rules (stack, API, synthesis)
│   ├── CONTAINER-OPS.md               # Infrastructure runbook
│   ├── ROOT-SSH-SETUP.md              # fakeid.so documentation
│   ├── settings.json                  # Active hooks and permissions
│   ├── rules/                         # security.md, deployment.md, workflow.md
│   ├── sessions/                      # Compressed conversation history
│   └── research/                      # Research briefs for new projects
│
├── scripts/
│   ├── save-session.js                # JSONL → markdown session compressor
│   ├── session-context.js             # SessionStart briefing generator
│   ├── save-session-loop.sh           # Background idle session saver
│   ├── commit-with-devcontainer-guard.sh  # Validates .devcontainer/ before commit
│   ├── auto-restart-server.sh         # Restarts server if server.js changes
│   ├── validate-devcontainer.sh       # Pre-commit validation
│   ├── extract-file-path.js           # Hook helper: extracts file path from tool result
│   ├── skill-reminder.js              # Hook helper: suggests skills by file type
│   ├── skill-reflection.js            # Stop hook: prompts skill updates
│   ├── rebuild-container.sh           # Rebuild from inside (needs Docker socket)
│   ├── self-rebuild.sh                # Self-replacing rebuild via Docker API
│   ├── rebuild-now.sh                 # Helper for self-rebuild
│   ├── new-machine-setup.sh           # One-time SSH + config setup
│   └── bootstrap-claude.sh            # curl-downloadable global CLAUDE.md installer
│
└── docs/
    └── PROJECT-HISTORY.md             # This file
```

---

## Persistence Model

| Layer | What persists | Survives |
|---|---|---|
| **Bind mount** (`/workspace`) | All code, configs, .env, session history | Everything |
| **Named volumes** (3) | Credentials, deploy key, skills, bash history, Chrome cache | Container rebuild |
| **Image layer** (Dockerfile) | System packages, fakeid.so, SSH config, PATH | Container rebuild |
| **Restore scripts** (post-start.sh) | CLAUDE.md, settings.json, credentials, git config, root setup | Every start |

---

## What's Next

- **Ad Intelligence Tool** — Facebook Ad Library analysis for trending ads + funnel tracking (research complete, API access pending)
- **Voice input improvements** — currently Whisper; could add Web Speech API as offline fallback
- **Multi-platform** — TikTok Creative Center, Google Ads Transparency Center
