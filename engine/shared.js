/**
 * engine/shared.js — Shared utilities for Minions engine, dashboard, and LLM modules.
 * Extracted from engine.js and dashboard.js to eliminate duplication.
 */

const fs = require('fs');
const path = require('path');

const MINIONS_DIR = path.resolve(__dirname, '..');
const PR_LINKS_PATH = path.join(MINIONS_DIR, 'engine', 'pr-links.json');
const LOG_PATH = path.join(__dirname, 'log.json');

// ── Timestamps & Logging ────────────────────────────────────────────────────
// Extracted from engine.js so engine/* modules can import directly without
// circular-requiring the orchestrator.

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

function log(level, msg, meta = {}) {
  const entry = { timestamp: ts(), level, message: msg, ...meta };
  console.log(`[${logTs()}] [${level}] ${msg}`);

  try {
    mutateJsonFileLocked(LOG_PATH, (logData) => {
      if (!Array.isArray(logData)) logData = logData?.entries || [];
      logData.push(entry);
      if (logData.length >= 2500) logData.splice(0, logData.length - 2000);
      return logData;
    }, { defaultValue: [] });
  } catch { /* logging should never crash the caller */ }
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
      try { safeWrite(p, backupData); } catch { /* best-effort restore */ }
      return backupData;
    } catch {
      return null;
    }
  }
}

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
  retryDelayMs = 25
} = {}) {
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
          try { fs.unlinkSync(lockPath); } catch { /* race: another process removed it */ }
          continue; // retry immediately after removing stale lock
        }
      } catch { /* lock file disappeared between EEXIST and stat — retry will succeed */ }
      sleepMs(retryDelayMs);
    }
  }
  if (fd === null) throw new Error(`Lock timeout: ${lockPath}`);

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* cleanup */ }
    try { fs.unlinkSync(lockPath); } catch { /* cleanup */ }
  }
}

function mutateJsonFileLocked(filePath, mutateFn, {
  defaultValue = {}
} = {}) {
  const lockPath = `${filePath}.lock`;
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
  });
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
function writeToInbox(agentId, slug, content, _inboxDir) {
  try {
    const inboxDir = _inboxDir || path.join(MINIONS_DIR, 'notes', 'inbox');
    const prefix = `${agentId}-${slug}-${dateStamp()}`;
    const existing = safeReadDir(inboxDir).find(f => f.startsWith(prefix));
    if (existing) return false;
    const filePath = path.join(inboxDir, `${prefix}.md`);
    safeWrite(filePath, content);
    return true;
  } catch (e) {
    log('warn', `writeToInbox failed: ${e.message}`);
    return false;
  }
}

// ── Process Spawning ────────────────────────────────────────────────────────
// All child process calls go through these to ensure windowsHide: true

const { execSync: _execSync, spawnSync: _spawnSync, spawn: _spawn } = require('child_process');

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

// ── Environment ─────────────────────────────────────────────────────────────

function cleanChildEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete env[key];
  }
  return env;
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
  heartbeatTimeout: 300000, // 5min
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
  autoReview: true, // auto-dispatch review agents for new PRs (disable for manual review workflow)
  meetingRoundTimeout: 600000, // 10min per meeting round before auto-advance
  evalLoop: true, // enable evaluate→fix loop after implementation completes
  evalMaxIterations: 3, // max evaluate→fix cycles before escalating to human
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
  outputFormat: 'json',
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
  if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
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
  try { return JSON.parse(require('fs').readFileSync(PR_LINKS_PATH, 'utf8')); } catch { return {}; }
}

function addPrLink(prId, itemId) {
  if (!prId || !itemId) return;
  const links = getPrLinks();
  if (links[prId] === itemId) return; // already correct, no write needed
  links[prId] = itemId;
  safeWrite(PR_LINKS_PATH, links);
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
  safeJson,
  safeWrite,
  safeUnlink,
  withFileLock,
  mutateJsonFileLocked,
  uid,
  uniquePath,
  writeToInbox,
  exec,
  execSilent,
  run,
  runFile,
  cleanChildEnv,
  gitEnv,
  parseStreamJsonOutput,
  KB_CATEGORIES,
  classifyInboxItem,
  ENGINE_DEFAULTS,
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
  LOCK_STALE_MS,
};

