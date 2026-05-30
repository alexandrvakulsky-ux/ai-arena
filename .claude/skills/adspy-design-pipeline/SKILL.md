---
name: "adspy-design-pipeline"
description: "Use this skill for the ad-spy frontend design workflow: generate/refine designs with AIDesigner (brand-kit steered), publish them to a GitHub Pages staging URL, collect element-pinned comments from Webvizio (relayed via the ad-spy container), rework, and ship the look to the real ad-spy app via a safe token-reskin deploy. Trigger on any ad-spy UI/design/redesign request, or 'check Webvizio', 'pull comments', 'publish the design', 'ship it'."
---

# Ad-Spy Design Pipeline (optimized)

A real comment→rework→ship loop. AIDesigner makes the design, GitHub Pages hosts it,
Webvizio is the shared comment surface, and the look ships to production as a token reskin.

## The loop (one pass)
```
refine in AIDesigner ──▶ aidesigner-fetch (HTML→file) ──▶ publish-staging (gh-pages)
        ▲                                                          │
        │                                                  user/wife comment in Webvizio
   wv pull (tasks+shots) ◀───────────────────────────────────────┘
        │
   present + refine each ──▶ publish ──▶ (optional compare report) ──▶ STOP
                                                                          │ human approves
                                              adspy-deploy-reskin (backup+verify+rollback) + wv close
```

## Helper scripts (in /workspace/scripts) — use these, don't hand-roll
| Script | Runs in | Purpose |
|---|---|---|
| `aidesigner-fetch.js <list\|canvas <id>\|latest> <out.html>` | ai-arena | Pull canvas HTML **straight from api.aidesigner.ai to a file**. NEVER hand-write/Write canvas HTML — it's the #1 token sink. |
| `wv.sh <tasks\|task\|prompt\|shot\|close\|pull> …` | ai-arena → ad-spy | Webvizio relay (the MCP is dead here — see constraints). `wv.sh pull <dir>` fetches open tasks + prompts + screenshots. |
| `publish-staging.sh <local.html>` | ai-arena | Idempotent, verified publish to the gh-pages staging URL (polls until the live page matches). |
| `adspy-deploy-reskin.sh <reskinned.html> [--marker=STR] \| --rollback` | ai-arena | Safe prod deploy: out-of-tree backup, atomic swap, 200+marker verify, auto-rollback. Refuses mockups. |
| `adspy-shoot.js <job.json>` | ad-spy | Puppeteer capture (login + gate dismissal). Loud: `ok:false` in manifest + non-zero exit on failure. |
| `design-compare.js <diff\|compare-shots>` | ai-arena | Zero-dep PNG pixel-diff + side-by-side report. |
| `adspy-design-compare.sh <run> <draft.html>…` / `adspy-live-shot.sh <label>` | ai-arena | Capture orchestrators (live + drafts) → report / before-after shots. |

## Stage-by-stage

### 0. Reference intake — MANDATORY, do this FIRST, every single time
**HARD RULE: never write a design prompt from imagination when a reference exists — and here one ALWAYS exists.** Do not hand-fabricate designs or hand-edit CSS and call it done. Gather the references and feed them *into* AIDesigner.

