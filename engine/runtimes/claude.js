/**
 * engine/runtimes/claude.js — Claude Code CLI runtime adapter.
 *
 * Foundation extracted from spawn-agent.js, engine.js, llm.js, and shared.js
 * with zero behavioral change. This adapter is the single source of truth for
 * everything Claude-CLI-specific: binary resolution, arg construction, prompt
 * preparation, output parsing, and error normalization.
 *
 * Adapter contract (all runtimes must implement):
 *   - name: string
 *   - capabilities: { ... } feature flags consumed by engine code
 *   - resolveBinary() → { bin, native, leadingArgs }
 *   - capsFile: absolute path of the binary-resolution cache for this runtime
 *   - listModels() → Promise<{id,name,provider}[] | null>
 *   - modelsCache: absolute path of the model-list cache for this runtime
 *   - spawnScript: absolute path of the spawn wrapper (or null if direct-only)
 *   - buildArgs(opts) → string[] — CLI args excluding the binary
 *   - buildPrompt(promptText, sysPromptText) → string — final prompt delivered
 *   - getUserAssetDirs(opts) → string[] — runtime-native global asset roots
 *   - getSkillRoots(opts) → {scope,dir,projectName?}[] — skill discovery roots
 *   - getSkillWriteTargets(opts) → {personal,project} — extraction targets
 *   - resolveModel(input) → string|undefined — shorthand expansion / passthrough
 *   - parseOutput(raw) → { text, usage, sessionId, model }
 *   - parseStreamChunk(line) → parsed event object or null
 *   - parseError(rawOutput) → { message, code, retriable }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FAILURE_CLASS, safeWrite, ts } = require('../shared');

const ENGINE_DIR = __dirname.replace(/[\\/]runtimes$/, '');
const MINIONS_DIR = path.resolve(ENGINE_DIR, '..');

const isWin = process.platform === 'win32';

// ── Binary Resolution ────────────────────────────────────────────────────────
// Mirrors engine/spawn-agent.js:26-91. Cached at engine/claude-caps.json so the
// repeated path-probe (PATH / npm-global / npm-root-g) only happens once per
// install.

const CAPS_FILE = path.join(ENGINE_DIR, 'claude-caps.json');

function _safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function _safeWriteJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch { /* best effort */ }
}

function _inferClaudeNativeFromBin(claudeBin) {
  const ext = path.extname(claudeBin).toLowerCase();
  return isWin ? ext === '.exe' : ext !== '.js';
}

function _probeClaudePackage(pkgDir) {
  const nativeBin = path.join(pkgDir, 'bin', isWin ? 'claude.exe' : 'claude');
  if (fs.existsSync(nativeBin)) return { bin: nativeBin, native: true };
  const cliJs = path.join(pkgDir, 'cli.js');
  if (fs.existsSync(cliJs)) return { bin: cliJs, native: false };
  return null;
}

function _execSyncCapture(cmd, env) {
  const { execSync } = require('child_process');
  return execSync(cmd, { encoding: 'utf8', env, timeout: 10000, windowsHide: true });
}

/**
 * Resolve the Claude CLI binary. Returns { bin, native, leadingArgs } or null.
 * `leadingArgs` is always [] for Claude (the binary is invoked directly with no
 * subcommand prefix). Reserved on the contract for runtimes like `gh copilot`
 * where the runtime is a subcommand of another binary.
 *
 * Backwards-compat: honors `config.claude.binary` from minions config when set
 * and the resulting path exists on disk.
 */
