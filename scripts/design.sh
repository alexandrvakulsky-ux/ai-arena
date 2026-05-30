#!/usr/bin/env bash
# design.sh — the operational spine of the Ad Spy design process. One command surface
# that walks the DESIGN-PLAYBOOK phases and ties the pieces together (AIDesigner ↔
# publish ↔ Webvizio ↔ ship), with naming convention, craft brief, and brand kit baked
# in. You (the agent) still supply judgment: the prompt/feedback files and the critique.
#
#   design.sh shot [label]                                  # Phase 2 — snapshot current app
#   design.sh new <Surface> <Direction> <prompt-file> [refURL]   # Phase 3 — new named direction
#   design.sh iterate <run_id> <canvas_id> <feedback-file>  # Phase 5 — refine in place (overwrite)
#   design.sh review                                        # Phase 6 — pull Webvizio comments
#   design.sh ship <ported-real-index.html> [marker]        # Ship — safe prod deploy
#
# All design HTML flows API→file (never through model context). See DESIGN-PLAYBOOK.md.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESIGNS=/workspace/.claude/designs
CURRENT="$DESIGNS/current/design.html"
BRAND="3ba50f7f-aa3a-4b85-9bea-de0986dd60d7"   # saved "Ad Spy" brand kit
mkdir -p "$DESIGNS/current"

jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d.trim().split(/\n/).pop())["'"$1"'"]??"")}catch(e){console.log("")}})'; }

cmd="${1:?usage: design.sh <shot|new|iterate|review|ship> ...}"; shift || true
case "$cmd" in
  shot)
    bash "$SELF/adspy-live-shot.sh" "${1:-current}" ;;

  new)
    SURFACE="${1:?Surface (e.g. Dashboard)}"; DIRECTION="${2:?Direction (e.g. Premium)}"; PF="${3:?prompt-file}"; REF="${4:-}"
    slug="$(echo "$SURFACE-$DIRECTION" | tr '[:upper:] ' '[:lower:]-')"
    out="$DESIGNS/$slug/v1.html"; mkdir -p "$(dirname "$out")"
    echo ">> Phase 3 — generating direction '$SURFACE — $DIRECTION'" >&2
    META="$(node "$SELF/aidesigner.js" gen "$out" --prompt-file="$PF" --surface="$SURFACE" --direction="$DIRECTION" --brand="$BRAND" --viewport=desktop ${REF:+--mode=enhance --url="$REF"})"
    echo "$META"
    cp "$out" "$CURRENT"
    bash "$SELF/publish-staging.sh" "$CURRENT" >&2
    RID=$(printf '%s' "$META" | jget run_id); CID=$(printf '%s' "$META" | jget canvas_id)
    echo ">> run_id=$RID canvas_id=$CID  · staging: https://alexandrvakulsky-ux.github.io/ai-arena/  · iterate with: design.sh iterate $RID $CID <feedback-file>" >&2 ;;

  iterate)
    RID="${1:?run_id}"; CID="${2:?canvas_id (overwrite in place)}"; FF="${3:?feedback-file}"
    echo ">> Phase 5 — refining canvas $CID in place" >&2
    META="$(node "$SELF/aidesigner.js" refine "$CURRENT" --run="$RID" --target="$CID" --feedback-file="$FF" --brand="$BRAND" --viewport=desktop)"
    echo "$META"
    bash "$SELF/publish-staging.sh" "$CURRENT" >&2
    NRID=$(printf '%s' "$META" | jget run_id)
    echo ">> new run_id=$NRID (same canvas $CID) · staging updated · next: design.sh review" >&2 ;;

  review)
    echo ">> Phase 6 — pulling Webvizio comments" >&2
    bash "$SELF/wv.sh" pull "$DESIGNS/current/feedback" ;;

  ship)
    PORTED="${1:?ported real index.html (full-template port, NOT a token swap)}"; MARKER="${2:-DM+Sans}"
    echo ">> Ship — deploying full-template port to prod (backup + verify + rollback)" >&2
    bash "$SELF/adspy-deploy-reskin.sh" "$PORTED" --marker="$MARKER" ;;

  *) echo "usage: design.sh <shot|new|iterate|review|ship> ..." >&2; exit 2 ;;
esac
