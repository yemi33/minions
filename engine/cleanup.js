/**
 * engine/cleanup.js — Periodic cleanup: temp files, worktrees, zombies, migrations.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { exec, execSilent } = shared;
const { safeJson, safeWrite, safeReadDir, getProjects, projectWorkItemsPath, projectPrPath,
  sanitizeBranch, KB_CATEGORIES } = shared;
const { getDispatch, getAgentStatus } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;
const AGENTS_DIR = queries.AGENTS_DIR;
const ENGINE_DIR = queries.ENGINE_DIR;
const PRD_DIR = queries.PRD_DIR;
const PLANS_DIR = queries.PLANS_DIR;

// Lazy require to break circular dependency with engine.js
let _engine = null;
function engine() { if (!_engine) _engine = require('../engine'); return _engine; }
function log(level, msg, meta) { return engine().log(level, msg, meta); }
function ts() { return engine().ts(); }

// Lazy require for dispatch module
let _dispatch = null;
function dispatchModule() { if (!_dispatch) _dispatch = require('./dispatch'); return _dispatch; }

// ─── Cleanup Orchestrator ────────────────────────────────────────────────────

function runCleanup(config, verbose = false) {
  const activeProcesses = engine().activeProcesses;
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
          } catch { /* cleanup */ }
        }
      }
    }
  } catch (e) { log('warn', 'cleanup temp files: ' + e.message); }

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
        } catch { /* cleanup */ }
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
    } catch (e) { log('warn', 'cleanup worktrees: ' + e.message); }
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
        try { if (info.proc) info.proc.kill('SIGTERM'); } catch { /* process may be dead */ }
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
      const central = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
      central.forEach(w => allWiIds.add(w.id));
    } catch (e) { log('warn', 'read central work items for orphan check: ' + e.message); }
    for (const project of projects) {
      try {
        const projItems = safeJson(projectWorkItemsPath(project)) || [];
        projItems.forEach(w => allWiIds.add(w.id));
      } catch (e) { log('warn', 'read project work items for orphan check: ' + e.message); }
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
      for (const f of fs.readdirSync(sweptDir)) {
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
        if (fs.existsSync(d)) current += fs.readdirSync(d).length;
      }
      if (current < checkpoint.count) {
        log('warn', `KB watchdog: file count dropped ${checkpoint.count} → ${current}, restoring from git`);
        try {
          const trackedCheck = execSilent('git ls-tree --name-only HEAD -- knowledge', { cwd: MINIONS_DIR }).toString().trim();
          if (!trackedCheck) {
            log('warn', 'KB watchdog: knowledge/ is not tracked in git HEAD — skipping restore');
          } else {
            execSilent('git checkout HEAD -- knowledge', { cwd: MINIONS_DIR });
            log('info', 'KB watchdog: restored knowledge/ from git HEAD');
          }
        } catch (err) {
          log('error', `KB watchdog: git restore failed — ${err.message}`);
        }
      }
    }
  } catch (e) { log('warn', 'KB watchdog check: ' + e.message); }

  // 6. Migrate legacy work-item statuses to canonical values
  // in-pr, implemented, complete → done (one-time correction per item)
  const LEGACY_DONE_STATUSES = new Set(['in-pr', 'implemented', 'complete']);
  for (const project of projects) {
    try {
      const wiPath = projectWorkItemsPath(project);
      const items = safeJson(wiPath) || [];
      let migrated = 0;
      for (const item of items) {
        if (LEGACY_DONE_STATUSES.has(item.status)) {
          item.status = 'done';
          migrated++;
        }
      }
      if (migrated > 0) {
        safeWrite(wiPath, items);
        log('info', `Migrated ${migrated} legacy status(es) → done in ${project.name} work items`);
      }
    } catch (e) { log('warn', 'migrate legacy statuses: ' + e.message); }
  }
  // Central work items
  try {
    const centralPath = path.join(MINIONS_DIR, 'work-items.json');
    const centralItems = safeJson(centralPath) || [];
    let migrated = 0;
    for (const item of centralItems) {
      if (LEGACY_DONE_STATUSES.has(item.status)) {
        item.status = 'done';
        migrated++;
      }
    }
    if (migrated > 0) {
      safeWrite(centralPath, centralItems);
      log('info', `Migrated ${migrated} legacy status(es) → done in central work items`);
    }
  } catch (e) { log('warn', 'migrate central legacy statuses: ' + e.message); }
  // PRD items (missing_features[].status)
  try {
    const prdFiles = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.json'));
    for (const pf of prdFiles) {
      const prdPath = path.join(PRD_DIR, pf);
      const prd = safeJson(prdPath);
      if (!prd?.missing_features) continue;
      let migrated = 0;
      for (const feat of prd.missing_features) {
        if (LEGACY_DONE_STATUSES.has(feat.status)) {
          feat.status = 'done';
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
};
