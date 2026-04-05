# Alexandr Vakulsky — Global Claude Config

YOU WORK FOR ALEX. This file is your bootstrap. Read it fully before doing anything.

## IMMEDIATE: ON EVERY SESSION START

### If /workspace/ exists (container is running):
1. `cat /workspace/.claude/CLAUDE.md` — project rules, stack, synthesis protocol
2. `cat /workspace/.claude/CONTAINER-OPS.md` — infra, SSH, ports, troubleshooting
3. `ls -t /workspace/.claude/sessions/*.md | head -3` then read those — recent conversation history
4. `cat /workspace/.claude/rules/*.md` — security, deployment, workflow rules
5. `ps aux | wc -l` — should be <50. If >100, investigate zombie processes.
6. `curl -s http://localhost:3000/health` — verify server running

### If /workspace/ DOES NOT exist (new machine, broken container, fresh install):
YOU MUST bootstrap. Run these commands yourself without asking:
```bash
git clone https://github.com/alexandrvakulsky-ux/ai-arena.git /tmp/ai-arena-docs
cat /tmp/ai-arena-docs/.claude/CLAUDE.md
cat /tmp/ai-arena-docs/.claude/CONTAINER-OPS.md
ls -t /tmp/ai-arena-docs/.claude/sessions/*.md | head -3 | xargs cat
```

### If git clone fails (no git, no network):
Tell Alex: "I need access to https://github.com/alexandrvakulsky-ux/ai-arena to load our project context. Can you give me network access or paste the CLAUDE.md contents?"

## REPOSITORY — THIS IS YOUR KNOWLEDGE BASE
- **Repo**: https://github.com/alexandrvakulsky-ux/ai-arena
- **Project docs**: `.claude/CLAUDE.md` (stack, API, synthesis protocol)
- **Infra runbook**: `.claude/CONTAINER-OPS.md` (SSH, ports, rebuild, troubleshooting)
- **Session history**: `.claude/sessions/YYYY-MM-DD-*.md` (summarized conversations)
- **Rules**: `.claude/rules/` (security.md, deployment.md, workflow.md)
- **Container setup**: `.devcontainer/` (Dockerfile, post-create.sh, post-start.sh)
- **Scripts**: `scripts/` (rebuild-container.sh, new-machine-setup.sh, etc.)

## INFRASTRUCTURE QUICK REFERENCE
- **Hetzner VPS**: 135.181.153.92
- **SSH into container**: port 2222 (maps to 22 inside), users: node, root
- **App**: port 3000 (Express/Node)
- **Deploy**: Railway auto-deploys from main branch
- **Docker volumes** (survive rebuild): ai-arena-claude-config, ai-arena-bashhistory, ai-arena-puppeteer-cache
- **GitHub deploy key**: stored on persistent volume at /home/node/.claude/github-deploy-key

## CORE PRINCIPLES — ALWAYS APPLY
- Do everything yourself. Only involve Alex for critical decisions (API keys, money, destructive ops).
- Never ask "should I do X?" if the answer is obviously yes. Just do it.
- Read before editing. Understand context before changing anything.
- Verify after changes. Run tests, check endpoints, confirm behavior.
- Document findings. Update session notes in .claude/sessions/ after significant work.

## PAST MISTAKES — DON'T REPEAT THESE
- **Zombie processes**: PID 1 was `tail -f /dev/null` → 1200+ zombies. Fix: --init flag + sleep infinity.
- **GitHub auth lost on rebuild**: was using HTTPS remote. Fix: SSH deploy key on persistent volume.
- **Claude auth lost on rebuild**: Fix: two-way sync between volume and /workspace/.claude-credentials.json.
- **Root wrapper cascade**: wrap_cli_binaries() kept re-wrapping `.real` files. Fix: skip `*.real` + `#!` guard.

## WHO ALEX IS
- Building AI Arena: multi-model comparison app (Claude vs GPT-4o vs Gemini)
- Running on Railway, developing in Docker dev containers on Hetzner VPS
- Not a full-time developer — focus on shipping fast, keeping things simple
- Uses Claude Code via Desktop app, Remote Control (mobile), and SSH

## HOW ALEX WORKS BEST
- **Terse responses** — no preamble, no trailing summaries
- **Show evidence** before asking if something looks right
- **Smallest change** that solves the problem — no scope creep

## UNIVERSAL CODE RULES
- No TypeScript — vanilla JS/Node only unless explicitly asked
- No new dependencies without asking first
- No build steps unless the project already uses them

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
