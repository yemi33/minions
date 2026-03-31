/**
 * engine/lifecycle.js — Post-completion hooks, PR sync, agent history/metrics, plan chaining.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite, execSilent, projectPrPath, getPrLinks, addPrLink } = shared;
const { trackEngineUsage } = require('./llm');
const queries = require('./queries');
const { getConfig, getInboxFiles, getNotes, getPrs, getDispatch,
  MINIONS_DIR, ENGINE_DIR, PLANS_DIR, PRD_DIR, INBOX_DIR, AGENTS_DIR } = queries;

// Lazy require — only for log(), ts(), dateStamp() and engine-specific functions
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// ─── Plan Completion Detection ───────────────────────────────────────────────
function checkPlanCompletion(meta, config) {
  const e = engine();
  const planFile = meta.item?.sourcePlan;
  if (!planFile) return;
  const planPath = path.join(PRD_DIR, planFile);
  const plan = safeJson(planPath);
  if (!plan?.missing_features) return;
  if (plan.status === 'completed') return;

  const projects = shared.getProjects(config);

  // Collect work items from ALL projects (PRD items can span multiple projects)
  let allWorkItems = [];
  for (const p of projects) {
    try {
      const wi = safeJson(shared.projectWorkItemsPath(p)) || [];
      allWorkItems = allWorkItems.concat(wi);
    } catch { /* optional */ }
  }
  const planItems = allWorkItems.filter(w => w.sourcePlan === planFile && w.itemType !== 'pr' && w.itemType !== 'verify');
  if (planItems.length === 0) return;

  // Hard completion gate: every PRD feature ID must have a corresponding work item in done status.
  const planFeatureIds = new Set((plan.missing_features || []).map(f => f.id).filter(Boolean));
  const workItemById = {};
  for (const w of planItems) { if (w.id) workItemById[w.id] = w; }

  // Check 1: every feature must have a work item (materialized)
  // Fallback: also accept features marked done directly in the PRD JSON (resolved externally)
  const unmaterialized = [...planFeatureIds].filter(id => {
    if (workItemById[id]) return false;
    const prdItem = (plan.missing_features || []).find(f => f.id === id);
    return !(prdItem && (prdItem.status === 'done' || prdItem.status === 'in-pr'));
  });
  if (unmaterialized.length > 0) {
    e.log('info', `Plan ${planFile}: ${unmaterialized.length}/${planFeatureIds.size} feature(s) not yet materialized as work items: ${unmaterialized.join(', ')}`);
    return;
  }

  // Check 2: every feature's work item must be done (or PRD item marked done externally)
  const notDone = [...planFeatureIds].filter(id => {
    const w = workItemById[id];
    if (w && (w.status === 'done' || w.status === 'in-pr')) return false; // in-pr accepted for backward compat
    const prdItem = (plan.missing_features || []).find(f => f.id === id);
    return !(prdItem && (prdItem.status === 'done' || prdItem.status === 'in-pr'));
  });
  if (notDone.length > 0) {
    e.log('info', `Plan ${planFile}: waiting for done on ${notDone.length}/${planFeatureIds.size} item(s): ${notDone.join(', ')}`);
    return;
  }

  const doneItems = planItems.filter(w => w.status === 'done' || w.status === 'in-pr');
  const failedItems = planItems.filter(w => w.status === 'failed');

  // 1. Mark plan as completed
  plan.status = 'completed';
  plan.completedAt = e.ts();

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
        const linkedItemId = prLinks[pr.id];
        if (linkedItemId && doneItems.find(w => w.id === linkedItemId)) {
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
    `**Completed:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
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
  const summaryFile = `prd-completion-${planFile.replace('.json', '')}-${e.ts().slice(0, 10)}.md`;
  shared.safeWrite(shared.uniquePath(path.join(MINIONS_DIR, 'notes', 'inbox', summaryFile)), summary);
  e.log('info', `PRD completion summary written to notes/inbox/${summaryFile}`);

  // Resolve the primary project for writing new work items (PR, verify)
  const projectName = plan.project;
  const primaryProject = projectName
    ? projects.find(p => p.name?.toLowerCase() === projectName?.toLowerCase()) : projects[0];
  const wiPath = primaryProject ? shared.projectWorkItemsPath(primaryProject) : null;
  const workItems = wiPath ? (safeJson(wiPath) || []) : [];

  // 3. For shared-branch plans, create PR work item
  if (plan.branch_strategy === 'shared-branch' && plan.feature_branch && wiPath) {
    const existingPrItem = allWorkItems.find(w => w.sourcePlan === planFile && w.itemType === 'pr');
    if (!existingPrItem) {
      const id = 'PL-' + shared.uid();
      const featureBranch = plan.feature_branch;
      const mainBranch = primaryProject.mainBranch || 'main';
      const itemSummary = doneItems.map(w => '- ' + w.id + ': ' + w.title.replace('Implement: ', '')).join('\n');
      workItems.push({
        id, title: `Create PR for plan: ${plan.plan_summary || planFile}`,
        type: 'implement', priority: 'high',
        description: `All plan items from \`${planFile}\` are complete on branch \`${featureBranch}\`.\n\n**Branch:** \`${featureBranch}\`\n**Target:** \`${mainBranch}\`\n\n## Completed Items\n${itemSummary}`,
        status: 'pending', created: e.ts(), createdBy: 'engine:plan-completion',
        sourcePlan: planFile, itemType: 'pr',
        branch: featureBranch, branchStrategy: 'shared-branch', project: projectName,
      });
      shared.safeWrite(wiPath, workItems);
    }
  }

  // 4. Create verification work item (build, test, start webapp, write testing guide)
  const existingVerify = allWorkItems.find(w => w.sourcePlan === planFile && w.itemType === 'verify');
  if (!existingVerify && doneItems.length > 0) {
    const verifyId = 'PL-' + shared.uid();
    const planSlug = planFile.replace('.json', '');

    // Group PRs by project — one worktree per project with all branches merged in
    const projectPrs = {}; // projectName -> { project, prs: [], mainBranch }
    for (const p of projects) {
      const prLinks = getPrLinks();
      const prs = (safeJson(shared.projectPrPath(p)) || [])
        .filter(pr => {
          const linkedId = prLinks[pr.id];
          return pr.status === 'active' && linkedId && doneItems.find(w => w.id === linkedId);
        });
      if (prs.length > 0) {
        projectPrs[p.name] = { project: p, prs, mainBranch: p.mainBranch || 'main' };
      }
    }

    // Build per-project checkout commands: one worktree, merge all PR branches into it
    const checkoutBlocks = Object.entries(projectPrs).map(([name, { project: p, prs, mainBranch }]) => {
      const wtPath = `${p.localPath}/../worktrees/verify-${name}-${planSlug}-${shared.uid()}`;
      const branches = prs.map(pr => pr.branch).filter(Boolean);
      const lines = [
        `# ${name} — merge ${branches.length} PR branch(es) into one worktree`,
        `cd "${p.localPath}"`,
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

    const description = [
      `Verification task for completed plan \`${planFile}\`.`,
      ``,
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

    workItems.push({
      id: verifyId,
      title: `Verify plan: ${(plan.plan_summary || planFile).slice(0, 80)}`,
      type: 'verify',
      priority: 'high',
      description,
      status: 'pending',
      created: e.ts(),
      createdBy: 'engine:plan-verification',
      sourcePlan: planFile,
      itemType: 'verify',
      project: projectName,
    });
    shared.safeWrite(wiPath, workItems);
    e.log('info', `Created verification work item ${verifyId} for plan ${planFile}`);
  }

  // 5. Archive: move PRD .json to prd/archive/ and source .md plan to plans/archive/
  const prdArchiveDir = path.join(PRD_DIR, 'archive');
  if (!fs.existsSync(prdArchiveDir)) fs.mkdirSync(prdArchiveDir, { recursive: true });
  shared.safeWrite(planPath, plan); // save completed status first
  try {
    fs.renameSync(planPath, path.join(prdArchiveDir, planFile));
    e.log('info', `Archived completed PRD: prd/archive/${planFile}`);
  } catch (err) {
    e.log('warn', `Failed to archive PRD ${planFile}: ${err.message}`);
    shared.safeWrite(planPath, plan);
  }

  // Also archive the source .md plan if it exists
  const planArchiveDir = path.join(PLANS_DIR, 'archive');
  if (!fs.existsSync(planArchiveDir)) fs.mkdirSync(planArchiveDir, { recursive: true });
  try {
    const mdFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    for (const md of mdFiles) {
      const mdContent = shared.safeRead(path.join(PLANS_DIR, md)) || '';
      // Match by project name or plan summary appearing in the .md content
      if (mdContent.includes(projectName) || mdContent.includes(plan.plan_summary?.slice(0, 40) || '___nomatch___')) {
        try {
          fs.renameSync(path.join(PLANS_DIR, md), path.join(planArchiveDir, md));
          e.log('info', `Archived source plan: plans/archive/${md}`);
        } catch (err) { e.log('warn', `Failed to archive plan ${md}: ${err.message}`); }
        break;
      }
    }
  } catch (err) { e.log('warn', `Plan archive scan: ${err.message}`); }

  // 6. Clean up ALL worktrees created for this plan's work items (shared-branch + per-item)
  try {
    // Collect all branch slugs: shared-branch + per-item branches + item IDs
    const branchSlugs = new Set();
    if (plan.feature_branch) branchSlugs.add(shared.sanitizeBranch(plan.feature_branch).toLowerCase());
    for (const w of doneItems) {
      if (w.branch) branchSlugs.add(shared.sanitizeBranch(w.branch).toLowerCase());
      if (w.id) branchSlugs.add(w.id.toLowerCase());
    }
    for (const pr of uniquePrs) {
      if (pr.branch) branchSlugs.add(shared.sanitizeBranch(pr.branch).toLowerCase());
    }

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
          try {
            execSilent(`git worktree remove "${wtPath}" --force`, { cwd: root, stdio: 'pipe', timeout: 15000 });
            cleanedWt++;
          } catch (err) { e.log('warn', `Failed to remove worktree ${dir}: ${err.message}`); }
        }
      }
    }
    if (cleanedWt > 0) e.log('info', `Plan completion: cleaned ${cleanedWt} worktree(s)`);
  } catch (err) { e.log('warn', `Worktree cleanup: ${err.message}`); }

  e.log('info', `PRD ${planFile} completed: ${doneItems.length} done, ${failedItems.length} failed, runtime ${runtimeMin}m`);
}

