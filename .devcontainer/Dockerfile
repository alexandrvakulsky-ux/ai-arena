FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  wget \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  # Chrome/Puppeteer system dependencies
  libnspr4 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libx11-6 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libatspi2.0-0 \
  # Voice / PulseAudio (for Claude Code voice input via WSLg)
  libpulse0 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history
RUN mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

ENV DEVCONTAINER=true

# Create workspace and config directories
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/zsh
ENV EDITOR=nano
ENV VISUAL=nano

ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Claude Code CLI (same pattern as https://github.com/anthropics/claude-code/tree/main/.devcontainer)
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Puppeteer MCP server (screenshot/visual verification for Claude Code)
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install -g @modelcontextprotocol/server-puppeteer && \
    node /usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer/install.mjs

USER root
# Passwordless sudo only for these exact paths (not raw `iptables` — that would prompt for node’s password, which is usually unset).
RUN printf '%s\n' \
  '#!/bin/sh' \
  'iptables -P INPUT ACCEPT 2>/dev/null || true' \
  'iptables -P FORWARD ACCEPT 2>/dev/null || true' \
  'iptables -P OUTPUT ACCEPT 2>/dev/null || true' \
  'echo "iptables: INPUT/FORWARD/OUTPUT default policies -> ACCEPT"' \
  > /usr/local/bin/reset-iptables-policies.sh && \
  chmod +x /usr/local/bin/reset-iptables-policies.sh && \
  printf '#!/bin/bash\nexec bash /workspace/.devcontainer/init-firewall.sh "$@"\n' > /usr/local/bin/init-firewall.sh && \
  chmod +x /usr/local/bin/init-firewall.sh && \
  printf '%s\n' \
  'node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/local/bin/reset-iptables-policies.sh' \
  > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall
USER node
