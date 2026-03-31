---
name: task-completion-integrity
description: Use before saying any task is done. Verify the artifact actually exists — file on disk, server responds, output matches. Prevents "I fetched the content but forgot to write the files" class of mistakes.
---

# Task Completion Integrity

## The Mistake This Prevents

Fetching content, generating output, or planning a change — then saying it's done without confirming the artifact actually landed. The most common form: "I've added X" when X was computed but never written to disk.

## The Iron Law

```
CLAIMING DONE = ARTIFACT EXISTS AND IS CORRECT
Not: "I generated it" or "I planned it" or "I fetched it"
```

## Verification by Artifact Type

**File created/edited:**
```bash
# Does it exist?
ls -la path/to/file
# Does it have the right content?
head -20 path/to/file
```

**Script/hook wired up:**
- Read the config file that references it
- Confirm the path in the config matches the actual file path
- Check for typos between where the file lives and where the hook points

**Server change:**
```bash
# Is the server running with the new code?
curl -s http://localhost:3000/api/health
# Check logs for errors
tail -20 /tmp/ai-arena-server.log
```

**Skill/agent created:**
```bash
ls ~/.claude/skills/*.md | grep skill-name
# OR
ls .claude/skills/*.md | grep skill-name
```

**Git committed:**
```bash
git log --oneline -3
git status --short
```

## High-Risk Moments

These are when this mistake most often happens:

1. **Multi-step fetching** — agent fetches content from a URL, returns it in the conversation, but the Write step never fires. Always confirm `ls` after any "I'll write these files" plan.

2. **Session continuation** — work started in one context window, continued in another. The previous session may have left things half-done. On continuation, check what actually exists before assuming it's there.

3. **Parallel operations** — when doing many things at once, easy to miss that one failed silently. Check each artifact individually.

4. **Config references** — writing a script to `path/A` but wiring the hook to `path/B`. Both exist but the hook is broken. Always cross-check paths.

## Before Saying "Done"

- [ ] I can name the specific file/endpoint/output that proves this is done
- [ ] I have verified that artifact exists right now (not "should exist", not "I wrote it earlier")
- [ ] If it's a script: I've confirmed the path matches wherever it's referenced
- [ ] If it's a server change: I've confirmed the server restarted with the new code
