/**
 * engine/lifecycle.js — Post-completion hooks, PR sync, agent history/metrics, plan chaining.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite, mutateJsonFileLocked, mutateWorkItems, execSilent, execAsync, projectPrPath, getPrLinks,
  log, ts, dateStamp, WI_STATUS, DONE_STATUSES, PLAN_TERMINAL_STATUSES, WORK_TYPE, PLAN_STATUS, PRD_ITEM_STATUS, PR_STATUS, DISPATCH_RESULT,
  ENGINE_DEFAULTS, DEFAULT_AGENT_METRICS, FAILURE_CLASS } = shared;
const { trackEngineUsage } = require('./llm');
const { resolveRuntime } = require('./runtimes');
const queries = require('./queries');
const { isBranchActive } = require('./cooldown');
const { worktreeMatchesBranch, getWorktreeBranch } = require('./cleanup');
const { getConfig, getInboxFiles, getNotes, getPrs, getDispatch,
  MINIONS_DIR, ENGINE_DIR, PLANS_DIR, PRD_DIR, INBOX_DIR, AGENTS_DIR } = queries;

// ─── Plan Completion Detection ───────────────────────────────────────────────
function checkPlanCompletion(meta, config) {

  const planFile = meta.item?.sourcePlan;
  if (!planFile) return;
  const planPath = path.join(PRD_DIR, planFile);
  const plan = safeJson(planPath);
  if (!plan?.missing_features) return;
  if (plan.status === PLAN_STATUS.COMPLETED) {
    if (plan._completionNotified) return;
  }

  const projects = shared.getProjects(config);

  // Collect work items from ALL projects + central (PRD items can be in either)
  const allWorkItems = queries.getWorkItems(config);
  const planItems = allWorkItems.filter(w => w.sourcePlan === planFile && w.itemType !== 'pr' && w.itemType !== 'verify');
  if (planItems.length === 0) return;

  // Hard completion gate: every PRD feature ID must have a corresponding work item in a terminal state.
  const planFeatureIds = new Set((plan.missing_features || []).map(f => f.id).filter(Boolean));
  const workItemById = {};
  for (const w of planItems) { if (w.id) workItemById[w.id] = w; }

  // Check 1: every feature must have a work item (materialized)
  // Fallback: also accept features marked done directly in the PRD JSON (resolved externally)
  const unmaterialized = [...planFeatureIds].filter(id => {
    if (workItemById[id]) return false;
    const prdItem = (plan.missing_features || []).find(f => f.id === id);
    return !(prdItem && DONE_STATUSES.has(prdItem.status));
  });
  if (unmaterialized.length > 0) {
    log('info', `Plan ${planFile}: ${unmaterialized.length}/${planFeatureIds.size} feature(s) not yet materialized as work items: ${unmaterialized.join(', ')}`);
    return;
  }

  // Check 2: every feature must be in a terminal state (done, failed, or cancelled).
  // Failed/cancelled items are unrecoverable — waiting on them blocks the plan indefinitely.
  const notTerminal = [...planFeatureIds].filter(id => {
    const w = workItemById[id];
    if (w && PLAN_TERMINAL_STATUSES.has(w.status)) return false;
    const prdItem = (plan.missing_features || []).find(f => f.id === id);
    return !(prdItem && PLAN_TERMINAL_STATUSES.has(prdItem.status));
  });
  if (notTerminal.length > 0) {
    log('info', `Plan ${planFile}: waiting for ${notTerminal.length}/${planFeatureIds.size} item(s) to reach terminal state: ${notTerminal.join(', ')}`);
    return;
  }

  const doneItems = planItems.filter(w => DONE_STATUSES.has(w.status));
  const failedItems = planItems.filter(w => w.status === WI_STATUS.FAILED || w.status === WI_STATUS.CANCELLED);
  const isActiveVerify = (wi) => wi && (
    wi.status === WI_STATUS.PENDING ||
    wi.status === WI_STATUS.QUEUED ||
    wi.status === WI_STATUS.DISPATCHED
  );
  const isReopenableVerify = (wi) => wi && (DONE_STATUSES.has(wi.status) || wi.status === WI_STATUS.FAILED);

  if (failedItems.length > 0) {
    const failDetails = failedItems.map(w =>
      `- \`${w.id}\`: ${w.title || 'Unknown'} — ${w.failReason || w.status}`
    ).join('\n');
    log('warn', `Plan ${planFile}: ${failedItems.length} item(s) failed/cancelled; completing with partial results (${doneItems.length} done, ${failedItems.length} failed):\n${failDetails}`);
  }

  // 1. Mark plan as completed
  plan.status = PLAN_STATUS.COMPLETED;
  plan.completedAt = ts();

  // Compute timing
  let firstDispatched = null, lastCompleted = null;
  for (const wi of planItems) {
    if (wi.dispatched_at) {
      const d = new Date(wi.dispatched_at).getTime();
      if (!firstDispatched || d < firstDispatched) firstDispatched = d;
    }
    if (wi.completedAt) {
      const c = new Date(wi.completedAt).getTime();
      if (!lastCompleted || c > lastCompleted) lastCompleted = c;
    }
  }
  const runtimeMs = firstDispatched && lastCompleted ? lastCompleted - firstDispatched : 0;
  const runtimeMin = Math.round(runtimeMs / 60000);

  // 2. Generate completion summary
  // Collect PRs from all projects
  const prsCreated = [];
  for (const p of projects) {
    try {
      const prPath = shared.projectPrPath(p);
      const prs = safeJson(prPath) || [];
      const prLinks = getPrLinks();
      for (const pr of prs) {
        const linkedItemIds = prLinks[pr.id] || [];
        if (linkedItemIds.some(itemId => doneItems.find(w => w.id === itemId))) {
          prsCreated.push(pr);
        }
      }
    } catch { /* optional */ }
  }
  const uniquePrs = [...new Map(prsCreated.map(pr => [pr.id || pr.url, pr])).values()];

  const summary = [
    `# PRD Completed: ${plan.plan_summary || planFile}`,
    ``,
    `**Project:** ${plan.project || 'Unknown'}`,
    `**Strategy:** ${plan.branch_strategy || 'parallel'}`,
    `**Completed:** ${ts().slice(0, 16).replace('T', ' ')}`,
    `**Runtime:** ${runtimeMin >= 60 ? Math.floor(runtimeMin / 60) + 'h ' + (runtimeMin % 60) + 'm' : runtimeMin + 'm'}`,
    ``,
    `## Results`,
    `- **${doneItems.length}** items completed`,
    failedItems.length ? `- **${failedItems.length}** items failed` : '',
    uniquePrs.length ? `- **${uniquePrs.length}** PR(s) created` : '',
    ``,
    `## Items`,
    ...doneItems.map(w => `- [done] ${w.id}: ${w.title.replace('Implement: ', '')}`),
    ...failedItems.map(w => `- [failed] ${w.id}: ${w.title.replace('Implement: ', '')}${w.failReason ? ' — ' + w.failReason : ''}`),
    uniquePrs.length ? `\n## Pull Requests` : '',
    ...uniquePrs.map(pr => `- ${pr.id}: ${pr.title || ''} ${pr.url || ''}`),
  ].filter(Boolean).join('\n');

  // Write summary to notes/inbox
  const summarySlug = `prd-completion-${planFile.replace('.json', '')}`;
  shared.writeToInbox('engine', summarySlug, summary);
  log('info', `PRD completion summary written to notes/inbox/${summarySlug}`);

  // Persist completed status + _completionNotified via file lock
  mutateJsonFileLocked(planPath, (data) => {
    data.status = PLAN_STATUS.COMPLETED;
    data.completedAt = plan.completedAt;
    data._completionNotified = true;
    return data;
  });

  // Resolve the primary project for writing new work items (PR, verify)
  const projectName = plan.project;
  const primaryProject = projectName
    ? projects.find(p => p.name?.toLowerCase() === projectName?.toLowerCase()) : projects[0];
  if (!primaryProject) {
    log('warn', `Plan ${planFile}: no primary project found — skipping PR/verify creation`);
    return;
  }
  const wiPath = shared.projectWorkItemsPath(primaryProject);

  // 3. For shared-branch plans, create PR work item
  if (plan.branch_strategy === 'shared-branch' && plan.feature_branch && wiPath) {
    const existingPrItem = allWorkItems.find(w => w.sourcePlan === planFile && w.itemType === 'pr');
    if (!existingPrItem) {
      const id = 'PL-' + shared.uid();
      const featureBranch = plan.feature_branch;
      const mainBranch = shared.resolveMainBranch(primaryProject.localPath, primaryProject.mainBranch);
      const itemSummary = doneItems.map(w => '- ' + w.id + ': ' + w.title.replace('Implement: ', '')).join('\n');
      mutateWorkItems(wiPath, workItems => {
        if (workItems.some(w => w.sourcePlan === planFile && w.itemType === 'pr')) return workItems;
        workItems.push({
          id, title: `Create PR for plan: ${plan.plan_summary || planFile}`,
          type: 'implement', priority: 'high',
          description: `All plan items from \`${planFile}\` are complete on branch \`${featureBranch}\`.\n\n**Branch:** \`${featureBranch}\`\n**Target:** \`${mainBranch}\`\n\n## Completed Items\n${itemSummary}`,
          status: WI_STATUS.PENDING, created: ts(), createdBy: 'engine:plan-completion',
          sourcePlan: planFile, itemType: 'pr',
          branch: featureBranch, branchStrategy: 'shared-branch', project: projectName,
        });
      });
    }
  }

  // 4. Create verification work item (build, test, start webapp, write testing guide)
  // Only one verify per PRD — skip if pending/dispatched, re-open if done/failed (PRD was modified)
  const existingVerify = allWorkItems.find(w => w.sourcePlan === planFile && w.itemType === 'verify');
  if (isActiveVerify(existingVerify)) {
    log('info', `Plan ${planFile}: verify WI ${existingVerify.id} already ${existingVerify.status} — skipping`);
  } else if (isReopenableVerify(existingVerify) && doneItems.length > 0) {
    const verifyProject = existingVerify.project || projectName;
    const vWiPath = shared.projectWorkItemsPath(
      projects.find(p => p.name?.toLowerCase() === verifyProject?.toLowerCase()) || primaryProject
    );
    let reopenedVerify = false;
    mutateWorkItems(vWiPath, items => {
      const v = items.find(w => w.id === existingVerify.id);
      if (isReopenableVerify(v)) {
        shared.reopenWorkItem(v);
        reopenedVerify = true;
      }
    });
    if (reopenedVerify) log('info', `Re-opened verification work item ${existingVerify.id} for modified plan ${planFile}`);
  } else if (!existingVerify && doneItems.length > 0) {
    const verifyId = 'PL-' + shared.uid();
    const planSlug = planFile.replace('.json', '');

    // Group PRs by project — one worktree per project with all branches merged in
    const projectPrs = {}; // projectName -> { project, prs: [], mainBranch }
    for (const p of projects) {
      const prLinks = getPrLinks();
      const prs = (safeJson(shared.projectPrPath(p)) || [])
        .filter(pr => {
          const linkedIds = prLinks[pr.id] || [];
          return pr.status === PR_STATUS.ACTIVE && linkedIds.some(itemId => doneItems.find(w => w.id === itemId));
        });
      if (prs.length > 0) {
        projectPrs[p.name] = { project: p, prs, mainBranch: shared.resolveMainBranch(p.localPath, p.mainBranch) };
      }
    }

    // Shared-branch plans already have all changes on a single feature branch — no merge needed
    const isSharedBranch = plan.branch_strategy === 'shared-branch' && plan.feature_branch;

    // Build per-project checkout commands: one worktree, merge all PR branches into it
    const checkoutBlocks = Object.entries(projectPrs).map(([name, { project: p, prs, mainBranch }]) => {
      if (isSharedBranch) {
        const featureBranch = plan.feature_branch;
        const wtPath = `${p.localPath}/../worktrees/verify-${name}-${planSlug}`;
        const lines = [
          `# ${name} — shared-branch: use existing feature branch directly`,
          `cd "${p.localPath.replace(/\\/g, '/')}"`,
          `git fetch origin "${featureBranch}"`,
          `git worktree add "${wtPath}" "origin/${featureBranch}" 2>/dev/null || (cd "${wtPath}" && git checkout "${featureBranch}" && git pull origin "${featureBranch}")`,
        ];
        return lines.join('\n');
      }
      const wtPath = `${p.localPath}/../worktrees/verify-${name}-${planSlug}-${shared.uid()}`;
      const branches = prs.map(pr => pr.branch).filter(Boolean);
      const lines = [
        `# ${name} — merge ${branches.length} PR branch(es) into one worktree`,
        `cd "${p.localPath.replace(/\\/g, '/')}"`,
        `git fetch origin ${branches.map(b => `"${b}"`).join(' ')} "${mainBranch}"`,
        `git worktree add "${wtPath}" "origin/${mainBranch}" 2>/dev/null || (cd "${wtPath}" && git checkout "${mainBranch}" && git pull origin "${mainBranch}")`,
        `cd "${wtPath}"`,
        ...branches.map(b => `git merge "origin/${b}" --no-edit  # ${prs.find(pr => pr.branch === b)?.id || b}`),
      ];
      return lines.join('\n');
    }).join('\n\n');

    // Build completed items summary with acceptance criteria
    const itemsWithCriteria = doneItems.map(w => {
      const planItem = plan.missing_features?.find(f => f.id === w.id);
      const criteria = (planItem?.acceptance_criteria || []).map(c => `  - ${c}`).join('\n');
      return `### ${w.id}: ${w.title.replace('Implement: ', '')}\n${criteria ? '**Acceptance Criteria:**\n' + criteria : ''}`;
    }).join('\n\n');

    const prSummary = uniquePrs.map(pr =>
      `- ${pr.id}: ${pr.title || ''} (branch: \`${pr.branch || '?'}\`) ${pr.url || ''}`
    ).join('\n');

    // List projects and their worktree paths for the agent
    const projectWorktrees = Object.entries(projectPrs).map(([name, { project: p }]) =>
      `- **${name}**: \`${p.localPath}/../worktrees/verify-${planSlug}\``
    ).join('\n');

    const sharedBranchNote = isSharedBranch
      ? `\n**Shared-branch plan** — all changes are already on branch \`${plan.feature_branch}\`. Use this branch directly for the E2E PR instead of creating a new \`e2e/\` branch. Check if a PR already exists for this branch before creating one.\n`
      : '';

    const description = [
      `Verification task for completed plan \`${planFile}\`.`,
      sharedBranchNote,
      `## Projects & Worktrees`,
      ``,
      `Each project gets ONE worktree with all PR branches merged in:`,
      projectWorktrees,
      ``,
      `## Setup Commands`,
      ``,
      `\`\`\`bash`,
      checkoutBlocks,
      `\`\`\``,
      ``,
      `If any merge conflicts occur, resolve them (prefer the PR branch changes).`,
      `After setup, build and test from the worktree paths above.`,
      ``,
      `## Completed Items`,
      ``,
      itemsWithCriteria,
      ``,
      `## Pull Requests`,
      ``,
      prSummary,
    ].join('\n');

    let createdVerify = false;
    let reopenedVerifyId = null;
    mutateWorkItems(wiPath, workItems => {
      const v = workItems.find(w => w.sourcePlan === planFile && w.itemType === 'verify');
      if (v) {
        if (isReopenableVerify(v)) {
          shared.reopenWorkItem(v);
          reopenedVerifyId = v.id;
        }
        return workItems;
      }
      workItems.push({
        id: verifyId,
        title: `Verify plan: ${(plan.plan_summary || planFile).slice(0, 80)}`,
        type: 'verify',
        priority: 'high',
        description,
        status: WI_STATUS.PENDING,
        created: ts(),
        createdBy: 'engine:plan-verification',
        sourcePlan: planFile,
        itemType: 'verify',
        project: projectName,
      });
      createdVerify = true;
    });
    if (createdVerify) {
      log('info', `Created verification work item ${verifyId} for plan ${planFile}`);

      // Teams notification for verify creation — non-blocking
      try {
        const teams = require('./teams');
        teams.teamsNotifyPlanEvent({ name: plan.plan_summary || planFile, file: planFile }, 'verify-created').catch(() => {});
      } catch {}
    } else if (reopenedVerifyId) {
      log('info', `Re-opened verification work item ${reopenedVerifyId} for modified plan ${planFile}`);
    }
  }

  // Archive deferred until verify completes

  // Teams notification for plan completion — non-blocking
  try {
    const teams = require('./teams');
    teams.teamsNotifyPlanEvent({
      name: plan.plan_summary || planFile, file: planFile, project: plan.project,
      doneCount: doneItems.length, totalCount: planFeatureIds.size,
    }, 'plan-completed').catch(() => {});
  } catch {}

  log('info', `PRD ${planFile} completed: ${doneItems.length} done, ${failedItems.length} failed, runtime ${runtimeMin}m`);
  return true;
}

