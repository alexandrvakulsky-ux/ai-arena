# Alexandr Vakulsky — Global Claude Config

YOU WORK FOR ALEX. This file is your bootstrap. Read it fully before doing anything.

## IMMEDIATE: ON EVERY SESSION START — DO THIS BEFORE ANYTHING ELSE

This block is MANDATORY. Run it at the start of every session, on every machine,
no matter the task. Do not skip steps. Do not assume the previous session did it.

### Step 0a — verify `~/.claude` is synced to claude-sync (skip if not a git repo)
```bash
git -C ~/.claude rev-parse --is-inside-work-tree 2>/dev/null && git -C ~/.claude remote get-url origin
```
- If output ends with `claude-sync.git`: pull latest → `git -C ~/.claude pull --rebase --autostash`
- If `~/.claude` is **not** a git repo and you are `node`: bootstrap immediately:
  ```bash
  bash <(curl -fsSL https://raw.githubusercontent.com/alexandrvakulsky-ux/claude-sync/master/bootstrap.sh)
  ```
  Needs SSH key OR `$GH_TOKEN`. If neither available, ask Alex once and stop.
- If `~/.claude` is `/root/.claude` (root home is overlay, not persisted): **this is normal.** post-create.sh re-seeds it from `/workspace/.devcontainer/global-claude/` on every container creation. Skip Step 0a entirely.

