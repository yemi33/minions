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
const queries = require('./engine/queries');
const os = require('os');

const { safeRead, safeReadDir, safeWrite, safeJson, safeUnlink, getProjects: _getProjects } = shared;
const { getAgents, getAgentDetail, getPrdInfo, getWorkItems, getDispatchQueue,
  getSkills, getInbox, getNotesWithMeta, getPullRequests,
  getEngineLog, getMetrics, getKnowledgeBaseEntries, timeSince,
  SQUAD_DIR, AGENTS_DIR, ENGINE_DIR, INBOX_DIR, DISPATCH_PATH, PRD_DIR } = queries;

const PORT = parseInt(process.env.PORT || process.argv[2]) || 7331;
const CONFIG = queries.getConfig();
const PROJECTS = _getProjects(CONFIG);
const projectNames = PROJECTS.map(p => p.name || 'Project').join(' + ');

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

function getStatus() {
  const prdInfo = getPrdInfo();
  return {
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
    timestamp: new Date().toISOString(),
  };
}

// -- Triage context for Haiku LLM --

function getTriageContext() {
  const agents = getAgents().map(a => `- ${a.name} (${a.id}): ${a.status}${a.currentTask ? ' — ' + a.currentTask.slice(0, 60) : ''}`).join('\n');
  const projects = PROJECTS.map(p => `- ${p.name}: ${(p.description || '').slice(0, 60)}`).join('\n');

  // Recent work items (last 10 central + all project items that are active/failed)
  const centralWi = getWorkItems().slice(-10).map(i => {
    let line = `- ${i.id}: "${(i.title || '').slice(0, 60)}" [${i.type}] ${i.status}`;
    if (i.dispatched_to) line += ' → ' + i.dispatched_to;
    if (i.status === 'failed' && i.failReason) line += ' | reason: ' + i.failReason.slice(0, 100);
    return line;
  });
  const projectWi = [];
  for (const proj of PROJECTS) {
    try {
      const items = safeJson(path.join(proj.localPath, '.squad', 'work-items.json'));
      items.filter(i => i.status === 'failed' || i.status === 'dispatched' || i.status === 'pending')
        .forEach(i => {
          let line = `- ${i.id}: "${(i.title || '').slice(0, 60)}" [${i.type}] ${i.status} (${proj.name})`;
          if (i.dispatched_to) line += ' → ' + i.dispatched_to;
          if (i.status === 'failed' && i.failReason) line += ' | reason: ' + i.failReason.slice(0, 100);
          projectWi.push(line);
        });
    } catch {}
  }
  // Recent completed dispatches with errors (last 5 errors for context)
  let recentErrors = '';
  try {
    const dispatch = JSON.parse(safeRead(path.join(SQUAD_DIR, 'engine', 'dispatch.json')) || '{}');
    const errors = (dispatch.completed || []).filter(d => d.result === 'error').slice(-5);
    if (errors.length > 0) {
      recentErrors = '\n\n### Recent Failures\n' + errors.map(d =>
        `- ${d.agent}: "${(d.task || '').slice(0, 60)}" | ${d.reason || 'unknown'} | ${d.completed_at || ''}`
      ).join('\n');
    }
  } catch {}
  const wi = [...centralWi, ...projectWi].join('\n') + recentErrors;

  // Plans (with summary, author, project, status) — PRDs are in prd/
  let plans = '';
  try {
    plans = safeReadDir(PRD_DIR).filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const plan = JSON.parse(safeRead(path.join(PRD_DIR, f)) || '{}');
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

// ── Command Center: session state + helpers ─────────────────────────────────

const CC_SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const CC_SESSION_MAX_TURNS = 50;
let ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
let ccInFlight = false;

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
    if (age < 30 * 60 * 1000) ccSession = saved;
  }
} catch {}