1. **Collect every available reference up front:**
   - The **current app** (what you're improving): `bash scripts/adspy-live-shot.sh before` → logged-in screenshot.
   - The **latest design**: the staging URL / the last canvas id from generate/refine.
   - **Direction / inspiration**: competitor or example URLs. If you don't have a clear target, GET it — ask Alex for the reference/examples, or ask AIDesigner to generate options (`generate_branding_kit_variations`, multiple `generate_design` directions). **Missing info → gather it; never guess.**
2. **Feed references INTO AIDesigner** (don't just describe them):
   - Website/app reachable by URL → `generate_design`/`refine_design` with `mode: clone | enhance | inspire` + `url:` (AIDesigner has internet; the gh-pages staging URL works; the public ad-spy host `:3001` works but is password-gated so it'll see the gate).
   - Brand from a site → `create_brand_kit_from_url`.
   - Screenshots/examples → host them on gh-pages and pass as `url:`, or pass reference `image_urls` to the image tools.
3. **Only then** generate — with the reference attached AND a complete, specific brief (layout, explicit palette/contrast rules, do/don't, the exact fixes requested).

**GATE:** if you're about to call generate/refine with a from-imagination prompt and no reference/url/image attached, STOP and complete step 1–2 first.

### 1. Design — AIDesigner MCP
- `whoami` / `get_credit_status` first. Brand kit **"Ad Spy"** = `3ba50f7f-aa3a-4b85-9bea-de0986dd60d7` (DM Sans, #0033FF on #0A192F navy, spiral mark). Editor session `5ee32805-c5f3-4c9f-a876-535c49ec9dfb`.
- `refine_design(run_id, feedback, brand_kit_id=…)` — pass **no** `target_canvas_id` to get a NEW canvas (before/after sits side-by-side in the editor); pass it to overwrite in place.
- **Then fetch, don't transcribe:** `node scripts/aidesigner-fetch.js latest /workspace/.claude/designs/current/design.html`.

### 2. Publish to staging
`bash scripts/publish-staging.sh /workspace/.claude/designs/current/design.html` → live at
**https://alexandrvakulsky-ux.github.io/ai-arena/** (the URL Webvizio loads). Idempotent + waits until live.

### 3. Collect comments — Webvizio (via relay)
`bash scripts/wv.sh pull /workspace/.claude/designs/current/feedback` → `tasks.json` + per-task `<uuid>.png`.
Present them; `/tasks` returns only OPEN tasks (closed ones drop off). Each task has a `prompt` (Webvizio-generated) + the pinned-element screenshot.

### 4. Rework
For each comment → `refine_design(...)` → `aidesigner-fetch.js latest …` → `publish-staging.sh`. Optionally
`adspy-design-compare.sh` for a before/after report. **STOP** and show the staging URL — let the human review.

### 5. Ship (human-gated)
Production is a **token reskin** of the REAL app, never the mockup:
- Reskin recipe (ad-spy is CSS-var driven): swap font (`<link>` + `--font` → DM Sans), retheme the `:root` token block (navy bg/surfaces, `--accent:#0033FF`), add the blue spiral `<svg>` in `.sidebar-header`. **Nothing else** — JS/gate/`/api`/markup untouched.
- Deploy: `bash scripts/adspy-deploy-reskin.sh <reskinned-real-index.html>` (backs up to `/workspace/.deploy-backups/`, verifies live 200 + marker, auto-rolls-back on failure). Revert: `--rollback`.
- Then close the addressed Webvizio task: `bash scripts/wv.sh close <uuid>` — **only after the human approves** (closing is an external write).

## Hard constraints (verified)
- **ai-arena egress is allowlisted.** Reachable: `api.aidesigner.ai`, npm, github, `fonts.googleapis.com`. **Blocked: `app.webvizio.com`, `cdn.tailwindcss.com`.** So: the registered `@webvizio/mcp-server` is **dead from ai-arena** — always use `wv.sh` (relays through ad-spy). And design HTML using the Tailwind CDN renders unstyled if captured in ai-arena.
- **ad-spy** (sibling container) has open internet + Puppeteer + Chrome 146, and runs the live app. Reach it only via `docker exec ad-spy` / `docker cp`. Its `curl` has a broken CA bundle — use `node` for https.
- **Webvizio relay:** base `https://app.webvizio.com/api/mcp/v1`, Bearer key from `/home/node/.claude/webvizio.key` (durable). Project uuid `826083f4-89c2-460a-8f8e-1aede04c40f2`.

## Two hard human gates (never automate)
1. **Never deploy to the real app** without explicit approval (and never ship the AIDesigner mockup — demo data + stripped JS).
2. **Never close a Webvizio task** without approval (it's an external-system write; the safety layer blocks it anyway).

## Hygiene
- Design drafts live under `/workspace/.claude/designs/` (gitignored) — NOT `/workspace/public/` (that's the Railway-deployed ai-arena app; putting drafts there leaks them).
- Deploy backups go to `/workspace/.deploy-backups/` (gitignored, last 8 kept), never in the ad-spy repo tree.
