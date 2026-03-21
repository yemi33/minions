#!/usr/bin/env node
/**
 * Squad Mission Control Dashboard
 * Run: node .squad/dashboard.js
 * Opens: http://localhost:7331
 */

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const llm = require('./engine/llm');
const shared = require('./engine/shared');
const queries = require('./engine/queries');
const os = require('os');

const { safeRead, safeReadDir, safeWrite, safeJson, safeUnlink, mutateJsonFileLocked, getProjects: _getProjects } = shared;
const { getAgents, getAgentDetail, getPrdInfo, getWorkItems, getDispatchQueue,
  getSkills, getInbox, getNotesWithMeta, getPullRequests,
  getEngineLog, getMetrics, getKnowledgeBaseEntries, timeSince,
  SQUAD_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, DISPATCH_PATH, PRD_DIR } = queries;

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
let CONFIG = queries.getConfig();
let PROJECTS = _getProjects(CONFIG);
let projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');

function reloadConfig() {
  CONFIG = queries.getConfig();
  PROJECTS = _getProjects(CONFIG);
  projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');
}

const PLANS_DIR = path.join(SQUAD_DIR, 'plans');

// Resolve a plan/PRD file path: .json files live in prd/, .md files in plans/
function resolvePlanPath(file) {
  if (file.endsWith('.json')) {
    const active = path.join(PRD_DIR, file);
    if (fs.existsSync(active)) return active;
    const archived = path.join(PRD_DIR, 'archive', file);
    if (fs.existsSync(archived)) return archived;
    return active;
  }
  const active = path.join(PLANS_DIR, file);
  if (fs.existsSync(active)) return active;
  const archived = path.join(PLANS_DIR, 'archive', file);
  if (fs.existsSync(archived)) return archived;
  return active;
}

const HTML_RAW = safeRead(path.join(SQUAD_DIR, 'dashboard.html')) || '';
const HTML = HTML_RAW.replace('Squad Mission Control', `Squad Mission Control — ${projectNames}`);
const HTML_GZ = zlib.gzipSync(HTML);
const HTML_ETAG = '"' + require('crypto').createHash('md5').update(HTML).digest('hex') + '"';


// -- Data Collectors (most moved to engine/queries.js) --

function getVerifyGuides() {
  const guidesDir = path.join(SQUAD_DIR, 'prd', 'guides');
  const guides = [];
  try {
    const files = safeReadDir(guidesDir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      // Match guide to plan: verify-officeagent-2026-03-15.md → officeagent-2026-03-15.json
      const planSlug = f.replace('verify-', '').replace('.md', '');
      const planFile = planSlug + '.json';
      guides.push({ file: f, planFile });
    }
  } catch {}
  return guides;
}

function getArchivedPrds() { return []; }
function getEngineState() { return queries.getControl(); }

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

let _statusCache = null;
let _statusCacheTs = 0;
const STATUS_CACHE_TTL = 10000; // 10s — reduces expensive aggregation frequency; mutations call invalidateStatusCache()
function invalidateStatusCache() { _statusCache = null; }

function getStatus() {
  const now = Date.now();
  if (_statusCache && (now - _statusCacheTs) < STATUS_CACHE_TTL) return _statusCache;

  // Reload config on each cache miss — picks up external changes (squad init, squad add)
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
    engine: getEngineState(),
    dispatch: getDispatchQueue(),
    engineLog: getEngineLog(),
    metrics: getMetrics(),
    workItems: getWorkItems(),
    skills: getSkills(),
    mcpServers: getMcpServers(),
    projects: PROJECTS.map(p => ({ name: p.name, path: p.localPath, description: p.description || '' })),
    initialized: !!(CONFIG.agents && Object.keys(CONFIG.agents).length > 0),
    installId: safeRead(path.join(SQUAD_DIR, '.install-id')).trim() || null,
    timestamp: new Date().toISOString(),
  };
  _statusCacheTs = now;
  return _statusCache;
}


// ── Command Center: session state + helpers ─────────────────────────────────

const CC_SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
const CC_SESSION_MAX_TURNS = 50;
let ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
let ccInFlight = false;
let ccInFlightSince = 0; // timestamp — auto-release stuck guard
const CC_INFLIGHT_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes (slightly > LLM timeout)

function ccSessionValid() {
  if (!ccSession.sessionId) return false;
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
} catch {}

