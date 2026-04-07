#!/usr/bin/env node
/**
 * Minions Engine — Auto-assigning orchestrator
 *
 * Discovers work from configurable sources (PRD gaps, PR tracker, manual queue),
 * renders playbook templates with agent charters as system prompts, and spawns
 * isolated `claude` CLI processes in git worktrees.
 *
 * Usage:
 *   node .minions/engine.js              Start the engine (daemon mode)
 *   node .minions/engine.js status       Show current state
 *   node .minions/engine.js pause        Pause dispatching
 *   node .minions/engine.js resume       Resume dispatching
 *   node .minions/engine.js stop         Stop the engine
 *   node .minions/engine.js queue        Show dispatch queue
 *   node .minions/engine.js dispatch     Force a dispatch cycle
 *   node .minions/engine.js complete <id>  Mark dispatch as done
 *   node .minions/engine.js spawn <agent> <prompt>  Manually spawn an agent
 *   node .minions/engine.js work <title> [opts-json]  Add to work queue
 *   node .minions/engine.js sources      Show work source status
 *   node .minions/engine.js discover     Dry-run work discovery
 */

const fs = require('fs');
const path = require('path');
const shared = require('./engine/shared');
const { exec, execSilent, runFile, ENGINE_DEFAULTS: DEFAULTS,
  WI_STATUS, DONE_STATUSES, WORK_TYPE, PLAN_STATUS, PR_STATUS, DISPATCH_RESULT } = shared;
const queries = require('./engine/queries');

// ─── Paths ──────────────────────────────────────────────────────────────────

const MINIONS_DIR = __dirname;
const ROUTING_PATH = path.join(MINIONS_DIR, 'routing.md');
const PLAYBOOKS_DIR = path.join(MINIONS_DIR, 'playbooks');
const ARCHIVE_DIR = path.join(MINIONS_DIR, 'notes', 'archive');
const IDENTITY_DIR = path.join(MINIONS_DIR, 'identity');

// Re-export from queries for internal use (avoid changing every call site)
const { CONFIG_PATH, NOTES_PATH, AGENTS_DIR, ENGINE_DIR, CONTROL_PATH,
  DISPATCH_PATH, LOG_PATH, INBOX_DIR, KNOWLEDGE_DIR, PLANS_DIR, PRD_DIR } = queries;

// ─── Multi-Project Support ──────────────────────────────────────────────────
// Config can have either:
//   "project": { ... }           — single project (legacy, .minions inside repo)
//   "projects": [ { ... }, ... ] — multi-project (central .minions)
// Each project must have "localPath" pointing to the repo root.

function validateConfig(config) {
  let errors = 0;
  // Agents
  if (!config.agents || Object.keys(config.agents).length === 0) {
    console.error('FATAL: No agents defined in config.json');
    errors++;
  }
  // Projects (optional — engine works with central work items even without projects)
  const projects = getProjects(config);
  if (projects.length === 0) {
    console.log('  No projects linked — add one with: minions add <dir>');
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

const { getProjects, projectRoot, projectStateDir, projectWorkItemsPath, projectPrPath, getAdoOrgBase, sanitizeBranch, parseSkillFrontmatter, safeReadDir,
  ts, logTs, dateStamp, log } = shared;

// ─── Utilities ──────────────────────────────────────────────────────────────

const safeJson = shared.safeJson;
const safeRead = shared.safeRead;
const safeWrite = shared.safeWrite;
const mutateJsonFileLocked = shared.mutateJsonFileLocked;
const withFileLock = shared.withFileLock;

// ─── Dispatch Management (extracted to engine/dispatch.js) ───────────────────

const { mutateDispatch, addToDispatch, isRetryableFailureReason, completeDispatch,
  writeInboxAlert } = require('./engine/dispatch');

// ─── Timeout / Steering / Idle (extracted to engine/timeout.js) ──────────────

const { checkTimeouts, checkSteering, checkIdleThreshold } = require('./engine/timeout');

// ─── Cleanup (extracted to engine/cleanup.js) ────────────────────────────────

const { runCleanup } = require('./engine/cleanup');

// ─── State Readers (delegated to engine/queries.js) ─────────────────────────

const { getConfig, getControl, getDispatch, getNotes,
  getAgentStatus, getAgentCharter, getInboxFiles,
  collectSkillFiles, getSkillIndex, getKnowledgeBaseIndex,
  getPrs, SKILLS_DIR } = queries;

// ─── Routing (extracted to engine/routing.js) ───────────────────────────────

const { getRouting, parseRoutingTable, getRoutingTableCached, getMonthlySpend,
  getAgentErrorRate, isAgentIdle, resolveAgent, resetClaimedAgents,
  tempAgents } = require('./engine/routing');

// ─── Playbook, system prompt, agent context (extracted to engine/playbook.js) ─

const { renderPlaybook, buildSystemPrompt, buildAgentContext, selectPlaybook,
  buildBaseVars, buildPrDispatch, resolveTaskContext,
  getRepoHostLabel, getRepoHostToolRule } = require('./engine/playbook');

// sanitizeBranch imported from shared.js

// ─── Lifecycle (extracted to engine/lifecycle.js) ────────────────────────────

const { runPostCompletionHooks, updateWorkItemStatus, syncPrdItemStatus, handlePostMerge, checkPlanCompletion,
  syncPrsFromOutput, updatePrAfterReview, updatePrAfterFix, checkForLearnings, extractSkillsFromOutput,
  updateAgentHistory, updateMetrics, createReviewFeedbackForAuthor, parseAgentOutput, syncPrdFromPrs,
  isItemCompleted } = require('./engine/lifecycle');

// ─── Agent Spawner ──────────────────────────────────────────────────────────

const activeProcesses = new Map(); // dispatchId → { proc, agentId, startedAt }
// tempAgents imported from engine/routing.js
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
      if (!pr.branch || pr.status !== PR_STATUS.ACTIVE) continue;
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
  } catch (e) { log('warn', 'git: ' + e.message); }
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
  } catch (e) { log('warn', 'git: ' + e.message); }
}

