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

function getProjects(config) {
  if (config.projects && Array.isArray(config.projects)) {
    return config.projects;
  }
  // Legacy single-project: derive localPath from .squad parent
  const proj = config.project || {};
  if (!proj.localPath) proj.localPath = path.resolve(SQUAD_DIR, '..');
  if (!proj.workSources) proj.workSources = config.workSources || {};
  return [proj];
}

function projectRoot(project) {
  return path.resolve(project.localPath);
}

function projectWorkItemsPath(project) {
  const wiSrc = project.workSources?.workItems;
  if (wiSrc?.path) return path.resolve(projectRoot(project), wiSrc.path);
  return path.join(projectRoot(project), '.squad', 'work-items.json');
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function logTs() { return new Date().toLocaleTimeString(); }
function dateStamp() { return new Date().toISOString().slice(0, 10); }

function safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function safeWrite(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content);
    // Atomic rename — retry on Windows EPERM (file locking)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.renameSync(tmp, p);
        return;
      } catch (e) {
        if (e.code === 'EPERM' && attempt < 4) {
          const delay = 50 * (attempt + 1); // 50, 100, 150, 200ms
          const start = Date.now(); while (Date.now() - start < delay) {}
          continue;
        }
        // Final attempt failed — fall through to direct write
      }
    }
    // All rename attempts failed — direct write as fallback (not atomic but won't lose data)
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(p, content);
  } catch {
    // Even direct write failed — clean up tmp silently
    try { fs.unlinkSync(tmp); } catch {}
  }
}

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

// ─── MCP Server Sync ─────────────────────────────────────────────────────────

const MCP_SERVERS_PATH = path.join(SQUAD_DIR, 'mcp-servers.json');

function syncMcpServers() {
  // Sync MCP servers from ~/.claude.json into squad's mcp-servers.json
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeJsonPath = path.join(home, '.claude.json');

  if (!fs.existsSync(claudeJsonPath)) {
    console.log('  ~/.claude.json not found — skipping MCP sync');
    return false;
  }

  try {
    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const servers = claudeJson.mcpServers;
    if (!servers || Object.keys(servers).length === 0) {
      console.log('  No MCP servers found in ~/.claude.json');
      return false;
    }

    safeWrite(MCP_SERVERS_PATH, { mcpServers: servers });
    const names = Object.keys(servers);
    console.log(`  MCP servers synced (${names.length}): ${names.join(', ')}`);
    log('info', `Synced ${names.length} MCP servers from ~/.claude.json: ${names.join(', ')}`);
    return true;
  } catch (e) {
    console.log(`  MCP sync failed: ${e.message}`);
    return false;
  }
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

function parseSkillFrontmatter(content, filename) {
  let name = filename.replace('.md', '');
  let trigger = '', description = '', project = 'any', author = '', created = '', allowedTools = '';
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    name = m('name') || name;
    trigger = m('trigger');
    description = m('description');
    project = m('project') || 'any';
    author = m('author');
    created = m('created');
    allowedTools = m('allowed-tools');
  }
  return { name, trigger, description, project, author, created, allowedTools };
}

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
  const status = getAgentStatus(agentId);
  return ['idle', 'done', 'completed'].includes(status.status);
}

function resolveAgent(workType, config, authorAgent = null) {
  const routes = parseRoutingTable();
  const route = routes[workType] || routes['implement'];
  const agents = config.agents || {};

  // Resolve _author_ token
  let preferred = route.preferred === '_author_' ? authorAgent : route.preferred;
  let fallback = route.fallback === '_author_' ? authorAgent : route.fallback;

  // Check preferred and fallback first (routing table order)
  if (preferred && agents[preferred] && isAgentIdle(preferred)) return preferred;
  if (fallback && agents[fallback] && isAgentIdle(fallback)) return fallback;

  // Fall back to any idle agent, preferring lower error rates
  const idle = Object.keys(agents)
    .filter(id => id !== preferred && id !== fallback && isAgentIdle(id))
    .sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b));

  return idle[0] || null;
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
  content += `- Conventions to follow\n\n`;
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

function buildSystemPrompt(agentId, config, project) {
  const agent = config.agents[agentId];
  const charter = getAgentCharter(agentId);
  const notes = getNotes();
  project = project || config.project || {};

  let prompt = '';

  // Agent identity
  prompt += `# You are ${agent.name} (${agent.role})\n\n`;
  prompt += `Agent ID: ${agentId}\n`;
  prompt += `Skills: ${(agent.skills || []).join(', ')}\n\n`;

  // Charter (detailed instructions)
  if (charter) {
    prompt += `## Your Charter\n\n${charter}\n\n`;
  }

  // Agent history (past tasks)
  const history = safeRead(path.join(AGENTS_DIR, agentId, 'history.md'));
  if (history && history.trim() !== '# Agent History') {
    prompt += `## Your Recent History\n\n${history}\n\n`;
  }

  // Project context
  prompt += `## Project: ${project.name || 'Unknown Project'}\n\n`;
  prompt += `- Repo: ${project.repoName || 'Unknown'} (${project.adoOrg || 'Unknown'}/${project.adoProject || 'Unknown'})\n`;
  prompt += `- Repo ID: ${project.repositoryId || ''}\n`;
  prompt += `- Repo host: ${getRepoHostLabel(project)}\n`;
  prompt += `- Main branch: ${project.mainBranch || 'main'}\n\n`;

  // Project conventions (from CLAUDE.md)
  if (project.localPath) {
    const claudeMd = safeRead(path.join(project.localPath, 'CLAUDE.md'));
    if (claudeMd && claudeMd.trim()) {
      // Truncate to 4KB to avoid bloating the system prompt
      const truncated = claudeMd.length > 4096 ? claudeMd.slice(0, 4096) + '\n\n...(truncated)' : claudeMd;
      prompt += `## Project Conventions (from CLAUDE.md)\n\n${truncated}\n\n`;
    }
  }

  // Critical rules
  prompt += `## Critical Rules\n\n`;
  prompt += `1. Use git worktrees — NEVER checkout on main working tree\n`;
  prompt += `2. ${getRepoHostToolRule(project)}\n`;
  prompt += `3. Follow the project conventions above (from CLAUDE.md) if present\n`;
  prompt += `4. Write learnings to: ${SQUAD_DIR}/notes/inbox/${agentId}-${dateStamp()}.md\n`;
  prompt += `5. Do NOT write to agents/*/status.json — the engine manages agent status automatically\n`;
  prompt += `6. If you discover a repeatable workflow, save it as a skill:\n`;
  prompt += `   - Squad-wide: \`${SKILLS_DIR}/<name>.md\` (no PR needed)\n`;
  prompt += `   - Project-specific: \`<project>/.claude/skills/<name>.md\` (requires a PR since it modifies the repo)\n\n`;

  // Skills
  const skillIndex = getSkillIndex();
  if (skillIndex) {
    prompt += skillIndex + '\n';
  }

  // Team notes
  if (notes) {
    prompt += `## Team Notes\n\n${notes}\n\n`;
  }

  return prompt;
}

function sanitizeBranch(name) {
  return String(name).replace(/[^a-zA-Z0-9._\-\/]/g, '-').slice(0, 200);
}

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
          // Parallel: create new branch
          log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
          execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${sanitizeBranch(project.mainBranch || 'main')}`, {
            cwd: rootDir, stdio: 'pipe'
          });
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

  // Build the system prompt
  const systemPrompt = buildSystemPrompt(agentId, config, project);

  // Write prompt and system prompt to temp files (avoids shell escaping issues)
  const promptPath = path.join(ENGINE_DIR, `prompt-${id}.md`);
  safeWrite(promptPath, taskPrompt);

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

  // MCP servers — pass config file if it exists
  const mcpConfigPath = claudeConfig.mcpConfig || path.join(SQUAD_DIR, 'mcp-servers.json');
  if (fs.existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

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
    env: childEnv
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

    // Update agent status
    setAgentStatus(agentId, {
      status: code === 0 ? 'done' : 'error',
      task: dispatchItem.task,
      dispatch_id: id,
      type: type,
      branch: branchName,
      exit_code: code,
      started_at: startedAt,
      completed_at: ts()
    });

    // Move from active to completed in dispatch
    completeDispatch(id, code === 0 ? 'success' : 'error');

    // Post-completion: update work item status on success
    if (code === 0 && meta?.item?.id) {
      updateWorkItemStatus(meta, 'done', '');
    }

    // Post-completion: chain plan → plan-to-prd if this was a plan task
    if (code === 0 && type === 'plan' && meta?.item?.chain === 'plan-to-prd') {
      chainPlanToPrd(dispatchItem, meta, config);
    }

    // Post-completion: check shared-branch plan completion
    if (code === 0 && meta?.item?.branchStrategy === 'shared-branch') {
      checkPlanCompletion(meta, config);
    }

    // Post-completion: scan output for PRs and sync to pull-requests.json
    if (code === 0) {
      syncPrsFromOutput(stdout, agentId, meta, config);
    }

    // Post-completion: update PR status if relevant
    if (type === 'review') updatePrAfterReview(agentId, meta?.pr, meta?.project);
    if (type === 'fix') updatePrAfterFix(meta?.pr, meta?.project);

    // Check for learnings
    checkForLearnings(agentId, config.agents[agentId], dispatchItem.task);

    // Extract skills from output
    if (code === 0) {
      extractSkillsFromOutput(stdout, agentId, dispatchItem, config);
    }

    // Update agent history
    updateAgentHistory(agentId, dispatchItem, code === 0 ? 'success' : 'error');

    // Update quality metrics
    updateMetrics(agentId, dispatchItem, code === 0 ? 'success' : 'error');

    // Cleanup temp files
    try { fs.unlinkSync(sysPromptPath); } catch {}
    try { fs.unlinkSync(promptPath); } catch {}

    log('info', `Agent ${agentId} completed. Output saved to ${outputPath}`);
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
  setTimeout(() => {
    const pidFile = promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid');
    try {
      const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
      if (pidStr) {
        log('info', `Agent ${agentId} verified via PID file: ${pidStr}`);
      }
      try { fs.unlinkSync(pidFile); } catch {}
    } catch {
      // No PID file — check if live output exists (spawn-agent.js may have written it)
      if (!fs.existsSync(liveOutputPath) || fs.statSync(liveOutputPath).size <= 200) {
        log('error', `Agent ${agentId} (${id}) — no PID file and no output after 5s. Spawn likely failed.`);
        // Don't mark as error yet — heartbeat will catch it at 5min
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
    if (!depItem || depItem.status !== 'done') return false;
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

// ─── Plan Completion Detection ───────────────────────────────────────────────
function checkPlanCompletion(meta, config) {
  const planFile = meta.item?.sourcePlan;
  if (!planFile) return;
  const plan = safeJson(path.join(PLANS_DIR, planFile));
  if (!plan?.missing_features || plan.branch_strategy !== 'shared-branch') return;
  if (plan.status === 'completed') return;
  const projectName = plan.project;
  const projects = getProjects(config);
  const project = projectName
    ? projects.find(p => p.name?.toLowerCase() === projectName?.toLowerCase()) : projects[0];
  if (!project) return;
  const wiPath = projectWorkItemsPath(project);
  const workItems = safeJson(wiPath) || [];
  const planItems = workItems.filter(w => w.sourcePlan === planFile && w.planItemId !== 'PR');
  if (planItems.length === 0) return;
  if (!planItems.every(w => w.status === 'done')) return;
  log('info', `All ${planItems.length} items in plan ${planFile} completed — creating PR work item`);
  const maxNum = workItems.reduce((max, i) => {
    const m = (i.id || '').match(/(\d+)$/);
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 0);
  const id = 'PL-W' + String(maxNum + 1).padStart(3, '0');
  const featureBranch = plan.feature_branch;
  const mainBranch = project.mainBranch || 'main';
  const itemSummary = planItems.map(w => '- ' + w.planItemId + ': ' + w.title.replace('Implement: ', '')).join('\n');
  workItems.push({
    id, title: `Create PR for plan: ${plan.plan_summary || planFile}`,
    type: 'implement', priority: 'high',
    description: `All plan items from \`${planFile}\` are complete on branch \`${featureBranch}\`.
Create a pull request and clean up the worktree.

**Branch:** \`${featureBranch}\`
**Target:** \`${mainBranch}\`

## Completed Items
${itemSummary}

## Instructions
1. Rebase onto ${mainBranch} if needed (abort if conflicts — PR as-is is fine)
2. Push: git push origin ${featureBranch} --force-with-lease
3. Create the PR targeting ${mainBranch}
4. Cleanup: git worktree remove ../worktrees/${featureBranch} --force`,
    status: 'pending', created: ts(), createdBy: 'engine:plan-completion',
    sourcePlan: planFile, planItemId: 'PR',
    branch: featureBranch, branchStrategy: 'shared-branch', project: projectName,
  });
  safeWrite(wiPath, workItems);
  plan.status = 'completed'; plan.completedAt = ts();
  safeWrite(path.join(PLANS_DIR, planFile), plan);
}

