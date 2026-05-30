#!/usr/bin/env bash
# adspy-live-shot.sh — logged-in screenshot of the LIVE ad-spy UI (desktop+mobile),
# for before/after snapshots during the pinpoint-feedback edit loop.
# Runs the capture inside the ad-spy container (its Puppeteer + login), copies PNGs back.
#
# Usage:  scripts/adspy-live-shot.sh <label> [outdir]
#   <label>  e.g. "before" / "after-v1" — prefixes the output files.
#   [outdir] default /workspace/.claude/designs/live-shots
set -euo pipefail

LABEL="${1:?usage: adspy-live-shot.sh <label> [outdir]}"
OUTDIR="${2:-/workspace/.claude/designs/live-shots}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="ad-spy"
REMOTE="/tmp/adspy-shoot"
VIEWPORTS='[{"label":"desktop","w":1440,"h":900},{"label":"mobile","w":390,"h":844}]'

mkdir -p "$OUTDIR"
docker exec "$CONTAINER" mkdir -p "$REMOTE/out"
docker cp "$SELF_DIR/adspy-shoot.js" "$CONTAINER:$REMOTE/adspy-shoot.js"

cat > /tmp/adspy-live-job.json <<JOB
{ "outDir": "$REMOTE/out", "viewports": $VIEWPORTS, "fullPage": true, "settleMs": 2500,
  "targets": [ {"label":"$LABEL","url":"http://localhost:3001","login":true} ] }
JOB
docker cp /tmp/adspy-live-job.json "$CONTAINER:$REMOTE/live-job.json"

docker exec -e NODE_PATH=/workspace/node_modules -w /workspace "$CONTAINER" \
  node "$REMOTE/adspy-shoot.js" "$REMOTE/live-job.json" >/dev/null

for vp in desktop mobile; do
  docker cp "$CONTAINER:$REMOTE/out/${LABEL}_${vp}.png" "$OUTDIR/${LABEL}_${vp}.png"
  echo "$OUTDIR/${LABEL}_${vp}.png"
done
