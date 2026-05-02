#!/usr/bin/env node
/**
 * spawn-agent.js — Runtime-agnostic wrapper for spawning a CLI runtime.
 *
 * As of P-9c4f2d6a this script knows nothing CLI-specific. All binary
 * resolution, arg construction, and prompt prep flows through the runtime
 * adapter resolved from `--runtime <name>` (defaults to 'claude').
 *
 * Usage:
 *   node spawn-agent.js <prompt-file> <sysprompt-file> [--runtime <name>] [adapter opts...] [unknown args...]
 *
 * Recognized adapter opts (parsed and forwarded to `runtime.buildArgs(opts)`):
 *   --model <m>                 → opts.model
 *   --max-turns <n>             → opts.maxTurns
 *   --allowedTools <list>       → opts.allowedTools
 *   --effort <level>            → opts.effort
 *   --resume <sessionId>        → opts.sessionId
 *   --max-budget-usd <n>        → opts.maxBudget
 *   --bare                      → opts.bare = true
 *   --fallback-model <m>        → opts.fallbackModel
 *   --output-format <f>         → opts.outputFormat
 *   --verbose / --no-verbose    → opts.verbose
 *   --stream <on|off>           → opts.stream                (Copilot)
 *   --disable-builtin-mcps      → opts.disableBuiltinMcps    (Copilot)
 *   --no-custom-instructions    → opts.suppressAgentsMd      (Copilot)
 *   --enable-reasoning-summaries→ opts.reasoningSummaries    (Copilot)
 *
 * Legacy --permission-mode <X> is dropped: the new Claude adapter emits
 * `--dangerously-skip-permissions` itself, so passing the legacy flag from a
 * pre-P-2a6d9c4f engine.js would only produce a duplicate flag. Other unknown
 * args are forwarded verbatim to the runtime binary as a defensive escape
 * hatch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { runFile, cleanChildEnv, killGracefully, killImmediate, ts } = require('./shared');
const { resolveRuntime } = require('./runtimes');

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * Parse argv into { promptFile, sysPromptFile, runtimeName, opts, passthrough }.
 * Returns null when the two positional args are missing.
 */
function parseSpawnArgs(argv) {
  const args = (argv || []).slice(2);
  if (args.length < 2) return null;

  const promptFile = args[0];
  const sysPromptFile = args[1];
  let runtimeName = 'claude';
  const opts = {};
  const passthrough = [];

  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    const peek = () => args[++i];

    switch (a) {
      case '--runtime':                    runtimeName = peek(); break;
      case '--model':                      opts.model = peek(); break;
      case '--max-turns':                  opts.maxTurns = peek(); break;
      case '--allowedTools':               opts.allowedTools = peek(); break;
      case '--effort':                     opts.effort = peek(); break;
      case '--resume':                     opts.sessionId = peek(); break;
      case '--max-budget-usd':             opts.maxBudget = peek(); break;
      case '--bare':                       opts.bare = true; break;
      case '--fallback-model':             opts.fallbackModel = peek(); break;
      case '--output-format':              opts.outputFormat = peek(); break;
      case '--verbose':                    opts.verbose = true; break;
      case '--no-verbose':                 opts.verbose = false; break;
      case '--stream':                     opts.stream = peek(); break;
      case '--disable-builtin-mcps':       opts.disableBuiltinMcps = true; break;
      case '--no-custom-instructions':     opts.suppressAgentsMd = true; break;
      case '--enable-reasoning-summaries': opts.reasoningSummaries = true; break;
      // LEGACY: dropped — the runtime adapter emits its own permission flag.
      // Pre-P-2a6d9c4f engine.js still passes `--permission-mode bypassPermissions`;
      // letting it through would duplicate the permission flag for Claude.
      case '--permission-mode':            i++; break;
      default:                             passthrough.push(a); break;
    }
  }

  return { promptFile, sysPromptFile, runtimeName, opts, passthrough };
}

