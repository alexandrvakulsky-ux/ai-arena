#!/usr/bin/env bash
# sync-second-brain.sh — mirror the live scout-bot source + brain (memory/journal)
# to the github.com/alexandrvakulsky-ux/second_brain repo. Idempotent: only commits
# + pushes when something actually changed. Excludes all secrets/runtime state.
# Scheduled (cron / auto-deploy loop). Logs to /workspace/sync-second-brain.log.
set -euo pipefail

PAT="$(grep -oE 'github_pat_[A-Za-z0-9_]+' /home/node/.claude/.git/config | head -1)"
[ -n "$PAT" ] || { echo "$(date -u +%FT%TZ) no PAT"; exit 1; }
SRC=/workspace/agents/scout-bot
MIRROR=/workspace/.second-brain-mirror
URL="https://x-access-token:${PAT}@github.com/alexandrvakulsky-ux/second_brain.git"

git config --global --add safe.directory "$MIRROR" 2>/dev/null || true
if [ ! -d "$MIRROR/.git" ]; then rm -rf "$MIRROR"; git clone -q "$URL" "$MIRROR"; fi
cd "$MIRROR"
git remote set-url origin "$URL"
git fetch -q origin main && git reset -q --hard origin/main

# SECURITY: memory.md + journal.md contain DM-derived context, coworker names and
# Telegram user IDs — they must NEVER be synced. Delete any previously-pushed copies.
rm -f "$MIRROR/memory.md" "$MIRROR/journal.md" 2>/dev/null || true
# Copy only the clean, non-secret source files.
for f in bot.js tools.js vectorstore.js seed-sources.json package.json README.md .gitignore; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$MIRROR/$f" || true
done

git add -A
if git diff --cached --quiet; then
  echo "$(date -u +%FT%TZ) no change"; exit 0
fi
git -c user.email="agent@adspy.local" -c user.name="adspy-agent" commit -q -m "sync $(date -u +%FT%TZ): bot source + brain snapshot"
git push -q origin main && echo "$(date -u +%FT%TZ) synced"
