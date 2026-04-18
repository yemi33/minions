/**
 * engine/shared.js — Shared utilities for Minions engine, dashboard, and LLM modules.
 * Extracted from engine.js and dashboard.js to eliminate duplication.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MINIONS_DIR = process.env.MINIONS_TEST_DIR || path.resolve(__dirname, '..');
const PR_LINKS_PATH = path.join(MINIONS_DIR, 'engine', 'pr-links.json');
const PINNED_ITEMS_PATH = path.join(MINIONS_DIR, 'engine', 'kb-pins.json');
const LOG_PATH = path.join(MINIONS_DIR, 'engine', 'log.json');

// ── Timestamps & Logging ────────────────────────────────────────────────────
// Extracted from engine.js so engine/* modules can import directly without
// circular-requiring the orchestrator.

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

// ── Log Buffering ──────────────────────────────────────────────────────────
// Buffer log entries in memory and flush to disk periodically to reduce lock
// contention (~139 calls/tick → 1 lock acquisition per flush).
const _logBuffer = [];
let _logFlushTimer = null;

function log(level, msg, meta = {}) {
  const entry = { timestamp: ts(), level, message: msg, ...meta };
  // Console output remains immediate
  console.log(`[${logTs()}] [${level}] ${msg}`);

  _logBuffer.push(entry);

  // Start the flush timer lazily on first buffered entry
  if (!_logFlushTimer) {
    _logFlushTimer = setInterval(() => {
      _flushLogBuffer();
    }, ENGINE_DEFAULTS.logFlushInterval);
    // Unref so the timer doesn't keep the process alive during shutdown
    if (_logFlushTimer.unref) _logFlushTimer.unref();
  }

  // Flush immediately when buffer exceeds threshold
  if (_logBuffer.length >= ENGINE_DEFAULTS.logBufferSize) {
    _flushLogBuffer();
  }
}

function _flushLogBuffer() {
  if (_logBuffer.length === 0) return;
  const entries = _logBuffer.splice(0);
  try {
    mutateJsonFileLocked(LOG_PATH, (logData) => {
      if (!Array.isArray(logData)) logData = logData?.entries || [];
      logData.push(...entries);
      if (logData.length >= 2500) logData.splice(0, logData.length - 2000);
      return logData;
    }, { defaultValue: [] });
  } catch { /* logging should never crash the caller */ }
}

/** Flush buffered log entries to disk. Call during graceful shutdown to drain the buffer. */
function flushLogs() {
  _flushLogBuffer();
  if (_logFlushTimer) {
    clearInterval(_logFlushTimer);
    _logFlushTimer = null;
  }
}

// ── File I/O ─────────────────────────────────────────────────────────────────

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // Primary file missing or corrupted — try restoring from .backup sidecar
    const backupPath = p + '.backup';
    try {
      const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      // Backup is valid — restore it to the primary file (atomic via safeWrite)
      console.log(`[safeJson] restored ${path.basename(p)} from .backup sidecar`);
      try {
        safeWrite(p, backupData);
        // Verify the restored file matches expected content
        const verifyData = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (JSON.stringify(verifyData) !== JSON.stringify(backupData)) {
          console.error(`[safeJson] CRITICAL: backup restore verification failed for ${p} — written data does not match backup`);
        }
      } catch (restoreErr) {
        // Restore-to-primary is best-effort — backupData is already parsed and valid.
        // Don't throw: disk-full / permission errors should not discard valid data.
        console.error(`[safeJson] restore write failed for ${p}: ${restoreErr.message}`);
      }
      return backupData;
    } catch (outerErr) {
      // Let CRITICAL errors propagate — callers must know about data integrity failures
      if (outerErr.message && outerErr.message.includes('CRITICAL')) throw outerErr;
      return null;
    }
  }
}

/** Null-safe safeJson wrapper — returns {} when file is missing/corrupt. */
function safeJsonObj(p) { return safeJson(p) || {}; }

/** Null-safe safeJson wrapper — returns [] when file is missing/corrupt. */
function safeJsonArr(p) { return safeJson(p) || []; }

/**
 * Monotonic counter for generating unique temp file names within this process.
 * Assumes single-thread execution (no worker_threads). If worker_threads are
 * introduced, this must be replaced with an atomic or thread-safe counter to
 * avoid temp file name collisions.
 */
let _tmpCounter = 0;

function safeWrite(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = p + '.tmp.' + process.pid + '.' + (++_tmpCounter);
  try {
    fs.writeFileSync(tmp, content);
    // Atomic rename — retry on Windows EPERM (file locking)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmp, p);
        return;
      } catch (e) {
        if (e.code === 'EPERM' && attempt < 4) {
          const delay = 50 * (attempt + 1); // 50, 100, 150, 200ms
          sleepMs(delay);
          continue;
        }
        // Final attempt failed — throw to let caller retry
        try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
        throw e;
      }
    }
    // All rename attempts exhausted without throw — should not happen, but clean up
    try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
    throw new Error(`[safeWrite] All 5 rename attempts failed for ${p}`);
  } catch (err) {
    // Clean up tmp if it still exists, then re-throw — never silently swallow
    try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
    throw err;
  }
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* cleanup */ }
}

// ── Dispatch Prompt Sidecar (#1167) ─────────────────────────────────────────
// Large prompts (PR diffs, build error logs, coalesced human feedback) inlined
// into dispatch.json caused hundreds-of-MB bloat per entry and eventual V8 OOM
// at startup. Sidecar files keep dispatch.json small while preserving full
// content for the agent at spawn time.

// Resolve lazily so MINIONS_TEST_DIR overrides work in tests.
function _promptContextsDir() {
  return path.join(MINIONS_DIR, 'engine', 'contexts');
}
// Keep the constant for callers that expect a stable export; callers that need
// the current value (tests) should call _promptContextsDir().
const PROMPT_CONTEXTS_DIR = _promptContextsDir();

/** Absolute path to the sidecar prompt file for a given dispatch id. */
function dispatchPromptSidecarPath(dispatchId) {
  if (!dispatchId) return null;
  const safeId = String(dispatchId).replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(_promptContextsDir(), `${safeId}.md`);
}

/**
 * If the dispatch item's prompt exceeds thresholdBytes, write the full prompt
 * to engine/contexts/<id>.md and replace `item.prompt` with a short stub
 * + `_promptFile` reference. Mutates item in place and returns true when
 * sidecaring happened, false otherwise.
 */
function sidecarDispatchPrompt(item, thresholdBytes) {
  if (!item || typeof item.prompt !== 'string') return false;
  const threshold = Number(thresholdBytes) > 0
    ? Number(thresholdBytes)
    : ENGINE_DEFAULTS.maxDispatchPromptBytes;
  const byteLen = Buffer.byteLength(item.prompt, 'utf8');
  if (byteLen <= threshold) return false;
  if (!item.id) return false; // can't sidecar without a stable id
  try {
    const ctxDir = _promptContextsDir();
    if (!fs.existsSync(ctxDir)) fs.mkdirSync(ctxDir, { recursive: true });
    const sidecar = dispatchPromptSidecarPath(item.id);
    safeWrite(sidecar, item.prompt);
    const relPath = path.relative(MINIONS_DIR, sidecar).replace(/\\/g, '/');
    item._promptFile = relPath;
    item._promptBytes = byteLen;
    item.prompt = `[Prompt sidecarred to ${relPath} — ${Math.round(byteLen / 1024)} KB. The engine reads the sidecar when spawning this agent.]`;
    try { log('warn', `Sidecarred oversized dispatch prompt: ${item.id} (${Math.round(byteLen / 1024)} KB → ${relPath})`); } catch { /* logger may not be ready */ }
    return true;
  } catch (e) {
    try { log('warn', `sidecarDispatchPrompt failed for ${item.id}: ${e.message}`); } catch { /* cleanup */ }
    return false;
  }
}

/**
 * Read the effective prompt for a dispatch item. Prefers the sidecar file when
 * `_promptFile` is set so spawnAgent always sees the full prompt even though
 * dispatch.json only stores a small stub.
 */
function resolveDispatchPrompt(item) {
  if (!item) return '';
  if (item._promptFile) {
    const candidates = [
      path.isAbsolute(item._promptFile) ? item._promptFile : path.resolve(MINIONS_DIR, item._promptFile),
      dispatchPromptSidecarPath(item.id),
    ].filter(Boolean);
    for (const c of candidates) {
      try {
        const content = fs.readFileSync(c, 'utf8');
        if (content) return content;
      } catch { /* try next candidate */ }
    }
  }
  return item.prompt || '';
}

/** Remove the sidecar prompt file for a completed/cancelled dispatch. */
function deleteDispatchPromptSidecar(item) {
  if (!item) return;
  const paths = new Set();
  if (item._promptFile) {
    paths.add(path.isAbsolute(item._promptFile) ? item._promptFile : path.resolve(MINIONS_DIR, item._promptFile));
  }
  const idPath = dispatchPromptSidecarPath(item.id);
  if (idPath) paths.add(idPath);
  for (const p of paths) safeUnlink(p);
}