function runWorktreeAdd(rootDir, worktreePath, args, gitOpts, worktreeCreateRetries) {
  let lastErr = null;
  const retries = Math.max(0, Number(worktreeCreateRetries) || 0);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        try { exec('git worktree prune', { ...gitOpts, cwd: rootDir, timeout: 15000 }); } catch (e) { log('warn', 'git: ' + e.message); }
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
  // meta.project has {name, localPath} — enrich with full config (mainBranch, repoHost, etc.)
  const metaProject = meta?.project || {};
  const fullProject = getProjects(config).find(p => p.name === metaProject.name || p.localPath === metaProject.localPath) || getProjects(config)[0] || {};
  const project = { ...fullProject, ...metaProject };
  const rootDir = project.localPath ? path.resolve(project.localPath) : path.resolve(MINIONS_DIR, '..');

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
      try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
      try { exec(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: existingWt }); } catch (e) { log('warn', 'git: ' + e.message); }
    } else if (['meeting', 'ask', 'explore'].includes(type)) {
      // Read-only tasks — no worktree needed, run in rootDir
      log('info', `${type}: read-only task, no worktree needed — running in rootDir`);
      branchName = null;
      worktreePath = null;
    } else {
      try {
        if (!fs.existsSync(worktreePath)) {
          const isSharedBranch = meta?.branchStrategy === 'shared-branch' || meta?.useExistingBranch;
          // Prune stale worktree entries before creating (handles leftover entries from crashed runs)
          try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
          // Remove stale index.lock before creating worktree (Windows crashes can leave this behind)
          removeStaleIndexLock(rootDir);

          if (isSharedBranch) {
            log('info', `Creating worktree for shared branch: ${worktreePath} on ${branchName}`);
            try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
            try {
              runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (eShared) {
              if (eShared.message?.includes('already used by worktree') || eShared.message?.includes('already checked out')) {
                const existingWtPath = findExistingWorktree(rootDir, branchName);
                if (existingWtPath && fs.existsSync(existingWtPath)) {
                  log('info', `Shared branch ${branchName} already checked out at ${existingWtPath} — reusing`);
                  worktreePath = existingWtPath;
                } else { throw eShared; }
              } else if (eShared.message?.includes('invalid reference') || eShared.message?.includes('not a valid ref')) {
                // Branch doesn't exist yet (first item in plan) — create it from main
                const mainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
                log('info', `Shared branch ${branchName} not found — creating from ${mainRef}`);
                runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, worktreeCreateRetries);
              } else { throw eShared; }
            }
          } else {
            log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
            const mainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
            try {
              runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (e1) {
              const branchExists = e1.message?.includes('already exists');
              log('warn', `Worktree -b failed for ${branchName}: ${e1.message?.split('\n')[0]}`);
              if (!branchExists) {
                // Transient error (lock, timeout) — prune, clean, and retry -b once more
                log('info', `Retrying -b create after prune for ${branchName}`);
                try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 15000 }); } catch { /* optional */ }
                removeStaleIndexLock(rootDir);
                // Clean up partial worktree directory from failed attempt
                try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* optional */ }
                try {
                  runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, 0);
                } catch (e1b) {
                  log('error', `Worktree -b retry also failed for ${branchName}: ${e1b.message?.split('\n')[0]}`);
                  throw e1b;
                }
              } else {
                // Branch already exists — try checkout without -b
                try { exec(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
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
                      // Bug fix: read dispatch under file lock so check-and-act is atomic
                      let activelyUsed = false;
                      mutateDispatch((dp) => {
                        activelyUsed = (dp.active || []).some(d => {
                          const dBranch = d.meta?.branch ? sanitizeBranch(d.meta.branch) : '';
                          return dBranch === branchName && d.id !== id;
                        });
                        return dp;
                      });
                      if (activelyUsed) {
                        log('warn', `Branch ${branchName} actively used by another agent at ${existingWtPath} — cannot create worktree`);
                        throw e2;
                      }
                      log('info', `Branch ${branchName} already checked out at ${existingWtPath} — reusing`);
                      worktreePath = existingWtPath;
                    } else if (existingWtPath && !fs.existsSync(existingWtPath)) {
                      log('warn', `Branch ${branchName} tracked in missing dir ${existingWtPath} — pruning and recreating`);
                      try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
                      runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                      log('info', `Recovered worktree for ${branchName} after stale entry prune`);
                    } else {
                      try { exec(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
                      runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                    }
                  } else {
                    throw e2;
                  }
                }
              }
            }
          }
        } else if (meta?.branchStrategy === 'shared-branch') {
          log('info', `Pulling latest on shared branch ${branchName}`);
          try { exec(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: worktreePath }); } catch (e) { log('warn', 'git: ' + e.message); }
        }
      } catch (err) {
        if (recoverPartialWorktree(rootDir, worktreePath, branchName, _gitOpts)) {
          cwd = worktreePath;
          log('warn', `Proceeding with recovered worktree after add failure for ${branchName}`);
        } else {
          log('error', `Failed to create worktree for ${branchName}: ${err.message}${err.stderr ? '\n' + err.stderr.toString().slice(0, 500) : ''}`);
          completeDispatch(id, DISPATCH_RESULT.ERROR, 'Worktree creation failed: ' + (err.message || '').slice(0, 200));
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

  // Safety check: warn if a write-capable task is running in the main repo without a worktree
  if (cwd === rootDir && [WORK_TYPE.IMPLEMENT, WORK_TYPE.IMPLEMENT_LARGE, WORK_TYPE.FIX, WORK_TYPE.TEST, WORK_TYPE.VERIFY, WORK_TYPE.PLAN_TO_PRD].includes(type)) {
    log('warn', `Agent ${agentId} running ${type} task in main repo (no worktree) for ${id} — changes may land on master directly`);
  }

  // Prepend bulk context to task prompt — keeps system prompt small and stable
  const fullTaskPrompt = agentContext
    ? `## Agent Context\n\n${agentContext}\n---\n\n## Your Task\n\n${taskPrompt}`
    : taskPrompt;

  // Write prompt and system prompt to temp files (avoids shell escaping issues)
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const safeId = id.replace(/[:\\/*?"<>|]/g, '-');
  const promptPath = path.join(tmpDir, `prompt-${safeId}.md`);
  safeWrite(promptPath, fullTaskPrompt);

  const sysPromptPath = path.join(tmpDir, `sysprompt-${safeId}.md`);
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

  // Session resume: reuse last session if same branch and recent enough (< 2 hours)
  let cachedSessionId = null;
  // Only resume when the context is relevant — same branch means the agent is
  // continuing work on the same PR/feature (e.g., author fixing their own build failure)
  if (!agentId.startsWith('temp-')) {
    try {
      const sessionFile = safeJson(path.join(AGENTS_DIR, agentId, 'session.json'));
      if (sessionFile?.sessionId && sessionFile.savedAt) {
        cachedSessionId = sessionFile.sessionId;
        const sessionAge = Date.now() - new Date(sessionFile.savedAt).getTime();
        const sameBranch = branchName && sessionFile.branch && sessionFile.branch === branchName;
        if (sessionAge < 2 * 60 * 60 * 1000 && sameBranch) {
          args.push('--resume', sessionFile.sessionId);
          log('info', `Resuming session ${sessionFile.sessionId} for ${agentId} on branch ${branchName} (age: ${Math.round(sessionAge / 60000)}min)`);
        }
      }
    } catch (e) { log('warn', 'session resume lookup: ' + e.message); }
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
    try { fs.appendFileSync(liveOutputPath, `[heartbeat] running — no output for ${silentSec}s\n`); } catch { /* optional */ }
  }, 30000);

  proc.stdout.on('data', (data) => {
    const chunk = data.toString();
    lastOutputAt = Date.now();
    if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
    try { fs.appendFileSync(liveOutputPath, chunk); } catch { /* optional */ }

    // Capture sessionId early for mid-session steering
    const procInfo = activeProcesses.get(id);
    if (procInfo && !procInfo.sessionId && chunk.includes('session_id')) {
      try {
        for (const line of chunk.split('\n')) {
          if (!line.trim() || !line.startsWith('{')) continue;
          const obj = JSON.parse(line);
          if (obj.session_id) {
            procInfo.sessionId = obj.session_id;
            safeWrite(path.join(AGENTS_DIR, agentId, 'session.json'), {
              sessionId: obj.session_id, dispatchId: id, savedAt: new Date().toISOString(), branch: branchName
            });
            break;
          }
        }
      } catch { /* JSON parse — output may not be valid JSON */ }
    }
  });

  proc.stderr.on('data', (data) => {
    const chunk = data.toString();
    lastOutputAt = Date.now();
    if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
    try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch { /* optional */ }
  });

  function onAgentClose(code) {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('info', `Agent ${agentId} (${id}) exited with code ${code}`);

    // Check if this was a steering kill — re-spawn with resume
    const procInfo = activeProcesses.get(id);
    if (procInfo?._steeringMessage) {
      const steerMsg = procInfo._steeringMessage;
      const steerSessionId = procInfo._steeringSessionId;
      delete procInfo._steeringMessage;
      delete procInfo._steeringSessionId;

      log('info', `Steering: re-spawning ${agentId} with --resume ${steerSessionId}`);

      // Write new prompt with steering message
      const steerPrompt = `Message from your human teammate:\n\n${steerMsg}\n\nRespond to this, then continue working on your current task.`;
      const steerPromptPath = path.join(ENGINE_DIR, 'tmp', `prompt-steer-${safeId}.md`);
      safeWrite(steerPromptPath, steerPrompt);

      // Build resume args
      const resumeArgs = [
        '--output-format', claudeConfig?.outputFormat || 'stream-json',
        '--max-turns', String(engineConfig?.maxTurns || DEFAULTS.maxTurns),
        '--verbose',
        '--permission-mode', claudeConfig?.permissionMode || 'bypassPermissions',
        '--resume', steerSessionId,
      ];
      if (claudeConfig?.allowedTools) resumeArgs.push('--allowedTools', claudeConfig.allowedTools);

      const spawnScript = path.join(ENGINE_DIR, 'spawn-agent.js');
      const childEnv = shared.cleanChildEnv();
      const resumeProc = runFile(process.execPath, [spawnScript, steerPromptPath, steerPromptPath, ...resumeArgs], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      });

      // Re-attach to existing tracking
      activeProcesses.set(id, { proc: resumeProc, agentId, startedAt: procInfo.startedAt, sessionId: steerSessionId });

      // Reset output buffers so post-completion parsing only sees the resumed session
      stdout = '';
      stderr = '';
      lastOutputAt = Date.now();

      // Re-wire stdout/stderr handlers (same as original)
      resumeProc.stdout.on('data', (data) => {
        const chunk = data.toString();
        lastOutputAt = Date.now();
        if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
        try { fs.appendFileSync(liveOutputPath, chunk); } catch { /* optional */ }
      });
      resumeProc.stderr.on('data', (data) => {
        const chunk = data.toString();
        lastOutputAt = Date.now();
        if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
        try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch { /* optional */ }
      });

      // Re-wire close handler for the resumed process
      resumeProc.on('close', (resumeCode) => {
        if (resumeCode !== 0) {
          // Resume failed — don't burn a retry slot. Complete the dispatch as success
          // (the original work was already done up to the kill point) and let the
          // work item be re-discovered on the next tick if still pending.
          log('warn', `Steering resume for ${agentId} exited with code ${resumeCode} — completing dispatch without error`);
          activeProcesses.delete(id);
          completeDispatch(id, DISPATCH_RESULT.SUCCESS, 'Steering resume failed but original work completed', '', { processWorkItemFailure: false });
          return;
        }
        // Successful resume — run normal close handler
        onAgentClose(resumeCode);
      });
      resumeProc.on('error', (err) => {
        log('warn', `Steering re-spawn error for ${agentId}: ${err.message}`);
        activeProcesses.delete(id);
        completeDispatch(id, DISPATCH_RESULT.SUCCESS, 'Steering re-spawn error but original work completed', '', { processWorkItemFailure: false });
      });

      // Don't run completion hooks — agent is still working
      return;
    }

    activeProcesses.delete(id);

    // If timeout checker already finalized this dispatch, don't overwrite work-item status again.
    // This avoids races where close-handler marks an auto-retried item as failed.
    const dispatchNow = getDispatch();
    const stillActive = (dispatchNow.active || []).some(d => d.id === id);
    if (!stillActive) {
      log('info', `Agent ${agentId} (${id}) close event ignored — dispatch already completed elsewhere`);
      try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }
      return;
    }

    // Save output — per-dispatch archive + latest symlink
    const outputContent = `# Output for dispatch ${id}\n# Exit code: ${code}\n# Completed: ${ts()}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}`;
    const archivePath = path.join(AGENTS_DIR, agentId, `output-${id}.log`);
    const latestPath = path.join(AGENTS_DIR, agentId, 'output.log');
    safeWrite(archivePath, outputContent);
    safeWrite(latestPath, outputContent); // overwrite latest for dashboard compat

    // Detect configuration errors (e.g. Claude CLI not found) — fail immediately with clear message
    if (code === 78) {
      const errMsg = stderr.includes('claude-code') ? stderr.trim() : 'Configuration error — Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code';
      log('error', `Agent ${agentId} (${id}) failed: ${errMsg}`);
      completeDispatch(id, DISPATCH_RESULT.ERROR, errMsg, '');
      try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }
      return;
    }

    // Parse output and run all post-completion hooks
    const { resultSummary, autoRecovered } = runPostCompletionHooks(dispatchItem, agentId, code, stdout, config);

    // Move from active to completed in dispatch (single source of truth for agent status)
    // autoRecovered: agent failed (e.g. heartbeat timeout) but created PRs — treat as success
    const effectiveResult = (code === 0 || autoRecovered) ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;
    completeDispatch(id, effectiveResult, '', resultSummary);

    // Cleanup temp files (including PID file now that dispatch is complete)
    try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
    try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
    try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }

    log('info', `Agent ${agentId} completed. Output saved to ${archivePath}`);

    // Clean up temp agent directory
    if (tempAgents.has(agentId)) {
      tempAgents.delete(agentId);
      try {
        const agentDir = path.join(AGENTS_DIR, agentId);
        // Keep output archive but remove temp agent directory (live-output.log etc.)
        fs.rmSync(agentDir, { recursive: true, force: true });
        log('info', `Temp agent ${agentId} cleaned up`);
      } catch { /* cleanup */ }
    }
  }

  proc.on('close', onAgentClose);

  proc.on('error', (err) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('error', `Failed to spawn agent ${agentId}: ${err.message}`);
    activeProcesses.delete(id);
    completeDispatch(id, DISPATCH_RESULT.ERROR, `Spawn error: ${err.message}`);
  });

  // Safety: if process exits immediately (within 3s), log it
  setTimeout(() => {
    if (proc.exitCode !== null && !proc.killed) {
      log('warn', `Agent ${agentId} (${id}) exited within 3s with code ${proc.exitCode}`);
    }
  }, 3000);

  // Track process — even if PID isn't available yet (async on Windows)
  activeProcesses.set(id, { proc, agentId, startedAt, sessionId: cachedSessionId });

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
    if (idx < 0) return dispatch;
    const item = dispatch.pending.splice(idx, 1)[0];
    item.started_at = startedAt;
    delete item.skipReason;
    if (!dispatch.active.some(d => d.id === id)) {
      dispatch.active.push(item);
    }
    return dispatch;
  });

  return proc;
}

