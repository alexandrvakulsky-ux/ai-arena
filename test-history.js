#!/usr/bin/env node
// Tests history save/load and multi-turn conversation flow
// Usage: node test-history.js

const puppeteer = require('/usr/local/share/npm-global/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer');

const BASE = 'http://localhost:3000';
const PASS = ['/tmp/test-history-1.png', '/tmp/test-history-2.png', '/tmp/test-history-3.png', '/tmp/test-history-4.png'];
let step = 0;

function log(msg, ok = true) {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
}

async function shot(page, label) {
  const file = PASS[step++];
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  [screenshot ${step}] ${label} → ${file}`);
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // ── 1. Load app ──────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 15000 });
  await shot(page, 'initial load');
  log('App loaded');

  // ── 2. Inject mock history into localStorage ─────────────────
  // Simulates a previous session with 2 turns
  const mockHistory = [
    {
      sessionId: 'test-session-abc',
      question: 'What is the capital of France?',
      timestamp: Date.now() - 60000,
      answers: {
        claude: 'Paris is the capital of France.',
        openai: 'The capital of France is Paris.',
        gemini: 'Paris. It has been the capital since 987 AD.'
      }
    },
    {
      sessionId: 'test-session-abc',
      question: 'And what is its population?',
      timestamp: Date.now() - 30000,
      answers: {
        claude: 'Paris has about 2.1 million people in the city proper.',
        openai: 'The population of Paris is approximately 2.1 million.',
        gemini: 'Paris proper has around 2.1 million inhabitants.'
      }
    }
  ];

  await page.evaluate((hist) => {
    localStorage.setItem('ai_arena_history', JSON.stringify(hist));
  }, mockHistory);

  log('Injected mock history (2 turns)');

  // ── 3. Reload to pick up injected history ────────────────────
  await page.reload({ waitUntil: 'networkidle0' });
  await shot(page, 'after history inject');

  // ── 4. Check history list renders ───────────────────────────
  await page.waitForSelector('#historyList', { timeout: 5000 });
  const historyItems = await page.$$('.history-item');
  if (historyItems.length > 0) {
    log(`History list shows ${historyItems.length} item(s)`);
  } else {
    log('History list is empty — items not rendering', false);
  }

  // ── 5. Click the history item ────────────────────────────────
  if (historyItems.length > 0) {
    await historyItems[0].click();
    await new Promise(r => setTimeout(r, 800));
    await shot(page, 'after clicking history item');

    // Check if answers are shown
    const panels = await page.$$('.response-panel, .model-response, [class*="response"]');
    log(`Response panels visible: ${panels.length}`);

    // Check if question input shows follow-up placeholder
    const placeholder = await page.$eval('#questionInput', el => el.placeholder).catch(() => '');
    log(`Input placeholder: "${placeholder}"`);
  }

  // ── 6. Check multi-turn context in UI ────────────────────────
  const turnCount = await page.$eval('.history-item-meta', el => el.textContent).catch(() => '');
  log(`Turn count display: "${turnCount.trim()}"`);

  // ── 7. Test API directly for multi-turn ──────────────────────
  console.log('\n── API multi-turn test ──');
  const tokenRes = await page.evaluate(async () => {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '' })
    });
    return r.json();
  });

  if (tokenRes.token) {
    log('Got session token');

    // Send a question with history context
    const apiRes = await page.evaluate(async (token) => {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-token': token },
        body: JSON.stringify({
          question: 'And what language do they speak there?',
          models: ['claude'],
          history: [
            { role: 'user', content: 'What is the capital of France?' },
            { role: 'assistant', content: 'Paris is the capital of France.' }
          ]
        })
      });
      return r.json();
    }, tokenRes.token);

    if (apiRes.claude && !apiRes.claude.error) {
      log(`Multi-turn API response received (claude): "${apiRes.claude.text?.slice(0, 80)}..."`);
    } else {
      log(`Multi-turn API failed: ${JSON.stringify(apiRes.claude)}`, false);
    }
  } else {
    log('Could not get token', false);
  }

  await shot(page, 'final state');
  await browser.close();

  console.log('\nScreenshots saved to /tmp/test-history-*.png');
})().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