// ─── Plan → PRD Chaining ─────────────────────────────────────────────────────
// When a 'plan' type task completes, find the plan file it wrote and dispatch
// a plan-to-prd task so Lambert converts it to structured PRD items.
function chainPlanToPrd(dispatchItem, meta, config) {
  const planDir = path.join(SQUAD_DIR, 'plans');
  if (!fs.existsSync(planDir)) {
    log('warn', `Plan chaining: no plans/ directory found after plan task ${dispatchItem.id}`);
    return;
  }

  // Find the plan file — look for recently created .md files in plans/
  const planFiles = fs.readdirSync(planDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(planDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  // Use the most recently modified plan file (the one the plan agent just wrote)
  const planFile = planFiles[0];
  if (!planFile) {
    log('warn', `Plan chaining: no .md plan files found in plans/ after task ${dispatchItem.id}`);
    return;
  }

  const planPath = path.join(planDir, planFile.name);
  let planContent;
  try { planContent = fs.readFileSync(planPath, 'utf8'); } catch (e) {
    log('error', `Plan chaining: failed to read plan file ${planFile.name}: ${e.message}`);
    return;
  }

  // Resolve target project
  const projectName = meta?.item?.project || meta?.project?.name;
  const projects = getProjects(config);
  const targetProject = projectName
    ? projects.find(p => p.name === projectName) || projects[0]
    : projects[0];

  if (!targetProject) {
    log('error', 'Plan chaining: no target project available');
    return;
  }

  // Resolve agent for plan-to-prd (typically Lambert)
  const agentId = resolveAgent('plan-to-prd', config);
  if (!agentId) {
    // No agent available now — create a pending work item so engine picks it up on next tick
    log('info', `Plan chaining: no agent available now, queuing plan-to-prd for next tick`);
    const wiPath = path.join(SQUAD_DIR, 'work-items.json');
    let items = [];
    try { items = JSON.parse(fs.readFileSync(wiPath, 'utf8')); } catch {}
    const maxNum = items.reduce((max, i) => {
      const m = (i.id || '').match(/(\d+)$/);
      return m ? Math.max(max, parseInt(m[1])) : max;
    }, 0);
    items.push({
      id: 'W' + String(maxNum + 1).padStart(3, '0'),
      title: `Convert plan to PRD: ${meta?.item?.title || planFile.name}`,
      type: 'plan-to-prd',
      priority: meta?.item?.priority || 'high',
      description: `Plan file: plans/${planFile.name}\nChained from plan task ${dispatchItem.id}`,
      status: 'pending',
      created: ts(),
      createdBy: 'engine:chain',
      project: targetProject.name,
      planFile: planFile.name,
    });
    safeWrite(wiPath, items);
    return;
  }

  // Build plan-to-prd vars and dispatch immediately
  const vars = {
    agent_id: agentId,
    agent_name: config.agents[agentId]?.name || agentId,
    agent_role: config.agents[agentId]?.role || '',
    project_name: targetProject.name || 'Unknown',
    project_path: targetProject.localPath || '',
    main_branch: targetProject.mainBranch || 'main',
    ado_org: targetProject.adoOrg || config.project?.adoOrg || 'Unknown',
    ado_project: targetProject.adoProject || config.project?.adoProject || 'Unknown',
    repo_name: targetProject.repoName || config.project?.repoName || 'Unknown',
    team_root: SQUAD_DIR,
    date: dateStamp(),
    plan_content: planContent,
    plan_summary: (meta?.item?.title || planFile.name).substring(0, 80),
    project_name_lower: (targetProject.name || 'project').toLowerCase(),
    branch_strategy_hint: meta?.item?.branchStrategy
      ? `The user requested **${meta.item.branchStrategy}** strategy. Use this unless the analysis strongly suggests otherwise.`
      : 'Choose the best strategy based on your analysis of item dependencies.',
  };

  if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });

  const prompt = renderPlaybook('plan-to-prd', vars);
  if (!prompt) {
    log('error', 'Plan chaining: could not render plan-to-prd playbook');
    return;
  }

  const id = addToDispatch({
    type: 'plan-to-prd',
    agent: agentId,
    agentName: config.agents[agentId]?.name,
    agentRole: config.agents[agentId]?.role,
    task: `[${targetProject.name}] Convert plan to PRD: ${vars.plan_summary}`,
    prompt,
    meta: {
      source: 'chain',
      chainedFrom: dispatchItem.id,
      project: { name: targetProject.name, localPath: targetProject.localPath },
      planFile: planFile.name,
      planSummary: vars.plan_summary,
    }
  });

  log('info', `Plan chaining: dispatched plan-to-prd ${id} → ${config.agents[agentId]?.name} (chained from ${dispatchItem.id})`);

  // Spawn immediately if engine is running
  const control = getControl();
  if (control.state === 'running') {
    const dispatch = getDispatch();
    const item = dispatch.pending.find(d => d.id === id);
    if (item) {
      spawnAgent(item, config);
      log('info', `Plan chaining: agent spawned immediately for ${id}`);
    }
  }
}

function updateWorkItemStatus(meta, status, reason) {
  const itemId = meta.item?.id;
  if (!itemId) return;

  // Handle plan-sourced items — update status in the plan JSON file
  if (meta.source === 'plan' && meta.planFile) {
    const planPath = path.join(PLANS_DIR, meta.planFile);
    const plan = safeJson(planPath);
    if (plan?.missing_features) {
      const feature = plan.missing_features.find(f => f.id === itemId);
      if (feature) {
        feature.status = status === 'done' ? 'implemented' : status === 'failed' ? 'failed' : feature.status;
        if (status === 'done') feature.implementedAt = ts();
        if (status === 'failed' && reason) feature.failReason = reason;
        safeWrite(planPath, plan);
        log('info', `Plan item ${itemId} (${meta.planFile}) → ${feature.status}`);
      }
    }
    return;
  }

  // Determine which work-items file to update
  let wiPath;
  if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
    wiPath = path.join(SQUAD_DIR, 'work-items.json');
  } else if (meta.source === 'work-item' && meta.project?.localPath) {
    const root = path.resolve(meta.project.localPath);
    const config = getConfig();
    const proj = (config.projects || []).find(p => p.name === meta.project.name);
    const wiSrc = proj?.workSources?.workItems || config.workSources?.workItems || {};
    wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
  }
  if (!wiPath) return;

  const items = safeJson(wiPath);
  if (!items || !Array.isArray(items)) return;

  const target = items.find(i => i.id === itemId);
  if (target) {
    // For fan-out items, track per-agent results instead of overwriting the whole status
    if (meta.source === 'central-work-item-fanout') {
      if (!target.agentResults) target.agentResults = {};
      const agentId = meta.dispatchKey?.split('-')[0] || 'unknown';
      // Extract agent name from dispatch key: "central-work-W002-dallas" → "dallas"
      const parts = (meta.dispatchKey || '').split('-');
      const agent = parts[parts.length - 1] || 'unknown';
      target.agentResults[agent] = { status, completedAt: ts(), reason: reason || undefined };

      // Fan-out is "done" if ANY agent succeeded, "failed" only if ALL failed
      const results = Object.values(target.agentResults);
      const anySuccess = results.some(r => r.status === 'done');
      const allDone = target.fanOutAgents ? results.length >= target.fanOutAgents.length : false;

      if (anySuccess) {
        target.status = 'done';
        delete target.failReason;
        delete target.failedAt;
        target.completedAgents = Object.entries(target.agentResults)
          .filter(([, r]) => r.status === 'done')
          .map(([a]) => a);
      } else if (allDone) {
        target.status = 'failed';
        target.failReason = 'All fan-out agents failed';
        target.failedAt = ts();
      }
    } else {
      target.status = status;
      if (status === 'done') {
        // Clean up error fields on success
        delete target.failReason;
        delete target.failedAt;
        target.completedAt = ts();
      } else if (status === 'failed') {
        if (reason) target.failReason = reason;
        target.failedAt = ts();
      }
    }

    safeWrite(wiPath, items);
    log('info', `Work item ${itemId} → ${status}${reason ? ': ' + reason : ''}`);
  }
}

// ─── PR Sync from Output ─────────────────────────────────────────────────────