// ─── Plan → PRD Chaining ─────────────────────────────────────────────────────
function chainPlanToPrd(dispatchItem, meta, config) {
  const e = engine();
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
      e.log('warn', `Plan chaining: no plan files found in plans/ after task ${dispatchItem.id}`);
      return;
    }
    e.log('info', `Plan chaining: using mtime fallback — found ${planFileName}`);
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
        e.log('info', `Plan chaining: renamed ${planFileName} → ${mdName} (plans must be .md)`);
      }
    } catch {
      try {
        if (fs.existsSync(jsonPath)) fs.renameSync(jsonPath, path.join(planDir, mdName));
        planFileName = mdName;
        e.log('info', `Plan chaining: renamed to .md (not valid JSON)`);
      } catch (err) { e.log('warn', `Plan rename fallback: ${err.message}`); }
    }
  }

  const planFile = { name: planFileName };
  const planPath = path.join(planDir, planFileName);
  let planContent;
  try { planContent = fs.readFileSync(planPath, 'utf8'); } catch (err) {
    e.log('error', `Plan chaining: failed to read plan file ${planFile.name}: ${err.message}`);
    return;
  }

  const projectName = meta?.item?.project || meta?.project?.name;
  const projects = shared.getProjects(config);
  const targetProject = projectName
    ? projects.find(p => p.name === projectName) || projects[0]
    : projects[0];

  if (!targetProject) {
    e.log('error', 'Plan chaining: no target project available');
    return;
  }

  e.log('info', `Plan chaining: queuing plan-to-prd for next tick (chained from ${dispatchItem.id})`);
  const wiPath = path.join(MINIONS_DIR, 'work-items.json');
  let items = [];
  try { items = JSON.parse(fs.readFileSync(wiPath, 'utf8')); } catch {}
  items.push({
    id: 'W-' + shared.uid(),
    title: `Convert plan to PRD: ${meta?.item?.title || planFile.name}`,
    type: 'plan-to-prd',
    priority: meta?.item?.priority || 'high',
    description: `Plan file: plans/${planFile.name}\nChained from plan task ${dispatchItem.id}`,
    status: 'pending',
    created: e.ts(),
    createdBy: 'engine:chain',
    project: targetProject.name,
    planFile: planFile.name,
  });
  shared.safeWrite(wiPath, items);
}