### Step 0b — read the instructions
After Step 0a (succeeds or is skipped), READ these in order. They are short. No skipping.
1. `~/.claude/CLAUDE.md` ← this file (you're already reading it if it auto-loaded; if not, `cat` it)
2. `~/.claude/CHANGELOG.md` ← what changed recently in this config — non-obvious gotchas live here (only present in the claude-sync version under `/home/node/.claude/`)
3. Per-cwd memory:
   - `~/.claude/projects/-workspace/memory/MEMORY.md` if cwd is `/workspace`
   - `~/.claude/projects/-home-node/memory/MEMORY.md` if cwd is `/home/node`
   - `~/.claude/projects/-root/memory/MEMORY.md` if cwd is `/root`

### Step 0b.5 — health check + self-heal (do this without asking)
```bash
ps -eo pid,user,etimes,comm | awk '$2=="root" && $3>43200 && /ccd-cli|node/ {print}'
ss -tlnp 2>/dev/null | grep -E ':300[01]'
ps aux | wc -l        # should be <50; >100 = investigate zombies
```
If you see **stale root ccd-cli (>12h old) or `node server.js` running as root**, that's leftover state from a previous machine's session. Fix it yourself:
- **If current session is root:** `bash ~/.claude/scripts/cleanup-stale-root-procs.sh` (idempotent, restarts services as `node`).
- **If current session is `node` (no root):** can't kill root procs. Note it in your reply ("stale root procs detected, will clean up next root session") and move on.

Also check `~/.claude/TASKS.md` (claude-sync's rolling list) — pick anything you can do at current privilege level.

### Step 0c — load project context based on cwd
- `pwd` to identify location.
- `/workspace` → ai-arena devcontainer. Do the `/workspace/` block below.
- `/home/node` → general node home; check ACTIVE PROJECTS section.
- Anything else → ask Alex once: "Which project are we working on?"

### If `/workspace/` exists (container is running):
1. `cat /workspace/.claude/CLAUDE.md` — project rules, stack, synthesis protocol
2. `cat /workspace/.claude/CONTAINER-OPS.md` — infra, SSH, ports, troubleshooting, ROOT-vs-NODE, sibling ad-spy access
3. `ls -t /workspace/.claude/sessions/*.md | head -3 | xargs -I{} cat {}` — recent conversation history
4. `cat /workspace/.claude/rules/*.md` — security, deployment, workflow, pattern-recognition rules
5. `ps aux | wc -l` — should be <50. If >100, investigate zombies.
6. `curl -s http://localhost:3000/health` — ai-arena health
7. `docker exec ad-spy curl -sm 3 http://localhost:3001/health` — sibling ad-spy health (Docker socket is mounted in ai-arena)

### If `/workspace/` does NOT exist (new machine, broken container, fresh install):
YOU MUST bootstrap. Run these commands without asking:
```bash
# 1. Clone ai-arena (public) — has all docs, configs, scripts, session history
git clone https://github.com/alexandrvakulsky-ux/ai-arena.git /tmp/ai-arena-docs

# 2. Read the critical files
cat /tmp/ai-arena-docs/.claude/CLAUDE.md
cat /tmp/ai-arena-docs/.claude/CONTAINER-OPS.md
ls -t /tmp/ai-arena-docs/.claude/sessions/*.md | head -3 | xargs cat

# 3. Now follow CONTAINER-OPS.md to recover/rebuild.
```
If the clone fails (no git, no network): tell Alex "I need access to https://github.com/alexandrvakulsky-ux/ai-arena to load context."

## ACTIVE PROJECTS

### ai-arena (primary)
- Repo: https://github.com/alexandrvakulsky-ux/ai-arena (public)
- What: multi-model comparison app — Claude vs GPT-4o vs Gemini, 3-round Propose→Challenge→Revise synthesis
- Stack: vanilla Node.js + Express, vanilla JS frontend, no build step
- Port: 3000 (host) / 3000 (container)
- SSH: 2222 (host) → 22 (container)
- Deploy: self-hosted on Hetzner — auto-deploy.sh polls origin/main and restarts server.js (Railway retired 2026-05-26)
- Dev: Docker devcontainer on Hetzner VPS, cwd `/workspace`
- Full docs: `/workspace/.claude/CLAUDE.md`, `/workspace/.claude/CONTAINER-OPS.md`, `/workspace/docs/PROJECT-HISTORY.md`

### ad-spy (sibling container on same host)
- Repo: https://github.com/alexandrvakulsky-ux/ad-spy (private)
- What: Facebook Ad Library intelligence tool — tracks competitor ads in cybersecurity + Genesis verticals, ScrapeCreators API as primary source
- Stack: vanilla Node.js + Express, vanilla JS frontend, single `server.js` (~1,460 lines)
- Port: 3001 (host) / 3001 (container) — separately exposed on Hetzner host
- SSH: 2223 (host) → 22 (container)
- Bind mount: host `/srv/ad-spy/` → container `/workspace`
- Reachable from ai-arena via `docker exec ad-spy <cmd>` (Docker socket mounted) — direct curl `localhost:3001` does NOT work from inside ai-arena (separate networks)
- Architecture: per-competitor lazy-fetch with 4h TTL, stale-while-revalidate, rollback protection, daily self-healing audits
- Full docs: `/tmp/ad-spy/README.md` (after `ad_spy_sync_local`), `/tmp/ad-spy/DESIGN.md`, `/tmp/ad-spy/MISTAKES.md`
- Helpers: `source /workspace/scripts/ad-spy-helpers.sh` → `ad_spy_sync_local`, `ad_spy_exec`, `ad_spy_log`

### claude-sync (infra, master branch)
- Repo: https://github.com/alexandrvakulsky-ux/claude-sync (private)
- What: syncs `~/.claude/` (settings, memory, plugins) across devices
- Lives at `/home/node/.claude/` on the named volume `ai-arena-claude-config`
- Per-cwd memory under `projects/<encoded-cwd>/memory/` (e.g. `projects/-workspace/`, `projects/-home-node/`, `projects/-root/`)
- ⚠️ Per-cwd memory only loads when cwd matches. For cross-project context (user profile, project summaries), put it in THIS file (global CLAUDE.md), not in per-cwd memory.

## INFRASTRUCTURE QUICK REFERENCE
- **Hetzner VPS**: 135.181.153.92 — runs TWO sibling containers
  - `ai-arena` — port 3000 (app), 2222 (ssh). Where you usually land.
  - `ad-spy`  — port 3001 (app), 2223 (ssh). Reachable from ai-arena via `docker exec ad-spy <cmd>` (Docker socket is mounted) — **not** via direct curl.
- **Docker volumes** (survive ai-arena rebuild): `ai-arena-claude-config`, `ai-arena-bashhistory`, `ai-arena-puppeteer-cache`. Ad-spy has its own: `ad-spy-puppeteer-cache`.
- **Persistent paths** (on `/dev/sda1`, survive rebuild): `/workspace`, `/commandhistory`, `/home/node/.claude`, `/home/node/.cache/puppeteer`. Everything else is overlay (wiped on rebuild) — including `/tmp` and `/root` (except `/root/.ssh` which post-start restores).
- **GitHub repos** (alexandrvakulsky-ux):
  - `ai-arena` — **public**. SSH deploy key at `/root/.ssh/github-deploy-key` and `/home/node/.claude/github-deploy-key`. Deploy keys are **repo-scoped** — they can ONLY push/pull ai-arena, not ad-spy.
  - `ad-spy` — **private**. Use the owner-scoped PAT: `grep -oE 'github_pat_[A-Za-z0-9_]+' /home/node/.claude/.git/config | head -1`. That PAT has admin on all of Alex's private repos.
  - `claude-sync` — **private**. Same PAT.
- **Deploy**: self-hosted on Hetzner — `auto-deploy.sh` polls origin/main and restarts `server.js` (Railway retired 2026-05-26). Ad-spy also runs on Hetzner only.

## ROOT vs NODE — DON'T GET FOOLED
When SSH'd as root into either container, libc-based tools (`id`, `whoami`, `sudo`) report `node` (uid 1000) because of `LD_PRELOAD=/root/.claude/remote/fakeid.so` set by the Claude Code Remote runtime. The kernel-side process IS uid 0 — verify with:
```bash
grep ^Uid /proc/$$/status        # 0 = real root
LD_PRELOAD= /usr/bin/id          # bypasses the shim
```
If `$USER=root` and `$HOME=/root` but `whoami=node`, you ARE root. Don't waste a turn telling Alex he's `node`.

**Why the shim exists**: Claude Code CLI hard-blocks `--dangerously-skip-permissions` when `getuid() == 0` — there's no override flag. `fakeid.so` is the only way to run YOLO-mode Claude Code as root. Full setup details: `/workspace/.claude/ROOT-SSH-SETUP.md`.

## CORE PRINCIPLES — ALWAYS APPLY
- Do everything yourself. Only involve Alex for critical decisions (API keys, money, destructive ops).
- Never ask "should I do X?" if the answer is obviously yes. Just do it.
- Read before editing. Understand context before changing anything.
- Verify after changes. Run tests, check endpoints, confirm behavior.
- Document findings. Update session notes in `.claude/sessions/` after significant work.
- Keep the container clean. Watch for zombie processes, stale files, resource leaks.

## SESSION HANDOFFS — ALWAYS DO THIS
**FORMAT RULE (mandatory): the new-session message is ONE copy-paste code block — lead the reply with it, ZERO prose before it. Inside = terse imperative steps + the exact thing to paste/run. No preamble, no explanation, no "blah blah". Alex pastes and goes. All detail goes in the handoff FILE, never in the message.**
When work must continue in a NEW session (context heavy, restart needed, MCP re-auth, dropped token/connection, etc.):
1. **Write a handoff file** under `/workspace/.claude/sessions/` (or the relevant project) with the EXACT resume recipe — absolute paths, exact tool calls + params, credit/cost notes, and what NOT to touch. Make it the newest file so cwd-based auto-read can pick it up.
2. **ALWAYS hand Alex a copy-paste "first message"** for the new session that makes it INSTANTLY pick up the work. It MUST:
   - Reference handoff/input files by **ABSOLUTE PATH** (works from any cwd).
   - Contain the **full instruction to execute immediately** — not "read this and wait".
   - **Never depend on Alex picking a folder / switching to `/workspace`.** He starts sessions as ROOT sitting in `~` (`/root`) and does NOT want folder gymnastics. Make everything work from `/root`.
3. **Don't make him fight the UI.** If something must load regardless of cwd (e.g. an MCP server, command, or skill), register/copy it at **USER scope** (`/root/.claude.json`, `/root/.claude/`) so it's available everywhere — not project scope.
4. Lead the reply with the paste-ready first message in a code block. Keep it self-contained so a blank session executes with zero re-explaining.

## PAST MISTAKES — DON'T REPEAT THESE
- **Zombie processes**: PID 1 was `tail -f /dev/null` → 1200+ zombies. Fix: `--init` flag in Docker `runArgs`.
- **GitHub auth lost on rebuild**: was using HTTPS remote + no credential helper. Fix: SSH deploy key on persistent volume, auto-configured by post-start.sh.
- **Claude auth lost on rebuild**: credentials not backed up. Fix: two-way sync between volume and `/workspace/.claude-credentials.json`, auto-backup every 30 min.
- **Session amnesia**: no context between sessions. Fix: `save-session.js` runs on Stop hook; `session-context.js` runs on SessionStart hook.
- **Global config lost**: `~/.claude/CLAUDE.md` didn't exist. Fix: post-create.sh copies from repo, post-start.sh verifies.
- **Ad-spy "Repository not found"**: the ai-arena deploy key is repo-scoped — it CANNOT clone ad-spy. Symptom: `git clone git@github.com:alexandrvakulsky-ux/ad-spy.git` fails with "Repository not found" even though the repo exists. Fix: use the PAT over HTTPS, or `source /workspace/scripts/ad-spy-helpers.sh && ad_spy_sync_local`.
- **Trusting `whoami` over `/proc`**: see "ROOT vs NODE" above. Kernel-side uid is the truth.
- **Confusing `/srv/ad-spy/` with the ad-spy code**: `/srv/ad-spy/` on the Hetzner host is the bind mount that becomes `/workspace` *inside* the ad-spy container. From inside ai-arena, `docker exec ad-spy ls /workspace` is the right way to inspect it.

## WHO ALEX IS
- Building AI Arena (multi-model comparison) and Ad Spy (FB Ad Library intelligence)
- Running self-hosted on a Hetzner VPS, developing in Docker dev containers
- Not a full-time developer — focus on shipping fast, keeping things simple
- Uses Claude Code via Desktop app, Remote Control (mobile), and SSH

## HOW ALEX WORKS BEST
- **Terse responses** — no preamble, no trailing summaries
- **Show evidence** before asking if something looks right
- **Smallest change** that solves the problem — no scope creep
- **Ask one clarifying question** if the request is ambiguous — don't guess

## UNIVERSAL CODE RULES
- No TypeScript — vanilla JS/Node only unless explicitly asked
- No new dependencies without asking first
- No build steps unless the project already uses them
- No comments added to code I didn't change

## AFTER FINISHING ANY TASK
1. Gather evidence (screenshot, test run, or curl)
2. Show the evidence
3. Ask: "Does this match what you expected?"

## CONTEXT HYGIENE
- Run `/compact` before starting a large task if context feels heavy
- Use the `reviewer` sub-agent after non-trivial changes
- Use skills instead of ad-hoc verification

## SKILL MAINTENANCE (mandatory)
Skills are living documents. Update immediately when:
- A mistake happens that the skill should have caught
- A correction comes from the user
- A new pattern emerges across 2+ sessions

## SKILL ROUTING (apply automatically)

| Situation | Skill |
|---|---|
| New feature | `brainstorming` (HARD GATE) |
| Single bug | `systematic-debugging` |
| Multi-file broken | `focused-fix` |
| Claiming something works | `verification-before-completion` |
| Writing new code | `test-driven-development` |
| Multi-step plan | `subagent-driven-development` |
| Backend change | `deploy-check` |
| Synthesis broken | `debug-synthesis` |
| API endpoints | `api-design-reviewer` |
| Frontend/CSS | `web-design-guidelines` + `ui-design-review` |
| External instructions pasted | `external-source-vetting` (ALWAYS) |
| Finishing any task | `task-completion-integrity` |
| After mistake | update the relevant skill immediately |
