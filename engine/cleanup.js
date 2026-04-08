/**
 * engine/cleanup.js — Periodic cleanup: temp files, worktrees, zombies, migrations.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { exec, execSilent, log, ts } = shared;
const { safeJson, safeWrite, safeReadDir, mutateWorkItems, getProjects, projectWorkItemsPath, projectPrPath,
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

// ─── Cleanup Orchestrator ────────────────────────────────────────────────────

function runCleanup(config, verbose = false) {
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

      for (const { dir, wtPath } of allDirs) {

        let shouldClean = false;
        let isProtected = false;

        // Check if this worktree's branch is merged/abandoned
        // Use sanitized exact match on the branch portion of the dir name (format: {slug}-{branch}-{suffix})
        const dirLower = dir.toLowerCase();
        for (const branch of mergedBranches) {
          if (worktreeDirMatchesBranch(dirLower, branch)) {
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
          } catch (e) { log('warn', 'check shared-branch protection: ' + e.message); }
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
            if (worktreeDirMatchesBranch(entryDirLower, branch)) {
              stillMerged = true;
              break;
            }
          }
          // If originally marked due to merged branch but PR was reopened, skip deletion
          if (!stillMerged) {
            // Check if it was marked for age/cap cleanup (not branch-based) — those are still valid
            const wasMarkedByBranch = [...mergedBranches].some(branch => worktreeDirMatchesBranch(entryDirLower, branch));
            if (wasMarkedByBranch) {
              if (verbose) console.log(`  Skipping worktree ${entry.dir}: PR was reopened since initial check`);
              log('info', `Worktree deletion skipped — PR reopened: ${entry.dir}`);
              continue;
            }
          }

          if (_attemptedWorktreePaths.has(entry.wtPath)) continue;
          _attemptedWorktreePaths.add(entry.wtPath);
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

  // 4. Kill zombie claude processes not tracked by the engine
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

  // 9. KB watchdog — restore deleted KB files from git if count dropped vs checkpoint
  try {
    const checkpoint = safeJson(path.join(ENGINE_DIR, 'kb-checkpoint.json'));
    if (checkpoint && checkpoint.count > 0) {
      const cats = KB_CATEGORIES;
      const knowledgeDir = path.join(MINIONS_DIR, 'knowledge');
      let current = 0;
      for (const cat of cats) {
        const d = path.join(knowledgeDir, cat);
        try {
          if (fs.existsSync(d)) current += fs.readdirSync(d).length;
        } catch (e) {
          log('warn', `KB watchdog: failed to read ${cat} directory — ${e.message}`);
        }
      }
      if (current < checkpoint.count) {
        log('warn', `KB watchdog: file count dropped ${checkpoint.count} → ${current}, restoring from git`);
        try {
          const trackedCheck = execSilent('git ls-tree --name-only HEAD -- knowledge', { cwd: MINIONS_DIR }).toString().trim();
          if (!trackedCheck) {
            log('warn', 'KB watchdog: knowledge/ is not tracked in git HEAD — skipping restore');
          } else {
            // Bug #29: Check exit code and verify restore succeeded
            let restoreOutput;
            try {
              restoreOutput = execSilent('git checkout HEAD -- knowledge', { cwd: MINIONS_DIR });
            } catch (restoreErr) {
              log('warn', `KB watchdog: git checkout exited with error — ${restoreErr.message}`);
              restoreOutput = null;
            }
            if (restoreOutput !== null) {
              // Verify the restore actually recovered files
              let postRestoreCount = 0;
              for (const cat of cats) {
                const d = path.join(knowledgeDir, cat);
                try {
                  if (fs.existsSync(d)) postRestoreCount += fs.readdirSync(d).length;
                } catch { /* count what we can */ }
              }
              if (postRestoreCount < checkpoint.count) {
                log('warn', `KB watchdog: restore incomplete — expected ${checkpoint.count} files, got ${postRestoreCount}`);
              } else {
                log('info', `KB watchdog: restored knowledge/ from git HEAD (${postRestoreCount} files)`);
              }
            }
          }
        } catch (err) {
          log('error', `KB watchdog: git restore failed — ${err.message}`);
        }
      }
    }
  } catch (e) { log('warn', 'KB watchdog check: ' + e.message); }

  // 6a. Reconcile failed work items that have an attached PR (#407)
  // If a work item is 'failed' but already has _pr, it should be 'done'.
  for (const project of projects) {
    try {
      const wiPath = projectWorkItemsPath(project);
      const items = safeJson(wiPath) || [];
      let reconciled = 0;
      for (const item of items) {
        if (item.status === shared.WI_STATUS.FAILED && item._pr) {
          item.status = shared.WI_STATUS.DONE;
          if (item.failReason) delete item.failReason;
          if (item.failedAt) delete item.failedAt;
          if (!item.completedAt) item.completedAt = shared.ts();
          reconciled++;
        }
      }
      if (reconciled > 0) {
        safeWrite(wiPath, items);
        log('info', `Reconciled ${reconciled} failed-with-PR item(s) → done in ${project.name}`);
      }
    } catch (e) { log('warn', 'reconcile failed-with-PR: ' + e.message); }
  }

  // 6b. Migrate legacy work-item statuses to canonical 'done'
  // in-pr, implemented, complete → done (one-time correction per item)
  const LEGACY_DONE_ALIASES = new Set(['in-pr', 'implemented', 'complete']);
  for (const project of projects) {
    try {
      const wiPath = projectWorkItemsPath(project);
      let migrated = 0;
      mutateWorkItems(wiPath, items => {
        for (const item of items) {
          if (LEGACY_DONE_ALIASES.has(item.status)) {
            item.status = shared.WI_STATUS.DONE;
            delete item._pendingReason;
            migrated++;
          }
        }
      });
      if (migrated > 0) {
        log('info', `Migrated ${migrated} legacy status(es) → done in ${project.name} work items`);
      }
    } catch (e) { log('warn', 'migrate legacy statuses: ' + e.message); }
  }
  // Central work items
  try {
    const centralPath = path.join(MINIONS_DIR, 'work-items.json');
    let migrated = 0;
    mutateWorkItems(centralPath, items => {
      for (const item of items) {
        if (LEGACY_DONE_ALIASES.has(item.status)) {
          item.status = shared.WI_STATUS.DONE;
          delete item._pendingReason;
          migrated++;
        }
      }
    });
    if (migrated > 0) {
      log('info', `Migrated ${migrated} legacy status(es) → done in central work items`);
    }
  } catch (e) { log('warn', 'migrate central legacy statuses: ' + e.message); }
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
      const prd = safeJson(prdPath);
      if (!prd?.missing_features) continue;
      let migrated = 0;
      for (const feat of prd.missing_features) {
        if (LEGACY_DONE_ALIASES.has(feat.status)) {
          feat.status = shared.WI_STATUS.DONE;
          migrated++;
        }
      }
      if (migrated > 0) {
        safeWrite(prdPath, prd);
        log('info', `Migrated ${migrated} legacy PRD item status(es) → done in ${pf}`);
      }
    }
  } catch (e) { log('warn', 'migrate PRD legacy statuses: ' + e.message); }

  return cleaned;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  runCleanup,
  worktreeDirMatchesBranch,  // exported for testing
};
