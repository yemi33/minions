/**
 * engine/llm.js — Shared LLM utilities for Minions engine + dashboard.
 *
 * Provides callLLM() / callLLMStreaming() (with optional session resume) and
 * trackEngineUsage(). As of P-5e1b7a3c the CC / doc-chat direct-spawn path
 * goes through the runtime adapter registry — same model used by the agent
 * dispatch path (P-2a6d9c4f). This file holds zero `runtime.name === ...`
 * branches; conditional behavior gates exclusively on `runtime.capabilities.*`
 * flags or on event-shape inspection inside the streaming accumulator.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const {
  safeWrite, safeUnlink, uid, ts, runFile, cleanChildEnv,
  parseStreamJsonOutput, mutateJsonFileLocked, appendTextTail,
  ENGINE_DEFAULTS,
  resolveCcCli, resolveCcModel,
} = shared;
const { resolveRuntime } = require('./runtimes');

const MINIONS_DIR = shared.MINIONS_DIR;
const ENGINE_DIR = path.join(MINIONS_DIR, 'engine');
const COPILOT_TASK_COMPLETE_GRACE_MS = 3000;
const MISSING_RUNTIME_EXIT_CODE = 78;
// When the spawned process emits 'exit' but 'close' is delayed (a detached
// grandchild inherited stdio), wait this long for trailing stdout data to
// drain into our buffer before finalizing on the exit fallback path. 'close'
// is preferred; this is a safety net so callers don't hang on inherited pipes.
const EXIT_DRAIN_FALLBACK_MS = 100;

// ─── Engine-Usage Metrics ────────────────────────────────────────────────────
//
// Updates accumulate in an in-memory buffer and flush every
// metricsFlushIntervalMs (default 10s). Replaces the per-call mutateJsonFileLocked
// that was both serializing the LLM hot path and bumping metrics.json mtime
// on every call — defeating the dashboard fast-state mtime-based early-exit.

let _pendingMetrics = { engine: Object.create(null), daily: Object.create(null) };
let _flushTimer = null;

function _emptyEngineDelta() {
  return { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalDurationMs: 0, timedCalls: 0 };
}

function _emptyDailyDelta() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 };
}

function _ensureFlushTimer() {
  if (_flushTimer) return;
  const interval = shared.ENGINE_DEFAULTS.metricsFlushIntervalMs || 10000;
  _flushTimer = setInterval(flushMetricsBuffer, interval);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

function trackEngineUsage(category, usage) {
  if (!usage) return;
  if (category && (category.startsWith('_test') || category.startsWith('test-'))) return;

  if (!_pendingMetrics.engine[category]) _pendingMetrics.engine[category] = _emptyEngineDelta();
  const cat = _pendingMetrics.engine[category];
  cat.calls++;
  cat.costUsd += usage.costUsd || 0;
  cat.inputTokens += usage.inputTokens || 0;
  cat.outputTokens += usage.outputTokens || 0;
  cat.cacheRead += usage.cacheRead || 0;
  cat.cacheCreation += usage.cacheCreation || 0;
  if (usage.durationMs) {
    cat.totalDurationMs += usage.durationMs;
    cat.timedCalls += 1;
  }

  const today = ts().slice(0, 10);
  if (!_pendingMetrics.daily[today]) _pendingMetrics.daily[today] = _emptyDailyDelta();
  const daily = _pendingMetrics.daily[today];
  daily.costUsd += usage.costUsd || 0;
  daily.inputTokens += usage.inputTokens || 0;
  daily.outputTokens += usage.outputTokens || 0;
  daily.cacheRead += usage.cacheRead || 0;

  _ensureFlushTimer();
}

function flushMetricsBuffer() {
  const pending = _pendingMetrics;
  if (!Object.keys(pending.engine).length && !Object.keys(pending.daily).length) return;
  _pendingMetrics = { engine: Object.create(null), daily: Object.create(null) };

  try {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    mutateJsonFileLocked(metricsPath, (metrics) => {
      if (!metrics._engine) metrics._engine = {};
      for (const [category, delta] of Object.entries(pending.engine)) {
        if (!metrics._engine[category]) {
          metrics._engine[category] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
        }
        const cat = metrics._engine[category];
        cat.calls = (cat.calls || 0) + delta.calls;
        cat.costUsd = (cat.costUsd || 0) + delta.costUsd;
        cat.inputTokens = (cat.inputTokens || 0) + delta.inputTokens;
        cat.outputTokens = (cat.outputTokens || 0) + delta.outputTokens;
        cat.cacheRead = (cat.cacheRead || 0) + delta.cacheRead;
        cat.cacheCreation = (cat.cacheCreation || 0) + delta.cacheCreation;
        if (delta.timedCalls > 0) {
          cat.totalDurationMs = (cat.totalDurationMs || 0) + delta.totalDurationMs;
          cat.timedCalls = (cat.timedCalls || 0) + delta.timedCalls;
        }
      }
      if (!metrics._daily) metrics._daily = {};
      for (const [day, delta] of Object.entries(pending.daily)) {
        if (!metrics._daily[day]) {
          metrics._daily[day] = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, tasks: 0 };
        }
        const d = metrics._daily[day];
        d.costUsd += delta.costUsd;
        d.inputTokens += delta.inputTokens;
        d.outputTokens += delta.outputTokens;
        d.cacheRead += delta.cacheRead;
      }
      return metrics;
    });
  } catch (e) {
    // Re-merge pending so the next flush retries — never drop counters silently.
    for (const [category, delta] of Object.entries(pending.engine)) {
      if (!_pendingMetrics.engine[category]) _pendingMetrics.engine[category] = _emptyEngineDelta();
      const c = _pendingMetrics.engine[category];
      c.calls += delta.calls; c.costUsd += delta.costUsd;
      c.inputTokens += delta.inputTokens; c.outputTokens += delta.outputTokens;
      c.cacheRead += delta.cacheRead; c.cacheCreation += delta.cacheCreation;
      c.totalDurationMs += delta.totalDurationMs; c.timedCalls += delta.timedCalls;
    }
    for (const [day, delta] of Object.entries(pending.daily)) {
      if (!_pendingMetrics.daily[day]) _pendingMetrics.daily[day] = _emptyDailyDelta();
      const d = _pendingMetrics.daily[day];
      d.costUsd += delta.costUsd; d.inputTokens += delta.inputTokens;
      d.outputTokens += delta.outputTokens; d.cacheRead += delta.cacheRead;
    }
    console.error('metrics flush:', e.message);
  }
}

function _resetMetricsBufferForTest() {
  _pendingMetrics = { engine: Object.create(null), daily: Object.create(null) };
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
}

// ─── Runtime Binary Resolution (TTL-cached) ──────────────────────────────────
//
// Replaces the legacy `_resolveClaudeBin()`. Each adapter's `resolveBinary()`
// already encapsulates its own disk-cache + PATH probe + npm probe (Claude) or
// PATH probe + gh-extension fallback (Copilot). We layer a per-process,
// per-runtime in-memory TTL cache on top so a busy CC session doesn't pay
// the tiny disk-read cost on every call.
//
// `runtime.capsFile` (an adapter-exported absolute path) is the on-disk cache
// path the adapter owns. We don't read it directly here — the adapter does
// that inside resolveBinary() — but the test surface inspects `runtime.capsFile`
// to verify each adapter has its own file.

const _binCache = new Map(); // runtime.name → { bin, native, leadingArgs, ts }
const _BIN_TTL = 1800000;    // 30 min

function _resolveBin(runtime) {
  if (!runtime) return null;
  const key = runtime.name;
  const cached = _binCache.get(key);
  // Trust the 30-min TTL — skip per-call existsSync (10-50ms on Windows w/ AV).
  // If the binary disappears mid-window, spawn fails with ENOENT and the
  // adapter's resolveBinary() reprobes on the next cache miss.
  if (cached && Date.now() - cached.ts < _BIN_TTL) {
    return { bin: cached.bin, native: cached.native, leadingArgs: cached.leadingArgs };
  }
  let resolved = null;
  try { resolved = runtime.resolveBinary({ env: cleanChildEnv() }); }
  catch { return null; }
  if (!resolved) return null;
  const leadingArgs = Array.isArray(resolved.leadingArgs) ? resolved.leadingArgs : [];
  _binCache.set(key, { bin: resolved.bin, native: !!resolved.native, leadingArgs, ts: Date.now() });
  return { bin: resolved.bin, native: !!resolved.native, leadingArgs };
}

function _resetBinCache() { _binCache.clear(); }

function _runtimeInstallHint(runtimeName, runtime) {
  if (runtime && typeof runtime.installHint === 'string' && runtime.installHint) return runtime.installHint;
  return `install the ${runtimeName || 'selected'} CLI and make sure it is on PATH`;
}

function _missingRuntimeMessage(runtimeName, runtime, reason) {
  const selected = runtime?.name || runtimeName || 'configured';
  if (!runtime) {
    return [
      `Minions can't run the configured runtime "${selected}".`,
      '',
      reason || 'The configured runtime is not registered.',
      '',
      'Choose a supported runtime in Settings -> Engine -> defaultCli/ccCli, then install its CLI:',
      '- Claude Code: npm install -g @anthropic-ai/claude-code or download from https://claude.ai/download',
      '- GitHub Copilot CLI: install via GitHub CLI/gh-copilot or download from https://github.com/github/copilot-cli/releases',
      '',
      'After installing, restart Minions so the dashboard and engine inherit the updated PATH.',
    ].join('\n');
  }
  const lines = [
    `Minions can't run the "${selected}" runtime yet.`,
    '',
    reason || `The ${selected} CLI binary was not found on PATH.`,
    '',
    `Install steps for "${selected}": ${_runtimeInstallHint(selected, runtime)}.`,
    '',
    'After installing, restart Minions so the dashboard and engine inherit the updated PATH.',
  ];
  if (selected !== 'claude') {
    lines.push('Or switch Settings -> Engine -> defaultCli/ccCli back to "claude" after installing Claude Code.');
  } else {
    lines.push('Or switch Settings -> Engine -> defaultCli/ccCli to "copilot" after installing GitHub Copilot CLI.');
  }
  return lines.join('\n');
}

function _missingRuntimeResult(runtimeName, runtime, reason) {
  const message = _missingRuntimeMessage(runtimeName, runtime, reason);
  return {
    text: message,
    usage: null,
    sessionId: null,
    code: MISSING_RUNTIME_EXIT_CODE,
    stderr: message,
    raw: '',
    toolUses: [],
    runtime: runtime?.name || runtimeName || null,
    errorClass: shared.FAILURE_CLASS.CONFIG_ERROR,
    missingRuntime: true,
  };
}

function _resolvedCallResult(result) {
  const promise = Promise.resolve(result);
  promise.abort = () => {};
  return promise;
}

function _resolveRuntimeNameFor(callOpts = {}) {
  let runtimeName = callOpts.cli;
  if (!runtimeName && callOpts.engineConfig) runtimeName = resolveCcCli(callOpts.engineConfig);
  return runtimeName || 'claude';
}

function _runtimeUnavailableResult(callOpts = {}) {
  const runtimeName = _resolveRuntimeNameFor(callOpts);
  let runtime = null;
  try {
    runtime = resolveRuntime(runtimeName);
  } catch (err) {
    return _missingRuntimeResult(runtimeName, null, err.message);
  }
  if (!_resolveBin(runtime)) {
    return _missingRuntimeResult(runtimeName, runtime, `The ${runtime.name} CLI binary was not found on PATH or in the runtime cache.`);
  }
  return null;
}

// ─── Spawn Helpers ───────────────────────────────────────────────────────────

/**
 * Translate the unified opts bag into the named CLI flags consumed by
 * `engine/spawn-agent.js`. spawn-agent.js parses these back into an opts
 * object and calls `runtime.buildArgs(opts)` once — keeping the adapter as
 * the single source of truth and avoiding double-flag emission.
 *
 * Capability gating (matches engine.js _buildAgentSpawnFlags from P-2a6d9c4f):
 *   - effort/sessionId/maxBudget/bare/fallbackModel are dropped when the
 *     runtime's matching capability is false.
 *   - Copilot-specific opts (stream, disableBuiltinMcps, suppressAgentsMd,
 *     reasoningSummaries) are emitted unconditionally; the Claude adapter
 *     ignores them via the "tolerate unknown opts" rule.
 */
