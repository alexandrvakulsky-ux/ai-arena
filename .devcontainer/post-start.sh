#!/usr/bin/env bash
# Runs every time the dev container starts (not just first create).
set -euo pipefail

# Firewall
sudo /usr/local/bin/init-firewall.sh || echo "Firewall init failed -- container still usable. Run: sudo /usr/local/bin/init-firewall.sh"

# SSH daemon — run with -o to clean up finished sessions
sudo /usr/sbin/sshd -o "UsePAM yes" || echo "sshd failed to start"

# Zombie reaper safety net: periodically wait for orphaned children
# This helps even if --init is not available (e.g., older Docker versions)
(while true; do
  sleep 300
  # Log zombie count for monitoring
  ZOMBIE_COUNT=$(ps -eo stat | grep -c '^Z' 2>/dev/null || echo 0)
  if [ "$ZOMBIE_COUNT" -gt 0 ]; then
    echo "$(date): $ZOMBIE_COUNT zombie processes detected" >> /tmp/zombie-reaper.log
  fi
done) &
disown

# Restore Claude Code credentials from backup (catches cases where volume was wiped)
if [ ! -f "$HOME/.claude/.credentials.json" ] && [ -f /workspace/.claude-credentials.json ]; then
    cp /workspace/.claude-credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Claude Code credentials restored from backup."
fi

# Auto-start Claude Code in a persistent tmux session (enables mobile remote control)
export PATH=$PATH:/usr/local/share/npm-global/bin
if command -v claude &>/dev/null && command -v tmux &>/dev/null && [ -f "$HOME/.claude/.credentials.json" ]; then
    tmux has-session -t claude 2>/dev/null || tmux new-session -d -s claude -c /workspace "claude"
    echo "Claude Code started in tmux session 'claude' (attach with: tmux attach -t claude)"
else
    echo "Claude Code tmux session skipped — not authenticated or tmux missing"
fi

# Auto-start server only if .env has real credentials (not placeholder values)
if [ -f /workspace/.env ] && ! grep -q "your-key-here\|your-password-here" /workspace/.env; then
    cd /workspace
    nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
    echo "Server starting on port 3000 (logs: /tmp/ai-arena-server.log)"
else
    echo "Server not started — fill in real API keys in /workspace/.env first"
fi
