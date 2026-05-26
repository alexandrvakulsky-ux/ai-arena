# AI Arena 🤖⚔️

Ask a question → get answers from Claude, ChatGPT, and Gemini → Claude analyzes, compares, and synthesizes the best possible answer.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add your API keys
```bash
cp .env.example .env
```
Open `.env` and fill in your keys:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-key-here
GOOGLE_API_KEY=AIza-your-key-here
```

### 3. Run the server
```bash
npm start
```

Open http://localhost:3000 in your browser.

> First visit: you'll create a password to protect the app.

---

## Develop in the cloud (GitHub Codespaces)

You can work entirely in GitHub without a local clone:

1. Open the repo on GitHub → **Code** → **Codespaces** → **Create codespace on main** (or your branch).
2. On each start, `.devcontainer` runs **`scripts/codespace-bootstrap.sh`**: `npm install`, ensures `.env`, then starts the app in the background on port **3000** if nothing is already listening.
3. **API keys (pick one):**
   - Add [Codespaces secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-secrets-for-your-codespaces) named **`ANTHROPIC_API_KEY`**, **`OPENAI_API_KEY`**, **`GOOGLE_API_KEY`** (optional: **`APP_PASSWORD`**, **`PORT`**). They become environment variables; the first time `.env` is missing/empty, the bootstrap writes `.env` from them.
   - Or edit `.env` manually once; it is gitignored and persists in the codespace.
4. Open the forwarded URL for port **3000** from the **Ports** tab (or the notification).
5. If the server did not start, run `npm run codespace:boot` or check `tail -f /tmp/ai-arena-server.log`.

---

## Deploying to the web

### Production (active): Hetzner VPS
Lives at **http://135.181.153.92:3000**. Runs inside the `ai-arena`
Docker container on the same Hetzner host as ad-spy.

Auto-deploy is handled by `scripts/prod-supervisor.sh`:
- Polls `origin/main` every 60s; on a new commit, pulls + restarts.
- Auto-restarts `node server.js` on crash (3s backoff).
- Logs to `/workspace/server.log` (append-mode).

To start the supervisor after a container rebuild:
```bash
nohup bash /workspace/scripts/prod-supervisor.sh > /workspace/supervisor.log 2>&1 &
disown
```

### Other free hosts (if self-hosting isn't desired)
- **Render**: New Web Service → connect repo → build `npm install`, start `npm start`.
- **Fly.io**: `fly launch && fly secrets set ANTHROPIC_API_KEY=... && fly deploy`.

> Railway hosting was retired on 2026-05-26 — the Hetzner deploy is
> the canonical production now. The old `ai-arena-production-92e7.up.railway.app`
> URL is no longer maintained.

---

## Project structure

```
ai-arena/
├── server.js          ← Express backend (holds API keys)
├── public/
│   └── index.html     ← Frontend (no keys here!)
├── .env               ← Your secret keys (never commit this)
├── .env.example       ← Template
├── .gitignore         ← Ignores .env and node_modules
└── package.json
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ask` | Sends question to all 3 models |
| POST | `/api/synthesize` | Claude analyzes + synthesizes responses |
