#!/usr/bin/env node
/**
 * Squad Mission Control Dashboard
 * Run: node .squad/dashboard.js
 * Opens: http://localhost:7331
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
const SQUAD_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SQUAD_DIR, 'config.json'), 'utf8'));

// Multi-project support
function getProjects() {
  if (CONFIG.projects && Array.isArray(CONFIG.projects)) return CONFIG.projects;
  const proj = CONFIG.project || {};
  if (!proj.localPath) proj.localPath = path.resolve(SQUAD_DIR, '..');
  if (!proj.workSources) proj.workSources = CONFIG.workSources || {};
  return [proj];
}
const PROJECTS = getProjects();
const projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');

const HTML_RAW = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
const HTML = HTML_RAW.replace('Squad Mission Control', `Squad Mission Control — ${projectNames}`);

// -- Helpers --

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Atomic write with Windows EPERM retry (matches engine.js safeWrite)
function safeWrite(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.renameSync(tmp, p); return; } catch (e) {
        if (e.code === 'EPERM' && attempt < 4) {
          const delay = 50 * (attempt + 1);
          const start = Date.now(); while (Date.now() - start < delay) {}
          continue;
        }
      }
    }
    try { fs.unlinkSync(tmp); } catch {}
    safeWrite(p, content);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function timeSince(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// -- Data Collectors --

function getAgentDetail(id) {
  const agentDir = path.join(SQUAD_DIR, 'agents', id);
  const charter = safeRead(path.join(agentDir, 'charter.md')) || 'No charter found.';
  const history = safeRead(path.join(agentDir, 'history.md')) || 'No history yet.';
  const outputLog = safeRead(path.join(agentDir, 'output.log')) || '';

  const statusJson = safeRead(path.join(agentDir, 'status.json'));
  let statusData = null;
  if (statusJson) { try { statusData = JSON.parse(statusJson); } catch {} }

  const inboxDir = path.join(SQUAD_DIR, 'notes', 'inbox');
  const inboxContents = safeReadDir(inboxDir)
    .filter(f => f.includes(id))
    .map(f => ({ name: f, content: safeRead(path.join(inboxDir, f)) || '' }));

  // Recent completed dispatches for this agent (last 10)
  let recentDispatches = [];
  try {
    const dispatch = JSON.parse(safeRead(path.join(SQUAD_DIR, 'engine', 'dispatch.json')) || '{}');
    recentDispatches = (dispatch.completed || [])
      .filter(d => d.agent === id)
      .slice(-10)
      .reverse()
      .map(d => ({
        id: d.id,
        task: d.task || '',
        type: d.type || '',
        result: d.result || '',
        reason: d.reason || '',
        completed_at: d.completed_at || '',
      }));
  } catch {}

  return { charter, history, statusData, outputLog, inboxContents, recentDispatches };
}

function getAgents() {
  const roster = Object.entries(CONFIG.agents).map(([id, info]) => ({ id, ...info }));

  return roster.map(a => {
    const inboxFiles = safeReadDir(path.join(SQUAD_DIR, 'notes', 'inbox'))
      .filter(f => f.includes(a.id));

    let status = 'idle';
    let lastAction = 'Waiting for assignment';
    let currentTask = '';
    let resultSummary = '';

    const statusFile = safeRead(path.join(SQUAD_DIR, 'agents', a.id, 'status.json'));
    if (statusFile) {
      try {
        const sj = JSON.parse(statusFile);
        status = sj.status || 'idle';
        currentTask = sj.task || '';
        resultSummary = sj.resultSummary || '';
        if (sj.status === 'working') {
          lastAction = `Working: ${sj.task}`;
        } else if (sj.status === 'done') {
          lastAction = `Done: ${sj.task}`;
        }
      } catch {}
    }

    // Show recent inbox output as context, but don't override idle status
    if (status === 'idle' && inboxFiles.length > 0) {
      const lastOutput = path.join(SQUAD_DIR, 'notes', 'inbox', inboxFiles[inboxFiles.length - 1]);
      try {
        const stat = fs.statSync(lastOutput);
        lastAction = `Output: ${path.basename(lastOutput)} (${timeSince(stat.mtimeMs)})`;
      } catch {}
    }

    const chartered = fs.existsSync(path.join(SQUAD_DIR, 'agents', a.id, 'charter.md'));
    // Truncate lastAction to prevent UI overflow from corrupted data
    if (lastAction.length > 120) lastAction = lastAction.slice(0, 120) + '...';
    return { ...a, status, lastAction, currentTask: (currentTask || '').slice(0, 200), resultSummary: (resultSummary || '').slice(0, 500), chartered, inboxCount: inboxFiles.length };
  });
}

function getPrdInfo() {
  // Squad-level PRD — single file at ~/.squad/prd.json
  const prdPath = path.join(SQUAD_DIR, 'prd.json');
  if (!fs.existsSync(prdPath)) return { progress: null, status: null };

  try {
    const stat = fs.statSync(prdPath);
    const data = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
    const items = data.missing_features || [];

    const byStatus = {};
    items.forEach(item => {
      const s = item.status || 'missing';
      byStatus[s] = byStatus[s] || [];
      byStatus[s].push({ id: item.id, name: item.name || item.title, priority: item.priority, complexity: item.estimated_complexity || item.size, status: s });
    });

    const complete = (byStatus['complete'] || []).length + (byStatus['completed'] || []).length + (byStatus['implemented'] || []).length;
    const prCreated = (byStatus['pr-created'] || []).length;
    const inProgress = (byStatus['in-progress'] || []).length + (byStatus['dispatched'] || []).length;
    const planned = (byStatus['planned'] || []).length;
    const missing = (byStatus['missing'] || []).length;
    const total = items.length;
    const donePercent = total > 0 ? Math.round(((complete + prCreated) / total) * 100) : 0;

    // Build PRD item → PR lookup from all project PRs
    const allPrs = getPullRequests();
    const prdToPr = {};
    for (const pr of allPrs) {
      for (const itemId of (pr.prdItems || [])) {
        if (!prdToPr[itemId]) prdToPr[itemId] = [];
        prdToPr[itemId].push({ id: pr.id, url: pr.url, title: pr.title, status: pr.status });
      }
    }

    const progress = {
      total, complete, prCreated, inProgress, planned, missing, donePercent,
      items: items.map(i => ({
        id: i.id, name: i.name || i.title, priority: i.priority,
        complexity: i.estimated_complexity || i.size, status: i.status || 'missing',
        projects: i.projects || [],
        prs: prdToPr[i.id] || []
      })),
    };

    const status = {
      exists: true,
      age: timeSince(stat.mtimeMs),
      existing: data.existing_features?.length || 0,
      missing: data.missing_features?.length || 0,
      questions: data.open_questions?.length || 0,
      summary: data.summary || '',
      missingList: (data.missing_features || []).map(f => ({ id: f.id, name: f.name || f.title, priority: f.priority, complexity: f.estimated_complexity || f.size })),
    };

    return { progress, status };
  } catch {
    return { progress: null, status: { exists: true, age: 'unknown', error: true } };
  }
}

function getInbox() {
  const dir = path.join(SQUAD_DIR, 'notes', 'inbox');
  return safeReadDir(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const fullPath = path.join(dir, f);
      try {
        const stat = fs.statSync(fullPath);
        const content = safeRead(fullPath) || '';
        return { name: f, age: timeSince(stat.mtimeMs), mtime: stat.mtimeMs, content };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function getNotes() {
  return safeRead(path.join(SQUAD_DIR, 'notes.md')) || '';
}

function getPullRequests() {
  const allPrs = [];
  for (const project of PROJECTS) {
    const root = path.resolve(project.localPath || path.resolve(SQUAD_DIR, '..'));
    const prSrc = project.workSources?.pullRequests || CONFIG.workSources?.pullRequests || {};
    const prPath = path.resolve(root, prSrc.path || '.squad/pull-requests.json');
    const prFile = safeRead(prPath);
    if (!prFile) continue;
    try {
      const prs = JSON.parse(prFile);
      const base = project.prUrlBase || CONFIG.prUrlBase || '';
      for (const pr of prs) {
        if (!pr.url && base && pr.id) {
          pr.url = base + String(pr.id).replace('PR-', '');
        }
        pr._project = project.name || 'Project';
        allPrs.push(pr);
      }
    } catch {}
  }
  // Sort by created date descending
  allPrs.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return allPrs;
}

function getArchivedPrds() {
  const firstProject = PROJECTS[0];
  const root = path.resolve(firstProject.localPath || path.resolve(SQUAD_DIR, '..'));
  const prdSrc = firstProject.workSources?.prd || CONFIG.workSources?.prd || {};
  const prdDir = path.dirname(path.resolve(root, prdSrc.path || 'docs/prd-gaps.json'));
  const archiveDir = path.join(prdDir, 'archive');
  return safeReadDir(archiveDir)
    .filter(f => f.startsWith('prd-gaps') && f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'));
        const items = data.missing_features || [];
        return {
          file: f,
          version: data.version || f.replace('prd-gaps-', '').replace('.json', ''),
          summary: data.summary || '',
          total: items.length,
          existing_features: data.existing_features || [],
          missing_features: items,
          open_questions: data.open_questions || [],
        };
      } catch { return null; }
    })
    .filter(Boolean);
}

function getEngineState() {
  const controlPath = path.join(SQUAD_DIR, 'engine', 'control.json');
  const controlJson = safeRead(controlPath);
  if (!controlJson) return { state: 'stopped' };
  try { return JSON.parse(controlJson); } catch { return { state: 'stopped' }; }
}

function getDispatchQueue() {
  const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
  const dispatchJson = safeRead(dispatchPath);
  if (!dispatchJson) return { pending: [], active: [], completed: [] };
  try {
    const d = JSON.parse(dispatchJson);
    return {
      pending: d.pending || [],
      active: d.active || [],
      completed: (d.completed || []).slice(-20)
    };
  } catch { return { pending: [], active: [], completed: [] }; }
}

function getEngineLog() {
  const logPath = path.join(SQUAD_DIR, 'engine', 'log.json');
  const logJson = safeRead(logPath);
  if (!logJson) return [];
  try {
    const entries = JSON.parse(logJson);
    // Handle both formats: array or { entries: [] }
    const arr = Array.isArray(entries) ? entries : (entries.entries || []);
    return arr.slice(-50);
  } catch { return []; }
}

function getMetrics() {
  const metricsPath = path.join(SQUAD_DIR, 'engine', 'metrics.json');
  const data = safeRead(metricsPath);
  if (!data) return {};
  try { return JSON.parse(data); } catch { return {}; }
}

function getSkills() {
  const skillsDirs = [
    { dir: path.join(SQUAD_DIR, 'skills'), source: 'skills', scope: 'squad' },
  ];
  // Also scan project-level skills
  for (const p of PROJECTS) {
    const projectSkillsDir = path.resolve(p.localPath, '.claude', 'skills');
    skillsDirs.push({ dir: projectSkillsDir, source: 'project:' + p.name, scope: 'project', projectName: p.name });
  }
  const all = [];
  for (const { dir, source, scope, projectName } of skillsDirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md');
      for (const f of files) {
        const content = safeRead(path.join(dir, f)) || '';
        let name = f.replace('.md', '');
        let description = '', trigger = '', author = '', created = '', project = 'any', allowedTools = '';
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm = fmMatch[1];
          const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
          name = m('name') || name;
          description = m('description');
          trigger = m('trigger');
          author = m('author');
          created = m('created');
          project = m('project') || (scope === 'project' ? projectName : 'any');
          allowedTools = m('allowed-tools');
        }
        all.push({ name, description, trigger, author, created, project, allowedTools, file: f, source, scope });
      }
    } catch {}
  }
  return all;
}

function getWorkItems() {
  const allItems = [];

  // Central work items
  const centralPath = path.join(SQUAD_DIR, 'work-items.json');
  const centralData = safeRead(centralPath);
  if (centralData) {
    try {
      const items = JSON.parse(centralData);
      for (const item of items) {
        item._source = 'central';
        allItems.push(item);
      }
    } catch {}
  }

  // Per-project work items
  for (const project of PROJECTS) {
    const root = path.resolve(project.localPath || path.resolve(SQUAD_DIR, '..'));
    const wiSrc = project.workSources?.workItems || CONFIG.workSources?.workItems || {};
    const wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
    const data = safeRead(wiPath);
    if (data) {
      try {
        const items = JSON.parse(data);
        for (const item of items) {
          item._source = project.name || 'project';
          allItems.push(item);
        }
      } catch {}
    }
  }

  // Cross-reference with all PRs to find links — only for implement/fix types (not explore/review)
  const allPrs = getPullRequests();
  const prSpeculativeTypes = ['implement', 'fix', 'test', ''];
  for (const item of allItems) {
    // Check if item already has _pr from the JSON
    if (item._pr && !item._prUrl) {
      const prId = String(item._pr).replace('PR-', '');
      const pr = allPrs.find(p => String(p.id).includes(prId));
      if (pr) { item._prUrl = pr.url; }
    }
    // Always check PRs that explicitly reference this work item ID via prdItems
    if (!item._pr) {
      const linkedPr = allPrs.find(p => (p.prdItems || []).includes(item.id));
      if (linkedPr) {
        item._pr = linkedPr.id;
        item._prUrl = linkedPr.url;
      }
    }
    // Speculative fallback (agent status) — only for implement/fix/test types
    if (!item._pr && prSpeculativeTypes.includes(item.type || '')) {
      const dispatch = getDispatchQueue();
      const match = (dispatch.completed || []).find(d => d.meta?.item?.id === item.id && d.meta?.source?.includes('work-item'));
      if (match?.agent) {
        const statusFile = safeRead(path.join(SQUAD_DIR, 'agents', match.agent, 'status.json'));
        if (statusFile) {
          try {
            const s = JSON.parse(statusFile);
            if (s.pr) {
              item._pr = s.pr;
              const prId = String(s.pr).replace('PR-', '');
              const pr = allPrs.find(p => String(p.id).includes(prId));
              if (pr) item._prUrl = pr.url;
            }
          } catch {}
        }
      }
    }
  }

  // Sort: pending/queued first, then by created date desc
  const statusOrder = { pending: 0, queued: 0, dispatched: 1, done: 2 };
  allItems.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 1;
    const sb = statusOrder[b.status] ?? 1;
    if (sa !== sb) return sa - sb;
    return (b.created || '').localeCompare(a.created || '');
  });

  return allItems;
}

function getStatus() {
  const prdInfo = getPrdInfo();
  return {
    agents: getAgents(),
    prdProgress: prdInfo.progress,
    inbox: getInbox(),
    notes: getNotes(),
    prd: prdInfo.status,
    pullRequests: getPullRequests(),
    archivedPrds: getArchivedPrds(),
    engine: getEngineState(),
    dispatch: getDispatchQueue(),
    engineLog: getEngineLog(),
    metrics: getMetrics(),
    workItems: getWorkItems(),
    skills: getSkills(),
    projects: PROJECTS.map(p => ({ name: p.name, path: p.localPath, description: p.description || '' })),
    timestamp: new Date().toISOString(),
  };
}

// -- POST helpers --

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

function jsonReply(res, code, data) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = code;
  res.end(JSON.stringify(data));
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

  // POST /api/work-items/retry — reset a failed/dispatched item to pending
  if (req.method === 'POST' && req.url === '/api/work-items/retry') {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      // Find the right file
      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(SQUAD_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          const root = path.resolve(proj.localPath || path.resolve(SQUAD_DIR, '..'));
          const wiSrc = proj.workSources?.workItems || CONFIG.workSources?.workItems || {};
          wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const item = items.find(i => i.id === id);
      if (!item) return jsonReply(res, 404, { error: 'item not found' });

      item.status = 'pending';
      delete item.dispatched_at;
      delete item.dispatched_to;
      delete item.failReason;
      delete item.failedAt;
      delete item.fanOutAgents;
      safeWrite(wiPath, items);

      // Clear completed dispatch entries so the engine doesn't dedup this item
      const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
      try {
        const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
        if (dispatch.completed) {
          const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
          const dispatchKey = sourcePrefix + id;
          const before = dispatch.completed.length;
          dispatch.completed = dispatch.completed.filter(d => d.meta?.dispatchKey !== dispatchKey);
          // Also clear fan-out entries
          dispatch.completed = dispatch.completed.filter(d => !d.meta?.parentKey || d.meta.parentKey !== dispatchKey);
          if (dispatch.completed.length !== before) {
            safeWrite(dispatchPath, dispatch);
          }
        }
      } catch {}

      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/work-items/delete — remove a work item, kill agent, clear dispatch
  if (req.method === 'POST' && req.url === '/api/work-items/delete') {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      // Find the right work-items file
      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(SQUAD_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          const root = path.resolve(proj.localPath || path.resolve(SQUAD_DIR, '..'));
          const wiSrc = proj.workSources?.workItems || CONFIG.workSources?.workItems || {};
          wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) return jsonReply(res, 404, { error: 'item not found' });

      const item = items[idx];

      // Kill running agent process if dispatched
      if (item.dispatched_to) {
        const agentDir = path.join(SQUAD_DIR, 'agents', item.dispatched_to);
        const statusPath = path.join(agentDir, 'status.json');
        try {
          const status = JSON.parse(safeRead(statusPath) || '{}');
          if (status.pid) {
            try { process.kill(status.pid, 'SIGTERM'); } catch {}
          }
          // Reset agent to idle
          status.status = 'idle';
          delete status.currentTask;
          delete status.dispatched;
          safeWrite(statusPath, status);
        } catch {}
      }

      // Remove item from work-items file
      items.splice(idx, 1);
      safeWrite(wiPath, items);

      // Clear dispatch entries (pending, active, completed + fan-out)
      const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
      try {
        const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
        const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
        const dispatchKey = sourcePrefix + id;
        let changed = false;
        for (const queue of ['pending', 'active', 'completed']) {
          if (dispatch[queue]) {
            const before = dispatch[queue].length;
            dispatch[queue] = dispatch[queue].filter(d =>
              d.meta?.dispatchKey !== dispatchKey &&
              (!d.meta?.parentKey || d.meta.parentKey !== dispatchKey)
            );
            if (dispatch[queue].length !== before) changed = true;
          }
        }
        if (changed) {
          safeWrite(dispatchPath, dispatch);
        }
      } catch {}

      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/work-items/archive — move a completed/failed work item to archive
  if (req.method === 'POST' && req.url === '/api/work-items/archive') {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      let wiPath;
      if (!source || source === 'central') {
        wiPath = path.join(SQUAD_DIR, 'work-items.json');
      } else {
        const proj = PROJECTS.find(p => p.name === source);
        if (proj) {
          const root = path.resolve(proj.localPath || path.resolve(SQUAD_DIR, '..'));
          const wiSrc = proj.workSources?.workItems || CONFIG.workSources?.workItems || {};
          wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) return jsonReply(res, 404, { error: 'item not found' });

      const item = items.splice(idx, 1)[0];
      item.archivedAt = new Date().toISOString();

      // Append to archive file
      const archivePath = wiPath.replace('.json', '-archive.json');
      let archive = [];
      const existing = safeRead(archivePath);
      if (existing) { try { archive = JSON.parse(existing); } catch {} }
      archive.push(item);
      safeWrite(archivePath, archive);
      safeWrite(wiPath, items);

      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // GET /api/work-items/archive — list archived work items
  if (req.method === 'GET' && req.url === '/api/work-items/archive') {
    try {
      let allArchived = [];
      // Central archive
      const centralPath = path.join(SQUAD_DIR, 'work-items-archive.json');
      const central = safeRead(centralPath);
      if (central) { try { allArchived.push(...JSON.parse(central).map(i => ({ ...i, _source: 'central' }))); } catch {} }
      // Project archives
      for (const project of PROJECTS) {
        const root = path.resolve(project.localPath || path.resolve(SQUAD_DIR, '..'));
        const wiSrc = project.workSources?.workItems || CONFIG.workSources?.workItems || {};
        const archPath = path.resolve(root, (wiSrc.path || '.squad/work-items.json').replace('.json', '-archive.json'));
        const content = safeRead(archPath);
        if (content) { try { allArchived.push(...JSON.parse(content).map(i => ({ ...i, _source: project.name }))); } catch {} }
      }
      return jsonReply(res, 200, allArchived);
    } catch (e) { return jsonReply(res, 200, []); }
  }

  // POST /api/work-items
  if (req.method === 'POST' && req.url === '/api/work-items') {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      let wiPath;
      if (body.project) {
        // Write to project-specific queue
        const targetProject = PROJECTS.find(p => p.name === body.project) || PROJECTS[0];
        const root = path.resolve(targetProject.localPath || path.resolve(SQUAD_DIR, '..'));
        const wiSrc = targetProject.workSources?.workItems || CONFIG.workSources?.workItems || {};
        wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
      } else {
        // Write to central queue — agent decides which project
        wiPath = path.join(SQUAD_DIR, 'work-items.json');
      }
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }
      // Generate unique ID with project prefix to avoid collisions across sources
      const prefix = body.project ? body.project.slice(0, 3).toUpperCase() + '-' : '';
      const maxNum = items.reduce(function(max, i) {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const id = prefix + 'W' + String(maxNum + 1).padStart(3, '0');
      const item = {
        id, title: body.title, type: body.type || 'implement',
        priority: body.priority || 'medium', description: body.description || '',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard',
      };
      if (body.scope) item.scope = body.scope;
      if (body.agent) item.agent = body.agent;
      if (body.agents) item.agents = body.agents;
      items.push(item);
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/notes — write to inbox so it flows through normal consolidation
  if (req.method === 'POST' && req.url === '/api/notes') {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      const inboxDir = path.join(SQUAD_DIR, 'notes', 'inbox');
      fs.mkdirSync(inboxDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const author = body.author || os.userInfo().username;
      const slug = (body.title || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const filename = `${author}-${slug}-${today}.md`;
      const content = `# ${body.title}\n\n**By:** ${author}\n**Date:** ${today}\n\n${body.what}\n${body.why ? '\n**Why:** ' + body.why + '\n' : ''}`;
      safeWrite(path.join(inboxDir, filename), content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plan — create a plan work item that chains to PRD on completion
  if (req.method === 'POST' && req.url === '/api/plan') {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      // Write as a work item with type 'plan' — engine handles the chaining
      const wiPath = path.join(SQUAD_DIR, 'work-items.json');
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }
      const maxNum = items.reduce(function(max, i) {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const id = 'W' + String(maxNum + 1).padStart(3, '0');
      const item = {
        id, title: body.title, type: 'plan',
        priority: body.priority || 'high', description: body.description || '',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard',
        chain: 'plan-to-prd',
        branchStrategy: body.branch_strategy || 'shared-branch',
      };
      if (body.project) item.project = body.project;
      if (body.agent) item.agent = body.agent;
      items.push(item);
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, id, agent: body.agent || '' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items — squad-level PRD
  if (req.method === 'POST' && req.url === '/api/prd-items') {
    try {
      const body = await readBody(req);
      if (!body.name || !body.name.trim()) return jsonReply(res, 400, { error: 'name is required' });
      const prdPath = path.join(SQUAD_DIR, 'prd.json');
      let data = { missing_features: [], existing_features: [], open_questions: [] };
      const existing = safeRead(prdPath);
      if (existing) { try { data = JSON.parse(existing); } catch {} }
      if (!data.missing_features) data.missing_features = [];
      data.missing_features.push({
        id: body.id, name: body.name, description: body.description || '',
        priority: body.priority || 'medium', estimated_complexity: body.estimated_complexity || 'medium',
        rationale: body.rationale || '', status: 'missing', affected_areas: [],
        projects: body.projects || [],
      });
      safeWrite(prdPath, data);
      return jsonReply(res, 200, { ok: true, id: body.id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // GET /api/agent/:id/live — tail live output for a working agent
  const liveMatch = req.url.match(/^\/api\/agent\/([\w-]+)\/live(?:\?.*)?$/);
  if (liveMatch && req.method === 'GET') {
    const agentId = liveMatch[1];
    const livePath = path.join(SQUAD_DIR, 'agents', agentId, 'live-output.log');
    const content = safeRead(livePath);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!content) {
      res.end('No live output. Agent may not be running.');
    } else {
      // Return last N bytes via ?tail=N param (default last 8KB)
      const params = new URL(req.url, 'http://localhost').searchParams;
      const tailBytes = parseInt(params.get('tail')) || 8192;
      res.end(content.length > tailBytes ? content.slice(-tailBytes) : content);
    }
    return;
  }

  // GET /api/agent/:id/output — fetch final output.log for an agent
  const outputMatch = req.url.match(/^\/api\/agent\/([\w-]+)\/output(?:\?.*)?$/);
  if (outputMatch && req.method === 'GET') {
    const agentId = outputMatch[1];
    const outputPath = path.join(SQUAD_DIR, 'agents', agentId, 'output.log');
    const content = safeRead(outputPath);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'No output log found for this agent.');
    return;
  }

  // GET /api/notes-full — return full notes.md content
  if (req.method === 'GET' && req.url === '/api/notes-full') {
    const content = safeRead(path.join(SQUAD_DIR, 'notes.md'));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'No notes file found.');
    return;
  }

  // GET /api/knowledge — list all knowledge base entries grouped by category
  if (req.method === 'GET' && req.url === '/api/knowledge') {
    const kbDir = path.join(SQUAD_DIR, 'knowledge');
    const categories = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];
    const result = {};
    for (const cat of categories) {
      const catDir = path.join(kbDir, cat);
      const files = safeReadDir(catDir).filter(f => f.endsWith('.md')).sort().reverse();
      result[cat] = files.map(f => {
        const content = safeRead(path.join(catDir, f)) || '';
        // Extract title from first heading
        const titleMatch = content.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1] : f.replace(/\.md$/, '');
        // Extract agent and date from frontmatter
        const agentMatch = content.match(/^agent:\s*(.+)/m);
        const dateMatch = content.match(/^date:\s*(.+)/m);
        return {
          file: f,
          category: cat,
          title,
          agent: agentMatch ? agentMatch[1].trim() : '',
          date: dateMatch ? dateMatch[1].trim() : '',
          size: content.length,
          preview: content.replace(/^---[\s\S]*?---\n*/m, '').split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ').slice(0, 200),
        };
      });
    }
    return jsonReply(res, 200, result);
  }

  // GET /api/knowledge/:category/:file — read a specific knowledge base entry
  const kbMatch = req.url.match(/^\/api\/knowledge\/([^/]+)\/([^?]+)/);
  if (kbMatch && req.method === 'GET') {
    const cat = kbMatch[1];
    const file = decodeURIComponent(kbMatch[2]);
    // Prevent path traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return jsonReply(res, 400, { error: 'invalid file name' });
    }
    const content = safeRead(path.join(SQUAD_DIR, 'knowledge', cat, file));
    if (content === null) return jsonReply(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  // GET /api/plans — list all plan files with status
  if (req.method === 'GET' && req.url === '/api/plans') {
    const plansDir = path.join(SQUAD_DIR, 'plans');
    const files = safeReadDir(plansDir).filter(f => f.endsWith('.json'));
    const plans = files.map(f => {
      const plan = JSON.parse(safeRead(path.join(plansDir, f)) || '{}');
      return {
        file: f,
        project: plan.project || '',
        summary: plan.plan_summary || '',
        status: plan.status || 'active',
        branchStrategy: plan.branch_strategy || 'parallel',
        featureBranch: plan.feature_branch || '',
        itemCount: (plan.missing_features || []).length,
        generatedBy: plan.generated_by || '',
        generatedAt: plan.generated_at || '',
        requiresApproval: plan.requires_approval || false,
        revisionFeedback: plan.revision_feedback || null,
      };
    }).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return jsonReply(res, 200, plans);
  }

  // GET /api/plans/:file — read full plan JSON
  const planFileMatch = req.url.match(/^\/api\/plans\/([^?]+)$/);
  if (planFileMatch && req.method === 'GET') {
    const file = decodeURIComponent(planFileMatch[1]);
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return jsonReply(res, 400, { error: 'invalid' });
    const content = safeRead(path.join(SQUAD_DIR, 'plans', file));
    if (!content) return jsonReply(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  // POST /api/plans/approve — approve a plan for execution
  if (req.method === 'POST' && req.url === '/api/plans/approve') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'approved';
      plan.approvedAt = new Date().toISOString();
      plan.approvedBy = body.approvedBy || os.userInfo().username;
      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, status: 'approved' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/reject — reject a plan
  if (req.method === 'POST' && req.url === '/api/plans/reject') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'rejected';
      plan.rejectedAt = new Date().toISOString();
      plan.rejectedBy = body.rejectedBy || os.userInfo().username;
      if (body.reason) plan.rejectionReason = body.reason;
      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, status: 'rejected' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/revise — request revision with feedback, dispatches agent to revise
  if (req.method === 'POST' && req.url === '/api/plans/revise') {
    try {
      const body = await readBody(req);
      if (!body.file || !body.feedback) return jsonReply(res, 400, { error: 'file and feedback required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'revision-requested';
      plan.revision_feedback = body.feedback;
      plan.revisionRequestedAt = new Date().toISOString();
      plan.revisionRequestedBy = body.requestedBy || os.userInfo().username;
      safeWrite(planPath, plan);

      // Create a work item to revise the plan
      const wiPath = path.join(SQUAD_DIR, 'work-items.json');
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }
      const maxNum = items.reduce(function(max, i) {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const id = 'W' + String(maxNum + 1).padStart(3, '0');
      items.push({
        id, title: 'Revise plan: ' + (plan.plan_summary || body.file),
        type: 'plan-to-prd', priority: 'high',
        description: 'Revision requested on plan file: plans/' + body.file + '\n\nFeedback:\n' + body.feedback + '\n\nRevise the plan to address this feedback. Read the existing plan, apply the feedback, and overwrite the file with the updated version. Set status back to "awaiting-approval".',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard:revision',
        project: plan.project || '',
        planFile: body.file,
      });
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, status: 'revision-requested', workItemId: id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/inbox/persist — promote an inbox item to team notes
  if (req.method === 'POST' && req.url === '/api/inbox/persist') {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });

      const inboxPath = path.join(SQUAD_DIR, 'notes', 'inbox', name);
      const content = safeRead(inboxPath);
      if (!content) return jsonReply(res, 404, { error: 'inbox item not found' });

      // Extract a title from the first heading or first line
      const titleMatch = content.match(/^#+ (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : name.replace('.md', '');

      // Append to notes.md as a new team note
      const notesPath = path.join(SQUAD_DIR, 'notes.md');
      let notes = safeRead(notesPath) || '# Squad Notes\n\n## Active Notes\n';
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
      const archiveDir = path.join(SQUAD_DIR, 'notes', 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      try { fs.renameSync(inboxPath, path.join(archiveDir, `persisted-${name}`)); } catch {}

      return jsonReply(res, 200, { ok: true, title });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/inbox/open — open inbox file in Windows explorer
  if (req.method === 'POST' && req.url === '/api/inbox/open') {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid name' });
      }
      const filePath = path.join(SQUAD_DIR, 'notes', 'inbox', name);
      if (!fs.existsSync(filePath)) return jsonReply(res, 404, { error: 'file not found' });

      const { exec } = require('child_process');
      try {
        if (process.platform === 'win32') {
          exec(`explorer /select,"${filePath.replace(/\//g, '\\\\')}"`);
        } else if (process.platform === 'darwin') {
          exec(`open -R "${filePath}"`);
        } else {
          exec(`xdg-open "${path.dirname(filePath)}"`);
        }
      } catch (e) {
        return jsonReply(res, 500, { error: 'Could not open file manager: ' + e.message });
      }
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // GET /api/skill?file=<name>.md&source=skills|project:<name>
  if (req.method === 'GET' && req.url.startsWith('/api/skill?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const file = params.get('file');
    const source = params.get('source') || 'skills';
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      res.statusCode = 400; res.end('Invalid file'); return;
    }
    let skillDir;
    if (source.startsWith('project:')) {
      const projName = source.replace('project:', '');
      const proj = PROJECTS.find(p => p.name === projName);
      skillDir = proj ? path.resolve(proj.localPath, '.claude', 'skills') : null;
    } else {
      skillDir = path.join(SQUAD_DIR, 'skills');
    }
    const content = skillDir ? safeRead(path.join(skillDir, file)) : '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'Skill not found.');
    return;
  }

  // GET /api/health — lightweight health check for monitoring
  if (req.method === 'GET' && req.url === '/api/health') {
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

  const agentMatch = req.url.match(/^\/api\/agent\/([\w-]+)$/);
  if (agentMatch) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      res.end(JSON.stringify(getAgentDetail(agentMatch[1])));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/api/status') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      res.end(JSON.stringify(getStatus()));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/health — lightweight health check
  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      const engine = getEngineState();
      const agents = getAgents().map(a => ({ id: a.id, status: a.status }));
      const projects = PROJECTS.map(p => {
        let reachable = false;
        try { reachable = fs.existsSync(p.localPath); } catch {}
        return { name: p.name || 'Project', reachable };
      });

      const allIdle = agents.every(a => a.status === 'idle' || a.status === 'done');
      const engineStopped = engine.state === 'stopped';
      let status = 'healthy';
      if (engineStopped && !allIdle) status = 'degraded';
      if (engineStopped && projects.every(p => !p.reachable)) status = 'stopped';

      return jsonReply(res, 200, {
        status,
        engine: { state: engine.state || 'stopped', pid: engine.pid || null },
        agents,
        projects,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      return jsonReply(res, 500, { status: 'degraded', error: e.message, timestamp: new Date().toISOString() });
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(HTML);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Squad Mission Control`);
  console.log(`  -----------------------------------`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`\n  Watching:`);
  console.log(`  Squad dir:  ${SQUAD_DIR}`);
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
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} already in use. Kill the existing process or change PORT.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
