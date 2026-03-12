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
const DECISIONS_PATH = path.join(SQUAD_DIR, 'decisions.md');
const AGENTS_DIR = path.join(SQUAD_DIR, 'agents');
const PLAYBOOKS_DIR = path.join(SQUAD_DIR, 'playbooks');
const ENGINE_DIR = path.join(SQUAD_DIR, 'engine');
const CONTROL_PATH = path.join(ENGINE_DIR, 'control.json');
const DISPATCH_PATH = path.join(ENGINE_DIR, 'dispatch.json');
const LOG_PATH = path.join(ENGINE_DIR, 'log.json');
const INBOX_DIR = path.join(SQUAD_DIR, 'decisions', 'inbox');
const ARCHIVE_DIR = path.join(SQUAD_DIR, 'decisions', 'archive');
const IDENTITY_DIR = path.join(SQUAD_DIR, 'identity');

// ─── Multi-Project Support ──────────────────────────────────────────────────
// Config can have either:
//   "project": { ... }           — single project (legacy, .squad inside repo)
//   "projects": [ { ... }, ... ] — multi-project (central .squad)
// Each project must have "localPath" pointing to the repo root.

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
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
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

function getDecisions() {
  return safeRead(DECISIONS_PATH);
}

function getAgentStatus(agentId) {
  return safeJson(path.join(AGENTS_DIR, agentId, 'status.json')) || {
    status: 'idle', task: null, started_at: null, completed_at: null
  };
}

