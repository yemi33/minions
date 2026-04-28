/**
 * engine/runtimes/copilot.js — GitHub Copilot CLI runtime adapter (P-1d4a8e7c).
 *
 * Implements the same contract as engine/runtimes/claude.js (see the header of
 * that file for the contract surface). Built against the empirical findings in
 * docs/copilot-cli-schema.md (P-8f2c4d9b spike) — every flag and parser branch
 * here traces back to a real CLI invocation captured during the spike.
 *
 * Headline behaviors that differ from Claude and surface as capability flags:
 *   - promptViaArg: false           — stdin works; -p with a 40 KB prompt hits
 *                                    Windows ARG_MAX (~32 KB) and CreateProcess
 *                                    rejects the spawn outright. Stdin is the
 *                                    only safe path on Windows.
 *   - systemPromptFile: false       — no --system-prompt-file flag exists, so
 *                                    buildPrompt() prepends a <system> block.
 *   - costTracking: false           — result.usage has premiumRequests count
 *                                    and durations only; no USD or per-token.
 *   - modelShorthands: false        — full model IDs like "claude-sonnet-4.5",
 *                                    "gpt-5.4". Bare "sonnet" / "opus" / "haiku"
 *                                    is a Claude-ism — log a one-time warning
 *                                    when seen so the user notices the mistake.
 *   - modelDiscovery: true          — GET https://api.githubcopilot.com/models
 *                                    with `gh auth token` Bearer returns the
 *                                    catalog (24 models on the test account).
 *   - effortLevels: true (max → xhigh) — Copilot accepts low/medium/high/xhigh;
 *                                    'max' is a Claude-ism that maps to 'xhigh'.
 *   - budgetCap / bareMode / fallbackModel: false — no equivalent flags.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execSync } = require('child_process');

const ENGINE_DIR = __dirname.replace(/[\\/]runtimes$/, '');
const isWin = process.platform === 'win32';

// ── Binary Resolution ───────────────────────────────────────────────────────
//
// Two install paths are supported:
//   1. Standalone `copilot` (preferred) — WinGet, scoop, or manual install. PATH
//      probe finds it; we cache the resolved path with `leadingArgs: []`.
//   2. `gh copilot` extension fallback — invoked as `gh copilot ...`. We return
//      `leadingArgs: ['copilot']` so engine/spawn-agent.js prepends "copilot"
//      to the gh binary invocation. NOTE: the older gh-copilot extension is
//      the explain/suggest UX, NOT the v1.0.36 agent CLI; flag support varies.
//      We surface it as best-effort and let preflight warn.
//
// We deliberately do NOT npm-probe — Copilot is not an npm package. Doing so
// would be confusing dead code that suggests an install path that doesn't exist.

const CAPS_FILE = path.join(ENGINE_DIR, 'copilot-caps.json');
const MODELS_CACHE = path.join(ENGINE_DIR, 'copilot-models.json');

function _safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function _safeWriteJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch { /* best effort */ }
}

function _execSyncCapture(cmd, env, timeoutMs = 10000) {
  return execSync(cmd, { encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true });
}

/**
 * Probe PATH for a standalone `copilot` binary. Returns the absolute path or
 * null. Resilient to non-zero exits (where/which return 1 when nothing found).
 */
function _findStandaloneCopilot(env) {
  try {
    const cmd = isWin ? 'where copilot 2>NUL' : 'which copilot 2>/dev/null';
    const which = _execSyncCapture(cmd, env).trim().split('\n')[0].trim();
    if (which && fs.existsSync(which)) return which;
  } catch { /* PATH probe is optional */ }
  return null;
}

/**
 * Probe `gh extension list` for the gh-copilot extension. Returns the absolute
 * path of the `gh` binary when found, null otherwise.
 *
 * `gh extension list` exits 0 with a list of extensions on stdout. We grep for
 * `gh-copilot`, the extension's repository slug. If `gh` isn't on PATH the
 * outer try-catch swallows the ENOENT.
 */
function _findGhCopilotExtension(env) {
  let ghPath = null;
  try {
    const cmd = isWin ? 'where gh 2>NUL' : 'which gh 2>/dev/null';
    const which = _execSyncCapture(cmd, env).trim().split('\n')[0].trim();
    if (!which) return null;
    ghPath = which;
  } catch { return null; }
  try {
    const out = _execSyncCapture('gh extension list', env);
    if (/gh-copilot/i.test(out)) return ghPath;
  } catch { /* `gh` may have no extensions or be misconfigured */ }
  return null;
}

