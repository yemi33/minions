/**
 * engine/lifecycle.js — Post-completion hooks, PR sync, agent history/metrics, plan chaining.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const shared = require('./shared');
const { trackEngineUsage } = require('./llm');

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
  const plan = e.safeJson(path.join(e.PLANS_DIR, planFile));
  if (!plan?.missing_features || plan.branch_strategy !== 'shared-branch') return;
  if (plan.status === 'completed') return;
  const projectName = plan.project;
  const projects = shared.getProjects(config);
  const project = projectName
    ? projects.find(p => p.name?.toLowerCase() === projectName?.toLowerCase()) : projects[0];
  if (!project) return;
  const wiPath = shared.projectWorkItemsPath(project);
  const workItems = e.safeJson(wiPath) || [];
  const planItems = workItems.filter(w => w.sourcePlan === planFile && w.planItemId !== 'PR');
  if (planItems.length === 0) return;
  if (!planItems.every(w => w.status === 'done')) return;

  const existingPrItem = workItems.find(w => w.sourcePlan === planFile && w.planItemId === 'PR');
  if (existingPrItem) {
    e.log('debug', `Plan ${planFile} already has PR item ${existingPrItem.id} — skipping`);
    if (plan.status !== 'completed') { plan.status = 'completed'; plan.completedAt = e.ts(); shared.safeWrite(path.join(e.PLANS_DIR, planFile), plan); }
    return;
  }
  e.log('info', `All ${planItems.length} items in plan ${planFile} completed — creating PR work item`);
  const id = shared.nextWorkItemId(workItems, 'PL-W');
  const featureBranch = plan.feature_branch;
  const mainBranch = project.mainBranch || 'main';
  const itemSummary = planItems.map(w => '- ' + w.planItemId + ': ' + w.title.replace('Implement: ', '')).join('\n');
  workItems.push({
    id, title: `Create PR for plan: ${plan.plan_summary || planFile}`,
    type: 'implement', priority: 'high',
    description: `All plan items from \`${planFile}\` are complete on branch \`${featureBranch}\`.\nCreate a pull request and clean up the worktree.\n\n**Branch:** \`${featureBranch}\`\n**Target:** \`${mainBranch}\`\n\n## Completed Items\n${itemSummary}\n\n## Instructions\n1. Rebase onto ${mainBranch} if needed (abort if conflicts — PR as-is is fine)\n2. Push: git push origin ${featureBranch} --force-with-lease\n3. Create the PR targeting ${mainBranch}\n4. Cleanup: git worktree remove ../worktrees/${featureBranch} --force`,
    status: 'pending', created: e.ts(), createdBy: 'engine:plan-completion',
    sourcePlan: planFile, planItemId: 'PR',
    branch: featureBranch, branchStrategy: 'shared-branch', project: projectName,
  });
  shared.safeWrite(wiPath, workItems);
  plan.status = 'completed'; plan.completedAt = e.ts();
  shared.safeWrite(path.join(e.PLANS_DIR, planFile), plan);
}

// ─── Plan → PRD Chaining ─────────────────────────────────────────────────────
function chainPlanToPrd(dispatchItem, meta, config) {
  const e = engine();
  const planDir = path.join(e.SQUAD_DIR, 'plans');
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
    const jsonPath = path.join(planDir, planFileName);
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
        fs.renameSync(jsonPath, path.join(planDir, mdName));
        planFileName = mdName;
        e.log('info', `Plan chaining: renamed to .md (not valid JSON)`);
      } catch {}
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
  const wiPath = path.join(e.SQUAD_DIR, 'work-items.json');
  let items = [];
  try { items = JSON.parse(fs.readFileSync(wiPath, 'utf8')); } catch {}
  items.push({
    id: shared.nextWorkItemId(items, 'W'),
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

  if (meta.source === 'plan' && meta.planFile) {
    const planPath = path.join(e.PLANS_DIR, meta.planFile);
    const plan = e.safeJson(planPath);
    if (plan?.missing_features) {
      const feature = plan.missing_features.find(f => f.id === itemId);
      if (feature) {
        feature.status = status === 'done' ? 'implemented' : status === 'failed' ? 'failed' : feature.status;
        if (status === 'done') feature.implementedAt = e.ts();
        if (status === 'failed' && reason) feature.failReason = reason;
        shared.safeWrite(planPath, plan);
        e.log('info', `Plan item ${itemId} (${meta.planFile}) → ${feature.status}`);
      }
    }
    return;
  }

  let wiPath;
  if (meta.source === 'central-work-item' || meta.source === 'central-work-item-fanout') {
    wiPath = path.join(e.SQUAD_DIR, 'work-items.json');
  } else if (meta.source === 'work-item' && meta.project?.localPath) {
    const root = path.resolve(meta.project.localPath);
    const config = e.getConfig();
    const proj = (config.projects || []).find(p => p.name === meta.project.name);
    const wiSrc = proj?.workSources?.workItems || config.workSources?.workItems || {};
    wiPath = path.resolve(root, wiSrc.path || '.squad/work-items.json');
  }
  if (!wiPath) return;

  const items = e.safeJson(wiPath);
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
      const allDone = target.fanOutAgents ? results.length >= target.fanOutAgents.length : false;
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
  }
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
          const createdIdPattern = /(?:created|opened|submitted|new)\s+PR[# -]*(\d{5,})/gi;
          while ((match = createdIdPattern.exec(resultText)) !== null) prMatches.add(match[1]);
        }
      } catch {}
    }
  } catch {}

  const today = e.dateStamp();
  const inboxFiles = e.getInboxFiles().filter(f => f.includes(agentId) && f.includes(today));
  for (const f of inboxFiles) {
    const content = e.safeRead(path.join(e.INBOX_DIR, f));
    const prHeaderPattern = /\*\*PR[:\*]*\*?\s*[#-]*\s*(?:(?:visualstudio\.com|dev\.azure\.com)[^\s"]*?pullrequest\/(\d+)|github\.com\/[^\s"]*?\/pull\/(\d+))/gi;
    while ((match = prHeaderPattern.exec(content)) !== null) prMatches.add(match[1] || match[2]);
  }

  if (prMatches.size === 0) return 0;

  const projects = shared.getProjects(config);
  let targetProject = null;
  if (meta?.project?.name) {
    targetProject = projects.find(p => p.name === meta.project.name);
  }
  if (!targetProject) {
    for (const p of projects) {
      if (p.prUrlBase && output.includes(p.prUrlBase.replace(/pullrequest\/$/, ''))) { targetProject = p; break; }
      if (p.repoName && output.includes(`_git/${p.repoName}`)) { targetProject = p; break; }
    }
  }
  if (!targetProject) targetProject = projects[0];
  if (!targetProject) return;

  const prPath = shared.projectPrPath(targetProject);
  const prs = e.safeJson(prPath) || [];
  const agentName = config.agents?.[agentId]?.name || agentId;
  let added = 0;

  for (const prId of prMatches) {
    const fullId = `PR-${prId}`;
    if (prs.some(p => p.id === fullId || String(p.id).includes(prId))) continue;
    let title = meta?.item?.title || '';
    const titleMatch = output.match(new RegExp(`${prId}[^\\n]*?[—–-]\\s*([^\\n]+)`, 'i'));
    if (titleMatch) title = titleMatch[1].trim();
    if (title.includes('session_id') || title.includes('is_error') || title.includes('uuid') || title.length > 120) {
      title = meta?.item?.title || '';
    }
    prs.push({
      id: fullId,
      title: (title || `PR created by ${agentName}`).slice(0, 120),
      agent: agentName,
      branch: meta?.branch || '',
      reviewStatus: 'pending',
      status: 'active',
      created: e.dateStamp(),
      url: targetProject.prUrlBase ? targetProject.prUrlBase + prId : '',
      prdItems: meta?.item?.id ? [meta.item.id] : []
    });
    added++;
  }

  if (added > 0) {
    shared.safeWrite(prPath, prs);
    e.log('info', `Synced ${added} PR(s) from ${agentName}'s output to ${targetProject.name}/pull-requests.json`);
  }
  return added;
}

// ─── Post-Completion Hooks ──────────────────────────────────────────────────

function updatePrAfterReview(agentId, pr, project) {
  const e = engine();
  if (!pr?.id) return;
  const prs = e.getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;

  const agentStatus = e.getAgentStatus(agentId);
  const verdict = agentStatus.verdict || 'reviewed';
  const config = e.getConfig();
  const reviewerName = config.agents[agentId]?.name || agentId;
  const isChangesRequested = verdict.toLowerCase().includes('request') || verdict.toLowerCase().includes('change');
  const squadVerdict = isChangesRequested ? 'changes-requested' : 'approved';

  target.squadReview = {
    status: squadVerdict,
    reviewer: reviewerName,
    reviewedAt: e.ts(),
    note: agentStatus.task || ''
  };

  const authorAgentId = (pr.agent || '').toLowerCase();
  if (authorAgentId && config.agents?.[authorAgentId]) {
    const metricsPath = path.join(e.ENGINE_DIR, 'metrics.json');
    const metrics = e.safeJson(metricsPath) || {};
    if (!metrics[authorAgentId]) metrics[authorAgentId] = { tasksCompleted:0, tasksErrored:0, prsCreated:0, prsApproved:0, prsRejected:0, reviewsDone:0, lastTask:null, lastCompleted:null };
    if (!metrics[authorAgentId]._reviewedPrs) metrics[authorAgentId]._reviewedPrs = {};
    const prevVerdict = metrics[authorAgentId]._reviewedPrs[pr.id];
    if (prevVerdict !== squadVerdict) {
      if (prevVerdict === 'approved') metrics[authorAgentId].prsApproved = Math.max(0, (metrics[authorAgentId].prsApproved || 0) - 1);
      else if (prevVerdict === 'changes-requested') metrics[authorAgentId].prsRejected = Math.max(0, (metrics[authorAgentId].prsRejected || 0) - 1);
      if (squadVerdict === 'approved') metrics[authorAgentId].prsApproved++;
      else if (squadVerdict === 'changes-requested') metrics[authorAgentId].prsRejected++;
      metrics[authorAgentId]._reviewedPrs[pr.id] = squadVerdict;
    }
    shared.safeWrite(metricsPath, metrics);
  }

  shared.safeWrite(project ? shared.projectPrPath(project) : path.join(path.resolve(e.SQUAD_DIR, '..'), '.squad', 'pull-requests.json'), prs);
  e.log('info', `Updated ${pr.id} → squad review: ${squadVerdict} by ${reviewerName}`);
  createReviewFeedbackForAuthor(agentId, { ...pr, ...target }, config);
}

function updatePrAfterFix(pr, project) {
  const e = engine();
  if (!pr?.id) return;
  const prs = e.getPrs(project);
  const target = prs.find(p => p.id === pr.id);
  if (!target) return;
  target.squadReview = {
    ...target.squadReview,
    status: 'waiting',
    note: 'Fixed, awaiting re-review',
    fixedAt: e.ts()
  };
  shared.safeWrite(project ? shared.projectPrPath(project) : path.join(path.resolve(e.SQUAD_DIR, '..'), '.squad', 'pull-requests.json'), prs);
  e.log('info', `Updated ${pr.id} → squad review: waiting (fix pushed)`);
}

// ─── Post-Merge / Post-Close Hooks ───────────────────────────────────────────

async function handlePostMerge(pr, project, config, newStatus) {
  const e = engine();
  const prNum = (pr.id || '').replace('PR-', '');

  if (pr.branch) {
    const root = path.resolve(project.localPath);
    const wtRoot = path.resolve(root, config.engine?.worktreeRoot || '../worktrees');
    const wtPath = path.join(wtRoot, pr.branch);
    const btPath = path.join(wtRoot, `bt-${prNum}`);
    for (const p of [wtPath, btPath]) {
      if (fs.existsSync(p)) {
        try {
          execSync(`git worktree remove "${p}" --force`, { cwd: root, stdio: 'pipe', timeout: 15000 });
          e.log('info', `Cleaned up worktree: ${p}`);
        } catch (err) { e.log('warn', `Failed to remove worktree ${p}: ${err.message}`); }
      }
    }
  }

  if (newStatus !== 'merged') return;

  if (pr.prdItems?.length > 0) {
    const plansDir = path.join(e.SQUAD_DIR, 'plans');
    try {
      const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.json'));
      let updated = 0;
      for (const pf of planFiles) {
        const plan = e.safeJson(path.join(plansDir, pf));
        if (!plan?.missing_features) continue;
        let changed = false;
        for (const itemId of pr.prdItems) {
          const feature = plan.missing_features.find(f => f.id === itemId);
          if (feature && feature.status !== 'implemented') {
            feature.status = 'implemented';
            changed = true;
            updated++;
          }
        }
        if (changed) shared.safeWrite(path.join(plansDir, pf), plan);
      }
      if (updated > 0) e.log('info', `Post-merge: marked ${updated} PRD item(s) as implemented for ${pr.id}`);
    } catch {}
  }

  const agentId = (pr.agent || '').toLowerCase();
  if (agentId && config.agents?.[agentId]) {
    const metricsPath = path.join(e.ENGINE_DIR, 'metrics.json');
    const metrics = e.safeJson(metricsPath) || {};
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
  const inboxFiles = e.getInboxFiles();
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
    const scope = m('scope') || 'squad';
    const project = m('project');
    let enrichedBlock = block;
    if (!m('author')) enrichedBlock = enrichedBlock.replace('---\n', `---\nauthor: ${agentName}\n`);
    if (!m('created')) enrichedBlock = enrichedBlock.replace('---\n', `---\ncreated: ${e.dateStamp()}\n`);
    const filename = name.replace(/[^a-z0-9-]/g, '-') + '.md';
    if (scope === 'project' && project) {
      const proj = shared.getProjects(config).find(p => p.name === project);
      if (proj) {
        const centralPath = path.join(e.SQUAD_DIR, 'work-items.json');
        const items = e.safeJson(centralPath) || [];
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
      const skillPath = path.join(e.SKILLS_DIR, filename);
      if (!fs.existsSync(skillPath)) {
        shared.safeWrite(skillPath, enrichedBlock);
        e.log('info', `Extracted squad skill "${name}" from ${agentName} → ${filename}`);
      } else {
        e.log('info', `Squad skill "${name}" already exists, skipping`);
      }
    }
  }
}

function updateAgentHistory(agentId, dispatchItem, result) {
  const e = engine();
  const historyPath = path.join(e.AGENTS_DIR, agentId, 'history.md');
  let history = e.safeRead(historyPath) || '# Agent History\n\n';
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
  const inboxFiles = e.getInboxFiles();
  const reviewFiles = inboxFiles.filter(f => f.includes(reviewerAgentId) && f.includes(today));
  if (reviewFiles.length === 0) return;
  const reviewContent = reviewFiles.map(f => e.safeRead(path.join(e.INBOX_DIR, f))).join('\n\n');
  const feedbackFile = `feedback-${authorAgentId}-from-${reviewerAgentId}-${pr.id}-${today}.md`;
  const feedbackPath = path.join(e.INBOX_DIR, feedbackFile);
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
  const metricsPath = path.join(e.ENGINE_DIR, 'metrics.json');
  const metrics = e.safeJson(metricsPath) || {};
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
  let resultSummary = '';
  let taskUsage = null;
  try {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'result') {
          if (obj.result) resultSummary = obj.result.slice(0, 500);
          if (obj.total_cost_usd || obj.usage) {
            taskUsage = {
              costUsd: obj.total_cost_usd || 0,
              inputTokens: obj.usage?.input_tokens || 0,
              outputTokens: obj.usage?.output_tokens || 0,
              cacheRead: obj.usage?.cache_read_input_tokens || obj.usage?.cacheReadInputTokens || 0,
              cacheCreation: obj.usage?.cache_creation_input_tokens || obj.usage?.cacheCreationInputTokens || 0,
              durationMs: obj.duration_ms || 0,
              numTurns: obj.num_turns || 0,
            };
          }
          break;
        }
      } catch {}
    }
  } catch {}
  return { resultSummary, taskUsage };
}

function runPostCompletionHooks(dispatchItem, agentId, code, stdout, config) {
  const type = dispatchItem.type;
  const meta = dispatchItem.meta;
  const isSuccess = code === 0;
  const result = isSuccess ? 'success' : 'error';
  const { resultSummary, taskUsage } = parseAgentOutput(stdout);

  if (isSuccess && meta?.item?.id) updateWorkItemStatus(meta, 'done', '');
  if (isSuccess && type === 'plan' && meta?.item?.chain === 'plan-to-prd') chainPlanToPrd(dispatchItem, meta, config);
  if (isSuccess && meta?.item?.branchStrategy === 'shared-branch') checkPlanCompletion(meta, config);

  let prsCreatedCount = 0;
  if (isSuccess) prsCreatedCount = syncPrsFromOutput(stdout, agentId, meta, config) || 0;

  if (type === 'review') updatePrAfterReview(agentId, meta?.pr, meta?.project);
  if (type === 'fix') updatePrAfterFix(meta?.pr, meta?.project);
  checkForLearnings(agentId, config.agents[agentId], dispatchItem.task);
  if (isSuccess) extractSkillsFromOutput(stdout, agentId, dispatchItem, config);
  updateAgentHistory(agentId, dispatchItem, result);
  updateMetrics(agentId, dispatchItem, result, taskUsage, prsCreatedCount);

  return { resultSummary, taskUsage };
}

module.exports = {
  checkPlanCompletion,
  chainPlanToPrd,
  updateWorkItemStatus,
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
};
