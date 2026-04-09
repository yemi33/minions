// render-plans.js — Plan rendering functions extracted from dashboard.html

const PLANS_PER_PAGE = 10;
let _plansPage = 0;

function _plansPrev() { if (_plansPage > 0) { _plansPage--; refresh(); } }
function _plansNext() { _plansPage++; refresh(); }

function openCreatePlanModal() {
  const projOpts = (typeof cmdProjects !== 'undefined' ? cmdProjects : []).map(p =>
    '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>'
  ).join('');
  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  document.getElementById('modal-title').textContent = 'Create Plan';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title <input id="plan-new-title" style="' + inputStyle + '" placeholder="e.g. Add user authentication with JWT"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Project <select id="plan-new-project" style="' + inputStyle + '"><option value="">Auto</option>' + projOpts + '</select></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Plan Content <textarea id="plan-new-content" rows="12" style="' + inputStyle + ';resize:vertical;font-family:monospace;font-size:12px" placeholder="Write your plan in markdown...\n\nDescribe what needs to be built, the approach, requirements, and any constraints.\n\nThe squad will convert this into a PRD with structured work items."></textarea></label>' +
      '<div style="font-size:11px;color:var(--muted)">After creating, click Execute on the plan card to have an agent convert it into a PRD with work items.</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitCreatePlan()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Create Plan</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('plan-new-title')?.focus(), 100);
}

