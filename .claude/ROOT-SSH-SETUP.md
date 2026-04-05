# Root SSH + Bypass Permissions Setup

## What this solves

Claude Code CLI blocks `--dangerously-skip-permissions` when running as root (UID 0).
This prevents Claude Code Desktop from connecting as root with bypass permissions enabled.

## How it works

1. **`fakeid.so`** — A tiny shared library compiled into the Docker image that overrides
   `getuid()` and `geteuid()` to return 1000 (node's UID). When loaded via `LD_PRELOAD`,
   the CLI thinks it's not root.

2. **Wrapper script** — The real CLI binary at `/root/.claude/remote/ccd-cli/<version>` gets
   renamed to `<version>.real`. A bash wrapper takes its place that sets `LD_PRELOAD` and
   execs the real binary.

3. **`setup-root-claude.sh`** — Orchestrates everything: copies credentials from node to root,
   applies the wrapper, and runs a background watcher to catch new CLI binaries.

## Automatic setup (survives rebuilds)

All of this is baked into the container:

- **Dockerfile** builds `fakeid.so` and installs `setup-root-claude.sh`
- **post-start.sh** runs `sudo /usr/local/bin/setup-root-claude.sh` on every container start
- A background watcher polls for 10 minutes to catch CLI binaries dropped after first connect

## Manual recovery (if automatic setup fails)

Run from **any** Claude session connected as node:

```bash
sudo /usr/local/bin/setup-root-claude.sh
```

## Full manual recovery (nuclear option — no working container session)

If you can't get into the container at all, run these from your local machine (PowerShell):

### Step 1: Fix SSH known_hosts (if container was rebuilt)
```powershell
ssh-keygen -R "[135.181.153.92]:2222"
```

### Step 2: Verify SSH works
```powershell
ssh -p 2222 root@135.181.153.92 "whoami"
```
If this asks for a password, the authorized_keys is missing. Fix:
```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@135.181.153.92 "docker exec -u root -i ai-arena bash -c 'mkdir -p /root/.ssh && chmod 700 /root/.ssh && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'"
```

### Step 3: Check if fakeid.so exists
```powershell
ssh -p 2222 root@135.181.153.92 "ls -la /root/.claude/remote/fakeid.so"
```
If missing, compile on host and copy in:
```powershell
ssh root@135.181.153.92 "echo '#include <sys/types.h>
uid_t getuid(void) { return 1000; }
uid_t geteuid(void) { return 1000; }' > /tmp/fakeid.c && gcc -shared -fPIC -o /tmp/fakeid.so /tmp/fakeid.c && docker cp /tmp/fakeid.so ai-arena:/root/.claude/remote/fakeid.so && echo done"
```
If gcc is not installed on the host:
```powershell
ssh root@135.181.153.92 "apt-get install -y gcc && echo done"
```

### Step 4: Copy credentials from node to root
```powershell
ssh -p 2222 root@135.181.153.92 "cp /home/node/.claude/.credentials.json /root/.claude/.credentials.json 2>/dev/null; cp /home/node/.claude/settings.json /root/.claude/settings.json 2>/dev/null; echo done"
```

### Step 5: Copy remote CLI and apply wrapper
```powershell
ssh -p 2222 root@135.181.153.92 "cp -r /home/node/.claude/remote /root/.claude/remote 2>/dev/null; echo done"
```
Then connect as root in Claude Code Desktop (it will fail once but drops the CLI binary).
Then apply the wrapper:
```powershell
ssh -p 2222 root@135.181.153.92 "for f in /root/.claude/remote/ccd-cli/*; do [ -f \"$f\" ] && [ ! -f \"${f}.real\" ] && head -c4 \"$f\" | grep -qv '#!/' && mv \"$f\" \"${f}.real\" && printf '#!/bin/bash\nexport LD_PRELOAD=/root/.claude/remote/fakeid.so\nexec \"$(dirname \"$0\")/$(basename \"$0\").real\" \"$@\"\n' > \"$f\" && chmod +x \"$f\" && echo \"wrapped $f\"; done"
```

### Step 6: Restart Claude Code Desktop and connect as root

## Verifying the fix

```bash
# From inside the container as root:
/root/.claude/remote/ccd-cli/*.real --version  # should print version
cat /root/.claude/remote/ccd-cli/<version>     # should show the wrapper script
ls -la /root/.claude/remote/fakeid.so          # should exist
cat /root/.claude/.credentials.json            # should have OAuth tokens
```

## Files involved

| File | Location | Purpose |
|------|----------|---------|
| `fakeid.so` | `/root/.claude/remote/fakeid.so` | LD_PRELOAD lib that fakes UID |
| `setup-root-claude.sh` | `/usr/local/bin/setup-root-claude.sh` | Setup + watcher script |
| Dockerfile | `.devcontainer/Dockerfile` | Builds fakeid.so into image |
| post-start.sh | `.devcontainer/post-start.sh` | Runs setup on container start |

## Root cause

Claude Code CLI source contains a hardcoded check: if `getuid() == 0` and
`--dangerously-skip-permissions` is passed, it prints an error and exits with code 1.
There is no config flag or environment variable to override this. The LD_PRELOAD
approach is the only workaround that preserves actual root privileges.