// ─── Work Item Status ────────────────────────────────────────────────────────
function updateWorkItemStatus(meta, status, reason) {
  const e = engine();
  const itemId = meta.item?.id;
  if (!itemId) return;

  let wiPath;
  if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
    wiPath = path.join(MINIONS_DIR, 'work-items.json');
  } else if (meta.source === 'work-item' && meta.project?.name) {
    wiPath = path.join(MINIONS_DIR, 'projects', meta.project.name, 'work-items.json');
  }
  if (!wiPath) return;

  const items = safeJson(wiPath);
  if (!items || !Array.isArray(items)) return;

  const target = items.find(i => i.id === itemId);
  if (target) {
    if (meta.source === 'central-work-item-fanout') {
      if (!target.agentResults) target.agentResults = {};
      const parts = (meta.dispatchKey || '').split('-');
      const agent = parts[parts.length - 1] || 'unknown';
      target.agentResults[agent] = { status, completedAt: e.ts(), reason: reason || undefined };

      const results = Object.values(target.agentResults);
      const anySuccess = results.some(r => r.status === 'done');
      const allDone = Array.isArray(target.fanOutAgents) && target.fanOutAgents.length > 0 ? results.length >= target.fanOutAgents.length : false;
      const dispatchAge = target.dispatched_at ? Date.now() - new Date(target.dispatched_at).getTime() : 0;
      const timedOut = !allDone && dispatchAge > 6 * 60 * 60 * 1000 && results.length > 0;

      if (anySuccess) {
        target.status = 'done';
        delete target.failReason;
        delete target.failedAt;
        target.completedAgents = Object.entries(target.agentResults)
          .filter(([, r]) => r.status === 'done')
          .map(([a]) => a);
      } else if (allDone || timedOut) {
        target.status = 'failed';
        target.failReason = timedOut
          ? `Fan-out timed out: ${results.length}/${(target.fanOutAgents || []).length} agents reported (all failed)`
          : 'All fan-out agents failed';
        target.failedAt = e.ts();
      }
    } else {
      target.status = status;
      if (status === 'done') {
        delete target.failReason;
        delete target.failedAt;
        target.completedAt = e.ts();
      } else if (status === 'failed') {
        if (reason) target.failReason = reason;
        target.failedAt = e.ts();
      }
    }

    shared.safeWrite(wiPath, items);
    e.log('info', `Work item ${itemId} → ${status}${reason ? ': ' + reason : ''}`);

    // Sync status to PRD JSON so the two share the same value (work item is source of truth)
    syncPrdItemStatus(itemId, status, meta.item?.sourcePlan);
  }
}

function syncPrdItemStatus(itemId, status, sourcePlan) {
  if (!itemId) return;
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
  } catch (err) { engine().log('warn', `PRD status sync: ${err.message}`); }
}

// ─── PR Sync from Output ─────────────────────────────────────────────────────