async function _submitCreatePlan() {
  var btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
  const title = document.getElementById('plan-new-title')?.value?.trim();
  const content = document.getElementById('plan-new-content')?.value?.trim();
  if (!title) { if (btn) { btn.disabled = false; btn.textContent = 'Create Plan'; } alert('Title is required'); return; }
  if (!content) { if (btn) { btn.disabled = false; btn.textContent = 'Create Plan'; } alert('Plan content is required'); return; }
  const project = document.getElementById('plan-new-project')?.value || '';

  try {
    const res = await fetch('/api/plans/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, project })
    });
    const data = await res.json();
    if (res.ok) {
      try { closeModal(); } catch { /* expected */ }
      refreshPlans();
      refresh();
      try { showToast('cmd-toast', 'Plan "' + data.file + '" created — click Execute to convert to PRD', true); } catch { /* expected */ }
    } else {
      alert('Failed: ' + (data.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function refreshPlans() {
  try {
    const plans = await fetch('/api/plans').then(r => r.json());
    renderPlans(plans);
  } catch (e) { console.error('plans refresh:', e.message); }
}

/**
 * Derive effective plan/PRD status from work items (single source of truth).
 * PRD JSON status is treated as user intent (approved, paused, rejected),
 * but completion/progress is always derived from actual work item state.
 */
function derivePlanStatus(prdFile, mdFile, prdJsonStatus, workItems) {
  const wi = workItems.filter(w =>
    w.sourcePlan === prdFile || w.sourcePlan === mdFile ||
    (w.type === 'plan-to-prd' && (w.planFile === prdFile || w.planFile === mdFile))
  );
  const implementWi = wi.filter(w => w.type !== 'plan-to-prd' && w.type !== 'verify');
  const hasPendingPrd = wi.some(w => w.type === 'plan-to-prd' && (w.status === 'pending' || w.status === 'dispatched'));
  const hasActiveWork = implementWi.some(w => w.status === 'pending' || w.status === 'dispatched');
  const allDone = implementWi.length > 0 && implementWi.every(w => w.status === 'done' || w.status === 'decomposed');
  const hasFailed = implementWi.some(w => w.status === 'failed');

  // User-set statuses take priority when no work has started
  if (prdJsonStatus === 'rejected') return 'rejected';
  if (prdJsonStatus === 'paused' && !allDone) return 'paused';
  if (prdJsonStatus === 'revision-requested') return 'revision-requested';

  // Derive from work item progress
  if (allDone && !hasActiveWork) return 'completed';
  if (hasActiveWork) return 'dispatched';
  if (hasPendingPrd) return 'converting';
  if (hasFailed && !hasActiveWork) return 'has-failures';

  if (prdJsonStatus === 'awaiting-approval' && implementWi.length === 0) return 'awaiting-approval';
  if (prdJsonStatus === 'approved' && implementWi.length === 0) return 'approved';

  // plan-to-prd conversion done but no implement items and PRD is gone — truly completed
  const prdConversionDone = wi.some(w => w.type === 'plan-to-prd' && w.status === 'done');
  if (prdConversionDone && implementWi.length === 0) return 'completed';

  return prdJsonStatus || 'active';
}

function renderPlans(plans) {
  plans = plans.filter(function(p) { return !isDeleted('plan:' + p.file); });
  const el = document.getElementById('plans-list');
  const countEl = document.getElementById('plans-count');
  countEl.textContent = plans.length;

  if (plans.length === 0) {
    el.innerHTML = '<p class="empty">No plans yet. Use /plan in the command center to create one.</p>';
    return;
  }

  const statusLabels = { 'awaiting-approval': 'Awaiting Approval', 'paused': 'Paused', 'approved': 'Approved', 'rejected': 'Rejected', 'revision-requested': 'Revision Requested', 'completed': 'Completed', 'active': 'Active' };
  const statusClass = (s) => s === 'awaiting-approval' || s === 'paused' ? 'awaiting' : s || '';
  const normalizeSourcePlanKey = (name) => {
    if (!name) return '';
    if (name.endsWith('.md') || name.endsWith('.json')) return name;
    return name + '.md';
  };

  // Check which plans have active dispatches or pending plan-to-prd work items
  const activeDisp = (window._lastDispatch?.active || []);
  const pendingDisp = (window._lastDispatch?.pending || []);
  const workingPlanFiles = new Set();
  for (const d of [...activeDisp, ...pendingDisp]) {
    const src = d.meta?.item?.sourcePlan || '';
    if (src) workingPlanFiles.add(src);
    // Match plan-to-prd tasks by planFile in item meta
    const planFile = d.meta?.item?.planFile || d.meta?.planFile || '';
    if (planFile) workingPlanFiles.add(planFile);
    // Also match by task description
    if (d.type === 'plan-to-prd' && d.task) {
      for (const p of plans) { if (d.task.includes(p.file?.replace('.md', '').replace('.json', '') || '___')) workingPlanFiles.add(p.file); }
    }
  }
  // Check work items for pending/dispatched plan-to-prd or implement tasks
  const allWi = window._lastWorkItems || [];
  for (const w of allWi) {
    if (w.type === 'plan-to-prd' && (w.status === 'pending' || w.status === 'dispatched') && w.planFile) {
      workingPlanFiles.add(w.planFile);
    }
    // Also track which PRD .json files have active work
    if (w.sourcePlan && (w.status === 'dispatched' || w.status === 'pending')) {
      workingPlanFiles.add(w.sourcePlan);
    }
  }

  // Link .md plans to their PRD .json — if a PRD is being worked on, the source plan is too
  // Convention: plan-w025-2026-03-15.md → officeagent-2026-03-15.json (same date, different prefix)
  const workingJsons = new Set([...workingPlanFiles].filter(f => f.endsWith('.json')));
  if (workingJsons.size > 0) {
    for (const p of plans) {
      if (p.format === 'draft' && p.file.endsWith('.md')) {
        // A .md plan is "working" if any PRD .json has active dispatches
        // (since the .md is the source that generated those PRDs)
        if (workingJsons.size > 0) workingPlanFiles.add(p.file);
      }
    }
  }

  // Track which .md plans have a paused PRD, and map .md → PRD .json
  // (status derived from work items via derivePlanStatus — no separate tracking needed)
  const planToPrdFile = {}; // .md filename → .json PRD filename
  for (const p of plans) {
    if (p.format === 'prd' && !p.archived && p.sourcePlan) {
      const sourceKeys = [p.sourcePlan, normalizeSourcePlanKey(p.sourcePlan)];
      for (const sourceKey of sourceKeys) {
        if (!sourceKey) continue;
        planToPrdFile[sourceKey] = p.file;
        // Status derived via derivePlanStatus — planToPrdFile mapping is all we need
      }
    }
  }

  const activePlans = plans.filter(p => !p.archived && p.format !== 'prd');
  const archivedPlans = plans.filter(p => p.archived && p.format !== 'prd');
  countEl.textContent = activePlans.length + (archivedPlans.length ? ' + ' + archivedPlans.length + ' archived' : '');

  function renderPlanCard(p) {
    const prdFile = planToPrdFile[p.file] || (p.file.endsWith('.json') ? p.file : '');
    const isArchived = p.archived;

    // For .md plans with a linked PRD, use the PRD's status as the authoritative intent
    let prdJsonStatus = p.status || 'active';
    if (prdFile && p.format !== 'prd') {
      const linkedPrd = plans.find(pp => pp.file === prdFile && pp.format === 'prd');
      if (linkedPrd) prdJsonStatus = linkedPrd.status || prdJsonStatus;
      else if (!linkedPrd) {
        const archivedPrd = archivedPlans.find(pp => pp.file === prdFile && pp.format === 'prd');
        if (archivedPrd) prdJsonStatus = 'completed';
      }
    }

    // Single source of truth: derive status from work items
    const effectiveStatus = isArchived ? 'completed' : derivePlanStatus(prdFile, p.file, prdJsonStatus, allWi);

    const statusLabelsMap = {
      'completed': 'Completed', 'dispatched': 'In Progress', 'converting': 'Converting to PRD',
      'paused': 'Paused', 'awaiting-approval': 'Awaiting Approval', 'approved': 'Approved',
      'rejected': 'Rejected', 'revision-requested': 'Revision Requested',
      'has-failures': 'Has Failures', 'active': 'Active'
    };
    const label = statusLabelsMap[effectiveStatus] || effectiveStatus;
    const needsAction = (effectiveStatus === 'awaiting-approval' || effectiveStatus === 'paused') && !isArchived;
    const isRevision = effectiveStatus === 'revision-requested';
    const isCompleted = effectiveStatus === 'completed';
    const isDraft = p.format === 'draft' && !isCompleted;
    // For .md drafts: show Execute only if no PRD exists yet (not already executed)

    let actions = '';
    if (needsAction) {
      const actionTarget = prdFile || p.file;
      // For awaiting-approval: show Execute (re-generate PRD from updated plan) + Approve (use current PRD as-is)
      if (effectiveStatus === 'awaiting-approval' && isDraft && prdFile) {
        actions = '<div class="plan-card-actions" onclick="event.stopPropagation()">' +
          '<button class="plan-btn approve" onclick="planApprove(\'' + escHtml(actionTarget) + '\')">Approve</button>' +
          '<button class="plan-btn approve" style="opacity:0.7" onclick="planExecute(\'' + escHtml(p.file) + '\',\'' + escHtml(p.project || '') + '\',this)">Re-execute</button>' +
          '<button class="plan-btn reject" onclick="planReject(\'' + escHtml(actionTarget) + '\')">Reject</button>' +
        '</div>';
      } else {
        const actionLabel = effectiveStatus === 'paused' ? 'Resume' : 'Approve';
        actions = '<div class="plan-card-actions" onclick="event.stopPropagation()">' +
          '<button class="plan-btn approve" onclick="planApprove(\'' + escHtml(actionTarget) + '\')">' + actionLabel + '</button>' +
          '<button class="plan-btn reject" onclick="planReject(\'' + escHtml(actionTarget) + '\')">Reject</button>' +
        '</div>';
      }
    } else if (isRevision) {
      actions = '<div class="plan-card-meta" style="margin-top:6px;color:var(--purple,#a855f7)">Revision in progress: ' + escHtml((p.revisionFeedback || '').slice(0, 100)) + '</div>';
    }

    const executeBtn = isDraft && (effectiveStatus === 'active' || effectiveStatus === 'draft') && !isArchived && !prdFile ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);font-weight:600" ' +
      'onclick="event.stopPropagation();planExecute(\'' + escHtml(p.file) + '\',\'' + escHtml(p.project) + '\',this)">Execute</button>' : '';
    const showPause = effectiveStatus === 'dispatched' && prdFile && !isArchived;
    // Resume pill not needed — paused state is handled by the actions block above
    const showResume = false;
    const verifyWi = allWi.find(w => w.itemType === 'verify' && w.sourcePlan === prdFile);
    const hasVerifyWi = !!verifyWi;
    const showVerify = effectiveStatus === 'completed' && prdFile && !isArchived && !hasVerifyWi;
    const pauseBtn = showPause ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow)" ' +
      'onclick="event.stopPropagation();planPause(\'' + escHtml(prdFile) + '\',this)">Pause</button>' : '';
    const resumeBtn = showResume
      ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green)" ' +
        'onclick="event.stopPropagation();planApprove(\'' + escHtml(prdFile) + '\',this)">Resume</button>'
      : '';
    const verifyBtn = showVerify ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green)" ' +
      'onclick="event.stopPropagation();triggerVerify(\'' + escHtml(prdFile) + '\',this)">Verify</button>' : '';
    const showArchive = !isArchived;
    const archiveFile = prdFile || p.file;
    const archiveBtn = showArchive ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" ' +
      'onclick="event.stopPropagation();planArchive(\'' + escHtml(archiveFile) + '\',this)">Archive</button>' : '';
    const deleteBtn = !isArchived ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red)" ' +
      'onclick="event.stopPropagation();planDelete(\'' + escHtml(p.file) + '\')">Delete</button>' : '';

    const versionBadge = p.version ? ' <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(56,139,253,0.15);color:var(--blue);vertical-align:middle">v' + p.version + '</span>' : '';
    const statusColors = { 'completed': 'var(--green)', 'dispatched': 'var(--blue)', 'converting': 'var(--yellow)', 'paused': 'var(--muted)', 'awaiting-approval': 'var(--yellow)', 'approved': 'var(--green)', 'rejected': 'var(--red)', 'has-failures': 'var(--red)', 'revision-requested': 'var(--purple,#a855f7)', 'active': 'var(--muted)' };
    const cardClass = effectiveStatus === 'dispatched' || effectiveStatus === 'converting' ? 'working' : effectiveStatus === 'awaiting-approval' || effectiveStatus === 'paused' ? 'awaiting' : effectiveStatus;
    return '<div class="plan-card ' + cardClass + '" data-file="plans/' + escHtml(p.file) + '" style="cursor:pointer' + (isArchived ? ';opacity:0.7' : '') + '" onclick="planView(\'' + escHtml(p.file) + '\')">' +
      '<div class="plan-card-header">' +
        '<div><div class="plan-card-title">' + escHtml(p.summary || p.file) + versionBadge + '</div>' +
          '<div class="plan-card-meta">' +
            '<span style="font-weight:600;color:' + (statusColors[effectiveStatus] || 'var(--muted)') + '">' + label + '</span>' +
            (p.project ? '<span>' + escHtml(p.project) + '</span>' : '') +
            '<span>' + p.itemCount + ' items</span>' +
            (p.updatedAt ? '<span title="Last updated: ' + p.updatedAt + '">Updated ' + timeAgo(p.updatedAt) + '</span>' : '') +
            (p.completedAt ? '<span>' + p.completedAt.slice(0, 10) + '</span>' : '') +
            (p.generatedBy ? '<span>by ' + escHtml(p.generatedBy) + '</span>' : '') +
            executeBtn + pauseBtn + resumeBtn + verifyBtn + (hasVerifyWi ? _renderVerifyBadge(verifyWi) : '') + archiveBtn + deleteBtn +
          '</div>' +
        '</div>' +
      '</div>' +
      actions +
    '</div>';
  }

  const totalPlanPages = Math.ceil(activePlans.length / PLANS_PER_PAGE);
  if (_plansPage >= totalPlanPages) _plansPage = totalPlanPages - 1;
  if (_plansPage < 0) _plansPage = 0;
  const plansStart = _plansPage * PLANS_PER_PAGE;
  const pagePlans = activePlans.slice(plansStart, plansStart + PLANS_PER_PAGE);

  let html = pagePlans.map(renderPlanCard).join('');

  if (activePlans.length > PLANS_PER_PAGE) {
    html += '<div class="pr-pager">' +
      '<span class="pr-page-info">' + (plansStart + 1) + '-' + Math.min(plansStart + PLANS_PER_PAGE, activePlans.length) + ' of ' + activePlans.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_plansPage === 0 ? 'disabled' : '') + '" onclick="_plansPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_plansPage >= totalPlanPages - 1 ? 'disabled' : '') + '" onclick="_plansNext()">Next</button>' +
      '</div>' +
    '</div>';
  }

  if (archivedPlans.length > 0) {
    window._archivedPlans = archivedPlans;
    window._archivedPlanRenderer = renderPlanCard;
    html += '<div style="margin-top:8px;text-align:right;position:relative" data-file="plan-archives">' +
      '<button class="pr-pager-btn" style="font-size:10px;padding:3px 10px;color:var(--muted)" onclick="openArchivedPlansModal()">' +
        'View Archives (' + archivedPlans.length + ')' +
      '</button>' +
    '</div>';
  }

  el.innerHTML = html;
  restoreNotifBadges();
}

