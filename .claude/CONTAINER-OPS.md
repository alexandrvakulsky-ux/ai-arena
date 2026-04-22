# Container Operations Runbook

> This file is tracked in git and pushed to GitHub. Edit it in `/workspace/.claude/CONTAINER-OPS.md`.

## SSH Access

### Connecting
```bash
# As node user (default, runs the app)
ssh -p 2222 node@135.181.153.92

# As root (full access)
ssh -p 2222 root@135.181.153.92
```

SSH keys must be authorized in the container. The devcontainer setup copies keys during post-create.

### Troubleshooting SSH
- **Connection refused:** SSH daemon may not be running. Check with `docker exec` from the host, then `service ssh start`.
- **Permission denied:** Check `~/.ssh/authorized_keys` inside the container for the correct public key.
- **Port confusion:** The container listens on port 22 internally. The Hetzner host maps 2222 -> 22. Never try to SSH on port 22 from outside.

## Port Mappings

### AI Arena container (`ai-arena`)
| Host Port | Container Port | Service | Notes |
|-----------|---------------|---------|-------|
| 3000      | 3000          | Express app (AI Arena) | Main application |
| 2222      | 22            | SSH server | For remote shell access |

### Ad Spy container (`ad-spy`)
| Host Port | Container Port | Service | Notes |
|-----------|---------------|---------|-------|
| 3001      | 3001          | Express app (Ad Spy) | Facebook Ad Library intelligence |
| 2223      | 22            | SSH server | For remote shell access |

Ad Spy workspace bind mount: `/srv/ad-spy` → `/workspace`
Puppeteer cache volume: `ad-spy-puppeteer-cache`
**Repo:** `git@github.com:alexandrvakulsky-ux/ad-spy.git` — the ad-spy container has its own git clone at `/workspace` with SSH deploy key at `~/.ssh/github-deploy-key`. To commit changes: `docker exec ad-spy sh -c "cd /workspace && git add <files> && git commit -m '...' && git push"`. Source files to deploy live on host at `/srv/ad-spy/` (bind-mounted) — after editing on host, copy into container with `docker cp` and then commit from inside.

### Ad Spy operations runbook

**Video-detection audit** (checks classification accuracy via ScrapeCreators ground truth):
```
docker exec ad-spy node /workspace/scripts/verify-video-detection.js 30 --active
```
Runs automatically once per day on first user activity. Mismatches logged to `/workspace/.cache/video-audit-{ts}.json`. See `grep \[audit\] /workspace/server.log`.

**Force cache refresh:**
```
docker exec ad-spy sh -c "rm -f /workspace/.cache/_ads_cache.json /workspace/.cache/_sc_fetch_log.json" && docker restart ad-spy
# Then make any /api/ads/new request to trigger the fetch.
```

**Cost control knobs** (all in `server.js`):
- `SC_REFETCH_INTERVAL` — 4h throttle on ScrapeCreators per-page fetches
- `IDLE_THRESHOLD_MS` — 2h; no background refresh if user idle longer
- `FETCH_PAGE_BUDGET_MS` — 90s hard budget on Meta API pagination per page_id
- `EU_TOTAL_BUDGET_MS` — 120s hard budget on EU enrichment phase

**When UX feels broken (images missing, videos no play button):**
1. Check if Puppeteer is running: `docker exec ad-spy tail -20 /workspace/server.log | grep -i previews`
2. Count cached images: `docker exec ad-spy sh -c 'ls /workspace/.cache/*.jpg | wc -l'`
3. Run audit: command above
4. If audit shows >20% mismatch, a refresh is needed. Force-refresh via commands above.

## Container Rebuild

### When to rebuild
- Changes to `Dockerfile`
- Changes to `devcontainer.json`
- Changes to `post-create.sh` (runs only on create, not restart)
- New system packages needed

### How to rebuild
```bash
# From the host or via Cursor:
scripts/rebuild-container.sh

# Or from Cursor: Ctrl+Shift+P -> "Dev Containers: Rebuild Container"
```