/**
 * Compose the final spawn invocation. Pure: no FS, no spawn. Caller is
 * responsible for writing the sysprompt tmp file (when `sysPromptFile` is
 * supplied via opts) and for cleanup.
 *
 * Returns:
 *   {
 *     bin, leadingArgs, args,         // → spawn(execPath OR bin, [bin?, ...leadingArgs, ...args])
 *     deliveryMode,                   // 'stdin' | 'arg' (runtime adapter decision)
 *     finalPrompt,                    // adapter-built prompt text (may include sysprompt for some runtimes)
 *     usingNodeShim,                  // true → runtime returned a non-native binary (Claude cli.js)
 *   }
 */
function buildSpawnInvocation({ runtime, resolved, promptText, sysPromptText, opts, passthrough, addDirs }) {
  const adapterOpts = { ...opts };
  if (Array.isArray(addDirs) && addDirs.length) adapterOpts.addDirs = addDirs;
  const finalPrompt = runtime.buildPrompt(promptText, sysPromptText, adapterOpts);
  const deliveryMode = typeof runtime.getPromptDeliveryMode === 'function'
    ? runtime.getPromptDeliveryMode(adapterOpts)
    : (runtime.capabilities && runtime.capabilities.promptViaArg ? 'arg' : 'stdin');
  if (deliveryMode === 'arg') {
    adapterOpts.prompt = finalPrompt;
  }
  const adapterArgs = runtime.buildArgs(adapterOpts);
  const { bin, native, leadingArgs = [] } = resolved;
  return {
    bin,
    native,
    leadingArgs,
    args: [...adapterArgs, ...(passthrough || [])],
    deliveryMode,
    finalPrompt,
    usingNodeShim: !native,
  };
}

function normalizeRuntimeExit(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal) return 128;
  return 1;
}

function injectAdoTokenEnv(env, { execSync: _execSync = execSync, warn = (msg) => process.stderr.write(msg + '\n') } = {}) {
  let token;
  try {
    token = String(_execSync('azureauth ado token --mode iwa --mode broker --output token --timeout 1', {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    }) || '').trim();
  } catch (err) {
    warn(`spawn-agent.js: ADO token fetch failed: ${err.message}`);
    return false;
  }
  if (!token || !token.startsWith('eyJ')) {
    warn('spawn-agent.js: invalid ADO token from azureauth; continuing without Azure DevOps PAT env');
    return false;
  }
  env.AZURE_DEVOPS_EXT_PAT = token;
  env.AZURE_DEVOPS_EXT_AZURE_RM_PAT = token;
  return true;
}

const PROCESS_EXIT_SENTINEL_FLUSH_TIMEOUT_MS = 2000;

function formatProcessExitSentinel(exitCode, signal) {
  return `\n[process-exit] code=${exitCode}${signal ? ` signal=${signal}` : ''}\n`;
}

function _appendSentinelFallback(outputPath, sentinel) {
  if (!outputPath) return false;
  try {
    fs.appendFileSync(outputPath, sentinel);
    return true;
  } catch {
    return false;
  }
}