// ─── Archive Plan ───────────────────────────────────────────────────────────
function archivePlan(planFile, plan, projects, config) {
  const planPath = path.join(PRD_DIR, planFile);

  // Archive PRD .json to prd/archive/
  const prdArchiveDir = path.join(PRD_DIR, 'archive');
  if (!fs.existsSync(prdArchiveDir)) fs.mkdirSync(prdArchiveDir, { recursive: true });
  try {
    if (fs.existsSync(planPath)) {
      fs.renameSync(planPath, path.join(prdArchiveDir, planFile));
      log('info', `Archived completed PRD: prd/archive/${planFile}`);
    }
    // Remove .backup sidecar — if left behind, safeJson() would restore the pre-completion
    // snapshot (status: approved, no _completionNotified) on engine restart, re-triggering
    // plan completion and spawning duplicate verify tasks for already-archived plans.
    // On Windows, the unlink can fail due to file locking; overwrite with archived status
    // as a fallback so a restored backup is inert even if deletion fails.
    const backupCleanup = shared.neutralizeJsonBackupSidecar(planPath);
    if (!backupCleanup.ok) {
      log('warn', `Archive backup cleanup failed for ${planFile}: unlink failed (${backupCleanup.unlinkError}); fallback neutralize failed (${backupCleanup.writeError})`);
    }
  } catch (err) {
    log('warn', `Failed to archive PRD ${planFile}: ${err.message}`);
  }

  // Archive the source .md plan if it exists
  const projectName = plan.project;
  const planArchiveDir = path.join(PLANS_DIR, 'archive');
  if (!fs.existsSync(planArchiveDir)) fs.mkdirSync(planArchiveDir, { recursive: true });
  try {
    // Direct match by source_plan field or planFile-derived name
    const sourcePlanName = plan.source_plan || planFile.replace(/\.json$/, '.md');
    if (sourcePlanName && fs.existsSync(path.join(PLANS_DIR, sourcePlanName))) {
      try {
        fs.renameSync(path.join(PLANS_DIR, sourcePlanName), path.join(planArchiveDir, sourcePlanName));
        log('info', `Archived source plan: plans/archive/${sourcePlanName}`);
      } catch (err) { log('warn', `Failed to archive plan ${sourcePlanName}: ${err.message}`); }
    } else {
      // Fallback: match by content
      const mdFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
      for (const md of mdFiles) {
        const mdContent = shared.safeRead(path.join(PLANS_DIR, md)) || '';
        if (mdContent.includes(projectName) || mdContent.includes(plan.plan_summary?.slice(0, 40) || '___nomatch___')) {
          try {
            fs.renameSync(path.join(PLANS_DIR, md), path.join(planArchiveDir, md));
            log('info', `Archived source plan: plans/archive/${md}`);
          } catch (err) { log('warn', `Failed to archive plan ${md}: ${err.message}`); }
          break;
        }
      }
    }
  } catch (err) { log('warn', `Plan archive scan: ${err.message}`); }

  // Clean up ALL worktrees created for this plan's work items (shared-branch + per-item)
  cleanupPlanWorktrees(planFile, plan, projects, config);
}

/**
 * Clean up worktrees associated with a plan's work items and PRs.
 * Called from archivePlan() and also from plan delete/archive handlers.
 */
function cleanupPlanWorktrees(planFile, plan, projects, config) {
  try {
    const branchSlugs = new Set();
    if (plan?.feature_branch) branchSlugs.add(shared.sanitizeBranch(plan.feature_branch).toLowerCase());

    const allWorkItems = queries.getWorkItems(config);
    const planItems = allWorkItems.filter(w => w.sourcePlan === planFile);
    for (const w of planItems) {
      if (w.branch) branchSlugs.add(shared.sanitizeBranch(w.branch).toLowerCase());
      if (w.id) branchSlugs.add(w.id.toLowerCase());
    }

    for (const p of projects) {
      try {
        const prs = safeJson(shared.projectPrPath(p)) || [];
        const prLinks = getPrLinks();
        for (const pr of prs) {
          const linkedIds = prLinks[pr.id] || [];
          if (linkedIds.some(itemId => planItems.find(w => w.id === itemId)) && pr.branch) {
            branchSlugs.add(shared.sanitizeBranch(pr.branch).toLowerCase());
          }
        }
      } catch { /* optional */ }
    }

    if (branchSlugs.size === 0) return;

    let cleanedWt = 0;
    for (const p of projects) {
      const root = path.resolve(p.localPath);
      const wtRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
      if (!fs.existsSync(wtRoot)) continue;
      const dirs = fs.readdirSync(wtRoot);
      for (const dir of dirs) {
        const wtPath = path.join(wtRoot, dir);
        const dirLower = dir.toLowerCase();
        const actualBranch = getWorktreeBranch(wtPath);
        const actualBranchSlug = actualBranch ? shared.sanitizeBranch(actualBranch).toLowerCase() : '';
        const matches = [...branchSlugs].some(slug => dirLower.includes(slug) || actualBranchSlug === slug);
        if (matches) {
          if (shared.removeWorktree(wtPath, root, wtRoot)) cleanedWt++;
        }
      }
    }
    if (cleanedWt > 0) log('info', `Plan worktree cleanup: removed ${cleanedWt} worktree(s)`);
  } catch (err) { log('warn', `Plan worktree cleanup: ${err.message}`); }
}

// ─── Work Item Path Resolution ───────────────────────────────────────────────

/** Resolve the work-items.json path from dispatch meta. Reused by retry paths. */
function resolveWorkItemPath(meta) {
  if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
    return path.join(MINIONS_DIR, 'work-items.json');
  }
  if (meta.source === 'work-item' && meta.project?.name) {
    return path.join(MINIONS_DIR, 'projects', meta.project.name, 'work-items.json');
  }
  return null;
}

/** Check if a work item is in a terminal completed state. */
function isItemCompleted(item) {
  return item.status === WI_STATUS.DONE || !!item.completedAt;
}

// ─── Work Item Status ────────────────────────────────────────────────────────
const _VALID_WI_STATUSES = new Set(Object.values(WI_STATUS));
function updateWorkItemStatus(meta, status, reason) {

  const itemId = meta.item?.id;
  if (!itemId) return;
  if (!_VALID_WI_STATUSES.has(status)) {
    log('warn', `Invalid work item status '${status}' for ${itemId} — ignoring`);
    return;
  }

  const wiPath = resolveWorkItemPath(meta);
  if (!wiPath) return;

  let completionGuarded = false;
  mutateJsonFileLocked(wiPath, (items) => {
    if (!items || !Array.isArray(items)) return items;
    const target = items.find(i => i.id === itemId);
    if (!target) return items;
    if (status !== WI_STATUS.DONE && (
      target.status === WI_STATUS.DONE ||
      (!!target.completedAt && (!!target._pr || !!target._prUrl))
    )) {
      completionGuarded = true;
      return items;
    }

    if (meta.source === 'central-work-item-fanout') {
      if (!target.agentResults) target.agentResults = {};
      const parts = (meta.dispatchKey || '').split('-');
      const agent = parts[parts.length - 1] || 'unknown';
      target.agentResults[agent] = { status, completedAt: ts(), reason: reason || undefined };

      const results = Object.values(target.agentResults);
      const anySuccess = results.some(r => r.status === WI_STATUS.DONE);
      const allDone = Array.isArray(target.fanOutAgents) && target.fanOutAgents.length > 0 ? results.length >= target.fanOutAgents.length : false;
      const dispatchAge = target.dispatched_at ? Date.now() - new Date(target.dispatched_at).getTime() : 0;
      const timedOut = !allDone && dispatchAge > 6 * 60 * 60 * 1000 && results.length > 0;

      if (anySuccess) {
        target.status = WI_STATUS.DONE;
        delete target.failReason;
        delete target.failedAt;
        delete target._retryCount;
        target.completedAgents = Object.entries(target.agentResults)
          .filter(([, r]) => r.status === WI_STATUS.DONE)
          .map(([a]) => a);
      } else if (allDone || timedOut) {
        target.status = WI_STATUS.FAILED;
        target.failReason = timedOut
          ? `Fan-out timed out: ${results.length}/${(target.fanOutAgents || []).length} agents reported (all failed)`
          : 'All fan-out agents failed';
        target.failedAt = ts();
      }
    } else {
      target.status = status;
      if (status === WI_STATUS.DONE) {
        delete target.failReason;
        delete target.failedAt;
        delete target._retryCount;
        target.completedAt = ts();
        // Restore agent info from dispatch metadata (cleared on retry reset)
        if (meta._agentId && !target.dispatched_to) target.dispatched_to = meta._agentId;
      } else if (status === WI_STATUS.FAILED) {
        if (reason) target.failReason = reason;
        target.failedAt = ts();
      }
    }
    return items;
  }, { defaultValue: [], skipWriteIfUnchanged: true });

  if (completionGuarded) {
    log('info', `Work item ${itemId} already completed — ignoring ${status} status update`);
    return;
  }
  log('info', `Work item ${itemId} → ${status}${reason ? ': ' + reason : ''}`);
  syncPrdItemStatus(itemId, status, meta.item?.sourcePlan);
}

const _VALID_PRD_STATUSES = new Set([...Object.values(WI_STATUS), 'missing']);
// (#984) PRD statuses that are stale when the work item is actually done
const _STALE_PRD_STATUSES = new Set([WI_STATUS.DISPATCHED, WI_STATUS.FAILED, WI_STATUS.PENDING]);
function syncPrdItemStatus(itemId, status, sourcePlan) {
  if (!itemId) return;
  if (!_VALID_PRD_STATUSES.has(status)) return;
  try {
    const prdDir = path.join(MINIONS_DIR, 'prd');
    const files = sourcePlan ? [sourcePlan] : require('fs').readdirSync(prdDir).filter(f => f.endsWith('.json'));
    for (const pf of files) {
      const fpath = path.join(prdDir, pf);
      // Lock-free peek: most PRDs won't contain the ID, so skip the lock cost.
      const plan = safeJson(fpath);
      const feature = plan?.missing_features?.find(f => f.id === itemId);
      if (!feature || feature.status === status) continue;
      let updated = false;
      mutateJsonFileLocked(fpath, (fresh) => {
        const f = fresh?.missing_features?.find(x => x.id === itemId);
        if (f && f.status !== status) {
          f.status = status;
          updated = true;
        }
        return fresh;
      }, { skipWriteIfUnchanged: true });
      if (updated) return;
    }
  } catch (err) { log('warn', `PRD status sync: ${err.message}`); }
}

// ─── PRD Backward-Scan Reconciliation (#929, #984) ─────────────────────────
// Proactive counterpart to syncPrdItemStatus. Scans all active PRDs and:
// 1. Promotes "missing" items to "updated" when a done work item already exists (#929)
// 2. Promotes stale "dispatched"/"failed"/"pending" items to "done" when the work item
//    is actually done (#984) — catches cases where fix work items complete with a
//    different ID than the original PRD feature, leaving the PRD status stale.

function reconcilePrdStatuses(config) {
  if (!fs.existsSync(PRD_DIR)) return;
  let prdFiles;
  try { prdFiles = fs.readdirSync(PRD_DIR).filter(f => f.endsWith('.json')); } catch { return; }
  if (prdFiles.length === 0) return;

  const allWorkItems = queries.getWorkItems(config);
  if (allWorkItems.length === 0) return;

  // Index done work items by ID for O(1) lookup
  const doneWiById = new Map();
  for (const wi of allWorkItems) {
    if (wi.id && DONE_STATUSES.has(wi.status)) doneWiById.set(wi.id, wi);
  }
  if (doneWiById.size === 0) return;

  for (const file of prdFiles) {
    try {
      const fpath = path.join(PRD_DIR, file);
      const logMessages = [];
      mutateJsonFileLocked(fpath, (plan) => {
        if (!plan?.missing_features) return plan;
        // Skip completed/archived PRDs — no reconciliation needed
        if (plan.status === PLAN_STATUS.COMPLETED) return plan;

        for (const feature of plan.missing_features) {
          if (feature.status === PRD_ITEM_STATUS.MISSING && doneWiById.has(feature.id)) {
            feature.status = PRD_ITEM_STATUS.UPDATED;
            logMessages.push(`PRD backward-scan: promoted ${feature.id} from missing→updated in ${file} (done work item exists)`);
          }
          // (#984) Stale status: PRD item stuck at dispatched/failed/pending while WI is done —
          // happens when fix work items complete with a different ID than the original PRD feature
          else if (_STALE_PRD_STATUSES.has(feature.status) && doneWiById.has(feature.id)) {
            const prev = feature.status;
            feature.status = WI_STATUS.DONE;
            logMessages.push(`PRD backward-scan: promoted ${feature.id} from ${prev}→done in ${file} (done work item exists)`);
          }
        }
        return plan;
      }, { skipWriteIfUnchanged: true });
      for (const message of logMessages) log('info', message);
    } catch (err) { log('warn', `PRD backward-scan for ${file}: ${err.message}`); }
  }
}

// ─── PR Sync from Output ─────────────────────────────────────────────────────

