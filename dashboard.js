#!/usr/bin/env node
/**
 * Squad Mission Control Dashboard
 * Run: node .squad/dashboard.js
 * Opens: http://localhost:7331
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const llm = require('./engine/llm');
const shared = require('./engine/shared');
const os = require('os');

const { safeRead, safeReadDir, safeWrite, getProjects: _getProjects, parseSkillFrontmatter } = shared;

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
const SQUAD_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(SQUAD_DIR, 'config.json'), 'utf8'));

const PROJECTS = _getProjects(CONFIG);
const projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');

const HTML_RAW = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
const HTML = HTML_RAW.replace('Squad Mission Control', `Squad Mission Control — ${projectNames}`);

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
  // All PRD items come from plans/*.json (both manual /prd entries and agent-generated plans)
  const plansDir = path.join(SQUAD_DIR, 'plans');
  let allPrdItems = [];
  let latestStat = null;

  try {
    const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.json'));
    for (const pf of planFiles) {
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(plansDir, pf), 'utf8'));
        if (!plan.missing_features) continue;
        const stat = fs.statSync(path.join(plansDir, pf));
        if (!latestStat || stat.mtimeMs > latestStat.mtimeMs) latestStat = stat;
        (plan.missing_features || []).forEach(f => allPrdItems.push({
          ...f, _source: pf, _planStatus: plan.status || 'active',
          _planSummary: plan.plan_summary || pf,
          _planProject: plan.project || '',
        }));
      } catch {}
    }
  } catch {}

  // Legacy prd.json removed — all PRD items now in plans/*.json

  if (allPrdItems.length === 0) return { progress: null, status: null };

  const items = allPrdItems;

  const total = items.length;

  // Build work item lookups: PRD item → work item status (single source of truth)
  // and work item ID → PRD item ID (for PR linking)
  const wiByPlanKey = {}; // key: "sourcePlan:sourcePlanItem" → work item
  const wiToPlanItem = {};
  for (const project of PROJECTS) {
    try {
      const wiPath = path.join(project.localPath, '.squad', 'work-items.json');
      const workItems = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
      for (const wi of workItems) {
        if (wi.sourcePlanItem) wiToPlanItem[wi.id] = wi.sourcePlanItem;
        if (wi.sourcePlan && wi.sourcePlanItem) {
          wiByPlanKey[wi.sourcePlan + ':' + wi.sourcePlanItem] = wi;
        }
      }
    } catch {}
  }

  // Override PRD item status from work items (work items are the source of truth)
  for (const item of items) {
    const wi = wiByPlanKey[item._source + ':' + item.id];
    if (wi) {
      if (wi.status === 'done') item.status = 'implemented';
      else if (wi.status === 'failed') item.status = 'failed';
      else if (wi.status === 'dispatched') item.status = 'in-progress';
      else if (wi.status === 'pending') item.status = 'missing';
    }
  }

  // Recompute status counts after override
  const byStatus = {};
  items.forEach(item => {
    const s = item.status || 'missing';
    byStatus[s] = byStatus[s] || [];
    byStatus[s].push(item);
  });
  const complete = (byStatus['complete'] || []).length + (byStatus['completed'] || []).length + (byStatus['implemented'] || []).length;
  const prCreated = (byStatus['pr-created'] || []).length;
  const inProgress = (byStatus['in-progress'] || []).length + (byStatus['dispatched'] || []).length;
  const planned = (byStatus['planned'] || []).length;
  const missing = (byStatus['missing'] || []).length;
  const donePercent = total > 0 ? Math.round(((complete + prCreated) / total) * 100) : 0;

  const allPrs = getPullRequests();
  const prdToPr = {};
  for (const pr of allPrs) {
    for (const itemId of (pr.prdItems || [])) {
      // Direct match (if prdItems contains PRD item IDs)
      if (!prdToPr[itemId]) prdToPr[itemId] = [];
      prdToPr[itemId].push({ id: pr.id, url: pr.url, title: pr.title, status: pr.status });
      // Indirect match: work item ID → PRD item ID
      const planItemId = wiToPlanItem[itemId];
      if (planItemId && planItemId !== itemId) {
        if (!prdToPr[planItemId]) prdToPr[planItemId] = [];
        prdToPr[planItemId].push({ id: pr.id, url: pr.url, title: pr.title, status: pr.status });
      }
    }
  }

  // Compute timing per source plan from materialized work items
  const planTimings = {};
  for (const project of PROJECTS) {
    const wiPath = path.join(project.localPath, '.squad', 'work-items.json');
    try {
      const workItems = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
      for (const wi of workItems) {
        if (!wi.sourcePlan) continue;
        if (!planTimings[wi.sourcePlan]) planTimings[wi.sourcePlan] = { firstDispatched: null, lastCompleted: null, allDone: true };
        const t = planTimings[wi.sourcePlan];
        if (wi.dispatched_at) {
          const d = new Date(wi.dispatched_at).getTime();
          if (!t.firstDispatched || d < t.firstDispatched) t.firstDispatched = d;
        }
        if (wi.completedAt) {
          const c = new Date(wi.completedAt).getTime();
          if (!t.lastCompleted || c > t.lastCompleted) t.lastCompleted = c;
        }
        if (wi.status !== 'done') t.allDone = false;
      }
    } catch {}
  }

  const progress = {
    total, complete, prCreated, inProgress, planned, missing, donePercent,
    planTimings,
    items: items.map(i => ({
      id: i.id, name: i.name || i.title, priority: i.priority,
      complexity: i.estimated_complexity || i.size, status: i.status || 'missing',
      description: (i.description || '').slice(0, 200),
      projects: i.projects || [],
      prs: prdToPr[i.id] || [],
      depends_on: i.depends_on || [],
      source: i._source || '',
      planSummary: i._planSummary || '',
      planProject: i._planProject || '',
    })),
  };

  const status = {
    exists: true,
    age: latestStat ? timeSince(latestStat.mtimeMs) : 'unknown',
    existing: 0,
    missing: items.filter(i => i.status === 'missing').length,
    questions: 0,
    summary: '',
    missingList: items.filter(i => i.status === 'missing').map(f => ({ id: f.id, name: f.name || f.title, priority: f.priority, complexity: f.estimated_complexity || f.size })),
  };

  return { progress, status };
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
  const notesPath = path.join(SQUAD_DIR, 'notes.md');
  const content = safeRead(notesPath) || '';
  try {
    const stat = fs.statSync(notesPath);
    return { content, updatedAt: stat.mtimeMs };
  } catch { return { content, updatedAt: null }; }
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
  // All PRD items now in plans/*.json — no separate archive needed
  return [];
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
        const meta = parseSkillFrontmatter(content, f);
        // Override project for project-scoped skills
        if (scope === 'project' && meta.project === 'any') meta.project = projectName;
        all.push({ ...meta, file: f, source, scope });
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

function getMcpServers() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = path.join(home, '.claude.json');
    const data = JSON.parse(safeRead(claudeJsonPath) || '{}');
    const servers = data.mcpServers || {};
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      command: cfg.command || '',
      args: (cfg.args || []).slice(-1)[0] || '',
    }));
  } catch { return []; }
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
    mcpServers: getMcpServers(),
    projects: PROJECTS.map(p => ({ name: p.name, path: p.localPath, description: p.description || '' })),
    timestamp: new Date().toISOString(),
  };
}

// -- Triage context for Haiku LLM --

function getTriageContext() {
  const agents = getAgents().map(a => `- ${a.name} (${a.id}): ${a.status}${a.currentTask ? ' — ' + a.currentTask.slice(0, 60) : ''}`).join('\n');
  const projects = PROJECTS.map(p => `- ${p.name}: ${(p.description || '').slice(0, 60)}`).join('\n');

  // Recent work items (last 10 central + all project items that are active/failed)
  const centralWi = getWorkItems().slice(-10).map(i =>
    `- ${i.id}: "${i.title.slice(0, 60)}" [${i.type}] ${i.status}${i.dispatched_to ? ' → ' + i.dispatched_to : ''}`
  );
  const projectWi = [];
  for (const proj of PROJECTS) {
    try {
      const items = JSON.parse(fs.readFileSync(path.join(proj.localPath, '.squad', 'work-items.json'), 'utf8'));
      items.filter(i => i.status === 'failed' || i.status === 'dispatched' || i.status === 'pending')
        .forEach(i => projectWi.push(`- ${i.id}: "${(i.title || '').slice(0, 60)}" [${i.type}] ${i.status} (${proj.name})${i.dispatched_to ? ' → ' + i.dispatched_to : ''}`));
    } catch {}
  }
  const wi = [...centralWi, ...projectWi].join('\n');

  // Plans (with summary, author, project, status)
  const plansDir = path.join(SQUAD_DIR, 'plans');
  let plans = '';
  try {
    plans = safeReadDir(plansDir).filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const plan = JSON.parse(safeRead(path.join(plansDir, f)) || '{}');
          const author = plan.generatedBy || plan.generated_by || '';
          const summary = (plan.plan_summary || '').slice(0, 80);
          const status = plan.status || 'unknown';
          const project = plan.project || '';
          return `- ${f} | ${status} | by ${author} | project: ${project} | "${summary}"`;
        } catch { return `- ${f}`; }
      }).join('\n');
  } catch {}

  // PRD items (from all plan JSONs)
  let prdItems = '';
  try {
    const prdInfo = getPrdInfo();
    if (prdInfo.progress && prdInfo.progress.items) {
      prdItems = prdInfo.progress.items.map(i => {
        const deps = (i.depends_on || []).join(',');
        return `- ${i.id}: "${(i.name || '').slice(0, 50)}" [${i.status}] ${i.priority}${deps ? ' deps:[' + deps + ']' : ''} (${i.source})`;
      }).join('\n');
    }
  } catch {}

  // Active dispatch
  const dq = getDispatchQueue();
  const active = (dq.active || []).map(d =>
    `- ${d.agentName || d.agent}: ${(d.task || '').slice(0, 50)}`
  ).join('\n');

  return { agents, projects, workItems: wi, plans, prdItems, activeDispatch: active };
}

function buildTriageSysPrompt(ctx) {
  return `You are a triage assistant for a software engineering squad called "Squad."
Given a user command, determine the intent and return structured JSON.

## Squad Context

### Agents
${ctx.agents}

### Projects
${ctx.projects}

### Recent Work Items
${ctx.workItems}

### Plans on Disk
${ctx.plans}

### PRD Items (from active PRDs)
${ctx.prdItems}

### Currently Active
${ctx.activeDispatch}

## Available Intents

- "work-item": A task for an agent. Types: ask, explore, fix, review, test, implement, plan-to-prd
- "note": A decision, reminder, or knowledge to save (keywords: remember, note, don't forget)
- "plan": Create a NEW multi-step implementation plan from scratch. Use only when no plan exists yet.
  Keywords: plan, design, architect, make a plan for, /plan
- "work-item" with type "plan-to-prd": Convert an EXISTING plan into PRD items / executable tasks.
  Use when the user references a plan that already exists on disk (check plans list above).
  Keywords: create PRD from, convert plan to PRD, execute the plan, implement the plan, break down the plan
- "retry": Retry/restart/rerun existing failed or stuck work items. Do NOT create new work items.
  Keywords: retry, restart, rerun, redo, try again, re-dispatch, reset
  Include the work item IDs to retry in the "retryIds" field. Match from the work items list above.
  If the user says "the failed tasks" or "the three failed ones", find items with status "failed" and include their IDs.
- "answer": Answer a question about the squad state. Use when the user asks a question
  (what, which, how many, status, what's blocking, what's left, who is working on, etc.)
  Put your concise answer in the "answer" field. Use the context above to answer accurately.

## Rules

0. CRITICAL: If the user is ASKING A QUESTION about the current state (why, what, which, how many,
   what happened, what failed, what's blocking, status, progress, who is working on), use intent "answer".
   Do NOT create a work item for questions. Only create work items when the user wants ACTION taken.
   "Why did X fail?" = answer. "Fix X" = work-item. "What's blocking P011?" = answer. "Unblock P011" = work-item.
1. Explicit prefixes override everything: /plan or /prd -> plan, /note or /decide -> note
2. @mentions map to agent IDs. @everyone or @all -> fanout=true
3. #tags map to project names from the project list above
4. !high or !urgent -> priority "high"; !low -> "low"; default "medium"
5. For work items, pick the best type:
   - ask: user wants an explanation or answer (explain, why, what does, how)
   - explore: user wants research, analysis, investigation, or document review
   - fix: bugs, errors, broken things
   - review: PR/code review specifically (not document review)
   - test: build, run, verify, test
   - implement: build something new, create, add feature
6. When the user references an agent's work, resolve it to a specific artifact from the lists above.
7. If the user references "the plan" or "latest plan", use the most recent plan from the plans list.
8. Default branchStrategy for plans: "parallel"
9. Be concise in title and description.
10. When the user says "create PRD from X's plan", "execute the plan", "implement the plan":
    -> If the plan EXISTS on disk -> intent "work-item", type "plan-to-prd", include plan filename in description
    -> If NO plan exists yet -> intent "plan" (create one first)

## Output Format

Respond with ONLY a JSON object, no markdown fences, no explanation:
{
  "intent": "work-item|note|plan|retry|answer",
  "title": "concise action title",
  "description": "additional context, resolved references",
  "type": "ask|explore|fix|review|test|implement|plan-to-prd",
  "priority": "low|medium|high",
  "agents": ["agent-id"] or [],
  "fanout": false,
  "project": "project-name or empty string",
  "projects": [],
  "branchStrategy": "parallel",
  "retryIds": ["work-item-id"], // only for intent "retry"
  "answer": "text response" // only for intent "answer"
}`;
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

// -- Dispatch cleanup helper --

/**
 * Remove dispatch entries matching a predicate. Scans pending, active, completed queues.
 * Also kills agent processes for matched active entries.
 * @param {(entry) => boolean} matchFn - return true for entries to remove
 * @returns {number} count of removed entries
 */
