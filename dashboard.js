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
const shared = require('./engine/shared');
const queries = require('./engine/queries');
const os = require('os');

const { safeRead, safeReadDir, safeWrite, safeJson, safeUnlink, mutateJsonFileLocked, getProjects: _getProjects } = shared;
const { getAgents, getAgentDetail, getPrdInfo, getWorkItems, getDispatchQueue,
  getSkills, getInbox, getNotesWithMeta, getPullRequests,
  getEngineLog, getMetrics, getKnowledgeBaseEntries, timeSince,
  MINIONS_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, DISPATCH_PATH, PRD_DIR } = queries;

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
let CONFIG = queries.getConfig();
let PROJECTS = _getProjects(CONFIG);
let projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');

function reloadConfig() {
  CONFIG = queries.getConfig();
  PROJECTS = _getProjects(CONFIG);
  projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');
}

const PLANS_DIR = path.join(MINIONS_DIR, 'plans');

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
  const pages = ['home', 'work', 'prd', 'prs', 'plans', 'inbox', 'tools', 'schedule', 'engine'];
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
    'render-other', 'render-schedules', 'render-pinned',
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
    .replace('/* __JS__ */', () => jsHtml);
}

let HTML_RAW = buildDashboardHtml();
let HTML = HTML_RAW.replace('Minions Mission Control', `Minions Mission Control — ${projectNames}`);
let HTML_GZ = zlib.gzipSync(HTML);
let HTML_ETAG = '"' + require('crypto').createHash('md5').update(HTML).digest('hex') + '"';

// Hot-reload: watch dashboard/ directory for changes, rebuild, and push reload to browsers
const _hotReloadClients = new Set();