function openArchivedPlansModal() {
  const plans = (window._archivedPlans || []).slice().sort((a, b) =>
    (b.completedAt || b.updatedAt || '').localeCompare(a.completedAt || a.updatedAt || '')
  );
  const render = window._archivedPlanRenderer;
  if (!plans.length || !render) return;

  const html = plans.map(p => {
    const itemCount = p.itemCount || 0;
    const completed = p.completedAt ? p.completedAt.slice(0, 10) : '';
    return '<div class="plan-card" data-file="plans/' + escHtml(p.file) + '" style="cursor:pointer;opacity:0.8" onclick="planView(\'' + escHtml(p.file) + '\')">' +
      '<div class="plan-card-header">' +
        '<div><div class="plan-card-title" style="font-size:13px">' + escHtml(p.summary || p.file) + '</div>' +
          '<div class="plan-card-meta">' +
            '<span style="color:var(--green);font-weight:600">Completed</span>' +
            (p.project ? '<span>' + escHtml(p.project) + '</span>' : '') +
            '<span>' + itemCount + ' items</span>' +
            (completed ? '<span>' + completed + '</span>' : '') +
            (p.generatedBy ? '<span>by ' + escHtml(p.generatedBy) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('modal-title').textContent = 'Archived Plans';
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}

// Disable all PRD action buttons to prevent double-clicks

async function planExecute(file, project, btn) {
  if (btn) { btn.textContent = 'Executing...'; btn.disabled = true; btn.style.color = 'var(--blue)'; }
  try {
    const res = await fetch('/api/plans/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, project })
    });
    const data = await res.json();
    if (res.ok) {
      // Inject into local work items so the next render immediately hides Execute
      if (!data.alreadyQueued) {
        (window._lastWorkItems = window._lastWorkItems || []).push({
          id: data.id, type: 'plan-to-prd', status: 'pending', planFile: file
        });
      }
      closeModal();
      showToast('cmd-toast', data.alreadyQueued ? 'Already queued (' + data.id + ')' : 'Queued ' + data.id + ' — agent will convert plan to PRD', true);
      wakeEngine();
      refreshPlans();
    } else {
      if (btn) { btn.textContent = 'Execute'; btn.disabled = false; btn.style.color = 'var(--green)'; }
      alert('Failed: ' + (data.error || 'unknown'));
    }
  } catch (e) {
    if (btn) { btn.textContent = 'Execute'; btn.disabled = false; btn.style.color = 'var(--green)'; }
    alert('Error: ' + e.message);
  }
}

async function planSubmitRevise(file) {
  const id = 'revise-feedback-' + file.replace(/\./g, '-');
  const feedback = document.getElementById(id).value.trim();
  if (!feedback) { showToast('cmd-toast', 'Please enter feedback', false); return; }
  try {
    const res = await fetch('/api/plans/revise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, feedback }) });
    const data = await res.json();
    if (!res.ok) { showToast('cmd-toast', 'Revision failed: ' + (data.error || 'unknown'), false); return; }
    showToast('cmd-toast', 'Revision requested — agent will update the plan (' + data.workItemId + ')', true);
    planHideRevise(file);
    refreshPlans();
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

function planShowRevise(file) {
  const id = 'revise-input-' + file.replace(/\./g, '-');
  document.getElementById(id).style.display = 'block';
}

function planHideRevise(file) {
  const id = 'revise-input-' + file.replace(/\./g, '-');
  document.getElementById(id).style.display = 'none';
}

let _planPollInterval = null;
let _planPollFile = null;
let _planPollLastRaw = null;

function _stopPlanPoll() {
  if (_planPollInterval) { clearInterval(_planPollInterval); _planPollInterval = null; }
  _planPollFile = null;
  _planPollLastRaw = null;
}

function _renderPlanModal(normalizedFile, raw, lastMod) {
  let title = normalizedFile;
  let text = '';

  if (normalizedFile.endsWith('.json')) {
    let plan;
    try { plan = JSON.parse(raw); } catch (e) {
      document.getElementById('modal-body').innerHTML = '<p style="color:var(--red)">Failed to parse plan JSON: ' + escHtml(e.message) + '</p><pre style="font-size:10px;max-height:200px;overflow:auto">' + escHtml((raw || '').slice(0, 500)) + '</pre>';
      return;
    }
    title = plan.plan_summary || normalizedFile;
    const items = (plan.missing_features || []).map((f, i) =>
      (i + 1) + '. [' + f.id + '] ' + f.name + ' (' + (f.estimated_complexity || '?') + ', ' + (f.priority || '?') + ')' +
      (f.depends_on?.length ? ' \u2192 depends on: ' + f.depends_on.join(', ') : '') +
      '\n   ' + (f.description || '').slice(0, 200) +
      (f.acceptance_criteria?.length ? '\n   Criteria: ' + f.acceptance_criteria.join('; ') : '')
    ).join('\n\n');
    text = 'Project: ' + (plan.project || '?') +
      '\nStrategy: ' + (plan.branch_strategy || 'parallel') +
      '\nBranch: ' + (plan.feature_branch || 'per-item') +
      '\nStatus: ' + (plan.status || 'active') +
      '\nGenerated by: ' + (plan.generated_by || '?') + ' on ' + (plan.generated_at || '?') +
      '\n\n--- Items (' + (plan.missing_features || []).length + ') ---\n\n' + items +
      (plan.open_questions?.length ? '\n\n--- Open Questions ---\n\n' + plan.open_questions.map(q => '\u2022 ' + q).join('\n') : '');
  } else {
    text = raw;
    const titleMatch = raw.match(/^#\s+(?:Plan:\s*)?(.+)/m);
    if (titleMatch) title = titleMatch[1];
  }

  const vMatch = normalizedFile.match(/-v(\d+)/);
  const versionLabel = vMatch ? ' (v' + vMatch[1] + ')' : '';
  const isMdPlan = normalizedFile.endsWith('.md');
  let planStatus = '';
  try { if (normalizedFile.endsWith('.json')) planStatus = JSON.parse(raw).status || ''; } catch {}
  const isActive = planStatus === 'approved' || planStatus === 'active';
  const isPaused = planStatus === 'awaiting-approval' || planStatus === 'paused';
  const wi = window._lastWorkItems || [];
  const linkedPrdFile = isMdPlan ? (window._lastStatus?.plans || []).find(p => p.sourcePlan === normalizedFile && p.format === 'prd')?.file : null;
  const hasActiveWork = wi.some(w =>
    (w.status === 'pending' || w.status === 'dispatched') &&
    (w.planFile === normalizedFile || w.sourcePlan === normalizedFile ||
      (linkedPrdFile && w.sourcePlan === linkedPrdFile))
  );
  const prdConversion = wi.find(w => w.type === 'plan-to-prd' && w.status === 'done' && w.planFile === normalizedFile);
  const linkedPrd = (window._lastStatus?.plans || []).find(p => p.sourcePlan === normalizedFile && p.format === 'prd');
  const hasPrd = !!linkedPrd;
  // Plan-to-prd conversion done is not "completed" — the PRD still needs approval and execution
  const prdCompleted = prdConversion && linkedPrd && linkedPrd.status === 'completed';
  const linkedPrdAwaiting = linkedPrd && (linkedPrd.status === 'awaiting-approval' || linkedPrd.status === 'paused');
  const modalShowResume = isPaused || linkedPrdAwaiting;
  const canExecute = isMdPlan && !hasActiveWork && !prdCompleted;
  const modalExecuteBtn = canExecute && !hasPrd ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green);font-weight:600" ' +
    'onclick="planExecute(\'' + escHtml(normalizedFile) + '\',\'\',this)">Execute</button>' : '';
  const modalReExecuteBtn = canExecute && linkedPrdAwaiting ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green);font-weight:600" ' +
    'onclick="planExecute(\'' + escHtml(normalizedFile) + '\',\'\',this)">Re-execute</button>' : '';
  const modalCompletedLabel = prdCompleted && !hasActiveWork ? '<span style="font-size:10px;color:var(--green);font-weight:600">Completed</span>' : '';
  const modalAwaitingLabel = linkedPrdAwaiting && !hasActiveWork && !prdCompleted ? '<span style="font-size:10px;color:var(--yellow);font-weight:600">Awaiting Approval</span>' : '';
  const modalInProgressLabel = hasActiveWork ? '<span style="font-size:10px;color:var(--blue)">In Progress</span>' : '';
  const isModalCompleted = planStatus === 'completed';
  const modalPauseBtn = isActive && !isMdPlan && !isModalCompleted ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--yellow)" ' +
    'onclick="planPause(\'' + escHtml(normalizedFile) + '\',this)">Pause</button>' : '';
  const modalApproveTarget = linkedPrdAwaiting ? linkedPrd.file : normalizedFile;
  const isActuallyPaused = planStatus === 'paused' || linkedPrd?.status === 'paused';
  const modalApproveLabel = isActuallyPaused ? 'Resume' : 'Approve';
  const showRejectInModal = linkedPrdAwaiting || planStatus === 'awaiting-approval';
  const modalApproveBtn = modalShowResume ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green)" ' +
    'onclick="planApprove(\'' + escHtml(modalApproveTarget) + '\',this)">' + modalApproveLabel + '</button>' : '';
  const modalRejectBtn = showRejectInModal ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--red)" ' +
    'onclick="planReject(\'' + escHtml(modalApproveTarget) + '\')">Reject</button>' : '';
  const modalVerifyWi = (window._lastWorkItems || []).find(w => w.itemType === 'verify' && w.sourcePlan === normalizedFile);
  const modalVerifyBtn = isModalCompleted && !modalVerifyWi ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green)" ' +
    'onclick="triggerVerify(\'' + escHtml(normalizedFile) + '\',this)">Verify</button>' : '';
  const modalVerifyInfo = modalVerifyWi ? _renderVerifyBadge(modalVerifyWi) : '';
  const modalArchiveBtn = '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--muted)" ' +
    'onclick="planArchive(\'' + escHtml(normalizedFile) + '\')">Archive</button>';
  const lastModLabel = lastMod ? '<div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:2px">Last updated: ' + new Date(lastMod).toLocaleString() + '</div>' : '';
  const actionBtns = '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
    (modalCompletedLabel || '') + (modalAwaitingLabel || '') + (modalInProgressLabel || '') + (modalApproveBtn || '') + (modalReExecuteBtn || '') + (modalExecuteBtn || '') + (modalPauseBtn || '') + (modalRejectBtn || '') + (modalVerifyBtn || '') + (modalVerifyInfo || '') +
    ' ' + modalArchiveBtn +
    ' <button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--red)" ' +
    'onclick="planDelete(\'' + escHtml(normalizedFile) + '\')">Delete</button>' +
  '</div>';

  document.getElementById('modal-title').innerHTML = escHtml(title) + (versionLabel ? ' <span style="font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px;background:rgba(56,139,253,0.15);color:var(--blue)">' + escHtml(versionLabel) + '</span>' : '') + lastModLabel + actionBtns;
  const modalBody = document.getElementById('modal-body');
  const scrollTop = modalBody.scrollTop;
  if (normalizedFile.endsWith('.json')) {
    modalBody.textContent = text;
    modalBody.style.fontFamily = 'Consolas, monospace';
    modalBody.style.whiteSpace = 'pre-wrap';
  } else {
    modalBody.innerHTML = renderMd(text);
  }
  modalBody.scrollTop = scrollTop;

  return { title, text };
}

