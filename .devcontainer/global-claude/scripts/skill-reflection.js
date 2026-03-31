#!/usr/bin/env node
// Fires at session Stop. Prompts skill reflection before ending.
// Outputs a systemMessage reminding to capture any skill lessons from this session.
const msg = [
  'Before this session ends — quick skill check:',
  '1. Did any skill prevent a mistake or catch something you would have missed? → refine it with the specific lesson',
  '2. Did you make a mistake that an existing skill should have caught but didn\'t? → update that skill now',
  '3. Did you hit a situation no skill covered? → add one to ~/.claude/skills/',
  '4. Did any skill fire but feel too generic / not quite right? → sharpen its trigger or body',
  'If none of the above: skip. If any: update the skill file before stopping.',
].join('\n');

process.stdout.write(JSON.stringify({ systemMessage: msg }));