// Static system prompt — baked into session on creation, never changes
const CC_STATIC_SYSTEM_PROMPT = `You are the Command Center AI for a software engineering squad called "Squad."
You have full CLI-level power — you can read, write, edit files, run shell commands, and execute builds just like a Claude Code CLI session. You also have squad-specific actions to delegate work to agents.

## Guardrails — What You Must NOT Touch

These files are the live engine. Modifying them can crash the squad or corrupt state:
- \`${SQUAD_DIR}/engine.js\` and \`${SQUAD_DIR}/engine/*.js\` — engine source code
- \`${SQUAD_DIR}/dashboard.js\` and \`${SQUAD_DIR}/dashboard.html\` — dashboard source
- \`${SQUAD_DIR}/squad.js\` and \`${SQUAD_DIR}/bin/*.js\` — CLI source
- \`${SQUAD_DIR}/engine/control.json\` — engine state (use CLI commands instead)
- \`${SQUAD_DIR}/engine/dispatch.json\` — dispatch queue (use actions instead)
- \`${SQUAD_DIR}/config.json\` — engine config (use actions or CLI instead)

You CAN freely read any of these files. You just must not write/edit them.

You CAN freely modify: notes, plans, knowledge base, work items, pull-requests.json, routing.md, agent charters, skills, playbooks, and anything in project repos.

## Filesystem — What's Where

\`\`\`
${SQUAD_DIR}/
├── config.json                    # Engine + project config (READ ONLY)
├── routing.md                     # Agent dispatch routing rules
├── notes.md                       # Consolidated team notes
├── work-items.json                # Central work item queue (cross-project tasks)
├── projects/{name}/               # Per-project state (centralized, NOT in project repos)
│   ├── work-items.json            # Project-specific work items
│   └── pull-requests.json         # PR tracking for this project
├── agents/
│   ├── {id}/charter.md            # Agent role definition
│   ├── {id}/output.log            # Latest agent output
│   └── {id}/output-{dispatchId}.log  # Archived outputs
├── plans/                         # Source plans (.md)
├── prd/                           # PRD items (.json), prd/archive/, prd/guides/
├── knowledge/{category}/*.md      # Knowledge base
├── engine/                        # Engine internals (READ ONLY)
│   ├── dispatch.json              # Pending, active, completed dispatches
│   ├── metrics.json               # Token/cost tracking
│   ├── control.json               # Engine state (running/paused/stopped)
│   └── cooldowns.json             # Dispatch cooldown timers
├── playbooks/*.md                 # Task templates
├── skills/*.md                    # Reusable agent workflow definitions
└── notes/inbox/*.md               # Unconsolidated agent findings
\`\`\`

Projects are configured in \`config.json\` under \`projects[]\`. Per-project state lives centrally in \`${SQUAD_DIR}/projects/{name}/\` — NOT inside project repos. There are no \`.squad/\` folders inside project repos.

## Direct Execution

You have Bash, Write, Edit, and all standard tools. Use them directly when the task is straightforward:
- **Build & run projects** — \`cd <project> && npm install && npm run dev\`
- **Inspect code** — read files, grep, explore
- **Edit project files** — fix configs, update docs, tweak settings
- **Git operations** — fetch, checkout, merge, diff (but do NOT push without the user confirming)
- **Start dev servers** — for long-running servers, use detached processes so they survive after you finish

**When to do it yourself vs delegate to an agent:**
- Quick, one-shot tasks (build, read, check, install, start a server) → do it yourself
- Complex multi-file code changes, PR creation, code review → dispatch to an agent
- Anything that needs deep codebase knowledge or iterative coding → dispatch to an agent

## Squad Actions (Delegation)

When you want to delegate work to agents, append actions at the END of your response.

**Format:** Write your conversational response first, then on a new line write exactly \`===ACTIONS===\` followed by a JSON array of actions. Example:

I'll save that as a note and dispatch dallas to fix the bug.

===ACTIONS===
[{"type": "note", "title": "API v3 migration needed", "content": "We need to migrate..."}, {"type": "dispatch", "title": "Fix login bug", "workType": "fix", "priority": "high", "agents": ["dallas"], "project": "OfficeAgent", "description": "..."}]

**CRITICAL:** The ===ACTIONS=== line and JSON array must be the LAST thing in your response. No text after it. The JSON must be a valid array on a single line.

If no actions are needed (just answering a question, or you handled it directly), do NOT include the ===ACTIONS=== line.

Available action types:
- **dispatch**: Create a work item for an agent. Fields: title, workType (ask/explore/fix/review/test/implement/verify), priority (low/medium/high), agents (array of IDs, optional), project, description. Use \`verify\` when the user wants to build PRs locally, merge branches together, start a dev server, and get a localhost URL to test.
- **note**: Save a note/decision. Fields: title, content
- **plan**: Create a multi-step plan. Fields: title, description, project, branchStrategy (parallel/shared-branch)
- **cancel**: Cancel a running agent. Fields: agent (agent ID), reason
- **retry**: Retry failed work items. Fields: ids (array of work item IDs)
- **pause-plan**: Pause a PRD (stop materializing items). Fields: file (PRD .json filename)
- **approve-plan**: Approve a PRD (start materializing items). Fields: file (PRD .json filename)
- **edit-prd-item**: Edit a PRD item. Fields: source (PRD filename), itemId, name, description, priority, complexity
- **remove-prd-item**: Remove a PRD item. Fields: source (PRD filename), itemId
- **delete-work-item**: Delete a work item. Fields: id, source (project name or "central")
- **plan-edit**: Revise/edit a plan .md file. Fields: file (plan .md filename from plans/), instruction (what to change).
- **execute-plan**: Execute an existing plan .md file. Fields: file (plan .md filename), project (optional)
- **file-edit**: Edit any squad file via LLM. Fields: file (path relative to squad dir), instruction (what to change).

## Rules

1. **Use tools proactively.** Read files before answering — don't guess from the state snapshot alone.
2. Be specific — cite IDs, agent names, statuses, filenames, line numbers.
3. When delegating, include the action block AND explain what you're doing.
4. Resolve references like "ripley's plan", "the failing PR" by reading files.
5. When recommending which agent to assign, read \`routing.md\` and agent charters.
6. Keep responses concise but informative. Use markdown.
7. **Never modify engine source code** (engine.js, engine/*.js, dashboard.js/html, squad.js, bin/).
8. **Never push to git remotes** without the user explicitly confirming.
9. For long-running processes (dev servers), start them detached so they survive after your session.`;