function resolveBinary({ env = process.env, config = null } = {}) {
  // 0. Honor explicit override from config.claude.binary (legacy field)
  const overridePath = config?.claude?.binary && config.claude.binary !== 'claude'
    ? config.claude.binary
    : null;
  if (overridePath && fs.existsSync(overridePath)) {
    // If the override points at an npm package dir, probe it — otherwise treat
    // as a direct binary path.
    const probed = _probeClaudePackage(overridePath);
    if (probed) return { bin: probed.bin, native: probed.native, leadingArgs: [] };
    const native = !isWin || path.extname(overridePath).toLowerCase() === '.exe';
    return { bin: overridePath, native, leadingArgs: [] };
  }

  // 1. Cache hit — fastest path
  const cached = _safeJson(CAPS_FILE);
  if (cached?.claudeBin && fs.existsSync(cached.claudeBin)) {
    const native = cached.claudeIsNative != null
      ? !!cached.claudeIsNative
      : _inferClaudeNativeFromBin(cached.claudeBin);
    if (cached.claudeIsNative == null) {
      cached.claudeIsNative = native;
      _safeWriteJson(CAPS_FILE, cached);
    }
    return { bin: cached.claudeBin, native, leadingArgs: [] };
  }

  // 2. PATH lookup → probe the resolved path's neighbouring node_modules dir
  let bin = null;
  let native = false;
  try {
    const cmd = isWin ? 'where claude 2>NUL' : 'which claude 2>/dev/null';
    const which = _execSyncCapture(cmd, env).trim().split('\n')[0].trim();
    if (which) {
      const whichNative = isWin
        ? which
        : which.replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':/').replace(/\//g, path.sep);
      const ccPkg = path.join(path.dirname(whichNative), 'node_modules', '@anthropic-ai', 'claude-code');
      const found = _probeClaudePackage(ccPkg);
      if (found) {
        bin = found.bin;
        native = found.native;
      } else if (!isWin || path.extname(whichNative).toLowerCase() === '.exe') {
        bin = whichNative;
        native = true;
      }
    }
  } catch { /* PATH probe is optional */ }

  // 3. Known npm-global locations
  if (!bin) {
    const prefixes = [
      env.npm_config_prefix ? path.join(env.npm_config_prefix, 'node_modules', '@anthropic-ai', 'claude-code') : '',
      env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code') : '',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
      '/usr/lib/node_modules/@anthropic-ai/claude-code',
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code',
      path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'),
      path.join(path.dirname(process.execPath), 'node_modules', '@anthropic-ai', 'claude-code'),
      path.join(MINIONS_DIR, 'node_modules', '@anthropic-ai', 'claude-code'),
    ].filter(Boolean);
    for (const pkg of prefixes) {
      try {
        const found = _probeClaudePackage(pkg);
        if (found) { bin = found.bin; native = found.native; break; }
      } catch {}
    }
  }

  // 4. `npm root -g` fallback
  if (!bin) {
    try {
      const globalRoot = _execSyncCapture('npm root -g', env).trim();
      const found = _probeClaudePackage(path.join(globalRoot, '@anthropic-ai', 'claude-code'));
      if (found) { bin = found.bin; native = found.native; }
    } catch { /* optional */ }
  }

  if (!bin) return null;

  // Persist cache for the next spawn
  _safeWriteJson(CAPS_FILE, { claudeBin: bin, claudeIsNative: native });
  return { bin, native, leadingArgs: [] };
}

// ── Model Resolution ─────────────────────────────────────────────────────────

const _CLAUDE_SHORTHANDS = new Set(['sonnet', 'opus', 'haiku']);

/**
 * Pass through Claude model strings verbatim — including the family
 * shorthands `sonnet`, `opus`, `haiku`, which Claude CLI itself expands.
 * Returns `undefined` for nullish input so the caller omits `--model`.
 */
function resolveModel(input) {
  if (input == null || input === '') return undefined;
  return String(input);
}

/**
 * Claude has no public model-enumeration mechanism — the CLI bakes the model
 * list internally and the Anthropic API doesn't expose it. Returning null
 * tells the dashboard to fall back to a free-text input.
 */
function listModels() {
  return null;
}

const MODELS_CACHE = path.join(ENGINE_DIR, 'claude-models.json');

// ── Argument Construction ────────────────────────────────────────────────────

/**
 * Build the CLI args (excluding the binary itself) for a Claude invocation.
 *
 * Mirrors the union of:
 *   - engine.js:817-844 (agent dispatch)
 *   - engine/llm.js:68-76 (CC / doc-chat direct spawn)
 *   - spawn-agent.js:118-128 (--system-prompt-file injection on first turn)
 *
 * Per the plan: emits `--dangerously-skip-permissions` (the modern Claude flag)
 * instead of the old `--permission-mode bypassPermissions`. The adapter owns
 * `--add-dir` injection too (when `opts.addDirs` is supplied); spawn-agent.js
 * just hands the dirs over so the wrapper itself stays runtime-agnostic.
 *
 * Conditional flags are emitted ONLY when their corresponding capability is
 * truthy. Copilot-only flags (`stream`, `disableBuiltinMcps`,
 * `suppressAgentsMd`, `reasoningSummaries`) are silently ignored on the Claude
 * path — runtime adapters MUST be tolerant of unknown opts so engine code can
 * pass the same option bag to every adapter without branching.
 */