function syncPrsFromOutput(output, agentId, meta, config) {
  const e = engine();
  const prMatches = new Set();
  const urlPattern = /(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+)/g;
  let match;

  try {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        if (!line.includes('"type":"assistant"') && !line.includes('"type":"result"')) continue;
        const parsed = JSON.parse(line);
        const content = parsed.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_result' && block.content) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            if (text.includes('pullRequestId') || text.includes('create_pull_request')) {
              while ((match = urlPattern.exec(text)) !== null) prMatches.add(match[1] || match[2]);
            }
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

  const today = e.dateStamp();
  const inboxFiles = getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
  for (const f of inboxFiles) {
    const content = safeRead(path.join(INBOX_DIR, f));
    const prHeaderPattern = /\*\*PR[:\*]*\*?\s*[#-]*\s*(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
    while ((match = prHeaderPattern.exec(content)) !== null) prMatches.add(match[1] || match[2]);
  }

  if (prMatches.size === 0) return 0;

  const projects = shared.getProjects(config);
  const defaultProject = (meta?.project?.name && projects.find(p => p.name === meta.project.name)) || projects[0];
  if (!defaultProject) return 0;

  // Match each PR to its correct project by finding which repo URL appears near the PR number in output
  function resolveProjectForPr(prId) {
    // Look for the PR URL in output to determine which ADO project it belongs to
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

  const agentName = config.agents?.[agentId]?.name || agentId;
  let added = 0;
  // Track which project PR files need writing
  const dirtyProjects = new Map(); // projectName -> { project, prs, prPath }

  for (const prId of prMatches) {
    const fullId = `PR-${prId}`;
    const targetProject = resolveProjectForPr(prId);
    const prPath = shared.projectPrPath(targetProject);

    // Load PRs for this project (cache per project)
    if (!dirtyProjects.has(targetProject.name)) {
      dirtyProjects.set(targetProject.name, { project: targetProject, prs: safeJson(prPath) || [], prPath });
    }
    const entry = dirtyProjects.get(targetProject.name);
    if (entry.prs.some(p => p.id === fullId || String(p.id).includes(prId))) continue;

    let title = meta?.item?.title || '';
    const titleMatch = output.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
    if (titleMatch) title = titleMatch[1].trim();
    if (title.includes('session_id') || title.includes('is_error') || title.includes('uuid') || title.length > 120) {
      title = meta?.item?.title || '';
    }
    entry.prs.push({
      id: fullId,
      title: (title || `PR created by ${agentName}`).slice(0, 120),
      agent: agentName,
      branch: meta?.branch || '',
      reviewStatus: 'pending',
      status: 'active',
      created: e.dateStamp(),
      url: targetProject.prUrlBase ? targetProject.prUrlBase + prId : '',
      prdItems: meta?.item?.id ? [meta.item.id] : [],
      sourcePlan: meta?.item?.sourcePlan || '',
      itemType: meta?.item?.itemType || ''
    });
    if (meta?.item?.id) addPrLink(fullId, meta.item.id);
    added++;
  }

  for (const [name, entry] of dirtyProjects) {
    shared.safeWrite(entry.prPath, entry.prs);
    e.log('info', `Synced PR(s) from ${agentName}'s output to ${name}/pull-requests.json`);
  }
  return added;
}

// ─── Post-Completion Hooks ──────────────────────────────────────────────────

function updatePrAfterReview(agentId, pr, project) {
  const e = engine();
  if (!pr?.id) return;
  const prs = getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  const config = getConfig();
  const reviewerName = config.agents[agentId]?.name || agentId;
  // Record the reviewer — actual verdict comes from ADO/GitHub votes via pollPrStatus.
  // Set to 'waiting' so pollPrStatus updates it with the real vote on next cycle.
  const dispatch = getDispatch();
  const completedEntry = (dispatch.completed || []).find(d => d.agent === agentId && d.type === 'review');

  // Set reviewStatus to 'waiting' (single source of truth — synced from ADO/GitHub votes on next poll)
  target.reviewStatus = 'waiting';
  target.minionsReview = {
    reviewer: reviewerName,
    reviewedAt: e.ts(),
    note: completedEntry?.task || ''
  };
  // Metrics update: don't track 'waiting' as a verdict — metrics are updated
  // when pollPrStatus syncs the actual vote to minionsReview.status.
  // The reviewer's reviewsDone counter is incremented in the main updateMetrics call.

  // Track reviewer for metrics purposes
  const authorAgentId = (pr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath) || {};
    if (!metrics[authorAgentId]) metrics[authorAgentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    if (!metrics[agentId]) metrics[agentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    metrics[agentId].reviewsDone = (metrics[agentId].reviewsDone || 0) + 1;
    shared.safeWrite(metricsPath, metrics);
  }

  shared.safeWrite(project ? shared.projectPrPath(project) : path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json'), prs);
  e.log('info', `Updated ${pr.id} → minions review: ${minionsVerdict} by ${reviewerName}`);
  createReviewFeedbackForAuthor(agentId, { ...pr, ...target }, config);
}

function updatePrAfterFix(pr, project, source) {
  const e = engine();
  if (!pr?.id) return;
  const prs = getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  // Reset reviewStatus to 'waiting' for re-review (single source of truth)
  target.reviewStatus = 'waiting';
  if (source === 'pr-human-feedback') {
    if (target.humanFeedback) target.humanFeedback.pendingFix = false;
    target.minionsReview = { ...target.minionsReview, note: 'Fixed human feedback, awaiting re-review', fixedAt: e.ts() };
    e.log('info', `Updated ${pr.id} → cleared humanFeedback.pendingFix, reset to waiting for re-review`);
  } else {
    target.minionsReview = { ...target.minionsReview, note: 'Fixed, awaiting re-review', fixedAt: e.ts() };
    e.log('info', `Updated ${pr.id} → reviewStatus: waiting (fix pushed)`);
  }

  shared.safeWrite(project ? shared.projectPrPath(project) : path.join(path.resolve(MINIONS_DIR, '..'), '.minions', 'pull-requests.json'), prs);
}

// ─── Post-Merge / Post-Close Hooks ───────────────────────────────────────────

async function handlePostMerge(pr, project, config, newStatus) {
  const e = engine();
  const prNum = (pr.id || '').replace('PR-', '');

  if (pr.branch) {
    const root = path.resolve(project.localPath);
    const wtRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    // Find worktrees matching this branch — dir format is {slug}-{branch}-{suffix}
    const branchSlug = shared.sanitizeBranch(pr.branch).toLowerCase();
    try {
      const dirs = require('fs').readdirSync(wtRoot);
      for (const dir of dirs) {
        const dirLower = dir.toLowerCase();
        if (dirLower.includes(branchSlug) || dir === pr.branch || dir === `bt-${prNum}`) {
          const wtPath = path.join(wtRoot, dir);
          try {
            if (!require('fs').statSync(wtPath).isDirectory()) continue;
            execSilent(`git worktree remove "${wtPath}" --force`, { cwd: root, stdio: 'pipe', timeout: 15000 });
            e.log('info', `Post-merge cleanup: removed worktree ${dir}`);
          } catch (err) { e.log('warn', `Failed to remove worktree ${dir}: ${err.message}`); }
        }
      }
    } catch (err) { e.log('warn', `Post-merge worktree cleanup: ${err.message}`); }
  }

  if (newStatus !== 'merged') return;

  const mergedItemId = getPrLinks()[pr.id];
  if (mergedItemId) {
    const prdDir = path.join(MINIONS_DIR, 'prd');
    try {
      const planFiles = fs.readdirSync(prdDir).filter(f => f.endsWith('.json'));
      let updated = 0;
      for (const pf of planFiles) {
        const plan = safeJson(path.join(prdDir, pf));
        if (!plan?.missing_features) continue;
        const feature = plan.missing_features.find(f => f.id === mergedItemId);
        if (feature && feature.status !== 'implemented') {
          feature.status = 'implemented';
          shared.safeWrite(path.join(prdDir, pf), plan);
          updated++;
        }
      }
      if (updated > 0) e.log('info', `Post-merge: marked ${mergedItemId} as implemented for ${pr.id}`);
    } catch (err) { e.log('warn', `Post-merge PRD update: ${err.message}`); }
  }

  const agentId = (pr.agent || '').toLowerCase();
  if (agentId && config.agents?.[agentId]) {
    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath) || {};
    if (!metrics[agentId]) metrics[agentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, prsMerged:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    metrics[agentId].prsMerged = (metrics[agentId].prsMerged || 0) + 1;
    shared.safeWrite(metricsPath, metrics);
  }

  const teamsUrl = process.env.TEAMS_PLAN_FLOW_URL;
  if (teamsUrl) {
    try {
      await fetch(teamsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `PR ${pr.id} merged: ${pr.title} (${project.name}) by ${pr.agent || 'unknown'}` })
      });
    } catch (err) { e.log('warn', `Teams post-merge notify failed: ${err.message}`); }
  }

  e.log('info', `Post-merge hooks completed for ${pr.id}`);
}

function checkForLearnings(agentId, agentInfo, taskDesc) {
  const e = engine();
  const today = e.dateStamp();
  const inboxFiles = getInboxFiles();
  const agentFiles = inboxFiles.filter(f => f.includes(agentId) && f.includes(today));
  if (agentFiles.length > 0) {
    e.log('info', `${agentInfo?.name || agentId} wrote ${agentFiles.length} finding(s) to inbox`);
    return;
  }
  e.log('warn', `${agentInfo?.name || agentId} didn't write learnings — no follow-up queued`);
}

function extractSkillsFromOutput(output, agentId, dispatchItem, config) {
  const e = engine();
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
  let match;
  while ((match = skillRegex.exec(fullText)) !== null) {
    skillBlocks.push(match[1].trim());
  }
  if (skillBlocks.length === 0) return;
  const agentName = config.agents[agentId]?.name || agentId;
  for (const block of skillBlocks) {
    const fmMatch = block.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) { e.log('warn', `Skill block from ${agentName} has no frontmatter, skipping`); continue; }
    const fm = fmMatch[1];
    const m = (key) => { const r = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return r ? r[1].trim() : ''; };
    const name = m('name');
    if (!name) { e.log('warn', `Skill block from ${agentName} has no name, skipping`); continue; }
    const scope = m('scope') || 'minions';
    const project = m('project');
    let enrichedBlock = block;
    if (!m('author')) enrichedBlock = enrichedBlock.replace('---\n', `---\nauthor: ${agentName}\n`);
    if (!m('created')) enrichedBlock = enrichedBlock.replace('---\n', `---\ncreated: ${e.dateStamp()}\n`);
    const filename = name.replace(/[^a-z0-9-]/g, '-') + '.md';
    if (scope === 'project' && project) {
      const proj = shared.getProjects(config).find(p => p.name === project);
      if (proj) {
        const centralPath = path.join(MINIONS_DIR, 'work-items.json');
        const items = safeJson(centralPath) || [];
        const alreadyExists = items.some(i => i.title === `Add skill: ${name}` && i.status !== 'failed');
        if (!alreadyExists) {
          const skillId = `SK${String(items.filter(i => i.id?.startsWith('SK')).length + 1).padStart(3, '0')}`;
          items.push({ id: skillId, type: 'implement', title: `Add skill: ${name}`,
            description: `Create project-level skill \`${filename}\` in ${project}.\n\nWrite this file to \`${proj.localPath}/.claude/skills/${filename}\` via a PR.\n\n## Skill Content\n\n\`\`\`\n${enrichedBlock}\n\`\`\``,
            priority: 'low', status: 'queued', created: e.ts(), createdBy: `engine:skill-extraction:${agentName}` });
          shared.safeWrite(centralPath, items);
          e.log('info', `Queued work item ${skillId} to PR project skill "${name}" into ${project}`);
        }
      }
    } else {
      // Write in Claude Code native format: ~/.claude/skills/<name>/SKILL.md
      const claudeSkillsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
      const skillDir = path.join(claudeSkillsDir, name.replace(/[^a-z0-9-]/g, '-'));
      const skillPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        // Convert to Claude Code format: only name + description in frontmatter
        const description = m('description') || m('trigger') || `Auto-extracted skill from ${agentName}`;
        const body = fmMatch[2] || '';
        const ccContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
        if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
        shared.safeWrite(skillPath, ccContent);
        e.log('info', `Extracted skill "${name}" from ${agentName} → ~/.claude/skills/${name.replace(/[^a-z0-9-]/g, '-')}/SKILL.md`);
      } else {
        e.log('info', `Skill "${name}" already exists, skipping`);
      }

    }
  }
}

