/**
 * engine/shared.js — Shared utilities for Minions engine, dashboard, and LLM modules.
 * Extracted from engine.js and dashboard.js to eliminate duplication.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MINIONS_DIR = process.env.MINIONS_TEST_DIR || path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(MINIONS_DIR, 'engine');
const CONTROL_PATH = path.join(ENGINE_DIR, 'control.json');
const COOLDOWNS_PATH = path.join(ENGINE_DIR, 'cooldowns.json');
const PR_LINKS_PATH = path.join(MINIONS_DIR, 'engine', 'pr-links.json');
const PINNED_ITEMS_PATH = path.join(MINIONS_DIR, 'engine', 'kb-pins.json');
const LOG_PATH = path.join(MINIONS_DIR, 'engine', 'log.json');

// ── Timestamps & Logging ────────────────────────────────────────────────────
// Extracted from engine.js so engine/* modules can import directly without
// circular-requiring the orchestrator.

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

// ── Secret Redaction (SEC-09) ──────────────────────────────────────────────
// Pure, side-effect-free redactor applied to every entry on the log write path
// so ADO tokens, JWTs, and azureauth stdout dumps never land in engine/log.json
// (2500-entry ring buffer readable by any local process).
//
// Replacements (order matters — azureauth first, then Bearer, then bare JWT):
//   1. `"token":"<20+ char base64-ish>"` → `"token":"[REDACTED_AZUREAUTH]"`
//      Redacts the value only, not the whole line, so surrounding JSON
//      context (e.g. expiresOn) remains debuggable.
//   2. `Bearer <20+ char base64-ish>`   → `Bearer [REDACTED]`
//   3. `ey<b64url>.<b64url>[.<b64url>]` → `[REDACTED_JWT]`
//      Catches bare JWTs in error messages or stack traces (anything left
//      after Bearer replacement has consumed its tokens).
//
// `redactSecrets` also recurses into objects and arrays — used by `log()` to
// sanitize both the message and the meta payload before persistence.
const _BEARER_RE = /Bearer\s+[A-Za-z0-9+/=._\-]{20,}/g;
const _JWT_RE = /ey[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]{10,})?/g;
const _AZUREAUTH_RE = /"token"\s*:\s*"[A-Za-z0-9+/=._\-]{20,}"/g;

function _redactString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return s
    .replace(_AZUREAUTH_RE, '"token":"[REDACTED_AZUREAUTH]"')
    .replace(_BEARER_RE, 'Bearer [REDACTED]')
    .replace(_JWT_RE, '[REDACTED_JWT]');
}

function redactSecrets(value) {
  if (value == null) return value;
  if (typeof value === 'string') return _redactString(value);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactSecrets(value[k]);
    return out;
  }
  return value;
}

// ── Log Buffering ──────────────────────────────────────────────────────────
// Buffer log entries in memory and flush to disk periodically to reduce lock
// contention (~139 calls/tick → 1 lock acquisition per flush).
const _logBuffer = [];
let _logFlushTimer = null;

function log(level, msg, meta = {}) {
  // SEC-09: redact sensitive patterns (ADO tokens, JWTs, azureauth stdout)
  // before both the in-memory buffer push and the console echo — ensures
  // nothing sensitive is persisted to engine/log.json or engine stdout logs.
  const safeMsg = typeof msg === 'string' ? _redactString(msg) : msg;
  const safeMeta = redactSecrets(meta) || {};
  const entry = { timestamp: ts(), level, message: safeMsg, ...safeMeta };
  // Console output remains immediate (also redacted)
  console.log(`[${logTs()}] [${level}] ${safeMsg}`);

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
  // SEC-09 defense-in-depth: redact again at flush time so any direct
  // `_logBuffer.push(entry)` callers (tests, future paths) can't leak secrets.
  const entries = _logBuffer.splice(0).map(redactSecrets);
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

function neutralizeJsonBackupSidecar(filePath, inertData = { status: 'archived' }) {
  const backupPath = filePath + '.backup';
  try {
    fs.unlinkSync(backupPath);
    return { ok: true, action: 'removed', backupPath };
  } catch (unlinkErr) {
    if (unlinkErr.code === 'ENOENT') return { ok: true, action: 'absent', backupPath };
    try {
      safeWrite(backupPath, inertData);
      return {
        ok: true,
        action: 'neutralized',
        backupPath,
        unlinkError: unlinkErr.message,
      };
    } catch (writeErr) {
      return {
        ok: false,
        action: 'failed',
        backupPath,
        unlinkError: unlinkErr.message,
        writeError: writeErr.message,
      };
    }
  }
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

function dispatchCompletionReportPath(dispatchId) {
  if (!dispatchId) return null;
  const safeId = String(dispatchId).replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(MINIONS_DIR, 'engine', 'completions', `${safeId}.json`);
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

function mutateControl(mutator) {
  return mutateJsonFileLocked(CONTROL_PATH, (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    return mutator(data) || data;
  }, { defaultValue: { state: 'stopped', pid: null }, skipWriteIfUnchanged: true });
}

function mutateCooldowns(mutator) {
  return mutateJsonFileLocked(COOLDOWNS_PATH, (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    return mutator(data) || data;
  }, { defaultValue: {}, skipWriteIfUnchanged: true });
}

let _uidCounter = 0;

/**
 * Generate a unique ID suffix: timestamp + monotonic counter + random chars.
 * Use for filenames that could collide (dispatch IDs, temp files, etc.)
 */
