#!/usr/bin/env bash
# Smart auto-commit: validates .devcontainer/ files before committing.
# Used by the Claude Code PostToolUse hook in .claude/settings.json.
# Usage: commit-with-devcontainer-guard.sh <file_path>

set -euo pipefail

FILE="$1"
[ -z "$FILE" ] && exit 0

BASENAME=$(basename "$FILE")

# Check if this is a devcontainer config file
if echo "$FILE" | grep -qE "^(\.devcontainer/|/workspace/\.devcontainer/)"; then
    echo "=== Devcontainer file changed: $FILE ==="

    # Run validation — if it fails, DO NOT commit
    if ! bash /workspace/scripts/validate-devcontainer.sh 2>&1; then
        echo ""
        echo "❌ Devcontainer validation FAILED — changes NOT auto-committed." >&2
        echo "   Fix the issues above, then manually run:" >&2
        echo "   git add '$FILE' && git commit -m 'fix: update devcontainer config'" >&2
        exit 1
    fi

    # Validation passed — tag last known good state before committing
    BACKUP_TAG="devcontainer-backup-$(date +%s)"
    git tag "$BACKUP_TAG" HEAD 2>/dev/null \
        && echo "Tagged recovery point: $BACKUP_TAG (git checkout $BACKUP_TAG -- .devcontainer/ to restore)" \
        || true
fi

# Commit and push
git add "$FILE" \
    && git commit -m "Auto-save: update $BASENAME" \
    && git push \
    2>/dev/null || true
