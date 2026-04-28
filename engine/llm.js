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

// ─── Engine-Usage Metrics ────────────────────────────────────────────────────

function trackEngineUsage(category, usage) {
  if (!usage) return;
  if (category && (category.startsWith('_test') || category.startsWith('test-'))) return;
  try {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    mutateJsonFileLocked(metricsPath, (metrics) => {
      if (!metrics._engine) metrics._engine = {};
      if (!metrics._engine[category]) {
        metrics._engine[category] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };
      }
      const cat = metrics._engine[category];
      cat.calls++;
      cat.costUsd += usage.costUsd || 0;
      cat.inputTokens += usage.inputTokens || 0;
      cat.outputTokens += usage.outputTokens || 0;
      cat.cacheRead += usage.cacheRead || 0;
      cat.cacheCreation = (cat.cacheCreation || 0) + (usage.cacheCreation || 0);
      if (usage.durationMs) {
        cat.totalDurationMs = (cat.totalDurationMs || 0) + usage.durationMs;
        cat.timedCalls = (cat.timedCalls || 0) + 1;
      }

      const today = ts().slice(0, 10);
      if (!metrics._daily) metrics._daily = {};
      if (!metrics._daily[today]) metrics._daily[today] = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, tasks: 0 };
      const daily = metrics._daily[today];
      daily.costUsd += usage.costUsd || 0;
      daily.inputTokens += usage.inputTokens || 0;
      daily.outputTokens += usage.outputTokens || 0;
      daily.cacheRead += usage.cacheRead || 0;

      return metrics;
    });
  } catch (e) { console.error('metrics update:', e.message); }
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
  if (cached && Date.now() - cached.ts < _BIN_TTL && fs.existsSync(cached.bin)) {
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
  const finalPrompt = runtime.buildPrompt(promptText, sysPromptText);

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
    // Capability-gate per-flag opts so the Claude path keeps emitting its
    // historical flag set while Copilot only sees what it understands.
    if (!caps.effortLevels) adapterOpts.effort = undefined;
    if (!caps.sessionResume) adapterOpts.sessionId = undefined;
    if (!caps.budgetCap) adapterOpts.maxBudget = undefined;
    if (!caps.bareMode) adapterOpts.bare = undefined;
    if (!caps.fallbackModel) adapterOpts.fallbackModel = undefined;
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
// `runtime.parseStreamChunk()` — that gives us the runtime's defensive
// guarantees (e.g. Copilot rewrapping unknown event types as type:'ignore').
//
// Text / tool extraction branches on event SHAPE rather than runtime identity.
// Both Claude and Copilot events flow through here; for any given object only
// one branch matches because the event type strings don't collide.
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
}) {
  let stdout = '';
  let stderr = '';
  let lineBuf = '';
  let text = '';
  let usage = null;
  let sessionId = null;
  let lastTextSent = '';
  const toolUses = [];

  // Copilot streams `assistant.message_delta` with `data.deltaContent` chunks
  // before emitting the final `assistant.message`. We accumulate the deltas
  // for the live onChunk feed; the final `assistant.message.data.content`
  // value is the authoritative text.
  let copilotMessageBuffer = '';

  function captureEvent(obj) {
    if (!obj || typeof obj !== 'object') return;

    // ── Claude shape ────────────────────────────────────────────────────────
    if (obj.session_id) sessionId = obj.session_id;
    if (obj.type === 'result' && typeof obj.result === 'string') {
      // Claude result event: terminal text + usage.
      text = maxTextLength ? obj.result.slice(-maxTextLength) : obj.result;
      if (obj.total_cost_usd || obj.usage) {
        usage = {
          costUsd: obj.total_cost_usd || 0,
          inputTokens: obj.usage?.input_tokens || 0,
          outputTokens: obj.usage?.output_tokens || 0,
          cacheRead: obj.usage?.cache_read_input_tokens || obj.usage?.cacheReadInputTokens || 0,
          cacheCreation: obj.usage?.cache_creation_input_tokens || obj.usage?.cacheCreationInputTokens || 0,
          durationMs: obj.duration_ms || 0,
          numTurns: obj.num_turns || 0,
        };
      }
    }
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      // Claude assistant turn: content blocks (text + tool_use).
      for (const block of obj.message.content) {
        if (block?.type === 'text' && block.text) {
          text = maxTextLength ? block.text.slice(-maxTextLength) : block.text;
          if (onChunk && block.text !== lastTextSent) {
            lastTextSent = block.text;
            onChunk(block.text);
          }
        } else if (block?.type === 'tool_use' && block.name) {
          const toolUse = { name: block.name, input: block.input || {} };
          toolUses.push(toolUse);
          if (onToolUse) onToolUse(toolUse.name, toolUse.input);
        }
      }
    }

    // ── Copilot shape ───────────────────────────────────────────────────────
    if (obj.type === 'result' && typeof obj.sessionId === 'string') sessionId = obj.sessionId;
    if (obj.type === 'assistant.message_delta' && typeof obj.data?.deltaContent === 'string') {
      copilotMessageBuffer += obj.data.deltaContent;
      if (onChunk && copilotMessageBuffer !== lastTextSent) {
        lastTextSent = copilotMessageBuffer;
        onChunk(copilotMessageBuffer);
      }
    }
    if (obj.type === 'assistant.message' && typeof obj.data?.content === 'string') {
      // Authoritative final assistant text for this turn.
      const content = obj.data.content;
      if (content) {
        text = maxTextLength ? content.slice(-maxTextLength) : content;
        copilotMessageBuffer = '';
      }
      if (Array.isArray(obj.data.toolRequests)) {
        for (const tr of obj.data.toolRequests) {
          if (tr && tr.name) {
            const toolUse = { name: tr.name, input: tr.arguments || {} };
            toolUses.push(toolUse);
            if (onToolUse) onToolUse(toolUse.name, toolUse.input);
          }
        }
      }
    }
    if (obj.type === 'tool.execution_start' && obj.data?.toolName) {
      const toolUse = { name: obj.data.toolName, input: obj.data.arguments || {} };
      // Dedup: assistant.message.toolRequests already adds this — only push if
      // we haven't seen it yet (toolCallId would be the unique key, but we
      // compare by name+input shape since not every consumer cares).
      if (!toolUses.some(t => t.name === toolUse.name && JSON.stringify(t.input) === JSON.stringify(toolUse.input))) {
        toolUses.push(toolUse);
        if (onToolUse) onToolUse(toolUse.name, toolUse.input);
      }
    }
  }

  function ingestStdout(chunk) {
    const str = chunk == null ? '' : chunk.toString();
    stdout = appendTextTail(stdout, str, maxRawBytes, '...(truncated stdout)\n');
    lineBuf = appendTextTail(lineBuf, str, maxLineBufferBytes, '');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      const ev = runtime.parseStreamChunk(line);
      if (ev) captureEvent(ev);
    }
  }

  function ingestStderr(chunk) {
    stderr = appendTextTail(stderr, chunk == null ? '' : chunk.toString(), maxStderrBytes, '...(truncated stderr)\n');
  }

  function finalize() {
    const trimmed = lineBuf.trim();
    if (trimmed) {
      const ev = runtime.parseStreamChunk(trimmed);
      if (ev) captureEvent(ev);
    }
    // Reconciliation: if any field is still missing, ask the runtime adapter
    // to re-parse the whole stdout. parseOutput() may catch a result event
    // that was malformed when streamed in chunks.
    if (!text || !usage || !sessionId) {
      const parsedTail = runtime.parseOutput(stdout, maxTextLength ? { maxTextLength } : {});
      if (!text && parsedTail.text) text = parsedTail.text;
      if (!usage && parsedTail.usage) usage = parsedTail.usage;
      if (!sessionId && parsedTail.sessionId) sessionId = parsedTail.sessionId;
    }
    return { text, usage, sessionId, raw: stdout, stderr, toolUses };
  }

  return { ingestStdout, ingestStderr, finalize };
}

