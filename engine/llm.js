/**
 * engine/llm.js — Shared LLM utilities for Minions engine + dashboard
 * Provides callLLM() (with optional session resume) and trackEngineUsage().
 */

const path = require('path');
const shared = require('./shared');
const { safeWrite, safeUnlink, uid, ts, runFile, cleanChildEnv, parseStreamJsonOutput, mutateJsonFileLocked, appendTextTail, ENGINE_DEFAULTS } = shared;

const MINIONS_DIR = shared.MINIONS_DIR;
const ENGINE_DIR = path.join(MINIONS_DIR, 'engine');

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

// ── Claude Binary Resolution (cached by spawn-agent.js) ─────────────────────

let _claudeBinCache = null;
let _claudeBinCacheTs = 0;
const _CLAUDE_BIN_TTL = 1800000; // 30 min — binary path rarely changes during a session
function _resolveClaudeBin() {
  if (_claudeBinCache && Date.now() - _claudeBinCacheTs < _CLAUDE_BIN_TTL) return _claudeBinCache;
  _claudeBinCache = null;
  const caps = shared.safeJson(path.join(ENGINE_DIR, 'claude-caps.json'));
  if (caps?.claudeBin && require('fs').existsSync(caps.claudeBin)) {
    _claudeBinCache = { bin: caps.claudeBin, native: !!caps.claudeIsNative };
    _claudeBinCacheTs = Date.now();
    return _claudeBinCache;
  }
  return null;
}

// ── Spawn Helpers ───────────────────────────────────────────────────────────