function setAgentStatus(agentId, status) {
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

// ─── Runbooks ────────────────────────────────────────────────────────────────

const RUNBOOKS_DIR = path.join(SQUAD_DIR, 'runbooks');

function getRunbookIndex() {
  try {
    const files = fs.readdirSync(RUNBOOKS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
    if (files.length === 0) return '';

    let index = '## Available Runbooks\n\n';
    index += 'These are reusable workflows discovered by agents. Follow them when the trigger matches your task.\n\n';

    for (const f of files) {
      const content = safeRead(path.join(RUNBOOKS_DIR, f));
      // Parse frontmatter
      let name = f.replace('.md', '');
      let trigger = '';
      let project = 'any';
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const triggerMatch = fm.match(/^trigger:\s*(.+)$/m);
        const projectMatch = fm.match(/^project:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (triggerMatch) trigger = triggerMatch[1].trim();
        if (projectMatch) project = projectMatch[1].trim();
      }

      index += `### ${name}\n`;
      if (trigger) index += `**When:** ${trigger}\n`;
      if (project !== 'any') index += `**Project:** ${project}\n`;
      index += `**File:** \`${RUNBOOKS_DIR}/${f}\`\n`;
      index += `Read the full runbook file before following the steps.\n\n`;
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

function resolveAgent(workType, config, authorAgent = null) {
  const routes = parseRoutingTable();
  const route = routes[workType] || routes['implement'];
  const agents = config.agents || {};

  // Resolve _author_ token
  let preferred = route.preferred === '_author_' ? authorAgent : route.preferred;
  let fallback = route.fallback === '_author_' ? authorAgent : route.fallback;

  // Check if preferred is idle
  if (preferred && agents[preferred]) {
    const status = getAgentStatus(preferred);
    if (['idle', 'done', 'completed'].includes(status.status)) {
      return preferred;
    }
  }

  // Try fallback
  if (fallback && agents[fallback]) {
    const status = getAgentStatus(fallback);
    if (['idle', 'done', 'completed'].includes(status.status)) {
      return fallback;
    }
  }

  // Find any idle agent
  for (const [id] of Object.entries(agents)) {
    const status = getAgentStatus(id);
    if (['idle', 'done', 'completed'].includes(status.status)) {
      return id;
    }
  }

  return null; // All agents busy
}

// ─── Playbook Renderer ──────────────────────────────────────────────────────

function renderPlaybook(type, vars) {
  const pbPath = path.join(PLAYBOOKS_DIR, `${type}.md`);
  let content;
  try { content = fs.readFileSync(pbPath, 'utf8'); } catch {
    log('warn', `Playbook not found: ${type}`);
    return null;
  }

  // Inject decisions context
  const decisions = getDecisions();
  if (decisions) {
    content += '\n\n---\n\n## Team Decisions (MUST READ)\n\n' + decisions;
  }

  // Inject learnings requirement
  content += `\n\n---\n\n## REQUIRED: Write Learnings\n\n`;
  content += `After completing your task, you MUST write a findings/learnings file to:\n`;
  content += `\`${SQUAD_DIR}/decisions/inbox/${vars.agent_id || 'agent'}-${dateStamp()}.md\`\n\n`;
  content += `Include:\n`;
  content += `- What you learned about the codebase\n`;
  content += `- Patterns you discovered or established\n`;
  content += `- Gotchas or warnings for future agents\n`;
  content += `- Conventions to follow\n\n`;
  content += `If you discovered a **repeatable workflow** (multi-step procedure that other agents should follow in similar situations), `;
  content += `save it as a runbook at \`${RUNBOOKS_DIR}/<short-name>.md\` using the format documented in \`${RUNBOOKS_DIR}/README.md\`.\n`;

  // Inject project-level variables from config
  const config = getConfig();
  const project = config.project || {};
  const projectVars = {
    project_name: project.name || 'Unknown Project',
    ado_org: project.adoOrg || 'Unknown',
    ado_project: project.adoProject || 'Unknown',
    repo_name: project.repoName || 'Unknown',
  };
  const allVars = { ...projectVars, ...vars };

  // Substitute variables
  for (const [key, val] of Object.entries(allVars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val));
  }

  return content;
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

function buildSystemPrompt(agentId, config, project) {
  const agent = config.agents[agentId];
  const charter = getAgentCharter(agentId);
  const decisions = getDecisions();
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
  prompt += `- Main branch: ${project.mainBranch || 'main'}\n\n`;

  // Critical rules
  prompt += `## Critical Rules\n\n`;
  prompt += `1. Use git worktrees — NEVER checkout on main working tree\n`;
  prompt += `2. Use Azure DevOps MCP tools (mcp__azure-ado__*) — NEVER use gh CLI\n`;
  prompt += `3. Use PowerShell for yarn/oagent/gulp commands\n`;
  prompt += `4. Write learnings to: ${SQUAD_DIR}/decisions/inbox/${agentId}-${dateStamp()}.md\n`;
  prompt += `5. Update your status at: ${SQUAD_DIR}/agents/${agentId}/status.json\n`;
  prompt += `6. If you discover a repeatable workflow, save it as a runbook: ${RUNBOOKS_DIR}/<name>.md\n\n`;

  // Runbooks
  const runbookIndex = getRunbookIndex();
  if (runbookIndex) {
    prompt += runbookIndex + '\n';
  }

  // Team decisions
  if (decisions) {
    prompt += `## Team Decisions\n\n${decisions}\n\n`;
  }

  return prompt;
}

function sanitizeBranch(name) {
  return String(name).replace(/[^a-zA-Z0-9._\-\/]/g, '-').slice(0, 200);
}

// ─── Agent Spawner ──────────────────────────────────────────────────────────

const activeProcesses = new Map(); // dispatchId → { proc, agentId, startedAt }

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
        log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
        execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${sanitizeBranch(project.mainBranch || 'main')}`, {
          cwd: rootDir, stdio: 'pipe'
        });
      }
      cwd = worktreePath;
    } catch (err) {
      log('error', `Failed to create worktree for ${branchName}: ${err.message}`);
      // Fall back to main directory for non-writing tasks
      if (type === 'review' || type === 'analyze') {
        cwd = ROOT_DIR;
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

  // Spawn via wrapper script — avoids shell metacharacter issues entirely
  // The wrapper reads prompt + system prompt from files, pipes prompt via stdin
  const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
  const proc = spawn(process.execPath, [spawnScript, promptPath, sysPromptPath, ...args], {
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

    // Save output
    const outputPath = path.join(AGENTS_DIR, agentId, 'output.log');
    safeWrite(outputPath, `# Output for dispatch ${id}\n# Exit code: ${code}\n# Completed: ${ts()}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}`);

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

    // Post-completion: scan output for PRs and sync to pull-requests.json
    if (code === 0) {
      syncPrsFromOutput(stdout, agentId, meta, config);
    }

    // Post-completion: update PR status if relevant
    if (type === 'review') updatePrAfterReview(agentId, meta?.pr, meta?.project);
    if (type === 'fix') updatePrAfterFix(meta?.pr, meta?.project);

    // Check for learnings
    checkForLearnings(agentId, config.agents[agentId], dispatchItem.task);

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
    setAgentStatus(agentId, {
      status: 'error',
      task: dispatchItem.task,
      error: err.message,
      completed_at: ts()
    });
  });

  // Debug: check if spawn succeeded
  if (proc.pid) {
    log('info', `Agent process started: PID ${proc.pid}`);
  } else {
    log('error', `Agent spawn returned no PID — process may have failed to start. Script: ${spawnScript}`);
  }

  activeProcesses.set(id, { proc, agentId, startedAt });

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
    dispatch.completed = dispatch.completed || [];
    dispatch.completed.push(item);
    // Keep last 100 completed
    if (dispatch.completed.length > 100) {
      dispatch.completed.splice(0, dispatch.completed.length - 100);
    }
    safeWrite(DISPATCH_PATH, dispatch);
    log('info', `Completed dispatch: ${id} (${result}${reason ? ': ' + reason : ''})`);

    // Update source work item status on failure
    if (result === 'error' && item.meta?.item?.id) {
      updateWorkItemStatus(item.meta, 'failed', reason);
    }
  }
}

function updateWorkItemStatus(meta, status, reason) {
  const itemId = meta.item?.id;
  if (!itemId) return;

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
    target.status = status;
    if (reason) target.failReason = reason;
    target.failedAt = ts();
    safeWrite(wiPath, items);
    log('info', `Work item ${itemId} → ${status}${reason ? ': ' + reason : ''}`);
  }
}