function _buildSpawnAgentFlags(runtime, opts = {}) {
  const caps = (runtime && runtime.capabilities) || {};
  const flags = ['--runtime', String(runtime?.name || 'claude')];

  if (opts.maxTurns != null) flags.push('--max-turns', String(opts.maxTurns));
  if (opts.model) flags.push('--model', String(opts.model));
  if (opts.allowedTools) flags.push('--allowedTools', String(opts.allowedTools));

  if (caps.effortLevels && opts.effort) flags.push('--effort', String(opts.effort));
  if (caps.sessionResume && opts.sessionId) flags.push('--resume', String(opts.sessionId));
  if (caps.budgetCap && opts.maxBudget != null) flags.push('--max-budget-usd', String(opts.maxBudget));
  if (caps.bareMode && opts.bare === true) flags.push('--bare');
  if (caps.fallbackModel && opts.fallbackModel) flags.push('--fallback-model', String(opts.fallbackModel));

  if (opts.stream === 'on' || opts.stream === 'off') flags.push('--stream', opts.stream);
  if (opts.disableBuiltinMcps === true) flags.push('--disable-builtin-mcps');
  if (opts.suppressAgentsMd === true) flags.push('--no-custom-instructions');
  if (opts.reasoningSummaries === true) flags.push('--enable-reasoning-summaries');

  return flags;
}