// addToDispatch, isRetryableFailureReason — now in engine/dispatch.js

// completeDispatch — now in engine/dispatch.js

// ─── Dependency Gate ─────────────────────────────────────────────────────────
// Returns: true (deps met), false (deps pending), WI_STATUS.FAILED (dep failed — propagate)
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
    } catch (e) { log('warn', 'read project work items for deps: ' + e.message); }
  }
  // PRD item statuses that count as "done" for dep resolution
  const PRD_MET_STATUSES = DONE_STATUSES;

  for (const depId of deps) {
    const depItem = allWorkItems.find(w => w.id === depId);
    if (!depItem) {
      // Fallback: check PRD JSON — plan-to-prd agents may pre-set items to done
      try {
        const plan = safeJson(path.join(PRD_DIR, sourcePlan));
        const prdItem = (plan?.missing_features || []).find(f => f.id === depId);
        if (prdItem && PRD_MET_STATUSES.has(prdItem.status)) continue; // PRD says done — treat as met
      } catch (e) { log('warn', 'check PRD dep status: ' + e.message); }
      log('warn', `Dependency ${depId} not found for ${item.id} (plan: ${sourcePlan}) — treating as unmet`);
      return false;
    }
    if (depItem.status === WI_STATUS.FAILED) return WI_STATUS.FAILED;
    if (!PRD_MET_STATUSES.has(depItem.status)) return false; // Pending, dispatched, or retrying — wait (legacy aliases accepted)
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


// writeInboxAlert — now in engine/dispatch.js

// Reconciles work items against known PRs.
// Primary linkage comes from prdItems in pull-requests.json; fallback linkage
// uses engine/pr-links.json so matching does not depend on branch/title parsing.
// onlyIds: if provided, only items whose ID is in this Set are eligible.
function reconcileItemsWithPrs(items, allPrs, { onlyIds } = {}) {
  const prLinks = shared.getPrLinks();
  let reconciled = 0;
  for (const wi of items) {
    if (wi.status !== WI_STATUS.PENDING || wi._pr) continue;
    if (onlyIds && !onlyIds.has(wi.id)) continue;

    let exactPr = allPrs.find(pr => (pr.prdItems || []).includes(wi.id));
    if (!exactPr) {
      const linkedPrId = Object.keys(prLinks).find(prId => prLinks[prId] === wi.id);
      if (linkedPrId) exactPr = allPrs.find(pr => pr.id === linkedPrId) || { id: linkedPrId };
    }
    if (exactPr) {
      wi.status = WI_STATUS.DONE;
      wi._pr = exactPr.id;
      reconciled++;
    }
  }
  return reconciled;
}

// ─── Inbox Consolidation (extracted to engine/consolidation.js) ──────────────

const { consolidateInbox } = require('./engine/consolidation');
const { pollPrStatus, pollPrHumanComments, reconcilePrs, checkLiveReviewStatus: adoCheckLiveReview } = require('./engine/ado');
const { pollPrStatus: ghPollPrStatus, pollPrHumanComments: ghPollPrHumanComments, reconcilePrs: ghReconcilePrs, checkLiveReviewStatus: ghCheckLiveReview } = require('./engine/github');

// ─── State Snapshot ─────────────────────────────────────────────────────────

function updateSnapshot(config) {
  const dispatch = getDispatch();
  const agents = config.agents || {};
  const projects = getProjects(config);

  let snapshot = `# Minions State — ${ts()}\n\n`;
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

// checkIdleThreshold, checkSteering, checkTimeouts — now in engine/timeout.js

// runCleanup — now in engine/cleanup.js

// ─── Cooldowns (extracted to engine/cooldown.js) ─────────────────────────────

const { COOLDOWN_PATH, dispatchCooldowns, loadCooldowns, saveCooldowns,
  isOnCooldown, setCooldown, setCooldownWithContext, getCoalescedContexts,
  setCooldownFailure, isAlreadyDispatched } = require('./engine/cooldown');



/**
 * Scan ~/.minions/plans/ for plan-generated PRD files → queue implement tasks.
 * Plans are project-scoped JSON files written by the plan-to-prd playbook.
 */
/**
 * Convert plan files into project work items (side-effect, like specs).
 * Plans write to the target project's work-items.json — picked up by discoverFromWorkItems next tick.
 */
// Auto-clean pending/failed work items for a PRD so they re-materialize with updated plan data
function autoCleanPrdWorkItems(prdFile, config) {
  const allProjects = getProjects(config);
  const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
  for (const proj of allProjects) wiPaths.push(projectWorkItemsPath(proj));
  const deletedIds = [];
  for (const wiPath of wiPaths) {
    try {
      const peek = safeJson(wiPath);
      if (!peek) continue;
      const hasMatch = peek.some(w => w.sourcePlan === prdFile && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.FAILED));
      if (hasMatch) {
        mutateJsonFileLocked(wiPath, (items) => {
          return items.filter(w => {
            if (w.sourcePlan === prdFile && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.FAILED)) {
              deletedIds.push(w.id); return false;
            }
            return true;
          });
        }, { defaultValue: [] });
      }
    } catch (e) { log('warn', 'auto-clean PRD work items: ' + e.message); }
  }
  if (deletedIds.length > 0) {
    const deletedSet = new Set(deletedIds);
    mutateDispatch((dispatch) => {
      const pred = d => deletedSet.has(d.meta?.item?.id) && d.meta?.item?.sourcePlan === prdFile;
      for (const queue of ['pending', 'active', 'completed']) {
        if (!Array.isArray(dispatch[queue])) continue;
        dispatch[queue] = dispatch[queue].filter(d => !pred(d));
      }
      return dispatch;
    });
    log('info', `Plan sync: cleared ${deletedIds.length} pending/failed work items for ${prdFile}`);
  }
}

