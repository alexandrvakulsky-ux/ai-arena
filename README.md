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

## Deploying to the web

### Option A — Railway (easiest, free tier)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add your API keys as environment variables in Railway's dashboard
4. Done — Railway gives you a public URL

### Option B — Render (free tier)
1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env vars in Render's dashboard

### Option C — Fly.io
```bash
npm install -g flyctl
fly launch
fly secrets set ANTHROPIC_API_KEY=sk-ant-... OPENAI_API_KEY=sk-... GOOGLE_API_KEY=AIza-...
fly deploy
```

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