function syncPrsFromOutput(output, agentId, meta, config, opts = {}) {
  const { structuredCompletion = null } = opts;
  const outputText = String(output || '');
  const prEvidence = new Map();
  const trustedPrCreateToolIds = new Set();
  const prUrlPattern = /(https?:\/\/github\.com\/[^\s"'\\)\]]+\/[^\s"'\\)\]]+\/pull\/(\d+)(?:[^\s"'\\)\]]*)?|https?:\/\/(?:dev\.azure\.com|[^/\s"'\\)\]]+\.visualstudio\.com)[^\s"'\\)\]]*?pullrequest\/(\d+)(?:[^\s"'\\)\]]*)?)/gi;
  let match;

  function cleanPrUrl(url) {
    return String(url || '').replace(/[.,;:]+$/, '');
  }

  function addPrUrlEvidence(text) {
    if (!text) return;
    prUrlPattern.lastIndex = 0;
    while ((match = prUrlPattern.exec(String(text))) !== null) {
      const prId = match[2] || match[3];
      if (prId && !prEvidence.has(prId)) prEvidence.set(prId, cleanPrUrl(match[1]));
    }
  }

  function addExplicitPrCreatedEvidence(text) {
    if (!text) return;
    const explicitPrCreatedPattern = /(?:^|\n)\s*\*{0,2}(?:PR|Pull\s+Request|E2E\s+PR)\s+(?:created|opened|submitted)\*{0,2}\s*[:\-]\s*([^\n]+)/gi;
    let createdMatch;
    while ((createdMatch = explicitPrCreatedPattern.exec(String(text))) !== null) {
      addPrUrlEvidence(createdMatch[1]);
    }
  }

  function addStructuredPrEvidence(completion) {
    const raw = completion?.pr ?? completion?.pull_request ?? completion?.pullRequest;
    if (raw == null) return;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value || '');
      if (!text || /^(?:n\/a|na|none|null|no pr|-)\s*$/i.test(text.trim())) continue;
      const before = prEvidence.size;
      addPrUrlEvidence(text);
      if (prEvidence.size > before) continue;
      const idMatch = text.match(/\b(?:PR|pull\s*request)?\s*#?\s*(\d{1,10})\b/i);
      if (idMatch && !prEvidence.has(idMatch[1])) prEvidence.set(idMatch[1], '');
    }
  }

  function isTrustedPrCreateToolUse(block) {
    const name = String(block?.name || '');
    if (/(?:create|open|submit)[_-]?(?:pull[_-]?request|pr)|(?:pull[_-]?request|pr)[_-]?(?:create|open|submit)/i.test(name)) {
      return true;
    }
    const inputText = typeof block?.input === 'string' ? block.input : JSON.stringify(block?.input || {});
    if (/\bgh(?:\.exe)?\s+pr\s+create\b/i.test(inputText)) return true;
    if (/\baz(?:\.cmd|\.exe)?\s+repos\s+pr\s+create\b/i.test(inputText)) return true;
    const callsAdoCreateApi = /_apis\/git\/repositories\/[^\s"'\\]+\/pullrequests\b/i.test(inputText);
    const usesPost = /\bPOST\b|-X\s*POST|-Method\s+POST|method["']?\s*:\s*["']?POST/i.test(inputText);
    return callsAdoCreateApi && usesPost;
  }

  try {
    const lines = outputText.split('\n');
    for (const line of lines) {
      try {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"result"') && !line.includes('"type":"user"')) continue;
        const parsed = JSON.parse(line);
        const content = parsed.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_use' && block.id && isTrustedPrCreateToolUse(block)) {
            trustedPrCreateToolIds.add(block.id);
          }
          // Tool output is trusted only when tied to a known PR-create command/API call.
          if (block.type === 'tool_result' && block.content) {
            if (trustedPrCreateToolIds.has(block.tool_use_id)) {
              const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              addPrUrlEvidence(text);
            }
          }
          // Assistant text must use the explicit Minions PR-created protocol line.
          if (block.type === 'text' && block.text) {
            addExplicitPrCreatedEvidence(block.text);
          }
        }
        if (parsed.type === 'result' && parsed.result) {
          const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
          addExplicitPrCreatedEvidence(resultText);
        }
      } catch {}
    }
  } catch {}

  addStructuredPrEvidence(structuredCompletion);

  // Accept inbox fallback ONLY when the agent's stdout is empty (rotated/lost).
  // The inbox note is the durable artifact for the "gh pr create ran in a sibling
  // dispatch whose stdout was rotated" case. When stdout has actual content (even
  // without PR evidence — e.g. the agent ran gh issue view but didn't create a PR),
  // we must NOT pull in PR URLs from leftover inbox files of prior dispatches —
  // those would falsely attribute unrelated PRs to this run.
  if (!outputText.trim()) {
    const today = dateStamp();
    const inboxFiles = getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
    const currentItemId = meta?.item?.id ? String(meta.item.id) : '';
    function isCurrentItemInboxNote(fileName, content) {
      if (!currentItemId) return true;
      return String(fileName || '').includes(currentItemId) || String(content || '').includes(currentItemId);
    }
    for (const f of inboxFiles) {
      const content = safeRead(path.join(INBOX_DIR, f));
      if (!content) continue;
      if (!isCurrentItemInboxNote(f, content)) continue;
      const prHeaderPattern = /(?:^|\n)\s*\*{0,2}(?:PR|Pull\s+Request|E2E\s+PR)\s+(?:created|opened|submitted)\*{0,2}\s*[:\-]\s*([^\n]+)/gi;
      while ((match = prHeaderPattern.exec(content)) !== null) {
        addPrUrlEvidence(match[1]);
      }
    }
  }

  if (prEvidence.size === 0) return 0;

  const projects = shared.getProjects(config);
  if (projects.length === 0 && !meta?.project?.name) return 0;
  const defaultProject = (meta?.project?.name && projects.find(p => p.name === meta.project.name)) || projects[0];
  const useCentral = !defaultProject;

  // Match each PR to its correct project by finding which repo URL appears near the PR number in output
  function resolveProjectForPr(prId) {
    const evidenceUrl = prEvidence.get(prId) || '';
    const evidenceText = `${outputText}\n${evidenceUrl}`;
    for (const p of projects) {
      if (!p.prUrlBase) continue;
      const urlFragment = p.prUrlBase.replace(/pullrequest\/$/, '');
      if (evidenceText.includes(urlFragment + 'pullrequest/' + prId) || evidenceText.includes(urlFragment + prId)) return p;
    }
    for (const p of projects) {
      if (p.repoName && evidenceText.includes(`_git/${p.repoName}/pullrequest/${prId}`)) return p;
    }
    return defaultProject;
  }

  // Extract PR URL directly from agent output — no manual construction.
  // Falls back to the URL captured from the inbox note when the agent stdout
  // doesn't contain the link (gh pr create may have run in a sibling dispatch
  // whose stdout was rotated; the inbox note is the durable artifact).
  function extractPrUrl(prId) {
    return prEvidence.get(prId) || '';
  }

  const agentName = config.agents?.[agentId]?.name || agentId;
  let added = 0;
  const centralPrPath = path.join(MINIONS_DIR, 'pull-requests.json');

  // Group new PRs by target file path
  const newPrsByPath = new Map(); // prPath -> [{ prId, newEntry }]

  for (const prId of prEvidence.keys()) {
    const targetProject = useCentral ? null : resolveProjectForPr(prId);
    const targetName = targetProject ? targetProject.name : '_central';
    const prPath = targetProject ? shared.projectPrPath(targetProject) : centralPrPath;
    const prUrl = extractPrUrl(prId);
    const fullId = shared.getCanonicalPrId(targetProject, prId, prUrl);

    let title = meta?.item?.title || '';
    const titleMatch = outputText.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
    if (titleMatch) title = titleMatch[1].trim();
    if (title.includes('session_id') || title.includes('is_error') || title.includes('uuid') || title.length > 120 || /[{}"\[\]]/.test(title) || /^[0-9a-f-]{8,}$/i.test(title)) {
      title = meta?.item?.title || '';
    }

    if (!newPrsByPath.has(prPath)) newPrsByPath.set(prPath, { name: targetName, project: targetProject, entries: [] });
    const entry = {
      id: fullId,
      prNumber: parseInt(prId, 10) || prId,
      title: (title || `PR created by ${agentName}`).slice(0, 120),
      agent: agentName,
      branch: meta?.branch || '',
      reviewStatus: 'pending',
      status: PR_STATUS.ACTIVE,
      created: ts(),
      url: prUrl,
      prdItems: meta?.item?.id ? [meta.item.id] : [],
      sourcePlan: meta?.item?.sourcePlan || '',
      itemType: meta?.item?.itemType || ''
    };
    // Issue #1772: one-off dispatches (e.g. human-initiated "review this PR" via CC)
    // must not enroll the discovered PR into the auto eval loop. Tag _contextOnly so
    // discoverFromPrs skips it for review/fix dispatch (still polled for status/comments).
    if (meta?.item?.oneShot) entry._contextOnly = true;
    newPrsByPath.get(prPath).entries.push({ prId, fullId, entry });
  }

  const entryBranch = meta?.branch || '';

  for (const [prPath, { name, project: targetProject, entries }] of newPrsByPath) {
    for (const { prId, fullId, entry } of entries) {
      let duplicateOnBranch = null;
      const result = shared.upsertPullRequestRecord(prPath, entry, {
        project: targetProject,
        itemId: meta?.item?.id || null,
        beforeInsert: (prs, normalizedEntry) => {
          // Normalize legacy YYYY-MM-DD created dates to ISO while the file is locked.
          for (const p of prs) {
            if (p.created && p.created.length === 10) p.created = p.created + 'T00:00:00.000Z';
          }
          // Branch-level dedup: skip if an active PR already exists on the same branch.
          // This prevents duplicate PRs when an agent retries and calls `gh pr create` again
          // on the same branch (GitHub allows multiple PRs from one branch).
          // Only block when the existing PR is active — abandoned/merged PRs don't conflict.
          const branch = normalizedEntry.branch || entryBranch;
          if (!branch) return true;
          duplicateOnBranch = prs.find(p => p.branch === branch && p.status === PR_STATUS.ACTIVE && p.id !== normalizedEntry.id) || null;
          return !duplicateOnBranch;
        },
      });
      if (duplicateOnBranch) {
        log('warn', `Duplicate PR detected: ${fullId} on branch ${entry.branch || entryBranch} — already tracked as ${duplicateOnBranch.id}. Skipping.`);
        // Best-effort close the duplicate on GitHub (non-blocking, fire-and-forget)
        try {
          const ghSlug = outputText.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
          if (ghSlug) {
            execAsync(`gh pr close ${prId} --repo ${ghSlug} --comment "Closing duplicate — ${duplicateOnBranch.id} already tracks this branch."`, { timeout: 15000 })
              .catch(() => {});
          }
        } catch { /* best-effort */ }
        continue;
      }
      if (result.created || result.linked) added++;
    }
    log('info', `Synced PR(s) from ${agentName}'s output to ${name === '_central' ? 'central' : name}/pull-requests.json`);
  }
  return added;
}

function isPrAttachmentRequired(type, item, meta = {}) {
  if (!item?.id || item.skipPr) return false;
  const explicit = item.requiresPr === true
    || item.prRequired === true
    || item.requiresPullRequest === true
    || item.itemType === 'pr';
  const branchStrategy = meta.branchStrategy || item.branchStrategy;
  if (branchStrategy === 'shared-branch' && item.itemType !== 'pr' && !explicit) return false;

  // Fix/test work items dispatched against an existing PR don't produce a new
  // PR — the agent updates meta.pr in place. The meta.pr short-circuit beats
  // the explicit-flag fallthrough so a legacy requiresPr:true fix doesn't
  // trigger the contract when there's already a PR attached.
  if ((type === WORK_TYPE.FIX || type === WORK_TYPE.TEST) && meta?.pr) return false;

  // Standalone test work is usually pure build/run/verify. It should only be
  // PR-required when the caller explicitly marks it as file-changing work.
  if (type === WORK_TYPE.TEST && !explicit) return false;

  return explicit
    || type === WORK_TYPE.IMPLEMENT
    || type === WORK_TYPE.IMPLEMENT_LARGE
    || type === WORK_TYPE.FIX;
}

function readOptionalJsonStrict(filePath, label, validate) {
  if (!filePath) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${label} JSON at ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt ${label} JSON at ${filePath}: ${err.message}`);
  }
  if (validate && !validate(parsed)) {
    throw new Error(`Invalid ${label} JSON shape at ${filePath}`);
  }
  return parsed;
}

function hasCanonicalPrAttachment(itemId, config) {
  if (!itemId) return false;
  // Cheapest probe first — getPrLinks() is in-process cached and merges canonical IDs.
  if (Object.values(getPrLinks()).some(linkedIds => (linkedIds || []).includes(itemId))) return true;
  const projects = shared.getProjects(config);
  for (const p of projects) {
    const prs = readOptionalJsonStrict(shared.projectPrPath(p), 'project pull-requests', Array.isArray) || [];
    if (prs.some(pr => (pr.prdItems || []).includes(itemId))) return true;
  }
  const centralPrs = readOptionalJsonStrict(path.join(MINIONS_DIR, 'pull-requests.json'), 'central pull-requests', Array.isArray) || [];
  return centralPrs.some(pr => (pr.prdItems || []).includes(itemId));
}

function resolvePrFallbackProject(meta, config) {
  const projects = shared.getProjects(config);
  if (meta?.project?.name) {
    const match = projects.find(p => p.name === meta.project.name);
    if (match) return match;
  }
  if (meta?.project?.localPath) {
    const metaPath = path.resolve(meta.project.localPath);
    const match = projects.find(p => p.localPath && path.resolve(p.localPath) === metaPath);
    if (match) return match;
  }
  if (meta?.item?.project) {
    const match = projects.find(p => p.name === meta.item.project);
    if (match) return match;
  }
  return projects.length === 1 ? projects[0] : null;
}

function runFileCapture(file, args, opts = {}) {
  const { timeout = 30000, ...spawnOpts } = opts;
  const MAX_BUFFER = 4 * 1024 * 1024; // 4MB — generous for gh/git output
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let killedForBuffer = false;
    let stdout = '';
    let stderr = '';
    let hardKillTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      fn(value);
    };
    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      if (!child) return;
      shared.killGracefully(child, 1000);
      // Hard-kill fallback if the child ignores SIGTERM. Cleared on close.
      hardKillTimer = setTimeout(() => {
        try { shared.killImmediate(child); } catch {}
      }, 2500);
    }, timeout) : null;
    try {
      child = shared.runFile(file, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish(reject, err);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (stdout.length + chunk.length > MAX_BUFFER) {
        if (!killedForBuffer) { killedForBuffer = true; try { shared.killImmediate(child); } catch {} }
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length + chunk.length > MAX_BUFFER) {
        if (!killedForBuffer) { killedForBuffer = true; try { shared.killImmediate(child); } catch {} }
        return;
      }
      stderr += chunk;
    });
    child.on('error', err => {
      err.stdout = stdout;
      err.stderr = stderr;
      finish(reject, err);
    });
    child.once('close', () => {
      if (hardKillTimer) { clearTimeout(hardKillTimer); hardKillTimer = null; }
    });
    child.on('close', code => {
      if (code === 0 && !timedOut && !killedForBuffer) {
        finish(resolve, stdout);
        return;
      }
      let message;
      let errCode;
      if (timedOut) {
        message = `${file} timed out after ${timeout}ms`;
        errCode = 'ETIMEDOUT';
      } else if (killedForBuffer) {
        message = `${file} exceeded max buffer of ${MAX_BUFFER} bytes`;
        errCode = 'ERR_OUT_OF_RANGE';
      } else {
        message = `${file} exited with code ${code}`;
        errCode = code;
      }
      const err = new Error(message);
      err.code = errCode;
      err.stdout = stdout;
      err.stderr = stderr;
      finish(reject, err);
    });
  });
}

async function findOpenPrForBranch(meta, config) {
  if (!meta?.branch) return null;
  const projectObj = resolvePrFallbackProject(meta, config);
  if (!projectObj) return null;
  const host = projectObj.repoHost || 'ado';
  if (host === 'github') {
    const ghSlug = projectObj.prUrlBase?.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
    if (!ghSlug) return null;
    const maxAttempts = ENGINE_DEFAULTS.prAutoLinkRetries;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      let raw = '';
      try {
        raw = await runFileCapture('gh', ['pr', 'list', '--head', String(meta.branch), '--repo', ghSlug, '--json', 'number,url,state', '--limit', '1'], { timeout: 15000 });
        const parsed = JSON.parse(raw || '[]');
        const hits = Array.isArray(parsed) ? parsed : [];
        if (hits.length > 0 && hits[0].state === 'OPEN') {
          return { project: projectObj, prNumber: hits[0].number, url: hits[0].url };
        }
        if (attempt === maxAttempts - 1) {
          log('warn', `Auto-link fallback: no open PR found on branch ${meta.branch} after ${maxAttempts} attempts (raw: ${(raw || '').slice(0, 200)})`);
        }
      } catch (err) {
        if (attempt === maxAttempts - 1) {
          const rawSuffix = raw ? ` (raw: ${raw.slice(0, 200)})` : '';
          log('warn', `Auto-link fallback: gh pr list lookup failed on branch ${meta.branch} after ${maxAttempts} attempts: ${err.message}${rawSuffix}`);
        }
      }
    }
    return null;
  }
  if (host === 'ado') {
    const found = await require('./ado').findOpenPrOnBranch(projectObj, meta.branch);
    return found ? { project: projectObj, prNumber: found.prNumber, url: found.url } : null;
  }
  log('debug', `Skipping branch PR lookup for unsupported repo host "${host}" on ${projectObj.name}`);
  return null;
}

// Lightweight probe for "did the agent's output contain ANY PR URL?". Used by
// the PR-attachment contract to distinguish silent-failure (no URL anywhere)
// from auto-link-miss (URL present but engine couldn't canonically attach it).
// Keep this regex roughly in sync with the gated detection in syncPrsFromOutput
// — this is yes/no only; no capture groups required.
function _outputContainsPrUrl(output) {
  if (!output || typeof output !== 'string') return false;
  const prUrlPattern = /https?:\/\/(?:github\.com\/[^\s"'\\)\]]+\/[^\s"'\\)\]]+\/pull\/\d+|(?:dev\.azure\.com|[^/\s"'\\)\]]+\.visualstudio\.com)[^\s"'\\)\]]*?pullrequest\/\d+)/i;
  return prUrlPattern.test(output);
}

function markMissingPrAttachment(meta, agentId, reason, resultSummary, severity) {
  const noPrWiPath = resolveWorkItemPath(meta);
  const isHard = severity !== 'soft';
  let syncFailedToPrd = false;
  if (noPrWiPath) {
    mutateJsonFileLocked(noPrWiPath, data => {
      if (!Array.isArray(data)) return data;
      const w = data.find(i => i.id === meta.item.id);
      if (!w) return data;
      if (isHard) {
        w.status = WI_STATUS.FAILED;
        w._missingPrAttachment = true;
        w.failReason = reason;
        w.failedAt = ts();
        w._lastReviewReason = reason;
        syncFailedToPrd = !!meta.item?.sourcePlan;
        delete w.completedAt;
        delete w._noPr;
        delete w._noPrReason;
      } else {
        // Soft: don't change status or failReason — the agent did the work,
        // we just couldn't auto-attach the PR. Surface a flag for the dashboard
        // so the dispatch row can render a yellow "verify" badge.
        w._unverifiedPrAttachment = true;
        w._lastReviewReason = reason;
      }
      return data;
    }, { skipWriteIfUnchanged: true });
  }
  if (isHard && syncFailedToPrd) {
    syncPrdItemStatus(meta.item.id, WI_STATUS.FAILED, meta.item.sourcePlan);
  }
  if (isHard) {
    shared.writeToInbox('engine', `missing-pr-attachment-${meta.item.id}`,
      `# PR attachment missing for ${meta.item.id}\n\n` +
      `**Agent:** ${agentId}\n` +
      `**Work item:** \`${meta.item.id}\` — ${meta.item.title || ''}\n` +
      `**Type:** ${meta.item.type || 'unknown'}\n` +
      `**Branch:** ${meta.branch || '(none)'}\n\n` +
      `${reason}\n` +
      (resultSummary ? `\n## Agent summary\n${resultSummary}\n` : ''),
      null,
      { sourceItem: meta.item.id, reason: 'missing-pr-attachment' });
  } else {
    shared.writeToInbox('engine', `pr-auto-link-unverified-${meta.item.id}`,
      `# PR auto-link unverified for ${meta.item.id}\n\n` +
      `**Agent:** ${agentId}\n` +
      `**Work item:** \`${meta.item.id}\` — ${meta.item.title || ''}\n` +
      `**Type:** ${meta.item.type || 'unknown'}\n` +
      `**Branch:** ${meta.branch || '(none)'}\n\n` +
      `${reason}\n\n` +
      `The agent's output mentioned a PR URL but the engine couldn't canonically attach it ` +
      `(URL detection regex miss, branch lookup race, untrusted tool_use signature, etc.). ` +
      `The work likely succeeded — verify against the project's PR list.\n` +
      (resultSummary ? `\n## Agent summary\n${resultSummary}\n` : ''),
      null,
      { sourceItem: meta.item.id, reason: 'pr-auto-link-unverified' });
  }
}

