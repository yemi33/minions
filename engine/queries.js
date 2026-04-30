/**
 * engine/queries.js — Shared read-only state queries for Minions engine + dashboard.
 * Single source of truth for all data reading/aggregation.
 * Both engine.js and dashboard.js require() this module.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const shared = require('./shared');

const { safeRead, safeReadDir, safeJson, safeWrite, getProjects, mutateJsonFileLocked,
  projectWorkItemsPath, projectPrPath, parseSkillFrontmatter, KB_CATEGORIES,
  WI_STATUS, DONE_STATUSES, PRD_ITEM_STATUS, PR_STATUS, ENGINE_DEFAULTS, DEFAULT_AGENT_METRICS } = shared;

/**
 * Read the first `bytes` and last `bytes` of a file efficiently using byte offsets.
 * For files <= 2*bytes, reads the whole file. Returns { head, tail } strings.
 * Returns { head: '', tail: '' } on any error.
 */
function readHeadTail(filePath, bytes = 1024) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return { head: '', tail: '' };
    if (size <= bytes * 2) {
      const full = fs.readFileSync(filePath, 'utf8');
      return { head: full, tail: full };
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const headBuf = Buffer.alloc(bytes);
      fs.readSync(fd, headBuf, 0, bytes, 0);
      const tailBuf = Buffer.alloc(bytes);
      fs.readSync(fd, tailBuf, 0, bytes, size - bytes);
      return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8') };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { head: '', tail: '' };
  }
}

/**
 * Detect in-flight tool calls from live-output.log tail content.
 * Scans for task_started events with no matching task_notification (by task_id).
 * Returns { description, taskId } for the most recent in-flight tool, or null.
 */
function detectInFlightTool(tail) {
  if (!tail) return null;
  const lines = tail.split('\n');
  const completed = new Set();

  // Reverse scan: collect task_notification ids first (most recent lines),
  // then the first task_started not in completed is the in-flight tool.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"task_')) continue; // fast skip non-task lines
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'system') continue;
      if (parsed.subtype === 'task_notification') {
        completed.add(parsed.task_id);
      } else if (parsed.subtype === 'task_started' && !completed.has(parsed.task_id)) {
        return { description: parsed.description || null, taskId: parsed.task_id };
      }
    } catch { /* not valid JSON — skip heartbeats, headers, partial lines */ }
  }
  return null;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const MINIONS_DIR = shared.MINIONS_DIR;
const AGENTS_DIR = path.join(MINIONS_DIR, 'agents');
const ENGINE_DIR = path.join(MINIONS_DIR, 'engine');
const INBOX_DIR = path.join(MINIONS_DIR, 'notes', 'inbox');
const PLANS_DIR = path.join(MINIONS_DIR, 'plans');
const PRD_DIR = path.join(MINIONS_DIR, 'prd');
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const KNOWLEDGE_DIR = path.join(MINIONS_DIR, 'knowledge');
const ARCHIVE_DIR = path.join(MINIONS_DIR, 'notes', 'archive');

const CONFIG_PATH = path.join(MINIONS_DIR, 'config.json');
const CONTROL_PATH = path.join(ENGINE_DIR, 'control.json');
const DISPATCH_PATH = path.join(ENGINE_DIR, 'dispatch.json');
const LOG_PATH = path.join(ENGINE_DIR, 'log.json');
const NOTES_PATH = path.join(MINIONS_DIR, 'notes.md');

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeSince(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function readJsonNoRestore(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

// ── Core State Readers ──────────────────────────────────────────────────────

let _configPollKeyMigrationChecked = false;

function migrateDeprecatedConfigPollKeysOnce() {
  if (_configPollKeyMigrationChecked) return;
  const initial = safeJson(CONFIG_PATH);
  if (!initial || typeof initial !== 'object' || Array.isArray(initial)) {
    _configPollKeyMigrationChecked = true;
    return;
  }
  const engine = initial.engine;
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
    _configPollKeyMigrationChecked = true;
    return;
  }
  const hasOldStatus = engine.adoPollStatusEvery !== undefined;
  const hasOldComments = engine.adoPollCommentsEvery !== undefined;
  if (!hasOldStatus && !hasOldComments) {
    _configPollKeyMigrationChecked = true;
    return;
  }
  try {
    mutateJsonFileLocked(CONFIG_PATH, (config) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
      const nextEngine = config.engine;
      if (!nextEngine || typeof nextEngine !== 'object' || Array.isArray(nextEngine)) return config;
      if (nextEngine.prPollStatusEvery === undefined && nextEngine.adoPollStatusEvery !== undefined) {
        nextEngine.prPollStatusEvery = nextEngine.adoPollStatusEvery;
      }
      if (nextEngine.prPollCommentsEvery === undefined && nextEngine.adoPollCommentsEvery !== undefined) {
        nextEngine.prPollCommentsEvery = nextEngine.adoPollCommentsEvery;
      }
      delete nextEngine.adoPollStatusEvery;
      delete nextEngine.adoPollCommentsEvery;
      return config;
    });
    _configPollKeyMigrationChecked = true;
  } catch (e) {
    console.warn('[config] one-time prPoll migration failed:', e.message);
  }
}

function getConfig() {
  migrateDeprecatedConfigPollKeysOnce();
  return safeJson(CONFIG_PATH) || {};
}

function getControl() {
  return readJsonNoRestore(CONTROL_PATH) || { state: 'stopped', pid: null };
}

let _dispatchCache = null;
let _dispatchCacheAt = 0;
function getDispatch() {
  // Short-lived cache — dispatch.json is read 10+ times per tick but only changes on mutateDispatch
  const now = Date.now();
  if (_dispatchCache && (now - _dispatchCacheAt) < 2000) return _dispatchCache;
  _dispatchCache = readJsonNoRestore(DISPATCH_PATH) || { pending: [], active: [], completed: [] };
  _dispatchCacheAt = now;
  return _dispatchCache;
}
function invalidateDispatchCache() { _dispatchCache = null; _dispatchCacheAt = 0; }

function getDispatchQueue() {
  const d = getDispatch();
  const allCompleted = d.completed || [];
  // Lifetime total from metrics (dispatch.completed is capped at 100)
  const metrics = readJsonNoRestore(path.join(ENGINE_DIR, 'metrics.json')) || {};
  d.completedTotal = Object.entries(metrics).filter(([k]) => !k.startsWith('_')).reduce((sum, [, m]) => sum + (m.tasksCompleted || 0) + (m.tasksErrored || 0), 0);
  d.completed = allCompleted.slice(-20);
  return d;
}

function getNotes() {
  return safeRead(NOTES_PATH);
}

