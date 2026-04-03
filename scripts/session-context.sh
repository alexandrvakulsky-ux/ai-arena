#!/usr/bin/env node
/**
 * Generates a context briefing at session start.
 * Output: JSON with systemMessage that Claude sees before the user speaks.
 * Called by SessionStart hook in .claude/settings.json.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SESSIONS_DIR = '/workspace/.claude/sessions';
const RULES_DIR = '/workspace/.claude/rules';

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; }
}

// --- Recent sessions (last 2 days, max 4 files, 60 lines each) ---
let recentSessions = '';
if (fs.existsSync(SESSIONS_DIR)) {
  const today = new Date();
  const yesterday = new Date(today - 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const validDates = [fmt(today), fmt(yesterday)];

  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.md') && f !== '.gitkeep')
    .sort().reverse()
    .filter(f => validDates.some(d => f.startsWith(d)))
    .slice(0, 4);

  for (const f of files) {
    const content = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
    const lines = content.split('\n').slice(0, 60).join('\n');
    recentSessions += `\n--- ${f} ---\n${lines}\n`;
  }
}

// --- System health ---
const procCount = run("ps aux 2>/dev/null | wc -l") || '?';
const zombieCount = run("ps -eo stat 2>/dev/null | grep -c '^Z'") || '0';
let healthStatus = `Processes: ${procCount} total, ${zombieCount} zombies`;
if (parseInt(zombieCount) > 10) healthStatus += ' [WARNING: zombie accumulation]';

// --- Server status ---
const httpCode = run("curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>/dev/null") || '000';
const serverStatus = httpCode === '200' ? 'Server: running (port 3000)' : `Server: NOT responding (HTTP ${httpCode})`;

// --- Rules list ---
let rulesList = '';
if (fs.existsSync(RULES_DIR)) {
  rulesList = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.md')).join(', ');
}

// --- Build briefing ---
const briefing = `SESSION CONTEXT BRIEFING (auto-generated)
============================================
Date: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC
${healthStatus}
${serverStatus}
Rules loaded: ${rulesList}
Docs: CLAUDE.md, CONTAINER-OPS.md, rules/*.md

RECENT SESSION HISTORY (last 2 days):
${recentSessions || 'No recent sessions found.'}

REMINDERS:
- Read CLAUDE.md Session Start Protocol if unsure about anything
- Act autonomously. Only escalate critical decisions to user.
- Document significant findings in .claude/sessions/
============================================`;

// Output as proper JSON
console.log(JSON.stringify({ systemMessage: briefing }));