async function planView(file) {
  _stopPlanPoll();
  try {
    const normalizedFile = normalizePlanFile(file);

    // Show modal immediately with loading state
    document.getElementById('modal-title').textContent = normalizedFile;
    document.getElementById('modal-body').innerHTML = '<p style="color:var(--muted)">Loading...</p>';
    document.getElementById('modal').classList.add('open');

    const planRes = await fetch('/api/plans/' + encodeURIComponent(normalizedFile));
    const lastMod = planRes.headers.get('Last-Modified');
    const resolvedPath = planRes.headers.get('X-Resolved-Path');
    const raw = await planRes.text();

    const { title, text } = _renderPlanModal(normalizedFile, raw, lastMod);
    _planPollLastRaw = raw;

    _modalDocContext = { title, content: text, selection: '' };
    _modalFilePath = resolvedPath || ((normalizedFile.endsWith('.json') ? 'prd/' : 'plans/') + normalizedFile); showModalQa();
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);

    // Live-poll while modal is open
    _planPollFile = normalizedFile;
    _planPollInterval = setInterval(function() {
      if (!document.getElementById('modal')?.classList?.contains('open') || _planPollFile !== normalizedFile) {
        _stopPlanPoll(); return;
      }
      fetch('/api/plans/' + encodeURIComponent(normalizedFile))
        .then(function(r) { return r.text().then(function(raw) { return { raw: raw, lastMod: r.headers.get('Last-Modified') }; }); })
        .then(function(d) { if (_planPollFile === normalizedFile && d.raw !== _planPollLastRaw) { _planPollLastRaw = d.raw; _renderPlanModal(normalizedFile, d.raw, d.lastMod); } })
        .catch(function() {});
    }, 3000);
  } catch (e) { console.error(e); }
}

