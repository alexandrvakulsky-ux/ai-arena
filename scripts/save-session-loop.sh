#!/bin/bash
# Background loop: saves Claude Code session on inactivity (10 min idle).
# Checks every 60s. Saves once per idle period — not on a fixed clock.
# Started by SessionStart hook. Only one instance runs at a time.

LOCKFILE=/tmp/save-session-loop.pid
IDLE_THRESHOLD=600  # 10 minutes in seconds

# Kill previous instance if running
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE")
  kill "$OLD_PID" 2>/dev/null
fi
echo $$ > "$LOCKFILE"

LAST_SAVE=0

while sleep 60; do
  # Find the most recently modified session JSONL
  JSONL=$(ls -t ~/.claude/projects/-workspace/*.jsonl 2>/dev/null | head -1)
  [ -z "$JSONL" ] && continue

  LAST_MOD=$(stat -c %Y "$JSONL" 2>/dev/null)
  NOW=$(date +%s)
  IDLE=$((NOW - LAST_MOD))

  # Save if: idle >= 10min AND there's been new activity since last save
  if [ "$IDLE" -ge "$IDLE_THRESHOLD" ] && [ "$LAST_MOD" -gt "$LAST_SAVE" ]; then
    node /workspace/scripts/save-session.js >> /tmp/session-saves.log 2>&1
    LAST_SAVE=$NOW
  fi
done