/**
 * Resolve the Copilot CLI binary. Returns { bin, native, leadingArgs } or null.
 *
 * Cache shape (engine/copilot-caps.json):
 *   { copilotBin, copilotIsNative, leadingArgs, source, resolvedAt }
 *
 * `source` is 'standalone' or 'gh-extension' — it lets future preflight rules
 * surface "you're on the older gh-copilot extension; consider installing the
 * standalone CLI" warnings without re-probing.
 */
function resolveBinary({ env = process.env } = {}) {
  // 1. Cache hit — fastest path
  const cached = _safeJson(CAPS_FILE);
  if (cached?.copilotBin && fs.existsSync(cached.copilotBin)) {
    const leadingArgs = Array.isArray(cached.leadingArgs) ? cached.leadingArgs : [];
    return { bin: cached.copilotBin, native: !!cached.copilotIsNative, leadingArgs };
  }

  // 2. Standalone `copilot` first (preferred)
  const standalone = _findStandaloneCopilot(env);
  if (standalone) {
    const native = !isWin || path.extname(standalone).toLowerCase() === '.exe';
    _safeWriteJson(CAPS_FILE, {
      copilotBin: standalone,
      copilotIsNative: native,
      leadingArgs: [],
      source: 'standalone',
      resolvedAt: new Date().toISOString(),
    });
    return { bin: standalone, native, leadingArgs: [] };
  }

  // 3. `gh copilot` extension fallback (best-effort)
  const gh = _findGhCopilotExtension(env);
  if (gh) {
    const native = !isWin || path.extname(gh).toLowerCase() === '.exe';
    _safeWriteJson(CAPS_FILE, {
      copilotBin: gh,
      copilotIsNative: native,
      leadingArgs: ['copilot'],
      source: 'gh-extension',
      resolvedAt: new Date().toISOString(),
    });
    return { bin: gh, native, leadingArgs: ['copilot'] };
  }

  return null;
}

// ── Model Resolution ────────────────────────────────────────────────────────
//
// Copilot models are full IDs (`claude-sonnet-4.5`, `gpt-5.4`, ...). The
// adapter passes them through verbatim. When we see a Claude shorthand
// ('sonnet', 'opus', 'haiku') we log ONCE — a stronger signal than silently
// passing it to Copilot, which would respond with an unknown-model error.

const _CLAUDE_SHORTHANDS = new Set(['sonnet', 'opus', 'haiku']);
let _shorthandWarningLogged = false;

function _resetShorthandWarning() { _shorthandWarningLogged = false; }

function resolveModel(input, { logger = console } = {}) {
  if (input == null || input === '') return undefined;
  const s = String(input);
  if (_CLAUDE_SHORTHANDS.has(s.toLowerCase()) && !_shorthandWarningLogged) {
    _shorthandWarningLogged = true;
    try {
      const warn = (logger && typeof logger.warn === 'function') ? logger.warn.bind(logger) : null;
      if (warn) warn(`[copilot] "${s}" is a Claude family shorthand; Copilot expects a full model id (e.g. claude-sonnet-4.5). Passing through verbatim — Copilot will likely reject it.`);
    } catch { /* logger may be unwired during tests */ }
  }
  return s;
}

/**
 * Map effort levels. Copilot accepts low|medium|high|xhigh. The Claude-ism
 * 'max' (used loosely as "give it the most thinking budget") maps to 'xhigh'
 * so a single fleet-wide effort knob works for both runtimes.
 */
function _mapEffort(level) {
  if (level == null || level === '') return undefined;
  const s = String(level);
  if (s === 'max') return 'xhigh';
  return s;
}

// ── Argument Construction ───────────────────────────────────────────────────
//
// Always-on baseline (per docs/copilot-cli-schema.md §3 and the PRD spec):
//   --output-format json -s --no-color --plain-diff --autopilot
//   --allow-all --no-ask-user --log-level error
//
// Conditional flags only emitted when their corresponding opt is set/truthy.
// Copilot has no --verbose flag — never emit it. The `bare` / `maxBudget` /
// `fallbackModel` opts are silently ignored (their capability flags are false
// so engine code shouldn't pass them, but we tolerate them gracefully).

