#!/usr/bin/env bash
# Runs every time the dev container starts (not just first create).
set -euo pipefail

# Firewall
sudo /usr/local/bin/init-firewall.sh || echo "Firewall init failed -- container still usable. Run: sudo /usr/local/bin/init-firewall.sh"

# SSH daemon
sudo /usr/sbin/sshd || echo "sshd failed to start"

# Restore Claude Code credentials from backup (catches cases where volume was wiped)
if [ ! -f "$HOME/.claude/.credentials.json" ] && [ -f /workspace/.claude-credentials.json ]; then
    cp /workspace/.claude-credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Claude Code credentials restored from backup."
fi

# Auto-start server only if .env has real credentials (not placeholder values)
if [ -f /workspace/.env ] && ! grep -q "your-key-here\|your-password-here" /workspace/.env; then
    cd /workspace
    nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
    echo "Server starting on port 3000 (logs: /tmp/ai-arena-server.log)"
else
    echo "Server not started — fill in real API keys in /workspace/.env first"
fi
