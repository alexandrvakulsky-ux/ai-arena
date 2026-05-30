# Ad Spy — Design Playbook (the single source of truth)

This is THE rulebook for all design work. Follow it every time, in order. The goal:
working with me on design should feel like working with a **senior product designer** —
deliberate, systematic, legible — not "pull something up, slap a layout, ship markup."
If anything below conflicts with an old note or habit, **this document wins.**

Three commitments that everything else serves:
1. **The design comes from AIDesigner, from references — never my imagination.**
2. **Every artifact is named and placed by a clear convention — never ad-hoc.**
3. **Every decision is justified by craft principles — never vibes.**

---

## 1 — The process (always these phases, in order)

A senior designer doesn't jump to pixels. We move through phases; each has an exit before
the next begins.

**Phase 1 · Brief.** Before anything, state in one short paragraph: *what surface, what
problem, who it's for, what "better" means here, and the hard constraints.* If any of that is
unknown, get it (ask the user one question, or read the current UI) — don't proceed on a guess.

**Phase 2 · References.** Gather the inputs and feed them **into AIDesigner**, never describe
from memory: the current screen (`adspy-live-shot`), the last approved design, and 1–2 direction
references (a tool/site we admire) via `--mode=enhance|clone|inspire --url=…`, brand-kit, or
reference images. No reference attached → stop and get one.

**Phase 3 · Directions.** Generate a *small, deliberate* set — **2–3 distinct named directions**,
not a pile of one-offs. Each on its own canvas with a clear title (§2). Quality of the brief
decides how few rounds this takes — write it strong and specific the first time.

**Phase 4 · Critique.** Judge each direction against the **principles in §3** — out loud, like a
design review: "hierarchy is muddy here", "blue is doing too much there". Pick ONE direction (or
synthesize the best of two). This is the senior-designer step most ad-hoc flows skip.

**Phase 5 · Iterate.** Refine the chosen direction **in place** (overwrite its canvas, §2) until
it's right. Publish each iteration to the staging URL so the user (and CMO) review the real thing,
not a description.

**Phase 6 · Ship.** Port the **full** approved template onto the real app faithfully (§4 ship gate),
verify it with real data, deploy safely (backup + rollback). Never a token-swap, never the mockup.

> One sentence to the user at each phase boundary: what we just did, what's next, what we need.
> No silent flailing.

---

## 2 — Organization & naming (so it's never flaky)

**Canvas name (the editor label).** AIDesigner derives it from the design `<title>`, so always
pass `--title`. Convention:
```
Ad Spy — <Surface> — <Direction> v<N>
e.g. "Ad Spy — Dashboard — Premium v2",  "Ad Spy — Dashboard — Dense Grid v1"
```
- **Surface** = the screen (Dashboard, Discover, Brief, Login).
- **Direction** = the concept (Premium, Dense Grid, Editorial…).
- **vN** = iteration of THAT direction.

**One canvas per direction.** Iterations of the same direction **overwrite in place**
(`refine --target=<canvas_id>`), bumping vN in the title. A **new canvas is only for a genuinely
different direction.** This is the rule that stops the pile-up/overlap.

**One board (editor session) per project.** When a board gets cluttered (AIDesigner can't delete
or move canvases), start a **fresh session** (`create_editor_session`, titled "Ad Spy Design") and
relink. Keep ≤ ~5 live canvases on a board.

**Files on disk.** Drafts live under `/workspace/.claude/designs/<surface>/<direction>-vN.html`
(gitignored). The current shipped/working design is `/workspace/.claude/designs/current/design.html`.
Never put drafts in `public/` (that deploys).

**Traceability.** Each design keeps its AIDesigner `run_id` + `canvas_id` (the `aidesigner.js`
output). A new direction references the run it branched from. We can always answer "where did this
come from."

---

## 3 — Design principles (the craft — this is what "senior" means)

