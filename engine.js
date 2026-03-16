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
const { spawn, execSync } = require('child_process');
const shared = require('./engine/shared');

// ─── Paths ──────────────────────────────────────────────────────────────────

const SQUAD_DIR = __dirname;
const CONFIG_PATH = path.join(SQUAD_DIR, 'config.json');
const ROUTING_PATH = path.join(SQUAD_DIR, 'routing.md');
const NOTES_PATH = path.join(SQUAD_DIR, 'notes.md');
const AGENTS_DIR = path.join(SQUAD_DIR, 'agents');
const PLAYBOOKS_DIR = path.join(SQUAD_DIR, 'playbooks');
const ENGINE_DIR = path.join(SQUAD_DIR, 'engine');
const CONTROL_PATH = path.join(ENGINE_DIR, 'control.json');
const DISPATCH_PATH = path.join(ENGINE_DIR, 'dispatch.json');
const LOG_PATH = path.join(ENGINE_DIR, 'log.json');
const INBOX_DIR = path.join(SQUAD_DIR, 'notes', 'inbox');
const KNOWLEDGE_DIR = path.join(SQUAD_DIR, 'knowledge');
const ARCHIVE_DIR = path.join(SQUAD_DIR, 'notes', 'archive');
const PLANS_DIR = path.join(SQUAD_DIR, 'plans');
const IDENTITY_DIR = path.join(SQUAD_DIR, 'identity');

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
  const projects = config.projects || [];
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

const { getProjects, projectRoot, projectWorkItemsPath, projectPrPath, nextWorkItemId, getAdoOrgBase, sanitizeBranch, parseSkillFrontmatter, safeReadDir } = shared;

// ─── Utilities ──────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

const safeJson = shared.safeJson;
const safeRead = (p) => shared.safeRead(p) || '';  // engine.js historically returns '' not null
const safeWrite = shared.safeWrite;

function log(level, msg, meta = {}) {
  const entry = { timestamp: ts(), level, message: msg, ...meta };
  console.log(`[${logTs()}] [${level}] ${msg}`);

  let logData = safeJson(LOG_PATH) || [];
  if (!Array.isArray(logData)) logData = logData.entries || [];
  logData.push(entry);
  if (logData.length > 500) logData.splice(0, logData.length - 500);
  safeWrite(LOG_PATH, logData);
}

// ─── State Readers ──────────────────────────────────────────────────────────

function getConfig() {
  return safeJson(CONFIG_PATH) || {};
}

function getControl() {
  return safeJson(CONTROL_PATH) || { state: 'stopped', pid: null };
}

function getDispatch() {
  return safeJson(DISPATCH_PATH) || { pending: [], active: [], completed: [] };
}

function getRouting() {
  return safeRead(ROUTING_PATH);
}

function getNotes() {
  return safeRead(NOTES_PATH);
}

function getAgentStatus(agentId) {
  return safeJson(path.join(AGENTS_DIR, agentId, 'status.json')) || {
    status: 'idle', task: null, started_at: null, completed_at: null
  };
}

