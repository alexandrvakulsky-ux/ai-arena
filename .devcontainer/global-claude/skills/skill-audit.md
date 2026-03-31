---
name: skill-audit
description: Periodic review of all skills in ~/.claude/skills/. Prune dead ones, merge overlapping ones, update stale ones, add missing ones. Run after any session where a pattern emerged that no skill covers, or monthly.
---

# Skill Audit

## When to Run

- A mistake happened that no existing skill would have caught → add one
- A skill fired but its instructions didn't quite fit the situation → update it
- You notice two skills giving contradictory advice → resolve the conflict
- A skill references a tool, path, or pattern that no longer exists → fix or remove
- After 10+ sessions without reviewing — skills drift from reality

## Phase 1 — Usage Review

For each skill in `~/.claude/skills/*.md`, ask:
- Has this fired at least once in recent memory?
- When it fired, did following it actually help?
- Is the trigger description still accurate?

**Remove** skills that have never fired and have no plausible trigger in this work context.
**Flag** skills that fired but felt generic or unhelpful — they need sharpening.

## Phase 2 — Conflict Check

Read skill descriptions and identify pairs that could both fire for the same situation. For each conflict:
1. Is the distinction in their triggers clear enough to pick one unambiguously?
2. If not: merge them into one skill, keeping the stronger rules from each
3. Update the routing table in `~/.claude/CLAUDE.md` if the trigger changes

Known overlaps to re-check each audit:
- `systematic-debugging` vs `focused-fix` — single bug vs whole feature
- `verification-before-completion` vs `task-completion-integrity` — claims vs artifacts
- `web-design-guidelines` vs `ui-design-review` vs `nielsen-heuristics-audit` — three UI skills, should be clearly differentiated or merged

## Phase 3 — Staleness Check

For each skill, check if its instructions are still accurate:
- Do referenced file paths still exist?
- Do referenced tools/commands still work?
- Does the skill assume a context that has changed (e.g., project-specific details in a global skill)?
- Are there new patterns from recent sessions that should be added to the skill body?

Fix inline. Don't create a separate "updated" version — just edit the file.

## Phase 4 — Gap Check

Think about recent sessions: what mistakes happened, what felt awkward, what had to be figured out from scratch?

For each gap: is it worth a new skill, or can an existing skill be extended?
- New skill: the pattern is distinct enough to need its own trigger and process
- Extend existing: it's a special case of something already covered

## Phase 5 — Routing Table Sync

After any adds/removes/renames, update the routing table in `~/.claude/CLAUDE.md`:
- Add new skills with their trigger
- Remove deleted skills
- Update triggers that changed
- Re-check skill hierarchy section for conflicts

## Output

Brief report:
- Skills removed (and why)
- Skills updated (what changed)
- Skills added (what gap they fill)
- Conflicts resolved
- Routing table updated: yes/no
