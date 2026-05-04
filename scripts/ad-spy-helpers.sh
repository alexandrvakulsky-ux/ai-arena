#!/usr/bin/env bash
# Helpers for working with the sibling ad-spy container + repo from
# inside the ai-arena container.
#
# Source this file or copy the parts you need:
#   source /workspace/scripts/ad-spy-helpers.sh
#
# Three things you usually want:
#   1. clone/refresh a local read-only copy of ad-spy (for grep/review)
#   2. docker exec into the live ad-spy container
#   3. tail ad-spy logs

set -uo pipefail

AD_SPY_LOCAL="/tmp/ad-spy"
AD_SPY_CONTAINER="ad-spy"

# Pull the GitHub PAT out of the claude-sync clone (persistent, in named volume).
# This PAT is owner-scoped and can read all of alexandrvakulsky-ux's private repos.
ad_spy_pat() {
  grep -oE 'github_pat_[A-Za-z0-9_]+' /home/node/.claude/.git/config 2>/dev/null | head -1
}

# Clone or fast-forward /tmp/ad-spy. /tmp is ephemeral so this re-clones
# after a container rebuild — that's fine, takes ~2s.
ad_spy_sync_local() {
  local pat
  pat=$(ad_spy_pat)
  if [ -z "$pat" ]; then
    echo "[ad-spy] PAT not found in /home/node/.claude/.git/config" >&2
    return 1
  fi
  if [ -d "$AD_SPY_LOCAL/.git" ]; then
    git -C "$AD_SPY_LOCAL" remote set-url origin "https://x-access-token:$pat@github.com/alexandrvakulsky-ux/ad-spy.git"
    git -C "$AD_SPY_LOCAL" fetch --quiet origin main && git -C "$AD_SPY_LOCAL" reset --hard origin/main --quiet
  else
    git clone --quiet "https://x-access-token:$pat@github.com/alexandrvakulsky-ux/ad-spy.git" "$AD_SPY_LOCAL"
  fi
  echo "[ad-spy] local clone at $AD_SPY_LOCAL @ $(git -C $AD_SPY_LOCAL rev-parse --short HEAD)"
}

# Run a command in the live ad-spy container.
#   ad_spy_exec ls /workspace
#   ad_spy_exec git log --oneline -5
ad_spy_exec() {
  docker exec "$AD_SPY_CONTAINER" "$@"
}

# Tail the live server log
ad_spy_log() {
  docker exec "$AD_SPY_CONTAINER" tail -n "${1:-50}" /workspace/server.log
}

# If invoked directly (not sourced), run a basic status check.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "=== local clone ==="
  ad_spy_sync_local || exit 1
  echo ""
  echo "=== live container ==="
  ad_spy_exec git -C /workspace log --oneline -3
  echo ""
  echo "=== health ==="
  ad_spy_exec curl -sm 3 http://localhost:3001/health || echo "(no /health)"
fi