/**
 * Spawn a runtime CLI process. Returns `{ proc, cleanupFiles }` or null when
 * the runtime can't even be resolved.
 *
 * Direct path (`direct: true`): bypasses spawn-agent.js, spawns the runtime
 *   binary directly. Fewer file syscalls. Used by CC and doc-chat.
 *
 * Indirect path: uses engine/spawn-agent.js — mostly a fallback when the
 *   direct path can't resolve the binary cache. spawn-agent.js handles
 *   adapter resolution itself; we just hand it `--runtime <name>` plus the
 *   named flags it knows how to parse.
 */
function _spawnProcess(promptText, sysPromptText, callOpts) {
  const {
    direct, label, runtime, model, maxTurns, allowedTools, effort, sessionId,
    maxBudget, bare, fallbackModel,
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
  } = callOpts;

  const id = uid();
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const cleanupFiles = [];
  const caps = (runtime && runtime.capabilities) || {};
  const adapterOpts = {
    model, maxTurns, allowedTools, effort, sessionId,
    maxBudget, bare, fallbackModel,
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
  };
  // Capability-gate per-flag opts before prompt construction so adapters can
  // make resume-aware prompt decisions from the same opts used for argv.
  if (!caps.effortLevels) adapterOpts.effort = undefined;
  if (!caps.sessionResume) adapterOpts.sessionId = undefined;
  if (!caps.budgetCap) adapterOpts.maxBudget = undefined;
  if (!caps.bareMode) adapterOpts.bare = undefined;
  if (!caps.fallbackModel) adapterOpts.fallbackModel = undefined;
  const finalPrompt = runtime.buildPrompt(promptText, sysPromptText, adapterOpts);

  // ── Direct path ──
  const resolved = direct ? _resolveBin(runtime) : null;
  if (resolved) {
    let sysTmpPath = null;
    // Only write a sys-prompt tmp file when the runtime actually consumes one
    // via --system-prompt-file (Claude) AND we're not resuming (resumed sessions
    // already have the sys prompt baked in).
    if (!sessionId && sysPromptText && caps.systemPromptFile) {
      sysTmpPath = path.join(tmpDir, `direct-sys-${id}.md`);
      fs.writeFileSync(sysTmpPath, sysPromptText);
      cleanupFiles.push(sysTmpPath);
      adapterOpts.sysPromptFile = sysTmpPath;
    }
    // promptViaArg=true: the adapter splices `--prompt <text>` into args itself.
    if (caps.promptViaArg) adapterOpts.prompt = finalPrompt;

    const cliArgs = runtime.buildArgs(adapterOpts);
    const execArgs = resolved.native
      ? [...resolved.leadingArgs, ...cliArgs]
      : [resolved.bin, ...resolved.leadingArgs, ...cliArgs];
    const execBin = resolved.native ? resolved.bin : process.execPath;
    const proc = runFile(execBin, execArgs, {
      cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv(),
    });
    if (caps.promptViaArg) {
      // Adapter has already spliced the prompt into argv; close stdin so the
      // child doesn't wait on it indefinitely.
      try { proc.stdin.end(); } catch { /* may already be closed */ }
    } else {
      try { proc.stdin.write(finalPrompt); proc.stdin.end(); } catch { /* broken pipe */ }
    }
    return { proc, cleanupFiles };
  }

  // Indirect: use spawn-agent.js (when direct=false or binary cache miss)
  const promptPath = path.join(tmpDir, `${label}-prompt-${id}.md`);
  const sysPath = path.join(tmpDir, `${label}-sys-${id}.md`);
  // The wrapper merges sys prompt into the user prompt for runtimes without
  // --system-prompt-file (Copilot) — write the user prompt as `finalPrompt`
  // (system block already prepended by buildPrompt) for those, and just the
  // raw user text for runtimes that take sys via a separate file (Claude).
  if (caps.systemPromptFile) {
    safeWrite(promptPath, promptText == null ? '' : String(promptText));
    safeWrite(sysPath, sysPromptText || '');
  } else {
    safeWrite(promptPath, finalPrompt);
    safeWrite(sysPath, '');
  }
  // spawn-agent.js derives a PID file from prompt path — include it in cleanup
  // to prevent leaks even if the spawned process never writes one.
  const pidPath = promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
  cleanupFiles.push(promptPath, sysPath, pidPath);

  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const adapterFlags = _buildSpawnAgentFlags(runtime, {
    model, maxTurns, allowedTools, effort, sessionId,
    maxBudget, bare, fallbackModel,
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
  });
  const args = [spawnScript, promptPath, sysPath, ...adapterFlags];

  const proc = runFile(process.execPath, args, {
    cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv(),
  });
  return { proc, cleanupFiles };
}