/**
 * Startup guard: throw a clear error when a state file has grown past
 * maxStateFileBytes. Without this the dashboard silently OOMs on JSON.parse
 * (seen on a 491 MB dispatch.json + 509 MB cooldowns.json — #1167).
 * The thrown error points at the bloated file so operators can act instead
 * of chasing V8 heap traces.
 */
function assertStateFileSize(filePath, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : ENGINE_DEFAULTS.maxStateFileBytes;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > limit) {
      throw new Error(
        `State file too large: ${filePath} is ${Math.round(stat.size / (1024 * 1024))} MB ` +
        `(limit ${Math.round(limit / (1024 * 1024))} MB). ` +
        `This usually means dispatch prompts or cooldown contexts were inlined and not sidecarred. ` +
        `Inspect/trim the file manually, then restart. See engine/contexts/ for sidecar files.`
      );
    }
  } catch (e) {
    if (e.code === 'ENOENT') return; // file absent is fine
    if (e.message && e.message.startsWith('State file too large:')) throw e;
    // Other stat errors (permission etc.) — do not block startup
  }
}

function sleepMs(ms) {
  try {
    const ab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(ab), 0, 0, ms);
  } catch {
    // Fallback: synchronous sleep via child process — avoids busy-wait blocking the event loop
    _spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${Math.max(0, Math.floor(ms))})`], { windowsHide: true });
  }
}

const LOCK_STALE_MS = 60000; // 60 seconds — force-remove locks older than this

function withFileLock(lockPath, fn, {
  timeoutMs = 5000,
  retryDelayMs = 25,
  retries = 0,
  retryBackoffMs = 1000
} = {}) {
  let lastErr = null;
  const maxAttempts = 1 + Math.max(0, retries);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff between retry attempts: retryBackoffMs * 2^(attempt-1)
      const backoff = retryBackoffMs * Math.pow(2, attempt - 1);
      sleepMs(backoff);
    }
    const start = Date.now();
    let fd = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const dir = path.dirname(lockPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fd = fs.openSync(lockPath, 'wx');
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Check for stale lock — if lock file is older than LOCK_STALE_MS, force-remove it
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            try {
              fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
              // ENOENT: another process deleted the lock between stat and unlink — safe to retry
              if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
            }
            continue; // lock just removed — retry immediately
          }
        } catch (staleErr) {
          // ENOENT from statSync: lock file disappeared between EEXIST and stat — retry will succeed
          if (staleErr.code !== 'ENOENT') throw staleErr;
        }
        sleepMs(retryDelayMs);
      }
    }
    if (fd === null) {
      lastErr = new Error(`Lock timeout: ${lockPath}`);
      continue; // retry if attempts remain
    }

    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch { /* cleanup */ }
      try { fs.unlinkSync(lockPath); } catch { /* cleanup */ }
    }
  }
  throw lastErr;
}

function mutateJsonFileLocked(filePath, mutateFn, {
  defaultValue = {},
  lockRetries,
  lockRetryBackoffMs,
  skipWriteIfUnchanged = false
} = {}) {
  const lockPath = `${filePath}.lock`;
  const retries = lockRetries ?? ENGINE_DEFAULTS.lockRetries;
  const retryBackoffMs = lockRetryBackoffMs ?? ENGINE_DEFAULTS.lockRetryBackoffMs;
  return withFileLock(lockPath, () => {
    const fileExists = fs.existsSync(filePath);
    let data = safeJson(filePath);
    const parsedInvalid = fileExists && data === null;
    if (data === null || typeof data !== 'object') data = Array.isArray(defaultValue) ? [...defaultValue] : { ...defaultValue };
    const beforeSerialized = skipWriteIfUnchanged ? JSON.stringify(data) : null;
    if (path.basename(filePath) === 'pull-requests.json' && Array.isArray(data)) {
      normalizePrRecords(data, resolveProjectForPrPath(filePath));
    }
    const next = mutateFn(data);
    const finalData = next === undefined ? data : next;
    const shouldWrite = !skipWriteIfUnchanged || parsedInvalid || JSON.stringify(finalData) !== beforeSerialized;
    if (shouldWrite) {
      // Back up last-known-good state before mutation (best-effort)
      const backupPath = filePath + '.backup';
      try { if (fileExists) fs.copyFileSync(filePath, backupPath); } catch { /* backup is best-effort */ }
      safeWrite(filePath, finalData);
    }
    return finalData;
  }, { retries, retryBackoffMs });
}

/**
 * Generate a unique ID suffix: timestamp + 4 random chars.
 * Use for filenames that could collide (dispatch IDs, temp files, etc.)
 */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Return a unique filepath by appending -2, -3, etc. if the file already exists.
 * E.g. uniquePath('/plans/foo.json') → '/plans/foo-2.json' if foo.json exists.
 */
function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

function truncateTextBytes(text, maxBytes, suffix = '') {
  const value = text == null ? '' : String(text);
  if (!maxBytes || maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffixText = suffix == null ? '' : String(suffix);
  const suffixBytes = Buffer.byteLength(suffixText, 'utf8');
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= targetBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low) + suffixText;
}

function tailTextBytes(text, maxBytes, prefix = '') {
  const value = text == null ? '' : String(text);
  if (!maxBytes || maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const prefixText = prefix == null ? '' : String(prefix);
  const prefixBytes = Buffer.byteLength(prefixText, 'utf8');
  const targetBytes = Math.max(0, maxBytes - prefixBytes);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(mid), 'utf8') <= targetBytes) high = mid;
    else low = mid + 1;
  }
  return prefixText + value.slice(low);
}

function appendTextTail(existing, addition, maxBytes, prefix = '') {
  return tailTextBytes((existing || '') + (addition || ''), maxBytes, prefix);
}

// ── Inbox Helpers ───────────────────────────────────────────────────────────

/**
 * Write a file to notes/inbox/ with slug+date-based dedup.
 * Filename: `{agentId}-{slug}-{YYYY-MM-DD}.md`
 * If a file with the same prefix already exists for today, skip the write.
 * Pattern matches writeInboxAlert() in dispatch.js.
 * @param {string} agentId - Agent or source identifier (e.g. 'engine', 'ralph')
 * @param {string} slug - Short descriptive slug (e.g. 'prd-completion-plan1')
 * @param {string} content - Markdown content to write
 * @returns {boolean} true if a write occurred, false if deduped/skipped
 */
/**
 * Extract note ID from frontmatter of an inbox file. Returns null if no ID found.
 */
function parseNoteId(content) {
  if (!content) return null;
  const m = content.match(/^---[\r\n]+[\s\S]*?id:\s*(NOTE-\w+)[\s\S]*?---/);
  return m ? m[1] : null;
}

function writeToInbox(agentId, slug, content, _inboxDir, metadata) {
  try {
    const inboxDir = _inboxDir || path.join(MINIONS_DIR, 'notes', 'inbox');
    const safeSlug = safeSlugComponent(slug, 80);
    const prefix = `${agentId}-${safeSlug}-${dateStamp()}`;
    const existing = safeReadDir(inboxDir).find(f => f.startsWith(prefix));
    if (existing) return false;
    const noteId = `NOTE-${uid()}`;
    // Build optional metadata lines for frontmatter injection
    const metaLines = (metadata && typeof metadata === 'object')
      ? Object.entries(metadata).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join('\n')
      : '';
    // Inject structured ID as YAML frontmatter if content doesn't already have it
    const hasFrontmatter = /^\s*---[\r\n]/.test(content);
    const tagged = hasFrontmatter
      ? content.replace(/^\s*---[\r\n]+/, `---\nid: ${noteId}\n${metaLines ? metaLines + '\n' : ''}`)
      : `---\nid: ${noteId}\nagent: ${agentId}\ndate: ${dateStamp()}\n${metaLines ? metaLines + '\n' : ''}---\n\n${content}`;
    const filePath = path.join(inboxDir, `${prefix}.md`);
    safeWrite(filePath, tagged);
    return noteId;
  } catch (e) {
    log('warn', `writeToInbox failed: ${e.message}`);
    return false;
  }
}

// ── Process Spawning ────────────────────────────────────────────────────────
// All child process calls go through these to ensure windowsHide: true

const { execSync: _execSync, spawnSync: _spawnSync, spawn: _spawn, exec: _cbExec } = require('child_process');

function exec(cmd, opts = {}) {
  return _execSync(cmd, { windowsHide: true, ...opts });
}

function run(cmd, opts = {}) {
  return _spawn(cmd, { windowsHide: true, ...opts });
}

function runFile(file, args, opts = {}) {
  return _spawn(file, args, { windowsHide: true, ...opts });
}

function execSilent(cmd, opts = {}) {
  return _execSync(cmd, { stdio: 'pipe', windowsHide: true, ...opts });
}

/**
 * Async version of exec() — runs a shell command without blocking the event loop.
 * Returns a Promise that resolves with { stdout, stderr } or rejects on error/timeout.
 * Drop-in replacement for sync `exec()` in async contexts.
 *
 * @param {string} cmd - Shell command to run
 * @param {object} opts - Options (same as child_process.exec: timeout, cwd, encoding, env, etc.)
 * @returns {Promise<string>} stdout (trimmed if encoding is set)
 */
function execAsync(cmd, opts = {}) {
  const { timeout, ...rest } = opts;
  return new Promise((resolve, reject) => {
    const child = _cbExec(cmd, { windowsHide: true, encoding: 'utf8', ...rest, timeout: timeout || 30000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve(stdout);
    });
    // Safety: ensure child is killed if parent process exits
    child.unref && child.unref();
  });
}

/**
 * Detect the default branch for a git repo. Tries in order:
 * 1. The configured mainBranch (if it exists as a local or remote ref)
 * 2. git symbolic-ref refs/remotes/origin/HEAD (what the remote says)
 * 3. Fallback to 'main'
 * Cached per rootDir to avoid repeated git calls within a tick.
 */
const _mainBranchCache = new Map();
function resolveMainBranch(rootDir, configuredBranch) {
  const cacheKey = rootDir + ':' + (configuredBranch || '');
  const cached = _mainBranchCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 300000) return cached.branch; // 5min TTL

  const gitOpts = { cwd: rootDir, encoding: 'utf8', stdio: 'pipe', timeout: 5000, windowsHide: true };

  // 1. If configured branch exists, use it
  if (configuredBranch) {
    try {
      _execSync(`git rev-parse --verify "${configuredBranch}"`, gitOpts);
      _mainBranchCache.set(cacheKey, { branch: configuredBranch, ts: Date.now() });
      return configuredBranch;
    } catch { /* configured branch doesn't exist locally */ }
    try {
      _execSync(`git rev-parse --verify "origin/${configuredBranch}"`, gitOpts);
      _mainBranchCache.set(cacheKey, { branch: configuredBranch, ts: Date.now() });
      return configuredBranch;
    } catch { /* not on remote either */ }
  }

  // 2. Auto-detect from remote HEAD
  try {
    const ref = _execSync('git symbolic-ref refs/remotes/origin/HEAD', gitOpts).trim();
    const branch = ref.replace('refs/remotes/origin/', '');
    if (branch) {
      _mainBranchCache.set(cacheKey, { branch, ts: Date.now() });
      return branch;
    }
  } catch { /* no remote HEAD set */ }

  // 3. Fallback
  const fallback = configuredBranch || 'main';
  _mainBranchCache.set(cacheKey, { branch: fallback, ts: Date.now() });
  return fallback;
}

// ── Environment ─────────────────────────────────────────────────────────────

let _cleanEnvCache = null;
function cleanChildEnv() {
  if (_cleanEnvCache) return { ..._cleanEnvCache };
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete env[key];
  }
  _cleanEnvCache = env;
  return { ..._cleanEnvCache };
}

// Environment for git commands — prevents credential manager from opening browser
function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

// ── Claude Output Parsing ───────────────────────────────────────────────────

/**
 * Parse stream-json output from claude CLI. Returns { text, usage }.
 * Single source of truth — used by llm.js, consolidation.js, and lifecycle.js.
 */
function parseStreamJsonOutput(raw, { maxTextLength = 0 } = {}) {
  let text = '';
  let usage = null;
  let sessionId = null;
  let model = null;

  function extractResult(obj) {
    if (obj.type !== 'result') return false;
    // Slice from the tail, not the head — review VERDICTs, structured completion
    // blocks, PR URLs, and agent conclusions all appear at the END of the output.
    // Head-slicing truncated VERDICTs and caused review work items to be
    // re-dispatched up to maxRetries times despite successful completion (#1234).
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

  const lines = raw.split('\n');
  // Scan forward for model from init message (appears early in output)
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.subtype === 'init' && obj.model) { model = obj.model; break; }
    } catch {}
  }
  // Scan backward for result (appears at end of output)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Handle JSON array format (--output-format json)
    if (line.startsWith('[')) {
      try {
        const arr = JSON.parse(line);
        for (let j = arr.length - 1; j >= 0; j--) {
          if (extractResult(arr[j])) break;
        }
        if (text || usage) break;
      } catch {}
    }
    // Handle newline-delimited format (--output-format stream-json)
    if (line.startsWith('{')) {
      try {
        if (extractResult(JSON.parse(line))) break;
      } catch {}
    }
  }
  return { text, usage, sessionId, model };
}

// ── Knowledge Base ──────────────────────────────────────────────────────────

const KB_CATEGORIES = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];

/**
 * Classify an inbox item into a knowledge base category.
 * Single source of truth — used by consolidation.js (both LLM and regex paths).
 */
function classifyInboxItem(name, content) {
  const nameLower = (name || '').toLowerCase();
  const contentLower = (content || '').toLowerCase();
  if (nameLower.includes('review') || nameLower.includes('pr-') || nameLower.includes('pr4') || nameLower.includes('feedback')) return 'reviews';
  if (nameLower.includes('build') || nameLower.includes('bt-') || contentLower.includes('build pass') || contentLower.includes('build fail') || contentLower.includes('lint')) return 'build-reports';
  if (contentLower.includes('architecture') || contentLower.includes('design doc') || contentLower.includes('system design') || contentLower.includes('data flow') || contentLower.includes('how it works')) return 'architecture';
  if (contentLower.includes('convention') || contentLower.includes('pattern') || contentLower.includes('always use') || contentLower.includes('never use') || contentLower.includes('rule:') || contentLower.includes('best practice')) return 'conventions';
  return 'project-notes';
}

// ── Engine Defaults ─────────────────────────────────────────────────────────
// Single source of truth for engine configuration defaults.
// Used by: engine.js, minions.js (init). config.template.json only has the project schema.

const ENGINE_DEFAULTS = {
  tickInterval: 60000,
  maxConcurrent: 5,
  inboxConsolidateThreshold: 5,
  agentTimeout: 18000000,  // 5h
  heartbeatTimeout: 300000, // 5min — base heartbeat for most work types
  heartbeatTimeouts: {}, // per-type overrides; merged with defaults at runtime (see timeout.js)
  maxTurns: 100,
  worktreeCreateTimeout: 300000, // 5min for git worktree add on large Windows repos
  worktreeCreateRetries: 1, // retry once on transient timeout/lock races
  worktreeRoot: '../worktrees',
  worktreeCountCacheTtl: 30000, // 30s — TTL for cached _countWorktrees() result in dashboard
  idleAlertMinutes: 15,
  fanOutTimeout: null, // falls back to agentTimeout
  restartGracePeriod: 1200000, // 20min
  shutdownTimeout: 300000, // 5min — max wait for active agents during graceful shutdown
  allowTempAgents: false, // opt-in: spawn ephemeral agents when all permanent agents are busy
  autoDecompose: true, // auto-decompose implement:large items into sub-tasks
  autoApprovePlans: false, // auto-approve PRDs without waiting for human approval
  autoArchive: false, // opt-in: auto-archive plans after verify completes (false = mark ready, user archives manually)
  autoFixConflicts: true, // auto-dispatch fix agents when a PR has merge conflicts
  autoFixBuilds: true, // auto-dispatch fix agents when a PR build fails
  meetingRoundTimeout: 900000, // 15min per meeting round before auto-advance
  evalLoop: true, // enable review→fix loop after implementation completes
  evalMaxIterations: 3, // max review→fix cycles before escalating to human
  evalMaxCost: null, // USD ceiling per work item across all eval iterations; null = no limit (gather baseline data first)
  maxRetries: 3, // max dispatch retries before marking work item as failed
  pipelineApiRetries: 2, // max attempts for pipeline API calls
  pipelineApiRetryDelay: 2000, // ms delay between pipeline API retries
  versionCheckInterval: 3600000, // 1 hour — how often to check npm for updates (ms)
  logFlushInterval: 5000, // 5s — how often to flush buffered log entries to disk
  logBufferSize: 50, // flush immediately when buffer exceeds this many entries
  lockRetries: 0, // no retries — single 5s timeout window with 25ms polling (200 attempts) is sufficient; stale lock recovery at 60s handles crashes
  lockRetryBackoffMs: 500, // base backoff between lock retries (doubles each attempt: 500ms, 1s, 2s, ...)
  maxBuildFixAttempts: 3, // max consecutive auto-fix dispatch cycles per PR before escalation to human
  buildFixGracePeriod: 600000, // 10min — wait for CI to run after build fix before re-dispatching
  adoPollEnabled: true, // poll ADO PR status, comments, and reconciliation on each tick cycle
  ghPollEnabled: true, // poll GitHub PR status, comments, and reconciliation on each tick cycle
  prPollStatusEvery: 12,   // poll PR build/review/merge status every N ticks for both ADO and GitHub (~12 min at default interval)
  prPollCommentsEvery: 12, // poll PR human comments every N ticks for both ADO and GitHub (~12 min at default interval)
  autoCompletePrs: false, // auto-merge PRs when builds green + review approved (opt-in)
  prMergeMethod: 'squash', // merge method: squash, merge, rebase
  ignoredCommentAuthors: [], // comments from these authors are auto-closed and never trigger fixes
  agentBusyReassignMs: 600000, // 10min — reassign work item to another agent if preferred agent is busy beyond this threshold
  ccModel: 'sonnet', // model for Command Center and doc-chat (sonnet, haiku, opus)
  ccEffort: null, // effort level for CC/doc-chat (null, 'low', 'medium', 'high')
  heartbeatTimeouts: {}, // populated after WORK_TYPE is defined (below)
  maxPendingContexts: 20, // cap pendingContexts arrays in cooldowns.json to prevent unbounded growth
  maxPendingContextEntryBytes: 256 * 1024, // 256 KB — cap each pendingContexts entry to prevent huge PR comments from bloating cooldowns.json
  maxDispatchPromptBytes: 1024 * 1024, // 1 MB — dispatch items with prompts larger than this sidecar to engine/contexts/ to prevent dispatch.json OOM (#1167)
  maxStateFileBytes: 100 * 1024 * 1024, // 100 MB — fail startup with a clear error when dispatch.json / cooldowns.json exceed this, rather than silently OOMing on JSON.parse (#1167)
  ccMaxTurns: 50, // max tool-use turns for CC/doc-chat before CLI stops
  ccSessionTtlMs: 2 * 60 * 60 * 1000, // 2h — expire stale resumed CC sessions to cap context growth
  docSessionTtlMs: 7 * 24 * 60 * 60 * 1000, // 7d — longer-lived doc sessions, still bounded
  maxLlmRawBytes: 256 * 1024, // keep only a bounded stdout tail from direct Claude calls
  maxLlmStderrBytes: 64 * 1024, // keep only a bounded stderr tail from direct Claude calls
  maxLlmLineBufferBytes: 128 * 1024, // cap the incremental JSON line buffer to avoid malformed-stream OOMs
  maxReferencedPlanBytes: 12 * 1024, // cap full plan injection when implicit task context references prior plans
  maxReferencedNotesBytes: 5 * 1024, // cap referenced inbox note excerpts injected via task context resolution
  maxResolvedTaskContextBytes: 20 * 1024, // bound the total implicit context injected from referenced plans/notes
  maxNotesPromptBytes: 8 * 1024, // cap Team Notes injected into every playbook prompt
  maxMeetingPromptBytes: 16 * 1024, // cap meeting findings/debate context injected into prompts
  maxMeetingHumanNotesBytes: 2 * 1024, // cap human note bullet lists injected into meeting prompts
  maxPipelineMeetingContextBytes: 16 * 1024, // cap aggregated meeting/dependency context for pipeline plan generation
  notesArchiveMaxFiles: 2000, // keep notes/archive bounded during periodic cleanup
  // Teams integration — config.teams shape: { enabled, appId, appPassword, certPath, privateKeyPath, tenantId, notifyEvents, ccMirror, inboxPollInterval }
  // Auth modes: (1) appId + appPassword (client secret), or (2) appId + certPath + privateKeyPath + tenantId (certificate)
  teams: {
    enabled: false,
    appId: '',
    appPassword: '',
    certPath: '',          // PEM certificate file path (certificate auth)
    privateKeyPath: '',    // PEM private key file path (certificate auth)
    tenantId: '',          // Azure AD tenant ID (required for certificate auth)
    notifyEvents: ['pr-merged', 'agent-completed', 'plan-completed', 'agent-failed'],
    ccMirror: true,
    inboxPollInterval: 15000,
  },
};

// ─── Status & Type Constants ─────────────────────────────────────────────────

const WI_STATUS = {
  PENDING: 'pending', DISPATCHED: 'dispatched', DONE: 'done', FAILED: 'failed',
  PAUSED: 'paused', QUEUED: 'queued', NEEDS_REVIEW: 'needs-human-review',
  DECOMPOSED: 'decomposed', CANCELLED: 'cancelled',
};
// Read-side: accept legacy aliases for backward compat with old data/clients.
// Write-side: only WI_STATUS.DONE is written (cleanup.js migrates old values on each run).
const DONE_STATUSES = new Set([WI_STATUS.DONE, 'in-pr', 'implemented', 'complete']);
// Terminal statuses for plan completion — item won't progress further (done, failed, cancelled).
// Used by checkPlanCompletion to unblock the gate when items are in an unrecoverable state.
const PLAN_TERMINAL_STATUSES = new Set([...DONE_STATUSES, WI_STATUS.FAILED, WI_STATUS.CANCELLED]);
const WORK_TYPE = {
  IMPLEMENT: 'implement', IMPLEMENT_LARGE: 'implement:large', FIX: 'fix', REVIEW: 'review',
  VERIFY: 'verify', PLAN: 'plan', PLAN_TO_PRD: 'plan-to-prd', DECOMPOSE: 'decompose',
  MEETING: 'meeting', EXPLORE: 'explore', ASK: 'ask', TEST: 'test', DOCS: 'docs',
};

// Per-work-type heartbeat timeouts (ms) — read-heavy tasks need longer silence windows.
// Keyed by WORK_TYPE constants; types not listed fall back to ENGINE_DEFAULTS.heartbeatTimeout.
Object.assign(ENGINE_DEFAULTS.heartbeatTimeouts, {
  [WORK_TYPE.EXPLORE]: 600000,   // 10 min — spends most time reading/analyzing, minimal stdout
  [WORK_TYPE.ASK]:     600000,   // 10 min — research-heavy, long silent analysis periods
  [WORK_TYPE.REVIEW]:  480000,   // 8 min — code review reads extensively before producing output
});

const PLAN_STATUS = {
  ACTIVE: 'active', AWAITING_APPROVAL: 'awaiting-approval', APPROVED: 'approved',
  PAUSED: 'paused', REJECTED: 'rejected', COMPLETED: 'completed',
  REVISION_REQUESTED: 'revision-requested',
};
const PRD_ITEM_STATUS = { MISSING: 'missing', UPDATED: 'updated', DONE: 'done' };
const PRD_MATERIALIZABLE = new Set([PRD_ITEM_STATUS.MISSING, PRD_ITEM_STATUS.UPDATED]);
const PR_STATUS = { ACTIVE: 'active', MERGED: 'merged', ABANDONED: 'abandoned', CLOSED: 'closed', LINKED: 'linked' };
// PRs eligible for polling (status/build/comment checks) — excludes terminal statuses
const PR_POLLABLE_STATUSES = new Set([PR_STATUS.ACTIVE, PR_STATUS.LINKED]);

// Watch statuses — engine-level persistent watches that survive restarts
const WATCH_STATUS = { ACTIVE: 'active', PAUSED: 'paused', TRIGGERED: 'triggered', EXPIRED: 'expired' };
const WATCH_TARGET_TYPE = { PR: 'pr', WORK_ITEM: 'work-item' };
const WATCH_CONDITION = { MERGED: 'merged', BUILD_FAIL: 'build-fail', BUILD_PASS: 'build-pass', COMPLETED: 'completed', FAILED: 'failed', STATUS_CHANGE: 'status-change', ANY: 'any', NEW_COMMENTS: 'new-comments', VOTE_CHANGE: 'vote-change' };
// Absolute conditions auto-expire on first trigger when stopAfter=0 (fire-once semantics).
// Change-based conditions (status-change, any) run forever when stopAfter=0.
const WATCH_ABSOLUTE_CONDITIONS = new Set([
  WATCH_CONDITION.MERGED, WATCH_CONDITION.BUILD_FAIL, WATCH_CONDITION.BUILD_PASS,
  WATCH_CONDITION.COMPLETED, WATCH_CONDITION.FAILED,
]);

/** Update per-agent review metrics (prsApproved/prsRejected). Only writes for configured agents. */
function trackReviewMetric(pr, newReviewStatus, config) {
  if (newReviewStatus !== 'approved' && newReviewStatus !== 'changes-requested') return;
  const authorId = (pr.agent || '').toLowerCase();
  if (!authorId || !config?.agents?.[authorId]) return;
  try {
    mutateJsonFileLocked(path.join(__dirname, 'metrics.json'), (metrics) => {
      if (!metrics[authorId]) metrics[authorId] = {};
      if (newReviewStatus === 'approved') metrics[authorId].prsApproved = (metrics[authorId].prsApproved || 0) + 1;
      else metrics[authorId].prsRejected = (metrics[authorId].prsRejected || 0) + 1;
      return metrics;
    });
  } catch (err) { log('warn', `Metrics update: ${err.message}`); }
}

/** Queue a plan-to-prd work item with dedup check inside lock. Returns true if queued. */
function queuePlanToPrd({ planFile, prdFile, title, description, project, createdBy, extra }) {
  const centralWiPath = path.join(__dirname, '..', 'work-items.json');
  let queued = false;
  mutateJsonFileLocked(centralWiPath, items => {
    if (!Array.isArray(items)) items = [];
    if (items.some(w => w.type === 'plan-to-prd' && w.planFile === planFile && (w.status === 'pending' || w.status === 'dispatched'))) return items;
    items.push({
      id: 'W-' + uid(),
      title,
      type: 'plan-to-prd',
      priority: 'high',
      description,
      status: 'pending',
      created: new Date().toISOString(),
      createdBy,
      project,
      planFile,
      ...(extra || {}),
    });
    queued = true;
    return items;
  }, { defaultValue: [] });
  return queued;
}
const DISPATCH_RESULT = { SUCCESS: 'success', ERROR: 'error', TIMEOUT: 'timeout' };
const PIPELINE_STATUS = {
  PENDING: 'pending', RUNNING: 'running', COMPLETED: 'completed',
  FAILED: 'failed', PAUSED: 'paused', WAITING_HUMAN: 'waiting-human',
  STOPPED: 'stopped', // pipeline auto-disabled by stopWhen or condition stage
};
const STAGE_TYPE = {
  TASK: 'task', MEETING: 'meeting', PLAN: 'plan', API: 'api',
  MERGE_PRS: 'merge-prs', SCHEDULE: 'schedule', WAIT: 'wait', PARALLEL: 'parallel',
  CONDITION: 'condition',
};
const MEETING_STATUS = {
  INVESTIGATING: 'investigating', DEBATING: 'debating', CONCLUDING: 'concluding',
  COMPLETED: 'completed', ARCHIVED: 'archived',
};
const AGENT_STATUS = {
  SPAWNING: 'spawning', WORKTREE_SETUP: 'worktree-setup', READY: 'ready',
  RUNNING: 'running', FINISHED: 'finished', FAILED: 'failed',
  TRUST_BLOCKED: 'trust-blocked', TIMED_OUT: 'timed-out',
};
const FAILURE_CLASS = {
  CONFIG_ERROR: 'config-error',           // Exit code 78, CLI not found, bad config
  PERMISSION_BLOCKED: 'permission-blocked', // Trust gate, permission denied, auth failure
  MERGE_CONFLICT: 'merge-conflict',       // Git merge conflict in worktree or dependency
  BUILD_FAILURE: 'build-failure',         // Compilation, lint, or test failure
  TIMEOUT: 'timeout',                     // Hard timeout or heartbeat timeout
  EMPTY_OUTPUT: 'empty-output',           // Agent produced no meaningful output
  SPAWN_ERROR: 'spawn-error',             // Process failed to start or crashed immediately
  NETWORK_ERROR: 'network-error',         // API rate limit, DNS, connectivity
  OUT_OF_CONTEXT: 'out-of-context',       // Context window exhausted (token limit, context length)
  MAX_TURNS: 'max-turns',                 // Claude CLI error_max_turns — work in progress, retryable
  UNKNOWN: 'unknown',                     // Unclassified failure
};
const ESCALATION_POLICY = {
  NO_RETRY: 'no-retry',         // CONFIG_ERROR, PERMISSION_BLOCKED — never retry
  RETRY_SAME: 'retry-same',     // MERGE_CONFLICT, BUILD_FAILURE, MAX_TURNS — retry same agent
  RETRY_FRESH: 'retry-fresh',   // TIMEOUT, SPAWN_ERROR — retry with fresh session
  HUMAN_REVIEW: 'human-review', // EMPTY_OUTPUT, OUT_OF_CONTEXT — flag for human
  AUTO: 'auto',                 // UNKNOWN, NETWORK_ERROR — use default retry logic
};

// Structured completion protocol — fields agents must produce in ```completion blocks
const COMPLETION_FIELDS = ['status', 'files_changed', 'tests', 'pr', 'pending', 'failure_class'];

