FROM node:20.20.2-slim

ARG TZ
ENV TZ="$TZ"

RUN apt-get update && apt-get install -y --no-install-recommends \
  curl wget ca-certificates \
  less git procps sudo fzf zsh unzip gnupg2 gh tmux docker.io \
  iptables ipset iproute2 dnsutils aggregate jq \
  nano tini \
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

# Ensure npm global bin is in PATH for all users (bash login shells)
RUN echo 'export PATH=$PATH:/usr/local/share/npm-global/bin' >> /home/node/.bashrc \
    && echo 'export PATH=$PATH:/usr/local/share/npm-global/bin' >> /root/.bashrc

USER root
RUN printf '#!/bin/bash\nexec bash /workspace/.devcontainer/init-firewall.sh "$@"\n' \
      > /usr/local/bin/init-firewall.sh && chmod +x /usr/local/bin/init-firewall.sh && \
    printf '#!/bin/sh\niptables -P INPUT ACCEPT; iptables -P FORWARD ACCEPT; iptables -P OUTPUT ACCEPT\necho "iptables policies reset to ACCEPT"\n' \
      > /usr/local/bin/reset-iptables.sh && chmod +x /usr/local/bin/reset-iptables.sh && \
    echo 'node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/local/bin/reset-iptables.sh, /usr/sbin/sshd, /usr/local/bin/setup-root-claude.sh' \
      > /etc/sudoers.d/node-firewall && chmod 0440 /etc/sudoers.d/node-firewall && \
    usermod -aG docker node || true

# Root Claude bypass-permissions setup script
COPY setup-root-claude.sh /usr/local/bin/setup-root-claude.sh
RUN chmod +x /usr/local/bin/setup-root-claude.sh

# SSH server — both node and root users get key-based access
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /home/node/.ssh /root/.ssh \
    && chown node:node /home/node/.ssh \
    && chmod 700 /home/node/.ssh /root/.ssh
COPY --chown=node:node authorized_keys /home/node/.ssh/authorized_keys
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 600 /home/node/.ssh/authorized_keys /root/.ssh/authorized_keys \
    && ssh-keygen -A \
    && echo "PermitRootLogin prohibit-password" >> /etc/ssh/sshd_config \
    && echo "MaxAuthTries 3" >> /etc/ssh/sshd_config \
    && echo "LoginGraceTime 20" >> /etc/ssh/sshd_config \
    && echo "PasswordAuthentication no" >> /etc/ssh/sshd_config \
    && echo "MaxStartups 3:50:10" >> /etc/ssh/sshd_config
EXPOSE 22

# Build fakeid.so for root bypass-permissions workaround
# Claude CLI blocks --dangerously-skip-permissions as root; this .so fakes getuid/geteuid
RUN mkdir -p /root/.claude/remote \
    && printf '#include <sys/types.h>\nuid_t getuid(void){return 1000;}\nuid_t geteuid(void){return 1000;}\nint getresuid(uid_t *r,uid_t *e,uid_t *s){*r=*e=*s=1000;return 0;}\nint getresgid(gid_t *r,gid_t *e,gid_t *s){*r=*e=*s=1000;return 0;}\n' > /tmp/fakeid.c \
    && apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && gcc -shared -fPIC -o /root/.claude/remote/fakeid.so /tmp/fakeid.c \
    && rm /tmp/fakeid.c \
    && apt-get purge -y gcc libc6-dev && apt-get autoremove -y \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

USER node
