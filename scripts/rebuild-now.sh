#!/bin/bash
# Runs inside a helper container to replace the main ai-arena container.
# Uses curl to talk to Docker API via mounted socket.
SOCK="/var/run/docker.sock"
API="http://localhost"

echo "[rebuild] Stopping ai-arena..."
curl -sf --unix-socket $SOCK -X POST "$API/containers/ai-arena/stop?t=5" 2>&1 || true
sleep 3
curl -sf --unix-socket $SOCK -X DELETE "$API/containers/ai-arena?force=true" 2>&1 || true
sleep 1

# Tag rebuild as latest
curl -sf --unix-socket $SOCK -X POST "$API/images/ai-arena:rebuild/tag?repo=ai-arena&tag=latest" || true

echo "[rebuild] Creating new container..."
BODY='{"Image":"ai-arena:latest","Cmd":["bash","-c","bash /workspace/.devcontainer/post-create.sh; bash /workspace/.devcontainer/post-start.sh; sleep infinity"],"ExposedPorts":{"22/tcp":{},"3000/tcp":{}},"HostConfig":{"Init":true,"RestartPolicy":{"Name":"unless-stopped"},"CapAdd":["NET_ADMIN","NET_RAW"],"PortBindings":{"22/tcp":[{"HostPort":"2222"}],"3000/tcp":[{"HostPort":"3000"}]},"Binds":["ai-arena-bashhistory:/commandhistory","ai-arena-claude-config:/home/node/.claude","ai-arena-puppeteer-cache:/home/node/.cache/puppeteer","/srv/ai-arena:/workspace","/var/run/docker.sock:/var/run/docker.sock"]}}'

RESP=$(curl -sf --unix-socket $SOCK -X POST -H "Content-Type: application/json" "$API/containers/create?name=ai-arena" -d "$BODY" 2>&1)
echo "[rebuild] Create response: $RESP"

echo "[rebuild] Starting..."
curl -sf --unix-socket $SOCK -X POST "$API/containers/ai-arena/start" 2>&1
echo "[rebuild] Done. Reconnect: ssh -p 2222 root@135.181.153.92"