function getNotesWithMeta() {
  const content = safeRead(NOTES_PATH) || '';
  try {
    const stat = fs.statSync(NOTES_PATH);
    return { content, updatedAt: stat.mtimeMs };
  } catch { return { content, updatedAt: null }; }
}

function getEngineLog() {
  const logJson = safeRead(LOG_PATH);
  if (!logJson) return [];
  try {
    const entries = JSON.parse(logJson);
    const arr = Array.isArray(entries) ? entries : (entries.entries || []);
    return arr.slice(-50);
  } catch { return []; }
}

function getMetrics() {
  const metrics = readJsonNoRestore(path.join(ENGINE_DIR, 'metrics.json')) || {};

  for (const [agentId, m] of Object.entries(metrics)) {
    if (agentId.startsWith('_')) continue;
    metrics[agentId] = {
      ...DEFAULT_AGENT_METRICS,
      ...(m && typeof m === 'object' && !Array.isArray(m) ? m : {}),
    };
  }

  // Enrich agent PR counts from pull-requests.json (source of truth)
  const allPrs = getPullRequests();
  const prCountByAgent = {};
  const prApprovedByAgent = {};
  const prRejectedByAgent = {};
  for (const pr of allPrs) {
    const agent = (pr.agent || '').toLowerCase();
    if (!agent || agent.startsWith('temp-')) continue;
    prCountByAgent[agent] = (prCountByAgent[agent] || 0) + 1;
    if (pr.reviewStatus === 'approved' || pr.status === 'merged') prApprovedByAgent[agent] = (prApprovedByAgent[agent] || 0) + 1;
    if (pr.reviewStatus === 'rejected') prRejectedByAgent[agent] = (prRejectedByAgent[agent] || 0) + 1;
  }

  // Enrich agent runtime from completed dispatch entries
  const dispatch = getDispatch();
  const runtimeByAgent = {};
  const runtimeCountByAgent = {};
  for (const d of (dispatch.completed || [])) {
    const agent = d.agent;
    if (!agent || agent.startsWith('temp-')) continue;
    if (d.started_at && d.completed_at) {
      const ms = new Date(d.completed_at).getTime() - new Date(d.started_at).getTime();
      if (ms > 0) {
        runtimeByAgent[agent] = (runtimeByAgent[agent] || 0) + ms;
        runtimeCountByAgent[agent] = (runtimeCountByAgent[agent] || 0) + 1;
      }
    }
  }

  // Apply enrichments to agent metrics
  for (const [agentId, existing] of Object.entries(metrics)) {
    if (agentId.startsWith('_')) continue;
    const m = { ...DEFAULT_AGENT_METRICS, ...(existing && typeof existing === 'object' ? existing : {}) };
    metrics[agentId] = m;
    const lower = agentId.toLowerCase();
    if (prCountByAgent[lower] !== undefined) {
      m.prsCreated = prCountByAgent[lower];
      m.prsApproved = prApprovedByAgent[lower] || 0;
      m.prsRejected = prRejectedByAgent[lower] || 0;
    }
    if (runtimeByAgent[agentId]) {
      // Use dispatch history as source of truth — it has full history
      m.totalRuntimeMs = runtimeByAgent[agentId];
      m.timedTasks = runtimeCountByAgent[agentId];
    }
  }

  return metrics;
}

// ── Inbox ───────────────────────────────────────────────────────────────────