// ─── Streaming Accumulator ───────────────────────────────────────────────────
//
// Reads JSONL events as they stream in. JSON parsing is delegated to
// `runtime.parseStreamChunk()` and event-shape interpretation is delegated to
// `runtime.createStreamConsumer(ctx)`. This file stays runtime-agnostic — it
// owns the global accumulator state (stdout/stderr/text dedup/toolUses) and
// exposes a `ctx` callback API the adapter calls when it sees Claude- or
// Copilot-shaped events.
//
// Final reconciliation calls `runtime.parseOutput(stdout)` so per-runtime
// finalization quirks (Copilot's premiumRequests, Claude's session_id) stay
// inside the adapter.

function _createStreamAccumulator({
  runtime,
  maxRawBytes,
  maxStderrBytes,
  maxLineBufferBytes,
  maxTextLength = 0,
  onChunk = null,
  onToolUse = null,
  onTaskComplete = null,
  onTerminalResult = null,
  onThinking = null,
}) {
  if (!runtime?.capabilities?.streamConsumer || typeof runtime.createStreamConsumer !== 'function') {
    throw new Error(`runtime ${runtime?.name || '<unknown>'} missing createStreamConsumer (capabilities.streamConsumer)`);
  }

  let stdout = '';
  let stderr = '';
  let lineBuf = '';
  let text = '';
  let usage = null;
  let sessionId = null;
  let lastTextSent = '';
  let thinkingSent = false;
  let taskCompleteFired = false;
  let terminalResultFired = false;
  let lastTaskCompleteSummary = '';
  const toolUses = [];

  function _streamText(value) {
    return (maxTextLength && value.length > maxTextLength) ? value.slice(-maxTextLength) : value;
  }

  // ── ctx surface — the only API the runtime stream consumer sees ─────────
  const ctx = {
    maxTextLength,
    pushText(value) {
      if (typeof value !== 'string' || !value) return;
      const next = _streamText(value);
      text = next;
      if (onChunk && next !== lastTextSent) {
        lastTextSent = next;
        onChunk(next);
      }
    },
    setText(value) {
      // Hard-set text bypassing dedup — for terminal events that should
      // override any streamed text (Claude's `result`, Copilot's final
      // assistant.message). onChunk is NOT fired here; this is the
      // authoritative final-text path, not a streaming chunk.
      //
      // Fire onTerminalResult once on the first non-empty terminal text so
      // callers can early-resolve without waiting for the OS-level 'exit' /
      // 'close' events — those can be delayed indefinitely on Linux when a
      // detached grandchild has inherited the stdout pipe (e.g. Claude/Copilot
      // CLIs that spawn background workers).
      if (typeof value !== 'string') return;
      text = _streamText(value);
      if (value && onTerminalResult && !terminalResultFired) {
        terminalResultFired = true;
        onTerminalResult();
      }
    },
    pushToolUse(name, input) {
      if (!name) return;
      const toolUse = { name, input: input || {} };
      toolUses.push(toolUse);
      if (onToolUse) onToolUse(toolUse.name, toolUse.input);
    },
    toolUseAlreadySeen(name, input) {
      if (!name) return false;
      const stringified = JSON.stringify(input || {});
      return toolUses.some(t => t.name === name && JSON.stringify(t.input) === stringified);
    },
    notifyThinking() {
      if (!onThinking || thinkingSent) return;
      thinkingSent = true;
      onThinking();
    },
    notifyTaskComplete(summary, success = true) {
      if (typeof summary !== 'string' || !summary) return;
      const finalSummary = _streamText(summary);
      const alreadySeen = taskCompleteFired && lastTaskCompleteSummary === finalSummary;
      lastTaskCompleteSummary = finalSummary;
      // Surface as terminal text only if nothing streamed yet.
      if (!text) {
        text = finalSummary;
        if (onChunk && finalSummary !== lastTextSent) {
          lastTextSent = finalSummary;
          onChunk(finalSummary);
        }
      }
      if (!alreadySeen && onTaskComplete) {
        taskCompleteFired = true;
        onTaskComplete({ summary: finalSummary, success: success !== false });
      } else {
        taskCompleteFired = true;
      }
    },
    setUsage(u) { if (u) usage = u; },
    setSessionId(id) { if (typeof id === 'string' && id) sessionId = id; },
  };

  const consumer = runtime.createStreamConsumer(ctx);

  function ingestStdout(chunk) {
    const str = chunk == null ? '' : chunk.toString();
    stdout = appendTextTail(stdout, str, maxRawBytes, '...(truncated stdout)\n');
    lineBuf = appendTextTail(lineBuf, str, maxLineBufferBytes, '');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      const ev = runtime.parseStreamChunk(line);
      if (ev) consumer.consume(ev);
    }
  }

  function ingestStderr(chunk) {
    stderr = appendTextTail(stderr, chunk == null ? '' : chunk.toString(), maxStderrBytes, '...(truncated stderr)\n');
  }

  function finalize() {
    const trimmed = lineBuf.trim();
    if (trimmed) {
      const ev = runtime.parseStreamChunk(trimmed);
      if (ev) consumer.consume(ev);
    }
    if (!text && lastTaskCompleteSummary) text = lastTaskCompleteSummary;
    // Reconciliation: always let the runtime adapter re-parse the complete
    // stdout. Stream consumers emit live progress, but parseOutput() owns the
    // runtime-specific final answer shape (including multi-fragment messages).
    const parsedTail = runtime.parseOutput(stdout, maxTextLength ? { maxTextLength } : {});
    if (parsedTail.text) text = parsedTail.text;
    if (!usage && parsedTail.usage) usage = parsedTail.usage;
    if (!sessionId && parsedTail.sessionId) sessionId = parsedTail.sessionId;
    return { text, usage, sessionId, raw: stdout, stderr, toolUses };
  }

  return { ingestStdout, ingestStderr, finalize };
}

