/**
 * engine/queries.js — Shared read-only state queries for Minions engine + dashboard.
 * Single source of truth for all data reading/aggregation.
 * Both engine.js and dashboard.js require() this module.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const shared = require('./shared');

const { safeRead, safeReadDir, safeJson, safeWrite, getProjects,
  projectWorkItemsPath, projectPrPath, parseSkillFrontmatter, KB_CATEGORIES,
  WI_STATUS } = shared;

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

// ── Core State Readers ──────────────────────────────────────────────────────

function getConfig() {
  return safeJson(CONFIG_PATH) || {};
}

function getControl() {
  return safeJson(CONTROL_PATH) || { state: 'stopped', pid: null };
}

function getDispatch() {
  return safeJson(DISPATCH_PATH) || { pending: [], active: [], completed: [] };
}

function getDispatchQueue() {
  const d = getDispatch();
  const allCompleted = d.completed || [];
  d.completedTotal = allCompleted.length;
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
  return safeJson(path.join(ENGINE_DIR, 'metrics.json')) || {};
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
    // Detect permission-waiting: check live output for non-bypass permission mode
    try {
      const liveLog = shared.safeRead(path.join(AGENTS_DIR, agentId, 'live-output.log'));
      if (liveLog) {
        // Check init message for permission mode
        const initMatch = liveLog.match(/"permissionMode"\s*:\s*"([^"]+)"/);
        if (initMatch && initMatch[1] !== 'bypassPermissions') {
          result._permissionMode = initMatch[1];
        }
        // Check if agent has been silent for >60s (possible permission prompt wait)
        const lastLine = liveLog.trimEnd().split('\n').pop();
        if (lastLine && lastLine.includes('"type":"assistant"') && lastLine.includes('"tool_use"')) {
          const liveStat = fs.statSync(path.join(AGENTS_DIR, agentId, 'live-output.log'));
          const silentMs = Date.now() - liveStat.mtimeMs;
          if (silentMs > 60000 && result._permissionMode) {
            result._warning = 'Possibly waiting for permission approval — agent is not in bypass mode';
          }
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
        completed_at: latest.completed_at,
        resultSummary: latest.resultSummary || latest.reason || '',
      };
    }
  }

  // Fallback: derive active state from work-item markers.
  // This protects UI status when dispatch.json briefly desyncs from work-item files.
  try {
    const config = getConfig();
    const allItems = getWorkItems(config);
    const latestInFlight = allItems
      .filter(w =>
        (w.dispatched_to || '').toLowerCase() === String(agentId).toLowerCase() &&
        w.status === WI_STATUS.DISPATCHED
      )
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
    const inboxFiles = allInboxFiles.filter(f => f.includes(a.id));
    const s = getAgentStatus(a.id); // derives from dispatch.json

    let lastAction = 'Waiting for assignment';
    if (s.status === 'working') lastAction = `Working: ${s.task}`;
    else if (s.status === 'done') lastAction = `Done: ${s.task}`;
    else if (s.status === 'error') lastAction = `Error: ${s.task}`;
    else if (inboxFiles.length > 0) {
      const lastOutput = path.join(INBOX_DIR, inboxFiles[inboxFiles.length - 1]);
      try { lastAction = `Output: ${path.basename(lastOutput)} (${timeSince(fs.statSync(lastOutput).mtimeMs)})`; } catch { /* optional */ }
    }

    const chartered = fs.existsSync(path.join(AGENTS_DIR, a.id, 'charter.md'));
    if (lastAction.length > 120) lastAction = lastAction.slice(0, 120) + '...';
    return {
      ...a, status: s.status, lastAction,
      currentTask: (s.task || '').slice(0, 200),
      resultSummary: (s.resultSummary || '').slice(0, 500),
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
  const outputLog = safeRead(path.join(agentDir, 'output.log')) || '';

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
        completed_at: d.completed_at || '',
      }));
  } catch { /* optional */ }

  return { charter, history, statusData, outputLog, inboxContents, recentDispatches };
}