function _writeStdoutWithTimeout(stdout, sentinel, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (flushed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(flushed);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    try {
      if (!stdout || typeof stdout.write !== 'function') {
        finish(false);
        return;
      }
      stdout.write(sentinel, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

async function writeProcessExitSentinel({
  exitCode,
  signal = null,
  stdout = process.stdout,
  outputPath = process.env.MINIONS_LIVE_OUTPUT_PATH,
  timeoutMs = PROCESS_EXIT_SENTINEL_FLUSH_TIMEOUT_MS,
} = {}) {
  const sentinel = formatProcessExitSentinel(exitCode, signal);
  const stdoutFlushed = await _writeStdoutWithTimeout(stdout, sentinel, timeoutMs);
  const outputPathWritten = stdoutFlushed ? false : _appendSentinelFallback(outputPath, sentinel);
  return { sentinel, stdoutFlushed, outputPathWritten };
}

// ─── Main script execution ──────────────────────────────────────────────────

function _installHint(name, runtime) {
  // Adapters expose `installHint` as the canonical message; fall back to a
  // generic line when an adapter without one is registered (defensive — every
  // bundled adapter sets it, but custom registrations may not).
  if (runtime && typeof runtime.installHint === 'string' && runtime.installHint) {
    return runtime.installHint;
  }
  return `${name} CLI binary not found on PATH`;
}

function main() {
  const parsed = parseSpawnArgs(process.argv);
  if (!parsed) {
    console.error('Usage: node spawn-agent.js <prompt-file> <sysprompt-file> [--runtime <name>] [args...]');
    process.exit(1);
  }
  const { promptFile, sysPromptFile, runtimeName, opts, passthrough } = parsed;

  const env = cleanChildEnv();
  injectAdoTokenEnv(env);

  let runtime;
  try { runtime = resolveRuntime(runtimeName); }
  catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(78);
  }

  const promptText = fs.readFileSync(promptFile, 'utf8');
  const sysPromptText = fs.readFileSync(sysPromptFile, 'utf8');

  // Sys prompt tmp file — only when (a) NOT resuming and (b) the adapter
  // accepts a system prompt as a separate file. For runtimes that bake the
  // system prompt into the user prompt (e.g. Copilot), sysPromptText is
  // already merged inside `runtime.buildPrompt(prompt, sys)`.
  const isResume = opts.sessionId != null;
  const sysTmpPath = sysPromptFile + '.tmp';
  const wantsSystemPromptFile = typeof runtime.usesSystemPromptFile === 'function'
    ? runtime.usesSystemPromptFile({ isResume, opts })
    : (!isResume && runtime.capabilities && runtime.capabilities.systemPromptFile);
  if (wantsSystemPromptFile) {
    fs.writeFileSync(sysTmpPath, sysPromptText);
    opts.sysPromptFile = sysTmpPath;
  }

  // Skill discovery dirs — agents run with CWD set to an external repo
  // worktree, so runtime-native global assets would otherwise be invisible.
  // The adapter owns both where those assets live and how to surface them.
  const minionsDir = path.resolve(__dirname, '..');
  const addDirs = [minionsDir];
  const runtimeAssetDirs = typeof runtime.getUserAssetDirs === 'function'
    ? runtime.getUserAssetDirs({ homeDir: os.homedir() })
    : [];
  for (const dir of runtimeAssetDirs) {
    if (dir && fs.existsSync(dir) && path.resolve(dir) !== path.resolve(minionsDir)) {
      addDirs.push(dir);
    }
  }

  let resolved;
  try { resolved = runtime.resolveBinary({ env }); }
  catch (err) {
    console.error(`FATAL: ${runtimeName} runtime resolveBinary failed: ${err.message}`);
    process.exit(78);
  }
  if (!resolved) {
    console.error(`FATAL: Cannot find ${runtimeName} CLI — ${_installHint(runtimeName, runtime)}`);
    process.exit(78);
  }

  const invocation = buildSpawnInvocation({
    runtime, resolved,
    promptText, sysPromptText,
    opts, passthrough, addDirs,
  });

  // Debug log (async — not on critical path)
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const debugPath = path.join(tmpDir, 'spawn-debug.log');
  fs.writeFile(
    debugPath,
    `spawn-agent.js at ${ts()}\nruntime=${runtimeName}\nbin=${invocation.bin}\nnative=${invocation.native}\n` +
      `leadingArgs=${invocation.leadingArgs.join(' ')}\nprompt=${promptFile}\nsysPrompt=${sysPromptFile}\n` +
      `delivery=${invocation.deliveryMode}\nargs=${invocation.args.join(' ').slice(0, 800)}\n`,
    () => {},
  );

  // Build the actual exec form. If the runtime returns a non-native binary
  // (e.g. Claude's cli.js), shim it under the current node process.
  const execBin = invocation.native ? invocation.bin : process.execPath;
  const execArgs = invocation.native
    ? [...invocation.leadingArgs, ...invocation.args]
    : [invocation.bin, ...invocation.leadingArgs, ...invocation.args];

  const proc = runFile(execBin, execArgs, { stdio: ['pipe', 'pipe', 'pipe'], env });

  fs.appendFile(debugPath, `PID=${proc.pid || 'none'}\n`, () => {});

  // Write PID file for parent engine to verify spawn (async — engine checks after 5s)
  const pidFile = promptFile.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
  fs.writeFile(pidFile, String(proc.pid || ''), () => {});

  // Deliver the prompt — stdin (Claude default) vs argv (handled by adapter).
  if (invocation.deliveryMode === 'stdin') {
    try {
      proc.stdin.write(invocation.finalPrompt);
      proc.stdin.end();
    } catch (err) {
      console.error(`FATAL: stdin write failed (broken pipe): ${err.message}`);
      fs.appendFileSync(debugPath, `STDIN ERROR: ${err.message}\n`);
      killImmediate(proc);
      process.exit(1);
    }
  } else {
    // Adapter has already spliced the prompt into argv (--prompt <text>).
    // Close stdin so the runtime doesn't wait on it.
    try { proc.stdin.end(); } catch { /* may already be closed */ }
  }

  // Clean up sys tmp (only created for non-resume sessions on adapters that
  // use --system-prompt-file).
  if (wantsSystemPromptFile) {
    setTimeout(() => { try { fs.unlinkSync(sysTmpPath); } catch { /* cleanup */ } }, 5000);
  }

  // Register exit handler to clean up orphaned temp files
  function _cleanupSpawnTempFiles() {
    if (wantsSystemPromptFile) {
      try { fs.unlinkSync(sysTmpPath); } catch { /* may already be cleaned */ }
    }
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

  // MCP startup timeout: kill if no stdout within 3 minutes
  const MCP_STARTUP_TIMEOUT = 180000; // 3 minutes
  let gotFirstOutput = false;
  const startupTimer = setTimeout(() => {
    if (!gotFirstOutput) {
      const msg = `TIMEOUT: ${runtimeName} CLI produced no output after ${MCP_STARTUP_TIMEOUT / 1000}s (likely MCP server startup stall)`;
      console.error(msg);
      fs.appendFileSync(debugPath, msg + '\n');
      killGracefully(proc);
    }
  }, MCP_STARTUP_TIMEOUT);
  proc.stdout.once('data', () => { gotFirstOutput = true; clearTimeout(startupTimer); });

  proc.on('close', async (code, signal) => {
    clearTimeout(startupTimer);
    const exitCode = normalizeRuntimeExit(code, signal);
    const sentinelResult = await writeProcessExitSentinel({ exitCode, signal });
    fs.appendFileSync(debugPath, `EXIT: code=${exitCode}${signal ? ` signal=${signal}` : ''}\nSTDERR: ${stderrBuf.slice(0, 500)}\n`);
    if (!sentinelResult.stdoutFlushed && sentinelResult.outputPathWritten) {
      fs.appendFileSync(debugPath, `EXIT SENTINEL FALLBACK: ${process.env.MINIONS_LIVE_OUTPUT_PATH}\n`);
    }
    process.exit(exitCode);
  });
  proc.on('error', async (err) => {
    fs.appendFileSync(debugPath, `ERROR: ${err.message}\n`);
    await writeProcessExitSentinel({ exitCode: 1 });
    process.exit(1);
  });
}

module.exports = { parseSpawnArgs, buildSpawnInvocation, normalizeRuntimeExit, injectAdoTokenEnv, writeProcessExitSentinel };

if (require.main === module) main();
