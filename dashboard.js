#!/usr/bin/env node
/**
 * Minions Mission Control Dashboard
 * Run: node .minions/dashboard.js
 * Opens: http://localhost:7331
 */

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const llm = require('./engine/llm');

// Dashboard version stamp — captured at module load so it reflects the code actually running
const _dashboardVersion = {
  codeVersion: (() => { try { return require('./package.json').version; } catch {} try { return require('@yemi33/minions/package.json').version; } catch {} return null; })(),
  codeCommit: (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); } catch { return null; } })(),
  startedAt: new Date().toISOString(),
  pid: process.pid,
};
const shared = require('./engine/shared');
const queries = require('./engine/queries');
const os = require('os');

const { safeRead, safeReadDir, safeWrite, safeJson, safeJsonObj, safeJsonArr, safeUnlink, mutateJsonFileLocked, mutateWorkItems, getProjects: _getProjects, DONE_STATUSES, WI_STATUS } = shared;
const { getAgents, getAgentDetail, getPrdInfo, getWorkItems, getDispatchQueue,
  getSkills, getInbox, getNotesWithMeta, getPullRequests,
  getEngineLog, getMetrics, getKnowledgeBaseEntries, timeSince,
  MINIONS_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, DISPATCH_PATH, PRD_DIR } = queries;

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
let CONFIG = queries.getConfig();
let PROJECTS = _getProjects(CONFIG);

function reloadConfig() {
  CONFIG = queries.getConfig();
  PROJECTS = _getProjects(CONFIG);
}

const PLANS_DIR = path.join(MINIONS_DIR, 'plans');

// Resolve a plan/PRD file path: .json files live in prd/, .md files in plans/
// Validates that the file stays within the expected directory to prevent path traversal.
function resolvePlanPath(file) {
  if (file.endsWith('.json')) {
    // Validate against both prd/ and prd/archive/
    shared.sanitizePath(file, PRD_DIR);
    const active = path.join(PRD_DIR, file);
    if (fs.existsSync(active)) return active;
    const archived = path.join(PRD_DIR, 'archive', file);
    if (fs.existsSync(archived)) return archived;
    return active;
  }
  // Validate against both plans/ and plans/archive/
  shared.sanitizePath(file, PLANS_DIR);
  const active = path.join(PLANS_DIR, file);
  if (fs.existsSync(active)) return active;
  const archived = path.join(PLANS_DIR, 'archive', file);
  if (fs.existsSync(archived)) return archived;
  return active;
}

// Assemble dashboard HTML from fragments (or fall back to monolith)
function buildDashboardHtml() {
  const dashDir = path.join(MINIONS_DIR, 'dashboard');
  const layoutPath = path.join(dashDir, 'layout.html');

  // Fall back to monolith if fragments don't exist
  if (!fs.existsSync(layoutPath)) {
    return safeRead(path.join(MINIONS_DIR, 'dashboard.html')) || '';
  }

  const layout = safeRead(layoutPath);
  const css = safeRead(path.join(dashDir, 'styles.css'));

  // Assemble page fragments
  const pages = ['home', 'work', 'prs', 'plans', 'inbox', 'tools', 'schedule', 'pipelines', 'meetings', 'engine'];
  let pageHtml = '';
  for (const p of pages) {
    const content = safeRead(path.join(dashDir, 'pages', p + '.html'));
    const activeClass = p === 'home' ? ' active' : '';
    pageHtml += `    <div class="page${activeClass}" id="page-${p}">\n${content}\n    </div>\n\n`;
  }

  // Assemble JS modules (order matters: utils → state → renderers → commands → refresh)
  const jsFiles = [
    'utils', 'state', 'detail-panel', 'live-stream',
    'render-agents', 'render-dispatch', 'render-work-items', 'render-prd',
    'render-prs', 'render-plans', 'render-inbox', 'render-kb', 'render-skills',
    'render-other', 'render-schedules', 'render-pipelines', 'render-meetings', 'render-pinned',
    'command-parser', 'command-input', 'command-center', 'command-history',
    'modal', 'modal-qa', 'settings', 'refresh'
  ];
  let jsHtml = '';
  for (const f of jsFiles) {
    const content = safeRead(path.join(dashDir, 'js', f + '.js'));
    jsHtml += `\n// ─── ${f}.js ────────────────────────────────────────\n${content}\n`;
  }

  return layout
    .replace('/* __CSS__ */', () => css)
    .replace('<!-- __PAGES__ -->', () => pageHtml)
    .replace('/* __JS__ */', () => `window.__MINIONS_HOME = ${JSON.stringify(os.homedir())};\n${jsHtml}`);
}

let HTML_RAW = buildDashboardHtml();
let HTML = HTML_RAW;
let HTML_GZ = zlib.gzipSync(HTML);
let HTML_ETAG = '"' + require('crypto').createHash('md5').update(HTML).digest('hex') + '"';

// Hot-reload: watch dashboard/ directory for changes, rebuild, and push reload to browsers
const _hotReloadClients = new Set();

function rebuildDashboardHtml() {
  try {
    const newRaw = buildDashboardHtml();
    if (newRaw === HTML_RAW) return; // no changes
    HTML_RAW = newRaw;
    HTML = HTML_RAW;
    HTML_GZ = zlib.gzipSync(HTML);
    HTML_ETAG = '"' + require('crypto').createHash('md5').update(HTML).digest('hex') + '"';
    console.log('  Dashboard hot-reloaded');
    // Push reload to all connected browsers via status-stream (saves a connection)
    for (const res of _statusStreamClients) {
      try { res.write('event: reload\ndata: reload\n\n'); } catch { _statusStreamClients.delete(res); }
    }
    // Legacy hot-reload clients
    for (const res of _hotReloadClients) {
      try { res.write('data: reload\n\n'); } catch { _hotReloadClients.delete(res); }
    }
  } catch (e) { console.error('  Hot-reload error:', e.message); }
}

const dashDir = path.join(MINIONS_DIR, 'dashboard');
if (fs.existsSync(dashDir)) {
  let _reloadTimer = null;
  const scheduleReload = () => {
    if (_reloadTimer) clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(rebuildDashboardHtml, 300); // debounce 300ms
  };
  // Watch top-level files (styles.css, layout.html)
  try { fs.watch(dashDir, scheduleReload); } catch { /* optional */ }
  // Watch subdirectories (pages/, js/)
  for (const sub of ['pages', 'js']) {
    const subDir = path.join(dashDir, sub);
    if (fs.existsSync(subDir)) try { fs.watch(subDir, scheduleReload); } catch { /* optional */ }
  }
}

// -- Data Collectors (most moved to engine/queries.js) --

function getVerifyGuides() {
  const guidesDir = path.join(MINIONS_DIR, 'prd', 'guides');
  const guides = [];
  try {
    const files = safeReadDir(guidesDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      // Match guide to plan: verify-officeagent-2026-03-15.md → officeagent-2026-03-15.json
      const planSlug = f.replace('verify-', '').replace('.md', '');
      const planFile = planSlug + '.json';
      guides.push({ file: f, planFile });
    }
  } catch (e) { console.error('getVerifyGuides:', e.message); }
  return guides;
}

function getArchivedPrds() { return []; }
function getEngineState() { return queries.getControl(); }

function _countWorktrees() {
  try {
    const config = queries.getConfig();
    const projects = shared.getProjects(config);
    let count = 0;
    for (const p of projects) {
      const root = p.localPath ? path.resolve(p.localPath) : null;
      if (!root) continue;
      const wtRoot = path.resolve(root, config.engine?.worktreeRoot || shared.ENGINE_DEFAULTS.worktreeRoot);
      try {
        for (const dir of fs.readdirSync(wtRoot)) {
          const dirPath = path.join(wtRoot, dir);
          try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
          // A git worktree has a .git file (not directory) in its root
          if (fs.existsSync(path.join(dirPath, '.git'))) {
            count++;
          } else {
            // Parent directory — scan subdirs for nested worktrees
            try {
              for (const sub of fs.readdirSync(dirPath)) {
                const subPath = path.join(dirPath, sub);
                try { if (fs.statSync(subPath).isDirectory() && fs.existsSync(path.join(subPath, '.git'))) count++; } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    }
    return count;
  } catch { return 0; }
}

// ── npm update check ────────────────────────────────────────────────────────
let _npmVersionCache = null;
let _npmVersionCacheTs = 0;
function _getVersionCheckInterval() {
  try { return queries.getConfig()?.engine?.versionCheckInterval || shared.ENGINE_DEFAULTS.versionCheckInterval; } catch { return shared.ENGINE_DEFAULTS.versionCheckInterval; }
}
const PKG_NAME = '@yemi33/minions';

async function checkNpmVersion() {
  const now = Date.now();
  if (_npmVersionCache && (now - _npmVersionCacheTs) < _getVersionCheckInterval()) return _npmVersionCache;
  try {
    // Use npm view — respects user's .npmrc proxy/registry config
    // Must use shell:true on Windows because npm is a .cmd batch script
    const { exec: _exec } = require('child_process');
    const nodeDir = require('path').dirname(process.execPath);
    const npmPath = require('path').join(nodeDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const version = await new Promise((resolve, reject) => {
      _exec(`"${npmPath}" view ${PKG_NAME} version`, { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        if (err) reject(err); else resolve((stdout || '').trim());
      });
    });
    _npmVersionCache = { latest: version || null, checkedAt: new Date().toISOString() };
    _npmVersionCacheTs = now;
  } catch (e) {
    console.error('[version-check] npm view failed:', e.message?.split('\n')?.[0]);
    _npmVersionCache = _npmVersionCache || { latest: null, checkedAt: null, error: e.message?.split('\n')?.[0] || 'check failed' };
  }
  return _npmVersionCache;
}

function _compareVersions(a, b) {
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// Kick off first npm check on startup, then re-check every 4 hours
checkNpmVersion().catch(() => {});
setInterval(() => checkNpmVersion().catch(() => {}), _getVersionCheckInterval());

// Cache disk version + git commit (only changes on deploy/pull, not per-request)
let _diskVersionCache = null;
let _diskVersionCacheTs = 0;
const DISK_VERSION_TTL = 60000; // re-check every 60s
function getDiskVersion() {
  const now = Date.now();
  if (_diskVersionCache && (now - _diskVersionCacheTs) < DISK_VERSION_TTL) return _diskVersionCache;
  let diskVersion = null;
  try {
    const pkgPath = require.resolve('./package.json');
    delete require.cache[pkgPath]; // bust Node's require cache so npm updates are detected
    diskVersion = require('./package.json').version;
  } catch {}
  // Fallback: if no local package.json (e.g. ~/.minions/ missing it), try the npm package root
  if (!diskVersion) {
    try { diskVersion = require('@yemi33/minions/package.json').version; } catch {}
  }
  let diskCommit = null;
  let isGitRepo = false;
  // Prefer git (authoritative for repo-based dev), fall back to .minions-commit (installed copies)
  try { diskCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: MINIONS_DIR, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); isGitRepo = true; } catch {}
  if (!diskCommit) {
    try { diskCommit = fs.readFileSync(path.join(MINIONS_DIR, '.minions-commit'), 'utf8').trim() || null; } catch {}
  }
  _diskVersionCache = { diskVersion, diskCommit, isGitRepo };
  _diskVersionCacheTs = now;
  return _diskVersionCache;
}

function getMcpServers() {
  try {
    const home = os.homedir();
    const claudeJsonPath = path.join(home, '.claude.json');
    const data = safeJsonObj(claudeJsonPath);
    const servers = data.mcpServers || {};
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: cfg.command || '',
      args: (cfg.args || []).slice(-1)[0] || '',
    }));
  } catch { return []; }
}

function parsePinnedEntries(content) {
  if (!content) return [];
  const entries = [];
  const regex = /###\s*(🔴\s*|🟡\s*)?(.+)\n\n([\s\S]*?)(?=\n\n###|\n\n\*Pinned|$)/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    entries.push({ level: m[1]?.includes('🔴') ? 'critical' : m[1]?.includes('🟡') ? 'warning' : 'info', title: m[2].trim(), content: m[3].trim() });
  }
  return entries;
}

let _statusCache = null;
let _statusCacheJson = null; // cached JSON.stringify(_statusCache) — avoids double-serialization for SSE
let _statusCacheTs = 0;
const STATUS_CACHE_TTL = 10000; // 10s — reduces expensive aggregation frequency; mutations call invalidateStatusCache()
const _statusStreamClients = new Set();
let _statusPushTimer = null;
let _lastStatusHash = '';

// mtime-based cache invalidation — skip full rebuild if no tracked files changed
const _mtimeTrackedFiles = () => {
  const files = [
    path.join(ENGINE_DIR, 'dispatch.json'),
    path.join(ENGINE_DIR, 'control.json'),
    path.join(ENGINE_DIR, 'log.json'),
    path.join(ENGINE_DIR, 'metrics.json'),
  ];
  // Add per-project work-items.json
  for (const p of PROJECTS) {
    if (p.localPath) files.push(path.join(p.localPath, '.minions', 'work-items.json'));
  }
  // Central work-items.json
  files.push(path.join(MINIONS_DIR, 'work-items.json'));
  return files;
};
let _lastMtimes = {}; // { filePath: mtimeMs }

function _getMtimes() {
  const result = {};
  for (const fp of _mtimeTrackedFiles()) {
    try { result[fp] = fs.statSync(fp).mtimeMs; } catch { result[fp] = 0; }
  }
  return result;
}

function _mtimesChanged(prev, curr) {
  for (const fp of Object.keys(curr)) {
    if (prev[fp] !== curr[fp]) return true;
  }
  // Also check if keys differ (new files appeared)
  for (const fp of Object.keys(prev)) {
    if (!(fp in curr)) return true;
  }
  return false;
}

function invalidateStatusCache() {
  _statusCache = null;
  _statusCacheJson = null;
  // Push to SSE clients (debounced 500ms to avoid flooding during batch mutations)
  if (_statusPushTimer) return;
  _statusPushTimer = setTimeout(() => {
    _statusPushTimer = null;
    if (_statusStreamClients.size === 0) return;
    const data = getStatusJson();
    for (const res of _statusStreamClients) {
      try { res.write('data: ' + data + '\n\n'); } catch { _statusStreamClients.delete(res); }
    }
  }, 500);
}

function getStatus() {
  const now = Date.now();
  if (_statusCache && (now - _statusCacheTs) < STATUS_CACHE_TTL) {
    // Within TTL — check mtimes for early return (skip full rebuild if nothing changed)
    const currMtimes = _getMtimes();
    if (!_mtimesChanged(_lastMtimes, currMtimes)) return _statusCache;
  }

  // Reload config on each cache miss — picks up external changes (minions init, minions add)
  reloadConfig();

  const prdInfo = getPrdInfo();
  _statusCache = {
    agents: getAgents(),
    prdProgress: prdInfo.progress,
    inbox: getInbox(),
    notes: getNotesWithMeta(),
    prd: prdInfo.status,
    pullRequests: getPullRequests(),
    verifyGuides: getVerifyGuides(),
    archivedPrds: getArchivedPrds(),
    engine: { ...getEngineState(), worktreeCount: _countWorktrees() },
    dispatch: getDispatchQueue(),
    engineLog: getEngineLog(),
    metrics: getMetrics(),
    workItems: getWorkItems(),
    skills: getSkills(),
    mcpServers: getMcpServers(),
    schedules: (() => {
      const scheds = CONFIG.schedules || [];
      const runs = shared.safeJson(path.join(MINIONS_DIR, 'engine', 'schedule-runs.json')) || {};
      return scheds.map(s => ({ ...s, _lastRun: runs[s.id] || null }));
    })(),
    meetings: (() => { try { return require('./engine/meeting').getMeetings(); } catch { return []; } })(),
    pipelines: (() => { try { const pl = require('./engine/pipeline'); return pl.getPipelines().map(p => ({ ...p, runs: (pl.getPipelineRuns()[p.id] || []).slice(-5) })); } catch { return []; } })(),
    pinned: (() => { try { return parsePinnedEntries(safeRead(path.join(MINIONS_DIR, 'pinned.md'))); } catch { return []; } })(),
    projects: PROJECTS.map(p => ({ name: p.name, path: p.localPath, description: p.description || '' })),
    autoMode: {
      approvePlans: !!CONFIG.engine?.autoApprovePlans,
      decompose: CONFIG.engine?.autoDecompose !== false,
      tempAgents: !!CONFIG.engine?.allowTempAgents,
      inboxThreshold: CONFIG.engine?.inboxConsolidateThreshold || shared.ENGINE_DEFAULTS.inboxConsolidateThreshold,
      ccModel: CONFIG.engine?.ccModel || shared.ENGINE_DEFAULTS.ccModel,
      ccEffort: CONFIG.engine?.ccEffort || shared.ENGINE_DEFAULTS.ccEffort,
    },
    initialized: !!(CONFIG.agents && Object.keys(CONFIG.agents).length > 0),
    installId: safeRead(path.join(MINIONS_DIR, '.install-id')).trim() || null,
    version: (() => {
      const engine = getEngineState();
      const { diskVersion, diskCommit, isGitRepo } = getDiskVersion();
      const engineStale = !!(engine.codeVersion && diskVersion && engine.codeVersion !== diskVersion) ||
                          !!(engine.codeCommit && diskCommit && engine.codeCommit !== diskCommit);
      const dashboardStale = !!(diskVersion && _dashboardVersion.codeVersion && diskVersion !== _dashboardVersion.codeVersion) ||
                             !!(diskCommit && _dashboardVersion.codeCommit && diskCommit !== _dashboardVersion.codeCommit);
      return {
        running: engine.codeVersion || null,
        runningCommit: engine.codeCommit || null,
        dashboardRunning: _dashboardVersion.codeVersion,
        dashboardRunningCommit: _dashboardVersion.codeCommit,
        dashboardStartedAt: _dashboardVersion.startedAt,
        disk: diskVersion,
        diskCommit,
        engineStale,
        dashboardStale,
        stale: engineStale || dashboardStale,
        latest: _npmVersionCache?.latest || null,
        // Only show "update available" for npm installs (no git repo) — repo users manage their own updates
        updateAvailable: !isGitRepo && !!(diskVersion && _npmVersionCache?.latest && _npmVersionCache.latest !== diskVersion && _compareVersions(_npmVersionCache.latest, diskVersion) > 0),
        _npmCheckError: _npmVersionCache?.error || null,
      };
    })(),
    timestamp: new Date().toISOString(),
  };
  _statusCacheTs = now;
  _statusCacheJson = null; // invalidate cached JSON — will be lazily rebuilt by getStatusJson()
  _lastMtimes = _getMtimes();
  return _statusCache;
}

/** Return cached JSON string of status — single stringify, reused by SSE and /api/status */
function getStatusJson() {
  getStatus(); // ensure _statusCache is fresh
  if (!_statusCacheJson) {
    _statusCacheJson = JSON.stringify(_statusCache);
  }
  return _statusCacheJson;
}

// Periodic push for engine-driven changes (dispatch.json, control.json) that bypass invalidateStatusCache
setInterval(() => {
  if (_statusStreamClients.size === 0) return;
  const data = getStatusJson();
  const hash = require('crypto').createHash('md5').update(data).digest('hex');
  if (hash === _lastStatusHash) return;
  _lastStatusHash = hash;
  for (const res of _statusStreamClients) {
    try { res.write('data: ' + data + '\n\n'); } catch { _statusStreamClients.delete(res); }
  }
}, 10000);


// ── Command Center: session state + helpers ─────────────────────────────────

const CC_SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
const CC_SESSION_MAX_TURNS = Infinity;
let ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
let ccInFlight = false;
let ccInFlightSince = 0; // timestamp — auto-release stuck guard
const CC_INFLIGHT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes — auto-release if request hangs

// _ccPromptHash computed after CC_STATIC_SYSTEM_PROMPT is defined (see below)

function ccSessionValid() {
  if (!ccSession.sessionId) return false;
  // Invalidate session if system prompt changed (e.g. after code update + restart)
  if (ccSession._promptHash && ccSession._promptHash !== _ccPromptHash) {
    console.log('[CC] System prompt changed — invalidating stale session');
    ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
    return false;
  }
  const age = Date.now() - new Date(ccSession.lastActiveAt || 0).getTime();
  return age < CC_SESSION_EXPIRY_MS && ccSession.turnCount < CC_SESSION_MAX_TURNS;
}

// Load persisted CC session on startup
try {
  const saved = safeJson(path.join(ENGINE_DIR, 'cc-session.json'));
  if (saved && saved.sessionId) {
    const age = Date.now() - new Date(saved.lastActiveAt || 0).getTime();
    if (age < CC_SESSION_EXPIRY_MS) ccSession = saved;
  }
} catch { /* optional */ }

// Static system prompt — baked into session on creation, never changes
// Load CC system prompt from file — editable without touching engine code
const CC_STATIC_SYSTEM_PROMPT = (() => {
  try {
    const raw = fs.readFileSync(path.join(MINIONS_DIR, 'prompts', 'cc-system.md'), 'utf8');
    return raw.replace(/\{\{minions_dir\}\}/g, MINIONS_DIR);
  } catch (e) {
    console.error('Failed to load prompts/cc-system.md:', e.message);
    return 'You are the Command Center AI for Minions. Delegate work to agents.';
  }
})();

// Hash the system prompt so we can detect changes and invalidate stale sessions
const _ccPromptHash = require('crypto').createHash('md5').update(CC_STATIC_SYSTEM_PROMPT).digest('hex').slice(0, 8);

let _preambleCache = null;
let _preambleCacheTs = 0;
const PREAMBLE_TTL = 30000; // 30s — longer TTL since preamble is lightweight orientation, not real-time data

function buildCCStatePreamble() {
  const now = Date.now();
  if (_preambleCache && now - _preambleCacheTs < PREAMBLE_TTL) return _preambleCache;
  // Lightweight snapshot — just enough to orient. Use tools for details.
  const agents = getAgents().map(a => `- ${a.name} (${a.id}): ${a.status}${a.currentTask ? ' — ' + a.currentTask.slice(0, 60) : ''}`).join('\n');
  const projects = PROJECTS.map(p => `- ${p.name}: ${p.localPath}`).join('\n');

  const dq = getDispatchQueue();
  const active = (dq.active || []).map(d => `- ${d.agentName || d.agent}: ${(d.task || '').slice(0, 50)}`).join('\n') || '(none)';
  const pending = (dq.pending || []).length;

  const prCount = getPullRequests().length;
  const wiCount = getWorkItems().length;

  const planFiles = [...safeReadDir(PLANS_DIR), ...safeReadDir(PRD_DIR)].filter(f => f.endsWith('.md') || f.endsWith('.json'));

  const schedules = CONFIG.schedules || [];
  const enabledSchedules = schedules.filter(s => s.enabled !== false).length;

  let pipelineCount = 0;
  try { pipelineCount = require('./engine/pipeline').getPipelines().length; } catch {}

  const result = `### Agents
${agents}

### Active Dispatch
${active}
Pending: ${pending}

### Quick Counts
PRs: ${prCount} | Work items: ${wiCount} | Plans/PRDs: ${planFiles.length} | Schedules: ${enabledSchedules}/${schedules.length} enabled | Pipelines: ${pipelineCount}

### Projects
${projects}

Use tools to read \`config.json\` (schedules), \`pipelines/\` dir, or \`curl http://localhost:7331/api/routes\` for details.
For all state files, look under \`${MINIONS_DIR}\`.`;
  _preambleCache = result;
  _preambleCacheTs = now;
  return result;
}

function parseCCActions(text) {
  let actions = [];
  let displayText = text;
  const delimIdx = text.indexOf('===ACTIONS===');
  if (delimIdx >= 0) {
    displayText = text.slice(0, delimIdx).trim();
    try {
      const parsed = JSON.parse(text.slice(delimIdx + '===ACTIONS==='.length).trim());
      actions = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
  }
  if (actions.length === 0) {
    const actionRegex = /`{3,}\s*action\s*\r?\n([\s\S]*?)`{3,}/g;
    let match;
    while ((match = actionRegex.exec(displayText)) !== null) {
      try { actions.push(JSON.parse(match[1].trim())); } catch {}
    }
    if (actions.length > 0) displayText = displayText.replace(/`{3,}\s*action\s*\r?\n[\s\S]*?`{3,}\n?/g, '').trim();
  }
  return { text: displayText, actions };
}

// ── Shared LLM call core — used by CC panel and doc modals ──────────────────

// Session store for doc modals — keyed by filePath or title, persisted to disk
const CC_SESSIONS_PATH = path.join(ENGINE_DIR, 'cc-sessions.json');
const DOC_SESSIONS_PATH = path.join(ENGINE_DIR, 'doc-sessions.json');
const docSessions = new Map(); // key → { sessionId, lastActiveAt, turnCount }

// Load persisted doc sessions on startup
try {
  const saved = safeJson(DOC_SESSIONS_PATH);
  if (saved && typeof saved === 'object') {
    const now = Date.now();
    for (const [key, s] of Object.entries(saved)) {
      const age = now - new Date(s.lastActiveAt || 0).getTime();
      if (age < CC_SESSION_EXPIRY_MS && s.turnCount < CC_SESSION_MAX_TURNS) {
        docSessions.set(key, s);
      }
    }
  }
} catch { /* optional */ }

function persistDocSessions() {
  const obj = {};
  for (const [key, s] of docSessions) obj[key] = s;
  safeWrite(DOC_SESSIONS_PATH, obj);
}

// Resolve session from any store (CC global or doc-specific)
function resolveSession(store, key) {
  if (store === 'cc') {
    return ccSessionValid() ? { sessionId: ccSession.sessionId, turnCount: ccSession.turnCount } : null;
  }
  if (!key) return null;
  const s = docSessions.get(key);
  if (!s) return null;
  const age = Date.now() - new Date(s.lastActiveAt).getTime();
  if (age > CC_SESSION_EXPIRY_MS || s.turnCount >= CC_SESSION_MAX_TURNS) {
    docSessions.delete(key);
    persistDocSessions();
    return null;
  }
  return s;
}

// Update session after successful call
function updateSession(store, key, sessionId, existing) {
  if (!sessionId) return;
  const now = new Date().toISOString();
  if (store === 'cc') {
    ccSession = {
      sessionId,
      createdAt: existing ? ccSession.createdAt : now,
      lastActiveAt: now,
      turnCount: (existing ? ccSession.turnCount : 0) + 1,
      _promptHash: _ccPromptHash,
    };
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
  } else if (key) {
    const prev = docSessions.get(key);
    docSessions.set(key, {
      sessionId,
      lastActiveAt: now,
      turnCount: (existing && prev ? prev.turnCount : 0) + 1,
      _docHash: prev?._docHash || null,
    });
    persistDocSessions();
  }
}

/**
 * Core LLM call — shared by CC panel and doc modals.
 * @param {string} message - User message
 * @param {object} opts
 * @param {string} opts.store - 'cc' or 'doc'
 * @param {string} opts.sessionKey - Key for doc session (filePath or title)
 * @param {string} opts.extraContext - Additional context prepended to message (e.g., document)
 * @param {string} opts.label - Metrics label
 * @param {number} opts.timeout - Timeout in ms
 * @param {number} opts.maxTurns - Max tool-use turns
 * @param {string} opts.allowedTools - Comma-separated tool list
 */
async function ccCall(message, { store = 'cc', sessionKey, extraContext, label = 'command-center', timeout = 900000, maxTurns, allowedTools = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch', skipStatePreamble = false, model } = {}) {
  if (!maxTurns) maxTurns = CONFIG.engine?.ccMaxTurns || shared.ENGINE_DEFAULTS.ccMaxTurns;
  if (!model) model = CONFIG.engine?.ccModel || shared.ENGINE_DEFAULTS.ccModel;
  const ccEffort = CONFIG.engine?.ccEffort || shared.ENGINE_DEFAULTS.ccEffort;
  const existing = resolveSession(store, sessionKey);
  let sessionId = existing ? existing.sessionId : null;

  function buildPrompt({ includePreamble = true } = {}) {
    const parts = (!skipStatePreamble && includePreamble) ? [`## Current Minions State (${new Date().toISOString().slice(0, 16)})\n\n${buildCCStatePreamble()}`] : [];
    if (extraContext) parts.push(extraContext);
    parts.push(message);
    return parts.join('\n\n---\n\n');
  }

  let result;

  // Attempt 1: resume existing session — skip preamble (session already has context)
  if (sessionId && maxTurns > 1) {
    result = await llm.callLLM(buildPrompt({ includePreamble: false }), '', {
      timeout, label, model, maxTurns, allowedTools, sessionId, effort: ccEffort, direct: true,
    });
    llm.trackEngineUsage(label, result.usage);

    if (result.text) {
      updateSession(store, sessionKey, result.sessionId || sessionId, true);
      return result;
    }

    // No text — distinguish "session exists but call failed" (e.g. tool timeout)
    // from "session is truly dead" (no sessionId returned, or stderr indicates invalid session).
    const sessionStillValid = llm.isResumeSessionStillValid(result);
    if (sessionStillValid) {
      console.log(`[${label}] Resume call failed (code=${result.code}, empty=${!result.text}) but session is still valid — preserving session for retry`);
      updateSession(store, sessionKey, result.sessionId || sessionId, true);
      return result;
    }

    console.log(`[${label}] Resume failed — session appears dead (code=${result.code}, empty=${!result.text}), retrying fresh...`);
    sessionId = null;
    // Invalidate the dead session so future calls don't try to resume it
    if (store === 'cc') {
      ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
      safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
    } else if (sessionKey) {
      docSessions.delete(sessionKey);
      persistDocSessions();
    }
  }

  // Attempt 2: fresh session (include preamble for full context)
  const freshPrompt = buildPrompt();
  result = await llm.callLLM(freshPrompt, CC_STATIC_SYSTEM_PROMPT, {
    timeout, label, model, maxTurns, allowedTools, effort: ccEffort, direct: true,
  });
  llm.trackEngineUsage(label, result.usage);

  if (result.text) {
    updateSession(store, sessionKey, result.sessionId, false);
    return result;
  }

  // Attempt 3: one more retry after a brief pause (skip for single-turn — not worth the latency)
  if (maxTurns <= 1) return result;
  console.log(`[${label}] Fresh call also failed (code=${result.code}, empty=${!result.text}), retrying once more...`);
  await new Promise(r => setTimeout(r, 2000));
  result = await llm.callLLM(freshPrompt, CC_STATIC_SYSTEM_PROMPT, {
    timeout, label, model, maxTurns, allowedTools, effort: ccEffort, direct: true,
  });
  llm.trackEngineUsage(label, result.usage);

  if (result.text) {
    updateSession(store, sessionKey, result.sessionId, false);
  }
  return result;
}

// Doc-specific wrapper — adds document context, parses ---DOCUMENT---
async function ccDocCall({ message, document, title, filePath, selection, canEdit, isJson, model }) {
  const sessionKey = filePath || title;
  const docSlice = document.slice(0, 20000);

  // Skip re-sending full document on session resume if content unchanged
  const docHash = require('crypto').createHash('md5').update(docSlice).digest('hex').slice(0, 8);
  const existing = resolveSession('doc', sessionKey);
  const docUnchanged = existing?.sessionId && existing._docHash === docHash;

  let docContext;
  if (docUnchanged) {
    // Session has the document — only send selection and edit instructions
    docContext = `## Document: ${title || 'Document'}${filePath ? ' (`' + filePath + '`)' : ''}${selection ? '\n**Selected text:**\n> ' + selection.slice(0, 1500) : ''}${canEdit ? '\nIf editing: respond with your explanation, then `---DOCUMENT---` on its own line, then the COMPLETE updated file.' : ''}`;
  } else {
    docContext = `## Document Context\n**${title || 'Document'}**${filePath ? ' (`' + filePath + '`)' : ''}${isJson ? ' (JSON)' : ''}\n${selection ? '\n**Selected text:**\n> ' + selection.slice(0, 1500) + '\n' : ''}\n\`\`\`\n${docSlice}\n\`\`\`\n${canEdit ? '\nIf editing: respond with your explanation, then `---DOCUMENT---` on its own line, then the COMPLETE updated file.' : '\n(Read-only — answer questions only.)'}`;
  }

  const result = await ccCall(message, {
    store: 'doc', sessionKey,
    extraContext: docContext, label: 'doc-chat',
    allowedTools: canEdit ? 'Read,Write,Edit,Glob,Grep' : 'Read,Glob,Grep',
    maxTurns: canEdit ? 15 : 10,
    skipStatePreamble: true,
    ...(model ? { model } : {}),
  });
  // Store doc hash for next call's unchanged check
  if (result.code === 0 && result.sessionId) {
    const session = resolveSession('doc', sessionKey);
    if (session) session._docHash = docHash;
  }

  if (result.code !== 0 || !result.text) {
    console.error(`[doc-chat] Failed: code=${result.code}, empty=${!result.text}, filePath=${filePath}, stderr=${(result.stderr || '').slice(0, 200)}`);
    return { answer: 'Failed to process request. Try again.', content: null, actions: [] };
  }

  // Parse ---DOCUMENT--- BEFORE actions — document content may contain ===ACTIONS=== literally
  const delimIdx = result.text.indexOf('---DOCUMENT---');
  if (delimIdx >= 0) {
    const answerPart = result.text.slice(0, delimIdx).trim();
    const { text: answer, actions } = parseCCActions(answerPart);
    let content = result.text.slice(delimIdx + '---DOCUMENT---'.length).trim();
    content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    return { answer, content, actions };
  }

  const { text: stripped, actions } = parseCCActions(result.text);
  return { answer: stripped, content: null, actions };
}

// -- POST helpers --

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Request body timeout after 30s'));
    }, 30000);
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) { clearTimeout(timeout); reject(new Error('Too large')); } });
    req.on('end', () => { clearTimeout(timeout); try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

const _rateLimits = new Map();
function checkRateLimit(key, maxPerMinute) {
  const now = Date.now();
  const entries = _rateLimits.get(key) || [];
  const recent = entries.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return true;
  recent.push(now);
  _rateLimits.set(key, recent);
  return false;
}

function jsonReply(res, code, data, req) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = code;
  const json = JSON.stringify(data);
  const ae = req && req.headers && req.headers['accept-encoding'] || '';
  if (ae.includes('gzip') && json.length > 1024) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(zlib.gzipSync(json));
  } else {
    res.end(json);
  }
}

