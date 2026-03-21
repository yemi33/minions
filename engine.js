#!/usr/bin/env node
/**
 * Squad Engine — Auto-assigning orchestrator
 *
 * Discovers work from configurable sources (PRD gaps, PR tracker, manual queue),
 * renders playbook templates with agent charters as system prompts, and spawns
 * isolated `claude` CLI processes in git worktrees.
 *
 * Usage:
 *   node .squad/engine.js              Start the engine (daemon mode)
 *   node .squad/engine.js status       Show current state
 *   node .squad/engine.js pause        Pause dispatching
 *   node .squad/engine.js resume       Resume dispatching
 *   node .squad/engine.js stop         Stop the engine
 *   node .squad/engine.js queue        Show dispatch queue
 *   node .squad/engine.js dispatch     Force a dispatch cycle
 *   node .squad/engine.js complete <id>  Mark dispatch as done
 *   node .squad/engine.js spawn <agent> <prompt>  Manually spawn an agent
 *   node .squad/engine.js work <title> [opts-json]  Add to work queue
 *   node .squad/engine.js sources      Show work source status
 *   node .squad/engine.js discover     Dry-run work discovery
 */

const fs = require('fs');
const path = require('path');
const shared = require('./engine/shared');
const { exec, execSilent, runFile, ENGINE_DEFAULTS: DEFAULTS } = shared;
const queries = require('./engine/queries');

// ─── Paths ──────────────────────────────────────────────────────────────────

const SQUAD_DIR = __dirname;
const ROUTING_PATH = path.join(SQUAD_DIR, 'routing.md');
const PLAYBOOKS_DIR = path.join(SQUAD_DIR, 'playbooks');
const ARCHIVE_DIR = path.join(SQUAD_DIR, 'notes', 'archive');
const IDENTITY_DIR = path.join(SQUAD_DIR, 'identity');

// Re-export from queries for internal use (avoid changing every call site)
const { CONFIG_PATH, NOTES_PATH, AGENTS_DIR, ENGINE_DIR, CONTROL_PATH,
  DISPATCH_PATH, LOG_PATH, INBOX_DIR, KNOWLEDGE_DIR, PLANS_DIR, PRD_DIR } = queries;

// ─── Multi-Project Support ──────────────────────────────────────────────────
// Config can have either:
//   "project": { ... }           — single project (legacy, .squad inside repo)
//   "projects": [ { ... }, ... ] — multi-project (central .squad)
// Each project must have "localPath" pointing to the repo root.

function validateConfig(config) {
  let errors = 0;
  // Agents
  if (!config.agents || Object.keys(config.agents).length === 0) {
    console.error('FATAL: No agents defined in config.json');
    errors++;
  }
  // Projects
  const projects = getProjects(config);
  if (projects.length === 0) {
    console.error('FATAL: No projects configured');
    errors++;
  }
  for (const p of projects) {
    if (!p.localPath || !fs.existsSync(path.resolve(p.localPath))) {
      console.error(`WARN: Project "${p.name}" path not found: ${p.localPath}`);
    }
    if (!p.repositoryId) {
      console.warn(`WARN: Project "${p.name}" missing repositoryId — PR operations will fail`);
    }
  }
  // Playbooks
  const requiredPlaybooks = ['implement', 'review', 'fix', 'work-item'];
  for (const pb of requiredPlaybooks) {
    if (!fs.existsSync(path.join(PLAYBOOKS_DIR, `${pb}.md`))) {
      console.error(`WARN: Missing playbook: playbooks/${pb}.md`);
    }
  }
  // Routing
  if (!fs.existsSync(ROUTING_PATH)) {
    console.error('WARN: routing.md not found — agent routing will use fallbacks only');
  }
  if (errors > 0) {
    console.error(`\n${errors} fatal config error(s) — exiting.`);
    process.exit(1);
  }
}

const { getProjects, projectRoot, projectStateDir, projectWorkItemsPath, projectPrPath, getAdoOrgBase, sanitizeBranch, parseSkillFrontmatter, safeReadDir } = shared;

// ─── Utilities ──────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

const safeJson = shared.safeJson;
const safeRead = shared.safeRead;
const safeWrite = shared.safeWrite;
const mutateJsonFileLocked = shared.mutateJsonFileLocked;

function log(level, msg, meta = {}) {
  const entry = { timestamp: ts(), level, message: msg, ...meta };
  console.log(`[${logTs()}] [${level}] ${msg}`);

  let logData = safeJson(LOG_PATH) || [];
  if (!Array.isArray(logData)) logData = logData.entries || [];
  logData.push(entry);
  if (logData.length > 500) logData.splice(0, logData.length - 500);
  safeWrite(LOG_PATH, logData);
}

function mutateDispatch(mutator) {
  const defaultDispatch = { pending: [], active: [], completed: [] };
  return mutateJsonFileLocked(DISPATCH_PATH, (dispatch) => {
    dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
    dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
    dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
    return mutator(dispatch) || dispatch;
  }, { defaultValue: defaultDispatch });
}

// ─── State Readers (delegated to engine/queries.js) ─────────────────────────

const { getConfig, getControl, getDispatch, getNotes,
  getAgentStatus, getAgentCharter, getInboxFiles,
  collectSkillFiles, getSkillIndex, getKnowledgeBaseIndex,
  getPrs, SKILLS_DIR } = queries;

function getRouting() {
  return safeRead(ROUTING_PATH);
}

// ─── Routing Parser ─────────────────────────────────────────────────────────

let _routingCache = null;
let _routingCacheMtime = 0;

function parseRoutingTable() {
  const content = getRouting();
  const routes = {};
  const lines = content.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| Work Type')) { inTable = true; continue; }
    if (line.startsWith('|---')) continue;
    if (!inTable || !line.startsWith('|')) {
      if (inTable && !line.startsWith('|')) inTable = false;
      continue;
    }
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 3) {
      routes[cells[0].toLowerCase()] = {
        preferred: cells[1].toLowerCase(),
        fallback: cells[2].toLowerCase()
      };
    }
  }
  return routes;
}

function getRoutingTableCached() {
  let mtime = 0;
  try { mtime = fs.statSync(ROUTING_PATH).mtimeMs; } catch {}
  if (_routingCache && _routingCacheMtime === mtime) return _routingCache;
  _routingCache = parseRoutingTable();
  _routingCacheMtime = mtime;
  return _routingCache;
}

function getAgentErrorRate(agentId) {
  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  const metrics = safeJson(metricsPath) || {};
  const m = metrics[agentId];
  if (!m) return 0;
  const total = m.tasksCompleted + m.tasksErrored;
  return total > 0 ? m.tasksErrored / total : 0;
}

function isAgentIdle(agentId) {
  // Dispatch queue is the single source of truth for agent availability
  const dispatch = safeJson(DISPATCH_PATH) || {};
  return !(dispatch.active || []).some(d => d.agent === agentId);
}

// Track agents claimed during a single discovery pass to distribute work
const _claimedAgents = new Set();
function resetClaimedAgents() { _claimedAgents.clear(); }

function resolveAgent(workType, config, authorAgent = null) {
  const routes = getRoutingTableCached();
  const route = routes[workType] || routes['implement'];
  const agents = config.agents || {};

  // Resolve _author_ token
  let preferred = route.preferred === '_author_' ? authorAgent : route.preferred;
  let fallback = route.fallback === '_author_' ? authorAgent : route.fallback;

  const isAvailable = (id) => agents[id] && isAgentIdle(id) && !_claimedAgents.has(id);

  // Check preferred and fallback first (routing table order)
  if (preferred && isAvailable(preferred)) { _claimedAgents.add(preferred); return preferred; }
  if (fallback && isAvailable(fallback)) { _claimedAgents.add(fallback); return fallback; }

  // Fall back to any idle agent, preferring lower error rates
  const idle = Object.keys(agents)
    .filter(id => id !== preferred && id !== fallback && isAvailable(id))
    .sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b));

  if (idle[0]) { _claimedAgents.add(idle[0]); return idle[0]; }

  // No idle agent available — return null, item stays pending until next tick
  return null;
}

// ─── Task Context Resolution ────────────────────────────────────────────────
// Resolves implicit references in task descriptions (e.g., "ripley's plan",
// "dallas's PR") to actual artifacts and injects their content.

function resolveTaskContext(item, config) {
  const title = (item.title || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const text = title + ' ' + desc;
  const agentNames = Object.entries(config.agents || {}).map(([id, a]) => ({
    id,
    name: (a.name || id).toLowerCase(),
  }));
  const resolved = { additionalContext: '', referencedFiles: [] };

  // Match agent references: "ripley's plan", "dallas's pr", "lambert's output", etc.
  for (const agent of agentNames) {
    const patterns = [
      new RegExp(`${agent.name}(?:'s|s)?\\s+plan`, 'i'),
      new RegExp(`${agent.id}(?:'s|s)?\\s+plan`, 'i'),
      new RegExp(`plan\\s+(?:created|made|written|generated)\\s+by\\s+${agent.name}`, 'i'),
      new RegExp(`plan\\s+(?:created|made|written|generated)\\s+by\\s+${agent.id}`, 'i'),
    ];
    const matchesPlan = patterns.some(p => p.test(text));
    if (matchesPlan) {
      // Find plans created by this agent (check work items for plan tasks dispatched to this agent)
      try {
        const plans = fs.readdirSync(path.join(SQUAD_DIR, 'plans')).filter(f => f.endsWith('.md') || f.endsWith('.json'));
        // Check work-items to find which plan file this agent created
        const workItems = safeJson(path.join(SQUAD_DIR, 'work-items.json')) || [];
        const agentPlanItems = workItems.filter(w =>
          w.type === 'plan' && w.dispatched_to === agent.id && w.status === 'done' && w._planFileName
        ).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

        if (agentPlanItems.length > 0) {
          const planFile = agentPlanItems[0]._planFileName;
          const planPath = path.join(SQUAD_DIR, 'plans', planFile);
          try {
            const content = safeRead(planPath);
            resolved.additionalContext += `\n\n## Referenced Plan: ${planFile} (created by ${agent.name})\n\n${content}`;
            resolved.referencedFiles.push(planPath);
            log('info', `Context resolution: found plan "${planFile}" by ${agent.name} for work item ${item.id}`);
          } catch {}
        } else if (plans.length > 0) {
          // Fallback: try to find a plan file with the agent's name or ID in it
          const match = plans.find(f => f.toLowerCase().includes(agent.id) || f.toLowerCase().includes(agent.name));
          if (match) {
            const planPath = path.join(SQUAD_DIR, 'plans', match);
            try {
              const content = safeRead(planPath);
              resolved.additionalContext += `\n\n## Referenced Plan: ${match}\n\n${content}`;
              resolved.referencedFiles.push(planPath);
              log('info', `Context resolution: found plan "${match}" (name match) for work item ${item.id}`);
            } catch {}
          }
        }
      } catch {}
    }

    // Match agent output/notes references
    const outputPatterns = [
      new RegExp(`${agent.name}(?:'s|s)?\\s+(?:output|findings|notes|results)`, 'i'),
      new RegExp(`(?:output|findings|notes|results)\\s+(?:from|by)\\s+${agent.name}`, 'i'),
    ];
    if (outputPatterns.some(p => p.test(text))) {
      // Find the agent's latest inbox notes
      try {
        const inboxDir = path.join(SQUAD_DIR, 'notes', 'inbox');
        const files = fs.readdirSync(inboxDir)
          .filter(f => f.startsWith(agent.id + '-'))
          .sort().reverse();
        if (files.length > 0) {
          const content = safeRead(path.join(inboxDir, files[0]));
          resolved.additionalContext += `\n\n## Referenced Notes by ${agent.name}: ${files[0]}\n\n${content.slice(0, 5000)}`;
          resolved.referencedFiles.push(path.join(inboxDir, files[0]));
          log('info', `Context resolution: found notes "${files[0]}" by ${agent.name} for work item ${item.id}`);
        }
      } catch {}
    }
  }

  // If no specific reference was resolved but the text mentions "the plan" or "latest plan",
  // find the most recent plan
  if (!resolved.additionalContext && /\b(the|latest|last|recent)\s+plan\b/i.test(text)) {
    try {
      const plans = fs.readdirSync(path.join(SQUAD_DIR, 'plans'))
        .filter(f => f.endsWith('.md') || f.endsWith('.json'))
        .sort().reverse();
      if (plans.length > 0) {
        const planPath = path.join(SQUAD_DIR, 'plans', plans[0]);
        const content = safeRead(planPath);
        resolved.additionalContext += `\n\n## Referenced Plan (latest): ${plans[0]}\n\n${content}`;
        resolved.referencedFiles.push(planPath);
        log('info', `Context resolution: using latest plan "${plans[0]}" for work item ${item.id}`);
      }
    } catch {}
  }

  return resolved;
}

// ─── Playbook Renderer ──────────────────────────────────────────────────────

function renderPlaybook(type, vars) {
  const pbPath = path.join(PLAYBOOKS_DIR, `${type}.md`);
  let content;
  try { content = fs.readFileSync(pbPath, 'utf8'); } catch {
    log('warn', `Playbook not found: ${type}`);
    return null;
  }

  // Inject team notes context
  const notes = getNotes();
  if (notes) {
    content += '\n\n---\n\n## Team Notes (MUST READ)\n\n' + notes;
  }

  // Inject KB guardrail
  content += `\n\n---\n\n## Knowledge Base Rules\n\n`;
  content += `**Never delete, move, or overwrite files in \`knowledge/\`.** The sweep (consolidation engine) is the only process that writes to \`knowledge/\`. If you think a KB file is wrong, note it in your learnings file — do not touch \`knowledge/\` directly.\n`;

  // Inject learnings requirement
  content += `\n\n---\n\n## REQUIRED: Write Learnings\n\n`;
  content += `After completing your task, you MUST write a findings/learnings file to:\n`;
  content += `\`${SQUAD_DIR}/notes/inbox/${vars.agent_id || 'agent'}-${dateStamp()}.md\`\n\n`;
  content += `Include:\n`;
  content += `- What you learned about the codebase\n`;
  content += `- Patterns you discovered or established\n`;
  content += `- Gotchas or warnings for future agents\n`;
  content += `- Conventions to follow\n`;
  content += `- **SOURCE REFERENCES for every finding** — file paths with line numbers, PR URLs, API endpoints, config keys. Format: \`(source: path/to/file.ts:42)\` or \`(source: PR-12345)\`. Without references, findings cannot be verified.\n\n`;
  content += `### Skill Extraction (IMPORTANT)\n\n`;
  content += `If during this task you discovered a **repeatable workflow** — a multi-step procedure, workaround, build process, or pattern that other agents should follow in similar situations — output it as a fenced skill block. The engine will automatically extract it.\n\n`;
  content += `Format your skill as a fenced code block with the \`skill\` language tag:\n\n`;
  content += '````\n```skill\n';
  content += `---\nname: short-descriptive-name\ndescription: One-line description of what this skill does\nallowed-tools: Bash, Read, Edit\ntrigger: when should an agent use this\nscope: squad\nproject: any\n---\n\n# Skill Title\n\n## Steps\n1. ...\n2. ...\n\n## Notes\n...\n`;
  content += '```\n````\n\n';
  content += `- Set \`scope: squad\` for cross-project skills (engine writes to ~/.claude/skills/ automatically)\n`;
  content += `- Set \`scope: project\` + \`project: <name>\` for repo-specific skills (engine queues a PR to <project>/.claude/skills/)\n`;
  content += `- Only output a skill block if you genuinely discovered something reusable — don't force it\n`;

  // Inject project-level variables from config
  const config = getConfig();
  const projects = getProjects(config);
  // Find the specific project being dispatched (match by repo_id or repo_name from vars)
  const dispatchProject = (vars.repo_id && projects.find(p => p.repositoryId === vars.repo_id))
    || (vars.repo_name && projects.find(p => p.repoName === vars.repo_name))
    || projects[0] || {};
  const projectVars = {
    project_name: dispatchProject.name || 'Unknown Project',
    ado_org: dispatchProject.adoOrg || 'Unknown',
    ado_project: dispatchProject.adoProject || 'Unknown',
    repo_name: dispatchProject.repoName || 'Unknown',
    pr_create_instructions: getPrCreateInstructions(dispatchProject),
    pr_comment_instructions: getPrCommentInstructions(dispatchProject),
    pr_fetch_instructions: getPrFetchInstructions(dispatchProject),
    pr_vote_instructions: getPrVoteInstructions(dispatchProject),
    repo_host_label: getRepoHostLabel(dispatchProject),
  };
  const allVars = { ...projectVars, ...vars };

  // Substitute variables
  for (const [key, val] of Object.entries(allVars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val));
  }

  return content;
}