// ─── PR Sync from Output ─────────────────────────────────────────────────────

function syncPrsFromOutput(output, agentId, meta, config) {
  // Scan agent output for PR URLs and add to the correct project's pull-requests.json
  // Matches patterns like: pullrequest/4959180, PR #4959180, PR-4959180
  const prMatches = new Set();
  const urlPattern = /pullrequest\/(\d+)/g;
  const idPattern = /PR[# -]*(\d{5,})/gi;
  let match;
  while ((match = urlPattern.exec(output)) !== null) prMatches.add(match[1]);
  while ((match = idPattern.exec(output)) !== null) prMatches.add(match[1]);

  if (prMatches.size === 0) return;

  // Also scan inbox files for this agent today
  const today = dateStamp();
  const inboxFiles = getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
  for (const f of inboxFiles) {
    const content = safeRead(path.join(INBOX_DIR, f));
    while ((match = urlPattern.exec(content)) !== null) prMatches.add(match[1]);
    while ((match = idPattern.exec(content)) !== null) prMatches.add(match[1]);
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

    // Extract title from output if possible
    let title = meta?.item?.title || '';
    const titleMatch = output.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
    if (titleMatch) title = titleMatch[1].trim();

    prs.push({
      id: fullId,
      title: title || `PR created by ${agentName}`,
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
  if (verdict.toLowerCase().includes('request') || verdict.toLowerCase().includes('change')) {
    target.reviewStatus = 'changes-requested';
  } else {
    target.reviewStatus = 'approved';
  }
  const config = getConfig();
  target.reviewer = config.agents[agentId]?.name || agentId;
  target.reviewNote = agentStatus.task || '';

  // Update author metrics
  const authorAgentId = (pr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath) || {};
    if (!metrics[authorAgentId]) metrics[authorAgentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    if (target.reviewStatus === 'approved') metrics[authorAgentId].prsApproved++;
    else if (target.reviewStatus === 'changes-requested') metrics[authorAgentId].prsRejected++;
    safeWrite(metricsPath, metrics);
  }

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prPath = project?.workSources?.pullRequests?.path || '.squad/pull-requests.json';
  safeWrite(path.resolve(root, prPath), prs);
  log('info', `Updated ${pr.id} → ${target.reviewStatus} by ${target.reviewer}`);

  // Create feedback for the PR author so they learn from the review
  createReviewFeedbackForAuthor(agentId, { ...pr, ...target }, config);
}

function updatePrAfterFix(pr, project) {
  if (!pr?.id) return;
  const prs = getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  target.reviewStatus = 'waiting';
  target.reviewNote = 'Fixed, awaiting re-review';

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prPath = project?.workSources?.pullRequests?.path || '.squad/pull-requests.json';
  safeWrite(path.resolve(root, prPath), prs);
  log('info', `Updated ${pr.id} → waiting (fix pushed)`);
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

  log('info', `Consolidating ${files.length} inbox items into decisions.md`);

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

  const current = getDecisions();

  // Prune old consolidations if decisions.md is getting too large (>50KB)
  let newContent = current + entry;
  if (newContent.length > 50000) {
    const sections = newContent.split('\n---\n\n### ');
    if (sections.length > 10) {
      // Keep header + last 8 consolidation sections
      const header = sections[0];
      const recent = sections.slice(-8);
      newContent = header + '\n---\n\n### ' + recent.join('\n---\n\n### ');
      log('info', `Pruned decisions.md: removed ${sections.length - 9} old sections`);
    }
  }

  safeWrite(DECISIONS_PATH, newContent);

  // Archive
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const f of files) {
    try { fs.renameSync(path.join(INBOX_DIR, f), path.join(ARCHIVE_DIR, `${dateStamp()}-${f}`)); } catch {}
  }

  log('info', `Consolidated ${files.length} items into decisions.md (${Object.entries(categories).map(([k,v]) => `${v.length} ${k}`).join(', ')})`);
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

// ─── Timeout Checker ────────────────────────────────────────────────────────

function checkTimeouts(config) {
  const timeout = config.engine?.agentTimeout || 18000000; // 5h default
  const heartbeatTimeout = config.engine?.heartbeatTimeout || 300000; // 5min — no output = dead

  // 1. Check tracked processes for hard timeout
  for (const [id, info] of activeProcesses.entries()) {
    const elapsed = Date.now() - new Date(info.startedAt).getTime();
    if (elapsed > timeout) {
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

    if (!hasProcess && silentMs > heartbeatTimeout) {
      // No tracked process AND no recent output → orphaned
      log('warn', `Orphan detected: ${item.agent} (${item.id}) — no process tracked, no output for ${silentSec}s`);
      deadItems.push({ item, reason: `Orphaned — no process, silent for ${silentSec}s` });
    } else if (hasProcess && silentMs > heartbeatTimeout) {
      // Has process but no output → hung
      log('warn', `Hung agent: ${item.agent} (${item.id}) — process exists but no output for ${silentSec}s`);
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
    setAgentStatus(item.agent, {
      status: 'idle',
      task: null,
      started_at: null,
      completed_at: ts()
    });
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

const dispatchCooldowns = new Map(); // key → timestamp of last dispatch

function isOnCooldown(key, cooldownMs) {
  const last = dispatchCooldowns.get(key);
  if (!last) return false;
  return (Date.now() - last) < cooldownMs;
}

function setCooldown(key) {
  dispatchCooldowns.set(key, Date.now());
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
 * Scan PRD (docs/prd-gaps.json) for missing/planned items → queue implement tasks
 */
function discoverFromPrd(config, project) {
  const src = project?.workSources?.prd || config.workSources?.prd;
  if (!src?.enabled) return [];

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(SQUAD_DIR, '..');
  const prdPath = path.resolve(root, src.path);
  const prd = safeJson(prdPath);
  if (!prd) return [];

  const cooldownMs = (src.cooldownMinutes || 30) * 60 * 1000;
  const statusFilter = src.itemFilter?.status || ['missing', 'planned'];
  const items = (prd.missing_features || []).filter(f => statusFilter.includes(f.status));
  const newWork = [];

  for (const item of items) {
    const key = `prd-${project?.name || 'default'}-${item.id}`;
    if (isAlreadyDispatched(key)) continue;
    if (isOnCooldown(key, cooldownMs)) continue;

    const workType = item.estimated_complexity === 'large' ? 'implement:large' : 'implement';
    const agentId = resolveAgent(workType, config);
    if (!agentId) continue;

    const branchName = `feature/${item.id.toLowerCase()}-${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
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
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', branchName),
      commit_message: `feat(${item.id.toLowerCase()}): ${item.name}`,
      team_root: SQUAD_DIR,
      repo_id: project?.repositoryId || config.project?.repositoryId || '',
      project_name: project?.name || config.project?.name || 'Unknown Project',
      ado_org: project?.adoOrg || config.project?.adoOrg || 'Unknown',
      ado_project: project?.adoProject || config.project?.adoProject || 'Unknown',
      repo_name: project?.repoName || config.project?.repoName || 'Unknown'
    };

    const prompt = renderPlaybook('implement', vars);
    if (!prompt) continue;

    newWork.push({
      type: 'implement',
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${project?.name || 'project'}] Implement ${item.id}: ${item.name}`,
      prompt,
      meta: { dispatchKey: key, source: 'prd', branch: branchName, item, project: { name: project?.name, localPath: project?.localPath } }
    });

    setCooldown(key);
  }

  return newWork;
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

    // PRs needing review
    if (pr.reviewStatus === 'pending' || pr.reviewStatus === 'waiting') {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      const agentId = resolveAgent('review', config);
      if (!agentId) continue;

      const vars = {
        agent_id: agentId,
        agent_name: config.agents[agentId]?.name || agentId,
        agent_role: config.agents[agentId]?.role || 'Agent',
        pr_id: pr.id,
        pr_title: pr.title || '',
        pr_branch: pr.branch || '',
        pr_author: pr.agent || '',
        pr_url: pr.url || '',
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

    // PRs with changes requested → route back to author for fix
    if (pr.reviewStatus === 'changes-requested') {
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
        review_note: pr.reviewNote || 'See PR thread comments',
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

  for (const item of items) {
    if (item.status !== 'queued' && item.status !== 'pending') continue;

    const key = `work-${project?.name || 'default'}-${item.id}`;
    if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

    const workType = item.type || 'implement';
    const agentId = item.agent || resolveAgent(workType, config);
    if (!agentId) continue;

    const branchName = item.branch || `work/${item.id}`;
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

    const prompt = item.prompt || renderPlaybook('work-item', vars) || renderPlaybook(workType, vars) || item.description;
    if (!prompt) continue;

    newWork.push({
      type: workType,
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${project?.name || 'project'}] ${item.title || item.description?.slice(0, 80) || item.id}`,
      prompt,
      meta: { dispatchKey: key, source: 'work-item', branch: branchName, item, project: { name: project?.name, localPath: project?.localPath } }
    });

    // Mark item as dispatched in the source file
    item.status = 'dispatched';
    item.dispatched_at = ts();
    item.dispatched_to = agentId;
    setCooldown(key);
  }

  // Write back updated statuses only if we dispatched something
  if (newWork.length > 0) {
    const workItemsPath = path.resolve(root, src.path);
    safeWrite(workItemsPath, items);
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
    line += `- **ADO:** ${p.adoOrg}/${p.adoProject}/${p.repoName} (repo ID: ${p.repositoryId || 'unknown'})\n`;
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

        const prompt = renderPlaybook('work-item', vars);
        if (!prompt) continue;

        newWork.push({
          type: workType,
          agent: agent.id,
          agentName: agent.name,
          agentRole: agent.role,
          task: `[fan-out] ${item.title} → ${agent.name}${assignedProject ? ' → ' + assignedProject.name : ''}`,
          prompt,
          meta: { dispatchKey: fanKey, source: 'central-work-item-fanout', item, parentKey: key }
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

      const prompt = renderPlaybook('work-item', vars);
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
 * Run all work discovery sources and queue new items
 * Priority: fix (0) > review (1) > implement (2) > work-items (3) > central (4)
 */
function discoverWork(config) {
  const projects = getProjects(config);
  let allFixes = [], allReviews = [], allImplements = [], allWorkItems = [];

  for (const project of projects) {
    const root = project.localPath ? path.resolve(project.localPath) : null;
    if (!root || !fs.existsSync(root)) continue;
    const prWork = discoverFromPrs(config, project);
    allFixes.push(...prWork.filter(w => w.type === 'fix'));
    allReviews.push(...prWork.filter(w => w.type === 'review'));
    allImplements.push(...discoverFromPrd(config, project));
    allWorkItems.push(...discoverFromWorkItems(config, project));
  }

  // Central work items (project-agnostic — agent decides where to work)
  const centralWork = discoverCentralWorkItems(config);

  const fixes = allFixes, reviews = allReviews, implements_ = allImplements, workItems = allWorkItems;
  const allWork = [...fixes, ...reviews, ...implements_, ...workItems, ...centralWork];

  for (const item of allWork) {
    addToDispatch(item);
  }

  if (allWork.length > 0) {
    log('info', `Discovered ${allWork.length} new work items: ${fixes.length} fixes, ${reviews.length} reviews, ${implements_.length} implements, ${workItems.length} work-items`);
  }

  return allWork.length;
}

// ─── Main Tick ──────────────────────────────────────────────────────────────

let tickCount = 0;

function tick() {
  const control = getControl();
  if (control.state !== 'running') return;

  const config = getConfig();
  tickCount++;

  // 1. Check for timed-out agents
  checkTimeouts(config);

  // 2. Consolidate inbox
  consolidateInbox(config);

  // 2.5. Periodic cleanup (every 10 ticks = ~10 minutes)
  if (tickCount % 10 === 0) {
    runCleanup(config);
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
      console.log('Engine is already running.');
      return;
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

    // Initial tick
    tick();

    // Start tick loop
    setInterval(tick, interval);
    console.log(`Tick interval: ${interval / 1000}s | Max concurrent: ${config.engine?.maxConcurrent || 3}`);
    console.log('Press Ctrl+C to stop');
  },

  stop() {
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
        const filePath = path.resolve(root, src.path);
        const exists = fs.existsSync(filePath);

        console.log(`  ${name}: ${status}`);
        console.log(`    Path: ${src.path} ${exists ? '(found)' : '(NOT FOUND)'}`);
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
        console.log('');
      }
    }
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
  console.log('  complete <id>    Mark dispatch as done');
  console.log('  cleanup           Clean temp files, worktrees, zombies');
  console.log('  mcp-sync         Sync MCP servers from ~/.claude.json');
  process.exit(1);
}
