/**
 * engine/lifecycle.js — Post-completion hooks, PR sync, agent history/metrics, plan chaining.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite, mutateJsonFileLocked, mutateWorkItems, execSilent, execAsync, projectPrPath, getPrLinks, addPrLink,
  log, ts, dateStamp, WI_STATUS, DONE_STATUSES, PLAN_TERMINAL_STATUSES, WORK_TYPE, PLAN_STATUS, PRD_ITEM_STATUS, PR_STATUS, DISPATCH_RESULT,
  ENGINE_DEFAULTS, DEFAULT_AGENT_METRICS, FAILURE_CLASS } = shared;
const { trackEngineUsage } = require('./llm');
const queries = require('./queries');
const { isBranchActive } = require('./cooldown');
const { worktreeDirMatchesBranch } = require('./cleanup');
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

  // Escalate failed/cancelled items to human — write inbox alert (deduped by slug)
  if (failedItems.length > 0) {
    const alertSlug = `plan-failure-escalation-${planFile.replace('.json', '')}`;
    const failDetails = failedItems.map(w =>
      `- \`${w.id}\`: ${w.title || 'Unknown'} — ${w.failReason || w.status}`
    ).join('\n');
    shared.writeToInbox('engine', alertSlug,
      `# Plan Items Failed: ${plan.plan_summary || planFile}\n\n` +
      `**${failedItems.length}** of ${planFeatureIds.size} item(s) failed or were cancelled:\n\n${failDetails}\n\n` +
      `The plan is completing with partial results (${doneItems.length} done, ${failedItems.length} failed).\n` +
      `Review failed items and re-dispatch manually if needed.\n`
    );
    log('warn', `Plan ${planFile}: ${failedItems.length} item(s) failed/cancelled — escalating to human: ${failedItems.map(w => w.id).join(', ')}`);
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
  if (existingVerify && (existingVerify.status === WI_STATUS.PENDING || existingVerify.status === WI_STATUS.DISPATCHED)) {
    log('info', `Plan ${planFile}: verify WI ${existingVerify.id} already ${existingVerify.status} — skipping`);
  } else if (doneItems.length > 0) {
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

    mutateWorkItems(wiPath, workItems => {
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
    });
    log('info', `Created verification work item ${verifyId} for plan ${planFile}`);

    // Teams notification for verify creation — non-blocking
    try {
      const teams = require('./teams');
      teams.teamsNotifyPlanEvent({ name: plan.plan_summary || planFile, file: planFile }, 'verify-created').catch(() => {});
    } catch {}
  } else if (existingVerify && DONE_STATUSES.has(existingVerify.status) && doneItems.length > 0) {
    // PRD was modified and re-completed — re-open the existing verify instead of creating a duplicate
    const verifyProject = existingVerify.project || projectName;
    const vWiPath = shared.projectWorkItemsPath(
      projects.find(p => p.name?.toLowerCase() === verifyProject?.toLowerCase()) || primaryProject
    );
    mutateWorkItems(vWiPath, items => {
      const v = items.find(w => w.id === existingVerify.id);
      if (v && DONE_STATUSES.has(v.status)) {
        v.status = WI_STATUS.PENDING;
        v._reopened = true;
        delete v.completedAt;
        delete v.dispatched_to;
        delete v.dispatched_at;
        v._retryCount = 0;
      }
    });
    log('info', `Re-opened verification work item ${existingVerify.id} for modified plan ${planFile}`);
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
    const backupPath = planPath + '.backup';
    try { fs.unlinkSync(backupPath); } catch {
      try { fs.writeFileSync(backupPath, JSON.stringify({ status: 'archived' })); } catch { }
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
        const dirLower = dir.toLowerCase();
        const matches = [...branchSlugs].some(slug => dirLower.includes(slug));
        if (matches) {
          const wtPath = path.join(wtRoot, dir);
          if (shared.removeWorktree(wtPath, root, wtRoot)) cleanedWt++;
        }
      }
    }
    if (cleanedWt > 0) log('info', `Plan worktree cleanup: removed ${cleanedWt} worktree(s)`);
  } catch (err) { log('warn', `Plan worktree cleanup: ${err.message}`); }
}

// ─── Plan → PRD Chaining ─────────────────────────────────────────────────────
function chainPlanToPrd(dispatchItem, meta, config) {

  const planDir = path.join(MINIONS_DIR, 'plans');
  if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });

  let planFileName = meta?.planFileName || meta?.item?._planFileName;
  if (planFileName && fs.existsSync(path.join(planDir, planFileName))) {
    // Exact match from meta
  } else {
    const planFiles = fs.readdirSync(planDir)
      .filter(f => f.endsWith('.md') || f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(planDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    planFileName = planFiles[0]?.name;
    if (!planFileName) {
      log('warn', `Plan chaining: no plan files found in plans/ after task ${dispatchItem.id}`);
      return;
    }
    log('info', `Plan chaining: using mtime fallback — found ${planFileName}`);
  }

  if (planFileName.endsWith('.json')) {
    const mdName = planFileName.replace(/\.json$/, '.md');
    // Check plans/ first, then prd/ for .json files
    const jsonPath = fs.existsSync(path.join(planDir, planFileName))
      ? path.join(planDir, planFileName)
      : path.join(MINIONS_DIR, 'prd', planFileName);
    const mdPath = path.join(planDir, mdName);
    try {
      const content = fs.readFileSync(jsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed.missing_features) {
        fs.renameSync(jsonPath, mdPath);
        planFileName = mdName;
        log('info', `Plan chaining: renamed ${planFileName} → ${mdName} (plans must be .md)`);
      }
    } catch {
      try {
        if (fs.existsSync(jsonPath)) fs.renameSync(jsonPath, path.join(planDir, mdName));
        planFileName = mdName;
        log('info', `Plan chaining: renamed to .md (not valid JSON)`);
      } catch (err) { log('warn', `Plan rename fallback: ${err.message}`); }
    }
  }

  const planFile = { name: planFileName };
  const planPath = path.join(planDir, planFileName);
  let planContent;
  try { planContent = fs.readFileSync(planPath, 'utf8'); } catch (err) {
    log('error', `Plan chaining: failed to read plan file ${planFile.name}: ${err.message}`);
    return;
  }

  const projectName = meta?.item?.project || meta?.project?.name;
  const projects = shared.getProjects(config);
  if (projects.length === 0) {
    log('error', 'Plan chaining: no projects configured');
    return;
  }
  const targetProject = projectName
    ? projects.find(p => p.name === projectName) || projects[0]
    : projects[0];

  if (!targetProject) {
    log('error', 'Plan chaining: no target project available');
    return;
  }

  log('info', `Plan chaining: queuing plan-to-prd for next tick (chained from ${dispatchItem.id})`);
  const wiPath = path.join(MINIONS_DIR, 'work-items.json');
  shared.mutateJsonFileLocked(wiPath, (items) => {
    if (!Array.isArray(items)) items = [];
    items.push({
      id: 'W-' + shared.uid(),
      title: `Convert plan to PRD: ${meta?.item?.title || planFile.name}`,
      type: 'plan-to-prd',
      priority: meta?.item?.priority || 'high',
      description: `Plan file: plans/${planFile.name}\nChained from plan task ${dispatchItem.id}`,
      status: WI_STATUS.PENDING,
      created: ts(),
      createdBy: 'engine:chain',
      project: targetProject.name,
      planFile: planFile.name,
    });
    return items;
  }, { defaultValue: [] });
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

  mutateJsonFileLocked(wiPath, (items) => {
    if (!items || !Array.isArray(items)) return items;
    const target = items.find(i => i.id === itemId);
    if (!target) return items;

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
      const plan = safeJson(fpath);
      if (!plan?.missing_features) continue;
      const feature = plan.missing_features.find(f => f.id === itemId);
      if (feature && feature.status !== status) {
        feature.status = status;
        shared.safeWrite(fpath, plan);
        return;
      }
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
      const plan = safeJson(fpath);
      if (!plan?.missing_features) continue;
      // Skip completed/archived PRDs — no reconciliation needed
      if (plan.status === PLAN_STATUS.COMPLETED) continue;

      let modified = false;
      for (const feature of plan.missing_features) {
        if (feature.status === PRD_ITEM_STATUS.MISSING && doneWiById.has(feature.id)) {
          feature.status = PRD_ITEM_STATUS.UPDATED;
          modified = true;
          log('info', `PRD backward-scan: promoted ${feature.id} from missing→updated in ${file} (done work item exists)`);
        }
        // (#984) Stale status: PRD item stuck at dispatched/failed/pending while WI is done —
        // happens when fix work items complete with a different ID than the original PRD feature
        else if (_STALE_PRD_STATUSES.has(feature.status) && doneWiById.has(feature.id)) {
          const prev = feature.status;
          feature.status = WI_STATUS.DONE;
          modified = true;
          log('info', `PRD backward-scan: promoted ${feature.id} from ${prev}→done in ${file} (done work item exists)`);
        }
      }

      if (modified) {
        safeWrite(fpath, plan);
      }
    } catch (err) { log('warn', `PRD backward-scan for ${file}: ${err.message}`); }
  }
}

// ─── PR Sync from Output ─────────────────────────────────────────────────────

function syncPrsFromOutput(output, agentId, meta, config) {

  const prMatches = new Set();
  const urlPattern = /(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+)/g;
  const textCreatedPattern = /(?:PR created|created PR|E2E PR)[:\s#-]*(\d{1,})/gi;
  let match;

  try {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"result"') && !line.includes('"type":"user"')) continue;
        const parsed = JSON.parse(line);
        const content = parsed.message?.content || [];
        for (const block of content) {
          // Scan tool_result blocks in user messages for PR URLs (gh pr create output lands here)
          if (block.type === 'tool_result' && block.content) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            while ((match = urlPattern.exec(text)) !== null) prMatches.add(match[1] || match[2]);
          }
          // Also scan assistant text blocks for PR URLs and "PR created" patterns
          if (block.type === 'text' && block.text) {
            while ((match = urlPattern.exec(block.text)) !== null) prMatches.add(match[1] || match[2]);
            textCreatedPattern.lastIndex = 0;
            let m2;
            while ((m2 = textCreatedPattern.exec(block.text)) !== null) prMatches.add(m2[1]);
          }
        }
        if (parsed.type === 'result' && parsed.result) {
          const resultText = parsed.result;
          const createdPattern = /(?:created|opened|submitted|new PR|PR created)[^\n]*?(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
          while ((match = createdPattern.exec(resultText)) !== null) prMatches.add(match[1] || match[2]);
          const createdIdPattern = /(?:created|opened|submitted|new)\s+PR[# -]*(\d{1,})/gi;
          while ((match = createdIdPattern.exec(resultText)) !== null) prMatches.add(match[1]);
        }
      } catch {}
    }
  } catch {}

  const today = dateStamp();
  const inboxFiles = getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
  for (const f of inboxFiles) {
    const content = safeRead(path.join(INBOX_DIR, f));
    if (!content) continue;
    const prHeaderPattern = /\*\*PR[:\*]*\*?\s*[#-]*\s*(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
    while ((match = prHeaderPattern.exec(content)) !== null) prMatches.add(match[1] || match[2]);
  }

  if (prMatches.size === 0) return 0;

  const projects = shared.getProjects(config);
  if (projects.length === 0 && !meta?.project?.name) return 0;
  const defaultProject = (meta?.project?.name && projects.find(p => p.name === meta.project.name)) || projects[0];
  const useCentral = !defaultProject;

  // Match each PR to its correct project by finding which repo URL appears near the PR number in output
  function resolveProjectForPr(prId) {
    for (const p of projects) {
      if (!p.prUrlBase) continue;
      const urlFragment = p.prUrlBase.replace(/pullrequest\/$/, '');
      if (output.includes(urlFragment + 'pullrequest/' + prId) || output.includes(urlFragment + prId)) return p;
    }
    for (const p of projects) {
      if (p.repoName && output.includes(`_git/${p.repoName}/pullrequest/${prId}`)) return p;
    }
    return defaultProject;
  }

  // Extract PR URL directly from agent output — no manual construction
  function extractPrUrl(prId) {
    // Stop at backslash in addition to whitespace/quotes — raw JSONL encodes newlines as \n (literal
    // backslash-n), so without this the regex would capture e.g. "pull/1804\n/usr/bin/bash".
    const ghMatch = output.match(new RegExp(`https?://github\\.com/[^\\s"'\\)\\]\\\\]*?/pull/${prId}(?:[^\\s"'\\)\\]\\\\]*)`, 'i'));
    if (ghMatch) return ghMatch[0].replace(/[.,;:]+$/, '');
    const adoMatch = output.match(new RegExp(`https?://(?:dev\\.azure\\.com|[^/]+\\.visualstudio\\.com)[^\\s"'\\)\\]\\\\]*?pullrequest/${prId}(?:[^\\s"'\\)\\]\\\\]*)`, 'i'));
    if (adoMatch) return adoMatch[0].replace(/[.,;:]+$/, '');
    return '';
  }

  const agentName = config.agents?.[agentId]?.name || agentId;
  let added = 0;
  const centralPrPath = path.join(MINIONS_DIR, 'pull-requests.json');

  // Group new PRs by target file path
  const newPrsByPath = new Map(); // prPath -> [{ prId, newEntry }]

  for (const prId of prMatches) {
    const targetProject = useCentral ? null : resolveProjectForPr(prId);
    const targetName = targetProject ? targetProject.name : '_central';
    const prPath = targetProject ? shared.projectPrPath(targetProject) : centralPrPath;
    const prUrl = extractPrUrl(prId);
    const fullId = shared.getCanonicalPrId(targetProject, prId, prUrl);

    let title = meta?.item?.title || '';
    const titleMatch = output.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
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
    const linksToPersist = [];
    mutateJsonFileLocked(prPath, (data) => {
      const prs = Array.isArray(data) ? data : [];
      // Normalize legacy YYYY-MM-DD created dates to ISO
      for (const p of prs) {
        if (p.created && p.created.length === 10) p.created = p.created + 'T00:00:00.000Z';
      }
      for (const { prId, fullId, entry } of entries) {
        if (prs.some(p => p.id === fullId || (p.url && p.url === entry.url))) continue;

        // Branch-level dedup: skip if an active PR already exists on the same branch.
        // This prevents duplicate PRs when an agent retries and calls `gh pr create` again
        // on the same branch (GitHub allows multiple PRs from one branch).
        // Only block when the existing PR is active — abandoned/merged PRs don't conflict.
        const branch = entry.branch || entryBranch;
        if (branch) {
          const existingOnBranch = prs.find(p => p.branch === branch && p.status === PR_STATUS.ACTIVE && p.id !== fullId);
          if (existingOnBranch) {
            log('warn', `Duplicate PR detected: ${fullId} on branch ${branch} — already tracked as ${existingOnBranch.id}. Skipping.`);
            // Best-effort close the duplicate on GitHub (non-blocking, fire-and-forget)
            try {
              const ghSlug = output.match(/github\.com\/([^/]+\/[^/]+)/)?.[1];
              if (ghSlug) {
                execAsync(`gh pr close ${prId} --repo ${ghSlug} --comment "Closing duplicate — ${existingOnBranch.id} already tracks this branch."`, { timeout: 15000 })
                  .catch(() => {});
              }
            } catch { /* best-effort */ }
            continue;
          }
        }

        prs.push(entry);
        if (meta?.item?.id) {
          linksToPersist.push({ prId: fullId, itemId: meta.item.id, project: targetProject, prNumber: entry.prNumber, url: entry.url });
        }
        added++;
      }
      return prs;
    });
    for (const { prId, itemId, project, prNumber, url } of linksToPersist) {
      addPrLink(prId, itemId, { project, prNumber, url });
    }
    log('info', `Synced PR(s) from ${agentName}'s output to ${name === '_central' ? 'central' : name}/pull-requests.json`);
  }
  return added;
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
    const v = verdictMatch[1].toUpperCase().replace(/[\s-]/g, '_');
    if (v === 'APPROVE') return 'approved';
    if (v.includes('CHANGES')) return 'changes-requested';
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