const DEFAULT_AGENT_METRICS = {
  tasksCompleted: 0, tasksErrored: 0,
  prsCreated: 0, prsApproved: 0, prsRejected: 0, prsMerged: 0,
  reviewsDone: 0,
  lastTask: null, lastCompleted: null,
  totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0,
  totalRuntimeMs: 0, // cumulative agent runtime across all tasks
};

const DEFAULT_AGENTS = {
  ripley:  { name: 'Ripley',  emoji: '\u{1F3D7}\uFE0F',  role: 'Lead / Explorer', skills: ['architecture', 'codebase-exploration', 'design-review'] },
  dallas:  { name: 'Dallas',  emoji: '\u{1F527}',  role: 'Engineer', skills: ['implementation', 'typescript', 'docker', 'testing'] },
  lambert: { name: 'Lambert', emoji: '\u{1F4CA}',  role: 'Analyst', skills: ['gap-analysis', 'requirements', 'documentation'] },
  rebecca: { name: 'Rebecca', emoji: '\u{1F9E0}',  role: 'Architect', skills: ['system-design', 'api-design', 'scalability', 'implementation'] },
  ralph:   { name: 'Ralph',   emoji: '\u2699\uFE0F',   role: 'Engineer', skills: ['implementation', 'bug-fixes', 'testing', 'scaffolding'] },
};

