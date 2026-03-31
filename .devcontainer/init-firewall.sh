#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

# Avoid locale spam in logs when en_US.UTF-8 isn't generated in the image
export LC_ALL=C
export LANG=C

# Cache resolved IPs on the persistent volume — avoids re-fetching on every container start.
# Cache is invalidated after 24 hours so IPs stay reasonably fresh.
CACHE_FILE="/home/node/.claude/.firewall-cache"
CACHE_MAX_AGE=86400  # seconds

# Block all IPv6 — flush any stale rules first, then set DROP policies
ip6tables -F 2>/dev/null || true
ip6tables -X 2>/dev/null || true
ip6tables -P INPUT   DROP
ip6tables -P OUTPUT  DROP
ip6tables -P FORWARD DROP

# Extract Docker DNS rules BEFORE flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# Critical: flush does NOT reset default policies. A prior run (or Ctrl+C mid-script)
# may have left OUTPUT DROP with no rules → all traffic blocked, GitHub curl times out.
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT

# Restore Docker internal DNS
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# DNS: allow any resolver listed in /etc/resolv.conf (not only 127.0.0.11).
# Docker Desktop / WSL / some hosts use the gateway or public DNS; locking DNS to
# 127.0.0.11 only causes getaddrinfo timeouts (EAI_AGAIN) and breaks Claude Code.
# Matches the pattern in https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -m state --state ESTABLISHED -j ACCEPT
# NOTE: No blanket SSH outbound rule — git-over-SSH to GitHub is covered by the GitHub ipset below
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# ── IP allowlist ──────────────────────────────────────────────────────────────

resolve_domain() {
    local domain="$1"
    local ips
    ips=$(dig +time=5 +tries=2 +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        return 1
    fi
    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            return 1
        fi
        ipset add -exist allowed-domains "$ip"
    done < <(echo "$ips")
}

# Resolve a domain in the background. Writes domain name to $FAIL_FILE on fatal failure.
# Call after setting FAIL_FILE=$(mktemp); collect results with wait_domains.
_resolve_async() {
    local domain="$1" fatal="$2"
    if resolve_domain "$domain"; then
        echo "  ✓ $domain"
    elif $fatal; then
        echo "$domain" >> "$FAIL_FILE"
        echo "  ✗ $domain (required — failed)"
    else
        echo "  WARNING: $domain (non-critical — skipping)"
    fi
}

# Wait for all background resolution jobs and exit if any required domain failed.
wait_domains() {
    wait
    if [ -s "$FAIL_FILE" ]; then
        echo "ERROR: Failed to resolve required domains:"
        sed 's/^/  - /' "$FAIL_FILE"
        rm -f "$FAIL_FILE"
        exit 1
    fi
    rm -f "$FAIL_FILE"
}

# Check if a valid cache exists
USE_CACHE=false
if [ -f "$CACHE_FILE" ]; then
    CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE") ))
    if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
        USE_CACHE=true
        echo "Using cached IP allowlist (age: $(( CACHE_AGE / 3600 ))h $(( (CACHE_AGE % 3600) / 60 ))m — refreshes every 24h)"
    else
        echo "IP cache expired — refreshing..."
    fi
fi

if $USE_CACHE; then
    ipset restore -! < "$CACHE_FILE"
else
    ipset create allowed-domains hash:net

    # GitHub IP ranges
    echo "Fetching GitHub IP ranges..."
    gh_ranges=$(curl -fsS --connect-timeout 20 --max-time 90 https://api.github.com/meta)
    if [ -z "$gh_ranges" ]; then
        echo "ERROR: Failed to fetch GitHub IP ranges"
        exit 1
    fi
    if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
        echo "ERROR: GitHub API response missing required fields"
        exit 1
    fi
    gh_count=0
    while read -r cidr; do
        if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            echo "ERROR: Invalid CIDR from GitHub meta: $cidr"
            exit 1
        fi
        ipset add allowed-domains "$cidr"
        (( gh_count++ )) || true
    done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)
    echo "  GitHub: $gh_count ranges"

    # Resolve all domains in parallel — reduces cold-start time from ~30s to ~3s
    echo "Resolving domains (parallel)..."
    FAIL_FILE=$(mktemp)
    _resolve_async "registry.npmjs.org"              true  &
    _resolve_async "api.anthropic.com"               true  &
    _resolve_async "console.anthropic.com"           true  &
    _resolve_async "claude.ai"                       true  &
    _resolve_async "www.claude.ai"                   true  &
    _resolve_async "statsig.anthropic.com"           true  &
    _resolve_async "api.openai.com"                  true  &
    _resolve_async "generativelanguage.googleapis.com" true &
    _resolve_async "marketplace.visualstudio.com"    true  &
    _resolve_async "vscode.blob.core.windows.net"    true  &
    _resolve_async "update.code.visualstudio.com"    true  &
    _resolve_async "open-vsx.org"                    true  &
    _resolve_async "api2.cursor.sh"                  true  &
    _resolve_async "authenticate.cursor.sh"          true  &
    _resolve_async "authenticator.cursor.sh"         true  &
    _resolve_async "marketplace.cursorapi.com"       true  &
    _resolve_async "sentry.io"                       false &
    _resolve_async "statsig.com"                     false &
    # Chrome/Puppeteer download domains (needed for MCP screenshot server install)
    _resolve_async "storage.googleapis.com"          false &
    _resolve_async "googlechromelabs.github.io"      false &
    _resolve_async "edgedl.me.gvt1.com"              false &
    wait_domains

    # Save for next start
    ipset save allowed-domains > "$CACHE_FILE"
    echo "Allowlist cached → next start will be faster."
fi

# ── Finalize rules ────────────────────────────────────────────────────────────

# Host gateway only (not the whole /24 subnet)
HOST_IP=$(ip route show default | awk 'NR==1{print $3}')
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host gateway IP"
    exit 1
fi
echo "Host gateway: $HOST_IP"
iptables -A INPUT  -s "$HOST_IP" -j ACCEPT
iptables -A OUTPUT -d "$HOST_IP" -j ACCEPT

# Default DROP policies
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

# Allow established connections
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow only whitelisted outbound
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Reject everything else with a clear error (vs silent DROP)
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# ── Verify ────────────────────────────────────────────────────────────────────

echo "Verifying..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall failed — reached https://example.com"
    exit 1
else
    echo "PASS: Cannot reach https://example.com (blocked as expected)"
fi
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall failed — cannot reach https://api.github.com"
    exit 1
else
    echo "PASS: Can reach https://api.github.com"
fi
if ! curl --connect-timeout 5 -o /dev/null -w "%{http_code}" -H "x-api-key: test" https://api.anthropic.com/v1/models 2>/dev/null | grep -qE "^(200|401|403)$"; then
    echo "ERROR: Firewall failed — cannot reach https://api.anthropic.com"
    exit 1
else
    echo "PASS: Can reach https://api.anthropic.com"
fi

echo "Firewall ready."