function syncPrsFromOutput(output, agentId, meta, config) {
  // Scan agent output for PR URLs — ONLY match full ADO PR URLs to avoid false positives
  // Stream-json output contains many numbers that could look like PR IDs, so we
  // only trust the full URL pattern: .../pullrequest/NNNNN
  const prMatches = new Set();
  const urlPattern = /(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+)/g;
  let match;

  // Strategy: only capture PRs the agent CREATED, not referenced.
  // 1. Scan stream-json for mcp__azure-ado__repo_create_pull_request tool results
  // 2. Scan for gh pr create output
  // 3. As fallback, look for "Created PR" / "PR created" patterns in the result text
  try {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"result"')) continue;
        const parsed = JSON.parse(line);

        // Check tool use results for PR creation MCP calls
        const content = parsed.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_result' && block.content) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            if (text.includes('pullRequestId') || text.includes('create_pull_request')) {
              while ((match = urlPattern.exec(text)) !== null) prMatches.add(match[1] || match[2]);
            }
          }
        }

        // Check result text for "created PR" patterns (not just any PR mention)
        if (parsed.type === 'result' && parsed.result) {
          const resultText = parsed.result;
          // Match PR URLs only near creation-indicating words
          const createdPattern = /(?:created|opened|submitted|new PR|PR created)[^\n]*?(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
          while ((match = createdPattern.exec(resultText)) !== null) prMatches.add(match[1] || match[2]);

          // Also match "PR #NNNN" or "PR-NNNN" only when preceded by created/opened
          const createdIdPattern = /(?:created|opened|submitted|new)\s+PR[# -]*(\d{5,})/gi;
          while ((match = createdIdPattern.exec(resultText)) !== null) prMatches.add(match[1]);
        }
      } catch {}
    }
  } catch {}

  // Also scan inbox files — look for "PR:" or "PR created" lines (agent's own summary)
  const today = dateStamp();
  const inboxFiles = getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
  for (const f of inboxFiles) {
    const content = safeRead(path.join(INBOX_DIR, f));
    // Only match PR URLs near "PR:" header lines (agent's structured output)
    const prHeaderPattern = /\*\*PR[:\*]*\*?\s*[#-]*\s*(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
    while ((match = prHeaderPattern.exec(content)) !== null) prMatches.add(match[1] || match[2]);
  }

  if (prMatches.size === 0) return;

  // Determine which project to add PRs to
  const projects = getProjects(config);
  let targetProject = null;
  if (meta?.project?.name) {
    targetProject = projects.find(p => p.name === meta.project.name);
  }
  // Try to detect project from PR URL patterns in output
  if (!targetProject) {
    for (const p of projects) {
      if (p.prUrlBase && output.includes(p.prUrlBase.replace(/pullrequest\/$/, ''))) {
        targetProject = p;
        break;
      }
      if (p.repoName && output.includes(`_git/${p.repoName}`)) {
        targetProject = p;
        break;
      }
    }
  }
  if (!targetProject) targetProject = projects[0];
  if (!targetProject) return;

  const root = path.resolve(targetProject.localPath);
  const prSrc = targetProject.workSources?.pullRequests || {};
  const prPath = path.resolve(root, prSrc.path || '.squad/pull-requests.json');
  const prs = safeJson(prPath) || [];

  const agentName = config.agents?.[agentId]?.name || agentId;
  let added = 0;

  for (const prId of prMatches) {
    const fullId = `PR-${prId}`;
    if (prs.some(p => p.id === fullId || String(p.id).includes(prId))) continue;

    // Extract title from output if possible — reject if it looks like stream-json garbage
    let title = meta?.item?.title || '';
    const titleMatch = output.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
    if (titleMatch) title = titleMatch[1].trim();
    // Reject corrupted titles
    if (title.includes('session_id') || title.includes('is_error') || title.includes('uuid') || title.length > 120) {
      title = meta?.item?.title || '';
    }

    prs.push({
      id: fullId,
      title: (title || `PR created by ${agentName}`).slice(0, 120),
      agent: agentName,
      branch: meta?.branch || '',
      reviewStatus: 'pending',
      status: 'active',
      created: dateStamp(),
      url: targetProject.prUrlBase ? targetProject.prUrlBase + prId : '',
      prdItems: meta?.item?.id ? [meta.item.id] : []
    });
    added++;
  }

  if (added > 0) {
    safeWrite(prPath, prs);
    log('info', `Synced ${added} PR(s) from ${agentName}'s output to ${targetProject.name}/pull-requests.json`);
  }
}

// ─── Post-Completion Hooks ──────────────────────────────────────────────────

function updatePrAfterReview(agentId, pr, project) {
  if (!pr?.id) return;
  const prs = getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  const agentStatus = getAgentStatus(agentId);
  const verdict = agentStatus.verdict || 'reviewed';
  const config = getConfig();
  const reviewerName = config.agents[agentId]?.name || agentId;

  const isChangesRequested = verdict.toLowerCase().includes('request') || verdict.toLowerCase().includes('change');
  const squadVerdict = isChangesRequested ? 'changes-requested' : 'approved';

  // Store squad review separately from ADO review state
  target.squadReview = {
    status: squadVerdict,
    reviewer: reviewerName,
    reviewedAt: ts(),
    note: agentStatus.task || ''
  };

  // Update author metrics
  const authorAgentId = (pr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath) || {};
    if (!metrics[authorAgentId]) metrics[authorAgentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    if (squadVerdict === 'approved') metrics[authorAgentId].prsApproved++;
    else if (squadVerdict === 'changes-requested') metrics[authorAgentId].prsRejected++;
    safeWrite(metricsPath, metrics);
  }

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prPath = project?.workSources?.pullRequests?.path || '.squad/pull-requests.json';
  safeWrite(path.resolve(root, prPath), prs);
  log('info', `Updated ${pr.id} → squad review: ${squadVerdict} by ${reviewerName}`);

  // Create feedback for the PR author so they learn from the review
  createReviewFeedbackForAuthor(agentId, { ...pr, ...target }, config);
}

function updatePrAfterFix(pr, project) {
  if (!pr?.id) return;
  const prs = getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  // Reset squad review so it gets re-reviewed
  target.squadReview = {
    ...target.squadReview,
    status: 'waiting',
    note: 'Fixed, awaiting re-review',
    fixedAt: ts()
  };

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prPath = project?.workSources?.pullRequests?.path || '.squad/pull-requests.json';
  safeWrite(path.resolve(root, prPath), prs);
  log('info', `Updated ${pr.id} → squad review: waiting (fix pushed)`);
}

// ─── ADO Build Status Polling ────────────────────────────────────────────────

let _adoTokenCache = { token: null, expiresAt: 0 };

function getAdoToken() {
  // Cache token for 30 minutes (they typically last 1hr)
  if (_adoTokenCache.token && Date.now() < _adoTokenCache.expiresAt) {
    return _adoTokenCache.token;
  }
  try {
    const token = execSync('azureauth ado token --output token', {
      timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    if (token && token.startsWith('eyJ')) {
      _adoTokenCache = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
      return token;
    }
  } catch (e) {
    log('warn', `Failed to get ADO token: ${e.message}`);
  }
  return null;
}

async function adoFetch(url, token, _retried = false) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  const text = await res.text();
  if (!text || text.trimStart().startsWith('<')) {
    // Auth redirect — token likely expired. Invalidate cache and retry once.
    if (!_retried) {
      _adoTokenCache = { token: null, expiresAt: 0 };
      const freshToken = getAdoToken();
      if (freshToken) {
        log('info', 'ADO token expired mid-session — refreshed and retrying');
        return adoFetch(url, freshToken, true);
      }
    }
    throw new Error(`ADO returned HTML instead of JSON (likely auth redirect) for ${url.split('?')[0]}`);
  }
  return JSON.parse(text);
}

/**
 * Poll ADO for full PR status: build/CI, review votes, and merge/completion state.
 * Replaces the agent-based pr-sync — does everything in direct API calls.
 *
 * Per PR, makes 2 calls:
 *   1. GET pullrequests/{id} → status, mergeStatus, reviewers[].vote
 *   2. GET pullrequests/{id}/statuses → CI pipeline results
 */
async function pollPrStatus(config) {
  const token = getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR status poll — no ADO token available');
    return;
  }

  const projects = getProjects(config);
  let totalUpdated = 0;

  for (const project of projects) {
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === 'active');
    if (activePrs.length === 0) continue;

    let projectUpdated = 0;

    for (const pr of activePrs) {
      const prNum = (pr.id || '').replace('PR-', '');
      if (!prNum) continue;

      try {
        let orgBase;
        if (project.prUrlBase) {
          const m = project.prUrlBase.match(/^(https?:\/\/[^/]+(?:\/DefaultCollection)?)/);
          if (m) orgBase = m[1];
        }
        if (!orgBase) {
          orgBase = project.adoOrg.includes('.')
            ? `https://${project.adoOrg}`
            : `https://dev.azure.com/${project.adoOrg}`;
        }

        const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}`;

        // ── Call 1: PR details (status, mergeStatus, reviewers) ──
        const prData = await adoFetch(`${repoBase}?api-version=7.1`, token);

        // Status: active / completed / abandoned
        let newStatus = pr.status;
        if (prData.status === 'completed') newStatus = 'merged';
        else if (prData.status === 'abandoned') newStatus = 'abandoned';
        else if (prData.status === 'active') newStatus = 'active';

        if (pr.status !== newStatus) {
          log('info', `PR ${pr.id} status: ${pr.status} → ${newStatus}`);
          pr.status = newStatus;
          projectUpdated++;

          // Post-merge / post-close hooks
          if (newStatus === 'merged' || newStatus === 'abandoned') {
            await handlePostMerge(pr, project, config, newStatus);
          }
        }

        // Review status from human reviewers (ADO votes)
        // 10=approved, 5=approved-with-suggestions, 0=no-vote, -5=waiting, -10=rejected
        const reviewers = prData.reviewers || [];
        const votes = reviewers.map(r => r.vote).filter(v => v !== undefined);
        let newReviewStatus = pr.reviewStatus || 'pending';
        if (votes.length > 0) {
          if (votes.some(v => v === -10)) newReviewStatus = 'changes-requested';
          else if (votes.some(v => v >= 5)) newReviewStatus = 'approved';
          else if (votes.some(v => v === -5)) newReviewStatus = 'waiting';
          else newReviewStatus = 'pending';
        }

        if (pr.reviewStatus !== newReviewStatus) {
          log('info', `PR ${pr.id} reviewStatus: ${pr.reviewStatus} → ${newReviewStatus}`);
          pr.reviewStatus = newReviewStatus;
          projectUpdated++;
        }

        // Skip build status poll for non-active PRs
        if (newStatus !== 'active') continue;

        // ── Call 2: CI/build statuses ──
        const statusData = await adoFetch(`${repoBase}/statuses?api-version=7.1`, token);

        // Dedupe: latest status per context (API returns newest first)
        const latest = new Map();
        for (const s of statusData.value || []) {
          const key = (s.context?.genre || '') + '/' + (s.context?.name || '');
          if (!latest.has(key)) latest.set(key, s);
        }

        // Filter to build/CI contexts
        const buildStatuses = [...latest.values()].filter(s => {
          const ctx = ((s.context?.genre || '') + '/' + (s.context?.name || '')).toLowerCase();
          return ctx.includes('codecoverage') || ctx.includes('build') ||
                 ctx.includes('deploy') || ctx.includes('ci/');
        });

        let buildStatus = 'none';
        let buildFailReason = '';

        if (buildStatuses.length > 0) {
          const states = buildStatuses.map(s => s.state).filter(Boolean);
          const hasFailed = states.some(s => s === 'failed' || s === 'error');
          const allDone = states.every(s => s === 'succeeded' || s === 'notApplicable');
          const hasQueued = buildStatuses.some(s => !s.state);

          if (hasFailed) {
            buildStatus = 'failing';
            const failed = buildStatuses.find(s => s.state === 'failed' || s.state === 'error');
            buildFailReason = failed?.description || failed?.context?.name || 'Build failed';
          } else if (allDone && !hasQueued) {
            buildStatus = 'passing';
          } else {
            buildStatus = 'running';
          }
        }

        if (pr.buildStatus !== buildStatus) {
          log('info', `PR ${pr.id} build: ${pr.buildStatus || 'none'} → ${buildStatus}${buildFailReason ? ' (' + buildFailReason + ')' : ''}`);
          pr.buildStatus = buildStatus;
          if (buildFailReason) pr.buildFailReason = buildFailReason;
          else delete pr.buildFailReason;
          projectUpdated++;
        }
      } catch (e) {
        log('warn', `Failed to poll status for ${pr.id}: ${e.message}`);
      }
    }

    if (projectUpdated > 0) {
      const root = path.resolve(project.localPath);
      const prSrc = project.workSources?.pullRequests || {};
      const prPath = path.resolve(root, prSrc.path || '.squad/pull-requests.json');
      safeWrite(prPath, prs);
      totalUpdated += projectUpdated;
    }
  }

  if (totalUpdated > 0) {
    log('info', `PR status poll: updated ${totalUpdated} PR(s)`);
  }
}

// ─── Poll Human Comments on PRs ──────────────────────────────────────────────

async function pollPrHumanComments(config) {
  const token = getAdoToken();
  if (!token) return;

  const projects = getProjects(config);
  let totalUpdated = 0;

  for (const project of projects) {
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === 'active');
    if (activePrs.length === 0) continue;

    let projectUpdated = 0;

    for (const pr of activePrs) {
      const prNum = (pr.id || '').replace('PR-', '');
      if (!prNum) continue;

      try {
        let orgBase;
        if (project.prUrlBase) {
          const m = project.prUrlBase.match(/^(https?:\/\/[^/]+(?:\/DefaultCollection)?)/);
          if (m) orgBase = m[1];
        }
        if (!orgBase) {
          orgBase = project.adoOrg.includes('.')
            ? `https://${project.adoOrg}`
            : `https://dev.azure.com/${project.adoOrg}`;
        }

        const threadsUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}/threads?api-version=7.1`;
        const threadsData = await adoFetch(threadsUrl, token);
        const threads = threadsData.value || [];

        // Collect human comments newer than our last-processed timestamp
        const cutoff = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
        const allHumanComments = [];

        for (const thread of threads) {
          for (const comment of (thread.comments || [])) {
            if (!comment.content) continue;
            if (comment.commentType === 'system') continue;
            // Skip agent-posted comments (signature pattern from playbooks)
            if (/\bSquad\s*\(/i.test(comment.content)) continue;
            // Only new comments
            if (comment.publishedDate && comment.publishedDate > cutoff) {
              allHumanComments.push({
                threadId: thread.id,
                commentId: comment.id,
                author: comment.author?.displayName || 'Human',
                authorId: comment.author?.uniqueName || '',
                content: comment.content,
                date: comment.publishedDate,
                hasSquadTag: /@squad\b/i.test(comment.content)
              });
            }
          }
        }

        // If only one unique human is commenting, all their comments are actionable.
        // If multiple humans, require @squad to avoid triggering on casual discussion.
        const uniqueHumans = new Set(allHumanComments.map(c => c.authorId || c.author));
        const soloReviewer = uniqueHumans.size <= 1;
        const newHumanComments = soloReviewer
          ? allHumanComments
          : allHumanComments.filter(c => c.hasSquadTag);

        if (newHumanComments.length === 0) continue;

        // Sort by date, concatenate feedback
        newHumanComments.sort((a, b) => a.date.localeCompare(b.date));
        const feedbackContent = newHumanComments
          .map(c => `**${c.author}** (${c.date}):\n${c.content.replace(/@squad\s*/gi, '').trim()}`)
          .join('\n\n---\n\n');
        const latestDate = newHumanComments[newHumanComments.length - 1].date;

        pr.humanFeedback = {
          lastProcessedCommentDate: latestDate,
          pendingFix: true,
          feedbackContent
        };

        log('info', `PR ${pr.id}: found ${newHumanComments.length} new human comment(s)${soloReviewer ? '' : ' (via @squad)'}`);
        projectUpdated++;
      } catch (e) {
        log('warn', `Failed to poll comments for ${pr.id}: ${e.message}`);
      }
    }

    if (projectUpdated > 0) {
      const root = path.resolve(project.localPath);
      const prSrc = project.workSources?.pullRequests || {};
      const prPath = path.resolve(root, prSrc.path || '.squad/pull-requests.json');
      safeWrite(prPath, prs);
      totalUpdated += projectUpdated;
    }
  }

  if (totalUpdated > 0) {
    log('info', `PR comment poll: found human feedback on ${totalUpdated} PR(s)`);
  }
}

// ─── Post-Merge / Post-Close Hooks ───────────────────────────────────────────

async function handlePostMerge(pr, project, config, newStatus) {
  const prNum = (pr.id || '').replace('PR-', '');

  // 1. Worktree cleanup
  if (pr.branch) {
    const root = path.resolve(project.localPath);
    const wtRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    const wtPath = path.join(wtRoot, pr.branch);
    const btPath = path.join(wtRoot, `bt-${prNum}`); // build-and-test worktree
    for (const p of [wtPath, btPath]) {
      if (fs.existsSync(p)) {
        try {
          execSync(`git worktree remove "${p}" --force`, { cwd: root, stdio: 'pipe', timeout: 15000 });
          log('info', `Cleaned up worktree: ${p}`);
        } catch (e) { log('warn', `Failed to remove worktree ${p}: ${e.message}`); }
      }
    }
  }

  // Only run remaining hooks for merged PRs (not abandoned)
  if (newStatus !== 'merged') return;

  // 2. Update PRD item status to 'implemented' (squad-level PRD)
  if (pr.prdItems?.length > 0) {
    const prdPath = path.join(SQUAD_DIR, 'prd.json');
    const prd = safeJson(prdPath);
    if (prd?.missing_features) {
      let updated = 0;
      for (const itemId of pr.prdItems) {
        const feature = prd.missing_features.find(f => f.id === itemId);
        if (feature && feature.status !== 'implemented') {
          feature.status = 'implemented';
          updated++;
        }
      }
      if (updated > 0) {
        safeWrite(prdPath, prd);
        log('info', `Post-merge: marked ${updated} PRD item(s) as implemented for ${pr.id}`);
      }
    }
  }

  // 3. Update agent metrics
  const agentId = (pr.agent || '').toLowerCase();
  if (agentId && config.agents?.[agentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath) || {};
    if (!metrics[agentId]) metrics[agentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, prsMerged:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    metrics[agentId].prsMerged = (metrics[agentId].prsMerged || 0) + 1;
    safeWrite(metricsPath, metrics);
  }

  // 4. Teams notification
  const teamsUrl = process.env.TEAMS_PLAN_FLOW_URL;
  if (teamsUrl) {
    try {
      await fetch(teamsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `PR ${pr.id} merged: ${pr.title} (${project.name}) by ${pr.agent || 'unknown'}` })
      });
    } catch (e) { log('warn', `Teams post-merge notify failed: ${e.message}`); }
  }

  log('info', `Post-merge hooks completed for ${pr.id}`);
}

function checkForLearnings(agentId, agentInfo, taskDesc) {
  const today = dateStamp();
  const inboxFiles = getInboxFiles();
  const agentFiles = inboxFiles.filter(f => f.includes(agentId) && f.includes(today));

  if (agentFiles.length > 0) {
    log('info', `${agentInfo?.name || agentId} wrote ${agentFiles.length} finding(s) to inbox`);
    return;
  }

  log('warn', `${agentInfo?.name || agentId} didn't write learnings — no follow-up queued`);
}

