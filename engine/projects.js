/**
 * engine/projects.js — Project lifecycle (currently: comprehensive remove).
 *
 * Used by both the CLI (minions.js) and the dashboard (handleProjectsRemove)
 * so removal semantics stay identical regardless of entry point.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const dispatch = require('./dispatch');
const { MINIONS_DIR } = shared;

/**
 * @param {object} d - dispatch entry
 * @returns {string} project name from any of the three meta shapes the engine
 *   uses (item.project, project.name, project string)
 */
function _dispatchProjectName(d) {
  return d?.meta?.item?.project || d?.meta?.project?.name || d?.meta?.project || '';
}

/**
 * Remove a project: cancel pending work items, drain dispatch + kill agents,
 * clean worktrees, disable project-targeted schedules, archive (or purge) the
 * data directory, then unlink from config.json.
 *
 * @param {string} target - Project name or localPath
 * @param {object} [options]
 * @param {'archive'|'keep'|'purge'} [options.dataMode='archive']
 *   archive: move projects/<name>/ to projects/.archived/<name>-YYYYMMDD/
 *   keep:    leave projects/<name>/ in place
 *   purge:   rm -rf projects/<name>/
 * @returns {object} summary { ok, project, cancelledItems, killedAgents,
 *   drainedDispatches, cleanedWorktrees, disabledSchedules, archivedTo,
 *   purgedDataDir, pipelineRefs[], warnings[] } or { ok:false, error }
 */
