#!/usr/bin/env bash
# AI Arena — new machine setup
# Run this once on any new Mac/Linux machine or WSL on Windows.
# Sets up SSH key, copies it to Hetzner, writes SSH config, tests connection.

set -euo pipefail

HETZNER_IP="135.181.153.92"
HETZNER_HOST_PORT="22"
CONTAINER_PORT="2222"
CONTAINER_USER="node"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_CONFIG="$HOME/.ssh/config"

echo ""
echo "=== AI Arena — New Machine Setup ==="
echo ""

# Step 1 — SSH key
if [ -f "$SSH_KEY" ]; then
  echo "[ok] SSH key already exists: $SSH_KEY"
else
  echo "[1/4] Generating SSH key..."
  ssh-keygen -t ed25519 -C "ai-arena-dev" -f "$SSH_KEY" -N ""
  echo "[ok] Key generated."
fi

# Step 2 — Copy public key to Hetzner host
echo ""
echo "[2/4] Copying public key to Hetzner host ($HETZNER_IP)..."
echo "      You'll be prompted for the root password once."
echo ""
ssh-copy-id -i "$SSH_KEY.pub" -p "$HETZNER_HOST_PORT" "root@$HETZNER_IP"
echo "[ok] Key added to Hetzner host."

# Step 3 — Write SSH config
echo ""
echo "[3/4] Writing SSH config..."

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

CONFIG_BLOCK="
Host hetzner-container
  HostName $HETZNER_IP
  Port $CONTAINER_PORT
  User $CONTAINER_USER
  IdentityFile $SSH_KEY"

if grep -q "Host hetzner-container" "$SSH_CONFIG" 2>/dev/null; then
  echo "[ok] SSH config entry already exists — skipping."
else
  echo "$CONFIG_BLOCK" >> "$SSH_CONFIG"
  chmod 600 "$SSH_CONFIG"
  echo "[ok] SSH config written."
fi

# Step 4 — Test connection
echo ""
echo "[4/4] Testing connection to container..."
if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new hetzner-container "echo ok" 2>/dev/null | grep -q "ok"; then
  echo "[ok] Connected successfully."
else
  echo "[!] Connection failed — make sure the container is running on Hetzner."
  exit 1
fi

echo ""
echo "================================================"
echo " Done! Connect with:  ssh hetzner-container"
echo " Or open VS Code → Remote SSH → hetzner-container"
echo ""
echo " First time only: fill in API keys on the server:"
echo "   nano /workspace/.env"
echo ""
echo " Keys needed (copy from Railway dashboard → Variables):"
echo "   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, APP_PASSWORD"
echo "================================================"
echo ""