function markPrAttachmentVerificationError(meta, agentId, reason, resultSummary) {
  const wiPath = resolveWorkItemPath(meta);
  let syncFailedToPrd = false;
  if (wiPath) {
    mutateJsonFileLocked(wiPath, data => {
      if (!Array.isArray(data)) return data;
      const w = data.find(i => i.id === meta.item.id);
      if (!w) return data;
      w.status = WI_STATUS.FAILED;
      w._prAttachmentStateError = true;
      w.failReason = reason;
      w.failedAt = ts();
      w._lastReviewReason = reason;
      syncFailedToPrd = !!meta.item?.sourcePlan;
      delete w.completedAt;
      delete w._missingPrAttachment;
      delete w._unverifiedPrAttachment;
      return data;
    }, { skipWriteIfUnchanged: true });
  }
  if (syncFailedToPrd) {
    syncPrdItemStatus(meta.item.id, WI_STATUS.FAILED, meta.item.sourcePlan);
  }
  shared.writeToInbox('engine', `pr-attachment-state-error-${meta.item.id}`,
    `# PR attachment verification blocked for ${meta.item.id}\n\n` +
    `**Agent:** ${agentId}\n` +
    `**Work item:** \`${meta.item.id}\` — ${meta.item.title || ''}\n` +
    `**Type:** ${meta.item.type || 'unknown'}\n` +
    `**Branch:** ${meta.branch || '(none)'}\n\n` +
    `${reason}\n` +
    (resultSummary ? `\n## Agent summary\n${resultSummary}\n` : ''),
    null,
    { sourceItem: meta.item.id, reason: 'pr-attachment-state-error' });
}

async function enforcePrAttachmentContract(type, meta, agentId, config, resultSummary, output) {
  if (!isPrAttachmentRequired(type, meta?.item, meta)) return null;
  try {
    if (hasCanonicalPrAttachment(meta.item.id, config)) return null;
  } catch (err) {
    const reason = `${meta.item.id} completed but PR attachment verification could not read PR tracking state: ${err.message}`;
    markPrAttachmentVerificationError(meta, agentId, reason, resultSummary);
    log('warn', reason);
    return { reason, itemId: meta.item.id, severity: 'hard', stateError: true };
  }

  const found = await findOpenPrForBranch(meta, config);
  if (found) {
    const entry = {
      id: shared.getCanonicalPrId(found.project, found.prNumber, found.url),
      prNumber: found.prNumber,
      title: meta.item?.title || `PR #${found.prNumber}`,
      agent: agentId,
      branch: meta.branch || '',
      reviewStatus: 'pending',
      status: PR_STATUS.ACTIVE,
      created: ts(),
      url: found.url,
      prdItems: [meta.item.id],
      sourcePlan: meta.item?.sourcePlan || '',
      itemType: meta.item?.itemType || '',
    };
    shared.upsertPullRequestRecord(shared.projectPrPath(found.project), entry, {
      project: found.project,
      itemId: meta.item.id,
    });
    log('info', `Auto-linked existing PR ${entry.id} on branch ${meta.branch} for ${meta.item.id}`);
    try {
      if (hasCanonicalPrAttachment(meta.item.id, config)) return null;
    } catch (err) {
      const reason = `${meta.item.id} auto-linked a PR but PR attachment verification could not read PR tracking state: ${err.message}`;
      markPrAttachmentVerificationError(meta, agentId, reason, resultSummary);
      log('warn', reason);
      return { reason, itemId: meta.item.id, severity: 'hard', stateError: true };
    }
  }

  // Distinguish "agent never claimed a PR" (hard — silent failure the contract
  // was designed to catch) from "agent claimed a PR but engine couldn't attach
  // it canonically" (soft — verification gap, not a failure).
  const severity = _outputContainsPrUrl(output) ? 'soft' : 'hard';
  const reason = severity === 'hard'
    ? `${meta.item.id} completed but no PR URL was detected in the agent's output. Expected a PR — verify the agent didn't fail silently. (Branch: ${meta.branch || '(none)'}, agent: ${agentId})`
    : `${meta.item.id} completed and a PR URL was found in the agent's output, but it couldn't be canonically attached. The work likely succeeded — verify by checking the PR list. (Branch: ${meta.branch || '(none)'}, agent: ${agentId})`;
  markMissingPrAttachment(meta, agentId, reason, resultSummary, severity);
  log(severity === 'hard' ? 'warn' : 'info', reason);
  return { reason, itemId: meta.item.id, severity };
}

// ─── Post-Completion Hooks ──────────────────────────────────────────────────

/**
 * Parse review verdict from agent output text.
 * Looks for "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" markers that the
 * review playbook instructs agents to include. This is the primary mechanism for
 * GitHub repos where formal --approve/--request-changes votes are blocked by
 * self-approval restrictions.
 * @param {string} text - Agent output / resultSummary
 * @returns {'approved'|'changes-requested'|null}
 */
function parseReviewVerdict(text) {
  if (!text) return null;
  // Match "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES" (case-insensitive, optional markdown bold)
  const verdictMatch = text.match(/VERDICT[:\s]+\*{0,2}(APPROVE|REQUEST[_\s-]?CHANGES)\*{0,2}/i);
  if (verdictMatch) {
    return normalizeReviewVerdict(verdictMatch[1]);
  }
  return null;
}

/**
 * Detect "idempotent bailout" output from a review agent — the agent saw a
 * prior review on the PR (or the same dispatchKey re-fired) and chose to bail
 * rather than spam a duplicate comment.
 *
 * Such output is intentionally short and contains no VERDICT keyword. Treating
 * it as a retryable failure burns _retryCount and eventually flips the WI to
 * status=failed even though the original review was successfully posted (#1770).
 *
 * @param {string} text - Agent output / resultSummary
 * @returns {boolean}
 */
function isReviewBailout(text) {
  if (!text || typeof text !== 'string') return false;
  return /bail(ing)?\s+out/i.test(text) || /already\s+posted/i.test(text);
}

function reviewPrRefFromCompletion(completion) {
  if (!completion || typeof completion !== 'object') return null;
  const value = String(completion.pr || completion.pull_request || completion.pullRequest || '').trim();
  if (!value || /^N\/?A$/i.test(value)) return null;
  return value;
}

function reviewPrRefMatchesDispatchTarget(reportedPr, dispatchPr, project) {
  if (!reportedPr || !dispatchPr) return true;
  const reportedUrl = typeof reportedPr === 'object' ? reportedPr.url || '' : String(reportedPr || '');
  const dispatchUrl = typeof dispatchPr === 'object' ? dispatchPr.url || '' : String(dispatchPr || '');
  const reportedId = shared.getCanonicalPrId(project, reportedPr, reportedUrl);
  const dispatchId = shared.getCanonicalPrId(project, dispatchPr, dispatchUrl);
  if (!reportedId || !dispatchId || reportedId === dispatchId) return true;

  const reportedNumber = shared.getPrNumber(reportedPr);
  const dispatchNumber = shared.getPrNumber(dispatchPr);
  if (reportedNumber == null || dispatchNumber == null || reportedNumber !== dispatchNumber) return false;

  const reportedScoped = !/^PR-\d+$/i.test(reportedId);
  const dispatchScoped = !/^PR-\d+$/i.test(dispatchId);
  return !(reportedScoped && dispatchScoped);
}

function centralPrPath() {
  return path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json');
}

function resolveReviewPrContext(pr, project, config, structuredCompletion = null) {
  const reportedPr = reviewPrRefFromCompletion(structuredCompletion);
  if (reportedPr && pr && !reviewPrRefMatchesDispatchTarget(reportedPr, pr, project)) return null;
  const refs = reportedPr ? [reportedPr] : [pr].filter(Boolean);
  if (refs.length === 0) return null;

  const projects = shared.getProjects(config);
  const projectCandidates = [];
  if (project) projectCandidates.push(project);
  for (const p of projects) {
    if (!projectCandidates.some(existing => existing?.name === p.name)) projectCandidates.push(p);
  }

  for (const candidateProject of projectCandidates) {
    const prPath = shared.projectPrPath(candidateProject);
    const prs = safeJson(prPath) || [];
    for (const ref of refs) {
      const refUrl = typeof ref === 'object' ? ref.url || '' : String(ref || '');
      if (!shared.isPrCompatibleWithProject(candidateProject, ref, refUrl)) continue;
      const target = shared.findPrRecord(prs, ref, candidateProject);
      if (target) return { pr: { ...target }, project: candidateProject, prPath };
    }
  }

  const centralPath = centralPrPath();
  const centralPrs = safeJson(centralPath) || [];
  const centralRefs = reportedPr ? [reportedPr] : refs;
  for (const ref of centralRefs) {
    const target = shared.findPrRecord(centralPrs, ref, null);
    if (target) return { pr: { ...target }, project: null, prPath: centralPath };
  }

  if (reportedPr) return null;

  return pr?.id
    ? { pr, project: project || null, prPath: project ? shared.projectPrPath(project) : centralPath }
    : null;
}

async function updatePrAfterReview(agentId, pr, project, config, resultSummary, structuredCompletion = null, dispatchItem = null) {

  if (!config) config = getConfig();
  const completionStatus = normalizeCompletionStatus(structuredCompletion?.status);
  if (completionStatus && NON_TERMINAL_COMPLETION_STATUSES.has(completionStatus)) {
    const target = pr?.id || reviewPrRefFromCompletion(structuredCompletion) || 'unknown PR';
    log('warn', `Skipping review update for ${target}: completion status is ${structuredCompletion.status}`);
    return;
  }
  const reviewContext = resolveReviewPrContext(pr, project, config, structuredCompletion);
  if (!reviewContext?.pr?.id) {
    const reportedPr = reviewPrRefFromCompletion(structuredCompletion);
    if (reportedPr) log('warn', `Review completion reported PR ${reportedPr}, but no tracked PR record was found`);
    return;
  }
  const reviewPr = reviewContext.pr;
  const reviewProject = reviewContext.project;
  const prPath = reviewContext.prPath;
  const reviewerName = config.agents?.[agentId]?.name || agentId;

  // Check actual review status from the platform (agent may have approved or requested changes)
  // If platform hasn't propagated the vote yet (returns 'pending'), keep current status unchanged.
  // The poller will pick up the real status on the next cycle (~3 min).
  let postReviewStatus = null; // null = don't change
  try {
    const projectObj = reviewProject || shared.getProjects(config)[0];
    if (projectObj) {
      const host = projectObj.repoHost || 'ado';
      const checkFn = host === 'github'
        ? require('./github').checkLiveReviewStatus
        : require('./ado').checkLiveReviewStatus;
      const liveStatus = await checkFn(reviewPr, projectObj);
      if (liveStatus && liveStatus !== 'pending') postReviewStatus = liveStatus;
    }
  } catch (e) { log('warn', `Post-review status check for ${reviewPr.id}: ${e.message}`); }

  // Fallback: if live check returned pending (e.g., GitHub self-approval blocked), use the agent's completion report.
  if (!postReviewStatus) {
    const verdict = reviewVerdictFromCompletion(structuredCompletion) || parseReviewVerdict(resultSummary);
    if (verdict) {
      postReviewStatus = verdict;
      log('info', `Read review verdict from agent completion for ${reviewPr.id}: ${verdict}`);
    }
  }

  let updatedTarget = null;
  const reviewNote = String(resultSummary || '').trim();
  shared.mutateJsonFileLocked(prPath, (prs) => {
    if (!Array.isArray(prs)) return prs;
    const target = shared.findPrRecord(prs, reviewPr, reviewProject);
    if (!target) return prs;
    // Once approved, stays approved — only changes-requested can override
    if (postReviewStatus) {
      if (target.reviewStatus === 'approved' && postReviewStatus !== 'changes-requested') {
        // Keep approved — don't downgrade
      } else {
        target.reviewStatus = postReviewStatus;
      }
    }
    target.lastReviewedAt = ts();
    target.minionsReview = {
      reviewer: reviewerName,
      reviewedAt: ts(),
      note: reviewNote,
      dispatchId: dispatchItem?.id || structuredCompletion?.dispatchId || null,
      sourceItem: dispatchItem?.meta?.item?.id || null,
      // Preserve fixedAt across re-reviews so the poller guard knows a fix was pushed.
      // Drop it when reviewer requests changes again — that starts a new fix cycle.
      ...(target.minionsReview?.fixedAt && postReviewStatus !== 'changes-requested' ? { fixedAt: target.minionsReview.fixedAt } : {}),
    };
    updatedTarget = { ...reviewPr, ...target };
    return prs;
  }, { defaultValue: [] });

  // Track reviewer for metrics purposes (separate file, separate lock)
  const authorAgentId = (reviewPr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    shared.mutateJsonFileLocked(path.join(ENGINE_DIR, 'metrics.json'), (metrics) => {
      if (!metrics[authorAgentId]) metrics[authorAgentId] = { ...DEFAULT_AGENT_METRICS };
      if (!metrics[agentId]) metrics[agentId] = { ...DEFAULT_AGENT_METRICS };
      metrics[agentId].reviewsDone = (metrics[agentId].reviewsDone || 0) + 1;
      return metrics;
    }, { defaultValue: {} });
  }

  log('info', `Updated ${reviewPr.id} → minions review: ${postReviewStatus || 'waiting'} by ${reviewerName}`);
  if (updatedTarget) {
    createReviewFeedbackForAuthor(agentId, updatedTarget, config, {
      reviewContent: reviewNote,
      project: reviewProject,
      dispatchId: dispatchItem?.id || structuredCompletion?.dispatchId || null,
      sourceItem: dispatchItem?.meta?.item?.id || null,
    });
  }
}

function getHumanFeedbackAutomationCauseKey(pr) {
  const feedback = pr?.humanFeedback;
  if (!feedback || typeof feedback !== 'object') return '';
  const commentRef = feedback.lastProcessedCommentKey
    || feedback.lastProcessedCommentId
    || feedback.commentId
    || feedback.lastProcessedCommentDate
    || feedback.feedbackContent
    || '';
  return commentRef ? `human-comment:${shared.safeSlugComponent(commentRef, 80)}` : '';
}

function shouldClearHumanFeedbackPendingFix(target, completedPr, automationCauseKey) {
  if (!target?.humanFeedback?.pendingFix) return true;
  const currentCauseKey = getHumanFeedbackAutomationCauseKey(target);
  const completedCauseKey = automationCauseKey || getHumanFeedbackAutomationCauseKey(completedPr);
  return !currentCauseKey || !completedCauseKey || currentCauseKey === completedCauseKey;
}

function fixCompletionChangedBranch(structuredCompletion) {
  if (!structuredCompletion || !Object.prototype.hasOwnProperty.call(structuredCompletion, 'files_changed')) {
    return true;
  }
  const value = structuredCompletion.files_changed;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return true;
  if (/^(?:none|no|n\/a|na|null|false|0|\[\]|-)$/.test(text)) return false;
  if (/^(?:no\s+)?(?:files?|code)\s+(?:changed?|changes?)(?:\s*\([^)]*\))?$/.test(text)) return false;
  if (/^(?:comment|comments|triage)[-\s]*only(?:\s*\([^)]*\))?$/.test(text)) return false;
  if (/^(?:no\s+)?branch\s+(?:changed?|changes?|updates?)(?:\s*\([^)]*\))?$/.test(text)) return false;
  return true;
}

function updatePrAfterFix(pr, project, source, opts = {}, dispatchId = '') {

  if (!pr?.id) return;
  const options = opts && typeof opts === 'object' && !Array.isArray(opts)
    ? opts
    : { automationCauseKey: opts, dispatchId };
  const branchChanged = options.branchChanged !== false;
  const automationCauseKey = options.automationCauseKey || '';
  const fixDispatchId = options.dispatchId || dispatchId || '';
  const prPath = project ? shared.projectPrPath(project) : path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json');
  shared.mutateJsonFileLocked(prPath, (prs) => {
    if (!Array.isArray(prs)) return prs;
    const target = shared.findPrRecord(prs, pr, project);
    if (!target) return prs;
    const triagedReview = (note) => {
      const next = { ...target.minionsReview, note, triagedAt: ts() };
      delete next.fixedAt;
      target.minionsReview = next;
    };
    if (source === 'pr-human-feedback') {
      const clearPendingFix = shouldClearHumanFeedbackPendingFix(target, pr, automationCauseKey);
      if (target.humanFeedback && clearPendingFix) target.humanFeedback.pendingFix = false;
      if (branchChanged) {
        // Never downgrade from approved — fix was dispatched but PR is already approved
        if (target.reviewStatus !== 'approved') target.reviewStatus = 'waiting';
        target.minionsReview = { ...target.minionsReview, note: 'Fixed human feedback, awaiting re-review', fixedAt: ts() };
        if (clearPendingFix) {
          log('info', `Updated ${pr.id} → cleared humanFeedback.pendingFix, reset to waiting for re-review`);
        } else {
          log('info', `Updated ${pr.id} → preserved newer humanFeedback.pendingFix, reset to waiting for re-review`);
        }
      } else {
        triagedReview('Triaged human feedback; no branch changes');
        if (clearPendingFix) {
          log('info', `Updated ${pr.id} → cleared humanFeedback.pendingFix after comment-only triage`);
        } else {
          log('info', `Updated ${pr.id} → preserved newer humanFeedback.pendingFix after comment-only triage`);
        }
      }
    } else {
      if (target.reviewStatus !== 'approved') target.reviewStatus = 'waiting';
      if (branchChanged) {
        target.minionsReview = { ...target.minionsReview, note: 'Fixed, awaiting re-review', fixedAt: ts() };
        log('info', `Updated ${pr.id} → reviewStatus: waiting (fix pushed)`);
      } else {
        triagedReview('Triaged fix feedback; no branch changes');
        log('info', `Updated ${pr.id} → reviewStatus: waiting (comment-only fix triage)`);
      }
    }
    if (automationCauseKey) {
      shared.markPrAutomationCause(target, automationCauseKey, {
        source,
        dispatchId: fixDispatchId || null,
        status: 'handled',
        handledAt: ts(),
      });
    }
    return prs;
  }, { defaultValue: [] });
}