const DEFAULT_CLAUDE = {
  binary: 'claude',
  outputFormat: 'stream-json',
  allowedTools: 'Edit,Write,Read,Bash,Glob,Grep,Agent,WebFetch,WebSearch',
};

// ── Project Helpers ──────────────────────────────────────────────────────────

function getProjects(config) {
  if (!config) config = safeJson(path.join(MINIONS_DIR, 'config.json')) || {};
  if (config && config.projects && Array.isArray(config.projects)) {
    return config.projects.filter(p => {
      if (!p || typeof p !== 'object') return false;
      const name = String(p.name || '').trim();
      // Drop template placeholders so they never leak into runtime/dashboard.
      if (!name || name === 'YOUR_PROJECT_NAME') return false;
      return true;
    });
  }
  return [];
}

function projectRoot(project) {
  return path.resolve(project.localPath);
}

// All project state files live centrally in .minions/projects/{name}/
// No state files in project repos — avoids worktree/git interference.
function projectStateDir(project) {
  const name = project.name || path.basename(project.localPath);
  const dir = path.join(MINIONS_DIR, 'projects', name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectWorkItemsPath(project) {
  return path.join(projectStateDir(project), 'work-items.json');
}

function projectPrPath(project) {
  return path.join(projectStateDir(project), 'pull-requests.json');
}

function resolveProjectForPrPath(filePath, config = null) {
  const resolvedPath = path.resolve(filePath);
  for (const project of getProjects(config)) {
    if (path.resolve(projectPrPath(project)) === resolvedPath) return project;
  }
  return null;
}

// ── ID Generation ────────────────────────────────────────────────────────────

function nextWorkItemId(items, prefix) {
  const maxNum = items.reduce((max, i) => {
    const m = (i.id || '').match(/(\d+)$/);
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 0);
  return prefix + String(maxNum + 1).padStart(3, '0');
}

// ── ADO URL ──────────────────────────────────────────────────────────────────

function getAdoOrgBase(project) {
  if (project.prUrlBase) {
    const m = project.prUrlBase.match(/^(https?:\/\/[^/]+(?:\/DefaultCollection)?)/);
    if (m) return m[1];
  }
  return project.adoOrg.includes('.')
    ? `https://${project.adoOrg}`
    : `https://dev.azure.com/${project.adoOrg}`;
}

// ── Path Sanitization ───────────────────────────────────────────────────────

/**
 * Validate that a user-supplied filename stays within the given base directory.
 * Rejects path traversal (../, encoded variants), null bytes, and absolute paths.
 * Returns the resolved absolute path or throws with a descriptive message.
 */
function sanitizePath(file, baseDir) {
  if (!file || typeof file !== 'string') throw new Error('file parameter is required');
  // Reject null bytes
  if (file.includes('\0')) throw new Error('invalid file path: null byte');
  // Reject obvious traversal patterns (including URL-encoded variants)
  const decoded = decodeURIComponent(file);
  if (decoded.includes('..') || file.includes('..')) throw new Error('invalid file path: directory traversal');
  // Reject absolute paths (Unix and Windows)
  if (path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) throw new Error('invalid file path: absolute path not allowed');
  const resolved = path.resolve(baseDir, file);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error('invalid file path: outside allowed directory');
  }
  return resolved;
}

/**
 * Validate that a PID value is a positive integer. Returns the numeric PID.
 * Throws if the value could be used for command injection.
 */
function validatePid(pid) {
  const s = String(pid);
  if (!/^\d+$/.test(s)) throw new Error('Invalid PID: must be numeric');
  const n = parseInt(s, 10);
  if (n <= 0 || !Number.isFinite(n)) throw new Error('Invalid PID: must be a positive integer');
  return n;
}

// ── Branch Sanitization ──────────────────────────────────────────────────────

function sanitizeBranch(name) {
  return String(name).replace(/[^a-zA-Z0-9._\-\/]/g, '-').slice(0, 200);
}

// ── Project Name / Path Validation (SEC-04 / SEC-05) ─────────────────────────
// Enforced at API boundaries (e.g. POST /api/projects/add). Callers that skip
// these validators leak caller-controlled strings into worktree paths, config
// keys, and shell invocations — never bypass them for "internal" callers.

const PROJECT_NAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

function _httpError(status, message, extra) {
  const err = new Error(message);
  err.statusCode = status;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Validate a project name against a strict allowlist before it ever reaches
 * filesystem paths, config keys, or shell arguments.
 *
 * Allowlist: `/^[a-zA-Z0-9_\-]{1,64}$/` (letters, digits, underscore, hyphen).
 * Rejects anything else — path separators, dots, whitespace, shell
 * metacharacters, null bytes. Returns the validated name; throws a 400 Error.
 */
function validateProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw _httpError(400, 'Invalid project name: name is required and must be a string');
  }
  if (name.length > 64) {
    throw _httpError(400, `Invalid project name: "${name}" is ${name.length} characters (max 64)`);
  }
  if (!PROJECT_NAME_RE.test(name)) {
    throw _httpError(400, `Invalid project name: "${name}". Must match /^[a-zA-Z0-9_\\-]{1,64}$/ (letters, digits, underscore, hyphen; no path separators, spaces, or shell metacharacters)`);
  }
  return name;
}

/**
 * Validate a project path before it is persisted to config.json or used as a
 * worktree parent.
 *
 * Default requires `fs.existsSync(path.join(pathStr, '.git'))` — accepts either
 * a `.git` directory (normal repo) or a `.git` file (worktree pointer).
 *
 * To register a non-repo path, the caller must pass BOTH
 *   `allowNonRepo: true`
 *   `confirmToken: <uuid>`
 * and supply an `isValidToken(token)` callback that consumes/validates the
 * token against a freshly generated server-side token. This prevents a
 * single POST from silently creating a broken project entry and forces the
 * client through an explicit confirmation step (D-5: Rebecca / UUID vote).
 *
 * Returns the resolved absolute path; throws a 400 Error (with
 * `needsConfirmation: true` when the only problem is the missing `.git`).
 */
function validateProjectPath(pathStr, options = {}) {
  if (typeof pathStr !== 'string' || pathStr.length === 0) {
    throw _httpError(400, 'Invalid project path: path is required and must be a string');
  }
  const resolved = path.resolve(pathStr);
  if (!fs.existsSync(resolved)) {
    throw _httpError(400, `Invalid project path: directory does not exist: ${resolved}`);
  }
  const gitMarker = path.join(resolved, '.git');
  if (fs.existsSync(gitMarker)) return resolved; // .git dir OR worktree .git file

  // Not a git repo — only accept with explicit confirmation.
  const { allowNonRepo, confirmToken, isValidToken } = options;
  if (allowNonRepo === true && typeof confirmToken === 'string' && typeof isValidToken === 'function' && isValidToken(confirmToken)) {
    return resolved;
  }
  throw _httpError(
    400,
    `Invalid project path: "${resolved}" is not a git repository (no .git directory or file). Retry with allowNonRepo:true and a confirmToken from POST /api/projects/confirm-token to override.`,
    { needsConfirmation: true },
  );
}

// ── Skill Frontmatter Parser ─────────────────────────────────────────────────

function parseSkillFrontmatter(content, filename) {
  let name = filename.replace('.md', '');
  let trigger = '', description = '', project = 'any', author = '', created = '', allowedTools = '';
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    name = m('name') || name;
    trigger = m('trigger');
    description = m('description');
    project = m('project') || 'any';
    author = m('author');
    created = m('created');
    allowedTools = m('allowed-tools');
  }
  return { name, trigger, description, project, author, created, allowedTools };
}