function uid() {
  _uidCounter = (_uidCounter + 1) % 0x1000000;
  return Date.now().toString(36) + _uidCounter.toString(36).padStart(4, '0') + crypto.randomBytes(2).toString('hex');
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
    _cbExec(cmd, { windowsHide: true, encoding: 'utf8', ...rest, timeout: timeout || 30000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve(stdout);
    });
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

// ── Stream-JSON Output Parsing (runtime-aware delegator) ────────────────────

/**
 * Parse stream-json output from a CLI runtime. Returns { text, usage, sessionId, model }.
 *
 * As of P-7e3a8b1c this is a thin delegator over the runtime adapter registry —
 * the actual parsing logic lives in `engine/runtimes/<name>.parseOutput()`.
 * Kept on `shared` for backward compat with all existing callers (llm.js,
 * consolidation.js, lifecycle.js, meeting.js, timeout.js).
 *
 * Signatures supported:
 *   parseStreamJsonOutput(raw)
 *   parseStreamJsonOutput(raw, optsObj)         ← legacy form (engine/llm.js still uses this)
 *   parseStreamJsonOutput(raw, runtimeName)
 *   parseStreamJsonOutput(raw, runtimeName, optsObj)
 *
 * `runtimeName` defaults to `'claude'`. Unknown runtime names throw via the
 * registry — surfaces misconfiguration immediately at the parse site.
 */
function parseStreamJsonOutput(raw, runtimeName, opts) {
  // Backward-compat: callers passing `(raw, optsObject)` — second arg is opts, not name
  if (runtimeName != null && typeof runtimeName === 'object') {
    opts = runtimeName;
    runtimeName = undefined;
  }
  // Lazy require to avoid a circular dep at module init (runtimes/claude.js
  // doesn't import shared, but downstream adapters might).
  const { resolveRuntime } = require('./runtimes');
  return resolveRuntime(runtimeName).parseOutput(raw, opts || {});
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
  heartbeatTimeout: 300000, // 5min — stale-orphan grace after process tracking is lost
  resumeHeartbeatTimeout: 300000, // 5min — max wait for a resumed runtime to emit its first output
  // Per-type stale-orphan overrides (merged with config.engine.heartbeatTimeouts at runtime — see timeout.js).
  // Heavy work types (multi-file edits, builds, test suites, full verify cycles) routinely go quiet for
  // longer than the 5-min default when the engine has lost their tracked handle (e.g. across an engine
  // restart). We give them headroom up to a typical build+tests cycle. Short-running types
  // (decompose / meeting / etc.) keep the 5-min default by simply not appearing here.
  heartbeatTimeouts: {
    implement:       900000, // 15min — refactors, multi-file edits, builds
    'implement:large': 900000, // 15min — same class of work, larger scope
    fix:             900000, // 15min — fix runs often include builds + retries
    test:            900000, // 15min — build-and-test against existing PR
    verify:          900000, // 15min — full project verification cycle
    plan:            600000, // 10min — research-heavy
  },
  maxTurns: 100,
  worktreeCreateTimeout: 300000, // 5min for git worktree add on large Windows repos
  worktreeCreateRetries: 1, // retry once on transient timeout/lock races
  worktreeRoot: '../worktrees',
  worktreeCountCacheTtl: 30000, // 30s — TTL for cached _countWorktrees() result in dashboard
  workItemCreateDedupWindowMs: 15 * 60 * 1000, // 15min — collapse duplicate CC/API create races
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
  autoReviewPrs: true, // auto-dispatch review agents for newly opened agent PRs
  autoReReviewPrs: true, // auto-dispatch review agents after a PR fix is pushed
  autoFixReviewFeedback: true, // auto-dispatch fix agents for minions review changes-requested verdicts
  autoFixHumanComments: true, // auto-dispatch fix agents for actionable human PR comments
  completionReportRetentionDays: 90, // retain completion report sidecars beyond capped dispatch history
  completionReportMaxFiles: 5000, // hard cap for completion report sidecars during cleanup
  meetingRoundTimeout: 900000, // 15min per meeting round before auto-advance
  evalLoop: true, // enable review→fix loop after implementation completes
  evalMaxIterations: 3, // legacy UI/config field; engine discovery no longer enforces review→fix cycle caps
  evalMaxCost: null, // USD ceiling per work item across all eval iterations; null = no limit (gather baseline data first)
  maxRetries: 3, // max dispatch retries before marking work item as failed
  minRetryGapMs: 120000, // 2min — minimum gap between retry dispatches for the same work item; prevents tight retry loops when an idempotent agent (e.g. review bailing out on a duplicate) cannot produce the expected output (#1770)
  pipelineApiRetries: 2, // max attempts for pipeline API calls
  pipelineApiRetryDelay: 2000, // ms delay between pipeline API retries
  prAutoLinkRetries: 3, // max attempts for gh pr list lookup when auto-linking PR after merge (3s backoff between attempts)
  rebaseQueueRetries: 3, // max rebase attempts per queued PR before giving up
  versionCheckInterval: 3600000, // 1 hour — how often to check npm for updates (ms)
  logFlushInterval: 5000, // 5s — how often to flush buffered log entries to disk
  logBufferSize: 50, // flush immediately when buffer exceeds this many entries
  lockRetries: 0, // no retries — single 5s timeout window with 25ms polling (200 attempts) is sufficient; stale lock recovery at 60s handles crashes
  lockRetryBackoffMs: 500, // base backoff between lock retries (doubles each attempt: 500ms, 1s, 2s, ...)
  maxBuildFixAttempts: 3, // legacy UI/config field; engine discovery no longer enforces build-fix attempt caps
  buildFixGracePeriod: 600000, // 10min — wait for CI to run after build fix before re-dispatching
  adoPollEnabled: true, // poll ADO PR status, comments, and reconciliation on each tick cycle
  ghPollEnabled: true, // poll GitHub PR status, comments, and reconciliation on each tick cycle
  prPollStatusEvery: 12,   // poll PR build/review/merge status every N ticks for both ADO and GitHub (~12 min at default interval)
  prPollCommentsEvery: 12, // poll PR human comments every N ticks for both ADO and GitHub (~12 min at default interval)
  autoCompletePrs: false, // auto-merge PRs when builds green + review approved (opt-in)
  prMergeMethod: 'squash', // merge method: squash, merge, rebase
  ignoredCommentAuthors: [], // comments from these authors are auto-closed and never trigger fixes
  agentBusyReassignMs: 600000, // 10min — reassign work item to another agent if preferred agent is busy beyond this threshold
  ccEffort: null, // effort level for CC/doc-chat (null, 'low', 'medium', 'high')

  // ── Runtime fleet (P-3b8e5f1d) ──────────────────────────────────────────────
  // Single source of truth for which CLI runtime + model every spawn uses.
  // Engine code MUST go through the resolveAgent*/resolveCc* helpers below;
  // never read these fields directly. New runtimes are added by registering
  // an adapter in engine/runtimes/index.js — these defaults stay stable.
  defaultCli: 'claude',          // fleet-wide CLI runtime (must be a key in engine/runtimes/index.js)
  defaultModel: undefined,       // fleet-wide model; undefined = let the runtime adapter pick its own default
  ccCli: undefined,              // CC/doc-chat CLI override; undefined = inherit defaultCli (independent of agent path)
  ccModel: undefined,            // CC/doc-chat model override; undefined = inherit defaultModel
  claudeBareMode: false,         // Claude --bare: suppress CLAUDE.md auto-discovery (per-agent override: agents.<id>.bareMode)
  claudeFallbackModel: undefined,// Claude --fallback-model on rate-limit / overload (Claude-only)
  copilotDisableBuiltinMcps: true,   // Copilot --disable-builtin-mcps: keep github-mcp-server out so it can't bypass pull-requests.json tracking
  copilotSuppressAgentsMd: true,     // Copilot --no-custom-instructions: stop AGENTS.md auto-load from fighting Minions playbook prompts
  copilotStreamMode: 'on',           // Copilot --stream <on|off>: 'on' streams assistant.message_delta events live; 'off' batches them
  copilotReasoningSummaries: false,  // Copilot --enable-reasoning-summaries (Anthropic-family models only)
  maxBudgetUsd: undefined,       // fleet USD ceiling for --max-budget-usd (per-agent override: agents.<id>.maxBudgetUsd). Honors 0 via ?? so a literal cap of $0 works
  disableModelDiscovery: false,  // skip runtime.listModels() REST calls fleet-wide (settings UI falls back to free-text)
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
  // Backward-compat: keep `engine.claude.*` field family deprecation tracker. Listed here so preflight
  // knows which subkeys to flag as deprecated. Do not consume `claude.*` in new code — use the runtime
  // adapter system (engine/runtimes/) and the resolveAgent*/resolveCc* helpers instead.
  _deprecatedConfigClaudeFields: ['binary', 'outputFormat', 'allowedTools', 'permissionMode', 'maxTurns', 'effort', 'budgetCap'],
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

// ─── Runtime Fleet Resolution (P-3b8e5f1d) ──────────────────────────────────
//
// Six helpers that are the single source of truth for "which CLI runtime + model
// + budget + bare-mode applies to this spawn?". Engine code MUST go through
// these — never read `agent.cli`, `engine.defaultCli`, etc. directly. Future
// agents adding new resolution rules should extend these helpers, not bypass
// them.
//
// Independence rule: the agent path (`resolveAgent*`) and the CC path
// (`resolveCc*`) do not fall through to each other. CC overrides via
// `engine.ccCli` / `engine.ccModel` are CC-only. Per-agent overrides via
// `agents.<id>.cli` / `agents.<id>.model` are agent-only. A user who wants
// fleet-wide change sets `engine.defaultCli` / `engine.defaultModel`.
//
// Empty strings (`''`) are treated as "unset" so the dashboard's "Default
// (CLI chooses)" option (which submits an empty string) clears the override
// instead of pinning the runtime to nothing.

function _isMeaningful(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Resolve the CLI runtime for a per-agent spawn. Priority:
 *   1. `agent.cli`              — per-agent override
 *   2. `engine.defaultCli`      — fleet default
 *   3. `ENGINE_DEFAULTS.defaultCli` ('claude') — hardcoded fallback
 *
 * Does NOT fall through to `engine.ccCli`. CC and agents are independent paths.
 */
function resolveAgentCli(agent, engine) {
  if (agent && _isMeaningful(agent.cli)) return String(agent.cli);
  if (engine && _isMeaningful(engine.defaultCli)) return String(engine.defaultCli);
  return ENGINE_DEFAULTS.defaultCli;
}

/**
 * Resolve the CLI runtime for the Command Center / doc-chat. Priority:
 *   1. `engine.ccCli`           — CC-only override
 *   2. `engine.defaultCli`      — fleet default
 *   3. `ENGINE_DEFAULTS.defaultCli` ('claude') — hardcoded fallback
 *
 * Does NOT inspect any agent overrides. CC has no notion of "which agent" —
 * it's a fleet-wide singleton.
 */
function resolveCcCli(engine) {
  if (engine && _isMeaningful(engine.ccCli)) return String(engine.ccCli);
  if (engine && _isMeaningful(engine.defaultCli)) return String(engine.defaultCli);
  return ENGINE_DEFAULTS.defaultCli;
}

/**
 * Resolve the model for a per-agent spawn. Priority:
 *   1. `agent.model`            — per-agent override
 *   2. `engine.defaultModel`    — fleet default
 *   3. `undefined`              — let the runtime adapter pick its own default
 *
 * Returning `undefined` is intentional: it tells the adapter to omit the
 * `--model` flag entirely so the underlying CLI uses whatever the user has
 * configured globally (Claude defaults to its own preferred model, Copilot
 * to the user's `~/.copilot/settings.json` model).
 */
function resolveAgentModel(agent, engine) {
  if (agent && _isMeaningful(agent.model)) return String(agent.model);
  if (engine && _isMeaningful(engine.defaultModel)) return String(engine.defaultModel);
  return undefined;
}

/**
 * Resolve the model for the Command Center / doc-chat. Priority:
 *   1. `engine.ccModel`         — CC-only override
 *   2. `engine.defaultModel`    — fleet default (CC inherits this when ccModel unset)
 *   3. `undefined`              — let the runtime adapter pick
 */
function resolveCcModel(engine) {
  if (engine && _isMeaningful(engine.ccModel)) return String(engine.ccModel);
  if (engine && _isMeaningful(engine.defaultModel)) return String(engine.defaultModel);
  return undefined;
}

/**
 * Resolve the per-spawn USD budget cap. Priority:
 *   1. `agent.maxBudgetUsd`     — per-agent override
 *   2. `engine.maxBudgetUsd`    — fleet default
 *   3. `undefined`              — no cap
 *
 * Uses nullish coalescing so a literal `0` is honored as a valid cap (for
 * read-only / dry-run agents) instead of being treated as "no cap" — the
 * acceptance criteria are explicit about this.
 */
function resolveAgentMaxBudget(agent, engine) {
  const a = agent ? agent.maxBudgetUsd : undefined;
  if (a !== undefined && a !== null) {
    const n = typeof a === 'number' ? a : Number(a);
    if (!Number.isNaN(n)) return n;
  }
  const e = engine ? engine.maxBudgetUsd : undefined;
  if (e !== undefined && e !== null) {
    const n = typeof e === 'number' ? e : Number(e);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/**
 * Resolve whether this agent should run in Claude `--bare` mode. Priority:
 *   1. `agent.bareMode`           — per-agent override (boolean)
 *   2. `engine.claudeBareMode`    — fleet default
 *   3. `false`                    — hardcoded fallback
 *
 * Strict undefined/null check (not falsy) so a per-agent `false` correctly
 * overrides an engine `true`.
 */
function resolveAgentBareMode(agent, engine) {
  const a = agent ? agent.bareMode : undefined;
  if (a !== undefined && a !== null) return !!a;
  const e = engine ? engine.claudeBareMode : undefined;
  if (e !== undefined && e !== null) return !!e;
  return false;
}

// ─── Legacy ccModel → defaultModel Migration ─────────────────────────────────
//
// Pre-P-3b8e5f1d, `engine.ccModel` was the single fleet-wide model knob (it
// was also used for agent dispatch via fall-through). The new architecture
// makes `defaultModel` the fleet knob and demotes `ccModel` to a CC-only
// override. To avoid breaking installs that have only `ccModel` configured,
// promote `ccModel` to act as `defaultModel` in memory at startup, log a
// deprecation notice once, and leave the on-disk config alone (so a future
// admin edit can decide whether to keep `ccModel` as override or remove it).

let _legacyCcModelMigrationLogged = false;

/**
 * If `config.engine.ccModel` is set but `config.engine.defaultModel` is unset,
 * mutate the in-memory `config.engine` so `defaultModel` mirrors `ccModel` and
 * log a one-time deprecation notice. Does NOT write to disk.
 *
 * Returns `true` when the migration was applied (useful for tests).
 *
 * The dedup flag is module-scoped so the warning fires once per Node process
 * even if multiple subsystems independently call this — e.g., engine startup
 * + a settings-reset path + a hot-reload tick.
 */
function applyLegacyCcModelMigration(config, { logger = log } = {}) {
  if (!config || !config.engine || typeof config.engine !== 'object') return false;
  const e = config.engine;
  if (_isMeaningful(e.defaultModel)) return false;
  if (!_isMeaningful(e.ccModel)) return false;
  e.defaultModel = e.ccModel;
  if (!_legacyCcModelMigrationLogged) {
    _legacyCcModelMigrationLogged = true;
    try {
      logger('warn', 'ccModel is now a CC-specific override; set defaultModel to apply fleet-wide');
    } catch { /* logger may not be wired during tests — best-effort */ }
  }
  return true;
}

/** Test helper: reset the dedup flag so repeated tests can re-trigger the log. */
function _resetLegacyCcModelMigrationFlag() {
  _legacyCcModelMigrationLogged = false;
}

// ─── Runtime Config Preflight Warnings ──────────────────────────────────────
//
// Emit non-fatal warnings about runtime/CLI configuration drift. Consumed by
// engine/preflight.js (which converts the entries to `{ name, ok: 'warn',
// message }` shape) and surfaced via `minions doctor`.
//
// The function is pure: takes the config and the list of registered runtime
// names, returns warning objects. No FS, no console writes — preflight owns
// presentation.

/**
 * Inspect runtime fleet config and return warning entries for misconfiguration.
 *
 * Warnings emitted:
 *   - Unknown CLI: any `cli` value (per-agent, ccCli, defaultCli) not in
 *     `registeredRuntimes`. Each unknown value produces one entry.
 *   - Deprecated `config.claude.*` fields: presence of any field in
 *     `ENGINE_DEFAULTS._deprecatedConfigClaudeFields` under `config.claude`.
 *   - Bare-mode misconfig: `engine.claudeBareMode === true` paired with
 *     CC running on the Claude runtime (resolved via `resolveCcCli`) and no
 *     explicit `engine.ccSystemPrompt` configured. `--bare` strips
 *     CLAUDE.md auto-discovery, so users should know CC will lose project
 *     context unless they wire an explicit system prompt.
 *
 * Returns: `{ id, message }[]` — `id` is a stable kebab-case identifier so
 * tests can assert specific warnings without matching message text.
 */
function runtimeConfigWarnings(config, registeredRuntimes) {
  const warnings = [];
  if (!config || typeof config !== 'object') return warnings;
  const known = new Set(Array.isArray(registeredRuntimes) ? registeredRuntimes : []);
  const engine = config.engine || {};
  const agents = config.agents || {};

  // 1. Unknown CLI values across the fleet.
  const seen = new Set();
  const checkCli = (label, value) => {
    if (!_isMeaningful(value)) return;
    const key = `${label}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (known.size > 0 && !known.has(String(value))) {
      const knownList = Array.from(known).sort().join(', ');
      warnings.push({
        id: 'unknown-cli',
        message: `Unknown CLI runtime "${value}" (${label}). Registered runtimes: ${knownList}`,
      });
    }
  };
  checkCli('engine.defaultCli', engine.defaultCli);
  checkCli('engine.ccCli', engine.ccCli);
  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent && typeof agent === 'object') checkCli(`agents.${agentId}.cli`, agent.cli);
  }

  // 2. Deprecated `config.claude.*` fields.
  const claude = config.claude;
  if (claude && typeof claude === 'object') {
    const deprecatedKeys = ENGINE_DEFAULTS._deprecatedConfigClaudeFields || [];
    const present = deprecatedKeys.filter(k => Object.prototype.hasOwnProperty.call(claude, k));
    if (present.length > 0) {
      warnings.push({
        id: 'deprecated-config-claude',
        message: `config.claude.{${present.join(',')}} is deprecated. Use the runtime adapter (engine/runtimes/) and resolveAgent*/resolveCc* helpers instead.`,
      });
    }
  }

  // 3. Bare-mode misconfig: claudeBareMode + a CC runtime that honours
  // `--bare` + no explicit CC system prompt. `--bare` suppresses CLAUDE.md
  // auto-discovery; CC will lose project context unless the user wires an
  // explicit prompt. Gated on `capabilities.bareMode` rather than runtime
  // name so any future runtime that adopts the same flag is covered.
  if (engine.claudeBareMode === true) {
    const ccCli = resolveCcCli(engine);
    let ccRuntime = null;
    try { ccRuntime = require('./runtimes').resolveRuntime(ccCli); } catch { /* unknown runtime — skip */ }
    if (ccRuntime?.capabilities?.bareMode === true && !_isMeaningful(engine.ccSystemPrompt)) {
      warnings.push({
        id: 'bare-mode-misconfig',
        message: `engine.claudeBareMode is true but CC runs on ${ccCli} (which honours --bare) with no engine.ccSystemPrompt — CLAUDE.md auto-discovery is suppressed and CC will lose project context.`,
      });
    }
  }

  return warnings;
}

/**
 * Detect projects whose discovery would silently no-op because the
 * `workSources` block is missing or its sub-flags are disabled. Catches the
 * common "I cloned the repo and ran it without `minions init`" footgun where
 * `engine.js` `discoverFromWorkItems` / `discoverFromPrs` bail on
 * `if (!src?.enabled) return [];` with no log output.
 *
 * Pure helper — pass `getDataCounts(project) → { workItems: N, pullRequests: N }`
 * so the caller controls disk reads (preflight reads files; tests inject counts).
 * If `getDataCounts` is omitted, every project with a missing/disabled source
 * is reported (caller decides whether to surface).
 *
 * Returns: `{ id, message, project }[]` — `id` is one of:
 *   - `project-worksources-missing`     — no workSources block at all
 *   - `project-worksources-disabled`    — block exists but a sub-source is disabled
 */
function projectWorkSourceWarnings(config, getDataCounts) {
  const warnings = [];
  if (!config || typeof config !== 'object') return warnings;
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const topSources = config.workSources || null;
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const projSources = project.workSources || null;
    const counts = (typeof getDataCounts === 'function')
      ? (getDataCounts(project) || {})
      : { workItems: Infinity, pullRequests: Infinity };
    const wiCount = Number(counts.workItems) || 0;
    const prCount = Number(counts.pullRequests) || 0;

    // Case 1: project has no workSources AND no top-level fallback. Discovery
    // will return [] for everything. This is the cloned-repo footgun.
    if (!projSources && !topSources) {
      if (wiCount > 0 || prCount > 0) {
        warnings.push({
          id: 'project-worksources-missing',
          project: project.name,
          message: `Project "${project.name}" has no workSources block — work-item and PR discovery are silently disabled (${wiCount} work item(s), ${prCount} PR(s) waiting). Run \`minions init\` if you cloned the repo directly, or re-link the project: \`minions add ${project.localPath || project.name}\`.`,
        });
      }
      continue;
    }

    // Case 2: workSources exists but a sub-source is disabled while data sits
    // unprocessed. Could be intentional, but worth surfacing.
    const wiSrc = projSources?.workItems || topSources?.workItems;
    if ((!wiSrc || wiSrc.enabled === false) && wiCount > 0) {
      warnings.push({
        id: 'project-worksources-disabled',
        project: project.name,
        message: `Project "${project.name}" has ${wiCount} unprocessed work item(s) but workSources.workItems.enabled is not true — engine will not dispatch them. Toggle in Dashboard → Settings → Project, or set \`workSources.workItems.enabled: true\` in config.json.`,
      });
    }
    const prSrc = projSources?.pullRequests || topSources?.pullRequests;
    if ((!prSrc || prSrc.enabled === false) && prCount > 0) {
      warnings.push({
        id: 'project-worksources-disabled',
        project: project.name,
        message: `Project "${project.name}" has ${prCount} pull-request record(s) but workSources.pullRequests.enabled is not true — engine will not poll or review them. Toggle in Dashboard → Settings → Project, or set \`workSources.pullRequests.enabled: true\` in config.json.`,
      });
    }
  }
  return warnings;
}

/**
 * Boot-time auto-heal for the cloned-repo / hand-rolled-config footgun: any
 * project missing a `workSources.workItems` or `workSources.pullRequests`
 * sub-block gets the dashboard's default backfilled. We only touch *missing*
 * sub-blocks — an explicit `enabled: false` is treated as user intent and
 * left alone.
 *
 * Pure helper — mutates `config` in place and returns
 * `{ changed: boolean, healed: Array<{ project, sources }> }` so the caller
 * can decide whether to persist + log. Returns `{ changed: false, healed: [] }`
 * for null/empty/malformed input.
 */
function backfillProjectWorkSourceDefaults(config) {
  const result = { changed: false, healed: [] };
  if (!config || typeof config !== 'object') return result;
  const projects = Array.isArray(config.projects) ? config.projects : [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const filled = [];
    if (!project.workSources || typeof project.workSources !== 'object') {
      project.workSources = {};
    }
    if (!project.workSources.pullRequests) {
      project.workSources.pullRequests = { enabled: true, cooldownMinutes: 30 };
      filled.push('pullRequests');
    }
    if (!project.workSources.workItems) {
      project.workSources.workItems = { enabled: true, cooldownMinutes: 0 };
      filled.push('workItems');
    }
    if (filled.length > 0) {
      result.changed = true;
      result.healed.push({ project: project.name, sources: filled });
    }
  }
  return result;
}

// ─── Status & Type Constants ─────────────────────────────────────────────────

const WI_STATUS = {
  PENDING: 'pending', DISPATCHED: 'dispatched', DONE: 'done', FAILED: 'failed',
  PAUSED: 'paused', QUEUED: 'queued',
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
const PR_PENDING_REASON = {
  MISSING_BRANCH: 'missing_pr_branch',
};

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
    mutateJsonFileLocked(path.join(MINIONS_DIR, 'engine', 'metrics.json'), (metrics) => {
      if (!metrics[authorId]) metrics[authorId] = { ...DEFAULT_AGENT_METRICS };
      if (newReviewStatus === 'approved') metrics[authorId].prsApproved = (metrics[authorId].prsApproved || 0) + 1;
      else metrics[authorId].prsRejected = (metrics[authorId].prsRejected || 0) + 1;
      return metrics;
    });
  } catch (err) { log('warn', `Metrics update: ${err.message}`); }
}

