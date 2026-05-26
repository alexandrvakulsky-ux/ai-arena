#!/usr/bin/env bash
# Poll origin/main every 60s. On new commit: pull + restart child processes.
# Same role Railway used to play. Nothing fancy.
#
# Managed children:
#   - node /workspace/server.js (ai-arena web server, port 3000)
#   - node /workspace/agents/scout-bot/bot.js (Telegram scout bot — only if
#     TELEGRAM_BOT_TOKEN is present in .env)
#
# Start (do this once per container lifetime):
#   nohup bash /workspace/scripts/auto-deploy.sh >> /workspace/auto-deploy.log 2>&1 &
#   disown
#
# Stop:
#   pkill -f scripts/auto-deploy.sh

cd /workspace || exit 1

start_children() {
  pkill -f "node /workspace/server.js" 2>/dev/null
  pkill -f "^node server.js" 2>/dev/null
  pkill -f "agents/scout-bot/bot.js" 2>/dev/null
  sleep 2
  nohup node /workspace/server.js >> /workspace/server.log 2>&1 &
  disown
  # Bot self-exits with code 0 if TELEGRAM_BOT_TOKEN is missing, so always-on
  # spawn is safe — costs nothing if disabled.
  if [ -f /workspace/agents/scout-bot/bot.js ]; then
    nohup node /workspace/agents/scout-bot/bot.js >> /workspace/scout-bot.log 2>&1 &
    disown
  fi
}

LAST=$(git rev-parse HEAD)
echo "[auto-deploy $(date -u +%FT%TZ)] starting at $LAST"
start_children

while true; do
  sleep 60
  git fetch --quiet origin main 2>/dev/null || continue
  CURR=$(git rev-parse origin/main)
  if [ "$CURR" != "$LAST" ]; then
    echo "[auto-deploy $(date -u +%FT%TZ)] new commit $LAST -> $CURR, pulling + restarting"
    git pull --rebase --autostash --quiet origin main || { echo "  pull failed, retrying next cycle"; continue; }
    start_children
    LAST=$CURR
    echo "[auto-deploy $(date -u +%FT%TZ)] restarted on $CURR"
  fi
done
