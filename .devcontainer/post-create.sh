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

# Restore Claude Code credentials from backup (survives container rebuilds)
if [ ! -f "$HOME/.claude/.credentials.json" ] && [ -f /workspace/.claude-credentials.json ]; then
    cp /workspace/.claude-credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Claude Code credentials restored from backup."
fi

# claude-sync: clone config repo into ~/.claude on first run (needs SSH key)
# Volume mount creates the directory — clone only if it's empty (no .git yet)
if [ ! -d "$HOME/.claude/.git" ]; then
    echo ""
    git clone --depth 1 git@github.com:alexandrvakulsky-ux/claude-sync.git "$HOME/.claude" 2>/dev/null \
        && echo "Claude config synced from GitHub." \
        || echo "Note: claude-sync skipped (SSH key not set up). Run manually later:"$'\n'"  git clone git@github.com:alexandrvakulsky-ux/claude-sync.git ~/.claude"
fi

# Load app API keys into shell — but unset ANTHROPIC_API_KEY so Claude CLI
# continues to use OAuth (.credentials.json) instead of falling back to API-key mode.
# server.js loads ANTHROPIC_API_KEY via dotenv directly from .env, so it never
# needs it in the shell environment.
if ! grep -q 'workspace/.env' "$HOME/.zshrc" 2>/dev/null; then
    echo '[ -f /workspace/.env ] && set -a && . /workspace/.env && set +a && unset ANTHROPIC_API_KEY' >> "$HOME/.zshrc"
fi

echo ""
echo "================================================"
echo " Setup status"
echo "================================================"

# Check each required .env key for placeholder or missing values
MISSING=0
for key in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY APP_PASSWORD; do
    val=$(grep "^${key}=" .env 2>/dev/null | cut -d= -f2- || true)
    if [ -z "$val" ] || echo "$val" | grep -qi 'your\|-here\|placeholder\|example'; then
        echo "  [!] .env: $key — needs a real value"
        MISSING=$((MISSING + 1))
    fi
done
if [ "$MISSING" -eq 0 ]; then
    echo "  [ok] .env — all keys set"
else
    echo "      -> Edit /workspace/.env"
fi

# Check Claude Code credentials
if [ -f "$HOME/.claude/.credentials.json" ]; then
    echo "  [ok] Claude Code — authenticated"
else
    echo "  [!] Claude Code — not logged in"
    echo "      -> Run: claude auth login"
fi

echo "================================================"
echo ""
echo "  npm start  — run the app on port 3000"
echo "  claude     — Claude Code CLI"
echo ""