// ── PR → PRD Links ────────────────────────────────────────────────────────────
// Stable single-writer file: maps PR IDs → PRD item IDs.
// Never touched by polling loops — only written when a PR is first linked to a PRD item.

function normalizePrScopeSegment(value) {
  return String(value || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

function parseCanonicalPrId(value) {
  const match = String(value || '').trim().match(/^(github|ado):(.+?)#(\d+)$/i);
  if (!match) return null;
  const scope = `${match[1].toLowerCase()}:${match[2].split('/').map(normalizePrScopeSegment).join('/')}`;
  return { scope, prNumber: parseInt(match[3], 10) };
}

function parseGitHubPrUrl(url) {
  const match = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) return null;
  return {
    scope: `github:${normalizePrScopeSegment(match[1])}/${normalizePrScopeSegment(match[2])}`,
    prNumber: parseInt(match[3], 10),
  };
}

function parseAdoPrUrl(url) {
  const devAzure = String(url || '').match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i);
  if (devAzure) {
    return {
      scope: `ado:${normalizePrScopeSegment(devAzure[1])}/${normalizePrScopeSegment(devAzure[2])}/${normalizePrScopeSegment(decodeURIComponent(devAzure[3]))}`,
      prNumber: parseInt(devAzure[4], 10),
    };
  }
  const visualStudio = String(url || '').match(/https?:\/\/([^/.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i);
  if (!visualStudio) return null;
  return {
    scope: `ado:${normalizePrScopeSegment(visualStudio[1])}/${normalizePrScopeSegment(visualStudio[2])}/${normalizePrScopeSegment(decodeURIComponent(visualStudio[3]))}`,
    prNumber: parseInt(visualStudio[4], 10),
  };
}

function getProjectPrScope(project) {
  if (!project) return '';
  const host = String(project.repoHost || '').toLowerCase();
  if (host === 'github') {
    const parsed = parseGitHubPrUrl(project.prUrlBase || '');
    if (parsed?.scope) return parsed.scope;
    const owner = normalizePrScopeSegment(project.adoOrg);
    const repo = normalizePrScopeSegment(project.repoName);
    return owner && repo ? `github:${owner}/${repo}` : '';
  }
  if (host === 'ado' || !host) {
    const parsed = parseAdoPrUrl(project.prUrlBase || '');
    if (parsed?.scope) return parsed.scope;
    const org = normalizePrScopeSegment(project.adoOrg);
    const adoProject = normalizePrScopeSegment(project.adoProject);
    const repo = normalizePrScopeSegment(project.repoName || project.repositoryId);
    return org && adoProject && repo ? `ado:${org}/${adoProject}/${repo}` : '';
  }
  return '';
}

function getPrNumber(value) {
  if (value && typeof value === 'object') {
    if (value.prNumber != null && /^\d+$/.test(String(value.prNumber))) {
      return parseInt(String(value.prNumber), 10);
    }
    return getPrNumber(value.id || value.url || '');
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const canonical = parseCanonicalPrId(raw);
  if (canonical) return canonical.prNumber;
  const parsedUrl = parseGitHubPrUrl(raw) || parseAdoPrUrl(raw);
  if (parsedUrl) return parsedUrl.prNumber;
  const legacy = raw.match(/^PR-(\d+)$/i) || raw.match(/^(\d+)$/);
  return legacy ? parseInt(legacy[1], 10) : null;
}

function getPrDisplayId(value, fallbackPrNumber = null) {
  const prNumber = getPrNumber(value) ?? getPrNumber(fallbackPrNumber);
  if (prNumber != null) return `PR-${prNumber}`;
  return typeof value === 'object' ? String(value?.id || '') : String(value || '');
}

function getCanonicalPrId(project, prRef, url = '') {
  const isObjectRef = !!prRef && typeof prRef === 'object';
  const rawId = isObjectRef ? (prRef.id || '') : String(prRef || '');
  const canonical = parseCanonicalPrId(rawId);
  if (canonical) return `${canonical.scope}#${canonical.prNumber}`;
  const parsedUrl = parseGitHubPrUrl(url || (isObjectRef ? prRef.url || '' : ''))
    || parseAdoPrUrl(url || (isObjectRef ? prRef.url || '' : ''));
  const prNumber = getPrNumber(isObjectRef ? (prRef.prNumber ?? prRef.id ?? prRef.url) : prRef);
  if (prNumber == null) return rawId;
  const scope = getProjectPrScope(project) || parsedUrl?.scope || '';
  return scope ? `${scope}#${prNumber}` : `PR-${prNumber}`;
}

function findPrRecord(prs, prRef, project = null) {
  if (!Array.isArray(prs) || !prRef) return null;
  const isObjectRef = typeof prRef === 'object';
  const rawId = isObjectRef ? String(prRef.id || '') : String(prRef || '');
  const refUrl = isObjectRef ? String(prRef.url || '') : '';
  const canonicalId = getCanonicalPrId(project, prRef, refUrl);
  if (canonicalId) {
    const canonicalMatch = prs.find(pr => pr?.id === canonicalId);
    if (canonicalMatch) return canonicalMatch;
  }
  if (rawId) {
    const rawMatch = prs.find(pr => pr?.id === rawId);
    if (rawMatch) return rawMatch;
  }
  if (refUrl) {
    const urlMatch = prs.find(pr => pr?.url === refUrl);
    if (urlMatch) return urlMatch;
  }
  const refNumber = getPrNumber(isObjectRef ? (prRef.prNumber ?? prRef.id ?? prRef.url) : prRef);
  if (refNumber == null) return null;
  const numberMatches = prs.filter(pr => getPrNumber(pr) === refNumber);
  return numberMatches.length === 1 ? numberMatches[0] : null;
}

function normalizePrRecord(pr, project = null) {
  if (!pr || typeof pr !== 'object') return false;
  let changed = false;
  const prNumber = getPrNumber(pr.prNumber ?? pr.id ?? pr.url);
  if (prNumber != null && pr.prNumber !== prNumber) {
    pr.prNumber = prNumber;
    changed = true;
  }
  const canonicalId = getCanonicalPrId(project, pr, pr.url || '');
  if (canonicalId && pr.id !== canonicalId) {
    pr.id = canonicalId;
    changed = true;
  }
  return changed;
}

function normalizePrRecords(prs, project = null) {
  if (!Array.isArray(prs)) return 0;
  let changed = 0;
  for (const pr of prs) {
    if (normalizePrRecord(pr, project)) changed++;
  }
  return changed;
}

function normalizePrLinkItems(value) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.filter(item => typeof item === 'string' && item))];
}

function mergePrLinkItems(links, prId, itemIds) {
  if (!prId) return;
  const merged = new Set([...(links[prId] || []), ...normalizePrLinkItems(itemIds)]);
  if (merged.size > 0) links[prId] = [...merged];
}

function getPrLinks() {
  const links = {};
  const knownPrIdsByDisplay = new Map();
  const registerPrId = (pr) => {
    if (!pr?.id) return;
    const displayId = getPrDisplayId(pr);
    if (!displayId) return;
    if (!knownPrIdsByDisplay.has(displayId)) knownPrIdsByDisplay.set(displayId, new Set());
    knownPrIdsByDisplay.get(displayId).add(pr.id);
  };
  // Primary source: derive from all projects/*/pull-requests.json prdItems
  const projectsDir = path.join(MINIONS_DIR, 'projects');
  const projectsByName = new Map(getProjects().map(project => [project.name || path.basename(project.localPath || ''), project]));
  try {
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const prs = JSON.parse(fs.readFileSync(path.join(projectsDir, d.name, 'pull-requests.json'), 'utf8'));
        const project = projectsByName.get(d.name) || null;
        normalizePrRecords(prs, project);
        for (const pr of prs) {
          if (!pr.id) continue;
          registerPrId(pr);
          mergePrLinkItems(links, pr.id, pr.prdItems || []);
        }
      } catch { /* missing or invalid */ }
    }
  } catch { /* projects dir missing */ }
  try {
    const centralPrs = JSON.parse(fs.readFileSync(path.join(MINIONS_DIR, 'pull-requests.json'), 'utf8'));
    normalizePrRecords(centralPrs, null);
    for (const pr of centralPrs) {
      if (!pr.id) continue;
      registerPrId(pr);
      mergePrLinkItems(links, pr.id, pr.prdItems || []);
    }
  } catch { /* central file optional */ }
  // Fallback: static pr-links.json for entries not covered above
  try {
    const static_ = JSON.parse(fs.readFileSync(PR_LINKS_PATH, 'utf8'));
    for (const [k, v] of Object.entries(static_)) {
      const canonical = parseCanonicalPrId(k);
      let normalizedKey = canonical ? `${canonical.scope}#${canonical.prNumber}` : k;
      if (!canonical) {
        const candidates = knownPrIdsByDisplay.get(getPrDisplayId(k));
        if (candidates?.size === 1) normalizedKey = [...candidates][0];
        else if (candidates?.size > 1) {
          log('warn', `Skipping ambiguous legacy PR link "${k}" — multiple canonical PR IDs share display ID ${getPrDisplayId(k)}`);
          continue;
        }
      }
      if (!links[normalizedKey]) mergePrLinkItems(links, normalizedKey, v);
    }
  } catch { /* missing */ }
  return links;
}

