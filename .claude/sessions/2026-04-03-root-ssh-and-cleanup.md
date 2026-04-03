# Session — 2026-04-03 — Root SSH & Zombie Cleanup

## Summary
Resolved root SSH access issues, discovered and fixed massive zombie process accumulation, added health endpoint for Railway.

## Root SSH Connection

**Problem:** Could not SSH as root into the devcontainer.

**Resolution:** The container runs SSH on port 22 internally, mapped to port 2222 on the Hetzner host (135.181.153.92).

- SSH access now works for both `node` user and `root` user
- Connect as node: `ssh -p 2222 node@135.181.153.92`
- Connect as root: `ssh -p 2222 root@135.181.153.92`

## Zombie Process Accumulation

**Discovery:** 1,205 zombie processes found — 98% of all running processes.

**Root cause:** PID 1 in the container was `tail -f /dev/null` (a common devcontainer keep-alive trick). This process does not reap orphaned child processes, so every spawned subprocess that finishes becomes a zombie.

**Fix:** Added `--init` to Docker `runArgs` in `devcontainer.json`. This injects `tini` as PID 1, which properly reaps zombie/orphaned processes.

**Key lesson:** Always use `--init` flag in Docker containers to prevent zombie accumulation. Any container where PID 1 is not an init system (bash, tail, node, etc.) will leak zombies over time.

## Health Endpoint

Added `/health` endpoint to the Express server for Railway healthchecks. Returns 200 OK with basic status info.

## Container Rebuild Procedure

After modifying `devcontainer.json` or `Dockerfile`, a container rebuild is needed.

**What survives a rebuild (named volumes):**
- Bash history
- Claude config
- Puppeteer cache

**What is lost:** Everything else in the filesystem not on a named volume.

## Port Mapping Reference

| Host Port | Container Port | Service |
|-----------|---------------|---------|
| 3000      | 3000          | Express app (AI Arena) |
| 2222      | 22            | SSH server |

## Changes Made
- `devcontainer.json`: Added `--init` to `runArgs`
- `server.js`: Added `/health` endpoint
- Verified SSH access for both users
- Confirmed zombie count drops to near-zero after rebuild with `--init`