function rebuildDashboardHtml() {
  try {
    const newRaw = buildDashboardHtml();
    if (newRaw === HTML_RAW) return; // no changes
    HTML_RAW = newRaw;
    HTML = HTML_RAW.replace('Minions Mission Control', `Minions Mission Control — ${projectNames}`);
    HTML_GZ = zlib.gzipSync(HTML);
    HTML_ETAG = '"' + require('crypto').createHash('md5').update(HTML).digest('hex') + '"';
    console.log('  Dashboard hot-reloaded');
    // Push reload to all connected browsers
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
  try { fs.watch(dashDir, scheduleReload); } catch {}
  // Watch subdirectories (pages/, js/)
  for (const sub of ['pages', 'js']) {
    const subDir = path.join(dashDir, sub);
    if (fs.existsSync(subDir)) try { fs.watch(subDir, scheduleReload); } catch {}
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
let _statusCacheTs = 0;
const STATUS_CACHE_TTL = 10000; // 10s — reduces expensive aggregation frequency; mutations call invalidateStatusCache()
function invalidateStatusCache() { _statusCache = null; }

function getStatus() {
  const now = Date.now();
  if (_statusCache && (now - _statusCacheTs) < STATUS_CACHE_TTL) return _statusCache;

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
    engine: getEngineState(),
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
    pinned: (() => { try { return parsePinnedEntries(safeRead(path.join(MINIONS_DIR, 'pinned.md'))); } catch { return []; } })(),
    projects: PROJECTS.map(p => ({ name: p.name, path: p.localPath, description: p.description || '' })),
    initialized: !!(CONFIG.agents && Object.keys(CONFIG.agents).length > 0),
    installId: safeRead(path.join(MINIONS_DIR, '.install-id')).trim() || null,
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
const CC_INFLIGHT_TIMEOUT_MS = 11 * 60 * 1000; // 11 minutes (slightly > LLM timeout)

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
const CC_STATIC_SYSTEM_PROMPT = `You are the Command Center AI for a software engineering minions called "Minions."
You have full CLI-level power — you can read, write, edit files, run shell commands, and execute builds just like a Claude Code CLI session. You also have minions-specific actions to delegate work to agents.

## Guardrails — What You Must NOT Touch

These files are the live engine. Modifying them can crash the minions or corrupt state:
- \`${MINIONS_DIR}/engine.js\` and \`${MINIONS_DIR}/engine/*.js\` — engine source code
- \`${MINIONS_DIR}/dashboard.js\` and \`${MINIONS_DIR}/dashboard.html\` — dashboard source
- \`${MINIONS_DIR}/minions.js\` and \`${MINIONS_DIR}/bin/*.js\` — CLI source
- \`${MINIONS_DIR}/engine/control.json\` — engine state (use CLI commands instead)
- \`${MINIONS_DIR}/engine/dispatch.json\` — dispatch queue (use actions instead)
- \`${MINIONS_DIR}/config.json\` — engine config (use actions or CLI instead)

You CAN freely read any of these files. You just must not write/edit them.

You CAN freely modify: notes, plans, knowledge base, work items, pull-requests.json, routing.md, agent charters, skills, playbooks, and anything in project repos.

## Filesystem — What's Where

\`\`\`
${MINIONS_DIR}/
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

Projects are configured in \`config.json\` under \`projects[]\`. Per-project state lives centrally in \`${MINIONS_DIR}/projects/{name}/\` — NOT inside project repos. There are no \`.minions/\` folders inside project repos.

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

## Minions Actions (Delegation)

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
- **file-edit**: Edit any minions file via LLM. Fields: file (path relative to minions dir), instruction (what to change).

## Rules

1. **Use tools proactively.** Read files before answering — don't guess from the state snapshot alone.
2. Be specific — cite IDs, agent names, statuses, filenames, line numbers.
3. When delegating, include the action block AND explain what you're doing.
4. Resolve references like "ripley's plan", "the failing PR" by reading files.
5. When recommending which agent to assign, read \`routing.md\` and agent charters.
6. Keep responses concise but informative. Use markdown.
7. **Never modify engine source code** (engine.js, engine/*.js, dashboard.js/html, minions.js, bin/).
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

  const schedules = CONFIG.schedules || [];
  const schedSummary = schedules.length > 0
    ? schedules.map(s => `- ${s.id}: "${s.title}" (cron: ${s.cron}, type: ${s.type || 'implement'}, ${s.enabled === false ? 'disabled' : 'enabled'})`).join('\n')
    : '(none configured)';

  return `### Agents
${agents}

### Active Dispatch
${active}
Pending: ${pending}

### Quick Counts
PRs: ${prCount} | Work items: ${wiCount} | Plans/PRDs on disk: ${planFiles.length} | Schedules: ${schedules.length}

### Projects
${projects}

### Scheduled Tasks
${schedSummary}

To discover all available dashboard APIs, fetch GET http://localhost:7331/api/routes — it returns every endpoint with method, path, description, and accepted parameters.

For details on any of the above, use your tools to read files under \`${MINIONS_DIR}\`.`;
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
async function ccCall(message, { store = 'cc', sessionKey, extraContext, label = 'command-center', timeout = 900000, maxTurns = 25, allowedTools = 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch', skipStatePreamble = false, model = 'sonnet' } = {}) {
  const existing = resolveSession(store, sessionKey);
  let sessionId = existing ? existing.sessionId : null;

  const parts = skipStatePreamble ? [] : [`## Current Minions State (${new Date().toISOString().slice(0, 16)})\n\n${buildCCStatePreamble()}`];
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

    // Distinguish "session exists but call failed" (e.g. tool timeout, signal timeout)
    // from "session is truly dead" (no sessionId returned, or stderr indicates invalid session).
    // If the session still exists, preserve it so the next "try again" can resume.
    const sessionStillValid = llm.isResumeSessionStillValid(result);
    if (sessionStillValid) {
      console.log(`[${label}] Resume call failed (code=${result.code}, empty=${!result.text}) but session is still valid — preserving session for retry`);
      // Update lastActiveAt so session doesn't expire while user retries
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
  const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
  const engineDir = path.join(MINIONS_DIR, 'engine');
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
            if (!matchFn(d)) continue;
            // Kill the running agent process via PID file
            const pidFile = path.join(engineDir, `pid-${d.id}.pid`);
            try {
              const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
              if (pid) process.kill(pid, 'SIGTERM');
            } catch {}
            try { fs.unlinkSync(pidFile); } catch {}
            // Clean up temp prompt files
            try { fs.unlinkSync(path.join(engineDir, 'tmp', `prompt-${d.id}.md`)); } catch {}
            try { fs.unlinkSync(path.join(engineDir, 'tmp', `sysprompt-${d.id}.md`)); } catch {}
            try { fs.unlinkSync(path.join(engineDir, 'tmp', `sysprompt-${d.id}.md.tmp`)); } catch {}
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

// ── Engine Restart Helpers (used by watchdog + API) ─────────────────────────

function spawnEngine() {
  const controlPath = path.join(ENGINE_DIR, 'control.json');
  safeWrite(controlPath, { state: 'stopped', pid: null, restarted_at: new Date().toISOString() });
  const { spawn: cpSpawn } = require('child_process');
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) delete childEnv[key];
  }
  const engineProc = cpSpawn(process.execPath, [path.join(MINIONS_DIR, 'engine.js'), 'start'], {
    cwd: MINIONS_DIR, stdio: 'ignore', detached: true, env: childEnv,
  });
  engineProc.unref();
  return engineProc.pid;
}

function killEnginePid(pid) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
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

  async function handleWorkItemsRetry(req, res) {
    try {
      const body = await readBody(req);
      const { id, source } = body;
      if (!id) return jsonReply(res, 400, { error: 'id required' });

      // Find the right file
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
      } catch {}

      // Clear cooldown so item isn't blocked by exponential backoff
      try {
        const cooldownPath = path.join(MINIONS_DIR, 'engine', 'cooldowns.json');
        const cooldowns = JSON.parse(safeRead(cooldownPath) || '{}');
        if (cooldowns[dispatchKey]) {
          delete cooldowns[dispatchKey];
          safeWrite(cooldownPath, cooldowns);
        }
      } catch {}

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

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const idx = items.findIndex(i => i.id === id);
      if (idx === -1) return jsonReply(res, 404, { error: 'item not found' });

      const item = items[idx];

      // Remove item from work-items file
      items.splice(idx, 1);
      safeWrite(wiPath, items);

      // Clean dispatch entries + kill running agent
      const dispatchRemoved = cleanDispatchEntries(d =>
        d.meta?.item?.id === id ||
        d.meta?.dispatchKey?.endsWith(id)
      );

      // Clean cooldown entries so item can be re-created immediately
      try {
        const cooldownPath = path.join(MINIONS_DIR, 'engine', 'cooldowns.json');
        const cooldowns = JSON.parse(safeRead(cooldownPath) || '{}');
        let cleaned = false;
        for (const key of Object.keys(cooldowns)) {
          if (key.includes(id)) { delete cooldowns[key]; cleaned = true; }
        }
        if (cleaned) safeWrite(cooldownPath, cooldowns);
      } catch {}

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
        const targetProject = PROJECTS.find(p => p.name === body.project) || PROJECTS[0];
        wiPath = shared.projectWorkItemsPath(targetProject);
      } else {
        // Write to central queue — agent decides which project
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
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
      if (body.references) item.references = body.references;
      if (body.acceptanceCriteria) item.acceptanceCriteria = body.acceptanceCriteria;
      items.push(item);
      safeWrite(wiPath, items);
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

      const items = JSON.parse(safeRead(wiPath) || '[]');
      const item = items.find(i => i.id === id);
      if (!item) return jsonReply(res, 404, { error: 'item not found' });

      if (item.status === 'dispatched') {
        return jsonReply(res, 400, { error: 'Cannot edit dispatched items' });
      }

      if (title !== undefined) item.title = title;
      if (description !== undefined) item.description = description;
      if (type !== undefined) item.type = type;
      if (priority !== undefined) item.priority = priority;
      if (agent !== undefined) item.agent = agent || null;
      if (body.references !== undefined) item.references = body.references;
      if (body.acceptanceCriteria !== undefined) item.acceptanceCriteria = body.acceptanceCriteria;
      item.updatedAt = new Date().toISOString();

      safeWrite(wiPath, items);
      return jsonReply(res, 200, { ok: true, item });
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
      const slug = (body.title || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
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
      const wiSyncPaths = [path.join(MINIONS_DIR, 'work-items.json')];
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

  async function handlePrdItemsRemove(req, res) {
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
      const centralPath = path.join(MINIONS_DIR, 'work-items.json');
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

  async function handleAgentsCancel(req, res) {
    try {
      const body = await readBody(req);
      const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
      const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
      const active = dispatch.active || [];
      const cancelled = [];

      for (const d of active) {
        const matchAgent = body.agent && d.agent === body.agent;
        const matchTask = body.task && (d.task || '').toLowerCase().includes((body.task || '').toLowerCase());
        if (!matchAgent && !matchTask) continue;

        // Kill agent process
        const statusPath = path.join(MINIONS_DIR, 'agents', d.agent, 'status.json');
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

  async function handleAgentLiveStream(req, res, match) {
    const agentId = match[1];
    const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
    const liveLogPath = path.join(agentDir, 'live-output.log');

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
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial content
    let offset = 0;
    try {
      const content = fs.readFileSync(liveLogPath, 'utf8');
      if (content.length > 0) {
        res.write(`data: ${JSON.stringify(content)}\n\n`);
        offset = Buffer.byteLength(content, 'utf8');
      }
    } catch {}

    // Watch for changes using fs.watchFile (cross-platform, works on Windows)
    const watcher = () => {
      try {
        const stat = fs.statSync(liveLogPath);
        if (stat.size > offset) {
          const fd = fs.openSync(liveLogPath, 'r');
          const buf = Buffer.alloc(stat.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = stat.size;
          const chunk = buf.toString('utf8');
          if (chunk) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      } catch {}
    };

    fs.watchFile(liveLogPath, { interval: 500 }, watcher);

    // Check if agent is still active (poll every 5s)
    const doneCheck = setInterval(() => {
      const dispatch = getDispatchQueue();
      const isActive = (dispatch.active || []).some(d => d.agent === agentId);
      if (!isActive) {
        watcher(); // flush final content
        res.write(`event: done\ndata: complete\n\n`);
        clearInterval(doneCheck);
        fs.unwatchFile(liveLogPath, watcher);
        res.end();
      }
    }, 5000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(doneCheck);
      fs.unwatchFile(liveLogPath, watcher);
    });

    return;
  }

  async function handleAgentLive(req, res, match) {
    const agentId = match[1];
    const livePath = path.join(MINIONS_DIR, 'agents', agentId, 'live-output.log');
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
      if (!body.content && body.content !== '') return jsonReply(res, 400, { error: 'content required' });
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
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return jsonReply(res, 400, { error: 'invalid file name' });
    }
    const content = safeRead(path.join(MINIONS_DIR, 'knowledge', cat, file));
    if (content === null) return jsonReply(res, 404, { error: 'not found' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(content);
    return;
  }

  async function handleKnowledgeSweep(req, res) {
    if (global._kbSweepInFlight) return jsonReply(res, 409, { error: 'sweep already in progress' });
    global._kbSweepInFlight = true;
    try {
      const entries = getKnowledgeBaseEntries();
      if (entries.length < 2) return jsonReply(res, 200, { ok: true, summary: 'nothing to sweep (< 2 entries)' });

      // Build a manifest of all KB entries with their content
      const manifest = [];
      for (const e of entries) {
        const content = safeRead(path.join(MINIONS_DIR, 'knowledge', e.cat, e.file));
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

1. **Find duplicates**: entries with substantially the same content or insights (same findings from different agents or dispatch runs). List pairs/groups by index. When choosing which to keep, prefer the more recent entry (later date) as it likely reflects the current state of the codebase.

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

      // Prune swept files older than 30 days
      let pruned = 0;
      const SWEPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
      try {
        for (const f of fs.readdirSync(kbArchiveDir)) {
          const fp = path.join(kbArchiveDir, f);
          try {
            if (Date.now() - fs.statSync(fp).mtimeMs > SWEPT_RETENTION_MS) { safeUnlink(fp); pruned++; }
          } catch {}
        }
      } catch {}

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
    const centralWi = JSON.parse(safeRead(path.join(MINIONS_DIR, 'work-items.json')) || '[]');
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

  async function handlePlansArchiveRead(req, res, match) {
    const file = decodeURIComponent(match[1]);
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

  async function handlePlansRead(req, res, match) {
    const file = decodeURIComponent(match[1]);
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
    for (const p of planCandidates) { try { const st = fs.statSync(p); if (st) { res.setHeader('Last-Modified', st.mtime.toISOString()); res.setHeader('X-Resolved-Path', path.relative(MINIONS_DIR, p).replace(/\\/g, '/')); break; } } catch {} }
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
      const plan = JSON.parse(safeRead(planPath) || '{}');
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
      const plan = JSON.parse(safeRead(planPath) || '{}');
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
      const dispatch = JSON.parse(safeRead(dispatchPath) || '{}');
      const killedAgents = new Set();
      const resetItemIds = new Set();

      for (const wiPath of wiPaths) {
        try {
          const items = safeJson(wiPath);
          if (!items) continue;
          let changed = false;
          for (const w of items) {
            if (w.sourcePlan !== body.file) continue;
            // Keep completed items as-is, reset everything else to pending.
            if (w.status === 'done' || w.status === 'implemented' || w.status === 'complete' || w.status === 'in-pr') continue;

            if (w.status === 'dispatched') {
              // Kill the agent working on this item, if any.
              const activeEntry = (dispatch.active || []).find(d => d.meta?.item?.id === w.id || d.meta?.dispatchKey?.includes(w.id));
              if (activeEntry) {
                const statusPath = path.join(MINIONS_DIR, 'agents', activeEntry.agent, 'status.json');
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
                killedAgents.add(activeEntry.agent);
              }
            }

            if (w.status !== 'pending') reset++;
            w.status = 'pending';
            delete w._pausedBy;
            delete w._resumedAt;
            delete w.dispatched_at;
            delete w.dispatched_to;
            delete w.failReason;
            delete w.failedAt;
            changed = true;
            if (w.id) resetItemIds.add(w.id);
          }
          if (changed) safeWrite(wiPath, items);
        } catch {}
      }

      // Remove dispatch active entries for reset items or killed agents.
      if (resetItemIds.size > 0 || killedAgents.size > 0) {
        mutateJsonFileLocked(dispatchPath, (dp) => {
          dp.active = Array.isArray(dp.active) ? dp.active : [];
          dp.active = dp.active.filter(d => {
            const itemId = d.meta?.item?.id;
            if (itemId && resetItemIds.has(itemId)) return false;
            if (killedAgents.has(d.agent)) return false;
            return true;
          });
          return dp;
        }, { defaultValue: { pending: [], active: [], completed: [] } });
      }

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, status: 'paused', resetWorkItems: reset });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handlePrdRegenerate(req, res) {
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
      const wiPath = path.join(MINIONS_DIR, 'work-items.json');
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

  async function handlePlansExecute(req, res) {
    try {
      const body = await readBody(req);
      if (!body.file) return jsonReply(res, 400, { error: 'file required' });
      if (!body.file.endsWith('.md')) return jsonReply(res, 400, { error: 'only .md plans can be executed' });
      const planPath = path.join(MINIONS_DIR, 'plans', body.file);
      if (!fs.existsSync(planPath)) return jsonReply(res, 404, { error: 'plan file not found' });

      // Check if already queued
      const centralPath = path.join(MINIONS_DIR, 'work-items.json');
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

  async function handlePlansReject(req, res) {
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

  async function handlePlansRegenerate(req, res) {
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
      const wiPaths = [{ path: path.join(MINIONS_DIR, 'work-items.json'), label: 'central' }];
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

  async function handlePlansDelete(req, res) {
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
      const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
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
          const centralPath = path.join(MINIONS_DIR, 'work-items.json');
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

  async function handlePlansRevise(req, res) {
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
      const wiPath = path.join(MINIONS_DIR, 'work-items.json');
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
      const wiPaths = [{ path: path.join(MINIONS_DIR, 'work-items.json'), label: 'central' }];
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
      const centralWiPath = path.join(MINIONS_DIR, 'work-items.json');
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
      const sysPrompt = `You are a Plan Advisor helping a human review and refine a feature plan before it gets dispatched to an agent minions.

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
        fullPath = path.resolve(MINIONS_DIR, body.filePath);
        if (!fullPath.startsWith(path.resolve(MINIONS_DIR))) return jsonReply(res, 400, { error: 'path must be under minions directory' });
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

  async function handleInboxPersist(req, res) {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });

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
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `persisted-${name}`), _c); safeUnlink(inboxPath); } catch {}

      return jsonReply(res, 200, { ok: true, title });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleInboxPromoteKb(req, res) {
    try {
      const body = await readBody(req);
      const { name, category } = body;
      if (!name) return jsonReply(res, 400, { error: 'name required' });
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
      try { const _c = safeRead(inboxPath); safeWrite(path.join(archiveDir, `kb-${category}-${name}`), _c); safeUnlink(inboxPath); } catch {}

      return jsonReply(res, 200, { ok: true, category, file: name });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  async function handleInboxOpen(req, res) {
    try {
      const body = await readBody(req);
      const { name } = body;
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
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
      if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
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
        } finally { try { fs.unlinkSync(psPath); } catch {} }
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

  async function handleCommandCenterNewSession(req, res) {
    ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
    ccInFlight = false; // Reset concurrency guard so a stuck request doesn't block new sessions
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
    return jsonReply(res, 200, { ok: true });
  }

  async function handleCommandCenter(req, res) {
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

  async function handleSchedulesList(req, res) {
    reloadConfig();
    const schedules = CONFIG.schedules || [];
    const runs = shared.safeJson(path.join(MINIONS_DIR, 'engine', 'schedule-runs.json')) || {};
    const result = schedules.map(s => ({ ...s, _lastRun: runs[s.id] || null }));
    return jsonReply(res, 200, { schedules: result });
  }

  async function handleSchedulesCreate(req, res) {
    const body = await readBody(req);
    const { id, cron, title, type, project, agent, description, priority, enabled } = body;
    if (!id || !cron || !title) return jsonReply(res, 400, { error: 'id, cron, and title are required' });

    reloadConfig();
    if (!CONFIG.schedules) CONFIG.schedules = [];
    if (CONFIG.schedules.some(s => s.id === id)) return jsonReply(res, 400, { error: 'Schedule ID already exists' });

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
        engine: config.engine || {},
        claude: config.claude || {},
        agents: config.agents || {},
        routing,
      });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  async function handleSettingsUpdate(req, res) {
    try {
      const body = await readBody(req);
      const configPath = path.join(MINIONS_DIR, 'config.json');
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

  async function handleSettingsRouting(req, res) {
    try {
      const body = await readBody(req);
      if (!body.content) return jsonReply(res, 400, { error: 'content required' });
      safeWrite(path.join(MINIONS_DIR, 'routing.md'), body.content);
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
      return jsonReply(res, 200, getStatus(), req);
    } catch (e) {
      return jsonReply(res, 500, { error: e.message }, req);
    }
  }

  // ── Route Registry ──────────────────────────────────────────────────────────
  // Order matters: specific routes before general ones (e.g., /api/plans/approve before /api/plans/:file)

  const ROUTES = [
    // Routes endpoint (self-describing API)
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
      for (const wiPath of paths) {
        const items = JSON.parse(safeRead(wiPath) || '[]');
        const item = items.find(i => i.id === id);
        if (!item) continue;
        item._humanFeedback = { rating, comment: comment || '', at: new Date().toISOString() };
        safeWrite(wiPath, items);
        const agent = item.dispatched_to || item.agent || 'unknown';
        const feedbackNote = '# Human Feedback on ' + id + '\n\n' +
          '**Rating:** ' + (rating === 'up' ? '👍 Good' : '👎 Needs improvement') + '\n' +
          '**Item:** ' + (item.title || id) + '\n' +
          '**Agent:** ' + agent + '\n' +
          (comment ? '**Feedback:** ' + comment + '\n' : '');
        const inboxPath = path.join(MINIONS_DIR, 'notes', 'inbox', agent + '-feedback-' + new Date().toISOString().slice(0, 10) + '-' + shared.uid().slice(0, 4) + '.md');
        safeWrite(inboxPath, feedbackNote);
        invalidateStatusCache();
        return jsonReply(res, 200, { ok: true });
      }
      return jsonReply(res, 404, { error: 'Work item not found' });
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
      const targetProject = projectName ? projects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) : projects[0];
      const prPath = targetProject ? shared.projectPrPath(targetProject) : path.join(MINIONS_DIR, 'pull-requests.json');
      const prs = JSON.parse(safeRead(prPath) || '[]');

      // Extract PR number from URL
      const prNumMatch = url.match(/\/pull\/(\d+)|pullrequest\/(\d+)/);
      const prNum = prNumMatch ? (prNumMatch[1] || prNumMatch[2]) : Date.now().toString().slice(-6);
      const prId = 'PR-' + prNum;

      if (prs.some(p => p.id === prId || p.url === url)) return jsonReply(res, 400, { error: 'PR already tracked' });

      prs.push({
        id: prId,
        title: (title || 'Linked PR #' + prNum).slice(0, 120),
        agent: 'human',
        branch: '',
        reviewStatus: autoObserve ? 'pending' : 'none',
        status: autoObserve ? 'active' : 'linked',
        created: new Date().toISOString().slice(0, 10),
        url,
        prdItems: [],
        _manual: true,
        _autoObserve: !!autoObserve,
        _context: context || '',
      });
      safeWrite(prPath, prs);
      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, id: prId });
    }},

    { method: 'POST', path: '/api/plans/create', desc: 'Create a plan from user-provided content', params: 'title, content, project?', handler: async (req, res) => {
      const body = await readBody(req);
      const { title, content, project: projectName } = body;
      if (!title || !content) return jsonReply(res, 400, { error: 'title and content required' });

      const plansDir = path.join(MINIONS_DIR, 'plans');
      if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-${date}.md`;
      const filePath = shared.uniquePath(path.join(plansDir, filename));

      const header = `# ${title}\n\n` +
        (projectName ? `**Project:** ${projectName}\n` : '') +
        `**Created:** ${date}\n**By:** human teammate\n\n---\n\n`;
      safeWrite(filePath, header + content);

      invalidateStatusCache();
      return jsonReply(res, 200, { ok: true, file: path.basename(filePath) });
    }},

    { method: 'POST', path: '/api/agents/steer', desc: 'Inject steering message into a running agent', params: 'agent, message', handler: async (req, res) => {
      const body = await readBody(req);
      const { agent: agentId, message } = body;
      if (!agentId || !message) return jsonReply(res, 400, { error: 'agent and message required' });

      const steerPath = path.join(MINIONS_DIR, 'agents', agentId, 'steer.md');
      const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
      if (!fs.existsSync(agentDir)) return jsonReply(res, 404, { error: 'Agent not found' });

      // Write steering file — engine picks it up on next tick
      safeWrite(steerPath, message);

      // Also append to live-output.log so it shows in the chat view
      const liveLogPath = path.join(agentDir, 'live-output.log');
      try { fs.appendFileSync(liveLogPath, '\n[human-steering] ' + message + '\n'); } catch {}

      return jsonReply(res, 200, { ok: true, message: 'Steering message sent' });
    }},
    { method: 'POST', path: '/api/agents/cancel', desc: 'Cancel an active agent by ID or task substring', params: 'agent?, task?', handler: handleAgentsCancel },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/live-stream(?:\?.*)?$/, desc: 'SSE real-time live output streaming', handler: handleAgentLiveStream },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/live(?:\?.*)?$/, desc: 'Tail live output for a working agent', params: 'tail? (bytes, default 8192)', handler: handleAgentLive },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)\/output(?:\?.*)?$/, desc: 'Fetch final output.log for an agent', handler: handleAgentOutput },
    { method: 'GET', path: /^\/api\/agent\/([\w-]+)$/, desc: 'Get detailed agent info', handler: handleAgentDetail },

    // Knowledge base
    { method: 'GET', path: '/api/knowledge', desc: 'List all knowledge base entries grouped by category', handler: handleKnowledgeList },
    { method: 'POST', path: '/api/knowledge', desc: 'Create a knowledge base entry', params: 'category, title, content', handler: async (req, res) => {
      const body = await readBody(req);
      const { category, title, content } = body;
      if (!category || !title || !content) return jsonReply(res, 400, { error: 'category, title, and content required' });
      const validCategories = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];
      if (!validCategories.includes(category)) return jsonReply(res, 400, { error: 'Invalid category. Must be: ' + validCategories.join(', ') });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
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
    { method: 'POST', path: '/api/projects/add', desc: 'Auto-discover and add a project to config', params: 'path, name?', handler: handleProjectsAdd },

    // Command Center
    { method: 'POST', path: '/api/command-center/new-session', desc: 'Clear active CC session', handler: handleCommandCenterNewSession },
    { method: 'POST', path: '/api/command-center', desc: 'Conversational command center with full minions context', params: 'message, sessionId?', handler: handleCommandCenter },

    // Schedules
    { method: 'GET', path: '/api/schedules', desc: 'Return schedules from config + last-run times', handler: handleSchedulesList },
    { method: 'POST', path: '/api/schedules', desc: 'Create a new schedule', params: 'id, cron, title, type?, project?, agent?, description?, priority?, enabled?', handler: handleSchedulesCreate },
    { method: 'POST', path: '/api/schedules/update', desc: 'Update an existing schedule', params: 'id, cron?, title?, type?, project?, agent?, description?, priority?, enabled?', handler: handleSchedulesUpdate },
    { method: 'POST', path: '/api/schedules/delete', desc: 'Delete a schedule', params: 'id', handler: handleSchedulesDelete },

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
  ];

  // ── Route Dispatcher ────────────────────────────────────────────────────────

  const pathname = req.url.split('?')[0];
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    if (typeof route.path === 'string') {
      // For /api/skill, match with query string prefix since it has no fixed path variant
      if (route.path === '/api/skill') {
        if (!req.url.startsWith('/api/skill?') && req.url !== '/api/skill') continue;
        return await route.handler(req, res, {});
      }
      if (pathname !== route.path) continue;
      return await route.handler(req, res, {});
    }
    const m = pathname.match(route.path);
    if (m) return await route.handler(req, res, m);
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
          const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', timeout: 3000 });
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