function backfillPrPrdItems(prs, prLinks) {
  let backfilled = 0;
  for (const pr of prs) {
    const linkedItems = prLinks[pr.id] || [];
    if (linkedItems.length > 0) {
      pr.prdItems = Array.isArray(pr.prdItems) ? pr.prdItems : [];
      for (const linked of linkedItems) {
        if (!pr.prdItems.includes(linked)) {
          pr.prdItems.push(linked);
          backfilled++;
        }
      }
    }
  }
  return backfilled;
}

function addPrLink(prId, itemId, { project = null, url = '', prNumber = null } = {}) {
  const canonicalPrId = getCanonicalPrId(project, prNumber ?? prId, url);
  const effectivePrId = canonicalPrId || prId;
  if (!effectivePrId || !itemId) return;
  const legacyPrId = String(prId || '');
  mutateJsonFileLocked(PR_LINKS_PATH, (links) => {
    if (!links || Array.isArray(links) || typeof links !== 'object') links = {};
    const mergedCurrent = new Set(normalizePrLinkItems(links[effectivePrId]));
    if (legacyPrId && legacyPrId !== effectivePrId && links[legacyPrId]) {
      for (const linkedItem of normalizePrLinkItems(links[legacyPrId])) mergedCurrent.add(linkedItem);
      delete links[legacyPrId];
    }
    if (!mergedCurrent.has(itemId)) mergedCurrent.add(itemId);
    links[effectivePrId] = [...mergedCurrent];
    return links;
  }, { defaultValue: {} });

  if (!project) return;
  const prPath = projectPrPath(project);
  const effectivePrNumber = getPrNumber(prNumber ?? effectivePrId);
  const prLockPath = `${prPath}.lock`;
  withFileLock(prLockPath, () => {
    if (!fs.existsSync(prPath)) return;
    let prs = safeJson(prPath);
    if (!Array.isArray(prs)) prs = [];
    normalizePrRecords(prs, project);
    const existingPr = prs.find(pr =>
      pr?.id === effectivePrId
      || (url && pr?.url === url)
      || (effectivePrNumber != null && getPrNumber(pr) === effectivePrNumber)
    );
    if (!existingPr) return;
    const backupPath = prPath + '.backup';
    try { if (fs.existsSync(prPath)) fs.copyFileSync(prPath, backupPath); } catch { /* backup is best-effort */ }
    existingPr.prdItems = Array.isArray(existingPr.prdItems) ? existingPr.prdItems : [];
    if (existingPr.prdItems.includes(itemId)) return;
    existingPr.prdItems.push(itemId);
    safeWrite(prPath, prs);
  }, {
    retries: ENGINE_DEFAULTS.lockRetries,
    retryBackoffMs: ENGINE_DEFAULTS.lockRetryBackoffMs
  });
}