// ─── Post-Merge Rebase ──────────────────────────────────────────────────────

/**
 * Find active PRs whose work items depend on the just-merged item.
 * Excludes shared-branch items (those use git pull instead).
 */
function findDependentActivePrs(mergedItemId, config) {
  const results = [];
  const allWi = queries.getWorkItems(config);
  const dependentWis = allWi.filter(wi =>
    wi.depends_on?.includes(mergedItemId) &&
    !DONE_STATUSES.has(wi.status) &&
    wi.branchStrategy !== 'shared-branch'
  );
  if (dependentWis.length === 0) return results;

  const projects = shared.getProjects(config);
  for (const p of projects) {
    const prs = safeJson(projectPrPath(p)) || [];
    for (const pr of prs) {
      if (!pr.branch || pr.status !== PR_STATUS.ACTIVE) continue;
      const linked = (pr.prdItems || []).some(id => dependentWis.some(wi => wi.id === id));
      if (linked && !results.some(r => r.pr.id === pr.id)) {
        const wi = dependentWis.find(w => (pr.prdItems || []).includes(w.id));
        results.push({ pr, project: p, workItem: wi });
      }
    }
  }
  return results;
}

/**
 * Rebase a PR branch onto main in a temporary worktree.
 * Returns { success: true } or { success: false, error: string }.
 */
async function rebaseBranchOntoMain(pr, project, config) {
  const root = path.resolve(project.localPath);
  const mainBranch = shared.resolveMainBranch(root, project.mainBranch);
  const branch = pr.branch;
  const wtRoot = path.resolve(root, config.engine?.worktreeRoot || ENGINE_DEFAULTS.worktreeRoot);
  const tmpWt = path.join(wtRoot, `rebase-${shared.sanitizeBranch(branch)}-${Date.now()}`).replace(/\\/g, '/');
  const _gitOpts = { cwd: root, timeout: 30000, windowsHide: true };

  try {
    await execAsync(`git fetch origin "${mainBranch}" "${branch}"`, _gitOpts);
    try {
      await execAsync(`git worktree add "${tmpWt}" "${branch}"`, { ..._gitOpts, timeout: 60000 });
    } catch (wtErr) {
      // Branch may already be checked out in a stale worktree — prune and retry once
      if (String(wtErr.message || wtErr).includes('already checked out')) {
        await execAsync(`git worktree prune`, _gitOpts);
        await execAsync(`git worktree add "${tmpWt}" "${branch}"`, { ..._gitOpts, timeout: 60000 });
      } else { throw wtErr; }
    }
  } catch (err) {
    log('warn', `Post-merge rebase: setup failed for ${branch}: ${err.message}`);
    try { await execAsync(`git worktree remove "${tmpWt}" --force`, _gitOpts); } catch {}
    return { success: false, error: err.message };
  }

  try {
    await execAsync(`git rebase "origin/${mainBranch}"`, { cwd: tmpWt, timeout: 120000, windowsHide: true });
    await execAsync(`git push --force-with-lease origin "${branch}"`, { cwd: tmpWt, timeout: 30000, windowsHide: true });
    log('info', `Post-merge rebase: rebased ${branch} onto ${mainBranch} and force-pushed`);
    return { success: true };
  } catch (err) {
    try { await execAsync(`git rebase --abort`, { cwd: tmpWt, timeout: 10000, windowsHide: true }); } catch {}
    log('warn', `Post-merge rebase failed for ${branch}: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    try { shared.removeWorktree(tmpWt, root, wtRoot); } catch {}
    try { await execAsync(`git worktree prune`, _gitOpts); } catch {}
  }
}

const PENDING_REBASES_PATH = path.join(ENGINE_DIR, 'pending-rebases.json');

function queuePendingRebase(pr, project, mergedItemId) {
  mutateJsonFileLocked(PENDING_REBASES_PATH, (pending) => {
    const prDisplayId = shared.getPrDisplayId(pr);
    if (pending.some(e => e.projectName === project.name && shared.getPrDisplayId(e.prId) === prDisplayId)) return pending; // already queued
    pending.push({ prId: pr.id, branch: pr.branch, projectName: project.name, mergedItemId, queuedAt: ts(), attempts: 0 });
    return pending;
  }, { defaultValue: [] });
}

async function processPendingRebases(config) {
  // Atomically drain the queue under lock so concurrent queuePendingRebase calls
  // during processing don't lose entries (they append to the now-empty file).
  let snapshot = [];
  mutateJsonFileLocked(PENDING_REBASES_PATH, (data) => {
    snapshot = [...data];
    return []; // drain file
  }, { defaultValue: [] });
  if (snapshot.length === 0) return;

  const remaining = [];
  for (const entry of snapshot) {
    if (isBranchActive(entry.branch)) { remaining.push(entry); continue; }

    const project = shared.getProjects(config).find(p => p.name === entry.projectName);
    if (!project) continue;

    const prs = getPrs(project);
    const pr = shared.findPrRecord(prs, entry.prId, project);
    if (pr && pr.id !== entry.prId) entry.prId = pr.id;
    if (!pr) continue; // PR closed/merged since queuing
    if (pr.status !== PR_STATUS.ACTIVE) continue; // PR closed/merged since queuing

    const result = await rebaseBranchOntoMain(pr, project, config);
    if (!result.success) {
      entry.attempts = (entry.attempts || 0) + 1;
      if (entry.attempts < ENGINE_DEFAULTS.rebaseQueueRetries) {
        remaining.push(entry);
      } else {
        log('warn', `Rebase failed after retries for ${pr.id} on ${pr.branch}: ${result.error}`);
      }
    }
  }
  // Merge remaining items back under lock — entries queued during processing are preserved
  if (remaining.length > 0) {
    mutateJsonFileLocked(PENDING_REBASES_PATH, (data) => {
      data.push(...remaining);
    }, { defaultValue: [] });
  }
}

// ─── Post-Merge / Post-Close Hooks ───────────────────────────────────────────

async function handlePostMerge(pr, project, config, newStatus) {

  const prNum = shared.getPrNumber(pr);

  if (pr.branch && project) {
    const root = path.resolve(project.localPath);
    const wtRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    // Find worktrees matching this branch; compact Windows dirs require branch metadata.
    try {
      const dirs = require('fs').readdirSync(wtRoot);
      for (const dir of dirs) {
        const wtPath = path.join(wtRoot, dir);
        const dirLower = dir.toLowerCase();
        if (worktreeMatchesBranch(dirLower, pr.branch, getWorktreeBranch(wtPath)) || dir === pr.branch || dir === `bt-${prNum}`) {
          try {
            if (!require('fs').statSync(wtPath).isDirectory()) continue;
            execSilent(`git worktree remove "${wtPath}" --force`, { cwd: root, stdio: 'pipe', timeout: 15000 });
            log('info', `Post-merge cleanup: removed worktree ${dir}`);
          } catch (err) { log('warn', `Failed to remove worktree ${dir}: ${err.message}`); }
        }
      }
    } catch (err) { log('warn', `Post-merge worktree cleanup: ${err.message}`); }
  }

  if (newStatus !== PR_STATUS.MERGED) return;

  // Resolve linked work item from pr-links or PR branch name
  const mergedItemIds = [...(getPrLinks()[pr.id] || [])];
  if (mergedItemIds.length === 0 && pr.branch) {
    const branchMatch = pr.branch.match(/(P-[a-z0-9]{6,})/i) || pr.branch.match(/(W-[a-z0-9]{6,})/i) || pr.branch.match(/(PL-[a-z0-9]{6,})/i);
    if (branchMatch) mergedItemIds.push(branchMatch[1]);
  }

  if (mergedItemIds.length > 0) {
    const mergedItemSet = new Set(mergedItemIds);
    // Mark PRD feature as implemented
    const prdDir = path.join(MINIONS_DIR, 'prd');
    try {
      const planFiles = fs.readdirSync(prdDir).filter(f => f.endsWith('.json'));
      let updated = 0;
      for (const pf of planFiles) {
        const planPath = path.join(prdDir, pf);
        mutateJsonFileLocked(planPath, (plan) => {
          if (!plan?.missing_features) return plan;
          for (const feature of plan.missing_features) {
            if (mergedItemSet.has(feature.id) && feature.status !== WI_STATUS.DONE) {
              feature.status = WI_STATUS.DONE;
              updated++;
            }
          }
          return plan;
        }, { skipWriteIfUnchanged: true });
      }
      if (updated > 0) log('info', `Post-merge: marked ${mergedItemIds.join(', ')} as done for ${pr.id}`);
    } catch (err) { log('warn', `Post-merge PRD update: ${err.message}`); }

    // Mark work item as done
    const wiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
    for (const p of shared.getProjects(config)) wiPaths.push(shared.projectWorkItemsPath(p));
    const remainingMergedIds = new Set(mergedItemIds);
    for (const wiPath of wiPaths) {
      try {
        mutateWorkItems(wiPath, items => {
          for (const item of items) {
            if (!remainingMergedIds.has(item.id)) continue;
            if (item.status !== WI_STATUS.DONE) {
              log('info', `Post-merge: marking work item ${item.id} as done (was ${item.status}) for ${pr.id}`);
              item.status = WI_STATUS.DONE;
              item.completedAt = ts();
              item._mergedVia = pr.id;
            }
            remainingMergedIds.delete(item.id);
          }
        });
        if (remainingMergedIds.size === 0) break;
      } catch (err) { log('warn', `Post-merge work item update: ${err.message}`); }
    }

    // Rebase dependent PRs onto main now that this dependency is merged
    try {
      const rebasedPrs = new Set();
      for (const mergedItemId of mergedItemIds) {
        const dependentPrs = findDependentActivePrs(mergedItemId, config);
        for (const { pr: depPr, project: depProject } of dependentPrs) {
          const rebaseKey = `${depProject.name}:${depPr.id}`;
          if (rebasedPrs.has(rebaseKey)) continue;
          rebasedPrs.add(rebaseKey);
          if (isBranchActive(depPr.branch)) {
            queuePendingRebase(depPr, depProject, mergedItemId);
            log('info', `Post-merge rebase deferred: ${depPr.branch} locked by active agent`);
            continue;
          }
          const result = await rebaseBranchOntoMain(depPr, depProject, config);
          if (!result.success) {
            log('warn', `Rebase failed for ${depPr.id} on ${depPr.branch} after dependency ${mergedItemId} merged: ${result.error}`);
          }
        }
      }
    } catch (err) { log('warn', `Post-merge rebase phase error: ${err.message}`); }
  }

  const agentId = (pr.agent || '').toLowerCase();
  if (agentId && config.agents?.[agentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    mutateJsonFileLocked(metricsPath, (metrics) => {
      if (!metrics[agentId]) metrics[agentId] = { ...DEFAULT_AGENT_METRICS };
      metrics[agentId].prsMerged = (metrics[agentId].prsMerged || 0) + 1;
      return metrics;
    });
  }

  // Teams PR lifecycle notification — non-blocking
  try {
    const teams = require('./teams');
    const prEvent = newStatus === PR_STATUS.MERGED ? 'pr-merged' : 'pr-abandoned';
    const prFilePath = project ? projectPrPath(project) : null;
    teams.teamsNotifyPrEvent(pr, prEvent, project, prFilePath).catch(() => {});
  } catch {}

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

function skillWriteTargets(runtimeName, project = null) {
  try {
    const runtime = resolveRuntime(runtimeName || 'claude');
    if (typeof runtime.getSkillWriteTargets === 'function') {
      return runtime.getSkillWriteTargets({ homeDir: os.homedir(), project });
    }
  } catch { /* fall through to Claude-compatible legacy target */ }
  return {
    personal: path.join(os.homedir(), '.claude', 'skills'),
    project: project?.localPath ? path.resolve(project.localPath, '.claude', 'skills') : null,
  };
}

function extractSkillsFromOutput(output, agentId, dispatchItem, config, runtimeName = null) {

  if (!output) return;
  const effectiveRuntime = runtimeName || dispatchItem?.meta?.runtimeName || dispatchItem?.runtimeName || 'claude';
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
  if (!fullText) fullText = output;
  const skillBlocks = [];
  const skillRegex = /```skill\s*\n([\s\S]*?)```/g;
  skillRegex.lastIndex = 0;
  let match;
  while ((match = skillRegex.exec(fullText)) !== null) {
    skillBlocks.push(match[1].trim());
  }
  if (skillBlocks.length === 0) return;
  const agentName = config.agents[agentId]?.name || agentId;
  for (const block of skillBlocks) {
    const fmMatch = block.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) { log('warn', `Skill block from ${agentName} has no frontmatter, skipping`); continue; }
    const fm = fmMatch[1];
    const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    const name = m('name');
    if (!name) { log('warn', `Skill block from ${agentName} has no name, skipping`); continue; }
    const scope = m('scope') || 'minions';
    const project = m('project');
    let enrichedBlock = block;
    if (!m('author')) enrichedBlock = enrichedBlock.replace('---\n', `---\nauthor: ${agentName}\n`);
    if (!m('created')) enrichedBlock = enrichedBlock.replace('---\n', `---\ncreated: ${dateStamp()}\n`);
    const skillDirName = name.replace(/[^a-z0-9-]/g, '-');
    if (scope === 'project' && project) {
      const proj = shared.getProjects(config).find(p => p.name === project);
      if (proj) {
        const projectSkillRoot = skillWriteTargets(effectiveRuntime, proj).project
          || path.resolve(proj.localPath, '.claude', 'skills');
        const projectSkillPath = path.join(projectSkillRoot, skillDirName, 'SKILL.md');
        const centralPath = path.join(MINIONS_DIR, 'work-items.json');
        let skillId = null;
        mutateJsonFileLocked(centralPath, data => {
          data = data || [];
          if (data.some(i => i.title === `Add skill: ${name}` && i.status !== WI_STATUS.FAILED)) return data;
          skillId = `SK${String(data.filter(i => i.id?.startsWith('SK')).length + 1).padStart(3, '0')}`;
          data.push({ id: skillId, type: 'implement', title: `Add skill: ${name}`,
            description: `Create project-level skill \`${skillDirName}/SKILL.md\` in ${project}.\n\nWrite this file to \`${projectSkillPath}\` via a PR.\n\n## Skill Content\n\n\`\`\`\n${enrichedBlock}\n\`\`\``,
            priority: 'low', status: WI_STATUS.QUEUED, created: ts(), createdBy: `engine:skill-extraction:${agentName}` });
          return data;
        }, { skipWriteIfUnchanged: true });
        if (skillId) {
          log('info', `Queued work item ${skillId} to PR project skill "${name}" into ${project}`);
        }
      }
    } else {
      const personalSkillRoot = skillWriteTargets(effectiveRuntime).personal;
      const skillDir = path.join(personalSkillRoot, name.replace(/[^a-z0-9-]/g, '-'));
      const skillPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        // Native skill format: only name + description in frontmatter. The
        // `Auto-extracted` marker is an HTML comment so the dashboard's
        // autoGenerated detection picks it up without polluting the body
        // an agent reads.
        const description = m('description') || m('trigger') || `Auto-extracted skill from ${agentName}`;
        const body = fmMatch[2] || '';
        const marker = `<!-- Auto-extracted by ${agentName} on ${dateStamp()} -->`;
        const ccContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${marker}\n\n${body.trim()}\n`;
        if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
        shared.safeWrite(skillPath, ccContent);
        try { require('./queries').invalidateSkillsCache(); } catch {}
        log('info', `Extracted skill "${name}" from ${agentName} → ${skillPath}`);
      } else {
        log('info', `Skill "${name}" already exists, skipping`);
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
  const headerEnd = history.indexOf('\n\n');
  if (headerEnd >= 0) {
    history = history.slice(0, headerEnd + 2) + entry + history.slice(headerEnd + 2);
  } else {
    history += entry;
  }
  const entries = history.split('### ').filter(Boolean);
  const header = entries[0].startsWith('#') ? entries.shift() : '# Agent History\n\n';
  const trimmed = entries.slice(0, 20);
  history = header + trimmed.map(e => '### ' + e).join('');
  shared.safeWrite(historyPath, history);
  log('info', `Updated history for ${agentId}`);
}

function reviewFeedbackSourceMatches({ fileName, content, reviewerAgentId, pr, dispatchItem, structuredCompletion }) {
  if (String(fileName || '').startsWith('feedback-')) return false;
  const text = String(content || '');
  const scopedExpected = [
    dispatchItem?.id,
    dispatchItem?.meta?.item?.id,
    structuredCompletion?.dispatchId,
    pr?.minionsReview?.dispatchId,
    pr?.minionsReview?.sourceItem,
  ].filter(Boolean).map(String);
  if (scopedExpected.length === 0) return true;

  const fileAndContent = `${fileName || ''}\n${text}`;
  if (!scopedExpected.some(value => fileAndContent.includes(value))) {
    log('warn', `Skipping review feedback source ${fileName || '(unknown)'} for ${pr?.id || 'unknown PR'}: missing current dispatch/source marker for ${reviewerAgentId}`);
    return false;
  }

  const prExpected = [
    pr?.id,
    pr?.url,
  ].filter(Boolean).map(String);
  if (prExpected.some(value => fileAndContent.includes(value))) return true;

  const prNumber = shared.getPrNumber(pr);
  if (prNumber != null) {
    const scope = shared.getPrScopeInfo(pr, pr.url || '')?.scope || shared.getProjectPrScope(dispatchItem?.meta?.project) || '';
    const numberMention = new RegExp(`(?:#|PR[-\\s])${prNumber}(?!\\d)`, 'i').test(fileAndContent);
    if (numberMention && (!scope || fileAndContent.toLowerCase().includes(scope.toLowerCase()))) return true;
  }

  log('warn', `Skipping review feedback source ${fileName || '(unknown)'} for ${pr?.id || 'unknown PR'}: not tied to dispatch/PR scope for ${reviewerAgentId}`);
  return false;
}

