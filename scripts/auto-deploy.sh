#!/usr/bin/env bash
# Poll origin/main every 60s. On new commit: pull + restart node server.js.
# Same role Railway used to play. Nothing fancy.
#
# Start (do this once per container lifetime):
#   nohup bash /workspace/scripts/auto-deploy.sh >> /workspace/auto-deploy.log 2>&1 &
#   disown
#
# Stop:
#   pkill -f scripts/auto-deploy.sh

cd /workspace || exit 1
LAST=$(git rev-parse HEAD)
echo "[auto-deploy $(date -u +%FT%TZ)] starting at $LAST"

while true; do
  sleep 60
  git fetch --quiet origin main 2>/dev/null || continue
  CURR=$(git rev-parse origin/main)
  if [ "$CURR" != "$LAST" ]; then
    echo "[auto-deploy $(date -u +%FT%TZ)] new commit $LAST -> $CURR, pulling + restarting"
    git pull --rebase --autostash --quiet origin main || { echo "  pull failed, retrying next cycle"; continue; }
    pkill -f "node /workspace/server.js" 2>/dev/null
    pkill -f "^node server.js" 2>/dev/null
    sleep 2
    nohup node /workspace/server.js >> /workspace/server.log 2>&1 &
    disown
    LAST=$CURR
    echo "[auto-deploy $(date -u +%FT%TZ)] restarted on $CURR"
  fi
done