function buildArgs(opts = {}) {
  const {
    model,
    maxTurns,
    allowedTools,
    effort,
    sessionId,
    sysPromptFile,
    addDirs,
    outputFormat = 'stream-json',
    verbose = true,
    maxBudget,
    bare = false,
    fallbackModel,
  } = opts;

  const args = ['-p', '--output-format', outputFormat];
  if (outputFormat === 'stream-json') args.push('--include-partial-messages');
  if (maxTurns != null) args.push('--max-turns', String(maxTurns));
  if (model) args.push('--model', String(model));
  if (verbose) args.push('--verbose');
  if (sysPromptFile) args.push('--system-prompt-file', sysPromptFile);
  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d) args.push('--add-dir', String(d));
    }
  }
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (effort) args.push('--effort', String(effort));
  args.push('--dangerously-skip-permissions');
  if (maxBudget != null) args.push('--max-budget-usd', String(maxBudget));
  if (bare === true) args.push('--bare');
  if (fallbackModel) args.push('--fallback-model', String(fallbackModel));
  if (sessionId) args.push('--resume', String(sessionId));
  return args;
}

function buildSpawnFlags(opts = {}) {
  const flags = ['--runtime', 'claude'];
  if (opts.maxTurns != null) flags.push('--max-turns', String(opts.maxTurns));
  if (opts.model) flags.push('--model', String(opts.model));
  if (opts.allowedTools) flags.push('--allowedTools', String(opts.allowedTools));
  if (opts.effort) flags.push('--effort', String(opts.effort));
  if (opts.sessionId) flags.push('--resume', String(opts.sessionId));
  if (opts.maxBudget != null) flags.push('--max-budget-usd', String(opts.maxBudget));
  if (opts.bare === true) flags.push('--bare');
  if (opts.fallbackModel) flags.push('--fallback-model', String(opts.fallbackModel));
  if (opts.stream != null && opts.stream !== '') flags.push('--stream', String(opts.stream));
  if (opts.disableBuiltinMcps === true) flags.push('--disable-builtin-mcps');
  if (opts.suppressAgentsMd === true) flags.push('--no-custom-instructions');
  if (opts.reasoningSummaries === true) flags.push('--enable-reasoning-summaries');
  return flags;
}

function getUserAssetDirs({ homeDir = os.homedir() } = {}) {
  return [path.join(homeDir, '.claude')];
}

function getSkillRoots({ homeDir = os.homedir(), project = null } = {}) {
  const roots = [
    { scope: 'claude-code', dir: path.join(homeDir, '.claude', 'skills') },
  ];
  if (project?.localPath) {
    roots.push({
      scope: 'project',
      projectName: project.name,
      dir: path.join(project.localPath, '.claude', 'skills'),
    });
  }
  return roots;
}

function getSkillWriteTargets({ homeDir = os.homedir(), project = null } = {}) {
  return {
    personal: path.join(homeDir, '.claude', 'skills'),
    project: project?.localPath ? path.join(project.localPath, '.claude', 'skills') : null,
  };
}

// Stamped into every session.json this adapter writes so the pre-spawn resume
// path can detect "session was produced by a different runtime" — Claude
// rejects Copilot session IDs (and vice versa) with "No conversation found",
// which would otherwise burn a retry slot before the post-failure cleanup at
// engine.js:1195 fires. See W-mot9fwya000d09cb.
const RUNTIME_NAME = 'claude';