function createReviewFeedbackForAuthor(reviewerAgentId, pr, config, opts = {}) {

  if (!pr?.id || !pr?.agent) return;
  const authorAgentId = pr.agent.toLowerCase();
  if (!config.agents[authorAgentId]) return;
  const today = dateStamp();
  const project = opts.project || opts.dispatchItem?.meta?.project || null;
  let reviewContent = String(opts.reviewContent || '').trim();
  if (reviewContent) {
    if (!reviewContentMatchesPr(reviewContent, pr, project)) {
      log('warn', `Skipped review feedback for ${pr.id}: review content references a different PR`);
      return;
    }
  } else {
    const inboxFiles = getInboxFiles();
    const reviewFiles = inboxFiles.filter(f => f.includes(reviewerAgentId) && f.includes(today));
    if (reviewFiles.length === 0) return;
    const matchedReviewContent = [];
    for (const f of reviewFiles) {
      const content = safeRead(path.join(INBOX_DIR, f));
      if (!content) continue;
      if (!reviewFeedbackSourceMatches({
        fileName: f,
        content,
        reviewerAgentId,
        pr,
        dispatchItem: opts.dispatchItem,
        structuredCompletion: opts.structuredCompletion,
      })) continue;
      matchedReviewContent.push(content);
    }
    if (matchedReviewContent.length === 0) return;
    reviewContent = matchedReviewContent.join('\n\n');
  }
  const prSlug = shared.safeSlugComponent(pr.id, 60);
  const content = `# Review Feedback for ${config.agents[authorAgentId]?.name || authorAgentId}\n\n` +
    `**PR:** ${pr.id} — ${pr.title || ''}\n` +
    `**Reviewer:** ${config.agents[reviewerAgentId]?.name || reviewerAgentId}\n` +
    `**Date:** ${today}\n\n` +
    `## What the reviewer found\n\n${reviewContent}\n\n` +
    `## Action Required\n\nRead this feedback carefully. When you work on similar tasks in the future, ` +
    `avoid the patterns flagged here. If you are assigned to fix this PR, ` +
    `address every point raised above.\n`;
  shared.writeToInbox('feedback', `${authorAgentId}-from-${reviewerAgentId}-${prSlug}`, content, null, {
    sourcePr: pr.id,
    reviewer: reviewerAgentId,
    author: authorAgentId,
    dispatchId: opts.dispatchId || opts.dispatchItem?.id || opts.structuredCompletion?.dispatchId || null,
    sourceItem: opts.sourceItem || opts.dispatchItem?.meta?.item?.id || null,
    project: project?.name || null,
  });
  log('info', `Created review feedback for ${authorAgentId} from ${reviewerAgentId} on ${pr.id}`);
}

function updateMetrics(agentId, dispatchItem, result, taskUsage, prsCreatedCount, model) {
  if (!agentId || agentId.startsWith('temp-') || agentId === 'agent1' || agentId === 'reviewer' || agentId.startsWith('_test')) return;

  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  mutateJsonFileLocked(metricsPath, metrics => {
    metrics = metrics || {};
    if (!metrics[agentId]) {
      metrics[agentId] = { ...DEFAULT_AGENT_METRICS };
    }
    const m = metrics[agentId];
    m.lastTask = dispatchItem.task;
    m.lastCompleted = ts();
    if (model) m.model = model;
    // Track runtime (wall-clock duration from dispatch start to now — completed_at not yet set)
    const runtimeMs = dispatchItem.started_at
      ? Date.now() - new Date(dispatchItem.started_at).getTime()
      : 0;
    if (runtimeMs > 0) {
      m.totalRuntimeMs = (m.totalRuntimeMs || 0) + runtimeMs;
      m.timedTasks = (m.timedTasks || 0) + 1;
    }

    if (result === DISPATCH_RESULT.SUCCESS) {
      m.tasksCompleted++;
      if (prsCreatedCount > 0) m.prsCreated = (m.prsCreated || 0) + prsCreatedCount;
      if (dispatchItem.type === WORK_TYPE.REVIEW) m.reviewsDone++;
    } else if (result === 'retry') {
      m.tasksRetried = (m.tasksRetried || 0) + 1;
    } else {
      m.tasksErrored++;
    }
    if (taskUsage) {
      m.totalCostUsd = (m.totalCostUsd || 0) + (taskUsage.costUsd || 0);
      m.totalInputTokens = (m.totalInputTokens || 0) + (taskUsage.inputTokens || 0);
      m.totalOutputTokens = (m.totalOutputTokens || 0) + (taskUsage.outputTokens || 0);
      m.totalCacheRead = (m.totalCacheRead || 0) + (taskUsage.cacheRead || 0);
    }
    // Track agent runs in _engine for LLM performance tile (alongside CC/doc-chat)
    if (!metrics._engine) metrics._engine = {};
    if (!metrics._engine['agent-dispatch']) {
      metrics._engine['agent-dispatch'] = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0, totalDurationMs: 0 };
    }
    const eng = metrics._engine['agent-dispatch'];
    eng.calls++;
    if (runtimeMs > 0) {
      eng.totalDurationMs = (eng.totalDurationMs || 0) + runtimeMs;
      eng.timedCalls = (eng.timedCalls || 0) + 1;
    }
    if (taskUsage) {
      eng.costUsd += taskUsage.costUsd || 0;
      eng.inputTokens += taskUsage.inputTokens || 0;
      eng.outputTokens += taskUsage.outputTokens || 0;
      eng.cacheRead += taskUsage.cacheRead || 0;
      eng.cacheCreation = (eng.cacheCreation || 0) + (taskUsage.cacheCreation || 0);
    }

    const today = dateStamp();
    if (!metrics._daily) metrics._daily = {};
    if (!metrics._daily[today]) metrics._daily[today] = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, tasks: 0, runtimeMs: 0 };
    const daily = metrics._daily[today];
    daily.tasks++;
    if (runtimeMs > 0) daily.runtimeMs = (daily.runtimeMs || 0) + runtimeMs;
    if (taskUsage) {
      daily.costUsd += taskUsage.costUsd || 0;
      daily.inputTokens += taskUsage.inputTokens || 0;
      daily.outputTokens += taskUsage.outputTokens || 0;
      daily.cacheRead += taskUsage.cacheRead || 0;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const day of Object.keys(metrics._daily)) {
      if (day < cutoffStr) delete metrics._daily[day];
    }
    return metrics;
  });
}

// ─── Agent Output Parsing ────────────────────────────────────────────────────

function parseAgentOutput(stdout, runtimeName) {
  const { text, usage, sessionId, model } = shared.parseStreamJsonOutput(stdout, runtimeName, { maxTextLength: 2000 });
  return { resultSummary: text, taskUsage: usage, sessionId, model };
}

/**
 * Parse structured completion block from agent output.
 * Agents produce a ```completion fenced block with key: value pairs.
 * Returns parsed object or null if not found / malformed.
 * If multiple blocks exist, the last one wins (agent may retry).
 */
function parseStructuredCompletion(stdout, runtimeName) {
  if (!stdout || typeof stdout !== 'string') return null;

  // Extract text from stream-json output if needed
  const text = extractCompletionText(stdout, runtimeName);

  // Find all ```completion blocks, take the last one
  const blockPattern = /```completion\s*\n([\s\S]*?)```/g;
  let lastMatch = null;
  let m;
  while ((m = blockPattern.exec(text)) !== null) {
    lastMatch = m[1];
  }
  if (!lastMatch) {
    const taskCompleteSummary = extractTaskCompleteSummary(stdout);
    return taskCompleteSummary ? parseCompletionKeyValues(taskCompleteSummary) : null;
  }

  return parseCompletionKeyValues(lastMatch);
}

function extractCompletionText(stdout, runtimeName) {
  let text = stdout;
  if (typeof stdout === 'string' && stdout.includes('"type":')) {
    try {
      const parsed = shared.parseStreamJsonOutput(stdout, runtimeName);
      if (parsed.text) text = parsed.text;
    } catch {}
  }
  return text;
}

function hasCompletionFence(stdout, runtimeName) {
  const text = extractCompletionText(stdout, runtimeName);
  return /```completion\s*\n[\s\S]*?```/.test(text);
}

function extractTaskCompleteSummary(stdout) {
  if (!stdout || typeof stdout !== 'string') return '';
  let summary = '';
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.type === 'session.task_complete') {
      const value = obj.data?.summary;
      if (typeof value === 'string' && value.trim()) summary = value;
      continue;
    }
    if (obj.type === 'tool.execution_start' && obj.data?.toolName === 'task_complete') {
      const value = obj.data?.arguments?.summary;
      if (typeof value === 'string' && value.trim()) summary = value;
      continue;
    }
    if (obj.type === 'assistant.message' && Array.isArray(obj.data?.toolRequests)) {
      for (const tr of obj.data.toolRequests) {
        if (tr?.name !== 'task_complete') continue;
        const value = tr.arguments?.summary || tr.intentionSummary;
        if (typeof value === 'string' && value.trim()) summary = value;
      }
    }
  }
  return summary;
}

function hasActionableFailureClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return !['n/a', 'na', 'none', 'null', 'no', 'false', 'not-applicable'].includes(normalized);
}

function parseCompletionKeyValues(text) {
  if (!text || typeof text !== 'string') return null;
  const result = {};
  const allowedFields = new Set(shared.COMPLETION_FIELDS || []);
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const normalizedLine = line.trim().replace(/^[-*]\s+/, '');
    const colonIdx = normalizedLine.indexOf(':');
    if (colonIdx < 1) continue;
    const key = normalizedLine.slice(0, colonIdx).trim().toLowerCase();
    if (allowedFields.size > 0 && !allowedFields.has(key)) continue;
    const value = normalizedLine.slice(colonIdx + 1).trim();
    if (key && value) result[key] = value;
  }

  // Must have at least status, or an actionable failure_class that implies failure.
  if (!result.status && hasActionableFailureClass(result.failure_class)) result.status = 'failed';
  if (!result.status) return null;
  return result;
}

function parseCompletionFieldSummary(text) {
  if (!text || typeof text !== 'string') return null;

  const allowedFields = new Set(shared.COMPLETION_FIELDS || []);
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!allowedFields.has(key)) continue;
    const value = line.slice(colonIdx + 1).trim().replace(/^["'`]+|["'`]+$/g, '');
    if (value) result[key] = value;
  }

  if (!result.status) return null;
  const fieldCount = Object.keys(result).length;
  const status = normalizeCompletionStatus(result.status);
  const explicitlyFailed = status.startsWith('fail') || status === 'error';
  if (fieldCount < 2 && !explicitlyFailed) return null;
  return result;
}

function parseCompletionReportFile(dispatchItem, opts = {}) {
  const reportPath = dispatchItem?.meta?.completionReportPath || shared.dispatchCompletionReportPath(dispatchItem?.id);
  if (!reportPath || !fs.existsSync(reportPath)) {
    if (opts.warnIfMissing && dispatchItem?.id) {
      log('warn', `Completion report missing for ${dispatchItem.id}: ${reportPath || '(no path)'}`);
    }
    return null;
  }
  const report = safeJson(reportPath);
  if (!shared.isPlainObject(report)) {
    log('warn', `Ignoring malformed completion report for ${dispatchItem?.id || 'unknown'}: ${reportPath}`);
    return null;
  }
  if (!report.status && report.outcome) report.status = report.outcome;
  if (!report.status) {
    log('warn', `Ignoring completion report without status for ${dispatchItem?.id || 'unknown'}: ${reportPath}`);
    return null;
  }
  report._source = 'report-file';
  report._path = reportPath;
  return report;
}

function persistCompletionReport(dispatchItem, completion, source = 'fallback') {
  if (!dispatchItem?.id || !completion || typeof completion !== 'object') return completion;
  const reportPath = dispatchItem?.meta?.completionReportPath || shared.dispatchCompletionReportPath(dispatchItem.id);
  if (!reportPath) return completion;
  const report = {
    ...completion,
    status: completion.status || completion.outcome || 'unknown',
    _source: source,
    _path: reportPath,
    dispatchId: dispatchItem.id,
    agent: dispatchItem.agent || null,
    type: dispatchItem.type || null,
    completedAt: ts(),
  };
  try {
    safeWrite(reportPath, report);
    log('info', `Persisted ${source} completion report for ${dispatchItem.id}: ${reportPath}`);
  } catch (err) {
    log('warn', `Persist fallback completion report for ${dispatchItem.id}: ${err.message}`);
  }
  return report;
}

function normalizeCompletionStatus(status) {
  return String(status || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// Trust the agent's explicit structured `status` field as the only signal that
// a completion is non-terminal. Earlier versions also scanned the agent's
// resultSummary prose with regex (looking for "pending", "in progress",
// "partial", "wake up", etc.), but that produced false positives on benign
// phrases like "I checked the pending PRs" or "build is in progress on CI"
// and burned 3-9 minutes of agent time per false-positive retry.
//
// Both structured signals (the JSON completion report at MINIONS_COMPLETION_REPORT
// and the fenced ```completion block in stdout) carry a `status` field. A plain
// task_complete summary made only of completion fields is accepted as a narrow
// compatibility fallback. If the agent explicitly says they're not done, honor
// it; otherwise accept the dispatch. The PR attachment contract still catches
// silent-failure cases for PR-producing work.
const NON_TERMINAL_COMPLETION_STATUSES = new Set([
  'partial', 'partially-complete', 'in-progress', 'pending', 'deferred',
  'blocked', 'incomplete', 'to-be-continued',
  'failed', 'failure', 'error',
]);

function detectNonTerminalResultSummary(_resultSummary, structuredCompletion, completionReport) {
  const candidates = [completionReport?.status, structuredCompletion?.status];
  for (const status of candidates) {
    const norm = normalizeCompletionStatus(status);
    if (!norm) continue;
    if (NON_TERMINAL_COMPLETION_STATUSES.has(norm)) {
      const isFailure = norm === 'failed' || norm === 'failure' || norm === 'error';
      return {
        phrase: `status:${status}`,
        reason: isFailure
          ? `Nonterminal completion summary: structured status is '${status}', not a successful terminal state`
          : `Nonterminal completion summary: structured status is '${status}'`,
      };
    }
  }
  return null;
}

function deferNonTerminalCompletion(meta, detection) {
  const itemId = meta?.item?.id;
  const reason = detection?.reason || 'Nonterminal completion summary';
  if (!itemId) return reason;
  const wiPath = resolveWorkItemPath(meta);
  if (!wiPath) return reason;

  let finalStatus = WI_STATUS.PENDING;
  try {
    mutateJsonFileLocked(wiPath, data => {
      if (!Array.isArray(data)) return data;
      const w = data.find(i => i.id === itemId);
      if (!w) return data;
      const retries = w._retryCount || 0;
      if (retries < ENGINE_DEFAULTS.maxRetries) {
        w.status = WI_STATUS.PENDING;
        w._retryCount = retries + 1;
        w._lastRetryAt = ts();
        w._lastRetryReason = reason;
        w._pendingReason = 'nonterminal_completion';
        delete w.completedAt;
        delete w.dispatched_at;
        delete w.dispatched_to;
        delete w.failedAt;
        finalStatus = WI_STATUS.PENDING;
        log('warn', `Work item ${itemId} reported nonterminal success — retry ${retries + 1}/${ENGINE_DEFAULTS.maxRetries}: ${reason}`);
      } else {
        w.status = WI_STATUS.FAILED;
        w.failReason = `${reason} after ${ENGINE_DEFAULTS.maxRetries} attempts`;
        w.failedAt = ts();
        delete w.completedAt;
        delete w.dispatched_at;
        delete w.dispatched_to;
        delete w._pendingReason;
        finalStatus = WI_STATUS.FAILED;
        log('warn', `Work item ${itemId} failed — repeated nonterminal completion summaries after ${ENGINE_DEFAULTS.maxRetries} attempts`);
      }
      return data;
    }, { defaultValue: [], skipWriteIfUnchanged: true });
    syncPrdItemStatus(itemId, finalStatus, meta.item?.sourcePlan);
  } catch (err) {
    log('warn', `nonterminal completion gate: ${err.message}`);
  }
  return reason;
}

function parseCompletionBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return true;
    if (['false', 'no', '0'].includes(normalized)) return false;
  }
  return undefined;
}