function getInboxFiles() {
  try { return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.md')); } catch { return []; }
}

function getInbox() {
  return safeReadDir(INBOX_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const fullPath = path.join(INBOX_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        const content = safeRead(fullPath) || '';
        return { name: f, age: timeSince(stat.mtimeMs), mtime: stat.mtimeMs, content };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// ── Agents ──────────────────────────────────────────────────────────────────

// Agent status is DERIVED from dispatch.json — single source of truth.
// dispatch.active entry for this agent → working
// dispatch.completed (most recent) → done/error
// neither → idle
// Metadata (resultSummary, verdict, pr) is carried on dispatch entries.
function getAgentStatus(agentId) {
  const dispatch = getDispatch();

  // Check active dispatch
  const active = (dispatch.active || []).find(d => d.agent === agentId);
  if (active) {
    const result = {
      status: 'working',
      task: active.task || '',
      dispatch_id: active.id,
      type: active.type || '',
      branch: active.meta?.branch || '',
      started_at: active.started_at || active.created_at || null,
    };
    // Surface any legacy blocking-tool annotation until timeout.js clears it.
    if (active._blockingToolCall) {
      result._blockingToolCall = active._blockingToolCall;
    }
    // Detect permission-waiting and in-flight tools: read only head+tail of live-output.log (max 2KB total)
    try {
      const liveLogPath = path.join(AGENTS_DIR, agentId, 'live-output.log');
      const { head, tail } = readHeadTail(liveLogPath, 1024);
      if (head) {
        // Check init message (in head) for permission mode
        const initMatch = head.match(/"permissionMode"\s*:\s*"([^"]+)"/);
        if (initMatch && initMatch[1] !== 'bypassPermissions') {
          result._permissionMode = initMatch[1];
        }
        // Check if agent has been silent for >60s (use tail for recent activity)
        const lastLine = tail.trimEnd().split('\n').pop();
        if (lastLine && lastLine.includes('"type":"assistant"') && lastLine.includes('"tool_use"')) {
          const liveStat = fs.statSync(liveLogPath);
          const silentMs = Date.now() - liveStat.mtimeMs;
          if (silentMs > 60000 && result._permissionMode) {
            result._warning = 'Possibly waiting for permission approval — agent is not in bypass mode';
          }
        }
        // Detect in-flight tool calls (task_started with no task_notification)
        const inFlight = detectInFlightTool(tail);
        if (inFlight && inFlight.description) {
          result._runningToolDescription = inFlight.description;
        }
      }
    } catch { /* optional — don't block status */ }
    return result;
  }

  // Check most recent completed dispatch (within last 5 minutes → show done/error)
  const completed = (dispatch.completed || [])
    .filter(d => d.agent === agentId)
    .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  if (completed.length > 0) {
    const latest = completed[0];
    const ageMs = latest.completed_at ? Date.now() - new Date(latest.completed_at).getTime() : Infinity;
    if (ageMs < 300000) { // 5 minutes
      return {
        status: latest.result === 'error' ? 'error' : 'done',
        task: latest.task || '',
        dispatch_id: latest.id,
        type: latest.type || '',
        started_at: latest.started_at || null,
        completed_at: latest.completed_at,
        resultSummary: latest.resultSummary || latest.reason || '',
      };
    }
  }

  // Fallback: derive active state from work-item markers.
  // This protects UI status when dispatch.json briefly desyncs from work-item files.
  // Guard: only trust dispatched state within 2x stale-orphan timeout to prevent stale
  // dispatched items from permanently showing an agent as working after a dead process.
  try {
    const config = getConfig();
    const staleOrphanTimeout = config.engine?.heartbeatTimeout || ENGINE_DEFAULTS.heartbeatTimeout;
    const staleThresholdMs = staleOrphanTimeout * 2;
    const now = Date.now();
    const allItems = getWorkItems(config);
    const latestInFlight = allItems
      .filter(w => {
        if ((w.dispatched_to || '').toLowerCase() !== String(agentId).toLowerCase()) return false;
        if (w.status !== WI_STATUS.DISPATCHED) return false;
        const ageMs = w.dispatched_at ? now - new Date(w.dispatched_at).getTime() : Infinity;
        return ageMs < staleThresholdMs;
      })
      .sort((a, b) => (b.dispatched_at || '').localeCompare(a.dispatched_at || ''))[0];
    if (latestInFlight) {
      return {
        status: 'working',
        task: latestInFlight.title || latestInFlight.id || '',
        dispatch_id: null,
        type: latestInFlight.type || '',
        branch: latestInFlight.branch || '',
        started_at: latestInFlight.dispatched_at || latestInFlight.created || null,
      };
    }
  } catch { /* optional */ }

  return { status: 'idle', task: null, started_at: null, completed_at: null };
}

// setAgentStatus removed — agent status is derived from dispatch.json.
// Status.json files no longer exist.

function getAgentCharter(agentId) {
  return safeRead(path.join(AGENTS_DIR, agentId, 'charter.md'));
}

function getAgents(config) {
  config = config || getConfig();
  // Fall back to DEFAULT_AGENTS if config has no agents (uninitialized repo)
  const agents = (config.agents && Object.keys(config.agents).length > 0)
    ? config.agents
    : shared.DEFAULT_AGENTS;
  const roster = Object.entries(agents).map(([id, info]) => ({ id, ...info }));

  // Include temp agents that are currently active so they show up in agent tiles
  const dispatch = getDispatch();
  const seen = new Set(roster.map(a => a.id));
  for (const d of (dispatch.active || [])) {
    if (d.agent && d.agent.startsWith('temp-') && !seen.has(d.agent)) {
      roster.push({ id: d.agent, name: d.agentName || d.agent, role: d.agentRole || 'Temp Agent', emoji: '\u{1F4A8}', skills: [], _temp: true });
      seen.add(d.agent);
    }
  }
  const allInboxFiles = safeReadDir(INBOX_DIR);

  return roster.map(a => {
    // Resolve which CLI runtime this agent dispatches to: per-agent override
    // → engine.defaultCli → 'claude'. Surfaced so the dashboard can show a
    // runtime tag next to the agent name.
    const runtime = shared.resolveAgentCli(a, config.engine || {});
    const inboxFiles = allInboxFiles.filter(f => f.includes(a.id));
    const s = getAgentStatus(a.id); // derives from dispatch.json

    let lastAction = 'Waiting for assignment';
    if (s.status === 'working') lastAction = s._runningToolDescription ? `Running: ${s._runningToolDescription}` : `Working: ${s.task}`;
    else if (s.status === 'done') lastAction = `Done: ${s.task}`;
    else if (s.status === 'error') lastAction = `Error: ${s.task}`;
    else if (inboxFiles.length > 0) {
      const lastOutput = path.join(INBOX_DIR, inboxFiles[inboxFiles.length - 1]);
      try { lastAction = `Output: ${path.basename(lastOutput)} (${timeSince(fs.statSync(lastOutput).mtimeMs)})`; } catch { /* optional */ }
    }

    const chartered = fs.existsSync(path.join(AGENTS_DIR, a.id, 'charter.md'));
    if (lastAction.length > 120) lastAction = lastAction.slice(0, 120) + '...';
    return {
      ...a, runtime, status: s.status, lastAction,
      currentTask: (s.task || '').slice(0, 200),
      resultSummary: (s.resultSummary || '').slice(0, 500),
      started_at: s.started_at || null,
      completed_at: s.completed_at || null,
      _blockingToolCall: s._blockingToolCall || null,
      _warning: s._warning || null,
      _permissionMode: s._permissionMode || null,
      chartered, inboxCount: inboxFiles.length
    };
  });
}

function getAgentDetail(id) {
  const agentDir = path.join(AGENTS_DIR, id);
  const charter = safeRead(path.join(agentDir, 'charter.md')) || 'No charter found.';
  const history = safeRead(path.join(agentDir, 'history.md')) || 'No history yet.';
  // Only send last 50KB of output.log — full logs can be megabytes and slow down the API
  let outputLog = safeRead(path.join(agentDir, 'output.log')) || '';
  if (outputLog.length > 50000) outputLog = '…(truncated — showing last 50KB)\n\n' + outputLog.slice(-50000);

  const statusData = getAgentStatus(id); // derives from dispatch.json

  const inboxContents = safeReadDir(INBOX_DIR)
    .filter(f => f.includes(id))
    .map(f => ({ name: f, content: safeRead(path.join(INBOX_DIR, f)) || '' }));

  let recentDispatches = [];
  try {
    const dispatch = getDispatch();
    recentDispatches = (dispatch.completed || [])
      .filter(d => d.agent === id)
      .slice(-10)
      .reverse()
      .map(d => ({
        id: d.id, task: d.task || '', type: d.type || '',
        result: d.result || '', reason: d.reason || '',
        started_at: d.started_at || '', completed_at: d.completed_at || '',
      }));
  } catch { /* optional */ }

  return { charter, history, statusData, outputLog, inboxContents, recentDispatches };
}

// ── Pull Requests ───────────────────────────────────────────────────────────

function getPrs(project) {
  if (project) {
    const prs = readJsonNoRestore(projectPrPath(project)) || [];
    shared.normalizePrRecords(prs, project);
    return prs;
  }
  const config = getConfig();
  const all = [];
  for (const p of getProjects(config)) all.push(...getPrs(p));
  return all;
}

// Cache: getPullRequests is called 3-5x per /api/status (getMetrics, getWorkItems,
// getPrdInfo, dashboard.js status + count). 1s TTL eliminates redundant fs reads
// within a single request without masking real updates from polling.
let _prsCache = null;
let _prsCacheAt = 0;

function getPullRequests(config) {
  const now = Date.now();
  if (_prsCache && (now - _prsCacheAt) < 1000) return _prsCache;
  config = config || getConfig();
  const projects = getProjects(config);
  const projectByName = new Map(projects.map(p => [p.name, p]));
  const allPrs = [];
  const seenIds = new Set();
  // Single pass over projects/* — configured projects use their full config
  // (prUrlBase fill-in, _project name); unconfigured subdirs are tagged _ghost
  // so engine code can filter them out. Mirrors what shared.getPrLinks scans,
  // so PRD links and PR records stay in sync after a project is removed.
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(path.join(MINIONS_DIR, 'projects'), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { /* projects dir missing */ }
  for (const dirName of projectDirs) {
    const project = projectByName.get(dirName) || null;
    const prPath = project ? projectPrPath(project) : path.join(MINIONS_DIR, 'projects', dirName, 'pull-requests.json');
    const prs = readJsonNoRestore(prPath);
    if (!Array.isArray(prs)) continue;
    shared.normalizePrRecords(prs, project);
    const base = project?.prUrlBase || '';
    for (const pr of prs) {
      if (!pr?.id || seenIds.has(pr.id)) continue;
      if (project && !pr.url && base) {
        const prNumber = shared.getPrNumber(pr);
        if (prNumber != null) pr.url = base + prNumber;
      }
      pr._project = project ? (project.name || 'Project') : dirName;
      if (!project) pr._ghost = true;
      allPrs.push(pr);
      seenIds.add(pr.id);
    }
  }
  // Central pull-requests.json — manually linked PRs without a project
  const centralPrs = readJsonNoRestore(path.join(MINIONS_DIR, 'pull-requests.json'));
  if (centralPrs) {
    shared.normalizePrRecords(centralPrs, null);
    for (const pr of centralPrs) {
      if (!pr?.id || seenIds.has(pr.id)) continue;
      pr._project = 'central';
      allPrs.push(pr);
      seenIds.add(pr.id);
    }
  }
  allPrs.sort((a, b) => {
    // Normalize to YYYY-MM-DD for date comparison (some have full ISO, some date-only)
    const aDate = (a.created || '').slice(0, 10);
    const bDate = (b.created || '').slice(0, 10);
    const dateComp = bDate.localeCompare(aDate);
    if (dateComp !== 0) return dateComp;
    // Same date — sort by PR number descending (newest first)
    const aNum = parseInt((a.id || '').replace(/\D/g, '')) || 0;
    const bNum = parseInt((b.id || '').replace(/\D/g, '')) || 0;
    return bNum - aNum;
  });
  _prsCache = allPrs;
  _prsCacheAt = now;
  return allPrs;
}

// Resolve a PR URL by preferring the canonical PR ID's own scope (e.g.
// `github:owner/repo#N`) so a github PR never gets an ADO URL just because the
// only configured project happens to be ADO. Falls back to a name-matched
// project's prUrlBase only when the ID is legacy (`PR-N`) and a real project
// owns it. Never blindly uses projects[0].
function buildPrUrlFromId(prId, pr, projects) {
  if (pr?.url) return pr.url;
  const canonical = shared.parseCanonicalPrId(prId);
  if (canonical) {
    const [host, rest] = canonical.scope.split(':');
    if (host === 'github') return `https://github.com/${rest}/pull/${canonical.prNumber}`;
    if (host === 'ado') {
      const [org, adoProject, repo] = rest.split('/');
      if (org && adoProject && repo) {
        return `https://dev.azure.com/${org}/${adoProject}/_git/${repo}/pullrequest/${canonical.prNumber}`;
      }
    }
  }
  const project = pr?._project ? projects.find(p => p.name === pr._project) : null;
  const prNumber = shared.getPrNumber(pr || prId);
  if (project?.prUrlBase && prNumber != null) return project.prUrlBase + prNumber;
  return '';
}

// ── Skills ──────────────────────────────────────────────────────────────────

function collectSkillFiles(config) {
  config = config || getConfig();
  const skillFiles = [];
  const seen = new Set(); // dedup by name

  // 1. Claude Code native skills: ~/.claude/skills/<name>/SKILL.md
  const homeDir = os.homedir();
  const claudeSkillsDir = path.join(homeDir, '.claude', 'skills');
  try {
    const dirs = fs.readdirSync(claudeSkillsDir).filter(d => {
      try { return fs.statSync(path.join(claudeSkillsDir, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      // Check both <name>/SKILL.md and <name>/skills/SKILL.md (Claude Code uses both)
      const skillFile = path.join(claudeSkillsDir, d, 'SKILL.md');
      const nestedSkillFile = path.join(claudeSkillsDir, d, 'skills', 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        skillFiles.push({ file: 'SKILL.md', dir: path.join(claudeSkillsDir, d), scope: 'claude-code', skillName: d });
        seen.add(d);
      } else if (fs.existsSync(nestedSkillFile)) {
        skillFiles.push({ file: 'SKILL.md', dir: path.join(claudeSkillsDir, d, 'skills'), scope: 'claude-code', skillName: d });
        seen.add(d);
      }
    }
  } catch { /* optional */ }

  // 1b. Installed plugin skills: ~/.claude/plugins/installed_plugins.json
  // Plugins use commands/*.md and/or skills/<name>/SKILL.md and/or skills/SKILL.md
  try {
    const pluginsFile = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
    const registry = JSON.parse(safeRead(pluginsFile) || '{}');
    for (const [pluginKey, installs] of Object.entries(registry.plugins || {})) {
      if (!Array.isArray(installs) || installs.length === 0) continue;
      const install = installs[0];
      if (!install.installPath) continue;
      const pluginName = pluginKey.split('@')[0];

      // commands/*.md (older style)
      const commandsDir = path.join(install.installPath, 'commands');
      try {
        const commands = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
        for (const cmd of commands) {
          const name = pluginName + ':' + cmd.replace('.md', '');
          if (seen.has(name)) continue;
          skillFiles.push({ file: cmd, dir: commandsDir, scope: 'plugin', skillName: name });
          seen.add(name);
        }
      } catch { /* optional */ }

      // skills/<name>/SKILL.md or skills/SKILL.md (newer style)
      const skillsDir = path.join(install.installPath, 'skills');
      try {
        const entries = fs.readdirSync(skillsDir);
        for (const entry of entries) {
          const entryPath = path.join(skillsDir, entry);
          if (entry === 'SKILL.md') {
            // Flat: skills/SKILL.md
            const name = pluginName;
            if (!seen.has(name)) {
              skillFiles.push({ file: 'SKILL.md', dir: skillsDir, scope: 'plugin', skillName: name });
              seen.add(name);
            }
          } else {
            try {
              if (!fs.statSync(entryPath).isDirectory()) continue;
            } catch { continue; }
            // Nested: skills/<name>/SKILL.md
            const nestedSkill = path.join(entryPath, 'SKILL.md');
            if (fs.existsSync(nestedSkill)) {
              const name = pluginName + ':' + entry;
              if (!seen.has(name)) {
                skillFiles.push({ file: 'SKILL.md', dir: entryPath, scope: 'plugin', skillName: name });
                seen.add(name);
              }
            }
          }
        }
      } catch { /* optional */ }
    }
  } catch { /* optional */ }

  // 2. Project-specific skills: <project>/.claude/skills/<name>.md or <name>/SKILL.md
  for (const project of getProjects(config)) {
    const projectSkillsDir = path.resolve(project.localPath, '.claude', 'skills');
    try {
      const entries = fs.readdirSync(projectSkillsDir);
      for (const entry of entries) {
        if (entry === 'README.md') continue;
        const entryPath = path.join(projectSkillsDir, entry);
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
          const skillFile = path.join(entryPath, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            skillFiles.push({ file: 'SKILL.md', dir: entryPath, scope: 'project', projectName: project.name, skillName: entry });
          }
        } else if (entry.endsWith('.md')) {
          skillFiles.push({ file: entry, dir: projectSkillsDir, scope: 'project', projectName: project.name });
        }
      }
    } catch { /* optional */ }
  }
  return skillFiles;
}

function getSkills(config) {
  const all = [];
  for (const { file: f, dir, scope, projectName, skillName } of collectSkillFiles(config)) {
    try {
      const content = safeRead(path.join(dir, f)) || '';
      const meta = parseSkillFrontmatter(content, skillName || f);
      if (scope === 'project' && meta.project === 'any') meta.project = projectName;
      // Check if auto-generated by an agent
      const isAutoGenerated = content.includes('Auto-extracted') || content.includes('author:') || content.includes('createdBy:');
      all.push({
        ...meta, file: f, dir: dir.replace(/\\/g, '/'),
        source: scope === 'claude-code' ? 'claude-code' : scope === 'plugin' ? 'plugin' : scope === 'project' ? 'project:' + projectName : 'minions',
        scope,
        autoGenerated: isAutoGenerated,
      });
    } catch { /* optional */ }
  }
  return all;
}

function getSkillIndex(config) {
  try {
    const skillFiles = collectSkillFiles(config);
    if (skillFiles.length === 0) return '';

    let index = '## Available Minions Skills\n\n';
    index += 'These are reusable workflows discovered by agents. Follow them when the trigger matches your task.\n\n';

    for (const { file: f, dir, scope, projectName } of skillFiles) {
      const content = safeRead(path.join(dir, f));
      const meta = parseSkillFrontmatter(content, f);
      index += `### ${meta.name}`;
      if (scope === 'project') index += ` (${projectName})`;
      index += '\n';
      if (meta.description) index += `${meta.description}\n`;
      if (meta.trigger) index += `**When:** ${meta.trigger}\n`;
      if (meta.project !== 'any') index += `**Project:** ${meta.project}\n`;
      index += `**File:** \`${dir}/${f}\`\n`;
      index += `Read the full skill file before following the steps.\n\n`;
    }
    return index;
  } catch { return ''; }
}

// ── Knowledge Base ──────────────────────────────────────────────────────────

let _kbCache = null;
let _kbCacheTs = 0;
const KB_CACHE_TTL = 30000; // 30s — KB changes infrequently

function invalidateKnowledgeBaseCache() {
  _kbCache = null;
  _kbCacheTs = 0;
}

function getKnowledgeBaseEntries() {
  const now = Date.now();
  if (_kbCache && (now - _kbCacheTs) < KB_CACHE_TTL) return _kbCache;

  const entries = [];
  for (const cat of KB_CATEGORIES) {
    const catDir = path.join(KNOWLEDGE_DIR, cat);
    const files = safeReadDir(catDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const filePath = path.join(catDir, f);
      const content = safeRead(filePath) || '';
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : f.replace(/\.md$/, '');
      const agentMatch = f.match(/^\d{4}-\d{2}-\d{2}-(\w+)-/);
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/) || content.match(/^date:\s*(\d{4}-\d{2}-\d{2})$/m);
      const sourceMatch = content.match(/^source:\s*(.+)/m);
      let sortTs = 0;
      try { sortTs = fs.statSync(filePath).mtimeMs || 0; } catch {}
      const displayDate = dateMatch ? dateMatch[1] : (sortTs ? new Date(sortTs).toISOString().slice(0, 10) : '');
      entries.push({
        cat, file: f, title,
        agent: agentMatch ? agentMatch[1] : '',
        date: displayDate,
        sortTs,
        source: sourceMatch ? sourceMatch[1].trim() : '',
        preview: content.slice(0, 200),
        size: content.length,
      });
    }
  }
  entries.sort((a, b) =>
    (b.sortTs || 0) - (a.sortTs || 0) ||
    (b.date || '').localeCompare(a.date || '') ||
    a.title.localeCompare(b.title)
  );
  _kbCache = entries;
  _kbCacheTs = now;
  return entries;
}

function getKnowledgeBaseIndex() {
  try {
    const entries = getKnowledgeBaseEntries();
    if (entries.length === 0) return '';
    let index = '## Knowledge Base Reference\n\n';
    index += 'Deep-reference docs from past work. Read the file if you need detail.\n\n';
    for (const e of entries) {
      index += `- \`knowledge/${e.cat}/${e.file}\` \u2014 ${e.title}\n`;
    }
    return index + '\n';
  } catch { return ''; }
}

// ── Work Items ──────────────────────────────────────────────────────────────

function getWorkItems(config) {
  config = config || getConfig();
  const projects = getProjects(config);
  const allItems = [];

  // Central work items
  const centralData = safeRead(path.join(MINIONS_DIR, 'work-items.json'));
  if (centralData) {
    try {
      for (const item of JSON.parse(centralData)) {
        item._source = 'central';
        allItems.push(item);
      }
    } catch {}
  }

  // Per-project work items
  for (const project of projects) {
    const data = safeRead(projectWorkItemsPath(project));
    if (data) {
      try {
        for (const item of JSON.parse(data)) {
          item._source = project.name || 'project';
          allItems.push(item);
        }
      } catch {}
    }
  }

  // Cross-reference with dispatch (fill in agent from active dispatch if missing on work item)
  const dispatch = getDispatch();
  const activeByWiId = new Map((dispatch.active || []).map(d => [d.meta?.item?.id, d.agent]));
  for (const item of allItems) {
    if (item.status === 'dispatched' && !item.dispatched_to && !item.agent) {
      const activeAgent = activeByWiId.get(item.id);
      if (activeAgent) item.dispatched_to = activeAgent;
    }
  }

  // Cross-reference with dispatch pending entries to surface skipReason + blockedBy (#617)
  const pendingByWiId = new Map();
  for (const d of (dispatch.pending || [])) {
    if (d.meta?.item?.id && d.skipReason) {
      pendingByWiId.set(d.meta.item.id, d);
    }
  }
  if (pendingByWiId.size > 0) {
    // Build branch → active agent name map for blockedBy lookup
    const branchToAgent = new Map();
    for (const d of (dispatch.active || [])) {
      if (d.meta?.branch) branchToAgent.set(d.meta.branch, d.agentName || d.agent || '');
    }
    for (const item of allItems) {
      const pendingEntry = pendingByWiId.get(item.id);
      if (!pendingEntry) continue;
      item._skipReason = pendingEntry.skipReason;
      if (pendingEntry.skipReason === 'branch_locked' && pendingEntry.meta?.branch) {
        const blocker = branchToAgent.get(pendingEntry.meta.branch);
        if (blocker) item._blockedBy = blocker;
      } else if (pendingEntry.skipReason === 'agent_busy') {
        const activeEntry = (dispatch.active || []).find(d => d.agent === pendingEntry.agent);
        if (activeEntry) item._blockedBy = activeEntry.agentName || activeEntry.agent || '';
      }
    }
  }

  // Cross-reference with PRs
  const allPrs = getPullRequests(config);
  for (const item of allItems) {
    if (item._pr && !item._prUrl) {
      const project = projects.find(p => p.name === item.project || p.name === item._source) || null;
      const canonicalPrId = shared.getCanonicalPrId(project, item._pr);
      const displayPrId = shared.getPrDisplayId(item._pr);
      const exactPr = allPrs.find(p => p.id === canonicalPrId);
      const displayMatches = exactPr ? [] : allPrs.filter(p => shared.getPrDisplayId(p) === displayPrId);
      const pr = exactPr || (displayMatches.length === 1 ? displayMatches[0] : null);
      if (pr) {
        item._pr = pr.id;
        item._prUrl = pr.url;
      }
    }
    if (!item._pr) {
      // Derive from PR.prdItems (single source of truth)
      const linkedPr = allPrs.find(p => (p.prdItems || []).includes(item.id));
      if (linkedPr) {
        item._pr = linkedPr.id;
        item._prUrl = linkedPr.url;
      }
    }
  }

  // Populate _artifacts for the work item detail modal
  // Build dispatch ID → work item ID lookup from completed dispatches
  const dispatchByWiId = {};
  for (const d of (dispatch.completed || [])) {
    const wiId = d.meta?.item?.id;
    if (wiId) dispatchByWiId[wiId] = d.id; // last completed dispatch wins
  }
  for (const d of (dispatch.active || [])) {
    const wiId = d.meta?.item?.id;
    if (wiId) dispatchByWiId[wiId] = d.id;
  }
  const _agentDirCache = {};
  const _inboxFiles = safeReadDir(INBOX_DIR);
  const _archiveFiles = safeReadDir(ARCHIVE_DIR);
  // Use cached KB entries (includes source frontmatter field)
  const _kbEntries = getKnowledgeBaseEntries();
  for (const item of allItems) {
    const arts = {};
    const agentId = item.dispatched_to || item.agent;
    if (agentId) {
      // Output log — match by dispatch ID (output-{dispatchId}.log)
      const dispatchId = dispatchByWiId[item.id];
      if (dispatchId) {
        if (!_agentDirCache[agentId]) {
          _agentDirCache[agentId] = safeReadDir(path.join(MINIONS_DIR, 'agents', agentId)).filter(f => f.startsWith('output-') && f.endsWith('.log'));
        }
        const matchLog = _agentDirCache[agentId].find(f => f.includes(dispatchId));
        if (matchLog) arts.outputLog = agentId + '/' + matchLog;
      }
      // Notes: inbox → KB (via source field) → archive (fallback if KB was swept)
      const itemId = item.id || '___';
      const matchInbox = _inboxFiles.filter(f => f.includes(agentId) && f.includes(itemId));
      const matchKb = _kbEntries.filter(kb => kb.source && kb.source.includes(agentId) && kb.source.includes(itemId));
      const allNotes = [
        ...matchInbox,
        ...matchKb.map(kb => 'kb:' + kb.cat + '/' + kb.file),
      ];
      // Archive fallback — only if nothing found in inbox or KB
      if (allNotes.length === 0) {
        const matchArchive = _archiveFiles.filter(f => f.includes(agentId) && f.includes(itemId));
        for (const f of matchArchive) allNotes.push('archive:' + f);
      }
      if (allNotes.length > 0) arts.notes = allNotes;
    }
    if (item.branch || item.featureBranch) arts.branch = item.branch || item.featureBranch;
    if (item.sourcePlan) arts.sourcePlan = item.sourcePlan;
    if (item._planFileName) arts.plan = item._planFileName;
    else if (item.planFile) arts.plan = item.planFile;
    if (item._pr) arts.pr = item._pr;
    if (Object.keys(arts).length > 0) item._artifacts = arts;
  }

  const statusOrder = {
    pending: 0,
    queued: 0,
    dispatched: 1,
    done: 3,
    failed: 4,
    paused: 5,
  };
  allItems.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 1;
    const sb = statusOrder[b.status] ?? 1;
    if (sa !== sb) return sa - sb;
    return (b.created || '').localeCompare(a.created || '');
  });

  return allItems;
}

// ── PRD Progress ────────────────────────────────────────────────────────────

// Module-level caches for getPrdInfo() — avoids re-reading unchanged PRD files
const _prdFileCache = new Map();       // filePath → { mtimeMs, plan }
let _prdDirMtimes = { prd: 0, archive: 0 }; // directory mtimes to detect new/deleted files
let _prdResultCache = null;            // cached final result
let _prdResultInputHash = '';          // hash of all input mtimes to detect any change

/**
 * Collect mtimes of all input files that affect getPrdInfo() output.
 * Returns a string hash for quick equality check plus the dir mtimes.
 */
function _getPrdInputHash(projects) {
  const mtimes = [];
  // PRD directory mtimes (detect new/deleted files)
  let prdDirMtime = 0, archiveDirMtime = 0;
  try { prdDirMtime = fs.statSync(PRD_DIR).mtimeMs; } catch { /* optional */ }
  const archiveDir = path.join(PRD_DIR, 'archive');
  try { archiveDirMtime = fs.statSync(archiveDir).mtimeMs; } catch { /* optional */ }
  mtimes.push(prdDirMtime, archiveDirMtime);
  // Work-items file mtimes (affect status display)
  for (const project of projects) {
    try { mtimes.push(fs.statSync(projectWorkItemsPath(project)).mtimeMs); } catch { mtimes.push(0); }
  }
  try { mtimes.push(fs.statSync(path.join(MINIONS_DIR, 'work-items.json')).mtimeMs); } catch { mtimes.push(0); }
  // PR file mtimes (affect PR links)
  for (const project of projects) {
    try { mtimes.push(fs.statSync(projectPrPath(project)).mtimeMs); } catch { mtimes.push(0); }
  }
  // Static pr-links.json overrides (affect shared.getPrLinks(); missing project mtimes otherwise)
  try { mtimes.push(fs.statSync(path.join(MINIONS_DIR, 'engine', 'pr-links.json')).mtimeMs); } catch { mtimes.push(0); }
  return { hash: mtimes.join(','), prdDirMtime, archiveDirMtime };
}

function getPrdInfo(config) {
  config = config || getConfig();
  const projects = getProjects(config);

  // Quick mtime check — return cached result if nothing changed
  const { hash, prdDirMtime, archiveDirMtime } = _getPrdInputHash(projects);
  if (_prdResultCache && hash === _prdResultInputHash) return _prdResultCache;

  let allPrdItems = [];
  let latestStat = null;

  // Check if directory listings need refresh
  const dirsChanged = prdDirMtime !== _prdDirMtimes.prd || archiveDirMtime !== _prdDirMtimes.archive;
  _prdDirMtimes = { prd: prdDirMtime, archive: archiveDirMtime };

  // Scan active PRDs and archived PRDs (completed PRDs still need to show progress)
  const planDirs = [
    { dir: PRD_DIR, archived: false },
    { dir: path.join(PRD_DIR, 'archive'), archived: true },
  ];
  for (const { dir, archived } of planDirs) {
    try {
      const planFiles = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const pf of planFiles) {
        try {
          const filePath = path.join(dir, pf);
          const stat = fs.statSync(filePath);
          if (!latestStat || stat.mtimeMs > latestStat.mtimeMs) latestStat = stat;

          // Per-file mtime cache: only re-read files that changed
          const cached = _prdFileCache.get(filePath);
          let plan;
          if (cached && cached.mtimeMs === stat.mtimeMs) {
            plan = cached.plan;
          } else {
            plan = readJsonNoRestore(filePath);
            _prdFileCache.set(filePath, { mtimeMs: stat.mtimeMs, plan });
          }
          if (!plan || !plan.missing_features) continue;

          // Staleness: compare source plan mtime to recorded sourcePlanModifiedAt
          let planStale = false;
          if (!archived && plan.source_plan) {
            try {
              const sourceMtime = Math.floor(fs.statSync(path.join(PLANS_DIR, plan.source_plan)).mtimeMs);
              const recorded = plan.sourcePlanModifiedAt ? new Date(plan.sourcePlanModifiedAt).getTime() : null;
              if (recorded && sourceMtime > recorded) planStale = true;
            } catch { /* optional */ }
          }
          for (const f of plan.missing_features) {
            allPrdItems.push({
              ...f, _source: pf, _planStatus: plan.status || 'active',
              _planSummary: plan.plan_summary || pf, _planProject: plan.project || '',
              _archived: archived, _sourcePlan: plan.source_plan || '',
              _branchStrategy: plan.branch_strategy || 'parallel',
              _planStale: planStale || plan.planStale || false, _lastSyncedFromPlan: plan.lastSyncedFromPlan || null,
              _prdUpdatedAt: new Date(stat.mtimeMs).toISOString(),
              _prdCompletedAt: plan.completedAt || '',
            });
          }
        } catch { /* optional */ }
      }
      // Clean stale entries from file cache when dirs changed
      if (dirsChanged) {
        for (const cachedPath of _prdFileCache.keys()) {
          if (cachedPath.startsWith(dir) && !fs.existsSync(cachedPath)) _prdFileCache.delete(cachedPath);
        }
      }
    } catch { /* optional */ }
  }

  if (allPrdItems.length === 0) return { progress: null, status: null };

  const items = allPrdItems;
  const total = items.length;

  // Build work item lookup — work item ID = PRD item ID
  const wiById = {};
  for (const project of projects) {
    try {
      const workItems = readJsonNoRestore(projectWorkItemsPath(project)) || [];
      for (const wi of workItems) { if (!wi?.id) { console.warn(`[queries] Skipping work item without id in ${project.name}:`, JSON.stringify(wi).slice(0, 120)); continue; } if (wi.sourcePlan) wiById[wi.id] = wi; }
    } catch { /* optional */ }
  }
  // Also check central work-items.json
  try {
    const centralWi = readJsonNoRestore(path.join(MINIONS_DIR, 'work-items.json')) || [];
    for (const wi of centralWi) { if (!wi?.id) { console.warn('[queries] Skipping central work item without id:', JSON.stringify(wi).slice(0, 120)); continue; } if (wi.sourcePlan && !wiById[wi.id]) wiById[wi.id] = wi; }
  } catch { /* optional */ }

  // PR-to-PRD linking — derived from PR.prdItems (single source of truth).
  // getPullRequests includes records from unconfigured project subdirs so PRD
  // links can resolve to last-known status even after a project is removed.
  const allPrs = getPullRequests(config);
  const prById = {};
  for (const pr of allPrs) prById[pr.id] = pr;

  const prdToPr = {};
  const prLinks = shared.getPrLinks(); // { "PR-xxxx": ["P-xxxx", "P-yyyy"] }
  for (const [prId, itemIds] of Object.entries(prLinks)) {
    const pr = prById[prId];
    // Skip aggregate / E2E PRs from per-item mapping — they link to multiple items
    // (or are typed as verify) and would bleed through as duplicate entries on every
    // constituent item. They are surfaced via renderE2eSection instead. (#1220)
    if ((itemIds || []).length > 1 || pr?.itemType === 'verify' || pr?.title?.startsWith('[E2E]')) continue;
    const url = buildPrUrlFromId(prId, pr, projects);
    for (const itemId of (itemIds || [])) {
      if (!prdToPr[itemId]) prdToPr[itemId] = [];
      prdToPr[itemId].push({ id: prId, url, title: pr?.title || '', status: pr?.status || PR_STATUS.ACTIVE, _project: pr?._project || '' });
    }
  }
  // Fallback: work item _pr field for anything still missing
  for (const wi of Object.values(wiById)) {
    if (!wi._pr || prdToPr[wi.id]?.length) continue;
    const project = projects.find(p => p.name === wi.project || p.name === wi._source) || null;
    const canonicalPrId = shared.getCanonicalPrId(project, wi._pr);
    const exactPr = prById[canonicalPrId] || null;
    const displayMatches = exactPr ? [] : Object.values(prById).filter(candidate => shared.getPrDisplayId(candidate) === shared.getPrDisplayId(wi._pr));
    const pr = exactPr || (displayMatches.length === 1 ? displayMatches[0] : null);
    const url = buildPrUrlFromId(canonicalPrId || wi._pr, pr, projects);
    prdToPr[wi.id] = [{ id: pr?.id || canonicalPrId || wi._pr, url, title: pr?.title || '', status: pr?.status || PR_STATUS.ACTIVE, _project: project?.name || '' }];
  }
  // Aggregate sub-task PRs to decomposed parent (sub-tasks aren't PRD items but their PRs should show)
  for (const pr of allPrs) {
    for (const itemId of (pr.prdItems || [])) {
      const allItems = Object.values(wiById);
      const wi = allItems.find(w => w.id === itemId && w.parent_id);
      if (!wi) continue;
      const parentId = wi.parent_id;
      if (!prdToPr[parentId]) prdToPr[parentId] = [];
      if (!prdToPr[parentId].some(p => p.id === pr.id)) {
        const url = buildPrUrlFromId(pr.id, pr, projects);
        prdToPr[parentId].push({ id: pr.id, url, title: pr.title || '', status: pr.status || PR_STATUS.ACTIVE, _project: pr._project || '' });
      }
    }
  }

  // PRD JSON status is the source of truth — kept in sync with work item by syncPrdItemStatus.
  // Map from PRD JSON values to display values (pending → missing for undispatched items)
  // Augment each item with execution metadata from the work item.
  const statusDisplay = { pending: 'missing', dispatched: 'in-progress' };
  for (const item of items) {
    const wi = wiById[item.id];
    // PRD 'updated'/'missing' = intentional rework signal — takes priority over a done work item (#930).
    // Otherwise work item status is source of truth when available (PRD JSON may lag behind).
    // If PRD says dispatched/failed but no work item exists, treat as pending (orphaned — #779)
    const prdFlaggedForRework = item.status === PRD_ITEM_STATUS.UPDATED || item.status === PRD_ITEM_STATUS.MISSING;
    const rawStatus = (wi && !(prdFlaggedForRework && DONE_STATUSES.has(wi.status)))
      ? (wi.status || item.status)
      : ((item.status === WI_STATUS.DISPATCHED || item.status === WI_STATUS.FAILED) ? WI_STATUS.PENDING : item.status);
    item.status = statusDisplay[rawStatus] || rawStatus || 'missing';
    // Attach execution metadata for display (agent, PR link, fail reason)
    if (wi) {
      if (wi.dispatched_to) item._agent = wi.dispatched_to;
      if (wi.failReason) item._failReason = wi.failReason;
    }
  }

  const byStatus = {};
  items.forEach(item => { const s = item.status || 'missing'; byStatus[s] = byStatus[s] || []; byStatus[s].push(item); });
  const complete = (byStatus['done'] || []).length + (byStatus['decomposed'] || []).length;
  const inProgress = (byStatus['in-progress'] || []).length;
  const paused = (byStatus['paused'] || []).length;
  const missing = (byStatus['missing'] || []).length;
  const donePercent = total > 0 ? Math.round((complete / total) * 100) : 0;

  // Plan timings — use wiById (already includes central work-items.json)
  const planTimings = {};
  for (const wi of Object.values(wiById)) {
    if (!wi.sourcePlan) continue;
    if (!planTimings[wi.sourcePlan]) planTimings[wi.sourcePlan] = { firstDispatched: null, lastCompleted: null, allDone: true };
    const t = planTimings[wi.sourcePlan];
    if (wi.dispatched_at) { const d = new Date(wi.dispatched_at).getTime(); if (!t.firstDispatched || d < t.firstDispatched) t.firstDispatched = d; }
    if (wi.completedAt) { const c = new Date(wi.completedAt).getTime(); if (!t.lastCompleted || c > t.lastCompleted) t.lastCompleted = c; }
    if (wi.status !== 'done') t.allDone = false;
  }

  const progress = {
    total, complete, inProgress, paused, missing, donePercent, planTimings,
    items: items.map(i => ({
      id: i.id, name: i.name || i.title, priority: i.priority,
      complexity: i.estimated_complexity || i.size, status: i.status || 'missing',
      description: i.description || '', projects: i.projects || [],
      prs: prdToPr[i.id] || [], depends_on: i.depends_on || [],
      project: i.project || '', source: i._source || '', planSummary: i._planSummary || '', planProject: i._planProject || '', planStatus: i._planStatus || 'active', _archived: i._archived || false, sourcePlan: i._sourcePlan || '',
      branchStrategy: i._branchStrategy || 'parallel',
      planStale: i._planStale || false, lastSyncedFromPlan: i._lastSyncedFromPlan || null, prdUpdatedAt: i._prdUpdatedAt || null, prdCompletedAt: i._prdCompletedAt || '',
      agent: i._agent || '', failReason: i._failReason || '',
    })),
  };

  const status = {
    exists: true, age: latestStat ? timeSince(latestStat.mtimeMs) : 'unknown',
    existing: 0, missing: items.filter(i => i.status === 'missing').length, questions: 0, summary: '',
    missingList: items.filter(i => i.status === 'missing').map(f => ({ id: f.id, name: f.name || f.title, priority: f.priority, complexity: f.estimated_complexity || f.size })),
  };

  const result = { progress, status };
  _prdResultCache = result;
  _prdResultInputHash = hash;
  return result;
}

/** Reset PRD info cache — exported for testing */
function resetPrdInfoCache() {
  _prdFileCache.clear();
  _prdDirMtimes = { prd: 0, archive: 0 };
  _prdResultCache = null;
  _prdResultInputHash = '';
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Paths (for modules that need direct access)
  MINIONS_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, PLANS_DIR, PRD_DIR, SKILLS_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  CONFIG_PATH, CONTROL_PATH, DISPATCH_PATH, LOG_PATH, NOTES_PATH,

  // Helpers
  timeSince,
  readHeadTail, // exported for testing
  detectInFlightTool, // exported for testing
  resetPrdInfoCache,
  invalidateKnowledgeBaseCache,

  // Core state
  getConfig, getControl, getDispatch, getDispatchQueue, invalidateDispatchCache,
  getNotes, getNotesWithMeta, getEngineLog, getMetrics,

  // Inbox
  getInboxFiles, getInbox,

  // Agents
  getAgentStatus, getAgentCharter, getAgents, getAgentDetail,

  // Pull requests
  getPrs, getPullRequests,

  // Skills
  collectSkillFiles, getSkills, getSkillIndex,

  // Knowledge base
  getKnowledgeBaseEntries, getKnowledgeBaseIndex,

  // Work items & PRD
  getWorkItems, getPrdInfo,
};