function cleanDispatchEntries(matchFn) {
  const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
  try {
    const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
    let removed = 0;
    for (const queue of ['pending', 'active', 'completed']) {
      if (!dispatch[queue]) continue;
      const before = dispatch[queue].length;

      // Kill agents for matched active entries
      if (queue === 'active') {
        for (const d of dispatch[queue]) {
          if (matchFn(d) && d.agent) {
            const statusPath = path.join(SQUAD_DIR, 'agents', d.agent, 'status.json');
            try {
              const status = JSON.parse(safeRead(statusPath) || '{}');
              if (status.pid) try { process.kill(status.pid, 'SIGTERM'); } catch {}
              status.status = 'idle';
              delete status.currentTask;
              safeWrite(statusPath, status);
            } catch {}
          }
        }
      }

      dispatch[queue] = dispatch[queue].filter(d => !matchFn(d));
      removed += before - dispatch[queue].length;
    }
    if (removed > 0) safeWrite(dispatchPath, dispatch);
    return removed;
  } catch { return 0; }
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

      // Remove item from work-items file
      items.splice(idx, 1);
      safeWrite(wiPath, items);

      // Clean dispatch entries + kill running agent
      const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
      const dispatchKey = sourcePrefix + id;
      cleanDispatchEntries(d =>
        d.meta?.dispatchKey === dispatchKey ||
        (d.meta?.parentKey && d.meta.parentKey === dispatchKey) ||
        d.meta?.item?.id === id
      );

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

      // Clean dispatch entries for archived item
      const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
      cleanDispatchEntries(d =>
        d.meta?.dispatchKey === sourcePrefix + id ||
        d.meta?.item?.id === id
      );

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
        branchStrategy: body.branch_strategy || 'parallel',
      };
      if (body.project) item.project = body.project;
      if (body.agent) item.agent = body.agent;
      items.push(item);
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, id, agent: body.agent || '' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items — create a PRD item as a plan file in plans/ (auto-approved)
  if (req.method === 'POST' && req.url === '/api/prd-items') {
    try {
      const body = await readBody(req);
      if (!body.name || !body.name.trim()) return jsonReply(res, 400, { error: 'name is required' });

      const plansDir = path.join(SQUAD_DIR, 'plans');
      if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });

      const id = body.id || ('M' + String(Date.now()).slice(-4));
      const planFile = 'manual-' + Date.now() + '.json';
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
      safeWrite(path.join(plansDir, planFile), plan);
      return jsonReply(res, 200, { ok: true, id, file: planFile });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items/update — edit a PRD item in its source plan JSON
  if (req.method === 'POST' && req.url === '/api/prd-items/update') {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const item = (plan.missing_features || []).find(f => f.id === body.itemId);
      if (!item) return jsonReply(res, 404, { error: 'item not found in plan' });

      // Update allowed fields
      if (body.name !== undefined) item.name = body.name;
      if (body.description !== undefined) item.description = body.description;
      if (body.priority !== undefined) item.priority = body.priority;
      if (body.estimated_complexity !== undefined) item.estimated_complexity = body.estimated_complexity;
      if (body.status !== undefined) item.status = body.status;

      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, item });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items/remove — remove a PRD item from plan + cancel materialized work item
  if (req.method === 'POST' && req.url === '/api/prd-items/remove') {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const idx = (plan.missing_features || []).findIndex(f => f.id === body.itemId);
      if (idx < 0) return jsonReply(res, 404, { error: 'item not found in plan' });

      plan.missing_features.splice(idx, 1);
      safeWrite(planPath, plan);

      // Also remove any materialized work item for this plan item
      let cancelled = false;
      for (const proj of PROJECTS) {
        const wiPath = path.join(proj.localPath, '.squad', 'work-items.json');
        try {
          const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
          const before = items.length;
          const filtered = items.filter(w => !(w.sourcePlan === body.source && w.sourcePlanItem === body.itemId));
          if (filtered.length < before) {
            safeWrite(wiPath, filtered);
            cancelled = true;
          }
        } catch {}
      }
      // Also check central work-items
      const centralPath = path.join(SQUAD_DIR, 'work-items.json');
      try {
        const items = JSON.parse(fs.readFileSync(centralPath, 'utf8'));
        const before = items.length;
        const filtered = items.filter(w => !(w.sourcePlan === body.source && w.sourcePlanItem === body.itemId));
        if (filtered.length < before) { safeWrite(centralPath, filtered); cancelled = true; }
      } catch {}

      // Clean dispatch entries for this item
      cleanDispatchEntries(d =>
        (d.meta?.item?.sourcePlan === body.source && d.meta?.item?.sourcePlanItem === body.itemId) ||
        (d.meta?.item?.planItemId === body.itemId && d.meta?.item?.sourcePlan === body.source)
      );

      return jsonReply(res, 200, { ok: true, cancelled });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/triage — Haiku LLM command triage for natural language input
  if (req.method === 'POST' && req.url === '/api/triage') {
    const body = await readBody(req);
    if (!body.message) return jsonReply(res, 400, { error: 'message required' });
    const ctx = getTriageContext();
    const sysPrompt = buildTriageSysPrompt(ctx);
    // Include previous exchange for follow-up context
    let message = body.message;
    if (body.previousExchange) {
      const prev = body.previousExchange;
      message = `Previous user message: ${prev.userMessage}\nPrevious response: ${JSON.stringify(prev.response)}\n\nCurrent user message: ${body.message}`;
    }
    llm.triageCommand(message, sysPrompt)
      .then(result => jsonReply(res, 200, result))
      .catch(e => jsonReply(res, 500, { error: e.message }));
    return;
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

  // POST /api/notes-save — save edited notes.md content
  if (req.method === 'POST' && req.url === '/api/notes-save') {
    try {
      const body = await readBody(req);
      if (!body.content && body.content !== '') return jsonReply(res, 400, { error: 'content required' });
      const file = body.file || 'notes.md';
      // Only allow saving notes.md (prevent arbitrary file writes)
      if (file !== 'notes.md') return jsonReply(res, 400, { error: 'only notes.md can be edited' });
      safeWrite(path.join(SQUAD_DIR, file), body.content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
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

  // GET /api/plans — list plan files (.md drafts + .json PRDs that need action)
  // PRD .json files with status 'approved'/'active' are shown in the PRD tile, not here
  if (req.method === 'GET' && req.url === '/api/plans') {
    const plansDir = path.join(SQUAD_DIR, 'plans');
    const allFiles = safeReadDir(plansDir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
    const plans = allFiles.map(f => {
      const content = safeRead(path.join(plansDir, f)) || '';
      const isJson = f.endsWith('.json');
      if (isJson) {
        try {
          const plan = JSON.parse(content);
          // All .json PRDs belong in the PRD tile, not the plans tile
          return null;
          return {
            file: f, format: 'prd',
            project: plan.project || '',
            summary: plan.plan_summary || '',
            status,
            branchStrategy: plan.branch_strategy || 'parallel',
            featureBranch: plan.feature_branch || '',
            itemCount: (plan.missing_features || []).length,
            generatedBy: plan.generated_by || '',
            generatedAt: plan.generated_at || '',
            requiresApproval: plan.requires_approval || false,
            revisionFeedback: plan.revision_feedback || null,
          };
        } catch { return null; }
      } else {
        // .md raw plan — extract metadata from markdown
        const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)/m);
        const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/m);
        const authorMatch = content.match(/\*\*Author:\*\*\s*(.+)/m);
        const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/m);
        return {
          file: f, format: 'draft',
          project: projectMatch ? projectMatch[1].trim() : '',
          summary: titleMatch ? titleMatch[1].trim() : f.replace('.md', ''),
          status: 'draft',
          branchStrategy: '',
          featureBranch: '',
          itemCount: (content.match(/^\d+\.\s+\*\*/gm) || []).length,
          generatedBy: authorMatch ? authorMatch[1].trim() : '',
          generatedAt: dateMatch ? dateMatch[1].trim() : '',
          requiresApproval: false,
          revisionFeedback: null,
        };
      }
    }).filter(Boolean).sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    return jsonReply(res, 200, plans);
  }

  // GET /api/plans/archive/:file — read archived plan
  const archiveFileMatch = req.url.match(/^\/api\/plans\/archive\/([^?]+)$/);
  if (archiveFileMatch && req.method === 'GET') {
    const file = decodeURIComponent(archiveFileMatch[1]);
    if (file.includes('..')) return jsonReply(res, 400, { error: 'invalid' });
    const content = safeRead(path.join(SQUAD_DIR, 'plans', 'archive', file));
    if (!content) return jsonReply(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  // GET /api/plans/:file — read full plan (JSON or markdown)
  const planFileMatch = req.url.match(/^\/api\/plans\/([^?]+)$/);
  if (planFileMatch && req.method === 'GET') {
    const file = decodeURIComponent(planFileMatch[1]);
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return jsonReply(res, 400, { error: 'invalid' });
    const content = safeRead(path.join(SQUAD_DIR, 'plans', file));
    if (!content) return jsonReply(res, 404, { error: 'not found' });
    const contentType = file.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType + '; charset=utf-8');
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

  // POST /api/plans/pause — pause a plan (stops new item materialization)
  if (req.method === 'POST' && req.url === '/api/plans/pause') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'awaiting-approval';
      plan.pausedAt = new Date().toISOString();
      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, status: 'paused' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/execute — queue plan-to-prd conversion for a .md plan
  if (req.method === 'POST' && req.url === '/api/plans/execute') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      if (!body.file.endsWith('.md')) return jsonReply(res, 400, { error: 'only .md plans can be executed' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });

      // Check if already queued
      const centralPath = path.join(SQUAD_DIR, 'work-items.json');
      const items = JSON.parse(safeRead(centralPath) || '[]');
      const existing = items.find(w => w.type === 'plan-to-prd' && w.planFile === body.file && (w.status === 'pending' || w.status === 'dispatched'));
      if (existing) return jsonReply(res, 200, { ok: true, id: existing.id, alreadyQueued: true });

      const maxNum = items.reduce((max, i) => { const m = (i.id || '').match(/(\d+)$/); return m ? Math.max(max, parseInt(m[1])) : max; }, 0);
      const id = 'W' + String(maxNum + 1).padStart(3, '0');
      items.push({
        id, title: 'Convert plan to PRD: ' + body.file.replace('.md', ''),
        type: 'plan-to-prd', priority: 'high',
        description: 'Plan file: plans/' + body.file,
        status: 'pending', created: new Date().toISOString(),
        createdBy: 'dashboard:execute', project: body.project || '',
        planFile: body.file,
      });
      safeWrite(centralPath, items);
      return jsonReply(res, 200, { ok: true, id });
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

  // POST /api/plans/delete — delete a plan file
  if (req.method === 'POST' && req.url === '/api/plans/delete') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      if (body.file.includes('..') || body.file.includes('/') || body.file.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid filename' });
      }
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan not found' });
      fs.unlinkSync(planPath);

      // Clean up materialized work items from all projects + central
      let cleaned = 0;
      const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(path.join(proj.localPath, '.squad', 'work-items.json'));
      }
      for (const wiPath of wiPaths) {
        try {
          const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
          const filtered = items.filter(w => w.sourcePlan !== body.file);
          if (filtered.length < items.length) {
            cleaned += items.length - filtered.length;
            safeWrite(wiPath, filtered);
          }
        } catch {}
      }

      // Clean up dispatch entries for this plan's items
      const dispatchCleaned = cleanDispatchEntries(d =>
        d.meta?.item?.sourcePlan === body.file ||
        d.meta?.planFile === body.file ||
        (d.task && d.task.includes(body.file))
      );

      return jsonReply(res, 200, { ok: true, cleanedWorkItems: cleaned, cleanedDispatches: dispatchCleaned });
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

  // POST /api/plans/discuss — generate a plan discussion session script
  if (req.method === 'POST' && req.url === '/api/plans/discuss') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = path.join(SQUAD_DIR, 'plans', body.file);
      const planContent = safeRead(planPath);
      if (!planContent) return jsonReply(res, 404, { error: 'plan not found' });

      const plan = JSON.parse(planContent);
      const projectName = plan.project || 'Unknown';

      // Build the session launch script
      const sessionName = 'plan-review-' + body.file.replace(/\.json$/, '');
      const sysPrompt = `You are a Plan Advisor helping a human review and refine a feature plan before it gets dispatched to an agent squad.

## Your Role
- Help the user understand, question, and refine the plan
- Accept feedback and update the plan accordingly
- When the user is satisfied, write the approved plan back to disk

## The Plan File
Path: ${planPath}
Project: ${projectName}

## How This Works
1. The user will discuss the plan with you — answer questions, suggest changes
2. When they want changes, update the plan items (add/remove/reorder/modify)
3. When they say ANY of these (or similar intent):
   - "approve", "go", "ship it", "looks good", "lgtm"
   - "clear context and implement", "clear context and go"
   - "go build it", "start working", "dispatch", "execute"
   - "do it", "proceed", "let's go", "send it"

   Then:
   a. Read the current plan file fresh from disk
   b. Update status to "approved", set approvedAt and approvedBy
   c. Write it back to ${planPath} using the Write tool
   d. Print exactly: "Plan approved and saved. The engine will dispatch work on the next tick. You can close this session."
   e. Then EXIT the session — use /exit or simply stop responding. The user does NOT need to interact further.

4. If they say "reject" or "cancel":
   - Update status to "rejected"
   - Write it back
   - Confirm and exit.

## Important
- Always read the plan file fresh before writing (another process may have modified it)
- Preserve all existing fields when writing back
- Use the Write tool to save changes
- You have full file access — you can also read the project codebase for context
- When the user signals approval, ALWAYS write the file and exit. Do not ask for confirmation — their intent is clear.`;

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
      const sessionDir = path.join(SQUAD_DIR, 'engine');
      const sysFile = path.join(sessionDir, `plan-discuss-sys-${Date.now()}.md`);
      const promptFile = path.join(sessionDir, `plan-discuss-prompt-${Date.now()}.md`);
      safeWrite(sysFile, sysPrompt);
      safeWrite(promptFile, initialPrompt);

      // Generate the launch command
      const cmd = `claude --system-prompt "$(cat '${sysFile.replace(/\\/g, '/')}')" --name "${sessionName}" --add-dir "${SQUAD_DIR.replace(/\\/g, '/')}" < "${promptFile.replace(/\\/g, '/')}"`;

      // Also generate a PowerShell-friendly version
      const psCmd = `Get-Content "${promptFile}" | claude --system-prompt (Get-Content "${sysFile}" -Raw) --name "${sessionName}" --add-dir "${SQUAD_DIR}"`;

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

  // POST /api/doc-chat — unified Q&A + steering via engine/llm.js
  if (req.method === 'POST' && req.url === '/api/doc-chat') {
    try {
      const body = await readBody(req);
      if (!body.message) return jsonReply(res, 400, { error: 'message required' });
      if (!body.document) return jsonReply(res, 400, { error: 'document required' });

      const canEdit = !!body.filePath;
      const isJson = body.filePath?.endsWith('.json');
      let currentContent = body.document;
      let fullPath = null;
      if (canEdit) {
        fullPath = path.resolve(SQUAD_DIR, body.filePath);
        if (!fullPath.startsWith(path.resolve(SQUAD_DIR))) return jsonReply(res, 400, { error: 'path must be under squad directory' });
        const diskContent = safeRead(fullPath);
        if (diskContent !== null) currentContent = diskContent;
      }

      const result = await llm.docChat({
        message: body.message, document: currentContent, title: body.title,
        filePath: canEdit ? body.filePath : null, selection: body.selection, history: body.history, isJson,
      });

      if (!result.edited) return jsonReply(res, 200, { ok: true, answer: result.answer, edited: false });

      if (isJson) {
        try { JSON.parse(result.content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: result.answer + '\n\n(JSON invalid — not saved: ' + e.message + ')', edited: false });
        }
      }
      if (canEdit && fullPath) {
        safeWrite(fullPath, result.content);
        return jsonReply(res, 200, { ok: true, answer: result.answer, edited: true, content: result.content });
      }
      return jsonReply(res, 200, { ok: true, answer: result.answer + '\n\n(Read-only — changes not saved)', edited: false });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/steer-document — modify a document via engine/llm.js
  if (req.method === 'POST' && req.url === '/api/steer-document') {
    try {
      const body = await readBody(req);
      if (!body.instruction) return jsonReply(res, 400, { error: 'instruction required' });
      if (!body.filePath) return jsonReply(res, 400, { error: 'filePath required' });
      const fullPath = path.resolve(SQUAD_DIR, body.filePath);
      if (!fullPath.startsWith(path.resolve(SQUAD_DIR))) return jsonReply(res, 400, { error: 'path must be under squad directory' });
      const currentContent = safeRead(fullPath);
      if (currentContent === null) return jsonReply(res, 404, { error: 'file not found' });
      const isJson = body.filePath.endsWith('.json');

      const result = await llm.steerDocument({
        instruction: body.instruction, filePath: body.filePath,
        content: currentContent, selection: body.selection, isJson,
      });

      if (!result.updated) return jsonReply(res, 200, { ok: true, answer: result.answer, updated: false });
      if (isJson) {
        try { JSON.parse(result.content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: result.answer + '\n\n(JSON validation failed — not saved: ' + e.message + ')', updated: false });
        }
      }
      safeWrite(fullPath, result.content);
      return jsonReply(res, 200, { ok: true, answer: result.answer, updated: true, content: result.content });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/ask-about — document Q&A via engine/llm.js
  if (req.method === 'POST' && req.url === '/api/ask-about') {
    try {
      const body = await readBody(req);
      if (!body.question) return jsonReply(res, 400, { error: 'question required' });
      if (!body.document) return jsonReply(res, 400, { error: 'document required' });
      const result = await llm.askAbout({
        question: body.question, document: body.document,
        title: body.title, selection: body.selection,
      });
      return jsonReply(res, 200, { ok: true, answer: result.answer });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
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

  // POST /api/inbox/promote-kb — promote an inbox item to the knowledge base
  if (req.method === 'POST' && req.url === '/api/inbox/promote-kb') {
    try {
      const body = await readBody(req);
      const { name, category } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });
      const validCategories = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];
      if (!category || !validCategories.includes(category)) {
        return jsonReply(res, 400, { error: 'category required: ' + validCategories.join(', ') });
      }

      const inboxPath = path.join(SQUAD_DIR, 'notes', 'inbox', name);
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
      const kbDir = path.join(SQUAD_DIR, 'knowledge', category);
      if (!fs.existsSync(kbDir)) fs.mkdirSync(kbDir, { recursive: true });
      const kbFile = path.join(kbDir, name);
      safeWrite(kbFile, kbContent);

      // Move inbox item to archive
      const archiveDir = path.join(SQUAD_DIR, 'notes', 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      try { fs.renameSync(inboxPath, path.join(archiveDir, `kb-${category}-${name}`)); } catch {}

      return jsonReply(res, 200, { ok: true, category, file: name });
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

  // POST /api/inbox/delete — delete an inbox note
  if (req.method === 'POST' && req.url === '/api/inbox/delete') {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid name' });
      }
      const filePath = path.join(SQUAD_DIR, 'notes', 'inbox', name);
      if (!fs.existsSync(filePath)) return jsonReply(res, 404, { error: 'file not found' });
      fs.unlinkSync(filePath);
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

  // POST /api/projects/browse — open folder picker dialog, return selected path
  if (req.method === 'POST' && req.url === '/api/projects/browse') {
    try {
      const { execSync } = require('child_process');
      let selectedPath = '';
      if (process.platform === 'win32') {
        // PowerShell folder browser dialog
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select project folder'; $f.ShowNewFolderButton = $false; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { '' }`;
        selectedPath = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
      } else if (process.platform === 'darwin') {
        selectedPath = execSync(`osascript -e 'POSIX path of (choose folder with prompt "Select project folder")'`, { encoding: 'utf8', timeout: 120000 }).trim();
      } else {
        selectedPath = execSync(`zenity --file-selection --directory --title="Select project folder" 2>/dev/null`, { encoding: 'utf8', timeout: 120000 }).trim();
      }
      if (!selectedPath) return jsonReply(res, 200, { cancelled: true });
      return jsonReply(res, 200, { path: selectedPath.replace(/\\/g, '/') });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/projects/add — auto-discover and add a project to config
  if (req.method === 'POST' && req.url === '/api/projects/add') {
    try {
      const body = await readBody(req);
      if (!body.path) return jsonReply(res, 400, { error: 'path required' });
      const target = path.resolve(body.path);
      if (!fs.existsSync(target)) return jsonReply(res, 400, { error: 'Directory not found: ' + target });

      const configPath = path.join(SQUAD_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
      } catch {}
      try {
        const pkgPath = path.join(target, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.name) detected.name = pkg.name.replace(/^@[^/]+\//, '');
        }
      } catch {}
      let description = '';
      try {
        const claudeMd = path.join(target, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          const lines = fs.readFileSync(claudeMd, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
          if (lines[0] && lines[0].length < 200) description = lines[0].trim();
        }
      } catch {}

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
        workSources: { pullRequests: { enabled: true, path: '.squad/pull-requests.json', cooldownMinutes: 30 }, workItems: { enabled: true, path: '.squad/work-items.json', cooldownMinutes: 0 } }
      };

      config.projects.push(project);
      safeWrite(configPath, config);

      // Create project-local state files
      const squadDir = path.join(target, '.squad');
      if (!fs.existsSync(squadDir)) fs.mkdirSync(squadDir, { recursive: true });
      const stateFiles = { 'pull-requests.json': '[]', 'work-items.json': '[]' };
      for (const [f, content] of Object.entries(stateFiles)) {
        const fp = path.join(squadDir, f);
        if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
      }

      return jsonReply(res, 200, { ok: true, name, path: target, detected });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
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

  // (duplicate /api/health removed — first handler above is the canonical one)

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

  // ─── Engine Watchdog ─────────────────────────────────────────────────────
  // Every 30s, check if engine PID is alive. If dead but control.json says
  // running, auto-restart it. Prevents silent engine death.
  const { execSync, spawn: cpSpawn } = require('child_process');
  setInterval(() => {
    try {
      const control = getEngineState();
      if (control.state !== 'running' || !control.pid) return;

      // Check if PID is alive
      let alive = false;
      try {
        if (process.platform === 'win32') {
          const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', timeout: 3000 });
          alive = out.includes(String(control.pid));
        } else {
          process.kill(control.pid, 0); // signal 0 = check existence
          alive = true;
        }
      } catch { alive = false; }

      if (!alive) {
        console.log(`[watchdog] Engine PID ${control.pid} is dead — auto-restarting...`);

        // Set state to stopped first
        const controlPath = path.join(SQUAD_DIR, 'engine', 'control.json');
        safeWrite(controlPath, { state: 'stopped', pid: null, crashed_at: new Date().toISOString() });

        // Restart engine
        const childEnv = { ...process.env };
        for (const key of Object.keys(childEnv)) {
          if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete childEnv[key];
        }
        const engineProc = cpSpawn(process.execPath, [path.join(SQUAD_DIR, 'engine.js'), 'start'], {
          cwd: SQUAD_DIR,
          stdio: 'ignore',
          detached: true,
          env: childEnv,
        });
        engineProc.unref();
        console.log(`[watchdog] Engine restarted (new PID: ${engineProc.pid})`);
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
