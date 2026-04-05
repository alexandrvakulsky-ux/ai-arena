#!/usr/bin/env bash
# Self-rebuild: triggers a container rebuild FROM INSIDE the container.
# Uses Docker API via socket to spawn a helper container on the host
# that builds the new image and replaces this container.
#
# Usage: bash scripts/self-rebuild.sh
set -euo pipefail

SOCK="/var/run/docker.sock"
API="http://localhost"
CONTAINER_NAME="ai-arena"
IMAGE_NAME="ai-arena"
HOST_WORKSPACE="/srv/ai-arena"

if [ ! -S "$SOCK" ]; then
    echo "ERROR: Docker socket not mounted. Can't self-rebuild."
    exit 1
fi

echo "=== Self-rebuild starting ==="
echo "This will:"
echo "  1. Build new image from .devcontainer/"
echo "  2. Stop and remove this container"
echo "  3. Start a new container with --init"
echo "  4. You'll need to reconnect SSH after ~60 seconds"
echo ""
echo "Starting in 5 seconds... (Ctrl+C to abort)"
sleep 5

# The rebuild script to run on the host via a helper container
# The rebuild uses Docker API directly (curl + unix socket) — no docker CLI needed.
# We use a helper container based on node:20-slim (already on host, no pull needed).
REBUILD_SCRIPT='#!/bin/bash
set -e
SOCK="/var/run/docker.sock"
API="http://localhost"

echo "[rebuild] Building new image..."
# Build via Docker API — POST /build with tar context
cd /host-workspace/.devcontainer
tar -c . | curl -s --unix-socket $SOCK \
  -X POST -H "Content-Type: application/x-tar" \
  --data-binary @- "$API/build?t=ai-arena&rm=true" | \
  while IFS= read -r line; do
    MSG=$(echo "$line" | node -e "try{const d=JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\"));process.stdout.write(d.stream||d.error||\"\")}catch{}" 2>/dev/null)
    [ -n "$MSG" ] && printf "%s" "$MSG"
  done
echo ""

echo "[rebuild] Stopping old container..."
curl -s --unix-socket $SOCK -X POST "$API/containers/ai-arena/stop?t=10" > /dev/null 2>&1 || true
sleep 2
curl -s --unix-socket $SOCK -X DELETE "$API/containers/ai-arena?force=true" > /dev/null 2>&1 || true

echo "[rebuild] Starting new container with --init..."
RESP=$(curl -s --unix-socket $SOCK -X POST \
  -H "Content-Type: application/json" \
  "$API/containers/create?name=ai-arena" \
  -d "{
    \"Image\": \"ai-arena\",
    \"Cmd\": [\"bash\", \"-c\", \"bash /workspace/.devcontainer/post-create.sh; bash /workspace/.devcontainer/post-start.sh; sleep infinity\"],
    \"ExposedPorts\": {\"22/tcp\": {}, \"3000/tcp\": {}},
    \"HostConfig\": {
      \"Init\": true,
      \"RestartPolicy\": {\"Name\": \"unless-stopped\"},
      \"CapAdd\": [\"NET_ADMIN\", \"NET_RAW\"],
      \"PortBindings\": {
        \"22/tcp\": [{\"HostPort\": \"2222\"}],
        \"3000/tcp\": [{\"HostPort\": \"3000\"}]
      },
      \"Binds\": [
        \"ai-arena-bashhistory:/commandhistory\",
        \"ai-arena-claude-config:/home/node/.claude\",
        \"ai-arena-puppeteer-cache:/home/node/.cache/puppeteer\",
        \"/srv/ai-arena:/workspace\",
        \"/var/run/docker.sock:/var/run/docker.sock\"
      ]
    }
  }")
NEW_ID=$(echo "$RESP" | node -e "process.stdout.write(JSON.parse(require(\"fs\").readFileSync(\"/dev/stdin\",\"utf8\")).Id||\"\")" 2>/dev/null)

if [ -z "$NEW_ID" ]; then
  echo "[rebuild] ERROR creating container: $RESP"
  exit 1
fi

curl -s --unix-socket $SOCK -X POST "$API/containers/$NEW_ID/start" > /dev/null
echo "[rebuild] New container started: ${NEW_ID:0:12}"
echo "[rebuild] Reconnect: ssh -p 2222 root@135.181.153.92"
'

echo "Spawning rebuild helper container..."
# Remove old helper if exists
curl -s --unix-socket $SOCK -X DELETE "$API/containers/ai-arena-rebuilder?force=true" > /dev/null 2>&1 || true

# Create helper container using node:20-slim (already pulled, no network needed)
HELPER_ID=$(curl -s --unix-socket $SOCK -X POST \
  -H "Content-Type: application/json" \
  "$API/containers/create?name=ai-arena-rebuilder" \
  -d "{
    \"Image\": \"ai-arena\",
    \"Cmd\": [\"bash\", \"-c\", $(node -e "console.log(JSON.stringify(process.argv[1]))" "$REBUILD_SCRIPT")],
    \"HostConfig\": {
      \"Binds\": [
        \"/var/run/docker.sock:/var/run/docker.sock\",
        \"${HOST_WORKSPACE}:/host-workspace\"
      ],
      \"AutoRemove\": true
    }
  }" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).Id || '')")

if [ -z "$HELPER_ID" ]; then
    echo "ERROR: Failed to create rebuild helper container."
    echo "Try manual rebuild: ssh root@135.181.153.92 'bash /srv/ai-arena/scripts/rebuild-container.sh'"
    exit 1
fi

echo "Helper container: ${HELPER_ID:0:12}"
echo "Starting rebuild... This container will stop shortly."
echo ""
echo ">>> Reconnect in ~60 seconds: ssh -p 2222 root@135.181.153.92 <<<"
echo ""

# Start the helper — it will kill us
curl -s --unix-socket $SOCK -X POST "$API/containers/$HELPER_ID/start" > /dev/null 2>&1

echo "Rebuild in progress..."
# Wait a bit so the user sees the message before we die
sleep 10