function removeProject(target, options = {}) {
  const dataMode = options.dataMode || (options.purge ? 'purge' : (options.keepData ? 'keep' : 'archive'));
  const summary = {
    ok: false,
    project: null,
    cancelledItems: 0,
    drainedDispatches: 0, // includes active dispatches whose agent processes were killed
    cleanedWorktrees: 0,
    disabledSchedules: 0,
    archivedPlans: [],
    pipelineRefs: [],
    archivedTo: null,
    purgedDataDir: false,
    warnings: [],
  };

  const configPath = path.join(MINIONS_DIR, 'config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { return { ...summary, error: 'Failed to read config: ' + e.message }; }

  const project = (config.projects || []).find(p =>
    p.name === target || path.resolve(p.localPath || '') === path.resolve(target));
  if (!project) {
    const available = (config.projects || []).map(p => p.name).join(', ') || '(none)';
    return { ...summary, error: `No project linked matching: ${target}. Available: ${available}` };
  }
  summary.project = { name: project.name, localPath: project.localPath };

  // 1. Cancel pending/queued work items linked to this project (project-local
  //    file + central). Done items are preserved as history.
  for (const wiPath of [
    path.join(MINIONS_DIR, 'projects', project.name, 'work-items.json'),
    path.join(MINIONS_DIR, 'work-items.json'),
  ]) {
    summary.cancelledItems += dispatch.cancelPendingWorkItems(
      wiPath,
      w => !w.project || w.project === project.name,
      'project-removed',
    );
  }

  // 2. Drain dispatch — also kills active agent processes and unlinks pid +
  //    prompt sidecars in engine/tmp/, matching what plan delete does.
  summary.drainedDispatches = dispatch.cleanDispatchEntries(
    d => _dispatchProjectName(d) === project.name,
  );

  // 3. Clean up worktrees under this project's worktree root, honoring
  //    config.engine.worktreeRoot (mirrors lifecycle.js cleanupPlanWorktrees).
  if (project.localPath) {
    try {
      const wtRoot = path.resolve(project.localPath, config.engine?.worktreeRoot || '../worktrees');
      if (fs.existsSync(wtRoot)) {
        for (const dir of fs.readdirSync(wtRoot)) {
          try {
            if (shared.removeWorktree(path.join(wtRoot, dir), project.localPath, wtRoot)) {
              summary.cleanedWorktrees++;
            }
          } catch { /* best effort */ }
        }
      }
    } catch (e) { summary.warnings.push('worktree cleanup: ' + e.message); }
  }

  // 4. Disable schedules whose `project` field targets this project
  //    specifically. Don't touch schedules with project='any' or unset.
  if (Array.isArray(config.schedules)) {
    for (const s of config.schedules) {
      if (s.project === project.name && s.enabled !== false) {
        s.enabled = false;
        summary.disabledSchedules++;
      }
    }
  }

  // 5. Archive plans + PRDs targeting this project so they don't keep
  //    showing in the dashboard after removal. Three signals:
  //      a) PRD JSON `project` field matches → archive PRD + linked source plan
  //      b) plan .md content has `Project: <name>` (any markdown emphasis)
  //      c) plan .md filename contains the project name (case-insensitive)
  //    The .backup sidecar removal in archivePlan prevents engine restart
  //    from re-triggering plan completion (mirror of f28162b0 fix).
  const plansDir = path.join(MINIONS_DIR, 'plans');
  const plansArchive = path.join(plansDir, 'archive');
  const prdDir = path.join(MINIONS_DIR, 'prd');
  const escName = project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const projectLineRe = new RegExp('^[*_>\\s]{0,4}\\*{0,2}_{0,2}Project:?\\*{0,2}_{0,2}\\s*' + escName + '\\b', 'im');
  const archivedSourcePlans = new Set();
  try {
    if (fs.existsSync(prdDir)) {
      const { archivePlan } = require('./lifecycle');
      for (const f of fs.readdirSync(prdDir).filter(f => f.endsWith('.json'))) {
        try {
          const prd = JSON.parse(fs.readFileSync(path.join(prdDir, f), 'utf8'));
          if (prd?.project !== project.name) continue;
          archivePlan(f, prd, [project], config);
          summary.archivedPlans.push('prd/' + f);
          if (prd.source_plan) archivedSourcePlans.add(prd.source_plan);
        } catch { /* skip unreadable PRD */ }
      }
    }
  } catch (e) { summary.warnings.push('archive PRDs: ' + e.message); }
  try {
    if (fs.existsSync(plansDir)) {
      fs.mkdirSync(plansArchive, { recursive: true });
      const lowerName = project.name.toLowerCase();
      for (const f of fs.readdirSync(plansDir).filter(f => f.endsWith('.md'))) {
        if (archivedSourcePlans.has(f)) continue; // already moved by archivePlan above
        const fp = path.join(plansDir, f);
        try {
          const filenameMatch = f.toLowerCase().includes(lowerName);
          const content = filenameMatch ? '' : fs.readFileSync(fp, 'utf8');
          if (!filenameMatch && !projectLineRe.test(content)) continue;
          fs.renameSync(fp, path.join(plansArchive, f));
          summary.archivedPlans.push('plans/' + f);
        } catch { /* skip unreadable plan */ }
      }
    }
  } catch (e) { summary.warnings.push('archive plans: ' + e.message); }

  // 6. Surface pipelines that reference this project so the user can review
  //    them. Don't auto-modify — user intent there is unclear.
  try {
    const { getPipelines } = require('./pipeline');
    for (const p of getPipelines() || []) {
      const refs = [
        ...(p.monitoredResources || []),
        ...((p.stages || []).flatMap(s => s.monitoredResources || [])),
      ];
      if (refs.some(r => r && (r.project === project.name || r._project === project.name))) {
        summary.pipelineRefs.push(p.id);
      }
    }
  } catch { /* pipelines optional */ }

  // 7. Remove from config.json (and persist any schedule disables)
  config.projects = (config.projects || []).filter(p => p.name !== project.name);
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }
  catch (e) { return { ...summary, error: 'Failed to write config: ' + e.message }; }

  // 8. Move (or purge) projects/<name>/ — preserves PR/work-item history by
  //    default so a re-add can pick up where it left off.
  const dataDir = path.join(MINIONS_DIR, 'projects', project.name);
  if (fs.existsSync(dataDir)) {
    if (dataMode === 'purge') {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); summary.purgedDataDir = true; }
      catch (e) { summary.warnings.push('purge data dir: ' + e.message); }
    } else if (dataMode === 'archive') {
      try {
        const archiveRoot = path.join(MINIONS_DIR, 'projects', '.archived');
        fs.mkdirSync(archiveRoot, { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        let archived = path.join(archiveRoot, project.name + '-' + stamp);
        let n = 1;
        while (fs.existsSync(archived)) archived = path.join(archiveRoot, project.name + '-' + stamp + '-' + (++n));
        fs.renameSync(dataDir, archived);
        summary.archivedTo = path.relative(MINIONS_DIR, archived).replace(/\\/g, '/');
      } catch (e) { summary.warnings.push('archive data dir: ' + e.message); }
    }
  }

  summary.ok = true;
  return summary;
}

module.exports = { removeProject };
