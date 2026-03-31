---
name: deploy-check
description: Verify AI Arena is healthy — server responds, all 3 API providers work, git is clean, Railway is in sync. Use after finishing any change or before calling something done.
tools: Bash
---

# Deploy Check

## Goal
Confirm the app is working end-to-end and the deployment is clean.

## Process

1. **Server running?**
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`
   - If not 200: note it, skip live API tests, continue with git checks

2. **Auth endpoint**
   - `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/verify -H "x-app-token: test"`
   - Expect 401 (not 500) — confirms server is handling requests

3. **Ask endpoint (all 3 providers)**
   - First get a valid token: `curl -s -X POST http://localhost:3000/api/auth -H "Content-Type: application/json" -d "{\"password\":\"$(grep APP_PASSWORD /workspace/.env | cut -d= -f2)\"}" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token||''))"`
   - POST to `/api/ask` with the token in `x-app-token` header and `{"question":"What is 1+1?","models":["claude","openai","gemini"]}`
   - Confirm all 3 return a response (not error/timeout)
   - Note any provider that fails or times out

4. **Git status**
   - `git status --short` — confirm clean
   - `git log --oneline -3` — show last 3 commits
   - `git log origin/main..HEAD --oneline` — show any commits not yet pushed/deployed

5. **Report**
   - One-line status per check: ✓ or ✗ + detail
   - List any issues with a concrete suggested fix