function buildArgs(opts = {}) {
  const {
    model,
    maxTurns,
    effort,
    sessionId,
    addDirs,
    stream,
    disableBuiltinMcps,
    suppressAgentsMd,
    reasoningSummaries,
  } = opts;

  const args = [
    '--output-format', 'json',
    '-s',
    '--no-color',
    '--plain-diff',
    '--autopilot',
    '--allow-all',
    '--no-ask-user',
    '--log-level', 'error',
  ];

  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d) args.push('--add-dir', String(d));
    }
  }

  if (maxTurns != null && maxTurns !== '') {
    args.push('--max-autopilot-continues', String(maxTurns));
  }

  if (model) args.push('--model', String(model));

  const mappedEffort = _mapEffort(effort);
  if (mappedEffort) args.push('--effort', mappedEffort);

  // Toggle flags — strict-true gating to avoid surprise opt-in from truthy
  // strings or 1/0 numbers in config.
  if (disableBuiltinMcps === true) args.push('--disable-builtin-mcps');
  if (suppressAgentsMd === true) args.push('--no-custom-instructions');
  if (reasoningSummaries === true) args.push('--enable-reasoning-summaries');

  // --stream takes a value: 'on' or 'off'. Caller passes that exact value.
  if (stream === 'on' || stream === 'off') {
    args.push('--stream', stream);
  }

  // --resume uses the equals-form per Copilot help: --resume[=value]. Without
  // the `=`, commander.js treats the next token as a positional, not the value.
  if (sessionId) args.push(`--resume=${sessionId}`);

  return args;
}

// ── Prompt Construction ─────────────────────────────────────────────────────
//
// Copilot has no --system-prompt-file flag, so we deliver the system prompt
// as a <system>...</system> block prepended to the user prompt. Mirrors the
// convention from Anthropic tool-use docs and is recognized as "system role"
// content by every model in the Copilot catalog.

function buildPrompt(promptText, sysPromptText) {
  const user = promptText == null ? '' : String(promptText);
  if (sysPromptText == null || sysPromptText === '') return user;
  return `<system>\n${String(sysPromptText)}\n</system>\n\n${user}`;
}

// ── Output Parsing ──────────────────────────────────────────────────────────
//
// Whitelist of event types observed during the spike (docs/copilot-cli-schema.md
// §5.1). Any other type is wrapped as `{ type: 'ignore', original: <type> }` so
// downstream consumers can drop them without crashing.

const KNOWN_EVENT_TYPES = new Set([
  'session.mcp_server_status_changed',
  'session.mcp_servers_loaded',
  'session.skills_loaded',
  'session.tools_updated',
  'session.info',
  'session.task_complete',
  'user.message',
  'assistant.turn_start',
  'assistant.turn_end',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.message_delta',
  'assistant.message',
  'tool.execution_start',
  'tool.execution_complete',
  'result',
  // Edge case observed once during stdin testing — appears to be a meta event
  // for tool invocation. Allowlisted so it doesn't get marked 'ignore'.
  'function',
]);

/**
 * Parse the full JSONL output of a Copilot CLI invocation.
 * Returns { text, usage, sessionId, model } — same shape as the Claude adapter
 * so engine/lifecycle.js can consume both transparently.
 *
 *   - text:      concatenation of every `assistant.message.data.content` value
 *                across turns (multi-turn autopilot loops emit one per turn)
 *   - usage:     mapped from the terminal `result` event. Copilot doesn't
 *                report cost/tokens — those fields are NULL, not 0, so the
 *                dashboard can distinguish "Copilot didn't tell us" from
 *                "this turn cost $0".
 *   - sessionId: from `result.sessionId` (camelCase — Copilot's spelling)
 *   - model:     from the first `session.tools_updated.data.model` event
 *
 * `maxTextLength` tail-slices the concatenated text — VERDICTs / completion
 * blocks live at the END of agent output, so we slice from the tail.
 */
