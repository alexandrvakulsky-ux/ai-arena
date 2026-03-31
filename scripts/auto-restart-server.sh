#!/usr/bin/env bash
FILE="$1"
[ -z "$FILE" ] && exit 0
[[ "$FILE" == *server.js ]] || exit 0
[ -f /workspace/.env ] || exit 0

pkill -f "node /workspace/server.js" 2>/dev/null || true
pkill -f "npm.*start" 2>/dev/null || true
sleep 0.8

cd /workspace
nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
echo "server.js changed — server restarted" >&2