function buildCCStatePreamble() {
  // Lightweight snapshot — just enough to orient. Use tools for details.
  const agents = getAgents().map(a => `- ${a.name} (${a.id}): ${a.status}${a.currentTask ? ' — ' + a.currentTask.slice(0, 60) : ''}`).join('\n');
  const projects = PROJECTS.map(p => `- ${p.name}: ${p.localPath}`).join('\n');

  const dq = getDispatchQueue();
  const active = (dq.active || []).map(d => `- ${d.agentName || d.agent}: ${(d.task || '').slice(0, 50)}`).join('\n') || '(none)';
  const pending = (dq.pending || []).length;

  const prCount = getPullRequests().length;
  const wiCount = getWorkItems().length;

  const planFiles = [...safeReadDir(PLANS_DIR), ...safeReadDir(PRD_DIR)].filter(f => f.endsWith('.md') || f.endsWith('.json'));

  return `### Agents
${agents}

### Active Dispatch
${active}
Pending: ${pending}

### Quick Counts
PRs: ${prCount} | Work items: ${wiCount} | Plans/PRDs on disk: ${planFiles.length}

### Projects
${projects}

For details on any of the above, use your tools to read files under \`${SQUAD_DIR}\`.`;
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
} catch {}

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
    };
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
  } else if (key) {
    const prev = docSessions.get(key);
    docSessions.set(key, {
      sessionId,
      lastActiveAt: now,
      turnCount: (existing && prev ? prev.turnCount : 0) + 1,
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
async function ccCall(message, { store = 'cc', sessionKey, extraContext, label = 'command-center', timeout = 600000, maxTurns = 25, allowedTools = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch', skipStatePreamble = false, model = 'sonnet' } = {}) {
  const existing = resolveSession(store, sessionKey);
  let sessionId = existing ? existing.sessionId : null;

  const parts = skipStatePreamble ? [] : [`## Current Squad State (${new Date().toISOString().slice(0, 16)})\n\n${buildCCStatePreamble()}`];
  if (extraContext) parts.push(extraContext);
  parts.push(message);
  const prompt = parts.join('\n\n---\n\n');

  let result;

  // Attempt 1: resume existing session (skip for single-turn/no-tool calls — nothing to resume)
  if (sessionId && maxTurns > 1) {
    result = await llm.callLLM(prompt, '', {
      timeout, label, model, maxTurns, allowedTools, sessionId,
    });
    llm.trackEngineUsage(label, result.usage);

    if (result.code === 0 && result.text) {
      updateSession(store, sessionKey, result.sessionId || sessionId, true);
      return result;
    }
    console.log(`[${label}] Resume failed (code=${result.code}, empty=${!result.text}), retrying fresh...`);
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

  // Attempt 2: fresh session
  result = await llm.callLLM(prompt, CC_STATIC_SYSTEM_PROMPT, {
    timeout, label, model, maxTurns, allowedTools,
  });
  llm.trackEngineUsage(label, result.usage);

  if (result.code === 0 && result.text) {
    updateSession(store, sessionKey, result.sessionId, false);
    return result;
  }

  // Attempt 3: one more retry after a brief pause (skip for single-turn — not worth the latency)
  if (maxTurns <= 1) return result;
  console.log(`[${label}] Fresh call also failed (code=${result.code}, empty=${!result.text}), retrying once more...`);
  await new Promise(r => setTimeout(r, 2000));
  result = await llm.callLLM(prompt, CC_STATIC_SYSTEM_PROMPT, {
    timeout, label, model, maxTurns, allowedTools,
  });
  llm.trackEngineUsage(label, result.usage);

  if (result.code === 0 && result.text) {
    updateSession(store, sessionKey, result.sessionId, false);
  }
  return result;
}

// Doc-specific wrapper — adds document context, parses ---DOCUMENT---
async function ccDocCall({ message, document, title, filePath, selection, canEdit, isJson }) {
  const docContext = `## Document Context\n**${title || 'Document'}**${filePath ? ' (`' + filePath + '`)' : ''}${isJson ? ' (JSON)' : ''}\n${selection ? '\n**Selected text:**\n> ' + selection.slice(0, 1500) + '\n' : ''}\n\`\`\`\n${document.slice(0, 20000)}\n\`\`\`\n${canEdit ? '\nIf editing: respond with your explanation, then `---DOCUMENT---` on its own line, then the COMPLETE updated file.' : '\n(Read-only — answer questions only.)'}`;

  // Plans: Sonnet with tools for codebase-aware Q&A and edits
  // Everything else: Haiku, 1 turn, no tools — fast
  const isPlan = filePath && /^plans\//.test(filePath);
  const result = await ccCall(message, {
    store: 'doc', sessionKey: filePath || title,
    extraContext: docContext, label: 'doc-chat',
    timeout: isPlan ? 300000 : 60000,
    maxTurns: isPlan ? 10 : 1,
    model: isPlan ? 'sonnet' : 'haiku',
    allowedTools: isPlan ? 'Read,Glob,Grep' : '',
    skipStatePreamble: !isPlan,
  });

  if (result.code !== 0 || !result.text) {
    return { answer: 'Failed to process request. Try again.', content: null, actions: [] };
  }

  const { text: stripped, actions } = parseCCActions(result.text);

  const delimIdx = stripped.indexOf('---DOCUMENT---');
  if (delimIdx >= 0) {
    const answer = stripped.slice(0, delimIdx).trim();
    let content = stripped.slice(delimIdx + '---DOCUMENT---'.length).trim();
    content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    return { answer, content, actions };
  }

  return { answer: stripped, content: null, actions };
}

// -- POST helpers --

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
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
  const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
  try {
    let removed = 0;
    mutateJsonFileLocked(dispatchPath, (dispatch) => {
      dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
      dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
      dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
      for (const queue of ['pending', 'active', 'completed']) {
        const before = dispatch[queue].length;
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
      return dispatch;
    }, { defaultValue: { pending: [], active: [], completed: [] } });
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

  // POST /api/plans/trigger-verify — manually trigger verification for a completed plan
  if (req.method === 'POST' && req.url === '/api/plans/trigger-verify') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });

      // Find the PRD — check active and archive
      const prdDir = path.join(SQUAD_DIR, 'prd');
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
        const plan = JSON.parse(safeRead(prdPath));
        plan.status = 'approved';
        delete plan.completedAt;
        safeWrite(activePath, plan);
      }

      // Trigger completion check
      const lifecycle = require('./engine/lifecycle');
      const config = queries.getConfig();
      lifecycle.checkPlanCompletion({ item: { sourcePlan: body.file, id: 'manual' } }, config);

      // Check if verify was created
      const project = PROJECTS.find(p => {
        const plan = JSON.parse(safeRead(activePath) || safeRead(prdPath) || '{}');
        return p.name?.toLowerCase() === (plan.project || '').toLowerCase();
      }) || PROJECTS[0];
      if (project) {
        const wiPath = shared.projectWorkItemsPath(project);
        const items = JSON.parse(safeRead(wiPath) || '[]');
        const verify = items.find(w => w.sourcePlan === body.file && w.itemType === 'verify');
        if (verify) {
          return jsonReply(res, 200, { ok: true, verifyId: verify.id });
        }
      }
      return jsonReply(res, 200, { ok: true, message: 'Completion check ran but no verify task was needed' });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
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
          wiPath = shared.projectWorkItemsPath(proj);
        }
      }
      if (!wiPath) return jsonReply(res, 404, { error: 'source not found' });

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const item = items.find(i => i.id === id);
      if (!item) return jsonReply(res, 404, { error: 'item not found' });

      item.status = 'pending';
      item._retryCount = 0; // Reset retry counter on manual retry
      delete item.dispatched_at;
      delete item.dispatched_to;
      delete item.failReason;
      delete item.failedAt;
      delete item.fanOutAgents;
      safeWrite(wiPath, items);

      // Clear completed dispatch entries so the engine doesn't dedup this item
      const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
      const sourcePrefix = (!source || source === 'central') ? 'central-work-' : `work-${source}-`;
      const dispatchKey = sourcePrefix + id;
      try {
        mutateJsonFileLocked(dispatchPath, (dispatch) => {
          dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
          dispatch.completed = dispatch.completed.filter(d => d.meta?.dispatchKey !== dispatchKey);
          dispatch.completed = dispatch.completed.filter(d => !d.meta?.parentKey || d.meta.parentKey !== dispatchKey);
          return dispatch;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      } catch {}

      // Clear cooldown so item isn't blocked by exponential backoff
      try {
        const cooldownPath = path.join(SQUAD_DIR, 'engine', 'cooldowns.json');
        const cooldowns = JSON.parse(safeRead(cooldownPath) || '{}');
        if (cooldowns[dispatchKey]) {
          delete cooldowns[dispatchKey];
          safeWrite(cooldownPath, cooldowns);
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
          wiPath = shared.projectWorkItemsPath(proj);
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
          wiPath = shared.projectWorkItemsPath(proj);
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
        const archPath = shared.projectWorkItemsPath(project).replace('.json', '-archive.json');
        const content = safeRead(archPath);
        if (content) { try { allArchived.push(...JSON.parse(content).map(i => ({ ...i, _source: project.name }))); } catch {} }
      }
      return jsonReply(res, 200, allArchived);
    } catch (e) { console.error('Archive fetch error:', e.message); return jsonReply(res, 500, { error: e.message }); }
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
        wiPath = shared.projectWorkItemsPath(targetProject);
      } else {
        // Write to central queue — agent decides which project
        wiPath = path.join(SQUAD_DIR, 'work-items.json');
      }
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }
      const id = 'W-' + shared.uid();
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
      const filename = `${author}-${slug}-${today}-${shared.uid().slice(-4)}.md`;
      const content = `# ${body.title}\n\n**By:** ${author}\n**Date:** ${today}\n\n${body.what}\n${body.why ? '\n**Why:** ' + body.why + '\n' : ''}`;
      safeWrite(shared.uniquePath(path.join(inboxDir, filename)), content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plan — create a plan work item that chains to PRD on completion
  if (req.method === 'POST' && req.url === '/api/plan') {
    try {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) return jsonReply(res, 400, { error: 'title is required' });
      // Write as a work item with type 'plan' — user must explicitly execute plan-to-prd after reviewing
      const wiPath = path.join(SQUAD_DIR, 'work-items.json');
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }
      const id = 'W-' + shared.uid();
      const item = {
        id, title: body.title, type: 'plan',
        priority: body.priority || 'high', description: body.description || '',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard',
        branchStrategy: body.branch_strategy || 'parallel',
      };
      if (body.project) item.project = body.project;
      if (body.agent) item.agent = body.agent;
      items.push(item);
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, id, agent: body.agent || '' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items — create a PRD item as a plan file in prd/ (auto-approved)
  if (req.method === 'POST' && req.url === '/api/prd-items') {
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

  // POST /api/prd-items/update — edit a PRD item in its source plan JSON
  if (req.method === 'POST' && req.url === '/api/prd-items/update') {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = safeJson(planPath);
      const item = (plan.missing_features || []).find(f => f.id === body.itemId);
      if (!item) return jsonReply(res, 404, { error: 'item not found in plan' });

      // Update allowed fields
      if (body.name !== undefined) item.name = body.name;
      if (body.description !== undefined) item.description = body.description;
      if (body.priority !== undefined) item.priority = body.priority;
      if (body.estimated_complexity !== undefined) item.estimated_complexity = body.estimated_complexity;
      if (body.status !== undefined) item.status = body.status;

      // Re-read plan before writing to minimize race window with engine
      const freshPlan = safeJson(planPath) || plan;
      const freshItem = (freshPlan.missing_features || []).find(f => f.id === body.itemId);
      if (freshItem) {
        if (body.name !== undefined) freshItem.name = body.name;
        if (body.description !== undefined) freshItem.description = body.description;
        if (body.priority !== undefined) freshItem.priority = body.priority;
        if (body.estimated_complexity !== undefined) freshItem.estimated_complexity = body.estimated_complexity;
        if (body.status !== undefined) freshItem.status = body.status;
      }
      safeWrite(planPath, freshPlan);

      // Feature 3: Sync edits to materialized work item if still pending
      let workItemSynced = false;
      const wiSyncPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiSyncPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiSyncPaths) {
        try {
          const items = safeJson(wiPath);
          const wi = items.find(w => w.sourcePlan === body.source && w.id === body.itemId);
          if (wi && wi.status === 'pending') {
            if (body.name !== undefined) wi.title = 'Implement: ' + body.name;
            if (body.description !== undefined) wi.description = body.description;
            if (body.priority !== undefined) wi.priority = body.priority;
            if (body.estimated_complexity !== undefined) {
              wi.type = body.estimated_complexity === 'large' ? 'implement:large' : 'implement';
            }
            safeWrite(wiPath, items);
            workItemSynced = true;
          }
        } catch {}
      }

      return jsonReply(res, 200, { ok: true, item, workItemSynced });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd-items/remove — remove a PRD item from plan + cancel materialized work item
  if (req.method === 'POST' && req.url === '/api/prd-items/remove') {
    try {
      const body = await readBody(req);
      if (!body.source || !body.itemId) return jsonReply(res, 400, { error: 'source and itemId required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = safeJson(planPath);
      const idx = (plan.missing_features || []).findIndex(f => f.id === body.itemId);
      if (idx < 0) return jsonReply(res, 404, { error: 'item not found in plan' });

      plan.missing_features.splice(idx, 1);
      safeWrite(planPath, plan);

      // Also remove any materialized work item for this plan item
      let cancelled = false;
      for (const proj of PROJECTS) {
        const wiPath = shared.projectWorkItemsPath(proj);
        try {
          const items = safeJson(wiPath);
          const before = items.length;
          const filtered = items.filter(w => !(w.sourcePlan === body.source && w.id === body.itemId));
          if (filtered.length < before) {
            safeWrite(wiPath, filtered);
            cancelled = true;
          }
        } catch {}
      }
      // Also check central work-items
      const centralPath = path.join(SQUAD_DIR, 'work-items.json');
      try {
        const items = safeJson(centralPath);
        const before = items.length;
        const filtered = items.filter(w => !(w.sourcePlan === body.source && w.id === body.itemId));
        if (filtered.length < before) { safeWrite(centralPath, filtered); cancelled = true; }
      } catch {}

      // Clean dispatch entries for this item
      cleanDispatchEntries(d =>
        d.meta?.item?.sourcePlan === body.source && d.meta?.item?.id === body.itemId
      );

      return jsonReply(res, 200, { ok: true, cancelled });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/agents/cancel — cancel an active agent by ID or task substring
  if (req.method === 'POST' && req.url === '/api/agents/cancel') {
    try {
      const body = await readBody(req);
      const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
      const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
      const active = dispatch.active || [];
      const cancelled = [];

      for (const d of active) {
        const matchAgent = body.agent && d.agent === body.agent;
        const matchTask = body.task && (d.task || '').toLowerCase().includes((body.task || '').toLowerCase());
        if (!matchAgent && !matchTask) continue;

        // Kill agent process
        const statusPath = path.join(SQUAD_DIR, 'agents', d.agent, 'status.json');
        try {
          const status = JSON.parse(safeRead(statusPath) || '{}');
          if (status.pid) {
            if (process.platform === 'win32') {
              try { require('child_process').execSync('taskkill /PID ' + status.pid + ' /F /T', { stdio: 'pipe', timeout: 5000 }); } catch {}
            } else {
              try { process.kill(status.pid, 'SIGTERM'); } catch {}
            }
          }
          status.status = 'idle';
          delete status.currentTask;
          delete status.dispatched;
          safeWrite(statusPath, status);
        } catch {}

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

  // POST /api/knowledge/sweep — deduplicate, consolidate, and reorganize knowledge base
  if (req.method === 'POST' && req.url === '/api/knowledge/sweep') {
    if (global._kbSweepInFlight) return jsonReply(res, 409, { error: 'sweep already in progress' });
    global._kbSweepInFlight = true;
    try {
      const entries = getKnowledgeBaseEntries();
      if (entries.length < 2) return jsonReply(res, 200, { ok: true, summary: 'nothing to sweep (< 2 entries)' });

      // Build a manifest of all KB entries with their content
      const manifest = [];
      for (const e of entries) {
        const content = safeRead(path.join(SQUAD_DIR, 'knowledge', e.cat, e.file));
        if (!content) continue;
        manifest.push({ category: e.cat, file: e.file, title: e.title, agent: e.agent, date: e.date, content: content.slice(0, 3000) });
      }

      const prompt = `You are a knowledge base curator. Analyze these ${manifest.length} knowledge base entries and produce a cleanup plan.

## Entries

${manifest.map((m, i) => `<entry index="${i}" category="${m.category}" file="${m.file}" date="${m.date}" agent="${m.agent || 'unknown'}">
${m.title}
${m.content.slice(0, 1500)}
</entry>`).join('\n\n')}

## Instructions

1. **Find duplicates**: entries with substantially the same content or insights (same findings from different agents or dispatch runs). List pairs/groups by index.

2. **Find misclassified**: entries in the wrong category. Common: build reports in conventions, reviews in architecture.

3. **Find stale/empty**: entries with no actionable content (boilerplate, "no changes needed", bail-out notes).

## Output Format

Respond with ONLY valid JSON (no markdown fences, no preamble):

{
  "duplicates": [
    { "keep": 0, "remove": [1, 5], "reason": "same PR review findings" }
  ],
  "reclassify": [
    { "index": 3, "from": "conventions", "to": "build-reports", "reason": "..." }
  ],
  "remove": [
    { "index": 7, "reason": "empty bail-out note" }
  ]
}

If nothing to do, return: { "duplicates": [], "reclassify": [], "remove": [] }`;

      const { callLLM, trackEngineUsage } = require('./engine/llm');
      const result = await callLLM(prompt, 'You are a concise knowledge curator. Output only JSON.', {
        timeout: 180000, label: 'kb-sweep', model: 'haiku', maxTurns: 1
      });
      trackEngineUsage('kb-sweep', result.usage);

      let plan;
      try {
        let jsonStr = result.text.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        plan = JSON.parse(jsonStr);
      } catch {
        return jsonReply(res, 200, { ok: false, error: 'LLM returned invalid JSON', raw: result.text.slice(0, 500) });
      }

      let removed = 0, reclassified = 0, merged = 0;
      const kbDir = path.join(SQUAD_DIR, 'knowledge');

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
        } catch {}
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
        } catch {}
      }

      const summary = `${merged} duplicates merged, ${removed} stale removed, ${reclassified} reclassified`;
      safeWrite(path.join(ENGINE_DIR, 'kb-swept.json'), JSON.stringify({ timestamp: new Date().toISOString(), summary }));
      return jsonReply(res, 200, { ok: true, summary, plan });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); } finally { global._kbSweepInFlight = false; }
  }

  // GET /api/plans — list plan files (.md drafts from plans/ + .json PRDs from prd/)
  if (req.method === 'GET' && req.url === '/api/plans') {
    const dirs = [
      { dir: PLANS_DIR, archived: false },
      { dir: path.join(PLANS_DIR, 'archive'), archived: true },
      { dir: PRD_DIR, archived: false },
      { dir: path.join(PRD_DIR, 'archive'), archived: true },
    ];
    // Load work items to check for completed plan-to-prd conversions
    const centralWi = JSON.parse(safeRead(path.join(SQUAD_DIR, 'work-items.json')) || '[]');
    const completedPrdFiles = new Set(
      centralWi.filter(w => w.type === 'plan-to-prd' && w.status === 'done' && w.planFile)
        .map(w => w.planFile)
    );
    const plans = [];
    for (const { dir, archived } of dirs) {
      const allFiles = safeReadDir(dir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const f of allFiles) {
        const filePath = path.join(dir, f);
        const content = safeRead(filePath) || '';
        let updatedAt = '';
        try { updatedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString(); } catch {}
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
            });
          } catch {}
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

  // GET /api/plans/archive/:file — read archived plan (checks prd/archive/ and plans/archive/)
  const archiveFileMatch = req.url.match(/^\/api\/plans\/archive\/([^?]+)$/);
  if (archiveFileMatch && req.method === 'GET') {
    const file = decodeURIComponent(archiveFileMatch[1]);
    if (file.includes('..')) return jsonReply(res, 400, { error: 'invalid' });
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

  // GET /api/plans/:file — read full plan (JSON from prd/ or markdown from plans/)
  const planFileMatch = req.url.match(/^\/api\/plans\/([^?]+)$/);
  if (planFileMatch && req.method === 'GET') {
    const file = decodeURIComponent(planFileMatch[1]);
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return jsonReply(res, 400, { error: 'invalid' });
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
    for (const p of planCandidates) { try { const st = fs.statSync(p); if (st) { res.setHeader('Last-Modified', st.mtime.toISOString()); res.setHeader('X-Resolved-Path', path.relative(SQUAD_DIR, p).replace(/\\/g, '/')); break; } } catch {} }
    const contentType = file.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType + '; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  // POST /api/plans/approve — approve a plan for execution
  if (req.method === 'POST' && req.url === '/api/plans/approve') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'approved';
      plan.approvedAt = new Date().toISOString();
      plan.approvedBy = body.approvedBy || os.userInfo().username;
      delete plan.pausedAt;
      safeWrite(planPath, plan);

      // Resume paused work items across all projects
      let resumed = 0;
      const resumedItemIds = [];
      const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiPaths) {
        try {
          const items = safeJson(wiPath);
          if (!items) continue;
          let changed = false;
          for (const w of items) {
            if (w.sourcePlan === body.file && w.status === 'paused' && w._pausedBy === 'prd-pause') {
              w.status = 'pending';
              delete w._pausedBy;
              w._resumedAt = new Date().toISOString();
              resumedItemIds.push(w.id);
              resumed++;
              changed = true;
            }
          }
          if (changed) safeWrite(wiPath, items);
        } catch {}
      }

      // Clear dispatch completed entries for resumed items so they aren't dedup-blocked
      if (resumedItemIds.length > 0) {
        const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
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

  // POST /api/plans/pause — pause a plan (stops new item materialization + pauses work items)
  if (req.method === 'POST' && req.url === '/api/plans/pause') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'paused';
      plan.pausedAt = new Date().toISOString();
      safeWrite(planPath, plan);

      // Propagate pause to materialized work items across all projects
      // But skip items that already have active PRs — those are past the point of pausing
      let paused = 0;
      const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      const allPrItemIds = new Set();
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
        try {
          const prs = safeJson(shared.projectPrPath(proj)) || [];
          for (const pr of prs) {
            if (pr.status === 'active' && pr.prdItems?.length) {
              pr.prdItems.forEach(id => allPrItemIds.add(id));
            }
          }
        } catch {}
      }
      const dispatchPath = path.join(SQUAD_DIR, 'engine', 'dispatch.json');
      const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
      const killedAgents = [];

      for (const wiPath of wiPaths) {
        try {
          const items = safeJson(wiPath);
          if (!items) continue;
          let changed = false;
          for (const w of items) {
            if (w.sourcePlan !== body.file) continue;
            // Don't pause if this item already has an active PR
            if (allPrItemIds.has(w.id) || allPrItemIds.has(w.sourcePlanItem)) continue;

            if (w.status === 'pending') {
              w.status = 'paused';
              w._pausedBy = 'prd-pause';
              paused++;
              changed = true;
            } else if (w.status === 'dispatched') {
              // Kill the agent working on this item
              const activeEntry = (dispatch.active || []).find(d => d.meta?.dispatchKey?.includes(w.id));
              if (activeEntry) {
                const statusPath = path.join(SQUAD_DIR, 'agents', activeEntry.agent, 'status.json');
                try {
                  const agentStatus = JSON.parse(safeRead(statusPath) || '{}');
                  if (agentStatus.pid) {
                    if (process.platform === 'win32') {
                      try { require('child_process').execSync('taskkill /PID ' + agentStatus.pid + ' /F /T', { stdio: 'pipe', timeout: 5000 }); } catch {}
                    } else {
                      try { process.kill(agentStatus.pid, 'SIGTERM'); } catch {}
                    }
                  }
                  agentStatus.status = 'idle';
                  delete agentStatus.currentTask;
                  delete agentStatus.dispatched;
                  safeWrite(statusPath, agentStatus);
                } catch {}
                killedAgents.push(activeEntry.agent);
              }
              w.status = 'paused';
              w._pausedBy = 'prd-pause';
              paused++;
              changed = true;
            }
          }
          if (changed) safeWrite(wiPath, items);
        } catch {}
      }

      // Remove killed agents from dispatch active
      if (killedAgents.length > 0) {
        const killedSet = new Set(killedAgents);
        mutateJsonFileLocked(dispatchPath, (dp) => {
          dp.active = Array.isArray(dp.active) ? dp.active : [];
          dp.active = dp.active.filter(d => !killedSet.has(d.agent));
          return dp;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, status: 'paused', pausedWorkItems: paused });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/prd/regenerate — regenerate PRD from revised source plan
  if (req.method === 'POST' && req.url === '/api/prd/regenerate') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file is required' });
      if (body.file.includes('..')) return jsonReply(res, 400, { error: 'invalid file path' });

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
        const projItems = safeJson(projWiPath);
        if (!projItems) continue;
        const filtered = projItems.filter(w => {
          if (w.sourcePlan !== body.file) return true; // different plan, keep
          return completedStatuses.has(w.status); // keep completed, remove pending/failed
        });
        if (filtered.length < projItems.length) safeWrite(projWiPath, filtered);
      }

      // Delete old PRD — agent will write replacement at same path
      try { fs.unlinkSync(prdPath); } catch {}

      // Queue plan-to-prd regeneration with instructions to preserve completed items
      const wiPath = path.join(SQUAD_DIR, 'work-items.json');
      let items = [];
      const existing = safeRead(wiPath);
      if (existing) { try { items = JSON.parse(existing); } catch {} }

      // Dedup: check if already queued
      const alreadyQueued = items.find(w =>
        w.type === 'plan-to-prd' && w.planFile === plan.source_plan && (w.status === 'pending' || w.status === 'dispatched')
      );
      if (alreadyQueued) return jsonReply(res, 200, { id: alreadyQueued.id, alreadyQueued: true });

      const completedContext = completedItems.length > 0
        ? `\n\n**Previously completed items (preserve their status in the new PRD):**\n${completedItems.map(i => `- ${i.id}: ${i.name} [${i.status}]`).join('\n')}`
        : '';

      const id = 'W-' + shared.uid();
      items.push({
        id, title: `Regenerate PRD: ${plan.plan_summary || plan.source_plan}`,
        type: 'plan-to-prd', priority: 'high',
        description: `Plan file: plans/${plan.source_plan}\nTarget PRD filename: ${body.file}\nRegeneration requested by user after plan revision.${completedContext}`,
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard:regenerate',
        project: plan.project || '', planFile: plan.source_plan,
        _targetPrdFile: body.file,
      });
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { id, file: plan.source_plan });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
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

      const id = 'W-' + shared.uid();
      items.push({
        id, title: 'Convert plan to PRD: ' + body.file.replace('.md', ''),
        type: 'plan-to-prd', priority: 'high',
        description: 'Plan file: plans/' + body.file,
        status: 'pending', created: new Date().toISOString(),
        createdBy: 'dashboard:execute', project: body.project || '',
        planFile: body.file,
      });
      safeWrite(centralPath, items);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/reject — reject a plan
  if (req.method === 'POST' && req.url === '/api/plans/reject') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      const planPath = resolvePlanPath(body.file);
      const plan = JSON.parse(safeRead(planPath) || '{}');
      plan.status = 'rejected';
      plan.rejectedAt = new Date().toISOString();
      plan.rejectedBy = body.rejectedBy || os.userInfo().username;
      if (body.reason) plan.rejectionReason = body.reason;
      safeWrite(planPath, plan);
      return jsonReply(res, 200, { ok: true, status: 'rejected' });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/regenerate — reset pending/failed work items for a plan so they re-materialize
  if (req.method === 'POST' && req.url === '/api/plans/regenerate') {
    try {
      const body = await readBody(req);
      if (!body.source) return jsonReply(res, 400, { error: 'source required' });
      const planPath = resolvePlanPath(body.source);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });
      const plan = safeJson(planPath);
      const planItems = plan.missing_features || [];

      let reset = 0, kept = 0, newCount = 0;
      const deletedItemIds = [];

      // Scan all work item sources for materialized items from this plan
      const wiPaths = [{ path: path.join(SQUAD_DIR, 'work-items.json'), label: 'central' }];
      for (const proj of PROJECTS) {
        wiPaths.push({ path: shared.projectWorkItemsPath(proj), label: proj.name });
      }

      // Track which plan items have materialized work items
      const materializedPlanItemIds = new Set();

      for (const wiInfo of wiPaths) {
        try {
          const items = safeJson(wiInfo.path);
          const filtered = [];
          for (const w of items) {
            if (w.sourcePlan === body.source) {
              materializedPlanItemIds.add(w.id);
              if (w.status === 'pending' || w.status === 'failed') {
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
          if (filtered.length < items.length) {
            safeWrite(wiInfo.path, filtered);
          }
        } catch {}
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

  // POST /api/plans/delete — delete a plan file
  if (req.method === 'POST' && req.url === '/api/plans/delete') {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      if (body.file.includes('..') || body.file.includes('/') || body.file.includes('\\')) {
        return jsonReply(res, 400, { error: 'invalid filename' });
      }
      const planPath = resolvePlanPath(body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan not found' });
      // Read PRD content before deleting to get source_plan for cleanup
      let prdSourcePlan = null;
      if (body.file.endsWith('.json')) {
        try { prdSourcePlan = JSON.parse(safeRead(planPath) || '{}').source_plan || null; } catch {}
      }
      safeUnlink(planPath);

      // Clean up materialized work items from all projects + central
      let cleaned = 0;
      const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(shared.projectWorkItemsPath(proj));
      }
      for (const wiPath of wiPaths) {
        try {
          const items = safeJson(wiPath);
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

      // If deleting a PRD .json, reset the plan-to-prd work item so the source .md reverts to draft
      if (prdSourcePlan) {
        try {
          const centralPath = path.join(SQUAD_DIR, 'work-items.json');
          const centralItems = safeJson(centralPath) || [];
          let changed = false;
          for (const w of centralItems) {
            if (w.type === 'plan-to-prd' && w.status === 'done' && w.planFile === prdSourcePlan) {
              w.status = 'cancelled';
              w._cancelledBy = 'prd-deleted';
              changed = true;
            }
          }
          if (changed) safeWrite(centralPath, centralItems);
        } catch {}
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, cleanedWorkItems: cleaned, cleanedDispatches: dispatchCleaned });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/revise — request revision with feedback, dispatches agent to revise
  if (req.method === 'POST' && req.url === '/api/plans/revise') {
    try {
      const body = await readBody(req);
      if (!body.file || !body.feedback) return jsonReply(res, 400, { error: 'file and feedback required' });
      const planPath = resolvePlanPath(body.file);
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
      const id = 'W-' + shared.uid();
      items.push({
        id, title: 'Revise plan: ' + (plan.plan_summary || body.file),
        type: 'plan-to-prd', priority: 'high',
        description: 'Revision requested on plan file: ' + (body.file.endsWith('.json') ? 'prd/' : 'plans/') + body.file + '\n\nFeedback:\n' + body.feedback + '\n\nRevise the plan to address this feedback. Read the existing plan, apply the feedback, and overwrite the file with the updated version. Set status back to "awaiting-approval".',
        status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard:revision',
        project: plan.project || '',
        planFile: body.file,
      });
      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, status: 'revision-requested', workItemId: id });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/plans/revise-and-regenerate — REMOVED: plan versioning now handled by /api/doc-chat
  // The "Replace old PRD" flow uses qaReplacePrd (frontend) which calls /api/plans/pause + /api/plans/regenerate + planExecute
  if (false && req.method === 'POST' && req.url === '/api/plans/revise-and-regenerate') {
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
        const prd = JSON.parse(safeRead(prdPath) || '{}');
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
      const prd = JSON.parse(safeRead(prdPath) || '{}');
      prd.status = 'revision-requested';
      prd.revision_feedback = body.instruction;
      prd.revisionRequestedAt = new Date().toISOString();
      safeWrite(prdPath, prd);

      // Step 3: Clean up pending/failed work items from old PRD
      let reset = 0, kept = 0;
      const wiPaths = [{ path: path.join(SQUAD_DIR, 'work-items.json'), label: 'central' }];
      for (const proj of PROJECTS) {
        wiPaths.push({ path: shared.projectWorkItemsPath(proj), label: proj.name });
      }
      const deletedItemIds = [];
      for (const wiInfo of wiPaths) {
        try {
          const items = safeJson(wiInfo.path);
          const filtered = [];
          for (const w of items) {
            if (w.sourcePlan === body.source) {
              if (w.status === 'pending' || w.status === 'failed') {
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
          if (filtered.length < items.length) safeWrite(wiInfo.path, filtered);
        } catch {}
      }
      for (const itemId of deletedItemIds) {
        cleanDispatchEntries(d =>
          d.meta?.item?.sourcePlan === body.source && d.meta?.item?.id === itemId
        );
      }

      // Step 4: Dispatch plan-to-prd to regenerate PRD from revised plan
      const centralWiPath = path.join(SQUAD_DIR, 'work-items.json');
      let centralItems = [];
      try { centralItems = JSON.parse(safeRead(centralWiPath) || '[]'); } catch {}
      const wiId = 'W-' + shared.uid();
      centralItems.push({
        id: wiId,
        title: 'Regenerate PRD from revised plan: ' + sourcePlanFile,
        type: 'plan-to-prd',
        priority: 'high',
        description: `The source plan \`${sourcePlanFile}\` has been revised. Convert it into a fresh PRD JSON.\n\nRevision instruction: ${body.instruction}\n\nRead the revised plan, generate updated PRD items (missing_features), and write to \`prd/${body.source}\`. Set status to "approved". Include \`"source_plan": "${sourcePlanFile}"\` in the JSON root.\n\nPreserve items that are already done (status "implemented" or "complete"). Reset or replace items that were pending/failed.`,
        status: 'pending',
        created: new Date().toISOString(),
        createdBy: 'dashboard:revise-and-regenerate',
        project: prd.project || '',
        planFile: sourcePlanFile,
      });
      safeWrite(centralWiPath, centralItems);

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

  // POST /api/plans/discuss — generate a plan discussion session script
  if (req.method === 'POST' && req.url === '/api/plans/discuss') {
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
      const id = shared.uid();
      const sysFile = path.join(sessionDir, `plan-discuss-sys-${id}.md`);
      const promptFile = path.join(sessionDir, `plan-discuss-prompt-${id}.md`);
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

  // POST /api/doc-chat — routes through CC session for squad-aware doc Q&A + editing
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

      const { answer, content, actions } = await ccDocCall({
        message: body.message, document: currentContent, title: body.title,
        filePath: body.filePath, selection: body.selection, canEdit, isJson,
      });

      if (!content) return jsonReply(res, 200, { ok: true, answer, edited: false, actions });

      if (isJson) {
        try { JSON.parse(content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(JSON invalid — not saved: ' + e.message + ')', edited: false, actions });
        }
      }
      if (canEdit && fullPath) {
        // Always save in-place — the engine's staleness detection handles PRD sync
        // if the source plan changes while an active PRD is running.
        safeWrite(fullPath, content);
        return jsonReply(res, 200, { ok: true, answer, edited: true, content, actions });
      }
      return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(Read-only — changes not saved)', edited: false, actions });
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
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `persisted-${name}`), _c); safeUnlink(inboxPath); } catch {}

      return jsonReply(res, 200, { ok: true, title });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/inbox/promote-kb — promote an inbox item to the knowledge base
  if (req.method === 'POST' && req.url === '/api/inbox/promote-kb') {
    try {
      const body = await readBody(req);
      const { name, category } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });
      if (!category || !shared.KB_CATEGORIES.includes(category)) {
        return jsonReply(res, 400, { error: 'category required: ' + shared.KB_CATEGORIES.join(', ') });
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
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `kb-${category}-${name}`), _c); safeUnlink(inboxPath); } catch {}

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
      safeUnlink(filePath);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // GET /api/skill?file=<name>&source=claude-code|project:<name>&dir=<path>
  if (req.method === 'GET' && req.url.startsWith('/api/skill?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const file = params.get('file');
    const dir = params.get('dir');
    if (!file || file.includes('..')) { res.statusCode = 400; res.end('Invalid file'); return; }

    let content = '';
    if (dir) {
      // Direct path from collectSkillFiles
      const fullPath = path.join(dir.replace(/\//g, path.sep), file);
      if (!fullPath.includes('..')) content = safeRead(fullPath) || '';
    }
    if (!content) {
      // Fallback: search Claude Code skills, then project skills
      const home = process.env.HOME || process.env.USERPROFILE || '';
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
      const config = safeJson(configPath);
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
          const pkg = safeJson(pkgPath);
          if (pkg.name) detected.name = pkg.name.replace(/^@[^/]+\//, '');
        }
      } catch {}
      let description = '';
      try {
        const claudeMd = path.join(target, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          const lines = (safeRead(claudeMd) || '').split('\n').filter(l => l.trim() && !l.startsWith('#'));
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
        workSources: { pullRequests: { enabled: true, cooldownMinutes: 30 }, workItems: { enabled: true, cooldownMinutes: 0 } }
      };

      config.projects.push(project);
      safeWrite(configPath, config);
      reloadConfig(); // Update in-memory project list immediately

      // Create project-local state files
      const squadDir = path.join(target, '.squad');
      if (!fs.existsSync(squadDir)) fs.mkdirSync(squadDir, { recursive: true });
      const stateFiles = { 'pull-requests.json': '[]', 'work-items.json': '[]' };
      for (const [f, content] of Object.entries(stateFiles)) {
        const fp = path.join(squadDir, f);
        if (!fs.existsSync(fp)) safeWrite(fp, content);
      }

      return jsonReply(res, 200, { ok: true, name, path: target, detected });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // ── Command Center: persistent multi-turn session ──────────────────────────

  // POST /api/command-center/new-session — clear active CC session
  if (req.method === 'POST' && req.url === '/api/command-center/new-session') {
    ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
    ccInFlight = false; // Reset concurrency guard so a stuck request doesn't block new sessions
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
    return jsonReply(res, 200, { ok: true });
  }

  // POST /api/command-center — conversational command center with full squad context
  if (req.method === 'POST' && req.url === '/api/command-center') {
    try {
      const body = await readBody(req);
      if (!body.message) return jsonReply(res, 400, { error: 'message required' });

      // Concurrency guard — only one CC call at a time, with auto-release for stuck requests
      if (ccInFlight && (Date.now() - ccInFlightSince) < CC_INFLIGHT_TIMEOUT_MS) {
        return jsonReply(res, 429, { error: 'Command Center is busy — wait for the current request to finish.' });
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

        if (result.code !== 0 || !result.text) {
          const debugInfo = result.code !== 0 ? `(exit code ${result.code})` : '(empty response)';
          const stderrTail = (result.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
          console.error(`[CC] LLM failed after retries ${debugInfo}: ${stderrTail}`);
          return jsonReply(res, 200, {
            text: `I had trouble processing that ${debugInfo}. ${stderrTail ? 'Detail: ' + stderrTail : ''}\n\nTry clicking **New Session** and sending your message again.`,
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

  // GET /api/settings — return current engine + claude + routing config
  if (req.method === 'GET' && req.url === '/api/settings') {
    try {
      const config = queries.getConfig();
      const routing = safeRead(path.join(SQUAD_DIR, 'routing.md')) || '';
      return jsonReply(res, 200, {
        engine: config.engine || {},
        claude: config.claude || {},
        agents: config.agents || {},
        routing,
      });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/settings — update engine + claude + agent config
  if (req.method === 'POST' && req.url === '/api/settings') {
    try {
      const body = await readBody(req);
      const configPath = path.join(SQUAD_DIR, 'config.json');
      const config = safeJson(configPath);

      if (body.engine) {
        // Validate and apply engine settings
        const e = body.engine;
        const D = shared.ENGINE_DEFAULTS;
        if (e.tickInterval !== undefined) config.engine.tickInterval = Math.max(10000, Number(e.tickInterval) || D.tickInterval);
        if (e.maxConcurrent !== undefined) config.engine.maxConcurrent = Math.max(1, Math.min(10, Number(e.maxConcurrent) || D.maxConcurrent));
        if (e.inboxConsolidateThreshold !== undefined) config.engine.inboxConsolidateThreshold = Math.max(1, Number(e.inboxConsolidateThreshold) || D.inboxConsolidateThreshold);
        if (e.agentTimeout !== undefined) config.engine.agentTimeout = Math.max(60000, Number(e.agentTimeout) || D.agentTimeout);
        if (e.maxTurns !== undefined) config.engine.maxTurns = Math.max(5, Math.min(500, Number(e.maxTurns) || D.maxTurns));
        if (e.heartbeatTimeout !== undefined) config.engine.heartbeatTimeout = Math.max(60000, Number(e.heartbeatTimeout) || D.heartbeatTimeout);
        if (e.worktreeCreateTimeout !== undefined) config.engine.worktreeCreateTimeout = Math.max(60000, Number(e.worktreeCreateTimeout) || D.worktreeCreateTimeout);
        if (e.worktreeCreateRetries !== undefined) config.engine.worktreeCreateRetries = Math.max(0, Math.min(3, Number(e.worktreeCreateRetries) || D.worktreeCreateRetries));
      }

      if (body.claude) {
        if (body.claude.allowedTools !== undefined) config.claude.allowedTools = String(body.claude.allowedTools);
        if (body.claude.outputFormat !== undefined) config.claude.outputFormat = String(body.claude.outputFormat);
      }

      if (body.agents) {
        for (const [id, updates] of Object.entries(body.agents)) {
          if (!config.agents[id]) continue;
          if (updates.role !== undefined) config.agents[id].role = String(updates.role);
          if (updates.skills !== undefined) config.agents[id].skills = Array.isArray(updates.skills) ? updates.skills : String(updates.skills).split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      safeWrite(configPath, config);
      return jsonReply(res, 200, { ok: true, message: 'Settings saved. Restart engine for changes to take full effect.' });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/settings/routing — update routing.md
  if (req.method === 'POST' && req.url === '/api/settings/routing') {
    try {
      const body = await readBody(req);
      if (!body.content) return jsonReply(res, 400, { error: 'content required' });
      safeWrite(path.join(SQUAD_DIR, 'routing.md'), body.content);
      return jsonReply(res, 200, { ok: true });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
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
    try {
      return jsonReply(res, 200, getStatus(), req);
    } catch (e) {
      return jsonReply(res, 500, { error: e.message }, req);
    }
  }

  // (duplicate /api/health removed — first handler above is the canonical one)

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