// Static system prompt — baked into session on creation, never changes
const CC_STATIC_SYSTEM_PROMPT = `You are the Command Center AI for a software engineering squad called "Squad."
You have complete visibility into the squad's state and can answer questions AND take actions.

Each message includes an updated "[Current Squad State]" section with real-time data. Use it to answer questions accurately.

## Actions You Can Take

When the user wants you to DO something (not just answer), append actions at the END of your response.

**Format:** Write your conversational response first, then on a new line write exactly \`===ACTIONS===\` followed by a JSON array of actions. Example:

I'll save that as a note and dispatch dallas to fix the bug.

===ACTIONS===
[{"type": "note", "title": "API v3 migration needed", "content": "We need to migrate..."}, {"type": "dispatch", "title": "Fix login bug", "workType": "fix", "priority": "high", "agents": ["dallas"], "project": "OfficeAgent", "description": "..."}]

**CRITICAL:** The ===ACTIONS=== line and JSON array must be the LAST thing in your response. No text after it. The JSON must be a valid array on a single line.

If no actions are needed (just answering a question), do NOT include the ===ACTIONS=== line at all.

Available action types:
- **dispatch**: Create a work item. Fields: title, workType (ask/explore/fix/review/test/implement), priority (low/medium/high), agents (array of IDs, optional), project, description
- **note**: Save a note/decision. Fields: title, content
- **plan**: Create a multi-step plan. Fields: title, description, project, branchStrategy (parallel/shared-branch)
- **cancel**: Cancel a running agent. Fields: agent (agent ID), reason
- **retry**: Retry failed work items. Fields: ids (array of work item IDs)
- **pause-plan**: Pause a PRD (stop materializing items). Fields: file (PRD .json filename)
- **approve-plan**: Approve a PRD (start materializing items). Fields: file (PRD .json filename)
- **edit-prd-item**: Edit a PRD item. Fields: source (PRD filename), itemId, name, description, priority, complexity
- **remove-prd-item**: Remove a PRD item. Fields: source (PRD filename), itemId
- **delete-work-item**: Delete a work item. Fields: id, source (project name or "central")

## Tool Access

You have read-only access to the filesystem. Use these tools when the squad state above isn't enough:
- **Read**: Read any file (code, config, plans, agent output logs, etc.)
- **Glob**: Find files by pattern (e.g., \`agents/*/output.log\`, \`plans/*.json\`)
- **Grep**: Search file contents (e.g., find where a function is defined, search agent outputs)
- **WebFetch/WebSearch**: Look up external resources

Key paths:
- Squad root: \`${SQUAD_DIR}\`
- Agent outputs: \`${SQUAD_DIR}/agents/{id}/output.log\` (latest) or \`output-{dispatch-id}.log\` (archived)
- Plans: \`${SQUAD_DIR}/plans/\` (.md source plans) and \`${SQUAD_DIR}/prd/\` (.json PRDs)
- Work items: \`${SQUAD_DIR}/work-items.json\` (central) or \`{project}/.squad/work-items.json\`
- Knowledge: \`${SQUAD_DIR}/knowledge/{category}/*.md\`
- Config: \`${SQUAD_DIR}/config.json\`

## Rules

1. Answer questions conversationally. Be specific — cite IDs, agent names, statuses, filenames, line numbers.
2. When the user wants action, include the action block AND explain what you're doing.
3. Resolve references like "ripley's plan", "the failing PR", "the old plan" to specific items from the context. Use Read/Grep to look up details if needed.
4. When recommending which agent to assign, consult the charters and routing rules.
5. If something is ambiguous, ask for clarification rather than guessing.
6. Keep responses concise but informative. Use markdown.
7. Never modify engine source code or config files directly — only take actions via action blocks.
8. When the user asks about what an agent did, read the agent's output log for details.`;

