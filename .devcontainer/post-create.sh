#!/usr/bin/env bash
# Installs this app’s npm dependencies after the dev container is first created.
# Claude Code itself is installed in the image (see Dockerfile), not here — you do not need to npm-install it.
set -euo pipefail
cd /workspace

echo “”
echo “=== Dev container: installing AI Arena dependencies ===”
npm install

# Auto-create .env from example on first container creation
if [ ! -f /workspace/.env ] && [ -f /workspace/.env.example ]; then
    cp /workspace/.env.example /workspace/.env
    echo “”
    echo “=== Created .env from .env.example — fill in your API keys ===”
fi

# Initialize ~/.claude from claude-sync git repo on first run (new device / fresh volume).
# Subsequent updates happen via the SessionStart git pull hook.
if [ ! -d “$HOME/.claude/.git” ]; then
    echo “”
    echo “=== Initializing ~/.claude from claude-sync repo ===”
    git clone git@github.com:alexandrvakulsky-ux/claude-sync.git “$HOME/.claude” 2>/dev/null \
        && echo “=== Claude config synced from GitHub ===” \
        || echo “=== Note: SSH key not set up yet — claude-sync skipped. Add your API keys to .env manually, then run: git clone git@github.com:alexandrvakulsky-ux/claude-sync.git ~/.claude ===”
fi

# Install vc (voice-to-text for Claude Code)
mkdir -p “$HOME/.local/bin”
chmod +x /workspace/scripts/voice-claude.sh
chmod +x /workspace/scripts/validate-devcontainer.sh
chmod +x /workspace/scripts/commit-with-devcontainer-guard.sh
ln -sf /workspace/scripts/voice-claude.sh “$HOME/.local/bin/vc”

# Ensure ~/.local/bin is in PATH
if ! grep -q '\.local/bin' “$HOME/.zshrc” 2>/dev/null; then
    echo 'export PATH=”$HOME/.local/bin:$PATH”' >> “$HOME/.zshrc”
fi

echo “”
echo “=== Done ===”
echo “• Claude Code CLI: already in this image — in Terminal run:  claude”
echo “• Start the web app:  npm start   (or Task: Run → Start AI Arena)”
echo “• API keys: edit .env and add your keys (already created from .env.example)”
echo “• Voice input: run 'vc' to record a voice prompt (transcribed via Whisper)”
echo “  Usage: claude -p \”\$(vc)\”  or  vc | claude”
echo “”