// ─── Repo Host Helpers ──────────────────────────────────────────────────────

function getRepoHost(project) {
  return project?.repoHost || 'ado';
}

function getPrCreateInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    return `Use \`gh pr create\` or the GitHub MCP tools to create a pull request.`;
  }
  // Default: Azure DevOps
  return `Use \`mcp__azure-ado__repo_create_pull_request\`:\n- repositoryId: \`${repoId}\``;
}

function getPrCommentInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    return `Use \`gh pr comment\` or the GitHub MCP tools to post a comment on the PR.`;
  }
  return `Use \`mcp__azure-ado__repo_create_pull_request_thread\`:\n- repositoryId: \`${repoId}\``;
}

function getPrFetchInstructions(project) {
  const host = getRepoHost(project);
  if (host === 'github') {
    return `Use \`gh pr view\` or the GitHub MCP tools to fetch PR status.`;
  }
  return `Use \`mcp__azure-ado__repo_get_pull_request_by_id\` to fetch PR status.`;
}

function getPrVoteInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    return `Use \`gh pr review\` to approve or request changes:\n- \`gh pr review <number> --approve\`\n- \`gh pr review <number> --request-changes\``;
  }
  return `Use \`mcp__azure-ado__repo_update_pull_request_reviewers\`:\n- repositoryId: \`${repoId}\`\n- Set your reviewer vote on the PR (10=approve, 5=approve-with-suggestions, -10=reject)`;
}

function getRepoHostLabel(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'GitHub';
  return 'Azure DevOps';
}

function getRepoHostToolRule(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'Use GitHub MCP tools or `gh` CLI for PR operations';
  return 'Use Azure DevOps MCP tools (mcp__azure-ado__*) for PR operations — NEVER use gh CLI';
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

// Lean system prompt: agent identity + rules only (~2-4KB, never grows)
function buildSystemPrompt(agentId, config, project) {
  const agent = config.agents[agentId];
  const charter = getAgentCharter(agentId);
  project = project || getProjects(config)[0] || {};

  let prompt = '';

  // Agent identity
  prompt += `# You are ${agent.name} (${agent.role})\n\n`;
  prompt += `Agent ID: ${agentId}\n`;
  prompt += `Skills: ${(agent.skills || []).join(', ')}\n\n`;

  // Charter (detailed instructions — typically 1-2KB)
  if (charter) {
    prompt += `## Your Charter\n\n${charter}\n\n`;
  }

  // Project context (fixed size)
  prompt += `## Project: ${project.name || 'Unknown Project'}\n\n`;
  prompt += `- Repo: ${project.repoName || 'Unknown'} (${project.adoOrg || 'Unknown'}/${project.adoProject || 'Unknown'})\n`;
  prompt += `- Repo ID: ${project.repositoryId || ''}\n`;
  prompt += `- Repo host: ${getRepoHostLabel(project)}\n`;
  prompt += `- Main branch: ${project.mainBranch || 'main'}\n\n`;

  // Critical rules (fixed size)
  prompt += `## Critical Rules\n\n`;
  prompt += `1. Use git worktrees — NEVER checkout on main working tree\n`;
  prompt += `2. ${getRepoHostToolRule(project)}\n`;
  prompt += `3. Follow the project conventions in CLAUDE.md if present\n`;
  prompt += `4. Write learnings to: ${SQUAD_DIR}/notes/inbox/${agentId}-${dateStamp()}.md\n`;
  prompt += `5. Agent status is managed by the engine via dispatch.json — agents do not need to track their own status\n`;
  prompt += `6. If you discover a repeatable workflow, output it as a \\\`\\\`\\\`skill fenced block — the engine auto-extracts it to ~/.claude/skills/\n\n`;

  return prompt;
}

// Bulk context: history, notes, conventions, skills — prepended to user/task prompt.
// This is the content that grows over time and would bloat the system prompt.
function buildAgentContext(agentId, config, project) {
  project = project || getProjects(config)[0] || {};
  let context = '';

  // Agent history — last 5 tasks only (keeps it relevant, avoids 37KB dumps)
  const history = safeRead(path.join(AGENTS_DIR, agentId, 'history.md'));
  if (history && history.trim() !== '# Agent History') {
    const entries = history.split(/(?=^### )/m);
    const header = entries[0].startsWith('#') && !entries[0].startsWith('### ') ? entries.shift() : '';
    const recent = entries.slice(-5);
    const trimmed = (header ? header + '\n' : '') + recent.join('');
    context += `## Your Recent History (last 5 tasks)\n\n${trimmed}\n\n`;
  }

  // Project conventions (from CLAUDE.md) — always relevant for code quality
  if (project.localPath) {
    const claudeMd = safeRead(path.join(project.localPath, 'CLAUDE.md'));
    if (claudeMd && claudeMd.trim()) {
      const truncated = claudeMd.length > 8192 ? claudeMd.slice(0, 8192) + '\n\n...(truncated)' : claudeMd;
      context += `## Project Conventions (from CLAUDE.md)\n\n${truncated}\n\n`;
    }
  }

  // KB and skills: NOT injected — agents can Glob/Read when needed
  // This saves ~27KB per dispatch. Reference note so agents know they exist:
  context += `## Reference Files\n\nKnowledge base entries are in \`knowledge/{category}/*.md\`. Skills are in \`skills/*.md\` and \`.claude/skills/\`. Use Glob/Read to browse when relevant.\n\n`;

  // Squad awareness: what's in flight, who's doing what
  const dispatch = getDispatch();
  const activeItems = (dispatch.active || []).map(d =>
    `- **${d.agent}**: ${d.type} — ${(d.task || '').slice(0, 100)}${d.agent === agentId ? ' ← (you)' : ''}`
  );
  if (activeItems.length > 0) {
    context += `## Active Agents\n\n${activeItems.join('\n')}\n\n`;
  }

  // Recent completions (last 5, not 10)
  const recentCompleted = (dispatch.completed || []).slice(-5).reverse().map(d =>
    `- **${d.agent}** ${d.result === 'success' ? 'completed' : 'failed'}: ${(d.task || '').slice(0, 80)}${d.resultSummary ? ' — ' + d.resultSummary.slice(0, 100) : ''}`
  );
  if (recentCompleted.length > 0) {
    context += `## Recently Completed\n\n${recentCompleted.join('\n')}\n\n`;
  }

  // Active PRs across projects — coordination awareness
  const projects = getProjects(config);
  const allPrs = [];
  for (const p of projects) {
    const prs = getPrs(p).filter(pr => pr.status === 'active');
    for (const pr of prs) allPrs.push({ ...pr, _project: p.name });
  }
  if (allPrs.length > 0) {
    const prLines = allPrs.map(pr =>
      `- **${pr.id}** (${pr._project}): ${(pr.title || '').slice(0, 80)} [${pr.reviewStatus || 'pending'}${pr.buildStatus === 'failing' ? ', BUILD FAILING' : ''}]${pr.branch ? ' branch: `' + pr.branch + '`' : ''}`
    );
    context += `## Active Pull Requests\n\n${prLines.join('\n')}\n\n`;
  }

  // Pending work items
  const pendingItems = (dispatch.pending || []).slice(0, 10).map(d =>
    `- ${d.type}: ${(d.task || '').slice(0, 80)}`
  );
  if (pendingItems.length > 0) {
    context += `## Pending Work Queue (${(dispatch.pending || []).length} items)\n\n${pendingItems.join('\n')}${(dispatch.pending || []).length > 10 ? '\n- ... and ' + ((dispatch.pending || []).length - 10) + ' more' : ''}\n\n`;
  }

  // Team notes — last 5 sections only (recent learnings, not the full history)
  const notes = getNotes();
  if (notes) {
    const sections = notes.split(/(?=^### )/m);
    const header = sections[0] && !sections[0].startsWith('### ') ? sections.shift() : '';
    if (sections.length > 5) {
      const recent = sections.slice(-5).join('');
      context += `## Team Notes (last 5 of ${sections.length})\n\n${recent}\n\n_${sections.length - 5} older entries in \`notes.md\` — Read if needed._\n\n`;
    } else {
      context += `## Team Notes\n\n${notes}\n\n`;
    }
  }

  return context;
}

// sanitizeBranch imported from shared.js

// ─── Lifecycle (extracted to engine/lifecycle.js) ────────────────────────────

const { runPostCompletionHooks, updateWorkItemStatus, syncPrdItemStatus, handlePostMerge, checkPlanCompletion,
  syncPrsFromOutput, updatePrAfterReview, updatePrAfterFix, checkForLearnings, extractSkillsFromOutput,
  updateAgentHistory, updateMetrics, createReviewFeedbackForAuthor, parseAgentOutput, syncPrdFromPrs } = require('./engine/lifecycle');

// ─── Agent Spawner ──────────────────────────────────────────────────────────

const activeProcesses = new Map(); // dispatchId → { proc, agentId, startedAt }
let engineRestartGraceUntil = 0; // timestamp — suppress orphan detection until this time

// Resolve dependency plan item IDs to their PR branches
function resolveDependencyBranches(depIds, sourcePlan, project, config) {
  const results = []; // [{ branch, prId }]
  if (!depIds?.length) return results;

  const projects = shared.getProjects(config);

  // Find work items for each dependency plan item
  const depWorkItems = [];
  for (const p of projects) {
    const wiPath = shared.projectWorkItemsPath(p);
    const items = safeJson(wiPath) || [];
    for (const wi of items) {
      if (depIds.includes(wi.id)) {
        depWorkItems.push(wi);
      }
    }
  }

  // Find PR branches for each dependency work item
  for (const p of projects) {
    const prPath = shared.projectPrPath(p);
    const prs = safeJson(prPath) || [];
    for (const pr of prs) {
      if (!pr.branch || pr.status !== 'active') continue;
      const linked = (pr.prdItems || []).some(id =>
        depWorkItems.find(w => w.id === id)
      );
      if (linked && !results.find(r => r.branch === pr.branch)) {
        results.push({ branch: pr.branch, prId: pr.id });
      }
    }
  }

  return results;
}

// Find an existing worktree already checked out on a given branch
function findExistingWorktree(repoDir, branchName) {
  try {
    const out = exec(`git worktree list --porcelain`, { cwd: repoDir, stdio: 'pipe', timeout: 10000 }).toString();
    const branchRef = `branch refs/heads/${branchName}`;
    const lines = out.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === branchRef) {
        // Walk back to find the worktree path
        for (let j = i - 1; j >= 0; j--) {
          if (lines[j].startsWith('worktree ')) {
            const wtPath = lines[j].slice('worktree '.length).trim();
            if (fs.existsSync(wtPath)) return wtPath;
            break;
          }
        }
      }
    }
  } catch {}
  return null;
}

function isWorktreeRetryableError(err) {
  const msg = String(err?.message || '');
  return msg.includes('ETIMEDOUT')
    || msg.includes('index.lock')
    || msg.includes('timed out')
    || msg.includes('could not lock')
    || msg.includes('resource busy')
    || msg.includes('already exists');
}

function removeStaleIndexLock(rootDir) {
  const lockFile = path.join(rootDir, '.git', 'index.lock');
  try {
    if (fs.existsSync(lockFile)) {
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (age > 300000) {
        fs.unlinkSync(lockFile);
        log('warn', `Removed stale index.lock (${Math.round(age / 1000)}s old) in ${rootDir}`);
      }
    }
  } catch {}
}

function runWorktreeAdd(rootDir, worktreePath, args, gitOpts, worktreeCreateRetries) {
  let lastErr = null;
  const retries = Math.max(0, Number(worktreeCreateRetries) || 0);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        try { exec('git worktree prune', { ...gitOpts, cwd: rootDir, timeout: 15000 }); } catch {}
        removeStaleIndexLock(rootDir);
        log('warn', `Retrying git worktree add (attempt ${attempt + 1}/${retries + 1}) for ${path.basename(worktreePath)}`);
      }
      exec(`git worktree add "${worktreePath}" ${args}`, { ...gitOpts, cwd: rootDir });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isWorktreeRetryableError(err)) throw err;
    }
  }
  if (lastErr) throw lastErr;
}

function recoverPartialWorktree(rootDir, worktreePath, branchName, gitOpts) {
  if (!branchName) return false;
  const existingWt = findExistingWorktree(rootDir, branchName);
  if (existingWt && fs.existsSync(existingWt)) return true;
  if (!fs.existsSync(worktreePath)) return false;
  try {
    exec(`git -C "${worktreePath}" rev-parse --is-inside-work-tree`, { ...gitOpts, timeout: 10000 });
    exec(`git -C "${worktreePath}" rev-parse --abbrev-ref HEAD`, { ...gitOpts, timeout: 10000 });
    log('warn', `Recovered partially-created worktree for ${branchName} at ${worktreePath}`);
    return true;
  } catch {
    return false;
  }
}