function materializePlansAsWorkItems(config) {
  if (!fs.existsSync(PRD_DIR)) { try { fs.mkdirSync(PRD_DIR, { recursive: true }); } catch (e) { log('warn', 'create PRD directory: ' + e.message); } }

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
            try { fs.unlinkSync(path.join(checkDir, mf)); } catch { /* cleanup */ }
            log('info', `Plan enforcement: moved ${mf} → prd/${jsonName} (PRDs must be .json in prd/)`);
          }
        } catch {} // Not JSON — it's a proper plan .md, leave it
      }
    } catch (e) { log('warn', 'scan .md files for PRD enforcement: ' + e.message); }
    // Also migrate any .json PRD files from plans/ to prd/
    if (checkDir === PLANS_DIR) {
      try {
        const jsonInPlans = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json'));
        for (const jf of jsonInPlans) {
          try {
            const parsed = safeJson(path.join(PLANS_DIR, jf));
            if (parsed?.missing_features) {
              safeWrite(path.join(PRD_DIR, jf), parsed);
              try { fs.unlinkSync(path.join(PLANS_DIR, jf)); } catch { /* cleanup */ }
              log('info', `Auto-migrated PRD ${jf} from plans/ to prd/`);
            }
          } catch (e) { log('warn', 'migrate PRD from plans: ' + e.message); }
        }
      } catch (e) { log('warn', 'scan JSON in plans dir: ' + e.message); }
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
          const baselineMtime = new Date(sourceMtime).toISOString();
          mutateJsonFileLocked(path.join(PRD_DIR, file), (p) => {
            p.sourcePlanModifiedAt = baselineMtime;
            return p;
          });
        } else if (sourceMtime > recorded) {
          // Source plan changed — auto-clean pending/failed items so they re-materialize with updated data
          log('info', `Source plan ${plan.source_plan} updated — re-syncing PRD ${file}`);
          autoCleanPrdWorkItems(file, config);
          plan.sourcePlanModifiedAt = new Date(sourceMtime).toISOString();
          plan.lastSyncedFromPlan = new Date().toISOString();

          // Handle PRD based on current status
          const prdStatus = plan.status || (plan.requires_approval ? PLAN_STATUS.AWAITING_APPROVAL : null);

          // Approved/executing PRDs: flag as stale but don't disrupt in-flight work
          if (prdStatus === PLAN_STATUS.APPROVED || prdStatus === PLAN_STATUS.COMPLETED) {
            plan.planStale = true;
            log('info', `PRD ${file} flagged as stale (plan revised while ${prdStatus}) — user can regenerate from dashboard`);
          }

          // Awaiting-approval PRDs: invalidate, carry over completed items, delete old PRD, queue regeneration
          if (prdStatus === PLAN_STATUS.AWAITING_APPROVAL) {
            log('info', `PRD ${file} invalidated (was awaiting-approval) — queuing regeneration from revised plan`);

            // Collect completed items to carry over to new PRD
            const completedStatuses = DONE_STATUSES; // includes legacy aliases for backward compat
            const completedItems = (plan.missing_features || [])
              .filter(f => completedStatuses.has(f.status))
              .map(f => ({ id: f.id, name: f.name, status: f.status }));

            const completedContext = completedItems.length > 0
              ? `\nPreviously completed items (preserve their status in the new PRD):\n${completedItems.map(i => `- ${i.id}: ${i.name} [${i.status}]`).join('\n')}`
              : '';

            // Delete old PRD — agent will write replacement at same path
            try { fs.unlinkSync(path.join(PRD_DIR, file)); } catch { /* cleanup */ }

            // Queue plan-to-prd regeneration
            const planContent = safeRead(path.join(PLANS_DIR, plan.source_plan));
            if (planContent) {
              const projectName = plan.project || file.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
              const allProjects = getProjects(config);
              const targetProject = allProjects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) || allProjects[0];
              if (targetProject) {
                const centralWiPath = path.join(MINIONS_DIR, 'work-items.json');
                const newItem = {
                  id: 'W-' + shared.uid(),
                  title: `Regenerate PRD from revised plan: ${plan.source_plan}`,
                  type: WORK_TYPE.PLAN_TO_PRD,
                  priority: 'high',
                  description: `Plan file: plans/${plan.source_plan}\nTarget PRD filename: ${file}\nSource plan was revised while PRD was awaiting approval — regenerating.${completedContext}`,
                  status: WI_STATUS.PENDING,
                  created: ts(),
                  createdBy: 'engine:plan-revision',
                  project: targetProject.name,
                  planFile: plan.source_plan,
                  _targetPrdFile: file,
                };
                mutateJsonFileLocked(centralWiPath, (items) => {
                  const alreadyQueued = items.some(w =>
                    w.type === WORK_TYPE.PLAN_TO_PRD && w.planFile === plan.source_plan && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.DISPATCHED)
                  );
                  if (!alreadyQueued) items.push(newItem);
                  return items;
                }, { defaultValue: [] });
                log('info', `Queued plan-to-prd regeneration for revised plan ${plan.source_plan} (${completedItems.length} completed items to carry over)`);
              }
            }
            continue; // Old PRD deleted — skip safeWrite below
          }

          const updatedMtime = plan.sourcePlanModifiedAt;
          const syncTs = plan.lastSyncedFromPlan;
          const isStale = plan.planStale;
          mutateJsonFileLocked(path.join(PRD_DIR, file), (p) => {
            p.sourcePlanModifiedAt = updatedMtime;
            p.lastSyncedFromPlan = syncTs;
            if (isStale) p.planStale = true;
            return p;
          });
        }
      } catch (e) { log('warn', 'plan staleness check: ' + e.message); }
    }

    // Human approval gate: plans start as 'awaiting-approval' and must be approved before work begins
    // Plans without a status (legacy) or with status 'approved' are allowed through
    const planStatus = plan.status || (plan.requires_approval ? PLAN_STATUS.AWAITING_APPROVAL : null);
    if (planStatus === PLAN_STATUS.AWAITING_APPROVAL) {
      if (config.engine?.autoApprovePlans) {
        const approvedAt = new Date().toISOString();
        mutateJsonFileLocked(path.join(PRD_DIR, file), (p) => {
          p.status = PLAN_STATUS.APPROVED;
          p.approvedAt = approvedAt;
          p.approvedBy = 'auto-mode';
          return p;
        });
        plan.status = PLAN_STATUS.APPROVED; // keep in-memory copy in sync for rest of loop
        log('info', `Auto-approved plan: ${file}`);
      } else {
        continue; // Skip — waiting for human approval
      }
    }
    if (planStatus === PLAN_STATUS.PAUSED || planStatus === PLAN_STATUS.REJECTED || planStatus === PLAN_STATUS.REVISION_REQUESTED) {
      continue; // Skip — paused or revision requested
    }
    // Stale PRDs: source plan was revised — don't materialize NEW items until user regenerates
    if (plan.planStale) {
      continue;
    }

    const defaultProjectName = plan.project || file.replace(/-\d{4}-\d{2}-\d{2}\.json$/, '');
    const allProjects = getProjects(config);
    const defaultProject = allProjects.find(p => p.name?.toLowerCase() === defaultProjectName.toLowerCase());
    // No project found — use central work-items.json (engine works without projects)
    const useCentral = !defaultProject;

    const statusFilter = ['missing', 'planned'];
    // Also materialize in-pr/done items that never got a work item (race with PR status sync)
    const allExistingWiIds = new Set();
    for (const p of allProjects) {
      for (const w of (safeJson(projectWorkItemsPath(p)) || [])) {
        if (w.id) allExistingWiIds.add(w.id);
      }
    }
    // Also check central work-items.json
    for (const w of (safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [])) {
      if (w.id) allExistingWiIds.add(w.id);
    }
    const items = plan.missing_features.filter(f =>
      statusFilter.includes(f.status) ||
      (DONE_STATUSES.has(f.status) && f.id && !allExistingWiIds.has(f.id))
    );

    // Group items by target project (per-item project field overrides plan-level project)
    // When no projects are configured, all items go to central work-items.json
    const itemsByProject = new Map(); // projectName -> { project, items: [] }
    for (const item of items) {
      if (useCentral) {
        if (!itemsByProject.has('_central')) itemsByProject.set('_central', { project: null, items: [] });
        itemsByProject.get('_central').items.push(item);
      } else {
        const itemProjectName = item.project || defaultProjectName;
        const itemProject = allProjects.find(p => p.name?.toLowerCase() === itemProjectName.toLowerCase()) || defaultProject;
        if (!itemProject) continue;
        if (!itemsByProject.has(itemProject.name)) {
          itemsByProject.set(itemProject.name, { project: itemProject, items: [] });
        }
        itemsByProject.get(itemProject.name).items.push(item);
      }
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
      const wiPath = project ? projectWorkItemsPath(project) : path.join(MINIONS_DIR, 'work-items.json');
      // Pre-check: collect IDs already materialized across all projects
      const allExistingIds = new Set();
      for (const p of allProjects) {
        for (const w of (safeJson(projectWorkItemsPath(p)) || [])) {
          if (w.id) allExistingIds.add(w.id);
        }
      }
      for (const w of (safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [])) {
        if (w.id) allExistingIds.add(w.id);
      }

      // Build new items to add
      const newItems = [];
      const newlyCreatedIds = new Set();
      for (const item of projItems) {
        if (allExistingIds.has(item.id)) continue;
        if (cycleSet.has(item.id)) continue;

        const id = item.id;
        const complexity = item.estimated_complexity || 'medium';
        const criteria = (item.acceptance_criteria || []).map(c => `- ${c}`).join('\n');

        newItems.push({
          id,
          title: `Implement: ${item.name}`,
          type: complexity === 'large' ? WORK_TYPE.IMPLEMENT_LARGE : WORK_TYPE.IMPLEMENT,
          priority: item.priority || 'medium',
          description: `${item.description || ''}\n\n**Plan:** ${file}\n**Plan Item:** ${item.id}\n**Complexity:** ${complexity}${criteria ? '\n\n**Acceptance Criteria:**\n' + criteria : ''}`,
          status: WI_STATUS.PENDING,
          created: ts(),
          createdBy: 'engine:plan-discovery',
          sourcePlan: file,
          depends_on: item.depends_on || [],
          branchStrategy: plan.branch_strategy || 'parallel',
          featureBranch: plan.feature_branch || null,
          project: item.project || plan.project || null,
        });
        newlyCreatedIds.add(id);
      }

      if (newItems.length > 0) {
        const currentPrdIds = new Set(plan.missing_features.map(f => f.id));
        const allPrsForReconcile = allProjects.flatMap(p => safeJson(projectPrPath(p)) || []);

        mutateJsonFileLocked(wiPath, (existingItems) => {
          // Add new items (re-check dedup inside lock)
          for (const ni of newItems) {
            if (!existingItems.some(w => w.id === ni.id)) existingItems.push(ni);
          }

          // Reconciliation: exact prdItems match only, scoped to newly created items
          const reconciled = reconcileItemsWithPrs(existingItems, allPrsForReconcile, { onlyIds: newlyCreatedIds });
          if (reconciled > 0) log('info', `Plan reconciliation: marked ${reconciled} item(s) as done → ${projName}`);

          // PRD removal sync: cancel pending work items whose PRD item was removed from the plan
          let cancelled = 0;
          for (const wi of existingItems) {
            if (wi.status !== WI_STATUS.PENDING || wi.sourcePlan !== file) continue;
            if (!currentPrdIds.has(wi.id)) {
              wi.status = WI_STATUS.CANCELLED;
              wi.cancelledAt = ts();
              wi.cancelReason = `PRD item removed from ${file}`;
              cancelled++;
            }
          }
          if (cancelled > 0) log('info', `Plan sync: cancelled ${cancelled} item(s) removed from ${file} → ${projName}`);

          return existingItems;
        }, { defaultValue: [] });
        log('info', `Plan discovery: created ${newItems.length} work item(s) from ${file} → ${projName}`);
      }
      totalCreated += created;
    }

    if (totalCreated > 0) {
      log('info', `Plan discovery: ${totalCreated} total item(s) from ${file} across ${itemsByProject.size} project(s)`);

      // Pre-create shared feature branch if branch_strategy is shared-branch
      if (plan.branch_strategy === 'shared-branch' && plan.feature_branch) {
        try {
          const firstProject = itemsByProject.values().next().value?.project;
          if (!firstProject?.localPath) throw new Error('no project with localPath');
          const root = path.resolve(firstProject.localPath);
          const mainBranch = shared.resolveMainBranch(root, firstProject.mainBranch);
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

// buildBaseVars, selectPlaybook, buildPrDispatch extracted to engine/playbook.js

function clearPendingHumanFeedbackFlag(projectMeta, prId) {
  if (!prId) return;
  try {
    const prsPath = projectPrPath(projectMeta);
    mutateJsonFileLocked(prsPath, (prs) => {
      const target = prs.find(p => p.id === prId);
      if (target?.humanFeedback?.pendingFix) target.humanFeedback.pendingFix = false;
      return prs;
    }, { defaultValue: [] });
  } catch (e) { log('warn', 'clear pending human feedback flag: ' + e.message); }
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

  const knownAgents = new Set(Object.keys(config.agents || {}));
  for (const pr of prs) {
    if (pr.status !== 'active') continue;
    if (activePrIds.has(pr.id)) continue; // Skip PRs with active dispatch (prevent race)
    // Skip human-authored PRs not linked to any work item — only auto-manage agent PRs
    // Manually-linked PRs with autoObserve are allowed through (they have _autoObserve flag)
    const isAgentPr = knownAgents.has((pr.agent || '').toLowerCase()) || (pr.prdItems && pr.prdItems.length > 0) || pr._autoObserve;
    if (!isAgentPr) continue;

    const prNumber = (pr.id || '').replace(/^PR-/, '');
    // Use reviewStatus as single source of truth (synced from ADO/GitHub votes)
    // minionsReview tracks metadata (reviewer, note) but not the authoritative status
    const reviewStatus = pr.reviewStatus || 'pending';

    // Skip fix dispatch if a fix was recently submitted and awaiting re-review.
    // The poller holds reviewStatus at 'waiting' until the reviewer acts on the new code.
    const awaitingReReview = reviewStatus === 'waiting' && !!pr.minionsReview?.fixedAt;

    // PRs needing review: pending review status and not already reviewed without new commits
    const autoReview = config.engine?.autoReview !== false;
    // Skip re-dispatch if already reviewed and no new commits pushed since last review
    const alreadyReviewed = pr.lastReviewedAt && (!pr.lastPushedAt || pr.lastPushedAt <= pr.lastReviewedAt);
    const needsReview = autoReview && reviewStatus === 'pending' && !alreadyReviewed;
    if (needsReview) {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      // Pre-dispatch live vote check — cached reviewStatus may be stale (poll lag ~6 min)
      try {
        const checkFn = project.repoHost === 'github' ? ghCheckLiveReview : adoCheckLiveReview;
        const liveStatus = checkFn(pr, project);
        if (liveStatus && liveStatus !== 'pending') {
          log('info', `Pre-dispatch vote check: ${pr.id} is ${liveStatus} (cached was pending) — skipping review`);
          pr.reviewStatus = liveStatus;
          // Persist so next tick doesn't re-check
          try {
            mutateJsonFileLocked(projectPrPath(project), data => {
              if (!Array.isArray(data)) return data;
              const target = data.find(p => p.id === pr.id);
              if (target) target.reviewStatus = liveStatus;
              return data;
            });
          } catch {}
          continue;
        }
      } catch (e) { log('warn', `Pre-dispatch vote check for ${pr.id}: ${e.message}`); }

      const agentId = resolveAgent('review', config);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'review', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        pr_author: pr.agent || '', pr_url: pr.url || '',
      }, `Review PR ${pr.id}: ${pr.title}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

    // PRs with changes requested → route back to author for fix
    if (reviewStatus === 'changes-requested' && !awaitingReReview) {
      const key = `fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: pr.minionsReview?.note || pr.reviewNote || 'See PR thread comments',
      }, `Fix PR ${pr.id} review feedback`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

    // PRs with pending human feedback (or coalesced comments from while agent was fixing)
    const humanFixKey = `human-fix-${project?.name || 'default'}-${pr.id}`;
    const hasCoalescedFeedback = (dispatchCooldowns.get(humanFixKey)?.pendingContexts || []).length > 0;
    if ((pr.humanFeedback?.pendingFix || hasCoalescedFeedback) && !awaitingReReview) {
      const key = humanFixKey;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) {
        // Coalesce: save feedback for next dispatch
        if (pr.humanFeedback?.feedbackContent) {
          setCooldownWithContext(key, { feedbackContent: pr.humanFeedback.feedbackContent, timestamp: new Date().toISOString() });
        }
        continue;
      }
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const coalesced = getCoalescedContexts(key);
      let reviewNote = pr.humanFeedback.feedbackContent || 'See PR thread comments';
      if (coalesced.length > 0) {
        const earlier = coalesced.map(c => c.feedbackContent).filter(Boolean).join('\n\n---\n\n');
        if (earlier) reviewNote = earlier + '\n\n---\n\n' + reviewNote;
      }

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_number: prNumber, pr_title: pr.title || '', pr_branch: pr.branch || '',
        reviewer: 'Human Reviewer',
        review_note: reviewNote,
      }, `Fix PR ${pr.id} — human feedback`, { dispatchKey: key, source: 'pr-human-feedback', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }
    }

    // PRs with build failures — route to author (has session context from implementing)
    if (pr.status === PR_STATUS.ACTIVE && pr.buildStatus === 'failing') {
      const key = `build-fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: `Build is failing: ${pr.buildFailReason || 'Check CI pipeline for details'}. Fix the build errors and push.`,
      }, `Fix build failure on PR ${pr.id}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); }

      // Notify the author agent about the build failure
      if (pr.agent && !pr._buildFailNotified) {
        writeInboxAlert(`build-fail-${pr.agent}-${pr.id}`,
          `# Build Failure Notification\n\n` +
          `**Your PR ${pr.id}** on branch \`${pr.branch || 'unknown'}\` has a failing build.\n` +
          `**Reason:** ${pr.buildFailReason || 'Check CI pipeline for details'}\n\n` +
          `A fix agent has been dispatched to address this. Review the fix when complete.\n`
        );
        // Mark notified to prevent duplicate alerts
        try {
          const prPath = projectPrPath(project);
          mutateJsonFileLocked(prPath, (prs) => {
            const target = prs.find(p => p.id === pr.id);
            if (target) target._buildFailNotified = true;
            return prs;
          }, { defaultValue: [] });
        } catch (e) { log('warn', 'mark build fail notified: ' + e.message); }
      }
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

  const root = project?.localPath ? path.resolve(project.localPath) : path.resolve(MINIONS_DIR, '..');
  const items = safeJson(projectWorkItemsPath(project)) || [];
  const cooldownMs = (src.cooldownMinutes || 0) * 60 * 1000;
  const newWork = [];
  const prdSyncQueue = [];
  const skipped = { gated: 0, noAgent: 0 };
  let needsWrite = false;

  for (const item of items) {
    try {
    // Re-evaluate failed items: if deps have recovered, reset to pending
    if (item.status === WI_STATUS.FAILED && !isItemCompleted(item) && item.failReason === 'Dependency failed — cannot proceed') {
      const depStatus = areDependenciesMet(item, config);
      if (depStatus === true) {
        item.status = WI_STATUS.PENDING;
        delete item.failReason;
        log('info', `Recovered ${item.id} from dependency failure — deps now met`);
        needsWrite = true;
      }
    }

    if (item.status !== WI_STATUS.QUEUED && item.status !== WI_STATUS.PENDING) continue;

    // Dependency gate: skip items whose depends_on are not yet met; propagate failure
    if (item.depends_on && item.depends_on.length > 0) {
      const depStatus = areDependenciesMet(item, config);
      if (depStatus === WI_STATUS.FAILED && !isItemCompleted(item)) {
        item.status = WI_STATUS.FAILED;
        item.failReason = 'Dependency failed — cannot proceed';
        delete item._pendingReason;
        log('warn', `Marking ${item.id} as failed: dependency failed (plan: ${item.sourcePlan})`);
        needsWrite = true;
        continue;
      }
      if (!depStatus) {
        if (item._pendingReason !== 'dependency_unmet') { item._pendingReason = 'dependency_unmet'; needsWrite = true; }
        continue;
      }
    }

    const key = `work-${project?.name || 'default'}-${item.id}`;
    // Self-heal: if an item is pending, stale completed/cooldown markers must not gate redispatch.
    // This protects against persisted state drift from old runtime versions.
    try {
      mutateDispatch((dp) => {
        const prev = Array.isArray(dp.completed) ? dp.completed : [];
        const next = [];
        for (let i = 0; i < prev.length; i++) {
          if (prev[i].meta?.dispatchKey !== key) next.push(prev[i]);
        }
        dp.completed = next;
        return dp;
      });
      dispatchCooldowns.delete(key);
    } catch (e) { log('warn', 'self-heal dispatch state: ' + e.message); }
    // Cooldown bypass for resumed items — clear in-memory cooldown so they dispatch immediately
    if (item._resumedAt) {
      dispatchCooldowns.delete(key);
      delete item._resumedAt;
      mutateJsonFileLocked(projectWorkItemsPath(project), (freshItems) => {
        const wi = freshItems.find(i => i.id === item.id);
        if (wi) delete wi._resumedAt;
        return freshItems;
      }, { defaultValue: [] });
    }
    if (isAlreadyDispatched(key)) {
      if (item.status === WI_STATUS.PENDING) { item.status = WI_STATUS.DISPATCHED; needsWrite = true; }
      if (item._pendingReason !== 'already_dispatched') { item._pendingReason = 'already_dispatched'; needsWrite = true; }
      skipped.gated++; continue;
    }
    if (isOnCooldown(key, cooldownMs)) {
      if (item._pendingReason !== 'cooldown') { item._pendingReason = 'cooldown'; needsWrite = true; }
      skipped.gated++; continue;
    }

    let workType = item.type || WORK_TYPE.IMPLEMENT;
    if (workType === WORK_TYPE.IMPLEMENT && (item.complexity === 'large' || item.estimated_complexity === 'large')) {
      workType = WORK_TYPE.IMPLEMENT_LARGE;
    }
    // Auto-decompose large items before implementation
    if (workType === WORK_TYPE.IMPLEMENT_LARGE && !item._decomposed && !item._decomposing && config.engine?.autoDecompose !== false) {
      workType = WORK_TYPE.DECOMPOSE;
      item._decomposing = true;
      needsWrite = true;
    }
    const agentId = item.agent || resolveAgent(workType, config);
    if (!agentId) {
      // Check if reason is budget
      const cfgAgents = config.agents || {};
      const budgetBlocked = Object.keys(cfgAgents).some(id => {
        const b = cfgAgents[id].monthlyBudgetUsd;
        return b && b > 0 && getMonthlySpend(id) >= b && isAgentIdle(id);
      });
      if (budgetBlocked) {
        if (item._pendingReason !== 'budget_exceeded') { item._pendingReason = 'budget_exceeded'; needsWrite = true; }
      } else {
        if (item._pendingReason !== 'no_agent') { item._pendingReason = 'no_agent'; needsWrite = true; }
      }
      skipped.noAgent++; continue;
    }

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
      source_plan: item.sourcePlan || '',
      plan_slug: (item.sourcePlan || '').replace('.json', ''),
      additional_context: item.prompt ? `## Additional Context\n\n${item.prompt}` : '',
      scope_section: `## Scope: Project — ${project?.name || 'default'}\n\nThis task is scoped to a single project.`,
      branch_name: branchName,
      project_path: root,
      worktree_path: path.resolve(root, config.engine?.worktreeRoot || '../worktrees', `${branchName}`),
      commit_message: item.commitMessage || `feat: ${item.title || item.id}`,
      notes_content: '',
    };
    try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }

    // Inject references and acceptance criteria
    const refs = (item.references || []).filter(r => r && r.url).map(r =>
      '- [' + (r.title || r.url) + '](' + r.url + ')' + (r.type ? ' (' + r.type + ')' : '')
    ).join('\n');
    vars.references = refs ? '## References\n\n' + refs : '';
    const ac = normalizeAc(item.acceptanceCriteria).map(c => '- [ ] ' + c).join('\n');
    vars.acceptance_criteria = ac ? '## Acceptance Criteria\n\n' + ac : '';

    // Inject checkpoint context if agent left a checkpoint.json from a prior run
    vars.checkpoint_context = '';
    try {
      const wtPath = vars.worktree_path || root;
      const cpPath = path.join(wtPath, 'checkpoint.json');
      if (fs.existsSync(cpPath)) {
        const cpData = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        const cpCount = (item._checkpointCount || 0) + 1;
        if (cpCount > 3) {
          log('warn', `Work item ${item.id} exceeded 3 checkpoint-resumes — marking as needs-human-review`);
          item.status = WI_STATUS.NEEDS_REVIEW;
          item._checkpointCount = cpCount;
          needsWrite = true;
          continue;
        }
        item._checkpointCount = cpCount;
        needsWrite = true;
        const cpSummary = [
          `## Checkpoint (Resume #${cpCount}/3)`,
          '',
          'A previous agent run timed out but left a checkpoint. Continue from where it left off.',
          '',
          cpData.completed && cpData.completed.length > 0 ? `### Completed\n${cpData.completed.map(s => '- ' + s).join('\n')}` : '',
          cpData.remaining && cpData.remaining.length > 0 ? `### Remaining\n${cpData.remaining.map(s => '- ' + s).join('\n')}` : '',
          cpData.blockers && cpData.blockers.length > 0 ? `### Blockers\n${cpData.blockers.map(s => '- ' + s).join('\n')}` : '',
          cpData.branch_state ? `### Branch State\n${cpData.branch_state}` : '',
        ].filter(Boolean).join('\n');
        vars.checkpoint_context = cpSummary;
        log('info', `Injecting checkpoint context for ${item.id} (resume #${cpCount})`);
      }
    } catch (e) { log('warn', `checkpoint read for ${item.id}: ${e.message}`); }

    // Inject ask-specific variables for the ask playbook
    if (workType === WORK_TYPE.ASK) {
      vars.question = item.title + (item.description ? '\n\n' + item.description : '');
      vars.task_id = item.id;
      vars.notes_content = '';
      try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }
    }

    // Resolve implicit context references (e.g., "ripley's plan", "the latest plan")
    const resolvedCtx = resolveTaskContext(item, config);
    if (resolvedCtx.additionalContext) {
      vars.additional_context = (vars.additional_context || '') + resolvedCtx.additionalContext;
      vars.task_description = vars.task_description + resolvedCtx.additionalContext;
    }

    const playbookName = selectPlaybook(workType, item);
    if (playbookName === 'work-item' && workType === WORK_TYPE.REVIEW) {
      log('info', `Work item ${item.id} is type "review" but has no PR — using work-item playbook`);
    }
    const prompt = item.prompt || renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars) || item.description;
    if (!prompt) {
      log('warn', `No playbook rendered for ${item.id} (type: ${workType}, playbook: ${playbookName}) — skipping`);
      continue;
    }

    // Mark item as dispatched BEFORE adding to newWork (prevents race on next tick)
    item.status = WI_STATUS.DISPATCHED;
    item.dispatched_at = ts();
    item.dispatched_to = agentId;
    delete item._pendingReason;
    prdSyncQueue.push({ id: item.id, sourcePlan: item.sourcePlan });

    newWork.push({
      type: workType,
      agent: agentId,
      agentName: config.agents[agentId]?.name || tempAgents.get(agentId)?.name || agentId,
      agentRole: config.agents[agentId]?.role || tempAgents.get(agentId)?.role || 'Agent',
      task: `[${project?.name || 'project'}] ${item.title || item.description?.slice(0, 80) || item.id}`,
      prompt,
      meta: { dispatchKey: key, source: 'work-item', branch: branchName, branchStrategy: item.branchStrategy || 'parallel', useExistingBranch: !!(item.branchStrategy === 'shared-branch' && item.featureBranch), item, project: { name: project?.name, localPath: project?.localPath } }
    });

    setCooldown(key);
    } catch (err) { log('warn', `discoverFromWorkItems: skipping ${item.id}: ${err.message}`); }
  }

  // Write back updated statuses (always, since we mark items dispatched before newWork check)
  if (newWork.length > 0 || needsWrite) {
    const workItemsPath = projectWorkItemsPath(project);
    mutateJsonFileLocked(workItemsPath, (freshItems) => {
      // Merge in-memory mutations by item ID
      const byId = new Map(items.map(i => [i.id, i]));
      for (let idx = 0; idx < freshItems.length; idx++) {
        const updated = byId.get(freshItems[idx].id);
        if (updated) freshItems[idx] = updated;
      }
      return freshItems;
    }, { defaultValue: [] });
    if (newWork.length > 0) {
      for (const s of prdSyncQueue) syncPrdItemStatus(s.id, WI_STATUS.DISPATCHED, s.sourcePlan);
    }
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
function normalizeAc(ac) {
  if (Array.isArray(ac)) return ac;
  if (typeof ac === 'string') return ac.split('\n').map(s => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return [];
}

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
    (pr.status === PR_STATUS.MERGED || pr.status === PLAN_STATUS.COMPLETED) &&
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
    } catch (e) { log('warn', 'git: ' + e.message); }
  }

  if (recentSpecs.length === 0) return;

  const wiPath = projectWorkItemsPath(project);
  const existingItems = safeJson(wiPath) || [];
  const newItems = [];

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

      newItems.push({
        id: newId,
        type: WORK_TYPE.IMPLEMENT,
        title: `Implement: ${info.title}`,
        description: `Implementation work from merged spec.\n\n**Spec:** \`${doc.file}\`\n**Source PR:** ${pr.id} — ${pr.title || ''}\n**PR URL:** ${pr.url || 'N/A'}\n\n## Summary\n\n${info.summary}\n\nRead the full spec at \`${doc.file}\` before starting.`,
        priority: info.priority,
        status: WI_STATUS.QUEUED,
        created: ts(),
        createdBy: 'engine:spec-discovery',
        sourceSpec: doc.file,
        sourcePr: pr.id
      });
      existingItems.push(newItems[newItems.length - 1]); // keep in-memory dedup working
      log('info', `Spec discovery: created ${newId} "${info.title}" from PR ${pr.id} in ${project.name}`);
    }

    tracker.processedPrs[pr.id] = { processedAt: ts(), matched: true, specs: matchedSpecs.map(d => d.file) };
  }

  if (newItems.length > 0) {
    mutateJsonFileLocked(wiPath, (items) => {
      for (const ni of newItems) {
        if (!items.some(i => i.sourceSpec === ni.sourceSpec)) items.push(ni);
      }
      return items;
    }, { defaultValue: [] });
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
 * Scan central ~/.minions/work-items.json for project-agnostic tasks.
 * Uses the shared work-item.md playbook with multi-project context injected.
 */
function discoverCentralWorkItems(config) {
  const centralPath = path.join(MINIONS_DIR, 'work-items.json');
  const items = safeJson(centralPath) || [];
  const projects = getProjects(config);
  const newWork = [];

  for (const item of items) {
    try {
    if (item.status !== WI_STATUS.QUEUED && item.status !== WI_STATUS.PENDING) continue;

    const key = `central-work-${item.id}`;
    if (isAlreadyDispatched(key) || isOnCooldown(key, 0)) continue;

    const workType = item.type || WORK_TYPE.IMPLEMENT;
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

        const ap = assignedProject || (projects.length > 0 ? projects[0] : null);
        if (!ap) { log('warn', `Fan-out: skipping ${fanKey} — no projects configured`); continue; }
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

        // Inject references and acceptance criteria
        const fanRefs = (item.references || []).filter(r => r && r.url).map(r =>
          '- [' + (r.title || r.url) + '](' + r.url + ')' + (r.type ? ' (' + r.type + ')' : '')
        ).join('\n');
        vars.references = fanRefs ? '## References\n\n' + fanRefs : '';
        const fanAc = normalizeAc(item.acceptanceCriteria).map(c => '- [ ] ' + c).join('\n');
        vars.acceptance_criteria = fanAc ? '## Acceptance Criteria\n\n' + fanAc : '';

        if (workType === WORK_TYPE.ASK) {
          vars.question = item.title + (item.description ? '\n\n' + item.description : '');
          vars.task_id = item.id;
          vars.notes_content = '';
          try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }
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
            branch: `fan/${item.id}/${agent.id}`,
            deadline: item.timeout ? Date.now() + item.timeout : Date.now() + (config.engine?.fanOutTimeout || config.engine?.agentTimeout || DEFAULTS.agentTimeout)
          }
        });
      }

      item.status = WI_STATUS.DISPATCHED;
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
      const firstProject = projects.length > 0 ? projects[0] : null;
      if (!firstProject) { log('warn', `Dispatch: skipping ${item.id} — no projects configured`); continue; }

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
      try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }

      // Inject references and acceptance criteria
      const normRefs = (item.references || []).filter(r => r && r.url).map(r =>
        '- [' + (r.title || r.url) + '](' + r.url + ')' + (r.type ? ' (' + r.type + ')' : '')
      ).join('\n');
      vars.references = normRefs ? '## References\n\n' + normRefs : '';
      const normAc = normalizeAc(item.acceptanceCriteria).map(c => '- [ ] ' + c).join('\n');
      vars.acceptance_criteria = normAc ? '## Acceptance Criteria\n\n' + normAc : '';

      // Inject checkpoint context if agent left a checkpoint.json from a prior run
      vars.checkpoint_context = '';
      try {
        const centralBranch = item.branch || `work/${item.id}`;
        const centralWtPath = firstProject?.localPath
          ? path.resolve(firstProject.localPath, config.engine?.worktreeRoot || '../worktrees', centralBranch)
          : '';
        const cpPath = centralWtPath ? path.join(centralWtPath, 'checkpoint.json') : '';
        if (cpPath && fs.existsSync(cpPath)) {
          const cpData = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
          const cpCount = (item._checkpointCount || 0) + 1;
          if (cpCount > 3) {
            log('warn', `Work item ${item.id} exceeded 3 checkpoint-resumes — marking as needs-human-review`);
            item.status = WI_STATUS.NEEDS_REVIEW;
            item._checkpointCount = cpCount;
            continue;
          }
          item._checkpointCount = cpCount;
          const cpSummary = [
            `## Checkpoint (Resume #${cpCount}/3)`,
            '',
            'A previous agent run timed out but left a checkpoint. Continue from where it left off.',
            '',
            cpData.completed && cpData.completed.length > 0 ? `### Completed\n${cpData.completed.map(s => '- ' + s).join('\n')}` : '',
            cpData.remaining && cpData.remaining.length > 0 ? `### Remaining\n${cpData.remaining.map(s => '- ' + s).join('\n')}` : '',
            cpData.blockers && cpData.blockers.length > 0 ? `### Blockers\n${cpData.blockers.map(s => '- ' + s).join('\n')}` : '',
            cpData.branch_state ? `### Branch State\n${cpData.branch_state}` : '',
          ].filter(Boolean).join('\n');
          vars.checkpoint_context = cpSummary;
          log('info', `Injecting checkpoint context for ${item.id} (resume #${cpCount})`);
        }
      } catch (e) { log('warn', `checkpoint read for ${item.id}: ${e.message}`); }

      // Inject plan-specific variables for the plan playbook
      if (workType === WORK_TYPE.PLAN) {
        // Ensure plans directory exists before agent tries to write
        if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
        const planFileName = `plan-${item.id.toLowerCase()}-${dateStamp()}.md`;
        vars.plan_content = item.title + (item.description ? '\n\n' + item.description : '');
        vars.plan_title = item.title;
        vars.plan_file = planFileName;
        vars.task_description = item.title;
        vars.notes_content = '';
        try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }
        // Track expected plan filename in meta for chainPlanToPrd
        item._planFileName = planFileName;
      }

      // Inject plan-to-prd variables — read the plan file content for the playbook
      if (workType === WORK_TYPE.PLAN_TO_PRD && item.planFile) {
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
      if (workType === WORK_TYPE.ASK) {
        vars.question = item.title + (item.description ? '\n\n' + item.description : '');
        vars.task_id = item.id;
        vars.notes_content = '';
        try { vars.notes_content = fs.readFileSync(path.join(MINIONS_DIR, 'notes.md'), 'utf8'); } catch { /* optional */ }
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
        item.status = WI_STATUS.PENDING;
        continue;
      }

      newWork.push({
        type: workType,
        agent: agentId,
        agentName,
        agentRole,
        task: item.title || item.description?.slice(0, 80) || item.id,
        prompt,
        meta: { dispatchKey: key, source: 'central-work-item', item, planFileName: item.planFile || item._planFileName || null, branch: item.branch || item.featureBranch || `work/${item.id}` }
      });

      item.status = WI_STATUS.DISPATCHED;
      item.dispatched_at = ts();
      item.dispatched_to = agentId;
      setCooldown(key);
    }
    } catch (err) { log('warn', `discoverCentralWorkItems: skipping ${item.id}: ${err.message}`); }
  }

  if (newWork.length > 0) {
    mutateJsonFileLocked(centralPath, (freshItems) => {
      const byId = new Map(items.map(i => [i.id, i]));
      for (let idx = 0; idx < freshItems.length; idx++) {
        const updated = byId.get(freshItems[idx].id);
        if (updated) freshItems[idx] = updated;
      }
      return freshItems;
    }, { defaultValue: [] });
  }
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
    allFixes.push(...prWork.filter(w => w.type === WORK_TYPE.FIX));
    allReviews.push(...prWork.filter(w => w.type === WORK_TYPE.REVIEW));
    allWorkItems.push(...prWork.filter(w => w.type === WORK_TYPE.TEST));

    // Side-effect: specs → work items (picked up below)
    materializeSpecsAsWorkItems(config, project);

    // Source 3: Work items (includes auto-filed from plans, design docs, build failures)
    allWorkItems.push(...discoverFromWorkItems(config, project));
  }

  // Source 2: Minions-level PRD → implements (multi-project, called once outside project loop)
  // PRD items now flow through plans/*.json → materializePlansAsWorkItems → discoverFromWorkItems

  // Central work items (project-agnostic — agent decides where to work)
  const centralWork = discoverCentralWorkItems(config);

  // Scheduled tasks (cron-style recurring work)
  try {
    const { discoverScheduledWork } = require('./engine/scheduler');
    const scheduledWork = discoverScheduledWork(config);
    if (scheduledWork.length > 0) {
      const { createMeeting, getMeetings } = require('./engine/meeting');
      const centralPath = path.join(MINIONS_DIR, 'work-items.json');
      const newScheduledItems = [];
      for (const item of scheduledWork) {
        if (item.type === WORK_TYPE.MEETING) {
          // Create a real multi-agent meeting instead of a single-agent work item
          const sched = (config.schedules || []).find(s => s.id === item._scheduleId);
          const participants = (sched && sched.participants) || [];
          const meeting = createMeeting({ title: item.title, agenda: item.description, participants });
          log('info', `Scheduled meeting created: ${item._scheduleId} → ${meeting.id} (${participants.length} participants)`);
        } else {
          newScheduledItems.push(item);
        }
      }
      if (newScheduledItems.length > 0) {
        mutateJsonFileLocked(centralPath, (items) => {
          for (const item of newScheduledItems) {
            if (!items.some(i => i._scheduleId === item._scheduleId && i.status !== WI_STATUS.DONE && i.status !== WI_STATUS.FAILED)) {
              items.push(item);
              log('info', `Scheduled task fired: ${item._scheduleId} → ${item.title}`);
            }
          }
          return items;
        }, { defaultValue: [] });
      }
    }
  } catch (e) { log('warn', 'discover scheduled work: ' + e.message); }

  // Meeting work (multi-round team discussions)
  try {
    const { discoverMeetingWork } = require('./engine/meeting');
    const meetingWork = discoverMeetingWork(config);
    allWorkItems.push(...meetingWork);
  } catch (e) { log('warn', 'discover meeting work: ' + e.message); }

  // Pipeline orchestration — check stage completions and start ready stages
  try {
    const { discoverPipelineWork } = require('./engine/pipeline');
    discoverPipelineWork(config).catch(e => log('warn', 'discover pipeline work: ' + e.message));
  } catch (e) { log('warn', 'discover pipeline work: ' + e.message); }

  // Periodic plan completion sweep — catch PRDs that completed while engine was down
  // or where checkPlanCompletion missed the completion event
  // Throttled to every 10 ticks (~5 min) to reduce call volume (P3 decision)
  if (tickCount % 10 === 0) {
    try {
      const lifecycle = require('./engine/lifecycle');
      const prdDir = path.join(MINIONS_DIR, 'prd');
      if (fs.existsSync(prdDir)) {
        for (const f of fs.readdirSync(prdDir).filter(f => f.endsWith('.json'))) {
          if (completedPlanCache.has(f)) continue;
          const plan = safeJson(path.join(prdDir, f));
          if (!plan?.missing_features || plan.status === PLAN_STATUS.COMPLETED) {
            if (plan?.status === PLAN_STATUS.COMPLETED) completedPlanCache.add(f);
            continue;
          }
          if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.ACTIVE) continue;
          // Simulate the meta object checkPlanCompletion expects
          lifecycle.checkPlanCompletion({ item: { sourcePlan: f } }, config);
          // If plan transitioned to completed, cache it
          const after = safeJson(path.join(prdDir, f));
          if (after?.status === PLAN_STATUS.COMPLETED) completedPlanCache.add(f);
        }
      }
    } catch (e) { log('warn', 'plan completion sweep: ' + e.message); }
  }

  // Gate reviews and fixes: do not dispatch until all implement items are complete
  const hasIncompleteImplements = projects.some(project => {
    const items = safeJson(projectWorkItemsPath(project)) || [];
    return items.some(i => [WI_STATUS.QUEUED, WI_STATUS.PENDING, WI_STATUS.DISPATCHED].includes(i.status) && (i.type || '').startsWith(WORK_TYPE.IMPLEMENT));
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
    if (item.meta?.source === 'pr-human-feedback') {
      clearPendingHumanFeedbackFlag(item.meta.project, item.meta.pr?.id);
    }
  }

  if (allWork.length > 0) {
    log('info', `Discovered ${allWork.length} new work items: ${allFixes.length} fixes, ${allReviews.length} reviews, ${allWorkItems.length} work-items`);
  }

  return allWork.length;
}

