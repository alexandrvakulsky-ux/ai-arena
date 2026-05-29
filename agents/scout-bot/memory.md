# Scout Bot Memory

This file is the agent's persistent knowledge about Alex and his projects.
It's loaded into the system prompt on every Telegram interaction. The
agent can append updates by including `MEMORY_UPDATE: ...` lines in its
replies — the handler parses those out and appends them here.

## Alex (the user)
- Builder, not full-time dev. Ships fast, keeps things simple.
- Comfortable with Node, npm/npx, SSH.
- Uses Claude Code Desktop on Windows.
- Email: alexandr.vakulsky@gmail.com.
- Communication style: terse, no preamble, no fluff. Likes evidence before claims. Will push back on over-engineering.

## Alex's projects

### Futureproof (active priority)
- Consumer cybersecurity SaaS. Competitive space: Cloaked, Guardio, Aura, Norton LifeLock, Privacyhawk, Clario.
- Target customer: consumers worried about identity theft, scams, data brokers, online privacy.
- Non-obvious angles win — e.g. Liven's "vagus nerve" hook from telemedicine (not wellness) was a runaway. The bar for "interesting find" is something that surprising.

### ad-spy
- FB Ad Library intelligence tool. Runs at http://135.181.153.92:3001.
- 24 competitors tracked across Digital Security + Genesis verticals, ~19,000 ads.
- Per-competitor SC-fed cache, lazy-fetch with 4-8h TTL.
- Daily competitive brief generation via Claude.

### ai-arena
- Multi-model comparison app. Claude vs GPT-4o vs Gemini, 3-round synthesis.
- Runs at http://135.181.153.92:3000.
- Migrated off Railway → Hetzner self-hosted (2026-05-26).

## What Alex finds interesting (calibrate from these)
- Surprising angles (the vagus-nerve type)
- Concrete examples with URLs over generic advice
- Genuinely cool MCPs that solve specific problems — not yet-another-DB-wrapper
- Cost-efficient solutions over enterprise-grade ones

## What Alex does NOT want
- Walls of text — concise wins
- Bulk questions all at once — ask one at a time
- Generic suggestions ("improve onboarding") without concrete URL refs
- Re-flagging things you already showed him

## Updates (auto-appended by the agent over time)


## Updates 2026-05-29
- Alex is dealing with Facebook personal account blocks, going through appeals process (2026-05-29).
- Alex is assembling a team to integrate AI agents into Futureproof (2026-05-29).

## Updates 2026-05-29
- Alex wants AI agents for Futureproof in three areas: support, audience feedback gathering, and competitor/funnel research. Some will be internal, some user-facing — flexible depending on context (2026-05-29).

## Updates 2026-05-29
- Alex has Zendesk for support. Considering Gemini voice API for voice-based agent features in Futureproof (2026-05-29).
- Alex wants AI agents for Futureproof in three areas: support, audience feedback gathering, and competitor/funnel research. Some will be internal, some user-facing — flexible depending on context (2026-05-29).

## Updates 2026-05-29
- Alex has Zendesk for support. Considering Gemini voice API for voice-based agent features in Futureproof (2026-05-29).
- Alex wants AI agents for Futureproof in three areas: support, audience feedback gathering, and competitor/funnel research. Some will be internal, some user-facing — flexible depending on context (2026-05-29).

## Updates 2026-05-29
- Alex's personal Facebook profile is restricted due to ad account activity. He's going through the appeals process (2026-05-29).
- Alex has a full separate project stack for Futureproof, not using the same Hetzner/Node setup as ad-spy and ai-arena (2026-05-29).

## Updates 2026-05-29
- Alex is dealing with Facebook personal account blocks, going through appeals process (2026-05-29).
- Alex is assembling a team to integrate AI agents into Futureproof (2026-05-29).
- Alex wants AI agents for Futureproof in three areas: support, audience feedback gathering, and competitor/funnel research. Some will be internal, some user-facing — flexible depending on context (2026-05-29).
- Alex has Zendesk for support. Considering Gemini voice API for voice-based agent features in Futureproof (2026-05-29).
- Alex has a full separate project stack for Futureproof, not using the same Hetzner/Node setup as ad-spy and ai-arena (2026-05-29).
- Alex is waiting to chat with his CTO before making team/architecture decisions for the AI agent work (2026-05-29).

## Updates 2026-05-29
- Alex is in discussions with Meta about MCP connectors to Meta Ads, and is aware of Manus AI integration. He shared this info in what appears to be a Ukrainian-language group chat (2026-05-29).
- Alex may have direct Meta contacts for ad platform discussions (2026-05-29).

## Updates 2026-05-29
- Alex is in a community/group discussing MCP connectors to Meta Ads and Manus AI integration with Meta Ads Manager. He's testing and sharing results (2026-05-29).

## Updates 2026-05-29
- Alex wants regular monitoring of Manus AI (Meta Ads Manager integration) for useful updates. Key triggers to flag: reliability improvements, campaign execution features, EU availability, new MCP connectors, anything relevant to ad-spy or Futureproof (2026-05-29).