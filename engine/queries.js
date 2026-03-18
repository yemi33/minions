/**
 * engine/queries.js — Shared read-only state queries for Squad engine + dashboard.
 * Single source of truth for all data reading/aggregation.
 * Both engine.js and dashboard.js require() this module.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const { safeRead, safeReadDir, safeJson, safeWrite, getProjects,
  projectWorkItemsPath, projectPrPath, parseSkillFrontmatter, KB_CATEGORIES } = shared;

// ── Paths ───────────────────────────────────────────────────────────────────

const SQUAD_DIR = shared.SQUAD_DIR;
const AGENTS_DIR = path.join(SQUAD_DIR, 'agents');
const ENGINE_DIR = path.join(SQUAD_DIR, 'engine');
const INBOX_DIR = path.join(SQUAD_DIR, 'notes', 'inbox');
const PLANS_DIR = path.join(SQUAD_DIR, 'plans');
const PRD_DIR = path.join(SQUAD_DIR, 'prd');
const SKILLS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
const KNOWLEDGE_DIR = path.join(SQUAD_DIR, 'knowledge');
const ARCHIVE_DIR = path.join(SQUAD_DIR, 'notes', 'archive');

const CONFIG_PATH = path.join(SQUAD_DIR, 'config.json');
const CONTROL_PATH = path.join(ENGINE_DIR, 'control.json');
const DISPATCH_PATH = path.join(ENGINE_DIR, 'dispatch.json');
const LOG_PATH = path.join(ENGINE_DIR, 'log.json');
const NOTES_PATH = path.join(SQUAD_DIR, 'notes.md');

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
  d.completed = (d.completed || []).slice(-20);
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

function getAgentStatus(agentId) {
  return safeJson(path.join(AGENTS_DIR, agentId, 'status.json')) || {
    status: 'idle', task: null, started_at: null, completed_at: null
  };
}

function setAgentStatus(agentId, status) {
  if (status.task && typeof status.task === 'string') {
    if (status.task.includes('"session_id"') || status.task.includes('"is_error"') || status.task.includes('"uuid"')) {
      const cleanEnd = status.task.search(/[{"\[].*session_id|[{"\[].*is_error|[{"\[].*uuid/);
      status.task = cleanEnd > 10 ? status.task.slice(0, cleanEnd).trim() : status.task.slice(0, 80);
    }
    if (status.task.length > 200) status.task = status.task.slice(0, 200);
  }
  safeWrite(path.join(AGENTS_DIR, agentId, 'status.json'), status);
}

function getAgentCharter(agentId) {
  return safeRead(path.join(AGENTS_DIR, agentId, 'charter.md'));
}

function getAgents(config) {
  config = config || getConfig();
  const roster = Object.entries(config.agents || {}).map(([id, info]) => ({ id, ...info }));
  const allInboxFiles = safeReadDir(INBOX_DIR); // read once, not per-agent

  return roster.map(a => {
    const inboxFiles = allInboxFiles.filter(f => f.includes(a.id));

    let status = 'idle';
    let lastAction = 'Waiting for assignment';
    let currentTask = '';
    let resultSummary = '';

    const statusFile = safeRead(path.join(AGENTS_DIR, a.id, 'status.json'));
    if (statusFile) {
      try {
        const sj = JSON.parse(statusFile);
        status = sj.status || 'idle';
        currentTask = sj.task || '';
        resultSummary = sj.resultSummary || '';
        if (sj.status === 'working') lastAction = `Working: ${sj.task}`;
        else if (sj.status === 'done') lastAction = `Done: ${sj.task}`;
      } catch {}
    }

    if (status === 'idle' && inboxFiles.length > 0) {
      const lastOutput = path.join(INBOX_DIR, inboxFiles[inboxFiles.length - 1]);
      try {
        const stat = fs.statSync(lastOutput);
        lastAction = `Output: ${path.basename(lastOutput)} (${timeSince(stat.mtimeMs)})`;
      } catch {}
    }

    const chartered = fs.existsSync(path.join(AGENTS_DIR, a.id, 'charter.md'));
    if (lastAction.length > 120) lastAction = lastAction.slice(0, 120) + '...';
    return {
      ...a, status, lastAction,
      currentTask: (currentTask || '').slice(0, 200),
      resultSummary: (resultSummary || '').slice(0, 500),
      chartered, inboxCount: inboxFiles.length
    };
  });
}

function getAgentDetail(id) {
  const agentDir = path.join(AGENTS_DIR, id);
  const charter = safeRead(path.join(agentDir, 'charter.md')) || 'No charter found.';
  const history = safeRead(path.join(agentDir, 'history.md')) || 'No history yet.';
  const outputLog = safeRead(path.join(agentDir, 'output.log')) || '';

  const statusJson = safeRead(path.join(agentDir, 'status.json'));
  let statusData = null;
  if (statusJson) { try { statusData = JSON.parse(statusJson); } catch {} }

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
  } catch {}

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
  allPrs.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return allPrs;
}

// ── Skills ──────────────────────────────────────────────────────────────────

function collectSkillFiles(config) {
  config = config || getConfig();
  const skillFiles = [];
  const seen = new Set(); // dedup by name

  // 1. Claude Code native skills: ~/.claude/skills/<name>/SKILL.md
  const claudeSkillsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
  try {
    const dirs = fs.readdirSync(claudeSkillsDir).filter(d => {
      try { return fs.statSync(path.join(claudeSkillsDir, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      const skillFile = path.join(claudeSkillsDir, d, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        skillFiles.push({ file: 'SKILL.md', dir: path.join(claudeSkillsDir, d), scope: 'claude-code', skillName: d });
        seen.add(d);
      }
    }
  } catch {}

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
    } catch {}
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
        source: scope === 'claude-code' ? 'claude-code' : scope === 'project' ? 'project:' + projectName : 'squad',
        scope,
        autoGenerated: isAutoGenerated,
      });
    } catch {}
  }
  return all;
}

function getSkillIndex(config) {
  try {
    const skillFiles = collectSkillFiles(config);
    if (skillFiles.length === 0) return '';

    let index = '## Available Squad Skills\n\n';
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

function getKnowledgeBaseEntries() {
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
  const centralData = safeRead(path.join(SQUAD_DIR, 'work-items.json'));
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
      const linkedPr = allPrs.find(p => (p.prdItems || []).includes(item.id));
      if (linkedPr) { item._pr = linkedPr.id; item._prUrl = linkedPr.url; }
    }
    if (!item._pr && ['implement', 'fix', 'test', ''].includes(item.type || '')) {
      const match = (dispatch.completed || []).find(d => d.meta?.item?.id === item.id && d.meta?.source?.includes('work-item'));
      if (match?.agent) {
        const s = safeJson(path.join(AGENTS_DIR, match.agent, 'status.json'));
        if (s?.pr) {
          item._pr = s.pr;
          const prId = String(s.pr).replace('PR-', '');
          const pr = allPrs.find(p => String(p.id).includes(prId));
          if (pr) item._prUrl = pr.url;
        }
      }
    }
  }

  const statusOrder = { pending: 0, queued: 0, dispatched: 1, done: 2 };
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
          const plan = JSON.parse(fs.readFileSync(path.join(dir, pf), 'utf8'));
          if (!plan.missing_features) continue;
          const stat = fs.statSync(path.join(dir, pf));
          if (!latestStat || stat.mtimeMs > latestStat.mtimeMs) latestStat = stat;
          for (const f of plan.missing_features) {
            allPrdItems.push({
              ...f, _source: pf, _planStatus: plan.status || 'active',
              _planSummary: plan.plan_summary || pf, _planProject: plan.project || '',
              _archived: archived, _sourcePlan: plan.source_plan || '',
            });
          }
        } catch {}
      }
    } catch {}
  }

  if (allPrdItems.length === 0) return { progress: null, status: null };

  const items = allPrdItems;
  const total = items.length;

  // Build work item lookup — work item ID = PRD item ID
  const wiById = {};
  for (const project of projects) {
    try {
      const workItems = safeJson(projectWorkItemsPath(project)) || [];
      for (const wi of workItems) { if (wi.sourcePlan) wiById[wi.id] = wi; }
    } catch {}
  }

  // Override PRD item status from work items
  for (const item of items) {
    const wi = wiById[item.id];
    if (wi) {
      if (wi.status === 'done') item.status = 'implemented';
      else if (wi.status === 'failed') item.status = 'failed';
      else if (wi.status === 'dispatched') item.status = 'in-progress';
      else if (wi.status === 'pending') item.status = 'missing';
    }
  }

  const byStatus = {};
  items.forEach(item => { const s = item.status || 'missing'; byStatus[s] = byStatus[s] || []; byStatus[s].push(item); });
  const complete = (byStatus['complete'] || []).length + (byStatus['completed'] || []).length + (byStatus['implemented'] || []).length;
  const prCreated = (byStatus['pr-created'] || []).length;
  const inProgress = (byStatus['in-progress'] || []).length + (byStatus['dispatched'] || []).length;
  const planned = (byStatus['planned'] || []).length;
  const missing = (byStatus['missing'] || []).length;
  const donePercent = total > 0 ? Math.round(((complete + prCreated) / total) * 100) : 0;

  // PR-to-PRD linking — work item ID = PRD item ID, so prdItems directly reference PRD items
  const allPrs = getPullRequests(config);
  const prdToPr = {};
  for (const pr of allPrs) {
    for (const itemId of (pr.prdItems || [])) {
      if (!prdToPr[itemId]) prdToPr[itemId] = [];
      prdToPr[itemId].push({ id: pr.id, url: pr.url, title: pr.title, status: pr.status, _project: pr._project });
    }
  }

  // Plan timings
  const planTimings = {};
  for (const project of projects) {
    try {
      const workItems = safeJson(projectWorkItemsPath(project)) || [];
      for (const wi of workItems) {
        if (!wi.sourcePlan) continue;
        if (!planTimings[wi.sourcePlan]) planTimings[wi.sourcePlan] = { firstDispatched: null, lastCompleted: null, allDone: true };
        const t = planTimings[wi.sourcePlan];
        if (wi.dispatched_at) { const d = new Date(wi.dispatched_at).getTime(); if (!t.firstDispatched || d < t.firstDispatched) t.firstDispatched = d; }
        if (wi.completedAt) { const c = new Date(wi.completedAt).getTime(); if (!t.lastCompleted || c > t.lastCompleted) t.lastCompleted = c; }
        if (wi.status !== 'done') t.allDone = false;
      }
    } catch {}
  }

  const progress = {
    total, complete, prCreated, inProgress, planned, missing, donePercent, planTimings,
    items: items.map(i => ({
      id: i.id, name: i.name || i.title, priority: i.priority,
      complexity: i.estimated_complexity || i.size, status: i.status || 'missing',
      description: (i.description || '').slice(0, 200), projects: i.projects || [],
      prs: prdToPr[i.id] || [], depends_on: i.depends_on || [],
      source: i._source || '', planSummary: i._planSummary || '', planProject: i._planProject || '', planStatus: i._planStatus || 'active', _archived: i._archived || false, sourcePlan: i._sourcePlan || '',
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
  SQUAD_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, PLANS_DIR, PRD_DIR, SKILLS_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  CONFIG_PATH, CONTROL_PATH, DISPATCH_PATH, LOG_PATH, NOTES_PATH,

  // Helpers
  timeSince,

  // Core state
  getConfig, getControl, getDispatch, getDispatchQueue,
  getNotes, getNotesWithMeta, getEngineLog, getMetrics,

  // Inbox
  getInboxFiles, getInbox,

  // Agents
  getAgentStatus, setAgentStatus, getAgentCharter, getAgents, getAgentDetail,

  // Pull requests
  getPrs, getPullRequests,

  // Skills
  collectSkillFiles, getSkills, getSkillIndex,

  // Knowledge base
  getKnowledgeBaseEntries, getKnowledgeBaseIndex,

  // Work items & PRD
  getWorkItems, getPrdInfo,
};