### What survives a rebuild (named volumes)
- **Bash history** — shell history persists across rebuilds
- **Claude config** — `~/.claude/` configuration and credentials
- **Puppeteer cache** — Chrome/Chromium binaries for screenshot.js

### What is LOST on rebuild
- Any files outside of `/workspace` and named volumes
- Running processes and their state
- Installed packages not in the Dockerfile
- Temporary files in `/tmp`

**Note:** `/workspace` is bind-mounted from the host, so project files always survive.

## Startup Sequence

### post-create.sh (runs once on container creation)
- Installs project dependencies (`npm install`)
- Sets up SSH authorized keys
- Installs Claude Code skills
- Restores credentials from named volumes
- Configures git identity

### post-start.sh (runs on every container start)
- Starts SSH daemon
- Starts the application server
- Runs any health checks

## Firewall Setup

The Hetzner host runs `ufw` (or equivalent) with an allowlist:

- **Port 3000** — AI Arena (consider restricting to known IPs)
- **Port 3001** — Ad Spy
- **Port 2222** — SSH to AI Arena container
- **Port 2223** — SSH to Ad Spy container
- **Port 443/80** — If reverse proxy is configured

**Troubleshooting firewall:**
```bash
# On the Hetzner host (not inside container):
sudo ufw status
sudo ufw allow 2222/tcp
sudo ufw allow 3000/tcp
```

## Zombie Process Prevention

### The problem
If PID 1 in a container is not an init system (e.g., `tail -f /dev/null`, `bash`, `node`), orphaned child processes become zombies because PID 1 never calls `wait()` to reap them.

### The fix
`devcontainer.json` includes `--init` in `runArgs`, which injects `tini` as PID 1. Tini properly reaps zombie processes.

### Checking for zombies
```bash
# Count total processes (should be <50)
ps aux | wc -l

# Count zombies specifically
ps aux | awk '$8 ~ /Z/' | wc -l

# If zombies are accumulating, check PID 1:
ps -p 1 -o comm=
# Should show "tini" or "docker-init", NOT "tail" or "bash"
```

### Emergency zombie cleanup
If zombies have accumulated and a rebuild is not immediately possible:
```bash
# Zombies can only be removed by killing their parent or restarting the container.
# Find zombie parents:
ps -eo pid,ppid,stat,comm | grep Z

# Kill the parent process (if safe to do so):
kill <parent_pid>
```

## Troubleshooting

### AI Arena not responding
```bash
curl -s http://localhost:3000/health
ps aux | grep node
cd /workspace && npm start &
```

### Ad Spy not responding
```bash
# From the Hetzner host or ai-arena container:
docker exec ad-spy curl -s http://localhost:3001/health
docker exec ad-spy cat /workspace/server.log | tail -20
docker restart ad-spy
```

### Container won't start
1. Check Docker logs on the Hetzner host: `docker logs <container_id>`
2. Look for errors in `devcontainer.json` (invalid JSON, bad mount paths, missing devices)
3. If `--device=` entries reference non-existent devices, remove them
4. Rebuild without cache: `docker build --no-cache .`

### Out of disk space
```bash
# Inside container
df -h

# On host — prune unused Docker resources
docker system prune -a
```

## Emergency Procedures

### Container completely unresponsive
1. SSH to Hetzner host directly: `ssh root@135.181.153.92`
2. Find the container: `docker ps -a`
3. Restart it: `docker restart <container_id>`
4. If that fails, stop and start: `docker stop <id> && docker start <id>`

### Need to recover from bad devcontainer.json
1. SSH to Hetzner host
2. Edit the file directly in the mounted workspace: `vim /path/to/workspace/.devcontainer/devcontainer.json`
3. Fix the issue (common: bad `--device=` flags, invalid JSON)
4. Restart the container

### Application secrets lost
1. Check Railway dashboard for environment variable values
2. Recreate `/workspace/.env` with the keys from Railway
3. Restart the application
