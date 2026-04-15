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
const { exec, execAsync, execSilent, runFile, ts, ENGINE_DEFAULTS: DEFAULTS,
  WI_STATUS, DONE_STATUSES, WORK_TYPE, PLAN_STATUS, PRD_ITEM_STATUS, PRD_MATERIALIZABLE, PR_STATUS, DISPATCH_RESULT, AGENT_STATUS,
  FAILURE_CLASS } = shared;
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
  logTs, dateStamp, log } = shared;

// ─── Utilities ──────────────────────────────────────────────────────────────

const safeJson = shared.safeJson;
const safeRead = shared.safeRead;
const safeWrite = shared.safeWrite;
const safeUnlink = shared.safeUnlink;
const mutateJsonFileLocked = shared.mutateJsonFileLocked;
const mutateWorkItems = shared.mutateWorkItems;
const mutatePullRequests = shared.mutatePullRequests;
const withFileLock = shared.withFileLock;

// ─── Dispatch Management (extracted to engine/dispatch.js) ───────────────────

const { mutateDispatch, addToDispatch, isRetryableFailureReason, completeDispatch,
  writeInboxAlert, updateAgentStatus } = require('./engine/dispatch');

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

const { renderPlaybook, validatePlaybookVars, PLAYBOOK_REQUIRED_VARS,
  buildSystemPrompt, buildAgentContext, selectPlaybook,
  buildBaseVars, buildPrDispatch, resolveTaskContext,
  getRepoHostLabel, getRepoHostToolRule } = require('./engine/playbook');

// sanitizeBranch imported from shared.js

// ─── Lifecycle (extracted to engine/lifecycle.js) ────────────────────────────

const { runPostCompletionHooks, updateWorkItemStatus, syncPrdItemStatus, reconcilePrdStatuses, handlePostMerge, checkPlanCompletion,
  syncPrsFromOutput, updatePrAfterReview, updatePrAfterFix, checkForLearnings, extractSkillsFromOutput,
  updateAgentHistory, updateMetrics, createReviewFeedbackForAuthor, parseAgentOutput, syncPrdFromPrs,
  isItemCompleted, classifyFailure, processPendingRebases, resolveWorkItemPath } = require('./engine/lifecycle');

// ─── Agent Spawner ──────────────────────────────────────────────────────────

const activeProcesses = new Map(); // dispatchId → { proc, agentId, startedAt }
const realActivityMap = new Map(); // dispatchId → timestamp of last REAL agent output (not engine heartbeat)
// tempAgents imported from engine/routing.js
let engineRestartGraceUntil = 0; // timestamp — suppress orphan detection until this time
const engineRestartGraceExempt = new Set(); // dispatch IDs with confirmed-dead PIDs at restart — bypass grace period

// Per-tick cache of refs that failed to fetch — avoids repeating 30s ETIMEDOUT for same missing ref
// Cleared at the start of each tick cycle (see tickInner)
const _failedRefCache = new Set();

// Parse conflicting file names from git merge error output (stderr/stdout combined)
function parseConflictFiles(mergeOutput) {
  const files = [];
  // Match "CONFLICT (content): Merge conflict in <file>" lines
  const conflictRe = /CONFLICT \([^)]*\): .*?(?:in|for) (.+)/g;
  let m;
  while ((m = conflictRe.exec(mergeOutput)) !== null) files.push(m[1].trim());
  // Also match "Auto-merging <file>" followed by conflict (less specific, fallback)
  if (files.length === 0) {
    const autoMergeRe = /Auto-merging (.+)/g;
    while ((m = autoMergeRe.exec(mergeOutput)) !== null) files.push(m[1].trim());
  }
  return [...new Set(files)]; // dedupe
}

// Prune dep branches that are ancestors of other dep branches (#958)
// When B already contains A's commits, merging both A and B causes conflicts.
async function pruneAncestorDeps(deps, gitOpts, cwd) {
  if (deps.length <= 1) return deps;
  const ancestorIndices = new Set();
  for (let i = 0; i < deps.length; i++) {
    if (ancestorIndices.has(i)) continue;
    for (let j = 0; j < deps.length; j++) {
      if (i === j || ancestorIndices.has(j)) continue;
      try {
        await execAsync(`git merge-base --is-ancestor "origin/${deps[i].branch}" "origin/${deps[j].branch}"`, { ...gitOpts, cwd });
        // deps[i] is an ancestor of deps[j] — prune deps[i]
        ancestorIndices.add(i);
        break;
      } catch (_) { /* not an ancestor — that's fine */ }
    }
  }
  return deps.filter((_, i) => !ancestorIndices.has(i));
}

// Pre-flight merge simulation using git merge-tree --write-tree (#958)
// Simulates sequential merges by chaining output tree SHAs via temporary commits.
// Returns { ok, conflictBranch, conflictFiles, isInterDep, prevBranch }
async function preflightMergeSimulation(deps, mainRef, gitOpts, cwd) {
  if (deps.length === 0) return { ok: true };
  let currentRef = `origin/${mainRef}`;
  let prevBranch = mainRef;
  for (let i = 0; i < deps.length; i++) {
    const depBranch = deps[i].branch;
    try {
      const result = await execAsync(`git merge-tree --write-tree "${currentRef}" "origin/${depBranch}"`, { ...gitOpts, cwd });
      const treeSha = (typeof result === 'string' ? result : (result.stdout?.toString?.() || '')).trim().split('\n')[0];
      if (!treeSha) return { ok: true }; // can't parse tree SHA, skip pre-flight
      // Create temp commit to chain for next dep (skip for last dep — no chaining needed)
      if (i < deps.length - 1) {
        try {
          const commitResult = await execAsync(
            `git commit-tree "${treeSha}" -p "${currentRef}" -p "origin/${depBranch}" -m "preflight-merge"`,
            { ...gitOpts, cwd }
          );
          const commitSha = (typeof commitResult === 'string' ? commitResult : (commitResult.stdout?.toString?.() || '')).trim();
          if (commitSha) {
            prevBranch = depBranch;
            currentRef = commitSha;
          }
        } catch (_) { return { ok: true }; } // commit-tree failed, skip pre-flight gracefully
      }
    } catch (err) {
      const output = (err.stdout?.toString?.() || '') + '\n' + (err.stderr?.toString?.() || '');
      const isInterDep = prevBranch !== mainRef;
      return {
        ok: false,
        conflictBranch: depBranch,
        conflictFiles: parseConflictFiles(output),
        isInterDep,
        prevBranch,
      };
    }
  }
  return { ok: true };
}

const _FAST_WORK_TYPES = new Set([WORK_TYPE.EXPLORE, WORK_TYPE.ASK, WORK_TYPE.REVIEW]);
const _MAX_TURNS_BY_TYPE = {
  [WORK_TYPE.EXPLORE]: 30, [WORK_TYPE.ASK]: 20, [WORK_TYPE.REVIEW]: 30,
  [WORK_TYPE.DECOMPOSE]: 15, [WORK_TYPE.PLAN]: 30, [WORK_TYPE.PLAN_TO_PRD]: 35,
  [WORK_TYPE.MEETING]: 30,
  [WORK_TYPE.IMPLEMENT]: 75, [WORK_TYPE.IMPLEMENT_LARGE]: 75, [WORK_TYPE.FIX]: 75,
  [WORK_TYPE.TEST]: 50, [WORK_TYPE.VERIFY]: 100, [WORK_TYPE.DOCS]: 30,
};
function _maxTurnsForType(type, engineConfig) {
  // Priority: per-type config override → global config override → built-in per-type default → global default
  const perType = engineConfig.maxTurnsByType || {};
  if (perType[type]) return perType[type];
  const globalOverride = engineConfig.maxTurns && engineConfig.maxTurns !== DEFAULTS.maxTurns ? engineConfig.maxTurns : null;
  return globalOverride || _MAX_TURNS_BY_TYPE[type] || DEFAULTS.maxTurns;
}

// Resolve dependency plan item IDs to their PR branches
function resolveDependencyBranches(depIds, sourcePlan, project, config) {
  const results = []; // [{ branch, prId }]
  if (!depIds?.length) return results;

  const projects = shared.getProjects(config);

  // Find work items for each dependency plan item
  const allItems = queries.getWorkItems(config);
  const depWorkItems = allItems.filter(wi => depIds.includes(wi.id));

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
async function findExistingWorktree(repoDir, branchName) {
  try {
    const out = await execAsync(`git worktree list --porcelain`, { cwd: repoDir, timeout: 10000 });
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

async function runWorktreeAdd(rootDir, worktreePath, args, gitOpts, worktreeCreateRetries) {
  let lastErr = null;
  const retries = Math.max(0, Number(worktreeCreateRetries) || 0);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        try { await execAsync('git worktree prune', { ...gitOpts, cwd: rootDir, timeout: 15000 }); } catch (e) { log('warn', 'git: ' + e.message); }
        removeStaleIndexLock(rootDir);
        log('warn', `Retrying git worktree add (attempt ${attempt + 1}/${retries + 1}) for ${path.basename(worktreePath)}`);
      }
      await execAsync(`git worktree add "${worktreePath}" ${args}`, { ...gitOpts, cwd: rootDir });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isWorktreeRetryableError(err)) throw err;
    }
  }
  if (lastErr) throw lastErr;
}

async function recoverPartialWorktree(rootDir, worktreePath, branchName, gitOpts) {
  if (!branchName) return false;
  const existingWt = await findExistingWorktree(rootDir, branchName);
  if (existingWt && fs.existsSync(existingWt)) return true;
  if (!fs.existsSync(worktreePath)) return false;
  try {
    await execAsync(`git -C "${worktreePath}" rev-parse --is-inside-work-tree`, { ...gitOpts, timeout: 10000 });
    await execAsync(`git -C "${worktreePath}" rev-parse --abbrev-ref HEAD`, { ...gitOpts, timeout: 10000 });
    log('warn', `Recovered partially-created worktree for ${branchName} at ${worktreePath}`);
    return true;
  } catch {
    return false;
  }
}

