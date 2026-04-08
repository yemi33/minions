#!/usr/bin/env node
/**
 * spawn-agent.js — Wrapper to spawn claude CLI safely
 * Reads prompt and system prompt from files, avoiding shell metacharacter issues.
 *
 * Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [claude-args...]
 */

const fs = require('fs');
const path = require('path');
const { exec, runFile, cleanChildEnv, killGracefully, killImmediate, ts, safeJson, safeWrite } = require('./shared');

const [,, promptFile, sysPromptFile, ...extraArgs] = process.argv;

if (!promptFile || !sysPromptFile) {
  console.error('Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [args...]');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
const sysPrompt = fs.readFileSync(sysPromptFile, 'utf8');

const env = cleanChildEnv();

// Resolve claude binary — supports both npm install (cli.js) and native installer (binary on PATH)
let claudeBin;
let claudeIsNative = false; // true = native binary, false = node cli.js
const capsCachePath = path.join(__dirname, 'claude-caps.json');
let _sysPromptFileSupported = null;

// Fast path: use cached binary path if it still exists on disk
const caps = safeJson(capsCachePath);
if (caps?.claudeBin && fs.existsSync(caps.claudeBin)) {
  claudeBin = caps.claudeBin;
  claudeIsNative = !!caps.claudeIsNative;
  _sysPromptFileSupported = caps.sysPromptFile ?? null;
}

// Strategy 1: Check if `claude` is on PATH (native installer or npm global bin)
if (!claudeBin) try {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where claude 2>NUL' : 'which claude 2>/dev/null';
  const which = exec(cmd, { encoding: 'utf8', env, timeout: 10000 }).trim().split('\n')[0].trim();
  if (which) {
    const whichNative = isWin ? which : which.replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':/').replace(/\//g, path.sep);
    // Check if it's a node wrapper (npm install) or native binary
    try {
      const content = fs.readFileSync(whichNative, 'utf8');
      // npm wrapper scripts reference cli.js — extract the path
      const m = content.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/);
      if (m) {
        const candidate = path.join(path.dirname(whichNative), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(candidate)) { claudeBin = candidate; }
      }
    } catch {
      // Can't read as text — it's a compiled binary
    }
    if (!claudeBin) {
      // Native binary or wrapper without cli.js reference — use directly
      claudeBin = whichNative;
      claudeIsNative = true;
    }
  }
} catch { /* optional */ }

// Strategy 2: Known node_modules locations (npm global installs)
if (!claudeBin) {
  const searchPaths = [
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js') : '',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ].filter(Boolean);
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) { claudeBin = p; break; } } catch {}
  }
}

// Strategy 3: npm root -g
if (!claudeBin) {
  try {
    const globalRoot = exec('npm root -g', { encoding: 'utf8', env, timeout: 10000 }).trim();
    const candidate = path.join(globalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(candidate)) claudeBin = candidate;
  } catch { /* optional */ }
}

// Debug log (async — not on critical path)
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const debugPath = path.join(tmpDir, 'spawn-debug.log');
fs.writeFile(debugPath, `spawn-agent.js at ${ts()}\nclaudeBin=${claudeBin || 'not found'}\nnative=${claudeIsNative}\nprompt=${promptFile}\nsysPrompt=${sysPromptFile}\nextraArgs=${extraArgs.join(' ')}\n`, () => {});

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

// --system-prompt-file is supported in all Claude CLI versions (not listed in --help but works)
let actualArgs = cliArgs;
// Save binary path cache (no capability check needed — spawnSync for --help was a bottleneck)
if (_sysPromptFileSupported === null) {
  _sysPromptFileSupported = true;
  try { safeWrite(capsCachePath, { claudeBin, claudeIsNative, sysPromptFile: true }); } catch {}
}

const proc = claudeIsNative
  ? runFile(claudeBin, actualArgs, { stdio: ['pipe', 'pipe', 'pipe'], env })
  : runFile(process.execPath, [claudeBin, ...actualArgs], { stdio: ['pipe', 'pipe', 'pipe'], env });

fs.appendFile(debugPath, `PID=${proc.pid || 'none'}\nargs=${actualArgs.join(' ').slice(0, 500)}\n`, () => {});

// Write PID file for parent engine to verify spawn
const pidFile = promptFile.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
fs.writeFileSync(pidFile, String(proc.pid || ''));

// Send prompt via stdin — if system prompt was truncated, prepend the full context
try {
  if (!isResume && Buffer.byteLength(sysPrompt) >= 30000) {
    // System prompt was too large for CLI — prepend full context to user prompt
    proc.stdin.write(`## Full Agent Context\n\n${sysPrompt}\n\n---\n\n## Your Task\n\n${prompt}`);
  } else {
    proc.stdin.write(prompt);
  }
  proc.stdin.end();
} catch (err) {
  console.error(`FATAL: stdin write failed (broken pipe): ${err.message}`);
  fs.appendFileSync(debugPath, `STDIN ERROR: ${err.message}\n`);
  killImmediate(proc);
  process.exit(1);
}

// Clean up temp file (only created for non-resume sessions)
if (!isResume) setTimeout(() => { try { fs.unlinkSync(sysTmpPath); } catch { /* cleanup */ } }, 5000);

// Register exit handler to clean up orphaned temp files (system prompt tmp)
function _cleanupSpawnTempFiles() {
  try { fs.unlinkSync(sysTmpPath); } catch { /* may already be cleaned */ }
}
process.on('exit', _cleanupSpawnTempFiles);
process.on('SIGTERM', () => { _cleanupSpawnTempFiles(); process.exit(143); });

// Capture stderr separately for debugging
let stderrBuf = '';
proc.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString();
  process.stderr.write(chunk);
});

// Pipe stdout to parent
proc.stdout.pipe(process.stdout);

// MCP startup timeout: kill if no stdout within 3 minutes (MCP servers downloading/starting)
const MCP_STARTUP_TIMEOUT = 180000; // 3 minutes
let gotFirstOutput = false;
const startupTimer = setTimeout(() => {
  if (!gotFirstOutput) {
    const msg = `TIMEOUT: Claude CLI produced no output after ${MCP_STARTUP_TIMEOUT / 1000}s (likely MCP server startup stall)`;
    console.error(msg);
    fs.appendFileSync(debugPath, msg + '\n');
    killGracefully(proc);
  }
}, MCP_STARTUP_TIMEOUT);
proc.stdout.once('data', () => { gotFirstOutput = true; clearTimeout(startupTimer); });

proc.on('close', (code) => {
  clearTimeout(startupTimer);
  fs.appendFileSync(debugPath, `EXIT: code=${code}\nSTDERR: ${stderrBuf.slice(0, 500)}\n`);
  process.exit(code || 0);
});
proc.on('error', (err) => {
  fs.appendFileSync(debugPath, `ERROR: ${err.message}\n`);
  process.exit(1);
});
