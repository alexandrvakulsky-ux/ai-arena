---
description: Recognize when a bug is a symptom of an upstream premise, not a new problem. Applies to any project.
---

## The rule

If you see a bug that "feels like" one you fixed recently, **stop before patching it again**. Go up one level and question the premise that your previous fix depended on.

## How to spot it

Red flags that you're about to patch a symptom, not the root cause:

- User says "this broke AGAIN" or "still broken"
- Your proposed fix is adjacent to last time's fix (same file, same function, different branch)
- The thing you're patching is a *signal* (detected value, cached flag, heuristic) rather than the ground-truth data
- You keep saying "this time I really got it"

## The discipline

Before writing the Nth fix for a recurring issue:

1. **Read any project-local `MISTAKES.md`**. If one doesn't exist, check session notes (`.claude/sessions/*.md`) for the same symptom.
2. **Look at actual data**, not your assumption of what the data should be. Run a query. Count something. Print it. Prove the diagnosis.
3. **Ask: what premise does my fix depend on?** If it's "X is correctly detected" and you've been patching detection for months, detection is the wrong signal. Find the ground truth and use it directly.
4. **If the fix works, write the entry in MISTAKES.md + add a Stop-hook invariant.** The invariant should catch the *class* of bug, not the specific symptom — usually a `check_not` that forbids the old broken pattern.

## Example

Ad Spy's "video play button missing" bug was patched 5 times. Each patch fixed a downstream signal (render logic, URL capture, Puppeteer timing, meta.json re-read, FB fallback).

The real premise was "play button requires `ad_format === 'video'`." But `ad_format` is async and lags. The real signal was `has_video` (video URL cached), which is instantly accurate.

Fix: stop using `ad_format` for the decision. Invariant: `check_not` forbids `isVideoFormat && canPlayInline` pattern from returning.

See `/srv/ad-spy/MISTAKES.md` for the full class list.

## Adjacent rules

- When editing shared files, `git remote -v` first (`hooks/pre-destructive.sh` enforces)
- Never `setInterval` in a server handling paid APIs (`hooks/invariants.sh` forbids)
- Before "fallback" logic, ask: what does the user see when it fires? If worse than doing nothing, don't add it.
