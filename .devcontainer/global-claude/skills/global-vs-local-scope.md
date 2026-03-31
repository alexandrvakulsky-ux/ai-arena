---
name: global-vs-local-scope
description: Use when creating any new file, script, hook, agent, or config. Explicitly decide: does this belong in ~/.claude (every project) or .claude (this project only)? Wrong scope = either pollutes all projects or gets lost on next project.
---

# Global vs Local Scope Decision

## The Mistake This Prevents

Creating a useful script in `/workspace/scripts/` and wiring it into `.claude/settings.json`, then discovering it's actually useful everywhere — but the next project doesn't have it. Or the reverse: installing a project-specific hook globally and having it break in unrelated projects.

## Decision Tree

```
Is this useful in ANY project, not just this one?
├── YES → Global (~/.claude/)
│   ├── Workflow behavior, skill reminders, completion chime → ~/.claude/settings.json hooks
│   ├── General-purpose scripts (extract-file-path, skill-reminder) → ~/.claude/scripts/
│   ├── Skills that apply to any codebase → ~/.claude/skills/
│   └── Agents (reviewer, researcher) → ~/.claude/agents/
│
└── NO → Project (.claude/ or project scripts/)
    ├── Project-specific hooks (auto-restart server.js, save session) → .claude/settings.json
    ├── Scripts that reference project paths → scripts/ in the project
    ├── Skills specific to this app's domain → .claude/skills/
    └── Rules about this project's architecture → .claude/rules/
```

## Rule of Thumb

**Global if:** removing the project directory would make you rebuild it for the next project.

**Local if:** it references a specific file path, port, command, or behavior unique to this project.

## Common Mistakes

| What | Wrong scope | Right scope | Why |
|------|------------|-------------|-----|
| `skill-reminder.js` | Project `/scripts/` | `~/.claude/scripts/` | Useful in every project |
| `save-session.js` | `~/.claude/scripts/` | Project `/scripts/` | References project-specific paths |
| `reviewer` agent | Project `.claude/agents/` | `~/.claude/agents/` | Every project benefits from code review |
| `deploy-check` skill | `~/.claude/skills/` | Project `.claude/skills/` | Checks AI Arena-specific endpoints |
| Auto-restart server hook | `~/.claude/settings.json` | Project `.claude/settings.json` | Only this project has `server.js` |
| Completion chime | Project `.claude/settings.json` | `~/.claude/settings.json` | Useful in every session |

## Before Creating Any New File

1. Write the file
2. Ask: "Would I want this in my next project too?"
3. If yes: put it in `~/.claude/` — global scope
4. If it's in global scope but references project paths: make the paths dynamic (`$PWD`, read from config, or parameterize)
5. Update both `~/.claude/settings.json` AND `.claude/settings.json` if the hook needs to work globally but also has project-specific variants
