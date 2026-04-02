FROM node:20-slim

ARG TZ
ENV TZ="$TZ"

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl wget ca-certificates \
  less git procps sudo fzf zsh unzip gnupg2 gh \
  iptables ipset iproute2 dnsutils aggregate jq \
  nano \
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libdbus-1-3 libxkbcommon0 libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxrandr2 libgbm1 libasound2 libatspi2.0-0 \
  libpango-1.0-0 libcairo2 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/share/npm-global /commandhistory /workspace /home/node/.claude /home/node/.cache/puppeteer && \
  touch /commandhistory/.bash_history && \
  chown -R node:node /usr/local/share/npm-global /commandhistory /workspace /home/node/.claude /home/node/.cache/puppeteer

ENV DEVCONTAINER=true

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
ENV SHELL=/bin/zsh
ENV EDITOR=nano
ENV VISUAL=nano

ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

ARG CLAUDE_CODE_VERSION=latest
RUN PUPPETEER_SKIP_DOWNLOAD=true \
  npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    @modelcontextprotocol/server-puppeteer

USER root
RUN printf '#!/bin/bash\nexec bash /workspace/.devcontainer/init-firewall.sh "$@"\n' \
      > /usr/local/bin/init-firewall.sh && chmod +x /usr/local/bin/init-firewall.sh && \
    printf '#!/bin/sh\niptables -P INPUT ACCEPT; iptables -P FORWARD ACCEPT; iptables -P OUTPUT ACCEPT\necho "iptables policies reset to ACCEPT"\n' \
      > /usr/local/bin/reset-iptables.sh && chmod +x /usr/local/bin/reset-iptables.sh && \
    echo 'node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/local/bin/reset-iptables.sh, /usr/sbin/sshd' \
      > /etc/sudoers.d/node-firewall && chmod 0440 /etc/sudoers.d/node-firewall

# SSH server
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /home/node/.ssh \
    && chown node:node /home/node/.ssh \
    && chmod 700 /home/node/.ssh
COPY --chown=node:node authorized_keys /home/node/.ssh/authorized_keys
RUN chmod 600 /home/node/.ssh/authorized_keys && ssh-keygen -A
EXPOSE 22

USER node