function updateAgentHistory(agentId, dispatchItem, result) {
  const e = engine();
  const historyPath = path.join(AGENTS_DIR, agentId, 'history.md');
  let history = safeRead(historyPath) || '# Agent History\n\n';
  const entry = `### ${e.ts()} — ${result}\n` +
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
  e.log('info', `Updated history for ${agentId}`);
}

function createReviewFeedbackForAuthor(reviewerAgentId, pr, config) {
  const e = engine();
  if (!pr?.id || !pr?.agent) return;
  const authorAgentId = pr.agent.toLowerCase();
  if (!config.agents[authorAgentId]) return;
  const today = e.dateStamp();
  const inboxFiles = getInboxFiles();
  const reviewFiles = inboxFiles.filter(f => f.includes(reviewerAgentId) && f.includes(today));
  if (reviewFiles.length === 0) return;
  const reviewContent = reviewFiles.map(f => safeRead(path.join(INBOX_DIR, f))).join('\n\n');
  const feedbackFile = `feedback-${authorAgentId}-from-${reviewerAgentId}-${pr.id}-${today}.md`;
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
  e.log('info', `Created review feedback for ${authorAgentId} from ${reviewerAgentId} on ${pr.id}`);
}

function updateMetrics(agentId, dispatchItem, result, taskUsage, prsCreatedCount) {
  const e = engine();
  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  const metrics = safeJson(metricsPath) || {};
  if (!metrics[agentId]) {
    metrics[agentId] = { tasksCompleted: 0, tasksErrored: 0, prsCreated: 0, prsApproved: 0, prsRejected: 0,
      reviewsDone: 0, lastTask: null, lastCompleted: null, totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0 };
  }
  const m = metrics[agentId];
  m.lastTask = dispatchItem.task;
  m.lastCompleted = e.ts();
  if (result === 'success') {
    m.tasksCompleted++;
    if (prsCreatedCount > 0) m.prsCreated = (m.prsCreated || 0) + prsCreatedCount;
    if (dispatchItem.type === 'review') m.reviewsDone++;
  } else if (result === 'retry') {
    // Auto-retry: count cost but not as a final outcome
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
  const today = e.dateStamp();
  if (!metrics._daily) metrics._daily = {};
  if (!metrics._daily[today]) metrics._daily[today] = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, tasks: 0 };
  const daily = metrics._daily[today];
  daily.tasks++;
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
  shared.safeWrite(metricsPath, metrics);
}