/**
 * Extract skill candidates from agent output.
 * Agents are prompted to output a ```skill block when they discover a reusable workflow.
 * The engine parses it out and writes the skill file automatically.
 */
function extractSkillsFromOutput(output, agentId, dispatchItem, config) {
  if (!output) return;

  // Parse stream-json output to extract assistant text
  let fullText = '';
  for (const line of output.split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.type === 'assistant' && j.message?.content) {
        for (const c of j.message.content) {
          if (c.type === 'text') fullText += c.text + '\n';
        }
      }
    } catch {}
  }
  if (!fullText) fullText = output; // fallback for non-json output

  // Look for ```skill blocks
  const skillBlocks = [];
  const skillRegex = /```skill\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = skillRegex.exec(fullText)) !== null) {
    skillBlocks.push(match[1].trim());
  }

  if (skillBlocks.length === 0) return;

  const agentName = config.agents[agentId]?.name || agentId;

  for (const block of skillBlocks) {
    // Parse the skill content — expect frontmatter
    const fmMatch = block.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      log('warn', `Skill block from ${agentName} has no frontmatter, skipping`);
      continue;
    }

    const fm = fmMatch[1];
    const body = fmMatch[2];
    const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    const name = m('name');
    if (!name) {
      log('warn', `Skill block from ${agentName} has no name, skipping`);
      continue;
    }

    const scope = m('scope') || 'squad';
    const project = m('project');

    // Ensure author and created are set
    let enrichedBlock = block;
    if (!m('author')) {
      enrichedBlock = enrichedBlock.replace('---\n', `---\nauthor: ${agentName}\n`);
    }
    if (!m('created')) {
      enrichedBlock = enrichedBlock.replace('---\n', `---\ncreated: ${dateStamp()}\n`);
    }

    const filename = name.replace(/[^a-z0-9-]/g, '-') + '.md';

    if (scope === 'project' && project) {
      // Project-level skill — don't write directly, queue a work item to PR it
      const proj = getProjects(config).find(p => p.name === project);
      if (proj) {
        const centralPath = path.join(SQUAD_DIR, 'work-items.json');
        const items = safeJson(centralPath) || [];
        const alreadyExists = items.some(i => i.title === `Add skill: ${name}` && i.status !== 'failed');
        if (!alreadyExists) {
          const skillId = `SK${String(items.filter(i => i.id?.startsWith('SK')).length + 1).padStart(3, '0')}`;
          items.push({
            id: skillId,
            type: 'implement',
            title: `Add skill: ${name}`,
            description: `Create project-level skill \`${filename}\` in ${project}.\n\nWrite this file to \`${proj.localPath}/.claude/skills/${filename}\` via a PR.\n\n## Skill Content\n\n\`\`\`\n${enrichedBlock}\n\`\`\``,
            priority: 'low',
            status: 'queued',
            created: ts(),
            createdBy: `engine:skill-extraction:${agentName}`
          });
          safeWrite(centralPath, items);
          log('info', `Queued work item ${skillId} to PR project skill "${name}" into ${project}`);
        }
      }
    } else {
      // Squad-level skill — write directly
      const skillPath = path.join(SKILLS_DIR, filename);
      if (!fs.existsSync(skillPath)) {
        safeWrite(skillPath, enrichedBlock);
        log('info', `Extracted squad skill "${name}" from ${agentName} → ${filename}`);
      } else {
        log('info', `Squad skill "${name}" already exists, skipping`);
      }
    }
  }
}

function updateAgentHistory(agentId, dispatchItem, result) {
  const historyPath = path.join(AGENTS_DIR, agentId, 'history.md');
  let history = safeRead(historyPath) || '# Agent History\n\n';

  const entry = `### ${ts()} — ${result}\n` +
    `- **Task:** ${dispatchItem.task}\n` +
    `- **Type:** ${dispatchItem.type}\n` +
    `- **Project:** ${dispatchItem.meta?.project?.name || 'central'}\n` +
    `- **Branch:** ${dispatchItem.meta?.branch || 'none'}\n` +
    `- **Dispatch ID:** ${dispatchItem.id}\n\n`;

  // Insert after header
  const headerEnd = history.indexOf('\n\n');
  if (headerEnd >= 0) {
    history = history.slice(0, headerEnd + 2) + entry + history.slice(headerEnd + 2);
  } else {
    history += entry;
  }

  // Keep last 20 entries
  const entries = history.split('### ').filter(Boolean);
  const header = entries[0].startsWith('#') ? entries.shift() : '# Agent History\n\n';
  const trimmed = entries.slice(0, 20);
  history = header + trimmed.map(e => '### ' + e).join('');

  safeWrite(historyPath, history);
  log('info', `Updated history for ${agentId}`);
}

function createReviewFeedbackForAuthor(reviewerAgentId, pr, config) {
  if (!pr?.id || !pr?.agent) return;

  const authorAgentId = pr.agent.toLowerCase();
  if (!config.agents[authorAgentId]) return;

  // Find reviewer's inbox files from today about this PR
  const today = dateStamp();
  const inboxFiles = getInboxFiles();
  const reviewFiles = inboxFiles.filter(f =>
    f.includes(reviewerAgentId) && f.includes(today)
  );

  if (reviewFiles.length === 0) return;

  // Read review content
  const reviewContent = reviewFiles.map(f =>
    safeRead(path.join(INBOX_DIR, f))
  ).join('\n\n');

  // Create a feedback file for the author
  const feedbackFile = `feedback-${authorAgentId}-from-${reviewerAgentId}-${pr.id}-${today}.md`;
  const feedbackPath = path.join(INBOX_DIR, feedbackFile);

  const content = `# Review Feedback for ${config.agents[authorAgentId]?.name || authorAgentId}\n\n` +
    `**PR:** ${pr.id} — ${pr.title || ''}\n` +
    `**Reviewer:** ${config.agents[reviewerAgentId]?.name || reviewerAgentId}\n` +
    `**Date:** ${today}\n\n` +
    `## What the reviewer found\n\n${reviewContent}\n\n` +
    `## Action Required\n\n` +
    `Read this feedback carefully. When you work on similar tasks in the future, ` +
    `avoid the patterns flagged here. If you are assigned to fix this PR, ` +
    `address every point raised above.\n`;

  safeWrite(feedbackPath, content);
  log('info', `Created review feedback for ${authorAgentId} from ${reviewerAgentId} on ${pr.id}`);
}

