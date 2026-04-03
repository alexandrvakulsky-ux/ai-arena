#!/bin/bash
set -euo pipefail
export LC_ALL=C LANG=C

echo "=== Configuring egress firewall ==="

# ── IPv6: block everything (we only allowlist IPv4) ──
# Some container runtimes / WSL2 kernels lack ip6tables — every command must be safe to fail.
ip6tables -F 2>/dev/null || true
ip6tables -X 2>/dev/null || true
ip6tables -P INPUT   DROP 2>/dev/null || true
ip6tables -P OUTPUT  DROP 2>/dev/null || true
ip6tables -P FORWARD DROP 2>/dev/null || true

# ── IPv4: save Docker DNS NAT rules, then flush everything ──
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
iptables -t mangle -F; iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# Start open — Ctrl+C mid-script won't leave a locked-out container
iptables -P INPUT ACCEPT; iptables -P FORWARD ACCEPT; iptables -P OUTPUT ACCEPT

# Restore Docker DNS NAT
if [ -n "$DOCKER_DNS_RULES" ]; then
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    while IFS= read -r rule; do
        [ -n "$rule" ] && iptables -t nat $rule 2>/dev/null || true
    done <<< "$DOCKER_DNS_RULES"
fi

# DNS + loopback (allow any resolver — Docker Desktop, WSL, etc.)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -m state --state ESTABLISHED -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# ── Build IP allowlist ──
ipset create allowed-domains hash:net

# GitHub CIDR ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -fsS --connect-timeout 15 --max-time 60 https://api.github.com/meta) || {
    echo "ERROR: Cannot reach api.github.com — check network/VPN"; exit 1
}
echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null || {
    echo "ERROR: Unexpected GitHub API response"; exit 1
}
while read -r cidr; do
    ipset add allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# Resolve individual domains (parallel for speed)
REQUIRED_DOMAINS=(
    # npm
    registry.npmjs.org
    # Anthropic (API + auth + telemetry)
    api.anthropic.com console.anthropic.com claude.ai www.claude.ai statsig.anthropic.com
    # OpenAI
    api.openai.com
    # Google / Gemini
    generativelanguage.googleapis.com
    # VS Code / Cursor extensions + updates
    marketplace.visualstudio.com vscode.blob.core.windows.net update.code.visualstudio.com
    open-vsx.org api2.cursor.sh authenticate.cursor.sh authenticator.cursor.sh marketplace.cursorapi.com
    # Chrome/Puppeteer downloads (MCP screenshot server)
    storage.googleapis.com googlechromelabs.github.io edgedl.me.gvt1.com
    # AI Arena production (Railway)
    ai-arena-production-92e7.up.railway.app
)
OPTIONAL_DOMAINS=(sentry.io statsig.com)

resolve_domain() {
    local domain="$1"
    dig +time=5 +tries=2 +noall +answer A "$domain" \
      | awk '$4=="A"{print $5}' \
      | while read -r ip; do ipset add -exist allowed-domains "$ip"; done
}

echo "Resolving domains..."
for d in "${REQUIRED_DOMAINS[@]}"; do resolve_domain "$d" & done
for d in "${OPTIONAL_DOMAINS[@]}"; do (resolve_domain "$d" || true) & done
wait

# Verify critical domains actually resolved
FAIL=""
for d in api.anthropic.com api.openai.com registry.npmjs.org; do
    if ! dig +short +time=3 A "$d" | grep -qE '^[0-9]'; then
        FAIL="$FAIL $d"
    fi
done
if [ -n "$FAIL" ]; then
    echo "WARNING: Could not resolve:$FAIL — those APIs may not work"
fi

# Host gateway
HOST_IP=$(ip route show default | awk 'NR==1{print $3}')
[ -z "$HOST_IP" ] && { echo "ERROR: No default gateway"; exit 1; }
iptables -A INPUT  -s "$HOST_IP" -j ACCEPT
iptables -A OUTPUT -d "$HOST_IP" -j ACCEPT

# ── Lock down ──
iptables -P INPUT DROP; iptables -P FORWARD DROP; iptables -P OUTPUT DROP
iptables -A INPUT  -p tcp --dport 22 -j ACCEPT
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# ── Smoke test ──
echo "Verifying..."
curl -s --connect-timeout 5 https://example.com >/dev/null 2>&1 \
    && { echo "FAIL: reached example.com (should be blocked)"; exit 1; } \
    || echo "  OK: example.com blocked"
curl -fsS --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1 \
    && echo "  OK: api.github.com reachable" \
    || { echo "FAIL: cannot reach api.github.com"; exit 1; }

echo "=== Firewall ready ==="
