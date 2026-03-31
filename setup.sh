#!/bin/bash
# Quick local setup (non-container). In a dev container, post-create.sh handles this.
echo "=== AI Arena Setup ==="

if [ "${DEVCONTAINER:-}" = "true" ]; then
  [ -d node_modules ] && echo "Dependencies: OK" || npm install
  [ -f .env ] && echo ".env: OK" || echo "Create .env from .env.example and add your API keys."
  echo "Run: npm start"
  exit 0
fi

if ! command -v node &>/dev/null; then
  echo "Node.js not found — install LTS from https://nodejs.org"
  exit 1
fi
echo "Node.js $(node -v)"

[ -d node_modules ] && echo "Dependencies: OK" || { echo "Installing..."; npm install; }
[ -f .env ] || echo "WARNING: .env missing — copy from .env.example and add your keys."

echo ""
echo "Ready! Run: npm start"
