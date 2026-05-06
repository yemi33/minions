/**
 * engine/cleanup.js — Periodic cleanup: temp files, worktrees, zombies, migrations.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { exec, execAsync, execSilent, log, ts, ENGINE_DEFAULTS } = shared;
const { safeJson, safeWrite, safeReadDir, mutateCooldowns, mutateWorkItems, mutateJsonFileLocked, getProjects, projectWorkItemsPath, projectPrPath,
  sanitizeBranch, KB_CATEGORIES } = shared;
const { getDispatch, getAgentStatus } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;
const AGENTS_DIR = queries.AGENTS_DIR;
const ENGINE_DIR = queries.ENGINE_DIR;
const PRD_DIR = queries.PRD_DIR;
const PLANS_DIR = queries.PLANS_DIR;

// Lazy require to break circular dependency with engine.js
// Only needed for engine().activeProcesses — log/ts come from shared.js
let _engine = null;
function engine() { if (!_engine) _engine = require('../engine'); return _engine; }

// Lazy require for dispatch module
let _dispatch = null;
function dispatchModule() { if (!_dispatch) _dispatch = require('./dispatch'); return _dispatch; }

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a worktree directory name matches a branch via sanitized slug comparison.
 * Eliminates 3x duplication of the branch matching logic (review feedback: Rebecca).
 */
function worktreeDirMatchesBranch(dirLower, branch) {
  const branchSlug = sanitizeBranch(branch).toLowerCase();
  return dirLower === branchSlug || dirLower.includes(branchSlug + '-') || dirLower.endsWith('-' + branchSlug);
}

function worktreeBranchMatches(actualBranch, branch) {
  if (!actualBranch || !branch) return false;
  return sanitizeBranch(actualBranch).toLowerCase() === sanitizeBranch(branch).toLowerCase();
}

function worktreeMatchesBranch(dirLower, branch, actualBranch = '') {
  return worktreeBranchMatches(actualBranch, branch) || worktreeDirMatchesBranch(dirLower, branch);
}

