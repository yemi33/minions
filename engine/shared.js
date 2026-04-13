/**
 * engine/shared.js — Shared utilities for Minions engine, dashboard, and LLM modules.
 * Extracted from engine.js and dashboard.js to eliminate duplication.
 */

const fs = require('fs');
const path = require('path');

const MINIONS_DIR = process.env.MINIONS_TEST_DIR || path.resolve(__dirname, '..');
const PR_LINKS_PATH = path.join(MINIONS_DIR, 'engine', 'pr-links.json');
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
  lockRetryBackoffMs
} = {}) {
  const lockPath = `${filePath}.lock`;
  const retries = lockRetries ?? ENGINE_DEFAULTS.lockRetries;
  const retryBackoffMs = lockRetryBackoffMs ?? ENGINE_DEFAULTS.lockRetryBackoffMs;
  return withFileLock(lockPath, () => {
    let data = safeJson(filePath);
    if (data === null || typeof data !== 'object') data = Array.isArray(defaultValue) ? [...defaultValue] : { ...defaultValue };
    // Back up last-known-good state before mutation (best-effort)
    const backupPath = filePath + '.backup';
    try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath); } catch { /* backup is best-effort */ }
    const next = mutateFn(data);
    const finalData = next === undefined ? data : next;
    safeWrite(filePath, finalData);
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

function writeToInbox(agentId, slug, content, _inboxDir) {
  try {
    const inboxDir = _inboxDir || path.join(MINIONS_DIR, 'notes', 'inbox');
    const prefix = `${agentId}-${slug}-${dateStamp()}`;
    const existing = safeReadDir(inboxDir).find(f => f.startsWith(prefix));
    if (existing) return false;
    const noteId = `NOTE-${uid()}`;
    // Inject structured ID as YAML frontmatter if content doesn't already have it
    const hasFrontmatter = /^\s*---[\r\n]/.test(content);
    const tagged = hasFrontmatter
      ? content.replace(/^\s*---[\r\n]+/, `---\nid: ${noteId}\n`)
      : `---\nid: ${noteId}\nagent: ${agentId}\ndate: ${dateStamp()}\n---\n\n${content}`;
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
    if (obj.result) text = maxTextLength ? obj.result.slice(0, maxTextLength) : obj.result;
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
  idleAlertMinutes: 15,
  fanOutTimeout: null, // falls back to agentTimeout
  restartGracePeriod: 1200000, // 20min
  shutdownTimeout: 300000, // 5min — max wait for active agents during graceful shutdown
  allowTempAgents: false, // opt-in: spawn ephemeral agents when all permanent agents are busy
  autoDecompose: true, // auto-decompose implement:large items into sub-tasks
  autoApprovePlans: false, // auto-approve PRDs without waiting for human approval
  autoArchive: false, // opt-in: auto-archive plans after verify completes (false = mark ready, user archives manually)
  autoReview: true, // auto-dispatch review agents for new PRs (disable for manual review workflow)
  meetingRoundTimeout: 600000, // 10min per meeting round before auto-advance
  evalLoop: true, // enable review→fix loop after implementation completes
  evalMaxIterations: 3, // max review→fix cycles before escalating to human
  evalMaxCost: null, // USD ceiling per work item across all eval iterations; null = no limit (gather baseline data first)
  maxRetries: 3, // max dispatch retries before marking work item as failed
  pipelineApiRetries: 2, // max attempts for pipeline API calls
  pipelineApiRetryDelay: 2000, // ms delay between pipeline API retries
  versionCheckInterval: 3600000, // 1 hour — how often to check npm for updates (ms)
  logFlushInterval: 5000, // 5s — how often to flush buffered log entries to disk
  logBufferSize: 50, // flush immediately when buffer exceeds this many entries
  lockRetries: 2, // retry lock acquisition this many times after initial timeout (total attempts = 1 + lockRetries)
  lockRetryBackoffMs: 500, // base backoff between lock retries (doubles each attempt: 500ms, 1s, 2s, ...)
  maxBuildFixAttempts: 3, // max consecutive auto-fix dispatch cycles per PR before escalation to human
  buildFixGracePeriod: 600000, // 10min — wait for CI to run after build fix before re-dispatching
  autoCompletePrs: false, // auto-merge PRs when builds green + review approved (opt-in)
  prMergeMethod: 'squash', // merge method: squash, merge, rebase
  ignoredCommentAuthors: [], // comments from these authors are auto-closed and never trigger fixes
  ccModel: 'sonnet', // model for Command Center and doc-chat (sonnet, haiku, opus)
  ccEffort: null, // effort level for CC/doc-chat (null, 'low', 'medium', 'high')
  heartbeatTimeouts: {}, // populated after WORK_TYPE is defined (below)
  ccMaxTurns: 50, // max tool-use turns for CC/doc-chat before CLI stops
  // Teams integration — config.teams shape: { enabled, appId, appPassword, notifyEvents, ccMirror, inboxPollInterval }
  teams: {
    enabled: false,
    appId: '',
    appPassword: '',
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
  OUT_OF_CONTEXT: 'out-of-context',       // Context window exhausted, max turns reached
  UNKNOWN: 'unknown',                     // Unclassified failure
};
const ESCALATION_POLICY = {
  NO_RETRY: 'no-retry',         // CONFIG_ERROR, PERMISSION_BLOCKED — never retry
  RETRY_SAME: 'retry-same',     // MERGE_CONFLICT, BUILD_FAILURE — retry same agent
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

function getPrLinks() {
  const links = {};
  // Primary source: derive from all projects/*/pull-requests.json prdItems
  const projectsDir = path.join(MINIONS_DIR, 'projects');
  try {
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const prs = JSON.parse(fs.readFileSync(path.join(projectsDir, d.name, 'pull-requests.json'), 'utf8'));
        for (const pr of prs) {
          if (!pr.id) continue;
          for (const itemId of (pr.prdItems || [])) {
            if (itemId) links[pr.id] = itemId;
          }
        }
      } catch { /* missing or invalid */ }
    }
  } catch { /* projects dir missing */ }
  // Fallback: static pr-links.json for entries not covered above
  try {
    const static_ = JSON.parse(fs.readFileSync(PR_LINKS_PATH, 'utf8'));
    for (const [k, v] of Object.entries(static_)) {
      if (!links[k]) links[k] = v;
    }
  } catch { /* missing */ }
  return links;
}

function addPrLink(prId, itemId) {
  if (!prId || !itemId) return;
  const links = getPrLinks();
  if (links[prId] === itemId) return; // already correct, no write needed
  links[prId] = itemId;
  safeWrite(PR_LINKS_PATH, links);
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
  }, { defaultValue: [] });
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

function formatTranscriptEntry(t) {
  return '### ' + (t.agent || 'agent') + ' (' + (t.type || '') + ', Round ' + (t.round || '?') + ')\n\n' + (t.content || '');
}

module.exports = {
  MINIONS_DIR,
  PR_LINKS_PATH,
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
  withFileLock,
  mutateJsonFileLocked,
  mutateWorkItems,
  reopenWorkItem,
  mutatePullRequests,
  uid,
  uniquePath,
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
  nextWorkItemId,
  getAdoOrgBase,
  sanitizePath,
  sanitizeBranch,
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
  formatTranscriptEntry,
  _logBuffer, // exported for testing
};

