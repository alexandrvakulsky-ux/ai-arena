#!/bin/bash
# PreToolUse hook — blocks git push/commit, docker cp/rm/restart, rm -rf, etc.
# unless project docs were consulted in the current session.
#
# Purpose: catch "I assumed X" bugs. Today's example (2026-04-17): assumed
# ad-spy had no git repo because /srv/ad-spy wasn't a repo on the host. The
# repo was inside the container at /workspace. Would have been caught by
# reading CONTAINER-OPS.md before committing to ai-arena.
#
# Allowlist: if transcript contains any recent reference to project docs OR
# the user has acknowledged the command, the hook allows it.

set -e

INPUT=$(cat)

# Only care about Bash commands
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
if [ "$TOOL" != "Bash" ]; then exit 0; fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# Destructive patterns to gate
if ! echo "$CMD" | grep -qE '(git[[:space:]]+(push|commit|reset[[:space:]]+--hard|rebase[[:space:]]+|branch[[:space:]]+-D|checkout[[:space:]]+--)|docker[[:space:]]+(cp|rm|restart|stop|kill)|rm[[:space:]]+-rf?[[:space:]]+/[^t])'; then
  exit 0
fi

# Check transcript for evidence docs were consulted (broad — any recent mention
# of doc files, remote URLs, or explicit checks counts).
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  if tail -c 80000 "$TRANSCRIPT" 2>/dev/null | grep -qE '(CONTAINER-OPS\.md|\.claude/rules/|\.claude/CLAUDE\.md|git remote -v|git ls-remote|git config --get remote|git status)'; then
    exit 0
  fi
fi

# Block with context
TARGET=$(echo "$CMD" | grep -oE '(git[[:space:]]+\w+|docker[[:space:]]+\w+|rm[[:space:]]+\S+)' | head -1)

cat >&2 <<EOF
🛑 DESTRUCTIVE OPERATION BLOCKED

About to run: $CMD

You have not consulted project documentation in this session. Before committing, pushing, restarting containers, or removing files, verify:

  1. Which repo/container you're targeting. Run:
       git remote -v              (if committing/pushing)
       docker ps                  (if docker cp/restart)

  2. Project rules that may apply:
       cat /workspace/.claude/CLAUDE.md
       cat /workspace/.claude/CONTAINER-OPS.md
       ls /workspace/.claude/rules/

  3. For ad-spy specifically: its repo lives INSIDE the container at /workspace,
     not on the host. Commit with:
       docker exec ad-spy sh -c 'cd /workspace && git ...'

Read the relevant docs (or run 'git remote -v' to verify target), then retry.

If this is a false positive, the operation is safe to retry: after reading any
doc file in a PreToolUse/Read event, the hook will allow the next attempt.
EOF
exit 2
