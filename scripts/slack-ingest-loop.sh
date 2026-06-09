#!/usr/bin/env bash
# slack-ingest-loop.sh — recurring Slack ingest every 30 min.
#
# ⚠️ This sends Slack channel + DM content to OpenAI (embeddings) and Anthropic
# (distillation). Start it yourself; it is intentionally NOT auto-wired into the
# container boot. flock guard prevents a second copy from running.
#
# Run detached now:        setsid bash /workspace/scripts/slack-ingest-loop.sh < /dev/null & disown
# Make it survive rebuild: add that same line to /workspace/.devcontainer/post-start.sh
# Stop it:                 pkill -f slack-ingest-loop.sh
set -uo pipefail
exec 9>/tmp/slack-ingest-loop.lock
flock -n 9 || { echo "[slack-loop] already running — exiting"; exit 0; }
echo "[slack-loop] started $(date -u +%FT%TZ)"
while true; do
  node /workspace/agents/scout-bot/slack-ingest.js >> /workspace/slack-ingest.log 2>&1 || true
  node /workspace/agents/scout-bot/fireflies-ingest.js >> /workspace/fireflies-ingest.log 2>&1 || true
  sleep 1800
done