function buildCCStatePreamble() {
  const ctx = getTriageContext();
  const notes = safeRead(path.join(SQUAD_DIR, 'notes.md')) || '';
  const notesTail = notes.length > 3000 ? notes.slice(-3000) : notes;
  const config = queries.getConfig();

  // Plan contents
  let planContents = '';
  for (const { dir, label } of [{ dir: PLANS_DIR, label: 'plan' }, { dir: PRD_DIR, label: 'prd' }]) {
    try {
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.json'))) {
        try {
          const raw = safeRead(path.join(dir, f));
          if (f.endsWith('.md')) {
            planContents += `\n#### ${f} (${label})\n${raw.length > 4000 ? raw.slice(0, 4000) + '\n...(truncated)' : raw}\n`;
          } else {
            const plan = JSON.parse(raw);
            planContents += `\n#### ${f} (${label})\nStatus: ${plan.status || 'unknown'} | By: ${plan.generated_by || 'unknown'} | Project: ${plan.project || ''}\nSummary: ${plan.plan_summary || ''}\n`;
            if (plan.missing_features) {
              planContents += `Items (${plan.missing_features.length}):\n`;
              for (const item of plan.missing_features) planContents += `- ${item.id}: ${(item.name || '').slice(0, 60)} [${item.status}] ${item.priority || ''}\n`;
            }
          }
        } catch {}
      }
      try {
        for (const f of fs.readdirSync(path.join(dir, 'archive')).filter(f => f.endsWith('.md') || f.endsWith('.json')).slice(-3)) {
          try { planContents += `\n#### [archived] ${f}\n${safeRead(path.join(dir, 'archive', f)).slice(0, 2000)}\n`; } catch {}
        }
      } catch {}
    } catch {}
  }

  const agentCharters = Object.keys(config.agents || {}).map(id => {
    const charter = safeRead(path.join(SQUAD_DIR, 'agents', id, 'charter.md'));
    return charter ? `#### ${id}\n${charter.slice(0, 600)}` : '';
  }).filter(Boolean).join('\n\n');

  const routing = safeRead(path.join(SQUAD_DIR, 'routing.md')) || '(no routing.md)';
  const skillsList = getSkills().map(s => `- **${s.name}**: ${s.description || ''} (trigger: ${s.trigger || 'manual'})`).join('\n') || '(no skills)';
  const kbEntries = getKnowledgeBaseEntries().slice(-20).map(e => `- [${e.cat}] ${e.title} (${e.file})`).join('\n') || '(empty)';
  const allPrs = getPullRequests().map(pr =>
    `- **${pr.id}** (${pr._project}): ${(pr.title || '').slice(0, 60)} | status: ${pr.status} | review: ${pr.reviewStatus || '?'} | build: ${pr.buildStatus || '?'}${pr.branch ? ' | branch: \`' + pr.branch + '\`' : ''}${pr.url ? ' | ' + pr.url : ''}`
  ).join('\n') || '(no PRs)';
  const engineConfig = config.engine || {};
  const dispatchHistory = (() => {
    try {
      const d = JSON.parse(safeRead(path.join(SQUAD_DIR, 'engine', 'dispatch.json')) || '{}');
      return (d.completed || []).slice(-15).reverse().map(c =>
        `- ${c.agent} ${c.result}: ${(c.task || '').slice(0, 80)}${c.resultSummary ? ' — ' + c.resultSummary.slice(0, 120) : ''}${c.reason ? ' [' + c.reason.slice(0, 60) + ']' : ''} (${(c.completed_at || '').slice(0, 16)})`
      ).join('\n') || '(none)';
    } catch { return '(unavailable)'; }
  })();

  return `### Agents & Statuses
${ctx.agents}

### Agent Charters
${agentCharters}

### Routing Rules
${routing}

### Projects
${ctx.projects}

### Engine Config
Tick: ${engineConfig.tickInterval || 60000}ms | Max concurrent: ${engineConfig.maxConcurrent || 3} | Agent timeout: ${Math.round((engineConfig.agentTimeout || 18000000) / 60000)}min | Max turns: ${engineConfig.maxTurns || 100}

### Work Items
${ctx.workItems}

### Pull Requests
${allPrs}

### Plans & PRDs
${ctx.plans}

### Plan Contents
${planContents || '(none)'}

### PRD Items
${ctx.prdItems}

### Active Dispatch
${ctx.activeDispatch}

### Recent Dispatch History
${dispatchHistory}

### Skills
${skillsList}

### Knowledge Base
${kbEntries}

### Team Notes
${notesTail.slice(-1500)}`;
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