function parseOutput(raw, { maxTextLength = 0 } = {}) {
  const safeRaw = raw == null ? '' : String(raw);
  if (!safeRaw) return { text: '', usage: null, sessionId: null, model: null };

  const messageContents = [];
  let usage = null;
  let sessionId = null;
  let model = null;
  let outputTokensTotal = 0;
  let turnEndCount = 0;

  for (const rawLine of safeRaw.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    const type = obj.type;
    if (type === 'assistant.message') {
      const content = obj.data?.content;
      if (typeof content === 'string' && content) messageContents.push(content);
      const ot = obj.data?.outputTokens;
      if (typeof ot === 'number') outputTokensTotal += ot;
    } else if (type === 'assistant.turn_end') {
      turnEndCount += 1;
    } else if (type === 'session.tools_updated' && model == null) {
      const m = obj.data?.model;
      if (typeof m === 'string' && m) model = m;
    } else if (type === 'result') {
      if (typeof obj.sessionId === 'string') sessionId = obj.sessionId;
      const u = obj.usage || {};
      usage = {
        // Cost / token fields are NULL — Copilot doesn't expose them.
        // Mapping them to 0 would falsely suggest "this turn cost $0" in the
        // dashboard cost telemetry.
        costUsd: null,
        inputTokens: null,
        // outputTokens is recovered from per-turn assistant.message events
        // since the result event itself doesn't report it.
        outputTokens: outputTokensTotal > 0 ? outputTokensTotal : null,
        cacheRead: null,
        cacheCreation: null,
        durationMs: typeof u.totalApiDurationMs === 'number' ? u.totalApiDurationMs : 0,
        numTurns: turnEndCount,
        // Copilot-specific extension — preserved alongside the standard shape
        // so the engine can distinguish "this turn cost N premium requests"
        // from token accounting on the Claude path.
        premiumRequests: typeof u.premiumRequests === 'number' ? u.premiumRequests : 0,
        sessionDurationMs: typeof u.sessionDurationMs === 'number' ? u.sessionDurationMs : 0,
      };
    }
  }

  let text = messageContents.join('');
  if (maxTextLength && text.length > maxTextLength) {
    text = text.slice(-maxTextLength);
  }

  return { text, usage, sessionId, model };
}

/**
 * Parse a single line from the Copilot JSONL stream. Returns the parsed event
 * object, or null when the line is empty / non-JSON.
 *
 * Unknown event types are NOT dropped — they're rewrapped with
 * `{ type: 'ignore', original }` so consumers can log/track schema drift
 * without crashing on a new event the spike didn't observe.
 */
function parseStreamChunk(line) {
  const trimmed = line == null ? '' : String(line).trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return obj || null;
  if (!KNOWN_EVENT_TYPES.has(obj.type)) {
    return { type: 'ignore', original: obj.type, raw: obj };
  }
  return obj;
}

// ── Error Normalization ─────────────────────────────────────────────────────

function parseError(rawOutput) {
  const text = rawOutput == null ? '' : String(rawOutput);
  if (!text) return { message: '', code: null, retriable: true };
  const lower = text.toLowerCase();

  if (/not authenticated|copilot login|please.*log.*in|401|403 forbidden|unauthorized/i.test(text)) {
    return { message: 'Copilot authentication failed', code: 'auth-failure', retriable: false };
  }
  if (/rate limit|too many requests|\b429\b/i.test(text)) {
    return { message: 'Copilot rate limit hit', code: 'rate-limit', retriable: true };
  }
  if (/unknown model|model not found|model.*invalid|invalid model/i.test(text)) {
    return { message: 'Copilot rejected the requested model', code: 'unknown-model', retriable: false };
  }
  if (/budget.*exceed|premium.*limit.*reach|quota.*exceed/i.test(lower)) {
    return { message: 'Copilot premium-request budget exceeded', code: 'budget-exceeded', retriable: false };
  }
  if (/internal error|panic|uncaught|copilot.*crashed|fatal: copilot/i.test(lower)) {
    return { message: 'Copilot CLI crashed', code: 'crash', retriable: true };
  }
  return { message: '', code: null, retriable: true };
}

// ── Model Discovery ─────────────────────────────────────────────────────────
//
// GET https://api.githubcopilot.com/models with a Bearer token.
// Token resolution priority:
//   1. process.env.GH_TOKEN
//   2. process.env.COPILOT_GITHUB_TOKEN
//   3. (best-effort) `gh auth token` — only if env is empty
//
// All failure modes (no token, network error, non-200 status, malformed JSON,
// no chat-type models in response) return null. Returning null tells the
// dashboard to fall back to free-text input.

