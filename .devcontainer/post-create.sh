#!/usr/bin/env bash
# Runs once after the dev container is created.
# Claude Code CLI + Puppeteer MCP are in the image; this installs the app's own deps.
set -euo pipefail
cd /workspace

echo "=== Installing AI Arena dependencies ==="
npm install

# Chrome for Puppeteer MCP — cached in a Docker volume, only downloads once
PUPPETEER_INSTALL="$(npm root -g)/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer/install.mjs"
if [ ! -d "$HOME/.cache/puppeteer/chrome" ] && [ -f "$PUPPETEER_INSTALL" ]; then
    echo "Downloading Chrome for Puppeteer (first time only)..."
    node "$PUPPETEER_INSTALL"
else
    echo "Chrome: cached"
fi

# .env from example on first run
if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example — fill in your API keys."
fi

# Restore Claude Code credentials from backup (survives container rebuilds)
if [ ! -f "$HOME/.claude/.credentials.json" ] && [ -f /workspace/.claude-credentials.json ]; then
    cp /workspace/.claude-credentials.json "$HOME/.claude/.credentials.json"
    chmod 600 "$HOME/.claude/.credentials.json"
    echo "Claude Code credentials restored from backup."
fi

# claude-sync: clone config repo into ~/.claude on first run (needs SSH key)
# Volume mount creates the directory — clone only if it's empty (no .git yet)
if [ ! -d "$HOME/.claude/.git" ]; then
    echo ""
    git clone --depth 1 git@github.com:alexandrvakulsky-ux/claude-sync.git "$HOME/.claude" 2>/dev/null \
        && echo "Claude config synced from GitHub." \
        || echo "Note: claude-sync skipped (SSH key not set up). Run manually later:"$'\n'"  git clone git@github.com:alexandrvakulsky-ux/claude-sync.git ~/.claude"
fi

# Setup global Claude config (~/.claude/skills, agents, scripts)
# Runs after claude-sync so it only fills gaps — never overwrites existing files.
echo "=== Setting up global Claude config ==="

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/scripts" "$HOME/.claude/agents"

# Clone skill repos (skip if already present)
for repo in \
    "https://github.com/anthropics/skills anthropics-skills" \
    "https://github.com/obra/superpowers superpowers" \
    "https://github.com/vercel-labs/agent-skills vercel-skills" \
    "https://github.com/alirezarezvani/claude-skills alirezarezvani-skills" \
    "https://github.com/mastepanoski/claude-skills mastepanoski-skills"; do
    url=$(echo "$repo" | cut -d' ' -f1)
    dir=$(echo "$repo" | cut -d' ' -f2)
    if [ ! -d "$HOME/.claude/skills/$dir" ]; then
        git clone --depth 1 "$url" "$HOME/.claude/skills/$dir" 2>/dev/null \
            && echo "  [ok] cloned $dir" \
            || echo "  [!] failed to clone $dir (no network?)"
    else
        echo "  [ok] $dir already present"
    fi
done

# Copy flat skill files from repos (only if not already there)
copy_skill() {
    local src="$1" dst="$HOME/.claude/skills/$(basename $src .md 2>/dev/null || basename $src)"
    [ -f "$dst" ] || cp "$src" "$dst"
}