function normalizeReviewVerdict(verdict) {
  const value = String(verdict || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === 'approve' || value === 'approved') return 'approved';
  if (value === 'request_changes' || value === 'changes_requested' || value === 'changes-requested') return 'changes-requested';
  return null;
}

function reviewVerdictFromCompletion(completion) {
  if (!completion || typeof completion !== 'object') return null;
  return normalizeReviewVerdict(completion.verdict || completion.review_verdict || completion.reviewVerdict);
}

function reviewContentMatchesPr(content, pr, project) {
  const text = String(content || '').trim();
  if (!text) return false;
  const targetId = shared.getCanonicalPrId(project, pr, pr?.url || '');
  const targetNumber = shared.getPrNumber(pr);
  if (!targetId) return true;

  const explicitRefs = new Set();
  for (const match of text.matchAll(/\b(?:github|ado):[A-Za-z0-9._~/-]+#\d+\b/g)) {
    explicitRefs.add(shared.getCanonicalPrId(project, match[0]));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)>"]+(?:\/pull\/|\/pullrequest\/)\d+[^\s)>"]*/gi)) {
    const url = match[0].replace(/[.,;:]+$/g, '');
    explicitRefs.add(shared.getCanonicalPrId(project, url, url));
  }
  if (explicitRefs.size > 0) return explicitRefs.size === 1 && explicitRefs.has(targetId);

  const mentionedNumbers = new Set();
  for (const match of text.matchAll(/\bPR\s*(?:#|-)\s*(\d+)\b/gi)) {
    mentionedNumbers.add(parseInt(match[1], 10));
  }
  if (mentionedNumbers.size > 0 && targetNumber != null) {
    return mentionedNumbers.size === 1 && mentionedNumbers.has(targetNumber);
  }
  return true;
}

function writeNonCleanAgentReport(dispatchItem, agentId, outcome, structuredCompletion, resultSummary, exitCode) {
  if (!dispatchItem?.id || !outcome) {
    log('warn', 'Cannot write non-clean agent report without dispatch id and outcome');
    return;
  }
  const itemId = dispatchItem.meta?.item?.id || '';
  const title = dispatchItem.meta?.item?.title || dispatchItem.task || dispatchItem.id;
  const metadata = {
    dispatchId: dispatchItem.id,
    sourceItem: itemId || null,
    result: outcome,
    completionStatus: structuredCompletion?.status || null,
  };
  const structuredLines = structuredCompletion
    ? Object.entries(structuredCompletion).map(([key, value]) => `- ${key}: ${value}`).join('\n')
    : '- none';
  const content = [
    `# Agent ${outcome === 'partial' ? 'Partially Completed' : 'Reported Failure'}: ${title}`,
    '',
    `**Agent:** ${agentId}`,
    `**Dispatch:** \`${dispatchItem.id}\``,
    itemId ? `**Work Item:** \`${itemId}\`` : '',
    `**Type:** ${dispatchItem.type || 'unknown'}`,
    `**Exit Code:** ${exitCode}`,
    `**Outcome:** ${outcome}`,
    '',
    `## Structured Completion`,
    structuredLines,
    '',
    resultSummary ? `## Summary\n${resultSummary}` : '## Summary\n(no agent summary captured)',
  ].filter(Boolean).join('\n');
  shared.writeToInbox(agentId || 'engine', `agent-${outcome}-${dispatchItem.id}`, content, null, metadata);
}

/**
 * Handle decomposition result — parse sub-items from agent output and create child work items.
 * Called from runPostCompletionHooks when type === 'decompose'.
 */
function handleDecompositionResult(stdout, meta, config, runtimeName) {

  const parentId = meta?.item?.id;
  if (!parentId) return 0;

  // Parse sub-items JSON from agent output
  const { text } = shared.parseStreamJsonOutput(stdout, runtimeName);
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) {
    log('warn', `Decomposition for ${parentId}: no JSON block found in output`);
    return 0;
  }

  let decomposition;
  try {
    decomposition = JSON.parse(jsonMatch[1]);
  } catch (err) {
    log('warn', `Decomposition for ${parentId}: invalid JSON — ${err.message}`);
    return 0;
  }

  const subItems = decomposition.sub_items || decomposition.subItems || [];
  if (subItems.length === 0) {
    log('warn', `Decomposition for ${parentId}: no sub-items produced`);
    return 0;
  }

  // Find and update the parent work item
  const projects = shared.getProjects(config);
  const allPaths = [path.join(MINIONS_DIR, 'work-items.json')];
  for (const p of projects) allPaths.push(shared.projectWorkItemsPath(p));

  for (const wiPath of allPaths) {
    let found = false;
    mutateJsonFileLocked(wiPath, data => {
      if (!Array.isArray(data)) return data;
      const p = data.find(i => i.id === parentId);
      if (!p) return data;
      found = true;

      // Mark parent as decomposed
      p.status = WI_STATUS.DECOMPOSED;
      p._decomposed = true;
      delete p._decomposing;
      // Sync to PRD so dashboard shows decomposed status
      if (p.sourcePlan) syncPrdItemStatus(p.id, WI_STATUS.DECOMPOSED, p.sourcePlan);
      p._subItemIds = subItems.map(s => s.id);

      // Create child work items
      for (const sub of subItems) {
        if (data.some(i => i.id === sub.id)) continue; // dedupe
        const childItem = {
          id: sub.id,
          title: sub.name || sub.title || `Sub-task of ${parentId}`,
          type: (sub.estimated_complexity === 'large') ? 'implement:large' : 'implement',
          priority: sub.priority || p.priority || 'medium',
          description: sub.description || '',
          status: WI_STATUS.PENDING,
          complexity: sub.estimated_complexity || 'medium',
          depends_on: sub.depends_on || [],
          parent_id: parentId,
          sourcePlan: p.sourcePlan,
          branchStrategy: p.branchStrategy,
          featureBranch: p.featureBranch,
          created: ts(),
          createdBy: 'decomposition',
        };
        // Persist structured fields from decompose output (additive — safe if absent)
        if (Array.isArray(sub.acceptance_criteria) && sub.acceptance_criteria.length > 0) {
          childItem.acceptance_criteria = sub.acceptance_criteria;
        }
        if (Array.isArray(sub.scope_boundaries) && sub.scope_boundaries.length > 0) {
          childItem.scope_boundaries = sub.scope_boundaries;
        }
        data.push(childItem);
      }
      return data;
    }, { skipWriteIfUnchanged: true });
    if (!found) continue;
    log('info', `Decomposition: ${parentId} → ${subItems.length} sub-items: ${subItems.map(s => s.id).join(', ')}`);
    return subItems.length;
  }

  return 0;
}

async function runPostCompletionHooks(dispatchItem, agentId, code, stdout, config) {

  const type = dispatchItem.type;
  const meta = dispatchItem.meta;
  const isSuccess = code === 0;
  const result = isSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;
  // Runtime name comes from the dispatch entry (set when the agent was spawned).
  // Defaults to 'claude' when missing — preserves behavior for existing dispatches
  // and for the foundation-only state of this plan item; downstream items
  // (P-2a6d9c4f, P-9c4f2d6a) populate dispatchItem.meta.runtimeName at spawn time.
  const runtimeName = dispatchItem.meta?.runtimeName || dispatchItem.runtimeName || 'claude';
  let { resultSummary, taskUsage, sessionId, model } = parseAgentOutput(stdout, runtimeName);

  // Prefer the sidecar completion report; keep fenced output as a compatibility fallback.
  const reportCompletion = parseCompletionReportFile(dispatchItem, { warnIfMissing: true });
  const fencedCompletion = reportCompletion ? null : parseStructuredCompletion(stdout, runtimeName);
  const summaryCompletion = reportCompletion || fencedCompletion ? null : parseCompletionFieldSummary(resultSummary);
  const fallbackCompletion = fencedCompletion || summaryCompletion;
  const fallbackSource = fencedCompletion && hasCompletionFence(stdout, runtimeName) ? 'fenced-completion' : 'summary-completion';
  const structuredCompletion = reportCompletion || persistCompletionReport(dispatchItem, fallbackCompletion, fallbackSource);
  if (structuredCompletion) {
    if (structuredCompletion.summary) resultSummary = String(structuredCompletion.summary);
    log('info', `Structured completion from ${agentId}: status=${structuredCompletion.status}, pr=${structuredCompletion.pr || 'N/A'}${structuredCompletion._source ? ` (${structuredCompletion._source})` : ''}`);
  }
  const completionGateSummary = resultSummary || (typeof stdout === 'string' && !stdout.includes('"type":') ? stdout : '');

  // Save session for potential resume on next dispatch
  if (isSuccess && sessionId && agentId && !agentId.startsWith('temp-')) {
    try {
      const runtime = resolveRuntime(runtimeName);
      if (runtime && typeof runtime.saveSession === 'function') {
        runtime.saveSession({
          agentId,
          dispatchId: dispatchItem.id,
          branch: dispatchItem.meta?.branch || null,
          sessionId,
          agentsDir: AGENTS_DIR,
          logger: { warn: (msg) => log('warn', msg) },
        });
      }
    } catch (err) { log('warn', `Session save: ${err.message}`); }
  }

  // Always attempt PR sync — even failed/timed-out agents may have created PRs before dying
  let prsCreatedCount = 0;
  try {
    prsCreatedCount = syncPrsFromOutput(stdout, agentId, meta, config, { structuredCompletion }) || 0;
  } catch (err) { log('warn', `PR sync from output: ${err.message}`); }

  // Structured completion may report PR even when regex didn't find it
  const scHasPr = structuredCompletion && structuredCompletion.pr && structuredCompletion.pr !== 'N/A';
  if (scHasPr && prsCreatedCount === 0) {
    log('info', `Structured completion reports PR (${structuredCompletion.pr}) but regex sync found none — PR may already be tracked`);
  }

  const completionStatus = normalizeCompletionStatus(structuredCompletion?.status);
  const agentNeedsRerun = parseCompletionBoolean(structuredCompletion?.needs_rerun ?? structuredCompletion?.needsRerun) === true;
  const agentReportedFailure = completionStatus.startsWith('fail')
    || completionStatus === 'error'
    || hasActionableFailureClass(structuredCompletion?.failure_class)
    || agentNeedsRerun;
  const agentRetryable = parseCompletionBoolean(structuredCompletion?.retryable);

  // Auto-recover: if a failed implement/fix/test agent created PRs, it likely succeeded before the failure surfaced.
  const prCreatingType = type === WORK_TYPE.IMPLEMENT || type === WORK_TYPE.IMPLEMENT_LARGE || type === WORK_TYPE.FIX || type === WORK_TYPE.TEST;
  const autoRecovered = !agentReportedFailure && !isSuccess && prsCreatedCount > 0 && prCreatingType && !!meta?.item?.id;
  if (autoRecovered) {
    log('info', `Auto-recovery: agent failed but created ${prsCreatedCount} PR(s) — upgrading ${meta.item.id} to done`);
  }
  const effectiveSuccess = (isSuccess && !agentReportedFailure) || autoRecovered;

  let nonCleanReportWritten = false;
  if (completionStatus.startsWith('partial') || autoRecovered || (agentReportedFailure && isSuccess)) {
    const outcome = agentReportedFailure ? 'failure' : 'partial';
    writeNonCleanAgentReport(dispatchItem, agentId, outcome, structuredCompletion, completionGateSummary, code);
    nonCleanReportWritten = true;
  }

  // Handle decomposition results — create sub-items from decompose agent output
  let skipDoneStatus = false;
  if (type === WORK_TYPE.DECOMPOSE && effectiveSuccess && meta?.item?.id) {
    const subCount = handleDecompositionResult(stdout, meta, config, runtimeName);
    if (subCount > 0) skipDoneStatus = true; // parent already marked 'decomposed' by handler
    // If decomposition produced nothing, fall through to mark parent as done
  }

  // Verify review work items include a verdict — must run BEFORE updateWorkItemStatus(DONE),
  // same pattern as plan-to-prd (#893): updateWorkItemStatus deletes _retryCount, so the check
  // must read/increment it before that happens. Also sets skipDoneStatus so completedAt isn't
  // written and then left dangling when status is reset to pending for retry.
  //
  // (#1770) Idempotent bailout: if the agent explicitly bailed because a review was
  // already posted (e.g. the WI got re-dispatched before lifecycle marked the first
  // run done), treat the run as success — fall through to mark DONE without retry.
  // Without this, the second run produces no VERDICT, _retryCount increments,
  // and after 3 such bailouts the WI flips to status=failed even though the
  // original review was posted on the first run.
  if (effectiveSuccess && type === WORK_TYPE.REVIEW && meta?.item?.id) {
    const verdict = reviewVerdictFromCompletion(structuredCompletion) || parseReviewVerdict(resultSummary);
    if (!verdict && isReviewBailout(resultSummary)) {
      log('info', `Review ${meta.item.id} bailed out (review already posted) — treating as DONE without retry`);
    } else if (!verdict) {
      skipDoneStatus = true;
      const wiPath = resolveWorkItemPath(meta);
      if (wiPath) {
        try {
          mutateJsonFileLocked(wiPath, data => {
            if (!Array.isArray(data)) return data;
            const w = data.find(i => i.id === meta.item.id);
            if (!w) return data;
            const retries = w._retryCount || 0;
            if (retries < ENGINE_DEFAULTS.maxRetries) {
              w.status = WI_STATUS.PENDING;
              w._retryCount = retries + 1;
              w._lastRetryAt = ts();
              w._lastRetryReason = 'no review verdict';
              delete w.dispatched_at;
              delete w.completedAt;
              delete w._pendingReason;
              log('warn', `Review ${meta.item.id} completed without verdict — auto-retry ${retries + 1}/${ENGINE_DEFAULTS.maxRetries}`);
            } else {
              w.status = WI_STATUS.FAILED;
              w.failReason = 'No review verdict after ' + ENGINE_DEFAULTS.maxRetries + ' attempts';
              w.failedAt = ts();
              log('warn', `Review ${meta.item.id} failed — no verdict after ${ENGINE_DEFAULTS.maxRetries} retries`);
            }
            return data;
          }, { skipWriteIfUnchanged: true });
        } catch (err) { log('warn', `review verdict check: ${err.message}`); }
      }
    }
  }

  // Verify plan-to-prd actually created the PRD file before marking done (#893)
  // Must run BEFORE updateWorkItemStatus(DONE) — otherwise _retryCount is deleted and retries never advance
  if (effectiveSuccess && type === WORK_TYPE.PLAN_TO_PRD && meta?.item?.id) {
    let prdFound = false;
    const expectedFile = meta.item._prdFilename;
    if (expectedFile) {
      prdFound = fs.existsSync(path.join(PRD_DIR, expectedFile));
    }
    if (!prdFound && meta.item.planFile) {
      try {
        for (const f of fs.readdirSync(PRD_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const prd = safeJson(path.join(PRD_DIR, f));
            if (prd && prd.source_plan === meta.item.planFile) { prdFound = true; break; }
          } catch {}
        }
      } catch {}
    }
    if (!prdFound) {
      skipDoneStatus = true;
      const wiPath = resolveWorkItemPath(meta);
      if (wiPath) {
        try {
          mutateJsonFileLocked(wiPath, data => {
            if (!Array.isArray(data)) return data;
            const w = data.find(i => i.id === meta.item.id);
            if (!w) return data;
            const retries = w._retryCount || 0;
            if (retries < ENGINE_DEFAULTS.maxRetries) {
              w.status = WI_STATUS.PENDING;
              w._retryCount = retries + 1;
              delete w.dispatched_at;
              delete w.completedAt;
              log('warn', `plan-to-prd ${meta.item.id} completed without PRD file — auto-retry ${retries + 1}/${ENGINE_DEFAULTS.maxRetries}`);
            } else {
              w.status = WI_STATUS.FAILED;
              w.failReason = 'PRD file not written after ' + ENGINE_DEFAULTS.maxRetries + ' attempts';
              w.failedAt = ts();
              log('warn', `plan-to-prd ${meta.item.id} failed — no PRD file after ${ENGINE_DEFAULTS.maxRetries} retries`);
            }
            return data;
          }, { skipWriteIfUnchanged: true });
        } catch (err) { log('warn', `plan-to-prd PRD check: ${err.message}`); }
      }
    }
  }

  let completionContractFailure = null;
  if (effectiveSuccess && meta?.item?.id && !skipDoneStatus) {
    const nonTerminalCompletion = detectNonTerminalResultSummary(completionGateSummary, structuredCompletion, reportCompletion);
    if (nonTerminalCompletion) {
      skipDoneStatus = true;
      const reason = deferNonTerminalCompletion(meta, nonTerminalCompletion);
      completionContractFailure = { reason, itemId: meta.item.id, nonTerminal: true, processWorkItemFailure: false };
      if (!nonCleanReportWritten) {
        writeNonCleanAgentReport(dispatchItem, agentId, 'partial', structuredCompletion, completionGateSummary, code);
      }
    }
  }

  if (effectiveSuccess && meta?.item?.id && !skipDoneStatus) {
    completionContractFailure = await enforcePrAttachmentContract(type, meta, agentId, config, resultSummary, stdout);
    if (completionContractFailure?.severity === 'hard' || completionContractFailure?.nonTerminal) {
      skipDoneStatus = true;
    }
  }

  if (effectiveSuccess && meta?.item?.id && !skipDoneStatus) {
    meta._agentId = agentId;
    updateWorkItemStatus(meta, WI_STATUS.DONE, '');
  }
  // Failure retry is handled by completeDispatch in dispatch.js — not duplicated here.
  // Only clear _decomposing flag on failure so decompose items don't get permanently stuck.
  if (!effectiveSuccess && meta?.item?.id && type === WORK_TYPE.DECOMPOSE) {
    const wiPath = resolveWorkItemPath(meta);
    if (wiPath) {
      try {
        mutateJsonFileLocked(wiPath, data => {
          if (!Array.isArray(data)) return data;
          const wi = data.find(i => i.id === meta.item.id);
          if (wi) delete wi._decomposing;
          return data;
        }, { skipWriteIfUnchanged: true });
      } catch (err) { log('warn', `Decompose cleanup: ${err.message}`); }
    }
  }
  // Meeting post-completion: collect findings/debate/conclusion
  if (type === WORK_TYPE.MEETING && meta?.meetingId) {
    try {
      const { collectMeetingFindings } = require('./meeting');
      collectMeetingFindings(meta.meetingId, agentId, meta.roundName, stdout, structuredCompletion, meta.round, {
        success: effectiveSuccess,
        result,
        code,
        completionStatus,
        agentReportedFailure,
        summary: resultSummary,
      });
    } catch (err) { log('warn', `Meeting collect: ${err.message}`); }
  }

  // Plan chaining removed — user must explicitly execute plan-to-prd after reviewing the plan
  if (effectiveSuccess && meta?.item?.sourcePlan) checkPlanCompletion(meta, config);

  // Archive is manual — user archives plans from the dashboard when ready

  // Scheduled task back-reference: update schedule-runs.json and write linked inbox note
  if (meta?.item?._scheduleId) {
    try {
      const scheduleId = meta.item._scheduleId;
      const itemId = meta.item.id;
      const schedRunsPath = path.join(ENGINE_DIR, 'schedule-runs.json');
      mutateJsonFileLocked(schedRunsPath, (runs) => {
        runs[scheduleId] = {
          lastRun: typeof runs[scheduleId] === 'string' ? runs[scheduleId] : (runs[scheduleId]?.lastRun || ts()),
          lastWorkItemId: itemId,
          lastResult: effectiveSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR,
          lastCompletedAt: ts(),
        };
        return runs;
      }, { defaultValue: {} });
      const status = effectiveSuccess ? 'succeeded' : 'failed';
      if (effectiveSuccess) {
        // Write a completion note to inbox with back-references only for successful scheduled runs.
        const noteSlug = `sched-completion-${scheduleId}`;
        const noteContent = `# Scheduled Task ${status}: ${meta.item.title || scheduleId}\n\n` +
          `**Schedule:** \`${scheduleId}\`\n` +
          `**Work Item:** \`${itemId}\`\n` +
          `**Result:** ${status}\n` +
          (resultSummary ? `\n## Summary\n${resultSummary}\n` : '');
        shared.writeToInbox('engine', noteSlug, noteContent, null, {
          sourceItem: itemId,
          scheduleId,
        });
        log('info', `Scheduled task ${scheduleId} (${itemId}) → ${status}, back-reference written`);
      } else {
        log('warn', `Scheduled task ${scheduleId} (${itemId}) → ${status}; inbox note suppressed`);
      }
    } catch (err) { log('warn', `Scheduled task back-reference: ${err.message}`); }
  }

  // Clean up worktree for non-shared-branch tasks after completion
  if (meta?.branch && meta?.branchStrategy !== 'shared-branch') {
    try {
      const project = meta.project || {};
      const rootDir = project.localPath ? path.resolve(project.localPath) : null;
      if (rootDir) {
        const engineConfig = (config.engine || {});
        const worktreeRoot = path.resolve(rootDir, engineConfig.worktreeRoot || '../worktrees');
        // Find the worktree directory for this dispatch's branch
        const branchSlug = shared.sanitizeBranch ? shared.sanitizeBranch(meta.branch) : meta.branch.replace(/[^a-zA-Z0-9._\-\/]/g, '-');
        const dirs = fs.readdirSync(worktreeRoot).filter(d => {
          const wtPath = path.join(worktreeRoot, d);
          return fs.statSync(wtPath).isDirectory()
            && worktreeMatchesBranch(d.toLowerCase(), meta.branch, getWorktreeBranch(wtPath));
        });
        // Only remove if no other active dispatch uses this branch
        const dispatch = getDispatch();
        const otherActive = ((dispatch.active || []).concat(dispatch.pending || [])).some(d =>
          d.id !== dispatchItem.id && d.meta?.branch && shared.sanitizeBranch && shared.sanitizeBranch(d.meta.branch) === branchSlug
        );
        if (!otherActive) {
          for (const dir of dirs) {
            const wtPath = path.join(worktreeRoot, dir);
            if (shared.removeWorktree(wtPath, rootDir, worktreeRoot)) {
              log('info', `Post-completion: removed worktree ${dir}`);
            }
          }
        }
      }
    } catch (err) {
      log('warn', `Post-completion worktree cleanup error: ${err.message}`);
    }
  }

  // Old plan-to-prd PRD check removed — moved before updateWorkItemStatus(DONE) to fix #893
  // (retryCount was being deleted by done-marking before the check could read it)
  // Review verdict check similarly moved before updateWorkItemStatus(DONE) — same root cause.

  const hardContractFail = completionContractFailure?.severity === 'hard'
    || completionContractFailure?.nonTerminal === true;
  const finalResult = hardContractFail ? DISPATCH_RESULT.ERROR : (effectiveSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR);
  if (type === WORK_TYPE.REVIEW && finalResult === DISPATCH_RESULT.SUCCESS && !skipDoneStatus) {
    await updatePrAfterReview(agentId, meta?.pr, meta?.project, config, resultSummary, structuredCompletion, dispatchItem);
  } else if (type === WORK_TYPE.REVIEW) {
    log('warn', `Skipping PR review metadata update for ${meta?.pr?.id || meta?.pr?.url || '(unknown PR)'} because review dispatch ${dispatchItem.id} did not complete cleanly`);
  }
  if (type === WORK_TYPE.FIX && effectiveSuccess) {
    updatePrAfterFix(meta?.pr, meta?.project, meta?.source, {
      branchChanged: fixCompletionChangedBranch(structuredCompletion),
      automationCauseKey: meta?.automationCauseKey,
      dispatchId: dispatchItem?.id,
    });
    // (#984) Sync PRD status for PR-linked features: fix work items have a different ID
    // than the original PRD feature, so syncPrdItemStatus(fixWiId, ...) finds nothing.
    // Use the PR's prdItems to propagate done status when the original work item is done.
    if (effectiveSuccess && meta?.pr?.prdItems?.length) {
      try {
        const allWis = queries.getWorkItems(config);
        for (const prdItemId of meta.pr.prdItems) {
          const wi = allWis.find(w => w.id === prdItemId);
          if (wi && DONE_STATUSES.has(wi.status) && wi.sourcePlan) {
            syncPrdItemStatus(prdItemId, WI_STATUS.DONE, wi.sourcePlan);
          }
        }
      } catch (err) { log('warn', `PRD sync after fix: ${err.message}`); }
    }
  }
  checkForLearnings(agentId, config.agents[agentId], dispatchItem.task);
  if (finalResult === DISPATCH_RESULT.SUCCESS) {
    extractSkillsFromOutput(stdout, agentId, dispatchItem, config);
    // Also scan inbox notes for skill blocks — agents often write skills to inbox, not stdout
    try {
      const today = dateStamp();
      const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
      const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes(agentId) && f.includes(today));
      for (const f of inboxFiles) {
        const content = shared.safeRead(path.join(inboxDir, f));
        if (content && content.includes('```skill')) {
          extractSkillsFromOutput(content, agentId, dispatchItem, config);
        }
      }
    } catch {}
  }
  updateAgentHistory(agentId, dispatchItem, finalResult);
  // Don't count auto-retries as errors in metrics — only count final outcomes
  const isAutoRetry = !effectiveSuccess && meta?.item?.id && (meta.item._retryCount || 0) < ENGINE_DEFAULTS.maxRetries;
  const metricsResult = isAutoRetry ? 'retry' : finalResult;
  updateMetrics(agentId, dispatchItem, metricsResult, taskUsage, prsCreatedCount, model);

  // Teams notification — non-blocking
  try {
    const teams = require('./teams');
    teams.teamsNotifyCompletion(dispatchItem, finalResult, agentId).catch(() => {});
  } catch {}

  return { resultSummary, taskUsage, autoRecovered, structuredCompletion, completionContractFailure, agentReportedFailure, agentRetryable };
}

