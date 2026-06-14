#!/usr/bin/env bash
# meta-sync-loop.sh — daily Meta Ads sync into the second-brain.
#
# Runs /workspace/data/meta-campaigns/sync-meta.js once per UTC day (durable
# System User token, low-frequency data → daily is plenty). Checks hourly; the
# date-stamp guard makes it fire once/day and retry next hour on failure.
#
# Run detached now:        setsid bash /workspace/scripts/meta-sync-loop.sh < /dev/null & disown
# Make it survive rebuild: launched from /workspace/.devcontainer/post-start.sh
# Stop it:                 pkill -f meta-sync-loop.sh
set -uo pipefail
exec 9>/tmp/meta-sync-loop.lock
flock -n 9 || { echo "[meta-loop] already running — exiting"; exit 0; }
echo "[meta-loop] started $(date -u +%FT%TZ)"
STAMP=/workspace/data/meta-campaigns/.last-sync
while true; do
  TODAY=$(date -u +%F)
  if [ "$(cat "$STAMP" 2>/dev/null)" != "$TODAY" ]; then
    if node /workspace/data/meta-campaigns/sync-meta.js >> /workspace/meta-sync.log 2>&1; then
      echo "$TODAY" > "$STAMP"
      echo "[meta-loop] synced $TODAY $(date -u +%FT%TZ)"
    else
      echo "[meta-loop] sync failed $(date -u +%FT%TZ) — retry next cycle"
    fi
  fi
  sleep 3600
done