// ─── Resolution Helpers (local, kept private) ───────────────────────────────

function _resolveRuntimeFor(callOpts) {
  // Explicit `cli` opt wins; otherwise fall to `engineConfig` resolution;
  // otherwise default to claude (the historical behavior).
  let runtimeName = callOpts.cli;
  if (!runtimeName && callOpts.engineConfig) runtimeName = resolveCcCli(callOpts.engineConfig);
  if (!runtimeName) runtimeName = 'claude';
  return resolveRuntime(runtimeName);
}

function _resolveModelFor(callOpts) {
  // Explicit `model` opt wins (current behavior of every internal caller —
  // kb-sweep, pipeline.js, dashboard CC paths). When unset and engineConfig is
  // provided, resolve via shared.resolveCcModel — that's the new fleet path.
  if (callOpts.model) return callOpts.model;
  if (callOpts.engineConfig) return resolveCcModel(callOpts.engineConfig);
  return undefined;
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

  const runtime = _resolveRuntimeFor({ cli: cliOverride, engineConfig });
  const model = _resolveModelFor({ model: modelOverride, engineConfig });

  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, {
      direct, label, runtime, model, maxTurns, allowedTools, effort, sessionId,
      maxBudget, bare, fallbackModel,
      stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
    });
    const acc = _createStreamAccumulator({
      runtime,
      maxRawBytes: ENGINE_DEFAULTS.maxLlmRawBytes,
      maxStderrBytes: ENGINE_DEFAULTS.maxLlmStderrBytes,
      maxLineBufferBytes: ENGINE_DEFAULTS.maxLlmLineBufferBytes,
    });

    _abort = () => { shared.killImmediate(proc); };

    proc.stdout.on('data', d => { acc.ingestStdout(d); });
    proc.stderr.on('data', d => { acc.ingestStderr(d); });

    const timer = setTimeout(() => { shared.killImmediate(proc); }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
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
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
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

  const runtime = _resolveRuntimeFor({ cli: cliOverride, engineConfig });
  const model = _resolveModelFor({ model: modelOverride, engineConfig });

  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, {
      direct, label, runtime, model, maxTurns, allowedTools, effort, sessionId,
      maxBudget, bare, fallbackModel,
      stream, disableBuiltinMcps, suppressAgentsMd, reasoningSummaries,
    });
    const acc = _createStreamAccumulator({
      runtime,
      maxRawBytes: ENGINE_DEFAULTS.maxLlmRawBytes,
      maxStderrBytes: ENGINE_DEFAULTS.maxLlmStderrBytes,
      maxLineBufferBytes: ENGINE_DEFAULTS.maxLlmLineBufferBytes,
      onChunk,
      onToolUse,
    });

    _abort = () => { shared.killImmediate(proc); };

    proc.stdout.on('data', d => { acc.ingestStdout(d); });
    proc.stderr.on('data', d => { acc.ingestStderr(d); });

    const timer = setTimeout(() => { shared.killImmediate(proc); }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
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
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
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
  // Exposed for unit tests — engine code MUST use the runtime adapter contract.
  _buildSpawnAgentFlags,
  _resolveBin,
  _resetBinCache,
  _resolveRuntimeFor,
  _resolveModelFor,
};
