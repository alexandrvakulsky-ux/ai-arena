---
name: ui-design-review
description: Evaluate visual design quality of public/index.html — typography, color, spacing, hierarchy, consistency. Use after any frontend change or before asking "does this look good?". Combines visual polish check with usability heuristics.
tools: Bash, Read
---

# UI Design Review — AI Arena

Evaluate `public/index.html` for visual quality and usability. This project uses vanilla HTML/CSS — no framework, no build step.

## Process

1. **Screenshot first**
   - Use Puppeteer MCP to take a screenshot of `http://localhost:3000`
   - If server is down: start it first, wait 2s, screenshot

2. **Visual design check** (apply these criteria to the screenshot + source)
   - Typography: consistent font sizes, weights, line-height — no random size jumps
   - Color: contrast ratios pass WCAG AA (4.5:1 for text, 3:1 for UI elements)
   - Spacing: consistent padding/margin rhythm — no cramped or floating elements
   - Hierarchy: most important content visually dominant — eye lands in the right place
   - Consistency: buttons, inputs, cards all follow the same visual pattern
   - States: hover, focus, loading, error states all look intentional (not browser defaults)

3. **Usability spot-check** (top 5 Nielsen heuristics for this UI)
   - Visibility of system status — is it clear when models are loading/responding?
   - Match with real world — labels and affordances use plain language
   - User control — can the user cancel or reset easily?
   - Error prevention — are destructive actions confirmed or prevented?
   - Recognition over recall — are all options visible, not buried?

4. **AI Arena specifics**
   - Do the 3 model response panels feel balanced and easy to compare?
   - Is the synthesis section visually distinct from the individual responses?
   - Score display (`Claude=X/10`) readable at a glance?
   - Mobile: does the layout degrade gracefully on narrow screens?

5. **Report**
   - Screenshot inline
   - Findings grouped by: Critical (breaks usability) / Minor (polish) / Suggestion
   - Specific CSS/HTML line references where possible
   - Maximum 5 actionable items — don't list every imperfection

## Related skills
- `web-design-guidelines` — Vercel's technical compliance check (keyboard, focus, a11y)
- `wcag-accessibility-audit` (`~/.claude/skills/mastepanoski-skills/skills/wcag-accessibility-audit/SKILL.md`) — full WCAG audit if accessibility issues found