// Route doc chat/steer through CC's persistent session for squad-aware context
async function ccDocCall({ message, document, title, filePath, selection, canEdit, isJson }) {
  const docContext = `## Document Context\n**${title || 'Document'}**${filePath ? ' (`' + filePath + '`)' : ''}${isJson ? ' (JSON)' : ''}\n${selection ? '\n**Selected text:**\n> ' + selection.slice(0, 1500) + '\n' : ''}\n\`\`\`\n${document.slice(0, 20000)}\n\`\`\`\n${canEdit ? '\nIf editing: respond with your explanation, then `---DOCUMENT---` on its own line, then the COMPLETE updated file.' : '\n(Read-only — answer questions only.)'}`;

  const prompt = `## Current Squad State (${new Date().toISOString().slice(0, 16)})\n\n${buildCCStatePreamble()}\n\n---\n\n${docContext}\n\n---\n\n${message}`;

  const sessionId = ccSessionValid() ? ccSession.sessionId : null;

  const result = await llm.callLLM(prompt, sessionId ? '' : CC_STATIC_SYSTEM_PROMPT, {
    timeout: 120000, label: 'command-center', model: 'sonnet', maxTurns: 3,
    allowedTools: 'Read,Glob,Grep', sessionId,
  });
  llm.trackEngineUsage('command-center', result.usage);

  // Update CC session
  const returnedId = result.sessionId || sessionId;
  if (returnedId) {
    ccSession = {
      sessionId: returnedId,
      createdAt: sessionId ? ccSession.createdAt : new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      turnCount: (sessionId ? ccSession.turnCount : 0) + 1,
    };
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
  }

  if (result.code !== 0 || !result.text) {
    return { answer: 'Failed to process request. Try again.', content: null };
  }

  // Parse ---DOCUMENT--- delimiter for doc edits
  const text = result.text;
  const delimIdx = text.indexOf('---DOCUMENT---');
  if (delimIdx >= 0) {
    const answer = text.slice(0, delimIdx).trim();
    let content = text.slice(delimIdx + '---DOCUMENT---'.length).trim();
    content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
    return { answer, content };
  }

  // Also strip any ===ACTIONS=== (CC might still emit them)
  const actIdx = text.indexOf('===ACTIONS===');
  return { answer: actIdx >= 0 ? text.slice(0, actIdx).trim() : text, content: null };
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
- "cancel": Stop/cancel/kill a running agent or active task.
  Keywords: stop, cancel, kill, abort, halt
  Include the agent ID in "agents" field. If targeting by task name, include "cancelTask" with a substring.
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
  "intent": "work-item|note|plan|retry|answer|cancel",
  "title": "concise action title",
  "description": "additional context, resolved references",
  "type": "ask|explore|fix|review|test|implement|plan-to-prd",
  "priority": "low|medium|high",
  "agents": ["agent-id"] or [],
  "fanout": false,
  "project": "project-name or empty string",
  "projects": [],
  "branchStrategy": "parallel",
  "cancelTask": "task substring", // only for intent "cancel"
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
        const wiPath = path.join(project.localPath, '.squad', 'work-items.json');
        const items = JSON.parse(safeRead(wiPath) || '[]');
        const verify = items.find(w => w.sourcePlan === body.file && w.planItemId === 'VERIFY');
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
        wiSyncPaths.push(path.join(proj.localPath, '.squad', 'work-items.json'));
      }
      for (const wiPath of wiSyncPaths) {
        try {
          const items = safeJson(wiPath);
          const wi = items.find(w => w.sourcePlan === body.source && w.sourcePlanItem === body.itemId);
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
        const wiPath = path.join(proj.localPath, '.squad', 'work-items.json');
        try {
          const items = safeJson(wiPath);
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
        const items = safeJson(centralPath);
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
        dispatch.active = active.filter(d => !cancelledIds.has(d.agent));
        safeWrite(dispatchPath, dispatch);
      }

      return jsonReply(res, 200, { ok: true, cancelled });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // POST /api/triage — Haiku LLM command triage for natural language input
  if (req.method === 'POST' && req.url === '/api/triage') {
    let body;
    try { body = await readBody(req); } catch (e) { return jsonReply(res, 400, { error: 'Invalid request body' }); }
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
    const entries = getKnowledgeBaseEntries();
    const result = {};
    for (const cat of shared.KB_CATEGORIES) result[cat] = [];
    for (const e of entries) {
      if (!result[e.cat]) result[e.cat] = [];
      result[e.cat].push({ file: e.file, category: e.cat, title: e.title, agent: e.agent, date: e.date, size: e.size, preview: e.preview });
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
        const content = safeRead(path.join(dir, f)) || '';
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
              requiresApproval: plan.requires_approval || false,
              revisionFeedback: plan.revision_feedback || null,
            });
          } catch {}
        } else {
          const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)/m);
          const projectMatch = content.match(/\*\*Project:\*\*\s*(.+)/m);
          const authorMatch = content.match(/\*\*Author:\*\*\s*(.+)/m);
          const dateMatch = content.match(/\*\*Date:\*\*\s*(.+)/m);
          plans.push({
            file: f, format: 'draft', archived,
            project: projectMatch ? projectMatch[1].trim() : '',
            summary: titleMatch ? titleMatch[1].trim() : f.replace('.md', ''),
            status: archived ? 'completed' : completedPrdFiles.has(f) ? 'completed' : 'draft',
            branchStrategy: '',
            featureBranch: '',
            itemCount: (content.match(/^\d+\.\s+\*\*/gm) || []).length,
            generatedBy: authorMatch ? authorMatch[1].trim() : '',
            generatedAt: dateMatch ? dateMatch[1].trim() : '',
            requiresApproval: false,
            revisionFeedback: null,
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
      const planPath = resolvePlanPath(body.file);
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
      const planPath = resolvePlanPath(body.file);
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
        wiPaths.push({ path: path.join(proj.localPath, '.squad', 'work-items.json'), label: proj.name });
      }

      // Track which plan items have materialized work items
      const materializedPlanItemIds = new Set();

      for (const wiInfo of wiPaths) {
        try {
          const items = safeJson(wiInfo.path);
          const filtered = [];
          for (const w of items) {
            if (w.sourcePlan === body.source) {
              materializedPlanItemIds.add(w.sourcePlanItem);
              if (w.status === 'pending' || w.status === 'failed') {
                // Delete — will re-materialize on next tick with updated plan data
                reset++;
                deletedItemIds.push(w.sourcePlanItem);
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
          (d.meta?.item?.sourcePlan === body.source && d.meta?.item?.sourcePlanItem === itemId) ||
          (d.meta?.item?.planItemId === itemId && d.meta?.item?.sourcePlan === body.source)
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
      safeUnlink(planPath);

      // Clean up materialized work items from all projects + central
      let cleaned = 0;
      const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const proj of PROJECTS) {
        wiPaths.push(path.join(proj.localPath, '.squad', 'work-items.json'));
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
      const maxNum = items.reduce(function(max, i) {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const id = 'W' + String(maxNum + 1).padStart(3, '0');
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

  // POST /api/plans/revise-and-regenerate — revise the SOURCE PLAN (.md), then dispatch plan-to-prd
  if (req.method === 'POST' && req.url === '/api/plans/revise-and-regenerate') {
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
        wiPaths.push({ path: path.join(proj.localPath, '.squad', 'work-items.json'), label: proj.name });
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
                deletedItemIds.push(w.sourcePlanItem);
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
          (d.meta?.item?.sourcePlan === body.source && d.meta?.item?.sourcePlanItem === itemId) ||
          (d.meta?.item?.planItemId === itemId && d.meta?.item?.sourcePlan === body.source)
        );
      }

      // Step 4: Dispatch plan-to-prd to regenerate PRD from revised plan
      const centralWiPath = path.join(SQUAD_DIR, 'work-items.json');
      let centralItems = [];
      try { centralItems = JSON.parse(safeRead(centralWiPath) || '[]'); } catch {}
      const maxNum = centralItems.reduce(function(max, i) {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const wiId = 'W' + String(maxNum + 1).padStart(3, '0');
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

      const { answer, content } = await ccDocCall({
        message: body.message, document: currentContent, title: body.title,
        filePath: body.filePath, selection: body.selection, canEdit, isJson,
      });

      if (!content) return jsonReply(res, 200, { ok: true, answer, edited: false });

      if (isJson) {
        try { JSON.parse(content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(JSON invalid — not saved: ' + e.message + ')', edited: false });
        }
      }
      if (canEdit && fullPath) {
        safeWrite(fullPath, content);
        return jsonReply(res, 200, { ok: true, answer, edited: true, content });
      }
      return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(Read-only — changes not saved)', edited: false });
    } catch (e) { return jsonReply(res, 500, { error: e.message }); }
  }

  // POST /api/steer-document — routes through CC session for squad-aware doc editing
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

      const { answer, content } = await ccDocCall({
        message: body.instruction, document: currentContent, title: path.basename(body.filePath),
        filePath: body.filePath, selection: body.selection, canEdit: true, isJson,
      });

      if (!content) return jsonReply(res, 200, { ok: true, answer, updated: false });
      if (isJson) {
        try { JSON.parse(content); } catch (e) {
          return jsonReply(res, 200, { ok: true, answer: answer + '\n\n(JSON validation failed — not saved: ' + e.message + ')', updated: false });
        }
      }
      safeWrite(fullPath, content);
      return jsonReply(res, 200, { ok: true, answer, updated: true, content });
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
        if (!fs.existsSync(fp)) safeWrite(fp, content);
      }

      return jsonReply(res, 200, { ok: true, name, path: target, detected });
    } catch (e) { return jsonReply(res, 400, { error: e.message }); }
  }

  // ── Command Center: persistent multi-turn session ──────────────────────────

  // POST /api/command-center/new-session — clear active CC session
  if (req.method === 'POST' && req.url === '/api/command-center/new-session') {
    ccSession = { sessionId: null, createdAt: null, lastActiveAt: null, turnCount: 0 };
    safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
    return jsonReply(res, 200, { ok: true });
  }

  // POST /api/command-center — conversational command center with full squad context
  if (req.method === 'POST' && req.url === '/api/command-center') {
    try {
      const body = await readBody(req);
      if (!body.message) return jsonReply(res, 400, { error: 'message required' });

      // Concurrency guard — only one CC call at a time
      if (ccInFlight) return jsonReply(res, 429, { error: 'Command Center is busy — wait for the current request to finish.' });
      ccInFlight = true;

      try {
        // Check if client-provided sessionId matches our active session
        // Resume if client sessionId matches and session is still valid
        let sessionId = (body.sessionId && body.sessionId === ccSession.sessionId && ccSessionValid())
          ? ccSession.sessionId : null;

        const prompt = `## Current Squad State (${new Date().toISOString().slice(0, 16)})\n\n${buildCCStatePreamble()}\n\n---\n\n${body.message}`;
        const ccOpts = { timeout: 300000, label: 'command-center', model: 'sonnet', maxTurns: 5, allowedTools: 'Read,Glob,Grep,WebFetch,WebSearch' };

        let result = await llm.callLLM(prompt, sessionId ? '' : CC_STATIC_SYSTEM_PROMPT, { ...ccOpts, sessionId });
        llm.trackEngineUsage('command-center', result.usage);

        // If resume failed, retry with a fresh session
        if ((result.code !== 0 || !result.text) && sessionId) {
          console.log('[CC] Resume failed, retrying with fresh session...');
          result = await llm.callLLM(prompt, CC_STATIC_SYSTEM_PROMPT, ccOpts);
          llm.trackEngineUsage('command-center', result.usage);
          sessionId = null; // Reset so session update below creates a new session
        }

        if (result.code !== 0 || !result.text) {
          const debugInfo = result.code !== 0 ? `(exit code ${result.code})` : '(empty response)';
          const stderr = (result.stderr || '').slice(-300);
          console.error(`[CC] LLM failed ${debugInfo}: ${stderr}`);
          return jsonReply(res, 200, {
            text: `I had trouble processing that ${debugInfo}. ${stderr ? 'Detail: ' + stderr.split('\n').pop() : 'Try again or rephrase.'}`,
            actions: [], sessionId: ccSession.sessionId
          });
        }

        // Update session state on success
        const returnedSessionId = result.sessionId || sessionId;
        if (returnedSessionId) {
          ccSession = {
            sessionId: returnedSessionId,
            createdAt: sessionId ? ccSession.createdAt : new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            turnCount: (sessionId ? ccSession.turnCount : 0) + 1,
          };
          safeWrite(path.join(ENGINE_DIR, 'cc-session.json'), ccSession);
        }

        // Tell frontend if this is a new session (so it can clear stale messages)
        const isNewSession = !sessionId || returnedSessionId !== body.sessionId;
        return jsonReply(res, 200, { ...parseCCActions(result.text), sessionId: returnedSessionId, newSession: isNewSession });
      } finally {
        ccInFlight = false;
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
        if (e.tickInterval !== undefined) config.engine.tickInterval = Math.max(10000, Number(e.tickInterval) || 60000);
        if (e.maxConcurrent !== undefined) config.engine.maxConcurrent = Math.max(1, Math.min(10, Number(e.maxConcurrent) || 3));
        if (e.inboxConsolidateThreshold !== undefined) config.engine.inboxConsolidateThreshold = Math.max(1, Number(e.inboxConsolidateThreshold) || 5);
        if (e.agentTimeout !== undefined) config.engine.agentTimeout = Math.max(60000, Number(e.agentTimeout) || 18000000);
        if (e.maxTurns !== undefined) config.engine.maxTurns = Math.max(5, Math.min(500, Number(e.maxTurns) || 100));
        if (e.heartbeatTimeout !== undefined) config.engine.heartbeatTimeout = Math.max(60000, Number(e.heartbeatTimeout) || 300000);
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