// ─── Agent Output Parsing ────────────────────────────────────────────────────

function parseAgentOutput(stdout) {
  const { text, usage, sessionId } = shared.parseStreamJsonOutput(stdout, { maxTextLength: 2000 });
  return { resultSummary: text, taskUsage: usage, sessionId };
}

/**
 * Handle decomposition result — parse sub-items from agent output and create child work items.
 * Called from runPostCompletionHooks when type === 'decompose'.
 */
function handleDecompositionResult(stdout, meta, config) {
  const e = engine();
  const parentId = meta?.item?.id;
  if (!parentId) return 0;

  // Parse sub-items JSON from agent output
  const { text } = shared.parseStreamJsonOutput(stdout);
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (!jsonMatch) {
    e.log('warn', `Decomposition for ${parentId}: no JSON block found in output`);
    return 0;
  }

  let decomposition;
  try {
    decomposition = JSON.parse(jsonMatch[1]);
  } catch (err) {
    e.log('warn', `Decomposition for ${parentId}: invalid JSON — ${err.message}`);
    return 0;
  }

  const subItems = decomposition.sub_items || decomposition.subItems || [];
  if (subItems.length === 0) {
    e.log('warn', `Decomposition for ${parentId}: no sub-items produced`);
    return 0;
  }

  // Find and update the parent work item
  const projects = shared.getProjects(config);
  const allPaths = [path.join(MINIONS_DIR, 'work-items.json')];
  for (const p of projects) allPaths.push(shared.projectWorkItemsPath(p));

  for (const wiPath of allPaths) {
    const items = safeJson(wiPath) || [];
    const parent = items.find(i => i.id === parentId);
    if (!parent) continue;

    // Mark parent as decomposed
    parent.status = 'decomposed';
    parent._decomposed = true;
    delete parent._decomposing;
    parent._subItemIds = subItems.map(s => s.id);

    // Create child work items
    for (const sub of subItems) {
      if (items.some(i => i.id === sub.id)) continue; // dedupe
      items.push({
        id: sub.id,
        title: sub.name || sub.title || `Sub-task of ${parentId}`,
        type: (sub.estimated_complexity === 'large') ? 'implement:large' : 'implement',
        priority: sub.priority || parent.priority || 'medium',
        description: sub.description || '',
        status: 'pending',
        complexity: sub.estimated_complexity || 'medium',
        depends_on: sub.depends_on || [],
        parent_id: parentId,
        sourcePlan: parent.sourcePlan,
        branchStrategy: parent.branchStrategy,
        featureBranch: parent.featureBranch,
        created: new Date().toISOString(),
        createdBy: 'decomposition',
      });
    }

    safeWrite(wiPath, items);
    e.log('info', `Decomposition: ${parentId} → ${subItems.length} sub-items: ${subItems.map(s => s.id).join(', ')}`);
    return subItems.length;
  }

  return 0;
}

