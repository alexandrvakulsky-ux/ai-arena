#!/usr/bin/env bash
# adspy-design-compare.sh — full COMPARE stage of the ad-spy design pipeline.
# Captures the live ad-spy dashboard (logged in) + one or more local design
# drafts, all rendered inside the ad-spy container (Puppeteer + its internet so
# CDN mockups style), then builds a side-by-side reference|candidate|diff report.
#
# Usage:
#   scripts/adspy-design-compare.sh <run-name> <draft1.html> [draft2.html ...]
# Output:
#   /workspace/.claude/designs/<run-name>/report.html  (+ shots/, manifest.json)
set -euo pipefail

NAME="${1:?usage: adspy-design-compare.sh <run-name> <draft.html> [...]}"; shift
[ "$#" -ge 1 ] || { echo "need at least one draft .html" >&2; exit 2; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNDIR="/workspace/.claude/designs/$NAME"
SHOTS="$RUNDIR/shots"
CONTAINER="ad-spy"
REMOTE="/tmp/adspy-shoot"
VIEWPORTS='[{"label":"desktop","w":1440,"h":900},{"label":"mobile","w":390,"h":844}]'

mkdir -p "$SHOTS"
docker exec "$CONTAINER" rm -rf "$REMOTE"
docker exec "$CONTAINER" mkdir -p "$REMOTE/drafts" "$REMOTE/out"
docker cp "$SELF_DIR/adspy-shoot.js" "$CONTAINER:$REMOTE/adspy-shoot.js"

# Build targets: live reference (login) + each draft (file, gate dismissed).
targets='[{"label":"live","url":"http://localhost:3001","login":true}'
for f in "$@"; do
  [ -f "$f" ] || { echo "no such draft: $f" >&2; exit 2; }
  label="$(basename "$f" .html)"
  docker cp "$f" "$CONTAINER:$REMOTE/drafts/$label.html"
  targets="$targets,{\"label\":\"$label\",\"file\":\"$REMOTE/drafts/$label.html\",\"hideGate\":true}"
done
targets="$targets]"

cat > /tmp/adspy-shoot-job.json <<JOB
{ "outDir": "$REMOTE/out", "viewports": $VIEWPORTS, "fullPage": true, "settleMs": 2500, "targets": $targets }
JOB
docker cp /tmp/adspy-shoot-job.json "$CONTAINER:$REMOTE/job.json"

echo ">> capturing (live + $#  draft(s)) in $CONTAINER ..." >&2
docker exec -e NODE_PATH=/workspace/node_modules -w /workspace "$CONTAINER" \
  node "$REMOTE/adspy-shoot.js" "$REMOTE/job.json" >/dev/null

echo ">> copying shots back ..." >&2
docker exec "$CONTAINER" sh -c "cd $REMOTE/out && ls *.png" | while read -r png; do
  docker cp "$CONTAINER:$REMOTE/out/$png" "$SHOTS/$png"
done

# Build compare-shots config (reference=live, candidates=draft labels).
cands="$(for f in "$@"; do printf '"%s",' "$(basename "$f" .html)"; done | sed 's/,$//')"
cat > "$RUNDIR/compare.json" <<CFG
{
  "name": "$NAME",
  "runDir": "$RUNDIR",
  "shotsDir": "$SHOTS",
  "threshold": 0.1,
  "viewports": $VIEWPORTS,
  "reference": "live",
  "candidates": [$cands]
}
CFG

node "$SELF_DIR/design-compare.js" compare-shots "$RUNDIR/compare.json"
echo ">> report: $RUNDIR/report.html" >&2