// ─── Resolution Helpers (local, kept private) ───────────────────────────────

function _resolveRuntimeFor(callOpts) {
  // Explicit `cli` opt wins; otherwise fall to `engineConfig` resolution;
  // otherwise default to claude (the historical behavior).
  return resolveRuntime(_resolveRuntimeNameFor(callOpts));
}

function _resolveModelFor(callOpts) {
  // Explicit `model` opt wins (current behavior of every internal caller —
  // kb-sweep, pipeline.js, dashboard CC paths). When unset and engineConfig is
  // provided, resolve via shared.resolveCcModel — that's the new fleet path.
  if (callOpts.model) return callOpts.model;
  if (callOpts.engineConfig) return resolveCcModel(callOpts.engineConfig);
  return undefined;
}

function _resolveModelForRuntime(runtime, callOpts) {
  const selected = _resolveModelFor(callOpts || {});
  if (!runtime || typeof runtime.resolveModel !== 'function') return selected;
  return runtime.resolveModel(selected);
}

function _resolveRuntimeFeatureOpts({
  stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries, engineConfig,
} = {}) {
  const engine = engineConfig || {};
  return {
    stream: stream ?? engine.copilotStreamMode,
    disableBuiltinMcps: disableBuiltinMcps ?? engine.copilotDisableBuiltinMcps,
    suppressAgentsMd: suppressAgentsMd ?? engine.copilotSuppressAgentsMd,
    reasoningSummaries: reasoningSummaries ?? engine.copilotReasoningSummaries,
  };
}

