#!/usr/bin/env node
// Reads Claude Code tool result from stdin, writes file_path to stdout.
// Used by PostToolUse hooks to extract the edited file path.
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const filePath = (JSON.parse(data).tool_input || {}).file_path || '';
  process.stdout.write(filePath);
});