// ─── PR → PRD Status Sync ─────────────────────────────────────────────────────
// Runs every 6 ticks (~3 min). For all pending work items across all projects,
// runs the reconciliation pass to catch PRs created after materialization
// (e.g., manually raised PRs, cross-plan PRs, or PRs created while engine was paused).
function syncPrdFromPrs(config) {
  try {
    const { reconcileItemsWithPrs } = require('../engine');
    config = config || queries.getConfig();
    const allProjects = shared.getProjects(config);

    // Exact prdItems match only — no fuzzy matching
    const allPrs = allProjects.flatMap(p => safeJson(shared.projectPrPath(p)) || []);

    let totalReconciled = 0;
    for (const project of allProjects) {
      const wiPath = shared.projectWorkItemsPath(project);
      const items = safeJson(wiPath) || [];
      const hasReconcilable = items.some(wi =>
        (wi.status === WI_STATUS.PENDING && !wi._pr) || wi.status === WI_STATUS.FAILED);
      if (!hasReconcilable) continue;
      let reconciled = 0;
      // skipWriteIfUnchanged: per-poll reconcile runs every prPollStatusEvery
      // ticks. Without the flag it'd unconditionally rewrite project work-items.json,
      // tripping the cli.js watcher into a tick storm even with zero reconciliation.
      const reconciledItems = mutateJsonFileLocked(wiPath, data => {
        if (!Array.isArray(data)) return data;
        reconciled = reconcileItemsWithPrs(data, allPrs);
        return data;
      }, { skipWriteIfUnchanged: true });
      if (reconciled > 0) {
        // Sync done status to PRD JSON for each newly reconciled item
        for (const wi of (reconciledItems || [])) {
          if (wi.status === WI_STATUS.DONE) syncPrdItemStatus(wi.id, WI_STATUS.DONE, wi.sourcePlan);
        }
        totalReconciled += reconciled;
      }
    }
    if (totalReconciled > 0) {
      log('info', `PR sync: reconciled ${totalReconciled} work item(s) to done`);
    }
  } catch (err) {
    // Non-fatal — log and continue
    try { log('warn', `syncPrdFromPrs error: ${err?.message || err}`); } catch { /* engine not available */ }
  }
}

// ─── Failure Classification ─────────────────────────────────────────────────

/**
 * Classify an agent failure into a FAILURE_CLASS value based on exit code and output.
 * @param {number} code — process exit code
 * @param {string} stdout — agent stdout
 * @param {string} stderr — agent stderr
 * @returns {string} — one of FAILURE_CLASS values
 */
function classifyFailure(code, stdout = '', stderr = '') {
  const out = String(stdout || '').toLowerCase();
  const err = String(stderr || '').toLowerCase();
  const combined = out + '\n' + err;

  // Exit code 78 — configuration error (Claude CLI not found, bad setup)
  if (code === 78) return FAILURE_CLASS.CONFIG_ERROR;

  // Max turns exhausted (error_max_turns) — definitive stop reason, retryable
  // Must be checked FIRST — hook startup failures (e.g. curl exit code 28) can inject
  // permission/auth text into stderr, but if the agent ran to turn exhaustion that's the
  // real cause. Checked before PERMISSION_BLOCKED and OUT_OF_CONTEXT.
  if (/error_max_turns|"subtype"\s*:\s*"error_max_turns"|terminal_reason.*max_turns|max.*turns.*reached/i.test(combined)) {
    return FAILURE_CLASS.MAX_TURNS;
  }

  // Permission / trust / auth failures
  //
  // History (W-moja4a5qp9pj): the previous patterns `trust.*blocked` and
  // `auth.*fail` used unbounded greedy `.*`. JSONL agent init events that
  // emit the entire skill / slash-command catalogue on a single line
  // happen to contain words like `check-self-authored-...` and
  // `diagnose-build-fail-...`, which made the greedy regex match across
  // thousands of unrelated characters and silently flag healthy agents
  // as PERMISSION_BLOCKED on any non-zero exit. Use anchored phrases that
  // only match real auth/trust failure messages.
  const _PERM_PHRASES = [
    /\bpermission denied\b/i,
    /\baccess denied\b/i,
    /\bunauthorized\b/i,
    /\b403 forbidden\b/i,
    /\bauthentication (?:failed|error|failure)\b/i,
    /\bauth(?:entication)? (?:fail(?:ed|ure|s)?|denied|rejected)\b/i,
    /\btrust (?:gate|domain|zone|policy)? ?(?:is |was |has been )?(?:blocked|denied|rejected)\b/i,
    /\bcredentials? (?:rejected|invalid|expired)\b/i,
    /\btoken (?:rejected|invalid|expired|revoked)\b/i,
  ];
  if (_PERM_PHRASES.some(re => re.test(combined))) {
    return FAILURE_CLASS.PERMISSION_BLOCKED;
  }

  // Merge conflicts
  if (/merge conflict|conflict.*merge|automatic merge failed|fix conflicts/i.test(combined)) {
    return FAILURE_CLASS.MERGE_CONFLICT;
  }

  // Context window exhausted (token limit, context length — NOT max turns)
  if (/context window|token limit|conversation.*too long|context.*length.*exceeded/i.test(combined)) {
    return FAILURE_CLASS.OUT_OF_CONTEXT;
  }

  // Network / API errors
  if (/rate limit|429|econnrefused|enotfound|etimedout|dns.*resolution|api.*error.*5\d\d|overloaded/i.test(combined)) {
    return FAILURE_CLASS.NETWORK_ERROR;
  }

  // Build / test / lint failures
  if (/build failed|compilation error|test.*fail|lint.*error|type.*error|error ts\d+|syntax error|npm err/i.test(combined)) {
    return FAILURE_CLASS.BUILD_FAILURE;
  }

  // Spawn errors — process crashed immediately or couldn't start
  if (/spawn.*error|enoent|cannot find module|cannot find.*binary/i.test(combined)) {
    return FAILURE_CLASS.SPAWN_ERROR;
  }

  // Empty output — agent produced nothing useful
  if (!stdout || stdout.trim().length < 50) {
    return FAILURE_CLASS.EMPTY_OUTPUT;
  }

  // Timeout is classified by the caller (timeout.js), not by output pattern
  // but check for timeout markers in output as fallback
  if (/timed.?out|timeout|heartbeat.*expired/i.test(combined)) {
    return FAILURE_CLASS.TIMEOUT;
  }

  return FAILURE_CLASS.UNKNOWN;
}

/**
 * When a claude CLI agent exits in <3s with code 1 and no output, the raw
 * EMPTY_OUTPUT class tells us "no meaningful output" but nothing about WHY.
 * This helper detects the fast-exit pattern and returns a diagnostic hint
 * listing likely root causes (machine sleep, network loss, auth failure).
 *
 * The hint is propagated as the dispatch `reason` and into the work-item
 * `failReason`, so humans and other agents can triage without digging into
 * `agents/*\/output-<id>.log`.
 *
 * @param {string|undefined} failureClass — one of FAILURE_CLASS values
 * @param {number} code — process exit code
 * @param {number} elapsedMs — milliseconds between spawn and close
 * @returns {string|null} — annotated hint, or null when the pattern doesn't match
 */
function diagnoseEmptyOutput(failureClass, code, elapsedMs) {
  if (failureClass !== FAILURE_CLASS.EMPTY_OUTPUT) return null;
  if (code !== 1) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 3000) return null;
  return `[empty-output: process exited in ${elapsedMs}ms \u2014 possible causes: machine sleep, network unavailability, auth failure]`;
}

module.exports = {
  checkPlanCompletion,
  archivePlan,
  cleanupPlanWorktrees,
  updateWorkItemStatus,
  syncPrdItemStatus,
  reconcilePrdStatuses,
  syncPrsFromOutput,
  updatePrAfterReview,
  updatePrAfterFix,
  fixCompletionChangedBranch,
  handlePostMerge,
  checkForLearnings,
  extractSkillsFromOutput,
  updateAgentHistory,
  reviewFeedbackSourceMatches,
  createReviewFeedbackForAuthor,
  updateMetrics,
  parseAgentOutput,
  parseReviewVerdict,
  isReviewBailout,
  parseStructuredCompletion,
  parseCompletionFieldSummary,
  detectNonTerminalResultSummary,
  parseCompletionReportFile,
  persistCompletionReport,
  runPostCompletionHooks,
  syncPrdFromPrs,
  resolveWorkItemPath,
  isItemCompleted,
  classifyFailure,
  diagnoseEmptyOutput,
  processPendingRebases,
  findDependentActivePrs,
  isPrAttachmentRequired,
};