async function updatePrAfterReview(agentId, pr, project, config, resultSummary) {

  if (!pr?.id) return;

  if (!config) config = getConfig();
  const reviewerName = config.agents?.[agentId]?.name || agentId;
  const dispatch = getDispatch();
  const completedEntry = (dispatch.completed || []).find(d => d.agent === agentId && d.type === 'review');

  // Check actual review status from the platform (agent may have approved or requested changes)
  // If platform hasn't propagated the vote yet (returns 'pending'), keep current status unchanged.
  // The poller will pick up the real status on the next cycle (~3 min).
  let postReviewStatus = null; // null = don't change
  try {
    const projectObj = project || shared.getProjects(config)[0];
    if (projectObj) {
      const host = projectObj.repoHost || 'ado';
      const checkFn = host === 'github'
        ? require('./github').checkLiveReviewStatus
        : require('./ado').checkLiveReviewStatus;
      const liveStatus = await checkFn(pr, projectObj);
      if (liveStatus && liveStatus !== 'pending') postReviewStatus = liveStatus;
    }
  } catch (e) { log('warn', `Post-review status check for ${pr.id}: ${e.message}`); }

  // Fallback: if live check returned pending (e.g., GitHub self-approval blocked), parse verdict from agent output
  if (!postReviewStatus) {
    const verdict = parseReviewVerdict(resultSummary);
    if (verdict) {
      postReviewStatus = verdict;
      log('info', `Parsed review verdict from agent output for ${pr.id}: ${verdict}`);
    }
  }

  const prPath = project ? shared.projectPrPath(project) : path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json');
  let updatedTarget = null;
  shared.mutateJsonFileLocked(prPath, (prs) => {
    if (!Array.isArray(prs)) return prs;
    const target = shared.findPrRecord(prs, pr, project);
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
      note: resultSummary || completedEntry?.task || '',
      // Preserve fixedAt across re-reviews so the poller guard knows a fix was pushed.
      // Drop it when reviewer requests changes again — that starts a new fix cycle.
      ...(target.minionsReview?.fixedAt && postReviewStatus !== 'changes-requested' ? { fixedAt: target.minionsReview.fixedAt } : {}),
    };
    updatedTarget = { ...pr, ...target };
    return prs;
  }, { defaultValue: [] });

  // Track reviewer for metrics purposes (separate file, separate lock)
  const authorAgentId = (pr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    shared.mutateJsonFileLocked(path.join(ENGINE_DIR, 'metrics.json'), (metrics) => {
      if (!metrics[authorAgentId]) metrics[authorAgentId] = { ...DEFAULT_AGENT_METRICS };
      if (!metrics[agentId]) metrics[agentId] = { ...DEFAULT_AGENT_METRICS };
      metrics[agentId].reviewsDone = (metrics[agentId].reviewsDone || 0) + 1;
      return metrics;
    }, { defaultValue: {} });
  }

  log('info', `Updated ${pr.id} → minions review: ${postReviewStatus || 'waiting'} by ${reviewerName}`);
  if (updatedTarget) createReviewFeedbackForAuthor(agentId, updatedTarget, config);
}

