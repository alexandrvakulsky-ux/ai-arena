#!/usr/bin/env bash
# Auto-restarts the dev server when server.js is edited.
# Called by the Claude Code PostToolUse hook with the edited file path.
FILE="$1"
[ -z "$FILE" ] && exit 0

# Only act on server.js edits
echo "$FILE" | grep -q "server\.js$" || exit 0

[ -f /workspace/.env ] || exit 0

echo "=== server.js changed — restarting server ==="
pkill -f "node /workspace/server.js" 2>/dev/null || true
pkill -f "npm.*start" 2>/dev/null || true
sleep 0.8

cd /workspace
nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
echo "Server restarted (logs: /tmp/ai-arena-server.log)"
