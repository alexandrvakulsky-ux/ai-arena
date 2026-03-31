---
description: How to approach every task — before, during, and after. Applies to all work in this repo.
---

## Before starting
- Read relevant files fully before editing — never modify code you haven't read
- For non-trivial tasks, create a checkpoint tag first: `git tag checkpoint-<short-description>`
- If the request is ambiguous, ask one clarifying question before starting

## While working
- Smallest change that solves the problem — no refactoring or cleanup beyond what was asked
- No new npm dependencies without explicit approval
- No TypeScript, no build steps — keep it vanilla JS/Node
- No comments or annotations added to code you didn't change

## After finishing — feedback loop (required)
Gather evidence before asking for feedback. Never ask "does it look right?" blind.
- UI/frontend change → take a Puppeteer screenshot and show it
- API/backend change → run `npm test` and show results, or use the `deploy-check` skill
- Full flow change → use Puppeteer to walk through the actual interaction
- If Puppeteer or the server isn't running, say so and ask — don't skip verification

After showing evidence: "Does this match what you expected, or should I adjust anything?"
Skip only for trivial fixes where the outcome is self-evident.

## Context management
- Run `/context` when a session feels slow or responses seem to miss earlier details
- Run `/compact` proactively before starting a large task if context is above 50%
- Use the `reviewer` sub-agent after writing non-trivial changes to server.js

## Never
- Change the synthesis output format (`Scores: Claude=X/10...` + `## ✨ Synthesized Answer`) — frontend parses it exactly
- Log request bodies or expose API keys
- Guess at missing context — ask instead
