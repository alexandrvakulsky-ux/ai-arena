#!/usr/bin/env node
// Reads Claude Code tool result from stdin, emits skill suggestion as systemMessage
// based on which file was edited. Works from any project directory.
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const filePath = (JSON.parse(data).tool_input || {}).file_path || '';
  let message = null;

  if (/\.(html|css)$/.test(filePath) || filePath.includes('/public/') || filePath.includes('/components/') || filePath.includes('/pages/')) {
    message = 'Frontend file edited — consider running /ui-design-review and /web-design-guidelines before marking done.';
  } else if (/server\.(js|ts)$/.test(filePath) || filePath.includes('/api/') || filePath.includes('/routes/') || filePath.includes('/controllers/')) {
    message = 'API/server file edited — consider running /api-design-reviewer and /deploy-check before marking done.';
  } else if (/\.(test|spec)\.(js|ts)$/.test(filePath)) {
    message = 'Test file edited — remember: watch the test FAIL before implementing (TDD red phase).';
  }

  if (message) {
    process.stdout.write(JSON.stringify({ systemMessage: message }));
  }
});