async function spawnAgent(dispatchItem, config) {
  const { id, agent: agentId, prompt: taskPrompt, type, meta } = dispatchItem;
  const claudeConfig = config.claude || {};
  const engineConfig = config.engine || {};
  const startedAt = ts();

  updateAgentStatus(id, AGENT_STATUS.SPAWNING, `Preparing ${type} task for ${agentId}`);

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

  // Build prompt before worktree setup — prompt doesn't depend on worktree path
  // and this avoids blocking 200ms of file reads behind 20-60s of git operations
  const systemPrompt = buildSystemPrompt(agentId, config, project);
  const agentContext = buildAgentContext(agentId, config, project);
  const fullTaskPrompt = agentContext
    ? `## Agent Context\n\n${agentContext}\n---\n\n## Your Task\n\n${taskPrompt}`
    : taskPrompt;
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const safeId = id.replace(/[:\\/*?"<>|]/g, '-');
  const promptPath = path.join(tmpDir, `prompt-${safeId}.md`);
  safeWrite(promptPath, fullTaskPrompt);
  const sysPromptPath = path.join(tmpDir, `sysprompt-${safeId}.md`);
  safeWrite(sysPromptPath, systemPrompt);
  const _cleanupPromptFiles = () => { safeUnlink(promptPath); safeUnlink(sysPromptPath); };

  if (branchName) {
    updateAgentStatus(id, AGENT_STATUS.WORKTREE_SETUP, `Setting up worktree for branch ${branchName}`);
    const wtSuffix = id ? id.split('-').pop() : shared.uid();
    const projectSlug = (project.name || 'default').replace(/[^a-zA-Z0-9_-]/g, '-');
    const wtDirName = `${projectSlug}-${branchName}-${wtSuffix}`;
    worktreePath = path.resolve(rootDir, engineConfig.worktreeRoot || '../worktrees', wtDirName);

    // If branch is already checked out in an existing worktree, reuse it
    const existingWt = await findExistingWorktree(rootDir, branchName);
    if (existingWt) {
      worktreePath = existingWt;
      log('info', `Reusing existing worktree for ${branchName}: ${existingWt}`);
      try { await execAsync(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
      try { await execAsync(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: existingWt }); } catch (e) { log('warn', 'git: ' + e.message); }
    } else if (['meeting', 'ask', 'explore', 'plan-to-prd', 'plan'].includes(type)) {
      // Read-only tasks — no worktree needed, run in rootDir
      log('info', `${type}: read-only task, no worktree needed — running in rootDir`);
      branchName = null;
      worktreePath = null;
    } else {
      try {
        if (!fs.existsSync(worktreePath)) {
          const isSharedBranch = meta?.branchStrategy === 'shared-branch' || meta?.useExistingBranch;
          // Prune stale worktree entries before creating (handles leftover entries from crashed runs)
          try { await execAsync(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
          // Remove stale index.lock before creating worktree (Windows crashes can leave this behind)
          removeStaleIndexLock(rootDir);

          if (isSharedBranch) {
            log('info', `Creating worktree for shared branch: ${worktreePath} on ${branchName}`);
            try { await execAsync(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
            try {
              await runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (eShared) {
              if (eShared.message?.includes('already used by worktree') || eShared.message?.includes('already checked out')) {
                const existingWtPath = await findExistingWorktree(rootDir, branchName);
                if (existingWtPath && fs.existsSync(existingWtPath)) {
                  log('info', `Shared branch ${branchName} already checked out at ${existingWtPath} — reusing`);
                  worktreePath = existingWtPath;
                } else { throw eShared; }
              } else if (eShared.message?.includes('invalid reference') || eShared.message?.includes('not a valid ref')) {
                // Branch doesn't exist yet (first item in plan) — create it from main
                const mainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
                log('info', `Shared branch ${branchName} not found — creating from ${mainRef}`);
                await runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, worktreeCreateRetries);
              } else { throw eShared; }
            }
          } else {
            log('info', `Creating worktree: ${worktreePath} on branch ${branchName}`);
            const mainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
            try {
              await runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, worktreeCreateRetries);
            } catch (e1) {
              const branchExists = e1.message?.includes('already exists');
              log('warn', `Worktree -b failed for ${branchName}: ${e1.message?.split('\n')[0]}`);
              if (!branchExists) {
                // Transient error (lock, timeout) — prune, clean, and retry -b once more
                log('info', `Retrying -b create after prune for ${branchName}`);
                try { await execAsync(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 15000 }); } catch { /* optional */ }
                removeStaleIndexLock(rootDir);
                // Clean up partial worktree directory from failed attempt
                try { if (fs.existsSync(worktreePath)) fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* optional */ }
                try {
                  await runWorktreeAdd(rootDir, worktreePath, `-b "${branchName}" ${mainRef}`, _worktreeGitOpts, 0);
                } catch (e1b) {
                  log('error', `Worktree -b retry also failed for ${branchName}: ${e1b.message?.split('\n')[0]}`);
                  throw e1b;
                }
              } else {
                // Branch already exists — try checkout without -b
                try { await execAsync(`git fetch origin "${branchName}"`, { ..._gitOpts, cwd: rootDir }); } catch (e) { log('warn', 'git: ' + e.message); }
                try {
                  await runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                  log('info', `Reusing existing branch: ${branchName}`);
                } catch (e2) {
                  // "already checked out" or "already used by worktree" — find and reuse or recover
                  const alreadyUsed = e2.message?.includes('already checked out') || e2.message?.includes('already used by worktree')
                    || e1.message?.includes('already checked out') || e1.message?.includes('already used by worktree');
                  if (alreadyUsed) {
                    const existingWtPath = await findExistingWorktree(rootDir, branchName);
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
                      try { await execAsync(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
                      await runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
                      log('info', `Recovered worktree for ${branchName} after stale entry prune`);
                    } else {
                      try { await execAsync(`git worktree prune`, { ..._gitOpts, cwd: rootDir, timeout: 10000 }); } catch (e) { log('warn', 'git: ' + e.message); }
                      await runWorktreeAdd(rootDir, worktreePath, `"${branchName}"`, _worktreeGitOpts, worktreeCreateRetries);
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
          try { await execAsync(`git pull origin "${branchName}"`, { ..._gitOpts, cwd: worktreePath }); } catch (e) { log('warn', 'git: ' + e.message); }
        }
      } catch (err) {
        if (await recoverPartialWorktree(rootDir, worktreePath, branchName, _gitOpts)) {
          cwd = worktreePath;
          log('warn', `Proceeding with recovered worktree after add failure for ${branchName}`);
        } else {
          log('error', `Failed to create worktree for ${branchName}: ${err.message}${err.stderr ? '\n' + err.stderr.toString().slice(0, 500) : ''}`);
          _cleanupPromptFiles();
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
          let depMergeFailed = false;
          let depConflictBranch = null; // track which dep branch caused the conflict
          let depConflictFiles = [];    // conflicting file names parsed from git output
          // Fetch all dependency branches in parallel (git fetches are independent)
          const fetchable = depBranches.filter(d => !_failedRefCache.has(d.branch));
          const unfetchable = depBranches.filter(d => _failedRefCache.has(d.branch));
          const allPrsForDeps = unfetchable.length > 0 ? shared.getProjects(config).reduce((acc, p) => acc.concat(safeJson(shared.projectPrPath(p)) || []), []) : [];
          for (const { branch: depBranch, prId } of unfetchable) {
            const pr = allPrsForDeps.find(p => p.id === prId);
            if (pr && (pr.status === 'merged' || pr.status === 'closed')) {
              log('info', `Dependency ${depBranch} (${prId}) already merged — skipping, changes already in main`);
              continue;
            }
            log('warn', `Skipping dependency ${depBranch} — already failed to fetch this tick`);
            depMergeFailed = true;
          }
          const fetchResults = await Promise.allSettled(
            fetchable.map(({ branch: depBranch }) =>
              execAsync(`git fetch origin "${depBranch}"`, { ..._gitOpts, cwd: rootDir }).then(() => depBranch)
            )
          );
          const hasFetchFailures = fetchResults.some(r => r.status === 'rejected');
          const allPrsForFetch = hasFetchFailures ? shared.getProjects(config).reduce((acc, p) => acc.concat(safeJson(shared.projectPrPath(p)) || []), []) : [];
          // Track branches recovered by local-only push so they can be merged
          const recoveredBranches = new Set();
          for (let i = 0; i < fetchResults.length; i++) {
            if (fetchResults[i].status === 'rejected') {
              const failedBranch = fetchable[i].branch;
              const failedPrId = fetchable[i].prId;
              const errMsg = fetchResults[i].reason?.message || '';
              const pr = allPrsForFetch.find(p => p.id === failedPrId);
              if (pr && (pr.status === 'merged' || pr.status === 'closed')) {
                log('info', `Dependency ${failedBranch} (${failedPrId}) already merged — skipping, changes already in main`);
                continue;
              }
              // If remote ref missing, check if branch exists locally and push it (#782)
              if (errMsg.includes('couldn\'t find remote ref') || errMsg.includes('not found in upstream')) {
                try {
                  await execAsync(`git rev-parse --verify "refs/heads/${failedBranch}"`, { ..._gitOpts, cwd: rootDir });
                  // Branch exists locally — push it to origin
                  log('info', `Dependency ${failedBranch} exists locally but not on remote — pushing to origin`);
                  await execAsync(`git push origin "${failedBranch}"`, { ..._gitOpts, cwd: rootDir, timeout: 60000 });
                  log('info', `Successfully pushed local-only dependency branch ${failedBranch} to origin`);
                  recoveredBranches.add(failedBranch);
                  continue;
                } catch (localErr) {
                  log('warn', `Dependency ${failedBranch} not found locally or push failed: ${localErr.message}`);
                }
              }
              _failedRefCache.add(failedBranch);
              log('warn', `Failed to fetch dependency ${failedBranch}: ${errMsg}`);
              depMergeFailed = true;
            }
          }
          // Merge successfully-fetched + recovered (local-only pushed) branches sequentially
          const fetched = fetchable.filter((_, i) => fetchResults[i].status === 'fulfilled' || recoveredBranches.has(fetchable[i].branch));
          // Ancestor pruning: remove dep branches already contained in another (#958)
          let prunedDeps = fetched;
          let _isInterDepConflict = false;
          let _preflightConflictPrev = null;
          if (fetched.length > 1 && !depMergeFailed) {
            try {
              prunedDeps = await pruneAncestorDeps(fetched, _gitOpts, rootDir);
              if (prunedDeps.length < fetched.length) {
                const pruned = fetched.filter(d => !prunedDeps.includes(d));
                log('info', `Ancestor pruning removed ${pruned.length} dep(s): ${pruned.map(d => d.branch).join(', ')}`);
              }
            } catch (e) {
              log('warn', `Ancestor pruning failed, using all deps: ${e.message}`);
              prunedDeps = fetched;
            }
          }
          // Skip dep re-merge if worktree HEAD already contains all pruned dep commits (#973)
          let skipDepMerge = false;
          if (!depMergeFailed && prunedDeps.length > 0) {
            const ancestorChecks = await Promise.all(
              prunedDeps.map(async ({ branch: depBranch }) => {
                try {
                  await execAsync(`git merge-base --is-ancestor "origin/${depBranch}" HEAD`, { ..._gitOpts, cwd: worktreePath });
                  return true;
                } catch (_) { return false; }
              })
            );
            if (ancestorChecks.every(Boolean)) {
              log('info', `All ${prunedDeps.length} dep branch(es) already merged into ${branchName} — skipping dep re-merge`);
              skipDepMerge = true;
            }
          }
          // Pre-flight merge simulation: detect conflicts without touching the worktree (#958)
          if (!depMergeFailed && !skipDepMerge && prunedDeps.length > 0) {
            const pfMainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
            try {
              const sim = await preflightMergeSimulation(prunedDeps, pfMainRef, _gitOpts, rootDir);
              if (!sim.ok) {
                depMergeFailed = true;
                depConflictBranch = sim.conflictBranch;
                depConflictFiles = sim.conflictFiles;
                _isInterDepConflict = sim.isInterDep;
                _preflightConflictPrev = sim.prevBranch;
                log('warn', `Pre-flight merge simulation detected conflict: ${sim.conflictBranch}${sim.isInterDep ? ` (inter-dep with ${sim.prevBranch})` : ''}`);
              }
            } catch (e) {
              log('warn', `Pre-flight simulation failed, proceeding with real merge: ${e.message}`);
            }
          }
          // Stash uncommitted changes before dep merge if worktree is dirty (#973)
          let stashed = false;
          if (!depMergeFailed && !skipDepMerge && prunedDeps.length > 0) {
            try {
              const statusOut = (await execAsync('git status --porcelain', { ..._gitOpts, cwd: worktreePath })).stdout.toString().trim();
              if (statusOut) {
                await execAsync('git stash push --include-untracked -m "engine: stash before dep re-merge"', { ..._gitOpts, cwd: worktreePath });
                stashed = true;
                log('info', `Stashed uncommitted changes in ${branchName} before dep merge`);
              }
            } catch (stashErr) {
              log('warn', `Failed to stash changes in ${branchName} before dep merge: ${stashErr.message}`);
            }
          }
          if (!depMergeFailed && !skipDepMerge) {
            for (const { branch: depBranch, prId } of prunedDeps) {
              try {
                await execAsync(`git merge "origin/${depBranch}" --no-edit`, { ..._gitOpts, cwd: worktreePath });
                log('info', `Merged dependency branch ${depBranch} (${prId}) into worktree ${branchName}`);
              } catch (mergeErr) {
                // Merge failed — possibly due to diverged history from a force-pushed (rebased) dep branch.
                // Abort partial merge, reset worktree to clean main base, and re-merge all deps from scratch.
                log('warn', `Merge of ${depBranch} into ${branchName} failed: ${mergeErr.message} — attempting reset and re-merge of all deps`);
                try { await execAsync(`git merge --abort`, { ..._gitOpts, cwd: worktreePath }); } catch (_) { /* no merge in progress */ }
                const mainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
                try {
                  await execAsync(`git reset --hard "origin/${mainRef}"`, { ..._gitOpts, cwd: worktreePath });
                  log('info', `Reset worktree ${branchName} to origin/${mainRef} for clean dep re-merge`);
                  // Re-merge ALL pruned dep branches from scratch on clean base
                  for (const { branch: reBranch, prId: rePrId } of prunedDeps) {
                    await execAsync(`git merge "origin/${reBranch}" --no-edit`, { ..._gitOpts, cwd: worktreePath });
                    log('info', `Re-merged dependency branch ${reBranch} (${rePrId}) into worktree ${branchName}`);
                  }
                  log('info', `Successfully re-merged all ${prunedDeps.length} dep branches after reset for ${branchName}`);
                } catch (resetErr) {
                  const errOutput = (resetErr.message || '') + '\n' + (resetErr.stdout?.toString?.() || '') + '\n' + (resetErr.stderr?.toString?.() || '');
                  log('warn', `Failed to reset and re-merge deps for ${branchName}: ${resetErr.message}`);
                  try { await execAsync(`git merge --abort`, { ..._gitOpts, cwd: worktreePath }); } catch (_) { /* no merge in progress */ }
                  // Post-mortem: incremental simulation to identify which dep caused the conflict (#958)
                  // Uses same chained merge-tree approach as pre-flight to catch inter-dep conflicts
                  const pmMainRef = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
                  try {
                    const sim = await preflightMergeSimulation(prunedDeps, pmMainRef, _gitOpts, rootDir);
                    if (!sim.ok) {
                      depConflictBranch = sim.conflictBranch;
                      depConflictFiles = sim.conflictFiles;
                      _isInterDepConflict = sim.isInterDep;
                      _preflightConflictPrev = sim.prevBranch;
                    }
                  } catch (_simErr) {
                    // Fallback: old per-branch isolation check via 3-arg git merge-tree
                    for (const { branch: reBranch2 } of prunedDeps) {
                      try {
                        const mainRef2 = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
                        const mergeBase = (await execAsync(`git merge-base "origin/${mainRef2}" "origin/${reBranch2}"`, { ..._gitOpts, cwd: rootDir })).stdout.toString().trim();
                        const treeResult = await execAsync(`git merge-tree "${mergeBase}" "origin/${mainRef2}" "origin/${reBranch2}"`, { ..._gitOpts, cwd: rootDir });
                        const treeOutput = treeResult.stdout?.toString?.() || '';
                        if (treeOutput.includes('<<<<<<<') || treeOutput.includes('changed in both')) {
                          depConflictBranch = reBranch2;
                          depConflictFiles = parseConflictFiles(treeOutput);
                          break;
                        }
                      } catch (_e) { /* merge-tree may fail — continue checking other branches */ }
                    }
                  }
                  // Fallback: parse conflict files from the error output if merge-tree didn't identify them
                  if (!depConflictBranch) {
                    depConflictFiles = parseConflictFiles(errOutput);
                  }
                  depMergeFailed = true;
                }
                break;
              }
            }
          }
          // Restore stashed changes after dep merge (#973)
          if (stashed) {
            try {
              await execAsync('git stash pop', { ..._gitOpts, cwd: worktreePath });
              log('info', `Restored stashed changes in ${branchName} after dep merge`);
            } catch (popErr) {
              log('warn', `git stash pop failed in ${branchName}: ${popErr.message} — stash preserved for agent`);
            }
          }
          if (depMergeFailed) {
            _cleanupPromptFiles();
            // Build actionable failReason identifying the conflicting branch and files (#958)
            const mainBranch = sanitizeBranch(shared.resolveMainBranch(rootDir, project.mainBranch));
            let failReason = 'Dependency merge failed';
            if (depConflictBranch) {
              if (_isInterDepConflict && _preflightConflictPrev) {
                failReason = `Dependency merge failed: ${depConflictBranch} conflicts with dep ${_preflightConflictPrev}`;
              } else {
                failReason = `Dependency merge failed: ${depConflictBranch} conflicts with ${mainBranch}`;
              }
              if (depConflictFiles.length > 0) failReason += ` in ${depConflictFiles.slice(0, 5).join(', ')}`;
              failReason += ' — dep branch needs updating';
            }
            completeDispatch(id, DISPATCH_RESULT.ERROR, failReason, '', { failureClass: FAILURE_CLASS.MERGE_CONFLICT });

            // Auto-queue conflict-fix work item when a specific dep branch is identified
            if (depConflictBranch && meta?.item?.id && project) {
              try {
                const wiPath = project.name
                  ? projectWorkItemsPath(project)
                  : path.join(MINIONS_DIR, 'work-items.json');
                const conflictFixId = `conflict-fix-${depConflictBranch.replace(/[^a-zA-Z0-9-]/g, '-')}`;
                const filesDesc = depConflictFiles.length > 0
                  ? `\n\nConflicting files:\n${depConflictFiles.map(f => '- ' + f).join('\n')}`
                  : '';
                // Inter-dep conflict: rebase onto the conflicting dep; dep-vs-main: merge main (#958)
                const conflictFixDesc = _isInterDepConflict && _preflightConflictPrev
                  ? `Branch \`${depConflictBranch}\` conflicts with dependency branch \`${_preflightConflictPrev}\`. Rebase \`${depConflictBranch}\` onto \`${_preflightConflictPrev}\` (or merge \`${_preflightConflictPrev}\` into \`${depConflictBranch}\`) and resolve conflicts, then push.`
                  : `Branch \`${depConflictBranch}\` conflicts with \`${mainBranch}\`. Merge ${mainBranch} into the branch and resolve conflicts, then push.`;
                mutateWorkItems(wiPath, items => {
                  // Don't create duplicate conflict-fix items
                  const existing = items.find(i => i.id === conflictFixId && i.status !== WI_STATUS.DONE && i.status !== WI_STATUS.FAILED && i.status !== WI_STATUS.CANCELLED);
                  if (existing) return;
                  items.push({
                    id: conflictFixId,
                    title: `Fix merge conflict: ${depConflictBranch} conflicts with ${_isInterDepConflict ? _preflightConflictPrev : mainBranch}`,
                    type: WORK_TYPE.FIX,
                    priority: 'high',
                    status: WI_STATUS.PENDING,
                    description: `${conflictFixDesc}${filesDesc}\n\nBlocked downstream item: \`${meta.item.id}\` — ${meta.item.title || ''}`,
                    created: ts(),
                    createdBy: 'engine:dep-conflict-fix',
                    _branch: depConflictBranch,
                    _blockedItem: meta.item.id,
                    _isInterDepConflict: _isInterDepConflict || false,
                    project: project.name || null,
                  });
                  log('info', `Auto-queued conflict-fix work item ${conflictFixId} for ${depConflictBranch} (blocked: ${meta.item.id})`);
                });
              } catch (e) { log('warn', `Failed to auto-queue conflict-fix: ${e.message}`); }
            }
            return;
          }
        } catch (e) {
          log('warn', `Could not resolve dependency branches for ${branchName}: ${e.message}`);
        }
      }
    }
  }

  updateAgentStatus(id, AGENT_STATUS.READY, 'Worktree ready, preparing to spawn process');

  // Inject dirty file list when worktree has uncommitted changes (e.g., max_turns retry)
  // This signals to the respawned agent that prior work exists in the worktree (#960)
  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      const dirtyResult = await execAsync('git status --porcelain', { ..._gitOpts, cwd: worktreePath, timeout: 10000 });
      const dirtyOutput = (dirtyResult.stdout || '').trim();
      if (dirtyOutput) {
        const dirtyFiles = dirtyOutput.split('\n').map(l => l.trim()).filter(Boolean);
        const dirtySection = [
          '\n## Uncommitted Work in Worktree\n',
          'The worktree has uncommitted changes from a previous agent run. Review these files and continue from where the previous agent left off.\n',
          '```',
          ...dirtyFiles,
          '```\n',
        ].join('\n');
        // Append dirty file list to the already-written prompt file
        try { fs.appendFileSync(promptPath, dirtySection); } catch (e) { log('warn', `dirty files inject: ${e.message}`); }
        log('info', `Injected ${dirtyFiles.length} dirty files into prompt for ${id}`);
      }
    } catch (e) { log('warn', `git status --porcelain for dirty files: ${e.message}`); }
  }

  // Safety check: warn if a write-capable task is running in the main repo without a worktree
  if (cwd === rootDir && ['implement', 'implement:large', 'fix', 'test', 'verify', 'plan-to-prd'].includes(type)) {
    log('warn', `Agent ${agentId} running ${type} task in main repo (no worktree) for ${id} — changes may land on master directly`);
  }

  // Build claude CLI args
  const args = [
    '--output-format', claudeConfig.outputFormat || 'stream-json',
    '--max-turns', String(_maxTurnsForType(type, engineConfig)),
    '--verbose',
    '--permission-mode', claudeConfig.permissionMode || 'bypassPermissions'
  ];

  if (claudeConfig.allowedTools) {
    args.push('--allowedTools', claudeConfig.allowedTools);
  }

  // Effort level: use 'low' for fast work types unless configured otherwise
  const effort = engineConfig.agentEffort || (_FAST_WORK_TYPES.has(type) ? 'low' : null);
  if (effort) args.push('--effort', effort);

  // Session resume: reuse last session if same branch and recent enough (< 2 hours)
  let cachedSessionId = null;
  // Only resume when the context is relevant — same branch means the agent is
  // continuing work on the same PR/feature (e.g., author fixing their own build failure)
  if (!agentId.startsWith('temp-')) {
    try {
      const sessionFile = safeJson(path.join(AGENTS_DIR, agentId, 'session.json'));
      if (sessionFile?.sessionId && sessionFile.savedAt) {
        const sessionAge = Date.now() - new Date(sessionFile.savedAt).getTime();
        const sameBranch = branchName && sessionFile.branch && sessionFile.branch === branchName;
        if (sessionAge < 2 * 60 * 60 * 1000 && sameBranch) {
          cachedSessionId = sessionFile.sessionId;
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

  // Inject cached ADO token so agents skip re-authentication (#998)
  // getAdoToken() returns cached token (30-min TTL) or null — never blocks on browser auth
  try {
    const adoToken = await getAdoToken();
    if (adoToken) childEnv.MINIONS_ADO_TOKEN = adoToken;
  } catch { /* non-fatal — agent can still authenticate on its own */ }

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
  let _trustCheckDone = false;
  const _spawnTime = Date.now();

  // Live output file — written as data arrives so dashboard can tail it
  const liveOutputPath = path.join(AGENTS_DIR, agentId, 'live-output.log');

  // Rotate previous live output to preserve session history (fixes #543: orphan recovery overwrites)
  // Only rotate if the existing file has meaningful content (beyond just the header)
  const LIVE_OUTPUT_SPARSE_THRESHOLD = 500; // bytes — header + init JSON is typically < 500
  try {
    if (fs.existsSync(liveOutputPath)) {
      const prevStat = fs.statSync(liveOutputPath);
      if (prevStat.size > LIVE_OUTPUT_SPARSE_THRESHOLD) {
        const prevPath = path.join(AGENTS_DIR, agentId, 'live-output-prev.log');
        fs.renameSync(liveOutputPath, prevPath);
      }
    }
  } catch { /* rotation is best-effort — overwrite still happens below */ }

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
    realActivityMap.set(id, Date.now()); // Track real agent output separately from heartbeat
    if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
    try { fs.appendFileSync(liveOutputPath, chunk); } catch { /* optional */ }

    // Trust gate detection: check first 30s of output for trust/permission prompts
    if (!_trustCheckDone && (Date.now() - _spawnTime) <= 30000) {
      const lower = chunk.toLowerCase();
      if (/\b(trust this|do you trust|allow access|grant permission|approve tools?|permission prompt)\b/.test(lower)) {
        _trustCheckDone = true;
        updateAgentStatus(id, AGENT_STATUS.TRUST_BLOCKED, 'Agent appears to be waiting for trust approval');
        log('warn', `Trust gate detected for ${agentId} (${id}) — agent may be blocked on a permission prompt`);
        writeInboxAlert(`trust-blocked-${id}`,
          `# Trust Gate Blocked — \`${id}\`\n\n` +
          `**Agent:** ${agentId}\n` +
          `**Task:** ${dispatchItem.task || type}\n\n` +
          `The agent appears to be blocked on a trust/permission prompt within 30s of spawn.\n` +
          `Check the agent's live output and approve the trust gate manually.\n`
        );
      }
    } else if (!_trustCheckDone) {
      _trustCheckDone = true; // past 30s window
    }

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
              sessionId: obj.session_id, dispatchId: id, savedAt: ts(), branch: branchName
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
    realActivityMap.set(id, Date.now()); // Track real agent output separately from heartbeat
    if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
    try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch { /* optional */ }
  });

  async function onAgentClose(code) {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    log('info', `Agent ${agentId} (${id}) exited with code ${code}`);

    // Emit worker-state transition: FINISHED or FAILED
    updateAgentStatus(id, code === 0 ? AGENT_STATUS.FINISHED : AGENT_STATUS.FAILED,
      code === 0 ? 'Agent completed successfully' : `Agent exited with code ${code}`);

    // Clear stale session if resume failed — prevents burning all retries on the same bad session
    if (code !== 0 && cachedSessionId && stderr.includes('No conversation found')) {
      log('warn', `Stale session ${cachedSessionId} for ${agentId} — clearing session.json`);
      try { shared.safeUnlink(path.join(AGENTS_DIR, agentId, 'session.json')); } catch {}
    }

    // Check if this was a steering kill — re-spawn with resume
    const procInfo = activeProcesses.get(id);
    if (procInfo?._steeringMessage) {
      const steerMsg = procInfo._steeringMessage;
      const steerSessionId = procInfo._steeringSessionId;
      delete procInfo._steeringMessage;
      delete procInfo._steeringSessionId;

      // Guard: can't resume without a session
      if (!steerSessionId) {
        log('warn', `Steering: no sessionId for ${agentId} — appending message to live output only`);
        try { fs.appendFileSync(liveOutputPath, `\n[steering-failed] No session to resume. Message was: ${steerMsg}\n`); } catch {}
        activeProcesses.delete(id);
        completeDispatch(id, DISPATCH_RESULT.SUCCESS, 'Steering skipped (no session)', '', { processWorkItemFailure: false });
        return;
      }

      log('info', `Steering: re-spawning ${agentId} with --resume ${steerSessionId}`);
      // Write status to live output so the UI shows the agent is resuming (not stuck)
      try { fs.appendFileSync(liveOutputPath, `\n[steering] Resuming session with your message... (this may take 10-30s)\n`); } catch {}

      // Wait for the old process tree to fully exit before resuming.
      // taskkill /F /T returns before child processes release session locks.
      // Poll until the PID is gone (max 10s, check every 500ms).
      const oldPid = procInfo.proc?.pid;
      if (oldPid) {
        for (let i = 0; i < 20; i++) {
          try { process.kill(oldPid, 0); } catch { break; } // throws if PID doesn't exist = dead
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Write new prompt with steering message
      const steerPrompt = `Message from your human teammate:\n\n${steerMsg}\n\nRespond to this, then continue working on your current task.`;
      const steerPromptPath = path.join(ENGINE_DIR, 'tmp', `prompt-steer-${safeId}.md`);
      try { safeWrite(steerPromptPath, steerPrompt); } catch (e) {
        log('warn', `Steering: failed to write prompt for ${agentId}: ${e.message}`);
        try { fs.appendFileSync(liveOutputPath, `\n[steering-failed] Could not write prompt. Message was: ${steerMsg}\n`); } catch {}
        activeProcesses.delete(id);
        completeDispatch(id, DISPATCH_RESULT.SUCCESS, 'Steering prompt write failed', '', { processWorkItemFailure: false });
        return;
      }

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
      // Inject cached ADO token for steering session too (#998)
      try {
        const adoToken = await getAdoToken();
        if (adoToken) childEnv.MINIONS_ADO_TOKEN = adoToken;
      } catch { /* non-fatal */ }
      let resumeProc;
      try {
        resumeProc = runFile(process.execPath, [spawnScript, steerPromptPath, sysPromptPath, ...resumeArgs], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
        });
      } catch (e) {
        log('warn', `Steering: spawn failed for ${agentId}: ${e.message}`);
        try { fs.appendFileSync(liveOutputPath, `\n[steering-failed] Spawn error: ${e.message}. Message was: ${steerMsg}\n`); } catch {}
        try { fs.unlinkSync(steerPromptPath); } catch {}
        activeProcesses.delete(id);
        completeDispatch(id, DISPATCH_RESULT.SUCCESS, 'Steering spawn failed', '', { processWorkItemFailure: false });
        return;
      }

      // Re-attach to existing tracking — do NOT carry _steeringAt forward (#1052).
      // The kill watcher in timeout.js fires 30s after _steeringAt is set. If we carry it
      // into the resumed process, it kills the resumed session. The kill watcher only exists
      // to handle cases where the original kill didn't take effect — once the process has
      // exited and the resume is spawned, _steeringAt must not be present.
      activeProcesses.set(id, { proc: resumeProc, agentId, startedAt: procInfo.startedAt, sessionId: steerSessionId, lastRealOutputAt: Date.now() });

      // Reset output buffers so post-completion parsing only sees the resumed session
      stdout = '';
      stderr = '';
      lastOutputAt = Date.now();

      // Restart heartbeat for the resumed process
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        try { fs.appendFileSync(liveOutputPath, `\n[heartbeat] running — no output for ${Math.round((Date.now() - lastOutputAt) / 1000)}s\n`); } catch {}
      }, 30000);

      // Re-wire stdout/stderr handlers (same as original)
      resumeProc.stdout.on('data', (data) => {
        const chunk = data.toString();
        lastOutputAt = Date.now();
        realActivityMap.set(id, Date.now()); // Track real agent output separately from heartbeat
        if (stdout.length < MAX_OUTPUT) stdout += chunk.slice(0, MAX_OUTPUT - stdout.length);
        try { fs.appendFileSync(liveOutputPath, chunk); } catch { /* optional */ }
      });
      resumeProc.stderr.on('data', (data) => {
        const chunk = data.toString();
        lastOutputAt = Date.now();
        realActivityMap.set(id, Date.now()); // Track real agent output separately from heartbeat
        if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
        try { fs.appendFileSync(liveOutputPath, '[stderr] ' + chunk); } catch { /* optional */ }
      });

      // Re-wire close handler for the resumed process
      resumeProc.on('close', (resumeCode) => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        try { fs.unlinkSync(steerPromptPath); } catch { /* cleanup */ }
        if (resumeCode !== 0) {
          log('warn', `Steering resume for ${agentId} exited with code ${resumeCode} | stderr: ${stderr.slice(-300).replace(/\n/g, ' ')}`);
          // Claude CLI can exit code 1 after a successful single-turn --resume session.
          // Only show [steering-failed] if no output was produced — suppress when agent responded despite non-zero exit.
          if (!stdout.trim()) {
            try { fs.appendFileSync(liveOutputPath, `\n[steering-failed] Resume exited with code ${resumeCode}. Your message was received but the agent could not continue the session.\n`); } catch {}
          }
          // Don't assume original work completed — run normal close handler to parse output and determine actual result
          onAgentClose(resumeCode);
          return;
        }
        // Successful resume — run normal close handler
        onAgentClose(resumeCode);
      });
      resumeProc.on('error', (err) => {
        log('warn', `Steering re-spawn error for ${agentId}: ${err.message}`);
        try { fs.appendFileSync(liveOutputPath, `\n[steering-failed] Spawn error: ${err.message}. Your message was received but the agent could not resume.\n`); } catch {}
        activeProcesses.delete(id);
        completeDispatch(id, DISPATCH_RESULT.ERROR, `Steering re-spawn failed: ${err.message}`);
      });

      // Don't run completion hooks — agent is still working
      return;
    }

    // Check if this was a no-session steering kill (#1014) — re-queue for retry instead of erroring.
    // timeout.js sets _steeringNoSession when it kills an agent that hasn't established a sessionId.
    // The steering message is already saved to inbox, so re-queuing lets the engine retry and the
    // agent picks up the message on the next dispatch.
    if (procInfo?._steeringNoSession) {
      log('info', `Steering no-session: re-queue ${agentId} (${id}) — dispatch moved back to pending`);
      activeProcesses.delete(id);
      realActivityMap.delete(id);
      // Move dispatch item from active back to pending so engine retries
      mutateDispatch((dp) => {
        const idx = dp.active.findIndex(d => d.id === id);
        if (idx >= 0) {
          const item = dp.active.splice(idx, 1)[0];
          delete item.started_at;
          delete item.workerState;
          delete item.workerStateAt;
          delete item.workerStateDetail;
          dp.pending.push(item);
        }
        return dp;
      });
      // Cleanup temp files
      try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }
      return;
    }

    activeProcesses.delete(id);
    realActivityMap.delete(id); // Clean up real activity tracking

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

    // Classify failure for non-zero exits
    const failureClass = code !== 0 ? classifyFailure(code, stdout, stderr) : undefined;

    // Detect configuration errors (e.g. Claude CLI not found) — fail immediately with clear message
    if (code === 78) {
      const errMsg = stderr.includes('claude-code') ? stderr.trim() : 'Configuration error — Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code';
      log('error', `Agent ${agentId} (${id}) failed: ${errMsg} [${failureClass}]`);
      completeDispatch(id, DISPATCH_RESULT.ERROR, errMsg, '', { failureClass });
      try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
      try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }
      return;
    }

    // Parse output and run all post-completion hooks
    const { resultSummary, autoRecovered } = await runPostCompletionHooks(dispatchItem, agentId, code, stdout, config);

    // Move from active to completed in dispatch (single source of truth for agent status)
    // autoRecovered: agent failed (e.g. heartbeat timeout) but created PRs — treat as success
    const effectiveResult = (code === 0 || autoRecovered) ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;
    const completeOpts = effectiveResult === DISPATCH_RESULT.ERROR && failureClass ? { failureClass } : {};
    // Extract last 5 non-empty stderr lines as error context when exit code is non-zero
    let errorReason = '';
    if (effectiveResult === DISPATCH_RESULT.ERROR) {
      errorReason = stderr.split('\n').filter(l => l.trim()).slice(-5).join(' | ').trim().slice(0, 300);
    }
    completeDispatch(id, effectiveResult, errorReason, resultSummary, completeOpts);

    // Cleanup temp files (including PID file now that dispatch is complete)
    try { fs.unlinkSync(sysPromptPath); } catch { /* cleanup */ }
    try { fs.unlinkSync(promptPath); } catch { /* cleanup */ }
    try { fs.unlinkSync(promptPath.replace(/prompt-/, 'pid-').replace(/\.md$/, '.pid')); } catch { /* cleanup */ }

    log('info', `Agent ${agentId} completed. Output saved to ${archivePath}`);

    // Track artifacts on the work item for dashboard display
    if (dispatchItem.meta?.item?.id) {
      try {
        const artWiPath = resolveWorkItemPath(dispatchItem.meta);
        if (artWiPath) {
          // Collect inbox notes written by this agent today (with structured IDs if available)
          const _artToday = shared.dateStamp();
          const _artInboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
          let _artNotes = [];
          try {
            const noteFiles = shared.safeReadDir(_artInboxDir).filter(f => f.startsWith(agentId + '-') && f.includes(_artToday));
            for (const f of noteFiles) {
              const content = shared.safeRead(path.join(_artInboxDir, f));
              const noteId = shared.parseNoteId(content);
              _artNotes.push({ file: f, id: noteId || f.replace(/\.md$/, '') });
            }
          } catch {}

          mutateJsonFileLocked(artWiPath, data => {
            if (!Array.isArray(data)) return data;
            const wi = data.find(i => i.id === dispatchItem.meta.item.id);
            if (!wi) return data;
            const arts = wi._artifacts || {};
            arts.outputLog = `agents/${agentId}/output-${id}.log`;
            if (dispatchItem.meta.branch) arts.branch = dispatchItem.meta.branch;
            if (wi._pr) arts.pr = wi._pr;
            if (wi._prUrl) arts.prUrl = wi._prUrl;
            if (_artNotes.length > 0) arts.notes = _artNotes;
            // Track plan/PRD artifacts from dispatch metadata
            if (dispatchItem.meta.item?.planFile) arts.plan = dispatchItem.meta.item.planFile;
            if (dispatchItem.meta.item?._prdFilename) arts.prd = dispatchItem.meta.item._prdFilename;
            if (dispatchItem.meta.item?.sourcePlan) arts.sourcePlan = dispatchItem.meta.item.sourcePlan;
            wi._artifacts = arts;
            return data;
          });
        }
      } catch (err) { log('warn', `Artifact tracking: ${err.message}`); }
    }

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
    realActivityMap.delete(id); // Clean up real activity tracking
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
  realActivityMap.set(id, Date.now()); // Initialize real activity at spawn time

  updateAgentStatus(id, AGENT_STATUS.RUNNING, `Process spawned for ${agentId}`);

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
    delete item._agentBusySince;
    if (!dispatch.active.some(d => d.id === id)) {
      dispatch.active.push(item);
    }
    return dispatch;
  });

  // Atomically stamp dispatched_to/dispatched_at on the originating work item (#402)
  // The discover phase sets these via safeWrite which can race with concurrent writes;
  // this locked write ensures the fields are persisted reliably.
  if (meta?.item?.id) {
    try {
      let wiPath = null;
      if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      } else if (meta.source === 'work-item' && meta.project?.name) {
        wiPath = projectWorkItemsPath({ name: meta.project.name, localPath: meta.project.localPath });
      }
      if (wiPath) {
        mutateJsonFileLocked(wiPath, (items) => {
          if (!Array.isArray(items)) return items;
          const wi = items.find(i => i.id === meta.item.id);
          if (wi) {
            wi.dispatched_to = wi.dispatched_to || agentId;
            wi.dispatched_at = wi.dispatched_at || startedAt;
            if (wi.status !== WI_STATUS.DISPATCHED) wi.status = WI_STATUS.DISPATCHED;
          }
          return items;
        }, { defaultValue: [] });
      }
    } catch (e) { log('warn', `stamp dispatched_to on work item ${meta.item.id}: ${e.message}`); }
  }

  return proc;
}