// ─── Main Tick ──────────────────────────────────────────────────────────────

let tickCount = 0;

// In-memory cache of plan filenames confirmed completed — avoids redundant
// checkPlanCompletion calls.  Cleared automatically on engine restart.
const completedPlanCache = new Set();

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
  if (control.state !== 'running' && control.state !== 'stopping') {
    log('info', `Engine state is "${control.state}" — exiting process`);
    process.exit(0);
  }

  // Write heartbeat so dashboard can detect stale engine
  try { mutateJsonFileLocked(CONTROL_PATH, (c) => { c.heartbeat = Date.now(); return c; }); } catch (e) { log('warn', 'write heartbeat: ' + e.message); }

  const config = getConfig();
  tickCount++;

  // Helper: run a phase, log + continue on error
  const safe = (label, fn) => { try { fn(); } catch (e) { log('warn', `${label}: ${e.message}`); } };

  // 1. Check for timed-out agents, steering messages, and idle threshold
  safe('checkTimeouts', () => checkTimeouts(config));
  safe('checkSteering', () => checkSteering(config));
  safe('checkIdleThreshold', () => checkIdleThreshold(config));

  // 1b. Check for meeting round timeouts
  safe('meetingTimeouts', () => { const { checkMeetingTimeouts } = require('./engine/meeting'); checkMeetingTimeouts(config); });

  // In stopping state, only track agent completions — skip discovery and dispatch
  if (control.state === 'stopping') {
    log('info', `Engine stopping — ${activeProcesses.size} agent(s) still active, skipping discovery/dispatch`);
    return;
  }

  // 2. Consolidate inbox
  safe('consolidateInbox', () => consolidateInbox(config));

  // 2.5. Periodic cleanup + MCP sync (every 10 ticks = ~5 minutes)
  if (tickCount % 10 === 0) {
    safe('runCleanup', () => runCleanup(config));
  }

  // 2.6. Poll PR status: build, review, merge (every 6 ticks = ~3 minutes)
  // Awaited so PR state is consistent before discoverWork reads it
  if (tickCount % 6 === 0) {
    try { await pollPrStatus(config); } catch (err) { log('warn', `ADO PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    try { await ghPollPrStatus(config); } catch (err) { log('warn', `GitHub PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    // Sync PR status back to PRD items (missing → done when active PR exists)
    try { syncPrdFromPrs(config); } catch (err) { log('warn', `PRD sync error: ${err?.message || err}`); }
    // Check if any plans can be marked completed (all features done/in-pr)
    try {
      const prdFiles = safeReadDir(PRD_DIR).filter(f => f.endsWith('.json'));
      for (const file of prdFiles) {
        if (completedPlanCache.has(file)) continue;
        const plan = safeJson(path.join(PRD_DIR, file));
        if (plan && plan.missing_features && plan.status !== PLAN_STATUS.COMPLETED) {
          checkPlanCompletion({ item: { sourcePlan: file } }, config);
          // If plan transitioned to completed, cache it
          const after = safeJson(path.join(PRD_DIR, file));
          if (after?.status === PLAN_STATUS.COMPLETED) completedPlanCache.add(file);
        } else if (plan?.status === PLAN_STATUS.COMPLETED) {
          completedPlanCache.add(file);
        }
      }
    } catch (err) { log('warn', `Plan completion check error: ${err?.message || err}`); }
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
            const failedIds = new Set(items.filter(w => w.status === WI_STATUS.FAILED).map(w => w.id));
            const pendingWithBlockedDeps = items.filter(w =>
              w.status === WI_STATUS.PENDING && (w.depends_on || []).some(d => failedIds.has(d))
            );

            if (pendingWithBlockedDeps.length > 0) {
              // Auto-retry failed items that are blocking others (transient errors)
              for (const item of items) {
                if (item.status !== WI_STATUS.FAILED || isItemCompleted(item)) continue;
                // Only retry if something depends on this item
                const isBlocking = items.some(w => w.status === WI_STATUS.PENDING && (w.depends_on || []).includes(item.id));
                if (!isBlocking) continue;

                log('info', `Stall recovery: auto-retrying ${item.id} (blocking ${pendingWithBlockedDeps.filter(w => (w.depends_on || []).includes(item.id)).length} items)`);
                item.status = WI_STATUS.PENDING;
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
                      dp.completed = dp.completed.filter(d => d.meta?.dispatchKey !== key);
                      return dp;
                    });
                  } catch (e) { log('warn', 'stall recovery clear dispatch: ' + e.message); }

                // Clear cooldown so item isn't blocked by exponential backoff
                try {
                  const key = `work-${project.name}-${item.id}`;
                  if (dispatchCooldowns.has(key)) {
                    dispatchCooldowns.delete(key);
                    saveCooldowns();
                  }
                } catch (e) { log('warn', 'stall recovery clear cooldown: ' + e.message); }
              }
            }

            // Un-fail dependent items that were cascade-failed
            if (changed) {
              const retriedIds = new Set(items.filter(w => w.status === WI_STATUS.PENDING && w._retryCount === 0).map(w => w.id));
              for (const dep of items) {
                if (dep.status === WI_STATUS.FAILED && !isItemCompleted(dep) && dep.failReason === 'Dependency failed — cannot proceed') {
                  const blockers = (dep.depends_on || []).filter(d => retriedIds.has(d));
                  if (blockers.length > 0) {
                    log('info', `Stall recovery: un-failing ${dep.id} (blocker ${blockers.join(',')} retried)`);
                    dep.status = WI_STATUS.PENDING;
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
                        return dp;
                      });
                    } catch (e) { log('warn', 'stall recovery clear dependent dispatch: ' + e.message); }
                  }
                }
              }
            }

            if (changed) {
              mutateJsonFileLocked(wiPath, (freshItems) => {
                const byId = new Map(items.map(i => [i.id, i]));
                for (let idx = 0; idx < freshItems.length; idx++) {
                  const updated = byId.get(freshItems[idx].id);
                  if (updated) freshItems[idx] = updated;
                }
                return freshItems;
              }, { defaultValue: [] });
            }
          } catch (e) { log('warn', 'stall recovery process project: ' + e.message); }
        }
      }
    } catch (err) { log('warn', `Stall detection error: ${err?.message || err}`); }
  }

  // 3. Discover new work from sources
  let discoveryOk = true;
  try { discoverWork(config); } catch (e) { log('warn', 'discoverWork: ' + e.message); discoveryOk = false; }

  // 4. Update snapshot
  safe('updateSnapshot', () => updateSnapshot(config));

  if (!discoveryOk) {
    log('warn', 'Skipping dispatch — discovery failed, stale data risk');
    return;
  }

  // 5. Process pending dispatches — auto-spawn agents
  const dispatch = getDispatch();
  const activeCount = (dispatch.active || []).length;
  const maxConcurrent = config.engine?.maxConcurrent || 5;

  if (activeCount >= maxConcurrent) {
    log('info', `At max concurrency (${activeCount}/${maxConcurrent}) — skipping dispatch`);
    return;
  }

  const slotsAvailable = maxConcurrent - activeCount;

  // Priority dispatch: fixes > reviews > plan-to-prd > implement > verify > other
  const typePriority = { [WORK_TYPE.IMPLEMENT_LARGE]: 0, [WORK_TYPE.IMPLEMENT]: 0, [WORK_TYPE.FIX]: 1, [WORK_TYPE.ASK]: 1, [WORK_TYPE.REVIEW]: 2, [WORK_TYPE.TEST]: 3, [WORK_TYPE.VERIFY]: 3, [WORK_TYPE.PLAN]: 4, [WORK_TYPE.PLAN_TO_PRD]: 4 };
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
    return dp;
  });

  // Only dispatch to agents that aren't already busy (one task per agent at a time).
  // Build set of agents currently active.
  const busyAgents = new Set((dispatch.active || []).map(d => d.agent));
  // Bug fix #14: deduplicate pending by dispatch ID to prevent double-dispatch.
  // This guards against the same item appearing twice in the in-memory pending array.
  const seenPendingIds = new Set();
  const toDispatch = [];
  for (const item of dispatch.pending) {
    if (toDispatch.length >= slotsAvailable) break;
    if (seenPendingIds.has(item.id)) {
      log('warn', `Duplicate dispatch ID ${item.id} in pending queue — skipping`);
      continue;
    }
    seenPendingIds.add(item.id);
    if (busyAgents.has(item.agent)) continue; // agent already has an active task
    toDispatch.push(item);
    busyAgents.add(item.agent); // mark busy for this dispatch round too
  }

  // Dispatch items — spawnAgent moves each from pending→active on disk.
  // We use the already-loaded item objects; spawnAgent handles the state transition.
  const dispatched = new Set();
  for (const item of toDispatch) {
    if (!dispatched.has(item.id)) {
      let proc;
      try { proc = spawnAgent(item, config); } catch (spawnErr) {
        log('error', `spawnAgent exception for ${item.id}: ${spawnErr.message}`);
        proc = null;
      }
      if (proc === null) {
        // spawnAgent failed (e.g., worktree creation error). It already called
        // completeDispatch internally which handles retry logic, but log at the
        // dispatch-loop level for visibility and handle any edge cases where
        // completeDispatch wasn't called.
        log('error', `spawnAgent returned null for ${item.id} (${item.type} → ${item.agent}) — spawn failed`);
        // Defensive: ensure the work item is re-queued if completeDispatch didn't fire
        if (item.meta?.item?.id) {
          try {
            const wiPath = item.meta.source === 'central-work-item' || item.meta.source === 'central-work-item-fanout'
              ? path.join(ENGINE_DIR, '..', 'work-items.json')
              : item.meta.project?.name ? projectWorkItemsPath({ name: item.meta.project.name, localPath: item.meta.project.localPath }) : null;
            if (wiPath) {
              const itemId = item.meta.item.id;
              mutateJsonFileLocked(wiPath, (items) => {
                const wi = items.find(i => i.id === itemId);
                if (wi && wi.status === WI_STATUS.DISPATCHED) {
                  // completeDispatch didn't update the work item — re-queue manually
                  wi.status = WI_STATUS.PENDING;
                  wi._retryCount = (wi._retryCount || 0) + 1;
                  wi._lastRetryReason = 'spawnAgent returned null';
                  wi._lastRetryAt = ts();
                  delete wi.dispatched_at;
                  delete wi.dispatched_to;
                  log('info', `Re-queued ${itemId} as pending (retry ${wi._retryCount})`);
                }
                return items;
              }, { defaultValue: [] });
            }
          } catch (e) { log('warn', `Failed to re-queue work item after spawn failure: ${e.message}`); }
        }
      } else {
        dispatched.add(item.id);
      }
    }
  }

  // Annotate remaining pending items with skipReason so dashboard can show why they're waiting.
  // Re-read dispatch after spawns (spawnAgent moves items from pending→active).
  const postDispatch = getDispatch();
  const postBusyAgents = new Set((postDispatch.active || []).map(d => d.agent));
  const postActiveCount = (postDispatch.active || []).length;
  let skipReasonChanged = false;
  for (const item of (postDispatch.pending || [])) {
    let reason = null;
    if (postActiveCount >= maxConcurrent) {
      reason = 'max_concurrency';
    } else if (postBusyAgents.has(item.agent)) {
      reason = 'agent_busy';
    }
    if (item.skipReason !== reason) {
      item.skipReason = reason;
      skipReasonChanged = true;
    }
  }
  if (skipReasonChanged) {
    mutateDispatch((dp) => { dp.pending = postDispatch.pending; return dp; });
  }
}