function runPostCompletionHooks(dispatchItem, agentId, code, stdout, config) {
  const e = engine();
  const type = dispatchItem.type;
  const meta = dispatchItem.meta;
  const isSuccess = code === 0;
  const result = isSuccess ? 'success' : 'error';
  const { resultSummary, taskUsage, sessionId } = parseAgentOutput(stdout);

  // Save session for potential resume on next dispatch
  if (isSuccess && sessionId && agentId && !agentId.startsWith('temp-')) {
    try {
      shared.safeWrite(path.join(AGENTS_DIR, agentId, 'session.json'), {
        sessionId, dispatchId: dispatchItem.id, savedAt: new Date().toISOString(),
        branch: dispatchItem.meta?.branch || null,
      });
    } catch (err) { engine().log('warn', `Session save: ${err.message}`); }
  }

  // Handle decomposition results — create sub-items from decompose agent output
  let skipDoneStatus = false;
  if (type === 'decompose' && isSuccess && meta?.item?.id) {
    const subCount = handleDecompositionResult(stdout, meta, config);
    if (subCount > 0) skipDoneStatus = true; // parent already marked 'decomposed' by handler
    // If decomposition produced nothing, fall through to mark parent as done
  }

  if (isSuccess && meta?.item?.id && !skipDoneStatus) updateWorkItemStatus(meta, 'done', '');
  if (!isSuccess && meta?.item?.id) {
    // Auto-retry: read fresh _retryCount from file (not stale dispatch-time snapshot)
    let retries = (meta.item._retryCount || 0);
    try {
      const wiPath = meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout'
        ? path.join(MINIONS_DIR, 'work-items.json')
        : meta.project?.name ? path.join(MINIONS_DIR, 'projects', meta.project.name, 'work-items.json') : null;
      if (wiPath) {
        const items = safeJson(wiPath) || [];
        const wi = items.find(i => i.id === meta.item.id);
        if (wi) retries = (wi._retryCount || 0); // Use fresh value from file
      }
    } catch { /* optional */ }

    if (retries < 3) {
      e.log('info', `Agent failed for ${meta.item.id} — auto-retry ${retries + 1}/3`);
      updateWorkItemStatus(meta, 'pending', '');
      try {
        const wiPath = meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout'
          ? path.join(MINIONS_DIR, 'work-items.json')
          : meta.project?.name ? path.join(MINIONS_DIR, 'projects', meta.project.name, 'work-items.json') : null;
        if (wiPath) {
          const items = safeJson(wiPath) || [];
          const wi = items.find(i => i.id === meta.item.id);
          if (wi) {
            wi._retryCount = retries + 1; wi.status = 'pending'; delete wi.dispatched_at; delete wi.dispatched_to;
            if (type === 'decompose') delete wi._decomposing; // clear so item can retry decomposition
            shared.safeWrite(wiPath, items);
          }
        }
      } catch (err) { e.log('warn', `Retry update: ${err.message}`); }
    } else {
      updateWorkItemStatus(meta, 'failed', 'Agent failed (3 retries exhausted)');
    }
    // Clear _decomposing flag on failure so item doesn't get permanently stuck
    if (type === 'decompose') {
      try {
        const wiPath = meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout'
          ? path.join(MINIONS_DIR, 'work-items.json')
          : meta.project?.name ? path.join(MINIONS_DIR, 'projects', meta.project.name, 'work-items.json') : null;
        if (wiPath) {
          const items = safeJson(wiPath) || [];
          const wi = items.find(i => i.id === meta.item.id);
          if (wi) { delete wi._decomposing; shared.safeWrite(wiPath, items); }
        }
      } catch (err) { e.log('warn', `Decompose cleanup: ${err.message}`); }
    }
  }
  // Meeting post-completion: collect findings/debate/conclusion
  if (type === 'meeting' && meta?.meetingId) {
    try {
      const { collectMeetingFindings } = require('./meeting');
      collectMeetingFindings(meta.meetingId, agentId, meta.roundName, stdout);
    } catch (err) { engine().log('warn', `Meeting collect: ${err.message}`); }
  }

  // Plan chaining removed — user must explicitly execute plan-to-prd after reviewing the plan
  if (isSuccess && meta?.item?.sourcePlan) checkPlanCompletion(meta, config);

  let prsCreatedCount = 0;
  if (isSuccess) prsCreatedCount = syncPrsFromOutput(stdout, agentId, meta, config) || 0;

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
          return d.includes(branchSlug) && fs.statSync(path.join(worktreeRoot, d)).isDirectory();
        });
        // Only remove if no other active dispatch uses this branch
        const dispatch = e.getDispatch();
        const otherActive = ((dispatch.active || []).concat(dispatch.pending || [])).some(d =>
          d.id !== dispatchItem.id && d.meta?.branch && shared.sanitizeBranch && shared.sanitizeBranch(d.meta.branch) === branchSlug
        );
        if (!otherActive) {
          for (const dir of dirs) {
            const wtPath = path.join(worktreeRoot, dir);
            try {
              shared.exec(`git worktree remove "${wtPath}" --force`, { cwd: rootDir, stdio: 'pipe', timeout: 15000, windowsHide: true });
              e.log('info', `Post-completion: removed worktree ${dir}`);
            } catch (err) {
              e.log('warn', `Post-completion: failed to remove worktree ${dir}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      e.log('warn', `Post-completion worktree cleanup error: ${err.message}`);
    }
  }

  // Detect implement tasks that completed without creating a PR
  if (isSuccess && (type === 'implement' || type === 'implement:large' || type === 'fix') && prsCreatedCount === 0 && meta?.item?.id) {
    // Check if a PR already exists linked to this work item (from a previous attempt)
    const projects = shared.getProjects(config);
    const existingPrFound = Object.values(getPrLinks()).includes(meta.item.id);
    if (!existingPrFound) {
      e.log('warn', `Agent completed implement task ${meta.item.id} but no PR was created`);
      // Set noPr flag on the work item so the dashboard can surface this
      let wiPath;
      if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
        wiPath = path.join(MINIONS_DIR, 'work-items.json');
      } else if (meta.project?.localPath) {
        wiPath = shared.projectWorkItemsPath(meta.project);
      }
      if (wiPath) {
        const items = safeJson(wiPath) || [];
        const wi = items.find(i => i.id === meta.item.id);
        if (wi) {
          wi.noPr = true;
          shared.safeWrite(wiPath, items);
        }
      }
    }
  }

  if (type === 'review') updatePrAfterReview(agentId, meta?.pr, meta?.project);
  if (type === 'fix') updatePrAfterFix(meta?.pr, meta?.project, meta?.source);
  checkForLearnings(agentId, config.agents[agentId], dispatchItem.task);
  if (isSuccess) extractSkillsFromOutput(stdout, agentId, dispatchItem, config);
  updateAgentHistory(agentId, dispatchItem, result);
  // Don't count auto-retries as errors in metrics — only count final outcomes
  const isAutoRetry = !isSuccess && meta?.item?.id && (meta.item._retryCount || 0) < 3;
  const metricsResult = isAutoRetry ? 'retry' : result;
  updateMetrics(agentId, dispatchItem, metricsResult, taskUsage, prsCreatedCount);

  return { resultSummary, taskUsage };
}

// ─── PR → PRD Status Sync ─────────────────────────────────────────────────────
// Runs every 6 ticks (~3 min). For all pending work items across all projects,
// runs the reconciliation pass to catch PRs created after materialization
// (e.g., manually raised PRs, cross-plan PRs, or PRs created while engine was paused).
function syncPrdFromPrs(config) {
  try {
    const { getProjects, projectWorkItemsPath, projectPrPath, safeJson, safeWrite } = require('./shared');
    const { reconcileItemsWithPrs } = require('../engine');
    config = config || queries.getConfig();
    const allProjects = getProjects(config);

    // Exact prdItems match only — no fuzzy matching
    const allPrs = allProjects.flatMap(p => safeJson(projectPrPath(p)) || []);

    let totalReconciled = 0;
    for (const project of allProjects) {
      const wiPath = projectWorkItemsPath(project);
      const items = safeJson(wiPath) || [];
      const hasPending = items.some(wi => wi.status === 'pending' && !wi._pr);
      if (!hasPending) continue;
      const reconciled = reconcileItemsWithPrs(items, allPrs);
      if (reconciled > 0) {
        safeWrite(wiPath, items);
        // Sync done status to PRD JSON for each newly reconciled item
        for (const wi of items) {
          if (wi.status === 'done') syncPrdItemStatus(wi.id, 'done', wi.sourcePlan);
        }
        totalReconciled += reconciled;
      }
    }
    if (totalReconciled > 0) {
      engine().log('info', `PR sync: reconciled ${totalReconciled} pending work item(s) to done`);
    }
  } catch (err) {
    // Non-fatal — log and continue
    try { engine().log('warn', `syncPrdFromPrs error: ${err?.message || err}`); } catch { /* engine not available */ }
  }
}

module.exports = {
  checkPlanCompletion,
  updateWorkItemStatus,
  syncPrdItemStatus,
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
  runPostCompletionHooks,
  syncPrdFromPrs,
};