// addToDispatch, isRetryableFailureReason — now in engine/dispatch.js

// completeDispatch — now in engine/dispatch.js

// ─── Dependency Gate ─────────────────────────────────────────────────────────
// Returns: true (deps met), false (deps pending), 'failed' (dep failed — propagate)
function areDependenciesMet(item, config) {
  const deps = item.depends_on;
  if (!deps || deps.length === 0) return true;
  const sourcePlan = item.sourcePlan;
  if (!sourcePlan) return true;
  const projects = getProjects(config);

  // Collect work items from ALL projects (dependencies can be cross-project)
  const allWorkItems = queries.getWorkItems(config);
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
    if (depItem.status === WI_STATUS.FAILED) return 'failed';
    if (depItem.status === WI_STATUS.DECOMPOSED) {
      // Decomposed: check if all children are done
      const children = allWorkItems.filter(w => w.parent_id === depId);
      if (children.length > 0 && children.every(c => PRD_MET_STATUSES.has(c.status))) continue; // all children done
      if (children.length > 0) return false; // children still in progress
      continue; // no children found — treat as met (decomposition may be in flight)
    }
    if (!PRD_MET_STATUSES.has(depItem.status)) return false; // Pending, dispatched, or retrying — wait
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
    // Reconcile pending items AND failed items that have a matching PR
    // (failed items may have been incorrectly marked during engine downtime)
    if (wi._pr && wi.status !== WI_STATUS.FAILED) continue;
    if (wi.status !== WI_STATUS.PENDING && wi.status !== WI_STATUS.FAILED) continue;
    if (onlyIds && !onlyIds.has(wi.id)) continue;

    // Short-circuit: failed item already has a PR attached — mark done directly (#407)
    if (wi.status === WI_STATUS.FAILED && wi._pr) {
      wi.status = WI_STATUS.DONE;
      if (wi.failReason) delete wi.failReason;
      if (wi.failedAt) delete wi.failedAt;
      if (!wi.completedAt) wi.completedAt = ts();
      reconciled++;
      continue;
    }

    let exactPr = allPrs.find(pr => (pr.prdItems || []).includes(wi.id));
    if (!exactPr) {
      const linkedPrId = Object.keys(prLinks).find(prId => prLinks[prId] === wi.id);
      if (linkedPrId) exactPr = allPrs.find(pr => pr.id === linkedPrId) || { id: linkedPrId };
    }
    // Branch-based matching: PR branch contains the work item ID (e.g. work/P-k7m2v9a1)
    if (!exactPr) {
      exactPr = allPrs.find(pr => pr.branch && pr.branch.includes(wi.id));
    }
    if (exactPr) {
      wi.status = WI_STATUS.DONE;
      wi._pr = exactPr.id;
      // Clear failure artifacts if reconciling a previously failed item
      if (wi.failReason) delete wi.failReason;
      if (wi.failedAt) delete wi.failedAt;
      if (!wi.completedAt) wi.completedAt = ts();
      reconciled++;
    }
  }
  return reconciled;
}

