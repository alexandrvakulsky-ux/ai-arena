# Session — 2026-05-04 — Access audit, root-vs-node identity, ad-spy access from inside ai-arena

## Trigger
User asked me to verify GitHub access for both repos, review both codebases + prior sessions, then fix and document the issues we hit when connecting as root.

## What I found

### 1. The "you're node, no you're root" confusion
SSH'd in as root, but `id` / `whoami` reported `node`. Root cause: `LD_PRELOAD=/root/.claude/remote/fakeid.so` is set by the Claude Code Remote runtime (`ccd-cli` wrapper). The shim intercepts libc `getuid/geteuid` so anything libc-based reports uid 1000. The kernel-side process is genuinely uid 0 — confirmed by `/proc/$$/status: Uid: 0 0 0 0` and `CapEff: 00000000a80435fb` (full caps).

Why it exists: tools that gatekeep on uid (npm warnings, soffice, some skills) work cleanly when they think they're a normal user.

How to verify real identity:
```
grep ^Uid /proc/$$/status   # 0 = real root
LD_PRELOAD= /usr/bin/id     # bypasses the shim
```

I also wasted a turn telling Alex he was `node`. Fixed by adding a "ROOT vs NODE — DON'T GET FOOLED" section to the global CLAUDE.md.

### 2. GitHub access matrix (from inside ai-arena container)

| Repo | Visibility | SSH deploy key works? | PAT in claude-sync clone works? |
|---|---|---|---|
| ai-arena | public | yes (`/root/.ssh/github-deploy-key`) | yes |
| ad-spy | private | **no** — deploy key is repo-scoped to ai-arena only | yes |
| claude-sync | private | n/a | yes |

The PAT lives in `/home/node/.claude/.git/config` (the claude-sync clone). The `/home/node/.claude` directory is a named volume (`ai-arena-claude-config`) that survives container rebuilds, so the PAT persists.

Symptom that bit me: `git clone git@github.com:.../ad-spy.git` returns "Repository not found" — GitHub returns the same error for "not found" and "no access," so the deploy-key auth made it look like the repo didn't exist.

### 3. Ad Spy live state
- Separate Docker container on the same Hetzner host (port 3001, ssh 2223, container name `ad-spy`)
- Bind mount: `/srv/ad-spy` (host) → `/workspace` (container)
- Reachable from inside ai-arena via `docker exec ad-spy <cmd>` because `/var/run/docker.sock` is mounted into ai-arena
- **NOT** reachable via direct curl from ai-arena — they're on separate Docker networks
- Live state: 24 competitors, 19,304 ads, 3,520 images cached, HEAD at `150381c` (matches what GitHub shows)

### 4. Local clone for review
Cloned latest ad-spy to `/tmp/ad-spy` via PAT for read-only review. /tmp is ephemeral (overlay, not a volume) — re-cloning is fine, takes ~2s.

## What I shipped

### `scripts/ad-spy-helpers.sh`
Bash helpers for working with Ad Spy from inside ai-arena:
- `ad_spy_pat` — extract PAT from claude-sync clone
- `ad_spy_sync_local` — clone or fast-forward `/tmp/ad-spy`
- `ad_spy_exec <cmd>` — run command in live container
- `ad_spy_log [N]` — tail server.log
Running the script directly does a full status check.

### Doc updates
- `.claude/CONTAINER-OPS.md`
  - Added "Heads-up: `whoami` lies when SSH'd as root" subsection
  - Added "Working with Ad Spy from inside the ai-arena container" subsection (docker socket + helper script + ephemerality of /tmp)
- `.claude/CLAUDE.md`
  - Added "Identity sanity check" section
  - Added "Sibling project: Ad Spy" section pointing at the helper + CONTAINER-OPS
- `.devcontainer/global-claude/CLAUDE.md` (and the live copy at `/root/.claude/CLAUDE.md`)
  - Promoted infrastructure quick-reference: two containers, repo access matrix, PAT location
  - Added "ROOT vs NODE — DON'T GET FOOLED" section
  - Added two new entries under PAST MISTAKES (deploy key scope, trusting `whoami`)

## Mounts confirmed (what survives a rebuild)
Persistent (`/dev/sda1`): `/workspace`, `/commandhistory`, `/home/node/.claude`, `/home/node/.cache/puppeteer`
Ephemeral (overlay): everything else, including `/tmp`, `/root` (except /root/.ssh which is restored by post-start), `/home/node` (except the two paths above).

This is why the global CLAUDE.md edits had to be synced to `.devcontainer/global-claude/CLAUDE.md` — `/root/.claude/CLAUDE.md` gets re-copied from there on rebuild.

## Outstanding / nice-to-have
- Could add an explicit `ad-spy` bind mount to devcontainer.json so `/tmp/ad-spy` lives somewhere persistent, but it's a 2s re-clone and `/tmp` works fine.
- The bootstrap section of global CLAUDE.md still says "git clone https://github.com/alexandrvakulsky-ux/ai-arena.git" — fine, but if someone bootstraps fresh and needs ad-spy too, they'll need the PAT (which they won't have on a brand-new machine without the claude-sync volume). Not blocking; flag for later.
