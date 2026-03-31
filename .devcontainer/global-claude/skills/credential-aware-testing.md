---
name: credential-aware-testing
description: Use when writing curl commands, test scripts, or any code that hits authenticated endpoints. Always extract real credentials from .env — never write placeholder commands that will silently 401.
---

# Credential-Aware Testing

## The Mistake This Prevents

Writing a test command like:
```bash
curl -H "x-app-token: YOUR_TOKEN_HERE" http://localhost:3000/api/ask
```

This looks correct but silently fails with 401 every time. The test is useless. Worse — it gives false confidence that you verified something when you didn't.

## The Rule

**Never write a test command with a placeholder credential.** Always extract the real value.

## How to Get Real Credentials

**For .env-based secrets:**
```bash
# Get APP_PASSWORD
grep '^APP_PASSWORD' .env | cut -d= -f2

# Get an auth token by actually calling the auth endpoint
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$(grep '^APP_PASSWORD' .env | cut -d= -f2)\"}" \
  | node -e "let d='';process.stdin.resume();process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token||'FAILED'))")

# Then use it
curl -H "x-app-token: $TOKEN" http://localhost:3000/api/verify
```

**For API keys:**
```bash
grep '^ANTHROPIC_API_KEY' .env | cut -d= -f2
```

## Checklist Before Writing Any Test Command

- [ ] Does this endpoint require auth? If yes — extract the real token, don't use a placeholder
- [ ] Does extracting the credential require a prior API call (e.g., login)? If yes — chain the commands
- [ ] Will this command actually work if run right now, as written? If not — fix it before including it

## Signs You're About to Make This Mistake

- Writing `Bearer <token>` or `x-app-token: test` or any angle-bracket placeholder
- Writing a curl example "for illustration" without noting it won't run
- Copying a curl from docs without checking if auth is required

## Applied to This Project (AI Arena)

The `/api/ask`, `/api/synthesize`, and `/api/verify` endpoints all require a valid `x-app-token`. To test them:

1. Make sure server is running: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`
2. Get token: `curl -s -X POST http://localhost:3000/api/auth -H "Content-Type: application/json" -d "{\"password\":\"$(grep '^APP_PASSWORD' /workspace/.env | cut -d= -f2)\"}"`
3. Use token in subsequent requests