// ─── Inbox Consolidation (extracted to engine/consolidation.js) ──────────────

const { consolidateInbox } = require('./engine/consolidation');
const { pollPrStatus, pollPrHumanComments, reconcilePrs, checkLiveReviewStatus: adoCheckLiveReview, needsAdoPollRetry, getAdoToken, isAdoThrottled } = require('./engine/ado');
const { pollPrStatus: ghPollPrStatus, pollPrHumanComments: ghPollPrHumanComments, reconcilePrs: ghReconcilePrs, checkLiveReviewStatus: ghCheckLiveReview, isGhThrottled } = require('./engine/github');

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
  setCooldownFailure, isAlreadyDispatched, isBranchActive } = require('./engine/cooldown');



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
      mutateWorkItems(wiPath, items => {
        const filtered = items.filter(w => {
          if (w.sourcePlan === prdFile && (w.status === WI_STATUS.PENDING || w.status === WI_STATUS.FAILED)) {
            deletedIds.push(w.id); return false;
          }
          return true;
        });
        if (filtered.length < items.length) return filtered;
      });
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
    // Reset PRD item status to 'missing' so engine re-materializes on next tick
    for (const id of deletedIds) {
      try { syncPrdItemStatus(id, 'missing', prdFile); } catch (e) { log('warn', `PRD status reset for ${id}: ${e.message}`); }
    }
    log('info', `Plan sync: cleared ${deletedIds.length} pending/failed work items for ${prdFile}`);
  }
}