These are the rules that separate the premium redesign from the half-assed one. Apply them in
critique (§Phase 4) and when briefing AIDesigner.

**Hierarchy.** Every screen has ONE clear focal point, then a deliberate second and third tier.
Big, confident key numbers (tabular figures); small, quiet labels (uppercase, tracked); calm body.
If everything shouts, nothing is heard.

**Color discipline.** ONE accent color, used **sparingly** — active state, one primary button,
small indicators. **Never** saturated accent as body or link text on dark (it's harsh and low-
contrast); interactive text is light-gray brightening toward white on hover. Status colors are
**muted and semantic** (a soft green/amber/red), not neon. Build depth from **layered neutral
surfaces**, not from color.

**Typography.** One family (DM Sans). A tight, consistent scale — don't invent sizes. Tabular
numerals for any data/metrics. Generous line-height for body. Weight carries hierarchy more than size.

**Spacing & alignment.** A consistent rhythm (4 / 8 px steps). Generous, even whitespace. Everything
aligns to a grid; nothing is "roughly there." Density is a deliberate choice, applied evenly.

**Depth — subtle, never flat, never garish.** Hairline borders (white at 6–11%), soft diffuse
shadows, gentle top-to-bottom surface gradients, a faint inner highlight on cards. Restraint reads
as expensive.

**Components, not one-offs.** Cards, chips, buttons, badges follow ONE pattern reused everywhere —
same padding, radii, states. Consistency > novelty per element.

**Restraint.** Remove before adding. The target adjective is **calm, premium, trustworthy** — a
tool a paying professional relies on. When unsure, take something away.

**Accessibility.** Readable contrast on every text/background pair; visible focus states; respect
reduced-motion.

---

## 4 — Decision rules (unambiguous calls)

- **Iterate vs new direction:** same concept, making it better → overwrite (`--target`). Different
  concept worth comparing → new named canvas. Default to iterate; branch only with intent.
- **Reference modes:** reproduce a site closely → `clone`; improve a specific site keeping its intent
  → `enhance`; borrow only the vibe → `inspire`. Always with `--url`.
- **Brand kit:** pass the saved Ad Spy kit so type/color stay consistent across directions.
- **Ship gate (production):** AIDesigner produces the **complete** template; port it **whole** onto
  the real app — reproduce its full design system in the app's static CSS (no Tailwind/build into
  prod), graft the real JS/gate/`/api` back in, verify with real data, deploy with backup + rollback.
  **NEVER** a `:root` token-swap shortcut, **NEVER** drop the demo mockup onto prod.
- **Human gates:** never auto-deploy to prod, never auto-close a Webvizio task, without approval.

---

## 5 — How the rules map to the toolchain (`design.sh` is the spine)

The process is wired into ONE command surface, `scripts/design.sh`. The principles aren't a
doc you remember — **`aidesigner.js` auto-injects the craft brief (§3, from `design-brief.md`)
and the naming convention (§2) into EVERY generate/refine.** Design HTML always flows API→file,
never through model output.

| Phase | Command |
|---|---|
| 2 · References | `design.sh shot` — snapshot the current app |
| 3 · Directions | `design.sh new <Surface> <Direction> <prompt-file> [refURL]` — named canvas, brief + brand auto-applied, published to staging |
| 4 · Critique | judge against §3 (your call) |
| 5 · Iterate | `design.sh iterate <run_id> <canvas_id> <feedback-file>` — overwrites the canvas in place, re-publishes |
| 6 · Review | `design.sh review` — pull Webvizio comments + screenshots |
| Ship | `design.sh ship <ported-real-index.html>` — full-template port → backup + verify + rollback |

You supply judgment (the brief, the prompt/feedback text, the critique). The tools supply the
conventions, the craft brief, the naming, and the plumbing — so it's systematic every time.

---

*Read this top-to-bottom at the start of any design task. It's the contract: a method, a naming
system, and a craft bar — so the work is systematic, legible, and senior-grade every time.*