function getResumeSessionId({ agentId, branchName, agentsDir, maxAgeMs = 2 * 60 * 60 * 1000, logger = console } = {}) {
  if (!agentId || agentId.startsWith('temp-') || !agentsDir) return null;
  const sessionPath = path.join(agentsDir, agentId, 'session.json');
  try {
    const sessionFile = _safeJson(sessionPath);
    if (!sessionFile?.sessionId || !sessionFile.savedAt) return null;

    // Runtime-mismatch invalidation. Distinct from stale-by-age: the session is
    // structurally unusable on this runtime, so drop it AND clear session.json
    // so the next dispatch starts fresh instead of failing with --resume.
    // Legacy sessions (no `runtime` field) are treated as compatible — opt-in
    // check, no false invalidations on first deploy.
    if (sessionFile.runtime && sessionFile.runtime !== RUNTIME_NAME) {
      if (logger && typeof logger.info === 'function') {
        logger.info(`Skipping resume for ${agentId}: runtime mismatch (session: ${sessionFile.runtime}, current: ${RUNTIME_NAME}) — clearing session.json`);
      }
      try { fs.unlinkSync(sessionPath); } catch {}
      return null;
    }

    const sessionAge = Date.now() - new Date(sessionFile.savedAt).getTime();
    const sameBranch = branchName && sessionFile.branch && sessionFile.branch === branchName;
    if (sessionAge < maxAgeMs && sameBranch) {
      if (logger && typeof logger.info === 'function') {
        logger.info(`Resuming session ${sessionFile.sessionId} for ${agentId} on branch ${branchName} (age: ${Math.round(sessionAge / 60000)}min)`);
      }
      return sessionFile.sessionId;
    }
  } catch (e) {
    if (logger && typeof logger.warn === 'function') logger.warn('session resume lookup: ' + e.message);
  }
  return null;
}

function saveSession({ agentId, dispatchId, branch, sessionId, agentsDir, now = ts, writeJson = safeWrite, logger = console } = {}) {
  if (!sessionId || !agentId || agentId.startsWith('temp-') || !agentsDir) return false;
  try {
    writeJson(path.join(agentsDir, agentId, 'session.json'), {
      sessionId,
      dispatchId,
      savedAt: typeof now === 'function' ? now() : new Date().toISOString(),
      branch: branch || null,
      runtime: RUNTIME_NAME,
    });
    return true;
  } catch (err) {
    if (logger && typeof logger.warn === 'function') logger.warn(`Session save: ${err.message}`);
    return false;
  }
}

function detectPermissionGate(outputChunk) {
  const lower = String(outputChunk || '').toLowerCase();
  return /\b(trust this|do you trust|allow access|grant permission|approve tools?|permission prompt)\b/.test(lower);
}

function getPromptDeliveryMode() {
  return 'stdin';
}

function usesSystemPromptFile({ isResume } = {}) {
  return !isResume;
}

function _runtimeFailureClass(code) {
  if (code === 'auth-failure' || code === 'budget-exceeded') return FAILURE_CLASS.PERMISSION_BLOCKED;
  if (code === 'context-limit') return FAILURE_CLASS.OUT_OF_CONTEXT;
  if (code === 'crash') return FAILURE_CLASS.SPAWN_ERROR;
  return null;
}

function classifyFailure({ code, stdout = '', stderr = '', fallback } = {}) {
  if (code === 78) return { failureClass: FAILURE_CLASS.CONFIG_ERROR, retryable: false, message: 'Claude configuration error' };
  const parsed = parseError(`${stdout || ''}\n${stderr || ''}`);
  const runtimeClass = parsed.code ? _runtimeFailureClass(parsed.code) : null;
  if (runtimeClass) return { failureClass: runtimeClass, retryable: parsed.retriable !== false, message: parsed.message || '' };
  const fallbackClass = typeof fallback === 'function' ? fallback(code, stdout, stderr) : FAILURE_CLASS.UNKNOWN;
  return { failureClass: fallbackClass, retryable: parsed.retriable !== false, message: parsed.message || '' };
}

/**
 * Build the final prompt text delivered to the Claude CLI. Claude takes the
 * system prompt via `--system-prompt-file` and the user prompt via stdin, so
 * `buildPrompt()` is a passthrough — `sysPromptText` is delivered separately
 * by the spawn wrapper, not embedded in the user prompt.
 */
function buildPrompt(promptText, /* sysPromptText */ _sys) {
  return String(promptText == null ? '' : promptText);
}

// ── Output Parsing ───────────────────────────────────────────────────────────

/**
 * Parse the full stream-json output of a Claude CLI invocation.
 * Returns { text, usage, sessionId, model } — same shape as the legacy
 * `shared.parseStreamJsonOutput`.
 *
 * Tail-slices `text` when `maxTextLength` is set — VERDICTs, completion blocks,
 * and PR URLs live at the END of agent output (regression #1234).
 */