function buildWiDescription(item, planFile) {
  const criteria = (item.acceptance_criteria || []).map(c => `- ${c}`).join('\n');
  const complexity = item.estimated_complexity || 'medium';
  return `${item.description || ''}\n\n**Plan:** ${planFile}\n**Plan Item:** ${item.id}\n**Complexity:** ${complexity}${criteria ? '\n\n**Acceptance Criteria:**\n' + criteria : ''}`;
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

  // Regex for detecting sequential PRD item IDs (P-001, P-002) — hoisted outside loop
  const SEQUENTIAL_ID_RE = /^P-?\d+$/;

  for (const file of planFiles) {
    const plan = safeJson(path.join(PRD_DIR, file));
    if (!plan?.missing_features) continue;

    // ID collision prevention: remap sequential IDs (P-001, P-002) to globally unique P-<uid> IDs.
    // Agents are instructed to use P-<uuid> format but sometimes generate sequential IDs,
    // which collide across PRDs causing phantom done/dispatched status (see #466).
    try {
      if (plan.missing_features.some(f => SEQUENTIAL_ID_RE.test(f.id))) {
        const allWorkItems = queries.getWorkItems(config);
        const anyMaterialized = plan.missing_features.some(f =>
          SEQUENTIAL_ID_RE.test(f.id) && allWorkItems.some(w => w.id === f.id && w.sourcePlan === file));
        if (!anyMaterialized) {
          const idMap = new Map();
          for (const f of plan.missing_features) {
            if (SEQUENTIAL_ID_RE.test(f.id)) {
              const newId = 'P-' + shared.uid();
              idMap.set(f.id, newId);
              f.id = newId;
            }
          }
          for (const f of plan.missing_features) {
            if (f.depends_on) f.depends_on = f.depends_on.map(d => idMap.get(d) || d);
          }
          safeWrite(path.join(PRD_DIR, file), plan);
          log('info', `Remapped ${idMap.size} sequential ID(s) in ${file} to prevent cross-PRD collisions`);
        }
      }
    } catch (e) { log('warn', `Sequential ID remapping failed for ${file}: ${e.message}`); }

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
          plan.lastSyncedFromPlan = ts();

          // Handle PRD based on current status
          const prdStatus = plan.status || (plan.requires_approval ? 'awaiting-approval' : null);

          // Flag stale for all statuses — user decides when to regenerate/resume from dashboard
          if (prdStatus) {
            plan.planStale = true;
            log('info', `PRD ${file} flagged as stale (plan revised while ${prdStatus}) — user can regenerate from dashboard`);
          }

          safeWrite(path.join(PRD_DIR, file), plan);
        }
      } catch (e) { log('warn', 'plan staleness check: ' + e.message); }
    }

    // Human approval gate: plans start as 'awaiting-approval' and must be approved before work begins
    // Plans without a status (legacy) or with status 'approved' are allowed through
    const planStatus = plan.status || (plan.requires_approval ? 'awaiting-approval' : null);
    if (planStatus === 'awaiting-approval') {
      if (config.engine?.autoApprovePlans) {
        plan.status = 'approved';
        plan.approvedAt = ts();
        plan.approvedBy = 'auto-mode';
        safeWrite(path.join(PRD_DIR, file), plan);
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

    const statusFilter = PRD_MATERIALIZABLE;
    // Also materialize in-pr/done items that never got a work item (race with PR status sync)
    const allExistingWiIds = new Set();
    for (const w of queries.getWorkItems()) {
      if (w.id) allExistingWiIds.add(w.id);
    }
    const items = plan.missing_features.filter(f =>
      statusFilter.has(f.status) ||
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
      let created = 0;
      const newlyCreatedIds = new Set(); // tracks IDs created in this pass for reconciliation scoping
      const deferredReopens = []; // cross-project re-opens executed after this lock releases

      mutateWorkItems(wiPath, existingItems => {
        for (const item of projItems) {
          // Re-open: 'updated' or 'missing' re-opens a done work item (#906)
          const existingWi = existingItems.find(w => w.id === item.id);
          const shouldReopen = item.status === PRD_ITEM_STATUS.UPDATED || item.status === PRD_ITEM_STATUS.MISSING;
          if (existingWi && DONE_STATUSES.has(existingWi.status) && shouldReopen) {
            shared.reopenWorkItem(existingWi);
            existingWi.description = buildWiDescription(item, file);
            existingWi.title = `Implement: ${item.name}`;
            created++;
            log('info', `Re-opened work item ${item.id} (PRD item set back to ${item.status}) — will dispatch to existing branch`);
            continue;
          }

          // Skip if already materialized — work item ID = PRD item ID, check all projects
          let alreadyExists = !!existingWi;
          if (!alreadyExists) {
            for (const p of allProjects) {
              if (p.name === projName) continue;
              const otherItems = safeJson(projectWorkItemsPath(p)) || [];
              const otherWi = otherItems.find(w => w.id === item.id);
              if (otherWi) {
                if (DONE_STATUSES.has(otherWi.status) && shouldReopen) {
                  deferredReopens.push({ itemId: item.id, projectName: p.name, item });
                  created++;
                }
                alreadyExists = true; break;
              }
            }
          }
          if (alreadyExists) continue;
          // Skip items involved in dependency cycles
          if (cycleSet.has(item.id)) continue;

          const id = item.id;
          const complexity = item.estimated_complexity || 'medium';

          const newItem = {
            id,
            title: `Implement: ${item.name}`,
            type: complexity === 'large' ? 'implement:large' : 'implement',
            priority: item.priority || 'medium',
            description: buildWiDescription(item, file),
            status: 'pending',
            created: ts(),
            createdBy: 'engine:plan-discovery',
            sourcePlan: file,
            depends_on: item.depends_on || [],
            branchStrategy: plan.branch_strategy || 'parallel',
            featureBranch: plan.feature_branch || null,
            project: item.project || plan.project || null,
            _source: projName,
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
            if (wi.status !== WI_STATUS.PENDING || wi.sourcePlan !== file) continue;
            if (!currentPrdIds.has(wi.id)) {
              wi.status = WI_STATUS.CANCELLED;
              wi.cancelledAt = ts();
              wi.cancelReason = `PRD item removed from ${file}`;
              cancelled++;
            }
          }
          if (cancelled > 0) log('info', `Plan sync: cancelled ${cancelled} item(s) removed from ${file} → ${projName}`);

          log('info', `Plan discovery: created ${created} work item(s) from ${file} → ${projName}`);
        }
      });

      // Process cross-project re-opens outside the lock (no nested locks)
      for (const { itemId, projectName: rProjName, item: rItem } of deferredReopens) {
        const rProject = allProjects.find(p => p.name === rProjName);
        if (!rProject) continue;
        const rPath = projectWorkItemsPath(rProject);
        mutateWorkItems(rPath, items => {
          const target = items.find(w => w.id === itemId);
          if (target && DONE_STATUSES.has(target.status)) {
            shared.reopenWorkItem(target);
            target.description = buildWiDescription(rItem, file);
            target.title = `Implement: ${rItem.name}`;
          }
        });
        log('info', `Re-opened work item ${itemId} in ${rProjName} (cross-project, PRD item set to ${rItem.status})`);
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
    mutatePullRequests(prsPath, prs => {
      const target = prs.find(p => p.id === prId);
      if (!target?.humanFeedback?.pendingFix) return;
      target.humanFeedback.pendingFix = false;
    });
  } catch (e) { log('warn', 'clear pending human feedback flag: ' + e.message); }
}

/**
 * Scan pull-requests.json for PRs needing review or fixes
 */
async function discoverFromPrs(config, project) {
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
    if (pr.status !== PR_STATUS.ACTIVE || pr._contextOnly) continue;
    if (activePrIds.has(pr.id)) continue; // Skip PRs with active dispatch (prevent race)
    // Branch mutex: skip if PR branch is locked by any active dispatch (cross-type collision)
    if (pr.branch && isBranchActive(pr.branch)) {
      log('info', `Branch mutex: skipping PR ${pr.id} dispatch — branch ${pr.branch} locked by another agent`);
      continue;
    }
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

    // Review→fix cycle cap — stop review/fix dispatch after N iterations, but allow build fixes and conflict fixes
    const evalMax = config.engine?.evalMaxIterations ?? DEFAULTS.evalMaxIterations;
    const evalCycles = pr._reviewFixCycles || 0;
    const evalEscalated = evalCycles >= evalMax;
    if (evalEscalated && !pr._evalEscalated) {
      writeInboxAlert(`eval-escalated-${pr.agent || 'unassigned'}-${pr.id}`,
        `# Review Loop Escalation\n\n**PR ${pr.id}**: ${pr.title || ''} on branch \`${pr.branch || 'unknown'}\` has gone through **${evalCycles}** review→fix cycles without approval.\n\n` +
        `Last review: ${pr.minionsReview?.note ? pr.minionsReview.note.slice(0, 200) : 'See PR thread'}\n\n` +
        `Auto-dispatch of reviews and fixes has been suspended. Please review the PR manually.`);
      try {
        mutatePullRequests(projectPrPath(project), prs => {
          const target = prs.find(p => p.id === pr.id);
          if (target) target._evalEscalated = true;
        });
      } catch (e) { log('warn', 'mark eval escalated: ' + e.message); }
      log('warn', `PR ${pr.id}: review→fix escalated after ${evalCycles} cycles — suspending auto-dispatch`);
    }

    // PRs needing review: pending review status and not already reviewed without new commits
    const autoReview = config.engine?.autoReview !== false;
    const alreadyReviewed = pr.lastReviewedAt && (!pr.lastPushedAt || pr.lastPushedAt <= pr.lastReviewedAt);
    const needsReview = autoReview && reviewStatus === 'pending' && !alreadyReviewed && !evalEscalated;
    if (needsReview) {
      const key = `review-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;

      // Pre-dispatch live vote check — cached reviewStatus may be stale (poll lag ~6 min)
      try {
        const checkFn = project.repoHost === 'github' ? ghCheckLiveReview : adoCheckLiveReview;
        const liveStatus = await checkFn(pr, project);
        if (liveStatus && liveStatus !== 'pending') {
          log('info', `Pre-dispatch vote check: ${pr.id} is ${liveStatus} (cached was pending) — skipping review`);
          // Never downgrade from approved
          if (pr.reviewStatus !== 'approved') pr.reviewStatus = liveStatus;
          // Persist so next tick doesn't re-check
          try {
            mutateJsonFileLocked(projectPrPath(project), data => {
              if (!Array.isArray(data)) return data;
              const target = data.find(p => p.id === pr.id);
              if (target && target.reviewStatus !== 'approved') target.reviewStatus = liveStatus;
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
      }, `Review ${pr.id}: ${pr.title}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); }
    }

    // PRs with changes requested → route back to author for fix
    let fixDispatched = false;
    if (reviewStatus === 'changes-requested' && !awaitingReReview && !evalEscalated) {
      const key = `fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: pr.minionsReview?.note || pr.reviewNote || 'See PR thread comments',
      }, `Fix ${pr.id}: ${pr.title || ''} — review feedback`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) {
        newWork.push(item); setCooldown(key); fixDispatched = true;
        // Increment review→fix cycle counter
        try {
          mutatePullRequests(projectPrPath(project), prs => {
            const target = prs.find(p => p.id === pr.id);
            if (target) target._reviewFixCycles = (target._reviewFixCycles || 0) + 1;
          });
        } catch (e) { log('warn', 'increment review-fix cycles: ' + e.message); }
      }
    }

    // PRs with pending human feedback (skip if review-fix already dispatched above)
    const humanFixKey = `human-fix-${project?.name || 'default'}-${pr.id}`;
    const hasCoalescedFeedback = (dispatchCooldowns.get(humanFixKey)?.pendingContexts || []).length > 0;
    if ((pr.humanFeedback?.pendingFix || hasCoalescedFeedback) && !awaitingReReview && !fixDispatched) {
      const key = humanFixKey;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) {
        // Coalesce: save feedback for next dispatch
        if (pr.humanFeedback?.feedbackContent) {
          setCooldownWithContext(key, { feedbackContent: pr.humanFeedback.feedbackContent, timestamp: ts() });
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
      }, `Fix ${pr.id}: ${pr.title || ''} — human feedback`, { dispatchKey: key, source: 'pr-human-feedback', pr, branch: pr.branch, project: projMeta });
      if (item) { newWork.push(item); setCooldown(key); fixDispatched = true; }
    }

    // PRs with build failures — route to author (has session context from implementing)
    // Grace period: after a build fix push, wait for CI to run before re-dispatching
    // Skip if build hasn't transitioned since last fix (still showing the old failure)
    if (pr._buildFixPushedAt && pr.buildStatus === 'failing') {
      const gracePeriodMs = config.engine?.buildFixGracePeriod ?? DEFAULTS.buildFixGracePeriod;
      if (Date.now() - new Date(pr._buildFixPushedAt).getTime() < gracePeriodMs) continue;
    }
    if (pr.status === PR_STATUS.ACTIVE && pr.buildStatus === 'failing') {
      const maxBuildFix = config.engine?.maxBuildFixAttempts ?? DEFAULTS.maxBuildFixAttempts;

      // Check if max retry cap reached — escalate to human instead of dispatching another fix
      if ((pr.buildFixAttempts || 0) >= maxBuildFix) {
        if (!pr.buildFixEscalated) {
          writeInboxAlert(`build-fix-escalated-${pr.agent || 'unassigned'}-${pr.id}`,
            `# Build Fix Escalation\n\n` +
            `**PR ${pr.id}**: ${pr.title || ''} on branch \`${pr.branch || 'unknown'}\` has failed **${pr.buildFixAttempts}** consecutive auto-fix attempts.\n` +
            `**Last failure:** ${pr.buildFailReason || 'Check CI pipeline for details'}\n\n` +
            `Auto-fix dispatch has been suspended. Please investigate manually.\n`
          );
          try {
            const prPath = projectPrPath(project);
            mutatePullRequests(prPath, prs => {
              const target = prs.find(p => p.id === pr.id);
              if (target) target.buildFixEscalated = true;
            });
          } catch (e) { log('warn', 'mark build fix escalated: ' + e.message); }
          log('warn', `PR ${pr.id}: build fix escalated after ${pr.buildFixAttempts} attempts — suspending auto-dispatch`);
        }
        continue;
      }

      const key = `build-fix-${project?.name || 'default'}-${pr.id}`;
      if (isAlreadyDispatched(key) || isOnCooldown(key, cooldownMs)) continue;
      const agentId = resolveAgent('fix', config, pr.agent);
      if (!agentId) continue;

      let reviewNote = `Build is failing: ${pr.buildFailReason || 'Check CI pipeline for details'}. Fix the build errors and push.`;
      if (pr.buildErrorLog) {
        reviewNote += `\n\n## Build Error Log\n\n\`\`\`\n${pr.buildErrorLog}\n\`\`\``;
      }

      const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
        pr_id: pr.id, pr_branch: pr.branch || '',
        review_note: reviewNote,
      }, `Fix build failure on ${pr.id}: ${pr.title || ''}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
      if (item) {
        newWork.push(item); setCooldown(key);
        // Increment build fix attempts counter
        try {
          const prPath = projectPrPath(project);
          mutatePullRequests(prPath, prs => {
            const target = prs.find(p => p.id === pr.id);
            if (target) {
              target.buildFixAttempts = (target.buildFixAttempts || 0) + 1;
              target._buildFixPushedAt = ts();
            }
          });
        } catch (e) { log('warn', 'increment build fix attempts: ' + e.message); }
      }

      // Notify the author agent about the build failure
      if (pr.agent && !pr._buildFailNotified) {
        let alertBody = `# Build Failure Notification\n\n` +
          `**Your PR ${pr.id}**: ${pr.title || ''} on branch \`${pr.branch || 'unknown'}\` has a failing build.\n` +
          `**Reason:** ${pr.buildFailReason || 'Check CI pipeline for details'}\n\n`;
        if (pr.buildErrorLog) {
          // Include first 30 lines of error log in notification (full log in fix agent prompt)
          const logPreview = pr.buildErrorLog.split('\n').slice(0, 30).join('\n');
          alertBody += `**Error preview:**\n\`\`\`\n${logPreview}\n\`\`\`\n\n`;
        }
        alertBody += `A fix agent has been dispatched to address this. Review the fix when complete.\n`;
        writeInboxAlert(`build-fail-${pr.agent}-${pr.id}`, alertBody);
        // Mark notified to prevent duplicate alerts
        try {
          const prPath = projectPrPath(project);
          mutatePullRequests(prPath, prs => {
            const target = prs.find(p => p.id === pr.id);
            if (target) {
              target._buildFailNotified = true;
            }
          });
        } catch (e) { log('warn', 'mark build fail notified: ' + e.message); }
      }
    }

    // PRs with merge conflicts — dispatch fix to resolve (gated by autoFixConflicts)
    const autoFixConflicts = config.engine?.autoFixConflicts ?? DEFAULTS.autoFixConflicts;
    if (autoFixConflicts && pr.status === PR_STATUS.ACTIVE && pr._mergeConflict && !fixDispatched) {
      const key = `conflict-fix-${project?.name || 'default'}-${pr.id}`;
      // Suppress re-dispatch for 10 min after last attempt — ADO/GitHub recomputes
      // mergeStatus asynchronously (1–5 min lag), so the flag may stay set even after
      // a successful push. _conflictFixedAt is cleared when the poller confirms clean status.
      const conflictFixedAt = pr._conflictFixedAt;
      const withinLag = conflictFixedAt && Date.now() - new Date(conflictFixedAt).getTime() < 10 * 60 * 1000;
      if (!withinLag && !isAlreadyDispatched(key) && !isOnCooldown(key, cooldownMs)) {
        const agentId = resolveAgent('fix', config, pr.agent);
        if (agentId) {
          const item = buildPrDispatch(agentId, config, project, pr, 'fix', {
            pr_id: pr.id, pr_branch: pr.branch || '',
            review_note: `This PR has merge conflicts with the target branch. Resolve the conflicts:\n\n1. Pull latest from main/master\n2. Resolve all conflicts (prefer PR branch changes unless main has critical fixes)\n3. Build and test after resolving\n4. Push the resolved branch`,
          }, `Fix merge conflicts on ${pr.id}: ${pr.title || ''}`, { dispatchKey: key, source: 'pr', pr, branch: pr.branch, project: projMeta });
          if (item) {
            newWork.push(item);
            setCooldown(key);
            // Record dispatch timestamp so re-dispatch is suppressed during ADO lag window
            try {
              mutatePullRequests(projectPrPath(project), prs => {
                const target = prs.find(p => p.id === pr.id);
                if (target) target._conflictFixedAt = new Date().toISOString();
              });
            } catch (e) { log('warn', `conflict-fix timestamp: ${e.message}`); }
          }
        }
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
  // PRD sync for dispatched status deferred to spawnAgent success (#480)
  const skipped = { gated: 0, noAgent: 0 };
  let needsWrite = false;
  const selfHealKeys = new Set(); // Collect keys for batched self-heal (1 lock instead of N)

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
      if (depStatus === 'failed' && !isItemCompleted(item)) {
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
    // Self-heal: collect keys for batched dispatch.json cleanup (after the loop)
    selfHealKeys.add(key);
    dispatchCooldowns.delete(key);
    // Cooldown bypass for resumed items
    if (item._resumedAt) {
      delete item._resumedAt;
      needsWrite = true;
    }
    // Skip dedup for items explicitly marked for retry (_retryCount set by engine)
    const isRetry = !!item._retryCount;
    if (isAlreadyDispatched(key)) {
      // Retry items should bypass the completed-dedup but still block if in-flight
      if (isRetry) {
        const inFlight = [...(getDispatch().pending || []), ...(getDispatch().active || [])];
        if (!inFlight.some(d => d.meta?.dispatchKey === key)) {
          // Not in-flight — allow retry to proceed
        } else {
          if (item._pendingReason !== 'already_dispatched') { item._pendingReason = 'already_dispatched'; needsWrite = true; }
          skipped.gated++; continue;
        }
      } else {
        // Only self-heal to DISPATCHED if actually in dispatch.active (agent spawned) (#480)
        const existingActive = getDispatch().active?.find(d => d.meta?.dispatchKey === key);
        if (existingActive) {
          if (item.status === WI_STATUS.PENDING) { item.status = WI_STATUS.DISPATCHED; needsWrite = true; }
          if (!item.dispatched_to && existingActive.agent) { item.dispatched_to = existingActive.agent; needsWrite = true; }
        }
        if (item._pendingReason !== 'already_dispatched') { item._pendingReason = 'already_dispatched'; needsWrite = true; }
        skipped.gated++; continue;
      }
    }
    if (isOnCooldown(key, cooldownMs)) {
      if (item._pendingReason !== 'cooldown') { item._pendingReason = 'cooldown'; needsWrite = true; }
      skipped.gated++; continue;
    }

    let workType = item.type || 'implement';
    if (workType === WORK_TYPE.IMPLEMENT && (item.complexity === 'large' || item.estimated_complexity === 'large')) {
      workType = WORK_TYPE.IMPLEMENT_LARGE;
    }
    // Auto-decompose large items before implementation
    if (workType === 'implement:large' && !item._decomposed && !item._decomposing && config.engine?.autoDecompose !== false) {
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

    // Branch mutex: skip if target branch is locked by an active dispatch
    const branchConflict = isBranchActive(branchName);
    if (branchConflict) {
      if (item._pendingReason !== 'branch_locked') { item._pendingReason = 'branch_locked'; needsWrite = true; }
      skipped.gated++;
      log('info', `Branch mutex: skipping ${item.id} — branch ${branchName} locked by ${branchConflict.id} (${branchConflict.agent})`);
      continue;
    }

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
    // Build common vars: references, acceptance criteria, checkpoint, notes, task context
    const cpResult = buildWorkItemDispatchVars(item, vars, config, {
      worktreePath: vars.worktree_path || root,
      workType,
    });
    if (cpResult.needsReview) {
      log('warn', `Work item ${item.id} exceeded 3 checkpoint-resumes — marking as needs-human-review`);
      item.status = WI_STATUS.NEEDS_REVIEW;
      item._checkpointCount = cpResult.checkpointCount;
      needsWrite = true;
      continue;
    }
    if (cpResult.checkpointCount !== null) {
      item._checkpointCount = cpResult.checkpointCount;
      needsWrite = true;
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

    // Don't mark dispatched here — item stays pending until spawnAgent succeeds.
    // spawnAgent() atomically stamps dispatched_to/dispatched_at/status via locked write (#480).
    // isAlreadyDispatched(key) prevents re-discovery on subsequent ticks.
    delete item._pendingReason;
    needsWrite = true;

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

  // Batched self-heal: clear all stale completed entries in ONE lock acquisition
  if (selfHealKeys.size > 0) {
    try {
      mutateDispatch((dp) => {
        dp.completed = (Array.isArray(dp.completed) ? dp.completed : []).filter(d => !selfHealKeys.has(d.meta?.dispatchKey));
        return dp;
      });
    } catch (e) { log('warn', 'batched self-heal: ' + e.message); }
  }

  // Auto-promote decomposed parents to done when all sub-tasks complete
  for (const item of items) {
    if (item.status !== WI_STATUS.DECOMPOSED || !item._subItemIds?.length) continue;
    const allSubsDone = item._subItemIds.every(sid => {
      const sub = items.find(i => i.id === sid);
      return sub && DONE_STATUSES.has(sub.status);
    });
    if (allSubsDone) {
      item.status = WI_STATUS.DONE;
      if (!item.completedAt) item.completedAt = ts();
      needsWrite = true;
      log('info', `Decomposed parent ${item.id} → done (all ${item._subItemIds.length} sub-tasks complete)`);
      if (item.sourcePlan) syncPrdItemStatus(item.id, WI_STATUS.DONE, item.sourcePlan);
    }
  }

  // Write back updated statuses (pendingReason clears, checkpoint counts, decompose flags, etc.)
  if (needsWrite) {
    mutateWorkItems(projectWorkItemsPath(project), () => items);
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

/**
 * Build common dispatch vars for a work item: references, acceptance criteria,
 * checkpoint context, notes content, and resolved task context.
 *
 * Consolidates duplicated patterns across discoverFromWorkItems, discoverCentralWorkItems
 * (normal + fan-out). Caller-specific vars (project_name, work_branch, plan vars) are NOT
 * handled here — they remain in the caller.
 *
 * @param {Object} item - Work item
 * @param {Object} vars - Mutable vars object to populate (must already have base vars)
 * @param {Object} config - Engine config
 * @param {Object} [options]
 * @param {string} [options.worktreePath] - Path for checkpoint lookup (omit to skip checkpoint)
 * @param {boolean} [options.includeNotes=true] - Whether to read notes.md into vars.notes_content
 * @param {string} [options.workType] - Work type (used for ASK-specific vars)
 * @returns {{ needsReview: boolean, checkpointCount: number|null }} checkpoint side-effect info
 */
function buildWorkItemDispatchVars(item, vars, config, options = {}) {
  const { worktreePath, includeNotes = true, workType } = options;

  // Notes content (uses queries.getNotes instead of inline fs.readFileSync)
  if (includeNotes) {
    vars.notes_content = getNotes() || '';
  }

  // References
  const refs = (item.references || []).filter(r => r && r.url).map(r =>
    '- [' + (r.title || r.url) + '](' + r.url + ')' + (r.type ? ' (' + r.type + ')' : '')
  ).join('\n');
  vars.references = refs ? '## References\n\n' + refs : '';

  // Acceptance criteria
  const ac = normalizeAc(item.acceptanceCriteria).map(c => '- [ ] ' + c).join('\n');
  vars.acceptance_criteria = ac ? '## Acceptance Criteria\n\n' + ac : '';

  // Checkpoint context
  vars.checkpoint_context = '';
  const result = { needsReview: false, checkpointCount: null };
  if (worktreePath) {
    try {
      const cpPath = path.join(worktreePath, 'checkpoint.json');
      if (fs.existsSync(cpPath)) {
        const cpData = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        const cpCount = (item._checkpointCount || 0) + 1;
        result.checkpointCount = cpCount;
        if (cpCount > 3) {
          result.needsReview = true;
        } else {
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
      }
    } catch (e) { log('warn', `checkpoint read for ${item.id}: ${e.message}`); }
  }

  // ASK-specific variables
  if (workType === WORK_TYPE.ASK) {
    vars.question = item.title + (item.description ? '\n\n' + item.description : '');
    vars.task_id = item.id;
    vars.notes_content = getNotes() || '';
  }

  // Resolve implicit context references (e.g., "ripley's plan", "the latest plan")
  const resolvedCtx = resolveTaskContext(item, config);
  if (resolvedCtx.additionalContext) {
    vars.additional_context = (vars.additional_context || '') + resolvedCtx.additionalContext;
    if (vars.task_description !== undefined) {
      vars.task_description = vars.task_description + resolvedCtx.additionalContext;
    }
  }

  return result;
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
  let created = 0;

  mutateWorkItems(wiPath, existingItems => {
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
  });
  mutateJsonFileLocked(trackerPath, () => tracker, { defaultValue: {} });
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
  // Collect mutations to apply atomically inside lock callback (avoids TOCTOU)
  const mutations = new Map(); // item.id → { field: value, ... }

  for (const item of items) {
    try {
    if (item.status !== WI_STATUS.QUEUED && item.status !== WI_STATUS.PENDING) continue;

    const key = `central-work-${item.id}`;
    // Skip dedup for items explicitly marked for retry (_retryCount set by engine)
    const isRetry = !!item._retryCount;
    if (isAlreadyDispatched(key)) {
      if (isRetry) {
        // Retry items bypass completed-dedup but still block if in-flight
        const inFlight = [...(getDispatch().pending || []), ...(getDispatch().active || [])];
        if (inFlight.some(d => d.meta?.dispatchKey === key)) continue;
        // Not in-flight — fall through to dispatch
      } else {
        // Self-heal: set DISPATCHED only when in dispatch.active (agent spawned) (#480)
        const existingActive = getDispatch().active?.find(d => d.meta?.dispatchKey === key);
        if (existingActive) {
          const m = {};
          if (item.status === WI_STATUS.PENDING) { m.status = WI_STATUS.DISPATCHED; }
          if (!item.dispatched_to && existingActive.agent) { m.dispatched_to = existingActive.agent; }
          if (Object.keys(m).length > 0) mutations.set(item.id, m);
        }
        continue;
      }
    }
    if (isOnCooldown(key, 0)) continue;

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

        const ap = assignedProject || (projects.length > 0 ? projects[0] : null);
        if (!ap) { log('warn', `Fan-out: skipping ${fanKey} — no projects configured`); continue; }
        const fanBranch = `fan/${item.id}/${agent.id}`;
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
          branch_name: fanBranch,
        };

        // Build common vars: references, acceptance criteria, notes (ASK only), task context
        buildWorkItemDispatchVars(item, vars, config, {
          includeNotes: false,
          workType,
        });

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
            branch: fanBranch,
            deadline: item.timeout ? Date.now() + item.timeout : Date.now() + (config.engine?.fanOutTimeout || config.engine?.agentTimeout || DEFAULTS.agentTimeout)
          }
        });
      }

      // Don't mark dispatched here — spawnAgent stamps status atomically (#480)
      mutations.set(item.id, {
        scope: 'fan-out',
        fanOutAgents: idleAgents.map(a => a.id),
      });
      setCooldown(key);
      log('info', `Fan-out: ${item.id} queued for ${idleAgents.length} agents: ${idleAgents.map(a => a.name).join(', ')}`);

    } else {
      // ─── Normal: single agent dispatch ──────────────────────────────
      const agentId = item.agent || resolveAgent(workType, config);
      if (!agentId) continue;

      const agentName = config.agents[agentId]?.name || agentId;
      const agentRole = config.agents[agentId]?.role || 'Agent';
      const firstProject = projects.length > 0 ? projects[0] : null;
      if (!firstProject) { log('warn', `Dispatch: skipping ${item.id} — no projects configured`); continue; }

      // Branch mutex: skip if target branch is locked by an active dispatch
      const centralBranch = item.branch || item.featureBranch || `work/${item.id}`;
      const centralBranchConflict = isBranchActive(centralBranch);
      if (centralBranchConflict) {
        log('info', `Branch mutex: skipping central ${item.id} — branch ${centralBranch} locked by ${centralBranchConflict.id} (${centralBranchConflict.agent})`);
        continue;
      }

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
        branch_name: centralBranch,
      };
      const centralWtPath = firstProject?.localPath
        ? path.resolve(firstProject.localPath, config.engine?.worktreeRoot || '../worktrees', centralBranch)
        : '';
      const cpResult = buildWorkItemDispatchVars(item, vars, config, {
        worktreePath: centralWtPath || undefined,
        workType,
      });
      if (cpResult.needsReview) {
        log('warn', `Work item ${item.id} exceeded 3 checkpoint-resumes — marking as needs-human-review`);
        mutations.set(item.id, { status: WI_STATUS.NEEDS_REVIEW, _checkpointCount: cpResult.checkpointCount });
        continue;
      }
      if (cpResult.checkpointCount !== null) {
        mutations.set(item.id, Object.assign(mutations.get(item.id) || {}, { _checkpointCount: cpResult.checkpointCount }));
      }

      // Inject plan-specific variables for the plan playbook
      if (workType === WORK_TYPE.PLAN) {
        // Ensure plans directory exists before agent tries to write
        if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
        const planFileName = `plan-${item.id.toLowerCase()}-${dateStamp()}.md`;
        vars.plan_content = item.title + (item.description ? '\n\n' + item.description : '');
        vars.plan_title = item.title;
        vars.plan_file = planFileName;
        vars.task_description = item.title;
        // Notes already populated by buildWorkItemDispatchVars — no need to re-read
        // Track expected plan filename in meta for chainPlanToPrd
        mutations.set(item.id, Object.assign(mutations.get(item.id) || {}, { _planFileName: planFileName }));
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
        // Check if a PRD already exists for this plan — reuse its filename to avoid duplicates (#884)
        let prdFilename = null;
        const prdFiles = safeReadDir(PRD_DIR).filter(f => f.endsWith('.json'));
        for (const pf of prdFiles) {
          const prd = safeJson(path.join(PRD_DIR, pf));
          if (prd?.source_plan === item.planFile) {
            prdFilename = pf;
            try { vars.existing_prd_json = fs.readFileSync(path.join(PRD_DIR, pf), 'utf8'); } catch (_) { /* ignore */ }
            log('info', `plan-to-prd: reusing existing PRD "${pf}" for plan "${item.planFile}" (#884)`);
            break;
          }
        }
        if (!prdFilename) {
          // Generate unique PRD filename — check prd/ and prd/archive/ for collisions
          const prdBase = vars.project_name_lower + '-' + dateStamp();
          prdFilename = prdBase + '.json';
          const prdExisting = new Set([
            ...prdFiles,
            ...safeReadDir(path.join(PRD_DIR, 'archive')).filter(f => f.endsWith('.json')),
          ]);
          let prdCounter = 2;
          while (prdExisting.has(prdFilename)) { prdFilename = prdBase + '-' + prdCounter + '.json'; prdCounter++; }
        }
        vars.prd_filename = prdFilename;
        mutations.set(item.id, Object.assign(mutations.get(item.id) || {}, { _prdFilename: prdFilename }));
        vars.branch_strategy_hint = item.branchStrategy
          ? `The user requested **${item.branchStrategy}** strategy. Use this unless the analysis strongly suggests otherwise.`
          : 'Choose the best strategy based on your analysis of item dependencies.';
      }

      // ASK and resolveTaskContext already handled by buildWorkItemDispatchVars above

      const playbookName = selectPlaybook(workType, item);
      const prompt = renderPlaybook(playbookName, vars) || renderPlaybook('work-item', vars);
      if (!prompt) {
        log('warn', `Dispatch: playbook '${playbookName}' failed to render for ${item.id}, resetting to pending`);
        item.status = WI_STATUS.PENDING;
        continue;
      }

      // Don't mark dispatched here — spawnAgent stamps status atomically (#480)

      newWork.push({
        type: workType,
        agent: agentId,
        agentName,
        agentRole,
        task: item.title || item.description?.slice(0, 80) || item.id,
        prompt,
        meta: { dispatchKey: key, source: 'central-work-item', item: { ...item, ...mutations.get(item.id) }, planFileName: item.planFile || mutations.get(item.id)?._planFileName || null, branch: item.branch || item.featureBranch || `work/${item.id}` }
      });

      setCooldown(key);
    }
    } catch (err) { log('warn', `discoverCentralWorkItems: skipping ${item.id}: ${err.message}`); }
  }

  if (mutations.size > 0) {
    // True atomic read-modify-write — applies mutations to fresh locked data
    mutateJsonFileLocked(centralPath, (freshItems) => {
      if (!Array.isArray(freshItems)) freshItems = [];
      for (const fi of freshItems) {
        const m = mutations.get(fi.id);
        if (m) Object.assign(fi, m);
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
async function discoverWork(config) {
  resetClaimedAgents(); // Reset per-tick agent claims for fair distribution
  const projects = getProjects(config);
  let allFixes = [], allReviews = [], allWorkItems = [];

  // Side-effect passes: materialize plans and design docs into work-items.json
  // These write to project work queues — picked up by discoverFromWorkItems below.
  reconcilePrdStatuses(config); // Backward-scan: correct "missing" PRD items that have done work items (#929)
  materializePlansAsWorkItems(config);

  for (const project of projects) {
    const root = project.localPath ? path.resolve(project.localPath) : null;
    if (!root || !fs.existsSync(root)) continue;

    // Source 1: Pull Requests → fixes, reviews, build-test
    const prWork = await discoverFromPrs(config, project);
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
      // Separate meetings (no work-items write) from task items
      const taskItems = [];
      for (const item of scheduledWork) {
        if (item.type === WORK_TYPE.MEETING) {
          const sched = (config.schedules || []).find(s => s.id === item._scheduleId);
          const participants = (sched && sched.participants) || [];
          const meeting = createMeeting({ title: item.title, agenda: item.description, participants });
          log('info', `Scheduled meeting created: ${item._scheduleId} → ${meeting.id} (${participants.length} participants)`);
        } else {
          taskItems.push(item);
        }
      }
      if (taskItems.length > 0) {
        // Atomic write — prevents race with dispatch status updates on central work-items.json
        mutateJsonFileLocked(centralPath, (items) => {
          if (!Array.isArray(items)) items = [];
          let added = 0;
          for (const item of taskItems) {
            if (!items.some(i => i._scheduleId === item._scheduleId && i.status !== WI_STATUS.DONE && i.status !== WI_STATUS.FAILED)) {
              items.push(item);
              added++;
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
    await discoverPipelineWork(config);
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
          if (!plan?.missing_features || plan.status === 'completed') {
            if (plan?.status === 'completed') completedPlanCache.add(f);
            continue;
          }
          if (plan.status !== 'approved' && plan.status !== 'active') continue;
          // Simulate the meta object checkPlanCompletion expects
          const completed = lifecycle.checkPlanCompletion({ item: { sourcePlan: f } }, config);
          if (completed) completedPlanCache.add(f);
        }
      }
    } catch (e) { log('warn', 'plan completion sweep: ' + e.message); }
  }

  // Gate reviews and fixes: do not dispatch until all implement items are complete
  const hasIncompleteImplements = queries.getWorkItems(config).some(i =>
    ['queued', 'pending', 'dispatched'].includes(i.status) && (i.type || '').startsWith('implement')
  );
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
    if (item.meta?.dispatchKey) setCooldown(item.meta.dispatchKey);
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
let _tickStartedAt = 0;
const TICK_TIMEOUT_MS = 300000; // 5 min — force-release tick lock if stuck

async function tick() {
  if (tickRunning) {
    if (_tickStartedAt && Date.now() - _tickStartedAt > TICK_TIMEOUT_MS) {
      log('error', `Tick hung for ${Math.round((Date.now() - _tickStartedAt) / 1000)}s — force-releasing lock`);
      tickRunning = false;
      _tickStartedAt = 0;
    }
    return;
  }
  tickRunning = true;
  _tickStartedAt = Date.now();
  try {
    await tickInner();
  } catch (e) {
    log('error', `Tick error: ${e.message}`);
  } finally {
    tickRunning = false;
    _tickStartedAt = 0;
  }
}

async function tickInner() {
  const control = getControl();
  if (control.state !== 'running' && control.state !== 'stopping') {
    log('info', `Engine state is "${control.state}" — exiting process`);
    process.exit(0);
  }

  // Write heartbeat so dashboard can detect stale engine
  try { safeWrite(CONTROL_PATH, { ...control, heartbeat: Date.now() }); } catch (e) { log('warn', 'write heartbeat: ' + e.message); }

  const config = getConfig();
  tickCount++;
  _failedRefCache.clear(); // Reset per-tick failed-ref cache

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

  // 2.55. Check persistent watches (every 3 ticks = ~3 minutes)
  if (tickCount % 3 === 0) {
    safe('checkWatches', () => {
      const { checkWatches } = require('./engine/watches');
      const pullRequests = PROJECTS.flatMap(p => {
        const prPath = path.join(MINIONS_DIR, 'projects', p.name, 'pull-requests.json');
        return safeJson(prPath) || [];
      });
      const workItems = PROJECTS.flatMap(p => {
        const wiPath = path.join(MINIONS_DIR, 'projects', p.name, 'work-items.json');
        return safeJson(wiPath) || [];
      });
      // Also include central work items
      const centralWi = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
      checkWatches(config, { pullRequests, workItems: [...workItems, ...centralWi] });
    });
  }

  const adoPollEnabled = config.engine?.adoPollEnabled ?? DEFAULTS.adoPollEnabled;
  const ghPollEnabled = config.engine?.ghPollEnabled ?? DEFAULTS.ghPollEnabled;
  const adoPollStatusEvery = Math.max(1, Number(config.engine?.adoPollStatusEvery) || DEFAULTS.adoPollStatusEvery);
  const adoPollCommentsEvery = Math.max(1, Number(config.engine?.adoPollCommentsEvery) || DEFAULTS.adoPollCommentsEvery);

  // 2.6. Poll PR status: build, review, merge (every adoPollStatusEvery ticks, default ~6 minutes)
  // Awaited so PR state is consistent before discoverWork reads it
  // Also re-polls early if previous tick had ADO auth failures (stale build status recovery)
  if (tickCount % adoPollStatusEvery === 0 || needsAdoPollRetry()) {
    if (adoPollEnabled && !isAdoThrottled()) {
      try { await pollPrStatus(config); } catch (err) { log('warn', `ADO PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    } else if (adoPollEnabled && isAdoThrottled()) {
      log('info', '[ado] PR status poll skipped — throttled');
    }
    if (ghPollEnabled && !isGhThrottled()) {
      try { await ghPollPrStatus(config); } catch (err) { log('warn', `GitHub PR status poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    } else if (ghPollEnabled && isGhThrottled()) {
      log('info', '[gh] PR status poll skipped — throttled');
    }
    try { await processPendingRebases(config); } catch (err) { log('warn', `Pending rebase processing error: ${err?.message || err}`); }
    // Sync PR status back to PRD items (missing → done when active PR exists)
    try { syncPrdFromPrs(config); } catch (err) { log('warn', `PRD sync error: ${err?.message || err}`); }
    // Check if any plans can be marked completed (all features done/in-pr)
    try {
      const prdFiles = safeReadDir(PRD_DIR).filter(f => f.endsWith('.json'));
      for (const file of prdFiles) {
        if (completedPlanCache.has(file)) continue;
        const plan = safeJson(path.join(PRD_DIR, file));
        if (plan && plan.missing_features && plan.status !== 'completed') {
          const completed = checkPlanCompletion({ item: { sourcePlan: file } }, config);
          if (completed) completedPlanCache.add(file);
        } else if (plan?.status === 'completed') {
          completedPlanCache.add(file);
        }
      }
    } catch (err) { log('warn', `Plan completion check error: ${err?.message || err}`); }
  }

  // 2.7. Poll PR threads for human comments (every adoPollCommentsEvery ticks, default ~12 minutes)
  if (tickCount % adoPollCommentsEvery === 0) {
    if (adoPollEnabled && !isAdoThrottled()) {
      try { await pollPrHumanComments(config); } catch (err) { log('warn', `ADO PR comment poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    } else if (adoPollEnabled && isAdoThrottled()) {
      log('info', '[ado] PR comment poll skipped — throttled');
    }
    if (ghPollEnabled && !isGhThrottled()) {
      try { await ghPollPrHumanComments(config); } catch (err) { log('warn', `GitHub PR comment poll error: ${err?.message || err}${err?.stack ? ' | ' + err.stack.split('\n')[1]?.trim() : ''}`); }
    } else if (ghPollEnabled && isGhThrottled()) {
      log('info', '[gh] PR comment poll skipped — throttled');
    }
    // Reconciliation runs regardless of poll flags — it's a recovery sweep, not a convenience poll
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
            // Collect keys to clear AFTER work-items lock is released (avoid nested locks)
            const dispatchKeysToClear = [];
            const cooldownKeysToClear = [];

            mutateWorkItems(wiPath, items => {
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

                  // Collect dispatch + cooldown keys for clearing outside lock
                  const key = `work-${project.name}-${item.id}`;
                  dispatchKeysToClear.push(key);
                  cooldownKeysToClear.push(key);
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
                      // Collect dispatch key for clearing outside lock
                      dispatchKeysToClear.push(`work-${project.name}-${dep.id}`);
                    }
                  }
                }
              }
            });

            // Clear dispatch entries AFTER work-items lock is released (no nested locks)
            for (const key of dispatchKeysToClear) {
              try {
                mutateDispatch((dp) => {
                  dp.completed = dp.completed.filter(d => d.meta?.dispatchKey !== key);
                  return dp;
                });
              } catch (e) { log('warn', 'stall recovery clear dispatch: ' + e.message); }
            }

            // Clear cooldowns AFTER work-items lock is released
            for (const key of cooldownKeysToClear) {
              try {
                if (dispatchCooldowns.has(key)) {
                  dispatchCooldowns.delete(key);
                  saveCooldowns();
                }
              } catch (e) { log('warn', 'stall recovery clear cooldown: ' + e.message); }
            }
          } catch (e) { log('warn', 'stall recovery process project: ' + e.message); }
        }
      }
    } catch (err) { log('warn', `Stall detection error: ${err?.message || err}`); }
  }

  // 3. Discover new work from sources
  let discoveryOk = true;
  try { await discoverWork(config); } catch (e) { log('warn', 'discoverWork: ' + e.message); discoveryOk = false; }

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

  const slotsAvailable = Math.max(0, maxConcurrent - activeCount);

  // Priority dispatch: implement > fix/ask > review > test/verify > plan > other
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
    return dp;
  });

  // Build set of agents currently active (one task per agent at a time).
  const busyAgents = new Set((dispatch.active || []).map(d => d.agent));
  // Branch mutex: track branches locked by active dispatches to prevent concurrent writes
  const lockedBranches = new Set();
  for (const d of (dispatch.active || [])) {
    if (d.meta?.branch) lockedBranches.add(sanitizeBranch(d.meta.branch));
  }
  const seenPendingIds = new Set();
  const toDispatch = [];
  let generalSlots = slotsAvailable;

  for (const item of dispatch.pending) {
    if (seenPendingIds.has(item.id)) {
      log('warn', `Duplicate dispatch ID ${item.id} in pending queue — skipping`);
      continue;
    }
    if (busyAgents.has(item.agent)) {
      // Agent busy reassignment: if item has been waiting on a busy agent past the threshold,
      // try to find an alternative agent via routing. Skip explicitly assigned items.
      const reassignMs = config.engine?.agentBusyReassignMs ?? DEFAULTS.agentBusyReassignMs;
      const isExplicitReassign = !!item.meta?.item?.agent;
      if (!isExplicitReassign && reassignMs > 0 && item._agentBusySince) {
        const busySinceMs = new Date(item._agentBusySince).getTime();
        if (Date.now() - busySinceMs > reassignMs) {
          const originalAgent = item.agent;
          const altAgent = resolveAgent(item.type, config);
          if (altAgent && altAgent !== originalAgent && !busyAgents.has(altAgent)) {
            log('info', `Reassigning ${item.id} from ${originalAgent} to ${altAgent} — agent busy > ${reassignMs}ms`);
            item.agent = altAgent;
            item.agentName = config.agents[altAgent]?.name || tempAgents.get(altAgent)?.name || altAgent;
            item.agentRole = config.agents[altAgent]?.role || tempAgents.get(altAgent)?.role || 'Agent';
            delete item._agentBusySince;
            delete item.skipReason;
            // Persist reassignment to dispatch.json
            mutateDispatch((dp) => {
              const p = (dp.pending || []).find(d => d.id === item.id);
              if (p) {
                p.agent = altAgent;
                p.agentName = item.agentName;
                p.agentRole = item.agentRole;
                delete p._agentBusySince;
                delete p.skipReason;
              }
              return dp;
            });
            // Fall through to branch mutex / concurrency checks below
          } else {
            continue; // No alternative agent available — keep waiting
          }
        } else {
          continue; // Below threshold — keep waiting
        }
      } else {
        continue; // No _agentBusySince set yet or explicitly assigned — skip
      }
    }
    // Branch mutex: skip items targeting a branch already locked by an active or newly-dispatched task
    const itemBranch = item.meta?.branch ? sanitizeBranch(item.meta.branch) : null;
    if (itemBranch && lockedBranches.has(itemBranch)) continue;
    // Items explicitly assigned to an agent bypass concurrency cap — dispatch if agent is free
    const isExplicitAssignment = !!item.meta?.item?.agent;
    if (!isExplicitAssignment && generalSlots <= 0) continue;
    seenPendingIds.add(item.id);
    toDispatch.push(item);
    busyAgents.add(item.agent);
    if (itemBranch) lockedBranches.add(itemBranch);
    if (!isExplicitAssignment) generalSlots--;
  }

  // Dispatch items — spawnAgent moves each from pending→active on disk.
  // We use the already-loaded item objects; spawnAgent handles the state transition.
  const dispatched = new Set();
  for (const item of toDispatch) {
    if (!dispatched.has(item.id)) {
      let proc;
      try { proc = await spawnAgent(item, config); } catch (spawnErr) {
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
              mutateWorkItems(wiPath, items => {
                const wi = items.find(i => i.id === item.meta.item.id);
                if (wi && wi.status === WI_STATUS.DISPATCHED) {
                  // completeDispatch didn't update the work item — re-queue manually
                  wi.status = WI_STATUS.PENDING;
                  wi._retryCount = (wi._retryCount || 0) + 1;
                  wi._lastRetryReason = 'spawnAgent returned null';
                  wi._lastRetryAt = ts();
                  delete wi.dispatched_at;
                  delete wi.dispatched_to;
                  log('info', `Re-queued ${item.meta.item.id} as pending (retry ${wi._retryCount})`);
                }
              });
            }
          } catch (e) { log('warn', `Failed to re-queue work item after spawn failure: ${e.message}`); }
        }
      } else {
        dispatched.add(item.id);
        // Sync PRD item status after successful spawn (#480)
        if (item.meta?.item?.sourcePlan) {
          try { syncPrdItemStatus(item.meta.item.id, WI_STATUS.DISPATCHED, item.meta.item.sourcePlan); }
          catch (e) { log('warn', `prd sync after spawn: ${e.message}`); }
        }
      }
    }
  }

  // Annotate remaining pending items with skipReason so dashboard can show why they're waiting.
  // Re-read dispatch after spawns (spawnAgent moves items from pending→active).
  const postDispatch = getDispatch();
  const postBusyAgents = new Set((postDispatch.active || []).map(d => d.agent));
  const postActiveCount = (postDispatch.active || []).length;
  // Rebuild locked branches from post-dispatch active set for skip-reason annotation
  const postLockedBranches = new Set();
  for (const d of (postDispatch.active || [])) {
    if (d.meta?.branch) postLockedBranches.add(sanitizeBranch(d.meta.branch));
  }
  let skipReasonChanged = false;
  for (const item of (postDispatch.pending || [])) {
    let reason = null;
    if (postActiveCount >= maxConcurrent) {
      reason = 'max_concurrency';
    } else if (postBusyAgents.has(item.agent)) {
      reason = 'agent_busy';
    } else {
      // Branch mutex: annotate items waiting for a branch to become free
      const pendingBranch = item.meta?.branch ? sanitizeBranch(item.meta.branch) : null;
      if (pendingBranch && postLockedBranches.has(pendingBranch)) {
        reason = 'branch_locked';
      }
    }
    // Track when item first became blocked on a busy agent for reassignment threshold
    if (reason === 'agent_busy') {
      if (!item._agentBusySince) {
        item._agentBusySince = ts();
        skipReasonChanged = true;
      }
    } else {
      if (item._agentBusySince) {
        delete item._agentBusySince;
        skipReasonChanged = true;
      }
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
  mutateDispatch, addToDispatch, isRetryableFailureReason, completeDispatch, writeInboxAlert, updateAgentStatus,
  activeProcesses, realActivityMap, engineRestartGraceExempt,
  get engineRestartGraceUntil() { return engineRestartGraceUntil; },
  set engineRestartGraceUntil(v) { engineRestartGraceUntil = v; },

  // Agent lifecycle
  spawnAgent, resolveAgent,

  // Discovery
  discoverWork, discoverFromPrs, discoverFromWorkItems,
  materializePlansAsWorkItems,

  // Shared helpers (used by lifecycle.js and tests)
  reconcileItemsWithPrs, detectDependencyCycles,
  parseConflictFiles, pruneAncestorDeps, preflightMergeSimulation, // exported for testing

  // Playbooks
  renderPlaybook, validatePlaybookVars, PLAYBOOK_REQUIRED_VARS, buildWorkItemDispatchVars,

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

