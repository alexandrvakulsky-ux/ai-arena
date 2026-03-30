#!/bin/bash
# Background loop: saves Claude Code session every 15 minutes.
# Started by SessionStart hook. Only one instance runs at a time.

LOCKFILE=/tmp/save-session-loop.pid

# Kill previous instance if running
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE")
  kill "$OLD_PID" 2>/dev/null
fi
echo $$ > "$LOCKFILE"

while sleep 900; do
  node /workspace/scripts/save-session.js >> /tmp/session-saves.log 2>&1
done
