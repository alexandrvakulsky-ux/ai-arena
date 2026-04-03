#!/usr/bin/env bash
# Rebuild and restart the ai-arena container from inside.
# Requires Docker socket to be mounted: -v /var/run/docker.sock:/var/run/docker.sock
set -euo pipefail

CONTAINER_NAME="ai-arena"
IMAGE_NAME="ai-arena"
WORKSPACE=$(docker inspect "$CONTAINER_NAME" --format='{{ (index .Mounts 0).Source }}' 2>/dev/null || echo "/root/ai-arena")

echo "=== Rebuilding $IMAGE_NAME from $WORKSPACE/.devcontainer ==="
docker build -t "$IMAGE_NAME" "$WORKSPACE/.devcontainer"

echo "=== Restarting container ==="
docker stop "$CONTAINER_NAME" && docker rm "$CONTAINER_NAME"
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  --cap-add=NET_ADMIN --cap-add=NET_RAW \
  -p 3000:3000 -p 2222:22 \
  -v ai-arena-bashhistory:/commandhistory \
  -v ai-arena-claude-config:/home/node/.claude \
  -v ai-arena-puppeteer-cache:/home/node/.cache/puppeteer \
  -v "$WORKSPACE":/workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$IMAGE_NAME" \
  bash -c "bash /workspace/.devcontainer/post-create.sh; bash /workspace/.devcontainer/post-start.sh; tail -f /dev/null"

echo "=== Done. Container restarted. SSH back in with: ssh hetzner-container ==="
