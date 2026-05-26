#!/usr/bin/env bash
# Production supervisor for ai-arena on the Hetzner host.
#
# What it does:
#   1. Polls origin/main every 60s; on new commits, pulls + restarts
#      `node server.js`.
#   2. If `node server.js` crashes, restarts after 3s.
#   3. Logs everything to /workspace/server.log (append-mode so history
#      survives restarts).
#
# Why this exists:
#   ai-arena used to auto-deploy via Railway. After moving production to
#   the Hetzner host (2026-05-26), we need a local equivalent: pull on
#   push + restart on crash. This script is the minimum-viable replacement.
#   No pm2, no systemd dependency, no setInterval-in-Node — pure bash.
#
# How to start it (do this once per container lifetime):
#   nohup bash /workspace/scripts/prod-supervisor.sh > /workspace/supervisor.log 2>&1 &
#   disown
#
# How to stop it:
#   pkill -f 'scripts/prod-supervisor.sh'
#   pkill -f 'node /workspace/server.js'
#
# How to verify it's running:
#   ps aux | grep -E 'prod-supervisor|node /workspace/server.js' | grep -v grep
#
# Cost: $0 — local file ops + one HEAD-of-origin fetch per minute.

set -u

cd /workspace || exit 1

SERVER_LOG=/workspace/server.log
SUP_LOG=/workspace/supervisor.log
POLL_INTERVAL=60
RESTART_BACKOFF=3
PID_FILE=/workspace/.prod-supervisor.pid

# Bail if another supervisor is already running. We track by PID rather
# than checking ps -ef to avoid false positives from the user grepping.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[supervisor] already running as PID $(cat "$PID_FILE") — exiting" >&2
  exit 1
fi
echo $$ > "$PID_FILE"

log() {
  echo "[supervisor $(date -u +%FT%TZ)] $*" | tee -a "$SUP_LOG"
}

cleanup() {
  log "shutdown signal received, killing node server"
  if [ -n "${SERVER_PID:-}" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup TERM INT

start_server() {
  log "starting node server.js (cwd=/workspace, log → $SERVER_LOG)"
  node server.js >> "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  log "node server.js PID=$SERVER_PID"
}

restart_server() {
  log "restarting node server.js"
  if [ -n "${SERVER_PID:-}" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    # Give it 5s to exit cleanly; then KILL.
    for _ in 1 2 3 4 5; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  start_server
}

# Track which commit we deployed so we only pull-and-restart on change.
LAST_SHA=$(git -C /workspace rev-parse HEAD 2>/dev/null || echo "unknown")
log "supervisor starting at sha=$LAST_SHA poll_interval=${POLL_INTERVAL}s"

start_server

while true; do
  # Sleep then check both: did the server die, and is there a new commit?
  for _ in $(seq 1 "$POLL_INTERVAL"); do
    sleep 1
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "node server.js died unexpectedly, restarting in ${RESTART_BACKOFF}s"
      sleep "$RESTART_BACKOFF"
      start_server
    fi
  done

  # Poll for new commits on origin/main
  if ! git -C /workspace fetch --quiet origin main 2>>"$SUP_LOG"; then
    log "git fetch failed (transient network?), will retry next cycle"
    continue
  fi
  CURR_SHA=$(git -C /workspace rev-parse origin/main 2>/dev/null || echo "unknown")
  if [ "$CURR_SHA" != "$LAST_SHA" ]; then
    log "new commit detected: $LAST_SHA → $CURR_SHA — pulling + restarting"
    if git -C /workspace pull --rebase --autostash --quiet origin main 2>>"$SUP_LOG"; then
      LAST_SHA=$CURR_SHA
      restart_server
    else
      log "git pull failed — will retry next cycle"
    fi
  fi
done