function getWorktreeBranch(wtPath) {
  try {
    return exec(`git -C "${wtPath}" branch --show-current`, { encoding: 'utf8', stdio: 'pipe', timeout: 5000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

async function getWorktreeBranchAsync(wtPath) {
  try {
    const out = await execAsync(`git -C "${wtPath}" branch --show-current`, { encoding: 'utf8', timeout: 5000 });
    return (out || '').toString().trim();
  } catch {
    return '';
  }
}

let _orphanPidProcessNamesCache = null;
function _orphanPidProcessNames() {
  if (_orphanPidProcessNamesCache) return _orphanPidProcessNamesCache;
  const names = new Set(['node']);
  try {
    for (const name of require('./runtimes').listRuntimes()) names.add(String(name).toLowerCase());
    // Copilot can run through the GitHub CLI fallback (`gh copilot`), so allow
    // gh only when the copilot runtime is registered.
    if (names.has('copilot')) names.add('gh');
  } catch {
    names.add('claude');
  }
  _orphanPidProcessNamesCache = names;
  return names;
}

function _processNameAllowedForOrphanKill(processText) {
  const firstLine = String(processText || '').trim().split(/\r?\n/).find(Boolean) || '';
  const imageName = path.basename(firstLine.trim().split(/\s+/)[0] || '').toLowerCase().replace(/\.exe$/, '');
  if (!imageName) return false;
  return _orphanPidProcessNames().has(imageName);
}


/**
 * Kill orphaned processes whose dispatch ID appears in the worktree dir name.
 * Only kills processes NOT in the active dispatch queue — never kills live agents.
 */
function _killProcessInWorktree(dir, activeProcesses, activeIds) {
  const dirLower = dir.toLowerCase();

  // Check tracked in-memory processes — only kill if dispatch is no longer active
  for (const [id, info] of activeProcesses.entries()) {
    if (!dirLower.includes(id.toLowerCase().slice(-8))) continue;
    if (activeIds.has(id)) continue; // still active — do not kill
    try { shared.killImmediate(info.proc); } catch {}
    activeProcesses.delete(id);
    log('info', `Killed orphaned process for dispatch ${id} before worktree removal`);
  }

  // Check PID files in engine/tmp/ — only kill if no active dispatch matches
  try {
    const tmpDir = path.join(ENGINE_DIR, 'tmp');
    for (const f of fs.readdirSync(tmpDir)) {
      if (!f.startsWith('pid-') || !f.endsWith('.pid')) continue;
      const pidFileName = f.replace(/^pid-/, '').replace(/\.pid$/, '');
      if (!dirLower.includes(pidFileName.slice(-8))) continue;
      // Verify this PID file's dispatch is not active
      let isActive = false;
      for (const id of activeIds) { if (pidFileName.includes(id.slice(-8))) { isActive = true; break; } }
      if (isActive) continue; // still active — do not kill
      const pid = parseInt(fs.readFileSync(path.join(tmpDir, f), 'utf8').trim(), 10);
      if (pid > 0) {
        // Verify the PID still belongs to a Minions runtime process before killing
        try {
          if (process.platform === 'win32') {
            const taskInfo = exec(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', timeout: 3000, windowsHide: true });
            const taskLower = taskInfo.toLowerCase();
            if (!_processNameAllowedForOrphanKill(taskLower)) continue;
            exec(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe', timeout: 5000, windowsHide: true });
          } else {
            // Verify the process name before killing (prevent recycled PID kill)
            try {
              const psOut = exec(`ps -p ${pid} -o comm=`, { encoding: 'utf8', timeout: 3000 }).trim();
              if (!_processNameAllowedForOrphanKill(psOut)) continue;
            } catch { continue; } // process dead or ps failed
            try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
          }
          log('info', `Killed orphaned PID ${pid} (${f}) before worktree removal`);
        } catch {} // process may already be dead
      }
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
    }
  } catch {} // tmp dir may not exist
}

// ─── Cleanup Orchestrator ────────────────────────────────────────────────────

async function runCleanup(config, verbose = false) {
  const activeProcesses = engine().activeProcesses;
  const projects = getProjects(config);
  let cleaned = { tempFiles: 0, liveOutputs: 0, worktrees: 0, zombies: 0 };

  // 1. Clean stale temp prompt/sysprompt files and orphaned safeWrite .tmp.* files (older than 1 hour)
  const oneHourAgo = Date.now() - 3600000;
  const tmpDir = path.join(ENGINE_DIR, 'tmp');
  const scanDirs = [ENGINE_DIR, ...(fs.existsSync(tmpDir) ? [tmpDir] : [])];
  for (const dir of scanDirs) {
    // Each directory gets its own try-catch so one failure doesn't abort other directories (Bug #27)
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dir);
    } catch (e) {
      log('warn', `cleanup temp files: failed to read ${dir} — ${e.message}`);
      continue;
    }
    for (const f of dirEntries) {
      const isPromptTemp = f.startsWith('prompt-') || f.startsWith('sysprompt-') || f.startsWith('tmp-sysprompt-');
      const isSafeWriteTemp = /\.tmp\.\d+\.\d+$/.test(f);
      if (isPromptTemp || isSafeWriteTemp) {
        const fp = path.join(dir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < oneHourAgo) {
            fs.unlinkSync(fp);
            cleaned.tempFiles++;
            if (isSafeWriteTemp) log('info', `Cleaned orphaned temp file: ${f}`);
          }
        } catch { /* cleanup */ }
      }
    }
  }

  // 2. Clean live-output.log and live-output-prev.log for idle agents (not currently working)
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
        } catch { /* cleanup */ }
      }
      // Also clean rotated previous session log
      const prevPath = path.join(AGENTS_DIR, agentId, 'live-output-prev.log');
      if (fs.existsSync(prevPath)) {
        try {
          const stat = fs.statSync(prevPath);
          if (stat.mtimeMs < oneHourAgo) {
            fs.unlinkSync(prevPath);
            cleaned.liveOutputs++;
          }
        } catch { /* cleanup */ }
      }
    }
  }

  // 3. Clean git worktrees for merged/abandoned PRs
  const _attemptedWorktreePaths = new Set(); // dedup across projects sharing a worktreeRoot
  for (const project of projects) {
    const root = project.localPath ? path.resolve(project.localPath) : null;
    if (!root || !fs.existsSync(root)) continue;

    // Scan all potential worktree locations: configured root + common project-local dirs
    const worktreeRoots = new Set();
    const configuredRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    if (fs.existsSync(configuredRoot)) worktreeRoots.add(configuredRoot);
    const localDirs = ['worktrees', '.claude/worktrees'].map(d => path.join(root, d));
    for (const d of localDirs) { if (fs.existsSync(d)) worktreeRoots.add(d); }

    for (const worktreeRoot of worktreeRoots) {

    // Get PRs for this project
    const prs = safeJson(projectPrPath(project)) || [];
    const mergedBranches = new Set();
    for (const pr of prs) {
      if (pr.status === shared.PR_STATUS.MERGED || pr.status === shared.PR_STATUS.ABANDONED || pr.status === shared.PLAN_STATUS.COMPLETED) {
        if (pr.branch) mergedBranches.add(pr.branch);
      }
    }

    // List worktrees — collect info for age-based + cap-based cleanup
    const MAX_WORKTREES = 10;
    try {
      // Collect all worktree directories (including nested ones like minions-work/P-xxx)
      const allDirs = [];
      const topDirs = fs.readdirSync(worktreeRoot);
      for (const dir of topDirs) {
        const dirPath = path.join(worktreeRoot, dir);
        try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
        // Check if this is a git worktree (has .git file) or a parent directory
        if (fs.existsSync(path.join(dirPath, '.git'))) {
          allDirs.push({ dir, wtPath: dirPath });
        } else {
          // Scan subdirectories for worktrees
          try {
            for (const sub of fs.readdirSync(dirPath)) {
              const subPath = path.join(dirPath, sub);
              try { if (fs.statSync(subPath).isDirectory()) allDirs.push({ dir: dir + '/' + sub, wtPath: subPath }); } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      }

      const wtEntries = []; // { dir, wtPath, mtime, shouldClean, isProtected }
      const dispatch = getDispatch();
      const activeDispatchIds = new Set((dispatch.active || []).map(d => d.id));

      // Probe `git branch --show-current` for every worktree in chunks of 5.
      // Sequential probing was the dominant cost in the cleanup phase
      // (5–15s tick stall every 10 ticks at 50+ worktrees), but unbounded
      // Promise.all would spawn 50+ concurrent git children — bad on Windows
      // where each fork pays AV-scan overhead. Mirrors engine/ado.js:611.
      const BRANCH_PROBE_CONCURRENCY = 5;
      const branchMap = new Map();
      for (let i = 0; i < allDirs.length; i += BRANCH_PROBE_CONCURRENCY) {
        const batch = allDirs.slice(i, i + BRANCH_PROBE_CONCURRENCY);
        const pairs = await Promise.all(
          batch.map(async ({ wtPath }) => [wtPath, await getWorktreeBranchAsync(wtPath)])
        );
        for (const [wtPath, branch] of pairs) branchMap.set(wtPath, branch);
      }

      for (const { dir, wtPath } of allDirs) {

        let shouldClean = false;
        let isProtected = false;
        const actualBranch = branchMap.get(wtPath) || '';

        // Check if this worktree's branch is merged/abandoned
        // Prefer actual git branch metadata; compact Windows dirs intentionally omit branch names.
        const dirLower = dir.toLowerCase();
        for (const branch of mergedBranches) {
          if (worktreeMatchesBranch(dirLower, branch, actualBranch)) {
            shouldClean = true;
            break;
          }
        }

        // Check if referenced by active/pending dispatch (use sanitized branch comparison)
        const isReferenced = [...dispatch.pending, ...(dispatch.active || [])].some(d => {
          if (!d.meta?.branch) return false;
          return worktreeMatchesBranch(dirLower, d.meta.branch, actualBranch);
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
          } catch { /* optional */ }
        }

        // Skip worktrees for active shared-branch plans (check both prd/ and plans/ for .json PRDs)
        if (shouldClean || !isProtected) {
          try {
            for (const checkDir of [PRD_DIR, path.join(MINIONS_DIR, 'plans')]) {
              if (!fs.existsSync(checkDir)) continue;
              for (const pf of fs.readdirSync(checkDir).filter(f => f.endsWith('.json'))) {
                const plan = safeJson(path.join(checkDir, pf));
                if (plan?.branch_strategy === 'shared-branch' && plan?.feature_branch && plan?.status !== 'completed') {
                  if (worktreeMatchesBranch(dirLower, plan.feature_branch, actualBranch)) {
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
          } catch (e) { log('warn', 'check shared-branch protection: ' + e.message); }
        }

        wtEntries.push({ dir, wtPath, mtime, shouldClean, isProtected, actualBranch });
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
      // Re-read PR status immediately before deletion — a PR can be reopened between
      // the initial status check and the actual deletion (Bug #15: TOCTOU race)
      const freshPrs = safeJson(projectPrPath(project)) || [];
      const freshMergedBranches = new Set();
      for (const pr of freshPrs) {
        if (pr.status === shared.PR_STATUS.MERGED || pr.status === shared.PR_STATUS.ABANDONED || pr.status === shared.PLAN_STATUS.COMPLETED) {
          if (pr.branch) freshMergedBranches.add(pr.branch);
        }
      }

      for (const entry of wtEntries) {
        if (entry.shouldClean) {
          // Verify the branch is still merged/closed — skip if PR was reopened since initial check
          const entryDirLower = entry.dir.toLowerCase();
          let stillMerged = false;
          for (const branch of freshMergedBranches) {
            if (worktreeMatchesBranch(entryDirLower, branch, entry.actualBranch)) {
              stillMerged = true;
              break;
            }
          }
          // If originally marked due to merged branch but PR was reopened, skip deletion
          if (!stillMerged) {
            // Check if it was marked for age/cap cleanup (not branch-based) — those are still valid
            const wasMarkedByBranch = [...mergedBranches].some(branch => worktreeMatchesBranch(entryDirLower, branch, entry.actualBranch));
            if (wasMarkedByBranch) {
              if (verbose) console.log(`  Skipping worktree ${entry.dir}: PR was reopened since initial check`);
              log('info', `Worktree deletion skipped — PR reopened: ${entry.dir}`);
              continue;
            }
          }

          if (_attemptedWorktreePaths.has(entry.wtPath)) continue;
          _attemptedWorktreePaths.add(entry.wtPath);
          // Kill any process still running in this worktree before removal
          _killProcessInWorktree(entry.dir, activeProcesses, activeDispatchIds);
          if (shared.removeWorktree(entry.wtPath, root, worktreeRoot)) {
            cleaned.worktrees++;
            if (verbose) console.log(`  Removed worktree: ${entry.wtPath}`);
          } else {
            if (verbose) console.log(`  Failed to remove worktree ${entry.wtPath}`);
          }
        }
      }
    } catch (e) { log('warn', 'cleanup worktrees: ' + e.message); }
    } // end worktreeRoots loop
  }

  // 4. Kill zombie agent processes not tracked by the engine
  // List all node processes, check if any are running spawn-agent.js for our minions
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
        shared.killImmediate(info.proc);
        activeProcesses.delete(id);
        cleaned.zombies++;
      }
    }
  } catch (e) { log('warn', 'cleanup zombie processes: ' + e.message); }

  // 5. Clean spawn-debug.log
  try { fs.unlinkSync(path.join(ENGINE_DIR, 'spawn-debug.log')); } catch { /* cleanup */ }

  // 6. Prune old output archive files (keep last 30 per agent)
  for (const agentId of Object.keys(config.agents || {})) {
    const agentDir = path.join(MINIONS_DIR, 'agents', agentId);
    if (!fs.existsSync(agentDir)) continue;
    try {
      const outputFiles = fs.readdirSync(agentDir)
        .filter(f => f.startsWith('output-') && f.endsWith('.log') && f !== 'output.log')
        .map(f => ({ name: f, mtime: fs.statSync(path.join(agentDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of outputFiles.slice(30)) {
        try { fs.unlinkSync(path.join(agentDir, old.name)); cleaned.files++; } catch { /* cleanup */ }
      }
    } catch (e) { log('warn', 'prune output archives: ' + e.message); }
  }

  // 6b. Prune notes/archive — keep the most recent bounded set
  cleaned.notesArchive = 0;
  try {
    const archiveDir = path.join(MINIONS_DIR, 'notes', 'archive');
    if (fs.existsSync(archiveDir)) {
      const archiveFiles = fs.readdirSync(archiveDir)
        .map(name => ({ name, mtime: fs.statSync(path.join(archiveDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (archiveFiles.length > ENGINE_DEFAULTS.notesArchiveMaxFiles) {
        for (const old of archiveFiles.slice(ENGINE_DEFAULTS.notesArchiveMaxFiles)) {
          try { fs.unlinkSync(path.join(archiveDir, old.name)); cleaned.notesArchive++; } catch { /* cleanup */ }
        }
      }
    }
  } catch (e) { log('warn', 'prune notes archive: ' + e.message); }

  // 7. Prune orphaned dispatch entries — items whose source work item no longer exists
  cleaned.orphanedDispatches = 0;
  try {
    const dispatch = getDispatch();
    // Collect all work item IDs across all sources
    const allWiIds = new Set();
    try {
      const allItems = queries.getWorkItems();
      allItems.forEach(w => allWiIds.add(w.id));
    } catch (e) { log('warn', 'read work items for orphan check: ' + e.message); }

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
      const { mutateDispatch } = dispatchModule();
      mutateDispatch((dp) => {
        for (const queue of ['pending', 'active']) {
          if (!dp[queue]) continue;
          dp[queue] = dp[queue].filter(d => {
            const itemId = d.meta?.item?.id;
            if (!itemId) return true;
            return allWiIds.has(itemId);
          });
        }
        return dp;
      });
    }
  } catch (e) { log('warn', 'prune orphaned dispatches: ' + e.message); }

  if (cleaned.tempFiles + cleaned.liveOutputs + cleaned.worktrees + cleaned.zombies + (cleaned.files || 0) + cleaned.orphanedDispatches > 0) {
    log('info', `Cleanup: ${cleaned.tempFiles} temp, ${cleaned.liveOutputs} live outputs, ${cleaned.worktrees} worktrees, ${cleaned.zombies} zombies, ${cleaned.files || 0} archives, ${cleaned.orphanedDispatches} orphaned dispatches`);
  }

  // 8. Clean swept KB files older than 7 days
  try {
    const sweptDir = path.join(MINIONS_DIR, 'knowledge', '_swept');
    if (fs.existsSync(sweptDir)) {
      const sevenDaysAgo = Date.now() - 7 * 86400000;
      let sweptEntries;
      try {
        sweptEntries = fs.readdirSync(sweptDir);
      } catch (e) {
        log('warn', `cleanup swept KB: failed to read ${sweptDir} — ${e.message}`);
        sweptEntries = [];
      }
      for (const f of sweptEntries) {
        try {
          const fp = path.join(sweptDir, f);
          if (fs.statSync(fp).mtimeMs < sevenDaysAgo) {
            fs.unlinkSync(fp);
            if (!cleaned.sweptKb) cleaned.sweptKb = 0;
            cleaned.sweptKb++;
          }
        } catch { /* cleanup */ }
      }
    }
  } catch (e) { log('warn', 'cleanup swept KB files: ' + e.message); }

  // 6a. Reconcile failed work items that have an attached PR (#407)
  // If a work item is 'failed' but already has _pr, it should be 'done'.
  // Uses mutateWorkItems() for locked atomic read-modify-write — prevents
  // race conditions with concurrent engine/dashboard/lifecycle writers.
  for (const project of projects) {
    try {
      const wiPath = projectWorkItemsPath(project);
      let reconciled = 0;
        mutateWorkItems(wiPath, items => {
          for (const item of items) {
            if (item.status === shared.WI_STATUS.FAILED && item._pr) {
              item.status = shared.WI_STATUS.DONE;
              if (item.failReason) delete item.failReason;
              if (item.failedAt) delete item.failedAt;
              delete item._retryCount;
              delete item._pendingReason;
              if (!item.completedAt) item.completedAt = shared.ts();
              reconciled++;
            }
          }
        });
      if (reconciled > 0) {
        log('info', `Reconciled ${reconciled} failed-with-PR item(s) → done in ${project.name}`);
      }
    } catch (e) { log('warn', 'reconcile failed-with-PR: ' + e.message); }
  }

  // 6b. Migrate legacy work-item statuses to canonical replacements
  // in-pr, implemented, complete → done; needs-human-review → failed
  const LEGACY_DONE_ALIASES = new Set(['in-pr', 'implemented', 'complete']);
  const LEGACY_NEEDS_REVIEW_STATUS = 'needs-human-review';
  const LEGACY_NEEDS_REVIEW_FAIL_REASON = 'Manual intervention required (migrated from needs-human-review)';
  function _migrateLegacyItem(item) {
    if (LEGACY_DONE_ALIASES.has(item.status)) {
      item.status = shared.WI_STATUS.DONE;
      delete item._retryCount;
      delete item._pendingReason;
      if (!item.completedAt) item.completedAt = shared.ts();
      return true;
    }
    if (item.status === LEGACY_NEEDS_REVIEW_STATUS) {
      item.status = shared.WI_STATUS.FAILED;
      if (!item.failReason) item.failReason = LEGACY_NEEDS_REVIEW_FAIL_REASON;
      if (!item.failedAt) item.failedAt = shared.ts();
      delete item.completedAt;
      return true;
    }
    return false;
  }
  function _migrateLegacyItemsAt(wiPath, label) {
    try {
      let migrated = 0;
      mutateWorkItems(wiPath, items => {
        for (const item of items) if (_migrateLegacyItem(item)) migrated++;
      });
      if (migrated > 0) log('info', `Migrated ${migrated} legacy status(es) in ${label}`);
    } catch (e) { log('warn', `migrate legacy statuses (${label}): ${e.message}`); }
  }
  for (const project of projects) _migrateLegacyItemsAt(projectWorkItemsPath(project), `${project.name} work items`);
  _migrateLegacyItemsAt(path.join(MINIONS_DIR, 'work-items.json'), 'central work items');

  // 6c. Strip stale retry metadata from completed work items
  cleaned.doneRetryCounts = 0;
  for (const project of projects) {
    try {
      const wiPath = projectWorkItemsPath(project);
      mutateWorkItems(wiPath, items => {
        for (const item of items) {
          if (item.status === shared.WI_STATUS.DONE && item._retryCount !== undefined) {
            delete item._retryCount;
            cleaned.doneRetryCounts++;
          }
        }
      });
    } catch (e) { log('warn', 'cleanup done retry metadata: ' + e.message); }
  }
  try {
    const centralPath = path.join(MINIONS_DIR, 'work-items.json');
    mutateWorkItems(centralPath, items => {
      for (const item of items) {
        if (item.status === shared.WI_STATUS.DONE && item._retryCount !== undefined) {
          delete item._retryCount;
          cleaned.doneRetryCounts++;
        }
      }
    });
  } catch (e) { log('warn', 'cleanup central done retry metadata: ' + e.message); }
  if (cleaned.doneRetryCounts > 0) {
    log('info', `Cleanup: cleared ${cleaned.doneRetryCounts} stale retry count(s) from done work items`);
  }
  // PRD items (missing_features[].status)
  try {
    let prdDirEntries;
    try {
      prdDirEntries = fs.readdirSync(PRD_DIR);
    } catch (e) {
      log('warn', `migrate PRD statuses: failed to read ${PRD_DIR} — ${e.message}`);
      prdDirEntries = [];
    }
    const prdFiles = prdDirEntries.filter(f => f.endsWith('.json'));
    for (const pf of prdFiles) {
      const prdPath = path.join(PRD_DIR, pf);
      let migrated = 0;
      shared.withFileLock(`${prdPath}.lock`, () => {
        const prd = safeJson(prdPath);
        if (!prd?.missing_features) return;
        for (const feat of prd.missing_features) {
          if (LEGACY_DONE_ALIASES.has(feat.status)) {
            feat.status = shared.WI_STATUS.DONE;
            migrated++;
          } else if (feat.status === LEGACY_NEEDS_REVIEW_STATUS) {
            feat.status = shared.WI_STATUS.FAILED;
            migrated++;
          }
        }
        if (migrated > 0) safeWrite(prdPath, prd);
      });
      if (migrated > 0) {
        log('info', `Migrated ${migrated} legacy PRD item status(es) in ${pf}`);
      }
    }
  } catch (e) { log('warn', 'migrate PRD legacy statuses: ' + e.message); }

  // Reset orphaned PRD item statuses — dispatched/failed with no matching work item (#779)
  cleaned.orphanedPrdStatuses = 0;
  try {
    const wiIds = new Set();
    for (const project of projects) {
      const items = safeJson(projectWorkItemsPath(project)) || [];
      for (const wi of items) { if (wi?.id) wiIds.add(wi.id); }
    }
    try {
      const centralWi = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
      for (const wi of centralWi) { if (wi?.id) wiIds.add(wi.id); }
    } catch { /* optional */ }

    let orphanPrdEntries;
    try { orphanPrdEntries = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.json')); }
    catch { orphanPrdEntries = []; }
    for (const pf of orphanPrdEntries) {
      const prdPath = path.join(PRD_DIR, pf);
      const peek = safeJson(prdPath);
      if (!peek?.missing_features) continue;
      let reset = 0;
      mutateJsonFileLocked(prdPath, (prd) => {
        if (!prd?.missing_features) return prd;
        for (const feat of prd.missing_features) {
          if ((feat.status === shared.WI_STATUS.DISPATCHED || feat.status === shared.WI_STATUS.FAILED) && !wiIds.has(feat.id)) {
            feat.status = shared.WI_STATUS.PENDING;
            reset++;
          }
        }
        return prd;
      }, { skipWriteIfUnchanged: true });
      if (reset > 0) {
        log('info', `Reset ${reset} orphaned PRD item status(es) → pending in ${pf}`);
        cleaned.orphanedPrdStatuses += reset;
      }
    }
  } catch (e) { log('warn', 'orphan PRD status reset: ' + e.message); }

  // 10. CC tab sessions are non-expiring by design — they persist until the
  // user explicitly closes the tab (which fires DELETE /api/cc-sessions/:id).
  // Cleanup intentionally does NOT prune cc-sessions.json; doing so would
  // silently invalidate live chat tabs the user expects to keep.
  cleaned.ccSessions = 0;

  // 10b. Prune doc-chat sessions — cap at 100 entries, remove oldest beyond cap
  cleaned.docSessions = 0;
  try {
    const docSessionsPath = path.join(ENGINE_DIR, 'doc-sessions.json');
    const docSessions = safeJson(docSessionsPath);
    if (docSessions && typeof docSessions === 'object') {
      const entries = Object.entries(docSessions);
      const DOC_SESSIONS_CAP = 100;
      if (entries.length > DOC_SESSIONS_CAP) {
        entries.sort((a, b) => new Date(b.lastActiveAt || 0) - new Date(a.lastActiveAt || 0));
        const keep = Object.fromEntries(entries.slice(0, DOC_SESSIONS_CAP));
        cleaned.docSessions = entries.length - DOC_SESSIONS_CAP;
        safeWrite(docSessionsPath, keep);
      }
    }
  } catch (e) { log('warn', 'prune doc-sessions: ' + e.message); }

  // 11. Cap cooldowns.json — keep at most 500 entries (on top of 24h TTL in cooldown.js)
  //     Also trim pendingContexts arrays to ENGINE_DEFAULTS.maxPendingContexts to prevent bloat.
  cleaned.cooldowns = 0;
  cleaned.pendingContextsTrimmed = 0;
  try {
    const cooldownPath = path.join(ENGINE_DIR, 'cooldowns.json');
    const cooldowns = safeJson(cooldownPath);
    if (cooldowns && typeof cooldowns === 'object') {
      let dirty = false;
      // Trim oversized pendingContexts arrays (one-time migration + ongoing cap)
      const pendingCtxCap = ENGINE_DEFAULTS.maxPendingContexts;
      for (const v of Object.values(cooldowns)) {
        if (Array.isArray(v.pendingContexts) && v.pendingContexts.length > pendingCtxCap) {
          v.pendingContexts = v.pendingContexts.slice(-pendingCtxCap);
          cleaned.pendingContextsTrimmed++;
          dirty = true;
        }
      }
      const entries = Object.entries(cooldowns);
      const COOLDOWN_CAP = 500;
      if (entries.length > COOLDOWN_CAP) {
        // Keep most recent by timestamp
        entries.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
        const keep = Object.fromEntries(entries.slice(0, COOLDOWN_CAP));
        cleaned.cooldowns = entries.length - COOLDOWN_CAP;
        mutateCooldowns(() => keep);
      } else if (dirty) {
        mutateCooldowns(() => cooldowns);
      }
    }
  } catch (e) { log('warn', 'cap cooldowns: ' + e.message); }

  // 12. Clean stale PID files — remove PID files whose process is no longer running
  cleaned.pidFiles = 0;
  try {
    const tmpDir = path.join(ENGINE_DIR, 'tmp');
    if (fs.existsSync(tmpDir)) {
      let pidDirEntries;
      try { pidDirEntries = fs.readdirSync(tmpDir); } catch { pidDirEntries = []; }
      const activePids = new Set();
      for (const [, info] of activeProcesses) {
        if (info.proc?.pid) activePids.add(String(info.proc.pid));
      }
      for (const f of pidDirEntries) {
        if (!f.startsWith('pid-') || !f.endsWith('.pid')) continue;
        const fp = path.join(tmpDir, f);
        try {
          const pidStr = fs.readFileSync(fp, 'utf8').trim();
          // Skip if actively tracked
          if (activePids.has(pidStr)) continue;
          // Check if file is stale (>1 hour old)
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < oneHourAgo) {
            fs.unlinkSync(fp);
            cleaned.pidFiles++;
          }
        } catch { /* cleanup */ }
      }
    }
  } catch (e) { log('warn', 'clean stale PID files: ' + e.message); }

  // 13. Prune test-results.json — keep last 200 entries
  try {
    const testResultsPath = path.join(ENGINE_DIR, 'test-results.json');
    const results = shared.safeJsonArr(testResultsPath);
    const TEST_RESULTS_CAP = 200;
    if (results.length > TEST_RESULTS_CAP) {
      safeWrite(testResultsPath, results.slice(-TEST_RESULTS_CAP));
    }
  } catch { /* optional — file may not exist */ }

  // 14. Scrub stale temp agent keys from metrics.json
  try { scrubStaleMetrics(); } catch { /* best-effort cleanup */ }

  // 15. Evict old completion reports — keep reports durable beyond the capped
  // dispatch history, but bound disk growth by age/count.
  cleaned.completionReports = 0;
  try {
    const dispatch = getDispatch();
    const protectedReportFiles = new Set();
    for (const queue of ['pending', 'active', 'completed']) {
      for (const entry of dispatch[queue] || []) {
        if (!entry?.id) continue;
        const reportPath = shared.dispatchCompletionReportPath(entry.id);
        if (reportPath) protectedReportFiles.add(path.basename(reportPath));
      }
    }
    const configuredRetentionDays = Number(config?.engine?.completionReportRetentionDays ?? ENGINE_DEFAULTS.completionReportRetentionDays);
    const configuredMaxReports = Number(config?.engine?.completionReportMaxFiles ?? ENGINE_DEFAULTS.completionReportMaxFiles);
    const retentionDays = Number.isFinite(configuredRetentionDays) ? configuredRetentionDays : ENGINE_DEFAULTS.completionReportRetentionDays;
    const maxReports = Number.isFinite(configuredMaxReports) ? configuredMaxReports : ENGINE_DEFAULTS.completionReportMaxFiles;
    const retentionMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : 0;
    const cutoffMs = retentionMs > 0 ? Date.now() - retentionMs : 0;
    const completionsDir = path.join(ENGINE_DIR, 'completions');
    if (fs.existsSync(completionsDir)) {
      const reports = fs.readdirSync(completionsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const fp = path.join(completionsDir, f);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(fp).mtimeMs; } catch {}
          return { file: f, path: fp, mtimeMs, protected: protectedReportFiles.has(f) };
        })
        .filter(r => r.mtimeMs > 0)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      const removeReport = (report) => {
        try { fs.unlinkSync(report.path); cleaned.completionReports++; return true; } catch { return false; }
      };
      for (const report of reports) {
        if (report.protected) continue;
        if (cutoffMs > 0 && report.mtimeMs < cutoffMs) {
          removeReport(report);
        }
      }
      if (maxReports > 0) {
        const remaining = reports.filter(r => fs.existsSync(r.path));
        let overflow = remaining.length - maxReports;
        for (const report of remaining) {
          if (overflow <= 0) break;
          if (report.protected) continue;
          if (removeReport(report)) overflow--;
        }
      }
      if (cleaned.completionReports > 0) {
        log('info', `Cleanup: removed ${cleaned.completionReports} old completion report(s)`);
      }
    }
  } catch (e) { log('warn', `cleanupCompletionReports: ${e.message}`); }

  if (cleaned.ccSessions + cleaned.docSessions + cleaned.cooldowns + cleaned.pidFiles + cleaned.pendingContextsTrimmed + cleaned.notesArchive + cleaned.completionReports > 0) {
    log('info', `Cleanup (resources): ${cleaned.ccSessions} cc-sessions, ${cleaned.docSessions} doc-sessions, ${cleaned.cooldowns} cooldowns, ${cleaned.pendingContextsTrimmed} pendingCtx trimmed, ${cleaned.notesArchive} archived notes, ${cleaned.pidFiles} PID files, ${cleaned.completionReports} completion reports`);
  }

  return cleaned;
}

// ─── Metrics Scrub ──────────────────────────────────────────────────────────

/** Remove stale temp-*, agent1, and _test-* keys from metrics.json.
 *  Mirrors the guard in lifecycle.js updateMetrics() — cleans up keys
 *  that were written before that guard existed. */
function scrubStaleMetrics() {
  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  if (!fs.existsSync(metricsPath)) return;
  mutateJsonFileLocked(metricsPath, metrics => {
    for (const key of Object.keys(metrics)) {
      if (key.startsWith('temp-') || key === 'agent1' || key.startsWith('_test')) {
        delete metrics[key];
      }
    }
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  runCleanup,
  scrubStaleMetrics,
  worktreeDirMatchesBranch,  // exported for testing
  worktreeMatchesBranch,     // exported for testing
  getWorktreeBranch,         // exported for lifecycle cleanup
};
