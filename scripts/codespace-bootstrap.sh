#!/usr/bin/env bash
# Runs when the Codespace container starts: deps, .env, background server.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$PATH"

git pull --ff-only 2>/dev/null || true
npm install

# Install Puppeteer MCP server if not already installed
if [[ ! -f /usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/dist/index.js ]]; then
  echo "[bootstrap] Installing Puppeteer MCP server..."
  PUPPETEER_SKIP_DOWNLOAD=true npm install -g @modelcontextprotocol/server-puppeteer
  node /usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer/install.mjs 2>/dev/null || true
fi

# Create Puppeteer MCP config if missing
MCP_JSON="$HOME/.claude/mcp.json"
if [[ ! -f "$MCP_JSON" ]]; then
  CHROME_PATH=$(ls "$HOME/.cache/puppeteer/chrome/linux-"*/chrome-linux64/chrome 2>/dev/null | head -1 || true)
  if [[ -n "$CHROME_PATH" ]]; then
    echo "[bootstrap] Creating ~/.claude/mcp.json with Puppeteer server..."
    cat > "$MCP_JSON" <<EOF
{
  "mcpServers": {
    "puppeteer": {
      "command": "node",
      "args": ["/usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/dist/index.js"],
      "env": {
        "PUPPETEER_EXECUTABLE_PATH": "$CHROME_PATH",
        "PUPPETEER_LAUNCH_OPTIONS": "{\"headless\":true,\"args\":[\"--no-sandbox\",\"--disable-setuid-sandbox\",\"--disable-dev-shm-usage\"]}"
      }
    }
  }
}
EOF
  fi
fi

# Codespaces without this repo’s Dockerfile still get a working Claude CLI
if ! command -v claude &>/dev/null; then
  echo "[codespace] Installing Claude Code CLI (global)…"
  npm install -g @anthropic-ai/claude-code
fi

ensure_env() {
  if [[ -f .env && -s .env ]]; then
    return 0
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" || -n "${OPENAI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" ]]; then
    : > .env
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" >> .env
    [[ -n "${OPENAI_API_KEY:-}" ]] && printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> .env
    [[ -n "${GOOGLE_API_KEY:-}" ]] && printf 'GOOGLE_API_KEY=%s\n' "$GOOGLE_API_KEY" >> .env
    [[ -n "${PORT:-}" ]] && printf 'PORT=%s\n' "$PORT" >> .env
    [[ -n "${APP_PASSWORD:-}" ]] && printf 'APP_PASSWORD=%s\n' "$APP_PASSWORD" >> .env
    echo "[codespace] Wrote .env from environment (Codespaces secrets)."
    return 0
  fi
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "[codespace] Created .env from .env.example — add keys or set Codespaces secrets."
  fi
}

port_in_use() {
  local p="${1:?}"
  (echo >/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1
}

ensure_env

if port_in_use "${PORT:-3000}"; then
  echo "[codespace] Port ${PORT:-3000} already in use — leaving server as-is."
  exit 0
fi

nohup npm start >> /tmp/ai-arena-server.log 2>&1 &
disown 2>/dev/null || true
echo "[codespace] AI Arena starting on port ${PORT:-3000} (log: /tmp/ai-arena-server.log)"