// ─── Exports (for engine/cli.js and other modules) ──────────────────────────

module.exports = {
  // Paths
  MINIONS_DIR, ENGINE_DIR, AGENTS_DIR, PLAYBOOKS_DIR, PLANS_DIR, PRD_DIR,
  CONTROL_PATH, DISPATCH_PATH, LOG_PATH, INBOX_DIR, KNOWLEDGE_DIR, ARCHIVE_DIR,
  IDENTITY_DIR, CONFIG_PATH, ROUTING_PATH, NOTES_PATH, SKILLS_DIR,

  // Utilities
  ts, logTs, dateStamp, log,
  safeJson, safeRead, safeWrite,

  // State readers/writers
  getConfig, getControl, getDispatch, getRouting, getNotes,
  getAgentStatus, getAgentCharter, getInboxFiles, getPrs,
  validateConfig,

  // Dispatch management (re-exported from engine/dispatch.js)
  mutateDispatch, addToDispatch, isRetryableFailureReason, completeDispatch, writeInboxAlert,
  activeProcesses, get engineRestartGraceUntil() { return engineRestartGraceUntil; },
  set engineRestartGraceUntil(v) { engineRestartGraceUntil = v; },

  // Agent lifecycle
  spawnAgent, resolveAgent,

  // Discovery
  discoverWork, discoverFromPrs, discoverFromWorkItems,
  materializePlansAsWorkItems,

  // Shared helpers (used by lifecycle.js and tests)
  reconcileItemsWithPrs, detectDependencyCycles,

  // Playbooks
  renderPlaybook,

  // Timeout / Steering / Idle (re-exported from engine/timeout.js)
  checkTimeouts, checkSteering, checkIdleThreshold,

  // Cleanup (re-exported from engine/cleanup.js)
  runCleanup,

  // Post-completion / lifecycle
  updateWorkItemStatus, handlePostMerge,

  // Cooldowns
  loadCooldowns, setCooldownWithContext, getCoalescedContexts,

  // Budget
  getMonthlySpend,

  // Tick
  tick,
};

// ─── Entrypoint ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const { handleCommand } = require('./engine/cli');
  const [cmd, ...args] = process.argv.slice(2);
  handleCommand(cmd, args);
}