function updatePrAfterFix(pr, project, source) {

  if (!pr?.id) return;
  const prPath = project ? shared.projectPrPath(project) : path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json');
  shared.mutateJsonFileLocked(prPath, (prs) => {
    if (!Array.isArray(prs)) return prs;
    const target = shared.findPrRecord(prs, pr, project);
    if (!target) return prs;
    // Never downgrade from approved — fix was dispatched but PR is already approved
    if (target.reviewStatus !== 'approved') target.reviewStatus = 'waiting';
    // Always clear pendingFix — a fix dispatch (regardless of source) addresses all pending feedback
    if (target.humanFeedback) target.humanFeedback.pendingFix = false;
    if (source === 'pr-human-feedback') {
      target.minionsReview = { ...target.minionsReview, note: 'Fixed human feedback, awaiting re-review', fixedAt: ts() };
      log('info', `Updated ${pr.id} → cleared humanFeedback.pendingFix, reset to waiting for re-review`);
    } else {
      target.minionsReview = { ...target.minionsReview, note: 'Fixed, awaiting re-review', fixedAt: ts() };
      log('info', `Updated ${pr.id} → reviewStatus: waiting (fix pushed)`);
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
      if (entry.attempts < 3) {
        remaining.push(entry);
      } else {
        shared.writeToInbox('engine', `rebase-fail-${pr.id}`,
          `# Rebase Failed: ${pr.id}\n\nBranch \`${pr.branch}\` could not be rebased onto main after dependency ${entry.mergedItemId} merged.\n\nError: ${result.error}\n\nManual rebase may be needed.`);
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
    // Find worktrees matching this branch — dir format is {slug}-{branch}-{suffix}
    try {
      const dirs = require('fs').readdirSync(wtRoot);
      for (const dir of dirs) {
        const dirLower = dir.toLowerCase();
        if (worktreeDirMatchesBranch(dirLower, pr.branch) || dir === pr.branch || dir === `bt-${prNum}`) {
          const wtPath = path.join(wtRoot, dir);
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
        const plan = safeJson(path.join(prdDir, pf));
        if (!plan?.missing_features) continue;
        let changed = false;
        for (const feature of plan.missing_features) {
          if (mergedItemSet.has(feature.id) && feature.status !== WI_STATUS.DONE) {
            feature.status = WI_STATUS.DONE;
            changed = true;
            updated++;
          }
        }
        if (changed) {
          shared.safeWrite(path.join(prdDir, pf), plan);
        }
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
            shared.writeToInbox('engine', `rebase-fail-${depPr.id}`,
              `# Rebase Failed: ${depPr.id}\n\nBranch \`${depPr.branch}\` could not be rebased onto main after dependency ${mergedItemId} merged.\n\nError: ${result.error}\n\nManual rebase may be needed.`);
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

function extractSkillsFromOutput(output, agentId, dispatchItem, config) {

  if (!output) return;
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
        const centralPath = path.join(MINIONS_DIR, 'work-items.json');
        let skillId = null;
        mutateJsonFileLocked(centralPath, data => {
          data = data || [];
          if (data.some(i => i.title === `Add skill: ${name}` && i.status !== WI_STATUS.FAILED)) return data;
          skillId = `SK${String(data.filter(i => i.id?.startsWith('SK')).length + 1).padStart(3, '0')}`;
          data.push({ id: skillId, type: 'implement', title: `Add skill: ${name}`,
            description: `Create project-level skill \`${skillDirName}/SKILL.md\` in ${project}.\n\nWrite this file to \`${proj.localPath}/.claude/skills/${skillDirName}/SKILL.md\` via a PR.\n\n## Skill Content\n\n\`\`\`\n${enrichedBlock}\n\`\`\``,
            priority: 'low', status: WI_STATUS.QUEUED, created: ts(), createdBy: `engine:skill-extraction:${agentName}` });
          return data;
        }, { skipWriteIfUnchanged: true });
        if (skillId) {
          log('info', `Queued work item ${skillId} to PR project skill "${name}" into ${project}`);
        }
      }
    } else {
      // Write in Claude Code native format: ~/.claude/skills/<name>/SKILL.md
      const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
      const skillDir = path.join(claudeSkillsDir, name.replace(/[^a-z0-9-]/g, '-'));
      const skillPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        // Convert to Claude Code format: only name + description in frontmatter
        const description = m('description') || m('trigger') || `Auto-extracted skill from ${agentName}`;
        const body = fmMatch[2] || '';
        const ccContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
        if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
        shared.safeWrite(skillPath, ccContent);
        log('info', `Extracted skill "${name}" from ${agentName} → ~/.claude/skills/${name.replace(/[^a-z0-9-]/g, '-')}/SKILL.md`);
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

function createReviewFeedbackForAuthor(reviewerAgentId, pr, config) {

  if (!pr?.id || !pr?.agent) return;
  const authorAgentId = pr.agent.toLowerCase();
  if (!config.agents[authorAgentId]) return;
  const today = dateStamp();
  const inboxFiles = getInboxFiles();
  const reviewFiles = inboxFiles.filter(f => f.includes(reviewerAgentId) && f.includes(today));
  if (reviewFiles.length === 0) return;
  const reviewContent = reviewFiles.map(f => safeRead(path.join(INBOX_DIR, f))).filter(Boolean).join('\n\n');
  const prSlug = shared.safeSlugComponent(pr.id, 60);
  const feedbackFile = `feedback-${authorAgentId}-from-${reviewerAgentId}-${prSlug}-${today}.md`;
  const feedbackPath = shared.uniquePath(path.join(INBOX_DIR, feedbackFile));
  const content = `# Review Feedback for ${config.agents[authorAgentId]?.name || authorAgentId}\n\n` +
    `**PR:** ${pr.id} — ${pr.title || ''}\n` +
    `**Reviewer:** ${config.agents[reviewerAgentId]?.name || reviewerAgentId}\n` +
    `**Date:** ${today}\n\n` +
    `## What the reviewer found\n\n${reviewContent}\n\n` +
    `## Action Required\n\nRead this feedback carefully. When you work on similar tasks in the future, ` +
    `avoid the patterns flagged here. If you are assigned to fix this PR, ` +
    `address every point raised above.\n`;
  shared.safeWrite(feedbackPath, content);
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
  let text = stdout;
  if (stdout.includes('"type":')) {
    try {
      const parsed = shared.parseStreamJsonOutput(stdout, runtimeName);
      if (parsed.text) text = parsed.text;
    } catch {}
  }

  // Find all ```completion blocks, take the last one
  const blockPattern = /```completion\s*\n([\s\S]*?)```/g;
  let lastMatch = null;
  let m;
  while ((m = blockPattern.exec(text)) !== null) {
    lastMatch = m[1];
  }
  if (!lastMatch) return null;

  // Parse key: value pairs
  const result = {};
  const lines = lastMatch.trim().split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) result[key] = value;
  }

  // Must have at least the status field to be valid
  if (!result.status) return null;
  return result;
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
  const { resultSummary, taskUsage, sessionId, model } = parseAgentOutput(stdout, runtimeName);

  // Try structured completion protocol first (```completion block from agent output)
  const structuredCompletion = parseStructuredCompletion(stdout, runtimeName);
  if (structuredCompletion) {
    log('info', `Structured completion from ${agentId}: status=${structuredCompletion.status}, pr=${structuredCompletion.pr || 'N/A'}`);
  }

  // Save session for potential resume on next dispatch
  if (isSuccess && sessionId && agentId && !agentId.startsWith('temp-')) {
    try {
      shared.safeWrite(path.join(AGENTS_DIR, agentId, 'session.json'), {
        sessionId, dispatchId: dispatchItem.id, savedAt: ts(),
        branch: dispatchItem.meta?.branch || null,
      });
    } catch (err) { log('warn', `Session save: ${err.message}`); }
  }

  // Always attempt PR sync — even failed/timed-out agents may have created PRs before dying
  let prsCreatedCount = 0;
  try {
    prsCreatedCount = syncPrsFromOutput(stdout, agentId, meta, config) || 0;
  } catch (err) { log('warn', `PR sync from output: ${err.message}`); }

  // Structured completion may report PR even when regex didn't find it
  const scHasPr = structuredCompletion && structuredCompletion.pr && structuredCompletion.pr !== 'N/A';
  if (scHasPr && prsCreatedCount === 0) {
    log('info', `Structured completion reports PR (${structuredCompletion.pr}) but regex sync found none — PR may already be tracked`);
  }

  // Auto-recover: if a failed implement/fix agent created PRs, it likely succeeded before being killed (e.g. heartbeat timeout)
  const prCreatingType = type === WORK_TYPE.IMPLEMENT || type === WORK_TYPE.IMPLEMENT_LARGE || type === WORK_TYPE.FIX;
  const autoRecovered = !isSuccess && prsCreatedCount > 0 && prCreatingType && !!meta?.item?.id;
  if (autoRecovered) {
    log('info', `Auto-recovery: agent failed but created ${prsCreatedCount} PR(s) — upgrading ${meta.item.id} to done`);
  }
  const effectiveSuccess = isSuccess || autoRecovered;

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
    const verdict = parseReviewVerdict(resultSummary);
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
      collectMeetingFindings(meta.meetingId, agentId, meta.roundName, stdout);
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
      // Write a completion note to inbox with back-references
      const noteSlug = `sched-completion-${scheduleId}`;
      const status = effectiveSuccess ? 'succeeded' : 'failed';
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
          return worktreeDirMatchesBranch(d.toLowerCase(), meta.branch) && fs.statSync(path.join(worktreeRoot, d)).isDirectory();
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

  // Detect implement tasks that completed without creating a PR
  if (effectiveSuccess && (type === WORK_TYPE.IMPLEMENT || type === WORK_TYPE.IMPLEMENT_LARGE || type === WORK_TYPE.FIX) && prsCreatedCount === 0 && meta?.item?.id && !meta?.item?.skipPr && meta?.project?.localPath) {
    // Check if a PR already exists linked to this work item (from a previous attempt)
    let existingPrFound = Object.values(getPrLinks()).some(linkedIds => (linkedIds || []).includes(meta.item.id));
    // Also check pull-requests.json for PRs with matching prdItems or branch
    if (!existingPrFound) {
      const allProjects = shared.getProjects(config);
      for (const p of allProjects) {
        const prs = safeJson(shared.projectPrPath(p)) || [];
        if (prs.some(pr => (pr.prdItems || []).includes(meta.item.id) || (pr.branch && pr.branch.includes(meta.item.id)))) {
          existingPrFound = true;
          break;
        }
      }
    }
    // Last resort: query the platform directly for an open PR on this branch.
    // Handles the case where a prior orphaned dispatch created a PR but the engine
    // never processed its output — so the PR exists on the platform but not in pull-requests.json.
    if (!existingPrFound && meta?.branch) {
      const projectObj = shared.getProjects(config).find(p => p.name === meta?.project?.name);
      if (projectObj) {
        try {
          let found = null;
          const host = projectObj.repoHost || 'ado';
          if (host === 'github') {
            const ghSlug = projectObj.prUrlBase?.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
            if (ghSlug) {
              // Retry up to 3 times — newly created PRs can take a few seconds to appear in the API
              for (let attempt = 0; attempt < 3 && !found; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
                let raw = '';
                try {
                  raw = await execAsync(`gh pr list --head "${meta.branch}" --repo ${ghSlug} --json number,url,state --limit 1`, { timeout: 15000, windowsHide: true });
                  const parsed = JSON.parse(raw || '[]');
                  const hits = Array.isArray(parsed) ? parsed : [];
                  if (hits.length > 0 && hits[0].state === 'OPEN') {
                    found = { prNumber: hits[0].number, url: hits[0].url };
                  } else if (attempt === 2) {
                    log('warn', `Auto-link fallback: no open PR found on branch ${meta.branch} after 3 attempts (raw: ${(raw || '').slice(0, 200)})`);
                  }
                } catch (err) {
                  if (attempt === 2) {
                    const rawSuffix = raw ? ` (raw: ${raw.slice(0, 200)})` : '';
                    log('warn', `Auto-link fallback: gh pr list lookup failed on branch ${meta.branch} after 3 attempts: ${err.message}${rawSuffix}`);
                  }
                }
              }
            }
          } else if (host === 'ado') {
            found = await require('./ado').findOpenPrOnBranch(projectObj, meta.branch);
          } else {
            log('debug', `Skipping branch PR lookup for unsupported repo host "${host}" on ${projectObj.name}`);
          }
          if (found) {
            const fullId = shared.getCanonicalPrId(projectObj, found.prNumber, found.url);
            const prPath = shared.projectPrPath(projectObj);
            mutateJsonFileLocked(prPath, prs => {
              if (!Array.isArray(prs)) prs = [];
              const existingPr = prs.find(p => p.id === fullId);
              if (existingPr) {
                if (meta.item?.id) {
                  if (!Array.isArray(existingPr.prdItems)) existingPr.prdItems = [];
                  if (!existingPr.prdItems.includes(meta.item.id)) existingPr.prdItems.push(meta.item.id);
                }
                return prs;
              }
              prs.push({
                id: fullId, prNumber: found.prNumber, title: meta.item?.title || '',
                agent: agentId, branch: meta.branch, reviewStatus: 'pending',
                status: PR_STATUS.ACTIVE, created: ts(), url: found.url,
                prdItems: meta.item?.id ? [meta.item.id] : [],
                sourcePlan: meta.item?.sourcePlan || '', itemType: meta.item?.itemType || '',
              });
              return prs;
            });
            log('info', `Auto-linked existing PR ${fullId} on branch ${meta.branch} for ${meta.item?.id}`);
            existingPrFound = true;
          }
        } catch (e) { log('warn', `PR lookup for branch ${meta.branch}: ${e.message}`); }
      }
    }
    if (!existingPrFound) {
      const noPrWiPath = resolveWorkItemPath(meta);
      if (noPrWiPath) {
        const hasOutput = stdout && stdout.length > 500;
        let action = null;
        mutateJsonFileLocked(noPrWiPath, data => {
          if (!Array.isArray(data)) return data;
          const w = data.find(i => i.id === meta.item.id);
          if (!w) return data;
          const retries = w._retryCount || 0;
          if (!hasOutput && retries < ENGINE_DEFAULTS.maxRetries) {
            w.status = WI_STATUS.PENDING;
            w._retryCount = retries + 1;
            delete w.dispatched_at;
            delete w.dispatched_to;
            delete w.failReason;
            delete w.noPr;
            action = { type: 'retry', retries: retries + 1 };
          } else if (hasOutput) {
            w.status = WI_STATUS.DONE;
            w.completedAt = ts();
            w._noPr = true;
            w._noPrReason = 'Agent completed without creating a PR (changes may already exist or not be needed)';
            delete w.failReason;
            action = { type: 'done' };
          } else {
            w.status = WI_STATUS.NEEDS_REVIEW;
            w._noPr = true;
            w.failReason = 'Completed without output or PR after ' + ENGINE_DEFAULTS.maxRetries + ' attempts';
            action = { type: 'needs-review' };
          }
          return data;
        }, { skipWriteIfUnchanged: true });
        if (action?.type === 'retry') {
          log('info', `Auto-retry ${action.retries}/${ENGINE_DEFAULTS.maxRetries} for ${meta.item.id} (no output, no PR)`);
        } else if (action?.type === 'done') {
          log('info', `${meta.item.id} completed without PR — marking done (agent produced output)`);
        } else if (action?.type === 'needs-review') {
          log('warn', `${meta.item.id} needs review — no output after ${ENGINE_DEFAULTS.maxRetries} retries`);
        }
      }
    }
  }

  // Old plan-to-prd PRD check removed — moved before updateWorkItemStatus(DONE) to fix #893
  // (retryCount was being deleted by done-marking before the check could read it)
  // Review verdict check similarly moved before updateWorkItemStatus(DONE) — same root cause.

  if (type === WORK_TYPE.REVIEW) await updatePrAfterReview(agentId, meta?.pr, meta?.project, config, resultSummary);
  if (type === WORK_TYPE.FIX) {
    updatePrAfterFix(meta?.pr, meta?.project, meta?.source);
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
  if (effectiveSuccess) {
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
  const finalResult = effectiveSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;
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

  return { resultSummary, taskUsage, autoRecovered, structuredCompletion };
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
  if (/permission denied|access denied|unauthorized|403 forbidden|trust.*blocked|auth.*fail/i.test(combined)) {
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
  handlePostMerge,
  checkForLearnings,
  extractSkillsFromOutput,
  updateAgentHistory,
  createReviewFeedbackForAuthor,
  updateMetrics,
  parseAgentOutput,
  parseReviewVerdict,
  isReviewBailout,
  parseStructuredCompletion,
  runPostCompletionHooks,
  syncPrdFromPrs,
  resolveWorkItemPath,
  isItemCompleted,
  classifyFailure,
  diagnoseEmptyOutput,
  processPendingRebases,
  findDependentActivePrs,
};