function _buildCliArgs({ model, maxTurns, allowedTools, effort, sessionId, sysPromptFile }) {
  const args = ['-p', '--output-format', 'stream-json', '--max-turns', String(maxTurns), '--model', model, '--verbose'];
  if (sysPromptFile) args.push('--system-prompt-file', sysPromptFile);
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (effort) args.push('--effort', effort);
  args.push('--permission-mode', 'bypassPermissions');
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/**
 * Spawn a claude CLI process. Returns { proc, cleanupFiles } or null if binary not cached.
 * When direct=true, spawns claude CLI directly (fewer syscalls). Otherwise uses spawn-agent.js.
 */
function _spawnProcess(promptText, sysPromptText, { direct, label, model, maxTurns, allowedTools, effort, sessionId }) {
  const fs = require('fs');
  const id = uid();
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const cleanupFiles = [];
  const resolved = direct ? _resolveClaudeBin() : null;

  if (resolved) {
    let sysTmpPath = null;
    if (!sessionId && sysPromptText) {
      sysTmpPath = path.join(tmpDir, `direct-sys-${id}.md`);
      fs.writeFileSync(sysTmpPath, sysPromptText);
      cleanupFiles.push(sysTmpPath);
    }
    const cliArgs = _buildCliArgs({ model, maxTurns, allowedTools, effort, sessionId, sysPromptFile: sysTmpPath });
    const proc = resolved.native
      ? runFile(resolved.bin, cliArgs, { cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() })
      : runFile(process.execPath, [resolved.bin, ...cliArgs], { cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
    try { proc.stdin.write(promptText); proc.stdin.end(); } catch { /* broken pipe */ }
    return { proc, cleanupFiles };
  }

  // Indirect: use spawn-agent.js
  const promptPath = path.join(tmpDir, `${label}-prompt-${id}.md`);
  const sysPath = path.join(tmpDir, `${label}-sys-${id}.md`);
  safeWrite(promptPath, promptText);
  safeWrite(sysPath, sysPromptText || '');
  // spawn-agent.js derives a PID file from prompt path — include it in cleanup to prevent leaks
  const pidPath = promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
  cleanupFiles.push(promptPath, sysPath, pidPath);

  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const args = [
    spawnScript, promptPath, sysPath,
    '--output-format', 'stream-json', '--max-turns', String(maxTurns), '--model', model,
    '--verbose',
  ];
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (effort) args.push('--effort', effort);
  args.push('--permission-mode', 'bypassPermissions');
  if (sessionId) args.push('--resume', sessionId);

  const proc = runFile(process.execPath, args, { cwd: MINIONS_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
  return { proc, cleanupFiles };
}

function _createStreamAccumulator({
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

  function captureResult(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.session_id) sessionId = obj.session_id;
    if (obj.type === 'result') {
      if (typeof obj.result === 'string') {
        text = maxTextLength ? obj.result.slice(0, maxTextLength) : obj.result;
      }
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
      for (const block of obj.message.content) {
        if (block?.type === 'text' && block.text) {
          text = maxTextLength ? block.text.slice(0, maxTextLength) : block.text;
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
  }

  function ingestStdout(chunk) {
    const str = chunk == null ? '' : chunk.toString();
    stdout = appendTextTail(stdout, str, maxRawBytes, '...(truncated stdout)\n');
    lineBuf = appendTextTail(lineBuf, str, maxLineBufferBytes, '');
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      try { captureResult(JSON.parse(trimmed)); } catch { /* incomplete JSON or non-JSON line */ }
    }
  }

  function ingestStderr(chunk) {
    stderr = appendTextTail(stderr, chunk == null ? '' : chunk.toString(), maxStderrBytes, '...(truncated stderr)\n');
  }

  function finalize() {
    const trimmed = lineBuf.trim();
    if (trimmed.startsWith('{')) {
      try { captureResult(JSON.parse(trimmed)); } catch { /* incomplete trailing JSON */ }
    }
    if (!text || !usage || !sessionId) {
      const parsedTail = parseStreamJsonOutput(stdout, maxTextLength ? { maxTextLength } : {});
      if (!text && parsedTail.text) text = parsedTail.text;
      if (!usage && parsedTail.usage) usage = parsedTail.usage;
      if (!sessionId && parsedTail.sessionId) sessionId = parsedTail.sessionId;
    }
    return { text, usage, sessionId, raw: stdout, stderr, toolUses };
  }

  return { ingestStdout, ingestStderr, finalize };
}

// ── Core LLM Call ───────────────────────────────────────────────────────────

function callLLM(promptText, sysPromptText, { timeout = 120000, label = 'llm', model = 'sonnet', maxTurns = 1, allowedTools = '', sessionId = null, effort = null, direct = false } = {}) {
  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, { direct, label, model, maxTurns, allowedTools, effort, sessionId });
    const acc = _createStreamAccumulator({
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
      resolve({ text: parsed.text || '', usage, sessionId: parsed.sessionId || null, code, stderr: parsed.stderr, raw: parsed.raw, toolUses: parsed.toolUses });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      for (const f of cleanupFiles) safeUnlink(f);
      console.error(`[LLM] spawn error (${label}): ${err.message}`);
      resolve({ text: '', usage: null, sessionId: null, code: 1, stderr: err.message, raw: '', toolUses: [] });
    });
  });
  promise.abort = () => { if (_abort) _abort(); };
  return promise;
}

/**
 * After a --resume call fails (non-zero exit or empty text), determine whether
 * the underlying session still exists (e.g. a tool timeout mid-turn) vs the
 * session is truly dead (expired, invalid ID, etc.).
 *
 * When the session still exists we should preserve it so the user can retry
 * with "try again" and resume into the same conversation.
 */
function isResumeSessionStillValid(result) {
  if (!result) return false;
  // If the CLI returned a session_id in the parsed output or raw stream,
  // the session is alive — the call just failed mid-execution.
  if (result.sessionId) return true;
  if (result.raw && result.raw.includes('"session_id"')) return true;
  return false;
}

/**
 * Streaming variant of callLLM — emits text chunks via onChunk callback.
 * Returns the same result object as callLLM when the process completes.
 * onChunk(text) is called for each assistant text block as it arrives.
 */
function callLLMStreaming(promptText, sysPromptText, { timeout = 120000, label = 'llm', model = 'sonnet', maxTurns = 1, allowedTools = '', sessionId = null, onChunk = () => {}, onToolUse = null, effort = null, direct = false } = {}) {
  let _abort = null;
  const promise = new Promise((resolve) => {
    const _startMs = Date.now();
    const { proc, cleanupFiles } = _spawnProcess(promptText, sysPromptText, { direct, label, model, maxTurns, allowedTools, effort, sessionId });
    const acc = _createStreamAccumulator({
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
      resolve({ text: parsed.text || '', usage, sessionId: parsed.sessionId || null, code, stderr: parsed.stderr, raw: parsed.raw, toolUses: parsed.toolUses });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      for (const f of cleanupFiles) safeUnlink(f);
      console.error(`[LLM-stream] spawn error (${label}): ${err.message}`);
      resolve({ text: '', usage: null, sessionId: null, code: 1, stderr: err.message, raw: '', toolUses: [] });
    });
  });
  promise.abort = () => { if (_abort) _abort(); };
  return promise;
}

module.exports = {
  callLLM,
  callLLMStreaming,
  trackEngineUsage,
  isResumeSessionStillValid,
};