function spawnAgent(dispatchItem, config) {
  const { id, agent: agentId, prompt: taskPrompt, type, meta } = dispatchItem;
  const claudeConfig = config.claude || {};
  const engineConfig = config.engine || {};
  const startedAt = ts();

  // Resolve project context for this dispatch
  const project = meta?.project || getProjects(config)[0] || {};
  const rootDir = project.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');

  // Determine working directory
  let cwd = rootDir;
  let worktreePath = null;
  let branchName = meta?.branch ? sanitizeBranch(meta.branch) : null;
  const worktreeCreateTimeout = Math.max(60000, Number(engineConfig.worktreeCreateTimeout) || DEFAULTS.worktreeCreateTimeout);
  const worktreeCreateRetries = Math.max(0, Math.min(3, Number(engineConfig.worktreeCreateRetries) || DEFAULTS.worktreeCreateRetries));
  const _gitOpts = { stdio: 'pipe', timeout: 30000, windowsHide: true, env: shared.gitEnv() };
  const _worktreeGitOpts = { ..._gitOpts, timeout: worktreeCreateTimeout };

  if (branchName) {
    const wtSuffix = id ? id.split('-').pop() : shared.uid();
    const projectSlug = (project.name || 'default').replace(/[^a-zA-Z0-9_-]/g, '-');
    const wtDirName = `${projectSlug}-${branchName}-${wtSuffix}`;
    worktreePath = path.resolve(rootDir, engineConfig.worktreeRoot || '../worktrees', wtDirName);

    // If branch is already checked out in an existing worktree, reuse it
    const existingWt = findExistingWorktree(rootDir, branchName);
    if (existingWt) {
      worktreePath = existingWt;
      log('info', `Reusing existing worktree for ${branchName}: ${existingWt}`);
      try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch {}
      try { exec(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: existingWt }); } catch {}
    } else if (type !== 'implement') {
      // Only implement tasks may create new worktrees.
      // Other task types are reuse-only: if no existing worktree, run in rootDir.
      log('info', `${type}: no existing worktree for ${branchName} — creation disabled for non-implement tasks, falling back to rootDir`);
      branchName = null;
      worktreePath = null;
    } else {
      try {
        if (!fs.existsSync(worktreePath)) {
          const isSharedBranch = meta?.branchStrategy === 'shared-branch' || meta?.useExistingBranch;
          // Prune stale worktree entries before creating (handles leftover entries from crashed runs)
          try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch {}
          // Remove stale index.lock before creating worktree (Windows crashes can leave this behind)
          removeStaleIndexLock(rootDir);

          if (isSharedBranch) {
            log('info', `Creating worktree for shared branch: ${worktreePath} on ${branchName}`);
            try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch {}
            try {
              runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (eShared) {
              if (eShared.message?.includes('already used by worktree') || eShared.message?.includes('already checked out')) {
                const existingWtPath = findExistingWorktree(rootDir, branchName);
                if (existingWtPath && fs.existsSync(existingWtPath)) {
                  log('info', `Shared branch ${branchName} already checked out at ${existingWtPath} — reusing`);
                  worktreePath = existingWtPath;
                } else { throw eShared; }
              } else { throw eShared; }
            }
          } else {
            log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
            try {
              runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${sanitizeBranch(project.mainBranch || 'main')}`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (e1) {
              // Branch already exists or checked out elsewhere — try without -b
              try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch {}
              try {
                runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                log('info', `Reusing existing branch: ${branchName}`);
              } catch (e2) {
                // "already checked out" or "already used by worktree" — find and reuse or recover
                const alreadyUsed = e2.message?.includes('already checked out') || e2.message?.includes('already used by worktree')
                  || e1.message?.includes('already checked out') || e1.message?.includes('already used by worktree');
                if (alreadyUsed) {
                  const existingWtPath = findExistingWorktree(rootDir, branchName);
                  if (existingWtPath && fs.existsSync(existingWtPath)) {
                    // Directory exists — reuse it if no other active dispatch is using it
                    const dispatch = safeJson(DISPATCH_PATH) || {};
                    const activelyUsed = (dispatch.active || []).some(d => {
                      const dBranch = d.meta?.branch ? sanitizeBranch(d.meta.branch) : '';
                      return dBranch === branchName && d.id !== id;
                    });
                    if (activelyUsed) {
                      log('warn', `Branch ${branchName} actively used by another agent at ${existingWtPath} — cannot create worktree`);
                      throw e2;
                    }
                    // Reuse the existing worktree — update path so the rest of spawnAgent uses it
                    log('info', `Branch ${branchName} already checked out at ${existingWtPath} — reusing`);
                    worktreePath = existingWtPath;
                  } else if (existingWtPath && !fs.existsSync(existingWtPath)) {
                    // Directory gone but git still tracks it — prune and recreate
                    log('warn', `Branch ${branchName} tracked in missing dir ${existingWtPath} — pruning and recreating`);
                    try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch {}
                    runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                    log('info', `Recovered worktree for ${branchName} after stale entry prune`);
                  } else {
                    // Can't find the worktree at all — prune and retry
                    try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch {}
                    runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                  }
                } else {
                  throw e2;
                }
              }
            }
          }
        } else if (meta?.branchStrategy === 'shared-branch') {
          log('info', `Pulling latest on shared branch ${branchName}`);
          try { exec(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: worktreePath }); } catch {}
        }
      } catch (err) {
        if (recoverPartialWorktree(rootDir, worktreePath, branchName, _gitOpts)) {
          cwd = worktreePath;
          log('warn', `Proceeding with recovered worktree after add failure for ${branchName}`);
        } else {
          log('error', `Failed to create worktree for ${branchName}: ${err.message}${err.stderr ? '\n' + err.stderr.toString().slice(0, 500) : ''}`);
          completeDispatch(id, 'error', 'Worktree creation failed: ' + (err.message || '').slice(0, 200));
          return null;
        }
      }
    }

    // Merge dependency PR branches into worktree (applies to both reused and new worktrees)
    if (worktreePath && fs.existsSync(worktreePath)) {
      cwd = worktreePath;
      const depIds = meta?.item?.depends_on || [];
      if (depIds.length > 0) {
        try {
          const depBranches = resolveDependencyBranches(depIds, meta?.item?.sourcePlan, project, config);
          for (const { branch: depBranch, prId } of depBranches) {
            try {
              exec(`git fetch origin "${depBranch}"`, { ..._gitOpts, cwd: rootDir });
              exec(`git merge "origin/${depBranch}" --no-edit`, { ..._gitOpts, cwd: worktreePath });
              log('info', `Merged dependency branch ${depBranch} (${prId}) into worktree ${branchName}`);
            } catch (mergeErr) {
              log('warn', `Failed to merge dependency ${depBranch} into ${branchName}: ${mergeErr.message}`);
            }
          }
        } catch (e) {
          log('warn', `Could not resolve dependency branches for ${branchName}: ${e.message}`);
        }
      }
    }
  }

  // Build lean system prompt (identity + rules, ~2-4KB) and bulk context (history, notes, skills)
  const systemPrompt = buildSystemPrompt(agentId, config, project);
  const agentContext = buildAgentContext(agentId, config, project);

  // Prepend bulk context to task prompt — keeps system prompt small and stable
  const fullTaskPrompt = agentContext
    ? `## Agent Context\n\n${agentContext}\n---\n\n## Your Task\n\n${taskPrompt}`
    : taskPrompt;

  // Write prompt and system prompt to temp files (avoids shell escaping issues)
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const promptPath = path.join(tmpDir, `prompt-${id}.md`);
  safeWrite(promptPath, fullTaskPrompt);

  const sysPromptPath = path.join(tmpDir, `sysprompt-${id}.md`);
  safeWrite(sysPromptPath, systemPrompt);

  // Build claude CLI args
  const args = [
    '--output-format', claudeConfig.outputFormat || 'stream-json',
    '--max-turns', String(engineConfig.maxTurns || DEFAULTS.maxTurns),
    '--verbose',
    '--permission-mode', claudeConfig.permissionMode || 'bypassPermissions'
  ];

  if (claudeConfig.allowedTools) {
    args.push('--allowedTools', claudeConfig.allowedTools);
  }

  // MCP servers: agents inherit from ~/.claude.json directly as Claude Code processes.
  // No --mcp-config needed — avoids redundant config and ensures agents always have latest servers.

  log('info', `Spawning agent: ${agentId} (${id}) in ${cwd}`);
  log('info', `Task type: ${type} | Branch: ${branchName || 'none'}`);

  // Agent status is derived from dispatch.json — no setAgentStatus needed for working state.

  // Spawn the claude process
  const childEnv = shared.cleanChildEnv();

  // Spawn via wrapper script — node directly (no bash intermediary)
  // spawn-agent.js handles CLAUDECODE env cleanup and claude binary resolution
  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const spawnArgs = [spawnScript, promptPath, sysPromptPath, ...args];

  const proc = runFile(process.execPath, spawnArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  const MAX_OUTPUT = 1024 * 1024; // 1MB
  let stdout = '';
  let stderr = '';
  let lastOutputAt = Date.now();
  let heartbeatTimer = null;

  // Live output file — written as data arrives so dashboard can tail it
  const liveOutputPath = path.join(AGENTS_DIR, agentId, 'live-output.log');
  safeWrite(liveOutputPath, `# Live output for ${agentId} — ${id}\n# Started: ${startedAt}\n# Task: ${dispatchItem.task}\n\n`);

  // Keep live log active even when the agent produces no stdout/stderr for long stretches.
  // This makes "silent but running" states visible in the dashboard tail view.
  heartbeatTimer = setInterval(() => {
    const silentMs = Date.now() - lastOutputAt;
    if (silentMs < 30000) return;
    const silentSec = Math.round(silentMs / 1000);
    try { fs.appendFileSync(liveOutputPath, `[heartbeat] running — no output for ${silentSec}s\n`); } catch {}
  }, 30000);

  proc.stdout.on('data', (data) => {
    const chunk = data.toString();
    lastOutputAt = Date.now();
    if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
    try { fs.appendFileSync(liveOutputPath, chunk); } catch {}
  });

  proc.stderr.on('data', (data) => {
    const chunk = data.toString();
    lastOutputAt = Date.now();
    if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
    try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch {}
  });

  proc.on('close', (code) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('info', `Agent ${agentId} (${id}) exited with code ${code}`);
    activeProcesses.delete(id);

    // If timeout checker already finalized this dispatch, don't overwrite work-item status again.
    // This avoids races where close-handler marks an auto-retried item as failed.
    const dispatchNow = getDispatch();
    const stillActive = (dispatchNow.active || []).some(d => d.id === id);
    if (!stillActive) {
      log('info', `Agent ${agentId} (${id}) close event ignored — dispatch already completed elsewhere`);
      try { fs.unlinkSync(sysPromptPath); } catch {}
      try { fs.unlinkSync(promptPath); } catch {}
      try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch {}
      return;
    }

    // Save output — per-dispatch archive + latest symlink
    const outputContent = `# Output for dispatch ${id}\n# Exit code: ${code}\n# Completed: ${ts()}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}`;
    const archivePath = path.join(AGENTS_DIR, agentId, `output-${id}.log`);
    const latestPath = path.join(AGENTS_DIR, agentId, 'output.log');
    safeWrite(archivePath, outputContent);
    safeWrite(latestPath, outputContent); // overwrite latest for dashboard compat

    // Parse output and run all post-completion hooks
    const { resultSummary } = runPostCompletionHooks(dispatchItem, agentId, code, stdout, config);

    // Move from active to completed in dispatch (single source of truth for agent status)
    completeDispatch(id, code === 0 ? 'success' : 'error', '', resultSummary);

    // Cleanup temp files (including PID file now that dispatch is complete)
    try { fs.unlinkSync(sysPromptPath); } catch {}
    try { fs.unlinkSync(promptPath); } catch {}
    try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch {}

    log('info', `Agent ${agentId} completed. Output saved to ${archivePath}`);
  });

  proc.on('error', (err) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('error', `Failed to spawn agent ${agentId}: ${err.message}`);
    activeProcesses.delete(id);
    completeDispatch(id, 'error', `Spawn error: ${err.message}`);
  });

  // Safety: if process exits immediately (within 3s), log it
  setTimeout(() => {
    if (proc.exitCode !== null && !proc.killed) {
      log('warn', `Agent ${agentId} (${id}) exited within 3s with code ${proc.exitCode}`);
    }
  }, 3000);

  // Track process — even if PID isn't available yet (async on Windows)
  activeProcesses.set(id, { proc, agentId, startedAt });

  // Log PID and persist to registry
  if (proc.pid) {
    log('info', `Agent process started: PID ${proc.pid}`);
  } else {
    log('warn', `Agent spawn returned no PID initially — will verify via PID file`);
  }

  // Verify spawn after 5 seconds via PID file written by spawn-agent.js
  // PID file is kept (not deleted) so engine can re-attach on restart
  setTimeout(() => {
    const pidFile = promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
    try {
      const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
      if (pidStr) {
        log('info', `Agent ${agentId} verified via PID file: ${pidStr}`);
      }
      // Don't delete — keep for re-attachment on engine restart
    } catch {
      if (!fs.existsSync(liveOutputPath) || fs.statSync(liveOutputPath).size <= 200) {
        log('error', `Agent ${agentId} (${id}) — no PID file and no output after 5s. Spawn likely failed.`);
      }
    }
  }, 5000);

  // Move pending -> active under a lock to avoid cross-process lost updates (engine/dashboard)
  mutateDispatch((dispatch) => {
    const idx = dispatch.pending.findIndex(d => d.id === id);
    if (idx < 0) return;
    const item = dispatch.pending.splice(idx, 1)[0];
    item.started_at = startedAt;
    if (!dispatch.active.some(d => d.id === id)) {
      dispatch.active.push(item);
    }
  });

  return proc;
}

// ─── Dispatch Management ────────────────────────────────────────────────────

function addToDispatch(item) {
  item.id = item.id || `${item.agent}-${item.type}-${shared.uid()}`;
  item.created_at = ts();
  mutateDispatch((dispatch) => {
    dispatch.pending.push(item);
  });
  log('info', `Queued dispatch: ${item.id} (${item.type} → ${item.agent})`);
  return item.id;
}

function isRetryableFailureReason(reason = '') {
  const r = String(reason || '').toLowerCase();
  if (!r) return true; // unknown error from tool exit — keep retryable
  const nonRetryable = [
    'no playbook rendered',
    'failed to render',
    'no target project available',
    'no plan files found',
    'plan file not found',
    'invalid filename',
    'invalid file path',
    'missing required',
    'validation failed',
  ];
  return !nonRetryable.some(s => r.includes(s));
}

function completeDispatch(id, result = 'success', reason = '', resultSummary = '', opts = {}) {
  const { processWorkItemFailure = true } = opts;
  let item = null;

  mutateDispatch((dispatch) => {
    // Check active list first
    let idx = dispatch.active.findIndex(d => d.id === id);
    if (idx >= 0) {
      item = dispatch.active.splice(idx, 1)[0];
    } else {
      // Also check pending list (e.g., worktree failure before spawn)
      idx = dispatch.pending.findIndex(d => d.id === id);
      if (idx >= 0) item = dispatch.pending.splice(idx, 1)[0];
    }

    if (!item) return;
    item.completed_at = ts();
    item.result = result;
    if (reason) item.reason = reason;
    if (resultSummary) item.resultSummary = resultSummary;
    delete item.prompt;
    if (dispatch.completed.length >= 100) {
      dispatch.completed = dispatch.completed.slice(-99);
    }
    dispatch.completed.push(item);
  });

  if (item) {
    log('info', `Completed dispatch: ${id} (${result}${reason ? ': ' + reason : ''})`);

    // Update source work item status on failure + auto-retry with backoff
    const retryableFailure = isRetryableFailureReason(reason);
    if (result === 'error' && item.meta?.dispatchKey && retryableFailure) setCooldownFailure(item.meta.dispatchKey);

    if (processWorkItemFailure && result === 'error' && item.meta?.item?.id) {
      const retries = (item.meta.item._retryCount || 0);
      if (retryableFailure && retries < 3) {
        log('info', `Dispatch error for ${item.meta.item.id} — auto-retry ${retries + 1}/3`);
        updateWorkItemStatus(item.meta, 'pending', '');
        // Remove this dispatch key from completed so dedupe doesn't block immediate redispatch.
        if (item.meta?.dispatchKey) {
          try {
            mutateDispatch((dp) => {
              const before = Array.isArray(dp.completed) ? dp.completed.length : 0;
              dp.completed = Array.isArray(dp.completed) ? dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey) : [];
              return dp.completed.length !== before ? dp : undefined;
            });
          } catch {}
        }
        // Increment retry counter on the source work item
        try {
          const wiPath = item.meta.source === 'central-work-item' || item.meta.source === 'central-work-item-fanout'
            ? path.join(SQUAD_DIR, 'work-items.json')
            : item.meta.project?.name ? projectWorkItemsPath({ name: item.meta.project.name, localPath: item.meta.project.localPath }) : null;
          if (wiPath) {
            const items = safeJson(wiPath) || [];
            const wi = items.find(i => i.id === item.meta.item.id);
            if (wi && wi.status !== 'paused') {
              wi._retryCount = retries + 1;
              wi.status = 'pending';
              wi._lastRetryReason = reason || '';
              wi._lastRetryAt = ts();
              delete wi.failReason;
              delete wi.failedAt;
              delete wi.dispatched_at;
              delete wi.dispatched_to;
              safeWrite(wiPath, items);
            }
          }
        } catch {}
      } else {
        const finalReason = !retryableFailure
          ? `Non-retryable failure: ${reason || 'Unknown error'}`
          : (reason || 'Failed after 3 retries');
        updateWorkItemStatus(item.meta, 'failed', finalReason);
        // Alert: find items blocked by this failure and write inbox note
        try {
          const config = getConfig();
          const failedId = item.meta.item.id;
          const blockedItems = [];
          for (const p of getProjects(config)) {
            const items = safeJson(projectWorkItemsPath(p)) || [];
            items.filter(w => w.status === 'pending' && (w.depends_on || []).includes(failedId))
              .forEach(w => blockedItems.push(`- \`${w.id}\` — ${w.title}`));
          }
          const centralItems = safeJson(path.join(SQUAD_DIR, 'work-items.json')) || [];
          centralItems.filter(w => w.status === 'pending' && (w.depends_on || []).includes(failedId))
            .forEach(w => blockedItems.push(`- \`${w.id}\` — ${w.title}`));

          writeInboxAlert(`failed-${failedId}`,
            `# Work Item Failed — \`${failedId}\`\n\n` +
            `**Item:** ${item.meta.item.title || failedId}\n` +
            `**Reason:** ${finalReason}\n\n` +
            (blockedItems.length > 0
              ? `**Blocked dependents (${blockedItems.length}):**\n${blockedItems.join('\n')}\n\n` +
                `These items cannot dispatch until \`${failedId}\` is fixed and reset to \`pending\`.\n`
              : `No downstream items are blocked.\n`)
          );
        } catch {}
      }
    }
  }
}

// ─── Dependency Gate ─────────────────────────────────────────────────────────
// Returns: true (deps met), false (deps pending), 'failed' (dep failed — propagate)
function areDependenciesMet(item, config) {
  const deps = item.depends_on;
  if (!deps || deps.length === 0) return true;
  const sourcePlan = item.sourcePlan;
  if (!sourcePlan) return true;
  const projects = getProjects(config);

  // Collect work items from ALL projects (dependencies can be cross-project)
  let allWorkItems = [];
  for (const p of projects) {
    try {
      const wi = safeJson(projectWorkItemsPath(p)) || [];
      allWorkItems = allWorkItems.concat(wi);
    } catch {}
  }
  // PRD item statuses that count as "done" for dep resolution
  const PRD_MET_STATUSES = new Set(['done', 'in-pr', 'implemented', 'complete']);

  for (const depId of deps) {
    const depItem = allWorkItems.find(w => w.id === depId);
    if (!depItem) {
      // Fallback: check PRD JSON — plan-to-prd agents may pre-set items to done
      try {
        const plan = safeJson(path.join(PRD_DIR, sourcePlan));
        const prdItem = (plan?.missing_features || []).find(f => f.id === depId);
        if (prdItem && PRD_MET_STATUSES.has(prdItem.status)) continue; // PRD says done — treat as met
      } catch {}
      log('warn', `Dependency ${depId} not found for ${item.id} (plan: ${sourcePlan}) — treating as unmet`);
      return false;
    }
    if (depItem.status === 'failed' && (depItem._retryCount || 0) >= 3) return 'failed'; // Only cascade after retries exhausted
    if (depItem.status !== 'done' && depItem.status !== 'in-pr') return false; // Pending, dispatched, or retrying — wait (in-pr accepted for backward compat)
  }
  return true;
}

function detectDependencyCycles(items) {
  const graph = new Map();
  for (const item of items) graph.set(item.id, item.depends_on || []);
  const visited = new Set(), inStack = new Set(), cycleIds = new Set();
  function dfs(id) {
    if (inStack.has(id)) { cycleIds.add(id); return true; }
    if (visited.has(id)) return false;
    visited.add(id); inStack.add(id);
    for (const dep of (graph.get(id) || [])) { if (dfs(dep)) cycleIds.add(id); }
    inStack.delete(id); return false;
  }
  for (const id of graph.keys()) dfs(id);
  return [...cycleIds];
}


// ─── Shared helpers ───────────────────────────────────────────────────────────

// Write a one-off alert note to notes/inbox so the user sees it on next consolidation
function writeInboxAlert(slug, content) {
  try {
    const file = path.join(INBOX_DIR, `engine-alert-${slug}-${dateStamp()}.md`);
    // Dedupe: don't write the same alert twice in the same day
    const existing = safeReadDir(INBOX_DIR).find(f => f.startsWith(`engine-alert-${slug}-${dateStamp()}`));
    if (existing) return;
    safeWrite(file, content);
  } catch {}
}

// Reconciles work items against known PRs via exact prdItems match only.
// reconcilePrs (ado.js) and syncPrsFromOutput (lifecycle.js) are responsible for
// correctly populating prdItems on PRs — this function just reads that linkage.
// onlyIds: if provided, only items whose ID is in this Set are eligible.
function reconcileItemsWithPrs(items, allPrs, { onlyIds } = {}) {
  let reconciled = 0;
  for (const wi of items) {
    if (wi.status !== 'pending' || wi._pr) continue;
    if (onlyIds && !onlyIds.has(wi.id)) continue;

    const exactPr = allPrs.find(pr => (pr.prdItems || []).includes(wi.id));
    if (exactPr) {
      wi.status = 'done';
      wi._pr = exactPr.id;
      reconciled++;
    }
  }
  return reconciled;
}

// ─── Inbox Consolidation (extracted to engine/consolidation.js) ──────────────

const { consolidateInbox } = require('./engine/consolidation');
const { pollPrStatus, pollPrHumanComments, reconcilePrs } = require('./engine/ado');
const { pollPrStatus: ghPollPrStatus, pollPrHumanComments: ghPollPrHumanComments, reconcilePrs: ghReconcilePrs } = require('./engine/github');

// ─── State Snapshot ─────────────────────────────────────────────────────────

function updateSnapshot(config) {
  const dispatch = getDispatch();
  const agents = config.agents || {};
  const projects = getProjects(config);

  let snapshot = `# Squad State — ${ts()}\n\n`;
  snapshot += `## Projects: ${projects.map(p => p.name).join(', ')}\n\n`;

  snapshot += `## Agents\n\n`;
  snapshot += `| Agent | Role | Status | Task |\n`;
  snapshot += `|-------|------|--------|------|\n`;
  for (const [id, agent] of Object.entries(agents)) {
    const status = getAgentStatus(id);
    snapshot += `| ${agent.emoji} ${agent.name} | ${agent.role} | ${status.status} | ${status.task || '-'} |\n`;
  }

  snapshot += `\n## Dispatch Queue\n\n`;
  snapshot += `- Pending: ${dispatch.pending.length}\n`;
  snapshot += `- Active: ${(dispatch.active || []).length}\n`;
  snapshot += `- Completed: ${(dispatch.completed || []).length}\n`;

  if (dispatch.pending.length > 0) {
    snapshot += `\n### Pending\n`;
    for (const d of dispatch.pending) {
      snapshot += `- [${d.id}] ${d.type} → ${d.agent}: ${d.task}\n`;
    }
  }
  if ((dispatch.active || []).length > 0) {
    snapshot += `\n### Active\n`;
    for (const d of dispatch.active) {
      snapshot += `- [${d.id}] ${d.type} → ${d.agent}: ${d.task} (since ${d.started_at})\n`;
    }
  }

  safeWrite(path.join(IDENTITY_DIR, 'now.md'), snapshot);
}

// ─── Idle Alert ─────────────────────────────────────────────────────────────

let _lastActivityTime = Date.now();
let _idleAlertSent = false;

function checkIdleThreshold(config) {
  const thresholdMs = (config.engine?.idleAlertMinutes || 15) * 60 * 1000;
  const agents = Object.keys(config.agents || {});
  const allIdle = agents.every(id => isAgentIdle(id));
  const dispatch = getDispatch();
  const hasPending = (dispatch.pending || []).length > 0;

  if (!allIdle || hasPending) {
    _lastActivityTime = Date.now();
    _idleAlertSent = false;
    return;
  }

  const idleMs = Date.now() - _lastActivityTime;
  if (idleMs > thresholdMs && !_idleAlertSent) {
    const mins = Math.round(idleMs / 60000);
    log('warn', `All agents idle for ${mins} minutes — no work sources producing items`);
    _idleAlertSent = true;
  }
}

// ─── Timeout Checker ────────────────────────────────────────────────────────

function checkTimeouts(config) {
  const timeout = config.engine?.agentTimeout || DEFAULTS.agentTimeout;
  const heartbeatTimeout = config.engine?.heartbeatTimeout || DEFAULTS.heartbeatTimeout;

  // 1. Check tracked processes for hard timeout (supports per-item deadline from fan-out)
  for (const [id, info] of activeProcesses.entries()) {
    const itemTimeout = info.meta?.deadline ? Math.max(0, info.meta.deadline - new Date(info.startedAt).getTime()) : timeout;
    const elapsed = Date.now() - new Date(info.startedAt).getTime();
    if (elapsed > itemTimeout) {
      log('warn', `Agent ${info.agentId} (${id}) hit hard timeout after ${Math.round(elapsed / 1000)}s — killing`);
      try { info.proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { info.proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  }

  // 2. Heartbeat check — for ALL active dispatch items (catches orphans after engine restart)
  //    Uses live-output.log mtime as heartbeat. If no output for heartbeatTimeout, agent is dead.
  const dispatch = getDispatch();
  const deadItems = [];

  for (const item of (dispatch.active || [])) {
    if (!item.agent) continue;

    const hasProcess = activeProcesses.has(item.id);
    const liveLogPath = path.join(AGENTS_DIR, item.agent, 'live-output.log');
    let lastActivity = item.started_at ? new Date(item.started_at).getTime() : 0;

    // Check live-output.log mtime as heartbeat
    try {
      const stat = fs.statSync(liveLogPath);
      lastActivity = Math.max(lastActivity, stat.mtimeMs);
    } catch {}

    const silentMs = Date.now() - lastActivity;
    const silentSec = Math.round(silentMs / 1000);

    // Check if the agent actually completed (result event in live output)
    // Optimization: only read file if recent activity (avoids reading stale 1MB logs)
    let completedViaOutput = false;
    try {
      if (silentMs > 600000) throw 'skip'; // No point reading a file silent for >10min
      const liveLog = safeRead(liveLogPath);
      if (liveLog && liveLog.includes('"type":"result"')) {
        completedViaOutput = true;
        const isSuccess = liveLog.includes('"subtype":"success"');
        log('info', `Agent ${item.agent} (${item.id}) completed via output detection (${isSuccess ? 'success' : 'error'})`);

        // Extract output text for the output.log
        const outputLogPath = path.join(AGENTS_DIR, item.agent, 'output.log');
        try {
          const resultLine = liveLog.split('\n').find(l => l.includes('"type":"result"'));
          if (resultLine) {
            const result = JSON.parse(resultLine);
            safeWrite(outputLogPath, `# Output for dispatch ${item.id}\n# Exit code: ${isSuccess ? 0 : 1}\n# Completed: ${ts()}\n# Detected via output scan\n\n## Result\n${result.result || '(no text)'}\n`);
          }
        } catch {}

        completeDispatch(item.id, isSuccess ? 'success' : 'error', 'Completed (detected from output)');

        // Run post-completion hooks via shared helper
        runPostCompletionHooks(item, item.agent, isSuccess ? 0 : 1, liveLog, config);

        if (hasProcess) {
          try { activeProcesses.get(item.id)?.proc.kill('SIGTERM'); } catch {}
          activeProcesses.delete(item.id);
        }
        continue; // Skip orphan/hung detection — we handled it
      }
    } catch {}

    // Check if agent is in a blocking tool call (TaskOutput block:true, Bash with long timeout, etc.)
    // These tools produce no stdout for extended periods — don't kill them prematurely
    // Check for BOTH tracked and untracked processes (orphan case after engine restart)
    let isBlocking = false;
    let blockingTimeout = heartbeatTimeout;
    if (silentMs > heartbeatTimeout) {
      try {
        const liveLog = safeRead(liveLogPath);
        if (liveLog) {
          // Find the last tool_use call in the output — check if it's a known blocking tool
          const lines = liveLog.split('\n');
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
            const line = lines[i];
            if (!line.includes('"tool_use"')) continue;
            try {
              const parsed = JSON.parse(line);
              const toolUse = parsed?.message?.content?.find?.(c => c.type === 'tool_use');
              if (!toolUse) continue;
              const input = toolUse.input || {};
              const name = toolUse.name || '';
              // TaskOutput with block:true — waiting for a background task
              if (name === 'TaskOutput' && input.block === true) {
                const taskTimeout = input.timeout || 600000; // default 10min
                blockingTimeout = Math.max(heartbeatTimeout, taskTimeout + 60000); // task timeout + 1min grace
                isBlocking = true;
              }
              // Bash with explicit long timeout (>5min)
              if (name === 'Bash' && input.timeout && input.timeout > heartbeatTimeout) {
                blockingTimeout = Math.max(heartbeatTimeout, input.timeout + 60000);
                isBlocking = true;
              }
              break; // only check the most recent tool_use
            } catch {}
          }
          if (isBlocking) {
            log('info', `Agent ${item.agent} (${item.id}) is in a blocking tool call — extended timeout to ${Math.round(blockingTimeout / 1000)}s (silent for ${silentSec}s)`);
          }
        }
      } catch {}
    }

    const effectiveTimeout = isBlocking ? blockingTimeout : heartbeatTimeout;

    if (!hasProcess && silentMs > effectiveTimeout && Date.now() > engineRestartGraceUntil) {
      // No tracked process AND no recent output past effective timeout AND grace period expired → orphaned
      log('warn', `Orphan detected: ${item.agent} (${item.id}) — no process tracked, silent for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''}`);
      deadItems.push({ item, reason: `Orphaned — no process, silent for ${silentSec}s` });
    } else if (hasProcess && silentMs > effectiveTimeout) {
      // Has process but no output past effective timeout → hung
      log('warn', `Hung agent: ${item.agent} (${item.id}) — process exists but no output for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''}`);
      const procInfo = activeProcesses.get(item.id);
      if (procInfo) {
        try { procInfo.proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { procInfo.proc.kill('SIGKILL'); } catch {} }, 5000);
        activeProcesses.delete(item.id);
      }
      deadItems.push({ item, reason: `Hung — no output for ${silentSec}s` });
    }
    // If has process and recent output → healthy, let it run
  }

  // Clean up dead items
  for (const { item, reason } of deadItems) {
    completeDispatch(item.id, 'error', reason);
  }

  // Agent status is now derived from dispatch.json at read time (getAgentStatus).
  // No reconcile sweep needed — dispatch IS the source of truth.

  // Reconcile: find work items stuck in "dispatched" with no matching active dispatch
  const activeKeys = new Set((dispatch.active || []).map(d => d.meta?.dispatchKey).filter(Boolean));
  const allWiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
  for (const project of getProjects(config)) {
    allWiPaths.push(projectWorkItemsPath(project));
  }
  for (const wiPath of allWiPaths) {
    const items = safeJson(wiPath);
    if (!items || !Array.isArray(items)) continue;
    let changed = false;
    for (const item of items) {
      if (item.status !== 'dispatched') continue;
      // Check if any active dispatch references this item
      // Dispatch keys include project name: work-{project}-{id} or central-work-{id}
      const projectNames = getProjects(config).map(p => p.name);
      const possibleKeys = [
        `central-work-${item.id}`,
        ...projectNames.map(p => `work-${p}-${item.id}`),
      ];
      const isActive = possibleKeys.some(k => activeKeys.has(k)) ||
        (dispatch.active || []).some(d => d.meta?.item?.id === item.id);
      if (!isActive) {
        const retries = (item._retryCount || 0);
        if (retries < 3) {
          log('info', `Reconcile: work item ${item.id} agent died — auto-retry ${retries + 1}/3`);
          item.status = 'pending';
          item._retryCount = retries + 1;
          delete item.dispatched_at;
          delete item.dispatched_to;
        } else {
          log('warn', `Reconcile: work item ${item.id} failed after ${retries} retries — marking as failed`);
          item.status = 'failed';
          item.failReason = 'Agent died or was killed (3 retries exhausted)';
          item.failedAt = ts();
        }
        changed = true;
      }
    }
    if (changed) safeWrite(wiPath, items);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function runCleanup(config, verbose = false) {
  const projects = getProjects(config);
  let cleaned = { tempFiles: 0, liveOutputs: 0, worktrees: 0, zombies: 0 };

  // 1. Clean stale temp prompt/sysprompt files (older than 1 hour)
  const oneHourAgo = Date.now() - 3600000;
  try {
    const tmpDir = path.join(ENGINE_DIR, 'tmp');
    const scanDirs = [ENGINE_DIR, ...(fs.existsSync(tmpDir) ? [tmpDir] : [])];
    for (const dir of scanDirs) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('prompt-') || f.startsWith('sysprompt-') || f.startsWith('tmp-sysprompt-')) {
          const fp = path.join(dir, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs < oneHourAgo) {
              fs.unlinkSync(fp);
              cleaned.tempFiles++;
            }
          } catch {}
        }
      }
    }
  } catch {}

  // 2. Clean live-output.log for idle agents (not currently working)
  for (const [agentId] of Object.entries(config.agents || {})) {
    const status = getAgentStatus(agentId);
    if (status.status !== 'working') {
      const livePath = path.join(AGENTS_DIR, agentId, 'live-output.log');
      if (fs.existsSync(livePath)) {
        try {
          const stat = fs.statSync(livePath);
          if (stat.mtimeMs < oneHourAgo) {
            fs.unlinkSync(livePath);
            cleaned.liveOutputs++;
          }
        } catch {}
      }
    }
  }

  // 3. Clean git worktrees for merged/abandoned PRs
  for (const project of projects) {
    const root = project.localPath ? path.resolve(project.localPath) : null;
    if (!root || !fs.existsSync(root)) continue;

    const worktreeRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    if (!fs.existsSync(worktreeRoot)) continue;

    // Get PRs for this project
    const prs = safeJson(projectPrPath(project)) || [];
    const mergedBranches = new Set();
    for (const pr of prs) {
      if (pr.status === 'merged' || pr.status === 'abandoned' || pr.status === 'completed') {
        if (pr.branch) mergedBranches.add(pr.branch);
      }
    }

    // List worktrees — collect info for age-based + cap-based cleanup
    const MAX_WORKTREES = 10;
    try {
      const dirs = fs.readdirSync(worktreeRoot);
      const wtEntries = []; // { dir, wtPath, mtime, shouldClean, isProtected }
      const dispatch = getDispatch();

      for (const dir of dirs) {
        const wtPath = path.join(worktreeRoot, dir);
        try { if (!fs.statSync(wtPath).isDirectory()) continue; } catch { continue; }

        let shouldClean = false;
        let isProtected = false;

        // Check if this worktree's branch is merged/abandoned
        // Use sanitized exact match on the branch portion of the dir name (format: {slug}-{branch}-{suffix})
        const dirLower = dir.toLowerCase();
        for (const branch of mergedBranches) {
          const branchSlug = sanitizeBranch(branch).toLowerCase();
          if (dirLower === branchSlug || dirLower.includes(branchSlug + '-') || dirLower.endsWith('-' + branchSlug)) {
            shouldClean = true;
            break;
          }
        }

        // Check if referenced by active/pending dispatch (use sanitized branch comparison)
        const isReferenced = [...dispatch.pending, ...(dispatch.active || [])].some(d => {
          if (!d.meta?.branch) return false;
          const dispBranch = sanitizeBranch(d.meta.branch).toLowerCase();
          return dirLower.includes(dispBranch);
        });
        if (isReferenced) isProtected = true;

        // Also clean worktrees older than 2 hours with no active dispatch referencing them
        let mtime = Date.now();
        if (!shouldClean) {
          try {
            const stat = fs.statSync(wtPath);
            mtime = stat.mtimeMs;
            const ageMs = Date.now() - mtime;
            if (ageMs > 7200000 && !isReferenced) { // 2 hours
              shouldClean = true;
            }
          } catch {}
        }

        // Skip worktrees for active shared-branch plans (check both prd/ and plans/ for .json PRDs)
        if (shouldClean || !isProtected) {
          try {
            for (const checkDir of [PRD_DIR, path.join(SQUAD_DIR, 'plans')]) {
              if (!fs.existsSync(checkDir)) continue;
              for (const pf of fs.readdirSync(checkDir).filter(f => f.endsWith('.json'))) {
                const plan = safeJson(path.join(checkDir, pf));
                if (plan?.branch_strategy === 'shared-branch' && plan?.feature_branch && plan?.status !== 'completed') {
                  const planBranch = sanitizeBranch(plan.feature_branch).toLowerCase();
                  if (dirLower.includes(planBranch)) {
                    isProtected = true;
                    if (shouldClean) {
                      shouldClean = false;
                      if (verbose) console.log(`  Skipping worktree ${dir}: active shared-branch plan`);
                    }
                    break;
                  }
                }
              }
              if (isProtected) break;
            }
          } catch {}
        }

        wtEntries.push({ dir, wtPath, mtime, shouldClean, isProtected });
      }

      // Enforce max worktree cap — if over limit, mark oldest unprotected for cleanup
      const surviving = wtEntries.filter(e => !e.shouldClean && !e.isProtected);
      if (surviving.length + wtEntries.filter(e => e.isProtected).length > MAX_WORKTREES) {
        // Sort oldest first
        surviving.sort((a, b) => a.mtime - b.mtime);
        const excess = surviving.length + wtEntries.filter(e => e.isProtected).length - MAX_WORKTREES;
        for (let i = 0; i < Math.min(excess, surviving.length); i++) {
          surviving[i].shouldClean = true;
          if (verbose) console.log(`  Marking worktree ${surviving[i].dir} for cap cleanup (${MAX_WORKTREES} max)`);
        }
      }

      // Remove all marked worktrees
      for (const entry of wtEntries) {
        if (entry.shouldClean) {
          try {
            exec(`git worktree remove "${entry.wtPath}" --force`, { cwd: root, stdio: 'pipe' });
            cleaned.worktrees++;
            if (verbose) console.log(`  Removed worktree: ${entry.wtPath}`);
          } catch (e) {
            if (verbose) console.log(`  Failed to remove worktree ${entry.wtPath}: ${e.message}`);
          }
        }
      }
    } catch {}
  }

  // 4. Kill zombie claude processes not tracked by the engine
  // List all node processes, check if any are running spawn-agent.js for our squad
  try {
    const dispatch = getDispatch();
    const activePids = new Set();
    for (const [, info] of activeProcesses.entries()) {
      if (info.proc?.pid) activePids.add(info.proc.pid);
    }

    // Clean individual orphaned processes — no matching active dispatch
    const activeIds = new Set((dispatch.active || []).map(d => d.id));
    for (const [id, info] of activeProcesses.entries()) {
      if (!activeIds.has(id)) {
        try { if (info.proc) info.proc.kill('SIGTERM'); } catch {}
        activeProcesses.delete(id);
        cleaned.zombies++;
      }
    }
  } catch {}

  // 5. Clean spawn-debug.log
  try { fs.unlinkSync(path.join(ENGINE_DIR, 'spawn-debug.log')); } catch {}

  // 6. Prune old output archive files (keep last 30 per agent)
  for (const agentId of Object.keys(config.agents || {})) {
    const agentDir = path.join(SQUAD_DIR, 'agents', agentId);
    if (!fs.existsSync(agentDir)) continue;
    try {
      const outputFiles = fs.readdirSync(agentDir)
        .filter(f => f.startsWith('output-') && f.endsWith('.log') && f !== 'output.log')
        .map(f => ({ name: f, mtime: fs.statSync(path.join(agentDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of outputFiles.slice(30)) {
        try { fs.unlinkSync(path.join(agentDir, old.name)); cleaned.files++; } catch {}
      }
    } catch {}
  }

  // 7. Prune orphaned dispatch entries — items whose source work item no longer exists
  cleaned.orphanedDispatches = 0;
  try {
    const dispatch = getDispatch();
    // Collect all work item IDs across all sources
    const allWiIds = new Set();
    try {
      const central = safeJson(path.join(SQUAD_DIR, 'work-items.json')) || [];
      central.forEach(w => allWiIds.add(w.id));
    } catch {}
    for (const project of projects) {
      try {
        const projItems = safeJson(projectWorkItemsPath(project)) || [];
        projItems.forEach(w => allWiIds.add(w.id));
      } catch {}
    }

    let changed = false;
    for (const queue of ['pending', 'active']) {
      if (!dispatch[queue]) continue;
      const before = dispatch[queue].length;
      dispatch[queue] = dispatch[queue].filter(d => {
        const itemId = d.meta?.item?.id;
        if (!itemId) return true; // keep entries without item tracking
        return allWiIds.has(itemId);
      });
      const removed = before - dispatch[queue].length;
      if (removed > 0) {
        cleaned.orphanedDispatches += removed;
        changed = true;
      }
    }
    if (changed) {
      mutateDispatch((dp) => {
        for (const queue of ['pending', 'active']) {
          if (!dp[queue]) continue;
          dp[queue] = dp[queue].filter(d => {
            const itemId = d.meta?.item?.id;
            if (!itemId) return true;
            return allWiIds.has(itemId);
          });
        }
      });
    }
  } catch {}

  if (cleaned.tempFiles + cleaned.liveOutputs + cleaned.worktrees + cleaned.zombies + (cleaned.files || 0) + cleaned.orphanedDispatches > 0) {
    log('info', `Cleanup: ${cleaned.tempFiles} temp, ${cleaned.liveOutputs} live outputs, ${cleaned.worktrees} worktrees, ${cleaned.zombies} zombies, ${cleaned.files || 0} archives, ${cleaned.orphanedDispatches} orphaned dispatches`);
  }

  // 8. Clean swept KB files older than 7 days
  try {
    const sweptDir = path.join(SQUAD_DIR, 'knowledge', '_swept');
    if (fs.existsSync(sweptDir)) {
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      for (const f of fs.readdirSync(sweptDir)) {
        try {
          const fp = path.join(sweptDir, f);
          if (fs.statSync(fp).mtimeMs < sevenDaysAgo) {
            fs.unlinkSync(fp);
            if (!cleaned.sweptKb) cleaned.sweptKb = 0;
            cleaned.sweptKb++;
          }
        } catch {}
      }
    }
  } catch {}

  // 9. KB watchdog — restore deleted KB files from git if count dropped vs checkpoint
  try {
    const checkpoint = safeJson(path.join(ENGINE_DIR, 'kb-checkpoint.json'));
    if (checkpoint && checkpoint.count > 0) {
      const { KB_CATEGORIES: cats } = shared;
      const knowledgeDir = path.join(SQUAD_DIR, 'knowledge');
      let current = 0;
      for (const cat of cats) {
        const d = path.join(knowledgeDir, cat);
        if (fs.existsSync(d)) current += fs.readdirSync(d).length;
      }
      if (current < checkpoint.count) {
        log('warn', `KB watchdog: file count dropped ${checkpoint.count} → ${current}, restoring from git`);
        try {
          const trackedCheck = execSilent('git ls-tree --name-only HEAD -- knowledge', { cwd: SQUAD_DIR }).toString().trim();
          if (!trackedCheck) {
            log('warn', 'KB watchdog: knowledge/ is not tracked in git HEAD — skipping restore');
          } else {
            execSilent('git checkout HEAD -- knowledge', { cwd: SQUAD_DIR });
            log('info', 'KB watchdog: restored knowledge/ from git HEAD');
          }
        } catch (err) {
          log('error', `KB watchdog: git restore failed — ${err.message}`);
        }
      }
    }
  } catch {}

  return cleaned;
}

// ─── Work Discovery ─────────────────────────────────────────────────────────

const COOLDOWN_PATH = path.join(ENGINE_DIR, 'cooldowns.json');
const dispatchCooldowns = new Map(); // key → { timestamp, failures }

function loadCooldowns() {
  const saved = safeJson(COOLDOWN_PATH);
  if (!saved) return;
  const now = Date.now();
  for (const [k, v] of Object.entries(saved)) {
    // Prune entries older than 24 hours
    if (now - v.timestamp < 24 * 60 * 60 * 1000) {
      dispatchCooldowns.set(k, v);
    }
  }
  log('info', `Loaded ${dispatchCooldowns.size} cooldowns from disk`);
}

let _cooldownWriteTimer = null;
function saveCooldowns() {
  // Debounce: reset timer on each call so latest state is always written
  if (_cooldownWriteTimer) clearTimeout(_cooldownWriteTimer);
  _cooldownWriteTimer = setTimeout(() => {
    _cooldownWriteTimer = null;
    // Prune expired entries (>24h) before saving
    const now = Date.now();
    for (const [k, v] of dispatchCooldowns) {
      if (now - v.timestamp > 24 * 60 * 60 * 1000) dispatchCooldowns.delete(k);
    }
    const obj = Object.fromEntries(dispatchCooldowns);
    safeWrite(COOLDOWN_PATH, obj);
  }, 1000); // debounce — write at most once per second
}

function isOnCooldown(key, cooldownMs) {
  const entry = dispatchCooldowns.get(key);
  if (!entry) return false;
  const backoff = Math.min(Math.pow(2, entry.failures || 0), 2);
  return (Date.now() - entry.timestamp) < (cooldownMs * backoff);
}

function setCooldown(key) {
  const existing = dispatchCooldowns.get(key);
  dispatchCooldowns.set(key, { timestamp: Date.now(), failures: existing?.failures || 0 });
  saveCooldowns();
}

function setCooldownFailure(key) {
  const existing = dispatchCooldowns.get(key);
  const failures = (existing?.failures || 0) + 1;
  dispatchCooldowns.set(key, { timestamp: Date.now(), failures });
  if (failures >= 3) {
    log('warn', `${key} has failed ${failures} times — cooldown is now ${Math.min(Math.pow(2, failures), 2)}x`);
  }
  saveCooldowns();
}

function isAlreadyDispatched(key) {
  const dispatch = getDispatch();
  // Check pending and active
  const inFlight = [...dispatch.pending, ...(dispatch.active || [])];
  if (inFlight.some(d => d.meta?.dispatchKey === key)) return true;
  // Also check recently completed (last hour) to prevent re-dispatch
  const oneHourAgo = Date.now() - 3600000;
  const recentCompleted = (dispatch.completed || []).filter(d =>
    d.completed_at && new Date(d.completed_at).getTime() > oneHourAgo
  );
  return recentCompleted.some(d => d.meta?.dispatchKey === key);
}



/**
 * Scan ~/.squad/plans/ for plan-generated PRD files → queue implement tasks.
 * Plans are project-scoped JSON files written by the plan-to-prd playbook.
 */
/**
 * Convert plan files into project work items (side-effect, like specs).
 * Plans write to the target project's work-items.json — picked up by discoverFromWorkItems next tick.
 */
// Auto-clean pending/failed work items for a PRD so they re-materialize with updated plan data
function autoCleanPrdWorkItems(prdFile, config) {
  const allProjects = getProjects(config);
  const wiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
  for (const proj of allProjects) wiPaths.push(projectWorkItemsPath(proj));
  const deletedIds = [];
  for (const wiPath of wiPaths) {
    try {
      const items = safeJson(wiPath);
      if (!items) continue;
      const filtered = items.filter(w => {
        if (w.sourcePlan === prdFile && (w.status === 'pending' || w.status === 'failed')) {
          deletedIds.push(w.id); return false;
        }
        return true;
      });
      if (filtered.length < items.length) safeWrite(wiPath, filtered);
    } catch {}
  }
  if (deletedIds.length > 0) {
    const deletedSet = new Set(deletedIds);
    cleanDispatchEntries(d => deletedSet.has(d.meta?.item?.id) && d.meta?.item?.sourcePlan === prdFile);
    log('info', `Plan sync: cleared ${deletedIds.length} pending/failed work items for ${prdFile}`);
  }
}

function materializePlansAsWorkItems(config) {
  if (!fs.existsSync(PRD_DIR)) { try { fs.mkdirSync(PRD_DIR, { recursive: true }); } catch {} }

  // Enforce: PRDs must be .json — auto-rename .md files that contain valid PRD JSON
  // Check both prd/ and plans/ (agents may still write JSON to plans/)
  for (const checkDir of [PRD_DIR, PLANS_DIR]) {
    if (!fs.existsSync(checkDir)) continue;
    try {
      const mdFiles = fs.readdirSync(checkDir).filter(f => f.endsWith('.md'));
      for (const mf of mdFiles) {
        try {
          const content = (safeRead(path.join(checkDir, mf)) || '').trim();
          // Strip markdown code fences if agent wrapped JSON in them
          const stripped = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
          const parsed = JSON.parse(stripped);
          if (parsed.missing_features) {
            const jsonName = mf.replace(/\.md$/, '.json');
            safeWrite(path.join(PRD_DIR, jsonName), parsed);
            try { fs.unlinkSync(path.join(checkDir, mf)); } catch {}
            log('info', `Plan enforcement: moved ${mf} → prd/${jsonName} (PRDs must be .json in prd/)`);
          }
        } catch {} // Not JSON — it's a proper plan .md, leave it
      }
    } catch {}
    // Also migrate any .json PRD files from plans/ to prd/
    if (checkDir === PLANS_DIR) {
      try {
        const jsonInPlans = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json'));
        for (const jf of jsonInPlans) {
          try {
            const parsed = safeJson(path.join(PLANS_DIR, jf));
            if (parsed?.missing_features) {
              safeWrite(path.join(PRD_DIR, jf), parsed);
              try { fs.unlinkSync(path.join(PLANS_DIR, jf)); } catch {}
              log('info', `Auto-migrated PRD ${jf} from plans/ to prd/`);
            }
          } catch {}
        }
      } catch {}
    }
  }

  let planFiles;
  try { planFiles = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.json')); } catch { return; }

  for (const file of planFiles) {
    const plan = safeJson(path.join(PRD_DIR, file));
    if (!plan?.missing_features) continue;

    // Plan staleness: if source_plan .md was modified since last sync, auto-clean and re-sync
    if (plan.source_plan) {
      const sourcePlanPath = path.join(PLANS_DIR, plan.source_plan);
      try {
        const sourceMtime = Math.floor(fs.statSync(sourcePlanPath).mtimeMs); // floor to strip sub-ms Windows precision
        const recorded = plan.sourcePlanModifiedAt ? new Date(plan.sourcePlanModifiedAt).getTime() : null;
        if (!recorded) {
          // First time seeing this plan — record baseline mtime (no clean needed)
          plan.sourcePlanModifiedAt = new Date(sourceMtime).toISOString();
          safeWrite(path.join(PRD_DIR, file), plan);
        } else if (sourceMtime > recorded) {
          // Source plan changed — auto-clean pending/failed items so they re-materialize with updated data
          log('info', `Source plan ${plan.source_plan} updated — re-syncing PRD ${file}`);
          autoCleanPrdWorkItems(file, config);
          plan.sourcePlanModifiedAt = new Date(sourceMtime).toISOString();
          plan.lastSyncedFromPlan = new Date().toISOString();

          // Handle PRD based on current status
          const prdStatus = plan.status || (plan.requires_approval ? 'awaiting-approval' : null);

          // Approved/executing PRDs: flag as stale but don't disrupt in-flight work
          if (prdStatus === 'approved' || prdStatus === 'completed') {
            plan.planStale = true;
            log('info', `PRD ${file} flagged as stale (plan revised while ${prdStatus}) — user can regenerate from dashboard`);
          }

          // Awaiting-approval PRDs: invalidate, carry over completed items, delete old PRD, queue regeneration
          if (prdStatus === 'awaiting-approval') {
            log('info', `PRD ${file} invalidated (was awaiting-approval) — queuing regeneration from revised plan`);

            // Collect completed items to carry over to new PRD
            const completedStatuses = new Set(['done', 'in-pr', 'implemented']); // in-pr kept for backward compat
            const completedItems = (plan.missing_features || [])
              .filter(f => completedStatuses.has(f.status))
              .map(f => ({ id: f.id, name: f.name, status: f.status }));

            const completedContext = completedItems.length > 0
              ? `\nPreviously completed items (preserve their status in the new PRD):\n${completedItems.map(i => `- ${i.id}: ${i.name} [${i.status}]`).join('\n')}`
              : '';

            // Delete old PRD — agent will write replacement at same path
            try { fs.unlinkSync(path.join(PRD_DIR, file)); } catch {}

            // Queue plan-to-prd regeneration
            const planContent = safeRead(path.join(PLANS_DIR, plan.source_plan));
            if (planContent) {
              const projectName = plan.project || file.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
              const allProjects = getProjects(config);
              const targetProject = allProjects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) || allProjects[0];
              if (targetProject) {
                const centralWiPath = path.join(SQUAD_DIR, 'work-items.json');
                const centralItems = safeJson(centralWiPath) || [];
                const alreadyQueued = centralItems.some(w =>
                  w.type === 'plan-to-prd' && w.planFile === plan.source_plan && (w.status === 'pending' || w.status === 'dispatched')
                );
                if (!alreadyQueued) {
                  centralItems.push({
                    id: 'W-' + shared.uid(),
                    title: `Regenerate PRD from revised plan: ${plan.source_plan}`,
                    type: 'plan-to-prd',
                    priority: 'high',
                    description: `Plan file: plans/${plan.source_plan}\nTarget PRD filename: ${file}\nSource plan was revised while PRD was awaiting approval — regenerating.${completedContext}`,
                    status: 'pending',
                    created: ts(),
                    createdBy: 'engine:plan-revision',
                    project: targetProject.name,
                    planFile: plan.source_plan,
                    _targetPrdFile: file,
                  });
                  safeWrite(centralWiPath, centralItems);
                  log('info', `Queued plan-to-prd regeneration for revised plan ${plan.source_plan} (${completedItems.length} completed items to carry over)`);
                }
              }
            }
            continue; // Old PRD deleted — skip safeWrite below
          }

          safeWrite(path.join(PRD_DIR, file), plan);
        }
      } catch {}
    }

    // Human approval gate: plans start as 'awaiting-approval' and must be approved before work begins
    // Plans without a status (legacy) or with status 'approved' are allowed through
    const planStatus = plan.status || (plan.requires_approval ? 'awaiting-approval' : null);
    if (planStatus === 'awaiting-approval' || planStatus === 'paused' || planStatus === 'rejected' || planStatus === 'revision-requested') {
      continue; // Skip — waiting for human approval, paused, or revision
    }
    // Stale PRDs: source plan was revised — don't materialize NEW items until user regenerates
    if (plan.planStale) {
      continue;
    }

    const defaultProjectName = plan.project || file.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
    const allProjects = getProjects(config);
    const defaultProject = allProjects.find(p => p.name?.toLowerCase() === defaultProjectName.toLowerCase());
    if (!defaultProject) continue;

    const statusFilter = ['missing', 'planned'];
    const items = plan.missing_features.filter(f => statusFilter.includes(f.status));

    // Group items by target project (per-item project field overrides plan-level project)
    const itemsByProject = new Map(); // projectName -> { project, items: [] }
    for (const item of items) {
      const itemProjectName = item.project || defaultProjectName;
      const itemProject = allProjects.find(p => p.name?.toLowerCase() === itemProjectName.toLowerCase()) || defaultProject;
      if (!itemsByProject.has(itemProject.name)) {
        itemsByProject.set(itemProject.name, { project: itemProject, items: [] });
      }
      itemsByProject.get(itemProject.name).items.push(item);
    }

    // Cycle detection BEFORE materialization — skip cyclic items
    const cycleSet = new Set();
    const planDerivedItems = plan.missing_features.filter(f => f.depends_on && f.depends_on.length > 0);
    if (planDerivedItems.length > 0) {
      const cycles = detectDependencyCycles(plan.missing_features);
      if (cycles.length > 0) {
        log('error', `Dependency cycle detected in plan ${file}: ${cycles.join(', ')} — skipping cyclic items`);
        cycles.forEach(c => cycleSet.add(c));
        writeInboxAlert(`cycle-${path.basename(file, '.json')}`,
          `# Dependency Cycle Detected — ${path.basename(file)}\n\n` +
          `The following PRD items form a cycle and were **skipped** (will never be dispatched):\n\n` +
          cycles.map(id => `- \`${id}\``).join('\n') + '\n\n' +
          `Fix by removing or reordering the \`depends_on\` relationships in \`prd/${path.basename(file)}\`.\n`
        );
      }
    }

    let totalCreated = 0;
    for (const [projName, { project, items: projItems }] of itemsByProject) {
      const wiPath = projectWorkItemsPath(project);
      const existingItems = safeJson(wiPath) || [];
      let created = 0;
      const newlyCreatedIds = new Set(); // tracks IDs created in this pass for reconciliation scoping

      for (const item of projItems) {
        // Skip if already materialized — work item ID = PRD item ID, check all projects
        let alreadyExists = existingItems.some(w => w.id === item.id);
        if (!alreadyExists) {
          for (const p of allProjects) {
            if (p.name === projName) continue;
            const otherItems = safeJson(projectWorkItemsPath(p)) || [];
            if (otherItems.some(w => w.id === item.id)) { alreadyExists = true; break; }
          }
        }
        if (alreadyExists) continue;
        // Skip items involved in dependency cycles
        if (cycleSet.has(item.id)) continue;

        const id = item.id; // Work item ID = PRD item ID — no indirection
        const complexity = item.estimated_complexity || 'medium';
        const criteria = (item.acceptance_criteria || []).map(c => `- ${c}`).join('\n');

        const newItem = {
          id,
          title: `Implement: ${item.name}`,
          type: complexity === 'large' ? 'implement:large' : 'implement',
          priority: item.priority || 'medium',
          description: `${item.description || ''}\n\n**Plan:** ${file}\n**Plan Item:** ${item.id}\n**Complexity:** ${complexity}${criteria ? '\n\n**Acceptance Criteria:**\n' + criteria : ''}`,
          status: 'pending',
          created: ts(),
          createdBy: 'engine:plan-discovery',
          sourcePlan: file,
          depends_on: item.depends_on || [],
          branchStrategy: plan.branch_strategy || 'parallel',
          featureBranch: plan.feature_branch || null,
          project: item.project || plan.project || null,
        };
        existingItems.push(newItem);
        newlyCreatedIds.add(id);
        created++;
      }

      if (created > 0) {
        // Reconciliation: exact prdItems match only, scoped to newly created items
        const allPrsForReconcile = allProjects.flatMap(p => safeJson(projectPrPath(p)) || []);
        const reconciled = reconcileItemsWithPrs(existingItems, allPrsForReconcile, { onlyIds: newlyCreatedIds });
        if (reconciled > 0) log('info', `Plan reconciliation: marked ${reconciled} item(s) as done → ${projName}`);

        // PRD removal sync: cancel pending work items whose PRD item was removed from the plan
        const currentPrdIds = new Set(plan.missing_features.map(f => f.id));
        let cancelled = 0;
        for (const wi of existingItems) {
          if (wi.status !== 'pending' || wi.sourcePlan !== file) continue;
          if (!currentPrdIds.has(wi.id)) {
            wi.status = 'cancelled';
            wi.cancelledAt = ts();
            wi.cancelReason = `PRD item removed from ${file}`;
            cancelled++;
          }
        }
        if (cancelled > 0) log('info', `Plan sync: cancelled ${cancelled} item(s) removed from ${file} → ${projName}`);

        safeWrite(wiPath, existingItems);
        log('info', `Plan discovery: created ${created} work item(s) from ${file} → ${projName}`);
      }
      totalCreated += created;
    }

    if (totalCreated > 0) {
      log('info', `Plan discovery: ${totalCreated} total item(s) from ${file} across ${itemsByProject.size} project(s)`);

      // Pre-create shared feature branch if branch_strategy is shared-branch
      if (plan.branch_strategy === 'shared-branch' && plan.feature_branch) {
        try {
          const root = path.resolve(project.localPath);
          const mainBranch = project.mainBranch || 'main';
          const branch = sanitizeBranch(plan.feature_branch);
          // Create branch from main (idempotent — ignores if exists)
          exec(`git branch "${branch}" "${mainBranch}" 2>/dev/null || true`, { cwd: root, stdio: 'pipe' });
          exec(`git push -u origin "${branch}" 2>/dev/null || true`, { cwd: root, stdio: 'pipe' });
          log('info', `Shared branch pre-created: ${branch} for plan ${file}`);
        } catch (err) {
          log('warn', `Failed to pre-create shared branch for ${file}: ${err.message}`);
        }
      }

      // (cycle detection moved before materialization loop)
    }
  }
}

// ─── Work Discovery Helpers ──────────────────────────────────────────────────

function buildBaseVars(agentId, config, project) {
  return {
    agent_id: agentId,
    agent_name: config.agents[agentId]?.name || agentId,
    agent_role: config.agents[agentId]?.role || 'Agent',
    team_root: SQUAD_DIR,
    repo_id: project?.repositoryId || '',
    project_name: project?.name || 'Unknown Project',
    ado_org: project?.adoOrg || 'Unknown',
    ado_project: project?.adoProject || 'Unknown',
    repo_name: project?.repoName || 'Unknown',
    main_branch: project?.mainBranch || 'main',
    date: dateStamp(),
  };
}

function selectPlaybook(workType, item) {
  if (item?.branchStrategy === 'shared-branch' && (workType === 'implement' || workType === 'implement:large')) {
    return 'implement-shared';
  }
  if (workType === 'review' && !item?._pr && !item?.pr_id) {
    return 'work-item';
  }
  const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask', 'verify'];
  return typeSpecificPlaybooks.includes(workType) ? workType : 'work-item';
}

function buildPrDispatch(agentId, config, project, pr, type, extraVars, taskLabel, meta) {
  const vars = { ...buildBaseVars(agentId, config, project), ...extraVars };
  const playbookName = type === 'test' ? 'build-and-test' : (type === 'review' ? 'review' : 'fix');
  const prompt = renderPlaybook(playbookName, vars);
  if (!prompt) return null;
  return {
    type,
    agent: agentId,
    agentName: config.agents[agentId]?.name,
    agentRole: config.agents[agentId]?.role,
    task: `[${project?.name || 'project'}] ${taskLabel}`,
    prompt,
    meta,
  };
}

/**
 * Scan pull-requests.json for PRs needing review or fixes
 */
function discoverFromPrs(config, project) {
  const src = project?.workSources?.pullRequests || config.workSources?.pullRequests;
  if (!src?.enabled) return [];

  const prs = safeJson(projectPrPath(project)) || [];
  const cooldownMs = (src.cooldownMinutes || 30) * 60 * 1000;
  const newWork = [];

  const projMeta = { name: project?.name, localPath: project?.localPath };

  // Collect active PR dispatches to prevent simultaneous review+fix on same PR
  const dispatch = getDispatch();
  const activePrIds = new Set(
    (dispatch.active || []).filter(d => d.meta?.pr?.id).map(d => d.meta.pr.id)
  );

  for (const pr of prs) {
    if (pr.status !== 'active') continue;
    if (activePrIds.has(pr.id)) continue; // Skip PRs with active dispatch (prevent race)

    const prNumber = (pr.id || '').replace(/^PR-/, '');
    const squadStatus = pr.squadReview?.status;

    // PRs needing review
    const needsReview = !squadStatus || squadStatus === 'waiting';
    if (needsReview) {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      // No self-review: exclude the PR author from review assignment
      const prAuthor = (pr.agent || '').toLowerCase();
      let agentId = resolveAgent('review', config);
      if (agentId && agentId === prAuthor) {
        agentId = resolveAgent('review', config); // retry — prAuthor now claimed, gets skipped
      }
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'review', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        pr_author: pr.agent || '', pr_url: pr.url || '',
      }, `Review PR ${pr.id}: ${pr.title}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

    // PRs with changes requested → route back to author for fix
    if (squadStatus === 'changes-requested') {
      const key = `fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: pr.squadReview?.note || pr.reviewNote || 'See PR thread comments',
      }, `Fix PR ${pr.id} review feedback`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

    // PRs with pending human feedback
    if (pr.humanFeedback?.pendingFix) {
      const key = `human-fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        reviewer: 'Human Reviewer',
        review_note: pr.humanFeedback.feedbackContent || 'See PR thread comments',
      }, `Fix PR ${pr.id} — human feedback`, { dispatchKey: key, source: 'pr-human-feedback', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); pr.humanFeedback.pendingFix = false; setCooldown(key); }
    }

    // PRs with build failures
    if (pr.status === 'active' && pr.buildStatus === 'failing') {
      const key = `build-fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: `Build is failing: ${pr.buildFailReason || 'Check CI pipeline for details'}. Fix the build errors and push.`,
      }, `Fix build failure on PR ${pr.id}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

  }
  // Build & test now runs once at PRD completion (via verify task), not per-PR.

  return newWork;
}

/**
 * Scan work-items.json for manually queued tasks
 */
function discoverFromWorkItems(config, project) {
  const src = project?.workSources?.workItems || config.workSources?.workItems;
  if (!src?.enabled) return [];

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const items = safeJson(projectWorkItemsPath(project)) || [];
  const cooldownMs = (src.cooldownMinutes || 0) * 60 * 1000;
  const newWork = [];
  const skipped = { gated: 0, noAgent: 0 };
  let needsWrite = false;

  for (const item of items) {
    // Re-evaluate failed items: if deps have recovered, reset to pending
    if (item.status === 'failed' && item.failReason === 'Dependency failed — cannot proceed') {
      const depStatus = areDependenciesMet(item, config);
      if (depStatus === true) {
        item.status = 'pending';
        delete item.failReason;
        log('info', `Recovered ${item.id} from dependency failure — deps now met`);
        needsWrite = true;
      }
    }

    if (item.status !== 'queued' && item.status !== 'pending') continue;

    // Dependency gate: skip items whose depends_on are not yet met; propagate failure
    if (item.depends_on && item.depends_on.length > 0) {
      const depStatus = areDependenciesMet(item, config);
      if (depStatus === 'failed') {
        item.status = 'failed';
        item.failReason = 'Dependency failed — cannot proceed';
        log('warn', `Marking ${item.id} as failed: dependency failed (plan: ${item.sourcePlan})`);
        continue;
      }
      if (!depStatus) continue;
    }

    const key = `work-${project?.name || 'default'}-${item.id}`;
    // Self-heal: if an item is pending, stale completed/cooldown markers must not gate redispatch.
    // This protects against persisted state drift from old runtime versions.
    try {
      mutateDispatch((dp) => {
        const before = Array.isArray(dp.completed) ? dp.completed.length : 0;
        dp.completed = Array.isArray(dp.completed) ? dp.completed.filter(d => d.meta?.dispatchKey !== key) : [];
        return dp.completed.length !== before ? dp : undefined;
      });
      dispatchCooldowns.delete(key);
    } catch {}
    // Cooldown bypass for resumed items — clear in-memory cooldown so they dispatch immediately
    if (item._resumedAt) {
      dispatchCooldowns.delete(key);
      delete item._resumedAt;
      safeWrite(projectWorkItemsPath(project), items);
    }
    if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) { skipped.gated++; continue; }

    let workType = item.type || 'implement';
    if (workType === 'implement' && (item.complexity === 'large' || item.estimated_complexity === 'large')) {
      workType = 'implement:large';
    }
    const agentId = item.agent || resolveAgent(workType, config);
    if (!agentId) { skipped.noAgent++; continue; }

    const isShared = item.branchStrategy === 'shared-branch' && item.featureBranch;
    const branchName = isShared ? item.featureBranch : (item.branch || `work/${item.id}`);
    const vars = {
      ...buildBaseVars(agentId, config, project),
      item_id: item.id,
      item_name: item.title || item.id,
      item_priority: item.priority || 'medium',
      item_description: item.description || '',
      item_complexity: item.complexity || item.estimated_complexity || 'medium',
      task_description: item.title + (item.description ? '\n\n' + item.description : ''),
      task_id: item.id,
      work_type: workType,
      additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
      scope_section: `## Scope: Project — ${project?.name || 'default'}\n\nThis task is scoped to a single project.`,
      branch_name: branchName,
      project_path: root,
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', `${branchName}`),
      commit_message: item.commitMessage || `feat: ${item.title || item.id}`,
      notes_content: '',
    };
    try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}

    // Inject ask-specific variables for the ask playbook
    if (workType === 'ask') {
      vars.question = item.title + (item.description ? '\n\n' + item.description : '');
      vars.task_id = item.id;
      vars.notes_content = '';
      try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}
    }

    // Resolve implicit context references (e.g., "ripley's plan", "the latest plan")
    const resolvedCtx = resolveTaskContext(item, config);
    if (resolvedCtx.additionalContext) {
      vars.additional_context = (vars.additional_context || '') + resolvedCtx.additionalContext;
      vars.task_description = vars.task_description + resolvedCtx.additionalContext;
    }

    const playbookName = selectPlaybook(workType, item);
    if (playbookName === 'work-item' && workType === 'review') {
      log('info', `Work item ${item.id} is type "review" but has no PR — using work-item playbook`);
    }
    const prompt = item.prompt || renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars) || item.description;
    if (!prompt) {
      log('warn', `No playbook rendered for ${item.id} (type: ${workType}, playbook: ${playbookName}) — skipping`);
      continue;
    }

    // Mark item as dispatched BEFORE adding to newWork (prevents race on next tick)
    item.status = 'dispatched';
    item.dispatched_at = ts();
    item.dispatched_to = agentId;
    syncPrdItemStatus(item.id, 'dispatched', item.sourcePlan);

    newWork.push({
      type: workType,
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${project?.name || 'project'}] ${item.title || item.description?.slice(0, 80) || item.id}`,
      prompt,
      meta: { dispatchKey: key, source: 'work-item', branch: branchName, branchStrategy: item.branchStrategy || 'parallel', useExistingBranch: !!(item.branchStrategy === 'shared-branch' && item.featureBranch), item, project: { name: project?.name, localPath: project?.localPath } }
    });

    setCooldown(key);
  }

  // Write back updated statuses (always, since we mark items dispatched before newWork check)
  if (newWork.length > 0) {
    const workItemsPath = projectWorkItemsPath(project);
    safeWrite(workItemsPath, items);
  }

  if (needsWrite) safeWrite(projectWorkItemsPath(project), items);

  const skipTotal = skipped.gated + skipped.noAgent;
  if (skipTotal > 0) {
    log('debug', `Work item discovery (${project?.name}): skipped ${skipTotal} items (${skipped.gated} gated, ${skipped.noAgent} no agent)`);
  }

  return newWork;
}

/**
 * Build the multi-project context section for central work items.
 * Inserted into the playbook via {{scope_section}}.
 */
function buildProjectContext(projects, assignedProject, isFanOut, agentName, agentRole) {
  const projectList = projects.map(p => {
    let line = `### ${p.name}\n`;
    line += `- **Path:** ${p.localPath}\n`;
    line += `- **Repo:** ${p.adoOrg}/${p.adoProject}/${p.repoName} (ID: ${p.repositoryId || 'unknown'}, host: ${getRepoHostLabel(p)})\n`;
    if (p.description) line += `- **What it is:** ${p.description}\n`;
    return line;
  }).join('\n');

  let section = '';

  if (isFanOut && assignedProject) {
    section += `## Scope: Fan-out (parallel multi-agent)\n\n`;
    section += `You are assigned to **${assignedProject.name}**. Other agents are handling the other projects.\n\n`;
  } else {
    section += `## Scope: Multi-project (you decide where to work)\n\n`;
    section += `Determine which project(s) this task applies to. It may span multiple repos.\n`;
    section += `If multi-repo, work on each sequentially (worktree + PR per repo).\n`;
    section += `Note cross-repo dependencies in PR descriptions.\n\n`;
  }

  section += `## Available Projects\n\n${projectList}`;
  return section;
}

/**
 * Detect merged PRs containing spec documents and create implement work items.
 * "Specs" = any markdown doc merged into the repo that describes work to build.
 * Writes work items as a side-effect; discoverFromWorkItems() picks them up next tick.
 *
 * Config key: workSources.specs
 * Only processes docs with frontmatter `type: spec` — regular docs are ignored.
 */
function materializeSpecsAsWorkItems(config, project) {
  const src = project?.workSources?.specs;
  if (!src?.enabled) return;

  const root = projectRoot(project);
  const filePatterns = src.filePatterns || ['docs/**/*.md'];
  const trackerPath = path.join(projectStateDir(project), 'spec-tracker.json');
  const tracker = safeJson(trackerPath) || { processedPrs: {} };

  const prs = getPrs(project);
  const mergedPrs = prs.filter(pr =>
    (pr.status === 'merged' || pr.status === 'completed') &&
    !tracker.processedPrs[pr.id]
  );

  if (mergedPrs.length === 0) return;

  const sinceDate = src.lookbackDays ? `${src.lookbackDays} days ago` : '7 days ago';
  let recentSpecs = [];
  for (const pattern of filePatterns) {
    try {
      const result = exec(
        `git log --diff-filter=AM --name-only --pretty=format:"COMMIT:%H|%s" --since="${sinceDate}" -- "${pattern}"`,
        { cwd: root, encoding: 'utf8', timeout: 10000 }
      ).trim();
      if (!result) continue;

      let currentCommit = null;
      for (const line of result.split('\n')) {
        if (line.startsWith('COMMIT:')) {
          const [hash, ...msgParts] = line.replace('COMMIT:', '').split('|');
          currentCommit = { hash: hash.trim(), message: msgParts.join('|').trim() };
        } else if (line.trim() && currentCommit) {
          recentSpecs.push({ file: line.trim(), ...currentCommit });
        }
      }
    } catch {}
  }

  if (recentSpecs.length === 0) return;

  const wiPath = projectWorkItemsPath(project);
  const existingItems = safeJson(wiPath) || [];
  let created = 0;

  for (const pr of mergedPrs) {
    const prBranch = (pr.branch || '').toLowerCase();
    const matchedSpecs = recentSpecs.filter(doc => {
      const msg = doc.message.toLowerCase();
      // Match any doc whose commit message references this PR's branch
      return prBranch && msg.includes(prBranch.split('/').pop());
    });

    if (matchedSpecs.length === 0) {
      tracker.processedPrs[pr.id] = { processedAt: ts(), matched: false };
      continue;
    }

    for (const doc of matchedSpecs) {
      if (existingItems.some(i => i.sourceSpec === doc.file)) continue;

      const info = extractSpecInfo(doc.file, root);
      if (!info) continue;

      const newId = 'SP-' + shared.uid();

      existingItems.push({
        id: newId,
        type: 'implement',
        title: `Implement: ${info.title}`,
        description: `Implementation work from merged spec.\n\n**Spec:** \`${doc.file}\`\n**Source PR:** ${pr.id} — ${pr.title || ''}\n**PR URL:** ${pr.url || 'N/A'}\n\n## Summary\n\n${info.summary}\n\nRead the full spec at \`${doc.file}\` before starting.`,
        priority: info.priority,
        status: 'queued',
        created: ts(),
        createdBy: 'engine:spec-discovery',
        sourceSpec: doc.file,
        sourcePr: pr.id
      });
      created++;
      log('info', `Spec discovery: created ${newId} "${info.title}" from PR ${pr.id} in ${project.name}`);
    }

    tracker.processedPrs[pr.id] = { processedAt: ts(), matched: true, specs: matchedSpecs.map(d => d.file) };
  }

  if (created > 0) {
    safeWrite(wiPath, existingItems);
  }
  safeWrite(trackerPath, tracker);
}

/**
 * Extract title, summary, and priority from a spec markdown file.
 * Returns null if the file doesn't have `type: spec` in its frontmatter.
 */
function extractSpecInfo(filePath, projectRoot_) {
  const fullPath = path.resolve(projectRoot_, filePath);
  const content = safeRead(fullPath);
  if (!content) return null;

  // Require frontmatter with type: spec
  const fmBlock = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmBlock) return null;
  const frontmatter = fmBlock[1];
  if (!/type:\s*spec/i.test(frontmatter)) return null;

  let title = '';
  const fmMatch = content.match(/^---\n[\s\S]*?title:\s*(.+)\n[\s\S]*?---/);
  const h1Match = content.match(/^#\s+(.+)$/m);
  title = fmMatch?.[1]?.trim() || h1Match?.[1]?.trim() || path.basename(filePath, '.md');

  let summary = '';
  const summaryMatch = content.match(/##\s*Summary\n\n([\s\S]*?)(?:\n##|\n---|$)/);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  } else {
    const lines = content.split('\n');
    let pastTitle = false;
    for (const line of lines) {
      if (line.startsWith('# ')) { pastTitle = true; continue; }
      if (pastTitle && line.trim() && !line.startsWith('#') && !line.startsWith('---')) {
        summary = line.trim();
        break;
      }
    }
  }

  const priorityMatch = content.match(/priority:\s*(high|medium|low|critical)/i);
  const priority = priorityMatch?.[1]?.toLowerCase() || 'medium';

  return { title, summary: summary.slice(0, 1500), priority };
}

/**
 * Scan central ~/.squad/work-items.json for project-agnostic tasks.
 * Uses the shared work-item.md playbook with multi-project context injected.
 */
function discoverCentralWorkItems(config) {
  const centralPath = path.join(SQUAD_DIR, 'work-items.json');
  const items = safeJson(centralPath) || [];
  const projects = getProjects(config);
  const newWork = [];

  for (const item of items) {
    if (item.status !== 'queued' && item.status !== 'pending') continue;

    const key = `central-work-${item.id}`;
    if (isAlreadyDispatched(key) || isOnCooldown(key, 0)) continue;

    const workType = item.type || 'implement';
    const isFanOut = item.scope === 'fan-out';

    if (isFanOut) {
      // ─── Fan-out: dispatch to ALL idle agents ───────────────────────
      const idleAgents = Object.entries(config.agents)
        .filter(([id]) => {
          const s = getAgentStatus(id);
          return ['idle', 'done', 'completed'].includes(s.status);
        })
        .map(([id, info]) => ({ id, ...info }));

      if (idleAgents.length === 0) {
        log('info', `Fan-out: all agents busy for ${item.id}, will retry next tick`);
        continue; // Item stays pending, retried next tick
      }

      const assignments = idleAgents.map((agent, i) => ({
        agent,
        assignedProject: projects.length > 0 ? projects[i % projects.length] : null
      }));

      for (const { agent, assignedProject } of assignments) {
        const fanKey = `${key}-${agent.id}`;
        if (isAlreadyDispatched(fanKey)) continue;

        const ap = assignedProject || projects[0];
        const vars = {
          ...buildBaseVars(agent.id, config, ap),
          item_id: item.id,
          item_name: item.title || item.id,
          item_priority: item.priority || 'medium',
          item_description: item.description || '',
          work_type: workType,
          additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
          scope_section: buildProjectContext(projects, assignedProject, true, agent.name, agent.role),
          project_path: ap?.localPath || '',
        };

        if (workType === 'ask') {
          vars.question = item.title + (item.description ? '\n\n' + item.description : '');
          vars.task_id = item.id;
          vars.notes_content = '';
          try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}
        }

        const resolvedCtx = resolveTaskContext(item, config);
        if (resolvedCtx.additionalContext) {
          vars.additional_context = (vars.additional_context || '') + resolvedCtx.additionalContext;
        }

        const playbookName = selectPlaybook(workType, item);
        const prompt = renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars);
        if (!prompt) {
          log('warn', `Fan-out: playbook '${playbookName}' failed to render for ${item.id} → ${agent.id}, skipping`);
          continue;
        }

        newWork.push({
          type: workType,
          agent: agent.id,
          agentName: agent.name,
          agentRole: agent.role,
          task: `[fan-out] ${item.title} → ${agent.name}${assignedProject ? ' → ' + assignedProject.name : ''}`,
          prompt,
          meta: {
            dispatchKey: fanKey, source: 'central-work-item-fanout', item, parentKey: key,
            deadline: item.timeout ? Date.now() + item.timeout : Date.now() + (config.engine?.fanOutTimeout || config.engine?.agentTimeout || DEFAULTS.agentTimeout)
          }
        });
      }

      item.status = 'dispatched';
      item.dispatched_at = ts();
      item.dispatched_to = idleAgents.map(a => a.id).join(', ');
      item.scope = 'fan-out';
      item.fanOutAgents = idleAgents.map(a => a.id);
      setCooldown(key);
      log('info', `Fan-out: ${item.id} dispatched to ${idleAgents.length} agents: ${idleAgents.map(a => a.name).join(', ')}`);

    } else {
      // ─── Normal: single agent dispatch ──────────────────────────────
      const agentId = item.agent || resolveAgent(workType, config);
      if (!agentId) continue;

      const agentName = config.agents[agentId]?.name || agentId;
      const agentRole = config.agents[agentId]?.role || 'Agent';
      const firstProject = projects[0];

      const vars = {
        ...buildBaseVars(agentId, config, firstProject),
        item_id: item.id,
        item_name: item.title || item.id,
        item_priority: item.priority || 'medium',
        item_description: item.description || '',
        item_complexity: item.complexity || item.estimated_complexity || 'medium',
        task_description: item.title + (item.description ? '\n\n' + item.description : ''),
        task_id: item.id,
        work_type: workType,
        additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
        scope_section: buildProjectContext(projects, null, false, agentName, agentRole),
        project_path: firstProject?.localPath || '',
        notes_content: '',
      };
      try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}

      // Inject plan-specific variables for the plan playbook
      if (workType === 'plan') {
        // Ensure plans directory exists before agent tries to write
        if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
        const planFileName = `plan-${item.id.toLowerCase()}-${dateStamp()}.md`;
        vars.plan_content = item.title + (item.description ? '\n\n' + item.description : '');
        vars.plan_title = item.title;
        vars.plan_file = planFileName;
        vars.task_description = item.title;
        vars.notes_content = '';
        try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}
        // Track expected plan filename in meta for chainPlanToPrd
        item._planFileName = planFileName;
      }

      // Inject plan-to-prd variables — read the plan file content for the playbook
      if (workType === 'plan-to-prd' && item.planFile) {
        if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
        if (!fs.existsSync(PRD_DIR)) fs.mkdirSync(PRD_DIR, { recursive: true });
        const planPath = path.join(PLANS_DIR, item.planFile);
        try {
          vars.plan_content = fs.readFileSync(planPath, 'utf8');
        } catch (e) {
          log('warn', `plan-to-prd: could not read plan file ${item.planFile} for ${item.id}: ${e.message}`);
          vars.plan_content = item.description || '';
        }
        vars.plan_summary = (item.title || item.planFile).substring(0, 80);
        vars.plan_file = item.planFile || '';
        vars.project_name_lower = (firstProject?.name || 'project').toLowerCase();
        vars.branch_strategy_hint = item.branchStrategy
          ? `The user requested **${item.branchStrategy}** strategy. Use this unless the analysis strongly suggests otherwise.`
          : 'Choose the best strategy based on your analysis of item dependencies.';
      }

      // Inject ask-specific variables for the ask playbook
      if (workType === 'ask') {
        vars.question = item.title + (item.description ? '\n\n' + item.description : '');
        vars.task_id = item.id;
        vars.notes_content = '';
        try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}
      }

      // Resolve implicit context references
      const resolvedCtx = resolveTaskContext(item, config);
      if (resolvedCtx.additionalContext) {
        vars.additional_context = (vars.additional_context || '') + resolvedCtx.additionalContext;
        vars.task_description = vars.task_description + resolvedCtx.additionalContext;
      }

      const playbookName = selectPlaybook(workType, item);
      const prompt = renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars);
      if (!prompt) {
        log('warn', `Dispatch: playbook '${playbookName}' failed to render for ${item.id}, resetting to pending`);
        item.status = 'pending';
        continue;
      }

      newWork.push({
        type: workType,
        agent: agentId,
        agentName,
        agentRole,
        task: item.title || item.description?.slice(0, 80) || item.id,
        prompt,
        meta: { dispatchKey: key, source: 'central-work-item', item, planFileName: item.planFile || item._planFileName || null }
      });

      item.status = 'dispatched';
      item.dispatched_at = ts();
      item.dispatched_to = agentId;
      setCooldown(key);
    }
  }

  if (newWork.length > 0) safeWrite(centralPath, items);
  return newWork;
}