// ─── Core LLM Call ───────────────────────────────────────────────────────────

function callLLM(promptText, sysPromptText, opts = {}) {
  const {
    timeout = 120000, label = 'llm', maxTurns = 1, allowedTools = '',
    sessionId = null, effort = null, direct = false,
    // Backward-compat opt (overrides resolution):
    model: modelOverride,
    cli: cliOverride,
    engineConfig,
    // Cross-runtime + Copilot opts:
    maxBudget, bare, fallbackModel,
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
  } = opts;

  const unavailable = _runtimeUnavailableResult({ cli: cliOverride, engineConfig });
  if (unavailable) return _resolvedCallResult(unavailable);

  const runtime = _resolveRuntimeFor({ cli: cliOverride, engineConfig });
  const model = _resolveModelForRuntime(runtime, { model: modelOverride, engineConfig });
  const runtimeFeatureOpts = _resolveRuntimeFeatureOpts({
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries, engineConfig,
  });

  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, {
      direct, label, runtime, model, maxTurns, allowedTools, effort, sessionId,
      maxBudget, bare, fallbackModel,
      ...runtimeFeatureOpts,
    });
    let taskCompleteTimer = null;
    const scheduleTaskCompleteClose = () => {
      if (taskCompleteTimer) return;
      taskCompleteTimer = setTimeout(() => { try { shared.killImmediate(proc); } catch {} }, COPILOT_TASK_COMPLETE_GRACE_MS);
    };
    const clearTaskCompleteTimer = () => {
      if (taskCompleteTimer) {
        clearTimeout(taskCompleteTimer);
        taskCompleteTimer = null;
      }
    };
    let resolved = false;
    let exitFallbackTimer = null;
    let exitCode = null;
    const scheduleExitFallback = (code) => {
      if (resolved || exitFallbackTimer) return;
      exitFallbackTimer = setTimeout(() => finalizeAndResolve(code), EXIT_DRAIN_FALLBACK_MS);
    };
    const acc = _createStreamAccumulator({
      runtime,
      maxRawBytes: ENGINE_DEFAULTS.maxLlmRawBytes,
      maxStderrBytes: ENGINE_DEFAULTS.maxLlmStderrBytes,
      maxLineBufferBytes: ENGINE_DEFAULTS.maxLlmLineBufferBytes,
      onTaskComplete: scheduleTaskCompleteClose,
      // Terminal text from the runtime adapter signals the LLM has logically
      // completed — kick the drain timer so we don't block on a delayed
      // 'exit'/'close' when an inherited pipe keeps the parent's FDs open.
      onTerminalResult: () => scheduleExitFallback(exitCode != null ? exitCode : 0),
    });

    _abort = () => { shared.killImmediate(proc); };

    proc.stdout.on('data', d => { acc.ingestStdout(d); });
    proc.stderr.on('data', d => { acc.ingestStderr(d); });

    const timer = setTimeout(() => { shared.killImmediate(proc); }, timeout);

    const finalizeAndResolve = (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTaskCompleteTimer();
      if (exitFallbackTimer) { clearTimeout(exitFallbackTimer); exitFallbackTimer = null; }
      for (const f of cleanupFiles) safeUnlink(f);
      const parsed = acc.finalize();
      const durationMs = Date.now() - _startMs;
      const usage = parsed.usage ? { ...parsed.usage, durationMs } : { durationMs };
      // parseError lets the adapter classify obvious failure modes (auth /
      // context-limit / rate-limit / crash). Callers can ignore the field
      // when they don't need it.
      const errInfo = code !== 0
        ? runtime.parseError([parsed.raw, parsed.stderr].filter(Boolean).join('\n'))
        : { message: '', code: null, retriable: true };
      resolve({
        text: parsed.text || '',
        usage,
        sessionId: parsed.sessionId || null,
        code,
        stderr: parsed.stderr,
        raw: parsed.raw,
        toolUses: parsed.toolUses,
        runtime: runtime.name,
        errorClass: errInfo.code,
      });
    };

    // 'close' fires after stdio streams close; if a detached grandchild
    // inherited stdout, that can be delayed indefinitely. 'exit' fires when
    // the child itself exits — schedule a short drain window then resolve.
    // On Linux, 'exit' itself can be delayed by an inherited pipe handle, so
    // the accumulator's onTerminalResult provides a third early-resolve path.
    proc.on('exit', (code) => { exitCode = code; scheduleExitFallback(code); });
    proc.on('close', (code) => { finalizeAndResolve(code); });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTaskCompleteTimer();
      if (exitFallbackTimer) { clearTimeout(exitFallbackTimer); exitFallbackTimer = null; }
      for (const f of cleanupFiles) safeUnlink(f);
      shared.log('error', `LLM spawn error (${label}): ${err.message}`);
      resolve({
        text: '', usage: null, sessionId: null, code: 1,
        stderr: err.message, raw: '', toolUses: [],
        runtime: runtime.name, errorClass: null,
      });
    });
  });
  promise.abort = () => { if (_abort) _abort(); };
  return promise;
}