// -- Dispatch cleanup helper --

/**
 * Remove dispatch entries matching a predicate. Scans pending, active, completed queues.
 * Also kills agent processes for matched active entries.
 * @param {(entry) => boolean} matchFn - return true for entries to remove
 * @returns {number} count of removed entries
 */
function cleanDispatchEntries(matchFn) {
  const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
  const engineDir = path.join(MINIONS_DIR, 'engine');
  try {
    let removed = 0;
    // Collect PIDs and file paths inside the lock, execute kills outside
    const pidsToKill = [];
    const filesToDelete = [];
    mutateJsonFileLocked(dispatchPath, (dispatch) => {
      dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
      dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
      dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
      for (const queue of ['pending', 'active', 'completed']) {
        const before = dispatch[queue].length;
        if (queue === 'active') {
          for (const d of dispatch[queue]) {
            if (!matchFn(d)) continue;
            // Collect PID and cleanup paths — actual I/O happens after lock release
            const pidFile = path.join(engineDir, `pid-${d.id}.pid`);
            try {
              const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
              if (pid) pidsToKill.push(pid);
            } catch { /* PID file may not exist */ }
            filesToDelete.push(pidFile);
            filesToDelete.push(path.join(engineDir, 'tmp', `prompt-${d.id}.md`));
            filesToDelete.push(path.join(engineDir, 'tmp', `sysprompt-${d.id}.md`));
            filesToDelete.push(path.join(engineDir, 'tmp', `sysprompt-${d.id}.md.tmp`));
          }
        }
        dispatch[queue] = dispatch[queue].filter(d => !matchFn(d));
        removed += before - dispatch[queue].length;
      }
      return dispatch;
    }, { defaultValue: { pending: [], active: [], completed: [] } });
    // Kill processes outside the lock — these can take hundreds of ms on Windows
    for (const pid of pidsToKill) {
      try {
        const safePid = shared.validatePid(pid);
        if (process.platform === 'win32') {
          const { execFileSync } = require('child_process');
          execFileSync('taskkill', ['/PID', String(safePid), '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
        } else {
          process.kill(safePid, 'SIGTERM');
        }
      } catch { /* process may already be dead */ }
    }
    // Clean up files outside the lock
    for (const fp of filesToDelete) {
      try { fs.unlinkSync(fp); } catch { /* file may not exist */ }
    }
    return removed;
  } catch { return 0; }
}

// ── Engine Restart Helpers (used by watchdog + API) ─────────────────────────

function spawnEngine() {
  const controlPath = path.join(ENGINE_DIR, 'control.json');
  // Don't pre-write 'stopped' — let the new engine process own its state transition.
  // The engine start code already handles state:'running' with a dead PID gracefully.
  // Only set restarted_at + clear stale pid so dashboard shows the restart timestamp.
  const control = safeJson(controlPath) || {};
  safeWrite(controlPath, { ...control, pid: null, restarted_at: new Date().toISOString() });
  const { spawn: cpSpawn } = require('child_process');
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete childEnv[key];
  }
  const engineProc = cpSpawn(process.execPath, [path.join(MINIONS_DIR, 'engine.js'), 'start'], {
    cwd: MINIONS_DIR, stdio: 'ignore', detached: true, env: childEnv, windowsHide: true,
  });
  engineProc.unref();
  return engineProc.pid;
}

function killEnginePid(pid) {
  const { execFileSync } = require('child_process');
  try {
    const safePid = shared.validatePid(pid);
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(safePid), '/F', '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
    } else {
      process.kill(safePid, 'SIGKILL');
    }
  } catch { /* process may be dead */ }
}

function restartEngine() {
  const control = getEngineState();
  if (control.pid) {
    killEnginePid(control.pid);
    console.log(`[watchdog] Killed engine PID ${control.pid}`);
  }
  const newPid = spawnEngine();
  console.log(`[watchdog] Engine restarted (new PID: ${newPid})`);
  return newPid;
}

