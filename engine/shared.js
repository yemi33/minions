/**
 * engine/shared.js — Shared utilities for Minions engine, dashboard, and LLM modules.
 * Extracted from engine.js and dashboard.js to eliminate duplication.
 */

const fs = require('fs');
const path = require('path');

const MINIONS_DIR = path.resolve(__dirname, '..');
const PR_LINKS_PATH = path.join(MINIONS_DIR, 'engine', 'pr-links.json');

// ── File I/O ─────────────────────────────────────────────────────────────────

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeWrite(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = p + '.tmp.' + process.pid;
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
          try { const ab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(ab), 0, 0, delay); } catch { /* fallback busy-wait */ const start = Date.now(); while (Date.now() - start < delay) {} }
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
    const start = Date.now();
    while (Date.now() - start < ms) {}
  }
}

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
    const backupPath = filePath + '.bak';
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
  return { text, usage, sessionId };
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
  meetingRoundTimeout: 600000, // 10min per meeting round before auto-advance
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
  safeRead,
  safeReadDir,
  safeJson,
  safeWrite,
  safeUnlink,
  withFileLock,
  mutateJsonFileLocked,
  uid,
  uniquePath,
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
  sanitizeBranch,
  parseSkillFrontmatter,
};

