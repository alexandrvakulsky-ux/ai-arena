#!/usr/bin/env bash
# adspy-deploy-reskin.sh — deploy a RESKINNED real ad-spy index.html to production,
# safely. ad-spy serves public/ via express.static (no restart needed). Backs up
# out-of-tree, swaps atomically, verifies the live app (200 + reskin marker), and
# auto-rolls-back on failure. NEVER ship the AIDesigner mockup (demo data/stripped
# JS) — only a token/font/logo reskin of the real index.html.
#
#   scripts/adspy-deploy-reskin.sh <reskinned-index.html> [--marker=DM+Sans]
#   scripts/adspy-deploy-reskin.sh --rollback
set -euo pipefail

CONTAINER="ad-spy"
LIVE=/workspace/public/index.html               # path INSIDE ad-spy
BACKUP_DIR=/workspace/.deploy-backups            # in ai-arena (gitignored), out of ad-spy tree
mkdir -p "$BACKUP_DIR"
TS="$(docker exec "$CONTAINER" date +%Y%m%d-%H%M%S)"

rollback() {
  local newest; newest="$(ls -1t "$BACKUP_DIR"/index.html.* 2>/dev/null | head -1 || true)"
  [ -n "$newest" ] || { echo '{"ok":false,"error":"no backup to roll back to"}'; exit 1; }
  docker cp "$newest" "$CONTAINER:$LIVE"
  echo "{\"ok\":true,\"action\":\"rollback\",\"restored\":\"$(basename "$newest")\"}"
}

[ "${1:-}" = "--rollback" ] && { rollback; exit 0; }

SRC="${1:?usage: adspy-deploy-reskin.sh <reskinned-index.html> [--marker=STR] | --rollback}"
[ -f "$SRC" ] || { echo "{\"ok\":false,\"error\":\"no such file: $SRC\"}"; exit 1; }
MARKER="DM+Sans"
for a in "$@"; do case "$a" in --marker=*) MARKER="${a#--marker=}";; esac; done

# Guard: refuse obvious mockups (demo data / no gate / no API wiring).
if ! grep -q 'id="gate"' "$SRC" || ! grep -q '/api/' "$SRC"; then
  echo '{"ok":false,"error":"refusing: file lacks #gate or /api/ wiring — looks like a mockup, not the real reskinned app"}'; exit 1
fi

# 1) backup current live (out of tree)
docker cp "$CONTAINER:$LIVE" "$BACKUP_DIR/index.html.$TS"
# keep last 8 backups
ls -1t "$BACKUP_DIR"/index.html.* 2>/dev/null | tail -n +9 | xargs -r rm -f

# 2) stage + atomic swap
docker cp "$SRC" "$CONTAINER:$LIVE.staged"
docker exec "$CONTAINER" mv "$LIVE.staged" "$LIVE"

# 3) verify the live app: 200 + marker present
VERIFY="$(docker exec "$CONTAINER" node -e '
const http=require("http");
http.get("http://localhost:3001/index.html",r=>{let d="";r.on("data",c=>d+=c).on("end",()=>{
  process.stdout.write(JSON.stringify({code:r.statusCode,marker:d.includes(process.argv[1])}));
});}).on("error",e=>process.stdout.write(JSON.stringify({code:0,err:e.message})));
' "$MARKER" 2>&1)"

if echo "$VERIFY" | grep -q '"code":200' && echo "$VERIFY" | grep -q '"marker":true'; then
  echo "{\"ok\":true,\"action\":\"deploy\",\"backup\":\"index.html.$TS\",\"verify\":$VERIFY}"
else
  docker cp "$BACKUP_DIR/index.html.$TS" "$CONTAINER:$LIVE"   # auto-restore
  echo "{\"ok\":false,\"action\":\"deploy-failed-rolledback\",\"verify\":$VERIFY}"
  exit 1
fi