// -- Server --

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── Route Handler Functions ───────────────────────────────────────────────

  async function handlePlansTriggerVerify(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      shared.sanitizePath(body.file, PRD_DIR);

      // Find the PRD — check active and archive
      const prdDir = path.join(MINIONS_DIR, 'prd');
      let prdPath = path.join(prdDir, body.file);
      let fromArchive = false;
      if (!fs.existsSync(prdPath)) {
        prdPath = path.join(prdDir, 'archive', body.file);
        fromArchive = true;
      }
      if (!fs.existsSync(prdPath)) return jsonReply(res, 404, { error: 'PRD not found' });

      // If archived, temporarily restore to active so checkPlanCompletion can find it
      const activePath = path.join(prdDir, body.file);
      if (fromArchive) {
        const plan = safeJson(prdPath);
        if (!plan) return jsonReply(res, 500, { error: 'Could not parse PRD file' });
        plan.status = 'approved';
        delete plan.completedAt;
        safeWrite(activePath, plan);
      }

      const config = queries.getConfig();
      const project = PROJECTS.find(p => {
        const plan = safeJson(activePath) || safeJson(prdPath);
        return plan && p.name?.toLowerCase() === (plan.project || '').toLowerCase();
      }) || PROJECTS[0] || null;

      // Check for existing verify WI — reset to pending if already done (re-verify)
      if (project) {
        const wiPath = shared.projectWorkItemsPath(project);
        let existingVerify = null;
        mutateWorkItems(wiPath, items => {
          const v = items.find(w => w.sourcePlan === body.file && w.itemType === 'verify');
          if (v && (v.status === 'done' || v.status === 'failed')) {
            v.status = 'pending';
            delete v.completedAt;
            delete v.dispatched_to;
            delete v.dispatched_at;
            v._retryCount = 0;
            existingVerify = v;
          } else if (v) {
            existingVerify = v;
          }
        });
        if (existingVerify) {
          invalidateStatusCache();
          return jsonReply(res, 200, { ok: true, verifyId: existingVerify.id });
        }
      }

      // No existing verify — clear completion flag and trigger fresh creation
      const planData = safeJson(activePath);
      if (planData?._completionNotified) {
        planData._completionNotified = false;
        safeWrite(activePath, planData);
      }

      const lifecycle = require('./engine/lifecycle');
      lifecycle.checkPlanCompletion({ item: { sourcePlan: body.file, id: 'manual' } }, config);

      if (project) {
        const wiPath = shared.projectWorkItemsPath(project);
        const items = safeJsonArr(wiPath);
        const verify = items.find(w => w.sourcePlan === body.file && w.itemType === 'verify');
        if (verify) {
          invalidateStatusCache();
          return jsonReply(res, 200, { ok: true, verifyId: verify.id });
        }
      }
      return jsonReply(res, 200, { ok: true, message: 'Completion check ran but no verify task was needed' });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleWorkItemsRetry(req, res) {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      // Find the right file — check source first, then search all project files
      let wiPath;
      if (source && source !== 'central') {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) wiPath = shared.projectWorkItemsPath(proj);
      }
      if (!wiPath) {
        // Search central first, then all projects
        const centralPath = path.join(MINIONS_DIR, 'work-items.json');
        const centralItems = shared.safeJson(centralPath) || [];
        if (centralItems.some(i => i.id === id)) {
          wiPath = centralPath;
        } else {
          for (const proj of PROJECTS) {
            const projPath = shared.projectWorkItemsPath(proj);
            const projItems = shared.safeJson(projPath) || [];
            if (projItems.some(i => i.id === id)) { wiPath = projPath; break; }
          }
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'work item not found in any source' });

      let found = false;
      mutateJsonFileLocked(wiPath, (items) => {
        if (!Array.isArray(items)) items = [];
        const item = items.find(i => i.id === id);
        if (!item) return items;
        // Don't reset completed items unless explicitly forced
        if ((DONE_STATUSES.has(item.status) || item.completedAt) && !body.force) {
          found = 'already_done';
          return items;
        }
        found = true;
        item.status = WI_STATUS.PENDING;
        item._retryCount = 0; // Reset retry counter on manual retry
        delete item.dispatched_at;
        delete item.dispatched_to;
        delete item.failReason;
        delete item.failedAt;
        delete item.completedAt;
        delete item.fanOutAgents;
        return items;
      });
      if (found === 'already_done') return jsonReply(res, 409, { error: 'item already completed — use force:true to retry' });
      if (!found) return jsonReply(res, 404, { error: 'item not found' });

      // Clear completed dispatch entries so the engine doesn't dedup this item
      const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
      const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
      const dispatchKey = sourcePrefix + id;
      try {
        mutateJsonFileLocked(dispatchPath, (dispatch) => {
          dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
          dispatch.completed = dispatch.completed.filter(d => d.meta?.dispatchKey !== dispatchKey);
          dispatch.completed = dispatch.completed.filter(d => !d.meta?.parentKey || d.meta.parentKey !== dispatchKey);
          return dispatch;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      } catch (e) { console.error('dispatch cleanup:', e.message); }

      // Clear cooldown so item isn't blocked by exponential backoff
      try {
        const cooldownPath = path.join(MINIONS_DIR, 'engine', 'cooldowns.json');
        const cooldowns = safeJsonObj(cooldownPath);
        if (cooldowns[dispatchKey]) {
          delete cooldowns[dispatchKey];
          safeWrite(cooldownPath, cooldowns);
        }
      } catch (e) { console.error('cooldown cleanup:', e.message); }

      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleWorkItemsDelete(req, res) {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      // Find the right work-items file
      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          wiPath = shared.projectWorkItemsPath(proj);
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      let item = null;
      let found = false;
      mutateJsonFileLocked(wiPath, (items) => {
        if (!Array.isArray(items)) return items;
        const idx = items.findIndex(i => i.id === id);
        if (idx === -1) return items;
        item = items[idx];
        items.splice(idx, 1);
        found = true;
        return items;
      }, { defaultValue: [] });
      if (!found) return jsonReply(res, 404, { error: 'item not found' });

      // Clean dispatch entries + kill running agent (outside lock)
      const dispatchRemoved = cleanDispatchEntries(d =>
        d.meta?.item?.id === id ||
        d.meta?.dispatchKey?.endsWith(id)
      );

      // Clean cooldown entries so item can be re-created immediately
      try {
        const cooldownPath = path.join(MINIONS_DIR, 'engine', 'cooldowns.json');
        const cooldowns = safeJsonObj(cooldownPath);
        let cleaned = false;
        for (const key of Object.keys(cooldowns)) {
          if (key.includes(id)) { delete cooldowns[key]; cleaned = true; }
        }
        if (cleaned) safeWrite(cooldownPath, cooldowns);
      } catch (e) { console.error('cooldown cleanup:', e.message); }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, id, dispatchRemoved });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleWorkItemsArchive(req, res) {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          wiPath = shared.projectWorkItemsPath(proj);
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      let archivedItem = null;
      mutateJsonFileLocked(wiPath, (items) => {
        if (!Array.isArray(items)) items = [];
        const idx = items.findIndex(i => i.id === id);
        if (idx === -1) return items;
        archivedItem = items.splice(idx, 1)[0];
        archivedItem.archivedAt = new Date().toISOString();
        return items;
      });
      if (!archivedItem) return jsonReply(res, 404, { error: 'item not found' });

      // Append to archive file (outside lock)
      const archivePath = wiPath.replace('.json', '-archive.json');
      mutateJsonFileLocked(archivePath, (archive) => {
        if (!Array.isArray(archive)) archive = [];
        archive.push(archivedItem);
        return archive;
      }, { defaultValue: [] });

      // Clean dispatch entries for archived item
      const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
      cleanDispatchEntries(d =>
        d.meta?.dispatchKey === sourcePrefix + id ||
        d.meta?.item?.id === id
      );

      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleWorkItemsArchiveList(req, res) {
    try {
      let allArchived = [];
      // Central archive
      const centralPath = path.join(MINIONS_DIR, 'work-items-archive.json');
      const central = safeRead(centralPath);
      if (central) { try { allArchived.push(...JSON.parse(central).map(i => ({ ...i, _source: 'central' }))); } catch {} }
      // Project archives
      for (const project of PROJECTS) {
        const archPath = shared.projectWorkItemsPath(project).replace('.json', '-archive.json');
        const content = safeRead(archPath);
        if (content) { try { allArchived.push(...JSON.parse(content).map(i => ({ ...i, _source: project.name }))); } catch {} }
      }
      return jsonReply(res, 200, allArchived);
    } catch (e) { console.error('Archive fetch error:', e.message); return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleWorkItemsCreate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      let wiPath;
      if (body.project) {
        // Write to project-specific queue
        const targetProject = PROJECTS.find(p => p.name === body.project) || (PROJECTS.length > 0 ? PROJECTS[0] : null);
        if (!targetProject) return jsonReply(res, 400, { error: 'No projects configured' });
        wiPath = shared.projectWorkItemsPath(targetProject);
      } else {
        // Write to central queue — agent decides which project
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      }
      const id = 'W-' + shared.uid();
      const item = {
        id, title: body.title, type: body.type || 'implement',
        priority: body.priority || 'medium', description: body.description || '',
        status: WI_STATUS.PENDING, created: new Date().toISOString(), createdBy: 'dashboard',
      };
      if (body.scope) item.scope = body.scope;
      if (body.agent) item.agent = body.agent;
      if (body.agents) item.agents = body.agents;
      if (body.references) item.references = body.references;
      if (body.acceptanceCriteria) item.acceptanceCriteria = body.acceptanceCriteria;
      if (body.skipPr) item.skipPr = true;
      mutateJsonFileLocked(wiPath, (items) => {
        if (!Array.isArray(items)) items = [];
        items.push(item);
        return items;
      });
      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleWorkItemsUpdate(req, res) {
    try {
      const body = await readBody(req);
      const { id, source, title, description, type, priority, agent } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          wiPath = shared.projectWorkItemsPath(proj);
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      let result = null;
      let agentChanged = false;
      mutateJsonFileLocked(wiPath, (items) => {
        if (!Array.isArray(items)) items = [];
        const item = items.find(i => i.id === id);
        if (!item) { result = { code: 404, body: { error: 'item not found' } }; return items; }
        if (item.status === WI_STATUS.DISPATCHED) { result = { code: 400, body: { error: 'Cannot edit dispatched items' } }; return items; }

        if (title !== undefined) item.title = title;
        if (description !== undefined) item.description = description;
        if (type !== undefined) item.type = type;
        if (priority !== undefined) item.priority = priority;
        if (agent !== undefined) {
          item.agent = agent || null;
          agentChanged = true;
        }
        if (body.references !== undefined) item.references = body.references;
        if (body.acceptanceCriteria !== undefined) item.acceptanceCriteria = body.acceptanceCriteria;
        item.updatedAt = new Date().toISOString();
        result = { code: 200, body: { ok: true, item } };
        return items;
      });
      if (!result) return jsonReply(res, 500, { error: 'unexpected state' });
      // Clear stale pending dispatch entries outside lock
      if (agentChanged) cleanDispatchEntries(d => d.meta?.item?.id === id);
      return jsonReply(res, result.code, result.body);
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleNotesCreate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
      fs.mkdirSync(inboxDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const author = body.author || os.userInfo().username;
      const slug = shared.slugify(body.title || 'note', 40);
      const filename = `${author}-${slug}-${today}-${shared.uid().slice(-4)}.md`;
      const content = `# ${body.title}\n\n**By:** ${author}\n**Date:** ${today}\n\n${body.what}\n${body.why ? '\n**Why:** ' + body.why + '\n' : ''}`;
      safeWrite(shared.uniquePath(path.join(inboxDir, filename)), content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlanCreate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      // Write as a work item with type 'plan' — user must explicitly execute plan-to-prd after reviewing
      const wiPath = path.join(MINIONS_DIR, 'work-items.json');
      const id = 'W-' + shared.uid();
      const item = {
        id, title: body.title, type: 'plan',
        priority: body.priority || 'high', description: body.description || '',
        status: WI_STATUS.PENDING, created: new Date().toISOString(), createdBy: 'dashboard',
        branchStrategy: body.branch_strategy || 'parallel',
      };
      if (body.project) item.project = body.project;
      if (body.agent) item.agent = body.agent;
      mutateWorkItems(wiPath, items => { items.push(item); });
      return jsonReply(res, 200, { ok: true, id, agent: body.agent || '' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePrdItemsCreate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.name || !body.name.trim()) return jsonReply(res, 400, { error: 'name is required' });

      if (!fs.existsSync(PRD_DIR)) fs.mkdirSync(PRD_DIR, { recursive: true });

      const id = body.id || ('M' + String(Date.now()).slice(-4));
      const planFile = 'manual-' + shared.uid() + '.json';
      const plan = {
        version: 'manual-' + new Date().toISOString().slice(0, 10),
        project: body.project || (PROJECTS[0]?.name || 'Unknown'),
        generated_by: 'dashboard',
        generated_at: new Date().toISOString().slice(0, 10),
        plan_summary: body.name,
        status: 'approved',
        requires_approval: false,
        branch_strategy: 'parallel',
        missing_features: [{
          id, name: body.name, description: body.description || '',
          priority: body.priority || 'medium', estimated_complexity: body.estimated_complexity || 'medium',
          status: 'missing', depends_on: [], acceptance_criteria: [],
        }],
        open_questions: [],
      };
      safeWrite(path.join(PRD_DIR, planFile), plan);
      return jsonReply(res, 200, { ok: true, id, file: planFile });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePrdItemsUpdate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      // Pre-check: verify item exists before taking the lock
      const preCheck = safeJsonObj(planPath);
      const preItem = (preCheck.missing_features || []).find(f => f.id === body.itemId);
      if (!preItem) return jsonReply(res, 404, { error: 'item not found in plan' });

      // Atomically read-modify-write under file lock
      let item;
      mutateJsonFileLocked(planPath, (plan) => {
        const target = (plan.missing_features || []).find(f => f.id === body.itemId);
        if (!target) return plan; // TOCTOU: item deleted between pre-check and lock acquisition
        if (body.name !== undefined) target.name = body.name;
        if (body.description !== undefined) target.description = body.description;
        if (body.priority !== undefined) target.priority = body.priority;
        if (body.estimated_complexity !== undefined) target.estimated_complexity = body.estimated_complexity;
        if (body.status !== undefined) target.status = body.status;
        item = target;
        return plan;
      }, { defaultValue: preCheck });

      // If item was deleted between pre-check and lock, return 404
      if (!item) return jsonReply(res, 404, { error: 'item not found in plan (deleted concurrently)' });

      // Feature 3: Sync edits to materialized work item if still pending
      let workItemSynced = false;
      const wiSyncPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiSyncPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiSyncPaths) {
        try {
          mutateWorkItems(wiPath, items => {
            const wi = items.find(w => w.sourcePlan === body.source && w.id === body.itemId);
            if (wi && wi.status === WI_STATUS.PENDING) {
              if (body.name !== undefined) wi.title = 'Implement: ' + body.name;
              if (body.description !== undefined) wi.description = body.description;
              if (body.priority !== undefined) wi.priority = body.priority;
              if (body.estimated_complexity !== undefined) {
                wi.type = body.estimated_complexity === 'large' ? 'implement:large' : 'implement';
              }
              workItemSynced = true;
            }
          });
        } catch (e) { console.error('work item sync:', e.message); }
      }

      return jsonReply(res, 200, { ok: true, item, workItemSynced });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePrdItemsRemove(req, res) {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = safeJsonObj(planPath);
      if (!plan) return jsonReply(res, 500, { error: 'failed to read plan file' });
      const idx = (plan.missing_features || []).findIndex(f => f.id === body.itemId);
      if (idx < 0) return jsonReply(res, 404, { error: 'item not found in plan' });

      plan.missing_features.splice(idx, 1);
      safeWrite(planPath, plan);

      // Also remove any materialized work item for this plan item
      let cancelled = false;
      const allWiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        allWiPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of allWiPaths) {
        try {
          mutateWorkItems(wiPath, items => {
            const filtered = items.filter(w => !(w.sourcePlan === body.source && w.id === body.itemId));
            if (filtered.length < items.length) {
              cancelled = true;
              return filtered;
            }
          });
        } catch (e) { console.error('work item cleanup:', e.message); }
      }

      // Clean dispatch entries for this item
      cleanDispatchEntries(d =>
        d.meta?.item?.sourcePlan === body.source && d.meta?.item?.id === body.itemId
      );

      return jsonReply(res, 200, { ok: true, cancelled });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleAgentsCancel(req, res) {
    try {
      const body = await readBody(req);
      const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
      const dispatch = safeJsonObj(dispatchPath);
      const active = dispatch.active || [];
      const cancelled = [];

      for (const d of active) {
        const matchAgent = body.agent && d.agent === body.agent;
        const matchTask = body.task && (d.task || '').toLowerCase().includes((body.task || '').toLowerCase());
        if (!matchAgent && !matchTask) continue;

        // Kill agent process
        const statusPath = path.join(MINIONS_DIR, 'agents', d.agent, 'status.json');
        try {
          const status = safeJsonObj(statusPath);
          if (status.pid) {
            try {
              const safePid = shared.validatePid(status.pid);
              if (process.platform === 'win32') {
                require('child_process').execFileSync('taskkill', ['/PID', String(safePid), '/F', '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
              } else {
                process.kill(safePid, 'SIGTERM');
              }
            } catch { /* process may be dead or invalid PID */ }
          }
          status.status = 'idle';
          delete status.currentTask;
          delete status.dispatched;
          safeWrite(statusPath, status);
        } catch (e) { console.error('agent cancel:', e.message); }

        cancelled.push({ agent: d.agent, task: d.task });
      }

      // Remove cancelled from active dispatch
      if (cancelled.length > 0) {
        const cancelledIds = new Set(cancelled.map(c => c.agent));
        mutateJsonFileLocked(dispatchPath, (dp) => {
          dp.active = Array.isArray(dp.active) ? dp.active : [];
          dp.active = dp.active.filter(d => !cancelledIds.has(d.agent));
          return dp;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      }

      return jsonReply(res, 200, { ok: true, cancelled });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleAgentLiveStream(req, res, match) {
    const agentId = match[1];
    const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
    const liveLogPath = path.join(agentDir, 'live-output.log');
    let _cleanedUp = false;

    // Safe res.write wrapper — guards against writes after cleanup and EPIPE/ERR_STREAM_DESTROYED
    const safeWrite = (data) => {
      if (_cleanedUp) return;
      try { res.write(data); } catch { /* EPIPE or ERR_STREAM_DESTROYED — client gone */ }
    };

    // Check if agent directory exists — avoid dangling watchers on nonexistent paths
    if (!fs.existsSync(agentDir)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify('Agent not found: ' + agentId)}\n\n`);
      res.write(`event: done\ndata: not-found\n\n`);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial content — tail only (last 64KB by default) to avoid memory spikes
    const params = new URL(req.url, 'http://localhost').searchParams;
    const tailBytes = Math.max(0, parseInt(params.get('tail') || '65536', 10) || 65536);
    let offset = 0;
    try {
      const stat = fs.statSync(liveLogPath);
      const fileSize = stat.size;

      // Fall back to previous session log when current is sparse (fixes #543)
      const SPARSE_THRESHOLD = 500;
      if (fileSize < SPARSE_THRESHOLD) {
        const prevPath = path.join(agentDir, 'live-output-prev.log');
        try {
          const prevStat = fs.statSync(prevPath);
          if (prevStat.size > SPARSE_THRESHOLD) {
            const prevTailBytes = Math.min(tailBytes, prevStat.size);
            const prevStart = Math.max(0, prevStat.size - prevTailBytes);
            const prevFd = fs.openSync(prevPath, 'r');
            const prevBuf = Buffer.alloc(prevStat.size - prevStart);
            fs.readSync(prevFd, prevBuf, 0, prevBuf.length, prevStart);
            fs.closeSync(prevFd);
            const prevContent = prevBuf.toString('utf8');
            if (prevContent) safeWrite(`data: ${JSON.stringify(prevContent + '\n\n--- previous session (new session starting) ---\n\n')}\n\n`);
          }
        } catch { /* prev file may not exist — that's fine */ }
      }

      if (fileSize > 0) {
        const readStart = Math.max(0, fileSize - tailBytes);
        const readLen = fileSize - readStart;
        const fd = fs.openSync(liveLogPath, 'r');
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readStart);
        fs.closeSync(fd);
        const content = buf.toString('utf8');
        if (content) safeWrite(`data: ${JSON.stringify(content)}\n\n`);
        offset = fileSize;
      }
    } catch { /* optional — file may not exist yet */ }

    // Watch for changes using fs.watchFile (cross-platform, works on Windows)
    const watcher = () => {
      if (_cleanedUp) return;
      try {
        const stat = fs.statSync(liveLogPath);
        if (stat.size > offset) {
          const fd = fs.openSync(liveLogPath, 'r');
          const buf = Buffer.alloc(stat.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = stat.size;
          const chunk = buf.toString('utf8');
          if (chunk) safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch { /* optional */ }
    };

    fs.watchFile(liveLogPath, { interval: 500 }, watcher);

    // Idempotent cleanup helper to prevent handle leaks
    const cleanup = () => {
      if (_cleanedUp) return;
      _cleanedUp = true;
      try { clearInterval(doneCheck); } catch { /* optional */ }
      try { fs.unwatchFile(liveLogPath, watcher); } catch { /* optional */ }
    };

    // Check if agent is still active (poll every 5s)
    const doneCheck = setInterval(() => {
      if (_cleanedUp) return;
      try {
        const dispatch = getDispatchQueue();
        const isActive = (dispatch.active || []).some(d => d.agent === agentId);
        if (!isActive) {
          watcher(); // flush final content
          safeWrite(`event: done\ndata: complete\n\n`);
          cleanup();
          try { res.end(); } catch { /* optional */ }
        }
      } catch (e) {
        cleanup();
        try { res.end(); } catch { /* optional */ }
      }
    }, 5000);

    // Cleanup on client disconnect
    req.on('close', cleanup);

    return;
  }

  async function handleAgentLive(req, res, match) {
    const agentId = match[1];
    const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
    const livePath = path.join(agentDir, 'live-output.log');
    const prevPath = path.join(agentDir, 'live-output-prev.log');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const params = new URL(req.url, 'http://localhost').searchParams;
    const rawTail = parseInt(params.get('tail'));
    if (params.has('tail') && isNaN(rawTail)) return jsonReply(res, 400, { error: 'tail must be a number' });
    const tailBytes = isNaN(rawTail) ? 8192 : Math.max(1, Math.min(65536, rawTail));
    // Read only the tail bytes from disk instead of entire file
    try {
      const stat = fs.statSync(livePath);
      if (stat.size === 0) { res.end('No live output. Agent may not be running.'); return; }

      // Fall back to previous session log when current is sparse (fixes #543)
      // Sparse = only header + init JSON, typically < 500 bytes
      const SPARSE_THRESHOLD = 500;
      if (stat.size < SPARSE_THRESHOLD && fs.existsSync(prevPath)) {
        try {
          const prevStat = fs.statSync(prevPath);
          if (prevStat.size > SPARSE_THRESHOLD) {
            // Prepend separator + previous session tail, then append current sparse content
            const prevTailBytes = Math.max(1, Math.min(tailBytes - stat.size - 100, prevStat.size));
            const prevStart = Math.max(0, prevStat.size - prevTailBytes);
            const prevBuf = Buffer.alloc(Math.min(prevTailBytes, prevStat.size));
            const prevFd = fs.openSync(prevPath, 'r');
            fs.readSync(prevFd, prevBuf, 0, prevBuf.length, prevStart);
            fs.closeSync(prevFd);
            const currentBuf = fs.readFileSync(livePath, 'utf8');
            res.end(prevBuf.toString('utf8') + '\n\n--- previous session (new session starting) ---\n\n' + currentBuf);
            return;
          }
        } catch { /* fall through to normal read */ }
      }

      const start = Math.max(0, stat.size - tailBytes);
      const buf = Buffer.alloc(Math.min(tailBytes, stat.size));
      const fd = fs.openSync(livePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      res.end(buf.toString('utf8'));
    } catch {
      // If live-output.log doesn't exist but prev does, serve that
      try {
        if (fs.existsSync(prevPath)) {
          const prevStat = fs.statSync(prevPath);
          if (prevStat.size > 0) {
            const start = Math.max(0, prevStat.size - tailBytes);
            const buf = Buffer.alloc(Math.min(tailBytes, prevStat.size));
            const fd = fs.openSync(prevPath, 'r');
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            res.end(buf.toString('utf8') + '\n\n--- previous session (current session output unavailable) ---\n');
            return;
          }
        }
      } catch { /* fall through */ }
      res.end('No live output. Agent may not be running.');
    }
    return;
  }

  async function handleAgentOutput(req, res, match) {
    const agentId = match[1];
    const outputPath = path.join(MINIONS_DIR, 'agents', agentId, 'output.log');
    const content = safeRead(outputPath);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'No output log found for this agent.');
    return;
  }

  async function handleNotesFull(req, res) {
    const content = safeRead(path.join(MINIONS_DIR, 'notes.md'));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'No notes file found.');
    return;
  }

  async function handleNotesSave(req, res) {
    try {
      const body = await readBody(req);
      if (body.content == null) return jsonReply(res, 400, { error: 'content required' });
      const file = body.file || 'notes.md';
      // Only allow saving notes.md (prevent arbitrary file writes)
      if (file !== 'notes.md') return jsonReply(res, 400, { error: 'only notes.md can be edited' });
      safeWrite(path.join(MINIONS_DIR, file), body.content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleKnowledgeList(req, res) {
    const entries = getKnowledgeBaseEntries();
    const result = {};
    for (const cat of shared.KB_CATEGORIES) result[cat] = [];
    for (const e of entries) {
      if (!result[e.cat]) result[e.cat] = [];
      result[e.cat].push({ file: e.file, category: e.cat, title: e.title, agent: e.agent, date: e.date, size: e.size, preview: e.preview });
    }
    const swept = safeJson(path.join(ENGINE_DIR, 'kb-swept.json'));
    if (swept) result.lastSwept = swept.timestamp;
    return jsonReply(res, 200, result);
  }

  async function handleKnowledgeRead(req, res, match) {
    const cat = match[1];
    const file = decodeURIComponent(match[2]);
    // Prevent path traversal
    const kbCatDir = path.join(MINIONS_DIR, 'knowledge', cat);
    try { shared.sanitizePath(file, kbCatDir); } catch { return jsonReply(res, 400, { error: 'invalid file name' }); }
    const content = safeRead(path.join(kbCatDir, file));
    if (content === null) return jsonReply(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  async function handleKnowledgeSweep(req, res) {
    // Auto-release stale guard after 5 min (LLM may have hung)
    if (global._kbSweepInFlight && global._kbSweepStartedAt && Date.now() - global._kbSweepStartedAt > 300000) {
      console.log('[kb-sweep] Auto-releasing stale guard (>5min)');
      global._kbSweepInFlight = false;
    }
    if (global._kbSweepInFlight) return jsonReply(res, 409, { error: 'sweep already in progress' });
    global._kbSweepInFlight = true;
    global._kbSweepStartedAt = Date.now();
    try {
      const body = await readBody(req).catch(() => ({}));
      const entries = getKnowledgeBaseEntries();
      if (entries.length < 2) return jsonReply(res, 200, { ok: true, summary: 'nothing to sweep (< 2 entries)' });

      // Build a manifest of all KB entries with their content (skip pinned — user wants to keep them)
      const pinnedKeys = new Set(body.pinnedKeys || []);
      const manifest = [];
      for (const e of entries) {
        if (pinnedKeys.has('knowledge/' + e.cat + '/' + e.file)) continue;
        const content = safeRead(path.join(MINIONS_DIR, 'knowledge', e.cat, e.file));
        if (!content) continue;
        manifest.push({ category: e.cat, file: e.file, title: e.title, agent: e.agent, date: e.date, content: content.slice(0, 3000) });
      }

      const { callLLM, trackEngineUsage } = require('./engine/llm');
      const BATCH_SIZE = 30; // ~30 entries per batch to stay within Haiku context
      const batches = [];
      for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
        batches.push(manifest.slice(i, i + BATCH_SIZE));
      }

      const plan = { duplicates: [], reclassify: [], remove: [] };
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const offset = b * BATCH_SIZE;
        const prompt = `You are a knowledge base curator. Analyze these ${batch.length} entries (batch ${b + 1}/${batches.length}, indices ${offset}-${offset + batch.length - 1}) and produce a cleanup plan.

## Entries

${batch.map((m, i) => `[${offset + i}] ${m.category}/${m.file} | ${m.title} | ${m.date} | ${m.agent || '?'} | ${(m.content || '').slice(0, 200).replace(/\n/g, ' ')}`).join('\n')}

## Instructions

1. **Find duplicates**: entries with substantially the same content (same findings, different agents/runs). List pairs by index. Prefer keeping the more recent entry.
2. **Find misclassified**: entries in the wrong category.
3. **Find stale/empty**: entries with no actionable content (boilerplate, bail-out notes, "no changes needed").

Respond with ONLY valid JSON: { "duplicates": [{ "keep": N, "remove": [N], "reason": "..." }], "reclassify": [{ "index": N, "from": "cat", "to": "cat", "reason": "..." }], "remove": [{ "index": N, "reason": "..." }] }
If nothing to do: { "duplicates": [], "reclassify": [], "remove": [] }`;

        const result = await callLLM(prompt, 'Output only JSON.', {
          timeout: 120000, label: 'kb-sweep', model: 'haiku', maxTurns: 1, direct: true
        });
        trackEngineUsage('kb-sweep', result.usage);

        let batchPlan;
        try {
          let jsonStr = (result.text || '').trim();
          const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) jsonStr = fenceMatch[1].trim();
          batchPlan = JSON.parse(jsonStr);
        } catch {
          console.log(`[kb-sweep] batch ${b + 1}/${batches.length} returned invalid JSON, skipping`);
          continue;
        }
        if (batchPlan.duplicates) plan.duplicates.push(...batchPlan.duplicates);
        if (batchPlan.reclassify) plan.reclassify.push(...batchPlan.reclassify);
        if (batchPlan.remove) plan.remove.push(...batchPlan.remove);
      }

      let removed = 0, reclassified = 0, merged = 0;
      const kbDir = path.join(MINIONS_DIR, 'knowledge');

      // If nothing to do, return early
      const totalActions = (plan.remove || []).length + (plan.duplicates || []).reduce((n, d) => n + (d.remove || []).length, 0) + (plan.reclassify || []).length;
      if (totalActions === 0) {
        return jsonReply(res, 200, { ok: true, summary: 'KB is clean — nothing to sweep', plan });
      }

      // Archive dir for swept files (never delete, always preserve)
      const kbArchiveDir = path.join(kbDir, '_swept');
      if (!fs.existsSync(kbArchiveDir)) fs.mkdirSync(kbArchiveDir, { recursive: true });

      function archiveKbFile(filePath, reason) {
        if (!fs.existsSync(filePath)) return;
        const basename = path.basename(filePath);
        const destPath = shared.uniquePath(path.join(kbArchiveDir, basename));
        try {
          const content = safeRead(filePath);
          if (content === null) return; // don't delete if we can't read
          const meta = `<!-- swept: ${new Date().toISOString()} | reason: ${reason} -->\n`;
          safeWrite(destPath, meta + content);
          safeUnlink(filePath);
        } catch (e) { console.error('kb archive:', e.message); }
      }

      // Process removals (stale/empty) — archive, not delete
      for (const r of (plan.remove || [])) {
        const entry = manifest[r.index];
        if (!entry) continue;
        const fp = path.join(kbDir, entry.category, entry.file);
        archiveKbFile(fp, 'stale: ' + (r.reason || ''));
        removed++;
      }

      // Process duplicates — archive the duplicates, keep the primary
      for (const d of (plan.duplicates || [])) {
        for (const idx of (d.remove || [])) {
          const entry = manifest[idx];
          if (!entry) continue;
          const fp = path.join(kbDir, entry.category, entry.file);
          archiveKbFile(fp, 'duplicate of index ' + d.keep + ': ' + (d.reason || ''));
          merged++;
        }
      }

      // Process reclassifications (move between categories)
      for (const r of (plan.reclassify || [])) {
        const entry = manifest[r.index];
        if (!entry || !shared.KB_CATEGORIES.includes(r.to)) continue;
        const srcPath = path.join(kbDir, entry.category, entry.file);
        const destDir = path.join(kbDir, r.to);
        if (!fs.existsSync(srcPath)) continue;
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        try {
          const content = safeRead(srcPath);
          const updated = content.replace(/^(category:\s*).+$/m, `$1${r.to}`);
          safeWrite(path.join(destDir, entry.file), updated);
          safeUnlink(srcPath);
          reclassified++;
        } catch (e) { console.error('kb reclassify:', e.message); }
      }

      // Prune swept files older than 30 days
      let pruned = 0;
      const SWEPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
      try {
        for (const f of fs.readdirSync(kbArchiveDir)) {
          const fp = path.join(kbArchiveDir, f);
          try {
            if (Date.now() - fs.statSync(fp).mtimeMs > SWEPT_RETENTION_MS) { safeUnlink(fp); pruned++; }
          } catch { /* cleanup */ }
        }
      } catch { /* optional */ }

      const summary = `${merged} duplicates merged, ${removed} stale removed, ${reclassified} reclassified${pruned ? ', ' + pruned + ' old swept files pruned' : ''}`;
      safeWrite(path.join(ENGINE_DIR, 'kb-swept.json'), JSON.stringify({ timestamp: new Date().toISOString(), summary }));
      return jsonReply(res, 200, { ok: true, summary, plan });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); } finally { global._kbSweepInFlight = false; }
  }

  async function handlePlansList(req, res) {
    const dirs = [
      { dir: PLANS_DIR, archived: false },
      { dir: path.join(PLANS_DIR, 'archive'), archived: true },
      { dir: PRD_DIR, archived: false },
      { dir: path.join(PRD_DIR, 'archive'), archived: true },
    ];
    // Load work items to check for completed plan-to-prd conversions
    const centralWi = safeJsonArr(path.join(MINIONS_DIR, 'work-items.json'));
    const completedPrdFiles = new Set(
      centralWi.filter(w => w.type === 'plan-to-prd' && DONE_STATUSES.has(w.status) && w.planFile)
        .map(w => w.planFile)
    );
    const plans = [];
    for (const { dir, archived } of dirs) {
      const allFiles = safeReadDir(dir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const f of allFiles) {
        const filePath = path.join(dir, f);
        const content = safeRead(filePath) || '';
        let updatedAt = '';
        try { updatedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString(); } catch { /* optional */ }
        const isJson = f.endsWith('.json');
        if (isJson) {
          try {
            const plan = JSON.parse(content);
            const status = plan.status || 'active';
            plans.push({
              file: f, format: 'prd', archived,
              project: plan.project || '',
              summary: plan.plan_summary || '',
              status,
              branchStrategy: plan.branch_strategy || 'parallel',
              featureBranch: plan.feature_branch || '',
              itemCount: (plan.missing_features || []).length,
              generatedBy: plan.generated_by || '',
              generatedAt: plan.generated_at || '',
              completedAt: plan.completedAt || '',
              updatedAt,
              requiresApproval: plan.requires_approval || false,
              revisionFeedback: plan.revision_feedback || null,
              sourcePlan: plan.source_plan || null,
              archiveReady: plan._archiveReady || false,
              archiveReadyAt: plan._archiveReadyAt || null,
            });
          } catch { /* JSON parse fallback */ }
        } else {
          const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)/m);
          const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/m);
          const authorMatch = content.match(/\*\*Author:\*\*\s*(.+)/m);
          const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/m);
          const versionMatch = f.match(/-v(\d+)/);
          plans.push({
            file: f, format: 'draft', archived,
            project: projectMatch ? projectMatch[1].trim() : '',
            summary: titleMatch ? titleMatch[1].trim() : f.replace('.md', ''),
            status: archived ? 'completed' : completedPrdFiles.has(f) ? 'converted' : 'draft',
            branchStrategy: '',
            featureBranch: '',
            itemCount: (content.match(/^\d+\.\s+\*\*/gm) || []).length,
            generatedBy: authorMatch ? authorMatch[1].trim() : '',
            generatedAt: dateMatch ? dateMatch[1].trim() : '',
            updatedAt,
            requiresApproval: false,
            revisionFeedback: null,
            version: versionMatch ? parseInt(versionMatch[1]) : null,
          });
        }
      }
    }
    plans.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    return jsonReply(res, 200, plans);
  }

  async function handlePlansUnarchive(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const file = body.file;
      if (file.includes('..') || file.includes('\0') || file.includes('/') || file.includes('\\')) return jsonReply(res, 400, { error: 'invalid' });

      const isJson = file.endsWith('.json');
      const targetDir = isJson ? PRD_DIR : PLANS_DIR;
      const archiveDir = path.join(targetDir, 'archive');
      const archivePath = path.join(archiveDir, file);

      if (!fs.existsSync(archivePath)) return jsonReply(res, 404, { error: 'File not found in archive' });
      fs.renameSync(archivePath, path.join(targetDir, file));

      // If unarchiving a PRD .json, also unarchive its source .md plan
      let unarchivedSource = null;
      if (isJson) {
        try {
          const prd = safeJson(path.join(targetDir, file));
          if (prd?.source_plan) {
            const mdArchivePath = path.join(PLANS_DIR, 'archive', prd.source_plan);
            if (fs.existsSync(mdArchivePath)) {
              fs.renameSync(mdArchivePath, path.join(PLANS_DIR, prd.source_plan));
              unarchivedSource = prd.source_plan;
            }
          }
        } catch { /* optional */ }
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, unarchivedSource });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansArchiveRead(req, res, match) {
    const file = decodeURIComponent(match[1]);
    if (file.includes('..') || file.includes('\0')) return jsonReply(res, 400, { error: 'invalid' });
    // Check prd/archive/ first for .json, then plans/archive/ for .md
    const archiveDir = file.endsWith('.json') ? path.join(PRD_DIR, 'archive') : path.join(PLANS_DIR, 'archive');
    let content = safeRead(path.join(archiveDir, file));
    // Fallback: check the other archive dir
    if (!content) content = safeRead(path.join(file.endsWith('.json') ? path.join(PLANS_DIR, 'archive') : path.join(PRD_DIR, 'archive'), file));
    if (!content) return jsonReply(res, 404, { error: 'not found' });
    const contentType = file.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType + '; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  async function handlePlansRead(req, res, match) {
    const file = decodeURIComponent(match[1]);
    if (file.includes('..') || file.includes('\0') || file.includes('/') || file.includes('\\')) return jsonReply(res, 400, { error: 'invalid' });
    let content = safeRead(resolvePlanPath(file));
    // Fallback: check all directories (prd/, plans/, guides/, archives)
    if (!content) content = safeRead(path.join(PRD_DIR, file));
    if (!content) content = safeRead(path.join(PRD_DIR, 'guides', file));
    if (!content) content = safeRead(path.join(PLANS_DIR, file));
    if (!content) content = safeRead(path.join(PRD_DIR, 'archive', file));
    if (!content) content = safeRead(path.join(PLANS_DIR, 'archive', file));
    if (!content) return jsonReply(res, 404, { error: 'not found' });
    // Find the actual file path for Last-Modified header + expose resolved relative path
    const planCandidates = [resolvePlanPath(file), path.join(PRD_DIR, file), path.join(PRD_DIR, 'guides', file), path.join(PLANS_DIR, file), path.join(PRD_DIR, 'archive', file), path.join(PLANS_DIR, 'archive', file)];
    for (const p of planCandidates) { try { const st = fs.statSync(p); if (st) { res.setHeader('Last-Modified', st.mtime.toISOString()); res.setHeader('X-Resolved-Path', path.relative(MINIONS_DIR, p).replace(/\\/g, '/')); break; } } catch { /* optional */ } }
    const contentType = file.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType + '; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  async function handlePlansApprove(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = safeJsonObj(planPath);
      plan.status = 'approved';
      plan.approvedAt = new Date().toISOString();
      plan.approvedBy = body.approvedBy || os.userInfo().username;
      delete plan.pausedAt;
      safeWrite(planPath, plan);

      // Resume paused work items across all projects
      let resumed = 0;
      const resumedItemIds = [];
      const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiPaths) {
        try {
          mutateJsonFileLocked(wiPath, (items) => {
            if (!Array.isArray(items)) return items;
            for (const w of items) {
              if (w.sourcePlan === body.file && w.status === WI_STATUS.PAUSED && w._pausedBy === 'prd-pause') {
                w.status = WI_STATUS.PENDING;
                delete w._pausedBy;
                w._resumedAt = new Date().toISOString();
                resumedItemIds.push(w.id);
                resumed++;
              }
            }
            return items;
          }, { defaultValue: [] });
        } catch (e) { console.error('resume work items:', e.message); }
      }

      // Clear dispatch completed entries for resumed items so they aren't dedup-blocked
      if (resumedItemIds.length > 0) {
        const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
        const resumedSet = new Set(resumedItemIds);
        mutateJsonFileLocked(dispatchPath, (dispatch) => {
          dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
          dispatch.completed = dispatch.completed.filter(d => !resumedSet.has(d.meta?.item?.id));
          return dispatch;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, status: 'approved', resumedWorkItems: resumed });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansPause(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = safeJsonObj(planPath);
      plan.status = 'paused';
      plan.pausedAt = new Date().toISOString();
      safeWrite(planPath, plan);

      // Propagate pause to materialized work items across all projects:
      // kill any active agent process and reset non-completed items back to pending.
      let reset = 0;
      const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
      }
      const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
      const killedAgents = new Set();
      const resetItemIds = new Set();

      // Read dispatch inside the lock so PID list is consistent with state being modified
      mutateJsonFileLocked(dispatchPath, (dispatch) => {
        for (const wiPath of wiPaths) {
          try {
            mutateWorkItems(wiPath, items => {
              let changed = false;
              for (const w of items) {
                if (w.sourcePlan !== body.file) continue;
                // Keep completed items as-is, reset everything else to pending.
                if (w.completedAt || DONE_STATUSES.has(w.status)) continue;

                if (w.status === WI_STATUS.DISPATCHED) {
                  // Kill the agent working on this item, if any.
                  const activeEntry = (dispatch.active || []).find(d => d.meta?.item?.id === w.id || d.meta?.dispatchKey?.includes(w.id));
                  if (activeEntry) {
                    const statusPath = path.join(MINIONS_DIR, 'agents', activeEntry.agent, 'status.json');
                    try {
                      const agentStatus = safeJsonObj(statusPath);
                      if (agentStatus.pid) {
                        try {
                          const safePid = shared.validatePid(agentStatus.pid);
                          if (process.platform === 'win32') {
                            require('child_process').execFileSync('taskkill', ['/PID', String(safePid), '/F', '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
                          } else {
                            process.kill(safePid, 'SIGTERM');
                          }
                        } catch { /* process may be dead or invalid PID */ }
                      }
                      agentStatus.status = 'idle';
                      delete agentStatus.currentTask;
                      delete agentStatus.dispatched;
                      safeWrite(statusPath, agentStatus);
                    } catch (e) { console.error('agent reset:', e.message); }
                    killedAgents.add(activeEntry.agent);
                  }
                }

                if (w.status !== WI_STATUS.PAUSED) reset++;
                w.status = WI_STATUS.PAUSED;
                w._pausedBy = 'prd-pause';
                delete w._resumedAt;
                delete w.dispatched_at;
                delete w.dispatched_to;
                delete w.failReason;
                delete w.failedAt;
                changed = true;
                if (w.id) resetItemIds.add(w.id);
              }
            });
          } catch (e) { console.error('reset work items:', e.message); }
        }

        // Remove dispatch active entries for reset items or killed agents.
        dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
        dispatch.active = dispatch.active.filter(d => {
          const itemId = d.meta?.item?.id;
          if (itemId && resetItemIds.has(itemId)) return false;
          if (killedAgents.has(d.agent)) return false;
          return true;
        });
        return dispatch;
      }, { defaultValue: { pending: [], active: [], completed: [] } });

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, status: 'paused', resetWorkItems: reset });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePrdRegenerate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file is required' });
      shared.sanitizePath(body.file, PRD_DIR);

      const prdPath = path.join(PRD_DIR, body.file);
      const plan = safeJson(prdPath);
      if (!plan) return jsonReply(res, 404, { error: 'PRD file not found' });
      if (!plan.source_plan) return jsonReply(res, 400, { error: 'PRD has no source_plan — cannot regenerate' });

      const sourcePlanPath = path.join(PLANS_DIR, plan.source_plan);
      if (!fs.existsSync(sourcePlanPath)) return jsonReply(res, 400, { error: `Source plan not found: ${plan.source_plan}` });

      // Collect completed item IDs from the old PRD to carry over
      const completedStatuses = new Set(['done', 'in-pr', 'implemented']); // in-pr kept for backward compat
      const completedItems = (plan.missing_features || [])
        .filter(f => completedStatuses.has(f.status))
        .map(f => ({ id: f.id, name: f.name, status: f.status }));

      // Clean pending/failed work items from old PRD (keep done items)
      const { getProjects, projectWorkItemsPath } = shared;
      const config = queries.getConfig();
      for (const p of getProjects(config)) {
        const projWiPath = projectWorkItemsPath(p);
        try {
          mutateWorkItems(projWiPath, items => {
            const filtered = items.filter(w => {
              if (w.sourcePlan !== body.file) return true; // different plan, keep
              return completedStatuses.has(w.status); // keep completed, remove pending/failed
            });
            if (filtered.length < items.length) return filtered;
          });
        } catch { /* project may not have work items */ }
      }

      // Delete old PRD — agent will write replacement at same path
      try { fs.unlinkSync(prdPath); } catch { /* cleanup */ }

      // Queue plan-to-prd regeneration with instructions to preserve completed items
      const wiPath = path.join(MINIONS_DIR, 'work-items.json');

      const completedContext = completedItems.length > 0
        ? `\n\n**Previously completed items (preserve their status in the new PRD):**\n${completedItems.map(i => `- ${i.id}: ${i.name} [${i.status}]`).join('\n')}`
        : '';

      const id = 'W-' + shared.uid();
      let alreadyQueuedId = null;
      mutateWorkItems(wiPath, items => {
        // Dedup: check if already queued
        const alreadyQueued = items.find(w =>
          w.type === 'plan-to-prd' && w.planFile === plan.source_plan && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.DISPATCHED)
        );
        if (alreadyQueued) { alreadyQueuedId = alreadyQueued.id; return; }
        items.push({
          id, title: `Regenerate PRD: ${plan.plan_summary || plan.source_plan}`,
          type: 'plan-to-prd', priority: 'high',
          description: `Plan file: plans/${plan.source_plan}\nTarget PRD filename: ${body.file}\nRegeneration requested by user after plan revision.${completedContext}`,
          status: WI_STATUS.PENDING, created: new Date().toISOString(), createdBy: 'dashboard:regenerate',
          project: plan.project || '', planFile: plan.source_plan,
          _targetPrdFile: body.file,
        });
      });
      if (alreadyQueuedId) return jsonReply(res, 200, { id: alreadyQueuedId, alreadyQueued: true });
      return jsonReply(res, 200, { id, file: plan.source_plan });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handlePlansExecute(req, res) {
    if (checkRateLimit('plans-execute', 5)) return jsonReply(res, 429, { error: 'Rate limited — max 5 requests/minute' });
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      if (!body.file.endsWith('.md')) return jsonReply(res, 400, { error: 'only .md plans can be executed' });
      shared.sanitizePath(body.file, PLANS_DIR);
      const planPath = path.join(MINIONS_DIR, 'plans', body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });

      // Atomic check-and-insert to prevent duplicates and races with engine
      const centralPath = path.join(MINIONS_DIR, 'work-items.json');
      let existingId = null;
      const id = 'W-' + shared.uid();
      mutateJsonFileLocked(centralPath, (items) => {
        if (!Array.isArray(items)) items = [];
        // Only block if actively pending/dispatched — allow re-execute after completion
        const existing = items.find(w => w.type === 'plan-to-prd' && w.planFile === body.file && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.DISPATCHED));
        if (existing) { existingId = existing.id; return items; }
        items.push({
          id, title: 'Convert plan to PRD: ' + body.file.replace('.md', ''),
          type: 'plan-to-prd', priority: 'high',
          description: 'Plan file: plans/' + body.file,
          status: WI_STATUS.PENDING, created: new Date().toISOString(),
          createdBy: 'dashboard:execute', project: body.project || '',
          planFile: body.file,
        });
        return items;
      }, { defaultValue: [] });
      if (existingId) return jsonReply(res, 200, { ok: true, id: existingId, alreadyQueued: true });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansReject(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = safeJsonObj(planPath);
      plan.status = 'rejected';
      plan.rejectedAt = new Date().toISOString();
      plan.rejectedBy = body.rejectedBy || os.userInfo().username;
      if (body.reason) plan.rejectionReason = body.reason;
      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, status: 'rejected' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansRegenerate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.source) return jsonReply(res, 400, { error: 'source required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = safeJsonObj(planPath);
      const planItems = plan.missing_features || [];

      let reset = 0, kept = 0, newCount = 0;
      const deletedItemIds = [];

      // Scan all work item sources for materialized items from this plan
      const wiPaths = [{ path: path.join(MINIONS_DIR, 'work-items.json'), label: 'central' }];
      for (const proj of PROJECTS) {
        wiPaths.push({ path: shared.projectWorkItemsPath(proj), label: proj.name });
      }

      // Track which plan items have materialized work items
      const materializedPlanItemIds = new Set();

      for (const wiInfo of wiPaths) {
        try {
          mutateWorkItems(wiInfo.path, items => {
            const filtered = [];
            for (const w of items) {
              if (w.sourcePlan === body.source) {
                materializedPlanItemIds.add(w.id);
                if (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.FAILED) {
                  // Delete — will re-materialize on next tick with updated plan data
                  reset++;
                  deletedItemIds.push(w.id);
                } else {
                  // dispatched or done — leave alone
                  kept++;
                  filtered.push(w);
                }
              } else {
                filtered.push(w);
              }
            }
            if (filtered.length < items.length) return filtered;
          });
        } catch (e) { console.error('work item sync:', e.message); }
      }

      // Count plan items that have no work item yet (will auto-materialize)
      for (const pi of planItems) {
        if (!materializedPlanItemIds.has(pi.id)) newCount++;
      }

      // Clean dispatch entries for deleted items
      for (const itemId of deletedItemIds) {
        cleanDispatchEntries(d =>
          d.meta?.item?.sourcePlan === body.source && d.meta?.item?.id === itemId
        );
      }

      return jsonReply(res, 200, { ok: true, reset, kept, new: newCount });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansDelete(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      shared.sanitizePath(body.file, body.file.endsWith('.json') ? PRD_DIR : PLANS_DIR);
      const planPath = resolvePlanPath(body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan not found' });
      // Read plan content before deleting — needed for worktree cleanup and source_plan
      let planObj = null;
      let prdSourcePlan = null;
      if (body.file.endsWith('.json')) {
        try { planObj = safeJsonObj(planPath); prdSourcePlan = planObj?.source_plan || null; } catch {}
      }
      // Clean up worktrees before deleting work items (needs branch info from work items)
      try {
        const { cleanupPlanWorktrees } = require('./engine/lifecycle');
        cleanupPlanWorktrees(body.file, planObj || {}, PROJECTS, getConfig());
      } catch (e) { console.error('plan worktree cleanup:', e.message); }
      safeUnlink(planPath);

      // Clean up materialized work items from all projects + central
      let cleaned = 0;
      const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiPaths) {
        try {
          mutateWorkItems(wiPath, items => {
            const filtered = items.filter(w => w.sourcePlan !== body.file);
            if (filtered.length < items.length) {
              cleaned += items.length - filtered.length;
              return filtered;
            }
          });
        } catch (e) { console.error('plan cleanup:', e.message); }
      }

      // Clean up dispatch entries for this plan's items
      const dispatchCleaned = cleanDispatchEntries(d =>
        d.meta?.item?.sourcePlan === body.file ||
        d.meta?.planFile === body.file ||
        (d.task && d.task.includes(body.file))
      );

      // If deleting a PRD .json, reset the plan-to-prd work item so the source .md reverts to draft
      if (prdSourcePlan) {
        try {
          const centralPath = path.join(MINIONS_DIR, 'work-items.json');
          mutateWorkItems(centralPath, items => {
            for (const w of items) {
              if (w.type === 'plan-to-prd' && DONE_STATUSES.has(w.status) && w.planFile === prdSourcePlan) {
                w.status = WI_STATUS.CANCELLED;
                w._cancelledBy = 'prd-deleted';
              }
            }
          });
        } catch (e) { console.error('plan-to-prd cleanup:', e.message); }
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, cleanedWorkItems: cleaned, cleanedDispatches: dispatchCleaned });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansArchive(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      shared.sanitizePath(body.file, body.file.endsWith('.json') ? PRD_DIR : PLANS_DIR);
      const planPath = resolvePlanPath(body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan not found' });

      // Move to archive directory
      const archiveDir = body.file.endsWith('.json') ? path.join(PRD_DIR, 'archive') : path.join(PLANS_DIR, 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, body.file);
      fs.renameSync(planPath, archivePath);

      // Mark archived in JSON if PRD
      let archivedSource = null;
      if (body.file.endsWith('.json')) {
        try {
          const prd = safeJsonObj(archivePath);
          prd.status = 'archived';
          prd.archivedAt = new Date().toISOString();
          safeWrite(archivePath, prd);
          // Also archive linked source plan
          if (prd.source_plan) {
            const mdPath = path.join(PLANS_DIR, prd.source_plan);
            if (fs.existsSync(mdPath)) {
              const planArchive = path.join(PLANS_DIR, 'archive');
              if (!fs.existsSync(planArchive)) fs.mkdirSync(planArchive, { recursive: true });
              fs.renameSync(mdPath, path.join(planArchive, prd.source_plan));
              archivedSource = prd.source_plan;
            }
          }
        } catch { /* optional */ }
      }

      // Clean up worktrees associated with this plan
      try {
        const plan = body.file.endsWith('.json') ? (safeJsonObj(archivePath) || {}) : {};
        const { cleanupPlanWorktrees } = require('./engine/lifecycle');
        cleanupPlanWorktrees(body.file, plan, PROJECTS, getConfig());
      } catch (e) { console.error('plan worktree cleanup:', e.message); }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, archived: body.file, archivedSource });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansUnarchive(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      try { shared.sanitizePath(body.file, body.file.endsWith('.json') ? PRD_DIR : PLANS_DIR); }
      catch { return jsonReply(res, 400, { error: 'invalid filename' }); }
      const isJson = body.file.endsWith('.json');
      const targetDir = isJson ? PRD_DIR : PLANS_DIR;
      const archivePath = path.join(targetDir, 'archive', body.file);
      if (!fs.existsSync(archivePath)) return jsonReply(res, 404, { error: 'File not found in archive' });
      fs.renameSync(archivePath, path.join(targetDir, body.file));

      // Also unarchive linked source plan
      let unarchivedSource = null;
      if (isJson) {
        try {
          const prd = safeJson(path.join(targetDir, body.file));
          if (prd?.source_plan) {
            const mdArchivePath = path.join(PLANS_DIR, 'archive', prd.source_plan);
            if (fs.existsSync(mdArchivePath)) {
              fs.renameSync(mdArchivePath, path.join(PLANS_DIR, prd.source_plan));
              unarchivedSource = prd.source_plan;
            }
          }
        } catch { /* optional */ }
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, unarchivedSource });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePlansRevise(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file || !body.feedback) return jsonReply(res, 400, { error: 'file and feedback required' });
      const planPath = resolvePlanPath(body.file);
      const plan = safeJsonObj(planPath);
      plan.status = 'revision-requested';
      plan.revision_feedback = body.feedback;
      plan.revisionRequestedAt = new Date().toISOString();
      plan.revisionRequestedBy = body.requestedBy || os.userInfo().username;
      safeWrite(planPath, plan);

      // Create a work item to revise the plan
      const wiPath = path.join(MINIONS_DIR, 'work-items.json');
      const id = 'W-' + shared.uid();
      mutateWorkItems(wiPath, items => {
        items.push({
          id, title: 'Revise plan: ' + (plan.plan_summary || body.file),
          type: 'plan-to-prd', priority: 'high',
          description: 'Revision requested on plan file: ' + (body.file.endsWith('.json') ? 'prd/' : 'plans/') + body.file + '\n\nFeedback:\n' + body.feedback + '\n\nRevise the plan to address this feedback. Read the existing plan, apply the feedback, and overwrite the file with the updated version. Set status back to "awaiting-approval".',
          status: WI_STATUS.PENDING, created: new Date().toISOString(), createdBy: 'dashboard:revision',
          project: plan.project || '',
          planFile: body.file,
        });
      });
      return jsonReply(res, 200, { ok: true, status: 'revision-requested', workItemId: id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/revise-and-regenerate — REMOVED: plan versioning now handled by /api/doc-chat
  // The "Replace old PRD" flow uses qaReplacePrd (frontend) which calls /api/plans/pause + /api/plans/regenerate + planExecute
  async function handlePlansReviseAndRegenerate(req, res) {
    try {
      const body = await readBody(req);
      if (!body.source || !body.instruction) return jsonReply(res, 400, { error: 'source and instruction required' });

      // Find the source plan .md file for this PRD
      // Convention: PRD JSON references plan via plan_summary containing the work item ID,
      // or the .md file has a matching name prefix
      const prdPath = path.join(PRD_DIR, body.source);
      if (!fs.existsSync(prdPath)) return jsonReply(res, 404, { error: 'PRD file not found' });

      // Look for corresponding .md plan file
      let sourcePlanFile = null;
      const planFiles = safeReadDir(PLANS_DIR).filter(f => f.endsWith('.md'));
      if (body.sourcePlan) {
        // Explicit source plan provided
        sourcePlanFile = body.sourcePlan;
      } else {
        // Heuristic: find .md plan by matching prefix or by reading PRD's generated_from field
        const prd = safeJsonObj(prdPath);
        if (prd.source_plan) {
          sourcePlanFile = prd.source_plan;
        } else {
          // Match by prefix: officeagent-2026-03-15.json → plan-*officeagent* or plan-w025*.md
          const prdBase = body.source.replace('.json', '');
          for (const f of planFiles) {
            // Check if plan file mentions the same project or was created around same time
            const content = safeRead(path.join(PLANS_DIR, f)) || '';
            if (content.includes(prd.project || '___nomatch___') || content.includes(prd.plan_summary?.slice(0, 40) || '___nomatch___')) {
              sourcePlanFile = f;
              break;
            }
          }
          // Last resort: most recent .md plan
          if (!sourcePlanFile && planFiles.length > 0) {
            sourcePlanFile = planFiles.sort((a, b) => {
              try { return fs.statSync(path.join(PLANS_DIR, b)).mtimeMs - fs.statSync(path.join(PLANS_DIR, a)).mtimeMs; } catch { return 0; }
            })[0];
          }
        }
      }

      if (!sourcePlanFile) {
        return jsonReply(res, 404, { error: 'No source plan (.md) found for this PRD. You can edit the PRD JSON directly using "Edit Plan".' });
      }

      const sourcePlanPath = path.join(PLANS_DIR, sourcePlanFile);
      const planContent = safeRead(sourcePlanPath);
      if (!planContent) return jsonReply(res, 404, { error: 'Source plan file not readable: ' + sourcePlanFile });

      // Step 1: Steer the source plan with the user's instruction via CC
      const result = await ccDocCall({
        message: body.instruction,
        document: planContent,
        title: sourcePlanFile,
        filePath: 'plans/' + sourcePlanFile,
        selection: body.selection || '',
        canEdit: true,
        isJson: false,
      });

      if (!result.content) {
        return jsonReply(res, 200, { ok: true, answer: result.answer, updated: false });
      }

      // Save the revised plan
      safeWrite(sourcePlanPath, result.content);

      // Step 2: Pause the old PRD so it stops materializing items
      const prd = safeJsonObj(prdPath);
      prd.status = 'revision-requested';
      prd.revision_feedback = body.instruction;
      prd.revisionRequestedAt = new Date().toISOString();
      safeWrite(prdPath, prd);

      // Step 3: Clean up pending/failed work items from old PRD
      let reset = 0, kept = 0;
      const wiPaths = [{ path: path.join(MINIONS_DIR, 'work-items.json'), label: 'central' }];
      for (const proj of PROJECTS) {
        wiPaths.push({ path: shared.projectWorkItemsPath(proj), label: proj.name });
      }
      const deletedItemIds = [];
      for (const wiInfo of wiPaths) {
        try {
          mutateWorkItems(wiInfo.path, items => {
            const filtered = [];
            for (const w of items) {
              if (w.sourcePlan === body.source) {
                if (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.FAILED) {
                  reset++;
                  deletedItemIds.push(w.id);
                } else {
                  kept++;
                  filtered.push(w);
                }
              } else {
                filtered.push(w);
              }
            }
            if (filtered.length < items.length) return filtered;
          });
        } catch (e) { console.error('work item deletion:', e.message); }
      }
      for (const itemId of deletedItemIds) {
        cleanDispatchEntries(d =>
          d.meta?.item?.sourcePlan === body.source && d.meta?.item?.id === itemId
        );
      }

      // Step 4: Dispatch plan-to-prd to regenerate PRD from revised plan
      const centralWiPath = path.join(MINIONS_DIR, 'work-items.json');
      const wiId = 'W-' + shared.uid();
      mutateWorkItems(centralWiPath, items => {
        items.push({
          id: wiId,
          title: 'Regenerate PRD from revised plan: ' + sourcePlanFile,
          type: 'plan-to-prd',
          priority: 'high',
          description: `The source plan \`${sourcePlanFile}\` has been revised. Convert it into a fresh PRD JSON.\n\nRevision instruction: ${body.instruction}\n\nRead the revised plan, generate updated PRD items (missing_features), and write to \`prd/${body.source}\`. Set status to "approved". Include \`"source_plan": "${sourcePlanFile}"\` in the JSON root.\n\nPreserve items that are already done (status "implemented" or "complete"). Reset or replace items that were pending/failed.`,
          status: WI_STATUS.PENDING,
          created: new Date().toISOString(),
          createdBy: 'dashboard:revise-and-regenerate',
          project: prd.project || '',
          planFile: sourcePlanFile,
        });
      });

      return jsonReply(res, 200, {
        ok: true,
        answer: result.answer,
        updated: true,
        sourcePlan: sourcePlanFile,
        prdPaused: true,
        reset,
        kept,
        workItemId: wiId,
      });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handlePlansDiscuss(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const planContent = safeRead(planPath);
      if (!planContent) return jsonReply(res, 404, { error: 'plan not found' });

      const plan = JSON.parse(planContent);
      const projectName = plan.project || 'Unknown';

      // Build the session launch script
      const sessionName = 'plan-review-' + body.file.replace(/\.json$/, '');
      let sysPrompt;
      try {
        sysPrompt = fs.readFileSync(path.join(MINIONS_DIR, 'prompts', 'plan-advisor-system.md'), 'utf8')
          .replace(/\{\{plan_path\}\}/g, planPath)
          .replace(/\{\{project_name\}\}/g, projectName);
      } catch {
        sysPrompt = `You are a Plan Advisor. The plan is at ${planPath} for project ${projectName}. Help the user review and approve it.`;
      }

      const initialPrompt = `Here's the plan awaiting your review:

**${plan.plan_summary || body.file}**
Project: ${projectName}
Strategy: ${plan.branch_strategy || 'parallel'}
Branch: ${plan.feature_branch || 'per-item'}
Items: ${(plan.missing_features || []).length}

${(plan.missing_features || []).map((f, i) =>
  `${i + 1}. **${f.id}: ${f.name}** (${f.estimated_complexity}, ${f.priority})${f.depends_on?.length ? ' → depends on: ' + f.depends_on.join(', ') : ''}
   ${f.description || ''}`
).join('\n\n')}

${plan.open_questions?.length ? '\n**Open Questions:**\n' + plan.open_questions.map(q => '- ' + q).join('\n') : ''}

What would you like to discuss or change? When you're happy, say "approve" and I'll finalize it.`;

      // Write session files
      const sessionDir = path.join(MINIONS_DIR, 'engine');
      const id = shared.uid();
      const sysFile = path.join(sessionDir, `plan-discuss-sys-${id}.md`);
      const promptFile = path.join(sessionDir, `plan-discuss-prompt-${id}.md`);
      safeWrite(sysFile, sysPrompt);
      safeWrite(promptFile, initialPrompt);

      // Generate the launch command
      const cmd = `claude --system-prompt "$(cat '${sysFile.replace(/\\/g, '/')}')" --name "${sessionName}" --add-dir "${MINIONS_DIR.replace(/\\/g, '/')}" < "${promptFile.replace(/\\/g, '/')}"`;

      // Also generate a PowerShell-friendly version
      const psCmd = `Get-Content "${promptFile}" | claude --system-prompt (Get-Content "${sysFile}" -Raw) --name "${sessionName}" --add-dir "${MINIONS_DIR}"`;

      return jsonReply(res, 200, {
        ok: true,
        sessionName,
        command: cmd,
        psCommand: psCmd,
        sysFile,
        promptFile,
        planFile: body.file,
      });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleDocChat(req, res) {
    try {
      const body = await readBody(req);
      if (!body.message) return jsonReply(res, 400, { error: 'message required' });
      if (!body.document) return jsonReply(res, 400, { error: 'document required' });

      const canEdit = !!body.filePath;
      const isJson = body.filePath?.endsWith('.json');
      let currentContent = body.document;
      let fullPath = null;
      if (canEdit) {
        try { shared.sanitizePath(body.filePath, MINIONS_DIR); } catch { return jsonReply(res, 400, { error: 'path must be under minions directory' }); }
        fullPath = path.resolve(MINIONS_DIR, body.filePath);
        const diskContent = safeRead(fullPath);
        if (diskContent !== null) currentContent = diskContent;
      }

      const { answer, content, actions } = await ccDocCall({
        message: body.message, document: currentContent, title: body.title,
        filePath: body.filePath, selection: body.selection, canEdit, isJson,
        model: body.model || undefined,
      });

      if (!content) return jsonReply(res, 200, { ok: true, answer, edited: false, actions });

      if (isJson) {
        try { JSON.parse(content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(JSON invalid — not saved: ' + e.message + ')', edited: false, actions });
        }
      }
      if (canEdit && fullPath) {
        // Block writes to completed/archived meeting JSON files
        if (body.filePath && /^meetings\//.test(body.filePath) && isJson) {
          try {
            const mtg = safeJson(fullPath);
            if (mtg && (mtg.status === 'completed' || mtg.status === 'archived')) {
              return jsonReply(res, 200, { ok: true, answer, edited: false, actions });
            }
          } catch { /* proceed with write if can't read */ }
        }

        safeWrite(fullPath, content);

        // If editing a plan .md that has an active PRD, auto-pause execution
        let pausedPrd = null;
        if (body.filePath && body.filePath.startsWith('plans/') && body.filePath.endsWith('.md')) {
          const planFile = body.filePath.replace(/^plans\//, '');
          try {
            const prdDir = path.join(MINIONS_DIR, 'prd');
            if (fs.existsSync(prdDir)) {
              for (const prdFile of fs.readdirSync(prdDir)) {
                if (!prdFile.endsWith('.json')) continue;
                const prd = safeJson(path.join(prdDir, prdFile));
                if (!prd || prd.source_plan !== planFile) continue;
                if (prd.status === 'paused' || prd.status === 'rejected') continue;
                // Found an active PRD linked to this plan — pause it
                prd.status = 'paused';
                prd.pausedAt = new Date().toISOString();
                prd.pausedBy = 'plan-steering';
                safeWrite(path.join(prdDir, prdFile), prd);
                pausedPrd = prdFile;
                // Pause work items linked to this PRD (sourcePlan = PRD filename)
                const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
                for (const proj of PROJECTS) wiPaths.push(shared.projectWorkItemsPath(proj));
                const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
                const dispatch = safeJsonObj(dispatchPath);
                const killedAgents = new Set();
                const resetItemIds = new Set();
                for (const wiPath of wiPaths) {
                  try {
                    mutateJsonFileLocked(wiPath, (items) => {
                      if (!Array.isArray(items)) return items;
                      for (const w of items) {
                        if (w.sourcePlan !== prdFile) continue;
                        if (w.completedAt || DONE_STATUSES.has(w.status)) continue;
                        if (w.status === WI_STATUS.DISPATCHED) {
                          const activeEntry = (dispatch.active || []).find(d => d.meta?.item?.id === w.id || d.meta?.dispatchKey?.includes(w.id));
                          if (activeEntry) {
                            const statusPath = path.join(MINIONS_DIR, 'agents', activeEntry.agent, 'status.json');
                            try {
                              const agentStatus = safeJsonObj(statusPath);
                              if (agentStatus.pid) {
                                try {
                                  const safePid = shared.validatePid(agentStatus.pid);
                                  if (process.platform === 'win32') {
                                    require('child_process').execFileSync('taskkill', ['/PID', String(safePid), '/F', '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
                                  } else {
                                    process.kill(safePid, 'SIGTERM');
                                  }
                                } catch { /* process may be dead or invalid PID */ }
                              }
                              agentStatus.status = 'idle';
                              delete agentStatus.currentTask;
                              delete agentStatus.dispatched;
                              safeWrite(statusPath, agentStatus);
                            } catch { /* agent reset */ }
                            killedAgents.add(activeEntry.agent);
                          }
                        }
                        w.status = WI_STATUS.PAUSED;
                        w._pausedBy = 'plan-steering';
                        delete w.dispatched_at;
                        delete w.dispatched_to;
                        delete w.failReason;
                        delete w.failedAt;
                        if (w.id) resetItemIds.add(w.id);
                      }
                      return items;
                    }, { defaultValue: [] });
                  } catch { /* reset work items */ }
                }
                if (resetItemIds.size > 0 || killedAgents.size > 0) {
                  mutateJsonFileLocked(dispatchPath, (dp) => {
                    dp.active = (dp.active || []).filter(d => {
                      if (d.meta?.item?.id && resetItemIds.has(d.meta.item.id)) return false;
                      if (killedAgents.has(d.agent)) return false;
                      return true;
                    });
                    return dp;
                  }, { defaultValue: { pending: [], active: [], completed: [] } });
                }
                invalidateStatusCache();
                break;
              }
            }
          } catch (e) { console.error('auto-pause PRD on plan steer:', e.message); }
        }

        return jsonReply(res, 200, { ok: true, answer, edited: true, content, actions, pausedPrd });
      }
      return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(Read-only — changes not saved)', edited: false, actions });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleInboxPersist(req, res) {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });
      shared.sanitizePath(name, path.join(MINIONS_DIR, 'notes', 'inbox'));

      const inboxPath = path.join(MINIONS_DIR, 'notes', 'inbox', name);
      const content = safeRead(inboxPath);
      if (!content) return jsonReply(res, 404, { error: 'inbox item not found' });

      // Extract a title from the first heading or first line
      const titleMatch = content.match(/^#+ (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : name.replace('.md', '');

      // Append to notes.md as a new team note
      const notesPath = path.join(MINIONS_DIR, 'notes.md');
      let notes = safeRead(notesPath) || '# Minions Notes\n\n## Active Notes\n';
      const today = new Date().toISOString().slice(0, 10);
      const entry = `\n### ${today}: ${title}\n**By:** Persisted from inbox (${name})\n**What:** ${content.slice(0, 500)}\n\n---\n`;

      const marker = '## Active Notes';
      const idx = notes.indexOf(marker);
      if (idx !== -1) {
        const insertAt = idx + marker.length;
        notes = notes.slice(0, insertAt) + '\n' + entry + notes.slice(insertAt);
      } else {
        notes += '\n' + entry;
      }
      safeWrite(notesPath, notes);

      // Move to archive
      const archiveDir = path.join(MINIONS_DIR, 'notes', 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `persisted-${name}`), _c); safeUnlink(inboxPath); } catch (e) { console.error('inbox archive:', e.message); }

      return jsonReply(res, 200, { ok: true, title });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleInboxPromoteKb(req, res) {
    try {
      const body = await readBody(req);
      const { name, category } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });
      if (name.includes('..') || name.includes('\0') || name.includes('/') || name.includes('\\')) return jsonReply(res, 400, { error: 'Invalid file name' });
      if (!category || !shared.KB_CATEGORIES.includes(category)) {
        return jsonReply(res, 400, { error: 'category required: ' + shared.KB_CATEGORIES.join(', ') });
      }

      const inboxPath = path.join(MINIONS_DIR, 'notes', 'inbox', name);
      const content = safeRead(inboxPath);
      if (!content) return jsonReply(res, 404, { error: 'inbox item not found' });

      // Add frontmatter if not present
      const today = new Date().toISOString().slice(0, 10);
      let kbContent = content;
      if (!content.startsWith('---')) {
        const titleMatch = content.match(/^#+ (.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : name.replace('.md', '');
        kbContent = `---\ntitle: ${title}\ncategory: ${category}\ndate: ${today}\nsource: inbox/${name}\n---\n\n${content}`;
      }

      // Write to knowledge base
      const kbDir = path.join(MINIONS_DIR, 'knowledge', category);
      if (!fs.existsSync(kbDir)) fs.mkdirSync(kbDir, { recursive: true });
      const kbFile = path.join(kbDir, name);
      safeWrite(kbFile, kbContent);

      // Move inbox item to archive
      const archiveDir = path.join(MINIONS_DIR, 'notes', 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `kb-${category}-${name}`), _c); safeUnlink(inboxPath); } catch (e) { console.error('inbox archive:', e.message); }

      return jsonReply(res, 200, { ok: true, category, file: name });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleInboxOpen(req, res) {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name || name.includes('..') || name.includes('\0') || name.includes('/') || name.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid name' });
      }
      const filePath = path.join(MINIONS_DIR, 'notes', 'inbox', name);
      if (!fs.existsSync(filePath)) return jsonReply(res, 404, { error: 'file not found' });

      const { execFile } = require('child_process');
      try {
        if (process.platform === 'win32') {
          execFile('explorer', ['/select,', filePath.replace(/\//g, '\\')]);
        } else if (process.platform === 'darwin') {
          execFile('open', ['-R', filePath]);
        } else {
          execFile('xdg-open', [path.dirname(filePath)]);
        }
      } catch (e) {
        return jsonReply(res, 500, { error: 'Could not open file manager: ' + e.message });
      }
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleInboxDelete(req, res) {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name || name.includes('..') || name.includes('\0') || name.includes('/') || name.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid name' });
      }
      const filePath = path.join(MINIONS_DIR, 'notes', 'inbox', name);
      if (!fs.existsSync(filePath)) return jsonReply(res, 404, { error: 'file not found' });
      safeUnlink(filePath);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleSkillRead(req, res) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const file = params.get('file');
    const dir = params.get('dir');
    if (!file || file.includes('..') || file.includes('\0') || file.includes('/') || file.includes('\\')) { res.statusCode = 400; res.end('Invalid file'); return; }

    let content = '';
    if (dir) {
      // Direct path from collectSkillFiles — validate resolved path stays within expected dir
      const resolvedDir = path.resolve(dir.replace(/\//g, path.sep));
      const fullPath = path.join(resolvedDir, file);
      if (fullPath.startsWith(resolvedDir)) content = safeRead(fullPath) || '';
    }
    if (!content) {
      // Fallback: search Claude Code skills, then project skills
      const home = os.homedir();
      const claudePath = path.join(home, '.claude', 'skills', file.replace('.md', '').replace('SKILL', ''), 'SKILL.md');
      content = safeRead(claudePath) || '';
      if (!content) {
        const source = params.get('source') || '';
        if (source.startsWith('project:')) {
          const proj = PROJECTS.find(p => p.name === source.replace('project:', ''));
          if (proj) content = safeRead(path.join(proj.localPath, '.claude', 'skills', file)) || '';
        }
      }
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'Skill not found.');
    return;
  }

  async function handleProjectsBrowse(req, res) {
    try {
      const { execSync } = require('child_process');
      let selectedPath = '';
      if (process.platform === 'win32') {
        // PowerShell STA with topmost window as owner — forces folder dialog to foreground
        // Write PS script to temp file to avoid shell quoting issues
        const psScript = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$f.Description = "Select project folder"',
          '$f.ShowNewFolderButton = $false',
          '$owner = New-Object System.Windows.Forms.Form',
          '$owner.TopMost = $true',
          '$owner.StartPosition = "CenterScreen"',
          '$owner.WindowState = "Minimized"',
          '$owner.Show()',
          '$owner.Hide()',
          'if ($f.ShowDialog($owner) -eq "OK") { Write-Output $f.SelectedPath }',
          '$owner.Dispose()',
        ].join('\r\n');
        const psPath = path.join(MINIONS_DIR, 'engine', 'tmp', '_browse.ps1');
        fs.mkdirSync(path.dirname(psPath), { recursive: true });
        fs.writeFileSync(psPath, psScript);
        try {
          selectedPath = execSync(`powershell -STA -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, { encoding: 'utf8', timeout: 120000 }).trim();
        } finally { try { fs.unlinkSync(psPath); } catch { /* cleanup */ } }
      } else if (process.platform === 'darwin') {
        selectedPath = execSync(`osascript -e 'POSIX path of (choose folder with prompt "Select project folder")'`, { encoding: 'utf8', timeout: 120000 }).trim();
      } else {
        selectedPath = execSync(`zenity --file-selection --directory --title="Select project folder" 2>/dev/null`, { encoding: 'utf8', timeout: 120000 }).trim();
      }
      if (!selectedPath) return jsonReply(res, 200, { cancelled: true });
      return jsonReply(res, 200, { path: selectedPath.replace(/\\/g, '/') });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleProjectsAdd(req, res) {
    try {
      const body = await readBody(req);
      if (!body.path) return jsonReply(res, 400, { error: 'path required' });
      const target = path.resolve(body.path);
      if (!fs.existsSync(target)) return jsonReply(res, 400, { error: 'Directory not found: ' + target });

      const configPath = path.join(MINIONS_DIR, 'config.json');
      const config = safeJsonObj(configPath);
      if (!config) return jsonReply(res, 500, { error: 'failed to read config' });
      if (!config.projects) config.projects = [];

      // Check if already linked
      if (config.projects.find(p => path.resolve(p.localPath) === target)) {
        return jsonReply(res, 400, { error: 'Project already linked at ' + target });
      }

      // Auto-discover from git repo
      const { execSync: ex } = require('child_process');
      const detected = { name: path.basename(target), _found: [] };
      try {
        const head = ex('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || git symbolic-ref HEAD', { cwd: target, encoding: 'utf8', timeout: 5000 }).trim();
        detected.mainBranch = head.replace('refs/remotes/origin/', '').replace('refs/heads/', '');
      } catch { detected.mainBranch = 'main'; }
      try {
        const remoteUrl = ex('git remote get-url origin', { cwd: target, encoding: 'utf8', timeout: 5000 }).trim();
        if (remoteUrl.includes('github.com')) {
          detected.repoHost = 'github';
          const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
          if (m) { detected.org = m[1]; detected.repoName = m[2]; }
        } else if (remoteUrl.includes('visualstudio.com') || remoteUrl.includes('dev.azure.com')) {
          detected.repoHost = 'ado';
          const m = remoteUrl.match(/https:\/\/([^.]+)\.visualstudio\.com[^/]*\/([^/]+)\/_git\/([^/\s]+)/) ||
                    remoteUrl.match(/https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+)/);
          if (m) { detected.org = m[1]; detected.project = m[2]; detected.repoName = m[3]; }
        }
      } catch (e) { console.error('git remote detection:', e.message); }
      try {
        const pkgPath = path.join(target, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = safeJson(pkgPath);
          if (pkg.name) detected.name = pkg.name.replace(/^@[^/]+\//, '');
        }
      } catch { /* optional */ }
      let description = '';
      try {
        const claudeMd = path.join(target, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          const lines = (safeRead(claudeMd) || '').split('\n').filter(l => l.trim() && !l.startsWith('#'));
          if (lines[0] && lines[0].length < 200) description = lines[0].trim();
        }
      } catch { /* optional */ }

      const name = body.name || detected.name;
      const prUrlBase = detected.repoHost === 'github'
        ? (detected.org && detected.repoName ? `https://github.com/${detected.org}/${detected.repoName}/pull/` : '')
        : (detected.org && detected.project && detected.repoName
          ? `https://${detected.org}.visualstudio.com/DefaultCollection/${detected.project}/_git/${detected.repoName}/pullrequest/` : '');

      const project = {
        name, description, localPath: target.replace(/\\/g, '/'),
        repoHost: detected.repoHost || 'ado', repositoryId: '',
        adoOrg: detected.org || '', adoProject: detected.project || '',
        repoName: detected.repoName || name, mainBranch: detected.mainBranch || 'main',
        prUrlBase,
        workSources: { pullRequests: { enabled: true, cooldownMinutes: 30 }, workItems: { enabled: true, cooldownMinutes: 0 } }
      };

      config.projects.push(project);
      safeWrite(configPath, config);
      reloadConfig(); // Update in-memory project list immediately

      // Create project-local state files
      const minionsDir = path.join(target, '.minions');
      if (!fs.existsSync(minionsDir)) fs.mkdirSync(minionsDir, { recursive: true });
      const stateFiles = { 'pull-requests.json': '[]', 'work-items.json': '[]' };
      for (const [f, content] of Object.entries(stateFiles)) {
        const fp = path.join(minionsDir, f);
        if (!fs.existsSync(fp)) safeWrite(fp, content);
      }

      return jsonReply(res, 200, { ok: true, name, path: target, detected });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleProjectsScan(req, res) {
    try {
      const body = await readBody(req);
      const scanRoot = path.resolve(body.path || os.homedir());
      const maxDepth = Math.min(Number(body.depth) || 3, 6);
      if (!fs.existsSync(scanRoot)) return jsonReply(res, 400, { error: 'path does not exist' });

      // Find git repos recursively (same logic as minions.js findGitRepos)
      const skipDirs = new Set(['node_modules', '.git', '.hg', 'AppData', '$Recycle.Bin', 'Windows',
        'Program Files', 'Program Files (x86)', '.cache', '.npm', '.yarn', '.nuget', 'NugetCache',
        'worktrees', '.minions', '.squad', '.vs', '.vscode', 'obj', 'bin', 'packages',
        'OneDrive', 'OneDrive - Microsoft', '.copilot', 'marketplace-cache']);
      const repos = [];
      function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name === '.git') {
            // Validate it's a real repo — must have HEAD file
            try { if (fs.existsSync(path.join(dir, '.git', 'HEAD'))) repos.push(dir); } catch {}
            return;
          }
          if (e.name.startsWith('.') || skipDirs.has(e.name)) continue;
          walk(path.join(dir, e.name), depth + 1);
        }
      }
      walk(scanRoot, 0);

      // Enrich each repo with metadata
      const existingPaths = new Set(PROJECTS.map(p => path.resolve(p.localPath)));
      const results = repos.map(repoPath => {
        const result = { path: repoPath.replace(/\\/g, '/'), name: path.basename(repoPath), host: 'git', linked: existingPaths.has(path.resolve(repoPath)) };
        try {
          const remoteUrl = require('child_process').execSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          const gh = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
          const ado = remoteUrl.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+)/) || remoteUrl.match(/([^.]+)\.visualstudio\.com.*?\/([^/]+)\/_git\/([^/\s]+)/);
          if (gh) { result.host = 'GitHub'; result.org = gh[1]; result.name = gh[2]; }
          else if (ado) { result.host = 'ADO'; result.org = ado[1]; result.name = ado[3] || ado[2]; }
        } catch { /* no remote */ }
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
          if (pkg.name) result.name = pkg.name.replace(/@[^/]+\//, '');
          if (pkg.description) result.description = pkg.description.slice(0, 100);
        } catch { /* no package.json */ }
        return result;
      });

      return jsonReply(res, 200, { repos: results });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleFileBug(req, res) {
    try {
      const body = await readBody(req);
      if (!body.title) return jsonReply(res, 400, { error: 'title required' });

      // Check gh CLI is available
      try { shared.exec('gh --version', { encoding: 'utf-8', timeout: 5000, windowsHide: true }); }
      catch { return jsonReply(res, 500, { error: 'gh CLI not installed. Run: npm install -g gh' }); }

      const repo = 'yemi33/minions';
      const labels = (body.labels || ['bug']).join(',');
      const bugBody = (body.description || '') + '\n\n---\n_Filed via Minions dashboard_';

      // Write body to temp file to avoid shell escaping issues with quotes, backticks, newlines
      const tmpBody = path.join(ENGINE_DIR, 'tmp', `bug-body-${Date.now()}.md`);
      safeWrite(tmpBody, bugBody);
      const safeTitle = body.title.replace(/["`$\\]/g, '');
      try {
        const cmd = `gh issue create --repo "${repo}" --title "${safeTitle}" --body-file "${tmpBody}" --label "${labels}" 2>&1`;
        const result = shared.exec(cmd, { encoding: 'utf-8', timeout: 30000, windowsHide: true });
        shared.safeUnlink(tmpBody);
        // Detect gh errors in output
        if (result.includes('authentication') || result.includes('auth login')) {
          return jsonReply(res, 401, { error: 'GitHub auth required. Run: gh auth login' });
        }
        const urlMatch = result.match(/https:\/\/github\.com\/\S+/);
        if (!urlMatch) {
          return jsonReply(res, 500, { error: 'Issue may not have been created: ' + result.trim().slice(0, 200) });
        }
        return jsonReply(res, 200, { ok: true, url: urlMatch[0], output: result.trim() });
      } catch (e) {
        shared.safeUnlink(tmpBody);
        throw e;
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('ENOENT') || msg.includes('not found')) return jsonReply(res, 500, { error: 'gh CLI not found. Install from https://cli.github.com/' });
      return jsonReply(res, 500, { error: msg });
    }
  }

  async function handleCommandCenterNewSession(req, res) {
    ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
    ccInFlight = false; // Reset concurrency guard so a stuck request doesn't block new sessions
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
    return jsonReply(res, 200, { ok: true });
  }

  async function handleCCSessionsList(req, res) {
    const sessions = shared.safeJsonArr(CC_SESSIONS_PATH);
    return jsonReply(res, 200, { sessions });
  }

  async function handleCCSessionDelete(req, res, match) {
    const id = match?.[1];
    if (!id) return jsonReply(res, 400, { error: 'id required' });
    const sessions = shared.safeJsonArr(CC_SESSIONS_PATH);
    const filtered = sessions.filter(s => s.id !== id);
    safeWrite(CC_SESSIONS_PATH, filtered);
    return jsonReply(res, 200, { ok: true });
  }

  async function handleCommandCenter(req, res) {
    if (checkRateLimit('command-center', 10)) return jsonReply(res, 429, { error: 'Rate limited — max 10 requests/minute' });
    try {
      const body = await readBody(req);
      if (!body.message) return jsonReply(res, 400, { error: 'message required' });

      // Concurrency guard — only one CC call at a time, with auto-release for stuck requests
      if (ccInFlight && (Date.now() - ccInFlightSince) < CC_INFLIGHT_TIMEOUT_MS) {
        return jsonReply(res, 429, { error: 'Command Center is busy — wait for the current request to finish, or click "New Session" to reset.' });
      }
      if (ccInFlight) console.log('[CC] Auto-releasing stuck in-flight guard after timeout');
      ccInFlight = true;
      ccInFlightSince = Date.now();

      try {
        if (body.sessionId && body.sessionId !== ccSession.sessionId) {
          ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
        }
        const wasResume = !!(body.sessionId && body.sessionId === ccSession.sessionId && ccSessionValid());

        const result = await ccCall(body.message, { store: 'cc' });

        // Non-zero exit with text = max_turns or partial success — still usable
        if (!result.text) {
          const debugInfo = result.code !== 0 ? `(exit code ${result.code})` : '(empty response)';
          const stderrTail = (result.stderr || '').trim().split('\n').filter(Boolean).slice(-5).join(' | ');
          console.error(`[CC] LLM failed after retries ${debugInfo}: ${stderrTail}`);
          try { shared.log('warn', `CC failed ${debugInfo}: ${stderrTail.slice(0, 300)}`); } catch {}
          const hasSession = !!ccSession.sessionId;
          const retryHint = hasSession
            ? 'Your session is still active — just send your message again to retry.'
            : 'Try clicking **New Session** and sending your message again.';
          return jsonReply(res, 200, {
            text: `I had trouble processing that ${debugInfo}. ${stderrTail ? 'Detail: ' + stderrTail : ''}\n\n${retryHint}`,
            actions: [], sessionId: ccSession.sessionId
          });
        }

        return jsonReply(res, 200, { ...parseCCActions(result.text), sessionId: ccSession.sessionId, newSession: !wasResume });
      } finally {
        ccInFlight = false;
        ccInFlightSince = 0;
      }
    } catch (e) { ccInFlight = false; return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleCommandCenterStream(req, res) {
    if (checkRateLimit('command-center', 10)) { res.statusCode = 429; res.end('Rate limited'); return; }
    try {
      const body = await readBody(req);
      if (!body.message) { res.statusCode = 400; res.end('message required'); return; }
      if (ccInFlight && (Date.now() - ccInFlightSince) < CC_INFLIGHT_TIMEOUT_MS) {
        res.statusCode = 429; res.end('CC busy'); return;
      }
      if (ccInFlight) console.log('[CC-stream] Auto-releasing stuck guard');
      ccInFlight = true;
      ccInFlightSince = Date.now();

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      let _ccStreamAbort = null;
      // Kill LLM process immediately if client disconnects mid-stream
      req.on('close', () => { ccInFlight = false; ccInFlightSince = 0; if (_ccStreamAbort) _ccStreamAbort(); });

      try {
        // Session management — same as non-streaming path
        if (body.sessionId && body.sessionId !== ccSession.sessionId) {
          ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
        }
        const wasResume = !!(ccSessionValid() && ccSession.sessionId);
        const sessionId = wasResume ? ccSession.sessionId : null;
        const preamble = wasResume ? '' : buildCCStatePreamble();
        const prompt = (preamble ? preamble + '\n\n---\n\n' : '') + body.message;

        const { callLLMStreaming, trackEngineUsage: trackUsage } = require('./engine/llm');
        const streamModel = CONFIG.engine?.ccModel || shared.ENGINE_DEFAULTS.ccModel;
        const streamEffort = CONFIG.engine?.ccEffort || shared.ENGINE_DEFAULTS.ccEffort;
        const ccMaxTurns = CONFIG.engine?.ccMaxTurns || shared.ENGINE_DEFAULTS.ccMaxTurns;
        const llmPromise = callLLMStreaming(prompt, CC_STATIC_SYSTEM_PROMPT, {
          timeout: 900000, label: 'command-center', model: streamModel, maxTurns: ccMaxTurns,
          allowedTools: 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch',
          sessionId, effort: streamEffort, direct: true,
          onChunk: (text) => {
            try { res.write('data: ' + JSON.stringify({ type: 'chunk', text }) + '\n\n'); } catch {}
          },
          onToolUse: (name, input) => {
            try { res.write('data: ' + JSON.stringify({ type: 'tool', name, input: typeof input === 'string' ? input.slice(0, 200) : JSON.stringify(input).slice(0, 200) }) + '\n\n'); } catch {}
          }
        });
        _ccStreamAbort = llmPromise.abort;
        const result = await llmPromise;
        trackUsage('command-center', result.usage);

        // Handle failure — non-zero exit with text = max_turns or partial success, still usable
        if (!result.text) {
          const debugInfo = result.code !== 0 ? `(exit code ${result.code})` : '(empty response)';
          const stderrTail = (result.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
          console.error(`[CC-stream] Failed: code=${result.code}, stderr=${(result.stderr || '').slice(0, 500)}, stdout_tail=${(result.raw || '').slice(-500)}`);
          // If resuming a session failed, auto-reset so next attempt starts fresh
          let retryHint;
          if (wasResume && result.code !== 0) {
            ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
            safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
            retryHint = 'Session was reset — send your message again to start fresh.';
          } else {
            retryHint = ccSession.sessionId
              ? 'Your session is still active — just send your message again to retry.'
              : 'Try clicking **New Session** and sending your message again.';
          }
          res.write('data: ' + JSON.stringify({ type: 'done', text: `I had trouble processing that ${debugInfo}. ${stderrTail ? 'Detail: ' + stderrTail : ''}\n\n${retryHint}`, actions: [], sessionId: ccSession.sessionId }) + '\n\n');
          res.end();
          return;
        }

        // Update session
        const now = Date.now();
        if (result.sessionId) {
          ccSession = { sessionId: result.sessionId, createdAt: ccSession.createdAt || now, lastActiveAt: now, turnCount: (ccSession.turnCount || 0) + 1, _promptHash: _ccPromptHash };
          safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
        }

        // Persist tab→session mapping if tabId provided
        const tabId = body.tabId;
        if (tabId && ccSession.sessionId) {
          try {
            const sessions = shared.safeJsonArr(CC_SESSIONS_PATH);
            const existing = sessions.find(s => s.id === tabId);
            const preview = (body.message || '').slice(0, 80);
            if (existing) {
              existing.sessionId = ccSession.sessionId;
              existing.lastActiveAt = new Date(now).toISOString();
              existing.turnCount = ccSession.turnCount;
              existing.preview = preview;
            } else {
              sessions.push({ id: tabId, title: (body.message || 'New chat').slice(0, 40), sessionId: ccSession.sessionId, createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), turnCount: ccSession.turnCount, preview });
            }
            safeWrite(CC_SESSIONS_PATH, sessions);
          } catch { /* non-critical */ }
        }

        // Send final result with actions
        const { text: displayText, actions } = parseCCActions(result.text);
        res.write('data: ' + JSON.stringify({ type: 'done', text: displayText, actions, sessionId: ccSession.sessionId, newSession: !wasResume }) + '\n\n');
        res.end();
      } finally {
        ccInFlight = false;
        ccInFlightSince = 0;
      }
    } catch (e) {
      ccInFlight = false;
      ccInFlightSince = 0;
      try { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n'); } catch {}
      try { res.end(); } catch {}
    }
  }

  async function handleSchedulesList(req, res) {
    reloadConfig();
    const schedules = CONFIG.schedules || [];
    const runs = shared.safeJson(path.join(MINIONS_DIR, 'engine', 'schedule-runs.json')) || {};
    const result = schedules.map(s => ({ ...s, _lastRun: runs[s.id] || null }));
    return jsonReply(res, 200, { schedules: result });
  }

  async function handleSchedulesCreate(req, res) {
    const body = await readBody(req);
    let { id, cron, title, type, project, agent, description, priority, enabled } = body;
    if (!cron || !title) return jsonReply(res, 400, { error: 'cron and title are required' });

    // Auto-generate ID from title if not provided
    if (!id) {
      id = shared.slugify(title, 40);
      if (!id) id = 'schedule';
    }

    reloadConfig();
    if (!CONFIG.schedules) CONFIG.schedules = [];

    // If auto-generated ID collides, append a short numeric suffix
    if (CONFIG.schedules.some(s => s.id === id)) {
      let suffix = 2;
      while (CONFIG.schedules.some(s => s.id === `${id}-${suffix}`)) suffix++;
      id = `${id}-${suffix}`;
    }

    const sched = { id, cron, title, type: type || 'implement', enabled: enabled !== false };
    if (project) sched.project = project;
    if (agent) sched.agent = agent;
    if (description) sched.description = description;
    if (priority) sched.priority = priority;

    CONFIG.schedules.push(sched);
    safeWrite(path.join(MINIONS_DIR, 'config.json'), CONFIG);
    invalidateStatusCache();
    return jsonReply(res, 200, { ok: true, schedule: sched });
  }

  async function handleSchedulesUpdate(req, res) {
    const body = await readBody(req);
    const { id, cron, title, type, project, agent, description, priority, enabled } = body;
    if (!id) return jsonReply(res, 400, { error: 'id required' });

    reloadConfig();
    if (!CONFIG.schedules) return jsonReply(res, 404, { error: 'No schedules configured' });
    const sched = CONFIG.schedules.find(s => s.id === id);
    if (!sched) return jsonReply(res, 404, { error: 'Schedule not found' });

    if (cron !== undefined) sched.cron = cron;
    if (title !== undefined) sched.title = title;
    if (type !== undefined) sched.type = type;
    if (project !== undefined) sched.project = project || null;
    if (agent !== undefined) sched.agent = agent || null;
    if (description !== undefined) sched.description = description;
    if (priority !== undefined) sched.priority = priority;
    if (enabled !== undefined) sched.enabled = enabled;

    safeWrite(path.join(MINIONS_DIR, 'config.json'), CONFIG);
    invalidateStatusCache();
    return jsonReply(res, 200, { ok: true, schedule: sched });
  }

  async function handleSchedulesDelete(req, res) {
    const body = await readBody(req);
    const { id } = body;
    if (!id) return jsonReply(res, 400, { error: 'id required' });

    reloadConfig();
    if (!CONFIG.schedules) return jsonReply(res, 404, { error: 'No schedules configured' });
    const idx = CONFIG.schedules.findIndex(s => s.id === id);
    if (idx < 0) return jsonReply(res, 404, { error: 'Schedule not found' });

    CONFIG.schedules.splice(idx, 1);
    safeWrite(path.join(MINIONS_DIR, 'config.json'), CONFIG);
    invalidateStatusCache();
    return jsonReply(res, 200, { ok: true });
  }

  async function handleSchedulesParseNatural(req, res) {
    const body = await readBody(req);
    const { text } = body;
    if (!text || !text.trim()) return jsonReply(res, 400, { error: 'text is required' });

    const prompt = `Convert this schedule description to a 3-field cron expression (minute hour dayOfWeek, where dayOfWeek is 0=Sun..6=Sat or ranges like 1-5). Return JSON only: {"cron": "...", "description": "..."}. Input: ${text.trim()}`;
    try {
      const result = await llm.callLLM(prompt, '', { model: 'haiku', maxTurns: 1, timeout: 30000, label: 'schedule-parse', direct: true });
      const parsed = JSON.parse(result.text.trim());
      if (!parsed.cron) return jsonReply(res, 422, { error: 'Could not parse schedule' });
      return jsonReply(res, 200, { cron: parsed.cron, description: parsed.description || '' });
    } catch (e) {
      return jsonReply(res, 422, { error: 'Parse failed: ' + e.message });
    }
  }

  async function handleEngineRestart(req, res) {
    try {
      const newPid = restartEngine();
      return jsonReply(res, 200, { ok: true, pid: newPid });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleSettingsRead(req, res) {
    try {
      const config = queries.getConfig();
      const routing = safeRead(path.join(MINIONS_DIR, 'routing.md')) || '';
      return jsonReply(res, 200, {
        engine: { ...shared.ENGINE_DEFAULTS, ...(config.engine || {}) },
        claude: { ...shared.DEFAULT_CLAUDE, ...(config.claude || {}) },
        agents: config.agents || {},
        routing,
      });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleSettingsUpdate(req, res) {
    try {
      const body = await readBody(req);
      const configPath = path.join(MINIONS_DIR, 'config.json');
      const config = safeJson(configPath) || {};
      if (!config.engine) config.engine = {};
      if (!config.claude) config.claude = {};
      if (!config.agents) config.agents = {};

      if (body.engine) {
        const e = body.engine;
        const D = shared.ENGINE_DEFAULTS;
        // Numeric fields: { key: [min, max?] }
        const numericFields = {
          tickInterval: [10000], maxConcurrent: [1, 50], inboxConsolidateThreshold: [1],
          agentTimeout: [60000], maxTurns: [5, 500], heartbeatTimeout: [60000],
          worktreeCreateTimeout: [60000], worktreeCreateRetries: [0, 3],
          idleAlertMinutes: [1], shutdownTimeout: [30000], restartGracePeriod: [60000],
          meetingRoundTimeout: [60000],
          versionCheckInterval: [60000],
          maxBuildFixAttempts: [1, 10],
        };
        const clamped = [];
        for (const [key, [min, max]] of Object.entries(numericFields)) {
          if (e[key] !== undefined) {
            let val = Number(e[key]) || D[key];
            const raw = val;
            val = Math.max(min, val);
            if (max !== undefined) val = Math.min(max, val);
            if (val !== raw) clamped.push(`${key}: ${raw} → ${val} (range: ${min}–${max || '∞'})`);
            config.engine[key] = val;
          }
        }
        // String fields
        if (e.worktreeRoot !== undefined) config.engine.worktreeRoot = String(e.worktreeRoot || D.worktreeRoot);
        // CC model/effort
        if (e.ccModel !== undefined) {
          const valid = ['sonnet', 'haiku', 'opus'];
          config.engine.ccModel = valid.includes(e.ccModel) ? e.ccModel : D.ccModel;
        }
        if (e.ccEffort !== undefined) {
          const valid = [null, 'low', 'medium', 'high'];
          config.engine.ccEffort = valid.includes(e.ccEffort) ? e.ccEffort : null;
        }
        // Per-type max turns
        if (e.maxTurnsByType !== undefined && typeof e.maxTurnsByType === 'object') {
          const mbt = {};
          for (const [type, val] of Object.entries(e.maxTurnsByType)) {
            const n = Number(val);
            if (n && n >= 5 && n <= 500) mbt[type] = n;
          }
          config.engine.maxTurnsByType = mbt;
        }
        // Boolean fields
        for (const key of ['autoApprovePlans', 'evalLoop', 'autoDecompose', 'allowTempAgents', 'autoArchive']) {
          if (e[key] !== undefined) config.engine[key] = !!e[key];
        }
        // Eval loop settings
        if (e.evalMaxIterations !== undefined) config.engine.evalMaxIterations = Math.max(1, Math.min(10, Number(e.evalMaxIterations) || D.evalMaxIterations));
        if (e.evalMaxCost !== undefined) config.engine.evalMaxCost = e.evalMaxCost === null || e.evalMaxCost === '' ? null : Math.max(0, Number(e.evalMaxCost) || 0);
      }

      if (body.claude) {
        for (const key of ['allowedTools', 'outputFormat']) {
          if (body.claude[key] !== undefined) config.claude[key] = String(body.claude[key]);
        }
        if (body.claude.permissionMode !== undefined) {
          const valid = ['bypassPermissions', 'auto', 'default'];
          config.claude.permissionMode = valid.includes(body.claude.permissionMode) ? body.claude.permissionMode : 'bypassPermissions';
        }
      }

      if (body.agents) {
        for (const [id, updates] of Object.entries(body.agents)) {
          if (!config.agents[id]) continue;
          if (updates.role !== undefined) config.agents[id].role = String(updates.role);
          if (updates.skills !== undefined) config.agents[id].skills = Array.isArray(updates.skills) ? updates.skills : String(updates.skills).split(',').map(s => s.trim()).filter(Boolean);
          if (updates.monthlyBudgetUsd !== undefined) {
            const val = updates.monthlyBudgetUsd === '' || updates.monthlyBudgetUsd === null ? undefined : Number(updates.monthlyBudgetUsd);
            if (val === undefined || isNaN(val)) delete config.agents[id].monthlyBudgetUsd;
            else config.agents[id].monthlyBudgetUsd = Math.max(0, val);
          }
        }
      }

      safeWrite(configPath, config);
      // Refresh in-memory CONFIG so subsequent reads see the update
      reloadConfig();
      invalidateStatusCache();
      console.log('[settings] Saved config.json — engine keys:', Object.keys(config.engine || {}));
      const msg = clamped.length > 0
        ? 'Settings saved. Some values were adjusted: ' + clamped.join('; ')
        : 'Settings saved. Engine picks up changes on next tick.';
      return jsonReply(res, 200, { ok: true, message: msg, clamped });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleSettingsRouting(req, res) {
    try {
      const body = await readBody(req);
      if (!body.content) return jsonReply(res, 400, { error: 'content required' });
      safeWrite(path.join(MINIONS_DIR, 'routing.md'), body.content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleSettingsReset(req, res) {
    try {
      const config = queries.getConfig();
      config.engine = { ...shared.ENGINE_DEFAULTS };
      config.claude = { ...shared.DEFAULT_CLAUDE };
      config.agents = { ...shared.DEFAULT_AGENTS };
      safeWrite(path.join(MINIONS_DIR, 'config.json'), config);
      reloadConfig();
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleHealth(req, res) {
    const engine = getEngineState();
    const agents = getAgents();
    const health = {
      status: engine.state === 'running' ? 'healthy' : engine.state === 'paused' ? 'degraded' : 'stopped',
      engine: { state: engine.state, pid: engine.pid },
      agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status })),
      projects: PROJECTS.map(p => ({ name: p.name, reachable: fs.existsSync(p.localPath) })),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
    return jsonReply(res, 200, health);
  }

  async function handleAgentDetail(req, res, match) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      res.end(JSON.stringify(getAgentDetail(match[1])));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  async function handleStatus(req, res) {
    try {
      // Use pre-serialized JSON to avoid double-stringify in jsonReply
      const json = getStatusJson();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.statusCode = 200;
      const ae = req && req.headers && req.headers['accept-encoding'] || '';
      if (ae.includes('gzip') && json.length > 1024) {
        res.setHeader('Content-Encoding', 'gzip');
        res.end(zlib.gzipSync(json));
      } else {
        res.end(json);
      }
    } catch (e) {
      return jsonReply(res, 500, { error: e.message }, req);
    }
  }

  // ── Route Registry ──────────────────────────────────────────────────────────
  // Order matters: specific routes before general ones (e.g., /api/plans/approve before /api/plans/:file)

  const ROUTES = [
    // Routes endpoint (self-describing API)
    { method: 'GET', path: '/api/version', desc: 'Current + latest version info with update check', handler: async (req, res) => {
      const npm = await checkNpmVersion();
      const { diskVersion, diskCommit, isGitRepo } = getDiskVersion();
      const engine = getEngineState();
      const engineStale = !!(engine.codeVersion && diskVersion && engine.codeVersion !== diskVersion) ||
                          !!(engine.codeCommit && diskCommit && engine.codeCommit !== diskCommit);
      const dashboardStale = !!(diskVersion && _dashboardVersion.codeVersion && diskVersion !== _dashboardVersion.codeVersion) ||
                             !!(diskCommit && _dashboardVersion.codeCommit && diskCommit !== _dashboardVersion.codeCommit);
      return jsonReply(res, 200, {
        current: diskVersion,
        currentCommit: diskCommit,
        engineRunning: engine.codeVersion || null,
        engineRunningCommit: engine.codeCommit || null,
        dashboardRunning: _dashboardVersion.codeVersion,
        dashboardRunningCommit: _dashboardVersion.codeCommit,
        latest: npm.latest,
        updateAvailable: !isGitRepo && !!(diskVersion && npm.latest && _compareVersions(npm.latest, diskVersion) > 0),
        engineStale,
        dashboardStale,
        stale: engineStale || dashboardStale,
        checkedAt: npm.checkedAt,
      });
    }},
    { method: 'GET', path: '/api/routes', desc: 'List all available API endpoints', handler: (req, res) => {
      const list = ROUTES.map(r => ({
        method: r.method,
        path: typeof r.path === 'string' ? r.path : r.path.toString(),
        description: r.desc,
        params: r.params || null
      }));
      return jsonReply(res, 200, { routes: list });
    }},

    // Status & health
    { method: 'GET', path: '/api/status', desc: 'Full dashboard status snapshot (agents, PRDs, work items, dispatch, etc.)', handler: handleStatus },
    { method: 'GET', path: '/api/status-stream', desc: 'SSE stream of real-time status updates', handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('data: ' + getStatusJson() + '\n\n');
      _statusStreamClients.add(res);
      req.on('close', () => _statusStreamClients.delete(res));
    }},
    { method: 'GET', path: '/api/health', desc: 'Lightweight health check for monitoring', handler: handleHealth },
    { method: 'GET', path: '/api/hot-reload', desc: 'SSE stream for dashboard hot-reload notifications', handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('data: connected\n\n');
      _hotReloadClients.add(res);
      req.on('close', () => _hotReloadClients.delete(res));
    }},

    // Work items
    { method: 'POST', path: '/api/work-items', desc: 'Create a new work item', params: 'title, type?, description?, priority?, project?, agent?, agents?, scope?, references?, acceptanceCriteria?', handler: handleWorkItemsCreate },
    { method: 'POST', path: '/api/work-items/update', desc: 'Edit a pending/failed work item', params: 'id, source?, title?, description?, type?, priority?, agent?, references?, acceptanceCriteria?', handler: handleWorkItemsUpdate },
    { method: 'POST', path: '/api/work-items/retry', desc: 'Reset a failed/dispatched item to pending', params: 'id, source?', handler: handleWorkItemsRetry },
    { method: 'POST', path: '/api/work-items/delete', desc: 'Remove a work item, kill agent, clear dispatch', params: 'id, source?', handler: handleWorkItemsDelete },
    { method: 'POST', path: '/api/work-items/archive', desc: 'Move a completed/failed work item to archive', params: 'id, source?', handler: handleWorkItemsArchive },
    { method: 'GET', path: '/api/work-items/archive', desc: 'List archived work items', handler: handleWorkItemsArchiveList },
    { method: 'POST', path: '/api/work-items/feedback', desc: 'Add human feedback on completed work', params: 'id, rating, comment?', handler: async (req, res) => {
      const body = await readBody(req);
      const { id, source, rating, comment } = body;
      if (!id || !rating) return jsonReply(res, 400, { error: 'id and rating required' });
      const projects = shared.getProjects(CONFIG);
      const paths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const p of projects) paths.push(shared.projectWorkItemsPath(p));
      let found = null;
      for (const wiPath of paths) {
        mutateWorkItems(wiPath, items => {
          const item = items.find(i => i.id === id);
          if (item && !found) {
            item._humanFeedback = { rating, comment: comment || '', at: new Date().toISOString() };
            found = { agent: item.dispatched_to || item.agent || 'unknown', title: item.title || id };
          }
        });
        if (found) break;
      }
      if (!found) return jsonReply(res, 404, { error: 'Work item not found' });
      const feedbackNote = '# Human Feedback on ' + id + '\n\n' +
        '**Rating:** ' + (rating === 'up' ? '👍 Good' : '👎 Needs improvement') + '\n' +
        '**Item:** ' + found.title + '\n' +
        '**Agent:** ' + found.agent + '\n' +
        (comment ? '**Feedback:** ' + comment + '\n' : '');
      const inboxPath = path.join(MINIONS_DIR, 'notes', 'inbox', found.agent + '-feedback-' + new Date().toISOString().slice(0, 10) + '-' + shared.uid().slice(0, 4) + '.md');
      safeWrite(inboxPath, feedbackNote);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},

    // Pinned notes
    { method: 'GET', path: '/api/pinned', desc: 'Get pinned notes', handler: async (req, res) => {
      const content = safeRead(path.join(MINIONS_DIR, 'pinned.md'));
      return jsonReply(res, 200, { content, entries: parsePinnedEntries(content) });
    }},
    { method: 'POST', path: '/api/pinned', desc: 'Add a pinned note', params: 'title, content, level?', handler: async (req, res) => {
      const body = await readBody(req);
      const { title, content, level } = body;
      if (!title || !content) return jsonReply(res, 400, { error: 'title and content required' });
      const pinnedPath = path.join(MINIONS_DIR, 'pinned.md');
      const existing = safeRead(pinnedPath);
      const levelTag = level === 'critical' ? '🔴 ' : level === 'warning' ? '🟡 ' : '';
      const entry = '\n\n### ' + levelTag + title + '\n\n' + content + '\n\n*Pinned by human on ' + new Date().toISOString().slice(0, 10) + '*';
      safeWrite(pinnedPath, (existing || '# Pinned Context\n\nCritical notes visible to all agents.') + entry);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/pinned/remove', desc: 'Remove a pinned note by title', params: 'title', handler: async (req, res) => {
      const body = await readBody(req);
      const { title } = body;
      if (!title) return jsonReply(res, 400, { error: 'title required' });
      const pinnedPath = path.join(MINIONS_DIR, 'pinned.md');
      let content = safeRead(pinnedPath);
      if (!content) return jsonReply(res, 404, { error: 'No pinned notes' });
      const regex = new RegExp('\\n\\n###\\s*(?:🔴\\s*|🟡\\s*)?' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n[\\s\\S]*?(?=\\n\\n###|$)', 'i');
      content = content.replace(regex, '');
      safeWrite(pinnedPath, content);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},

    // KB pin state (server-side so CC can pin items)
    { method: 'GET', path: '/api/kb-pins', desc: 'Get pinned KB item keys', handler: async (req, res) => {
      const pins = shared.safeJson(path.join(MINIONS_DIR, 'engine', 'kb-pins.json')) || [];
      return jsonReply(res, 200, { pins });
    }},
    { method: 'POST', path: '/api/kb-pins', desc: 'Set pinned KB item keys', params: 'pins[]', handler: async (req, res) => {
      const body = await readBody(req);
      if (!Array.isArray(body.pins)) return jsonReply(res, 400, { error: 'pins array required' });
      safeWrite(path.join(MINIONS_DIR, 'engine', 'kb-pins.json'), body.pins);
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/kb-pins/toggle', desc: 'Toggle a single KB pin', params: 'key', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.key) return jsonReply(res, 400, { error: 'key required' });
      const pinsPath = path.join(MINIONS_DIR, 'engine', 'kb-pins.json');
      const pins = shared.safeJson(pinsPath) || [];
      const idx = pins.indexOf(body.key);
      if (idx >= 0) pins.splice(idx, 1); else pins.unshift(body.key);
      safeWrite(pinsPath, pins);
      return jsonReply(res, 200, { ok: true, pinned: idx < 0 });
    }},

    // Notes
    { method: 'POST', path: '/api/notes', desc: 'Write a note to inbox for consolidation', params: 'title, what, why?, author?', handler: handleNotesCreate },
    { method: 'GET', path: '/api/notes-full', desc: 'Return full notes.md content', handler: handleNotesFull },
    { method: 'POST', path: '/api/notes-save', desc: 'Save edited notes.md content', params: 'content, file?', handler: handleNotesSave },

    // Plans
    { method: 'POST', path: '/api/plan', desc: 'Create a plan work item that chains to PRD on completion', params: 'title, description?, priority?, project?, agent?, branch_strategy?', handler: handlePlanCreate },
    { method: 'GET', path: '/api/plans', desc: 'List plan files (.md drafts + .json PRDs)', handler: handlePlansList },
    { method: 'POST', path: '/api/plans/trigger-verify', desc: 'Manually trigger verification for a completed plan', params: 'file', handler: handlePlansTriggerVerify },
    { method: 'POST', path: '/api/plans/approve', desc: 'Approve a plan for execution', params: 'file, approvedBy?', handler: handlePlansApprove },
    { method: 'POST', path: '/api/plans/pause', desc: 'Pause a plan (stops materialization + resets active items)', params: 'file', handler: handlePlansPause },
    { method: 'POST', path: '/api/plans/execute', desc: 'Queue plan-to-prd conversion for a .md plan', params: 'file, project?', handler: handlePlansExecute },
    { method: 'POST', path: '/api/plans/reject', desc: 'Reject a plan', params: 'file, rejectedBy?, reason?', handler: handlePlansReject },
    { method: 'POST', path: '/api/plans/regenerate', desc: 'Reset pending/failed work items for a plan so they re-materialize', params: 'source', handler: handlePlansRegenerate },
    { method: 'POST', path: '/api/plans/delete', desc: 'Delete a plan file and clean up work items', params: 'file', handler: handlePlansDelete },
    { method: 'POST', path: '/api/plans/archive', desc: 'Move a plan/PRD to archive (preserves work items)', params: 'file', handler: handlePlansArchive },
    { method: 'POST', path: '/api/plans/unarchive', desc: 'Restore a plan/PRD from archive', params: 'file', handler: handlePlansUnarchive },
    { method: 'POST', path: '/api/plans/revise', desc: 'Request revision with feedback, dispatches agent to revise', params: 'file, feedback, requestedBy?', handler: handlePlansRevise },
    { method: 'POST', path: '/api/plans/discuss', desc: 'Generate a plan discussion session script for Claude CLI', params: 'file', handler: handlePlansDiscuss },
    { method: 'GET', path: /^\/api\/plans\/archive\/([^?]+)$/, desc: 'Read an archived plan file', handler: handlePlansArchiveRead },
    { method: 'GET', path: /^\/api\/plans\/([^?]+)$/, desc: 'Read a full plan (JSON from prd/ or markdown from plans/)', handler: handlePlansRead },

    // PRD items
    { method: 'POST', path: '/api/prd-items', desc: 'Create a PRD item as a plan file in prd/ (auto-approved)', params: 'name, description?, priority?, estimated_complexity?, project?, id?', handler: handlePrdItemsCreate },
    { method: 'POST', path: '/api/prd-items/update', desc: 'Edit a PRD item in its source plan JSON', params: 'source, itemId, name?, description?, priority?, estimated_complexity?, status?', handler: handlePrdItemsUpdate },
    { method: 'POST', path: '/api/prd-items/remove', desc: 'Remove a PRD item from plan + cancel materialized work item', params: 'source, itemId', handler: handlePrdItemsRemove },
    { method: 'POST', path: '/api/prd/regenerate', desc: 'Regenerate PRD from revised source plan', params: 'file', handler: handlePrdRegenerate },

    // Agents
    { method: 'POST', path: '/api/pull-requests/link', desc: 'Manually link an external PR for tracking', params: 'url, title?, project?, autoObserve?, context?', handler: async (req, res) => {
      const body = await readBody(req);
      const { url, title, project: projectName, autoObserve, context } = body;
      if (!url) return jsonReply(res, 400, { error: 'url required' });

      // Determine project
      reloadConfig();
      const projects = shared.getProjects(CONFIG);
      const targetProject = projectName ? projects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) : (projects[0] || null);
      const prPath = targetProject ? shared.projectPrPath(targetProject) : path.join(MINIONS_DIR, 'pull-requests.json');

      // Extract PR number from URL
      const prNumMatch = url.match(/\/pull\/(\d+)|pullrequest\/(\d+)/);
      const prNum = prNumMatch ? (prNumMatch[1] || prNumMatch[2]) : Date.now().toString().slice(-6);
      const prId = 'PR-' + prNum;

      // Atomic check-and-insert to prevent duplicates and races with polling loops
      let duplicate = false;
      mutateJsonFileLocked(prPath, (prs) => {
        if (!Array.isArray(prs)) prs = [];
        if (prs.some(p => p.id === prId || p.url === url)) { duplicate = true; return prs; }
        prs.push({
          id: prId,
          title: (title || 'PR #' + prNum + ' (polling...)').slice(0, 120),
          description: '',
          agent: 'human',
          branch: '',
          reviewStatus: autoObserve ? 'pending' : 'none',
          status: autoObserve ? 'active' : 'linked',
          created: new Date().toISOString(),
          url,
          prdItems: [],
          _manual: true,
          _autoObserve: !!autoObserve,
          _context: context || '',
        });
        return prs;
      }, { defaultValue: [] });
      if (duplicate) return jsonReply(res, 400, { error: 'PR already tracked' });
      invalidateStatusCache();
      jsonReply(res, 200, { ok: true, id: prId });

      // Async-enrich: fetch title, description, branch, author from GitHub/ADO API
      (async () => {
        try {
          let prData = null;
          const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
          const adoMatch = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/);
          if (ghMatch) {
            const slug = ghMatch[1];
            const result = await shared.execAsync(`gh api "repos/${slug}/pulls/${prNum}"`, { timeout: 15000, encoding: 'utf-8' });
            const d = JSON.parse(result);
            prData = { title: d.title, description: d.body, branch: d.head?.ref, author: d.user?.login };
          } else if (adoMatch) {
            const [, adoOrg, adoProj, adoRepo] = adoMatch;
            try {
              const { getAdoToken } = require('./engine/ado');
              const token = await getAdoToken();
              if (token) {
                const apiUrl = `https://dev.azure.com/${adoOrg}/${adoProj}/_apis/git/repositories/${adoRepo}/pullrequests/${prNum}?api-version=7.1`;
                const result = await shared.execAsync(`curl -s --max-time 10 -H "Authorization: Bearer ${token}" "${apiUrl}"`, { encoding: 'utf-8', timeout: 15000, windowsHide: true });
                const d = JSON.parse(result);
                prData = { title: d.title, description: d.description, branch: d.sourceRefName?.replace('refs/heads/', ''), author: d.createdBy?.displayName };
              }
            } catch { /* ADO token may not be available */ }
          }
          if (!prData) return;
          mutateJsonFileLocked(prPath, (prs) => {
            const pr = prs.find(p => p.id === prId);
            if (!pr) return prs;
            if (!title && prData.title) pr.title = prData.title.slice(0, 120);
            if (prData.description) pr.description = prData.description.slice(0, 500);
            if (!pr.branch && prData.branch) pr.branch = prData.branch;
            if (pr.agent === 'human' && prData.author) pr.agent = prData.author;
            return prs;
          }, { defaultValue: [] });
          invalidateStatusCache();
        } catch (e) {
          shared.log('warn', `PR link enrichment failed for ${prId}: ${e.message}`);
        }
      })();
    }},

    { method: 'POST', path: '/api/pull-requests/delete', desc: 'Remove a PR from tracking', params: 'id, project?', handler: async (req, res) => {
      const body = await readBody(req);
      const { id } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });
      reloadConfig();
      // Search all project PR files and central file
      const prPaths = [
        ...shared.getProjects(CONFIG).map(p => shared.projectPrPath(p)),
        path.join(MINIONS_DIR, 'pull-requests.json'),
      ];
      let found = false;
      for (const prPath of prPaths) {
        if (found) break;
        mutateJsonFileLocked(prPath, (prs) => {
          if (!Array.isArray(prs)) return prs;
          const idx = prs.findIndex(p => p.id === id);
          if (idx >= 0) { prs.splice(idx, 1); found = true; }
          return prs;
        }, { defaultValue: [] });
      }
      if (!found) return jsonReply(res, 404, { error: 'PR not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},

    { method: 'POST', path: '/api/plans/create', desc: 'Create a plan from user-provided content', params: 'title, content, project?', handler: async (req, res) => {
      const body = await readBody(req);
      const { title, content, project: projectName, meetingId } = body;
      if (!title || !content) return jsonReply(res, 400, { error: 'title and content required' });

      const plansDir = path.join(MINIONS_DIR, 'plans');
      if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
      const slug = shared.slugify(title);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-${date}.md`;
      const filePath = shared.uniquePath(path.join(plansDir, filename));

      const header = `# ${title}\n\n` +
        (projectName ? `**Project:** ${projectName}\n` : '') +
        (meetingId ? `**Source Meeting:** ${meetingId}\n` : '') +
        `**Created:** ${date}\n**By:** human teammate\n\n---\n\n`;
      safeWrite(filePath, header + content);

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, file: path.basename(filePath) });
    }},

    { method: 'POST', path: '/api/agents/charter', desc: 'Save agent charter', params: 'agent, content', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.agent || body.content == null) return jsonReply(res, 400, { error: 'agent and content required' });
      const agentId = body.agent.replace(/[^a-zA-Z0-9_-]/g, '');
      const charterDir = path.join(MINIONS_DIR, 'agents', agentId);
      if (!fs.existsSync(charterDir)) fs.mkdirSync(charterDir, { recursive: true });
      safeWrite(path.join(charterDir, 'charter.md'), body.content);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/agents/steer', desc: 'Inject steering message into a running agent', params: 'agent, message', handler: async (req, res) => {
      const body = await readBody(req);
      const { agent: agentId, message } = body;
      if (!agentId || !message) return jsonReply(res, 400, { error: 'agent and message required' });

      const steerPath = path.join(MINIONS_DIR, 'agents', agentId, 'steer.md');
      const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
      if (!fs.existsSync(agentDir)) return jsonReply(res, 404, { error: 'Agent not found' });

      // Write steering file
      safeWrite(steerPath, message);

      // Also append to live-output.log so it shows in the chat view
      const liveLogPath = path.join(agentDir, 'live-output.log');
      try { fs.appendFileSync(liveLogPath, '\n[human-steering] ' + message + '\n'); } catch { /* optional */ }

      return jsonReply(res, 200, { ok: true, message: 'Steering message sent' });
    }},
    { method: 'POST', path: '/api/agents/cancel', desc: 'Cancel an active agent by ID or task substring', params: 'agent?, task?', handler: handleAgentsCancel },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/live-stream(?:\?.*)?$/, desc: 'SSE real-time live output streaming', handler: handleAgentLiveStream },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/live(?:\?.*)?$/, desc: 'Tail live output for a working agent', params: 'tail? (bytes, default 8192)', handler: handleAgentLive },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/output(?:\?.*)?$/, desc: 'Fetch final output.log for an agent', handler: handleAgentOutput },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)$/, desc: 'Get detailed agent info', handler: handleAgentDetail },
    { method: 'GET', path: '/api/agent-output', desc: 'Read agent output log file', params: 'file', handler: async (req, res) => {
      const file = new URL(req.url, 'http://localhost').searchParams.get('file');
      if (!file || file.includes('..') || file.includes('\0') || !file.startsWith('agents/')) return jsonReply(res, 400, { error: 'invalid file' });
      const content = safeRead(path.join(MINIONS_DIR, file));
      if (content === null) return jsonReply(res, 404, { error: 'not found' });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(content);
    } },

    // Knowledge base
    { method: 'GET', path: '/api/knowledge', desc: 'List all knowledge base entries grouped by category', handler: handleKnowledgeList },
    { method: 'POST', path: '/api/knowledge', desc: 'Create a knowledge base entry', params: 'category, title, content', handler: async (req, res) => {
      const body = await readBody(req);
      const { category, title, content } = body;
      if (!category || !title || !content) return jsonReply(res, 400, { error: 'category, title, and content required' });
      const validCategories = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];
      if (!validCategories.includes(category)) return jsonReply(res, 400, { error: 'Invalid category. Must be: ' + validCategories.join(', ') });
      const slug = shared.slugify(title, 60);
      const filePath = path.join(MINIONS_DIR, 'knowledge', category, slug + '.md');
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const header = '# ' + title + '\n\n*Created by human teammate on ' + new Date().toISOString().slice(0, 10) + '*\n\n';
      safeWrite(filePath, header + content);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, path: filePath });
    }},
    { method: 'POST', path: '/api/knowledge/sweep', desc: 'Deduplicate, consolidate, and reorganize knowledge base', handler: handleKnowledgeSweep },
    { method: 'GET', path: /^\/api\/knowledge\/([^/]+)\/([^?]+)/, desc: 'Read a specific knowledge base entry', handler: handleKnowledgeRead },

    // Doc chat
    { method: 'POST', path: '/api/doc-chat', desc: 'Minions-aware doc Q&A + editing via CC session', params: 'message, document, title?, filePath?, selection?', handler: handleDocChat },

    // Inbox
    { method: 'POST', path: '/api/inbox/persist', desc: 'Promote an inbox item to team notes', params: 'name', handler: handleInboxPersist },
    { method: 'POST', path: '/api/inbox/promote-kb', desc: 'Promote an inbox item to the knowledge base', params: 'name, category', handler: handleInboxPromoteKb },
    { method: 'POST', path: '/api/inbox/open', desc: 'Open inbox file in file manager', params: 'name', handler: handleInboxOpen },
    { method: 'POST', path: '/api/inbox/delete', desc: 'Delete an inbox note', params: 'name', handler: handleInboxDelete },

    // Skills
    { method: 'GET', path: '/api/skill', desc: 'Read a skill file', params: 'file, source?, dir?', handler: handleSkillRead },

    // Projects
    { method: 'POST', path: '/api/projects/browse', desc: 'Open folder picker dialog, return selected path', handler: handleProjectsBrowse },
    { method: 'POST', path: '/api/projects/scan', desc: 'Scan a directory for git repos', params: 'path?, depth?', handler: handleProjectsScan },
    { method: 'POST', path: '/api/projects/add', desc: 'Auto-discover and add a project to config', params: 'path, name?', handler: handleProjectsAdd },

    // Bug Filing
    { method: 'POST', path: '/api/issues/create', desc: 'File a bug on the Minions repo (yemi33/minions)', params: 'title, description?, labels?', handler: handleFileBug },

    // Command Center
    { method: 'POST', path: '/api/command-center/new-session', desc: 'Clear active CC session', handler: handleCommandCenterNewSession },
    { method: 'POST', path: '/api/command-center', desc: 'Conversational command center with full minions context', params: 'message, sessionId?', handler: handleCommandCenter },
    { method: 'POST', path: '/api/command-center/stream', desc: 'Streaming CC — SSE with text chunks as they arrive', params: 'message, tabId?', handler: handleCommandCenterStream },
    { method: 'GET', path: '/api/cc-sessions', desc: 'List CC session metadata for all tabs', handler: handleCCSessionsList },
    { method: 'DELETE', path: /^\/api\/cc-sessions\/([\w-]+)$/, desc: 'Delete a CC session by tab ID', handler: handleCCSessionDelete },

    // Schedules
    { method: 'POST', path: '/api/schedules/parse-natural', desc: 'Parse natural language schedule text into cron expression', params: 'text', handler: handleSchedulesParseNatural },
    { method: 'GET', path: '/api/schedules', desc: 'Return schedules from config + last-run times', handler: handleSchedulesList },
    { method: 'POST', path: '/api/schedules', desc: 'Create a new schedule', params: 'cron, title, id?, type?, project?, agent?, description?, priority?, enabled?', handler: handleSchedulesCreate },
    { method: 'POST', path: '/api/schedules/update', desc: 'Update an existing schedule', params: 'id, cron?, title?, type?, project?, agent?, description?, priority?, enabled?', handler: handleSchedulesUpdate },
    { method: 'POST', path: '/api/schedules/delete', desc: 'Delete a schedule', params: 'id', handler: handleSchedulesDelete },

    // Pipelines
    { method: 'GET', path: '/api/pipelines', desc: 'List all pipelines with runs', handler: async (req, res) => {
      const { getPipelines, getPipelineRuns } = require('./engine/pipeline');
      const pipelines = getPipelines();
      const runs = getPipelineRuns();
      const result = pipelines.map(p => ({ ...p, runs: (runs[p.id] || []).slice(-5) }));
      return jsonReply(res, 200, result);
    }},
    { method: 'POST', path: '/api/pipelines', desc: 'Create a pipeline', params: 'id, title, stages[], trigger?, stopWhen?, monitoredResources?', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id || !body.title || !body.stages) return jsonReply(res, 400, { error: 'id, title, and stages required' });
      const { savePipeline, getPipeline } = require('./engine/pipeline');
      if (getPipeline(body.id)) return jsonReply(res, 409, { error: 'Pipeline already exists' });
      const pipeline = { id: body.id, title: body.title, stages: body.stages, trigger: body.trigger || {}, enabled: body.enabled !== false };
      if (body.stopWhen) pipeline.stopWhen = body.stopWhen;
      if (Array.isArray(body.monitoredResources) && body.monitoredResources.length > 0) pipeline.monitoredResources = body.monitoredResources;
      savePipeline(pipeline);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, id: pipeline.id });
    }},
    { method: 'POST', path: '/api/pipelines/update', desc: 'Update a pipeline', params: 'id, title?, stages?, trigger?, enabled?, stopWhen?, monitoredResources?', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { getPipeline, savePipeline } = require('./engine/pipeline');
      const pipeline = getPipeline(body.id);
      if (!pipeline) return jsonReply(res, 404, { error: 'Pipeline not found' });
      if (body.title !== undefined) pipeline.title = body.title;
      if (body.stages !== undefined) pipeline.stages = body.stages;
      if (body.trigger !== undefined) pipeline.trigger = body.trigger;
      if (body.enabled !== undefined) pipeline.enabled = body.enabled;
      if (body.monitoredResources !== undefined) pipeline.monitoredResources = body.monitoredResources;
      if (body.stopWhen !== undefined) pipeline.stopWhen = body.stopWhen;
      savePipeline(pipeline);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/pipelines/delete', desc: 'Delete a pipeline', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { deletePipeline } = require('./engine/pipeline');
      if (!deletePipeline(body.id)) return jsonReply(res, 404, { error: 'Pipeline not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/pipelines/trigger', desc: 'Manually trigger a pipeline run', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { getPipeline, getActiveRun, startRun } = require('./engine/pipeline');
      const pipeline = getPipeline(body.id);
      if (!pipeline) return jsonReply(res, 404, { error: 'Pipeline not found' });
      if (getActiveRun(body.id)) return jsonReply(res, 409, { error: 'Pipeline already has an active run' });
      const run = startRun(body.id, pipeline);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, runId: run.runId });
    }},
    { method: 'POST', path: '/api/pipelines/continue', desc: 'Continue a pipeline past a wait stage', params: 'id, stageId', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id || !body.stageId) return jsonReply(res, 400, { error: 'id and stageId required' });
      const { updateRunStage, getActiveRun } = require('./engine/pipeline');
      const run = getActiveRun(body.id);
      if (!run) return jsonReply(res, 404, { error: 'No active run' });
      if (run.stages[body.stageId]?.status !== 'waiting-human') return jsonReply(res, 400, { error: 'Stage is not waiting for human' });
      updateRunStage(body.id, run.runId, body.stageId, { status: 'completed', completedAt: new Date().toISOString() });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},

    { method: 'POST', path: '/api/pipelines/abort', desc: 'Abort an active pipeline run', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { getActiveRun, completeRun } = require('./engine/pipeline');
      const run = getActiveRun(body.id);
      if (!run) return jsonReply(res, 404, { error: 'No active run to abort' });
      completeRun(body.id, run.runId, 'failed');
      // Cancel pending/active work items and dispatches spawned by this run
      let cancelled = 0;
      const wiPaths = [path.join(MINIONS_DIR, 'work-items.json'), ...PROJECTS.map(p => shared.projectWorkItemsPath(p))];
      for (const wiPath of wiPaths) {
        try {
          mutateWorkItems(wiPath, items => {
            for (const w of items) {
              if (w._pipelineRun === run.runId && w.status !== shared.WI_STATUS.DONE && w.status !== shared.WI_STATUS.CANCELLED) {
                w.status = shared.WI_STATUS.CANCELLED;
                w._cancelledBy = 'pipeline-abort';
                cancelled++;
              }
            }
          });
        } catch {}
      }
      const dispatchCleaned = cleanDispatchEntries(d => d.meta?.item?._pipelineRun === run.runId);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, runId: run.runId, cancelledWorkItems: cancelled, cancelledDispatches: dispatchCleaned });
    }},
    { method: 'POST', path: '/api/pipelines/retrigger', desc: 'Abort active run (if any) and start a new one', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const pipeline = require('./engine/pipeline');
      const run = pipeline.getActiveRun(body.id);
      if (run) pipeline.completeRun(body.id, run.runId, 'failed');
      const pipelines = pipeline.getPipelines();
      const def = pipelines.find(p => p.id === body.id);
      if (!def) return jsonReply(res, 404, { error: 'Pipeline not found' });
      const newRun = pipeline.startRun(body.id, def);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, runId: newRun?.runId });
    }},

    // Meetings
    { method: 'POST', path: '/api/meetings', desc: 'Create a team meeting', params: 'title, agenda, participants[]', handler: async (req, res) => {
      const body = await readBody(req);
      const { title, agenda, participants } = body;
      if (!title || !agenda) return jsonReply(res, 400, { error: 'title and agenda required' });
      const { createMeeting } = require('./engine/meeting');
      const meeting = createMeeting({ title, agenda, participants: participants || [] });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, meeting });
    }},

    { method: 'GET', path: '/api/meetings', desc: 'List all meetings', handler: async (req, res) => {
      const { getMeetings } = require('./engine/meeting');
      return jsonReply(res, 200, { meetings: getMeetings() });
    }},

    { method: 'GET', path: /^\/api\/meetings\/(MTG-[\w]+)$/, desc: 'Get meeting detail', handler: async (req, res, match) => {
      const { getMeeting } = require('./engine/meeting');
      const meeting = getMeeting(match[1]);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found' });
      return jsonReply(res, 200, { meeting });
    }},

    { method: 'POST', path: '/api/meetings/note', desc: 'Add human note to active meeting', params: 'id, note', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id || !body.note) return jsonReply(res, 400, { error: 'id and note required' });
      const { addMeetingNote } = require('./engine/meeting');
      const meeting = addMeetingNote(body.id, body.note);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, meeting });
    }},

    { method: 'POST', path: '/api/meetings/advance', desc: 'Force advance meeting to next round', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { advanceMeetingRound } = require('./engine/meeting');
      const meeting = advanceMeetingRound(body.id);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found or already completed' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, meeting });
    }},

    { method: 'POST', path: '/api/meetings/end', desc: 'End a meeting early', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { endMeeting } = require('./engine/meeting');
      const meeting = endMeeting(body.id);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/meetings/archive', desc: 'Archive a meeting', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { archiveMeeting } = require('./engine/meeting');
      const meeting = archiveMeeting(body.id);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/meetings/unarchive', desc: 'Unarchive a meeting', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { unarchiveMeeting } = require('./engine/meeting');
      const meeting = unarchiveMeeting(body.id);
      if (!meeting) return jsonReply(res, 404, { error: 'Meeting not found or not archived' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},
    { method: 'POST', path: '/api/meetings/delete', desc: 'Delete a meeting', params: 'id', handler: async (req, res) => {
      const body = await readBody(req);
      if (!body.id) return jsonReply(res, 400, { error: 'id required' });
      const { deleteMeeting } = require('./engine/meeting');
      if (!deleteMeeting(body.id)) return jsonReply(res, 404, { error: 'Meeting not found' });
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true });
    }},

    // Engine
    { method: 'POST', path: '/api/engine/wakeup', desc: 'Trigger immediate engine tick via control.json signal', handler: async (req, res) => {
      const controlPath = path.join(MINIONS_DIR, 'engine', 'control.json');
      const control = shared.safeJson(controlPath) || {};
      control._wakeupAt = Date.now();
      shared.safeWrite(controlPath, control);
      return jsonReply(res, 200, { ok: true, message: 'Wakeup signal sent' });
    }},
    { method: 'POST', path: '/api/engine/restart', desc: 'Force-kill engine and restart immediately', handler: handleEngineRestart },

    // Settings
    { method: 'GET', path: '/api/settings', desc: 'Return current engine + claude + routing config', handler: handleSettingsRead },
    { method: 'POST', path: '/api/settings', desc: 'Update engine + claude + agent config', params: 'engine?, claude?, agents?', handler: handleSettingsUpdate },
    { method: 'POST', path: '/api/settings/routing', desc: 'Update routing.md', params: 'content', handler: handleSettingsRouting },
    { method: 'POST', path: '/api/settings/reset', desc: 'Reset engine + claude + agent settings to defaults', handler: handleSettingsReset },
  ];

  // ── Route Dispatcher ────────────────────────────────────────────────────────

  const pathname = req.url.split('?')[0];
  const _reqStart = Date.now();
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    if (typeof route.path === 'string') {
      // For /api/skill, match with query string prefix since it has no fixed path variant
      if (route.path === '/api/skill') {
        if (!req.url.startsWith('/api/skill?') && req.url !== '/api/skill') continue;
        const _result = await route.handler(req, res, {});
        if (pathname.startsWith('/api/') && !pathname.includes('/status') && !pathname.includes('/hot-reload') && !pathname.includes('/status-stream')) {
          console.log(`  ${req.method} ${pathname} ${Date.now() - _reqStart}ms`);
        }
        return _result;
      }
      if (pathname !== route.path) continue;
      const _result = await route.handler(req, res, {});
      if (pathname.startsWith('/api/') && !pathname.includes('/status') && !pathname.includes('/hot-reload') && !pathname.includes('/status-stream')) {
        console.log(`  ${req.method} ${pathname} ${Date.now() - _reqStart}ms`);
      }
      return _result;
    }
    const m = pathname.match(route.path);
    if (m) {
      const _result = await route.handler(req, res, m);
      if (pathname.startsWith('/api/') && !pathname.includes('/status') && !pathname.includes('/hot-reload') && !pathname.includes('/status-stream')) {
        console.log(`  ${req.method} ${pathname} ${Date.now() - _reqStart}ms`);
      }
      return _result;
    }
  }

  // Serve dashboard HTML with gzip + caching
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('ETag', HTML_ETAG);
  res.setHeader('Cache-Control', 'no-cache'); // revalidate each time, but use 304 if unchanged
  if (req.headers['if-none-match'] === HTML_ETAG) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const ae = req.headers['accept-encoding'] || '';
  if (ae.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(HTML_GZ);
  } else {
    res.end(HTML);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Minions Mission Control`);
  console.log(`  -----------------------------------`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`\n  Watching:`);
  console.log(`  Minions dir:  ${MINIONS_DIR}`);
  console.log(`  Projects:   ${PROJECTS.map(p => `${p.name} (${p.localPath})`).join(', ')}`);
  console.log(`\n  Auto-refreshes every 4s. Ctrl+C to stop.\n`);

  const { exec } = require('child_process');
  try {
    if (process.platform === 'win32') {
      exec(`start "" "http://localhost:${PORT}"`);
    } else if (process.platform === 'darwin') {
      exec(`open http://localhost:${PORT}`);
    } else {
      exec(`xdg-open http://localhost:${PORT}`);
    }
  } catch (e) {
    console.log(`  Could not auto-open browser: ${e.message}`);
    console.log(`  Please open http://localhost:${PORT} manually.`);
  }

  // ─── Engine Watchdog ─────────────────────────────────────────────────────
  // Every 30s, check if engine PID is alive. If dead but control.json says
  // running, auto-restart it. Prevents silent engine death.
  const { execSync } = require('child_process');
  setInterval(() => {
    try {
      const control = getEngineState();
      if (control.state !== 'running' || !control.pid) return;

      // Check if PID is alive
      let alive = false;
      try {
        if (process.platform === 'win32') {
          const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
          alive = out.includes(String(control.pid));
        } else {
          process.kill(control.pid, 0); // signal 0 = check existence
          alive = true;
        }
      } catch { alive = false; }

      if (!alive) {
        console.log(`[watchdog] Engine PID ${control.pid} is dead — auto-restarting...`);
        restartEngine();
      }
    } catch (e) {
      console.error(`[watchdog] Error: ${e.message}`);
    }
  }, 30000);
  console.log(`  Engine watchdog: active (checks every 30s)`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} already in use. Kill the existing process or change PORT.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