function _resolveCopilotToken(env) {
  if (env.GH_TOKEN) return env.GH_TOKEN.trim();
  if (env.COPILOT_GITHUB_TOKEN) return env.COPILOT_GITHUB_TOKEN.trim();
  try {
    const out = _execSyncCapture('gh auth token', env, 5000).trim();
    if (out) return out;
  } catch { /* gh not installed or not authed */ }
  return null;
}

function _httpsGetJson(url, headers, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ status: 0, body: null, error: 'invalid-url' }); }
    const opts = {
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: timeoutMs,
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(buf); } catch { /* non-JSON response */ }
        resolve({ status: res.statusCode || 0, body, raw: buf });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0, body: null, error: 'timeout' }); });
    req.end();
  });
}

/**
 * Fetch the Copilot model catalog. Returns `Promise<{id,name,provider}[] | null>`.
 * `null` means "couldn't reach the API or the response wasn't usable" — the
 * settings UI falls back to free-text input.
 *
 * Filters applied to `data[]`:
 *   - drop embedding-only models (capabilities.type !== 'chat')
 *   - drop disabled models (policy.state must be 'enabled' OR preview must be true)
 */
async function listModels({ env = process.env, timeoutMs = 10000 } = {}) {
  const token = _resolveCopilotToken(env);
  if (!token) return null;
  const result = await _httpsGetJson('https://api.githubcopilot.com/models', {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    // The Copilot models API expects an editor identifier; the values mirror
    // what the CLI itself sends so the API treats us like a normal client.
    'Editor-Version': 'vscode/1.95.0',
    'Editor-Plugin-Version': 'copilot/1.0.36',
    'User-Agent': 'GitHubCopilotChat/0.20.0',
  }, timeoutMs);
  if (result.status !== 200 || !result.body || !Array.isArray(result.body.data)) return null;

  const models = [];
  for (const m of result.body.data) {
    if (!m || typeof m !== 'object') continue;
    if (m.capabilities?.type !== 'chat') continue;
    const enabled = m.policy?.state === 'enabled' || m.preview === true;
    if (!enabled) continue;
    models.push({ id: String(m.id), name: m.name ? String(m.name) : String(m.id), provider: m.vendor ? String(m.vendor) : '' });
  }
  if (models.length === 0) return null;
  return models;
}

// ── Capability Block ────────────────────────────────────────────────────────

const capabilities = {
  // JSONL events on stdout per --output-format json
  streaming: true,
  // --resume=<id> resumes a session
  sessionResume: true,
  // No --system-prompt-file flag — system prompt is merged into stdin
  systemPromptFile: false,
  // --effort low|medium|high|xhigh (no 'max' — adapter maps it)
  effortLevels: true,
  // result.usage carries premiumRequests count, no USD or tokens
  costTracking: false,
  // No 'sonnet'/'opus'/'haiku' shorthand — Copilot expects full model IDs
  modelShorthands: false,
  // GET https://api.githubcopilot.com/models works (verified during spike)
  modelDiscovery: true,
  // Stdin works in non-interactive mode; -p with >32KB hits Windows ARG_MAX
  promptViaArg: false,
  // No --max-budget-usd
  budgetCap: false,
  // No --bare (closest equivalent is --no-custom-instructions, gated separately)
  bareMode: false,
  // No --fallback-model
  fallbackModel: false,
  // Copilot manages session state internally in ~/.copilot/session-state/
  sessionPersistenceControl: false,
};

module.exports = {
  name: 'copilot',
  capabilities,
  resolveBinary,
  capsFile: CAPS_FILE,
  listModels,
  modelsCache: MODELS_CACHE,
  // Use the same wrapper as Claude — spawn-agent.js is runtime-agnostic per P-9c4f2d6a
  spawnScript: path.join(ENGINE_DIR, 'spawn-agent.js'),
  buildArgs,
  buildPrompt,
  resolveModel,
  parseOutput,
  parseStreamChunk,
  parseError,
  // Exposed for unit tests — engine code MUST go through resolveRuntime + the
  // adapter contract; never reach into these helpers directly.
  _CLAUDE_SHORTHANDS,
  _resetShorthandWarning,
  _mapEffort,
  KNOWN_EVENT_TYPES,
};