// ── Pull Requests ───────────────────────────────────────────────────────────

function getPrs(project) {
  if (project) return safeJson(projectPrPath(project)) || [];
  const config = getConfig();
  const all = [];
  for (const p of getProjects(config)) all.push(...getPrs(p));
  return all;
}

function getPullRequests(config) {
  config = config || getConfig();
  const projects = getProjects(config);
  const allPrs = [];
  for (const project of projects) {
    const prs = safeJson(projectPrPath(project));
    if (!prs) continue;
    const base = project.prUrlBase || '';
    for (const pr of prs) {
      if (!pr.url && base && pr.id) pr.url = base + String(pr.id).replace('PR-', '');
      pr._project = project.name || 'Project';
      allPrs.push(pr);
    }
  }
  // Also read central pull-requests.json (for manually linked PRs without a project)
  const centralPath = path.join(MINIONS_DIR, 'pull-requests.json');
  const centralPrs = safeJson(centralPath);
  if (centralPrs) {
    for (const pr of centralPrs) {
      if (!allPrs.some(p => p.id === pr.id)) {
        pr._project = 'central';
        allPrs.push(pr);
      }
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
  return allPrs;
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

function getKnowledgeBaseEntries() {
  const now = Date.now();
  if (_kbCache && (now - _kbCacheTs) < KB_CACHE_TTL) return _kbCache;

  const entries = [];
  for (const cat of KB_CATEGORIES) {
    const catDir = path.join(KNOWLEDGE_DIR, cat);
    const files = safeReadDir(catDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const content = safeRead(path.join(catDir, f)) || '';
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : f.replace(/\.md$/, '');
      const agentMatch = f.match(/^\d{4}-\d{2}-\d{2}-(\w+)-/);
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      entries.push({
        cat, file: f, title,
        agent: agentMatch ? agentMatch[1] : '',
        date: dateMatch ? dateMatch[1] : '',
        preview: content.slice(0, 200),
        size: content.length,
      });
    }
  }
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

  // Cross-reference with PRs
  const allPrs = getPullRequests(config);
  const dispatch = getDispatch();
  for (const item of allItems) {
    if (item._pr && !item._prUrl) {
      const prId = String(item._pr).replace('PR-', '');
      const pr = allPrs.find(p => String(p.id).includes(prId));
      if (pr) item._prUrl = pr.url;
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

function getPrdInfo(config) {
  config = config || getConfig();
  const projects = getProjects(config);
  let allPrdItems = [];
  let latestStat = null;

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
          const plan = safeJson(path.join(dir, pf));
          if (!plan || !plan.missing_features) continue;
          const stat = fs.statSync(path.join(dir, pf));
          if (!latestStat || stat.mtimeMs > latestStat.mtimeMs) latestStat = stat;
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
              _planStale: planStale || plan.planStale || false, _lastSyncedFromPlan: plan.lastSyncedFromPlan || null,
              _prdUpdatedAt: new Date(stat.mtimeMs).toISOString(),
              _prdCompletedAt: plan.completedAt || '',
            });
          }
        } catch { /* optional */ }
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
      const workItems = safeJson(projectWorkItemsPath(project)) || [];
      for (const wi of workItems) { if (!wi.id) { console.warn(`[queries] Skipping work item without id in ${project.name}:`, JSON.stringify(wi).slice(0, 120)); continue; } if (wi.sourcePlan) wiById[wi.id] = wi; }
    } catch { /* optional */ }
  }
  // Also check central work-items.json
  try {
    const centralWi = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
    for (const wi of centralWi) { if (!wi.id) { console.warn('[queries] Skipping central work item without id:', JSON.stringify(wi).slice(0, 120)); continue; } if (wi.sourcePlan && !wiById[wi.id]) wiById[wi.id] = wi; }
  } catch { /* optional */ }

  // PR-to-PRD linking — derived from PR.prdItems (single source of truth)
  const allPrs = getPullRequests(config);
  const prById = {};
  for (const pr of allPrs) prById[pr.id] = pr;

  const prdToPr = {};
  const prLinks = shared.getPrLinks(); // { "PR-xxxx": "P-xxxx" }
  for (const [prId, itemId] of Object.entries(prLinks)) {
    const pr = prById[prId];
    const project = projects.find(p => p.name === pr?._project) || projects[0] || null;
    const url = pr?.url || (project?.prUrlBase ? project.prUrlBase + prId.replace('PR-', '') : '');
    if (!prdToPr[itemId]) prdToPr[itemId] = [];
    prdToPr[itemId].push({ id: prId, url, title: pr?.title || '', status: pr?.status || 'active', _project: pr?._project || '' });
  }
  // Fallback: work item _pr field for anything still missing
  for (const wi of Object.values(wiById)) {
    if (!wi._pr || prdToPr[wi.id]?.length) continue;
    const pr = prById[wi._pr];
    const project = projects.find(p => p.name === wi.project || p.name === wi._source);
    const url = pr?.url || (project?.prUrlBase ? project.prUrlBase + wi._pr.replace('PR-', '') : '');
    prdToPr[wi.id] = [{ id: wi._pr, url, title: pr?.title || '', status: pr?.status || 'active', _project: project?.name || '' }];
  }

  // PRD JSON status is the source of truth — kept in sync with work item by syncPrdItemStatus.
  // Map from PRD JSON values to display values (pending → missing for undispatched items)
  // Augment each item with execution metadata from the work item.
  const statusDisplay = { pending: 'missing' };
  for (const item of items) {
    const wi = wiById[item.id];
    // Work item status is source of truth when available (PRD JSON may lag behind)
    const rawStatus = wi ? (wi.status || item.status) : item.status;
    item.status = statusDisplay[rawStatus] || rawStatus || 'missing';
    // Attach execution metadata for display (agent, PR link, fail reason)
    if (wi) {
      if (wi.dispatched_to) item._agent = wi.dispatched_to;
      if (wi.failReason) item._failReason = wi.failReason;
    }
  }

  const byStatus = {};
  items.forEach(item => { const s = item.status || 'missing'; byStatus[s] = byStatus[s] || []; byStatus[s].push(item); });
  const complete = (byStatus['done'] || []).length;
  const inProgress = (byStatus['dispatched'] || []).length;
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
      description: (i.description || '').slice(0, 200), projects: i.projects || [],
      prs: prdToPr[i.id] || [], depends_on: i.depends_on || [],
      project: i.project || '', source: i._source || '', planSummary: i._planSummary || '', planProject: i._planProject || '', planStatus: i._planStatus || 'active', _archived: i._archived || false, sourcePlan: i._sourcePlan || '',
      planStale: i._planStale || false, lastSyncedFromPlan: i._lastSyncedFromPlan || null, prdUpdatedAt: i._prdUpdatedAt || null, prdCompletedAt: i._prdCompletedAt || '',
    })),
  };

  const status = {
    exists: true, age: latestStat ? timeSince(latestStat.mtimeMs) : 'unknown',
    existing: 0, missing: items.filter(i => i.status === 'missing').length, questions: 0, summary: '',
    missingList: items.filter(i => i.status === 'missing').map(f => ({ id: f.id, name: f.name || f.title, priority: f.priority, complexity: f.estimated_complexity || f.size })),
  };

  return { progress, status };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Paths (for modules that need direct access)
  MINIONS_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, PLANS_DIR, PRD_DIR, SKILLS_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  CONFIG_PATH, CONTROL_PATH, DISPATCH_PATH, LOG_PATH, NOTES_PATH,

  // Helpers
  timeSince,

  // Core state
  getConfig, getControl, getDispatch, getDispatchQueue,
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

