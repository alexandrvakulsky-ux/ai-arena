#!/usr/bin/env bash
# Runs every time the dev container starts (not just first create).
set -euo pipefail

# Firewall
sudo /usr/local/bin/init-firewall.sh || echo "Firewall init failed -- container still usable. Run: sudo /usr/local/bin/init-firewall.sh"

# SSH daemon — run with -o to clean up finished sessions
sudo /usr/sbin/sshd -o "UsePAM yes" || echo "sshd failed to start"

# Keep global CLAUDE.md in sync from repo (source of truth) for both users
if [ -f /workspace/.devcontainer/global-claude/CLAUDE.md ]; then
    cp /workspace/.devcontainer/global-claude/CLAUDE.md "$HOME/.claude/CLAUDE.md" 2>/dev/null || true
    sudo cp /workspace/.devcontainer/global-claude/CLAUDE.md /root/.claude/CLAUDE.md 2>/dev/null || true
fi

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

# GitHub SSH key — stored on persistent volume, symlinked on every start
if [ -f "$HOME/.claude/github-deploy-key" ]; then
    mkdir -p "$HOME/.ssh"
    cp "$HOME/.claude/github-deploy-key" "$HOME/.ssh/github-deploy-key"
    chmod 600 "$HOME/.ssh/github-deploy-key"
    ssh-keyscan github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
    # Configure git to use this key for GitHub
    git config --global core.sshCommand "ssh -i $HOME/.ssh/github-deploy-key -o StrictHostKeyChecking=accept-new"
    git config --global user.name "alexandrvakulsky-ux"
    git config --global user.email "alexandr.vakulsky@gmail.com"
    echo "GitHub SSH deploy key configured."
fi

# Ensure git remote uses SSH (not HTTPS) for ai-arena
if [ -d /workspace/.git ]; then
    CURRENT_URL=$(git -C /workspace remote get-url origin 2>/dev/null || true)
    if echo "$CURRENT_URL" | grep -q "https://"; then
        git -C /workspace remote set-url origin "git@github.com:alexandrvakulsky-ux/ai-arena.git"
        echo "Switched git remote from HTTPS to SSH."
    fi
fi

# Claude Code credentials — two-way sync between volume and workspace backup
CRED_VOLUME="$HOME/.claude/.credentials.json"
CRED_BACKUP="/workspace/.claude-credentials.json"
if [ -f "$CRED_VOLUME" ] && [ -f "$CRED_BACKUP" ]; then
    # Both exist — keep the newer one (most recent auth/refresh wins)
    if [ "$CRED_VOLUME" -nt "$CRED_BACKUP" ]; then
        cp "$CRED_VOLUME" "$CRED_BACKUP"
        chmod 600 "$CRED_BACKUP"
        echo "Claude credentials: volume → backup (volume was newer)."
    elif [ "$CRED_BACKUP" -nt "$CRED_VOLUME" ]; then
        cp "$CRED_BACKUP" "$CRED_VOLUME"
        chmod 600 "$CRED_VOLUME"
        echo "Claude credentials: backup → volume (backup was newer)."
    fi
elif [ -f "$CRED_BACKUP" ] && [ ! -f "$CRED_VOLUME" ]; then
    # Volume wiped — restore from backup
    mkdir -p "$(dirname "$CRED_VOLUME")"
    cp "$CRED_BACKUP" "$CRED_VOLUME"
    chmod 600 "$CRED_VOLUME"
    echo "Claude credentials: restored from backup (volume was empty)."
elif [ -f "$CRED_VOLUME" ] && [ ! -f "$CRED_BACKUP" ]; then
    # Backup missing — create it
    cp "$CRED_VOLUME" "$CRED_BACKUP"
    chmod 600 "$CRED_BACKUP"
    echo "Claude credentials: created backup from volume."
fi

# Auto-backup credentials every 30 min (catches token refreshes)
(while true; do
    sleep 1800
    if [ -f "$HOME/.claude/.credentials.json" ]; then
        cp "$HOME/.claude/.credentials.json" /workspace/.claude-credentials.json 2>/dev/null
        chmod 600 /workspace/.claude-credentials.json 2>/dev/null
    fi
done) &
disown

# Auto-start Claude Code in a persistent tmux session (enables mobile remote control)
export PATH=$PATH:/usr/local/share/npm-global/bin
if command -v claude &>/dev/null && command -v tmux &>/dev/null && [ -f "$HOME/.claude/.credentials.json" ]; then
    tmux has-session -t claude 2>/dev/null || tmux new-session -d -s claude -c /workspace "claude"
    echo "Claude Code started in tmux session 'claude' (attach with: tmux attach -t claude)"
else
    echo "Claude Code tmux session skipped — not authenticated or tmux missing"
fi

# Backup .env to persistent volume (API keys survive even if workspace bind mount fails)
if [ -f /workspace/.env ]; then
    cp /workspace/.env "$HOME/.claude/.env.backup" 2>/dev/null
elif [ -f "$HOME/.claude/.env.backup" ] && [ ! -f /workspace/.env ]; then
    cp "$HOME/.claude/.env.backup" /workspace/.env
    echo "Restored .env from persistent volume backup."
fi

# Auto-start server only if .env has real credentials (not placeholder values)
if [ -f /workspace/.env ] && ! grep -q "your-key-here\|your-password-here" /workspace/.env; then
    cd /workspace
    nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
    echo "Server starting on port 3000 (logs: /tmp/ai-arena-server.log)"
else
    echo "Server not started — fill in real API keys in /workspace/.env first"
fi
