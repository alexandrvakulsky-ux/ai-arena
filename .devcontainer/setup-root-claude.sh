#!/bin/bash
# Setup root user for Claude Code with bypass-permissions support.
# CANONICAL COPY: .devcontainer/setup-root-claude.sh (used in Docker build)
# If you edit this file, also update .devcontainer/setup-root-claude.sh
#
# Problem: Claude CLI refuses --dangerously-skip-permissions when UID=0 (root).
# Solution: LD_PRELOAD a tiny .so that fakes getuid/geteuid to return 1000.
#
# This script:
#   1. Copies credentials and settings from node -> root
#   2. Wraps any CLI binary in /root/.claude/remote/ccd-cli/ with the LD_PRELOAD trick
#   3. Runs a background watcher to catch new CLI binaries dropped by Claude Code desktop
#
# Called by: post-start.sh (via sudo), or manually: sudo /usr/local/bin/setup-root-claude.sh
# Requires: /root/.claude/remote/fakeid.so (built in Dockerfile)
#
# Known limitation: LD_PRELOAD only affects the CLI process itself (not exported to children).
# If a future CLI version checks /proc/self/status or getresuid(), this bypass will break.

set -e

FAKEID="/root/.claude/remote/fakeid.so"

if [ ! -f "$FAKEID" ]; then
    echo "ERROR: $FAKEID not found. Container image may be stale — rebuild needed."
    exit 1
fi

# 1. Copy credentials and settings from node to root (retry up to 60s if not yet available)
mkdir -p /root/.claude/remote
copy_node_credentials() {
    if [ -f /home/node/.claude/.credentials.json ]; then
        cp /home/node/.claude/.credentials.json /root/.claude/.credentials.json
        return 0
    fi
    return 1
}

if ! copy_node_credentials; then
    echo "Node credentials not found yet — retrying for up to 60s..."
    for i in $(seq 1 12); do
        sleep 5
        if copy_node_credentials; then
            echo "Node credentials found after ${i}x5s"
            break
        fi
    done
    [ -f /root/.claude/.credentials.json ] || echo "WARNING: node credentials never appeared — root Claude will not be authenticated"
fi
cp /home/node/.claude/settings.json /root/.claude/settings.json 2>/dev/null || true
cp /home/node/.claude/CLAUDE.md /root/.claude/CLAUDE.md 2>/dev/null || true

# 2. Wrap any existing CLI binaries
wrap_cli_binaries() {
    [ -d /root/.claude/remote/ccd-cli ] || return 0
    for CLI_BIN in /root/.claude/remote/ccd-cli/*; do
        [ -f "$CLI_BIN" ] || continue
        # Skip files that are already .real (the renamed originals)
        case "$CLI_BIN" in *.real) continue ;; esac
        # Skip if already wrapped (a .real companion exists)
        [ -f "${CLI_BIN}.real" ] && continue
        # Skip if it's already a shell script (wrapper)
        head -c 2 "$CLI_BIN" | grep -q '#!' && continue
        mv "$CLI_BIN" "${CLI_BIN}.real"
        cat > "$CLI_BIN" << 'WRAPPER'
#!/bin/bash
exec env LD_PRELOAD=/root/.claude/remote/fakeid.so "$(dirname "$0")/$(basename "$0").real" "$@"
WRAPPER
        chmod +x "$CLI_BIN"
        echo "Root bypass wrapper installed for $(basename "$CLI_BIN")"
    done
}

wrap_cli_binaries

# 3. Background watcher: runs for the lifetime of the container.
#    Polls every 10s for new CLI binaries and also re-syncs credentials periodically.
#    Kill any previous watcher first to avoid duplicates.
PIDFILE="/tmp/root-claude-watcher.pid"
if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
fi
(
    echo $$ > "$PIDFILE"
    CRED_SYNC=0
    while true; do
        sleep 10
        wrap_cli_binaries 2>>/tmp/root-claude-watcher.log
        # Re-sync credentials every 5 min (catches token refreshes)
        CRED_SYNC=$((CRED_SYNC + 1))
        if [ $CRED_SYNC -ge 30 ]; then
            CRED_SYNC=0
            if [ -f /home/node/.claude/.credentials.json ]; then
                cp /home/node/.claude/.credentials.json /root/.claude/.credentials.json 2>/dev/null
            fi
        fi
    done
) &
disown

echo "Root Claude setup complete (persistent watcher running in background)"