# anthropics
for f in "$HOME/.claude/skills/anthropics-skills/skills"/*/SKILL.md; do
    name=$(basename "$(dirname "$f")")
    [ -f "$HOME/.claude/skills/${name}.md" ] || cp "$f" "$HOME/.claude/skills/${name}.md"
done
# vercel
for f in "$HOME/.claude/skills/vercel-skills/skills/web-design-guidelines/SKILL.md"; do
    [ -f "$HOME/.claude/skills/web-design-guidelines.md" ] || cp "$f" "$HOME/.claude/skills/web-design-guidelines.md"
done
# alirezarezvani engineering
for name in focused-fix api-design-reviewer env-secrets-manager performance-profiler \
            observability-designer dependency-auditor codebase-onboarding pr-review-expert; do
    f="$HOME/.claude/skills/alirezarezvani-skills/engineering/${name}/SKILL.md"
    [ -f "$HOME/.claude/skills/${name}.md" ] || { [ -f "$f" ] && cp "$f" "$HOME/.claude/skills/${name}.md"; }
done
# mastepanoski
for name in ui-design-review nielsen-heuristics-audit wcag-accessibility-audit owasp-llm-top10; do
    f="$HOME/.claude/skills/mastepanoski-skills/skills/${name}/SKILL.md"
    [ -f "$HOME/.claude/skills/${name}.md" ] || { [ -f "$f" ] && cp "$f" "$HOME/.claude/skills/${name}.md"; }
done
# superpowers
for name in brainstorming systematic-debugging verification-before-completion \
            test-driven-development subagent-driven-development; do
    f="$HOME/.claude/skills/superpowers/skills/${name}/SKILL.md"
    [ -f "$HOME/.claude/skills/${name}.md" ] || { [ -f "$f" ] && cp "$f" "$HOME/.claude/skills/${name}.md"; }
done

# Copy custom skills, scripts, agents from workspace backup (never overwrite)
for f in /workspace/.devcontainer/global-claude/skills/*.md; do
    dst="$HOME/.claude/skills/$(basename $f)"
    [ -f "$dst" ] || cp "$f" "$dst"
done
for f in /workspace/.devcontainer/global-claude/scripts/*.js; do
    dst="$HOME/.claude/scripts/$(basename $f)"
    [ -f "$dst" ] || cp "$f" "$dst"
done
for f in /workspace/.devcontainer/global-claude/agents/*.md; do
    dst="$HOME/.claude/agents/$(basename $f)"
    [ -f "$dst" ] || cp "$f" "$dst"
done

# Copy global CLAUDE.md and settings.json only if claude-sync didn't provide them
[ -f "$HOME/.claude/CLAUDE.md" ] || cp /workspace/.devcontainer/global-claude/CLAUDE.md "$HOME/.claude/CLAUDE.md"
[ -f "$HOME/.claude/settings.json" ] || cp /workspace/.devcontainer/global-claude/settings.json "$HOME/.claude/settings.json"

skill_count=$(ls "$HOME/.claude/skills/"*.md 2>/dev/null | wc -l)
echo "  [ok] $skill_count skills ready in ~/.claude/skills/"

# Load app API keys into shell — but unset ANTHROPIC_API_KEY so Claude CLI
# continues to use OAuth (.credentials.json) instead of falling back to API-key mode.
# server.js loads ANTHROPIC_API_KEY via dotenv directly from .env, so it never
# needs it in the shell environment.
if ! grep -q 'workspace/.env' "$HOME/.zshrc" 2>/dev/null; then
    echo '[ -f /workspace/.env ] && set -a && . /workspace/.env && set +a && unset ANTHROPIC_API_KEY' >> "$HOME/.zshrc"
fi

echo ""
echo "================================================"
echo " Setup status"
echo "================================================"

# Check each required .env key for placeholder or missing values
MISSING=0
for key in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY APP_PASSWORD; do
    val=$(grep "^${key}=" .env 2>/dev/null | cut -d= -f2- || true)
    if [ -z "$val" ] || echo "$val" | grep -qi 'your\|-here\|placeholder\|example'; then
        echo "  [!] .env: $key — needs a real value"
        MISSING=$((MISSING + 1))
    fi
done
if [ "$MISSING" -eq 0 ]; then
    echo "  [ok] .env — all keys set"
else
    echo "      -> Edit /workspace/.env"
fi

# Check Claude Code credentials
if [ -f "$HOME/.claude/.credentials.json" ]; then
    echo "  [ok] Claude Code — authenticated"
else
    echo "  [!] Claude Code — not logged in"
    echo "      -> Run: claude auth login"
fi

echo "================================================"
echo ""
echo "  npm start  — run the app on port 3000"
echo "  claude     — Claude Code CLI"
echo ""
