#!/usr/bin/env bash
# Validates .devcontainer/devcontainer.json for dangerous patterns.
# Used by commit-with-devcontainer-guard.sh (local) and GitHub Actions CI (remote).
# Exit 0 = valid, Exit 1 = invalid (do not commit/merge).

set -euo pipefail

DEVCONTAINER_JSON="${1:-/workspace/.devcontainer/devcontainer.json}"
ERRORS=0
WARNINGS=0

echo "=== Validating devcontainer.json ==="

# 1. Valid JSON
if ! jq empty "$DEVCONTAINER_JSON" 2>/dev/null; then
    echo "ERROR: devcontainer.json is not valid JSON" >&2
    ERRORS=$((ERRORS + 1))
fi

# 2. No --device= flags (dangerous in WSL2 — device paths often don't exist)
DEVICE_FLAGS=$(jq -r '.runArgs[]? // empty' "$DEVCONTAINER_JSON" 2>/dev/null | grep "^--device=" || true)
if [ -n "$DEVICE_FLAGS" ]; then
    echo "ERROR: Dangerous --device= flag(s) detected:" >&2
    echo "  $DEVICE_FLAGS" >&2
    echo "  Tip: For audio in WSL2, use WSLg PulseAudio socket mount instead:" >&2
    echo "  \"source=/mnt/wslg/runtime-dir,target=/mnt/wslg/runtime-dir,type=bind,readonly\"" >&2
    ERRORS=$((ERRORS + 1))
fi

# 3. No --privileged (grants full host access — security risk)
if jq -r '.runArgs[]? // empty' "$DEVCONTAINER_JSON" 2>/dev/null | grep -q "^--privileged"; then
    echo "ERROR: --privileged flag detected — grants full host access!" >&2
    ERRORS=$((ERRORS + 1))
fi

# 4. postStartCommand should have a fallback so container always becomes ready
POST_START=$(jq -r '.postStartCommand // ""' "$DEVCONTAINER_JSON" 2>/dev/null)
if [ -n "$POST_START" ] && ! echo "$POST_START" | grep -qE "\|\| (true|echo|:)"; then
    echo "WARNING: postStartCommand has no fallback (missing '|| true' or '|| echo ...')" >&2
    echo "  If this command fails, the container will appear stuck / not ready." >&2
    echo "  Current value: $POST_START" >&2
    WARNINGS=$((WARNINGS + 1))
fi

# 5. Bind mounts with non-WSLg host paths that likely don't exist
DANGEROUS_MOUNTS=$(jq -r '.mounts[]? // empty' "$DEVCONTAINER_JSON" 2>/dev/null \
    | grep "type=bind" \
    | grep -v "wslg" \
    | grep -v "localWorkspaceFolder" \
    | grep "source=/" || true)
if [ -n "$DANGEROUS_MOUNTS" ]; then
    echo "WARNING: Absolute host path bind mount(s) detected — will fail if path doesn't exist on host:" >&2
    echo "  $DANGEROUS_MOUNTS" >&2
    WARNINGS=$((WARNINGS + 1))
fi

# Summary
if [ $ERRORS -gt 0 ]; then
    echo ""
    echo "FAILED: $ERRORS error(s), $WARNINGS warning(s). Fix errors before committing." >&2
    exit 1
fi

if [ $WARNINGS -gt 0 ]; then
    echo "PASSED with $WARNINGS warning(s). Review warnings above."
else
    echo "PASSED: no issues found."
fi
exit 0