// ─── Cross-Platform Process Kill Helpers ─────────────────────────────────────

function killGracefully(proc, graceMs = 5000) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { _execSync(`taskkill /PID ${proc.pid} /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
    setTimeout(() => {
      try { _execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
    }, graceMs);
  } else {
    try { proc.kill('SIGTERM'); } catch { /* process may be dead */ }
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* process may be dead */ }
    }, graceMs);
  }
}

function killImmediate(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { _execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
  } else {
    try { proc.kill('SIGKILL'); } catch { /* process may be dead */ }
  }
}

// ─── Work Items & Pull Requests Mutation Helpers ────────────────────────────

/**
 * Atomic read-modify-write for work-items JSON files.
 * Wraps mutateJsonFileLocked with defaultValue of [].
 * @param {string} filePath - Path to the work-items JSON file
 * @param {Function} mutator - Receives the array, mutates in place or returns new value
 */
function mutateWorkItems(filePath, mutator) {
  return mutateJsonFileLocked(filePath, (data) => {
    if (!Array.isArray(data)) data = [];
    return mutator(data) || data;
  }, { defaultValue: [], skipWriteIfUnchanged: true });
}

/**
 * Reset a done work item for re-dispatch. Clears completion/dispatch metadata.
 * Caller must set description/title separately.
 */
function reopenWorkItem(wi) {
  wi.status = WI_STATUS.PENDING;
  wi._reopened = true;
  delete wi.completedAt;
  delete wi.dispatched_at;
  delete wi.dispatched_to;
  wi._retryCount = 0;
}

/**
 * Atomic read-modify-write for pull-requests JSON files.
 * Wraps mutateJsonFileLocked with defaultValue of [].
 * @param {string} filePath - Path to the pull-requests JSON file
 * @param {Function} mutator - Receives the array, mutates in place or returns new value
 */
function mutatePullRequests(filePath, mutator) {
  return mutateJsonFileLocked(filePath, (data) => {
    if (!Array.isArray(data)) data = [];
    return mutator(data) || data;
  }, { defaultValue: [] });
}

/**
 * Remove a git worktree, falling back to fs.rmSync if git fails (e.g., locked on Windows).
 * Only removes directories under worktreeRoot to prevent accidental deletion.
 * Tracks persistent failures to avoid retrying locked paths every cleanup cycle.
 *
 * On Windows, reserved device-name files (NUL, CON, PRN, AUX, etc.) can appear in
 * worktree directories when shell redirections run under Git Bash/WSL. These block
 * git worktree remove, fs.rmSync, and PowerShell Remove-Item. Two mitigations:
 * 1. _purgeReservedFiles() deletes them via the \\?\ extended path prefix before removal
 * 2. cmd /c rd /s /q as final fallback handles any remaining reserved names
 */
const _removeWorktreeFailures = new Map(); // path → { count, lastAttempt }

// Windows reserved device names that cannot be deleted via normal paths
const _WIN_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Recursively purge Windows reserved-name pseudo-files (NUL, CON, PRN, AUX, etc.)
 * using the \\?\ extended path prefix that bypasses reserved-name interpretation.
 * Called before normal deletion attempts on Windows to unblock git/fs operations.
 */
function _purgeReservedFiles(dirPath) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        _purgeReservedFiles(fullPath);
      } else {
        // Match NUL, NUL.txt, con, con.log, etc.
        const baseName = entry.name.toUpperCase().split('.')[0];
        if (_WIN_RESERVED_NAMES.has(baseName)) {
          // \\?\ prefix bypasses Win32 reserved-name interpretation
          fs.unlinkSync('\\\\?\\' + fullPath);
        }
      }
    } catch {
      // Best-effort: file may already be gone or inaccessible
    }
  }
}

function removeWorktree(wtPath, gitRoot, worktreeRoot) {
  const resolved = path.resolve(wtPath);
  const resolvedRoot = path.resolve(worktreeRoot) + path.sep;
  if (!resolved.startsWith(resolvedRoot)) {
    log('warn', `removeWorktree: refusing to remove ${wtPath} — not under ${worktreeRoot}`);
    return false;
  }
  // Skip paths that failed 3+ times — retry after 1 hour cooldown
  const prior = _removeWorktreeFailures.get(resolved);
  if (prior && prior.count >= 3 && Date.now() - prior.lastAttempt < 3600000) return false;

  // Windows: purge reserved-name pseudo-files (NUL, CON, etc.) that block normal deletion
  if (process.platform === 'win32') {
    _purgeReservedFiles(resolved);
  }

  try {
    exec(`git worktree remove "${wtPath}" --force`, { cwd: gitRoot, stdio: 'pipe', timeout: 15000, windowsHide: true });
    _removeWorktreeFailures.delete(resolved);
    return true;
  } catch (gitErr) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      try { exec('git worktree prune', { cwd: gitRoot, stdio: 'pipe', timeout: 10000, windowsHide: true }); } catch {}
      _removeWorktreeFailures.delete(resolved);
      return true;
    } catch (rmErr) {
      // Windows: try cmd /c rd /s /q for any error — handles reserved device names,
      // locked files, and partially-deleted directories (not just EPERM)
      if (process.platform === 'win32') {
        try {
          exec(`cmd /c rd /s /q "${resolved}"`, { stdio: 'pipe', timeout: 15000, windowsHide: true });
          try { exec('git worktree prune', { cwd: gitRoot, stdio: 'pipe', timeout: 10000, windowsHide: true }); } catch {}
          _removeWorktreeFailures.delete(resolved);
          return true;
        } catch (rdErr) {
          log('warn', `removeWorktree: rd /s /q fallback failed for ${wtPath}: ${rdErr.message}`);
        }
      }
      const fail = _removeWorktreeFailures.get(resolved) || { count: 0, lastAttempt: 0 };
      fail.count++;
      fail.lastAttempt = Date.now();
      _removeWorktreeFailures.set(resolved, fail);
      if (fail.count <= 3) log('warn', `removeWorktree: failed for ${wtPath} (attempt ${fail.count}/3): ${rmErr.message}`);
      return false;
    }
  }
}

function slugify(text, maxLen = 50) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLen);
}

function safeSlugComponent(text, maxLen = 80) {
  const raw = String(text || '').trim();
  if (!raw) return 'item';
  if (/^[A-Za-z0-9._-]+$/.test(raw) && raw.length <= maxLen) return raw;
  const hash = crypto.createHash('md5').update(raw).digest('hex').slice(0, 8);
  const base = slugify(raw, Math.max(8, maxLen - 9)) || 'item';
  return `${base}-${hash}`.slice(0, maxLen);
}

function formatTranscriptEntry(t) {
  return '### ' + (t.agent || 'agent') + ' (' + (t.type || '') + ', Round ' + (t.round || '?') + ')\n\n' + (t.content || '');
}

function getPinnedItems() {
  const pins = safeJson(PINNED_ITEMS_PATH);
  return Array.isArray(pins) ? pins.filter(item => typeof item === 'string' && item) : [];
}

// ── Throttle Tracker Factory ────────────────────────────────────────────────
// Generic rate-limit tracker reusable by both ADO and GitHub integrations.
// Returns an object with recordThrottle, recordSuccess, isThrottled, getState.

function createThrottleTracker({ label, baseBackoffMs = 60000, maxBackoffMs = 32 * 60000 } = {}) {
  let state = { throttled: false, retryAfter: 0, consecutiveHits: 0, backoffMs: baseBackoffMs };

  function recordThrottle(retryAfterMs) {
    state.consecutiveHits++;
    state.backoffMs = Math.min(state.backoffMs * 2, maxBackoffMs);
    const waitMs = (retryAfterMs > 0) ? retryAfterMs : state.backoffMs;
    state.throttled = true;
    state.retryAfter = Date.now() + waitMs;
    log('warn', `[${label}] Throttled — retry after ${Math.round(waitMs / 1000)}s, consecutive hits: ${state.consecutiveHits}`);
  }

  function recordSuccess() {
    if (state.consecutiveHits > 0) {
      state.consecutiveHits--;
      if (state.consecutiveHits === 0) {
        state.throttled = false;
        state.backoffMs = baseBackoffMs;
      }
    }
  }

  function isThrottled() {
    if (!state.throttled) return false;
    if (Date.now() >= state.retryAfter) {
      // Auto-clear ALL state when retryAfter has elapsed
      state.throttled = false;
      state.backoffMs = baseBackoffMs;
      state.consecutiveHits = 0;
      return false;
    }
    return true;
  }

  function getState() {
    return { throttled: isThrottled(), retryAfter: state.retryAfter, consecutiveHits: state.consecutiveHits };
  }

  // Testing helpers
  function _reset() {
    state = { throttled: false, retryAfter: 0, consecutiveHits: 0, backoffMs: baseBackoffMs };
  }
  function _setForTest(overrides) {
    Object.assign(state, overrides);
  }

  return { recordThrottle, recordSuccess, isThrottled, getState, _reset, _setForTest };
}

module.exports = {
  MINIONS_DIR,
  PR_LINKS_PATH,
  PINNED_ITEMS_PATH,
  LOG_PATH,
  ts,
  logTs,
  dateStamp,
  log,
  safeRead,
  safeReadDir,
  safeJson, safeJsonObj, safeJsonArr,
  safeWrite,
  safeUnlink,
  PROMPT_CONTEXTS_DIR,
  dispatchPromptSidecarPath,
  sidecarDispatchPrompt,
  resolveDispatchPrompt,
  deleteDispatchPromptSidecar,
  assertStateFileSize,
  withFileLock,
  mutateJsonFileLocked,
  mutateWorkItems,
  reopenWorkItem,
  mutatePullRequests,
  uid,
  uniquePath,
  truncateTextBytes,
  tailTextBytes,
  appendTextTail,
  writeToInbox, parseNoteId,
  exec,
  execAsync,
  execSilent,
  resolveMainBranch,
  run,
  runFile,
  cleanChildEnv,
  gitEnv,
  parseStreamJsonOutput,
  KB_CATEGORIES,
  classifyInboxItem,
  ENGINE_DEFAULTS,
  WI_STATUS, DONE_STATUSES, PLAN_TERMINAL_STATUSES, WORK_TYPE, PLAN_STATUS, PRD_ITEM_STATUS, PRD_MATERIALIZABLE, PR_STATUS, PR_POLLABLE_STATUSES, DISPATCH_RESULT, trackReviewMetric, queuePlanToPrd,
  WATCH_STATUS, WATCH_TARGET_TYPE, WATCH_CONDITION, WATCH_ABSOLUTE_CONDITIONS,
  PIPELINE_STATUS, STAGE_TYPE, MEETING_STATUS, AGENT_STATUS,
  FAILURE_CLASS, ESCALATION_POLICY, COMPLETION_FIELDS,
  DEFAULT_AGENT_METRICS,
  DEFAULT_AGENTS,
  DEFAULT_CLAUDE,
  getProjects,
  projectRoot,
  projectStateDir,
  projectWorkItemsPath,
  projectPrPath,
  getPrLinks,
  addPrLink,
  parseCanonicalPrId,
  getProjectPrScope,
  getPrNumber,
  getPrDisplayId,
  getCanonicalPrId,
  findPrRecord,
  normalizePrRecord,
  normalizePrRecords,
  nextWorkItemId,
  getAdoOrgBase,
  sanitizePath,
  sanitizeBranch,
  validateProjectName,
  validateProjectPath,
  validatePid,
  parseSkillFrontmatter,
  sleepMs,
  killGracefully,
  killImmediate,
  removeWorktree,
  _purgeReservedFiles, // exported for testing
  _WIN_RESERVED_NAMES, // exported for testing
  LOCK_STALE_MS,
  flushLogs,
  slugify,
  safeSlugComponent,
  formatTranscriptEntry,
  getPinnedItems,
  _logBuffer, // exported for testing
  createThrottleTracker,
  backfillPrPrdItems,
};
