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
 *   - resolveModel(input) → string|undefined — shorthand expansion / passthrough
 *   - parseOutput(raw) → { text, usage, sessionId, model }
 *   - parseStreamChunk(line) → parsed event object or null
 *   - parseError(rawOutput) → { message, code, retriable }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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
    return { bin: cached.claudeBin, native: !!cached.claudeIsNative, leadingArgs: [] };
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

  if (/invalid api key|api key.*invalid|authentication.*fail|unauthorized|401|403 forbidden|please.*log.*in|claude\.ai\/login/i.test(text)) {
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

// ── Capability Block ────────────────────────────────────────────────────────

const capabilities = {
  // Streaming JSONL events on stdout
  streaming: true,
  // `--resume <session-id>` resumes a previous turn
  sessionResume: true,
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
};

// Install hint surfaced when `resolveBinary()` returns null. Consumed by
// `engine/preflight.js` (per-runtime binary check) and `engine/spawn-agent.js`
// (fatal error message). Multi-line so all platforms see actionable guidance.
const INSTALL_HINT = 'install from https://claude.ai/download or: npm install -g @anthropic-ai/claude-code';

module.exports = {
  name: 'claude',
  capabilities,
  resolveBinary,
  capsFile: CAPS_FILE,
  listModels,
  modelsCache: MODELS_CACHE,
  spawnScript: path.join(ENGINE_DIR, 'spawn-agent.js'),
  installHint: INSTALL_HINT,
  buildArgs,
  buildPrompt,
  resolveModel,
  parseOutput,
  parseStreamChunk,
  parseError,
  // Exposed for unit tests — never imported by engine code
  _CLAUDE_SHORTHANDS,
};