/** Queue a plan-to-prd work item with dedup check inside lock. Returns true if queued. */
function queuePlanToPrd({ planFile, prdFile, title, description, project, createdBy, extra }) {
  // Use MINIONS_DIR (honors MINIONS_TEST_DIR override) instead of resolving from
  // __dirname — otherwise tests that exercise this helper leak work items into
  // the real package-root work-items.json even after createTestMinionsDir().
  const centralWiPath = path.join(MINIONS_DIR, 'work-items.json');
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
  TIMEOUT: 'timeout',                     // Hard runtime timeout or stale-orphan timeout
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
const COMPLETION_FIELDS = ['status', 'summary', 'files_changed', 'tests', 'pr', 'pending', 'failure_class', 'retryable', 'needs_rerun', 'verdict', 'artifacts'];

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

function realPathForComparison(filePath) {
  const resolved = path.resolve(filePath);
  const realpathSync = fs.realpathSync.native || fs.realpathSync;
  try {
    return realpathSync(resolved);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
  }

  let existing = resolved;
  const missingParts = [];
  while (true) {
    const parent = path.dirname(existing);
    missingParts.unshift(path.basename(existing));
    if (parent === existing) return resolved;
    existing = parent;
    try {
      return path.join(realpathSync(existing), ...missingParts);
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }
  }
}

function prPathComparisonCandidates(filePath) {
  const candidates = new Set();
  const addCandidate = (candidate) => {
    const resolved = path.resolve(candidate);
    candidates.add(resolved);
    candidates.add(realPathForComparison(resolved));
  };

  addCandidate(filePath);
  if (!path.isAbsolute(filePath)) {
    addCandidate(path.resolve(MINIONS_DIR, filePath));
  }
  return candidates;
}

function resolveProjectForPrPath(filePath, config = null) {
  const fileCandidates = prPathComparisonCandidates(filePath);
  const projects = getProjects(config);
  for (const project of projects) {
    for (const projectPath of prPathComparisonCandidates(projectPrPath(project))) {
      if (fileCandidates.has(projectPath)) return project;
    }
  }
  if (projects.length === 1) return projects[0];
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

/** Return the org/owner for a project regardless of host. Prefers host-specific field, falls back to adoOrg for backward compat. */
function getProjectOrg(project) {
  if (!project) return '';
  if (project.repoHost === 'github') return project.githubOrg || project.adoOrg || '';
  return project.adoOrg || '';
}

function getAdoOrgBase(project) {
  if (project.prUrlBase) {
    const devAzure = project.prUrlBase.match(/^(https?:\/\/dev\.azure\.com\/[^/]+)/i);
    if (devAzure) return devAzure[1];
    const m = project.prUrlBase.match(/^(https?:\/\/[^/]+(?:\/DefaultCollection)?)/);
    if (m) return m[1];
  }
  return project.adoOrg.includes('.')
    ? `https://${project.adoOrg}`
    : `https://dev.azure.com/${project.adoOrg}`;
}

// ── Path Sanitization ───────────────────────────────────────────────────────

/**
 * Files in the LIVE Minions checkout (MINIONS_DIR) that the Command Center
 * must never edit directly. Three flavours:
 *
 *   - "basenames": exact relative paths under the live root (engine.js, dashboard.js,
 *     minions.js, config.json — and the runtime state files engine/control.json
 *     and engine/dispatch.json).
 *   - "globs":     direct-child JS files under protected live directories
 *     (engine/*.js, bin/*.js).
 *   - "prefixes":  relative directory prefixes whose entire subtree is read-only
 *     when it lives in the live root (dashboard/**).
 *
 * The list is intentionally small and explicit. It mirrors the textual rule in
 * `prompts/cc-system.md`. Source of truth lives here; the system prompt renders
 * `{{cc_protected_paths}}` from this list at startup so the two cannot drift.
 *
 * The guard is ROOT-AWARE: a path only counts as protected when its absolute
 * resolution sits inside MINIONS_DIR. The same basename inside an isolated
 * task worktree (e.g. `D:/worktrees/minions-work/W-xxx/dashboard.js`) is NOT
 * protected — agents working in those copies are free to edit them, since
 * git keeps changes inside the worktree until the agent pushes a branch.
 */
const _CC_PROTECTED_BASENAMES = Object.freeze([
  'engine.js',
  'dashboard.js',
  'minions.js',
  'config.json',
  'engine/control.json',
  'engine/dispatch.json',
]);
const _CC_PROTECTED_FILE_GLOBS = Object.freeze([
  'engine/*.js',
  'bin/*.js',
]);
const _CC_PROTECTED_PREFIXES = Object.freeze([
  'dashboard/',
]);

/**
 * Returns the literal text used by the CC system prompt for the protected-file
 * rule. Combines the basenames + prefixes above into a single sentence so the
 * authored rule and the helper that enforces it can never disagree.
 *
 * The result is anchored to a specific live root so the LLM can't conflate
 * "edits to dashboard.js" with "edits to a worktree copy of dashboard.js".
 */
function describeCcProtectedPaths(liveRoot) {
  const root = (liveRoot && typeof liveRoot === 'string') ? liveRoot : MINIONS_DIR;
  const norm = root.replace(/\\/g, '/');
  const basenames = _CC_PROTECTED_BASENAMES.map(b => '`' + b + '`').join(', ');
  const globs = _CC_PROTECTED_FILE_GLOBS.map(g => '`' + g + '`').join(', ');
  const prefixes = _CC_PROTECTED_PREFIXES.map(p => '`' + p + '**`').join(', ');
  return `READ ONLY in the live checkout at \`${norm}\` — never write/edit: ${basenames}, ${globs}, ${prefixes}. This rule is path-scoped, not basename-scoped. Files with the same basename inside an isolated agent worktree (e.g. \`{worktreeRoot}/W-<id>/dashboard.js\`) are NOT protected — agents working in their own worktrees may edit any repository source the work item requires.`;
}

function renderCcSystemPrompt(raw, opts) {
  const liveRoot = (opts && typeof opts.liveRoot === 'string') ? opts.liveRoot : MINIONS_DIR;
  return String(raw || '')
    .replace(/\{\{minions_dir\}\}/g, liveRoot)
    .replace(/\{\{cc_protected_paths\}\}/g, describeCcProtectedPaths(liveRoot));
}

/**
 * Is this absolute path a CC-protected file in the LIVE Minions checkout?
 *
 * Returns true ONLY if all three hold:
 *   1. `absPath` resolves to something inside `liveRoot` (default: MINIONS_DIR).
 *   2. Its relative path matches a protected basename (e.g. `dashboard.js`)
 *      OR matches a protected direct-child glob (`engine/*.js`, `bin/*.js`)
 *      OR sits under a protected directory prefix (`dashboard/`).
 *   3. The input is a real string (no nullish, no non-string values).
 *
 * Returns false for:
 *   - Paths outside `liveRoot` (worktrees, sibling repos, scratch dirs, etc.)
 *   - Non-protected files inside `liveRoot` (notes.md, knowledge/foo.md, …)
 *   - Invalid inputs (null/undefined/empty/non-string)
 *
 * Why this exists: PR W-moja4a5qp9pj. The CC system prompt previously named
 * protected files by basename only ("never write/edit dashboard.js"). Agents
 * dispatched into isolated worktrees inherited the same prose verbatim and
 * occasionally interpreted it as banning their own worktree copy of those
 * files, blocking otherwise legitimate fixes. The guard now distinguishes
 * "same path, live tree" from "same basename, worktree copy".
 */
function isLiveCommandCenterPath(absPath, opts) {
  if (typeof absPath !== 'string' || absPath.length === 0) return false;
  if (absPath.includes('\0')) return false;
  const liveRoot = (opts && typeof opts.liveRoot === 'string') ? opts.liveRoot : MINIONS_DIR;
  const pathApi = /^[a-zA-Z]:[\\/]/.test(absPath) || /^[a-zA-Z]:[\\/]/.test(liveRoot) ? path.win32 : path;
  let resolved;
  let resolvedRoot;
  try {
    resolved = pathApi.resolve(absPath);
    resolvedRoot = pathApi.resolve(liveRoot);
  } catch { return false; }
  // Must be inside liveRoot. Compare with trailing separator to avoid the
  // sibling-prefix bug ("D:/squad-old" startsWith "D:/squad").
  const rootWithSep = resolvedRoot.endsWith(pathApi.sep) ? resolvedRoot : (resolvedRoot + pathApi.sep);
  const caseInsensitive = pathApi === path.win32 || process.platform === 'win32';
  const cmpResolved = caseInsensitive ? resolved.toLowerCase() : resolved;
  const cmpResolvedRoot = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
  const cmpRootWithSep = caseInsensitive ? rootWithSep.toLowerCase() : rootWithSep;
  if (cmpResolved !== cmpResolvedRoot && !cmpResolved.startsWith(cmpRootWithSep)) return false;
  // Compute the path relative to the live root and normalize separators so
  // the basename / prefix checks are platform-independent.
  const rel = pathApi.relative(resolvedRoot, resolved).replace(/\\/g, '/');
  if (rel === '' || rel === '.') return false; // root itself is not a "file"
  const relForMatch = rel.toLowerCase();
  if (_CC_PROTECTED_BASENAMES.includes(relForMatch)) return true;
  if (/^(?:engine|bin)\/[^/]+\.js$/.test(relForMatch)) return true;
  for (const prefix of _CC_PROTECTED_PREFIXES) {
    if (relForMatch === prefix.slice(0, -1) /* exact dir */ || relForMatch.startsWith(prefix)) return true;
  }
  return false;
}

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

// ── Prototype Pollution Guard ────────────────────────────────────────────────

const _DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Detect the presence of prototype-pollution attack keys in a JSON-decoded payload.
 *
 * Belt-and-braces defence for endpoints that call `JSON.parse` on untrusted
 * request bodies and then feed the result into `Object.assign`, spread, or
 * deep-merge utilities. `JSON.parse` itself is safe — it installs `__proto__`
 * as a regular own data property and does not mutate the prototype chain —
 * but downstream code that shallow-merges the payload into a target object
 * CAN elevate it into a prototype write.
 *
 * Contract is **rejection, not sanitization**: we inspect the top level plus
 * one level deep and return a boolean. Deeper walks are intentionally skipped
 * to avoid their own DoS pathologies on adversarial inputs.
 *
 * - Null / undefined / primitives → false.
 * - Arrays are transparent: each element is checked at the same depth as the
 *   array itself (an array does NOT consume a depth level).
 * - Max object nesting inspected: 1. Dangerous keys at object-depth 2+
 *   are intentionally NOT flagged.
 * - Never mutates the input.
 *
 * @param {*} obj - any JSON-decoded value
 * @param {number} [_depth=0] - internal recursion counter; do not pass externally
 * @returns {boolean} true if any forbidden key is present at object-depth ≤ 1
 */
function hasDangerousKey(obj, _depth = 0) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;

  // Arrays are transparent — preserve depth when recursing into elements.
  if (Array.isArray(obj)) {
    for (const elt of obj) {
      if (hasDangerousKey(elt, _depth)) return true;
    }
    return false;
  }

  // Object: check own keys at the current depth.
  for (const key of Object.keys(obj)) {
    if (_DANGEROUS_KEYS.has(key)) return true;
  }

  // Stop after one level of object nesting. Deeper recursion is an explicit
  // non-goal (see DoS note in the header).
  if (_depth >= 1) return false;

  for (const v of Object.values(obj)) {
    if (hasDangerousKey(v, _depth + 1)) return true;
  }
  return false;
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

function _worktreeNameSuffix(dispatchId, projectName, branchName) {
  const id = String(dispatchId || '').split('-').filter(Boolean).pop();
  if (id) return safeSlugComponent(id, 32);
  const hash = crypto.createHash('sha1')
    .update(`${projectName || 'default'}\n${branchName || 'worktree'}`)
    .digest('hex')
    .slice(0, 12);
  return hash;
}

function buildWorktreeDirName({
  dispatchId = '',
  projectName = 'default',
  branchName = 'worktree',
  platform = process.platform,
} = {}) {
  const suffix = _worktreeNameSuffix(dispatchId, projectName, branchName);
  if (platform === 'win32') return `W-${suffix}`;
  const projectSlug = String(projectName || 'default').replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${projectSlug}-${sanitizeBranch(branchName || 'worktree')}-${suffix}`;
}

// ── HTTP Origin Allowlist & Security Headers ─────────────────────────────────
// Pure helpers used by dashboard.js to gate mutating requests against an
// explicit allowlist of local origins and to attach uniform security response
// headers. Extracted here so they're unit-testable without the HTTP server.

// Allowed origin (scheme + host) — port-agnostic. Dashboard always binds to
// 127.0.0.1:7331 locally; browser tabs may arrive as localhost, 127.0.0.1, or
// IPv6 [::1] depending on how the user opened the page.
// WHATWG URL keeps IPv6 brackets in `hostname`, so we compare against the
// bracketed form `[::1]`. We also accept the bare form `::1` defensively.
const _ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const _ALLOWED_ORIGIN_SCHEMES = new Set(['http:']);

/**
 * Returns true if the origin-like header value (either an `Origin` header value
 * such as `http://localhost:7331` or a full `Referer` URL) belongs to the local
 * dashboard allowlist. Port-agnostic. Returns false for null/undefined/empty,
 * the literal string `'null'` (sandboxed iframes, data: URIs), malformed URLs,
 * non-http schemes, and any host not in the allowlist.
 * @param {string|null|undefined} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === 'null') return false;
  let parsed;
  try { parsed = new URL(trimmed); } catch { return false; }
  if (!parsed.hostname) return false;
  if (!_ALLOWED_ORIGIN_SCHEMES.has(parsed.protocol)) return false;
  return _ALLOWED_ORIGIN_HOSTS.has(parsed.hostname);
}

/**
 * Returns the baseline set of security response headers to apply on every HTTP
 * response from the dashboard. Values match OWASP defaults for a same-origin
 * SPA served from 127.0.0.1. The HTML entry-point response intentionally
 * overrides CSP to allow its inline `<script>` / `<style>` blocks; API (JSON,
 * SSE) responses inherit the strict CSP returned here.
 * @returns {{[key:string]: string}}
 */
function buildSecurityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
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
  const normalizedParts = match[2].split('/').map(normalizePrScopeSegment);
  if (!normalizedParts.some(Boolean)) return null;
  const scope = `${match[1].toLowerCase()}:${normalizedParts.join('/')}`;
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

function parsePrUrl(url) {
  return parseGitHubPrUrl(url) || parseAdoPrUrl(url);
}

function getProjectPrScope(project) {
  if (!project) return '';
  const host = String(project.repoHost || '').toLowerCase();
  if (host === 'github') {
    const parsed = parseGitHubPrUrl(project.prUrlBase || '');
    if (parsed?.scope) return parsed.scope;
    const owner = normalizePrScopeSegment(getProjectOrg(project));
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

function getPrScopeInfo(prRef, url = '') {
  const isObjectRef = !!prRef && typeof prRef === 'object';
  const rawUrl = url || (isObjectRef ? prRef.url || '' : String(prRef || ''));
  const parsedUrl = parsePrUrl(rawUrl);
  if (parsedUrl) return { ...parsedUrl, source: 'url' };
  const rawId = isObjectRef ? (prRef.id || '') : String(prRef || '');
  const canonical = parseCanonicalPrId(rawId);
  return canonical ? { ...canonical, source: 'id' } : null;
}

function getPrProjectScopeMismatch(project, prRef, url = '') {
  const projectScope = getProjectPrScope(project);
  if (!projectScope) return null;
  const refScope = getPrScopeInfo(prRef, url)?.scope || '';
  if (!refScope) return null;
  if (refScope === projectScope) return null;
  const [projectHost, projectRest = ''] = projectScope.split(':');
  const [refHost, refRest = ''] = refScope.split(':');
  if (projectHost === refHost && projectHost === 'ado' && !project.prUrlBase) {
    const projectParts = projectRest.split('/');
    const refParts = refRest.split('/');
    if (projectParts[0] === refParts[0] && projectParts[1] === refParts[1]) return null;
  }
  return { reason: 'pr_scope_mismatch', projectScope, prScope: refScope };
}

function isPrCompatibleWithProject(project, prRef, url = '') {
  return !getPrProjectScopeMismatch(project, prRef, url);
}

function getCanonicalPrId(project, prRef, url = '') {
  const isObjectRef = !!prRef && typeof prRef === 'object';
  const rawId = isObjectRef ? (prRef.id || '') : String(prRef || '');
  const rawUrl = url || (isObjectRef ? prRef.url || '' : String(prRef || ''));
  const parsedUrl = parsePrUrl(rawUrl);
  if (parsedUrl) return `${parsedUrl.scope}#${parsedUrl.prNumber}`;
  const canonical = parseCanonicalPrId(rawId);
  if (canonical) return `${canonical.scope}#${canonical.prNumber}`;
  const prNumber = getPrNumber(isObjectRef ? (prRef.prNumber ?? prRef.id ?? prRef.url) : prRef);
  if (prNumber == null) return rawId;
  const scope = getProjectPrScope(project) || '';
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

function snapshotPrRecord(pr) {
  if (pr === undefined) return undefined;
  return JSON.parse(JSON.stringify(pr));
}

function _jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
// Backwards-compat alias for legacy in-file callers.
const _isPlainObject = isPlainObject;

function applyPrFieldDelta(target, before, after) {
  if (!target || typeof target !== 'object' || !after || typeof after !== 'object') return target;
  before = before && typeof before === 'object' ? before : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const beforeValue = before[key];
    const afterHas = Object.prototype.hasOwnProperty.call(after, key);
    const afterValue = after[key];
    if (_jsonEqual(beforeValue, afterValue)) continue;
    if (!afterHas) {
      delete target[key];
    } else if (_isPlainObject(beforeValue) && _isPlainObject(afterValue) && _isPlainObject(target[key])) {
      applyPrFieldDelta(target[key], beforeValue, afterValue);
    } else {
      target[key] = snapshotPrRecord(afterValue);
    }
  }
  return target;
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
  const mismatch = getPrProjectScopeMismatch(project, pr, pr.url || '');
  if (mismatch) {
    const current = pr._invalidProjectScope || {};
    if (current.reason !== mismatch.reason || current.projectScope !== mismatch.projectScope || current.prScope !== mismatch.prScope) {
      pr._invalidProjectScope = mismatch;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(pr, '_invalidProjectScope')) {
    delete pr._invalidProjectScope;
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

function isAutoManagedPrRecord(pr) {
  if (!pr || typeof pr !== 'object' || pr._contextOnly === true) return false;
  if (normalizePrLinkItems(pr.prdItems).length > 0) return true;
  if (pr._autoObserve === true) return true;
  if (pr.sourcePlan || pr.itemType) return true;
  const agent = String(pr.agent || '').trim().toLowerCase();
  return !!agent && agent !== 'human';
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

/**
 * Canonical PR-producing work contract helper.
 *
 * Dashboard rendering derives work-item PR columns from PR.prdItems (with
 * engine/pr-links.json as a compatibility fallback). Any path that discovers or
 * manually records a PR for a work item must use this helper so the PR record
 * and the canonical work-item attachment are created together and idempotently.
 */
function upsertPullRequestRecord(prPath, entry, { project = null, itemId = null, itemIds = null, beforeInsert = null } = {}) {
  if (!prPath) throw new Error('prPath required');
  if (!entry || typeof entry !== 'object') throw new Error('entry required');

  const linkedItemIds = normalizePrLinkItems([
    ...(Array.isArray(entry.prdItems) ? entry.prdItems : []),
    ...(Array.isArray(itemIds) ? itemIds : [itemId]),
  ]);
  const prNumber = getPrNumber(entry.prNumber ?? entry.id ?? entry.url);
  const canonicalId = getCanonicalPrId(project, entry.prNumber ?? entry.id ?? entry.url ?? prNumber, entry.url || '');
  if (!canonicalId) throw new Error('PR id required');
  const normalizedEntry = {
    ...entry,
    id: canonicalId,
    prNumber: prNumber ?? entry.prNumber ?? null,
    prdItems: linkedItemIds,
  };

  let created = false;
  let linked = false;
  let skipped = false;
  let record = null;

  mutatePullRequests(prPath, (prs) => {
    normalizePrRecords(prs, project);
    let target = findPrRecord(prs, normalizedEntry, project);
    if (!target && typeof beforeInsert === 'function' && beforeInsert(prs, normalizedEntry) === false) {
      skipped = true;
      return prs;
    }
    if (!target) {
      target = normalizedEntry;
      prs.push(target);
      created = true;
    } else {
      target.id = canonicalId;
      if (prNumber != null) target.prNumber = prNumber;
      const targetWasAutoManaged = isAutoManagedPrRecord(target);
      for (const key of ['url', 'title', 'description', 'agent', 'branch', 'reviewStatus', 'status', 'created', 'sourcePlan', 'itemType']) {
        if (normalizedEntry[key] != null && normalizedEntry[key] !== '' && (target[key] == null || target[key] === '')) {
          target[key] = normalizedEntry[key];
        }
      }
      for (const key of ['_manual', '_autoObserve', '_context']) {
        if (normalizedEntry[key] != null) target[key] = normalizedEntry[key];
      }
      if (normalizedEntry._contextOnly != null) {
        const wouldDemoteManagedPr = normalizedEntry._contextOnly === true && targetWasAutoManaged;
        if (!wouldDemoteManagedPr) target._contextOnly = normalizedEntry._contextOnly;
      }
    }
    target.prdItems = normalizePrLinkItems(target.prdItems || []);
    for (const linkedItemId of linkedItemIds) {
      if (!target.prdItems.includes(linkedItemId)) {
        target.prdItems.push(linkedItemId);
        linked = true;
      }
    }
    record = { ...target, prdItems: [...target.prdItems] };
    return prs;
  });

  if (!skipped) {
    for (const linkedItemId of linkedItemIds) {
      addPrLink(canonicalId, linkedItemId, { project, prNumber, url: normalizedEntry.url || '' });
    }
  }

  return { id: canonicalId, prNumber, created, linked, skipped, record };
}

// ─── Cross-Platform Process Kill Helpers ─────────────────────────────────────

function normalizeKillPid(proc) {
  const pid = Number(proc?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function unixChildPids(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  try {
    return _execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(childPid => Number.isInteger(childPid) && childPid > 0 && childPid !== pid);
  } catch {
    return [];
  }
}

function killUnixProcessTree(pid, signal, seen = new Set()) {
  if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) return;
  seen.add(pid);
  for (const childPid of unixChildPids(pid)) {
    killUnixProcessTree(childPid, signal, seen);
  }
  try { process.kill(pid, signal); } catch { /* process may be dead */ }
}

function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function killGracefully(proc, graceMs = 5000) {
  const pid = normalizeKillPid(proc);
  if (!pid) return;
  if (process.platform === 'win32') {
    try { _execSync(`taskkill /PID ${pid} /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
    unrefTimer(setTimeout(() => {
      try { _execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
    }, graceMs));
  } else {
    killUnixProcessTree(pid, 'SIGTERM');
    unrefTimer(setTimeout(() => {
      killUnixProcessTree(pid, 'SIGKILL');
    }, graceMs));
  }
}

function killImmediate(proc) {
  const pid = normalizeKillPid(proc);
  if (!pid) return;
  if (process.platform === 'win32') {
    try { _execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 3000, windowsHide: true }); } catch { /* process may be dead */ }
  } else {
    killUnixProcessTree(pid, 'SIGKILL');
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
  ENGINE_DIR,
  CONTROL_PATH,
  COOLDOWNS_PATH,
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
  neutralizeJsonBackupSidecar,
  PROMPT_CONTEXTS_DIR,
  dispatchPromptSidecarPath,
  dispatchCompletionReportPath,
  sidecarDispatchPrompt,
  resolveDispatchPrompt,
  deleteDispatchPromptSidecar,
  assertStateFileSize,
  withFileLock,
  mutateJsonFileLocked,
  mutateControl,
  mutateCooldowns,
  mutateWorkItems,
  reopenWorkItem,
  mutatePullRequests,
  uid,
  uniquePath,
  isPlainObject,
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
  resolveAgentCli, resolveCcCli, resolveAgentModel, resolveCcModel,
  resolveAgentMaxBudget, resolveAgentBareMode,
  applyLegacyCcModelMigration, _resetLegacyCcModelMigrationFlag,
  runtimeConfigWarnings,
  projectWorkSourceWarnings,
  backfillProjectWorkSourceDefaults,
  WI_STATUS, DONE_STATUSES, PLAN_TERMINAL_STATUSES, WORK_TYPE, PLAN_STATUS, PRD_ITEM_STATUS, PRD_MATERIALIZABLE, PR_STATUS, PR_POLLABLE_STATUSES, PR_PENDING_REASON, DISPATCH_RESULT, trackReviewMetric, queuePlanToPrd,
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
  resolveProjectForPrPath, // exported for testing
  getPrLinks,
  addPrLink,
  normalizePrScopeSegment, // exported for testing
  parseCanonicalPrId,
  parseGitHubPrUrl, // exported for testing
  parseAdoPrUrl, // exported for testing
  parsePrUrl, // exported for testing
  getProjectPrScope,
  getPrNumber,
  getPrDisplayId,
  getPrScopeInfo,
  getPrProjectScopeMismatch,
  isPrCompatibleWithProject,
  getCanonicalPrId,
  findPrRecord,
  snapshotPrRecord,
  applyPrFieldDelta,
  normalizePrRecord,
  normalizePrRecords,
  normalizePrLinkItems, // exported for testing
  mergePrLinkItems, // exported for testing
  upsertPullRequestRecord,
  nextWorkItemId,
  getProjectOrg,
  getAdoOrgBase,
  sanitizePath,
  sanitizeBranch,
  buildWorktreeDirName, // exported for testing
  isLiveCommandCenterPath,
  describeCcProtectedPaths,
  renderCcSystemPrompt,
  _CC_PROTECTED_BASENAMES, // exported for testing
  _CC_PROTECTED_FILE_GLOBS, // exported for testing
  _CC_PROTECTED_PREFIXES,  // exported for testing
  isAllowedOrigin,
  buildSecurityHeaders,
  hasDangerousKey,
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
  redactSecrets,
  slugify,
  safeSlugComponent,
  formatTranscriptEntry,
  getPinnedItems,
  _logBuffer, // exported for testing
  createThrottleTracker,
  backfillPrPrdItems,
};
