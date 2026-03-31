---
description: Git workflow, Railway deployment, and dev container operations for AI Arena.
---

## Git workflow
- Work on `main` branch directly — no feature branches
- Auto-commit + push fires on every file edit (PostToolUse hook)
- Before any major change: `git tag checkpoint-<short-description>`
- To roll back: `git log --oneline` to find the commit, `git revert <hash>` (never reset --hard)

## Railway deployment
- Auto-deploys from `main` branch on every push (configured in `railway.toml`)
- No manual deploy step needed — push = deploy
- To check if deployed: `git log origin/main..HEAD --oneline` (empty = in sync)
- Live URL is separate from localhost:3000 — always test locally first

## Dev container
- Container image: Node 20 slim + Claude Code CLI + Puppeteer + Chrome
- Port 3000 is forwarded automatically
- API keys go in `.env` — auto-created from `.env.example` on first container build
- Claude credentials backed up to `/workspace/.claude-credentials.json` on session end
- On rebuild: credentials restore automatically from backup

## Firewall (if network breaks)
- `sudo /usr/local/bin/reset-iptables.sh` — emergency unlock
- `sudo /usr/local/bin/init-firewall.sh` — re-apply full allowlist
- These work without a password. If sudo asks for a password, the image is outdated — rebuild.