/**
 * Streaming variant of callLLM — emits text chunks via onChunk callback.
 * Returns the same result object as callLLM when the process completes.
 * onChunk(text) is called for each assistant text block as it arrives.
 */
function callLLMStreaming(promptText, sysPromptText, opts = {}) {
  const {
    timeout = 120000, label = 'llm', maxTurns = 1, allowedTools = '',
    sessionId = null, onChunk = () => {}, onToolUse = null,
    effort = null, direct = false,
    model: modelOverride, cli: cliOverride, engineConfig,
    maxBudget, bare, fallbackModel,
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
  } = opts;

  const unavailable = _runtimeUnavailableResult({ cli: cliOverride, engineConfig });
  if (unavailable) return _resolvedCallResult(unavailable);

  const runtime = _resolveRuntimeFor({ cli: cliOverride, engineConfig });
  const model = _resolveModelForRuntime(runtime, { model: modelOverride, engineConfig });
  const runtimeFeatureOpts = _resolveRuntimeFeatureOpts({
    stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries, engineConfig,
  });

  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, {
      direct, label, runtime, model, maxTurns, allowedTools, effort, sessionId,
      maxBudget, bare, fallbackModel,
      ...runtimeFeatureOpts,
    });
    let taskCompleteTimer = null;
    const scheduleTaskCompleteClose = () => {
      if (taskCompleteTimer) return;
      taskCompleteTimer = setTimeout(() => { try { shared.killImmediate(proc); } catch {} }, COPILOT_TASK_COMPLETE_GRACE_MS);
    };
    const clearTaskCompleteTimer = () => {
      if (taskCompleteTimer) {
        clearTimeout(taskCompleteTimer);
        taskCompleteTimer = null;
      }
    };
    let resolved = false;
    let exitFallbackTimer = null;
    let exitCode = null;
    const scheduleExitFallback = (code) => {
      if (resolved || exitFallbackTimer) return;
      exitFallbackTimer = setTimeout(() => finalizeAndResolve(code), EXIT_DRAIN_FALLBACK_MS);
    };
    const acc = _createStreamAccumulator({
      runtime,
      maxRawBytes: ENGINE_DEFAULTS.maxLlmRawBytes,
      maxStderrBytes: ENGINE_DEFAULTS.maxLlmStderrBytes,
      maxLineBufferBytes: ENGINE_DEFAULTS.maxLlmLineBufferBytes,
      onChunk,
      onToolUse,
      onTaskComplete: scheduleTaskCompleteClose,
      // Terminal text from the runtime adapter signals the LLM has logically
      // completed — kick the drain timer so we don't block on a delayed
      // 'exit'/'close' when an inherited pipe keeps the parent's FDs open.
      onTerminalResult: () => scheduleExitFallback(exitCode != null ? exitCode : 0),
      onThinking: opts.onThinking || null,
    });

    _abort = () => { shared.killImmediate(proc); };

    proc.stdout.on('data', d => { acc.ingestStdout(d); });
    proc.stderr.on('data', d => { acc.ingestStderr(d); });

    const timer = setTimeout(() => { shared.killImmediate(proc); }, timeout);

    const finalizeAndResolve = (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTaskCompleteTimer();
      if (exitFallbackTimer) { clearTimeout(exitFallbackTimer); exitFallbackTimer = null; }
      for (const f of cleanupFiles) safeUnlink(f);
      const parsed = acc.finalize();
      const durationMs = Date.now() - _startMs;
      const usage = parsed.usage ? { ...parsed.usage, durationMs } : { durationMs };
      const errInfo = code !== 0
        ? runtime.parseError([parsed.raw, parsed.stderr].filter(Boolean).join('\n'))
        : { message: '', code: null, retriable: true };
      resolve({
        text: parsed.text || '',
        usage,
        sessionId: parsed.sessionId || null,
        code,
        stderr: parsed.stderr,
        raw: parsed.raw,
        toolUses: parsed.toolUses,
        runtime: runtime.name,
        errorClass: errInfo.code,
      });
    };

    // 'close' fires after stdio streams close; if a detached grandchild
    // inherited stdout, that can be delayed indefinitely. 'exit' fires when
    // the child itself exits — schedule a short drain window then resolve.
    // On Linux, 'exit' itself can be delayed by an inherited pipe handle, so
    // the accumulator's onTerminalResult provides a third early-resolve path.
    proc.on('exit', (code) => { exitCode = code; scheduleExitFallback(code); });
    proc.on('close', (code) => { finalizeAndResolve(code); });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTaskCompleteTimer();
      if (exitFallbackTimer) { clearTimeout(exitFallbackTimer); exitFallbackTimer = null; }
      for (const f of cleanupFiles) safeUnlink(f);
      shared.log('error', `LLM-stream spawn error (${label}): ${err.message}`);
      resolve({
        text: '', usage: null, sessionId: null, code: 1,
        stderr: err.message, raw: '', toolUses: [],
        runtime: runtime.name, errorClass: null,
      });
    });
  });
  promise.abort = () => { if (_abort) _abort(); };
  return promise;
}

module.exports = {
  callLLM,
  callLLMStreaming,
  trackEngineUsage,
  flushMetricsBuffer,
  // Exposed for unit tests — engine code MUST use the runtime adapter contract.
  _buildSpawnAgentFlags,
  _resolveBin,
  _resetBinCache,
  _resetMetricsBufferForTest,
  _resolveRuntimeFor,
  _resolveModelFor,
  _resolveModelForRuntime,
  _resolveRuntimeFeatureOpts,
  _createStreamAccumulator,
};