function parseOutput(raw, { maxTextLength = 0 } = {}) {
  let text = '';
  let usage = null;
  let sessionId = null;
  let model = null;

  function extractResult(obj) {
    if (!obj || obj.type !== 'result') return false;
    if (obj.result) text = maxTextLength ? obj.result.slice(-maxTextLength) : obj.result;
    if (obj.session_id) sessionId = obj.session_id;
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
    return true;
  }

  const safeRaw = raw == null ? '' : String(raw);
  const lines = safeRaw.split('\n');

  // Forward-scan for the init message (always near the top)
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.subtype === 'init' && obj.model) { model = obj.model; break; }
    } catch {}
  }

  // Backward-scan for the result message (always at the tail)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      try {
        const arr = JSON.parse(line);
        for (let j = arr.length - 1; j >= 0; j--) {
          if (extractResult(arr[j])) break;
        }
        if (text || usage) break;
      } catch {}
    }
    if (line.startsWith('{')) {
      try {
        if (extractResult(JSON.parse(line))) break;
      } catch {}
    }
  }

  return { text, usage, sessionId, model };
}

/**
 * Parse a single line from the stream-json stdout. Returns the parsed event
 * object, or null when the line is empty / non-JSON.
 *
 * Used by the streaming accumulator in engine/llm.js to react to assistant
 * text blocks, tool-use blocks, and the terminal `result` event without
 * waiting for the whole process to exit.
 */
function parseStreamChunk(line) {
  const trimmed = line == null ? '' : String(line).trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ── Error Normalization ──────────────────────────────────────────────────────

/**
 * Inspect raw agent output (stdout/stderr concatenated by the caller) and map
 * common Claude error patterns onto a normalized shape:
 *   { message, code, retriable }
 *
 * `code` values are stable identifiers consumed by retry/escalation logic:
 *   - 'auth-failure'      — invalid API key / credit-card / org-blocked
 *   - 'context-limit'     — context window exhausted
 *   - 'budget-exceeded'   — `--max-budget-usd` ceiling hit
 *   - 'crash'             — CLI crashed (segfault, panic, "Internal error")
 *   - null                — no recognised pattern
 *
 * Returns `{ message: '', code: null, retriable: true }` when input is empty
 * (no signal — let upstream classification have the final word).
 */
function parseError(rawOutput) {
  const text = rawOutput == null ? '' : String(rawOutput);
  if (!text) return { message: '', code: null, retriable: true };
  const lower = text.toLowerCase();

  const hasExplicitAuthFailure = /invalid api key|api key.*invalid|authentication.*fail|\bunauthorized\b|please.*log.*in|claude\.ai\/login/i.test(text);
  const hasAuthStatusCode = /\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|statuscode|response(?:\s+status)?|api(?:\s+(?:error|response|status))?)\s*[:=]?\s*(?:401|403)\b|\b(?:401\s+unauthorized|403\s+forbidden)\b/i.test(text);
  if (hasExplicitAuthFailure || hasAuthStatusCode) {
    return { message: 'Claude authentication failed', code: 'auth-failure', retriable: false };
  }
  if (/prompt is too long|context window|context.*length.*exceeded|token limit|conversation.*too long/i.test(text)) {
    return { message: 'Claude context window exhausted', code: 'context-limit', retriable: false };
  }
  if (/budget.*exceed|max.budget.usd.*reach|cost.*limit.*exceed/i.test(lower)) {
    return { message: 'Claude budget cap exceeded', code: 'budget-exceeded', retriable: false };
  }
  if (/internal error|panic|segmentation fault|claude.*crashed|fatal: claude/i.test(lower)) {
    return { message: 'Claude CLI crashed', code: 'crash', retriable: true };
  }
  return { message: '', code: null, retriable: true };
}

// ── Stream Consumer ─────────────────────────────────────────────────────────
//
// Per-stream consumer factory invoked by engine/llm.js's accumulator. The
// accumulator owns global stream state (stdout/stderr/text dedup/tool dedup)
// and exposes the `ctx` API below; the consumer owns Claude-specific per-stream
// state (joined-text accumulator, content-block Map for tool/thinking
// tracking) and translates Claude event shapes into ctx callbacks.
//
// `ctx` shape (provided by accumulator):
//   maxTextLength, pushText(value), pushToolUse(name, input),
//   notifyThinking(), notifyTaskComplete(summary, success),
//   setUsage(usage), setSessionId(id), setText(value),
//   toolUseAlreadySeen(name, input)

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

