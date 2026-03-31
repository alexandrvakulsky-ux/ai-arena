#!/usr/bin/env bash
# Runs once after the dev container is created.
# Claude Code CLI + Puppeteer MCP are in the image; this installs the app's own deps.
set -euo pipefail
cd /workspace

echo "=== Installing AI Arena dependencies ==="
npm install

# Chrome for Puppeteer MCP — cached in a Docker volume, only downloads once
PUPPETEER_INSTALL="$(npm root -g)/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer/install.mjs"
if [ ! -d "$HOME/.cache/puppeteer/chrome" ] && [ -f "$PUPPETEER_INSTALL" ]; then
    echo "Downloading Chrome for Puppeteer (first time only)..."
    node "$PUPPETEER_INSTALL"
else
    echo "Chrome: cached"
fi

# .env from example on first run
if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example — fill in your API keys."
fi

# claude-sync: clone config repo into ~/.claude on first run (needs SSH key)
# Volume mount creates the directory — clone only if it's empty (no .git yet)
if [ ! -d "$HOME/.claude/.git" ]; then
    echo ""
    git clone --depth 1 git@github.com:alexandrvakulsky-ux/claude-sync.git "$HOME/.claude" 2>/dev/null \
        && echo "Claude config synced from GitHub." \
        || echo "Note: claude-sync skipped (SSH key not set up). Run manually later:"$'\n'"  git clone git@github.com:alexandrvakulsky-ux/claude-sync.git ~/.claude"
fi

echo ""
echo "Ready:"
echo "  npm start     — run the app (port 3000)"
echo "  claude        — Claude Code CLI"
echo ""