async function planApprove(file, btn) {
  if (btn) { btn.dataset.origText = btn.textContent; btn.textContent = 'Approving...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetch('/api/plans/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    if (res.ok) {
      showToast('cmd-toast', 'Plan approved — work will begin on next engine tick', true);
      refreshPlans();
      refresh();
    } else {
      if (btn) { btn.textContent = btn.dataset.origText || 'Approve'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      const d = await res.json().catch(() => ({}));
      alert('Approve failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { if (btn) { btn.textContent = btn.dataset.origText || 'Approve'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function planDelete(file) {
  _stopPlanPoll();
  if (!confirm('Delete plan "' + file + '"? This cannot be undone.')) return;
  markDeleted('plan:' + file);
  closeModal();
  showToast('cmd-toast', 'Plan deleted', true);
  try {
    const res = await fetch('/api/plans/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    if (res.ok) {
      refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (d.error || 'unknown'));
      refresh(); // revert optimistic
    }
  } catch (e) { alert('Error: ' + e.message); refresh(); }
}

async function planArchive(file, btn) {
  var isPrd = file.endsWith('.json');
  var confirmMsg = isPrd
    ? 'Archive this PRD? The linked source plan will also be archived.'
    : 'Archive this plan?';
  if (!confirm(confirmMsg)) return;
  _stopPlanPoll();
  markDeleted('plan:' + file);
  try { closeModal(); } catch { /* may not be open */ }
  showToast('cmd-toast', 'Archiving...', true);
  try {
    const res = await fetch('/api/plans/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { refresh(); return; }
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok) {
      var msg = 'Archived';
      if (d.archivedSource) msg += ' PRD + source plan (' + d.archivedSource + ')';
      if (d.cancelledItems) msg += ', cancelled ' + d.cancelledItems + ' pending item(s)';
      showToast('cmd-toast', msg, true);
      refresh();
    } else {
      resetBtn();
      alert('Archive failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { resetBtn(); alert('Error: ' + e.message); }
}

async function planPause(file, btn) {
  if (btn) { btn.dataset.origText = btn.textContent; btn.textContent = 'Pausing...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetch('/api/plans/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    if (res.ok) {
      showToast('cmd-toast', 'Plan paused — no new items will be dispatched', true);
      refreshPlans();
      refresh();
    } else {
      if (btn) { btn.textContent = btn.dataset.origText || 'Pause'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      const d = await res.json().catch(() => ({}));
      alert('Pause failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { if (btn) { btn.textContent = btn.dataset.origText || 'Pause'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function planReject(file) {
  if (!confirm('Reject this plan? It will not be executed.')) return;
  const reason = prompt('Reason for rejection (optional):') || '';
  try {
    const res = await fetch('/api/plans/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, reason }) });
    if (res.ok) {
      showToast('cmd-toast', 'Plan rejected', true);
      refreshPlans();
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Reject failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function planDiscuss(file) {
  try {
    const res = await fetch('/api/plans/discuss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Show the launch command in a modal
    const content = `To discuss and revise this plan interactively, run this command in a terminal:\n\n` +
      `━━━ Bash / Git Bash ━━━\n${data.command}\n\n` +
      `━━━ PowerShell ━━━\n${data.psCommand}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `This launches an interactive Claude session with the plan pre-loaded.\n` +
      `Chat naturally to review and refine. When you're satisfied, say "approve" and the session will write the approved plan back to disk.\n\n` +
      `The engine will pick it up on the next tick and start dispatching work.`;

    document.getElementById('modal-title').textContent = 'Discuss Plan: ' + file;
    document.getElementById('modal-body').textContent = content;
    document.getElementById('modal').classList.add('open');
  } catch (e) {
    showToast('cmd-toast', 'Error: ' + e.message, false);
  }
}

async function planOpenInDocChat(file) {
  try {
    document.getElementById('modal-title').textContent = file;
    document.getElementById('modal-body').innerHTML = '<p style="color:var(--muted)">Loading...</p>';
    document.getElementById('modal').classList.add('open');
    const normalizedFile = normalizePlanFile(file);
    const planRes = await fetch('/api/plans/' + encodeURIComponent(normalizedFile));
    const resolvedPath = planRes.headers.get('X-Resolved-Path');
    const raw = await planRes.text();
    let title = normalizedFile;
    let text = raw;
    if (normalizedFile.endsWith('.json')) {
      try { title = JSON.parse(raw).plan_summary || file; } catch {}
    }
    document.getElementById('modal-title').textContent = 'Edit: ' + title;
    if (normalizedFile.endsWith('.json')) {
      document.getElementById('modal-body').textContent = text;
      document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
      document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
    } else {
      document.getElementById('modal-body').innerHTML = renderMd(text);
    }
    _modalDocContext = { title: title, content: text, selection: '' };
    _modalFilePath = resolvedPath || ((normalizedFile.endsWith('.json') ? 'prd/' : 'plans/') + normalizedFile); showModalQa();
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    document.getElementById('modal').classList.add('open');
  } catch (e) { alert('Error opening plan: ' + e.message); }
}

async function planRegeneratePRD(source) {
  if (!confirm('Reset pending/failed items to pick up plan changes?\n\nIn-progress and completed items won\'t be affected.')) return;
  try {
    const res = await fetch('/api/plans/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    const d = await res.json();
    if (res.ok && d.ok) {
      refresh();
      showToast('cmd-toast', 'Regenerated: ' + d.reset + ' reset, ' + d.kept + ' kept, ' + d.new + ' new', true);
    } else {
      alert('Failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

function _renderVerifyBadge(verifyWi) {
  const statusColors = { pending: 'var(--muted)', dispatched: 'var(--blue)', done: 'var(--green)', failed: 'var(--red)' };
  const color = statusColors[verifyWi.status] || 'var(--muted)';
  const label = verifyWi.status === 'dispatched' ? 'Verifying...' : verifyWi.status === 'done' ? '\u2714 Verified' : verifyWi.status === 'failed' ? 'Verify failed' : 'Verify pending';
  // E2E PR — check by prdItems, branch, or title
  const allPrs = (window._lastStatus?.pullRequests) || [];
  const planFile = verifyWi.sourcePlan || '';
  const planSlug = planFile.replace('.json', '');
  const verifyPr = allPrs.find(pr => (pr.prdItems || []).includes(verifyWi.id) || (pr.branch && pr.branch.includes(planSlug) && (pr.title || '').includes('[E2E]')));
  const prLink = verifyPr?.url ? ' <a href="' + escHtml(verifyPr.url) + '" target="_blank" onclick="event.stopPropagation()" style="color:var(--blue);text-decoration:underline;font-size:9px">' + escHtml(verifyPr.id || 'E2E PR') + '</a>' : '';
  // Testing guide
  const guides = window._lastStatus?.verifyGuides || [];
  const guide = guides.find(g => g.planFile === planFile);
  const guideLink = guide ? ' <span onclick="event.stopPropagation();openVerifyGuide(\'' + escHtml(guide.file) + '\')" style="color:var(--green);cursor:pointer;text-decoration:underline;font-size:9px">Testing Guide</span>' : '';
  return '<span style="font-size:9px;font-weight:600;color:' + color + ';padding:0 4px">' + label + '</span>' + prLink + guideLink;
}

async function openVerifyGuide(file) {
  try {
    const normalizedFile = normalizePlanFile(file);
    const content = await fetch('/api/plans/' + encodeURIComponent(normalizedFile)).then(r => r.text());
    document.getElementById('modal-title').innerHTML = 'Manual Testing Guide' +
      ' <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;margin-left:8px;vertical-align:middle" onclick="openArchivedPrdModal()">Back</button>';
    document.getElementById('modal-body').innerHTML = renderMd(content);
    _modalDocContext = { title: 'Manual Testing Guide', content, selection: '' };
    _modalFilePath = 'prd/' + normalizedFile; showModalQa();
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    document.getElementById('modal').classList.add('open');
  } catch (e) { alert('Failed to load guide: ' + e.message); }
}

async function triggerVerify(file, btn) {
  if (btn) { btn.dataset.origText = btn.textContent; btn.textContent = 'Verifying...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetch('/api/plans/trigger-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const d = await res.json();
    if (res.ok && d.ok) {
      try { closeModal(); } catch { /* may not be open */ }
      refresh();
      showToast('cmd-toast', d.verifyId ? 'Verify task ' + d.verifyId + ' created' : (d.message || 'Done'), true);
    } else {
      if (btn) { btn.textContent = btn.dataset.origText || 'Verify'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      alert('Failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { if (btn) { btn.textContent = btn.dataset.origText || 'Verify'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Error: ' + e.message); }
}

async function planUnarchive(file, btn) {
  try { closeModal(); } catch {}
  showToast('cmd-toast', 'Restored from archive', true);
  try {
    const res = await fetch('/api/plans/unarchive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    if (res.ok) { refreshPlans(); refresh(); }
    else { const d = await res.json().catch(() => ({})); alert('Unarchive failed: ' + (d.error || 'unknown')); refresh(); }
  } catch (e) { alert('Error: ' + e.message); refresh(); }
}

window.MinionsPlans = { openCreatePlanModal, refreshPlans, derivePlanStatus, renderPlans, openArchivedPlansModal, planExecute, planSubmitRevise, planShowRevise, planHideRevise, planView, planApprove, planArchive, planUnarchive, planDelete, planPause, planReject, planDiscuss, planOpenInDocChat, planRegeneratePRD, openVerifyGuide, triggerVerify };
