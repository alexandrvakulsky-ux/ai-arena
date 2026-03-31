---
description: Security rules for AI Arena. The app handles API keys, session tokens, and user input — these rules are non-negotiable.
---

## What's already in place (don't break these)
- SESSION_TOKEN auth — random 32 bytes, regenerates on restart
- 5 wrong password attempts → 15-minute IP lockout
- Rate limiting: 10/min on auth, 20/min on API routes
- DOMPurify on all markdown rendered in the frontend
- CSP + HSTS + security headers on every response
- Missing API keys logged as warnings on startup, not errors that expose key names

## Rules
- Never log request bodies — they may contain user prompts or tokens
- Never expose API keys in responses, logs, or error messages
- Never commit `.env` or `.claude-credentials.json` — both are gitignored
- Always validate at system boundaries (user input, external API responses) — trust nothing inbound
- Don't add new auth bypass paths or weaken the rate limiter
- If adding a new endpoint: it needs rate limiting and token verification by default

## When making security-relevant changes
- Use the `reviewer` agent after editing auth middleware, rate limiting, or session handling
- Test that a missing/invalid token still returns 401, not 500
