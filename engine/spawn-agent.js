#!/usr/bin/env node
/**
 * spawn-agent.js — Wrapper to spawn claude CLI safely
 * Reads prompt and system prompt from files, avoiding shell metacharacter issues.
 *
 * Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [claude-args...]
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [,, promptFile, sysPromptFile, ...extraArgs] = process.argv;

if (!promptFile || !sysPromptFile) {
  console.error('Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [args...]');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
const sysPrompt = fs.readFileSync(sysPromptFile, 'utf8');

// Clean CLAUDECODE env vars
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
for (const key of Object.keys(env)) {
  if (key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete env[key];
}

// Resolve claude binary — find the actual JS entry point
let claudeBin;
const searchPaths = [
  // npm global install locations
  path.join(process.env.npm_config_prefix || '', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  'C:/.tools/.npm-global/node_modules/@anthropic-ai/claude-code/cli.js',
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
];
for (const p of searchPaths) {
  if (p && fs.existsSync(p)) { claudeBin = p; break; }
}
// Fallback: parse the shell wrapper
if (!claudeBin) {
  try {
    const which = execSync('bash -c "which claude"', { encoding: 'utf8', env }).trim();
    const wrapper = execSync(`bash -c "cat '${which}'"`, { encoding: 'utf8', env });
    const m = wrapper.match(/node_modules\/@anthropic-ai\/claude-code\/cli\.js/);
    if (m) {
      const basedir = path.dirname(which.replace(/^\/c\//, 'C:/').replace(/\//g, path.sep));
      claudeBin = path.join(basedir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    }
  } catch {}
}

// Debug log
const debugPath = path.join(__dirname, 'spawn-debug.log');
fs.writeFileSync(debugPath, `spawn-agent.js at ${new Date().toISOString()}\nclaudeBin=${claudeBin || 'not found'}\nprompt=${promptFile}\nsysPrompt=${sysPromptFile}\nextraArgs=${extraArgs.join(' ')}\n`);

const cliArgs = ['-p', '--system-prompt', sysPrompt, ...extraArgs];

if (!claudeBin) {
  fs.appendFileSync(debugPath, 'FATAL: Cannot find claude-code cli.js\n');
  process.exit(1);
}

const proc = spawn(process.execPath, [claudeBin, ...cliArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env
});

fs.appendFileSync(debugPath, `PID=${proc.pid || 'none'}\n`);

// Write PID file for parent engine to verify spawn
const pidFile = promptFile.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
fs.writeFileSync(pidFile, String(proc.pid || ''));

// Send prompt via stdin
proc.stdin.write(prompt);
proc.stdin.end();

// Pipe stdout/stderr to parent
proc.stdout.pipe(process.stdout);
proc.stderr.pipe(process.stderr);

proc.on('close', (code) => {
  fs.appendFileSync(debugPath, `EXIT: code=${code}\n`);
  process.exit(code || 0);
});
proc.on('error', (err) => {
  fs.appendFileSync(debugPath, `ERROR: ${err.message}\n`);
  process.exit(1);
});