function setAgentStatus(agentId, status) {
  // Sanitize: truncate task field and reject stream-json fragments
  if (status.task && typeof status.task === 'string') {
    if (status.task.includes('"session_id"') || status.task.includes('"is_error"') || status.task.includes('"uuid"')) {
      // Corrupted — extract just the beginning before the JSON garbage
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

function getInboxFiles() {
  try { return fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.md')); } catch { return []; }
}

// ─── Skills ──────────────────────────────────────────────────────────────────

const SKILLS_DIR = path.join(SQUAD_DIR, 'skills');
function collectSkillFiles() {
  const skillFiles = [];
  // Squad-level skills (shared across all agents)
  for (const dir of [SKILLS_DIR]) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md');
      for (const f of files) skillFiles.push({ file: f, dir, scope: 'squad' });
    } catch {}
  }
  // Project-level skills (<project>/.claude/skills/)
  const config = getConfig();
  for (const project of getProjects(config)) {
    const projectSkillsDir = path.resolve(project.localPath, '.claude', 'skills');
    try {
      const files = fs.readdirSync(projectSkillsDir).filter(f => f.endsWith('.md') && f !== 'README.md');
      for (const f of files) skillFiles.push({ file: f, dir: projectSkillsDir, scope: 'project', projectName: project.name });
    } catch {}
  }
  return skillFiles;
}

// parseSkillFrontmatter imported from shared.js

function getSkillIndex() {
  try {
    const skillFiles = collectSkillFiles();
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

function getKnowledgeBaseIndex() {
  try {
    const kbDir = path.join(SQUAD_DIR, 'knowledge');
    if (!fs.existsSync(kbDir)) return '';
    const categories = ['architecture', 'conventions', 'project-notes', 'build-reports', 'reviews'];
    let entries = [];
    for (const cat of categories) {
      const catDir = path.join(kbDir, cat);
      const files = safeReadDir(catDir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const content = safeRead(path.join(catDir, f)) || '';
        const titleMatch = content.match(/^#\s+(.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : f.replace(/\.md$/, '');
        entries.push({ cat, file: f, title });
      }
    }
    if (entries.length === 0) return '';
    let index = '## Knowledge Base Reference\n\n';
    index += 'Deep-reference docs from past work. Read the file if you need detail.\n\n';
    for (const e of entries) {
      index += `- \`knowledge/${e.cat}/${e.file}\` — ${e.title}\n`;
    }
    return index + '\n';
  } catch { return ''; }
}

function getPrs(project) {
  if (project) {
    const prPath = project.workSources?.pullRequests?.path;
    if (prPath) return safeJson(path.resolve(projectRoot(project), prPath)) || [];
    return safeJson(path.join(projectRoot(project), '.squad', 'pull-requests.json')) || [];
  }
  // Fallback: try all projects
  const config = getConfig();
  const projects = getProjects(config);
  const all = [];
  for (const p of projects) all.push(...getPrs(p));
  return all;
}

// ─── Routing Parser ─────────────────────────────────────────────────────────

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
  const routes = parseRoutingTable();
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

  // Last resort: allow already-claimed agents (better than not dispatching)
  if (preferred && agents[preferred] && isAgentIdle(preferred)) return preferred;
  if (fallback && agents[fallback] && isAgentIdle(fallback)) return fallback;
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
            const content = fs.readFileSync(planPath, 'utf8');
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
              const content = fs.readFileSync(planPath, 'utf8');
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
          const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
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
        const content = fs.readFileSync(planPath, 'utf8');
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
  content += `- Set \`scope: squad\` for cross-project skills (engine writes to \`${SKILLS_DIR}/\` automatically)\n`;
  content += `- Set \`scope: project\` + \`project: <name>\` for repo-specific skills (engine queues a PR)\n`;
  content += `- Only output a skill block if you genuinely discovered something reusable — don't force it\n`;

  // Inject project-level variables from config
  const config = getConfig();
  const project = config.project || {};
  // Find the specific project being dispatched (match by repo_id or repo_name from vars)
  const dispatchProject = (vars.repo_id && config.projects?.find(p => p.repositoryId === vars.repo_id))
    || (vars.repo_name && config.projects?.find(p => p.repoName === vars.repo_name))
    || project;
  const projectVars = {
    project_name: project.name || 'Unknown Project',
    ado_org: project.adoOrg || 'Unknown',
    ado_project: project.adoProject || 'Unknown',
    repo_name: project.repoName || 'Unknown',
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
  project = project || config.project || {};

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
  prompt += `5. Do NOT write to agents/*/status.json — the engine manages agent status automatically\n`;
  prompt += `6. If you discover a repeatable workflow, save it as a skill:\n`;
  prompt += `   - Squad-wide: \`${SKILLS_DIR}/<name>.md\` (no PR needed)\n`;
  prompt += `   - Project-specific: \`<project>/.claude/skills/<name>.md\` (requires a PR since it modifies the repo)\n\n`;

  return prompt;
}

// Bulk context: history, notes, conventions, skills — prepended to user/task prompt.
// This is the content that grows over time and would bloat the system prompt.
function buildAgentContext(agentId, config, project) {
  project = project || config.project || {};
  const notes = getNotes();
  let context = '';

  // Agent history (past tasks)
  const history = safeRead(path.join(AGENTS_DIR, agentId, 'history.md'));
  if (history && history.trim() !== '# Agent History') {
    context += `## Your Recent History\n\n${history}\n\n`;
  }

  // Project conventions (from CLAUDE.md)
  if (project.localPath) {
    const claudeMd = safeRead(path.join(project.localPath, 'CLAUDE.md'));
    if (claudeMd && claudeMd.trim()) {
      const truncated = claudeMd.length > 8192 ? claudeMd.slice(0, 8192) + '\n\n...(truncated)' : claudeMd;
      context += `## Project Conventions (from CLAUDE.md)\n\n${truncated}\n\n`;
    }
  }

  // Skills
  const skillIndex = getSkillIndex();
  if (skillIndex) {
    context += skillIndex + '\n';
  }

  // Knowledge base index (paths + titles only — agents can Read if needed)
  const kbIndex = getKnowledgeBaseIndex();
  if (kbIndex) {
    context += kbIndex + '\n';
  }

  // Team notes (the big one — can be 50KB)
  if (notes) {
    context += `## Team Notes (MUST READ)\n\n${notes}\n\n`;
  }

  return context;
}

// sanitizeBranch imported from shared.js

// ─── Lifecycle (extracted to engine/lifecycle.js) ────────────────────────────

const { runPostCompletionHooks, updateWorkItemStatus, handlePostMerge, checkPlanCompletion, chainPlanToPrd,
  syncPrsFromOutput, updatePrAfterReview, updatePrAfterFix, checkForLearnings, extractSkillsFromOutput,
  updateAgentHistory, updateMetrics, createReviewFeedbackForAuthor, parseAgentOutput } = require('./engine/lifecycle');

// ─── Agent Spawner ──────────────────────────────────────────────────────────

const activeProcesses = new Map(); // dispatchId → { proc, agentId, startedAt }
let engineRestartGraceUntil = 0; // timestamp — suppress orphan detection until this time

function spawnAgent(dispatchItem, config) {
  const { id, agent: agentId, prompt: taskPrompt, type, meta } = dispatchItem;
  const claudeConfig = config.claude || {};
  const engineConfig = config.engine || {};
  const startedAt = ts();

  // Resolve project context for this dispatch
  const project = meta?.project || config.project || {};
  const rootDir = project.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');

  // Determine working directory
  let cwd = rootDir;
  let worktreePath = null;
  let branchName = meta?.branch ? sanitizeBranch(meta.branch) : null;

  if (branchName) {
    worktreePath = path.resolve(rootDir, engineConfig.worktreeRoot || '../worktrees', branchName);
    try {
      if (!fs.existsSync(worktreePath)) {
        const isSharedBranch = meta?.branchStrategy === 'shared-branch' || meta?.useExistingBranch;
        if (isSharedBranch) {
          // Shared branch: fetch and checkout existing branch (no -b)
          log('info', `Creating worktree for shared branch: ${worktreePath} on ${branchName}`);
          try { execSync(`git fetch origin "${branchName}"`, { cwd: rootDir, stdio: 'pipe' }); } catch {}
          execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: rootDir, stdio: 'pipe' });
        } else {
          // Parallel: create new branch (reuse if exists from a previous attempt)
          log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
          try {
            execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${sanitizeBranch(project.mainBranch || 'main')}`, {
              cwd: rootDir, stdio: 'pipe'
            });
          } catch {
            // Branch already exists — use it without -b
            try { execSync(`git fetch origin "${branchName}"`, { cwd: rootDir, stdio: 'pipe' }); } catch {}
            execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: rootDir, stdio: 'pipe' });
            log('info', `Reusing existing branch: ${branchName}`);
          }
        }
      } else if (meta?.branchStrategy === 'shared-branch') {
        // Worktree exists — pull latest from prior plan item
        log('info', `Pulling latest on shared branch ${branchName}`);
        try { execSync(`git pull origin "${branchName}"`, { cwd: worktreePath, stdio: 'pipe' }); } catch {}
      }
      cwd = worktreePath;
    } catch (err) {
      log('error', `Failed to create worktree for ${branchName}: ${err.message}`);
      // Fall back to main directory for non-writing tasks
      if (type === 'review' || type === 'analyze' || type === 'plan-to-prd' || type === 'plan') {
        cwd = rootDir;
      } else {
        completeDispatch(id, 'error', 'Worktree creation failed');
        return null;
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
  const promptPath = path.join(ENGINE_DIR, `prompt-${id}.md`);
  safeWrite(promptPath, fullTaskPrompt);

  const sysPromptPath = path.join(ENGINE_DIR, `sysprompt-${id}.md`);
  safeWrite(sysPromptPath, systemPrompt);

  // Build claude CLI args
  const args = [
    '--output-format', claudeConfig.outputFormat || 'stream-json',
    '--max-turns', String(engineConfig.maxTurns || 100),
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

  // Update agent status
  setAgentStatus(agentId, {
    status: 'working',
    task: dispatchItem.task,
    dispatch_id: id,
    type: type,
    branch: branchName,
    started_at: startedAt
  });

  // Spawn the claude process
  // Unset CLAUDECODE to allow nested sessions (engine runs inside Claude Code)
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE') || key.startsWith('CLAUDECODE_')) {
      delete childEnv[key];
    }
  }

  // Spawn via wrapper script — node directly (no bash intermediary)
  // spawn-agent.js handles CLAUDECODE env cleanup and claude binary resolution
  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const spawnArgs = [spawnScript, promptPath, sysPromptPath, ...args];

  const proc = spawn(process.execPath, spawnArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true
  });

  const MAX_OUTPUT = 1024 * 1024; // 1MB
  let stdout = '';
  let stderr = '';

  // Live output file — written as data arrives so dashboard can tail it
  const liveOutputPath = path.join(AGENTS_DIR, agentId, 'live-output.log');
  safeWrite(liveOutputPath, `# Live output for ${agentId} — ${id}\n# Started: ${startedAt}\n# Task: ${dispatchItem.task}\n\n`);

  proc.stdout.on('data', (data) => {
    const chunk = data.toString();
    if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
    try { fs.appendFileSync(liveOutputPath, chunk); } catch {}
  });

  proc.stderr.on('data', (data) => {
    const chunk = data.toString();
    if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
    try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch {}
  });

  proc.on('close', (code) => {
    log('info', `Agent ${agentId} (${id}) exited with code ${code}`);
    activeProcesses.delete(id);

    // Save output — per-dispatch archive + latest symlink
    const outputContent = `# Output for dispatch ${id}\n# Exit code: ${code}\n# Completed: ${ts()}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}`;
    const archivePath = path.join(AGENTS_DIR, agentId, `output-${id}.log`);
    const latestPath = path.join(AGENTS_DIR, agentId, 'output.log');
    safeWrite(archivePath, outputContent);
    safeWrite(latestPath, outputContent); // overwrite latest for dashboard compat

    // Parse output and run all post-completion hooks
    const { resultSummary } = runPostCompletionHooks(dispatchItem, agentId, code, stdout, config);

    // Update agent status
    setAgentStatus(agentId, {
      status: code === 0 ? 'done' : 'error',
      task: dispatchItem.task,
      dispatch_id: id,
      type: type,
      branch: branchName,
      exit_code: code,
      started_at: startedAt,
      completed_at: ts(),
      resultSummary: resultSummary || undefined,
    });

    // Move from active to completed in dispatch
    completeDispatch(id, code === 0 ? 'success' : 'error');

    // Cleanup temp files (including PID file now that dispatch is complete)
    try { fs.unlinkSync(sysPromptPath); } catch {}
    try { fs.unlinkSync(promptPath); } catch {}
    try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch {}

    log('info', `Agent ${agentId} completed. Output saved to ${archivePath}`);
  });

  proc.on('error', (err) => {
    log('error', `Failed to spawn agent ${agentId}: ${err.message}`);
    activeProcesses.delete(id);
    completeDispatch(id, 'error', `Spawn error: ${err.message}`);
    setAgentStatus(agentId, {
      status: 'error',
      task: dispatchItem.task,
      error: err.message,
      completed_at: ts()
    });
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

  // Move dispatch item to active
  const dispatch = getDispatch();
  const idx = dispatch.pending.findIndex(d => d.id === id);
  if (idx >= 0) {
    const item = dispatch.pending.splice(idx, 1)[0];
    item.started_at = startedAt;
    dispatch.active = dispatch.active || [];
    dispatch.active.push(item);
    safeWrite(DISPATCH_PATH, dispatch);
  }

  return proc;
}

// ─── Dispatch Management ────────────────────────────────────────────────────

function addToDispatch(item) {
  const dispatch = getDispatch();
  item.id = item.id || `${item.agent}-${item.type}-${Date.now()}`;
  item.created_at = ts();
  dispatch.pending.push(item);
  safeWrite(DISPATCH_PATH, dispatch);
  log('info', `Queued dispatch: ${item.id} (${item.type} → ${item.agent})`);
  return item.id;
}

function completeDispatch(id, result = 'success', reason = '') {
  const dispatch = getDispatch();

  // Check active list first
  let idx = (dispatch.active || []).findIndex(d => d.id === id);
  let item;
  if (idx >= 0) {
    item = dispatch.active.splice(idx, 1)[0];
  } else {
    // Also check pending list (e.g., worktree failure before spawn)
    idx = dispatch.pending.findIndex(d => d.id === id);
    if (idx >= 0) {
      item = dispatch.pending.splice(idx, 1)[0];
    }
  }

  if (item) {
    item.completed_at = ts();
    item.result = result;
    if (reason) item.reason = reason;
    // Strip prompt from completed items (saves ~10KB per item, reduces file lock contention)
    delete item.prompt;
    dispatch.completed = dispatch.completed || [];
    dispatch.completed.push(item);
    // Keep last 100 completed
    if (dispatch.completed.length > 100) {
      dispatch.completed.splice(0, dispatch.completed.length - 100);
    }
    safeWrite(DISPATCH_PATH, dispatch);
    log('info', `Completed dispatch: ${id} (${result}${reason ? ': ' + reason : ''})`);

    // Update source work item status on failure + apply backoff cooldown
    if (result === 'error') {
      if (item.meta?.dispatchKey) setCooldownFailure(item.meta.dispatchKey);
      if (item.meta?.item?.id) updateWorkItemStatus(item.meta, 'failed', reason);
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
  const projectName = item.project;
  const projects = getProjects(config);
  const project = projectName
    ? projects.find(p => p.name?.toLowerCase() === projectName?.toLowerCase())
    : projects[0];
  if (!project) return true;
  const wiPath = projectWorkItemsPath(project);
  const workItems = safeJson(wiPath) || [];
  for (const depId of deps) {
    const depItem = workItems.find(w => w.sourcePlan === sourcePlan && w.planItemId === depId);
    if (!depItem) {
      log('warn', `Dependency ${depId} not found for ${item.id} (plan: ${sourcePlan}) — treating as unmet`);
      return false;
    }
    if (depItem.status === 'failed' && (depItem._retryCount || 0) >= 3) return 'failed'; // Only cascade after retries exhausted
    if (depItem.status !== 'done') return false; // Pending, dispatched, or retrying — wait
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


// ─── Inbox Consolidation (extracted to engine/consolidation.js) ──────────────

const { consolidateInbox } = require('./engine/consolidation');
const { pollPrStatus, pollPrHumanComments } = require('./engine/ado');

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
  const timeout = config.engine?.agentTimeout || 18000000; // 5h default
  const heartbeatTimeout = config.engine?.heartbeatTimeout || 300000; // 5min — no output = dead

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
    let completedViaOutput = false;
    try {
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
        setAgentStatus(item.agent, {
          status: 'done',
          task: item.task || '',
          dispatch_id: item.id,
          completed_at: ts()
        });

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
    if (item.meta?.item?.id) updateWorkItemStatus(item.meta, 'failed', reason);
    setAgentStatus(item.agent, {
      status: 'idle',
      task: null,
      started_at: null,
      completed_at: ts()
    });
  }

  // Reset "done" agents to "idle" after 1 minute (visual cleanup)
  // Also catch stranded "working" agents with no active dispatch (e.g. after engine restart)
  for (const [agentId] of Object.entries(config.agents || {})) {
    const status = getAgentStatus(agentId);
    if ((status.status === 'done' || status.status === 'error') && status.completed_at) {
      const elapsed = Date.now() - new Date(status.completed_at).getTime();
      if (elapsed > 60000) {
        setAgentStatus(agentId, { status: 'idle', task: null, started_at: null, completed_at: status.completed_at });
      }
    }
    // Reconcile: if status says "working" but no active dispatch exists, reset to idle
    if (status.status === 'working') {
      const hasActiveDispatch = (dispatch.active || []).some(d => d.agent === agentId);
      if (!hasActiveDispatch) {
        log('warn', `Reconcile: ${agentId} status is "working" but no active dispatch found — resetting to idle`);
        setAgentStatus(agentId, { status: 'idle', task: null, started_at: null, completed_at: ts() });
      }
    }
  }

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
      const possibleKeys = [`central-work-${item.id}`, `work-${item.id}`];
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
    const engineFiles = fs.readdirSync(ENGINE_DIR);
    for (const f of engineFiles) {
      if (f.startsWith('prompt-') || f.startsWith('sysprompt-') || f.startsWith('tmp-sysprompt-')) {
        const fp = path.join(ENGINE_DIR, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < oneHourAgo) {
            fs.unlinkSync(fp);
            cleaned.tempFiles++;
          }
        } catch {}
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

    // List worktrees
    try {
      const dirs = fs.readdirSync(worktreeRoot);
      for (const dir of dirs) {
        const wtPath = path.join(worktreeRoot, dir);
        if (!fs.statSync(wtPath).isDirectory()) continue;

        // Check if this worktree's branch is merged
        let shouldClean = false;

        // Match by directory name to branch (worktrees are named after branches)
        for (const branch of mergedBranches) {
          const branchSlug = branch.replace(/[^a-zA-Z0-9._\-\/]/g, '-');
          if (dir === branchSlug || dir === branch || branch.endsWith(dir)) {
            shouldClean = true;
            break;
          }
        }

        // Also clean worktrees older than 24 hours with no active dispatch referencing them
        if (!shouldClean) {
          try {
            const stat = fs.statSync(wtPath);
            const ageMs = Date.now() - stat.mtimeMs;
            if (ageMs > 86400000) { // 24 hours
              const dispatch = getDispatch();
              const isReferenced = [...dispatch.pending, ...(dispatch.active || [])].some(d =>
                d.meta?.branch && (dir.includes(d.meta.branch) || d.meta.branch.includes(dir))
              );
              if (!isReferenced) shouldClean = true;
            }
          } catch {}
        }

        // Skip worktrees for active shared-branch plans
        if (shouldClean) {
          try {
            const planDir = path.join(SQUAD_DIR, 'plans');
            if (fs.existsSync(planDir)) {
              for (const pf of fs.readdirSync(planDir).filter(f => f.endsWith('.json'))) {
                const plan = safeJson(path.join(planDir, pf));
                if (plan?.branch_strategy === 'shared-branch' && plan?.feature_branch && plan?.status !== 'completed') {
                  const planBranch = sanitizeBranch(plan.feature_branch);
                  if (dir === planBranch || dir.includes(planBranch) || planBranch.includes(dir)) {
                    shouldClean = false;
                    if (verbose) console.log(`  Skipping worktree ${dir}: active shared-branch plan`);
                    break;
                  }
                }
              }
            }
          } catch {}
        }

        if (shouldClean) {
          try {
            execSync(`git worktree remove "${wtPath}" --force`, { cwd: root, stdio: 'pipe' });
            cleaned.worktrees++;
            if (verbose) console.log(`  Removed worktree: ${wtPath}`);
          } catch (e) {
            if (verbose) console.log(`  Failed to remove worktree ${wtPath}: ${e.message}`);
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

    // If no active dispatches but active processes exist in the Map, clean the Map
    if ((dispatch.active || []).length === 0 && activeProcesses.size > 0) {
      for (const [id, info] of activeProcesses.entries()) {
        try { info.proc.kill('SIGTERM'); } catch {}
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
        const projItems = safeJson(path.join(project.localPath, '.squad', 'work-items.json')) || [];
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
    if (changed) safeWrite(DISPATCH_PATH, dispatch);
  } catch {}

  if (cleaned.tempFiles + cleaned.liveOutputs + cleaned.worktrees + cleaned.zombies + (cleaned.files || 0) + cleaned.orphanedDispatches > 0) {
    log('info', `Cleanup: ${cleaned.tempFiles} temp, ${cleaned.liveOutputs} live outputs, ${cleaned.worktrees} worktrees, ${cleaned.zombies} zombies, ${cleaned.files || 0} archives, ${cleaned.orphanedDispatches} orphaned dispatches`);
  }

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

let _cooldownWritePending = false;
function saveCooldowns() {
  if (_cooldownWritePending) return;
  _cooldownWritePending = true;
  setTimeout(() => {
    // Prune expired entries (>24h) before saving
    const now = Date.now();
    for (const [k, v] of dispatchCooldowns) {
      if (now - v.timestamp > 24 * 60 * 60 * 1000) dispatchCooldowns.delete(k);
    }
    const obj = Object.fromEntries(dispatchCooldowns);
    safeWrite(COOLDOWN_PATH, obj);
    _cooldownWritePending = false;
  }, 1000); // debounce — write at most once per second
}

function isOnCooldown(key, cooldownMs) {
  const entry = dispatchCooldowns.get(key);
  if (!entry) return false;
  const backoff = Math.min(Math.pow(2, entry.failures || 0), 8);
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
    log('warn', `${key} has failed ${failures} times — cooldown is now ${Math.min(Math.pow(2, failures), 8)}x`);
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
function materializePlansAsWorkItems(config) {
  if (!fs.existsSync(PLANS_DIR)) return;

  // Enforce: PRDs must be .json — auto-rename .md files that contain valid PRD JSON
  try {
    const mdFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    for (const mf of mdFiles) {
      try {
        const content = fs.readFileSync(path.join(PLANS_DIR, mf), 'utf8').trim();
        // Strip markdown code fences if agent wrapped JSON in them
        const stripped = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
        const parsed = JSON.parse(stripped);
        if (parsed.missing_features) {
          const jsonName = mf.replace(/\.md$/, '.json');
          fs.writeFileSync(path.join(PLANS_DIR, jsonName), JSON.stringify(parsed, null, 2));
          fs.unlinkSync(path.join(PLANS_DIR, mf));
          log('info', `Plan enforcement: renamed ${mf} → ${jsonName} (PRDs must be .json)`);
        }
      } catch {} // Not JSON — it's a proper plan .md, leave it
    }
  } catch {}

  let planFiles;
  try { planFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json')); } catch { return; }

  for (const file of planFiles) {
    const plan = safeJson(path.join(PLANS_DIR, file));
    if (!plan?.missing_features) continue;

    // Human approval gate: plans start as 'awaiting-approval' and must be approved before work begins
    // Plans without a status (legacy) or with status 'approved' are allowed through
    const planStatus = plan.status || (plan.requires_approval ? 'awaiting-approval' : null);
    if (planStatus === 'awaiting-approval' || planStatus === 'rejected' || planStatus === 'revision-requested') {
      continue; // Skip — waiting for human approval or revision
    }

    const projectName = plan.project || file.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
    const project = getProjects(config).find(p => p.name?.toLowerCase() === projectName.toLowerCase());
    if (!project) continue;

    const wiPath = projectWorkItemsPath(project);
    const existingItems = safeJson(wiPath) || [];

    let created = 0;
    const statusFilter = ['missing', 'planned'];
    const items = plan.missing_features.filter(f => statusFilter.includes(f.status));

    for (const item of items) {
      // Skip if already materialized
      if (existingItems.some(w => w.sourcePlan === file && w.sourcePlanItem === item.id)) continue;

      const id = nextWorkItemId(existingItems, 'PL-W');

      const complexity = item.estimated_complexity || 'medium';
      const criteria = (item.acceptance_criteria || []).map(c => `- ${c}`).join('\n');

      existingItems.push({
        id,
        title: `Implement: ${item.name}`,
        type: complexity === 'large' ? 'implement:large' : 'implement',
        priority: item.priority || 'medium',
        description: `${item.description || ''}\n\n**Plan:** ${file}\n**Plan Item:** ${item.id}\n**Complexity:** ${complexity}${criteria ? '\n\n**Acceptance Criteria:**\n' + criteria : ''}`,
        status: 'pending',
        created: ts(),
        createdBy: 'engine:plan-discovery',
        sourcePlan: file,
        sourcePlanItem: item.id,
        planItemId: item.id,
        depends_on: item.depends_on || [],
        branchStrategy: plan.branch_strategy || 'parallel',
        featureBranch: plan.feature_branch || null,
        project: plan.project || null,
      });
      created++;
    }

    if (created > 0) {
      safeWrite(wiPath, existingItems);
      log('info', `Plan discovery: created ${created} work item(s) from ${file} → ${project.name}`);

      // Pre-create shared feature branch if branch_strategy is shared-branch
      if (plan.branch_strategy === 'shared-branch' && plan.feature_branch) {
        try {
          const root = path.resolve(project.localPath);
          const mainBranch = project.mainBranch || 'main';
          const branch = sanitizeBranch(plan.feature_branch);
          // Create branch from main (idempotent — ignores if exists)
          execSync(`git branch "${branch}" "${mainBranch}" 2>/dev/null || true`, { cwd: root, stdio: 'pipe' });
          execSync(`git push -u origin "${branch}" 2>/dev/null || true`, { cwd: root, stdio: 'pipe' });
          log('info', `Shared branch pre-created: ${branch} for plan ${file}`);
        } catch (err) {
          log('warn', `Failed to pre-create shared branch for ${file}: ${err.message}`);
        }
      }

      // Cycle detection for plan items
      const planDerivedItems = plan.missing_features.filter(f => f.depends_on && f.depends_on.length > 0);
      if (planDerivedItems.length > 0) {
        const cycles = detectDependencyCycles(plan.missing_features);
        if (cycles.length > 0) {
          log('error', `Dependency cycle detected in plan ${file}: ${cycles.join(', ')} — marking cycling items as failed`);
          for (const wi of existingItems) {
            if (wi.sourcePlan === file && cycles.includes(wi.planItemId)) {
              wi.status = 'failed';
              wi.failReason = `Dependency cycle detected: ${cycles.join(', ')}. Fix deps in plan and retry.`;
            }
          }
          safeWrite(wiPath, existingItems);
        }
      }
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
    repo_id: project?.repositoryId || config.project?.repositoryId || '',
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

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prs = safeJson(path.resolve(root, src.path)) || [];
  const cooldownMs = (src.cooldownMinutes || 30) * 60 * 1000;
  const newWork = [];

  const projMeta = { name: project?.name, localPath: project?.localPath };

  for (const pr of prs) {
    if (pr.status !== 'active') continue;

    const prNumber = (pr.id || '').replace(/^PR-/, '');
    const squadStatus = pr.squadReview?.status;

    // PRs needing review
    const needsReview = !squadStatus || squadStatus === 'waiting';
    if (needsReview) {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('review', config);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'review', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        pr_author: pr.agent || '', pr_url: pr.url || '',
      }, `Review PR ${pr.id}: ${pr.title}`, { dispatchKey: key, source: 'pr', pr, project: projMeta });
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
      const key = `human-fix-${project?.name || 'default'}-${pr.id}-${pr.humanFeedback.lastProcessedCommentDate}`;
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

    // Newly created PRs needing build & test verification
    if (!pr.buildTested) {
      const key = `build-test-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('test', config);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'test', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        pr_author: pr.agent || '', pr_url: pr.url || '',
        project_path: project?.localPath ? path.resolve(project.localPath) : '',
      }, `Build & test PR ${pr.id}: ${pr.title}`, { dispatchKey: key, source: 'pr-build-test', pr, branch: pr.branch, project: projMeta });
      if (item) { pr.buildTested = 'dispatched'; newWork.push(item); setCooldown(key); }
    }
  }

  // Batch-write PR state changes (buildTested flags) once after the loop
  if (newWork.some(w => w.meta?.source === 'pr-build-test')) {
    safeWrite(projectPrPath(project), prs);
  }

  return newWork;
}

/**
 * Scan work-items.json for manually queued tasks
 */
function discoverFromWorkItems(config, project) {
  const src = project?.workSources?.workItems || config.workSources?.workItems;
  if (!src?.enabled) return [];

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const items = safeJson(path.resolve(root, src.path)) || [];
  const cooldownMs = (src.cooldownMinutes || 0) * 60 * 1000;
  const newWork = [];
  const skipped = { gated: 0, noAgent: 0 };

  for (const item of items) {
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
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', branchName),
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
    const workItemsPath = path.resolve(root, src.path);
    safeWrite(workItemsPath, items);
  }

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
  const trackerPath = path.resolve(root, src.statePath || '.squad/spec-tracker.json');
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
      const result = execSync(
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

      const spItems = existingItems.filter(i => i.id?.startsWith('SP'));
      const newId = nextWorkItemId(spItems, 'SP');

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
            deadline: item.timeout ? Date.now() + item.timeout : Date.now() + (config.engine?.fanOutTimeout || config.engine?.agentTimeout || 18000000)
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
        const planPath = path.join(PLANS_DIR, item.planFile);
        try {
          vars.plan_content = fs.readFileSync(planPath, 'utf8');
        } catch (e) {
          log('warn', `plan-to-prd: could not read plan file ${item.planFile} for ${item.id}: ${e.message}`);
          vars.plan_content = item.description || '';
        }
        vars.plan_summary = (item.title || item.planFile).substring(0, 80);
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
  let allFixes = [], allReviews = [], allImplements = [], allWorkItems = [];

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

  const allWork = [...allFixes, ...allReviews, ...allImplements, ...allWorkItems, ...centralWork];

  for (const item of allWork) {
    addToDispatch(item);
  }

  if (allWork.length > 0) {
    log('info', `Discovered ${allWork.length} new work items: ${allFixes.length} fixes, ${allReviews.length} reviews, ${allImplements.length} implements, ${allWorkItems.length} work-items`);
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

  // 2.6. Poll ADO for full PR status: build, review, merge (every 6 ticks = ~3 minutes)
  // Awaited so PR state is consistent before discoverWork reads it
  if (tickCount % 6 === 0) {
    try { await pollPrStatus(config); } catch (e) { log('warn', `PR status poll error: ${e.message}`); }
  }

  // 2.7. Poll PR threads for human @squad comments (every 12 ticks = ~6 minutes)
  if (tickCount % 12 === 0) {
    try { await pollPrHumanComments(config); } catch (e) { log('warn', `PR comment poll error: ${e.message}`); }
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
  const typePriority = { fix: 0, ask: 1, review: 1, test: 2, verify: 2, plan: 3, 'plan-to-prd': 3, 'implement:large': 4, implement: 5 };
  const itemPriority = { high: 0, medium: 1, low: 2 };
  dispatch.pending.sort((a, b) => {
    const ta = typePriority[a.type] ?? 5, tb = typePriority[b.type] ?? 5;
    if (ta !== tb) return ta - tb;
    const pa = itemPriority[a.meta?.item?.priority] ?? 1, pb = itemPriority[b.meta?.item?.priority] ?? 1;
    return pa - pb;
  });
  safeWrite(DISPATCH_PATH, dispatch);

  const toDispatch = dispatch.pending.slice(0, slotsAvailable);

  // Collect IDs to dispatch, then spawn — spawnAgent mutates dispatch.pending
  // so we snapshot the items first and re-read dispatch state is handled per-spawn
  const idsToDispatch = toDispatch.map(item => item.id);
  for (const dispatchId of idsToDispatch) {
    // Re-read dispatch fresh each iteration since spawnAgent modifies it
    const freshDispatch = getDispatch();
    const item = freshDispatch.pending.find(d => d.id === dispatchId);
    if (item) {
      spawnAgent(item, config);
    }
  }
}

// ─── Exports (for engine/cli.js and other modules) ──────────────────────────

module.exports = {
  // Paths
  SQUAD_DIR, ENGINE_DIR, AGENTS_DIR, PLAYBOOKS_DIR, PLANS_DIR,
  CONTROL_PATH, DISPATCH_PATH, LOG_PATH, INBOX_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  IDENTITY_DIR, CONFIG_PATH, ROUTING_PATH, NOTES_PATH, SKILLS_DIR,

  // Utilities
  ts, logTs, dateStamp, log,
  safeJson, safeRead, safeWrite,

  // State readers/writers
  getConfig, getControl, getDispatch, getRouting, getNotes,
  getAgentStatus, setAgentStatus, getAgentCharter, getInboxFiles, getPrs,
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