function createStreamConsumer(ctx) {
  // Per-stream local state. `claudeStreamBlocks` is kept for Map-based
  // bookkeeping (tool-use blocks, thinking events, out-of-order text-block
  // reassembly). The incremental `claudeJoinedText` string is the hot-path
  // accumulator — appending one delta at a time keeps the stream loop O(n).
  let claudeJoinedText = '';
  const claudeStreamBlocks = new Map();

  function _rebuildClaudeJoinedText() {
    claudeJoinedText = Array.from(claudeStreamBlocks.keys()).sort((a, b) => a - b)
      .map(index => claudeStreamBlocks.get(index))
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('');
  }

  function _consumeStreamEvent(obj) {
    const event = obj?.event;
    if (!event || typeof event !== 'object') return;
    if (event.type === 'message_start') {
      claudeStreamBlocks.clear();
      claudeJoinedText = '';
      return;
    }
    if (event.type === 'content_block_start') {
      const index = Number.isInteger(event.index) ? event.index : Number(event.index) || 0;
      const block = event.content_block || {};
      claudeStreamBlocks.set(index, { type: block.type || '', text: block.text || '' });
      if (THINKING_BLOCK_TYPES.has(block.type)) ctx.notifyThinking();
      // Out-of-order block landing: rebuild from the Map. Common case is
      // monotonic in-order arrival, where the trailing-append branch wins.
      const indices = Array.from(claudeStreamBlocks.keys());
      const isTrailing = indices.every(i => i <= index);
      if (!isTrailing) {
        _rebuildClaudeJoinedText();
      } else if (block.type === 'text' && block.text) {
        claudeJoinedText += block.text;
      }
      if (claudeJoinedText) ctx.pushText(claudeJoinedText);
      return;
    }
    if (event.type === 'content_block_delta') {
      const index = Number.isInteger(event.index) ? event.index : Number(event.index) || 0;
      const delta = event.delta || {};
      if (delta.type === 'thinking_delta' || typeof delta.thinking === 'string') ctx.notifyThinking();
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        const block = claudeStreamBlocks.get(index) || { type: 'text', text: '' };
        block.type = 'text';
        block.text = (block.text || '') + delta.text;
        claudeStreamBlocks.set(index, block);
        // Common case: deltas arrive monotonically per index — append directly.
        claudeJoinedText += delta.text;
        ctx.pushText(claudeJoinedText);
      }
      return;
    }
    // content_block_stop / message_delta / message_stop are observed but the
    // accumulator doesn't need to act on them — terminal text comes via the
    // result event below.
  }

  function consume(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.session_id) ctx.setSessionId(obj.session_id);

    if (obj.type === 'stream_event') {
      _consumeStreamEvent(obj);
      return;
    }

    if (obj.type === 'result' && typeof obj.result === 'string') {
      // Claude result event: terminal text + usage. Override any previously
      // streamed text — this is the authoritative final answer.
      ctx.setText(obj.result);
      if (obj.total_cost_usd || obj.usage) {
        ctx.setUsage({
          costUsd: obj.total_cost_usd || 0,
          inputTokens: obj.usage?.input_tokens || 0,
          outputTokens: obj.usage?.output_tokens || 0,
          cacheRead: obj.usage?.cache_read_input_tokens || obj.usage?.cacheReadInputTokens || 0,
          cacheCreation: obj.usage?.cache_creation_input_tokens || obj.usage?.cacheCreationInputTokens || 0,
          durationMs: obj.duration_ms || 0,
          numTurns: obj.num_turns || 0,
        });
      }
      return;
    }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      // Claude assistant turn: content blocks (text + tool_use).
      // Multi-text-block messages (with --include-partial-messages) need their
      // text JOINED before pushText, otherwise each block overwrites the prior.
      let assistantText = '';
      for (const block of obj.message.content) {
        if (block?.type === 'text' && block.text) {
          assistantText += block.text;
        } else if (THINKING_BLOCK_TYPES.has(block?.type)) {
          ctx.notifyThinking();
        } else if (block?.type === 'tool_use' && block.name) {
          ctx.pushToolUse(block.name, block.input || {});
        }
      }
      if (assistantText) ctx.pushText(assistantText);
    }
  }

  function reset() {
    claudeJoinedText = '';
    claudeStreamBlocks.clear();
  }

  return { consume, reset };
}

// ── Capability Block ────────────────────────────────────────────────────────