function updateMetrics(agentId, dispatchItem, result) {
  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  const metrics = safeJson(metricsPath) || {};

  if (!metrics[agentId]) {
    metrics[agentId] = {
      tasksCompleted: 0,
      tasksErrored: 0,
      prsCreated: 0,
      prsApproved: 0,
      prsRejected: 0,
      reviewsDone: 0,
      lastTask: null,
      lastCompleted: null
    };
  }

  const m = metrics[agentId];
  m.lastTask = dispatchItem.task;
  m.lastCompleted = ts();

  if (result === 'success') {
    m.tasksCompleted++;
    if (dispatchItem.type === 'implement') m.prsCreated++;
    if (dispatchItem.type === 'review') m.reviewsDone++;
  } else {
    m.tasksErrored++;
  }

  safeWrite(metricsPath, metrics);
}

// ─── Inbox Consolidation ────────────────────────────────────────────────────

function consolidateInbox(config) {
  const threshold = config.engine?.inboxConsolidateThreshold || 5;
  const files = getInboxFiles();
  if (files.length < threshold) return;

  log('info', `Consolidating ${files.length} inbox items into notes.md`);

  const items = files.map(f => ({
    name: f,
    content: safeRead(path.join(INBOX_DIR, f))
  }));

  // Categorize by type based on filename patterns
  const categories = {
    reviews: [],
    feedback: [],
    learnings: [],
    other: []
  };

  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.includes('review') || name.includes('pr-') || name.includes('pr4')) {
      categories.reviews.push(item);
    } else if (name.includes('feedback')) {
      categories.feedback.push(item);
    } else if (name.includes('build') || name.includes('explore') || name.includes('m0') || name.includes('m1')) {
      categories.learnings.push(item);
    } else {
      categories.other.push(item);
    }
  }

  let entry = `\n\n---\n\n### ${dateStamp()}: Consolidated from ${items.length} inbox items\n`;
  entry += `**By:** Engine (auto-consolidation)\n\n`;

  if (categories.reviews.length > 0) {
    entry += `#### Review Findings (${categories.reviews.length})\n`;
    for (const item of categories.reviews) {
      // Extract first meaningful line as summary
      const firstLine = item.content.split('\n').find(l => l.trim() && !l.startsWith('#')) || item.name;
      entry += `- **${item.name}**: ${firstLine.trim().slice(0, 150)}\n`;
    }
    entry += '\n';
  }

  if (categories.feedback.length > 0) {
    entry += `#### Review Feedback (${categories.feedback.length})\n`;
    for (const item of categories.feedback) {
      const firstLine = item.content.split('\n').find(l => l.trim() && !l.startsWith('#')) || item.name;
      entry += `- **${item.name}**: ${firstLine.trim().slice(0, 150)}\n`;
    }
    entry += '\n';
  }

  if (categories.learnings.length > 0) {
    entry += `#### Learnings & Conventions (${categories.learnings.length})\n`;
    for (const item of categories.learnings) {
      const firstLine = item.content.split('\n').find(l => l.trim() && !l.startsWith('#')) || item.name;
      entry += `- **${item.name}**: ${firstLine.trim().slice(0, 150)}\n`;
    }
    entry += '\n';
  }

  if (categories.other.length > 0) {
    entry += `#### Other (${categories.other.length})\n`;
    for (const item of categories.other) {
      const firstLine = item.content.split('\n').find(l => l.trim() && !l.startsWith('#')) || item.name;
      entry += `- **${item.name}**: ${firstLine.trim().slice(0, 150)}\n`;
    }
    entry += '\n';
  }

  const current = getNotes();

  // Prune old consolidations if notes.md is getting too large (>50KB)
  let newContent = current + entry;
  if (newContent.length > 50000) {
    const sections = newContent.split('\n---\n\n### ');
    if (sections.length > 10) {
      // Keep header + last 8 consolidation sections
      const header = sections[0];
      const recent = sections.slice(-8);
      newContent = header + '\n---\n\n### ' + recent.join('\n---\n\n### ');
      log('info', `Pruned notes.md: removed ${sections.length - 9} old sections`);
    }
  }

  safeWrite(NOTES_PATH, newContent);

  // Archive
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const f of files) {
    try { fs.renameSync(path.join(INBOX_DIR, f), path.join(ARCHIVE_DIR, `${dateStamp()}-${f}`)); } catch {}
  }

  log('info', `Consolidated ${files.length} items into notes.md (${Object.entries(categories).map(([k,v]) => `${v.length} ${k}`).join(', ')})`);
}

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
        const outputPath = path.join(AGENTS_DIR, item.agent, 'output.log');
        try {
          const resultLine = liveLog.split('\n').find(l => l.includes('"type":"result"'));
          if (resultLine) {
            const result = JSON.parse(resultLine);
            safeWrite(outputPath, `# Output for dispatch ${item.id}\n# Exit code: ${isSuccess ? 0 : 1}\n# Completed: ${ts()}\n# Detected via output scan\n\n## Result\n${result.result || '(no text)'}\n`);
          }
        } catch {}

        completeDispatch(item.id, isSuccess ? 'success' : 'error', 'Completed (detected from output)');
        if (item.meta?.item?.id) updateWorkItemStatus(item.meta, isSuccess ? 'done' : 'failed', '');
        setAgentStatus(item.agent, {
          status: 'done',
          task: item.task || '',
          dispatch_id: item.id,
          completed_at: ts()
        });

        // Run post-completion hooks
        if (isSuccess) {
          const config = getConfig();
          syncPrsFromOutput(liveLog, item.agent, item.meta, config);
          checkForLearnings(item.agent, config.agents?.[item.agent], item.task);
          updateAgentHistory(item.agent, item, isSuccess ? 'success' : 'error');
          updateMetrics(item.agent, item, isSuccess ? 'success' : 'error');
        }

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
        log('warn', `Reconcile: work item ${item.id} is "dispatched" but no active dispatch found — resetting to failed`);
        item.status = 'failed';
        item.failReason = 'Agent died or was killed';
        item.failedAt = ts();
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
    const prSrc = project.workSources?.pullRequests || {};
    const prs = safeJson(path.resolve(root, prSrc.path || '.squad/pull-requests.json')) || [];
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

  if (cleaned.tempFiles + cleaned.liveOutputs + cleaned.worktrees + cleaned.zombies > 0) {
    log('info', `Cleanup: ${cleaned.tempFiles} temp files, ${cleaned.liveOutputs} live outputs, ${cleaned.worktrees} worktrees, ${cleaned.zombies} zombies`);
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
 * Scan squad-level PRD (~/.squad/prd.json) for missing/planned items → queue implement tasks.
 * Items can span multiple projects via the `projects` array field.
 */
function discoverFromPrd(config) {
  const prdPath = path.join(SQUAD_DIR, 'prd.json');
  const prd = safeJson(prdPath);
  if (!prd) return [];

  const cooldownMs = (config.workSources?.prd?.cooldownMinutes || 30) * 60 * 1000;
  const statusFilter = config.workSources?.prd?.itemFilter?.status || ['missing', 'planned'];
  const items = (prd.missing_features || []).filter(f => statusFilter.includes(f.status));
  const newWork = [];
  const skipped = { dispatched: 0, cooldown: 0, noAgent: 0, noProject: 0 };
  const allProjects = config.projects || [];

  for (const item of items) {
    const key = `prd-squad-${item.id}`;
    if (isAlreadyDispatched(key)) { skipped.dispatched++; continue; }
    if (isOnCooldown(key, cooldownMs)) { skipped.cooldown++; continue; }

    // Resolve target projects from item.projects array
    const targetProjects = (item.projects || [])
      .map(name => allProjects.find(p => p.name.toLowerCase() === name.toLowerCase()))
      .filter(Boolean);
    if (targetProjects.length === 0) { skipped.noProject++; continue; }

    const workType = item.estimated_complexity === 'large' ? 'implement:large' : 'implement';
    const agentId = resolveAgent(workType, config);
    if (!agentId) { skipped.noAgent++; continue; }

    // Primary project = first in the list (used for worktree, branch, PR)
    const primary = targetProjects[0];
    const root = path.resolve(primary.localPath);
    const branchName = `feature/${item.id.toLowerCase()}-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

    // Build related projects context for multi-project items
    let relatedProjects = '';
    if (targetProjects.length > 1) {
      relatedProjects = targetProjects.map(p =>
        `- **${p.name}** — ${path.resolve(p.localPath)} (${p.adoOrg}/${p.adoProject}/${p.repoName}, branch: ${p.mainBranch || 'main'})`
      ).join('\n');
    }

    const vars = {
      agent_id: agentId,
      agent_name: config.agents[agentId]?.name || agentId,
      agent_role: config.agents[agentId]?.role || 'Agent',
      item_id: item.id,
      item_name: item.name,
      item_priority: item.priority || 'medium',
      item_complexity: item.estimated_complexity || 'medium',
      item_description: item.description || '',
      branch_name: branchName,
      project_path: root,
      main_branch: primary.mainBranch || 'main',
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', branchName),
      commit_message: `feat(${item.id.toLowerCase()}): ${item.name}`,
      team_root: SQUAD_DIR,
      repo_id: primary.repositoryId || '',
      project_name: targetProjects.map(p => p.name).join(', '),
      ado_org: primary.adoOrg || 'Unknown',
      ado_project: primary.adoProject || 'Unknown',
      repo_name: primary.repoName || 'Unknown',
      related_projects: relatedProjects,
    };

    const prompt = renderPlaybook('implement', vars);
    if (!prompt) continue;

    newWork.push({
      type: workType,
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${vars.project_name}] Implement ${item.id}: ${item.name}`,
      prompt,
      meta: { dispatchKey: key, source: 'prd', branch: branchName, item, project: { name: primary.name, localPath: primary.localPath } }
    });

    setCooldown(key);
  }

  const skipTotal = skipped.dispatched + skipped.cooldown + skipped.noAgent + skipped.noProject;
  if (skipTotal > 0) {
    log('debug', `PRD discovery: skipped ${skipTotal} items (${skipped.dispatched} dispatched, ${skipped.cooldown} cooldown, ${skipped.noAgent} no agent, ${skipped.noProject} no project)`);
  }

  return newWork;
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

  let planFiles;
  try { planFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json')); } catch { return; }

  for (const file of planFiles) {
    const plan = safeJson(path.join(PLANS_DIR, file));
    if (!plan?.missing_features) continue;

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

      const maxNum = existingItems.reduce((max, i) => {
        const m = (i.id || '').match(/(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 0);
      const id = 'PL-W' + String(maxNum + 1).padStart(3, '0');

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
          log('warn', `Dependency cycle detected in plan ${file}: ${cycles.join(', ')} — clearing deps for cycling items`);
          for (const wi of existingItems) {
            if (wi.sourcePlan === file && cycles.includes(wi.planItemId)) {
              wi.depends_on = [];
            }
          }
          safeWrite(wiPath, existingItems);
        }
      }
    }
  }
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

  for (const pr of prs) {
    if (pr.status !== 'active') continue;

    // PRs needing review — use squad review state (not ADO reviewStatus which pollPrStatus manages)
    const squadStatus = pr.squadReview?.status;
    const needsReview = !squadStatus || squadStatus === 'waiting';
    if (needsReview) {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('review', config);
      if (!agentId) continue;

      // Extract numeric PR ID from "PR-NNNNN" format
      const prNumber = (pr.id || '').replace(/^PR-/, '');
      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_number: prNumber,
        pr_title: pr.title || '',
        pr_branch: pr.branch || '',
        pr_author: pr.agent || '',
        pr_url: pr.url || '',
        main_branch: project?.mainBranch || 'main',
        team_root: SQUAD_DIR,
        repo_id: project?.repositoryId || config.project?.repositoryId || '',
        project_name: project?.name || 'Unknown Project',
        ado_org: project?.adoOrg || 'Unknown',
        ado_project: project?.adoProject || 'Unknown',
        repo_name: project?.repoName || 'Unknown'
      };

      const prompt = renderPlaybook('review', vars);
      if (!prompt) continue;

      newWork.push({
        type: 'review',
        agent: agentId,
        agentName: config.agents[agentId]?.name,
        agentRole: config.agents[agentId]?.role,
        task: `[${project?.name || 'project'}] Review PR ${pr.id}: ${pr.title}`,
        prompt,
        meta: { dispatchKey: key, source: 'pr', pr, project: { name: project?.name, localPath: project?.localPath } }
      });

      setCooldown(key);
    }

    // PRs with changes requested (by squad review) → route back to author for fix
    if (squadStatus === 'changes-requested') {
      const key = `fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_branch: pr.branch || '',
        review_note: pr.squadReview?.note || pr.reviewNote || 'See PR thread comments',
        team_root: SQUAD_DIR,
        repo_id: project?.repositoryId || config.project?.repositoryId || '',
        project_name: project?.name || 'Unknown Project',
        ado_org: project?.adoOrg || 'Unknown',
        ado_project: project?.adoProject || 'Unknown',
        repo_name: project?.repoName || 'Unknown'
      };

      const prompt = renderPlaybook('fix', vars);
      if (!prompt) continue;

      newWork.push({
        type: 'fix',
        agent: agentId,
        agentName: config.agents[agentId]?.name,
        agentRole: config.agents[agentId]?.role,
        task: `[${project?.name || 'project'}] Fix PR ${pr.id} review feedback`,
        prompt,
        meta: { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: { name: project?.name, localPath: project?.localPath } }
      });

      setCooldown(key);
    }

    // PRs with pending human feedback (@squad comments) → route to author for fix
    if (pr.humanFeedback?.pendingFix) {
      const key = `human-fix-${project?.name || 'default'}-${pr.id}-${pr.humanFeedback.lastProcessedCommentDate}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const prNumber = (pr.id || '').replace(/^PR-/, '');
      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_number: prNumber,
        pr_title: pr.title || '',
        pr_branch: pr.branch || '',
        reviewer: 'Human Reviewer',
        review_note: pr.humanFeedback.feedbackContent || 'See PR thread comments',
        team_root: SQUAD_DIR,
        repo_id: project?.repositoryId || config.project?.repositoryId || '',
        project_name: project?.name || 'Unknown Project',
        ado_org: project?.adoOrg || 'Unknown',
        ado_project: project?.adoProject || 'Unknown',
        repo_name: project?.repoName || 'Unknown'
      };

      const prompt = renderPlaybook('fix', vars);
      if (!prompt) continue;

      newWork.push({
        type: 'fix',
        agent: agentId,
        agentName: config.agents[agentId]?.name,
        agentRole: config.agents[agentId]?.role,
        task: `[${project?.name || 'project'}] Fix PR ${pr.id} — human feedback`,
        prompt,
        meta: { dispatchKey: key, source: 'pr-human-feedback', pr, branch: pr.branch, project: { name: project?.name, localPath: project?.localPath } }
      });

      // Clear pendingFix so it doesn't re-dispatch next tick
      pr.humanFeedback.pendingFix = false;
      setCooldown(key);
    }

    // PRs with build failures → route to any idle agent
    if (pr.status === 'active' && pr.buildStatus === 'failing') {
      const key = `build-fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('fix', config);
      if (!agentId) continue;

      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_branch: pr.branch || '',
        review_note: `Build is failing: ${pr.buildFailReason || 'Check CI pipeline for details'}. Fix the build errors and push.`,
        team_root: SQUAD_DIR,
        repo_id: project?.repositoryId || config.project?.repositoryId || '',
        project_name: project?.name || 'Unknown Project',
        ado_org: project?.adoOrg || 'Unknown',
        ado_project: project?.adoProject || 'Unknown',
        repo_name: project?.repoName || 'Unknown'
      };

      const prompt = renderPlaybook('fix', vars);
      if (!prompt) continue;

      newWork.push({
        type: 'fix',
        agent: agentId,
        agentName: config.agents[agentId]?.name,
        agentRole: config.agents[agentId]?.role,
        task: `[${project?.name || 'project'}] Fix build failure on PR ${pr.id}`,
        prompt,
        meta: { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: { name: project?.name, localPath: project?.localPath } }
      });

      setCooldown(key);
    }

    // Newly created PRs needing build & test verification
    if (!pr.buildTested) {
      const key = `build-test-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('test', config);
      if (!agentId) continue;

      const prNumber = (pr.id || '').replace(/^PR-/, '');
      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_number: prNumber,
        pr_title: pr.title || '',
        pr_branch: pr.branch || '',
        pr_author: pr.agent || '',
        pr_url: pr.url || '',
        main_branch: project?.mainBranch || 'main',
        team_root: SQUAD_DIR,
        repo_id: project?.repositoryId || '',
        project_name: project?.name || 'Unknown Project',
        project_path: project?.localPath ? path.resolve(project.localPath) : '',
        ado_org: project?.adoOrg || 'Unknown',
        ado_project: project?.adoProject || 'Unknown',
        repo_name: project?.repoName || 'Unknown',
        date: dateStamp()
      };

      const prompt = renderPlaybook('build-and-test', vars);
      if (!prompt) continue;

      // Mark PR so we don't re-dispatch (written after loop)
      pr.buildTested = 'dispatched';

      newWork.push({
        type: 'test',
        agent: agentId,
        agentName: config.agents[agentId]?.name,
        agentRole: config.agents[agentId]?.role,
        task: `[${project?.name || 'project'}] Build & test PR ${pr.id}: ${pr.title}`,
        prompt,
        meta: { dispatchKey: key, source: 'pr-build-test', pr, branch: pr.branch, project: { name: project?.name, localPath: project?.localPath } }
      });

      setCooldown(key);
    }
  }

  // Batch-write PR state changes (buildTested flags) once after the loop
  if (newWork.some(w => w.meta?.source === 'pr-build-test')) {
    const prRoot = path.resolve(project.localPath);
    const prSrc = project.workSources?.pullRequests || {};
    const prPath = path.resolve(prRoot, prSrc.path || '.squad/pull-requests.json');
    safeWrite(prPath, prs);
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

    // Dependency gate: skip items whose depends_on are not yet met
    if (item.depends_on && item.depends_on.length > 0 && !areDependenciesMet(item, config)) continue;

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
      agent_id: agentId,
      agent_name: config.agents[agentId]?.name || agentId,
      agent_role: config.agents[agentId]?.role || 'Agent',
      item_id: item.id,
      item_name: item.title || item.id,
      item_priority: item.priority || 'medium',
      item_description: item.description || '',
      work_type: workType,
      additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
      scope_section: `## Scope: Project — ${project?.name || 'default'}\n\nThis task is scoped to a single project.`,
      branch_name: branchName,
      project_path: root,
      main_branch: project?.mainBranch || 'main',
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', branchName),
      commit_message: item.commitMessage || `feat: ${item.title || item.id}`,
      team_root: SQUAD_DIR,
      repo_id: project?.repositoryId || config.project?.repositoryId || '',
      project_name: project?.name || 'Unknown Project',
      ado_org: project?.adoOrg || 'Unknown',
      ado_project: project?.adoProject || 'Unknown',
      repo_name: project?.repoName || 'Unknown',
      date: dateStamp()
    };

    // Select playbook: shared-branch items use implement-shared, others use type-specific or work-item
    let playbookName;
    if (item.branchStrategy === 'shared-branch' && (workType === 'implement' || workType === 'implement:large')) {
      playbookName = 'implement-shared';
    } else {
      const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask'];
      playbookName = typeSpecificPlaybooks.includes(workType) ? workType : 'work-item';
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
      const maxNum = spItems.reduce((max, i) => {
        const n = parseInt(i.id.replace('SP', ''), 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);
      const newId = `SP${String(maxNum + 1).padStart(3, '0')}`;

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

      if (idleAgents.length === 0) continue;

      const assignments = idleAgents.map((agent, i) => ({
        agent,
        assignedProject: projects.length > 0 ? projects[i % projects.length] : null
      }));

      for (const { agent, assignedProject } of assignments) {
        const fanKey = `${key}-${agent.id}`;
        if (isAlreadyDispatched(fanKey)) continue;

        const ap = assignedProject || projects[0];
        const vars = {
          agent_id: agent.id,
          agent_name: agent.name,
          agent_role: agent.role,
          item_id: item.id,
          item_name: item.title || item.id,
          item_priority: item.priority || 'medium',
          item_description: item.description || '',
          work_type: workType,
          additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
          scope_section: buildProjectContext(projects, assignedProject, true, agent.name, agent.role),
          project_path: ap?.localPath || '',
          main_branch: ap?.mainBranch || 'main',
          repo_id: ap?.repositoryId || '',
          project_name: ap?.name || 'Unknown',
          ado_org: ap?.adoOrg || 'Unknown',
          ado_project: ap?.adoProject || 'Unknown',
          repo_name: ap?.repoName || 'Unknown',
          team_root: SQUAD_DIR,
          date: dateStamp()
        };

        const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask'];
        const playbookName = typeSpecificPlaybooks.includes(workType) ? workType : 'work-item';
        const prompt = renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars);
        if (!prompt) continue;

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
        agent_id: agentId,
        agent_name: agentName,
        agent_role: agentRole,
        item_id: item.id,
        item_name: item.title || item.id,
        item_priority: item.priority || 'medium',
        item_description: item.description || '',
        work_type: workType,
        additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
        scope_section: buildProjectContext(projects, null, false, agentName, agentRole),
        project_path: firstProject?.localPath || '',
        main_branch: firstProject?.mainBranch || 'main',
        repo_id: firstProject?.repositoryId || '',
        project_name: firstProject?.name || 'Unknown',
        ado_org: firstProject?.adoOrg || 'Unknown',
        ado_project: firstProject?.adoProject || 'Unknown',
        repo_name: firstProject?.repoName || 'Unknown',
        team_root: SQUAD_DIR,
        date: dateStamp()
      };

      // Inject plan-specific variables for the plan playbook
      if (workType === 'plan') {
        const planFileName = `plan-${item.id.toLowerCase()}-${dateStamp()}.md`;
        vars.plan_content = item.title + (item.description ? '\n\n' + item.description : '');
        vars.plan_title = item.title;
        vars.plan_file = planFileName;
        vars.task_description = item.title;
        vars.notes_content = '';
        try { vars.notes_content = fs.readFileSync(path.join(SQUAD_DIR, 'notes.md'), 'utf8'); } catch {}
      }

      const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask'];
      const playbookName = typeSpecificPlaybooks.includes(workType) ? workType : 'work-item';
      const prompt = renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars);
      if (!prompt) continue;

      newWork.push({
        type: workType,
        agent: agentId,
        agentName,
        agentRole,
        task: item.title || item.description?.slice(0, 80) || item.id,
        prompt,
        meta: { dispatchKey: key, source: 'central-work-item', item }
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
 * Discover user questions from notes/inbox/ask-*.md files.
 * When a user drops an ask-*.md file in the inbox, the engine picks it up,
 * dispatches an agent to answer, and renames the file so it doesn't re-trigger.
 */
function discoverQuestions(config) {
  const inboxDir = path.join(SQUAD_DIR, 'notes', 'inbox');
  if (!fs.existsSync(inboxDir)) return [];

  const newWork = [];
  const projects = getProjects(config);

  let files;
  try { files = fs.readdirSync(inboxDir); } catch { return []; }

  const askFiles = files.filter(f => /^ask-.*\.md$/i.test(f) && !f.startsWith('ask-dispatched-'));

  for (const file of askFiles) {
    const filePath = path.join(inboxDir, file);
    const question = safeRead(filePath);
    if (!question || !question.trim()) continue;

    const taskId = file.replace(/^ask-/i, '').replace(/\.md$/i, '') || `q-${Date.now()}`;
    const key = `ask-${taskId}`;
    if (isAlreadyDispatched(key) || isOnCooldown(key, 0)) continue;

    const agentId = resolveAgent('ask', config);
    if (!agentId) continue;

    const agentName = config.agents[agentId]?.name || agentId;
    const agentRole = config.agents[agentId]?.role || 'Agent';

    const vars = {
      agent_id: agentId,
      agent_name: agentName,
      agent_role: agentRole,
      task_id: taskId,
      task_description: question.trim(),
      question: question.trim(),
      scope_section: buildProjectContext(projects, null, false, agentName, agentRole),
      team_root: SQUAD_DIR,
      date: dateStamp(),
      notes_content: getNotes() || ''
    };

    const prompt = renderPlaybook('ask', vars);
    if (!prompt) continue;

    newWork.push({
      type: 'ask',
      agent: agentId,
      agentName,
      agentRole,
      task: `Answer question: ${question.trim().slice(0, 80)}${question.trim().length > 80 ? '...' : ''}`,
      prompt,
      meta: { dispatchKey: key, source: 'ask-inbox', taskId }
    });

    // Rename so it doesn't re-trigger on next tick
    try {
      fs.renameSync(filePath, path.join(inboxDir, `ask-dispatched-${file}`));
    } catch (e) {
      log('warn', `Could not rename ask file ${file}: ${e.message}`);
    }

    setCooldown(key);
    log('info', `Picked up question from ${file} → dispatching to ${agentName}`);
  }

  return newWork;
}

/**
 * Run all work discovery sources and queue new items
 * Priority: fix (0) > ask (1) > review (1) > implement (2) > work-items (3) > central (4)
 */
function discoverWork(config) {
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
  allImplements.push(...discoverFromPrd(config));

  // Central work items (project-agnostic — agent decides where to work)
  const centralWork = discoverCentralWorkItems(config);

  // User questions (ask-*.md files in notes/inbox)
  const questions = discoverQuestions(config);

  const allWork = [...allFixes, ...questions, ...allReviews, ...allImplements, ...allWorkItems, ...centralWork];

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

  // 2.5. Periodic cleanup (every 10 ticks = ~5 minutes)
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

  // Priority dispatch: fixes > reviews > plan-to-prd > implement > other
  const typePriority = { fix: 0, ask: 1, review: 1, test: 2, plan: 3, 'plan-to-prd': 3, 'implement:large': 4, implement: 5 };
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

// ─── CLI Commands ───────────────────────────────────────────────────────────

const commands = {
  start() {
    const control = getControl();
    if (control.state === 'running') {
      // Check if the PID is actually alive
      let alive = false;
      if (control.pid) {
        try { process.kill(control.pid, 0); alive = true; } catch {}
      }
      if (alive) {
        console.log(`Engine is already running (PID ${control.pid}).`);
        return;
      }
      console.log(`Engine was running (PID ${control.pid}) but process is dead — restarting.`);
    }

    safeWrite(CONTROL_PATH, { state: 'running', pid: process.pid, started_at: ts() });
    log('info', 'Engine started');
    console.log(`Engine started (PID: ${process.pid})`);

    const config = getConfig();
    const interval = config.engine?.tickInterval || 60000;

    // Sync MCP servers from Claude Code
    syncMcpServers();

    // Validate project paths
    const projects = getProjects(config);
    for (const p of projects) {
      const root = p.localPath ? path.resolve(p.localPath) : null;
      if (!root || !fs.existsSync(root)) {
        log('warn', `Project "${p.name}" path not found: ${p.localPath} — skipping`);
        console.log(`  WARNING: ${p.name} path not found: ${p.localPath}`);
      } else {
        console.log(`  Project: ${p.name} (${root})`);
      }
    }

    // Validate config before starting
    validateConfig(config);

    // Load persistent state
    loadCooldowns();

    // Grace period for agents that survived a restart
    const dispatch = getDispatch();
    const activeOnStart = (dispatch.active || []);
    if (activeOnStart.length > 0) {
      const gracePeriod = config.engine?.restartGracePeriod || 1200000; // 20min default
      engineRestartGraceUntil = Date.now() + gracePeriod;
      console.log(`  ${activeOnStart.length} active dispatch(es) from previous session — ${gracePeriod / 60000}min grace period before orphan detection`);
      for (const item of activeOnStart) {
        console.log(`    - ${item.agentName || item.agent}: ${(item.task || '').slice(0, 70)}`);
      }
    }

    // Initial tick
    tick();

    // Start tick loop
    setInterval(tick, interval);
    console.log(`Tick interval: ${interval / 1000}s | Max concurrent: ${config.engine?.maxConcurrent || 3}`);
    console.log('Press Ctrl+C to stop');
  },

  stop() {
    // Warn if agents are actively working
    const dispatch = getDispatch();
    const active = (dispatch.active || []);
    if (active.length > 0) {
      console.log(`\n  WARNING: ${active.length} agent(s) are still working:`);
      for (const item of active) {
        console.log(`    - ${item.agentName || item.agent}: ${(item.task || '').slice(0, 80)}`);
      }
      console.log('\n  These agents will continue running but the engine won\'t monitor them.');
      console.log('  On next start, they\'ll get a 20-min grace period before being marked as orphans.');
      console.log('  To kill them now, run: node engine.js kill\n');
    }
    // Kill the running engine process by PID
    const control = getControl();
    if (control.pid && control.pid !== process.pid) {
      try { process.kill(control.pid); } catch {}
    }
    safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: ts() });
    log('info', 'Engine stopped');
    console.log('Engine stopped.');
  },

  pause() {
    safeWrite(CONTROL_PATH, { state: 'paused', paused_at: ts() });
    log('info', 'Engine paused');
    console.log('Engine paused. Run `node .squad/engine.js resume` to resume.');
  },

  resume() {
    const control = getControl();
    if (control.state === 'running') {
      console.log('Engine is already running.');
      return;
    }
    safeWrite(CONTROL_PATH, { state: 'running', resumed_at: ts() });
    log('info', 'Engine resumed');
    console.log('Engine resumed.');
  },

  status() {
    const config = getConfig();
    const control = getControl();
    const dispatch = getDispatch();
    const agents = config.agents || {};

    const projects = getProjects(config);

    console.log('\n=== Squad Engine ===\n');
    console.log(`State: ${control.state}`);
    console.log(`PID: ${control.pid || 'N/A'}`);
    console.log(`Projects: ${projects.map(p => p.name || 'unnamed').join(', ')}`);
    console.log('');

    console.log('Agents:');
    console.log(`  ${'ID'.padEnd(12)} ${'Name (Role)'.padEnd(30)} ${'Status'.padEnd(10)} Task`);
    console.log('  ' + '-'.repeat(70));
    for (const [id, agent] of Object.entries(agents)) {
      const status = getAgentStatus(id);
      console.log(`  ${id.padEnd(12)} ${`${agent.emoji} ${agent.name} (${agent.role})`.padEnd(30)} ${(status.status || 'idle').padEnd(10)} ${status.task || '-'}`);
    }

    console.log('');
    console.log(`Dispatch: ${dispatch.pending.length} pending | ${(dispatch.active || []).length} active | ${(dispatch.completed || []).length} completed`);
    console.log(`Active processes: ${activeProcesses.size}`);

    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath);
    if (metrics && Object.keys(metrics).length > 0) {
      console.log('\nMetrics:');
      console.log(`  ${'Agent'.padEnd(12)} ${'Done'.padEnd(6)} ${'Err'.padEnd(6)} ${'PRs'.padEnd(6)} ${'Approved'.padEnd(10)} ${'Rejected'.padEnd(10)} ${'Reviews'.padEnd(8)}`);
      console.log('  ' + '-'.repeat(58));
      for (const [id, m] of Object.entries(metrics)) {
        const approvalRate = m.prsCreated > 0 ? Math.round((m.prsApproved / m.prsCreated) * 100) + '%' : '-';
        console.log(`  ${id.padEnd(12)} ${String(m.tasksCompleted).padEnd(6)} ${String(m.tasksErrored).padEnd(6)} ${String(m.prsCreated).padEnd(6)} ${String(m.prsApproved + ' (' + approvalRate + ')').padEnd(10)} ${String(m.prsRejected).padEnd(10)} ${String(m.reviewsDone).padEnd(8)}`);
      }
    }
    console.log('');
  },

  queue() {
    const dispatch = getDispatch();

    console.log('\n=== Dispatch Queue ===\n');

    if (dispatch.pending.length) {
      console.log('PENDING:');
      for (const d of dispatch.pending) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.task}`);
      }
    } else {
      console.log('No pending dispatches.');
    }

    if ((dispatch.active || []).length) {
      console.log('\nACTIVE:');
      for (const d of dispatch.active) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.task} (since ${d.started_at})`);
      }
    }

    if ((dispatch.completed || []).length) {
      console.log(`\nCOMPLETED (last 5):`);
      for (const d of dispatch.completed.slice(-5)) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.result} (${d.completed_at})`);
      }
    }
    console.log('');
  },

  complete(id) {
    if (!id) {
      console.log('Usage: node .squad/engine.js complete <dispatch-id>');
      return;
    }
    completeDispatch(id, 'success');
    console.log(`Marked ${id} as completed.`);
  },

  dispatch() {
    console.log('Forcing dispatch cycle...');
    const control = getControl();
    const prevState = control.state;
    safeWrite(CONTROL_PATH, { ...control, state: 'running' });
    tick();
    if (prevState !== 'running') {
      safeWrite(CONTROL_PATH, { ...control, state: prevState });
    }
    console.log('Dispatch cycle complete.');
  },

  spawn(agentId, ...promptParts) {
    const prompt = promptParts.join(' ');
    if (!agentId || !prompt) {
      console.log('Usage: node .squad/engine.js spawn <agent-id> "<prompt>"');
      return;
    }

    const config = getConfig();
    if (!config.agents[agentId]) {
      console.log(`Unknown agent: ${agentId}. Available: ${Object.keys(config.agents).join(', ')}`);
      return;
    }

    const id = addToDispatch({
      type: 'manual',
      agent: agentId,
      agentName: config.agents[agentId].name,
      agentRole: config.agents[agentId].role,
      task: prompt.substring(0, 100),
      prompt: prompt,
      meta: {}
    });

    // Immediately dispatch
    const dispatch = getDispatch();
    const item = dispatch.pending.find(d => d.id === id);
    if (item) {
      spawnAgent(item, config);
    }
  },

  work(title, ...rest) {
    if (!title) {
      console.log('Usage: node .squad/engine.js work "<title>" [options-json]');
      console.log('Options: {"type":"implement","priority":"high","agent":"dallas","description":"...","branch":"feature/..."}');
      return;
    }

    let opts = {};
    const optStr = rest.join(' ');
    if (optStr) {
      try { opts = JSON.parse(optStr); } catch {
        console.log('Warning: Could not parse options JSON, using defaults');
      }
    }

    // Resolve which project to add work to
    const projects = getProjects(config);
    const targetProject = opts.project
      ? projects.find(p => p.name?.toLowerCase() === opts.project?.toLowerCase()) || projects[0]
      : projects[0];
    const wiPath = projectWorkItemsPath(targetProject);
    const items = safeJson(wiPath) || [];

    const item = {
      id: `W${String(items.length + 1).padStart(3, '0')}`,
      title: title,
      type: opts.type || 'implement',
      status: 'queued',
      priority: opts.priority || 'medium',
      complexity: opts.complexity || 'medium',
      description: opts.description || title,
      agent: opts.agent || null,
      branch: opts.branch || null,
      prompt: opts.prompt || null,
      created_at: ts()
    };

    items.push(item);
    safeWrite(wiPath, items);

    console.log(`Queued work item: ${item.id} — ${item.title} (project: ${targetProject.name || 'default'})`);
    console.log(`  Type: ${item.type} | Priority: ${item.priority} | Agent: ${item.agent || 'auto'}`);
  },

  plan(source, projectName) {
    if (!source) {
      console.log('Usage: node .squad/engine.js plan <source> [project]');
      console.log('');
      console.log('Source can be:');
      console.log('  - A file path (markdown, txt, or json)');
      console.log('  - Inline text wrapped in quotes');
      console.log('');
      console.log('Examples:');
      console.log('  node engine.js plan ./my-plan.md');
      console.log('  node engine.js plan ./my-plan.md MyProject');
      console.log('  node engine.js plan "Add auth middleware with JWT tokens and role-based access"');
      return;
    }

    const config = getConfig();
    const projects = getProjects(config);
    const targetProject = projectName
      ? projects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) || projects[0]
      : projects[0];

    if (!targetProject) {
      console.log('No projects configured. Run: node squad.js add <dir>');
      return;
    }

    // Read plan content from file or use inline text
    let planContent;
    let planSummary;
    const sourcePath = path.resolve(source);
    if (fs.existsSync(sourcePath)) {
      planContent = fs.readFileSync(sourcePath, 'utf8');
      planSummary = path.basename(sourcePath, path.extname(sourcePath));
      console.log(`Reading plan from: ${sourcePath}`);
    } else {
      planContent = source;
      planSummary = source.substring(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim();
      console.log('Using inline plan text.');
    }

    console.log(`Target project: ${targetProject.name}`);
    console.log(`Plan summary: ${planSummary}`);
    console.log('');

    // Dispatch as a plan-to-prd work item
    const agentId = resolveAgent('analyze', config) || resolveAgent('explore', config);
    if (!agentId) {
      console.log('No agents available. All agents are busy.');
      return;
    }

    const vars = {
      agent_id: agentId,
      agent_name: config.agents[agentId]?.name,
      agent_role: config.agents[agentId]?.role,
      project_name: targetProject.name || 'Unknown',
      project_path: targetProject.localPath || '',
      main_branch: targetProject.mainBranch || 'main',
      ado_org: targetProject.adoOrg || config.project?.adoOrg || 'Unknown',
      ado_project: targetProject.adoProject || config.project?.adoProject || 'Unknown',
      repo_name: targetProject.repoName || config.project?.repoName || 'Unknown',
      team_root: SQUAD_DIR,
      date: dateStamp(),
      plan_content: planContent,
      plan_summary: planSummary,
      project_name_lower: (targetProject.name || 'project').toLowerCase()
    };

    // Ensure plans directory exists
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });

    const prompt = renderPlaybook('plan-to-prd', vars);
    if (!prompt) {
      console.log('Error: Could not render plan-to-prd playbook.');
      return;
    }

    const id = addToDispatch({
      type: 'plan-to-prd',
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${targetProject.name}] Generate PRD from plan: ${planSummary}`,
      prompt,
      meta: {
        source: 'plan',
        project: { name: targetProject.name, localPath: targetProject.localPath },
        planSummary
      }
    });

    console.log(`Dispatched: ${id} → ${config.agents[agentId]?.name} (${agentId})`);
    console.log('The agent will analyze your plan and generate docs/prd-gaps.json as a PR.');

    // Immediately dispatch if engine is running
    const control = getControl();
    if (control.state === 'running') {
      const dispatch = getDispatch();
      const item = dispatch.pending.find(d => d.id === id);
      if (item) {
        spawnAgent(item, config);
        console.log('Agent spawned immediately.');
      }
    } else {
      console.log('Engine is not running — dispatch will happen on next tick after start.');
    }
  },

  sources() {
    const config = getConfig();
    const projects = getProjects(config);

    console.log('\n=== Work Sources ===\n');

    for (const project of projects) {
      const root = projectRoot(project);
      console.log(`── ${project.name || 'Project'} (${root}) ──\n`);

      const sources = project.workSources || config.workSources || {};
      for (const [name, src] of Object.entries(sources)) {
        const status = src.enabled ? 'ENABLED' : 'DISABLED';
        console.log(`  ${name}: ${status}`);

        const filePath = src.path ? path.resolve(root, src.path) : null;
        const exists = filePath && fs.existsSync(filePath);
        if (filePath) {
          console.log(`    Path: ${src.path} ${exists ? '(found)' : '(NOT FOUND)'}`);
        }
        console.log(`    Cooldown: ${src.cooldownMinutes || 0}m`);

        if (exists && name === 'prd') {
          const prd = safeJson(filePath);
          if (prd) {
            const missing = (prd.missing_features || []).filter(f => ['missing', 'planned'].includes(f.status));
            console.log(`    Items: ${missing.length} missing/planned features`);
          }
        }
        if (exists && name === 'pullRequests') {
          const prs = safeJson(filePath) || [];
          const pending = prs.filter(p => p.status === 'active' && (p.reviewStatus === 'pending' || p.reviewStatus === 'waiting'));
          const needsFix = prs.filter(p => p.status === 'active' && p.reviewStatus === 'changes-requested');
          console.log(`    PRs: ${pending.length} pending review, ${needsFix.length} need fixes`);
        }
        if (exists && name === 'workItems') {
          const items = safeJson(filePath) || [];
          const queued = items.filter(i => i.status === 'queued');
          console.log(`    Items: ${queued.length} queued`);
        }
        if (name === 'specs' || name === 'mergedDesignDocs') {
          const trackerFile = path.resolve(root, src.statePath || '.squad/spec-tracker.json');
          const tracker = safeJson(trackerFile) || { processedPrs: {} };
          const processed = Object.keys(tracker.processedPrs).length;
          const matched = Object.values(tracker.processedPrs).filter(p => p.matched).length;
          console.log(`    Processed: ${processed} merged PRs (${matched} had specs)`);
        }
        console.log('');
      }
    }
  },

  kill() {
    console.log('\n=== Kill All Active Work ===\n');
    const config = getConfig();
    const dispatch = getDispatch();

    // 1. Kill processes
    const pidFiles = fs.readdirSync(ENGINE_DIR).filter(f => f.startsWith('pid-'));
    for (const f of pidFiles) {
      const pid = safeRead(path.join(ENGINE_DIR, f)).trim();
      try { process.kill(Number(pid)); console.log(`Killed process ${pid} (${f})`); } catch { console.log(`Process ${pid} already dead`); }
      fs.unlinkSync(path.join(ENGINE_DIR, f));
    }

    // 2. Clear active dispatches and reset their work items to pending
    // NOTE: we do NOT add killed items to completed — that would block re-dispatch via dedup
    const killed = dispatch.active || [];
    for (const item of killed) {

      // Reset the source work item to pending
      if (item.meta) {
        updateWorkItemStatus(item.meta, 'pending', '');
        // Undo the 'failed' status that updateWorkItemStatus may set — we want 'pending'
        const itemId = item.meta.item?.id;
        if (itemId) {
          const wiPath = (item.meta.source === 'central-work-item' || item.meta.source === 'central-work-item-fanout')
            ? path.join(SQUAD_DIR, 'work-items.json')
            : item.meta.project?.localPath
              ? projectWorkItemsPath({ localPath: item.meta.project.localPath, name: item.meta.project.name, workSources: config.projects?.find(p => p.name === item.meta.project.name)?.workSources })
              : null;
          if (wiPath) {
            const items = safeJson(wiPath) || [];
            const target = items.find(i => i.id === itemId);
            if (target) {
              target.status = 'pending';
              delete target.dispatched_at;
              delete target.dispatched_to;
              delete target.failReason;
              delete target.failedAt;
              safeWrite(wiPath, items);
            }
          }
        }
      }

      console.log(`Killed dispatch: ${item.id} (${item.agent}) — work item reset to pending`);
    }
    dispatch.active = [];
    safeWrite(DISPATCH_PATH, dispatch);

    // 3. Reset all agents to idle
    for (const [agentId] of Object.entries(config.agents || {})) {
      const status = getAgentStatus(agentId);
      if (status.status === 'working' || status.status === 'error') {
        setAgentStatus(agentId, { status: 'idle', task: null, started_at: null, completed_at: ts() });
        console.log(`Reset ${agentId} to idle`);
      }
    }

    console.log(`\nDone: ${killed.length} dispatches killed, agents reset.`);
  },

  cleanup() {
    const config = getConfig();
    console.log('\n=== Cleanup ===\n');
    const result = runCleanup(config, true);
    console.log(`\nDone: ${result.tempFiles} temp files, ${result.liveOutputs} live outputs, ${result.worktrees} worktrees, ${result.zombies} zombies cleaned.`);
  },

  'mcp-sync'() {
    syncMcpServers();
  },

  discover() {
    const config = getConfig();
    console.log('\n=== Work Discovery (dry run) ===\n');

    materializePlansAsWorkItems(config);
    const prdWork = discoverFromPrd(config);
    const prWork = discoverFromPrs(config);
    const workItemWork = discoverFromWorkItems(config);

    const all = [...prdWork, ...prWork, ...workItemWork];

    if (all.length === 0) {
      console.log('No new work discovered from any source.');
    } else {
      console.log(`Found ${all.length} items:\n`);
      for (const w of all) {
        console.log(`  [${w.meta?.source}] ${w.type} → ${w.agent}: ${w.task}`);
      }
    }
    console.log('');
  }
};

// ─── Entrypoint ─────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);

if (!cmd) {
  commands.start();
} else if (commands[cmd]) {
  commands[cmd](...args);
} else {
  console.log(`Unknown command: ${cmd}`);
  console.log('Commands:');
  console.log('  start            Start engine daemon');
  console.log('  stop             Stop engine');
  console.log('  pause / resume   Pause/resume dispatching');
  console.log('  status           Show engine + agent state');
  console.log('  queue            Show dispatch queue');
  console.log('  sources          Show work source status');
  console.log('  discover         Dry-run work discovery');
  console.log('  dispatch         Force a dispatch cycle');
  console.log('  spawn <a> <p>    Manually spawn agent with prompt');
  console.log('  work <title> [o] Add to work-items.json queue');
  console.log('  plan <src> [p]   Generate PRD from a plan (file or text)');
  console.log('  complete <id>    Mark dispatch as done');
  console.log('  cleanup           Clean temp files, worktrees, zombies');
  console.log('  mcp-sync         Sync MCP servers from ~/.claude.json');
  process.exit(1);
}
