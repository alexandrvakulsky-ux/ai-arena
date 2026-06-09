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

### Heads-up: `whoami` lies when SSH'd as root

`/root/.claude/remote/fakeid.so` is `LD_PRELOAD`-injected into every process spawned by the Claude Code Remote runtime (`ccd-cli` wrapper). It overrides `getuid()`/`geteuid()` to return 1000, so libc-based tools (`id`, `whoami`, `sudo`) report `node` even when the kernel-side process is real `uid 0`.

**Why it exists**: Claude Code CLI hard-blocks `--dangerously-skip-permissions` when `getuid() == 0` — there's no flag to override. The shim is the only way to run YOLO-mode Claude Code as root while keeping actual root capabilities. See `.claude/ROOT-SSH-SETUP.md` for the full setup (Dockerfile build, wrapper layer, recovery).

**To check the real identity**, look at the kernel, not libc:
```bash
grep -E "^Uid|^CapEff" /proc/$$/status   # Uid: 0 = real root
LD_PRELOAD= /usr/bin/id                  # bypasses the shim
```

If you see `$USER=root`, `$HOME=/root`, but `whoami=node`: you're root. Don't waste a turn re-verifying.

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
**Repo:** `git@github.com:alexandrvakulsky-ux/ad-spy.git` (private). The ad-spy container has its own git clone at `/workspace` with SSH deploy key at `~/.ssh/github-deploy-key`. To commit changes: `docker exec ad-spy sh -c "cd /workspace && git add <files> && git commit -m '...' && git push"`. Source files to deploy live on host at `/srv/ad-spy/` (bind-mounted) — after editing on host, copy into container with `docker cp` and then commit from inside.

### Working with Ad Spy from inside the ai-arena container

The Docker socket (`/var/run/docker.sock`) is mounted into ai-arena, so from this container you can drive the sibling ad-spy container directly:

```bash
docker ps                          # both containers visible
docker exec ad-spy <cmd>           # run anything in ad-spy
docker exec ad-spy curl -s localhost:3001/health
```

Direct network reach (`curl ad-spy:3001`, `curl localhost:3001`) does **not** work from inside ai-arena — the containers are on separate networks. Use docker exec.

For read-only review of the ad-spy source from this container, use the helper:
```bash
source /workspace/scripts/ad-spy-helpers.sh
ad_spy_sync_local        # clones / fast-forwards /tmp/ad-spy
ad_spy_exec git log -5   # against the live container
ad_spy_log 100           # tail server.log
```

The helper authenticates via a GitHub PAT extracted from `/home/node/.claude/.git/config` (the claude-sync clone). That PAT is owner-scoped — it can read all of alexandrvakulsky-ux's private repos, including ad-spy. The volume is named (`ai-arena-claude-config`), so the PAT survives container rebuilds.

`/tmp/ad-spy` itself is **ephemeral** — `/tmp` is wiped on container rebuild. Re-cloning takes ~2s; don't write anything you care about there.

### Ad Spy operations runbook

**Daily self-healing audits** (fully automated — fire on first user activity each day):
- **Video-detection audit** — random-sample check that `ad_format`/`has_video` match ScrapeCreators ground truth.
- **Competitor coverage audit** — verifies every page_id returns data; **auto-force-refreshes** competitors with recoverable gaps (where SC has data but our cache is missing it).

Both report in `/workspace/server.log` under `[video-audit]`, `[coverage-audit]`, `[coverage]`, and `[audit]` tags. No human action required — if a competitor goes silently empty, the next user visit triggers the audit which triggers the recovery.

To inspect or run on demand (rarely needed):
```
docker exec ad-spy grep "\[coverage\]\|\[audit\]" /workspace/server.log | tail -20
```

**Force cache refresh** (per-competitor now, not global):
```
# One competitor:
curl -X POST "http://localhost:3001/api/refresh?competitor=Nebula" -H "x-app-token: $TOKEN"
# One group:
curl -X POST "http://localhost:3001/api/refresh?group=Genesis" -H "x-app-token: $TOKEN"
# Everything (sequential, ~5-10 min):
curl -X POST "http://localhost:3001/api/refresh" -H "x-app-token: $TOKEN"
# Nuclear — delete all per-comp caches + restart:
docker exec ad-spy sh -c "rm -rf /workspace/.cache/comp/* /workspace/.cache/_sc_fetch_log.json" && docker restart ad-spy
```

**Find missing persona pages** (competitors like BetterMe, Paw Champ, Finelo run most ads through spokesperson accounts):
```
docker exec ad-spy node /workspace/scripts/find-missing-personas.js
docker exec ad-spy node /workspace/scripts/apply-persona-additions.js /workspace/.cache/persona-audit-NNN.json
```
Costs ~$1-2 per run. Do it when you suspect undercount for a brand.

**Cost control knobs** (all in `server.js`):
- `COMP_TTL_MS` — 4h per-competitor cache TTL
- `COMP_MAX_CONCURRENT_FETCH` — 2 parallel SC requests cap (higher → SC starts returning empties)
- `MAX_FIRST_CALL_RETRIES` — 6 retries for SC empty-response flakiness
- 1.5s mandatory delay between page_ids within one competitor's fetch
- `IDLE_THRESHOLD_MS` — 2h; if no user activity in this window, skip background refreshes entirely

**Kill-switch env vars** (set in `/srv/ad-spy/.env` to disable):
- `AD_SPY_DISABLE_PAID_AUDITS=1` — skips the daily video-detection + coverage audits (~$1/day)
- `AD_SPY_DISABLE_BRIEF=1` — skips the daily competitive brief (~$0.15-0.30/day, fires 90s after first user activity each day)

**Today tab + competitive brief** (added 2026-05-05):
- `GET /api/brief/today` (auth-gated) — returns today's markdown brief + metadata. Falls back to the latest prior brief if today's isn't ready yet.
- `POST /api/brief/regenerate` (auth-gated, 90s in-process cooldown) — force a regeneration.
- Brief artifacts live at `/srv/ad-spy/.cache/briefs/YYYY-MM-DD.md` + `_latest.json`. `.cache/` is gitignored.
- Brief fires on first user activity each day via `maybeRunDailyBrief()` gating on `.cache/_last_brief.txt`. Mirrors the existing daily-audit pattern. Generator script: `scripts/generate-brief.js`.

**Cross-page association** (added 2026-05-11):
- `GET /api/clusters?min_pages=2&new_only=true` (auth-gated) — clusters tracked + un-tracked FB page_ids by shared destination domain. Surfaces hidden personas. $0 — reads cache only, no SC fetches. Computed in-process (~100ms walk).
- Script: `scripts/find-page-clusters.js`. Also runnable as a CLI for the readable report.
- Shared cache loader: `lib/cache-walk.js` (new canonical pattern; scripts should require this rather than re-implementing watchlist iteration).

**Architecture**: per-competitor lazy-fetch. Each competitor has its own `.cache/comp/{slug}.json` file with independent 4h TTL. Sidebar counts read these files directly without triggering fetches. Endpoint requests only fetch the competitors their filter actually needs. No more global cache wipe = no more cascading data loss.

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
1. Restore /workspace/.env from the persistent backup ($HOME/.claude/.env.backup)
2. (post-start.sh restores it automatically if missing)
3. Restart the application