/**
 * Run all work discovery sources and queue new items
 * Priority: fix (0) > ask (1) > review (1) > implement (2) > work-items (3) > central (4)
 */
function discoverWork(config) {
  resetClaimedAgents(); // Reset per-tick agent claims for fair distribution
  const projects = getProjects(config);
  let allFixes = [], allReviews = [], allWorkItems = [];

  // Side-effect passes: materialize plans and design docs into work-items.json
  // These write to project work queues — picked up by discoverFromWorkItems below.
  materializePlansAsWorkItems(config);

  for (const project of projects) {
    const root = project.localPath ? path.resolve(project.localPath) : null;
    if (!root || !fs.existsSync(root)) continue;

    // Source 1: Pull Requests → fixes, reviews, build-test
    const prWork = discoverFromPrs(config, project);
    allFixes.push(...prWork.filter(w => w.type === 'fix'));
    allReviews.push(...prWork.filter(w => w.type === 'review'));
    allWorkItems.push(...prWork.filter(w => w.type === 'test'));

    // Side-effect: specs → work items (picked up below)
    materializeSpecsAsWorkItems(config, project);

    // Source 3: Work items (includes auto-filed from plans, design docs, build failures)
    allWorkItems.push(...discoverFromWorkItems(config, project));
  }

  // Source 2: Squad-level PRD → implements (multi-project, called once outside project loop)
  // PRD items now flow through plans/*.json → materializePlansAsWorkItems → discoverFromWorkItems

  // Central work items (project-agnostic — agent decides where to work)
  const centralWork = discoverCentralWorkItems(config);

  // Gate reviews and fixes: do not dispatch until all implement items are complete
  const hasIncompleteImplements = projects.some(project => {
    const items = safeJson(projectWorkItemsPath(project)) || [];
    return items.some(i => ['queued', 'pending', 'dispatched'].includes(i.status) && (i.type || '').startsWith('implement'));
  });
  if (hasIncompleteImplements) {
    if (allReviews.length > 0) {
      log('info', `Gating ${allReviews.length} reviews — implement items still in progress`);
      allReviews = [];
    }
    if (allFixes.length > 0) {
      log('info', `Gating ${allFixes.length} fixes — implement items still in progress`);
      allFixes = [];
    }
  }

  const allWork = [...allFixes, ...allReviews, ...allWorkItems, ...centralWork];

  for (const item of allWork) {
    addToDispatch(item);
  }

  if (allWork.length > 0) {
    log('info', `Discovered ${allWork.length} new work items: ${allFixes.length} fixes, ${allReviews.length} reviews, ${allWorkItems.length} work-items`);
  }

  return allWork.length;
}

