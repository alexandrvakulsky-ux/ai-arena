#!/usr/bin/env node
// Reads Claude Code tool result from stdin, emits skill suggestion as systemMessage
// based on which file was edited. Used by PostToolUse hooks.
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  let filePath = '';
  try { filePath = (JSON.parse(data).tool_input || {}).file_path || ''; } catch (_) { process.exit(0); }
  let message = null;

  if (filePath.includes('public/') || filePath.endsWith('.html') || filePath.endsWith('.css')) {
    message = 'Frontend file edited — consider running /ui-design-review and /web-design-guidelines before marking done.';
  } else if (filePath.includes('server.js') || filePath.includes('/api/') || filePath.includes('route')) {
    message = 'API file edited — consider running /api-design-reviewer and /deploy-check before marking done.';
  }

  if (message) {
    process.stdout.write(JSON.stringify({ systemMessage: message }));
  }
});
