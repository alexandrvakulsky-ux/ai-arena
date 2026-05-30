#!/usr/bin/env bash
# wv.sh — Webvizio relay wrapper (run from ai-arena). Resolves the durable API
# key, ships webvizio.js into the ad-spy container (which has the internet the
# registered MCP can't reach from ai-arena), runs the command, and copies any
# screenshots back to ai-arena.
#
#   scripts/wv.sh tasks                      # open tasks (JSON)
#   scripts/wv.sh task <uuid>
#   scripts/wv.sh prompt <uuid>
#   scripts/wv.sh shot <uuid> <local.png>
#   scripts/wv.sh close <uuid>
#   scripts/wv.sh pull <local-dir>           # tasks+prompts+screenshots -> local-dir/
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="ad-spy"
REMOTE_JS="/tmp/webvizio.js"

KEY="${WEBVIZIO_API_KEY:-}"
[ -z "$KEY" ] && [ -f /home/node/.claude/webvizio.key ] && KEY="$(cat /home/node/.claude/webvizio.key)"
[ -n "$KEY" ] || { echo '{"ok":false,"error":"no Webvizio key (set WEBVIZIO_API_KEY or /home/node/.claude/webvizio.key)"}'; exit 1; }

docker cp "$SELF_DIR/webvizio.js" "$CONTAINER:$REMOTE_JS"
run() { docker exec -e WEBVIZIO_API_KEY="$KEY" ${WEBVIZIO_PROJECT:+-e WEBVIZIO_PROJECT="$WEBVIZIO_PROJECT"} "$CONTAINER" node "$REMOTE_JS" "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  pull)
    LOCAL="${1:?usage: wv.sh pull <local-dir>}"
    docker exec "$CONTAINER" rm -rf /tmp/wv-pull
    run pull /tmp/wv-pull
    mkdir -p "$LOCAL"
    docker cp "$CONTAINER:/tmp/wv-pull/." "$LOCAL/" >/dev/null
    echo ">> screenshots + tasks.json copied to $LOCAL" >&2
    ;;
  shot)
    UUID="${1:?usage: wv.sh shot <uuid> <local.png>}"; LOCAL="${2:?usage: wv.sh shot <uuid> <local.png>}"
    run shot "$UUID" /tmp/wv-shot.png
    mkdir -p "$(dirname "$LOCAL")"
    docker cp "$CONTAINER:/tmp/wv-shot.png" "$LOCAL" >/dev/null
    echo ">> screenshot -> $LOCAL" >&2
    ;;
  *)
    run "$cmd" "$@"
    ;;
esac
