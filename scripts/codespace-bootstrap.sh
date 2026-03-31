#!/usr/bin/env bash
# Codespace bootstrap: install deps, create .env, start the server.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

git pull --ff-only 2>/dev/null || true
npm install

# Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "[codespace] Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code
fi

# Puppeteer MCP server
if [ ! -f /usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/dist/index.js ]; then
  echo "[codespace] Installing Puppeteer MCP server..."
  PUPPETEER_SKIP_DOWNLOAD=true npm install -g @modelcontextprotocol/server-puppeteer
  node /usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer/install.mjs 2>/dev/null || true
fi

# .env from Codespace secrets or from .env.example
if [ ! -f .env ] || [ ! -s .env ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${GOOGLE_API_KEY:-}" ]; then
    : > .env
    [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" >> .env
    [ -n "${OPENAI_API_KEY:-}" ]    && echo "OPENAI_API_KEY=$OPENAI_API_KEY"       >> .env
    [ -n "${GOOGLE_API_KEY:-}" ]    && echo "GOOGLE_API_KEY=$GOOGLE_API_KEY"       >> .env
    [ -n "${APP_PASSWORD:-}" ]      && echo "APP_PASSWORD=$APP_PASSWORD"           >> .env
    [ -n "${PORT:-}" ]              && echo "PORT=$PORT"                           >> .env
    echo "[codespace] .env written from secrets."
  elif [ -f .env.example ]; then
    cp .env.example .env
    echo "[codespace] .env created from .env.example — add your keys."
  fi
fi

# Start server if port is free
PORT="${PORT:-3000}"
if ! (echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
  nohup npm start >> /tmp/ai-arena.log 2>&1 &
  disown 2>/dev/null || true
  echo "[codespace] AI Arena starting on port $PORT (log: /tmp/ai-arena.log)"
else
  echo "[codespace] Port $PORT in use — server already running."
fi