const capabilities = {
  // Streaming JSONL events on stdout
  streaming: true,
  // `--resume <session-id>` resumes a previous turn
  sessionResume: true,
  // Emits a resumable session ID before the terminal result event
  midRunSessionId: true,
  // Accepts the system prompt via `--system-prompt-file`
  systemPromptFile: true,
  // Honours `--effort low|medium|high|xhigh`
  effortLevels: true,
  // Emits `total_cost_usd` and detailed token usage in the result event
  costTracking: true,
  // Family shorthands (`sonnet` / `opus` / `haiku`) are accepted by the CLI
  modelShorthands: true,
  // No public model enumeration mechanism — settings UI uses free-text
  modelDiscovery: false,
  // Prompt is delivered via stdin (`-p` mode), NOT via `--prompt <text>`
  promptViaArg: false,
  // Supports `--max-budget-usd <n>`
  budgetCap: true,
  // Supports `--bare` (suppress CLAUDE.md auto-discovery)
  bareMode: true,
  // Supports `--fallback-model <id>`
  fallbackModel: true,
  // Engine controls session persistence (writes session.json on completion)
  sessionPersistenceControl: true,
  // Adapter implements createStreamConsumer(ctx) — required by llm.js accumulator
  streamConsumer: true,
};

// Install hint surfaced when `resolveBinary()` returns null. Consumed by
// `engine/preflight.js` (per-runtime binary check) and `engine/spawn-agent.js`
// (fatal error message). Multi-line so all platforms see actionable guidance.
const INSTALL_HINT = 'install from https://claude.ai/download or: npm install -g @anthropic-ai/claude-code';

// Asset roots passed to spawn as `--add-dir` so worktrees can read globally
// installed skills. `~/.agents/skills` is the cross-runtime portable location;
// every runtime adapter exposes it so a skill placed there is genuinely visible
// to every runtime (matches the directory name's promise).
function getUserAssetDirs({ homeDir = os.homedir() } = {}) {
  return [
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.agents'),
  ];
}

function getSkillRoots({ homeDir = os.homedir(), project = null } = {}) {
  const roots = [
    { dir: path.join(homeDir, '.claude', 'skills'), scope: 'claude-code' },
    { dir: path.join(homeDir, '.agents', 'skills'), scope: 'agent-skill' },
  ];
  if (project?.localPath) {
    const projectName = project.name || path.basename(project.localPath);
    roots.push(
      { dir: path.join(project.localPath, '.claude', 'skills'), scope: 'project', projectName },
      { dir: path.join(project.localPath, '.agents', 'skills'), scope: 'project', projectName },
    );
  }
  return roots;
}

function getSkillWriteTargets({ homeDir = os.homedir(), project = null } = {}) {
  const targets = { personal: path.join(homeDir, '.claude', 'skills') };
  if (project?.localPath) {
    targets.project = path.join(project.localPath, '.claude', 'skills');
  }
  return targets;
}

// Heuristic: does `model` look like a Claude model identifier? Powers the
// preflight "stale model after CLI switch" warning in cli.js. Returning false
// means "this looks wrong for Claude" — gpt-5.4 / o3-* / codex etc. Keep this
// here (not in cli.js) so the runtime owns its own model namespace and adding
// a future runtime never requires editing cli.js.
function modelLooksFamiliar(model) {
  if (!model) return true;
  const m = String(model).toLowerCase();
  if (m.startsWith('claude-')) return true;
  if (m === 'sonnet' || m === 'opus' || m === 'haiku') return true;
  return false;
}

module.exports = {
  name: 'claude',
  capabilities,
  resolveBinary,
  capsFile: CAPS_FILE,
  listModels,
  modelsCache: MODELS_CACHE,
  spawnScript: path.join(ENGINE_DIR, 'spawn-agent.js'),
  installHint: INSTALL_HINT,
  buildSpawnFlags,
  buildArgs,
  buildPrompt,
  getUserAssetDirs,
  getSkillRoots,
  getSkillWriteTargets,
  getResumeSessionId,
  saveSession,
  detectPermissionGate,
  getPromptDeliveryMode,
  usesSystemPromptFile,
  classifyFailure,
  resolveModel,
  modelLooksFamiliar,
  parseOutput,
  parseStreamChunk,
  parseError,
  createStreamConsumer,
  // Exposed for unit tests — never imported by engine code
  _CLAUDE_SHORTHANDS,
  THINKING_BLOCK_TYPES,
};
