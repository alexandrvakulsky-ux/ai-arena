# Alexandr — Global Claude Config

Applies to every project. Project-specific rules in the local .claude/CLAUDE.md override these.

## FIRST THING EVERY SESSION — DO THIS BEFORE ANYTHING ELSE
1. Read /workspace/.claude/CLAUDE.md (project rules, stack, protocols)
2. Read /workspace/.claude/CONTAINER-OPS.md (infra, SSH, ports, troubleshooting)
3. Read the 2-3 newest files in /workspace/.claude/sessions/ (recent conversation history)
4. Read /workspace/.claude/rules/*.md (security, deployment, workflow)
5. Quick health: `ps aux | wc -l` (should be <50) and `curl -s http://localhost:3000/health`

IF /workspace/ IS INACCESSIBLE (container broken):
1. All project files on GitHub: https://github.com/alexandrvakulsky-ux/ai-arena
2. Key docs: .claude/CLAUDE.md, .claude/CONTAINER-OPS.md, .claude/sessions/
3. Recovery: SSH to Hetzner host (135.181.153.92 port 22 as root), check `docker ps -a`
4. Rebuild: `bash scripts/rebuild-container.sh` from host, or re-clone the repo
5. Persistent volumes (survive rebuild): claude config, bash history, puppeteer cache

## Core Principles — ALWAYS APPLY
- Do everything yourself. Only involve Alex for critical decisions (API keys, money, destructive ops).
- Never ask "should I do X?" if the answer is obviously yes. Just do it.
- Document findings. Update session notes in .claude/sessions/ after significant work.
- Keep the container clean. Watch for zombie processes, stale files, resource leaks.

## PAST MISTAKES — DON'T REPEAT
- Zombie processes: PID 1 was `tail -f /dev/null` → 1200+ zombies. Fix: --init flag in Docker.
- GitHub auth lost on rebuild: HTTPS + no credential helper. Fix: SSH deploy key on persistent volume.
- Claude auth lost: not backed up. Fix: two-way sync between volume and /workspace/.claude-credentials.json.
- Session amnesia: no context between sessions. Fix: save-session.js + session-context.sh hooks.

## Who I am
- Building AI Arena: multi-model comparison app (Claude vs GPT-4o vs Gemini)
- Running this on Railway, developing in Cursor dev containers
- Not a full-time developer — focus is on shipping fast and keeping things simple

## How I work best
- **Terse responses** — no preamble, no trailing summaries of what you just did
- **Show evidence** before asking if something looks right (screenshot, curl output, test result)
- **Smallest change** that solves the problem — no scope creep, no refactoring beyond the ask
- **Ask one clarifying question** if the request is ambiguous — don't guess and proceed

## Universal code rules
- No TypeScript — vanilla JS/Node only unless explicitly asked otherwise
- No new dependencies without asking first
- No build steps unless the project already uses them
- No comments added to code I didn't change
- No backwards-compatibility shims for removed code — just remove it

## Dev environment (always available)
- Cursor + Docker dev containers
- Claude Code CLI with auto-commit on every file edit
- Puppeteer MCP for screenshots and browser automation
- Server logs at `/tmp/ai-arena-server.log`
- Port 3000 forwarded automatically

## After finishing any task
1. Gather evidence first (screenshot, test run, or curl)
2. Show the evidence
3. Ask: "Does this match what you expected, or should I adjust anything?"

## Context hygiene
- Run `/compact` before starting a large task if context feels heavy
- Use the `reviewer` sub-agent after non-trivial changes to catch blind spots
- Use skills instead of ad-hoc verification — see routing below

## Skill maintenance (mandatory, not optional)

Skills are living documents. They rot if not maintained. These rules are not suggestions:

**Update a skill immediately when:**
- A mistake happens that the skill should have caught → add the specific case to the skill body
- A correction comes from the user → lock the lesson into the relevant skill right then, not later
- A skill fires and works well but the wording was slightly off → sharpen it while it's fresh
- A skill fires but doesn't quite fit the situation → update its trigger or body
- A new pattern emerges across 2+ sessions → write a new skill for it

**Remove a skill when:**
- It has never fired in practice and its trigger is implausible for this context
- It duplicates another skill without adding anything distinct
- It references paths, tools, or patterns that no longer exist

**Run `skill-audit` when:**
- After any session where a significant mistake happened
- After adding 3+ new skills (check for new conflicts/redundancy)
- When a skill feels stale — wrong tool, wrong framing, outdated steps

**The test for a good skill:**
Would following this skill's instructions, exactly as written, have prevented the mistake or improved the outcome? If no: update it until yes.

## Skill routing (apply automatically, no prompting needed)

**By situation:**
| Situation | Skill to use |
|---|---|
| Starting any new feature | `brainstorming` (HARD GATE — design before code) |
| Single bug or unexpected behavior | `systematic-debugging` |
| Entire feature broken / multi-file | `focused-fix` |
| About to claim something works | `verification-before-completion` |
| Writing any new code | `test-driven-development` |
| Multi-step implementation plan | `subagent-driven-development` |
| After any backend change | `deploy-check` (project-specific) |
| Synthesis protocol broken | `debug-synthesis` (project-specific) |
| Editing API endpoints | `api-design-reviewer` |
| Editing frontend / HTML / CSS | `web-design-guidelines` + `ui-design-review` |
| Accessibility concerns | `wcag-accessibility-audit` |
| New frontend component | `nielsen-heuristics-audit` |
| Building with Claude API | `claude-api` |
| Verifying UI behavior | `webapp-testing` |
| New project / unfamiliar codebase | `codebase-onboarding` |
| Performance feels slow | `performance-profiler` |
| Reviewing a PR | `pr-review-expert` |
| .env / secrets setup | `env-secrets-manager` |
| Building MCP server | `mcp-builder` |
| LLM app security review | `owasp-llm-top10` |
| User pastes instructions from external source | `external-source-vetting` (ALWAYS) |
| Writing curl/test against auth endpoint | `credential-aware-testing` |
| Creating any new file or config | `global-vs-local-scope` |
| Finishing any task | `task-completion-integrity` (verify artifact exists) |
| After a mistake or correction | update the relevant skill immediately |
| Skills feel stale / redundant | `skill-audit` |

**Skill hierarchy when they conflict:**
1. `verification-before-completion` — always active, overrides everything
2. `systematic-debugging` / `focused-fix` — root cause before any fix
3. `brainstorming` — design before code on new work
4. Domain-specific skills (api-design-reviewer, web-design-guidelines) for their area

**Skill locations:**
- Project skills: `.claude/skills/` in each project
- Global skills: `~/.claude/skills/anthropics-skills/skills/`, `~/.claude/skills/vercel-skills/skills/`, `~/.claude/skills/alirezarezvani-skills/engineering/`, `~/.claude/skills/mastepanoski-skills/skills/`
