#!/usr/bin/env node
/**
 * Squad Mission Control Dashboard
 * Run: node .squad/dashboard.js
 * Opens: http://localhost:7331
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

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
const HTML = HTML_RAW.replace(/OfficeAgent/g, projectNames);

// -- Helpers --

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
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
  const outputLog = safeRead(path.join(agentDir, 'output.md')) || '';

  const statusJson = safeRead(path.join(agentDir, 'status.json'));
  let statusData = null;
  if (statusJson) { try { statusData = JSON.parse(statusJson); } catch {} }

  const inboxDir = path.join(SQUAD_DIR, 'decisions', 'inbox');
  const inboxContents = safeReadDir(inboxDir)
    .filter(f => f.includes(id))
    .map(f => ({ name: f, content: safeRead(path.join(inboxDir, f)) || '' }));

  return { charter, history, statusData, outputLog, inboxContents };
}

function getAgents() {
  const roster = Object.entries(CONFIG.agents).map(([id, info]) => ({ id, ...info }));

  return roster.map(a => {
    const inboxFiles = safeReadDir(path.join(SQUAD_DIR, 'decisions', 'inbox'))
      .filter(f => f.includes(a.id));

    let status = 'idle';
    let lastAction = 'Waiting for assignment';
    let currentTask = '';

    const statusFile = safeRead(path.join(SQUAD_DIR, 'agents', a.id, 'status.json'));
    if (statusFile) {
      try {
        const sj = JSON.parse(statusFile);
        status = sj.status || 'idle';
        currentTask = sj.task || '';
        if (sj.status === 'working') {
          lastAction = `Working: ${sj.task}`;
        } else if (sj.status === 'done') {
          lastAction = `Done: ${sj.task}`;
        }
      } catch {}
    }

    if (status === 'idle' && inboxFiles.length > 0) {
      const lastOutput = path.join(SQUAD_DIR, 'decisions', 'inbox', inboxFiles[inboxFiles.length - 1]);
      try {
        const stat = fs.statSync(lastOutput);
        status = 'done';
        lastAction = `Output: ${path.basename(lastOutput)} (${timeSince(stat.mtimeMs)})`;
      } catch {}
    }

    const chartered = fs.existsSync(path.join(SQUAD_DIR, 'agents', a.id, 'charter.md'));
    return { ...a, status, lastAction, currentTask, chartered, inboxCount: inboxFiles.length };
  });
}

function getPrdInfo() {
  // Aggregate PRD across all projects
  const firstProject = PROJECTS[0];
  const root = path.resolve(firstProject.localPath || path.resolve(SQUAD_DIR, '..'));
  const prdSrc = firstProject.workSources?.prd || CONFIG.workSources?.prd || {};
  const prdPath = path.resolve(root, prdSrc.path || 'docs/prd-gaps.json');
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

    const complete = (byStatus['complete'] || []).length;
    const prCreated = (byStatus['pr-created'] || []).length;
    const inProgress = (byStatus['in-progress'] || []).length;
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
  const dir = path.join(SQUAD_DIR, 'decisions', 'inbox');
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

function getDecisions() {
  const content = safeRead(path.join(SQUAD_DIR, 'decisions.md')) || '';
  return content.split('\n').filter(l => l.startsWith('### ')).map(l => l.replace('### ', '').trim());
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

function getRunbooks() {
  const runbooksDir = path.join(SQUAD_DIR, 'runbooks');
  try {
    const files = fs.readdirSync(runbooksDir).filter(f => f.endsWith('.md') && f !== 'README.md');
    return files.map(f => {
      const content = safeRead(path.join(runbooksDir, f)) || '';
      let name = f.replace('.md', '');
      let trigger = '', author = '', created = '', project = 'any';
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
        name = m('name') || name;
        trigger = m('trigger');
        author = m('author');
        created = m('created');
        project = m('project') || 'any';
      }
      return { name, trigger, author, created, project, file: f };
    });
  } catch { return []; }
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

  // Cross-reference with dispatch completed to find PRs created
  const dispatch = getDispatchQueue();
  const completed = dispatch.completed || [];
  for (const item of allItems) {
    const match = completed.find(d => d.meta?.item?.id === item.id && d.meta?.source?.includes('work-item'));
    if (match) {
      // Check agent status for PR info
      if (match.agent) {
        const statusFile = safeRead(path.join(SQUAD_DIR, 'agents', match.agent, 'status.json'));
        if (statusFile) {
          try {
            const s = JSON.parse(statusFile);
            if (s.pr) item._pr = s.pr;
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
    decisions: getDecisions(),
    prd: prdInfo.status,
    pullRequests: getPullRequests(),
    archivedPrds: getArchivedPrds(),
    engine: getEngineState(),
    dispatch: getDispatchQueue(),
    engineLog: getEngineLog(),
    metrics: getMetrics(),
    workItems: getWorkItems(),
    runbooks: getRunbooks(),
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

  // POST /api/work-items
  if (req.method === 'POST' && req.url === '/api/work-items') {
    try {
      const body = await readBody(req);
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
      const id = 'W' + String(items.length + 1).padStart(3, '0');
      const item = {
        id, title: body.title, type: body.type || 'implement',
        priority: body.priority || 'medium', description: body.description || '',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard',
      };
      if (body.scope) item.scope = body.scope;
      items.push(item);
      fs.writeFileSync(wiPath, JSON.stringify(items, null, 2));
      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/decisions
  if (req.method === 'POST' && req.url === '/api/decisions') {
    try {
      const body = await readBody(req);
      const decPath = path.join(SQUAD_DIR, 'decisions.md');
      let content = safeRead(decPath) || '# Squad Decisions\n\n## Active Decisions\n';
      const today = new Date().toISOString().slice(0, 10);
      const entry = `\n### ${today}: ${body.title}\n**By:** ${body.author || 'yemishin'}\n**What:** ${body.what}\n${body.why ? '**Why:** ' + body.why + '\n' : ''}\n---\n`;
      const marker = '## Active Decisions';
      const idx = content.indexOf(marker);
      if (idx !== -1) {
        const insertAt = idx + marker.length;
        content = content.slice(0, insertAt) + '\n' + entry + content.slice(insertAt);
      } else {
        content += '\n' + entry;
      }
      fs.writeFileSync(decPath, content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items
  if (req.method === 'POST' && req.url === '/api/prd-items') {
    try {
      const body = await readBody(req);
      const firstProject = PROJECTS[0];
      const root = path.resolve(firstProject.localPath || path.resolve(SQUAD_DIR, '..'));
      const prdSrc = firstProject.workSources?.prd || CONFIG.workSources?.prd || {};
      const prdPath = path.resolve(root, prdSrc.path || 'docs/prd-gaps.json');
      let data = { missing_features: [], existing_features: [], open_questions: [] };
      const existing = safeRead(prdPath);
      if (existing) { try { data = JSON.parse(existing); } catch {} }
      if (!data.missing_features) data.missing_features = [];
      data.missing_features.push({
        id: body.id, name: body.name, description: body.description || '',
        priority: body.priority || 'medium', estimated_complexity: body.estimated_complexity || 'medium',
        rationale: body.rationale || '', status: 'missing', affected_areas: [],
      });
      fs.writeFileSync(prdPath, JSON.stringify(data, null, 2));
      return jsonReply(res, 200, { ok: true, id: body.id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // GET /api/runbook?file=<name>.md
  if (req.method === 'GET' && req.url.startsWith('/api/runbook?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const file = params.get('file');
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      res.statusCode = 400; res.end('Invalid file'); return;
    }
    const content = safeRead(path.join(SQUAD_DIR, 'runbooks', file));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content || 'Runbook not found.');
    return;
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
  exec(`start http://localhost:${PORT}`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} already in use. Kill the existing process or change PORT.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
