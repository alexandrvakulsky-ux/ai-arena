#!/usr/bin/env bash
# Bootstrap Claude Code on any new machine.
# Run: curl -sL https://raw.githubusercontent.com/alexandrvakulsky-ux/ai-arena/main/scripts/bootstrap-claude.sh | bash
#
# What it does:
# 1. Creates ~/.claude/ directory
# 2. Downloads the global CLAUDE.md (bootstrap instructions for Claude)
# 3. Claude Code will read it automatically on next session start
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
REPO_RAW="https://raw.githubusercontent.com/alexandrvakulsky-ux/ai-arena/main"

mkdir -p "$CLAUDE_DIR"

echo "Downloading global Claude config..."
curl -sL "$REPO_RAW/.devcontainer/global-claude/CLAUDE.md" -o "$CLAUDE_DIR/CLAUDE.md"

if [ -f "$CLAUDE_DIR/CLAUDE.md" ]; then
    echo ""
    echo "Done. Claude Code will now auto-load project context on every session."
    echo ""
    echo "  ~/.claude/CLAUDE.md installed"
    echo ""
    echo "Next: run 'claude' in any directory. It will know to clone the repo and read the docs."
else
    echo "Failed to download. Check network access to github.com"
    exit 1
fi
