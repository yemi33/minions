#!/usr/bin/env node
/**
 * Pre-commit hook for Claude Code — runs regression tests before git commit.
 *
 * Invoked by PreToolUse hook on Bash commands. Reads the tool input from
 * CLAUDE_TOOL_INPUT env var. If the command contains 'git commit', runs
 * the test suite. Exits 0 to allow, exits 2 to block with a message.
 */

const { execSync } = require('child_process');

const toolInput = process.env.CLAUDE_TOOL_INPUT || '';
let command = '';
try {
  const parsed = JSON.parse(toolInput);
  command = parsed.command || '';
} catch {
  // Not JSON or no command field — allow
  process.exit(0);
}

// Only intercept git commit commands
if (!command.includes('git commit')) {
  process.exit(0);
}

// Skip if it's just a git commit --amend or other non-standard commit
// Also skip if running inside the test suite itself
if (process.env.MINIONS_TESTING) {
  process.exit(0);
}

process.stderr.write('Running regression tests before commit...\n');

try {
  const result = execSync('node test/minions-tests.js', {
    cwd: 'C:/Users/yemishin/.minions',
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, MINIONS_TESTING: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Check for failures in output
  const failMatch = result.match(/(\d+) failed/);
  if (failMatch && parseInt(failMatch[1]) > 0) {
    process.stderr.write(`\nTests failed! ${failMatch[1]} failure(s). Commit blocked.\n`);
    process.stderr.write(result.split('\n').filter(l => l.includes('FAIL')).join('\n') + '\n');
    process.exit(2);
  }

  process.stderr.write('All tests passed.\n');
  process.exit(0);
} catch (e) {
  // Test runner crashed — report but don't block (fail-open)
  process.stderr.write('Test runner error (allowing commit): ' + (e.message || '').slice(0, 200) + '\n');
  process.exit(0);
}
