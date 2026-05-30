#!/usr/bin/env bash
# publish-staging.sh — publish a design HTML to the GitHub Pages staging URL that
# Webvizio loads. Idempotent (no-op if unchanged), verified (polls until the live
# page actually matches), persistent clone (fetch+reset, not re-clone each time).
#
#   scripts/publish-staging.sh <local.html>
# Output: one-line JSON {ok,url,sha,changed,live}.
set -euo pipefail

SRC="${1:?usage: publish-staging.sh <local.html>}"
[ -f "$SRC" ] || { echo "{\"ok\":false,\"error\":\"no such file: $SRC\"}"; exit 1; }

REPO_URL_HOST="github.com/alexandrvakulsky-ux/ai-arena.git"
CLONE=/tmp/aip
URL="https://alexandrvakulsky-ux.github.io/ai-arena/"
PAT="$(grep -oE 'github_pat_[A-Za-z0-9_]+' /home/node/.claude/.git/config | head -1)"
[ -n "$PAT" ] || { echo '{"ok":false,"error":"no PAT in /home/node/.claude/.git/config"}'; exit 1; }
AUTH_URL="https://x-access-token:${PAT}@${REPO_URL_HOST}"

# Persistent gh-pages clone: refresh if present, else clone.
if [ -d "$CLONE/.git" ]; then
  git config --global --add safe.directory "$CLONE" 2>/dev/null || true
  git -C "$CLONE" remote set-url origin "$AUTH_URL"
  git -C "$CLONE" fetch -q origin "+refs/heads/gh-pages:refs/remotes/origin/gh-pages"
  git -C "$CLONE" checkout -q gh-pages 2>/dev/null || git -C "$CLONE" checkout -q -b gh-pages origin/gh-pages
  git -C "$CLONE" reset -q --hard origin/gh-pages
else
  rm -rf "$CLONE"
  git clone -q --branch gh-pages "$AUTH_URL" "$CLONE"
  git config --global --add safe.directory "$CLONE" 2>/dev/null || true
fi

cp "$SRC" "$CLONE/index.html"
cp "$SRC" "$CLONE/adspy-redesign-latest.html"

cd "$CLONE"
if git diff --quiet; then
  echo "{\"ok\":true,\"url\":\"$URL\",\"changed\":false,\"note\":\"already published\"}"
  exit 0
fi
git -c user.email="agent@adspy.local" -c user.name="adspy-agent" commit -aqm "Publish design to staging"
git push -q origin gh-pages
SHA="$(git rev-parse --short HEAD)"

# Verify: poll until the live page's hash matches the source (GitHub Pages build).
WANT="$(sha256sum "$SRC" | cut -d' ' -f1)"
LIVE=false
for i in $(seq 1 20); do
  GOT="$(curl -4 -fsSL "${URL}?cb=${SHA}-${i}" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)"
  if [ "$GOT" = "$WANT" ]; then LIVE=true; break; fi
  sleep 5
done
echo "{\"ok\":true,\"url\":\"$URL\",\"changed\":true,\"sha\":\"$SHA\",\"live\":$LIVE}"