// ─── Main Tick ──────────────────────────────────────────────────────────────

let tickCount = 0;

let tickRunning = false;

async function tick() {
  if (tickRunning) return; // prevent overlapping ticks
  tickRunning = true;
  try {
    await tickInner();
  } catch (e) {
    log('error', `Tick error: ${e.message}`);
  } finally {
    tickRunning = false;
  }
}

async function tickInner() {
  const control = getControl();
  if (control.state !== 'running') {
    log('info', `Engine state is "${control.state}" — exiting process`);
    process.exit(0);
  }

  // Write heartbeat so dashboard can detect stale engine
  try { safeWrite(CONTROL_PATH, { ...control, heartbeat: Date.now() }); } catch {}

  const config = getConfig();
  tickCount++;

  // 1. Check for timed-out agents and idle threshold
  checkTimeouts(config);
  checkIdleThreshold(config);

  // 2. Consolidate inbox
  consolidateInbox(config);

  // 2.5. Periodic cleanup + MCP sync (every 10 ticks = ~5 minutes)
  if (tickCount % 10 === 0) {
    runCleanup(config);
  }

  // 2.6. Poll PR status: build, review, merge (every 6 ticks = ~3 minutes)
  // Awaited so PR state is consistent before discoverWork reads it
  if (tickCount % 6 === 0) {
    try { await pollPrStatus(config); } catch (err) { log('warn', `ADO PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    try { await ghPollPrStatus(config); } catch (err) { log('warn', `GitHub PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    // Sync PR status back to PRD items (missing → done when active PR exists)
    try { syncPrdFromPrs(config); } catch (err) { log('warn', `PRD sync error: ${err?.message || err}`); }
  }

  // 2.7. Poll PR threads for human comments (every 12 ticks = ~6 minutes)
  if (tickCount % 12 === 0) {
    try { await pollPrHumanComments(config); } catch (err) { log('warn', `ADO PR comment poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    try { await ghPollPrHumanComments(config); } catch (err) { log('warn', `GitHub PR comment poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    try { await reconcilePrs(config); } catch (err) { log('warn', `ADO PR reconciliation error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    try { await ghReconcilePrs(config); } catch (err) { log('warn', `GitHub PR reconciliation error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
  }

  // 2.9. Stalled dispatch detection — auto-retry failed items blocking the graph (every 20 ticks = ~10 min)
  if (tickCount % 20 === 0) {
    try {
      const projects = getProjects(config);
      const dispatch = getDispatch();
      const activeCount = (dispatch.active || []).length;
      const allAgentsIdle = Object.keys(config.agents || {}).every(id => {
        const s = getAgentStatus(id);
        return !s || s.status === 'idle';
      });

      if (allAgentsIdle && activeCount === 0) {
        // Check for failed items blocking pending items
        for (const project of projects) {
          try {
            const wiPath = projectWorkItemsPath(project);
            const items = safeJson(wiPath) || [];
            let changed = false;
            const failedIds = new Set(items.filter(w => w.status === 'failed').map(w => w.id));
            const pendingWithBlockedDeps = items.filter(w =>
              w.status === 'pending' && (w.depends_on || []).some(d => failedIds.has(d))
            );

            if (pendingWithBlockedDeps.length > 0) {
              // Auto-retry failed items that are blocking others (transient errors)
              for (const item of items) {
                if (item.status !== 'failed') continue;
                // Only retry if something depends on this item
                const isBlocking = items.some(w => w.status === 'pending' && (w.depends_on || []).includes(item.id));
                if (!isBlocking) continue;

                log('info', `Stall recovery: auto-retrying ${item.id} (blocking ${pendingWithBlockedDeps.filter(w => (w.depends_on || []).includes(item.id)).length} items)`);
                item.status = 'pending';
                item._retryCount = 0;
                delete item.failReason;
                delete item.failedAt;
                delete item.dispatched_at;
                delete item.dispatched_to;
                changed = true;

                // Clear completed dispatch entries so isAlreadyDispatched doesn't block re-dispatch
                try {
                    const key = `work-${project.name}-${item.id}`;
                    mutateDispatch((dp) => {
                      const before = dp.completed.length;
                      dp.completed = dp.completed.filter(d => d.meta?.dispatchKey !== key);
                      if (dp.completed.length !== before) return dp;
                    });
                  } catch {}

                // Clear cooldown so item isn't blocked by exponential backoff
                try {
                  const key = `work-${project.name}-${item.id}`;
                  if (dispatchCooldowns.has(key)) {
                    dispatchCooldowns.delete(key);
                    saveCooldowns();
                  }
                } catch {}
              }
            }

            // Un-fail dependent items that were cascade-failed
            if (changed) {
              const retriedIds = new Set(items.filter(w => w.status === 'pending' && w._retryCount === 0).map(w => w.id));
              for (const dep of items) {
                if (dep.status === 'failed' && dep.failReason === 'Dependency failed — cannot proceed') {
                  const blockers = (dep.depends_on || []).filter(d => retriedIds.has(d));
                  if (blockers.length > 0) {
                    log('info', `Stall recovery: un-failing ${dep.id} (blocker ${blockers.join(',')} retried)`);
                    dep.status = 'pending';
                    dep._retryCount = 0;
                    delete dep.failReason;
                    delete dep.failedAt;
                    delete dep.dispatched_at;
                    delete dep.dispatched_to;
                    // Clear dispatch entries for this dependent too
                    try {
                      const key = `work-${project.name}-${dep.id}`;
                      mutateDispatch((dp) => {
                        dp.completed = dp.completed.filter(d => d.meta?.dispatchKey !== key);
                      });
                    } catch {}
                  }
                }
              }
            }

            if (changed) safeWrite(wiPath, items);
          } catch {}
        }
      }
    } catch (err) { log('warn', `Stall detection error: ${err?.message || err}`); }
  }

  // 3. Discover new work from sources
  discoverWork(config);

  // 4. Update snapshot
  updateSnapshot(config);

  // 5. Process pending dispatches — auto-spawn agents
  const dispatch = getDispatch();
  const activeCount = (dispatch.active || []).length;
  const maxConcurrent = config.engine?.maxConcurrent || 3;

  if (activeCount >= maxConcurrent) {
    log('info', `At max concurrency (${activeCount}/${maxConcurrent}) — skipping dispatch`);
    return;
  }

  const slotsAvailable = maxConcurrent - activeCount;

  // Priority dispatch: fixes > reviews > plan-to-prd > implement > verify > other
  const typePriority = { 'implement:large': 0, implement: 0, fix: 1, ask: 1, review: 2, test: 3, verify: 3, plan: 4, 'plan-to-prd': 4 };
  const itemPriority = { high: 0, medium: 1, low: 2 };
  dispatch.pending.sort((a, b) => {
    const ta = typePriority[a.type] ?? 5, tb = typePriority[b.type] ?? 5;
    if (ta !== tb) return ta - tb;
    const pa = itemPriority[a.meta?.item?.priority] ?? 1, pb = itemPriority[b.meta?.item?.priority] ?? 1;
    return pa - pb;
  });
  mutateDispatch((dp) => {
    dp.pending = dispatch.pending;
    dp.active = dispatch.active || dp.active;
  });

  // Only dispatch to agents that aren't already busy (one task per agent at a time).
  // Build set of agents currently active.
  const busyAgents = new Set((dispatch.active || []).map(d => d.agent));
  const toDispatch = [];
  for (const item of dispatch.pending) {
    if (toDispatch.length >= slotsAvailable) break;
    if (busyAgents.has(item.agent)) continue; // agent already has an active task
    toDispatch.push(item);
    busyAgents.add(item.agent); // mark busy for this dispatch round too
  }

  // Dispatch items — spawnAgent moves each from pending→active on disk.
  // We use the already-loaded item objects; spawnAgent handles the state transition.
  const dispatched = new Set();
  for (const item of toDispatch) {
    if (!dispatched.has(item.id)) {
      spawnAgent(item, config);
      dispatched.add(item.id);
    }
  }
}

// ─── Exports (for engine/cli.js and other modules) ──────────────────────────

module.exports = {
  // Paths
  SQUAD_DIR, ENGINE_DIR, AGENTS_DIR, PLAYBOOKS_DIR, PLANS_DIR, PRD_DIR,
  CONTROL_PATH, DISPATCH_PATH, LOG_PATH, INBOX_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  IDENTITY_DIR, CONFIG_PATH, ROUTING_PATH, NOTES_PATH, SKILLS_DIR,

  // Utilities
  ts, logTs, dateStamp, log,
  safeJson, safeRead, safeWrite,

  // State readers/writers
  getConfig, getControl, getDispatch, getRouting, getNotes,
  getAgentStatus, getAgentCharter, getInboxFiles, getPrs,
  validateConfig,

  // Dispatch management
  addToDispatch, completeDispatch,
  activeProcesses, get engineRestartGraceUntil() { return engineRestartGraceUntil; },
  set engineRestartGraceUntil(v) { engineRestartGraceUntil = v; },

  // Agent lifecycle
  spawnAgent, resolveAgent,

  // Discovery
  discoverWork, discoverFromPrs, discoverFromWorkItems,
  materializePlansAsWorkItems,

  // Shared helpers (used by lifecycle.js and tests)
  reconcileItemsWithPrs, writeInboxAlert, detectDependencyCycles,

  // Playbooks
  renderPlaybook,

  // Post-completion / lifecycle
  updateWorkItemStatus, runCleanup, handlePostMerge,

  // Cooldowns
  loadCooldowns,

  // Tick
  tick,
};

// ─── Entrypoint ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const { handleCommand } = require('./engine/cli');
  const [cmd, ...args] = process.argv.slice(2);
  handleCommand(cmd, args);
}
