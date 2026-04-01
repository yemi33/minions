#!/usr/bin/env node
/**
 * spawn-agent.js — Wrapper to spawn claude CLI safely
 * Reads prompt and system prompt from files, avoiding shell metacharacter issues.
 *
 * Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [claude-args...]
 */

const fs = require('fs');
const path = require('path');
const { exec, runFile, cleanChildEnv } = require('./shared');

const [,, promptFile, sysPromptFile, ...extraArgs] = process.argv;

if (!promptFile || !sysPromptFile) {
  console.error('Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [args...]');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
const sysPrompt = fs.readFileSync(sysPromptFile, 'utf8');

const env = cleanChildEnv();

// Resolve claude binary — find the actual JS entry point
let claudeBin;
const searchPaths = [
  // npm global install locations (platform-adaptive)
  path.join(process.env.npm_config_prefix || '', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  // Unix global locations
  '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
];
for (const p of searchPaths) {
  if (p && fs.existsSync(p)) { claudeBin = p; break; }
}
// Fallback: parse the shell wrapper
if (!claudeBin) {
  try {
    const which = exec('bash -c "which claude"', { encoding: 'utf8', env }).trim();
    const whichNative = which.replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':/').replace(/\//g, path.sep);
    const wrapper = fs.readFileSync(whichNative, 'utf8');
    const m = wrapper.match(/node_modules\/@anthropic-ai\/claude-code\/cli\.js/);
    if (m) {
      const basedir = path.dirname(whichNative);
      claudeBin = path.join(basedir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    }
  } catch { /* optional */ }
}

// Debug log
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const debugPath = path.join(tmpDir, 'spawn-debug.log');
fs.writeFileSync(debugPath, `spawn-agent.js at ${new Date().toISOString()}\nclaudeBin=${claudeBin || 'not found'}\nprompt=${promptFile}\nsysPrompt=${sysPromptFile}\nextraArgs=${extraArgs.join(' ')}\n`);

// When resuming a session, skip system prompt (it's baked into the session)
const isResume = extraArgs.includes('--resume');
const sysTmpPath = sysPromptFile + '.tmp';
let cliArgs;
if (isResume) {
  cliArgs = ['-p', ...extraArgs];
} else {
  // Pass system prompt via file to avoid ENAMETOOLONG on Windows (32KB arg limit)
  fs.writeFileSync(sysTmpPath, sysPrompt);
  cliArgs = ['-p', '--system-prompt-file', sysTmpPath, ...extraArgs];
}

if (!claudeBin) {
  const msg = 'FATAL: Cannot find claude-code cli.js — install with: npm install -g @anthropic-ai/claude-code';
  fs.appendFileSync(debugPath, msg + '\n');
  console.error(msg);
  process.exit(78); // 78 = configuration error (distinct from runtime failures)
}

// Check if --system-prompt-file is supported (cached to avoid spawning claude --help every call)
let actualArgs = cliArgs;
const capsCachePath = path.join(__dirname, 'claude-caps.json');
let _sysPromptFileSupported = null;
try {
  const caps = JSON.parse(fs.readFileSync(capsCachePath, 'utf8'));
  if (caps.claudeBin === claudeBin) _sysPromptFileSupported = caps.sysPromptFile;
} catch {}
if (_sysPromptFileSupported === null) {
  try {
    const { spawnSync } = require('child_process');
    const testResult = spawnSync(process.execPath, [claudeBin, '--help'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    _sysPromptFileSupported = (testResult.stdout || '').includes('system-prompt-file');
    try { fs.writeFileSync(capsCachePath, JSON.stringify({ claudeBin, sysPromptFile: _sysPromptFileSupported, checkedAt: new Date().toISOString() })); } catch { /* optional */ }
  } catch { _sysPromptFileSupported = true; /* assume supported */ }
}
if (!isResume) try {
  if (!_sysPromptFileSupported) {
    // Not supported — fall back to inline but safe: use --append-system-prompt with chunking
    // or just inline if under 30KB
    fs.unlinkSync(sysTmpPath);
    if (Buffer.byteLength(sysPrompt) < 30000) {
      actualArgs = ['-p', '--system-prompt', sysPrompt, ...extraArgs];
    } else {
      // Too large for inline — split: short identity as --system-prompt, rest prepended to user prompt
      // Extract first section (agent identity) as the system prompt, rest goes into user context
      const splitIdx = sysPrompt.indexOf('\n---\n');
      const shortSys = splitIdx > 0 && splitIdx < 2000
        ? sysPrompt.slice(0, splitIdx)
        : sysPrompt.slice(0, 1500) + '\n\n[System prompt truncated for CLI arg limit — full context provided below in user message]';
      actualArgs = ['-p', '--system-prompt', shortSys, ...extraArgs];
    }
  }
} catch {
  // If help check fails, try file approach anyway
}

const proc = runFile(process.execPath, [claudeBin, ...actualArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env
});

fs.appendFileSync(debugPath, `PID=${proc.pid || 'none'}\nargs=${actualArgs.join(' ').slice(0, 500)}\n`);

// Write PID file for parent engine to verify spawn
const pidFile = promptFile.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
fs.writeFileSync(pidFile, String(proc.pid || ''));

// Send prompt via stdin — if system prompt was truncated, prepend the full context
if (!isResume && Buffer.byteLength(sysPrompt) >= 30000) {
  // System prompt was too large for CLI — prepend full context to user prompt
  proc.stdin.write(`## Full Agent Context\n\n${sysPrompt}\n\n---\n\n## Your Task\n\n${prompt}`);
} else {
  proc.stdin.write(prompt);
}
proc.stdin.end();

// Clean up temp file (only created for non-resume sessions)
if (!isResume) setTimeout(() => { try { fs.unlinkSync(sysTmpPath); } catch { /* cleanup */ } }, 5000);

// Capture stderr separately for debugging
let stderrBuf = '';
proc.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(chunk);
});

// Pipe stdout to parent
proc.stdout.pipe(process.stdout);

proc.on('close', (code) => {
  fs.appendFileSync(debugPath, `EXIT: code=${code}\nSTDERR: ${stderrBuf.slice(0, 500)}\n`);
  process.exit(code || 0);
});
proc.on('error', (err) => {
  fs.appendFileSync(debugPath, `ERROR: ${err.message}\n`);
  process.exit(1);
});
