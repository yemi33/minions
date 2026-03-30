// render-plans.js — Plan rendering functions extracted from dashboard.html

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
  const title = document.getElementById('plan-new-title')?.value?.trim();
  const content = document.getElementById('plan-new-content')?.value?.trim();
  if (!title) { alert('Title is required'); return; }
  if (!content) { alert('Plan content is required'); return; }
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
  const allDone = implementWi.length > 0 && implementWi.every(w =>
    w.status === 'done' || w.status === 'in-pr' || w.status === 'implemented' || w.status === 'complete'
  );
  const hasFailed = implementWi.some(w => w.status === 'failed');

  // User-set statuses take priority when no work has started
  if (prdJsonStatus === 'rejected') return 'rejected';
  if (prdJsonStatus === 'paused' && !allDone) return 'paused';
  if (prdJsonStatus === 'revision-requested') return 'revision-requested';

  // Derive from work item progress
  if (allDone && !hasActiveWork) return 'completed';
  if (hasActiveWork || hasPendingPrd) return 'in-progress';
  if (hasFailed && !hasActiveWork) return 'has-failures';
  if (prdJsonStatus === 'awaiting-approval' && implementWi.length === 0) return 'awaiting-approval';
  if (prdJsonStatus === 'approved' && implementWi.length === 0) return 'approved';

  return prdJsonStatus || 'active';
}

function renderPlans(plans) {
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
    // (p.status for .md is 'draft'/'converted'/'active', not the PRD lifecycle status)
    let prdJsonStatus = p.status || 'active';
    if (prdFile && p.format !== 'prd') {
      const linkedPrd = plans.find(pp => pp.file === prdFile && pp.format === 'prd');
      if (linkedPrd) prdJsonStatus = linkedPrd.status || prdJsonStatus;
    }

    // Single source of truth: derive status from work items
    const effectiveStatus = isArchived ? 'completed' : derivePlanStatus(prdFile, p.file, prdJsonStatus, allWi);

    const statusLabelsMap = {
      'completed': 'Completed', 'in-progress': 'In Progress', 'paused': 'Paused',
      'awaiting-approval': 'Awaiting Approval', 'approved': 'Approved', 'rejected': 'Rejected',
      'revision-requested': 'Revision Requested', 'has-failures': 'Has Failures', 'active': 'Active'
    };
    const label = statusLabelsMap[effectiveStatus] || effectiveStatus;
    const needsAction = (effectiveStatus === 'awaiting-approval' || effectiveStatus === 'paused') && !isArchived;
    const isRevision = effectiveStatus === 'revision-requested';
    const isCompleted = effectiveStatus === 'completed';
    const isDraft = (p.format === 'draft' || rawStatus === 'draft') && !isCompleted;
    // For .md drafts: show Execute only if no PRD exists yet (not already executed)

    let actions = '';
    if (needsAction) {
      // Approve/Reject target the PRD .json file (not the .md plan) since the API parses it as JSON
      const actionTarget = prdFile || p.file;
      actions = '<div class="plan-card-actions" onclick="event.stopPropagation()">' +
        '<button class="plan-btn approve" onclick="planApprove(\'' + escHtml(actionTarget) + '\')">Approve</button>' +
        '<button class="plan-btn" style="color:var(--blue);border-color:var(--blue)" onclick="planDiscuss(\'' + escHtml(p.file) + '\')">Discuss &amp; Revise</button>' +
        '<button class="plan-btn reject" onclick="planReject(\'' + escHtml(actionTarget) + '\')">Reject</button>' +
      '</div>' +
      '<div id="revise-input-' + escHtml(p.file).replace(/\./g, '-') + '" style="display:none">' +
        '<textarea class="plan-feedback-input" placeholder="What should be changed? Be specific..." id="revise-feedback-' + escHtml(p.file).replace(/\./g, '-') + '"></textarea>' +
        '<div class="plan-card-actions" style="margin-top:4px">' +
          '<button class="plan-btn revise" onclick="planSubmitRevise(\'' + escHtml(p.file) + '\')">Submit Revision Request</button>' +
          '<button class="plan-btn" onclick="planHideRevise(\'' + escHtml(p.file) + '\')">Cancel</button>' +
        '</div>' +
      '</div>';
    } else if (isRevision) {
      actions = '<div class="plan-card-meta" style="margin-top:6px;color:var(--purple,#a855f7)">Revision in progress: ' + escHtml((p.revisionFeedback || '').slice(0, 100)) + '</div>';
    }

    const executeBtn = isDraft && effectiveStatus === 'active' && !isArchived && !prdFile ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);font-weight:600" ' +
      'onclick="event.stopPropagation();planExecute(\'' + escHtml(p.file) + '\',\'' + escHtml(p.project) + '\',this)">Execute</button>' : '';
    const showPause = effectiveStatus === 'in-progress' && prdFile && !isArchived;
    const showResume = (effectiveStatus === 'paused' || effectiveStatus === 'awaiting-approval') && prdFile && !isArchived;
    const pauseBtn = showPause ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow)" ' +
      'onclick="event.stopPropagation();planPause(\'' + escHtml(prdFile) + '\')">Pause</button>' : '';
    const resumeBtn = showResume
      ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green)" ' +
        'onclick="event.stopPropagation();planApprove(\'' + escHtml(prdFile) + '\')">' + (effectiveStatus === 'awaiting-approval' ? 'Approve' : 'Resume') + '</button>'
      : '';
    const deleteBtn = !isArchived ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red)" ' +
      'onclick="event.stopPropagation();planDelete(\'' + escHtml(p.file) + '\')">Delete</button>' : '';

    const versionBadge = p.version ? ' <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(56,139,253,0.15);color:var(--blue);vertical-align:middle">v' + p.version + '</span>' : '';
    const statusColors = { 'completed': 'var(--green)', 'in-progress': 'var(--blue)', 'paused': 'var(--muted)', 'awaiting-approval': 'var(--yellow)', 'approved': 'var(--green)', 'rejected': 'var(--red)', 'has-failures': 'var(--red)', 'revision-requested': 'var(--purple,#a855f7)', 'active': 'var(--muted)' };
    const cardClass = effectiveStatus === 'in-progress' ? 'working' : effectiveStatus === 'awaiting-approval' || effectiveStatus === 'paused' ? 'awaiting' : effectiveStatus;
    return '<div class="plan-card ' + cardClass + '" data-file="plans/' + escHtml(p.file) + '" style="cursor:pointer' + (isArchived ? ';opacity:0.7' : '') + '" onclick="planView(\'' + escHtml(p.file) + '\')">' +
      '<div class="plan-card-header">' +
        '<div><div class="plan-card-title">' + escHtml(p.summary || p.file) + versionBadge + '</div>' +
          '<div class="plan-card-meta">' +
            '<span style="font-weight:600;color:' + (statusColors[effectiveStatus] || 'var(--muted)') + '">' + label + '</span>' +
            '<span>' + escHtml(p.project) + '</span>' +
            '<span>' + p.itemCount + ' items</span>' +
            (p.updatedAt ? '<span title="Last updated: ' + p.updatedAt + '">Updated ' + timeAgo(p.updatedAt) + '</span>' : '') +
            (p.completedAt ? '<span>' + p.completedAt.slice(0, 10) + '</span>' : '') +
            (p.generatedBy ? '<span>by ' + escHtml(p.generatedBy) + '</span>' : '') +
            executeBtn + pauseBtn + resumeBtn + deleteBtn +
          '</div>' +
        '</div>' +
      '</div>' +
      actions +
    '</div>';
  }

  let html = activePlans.map(renderPlanCard).join('');

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
  const plans = window._archivedPlans || [];
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
function qaDisablePrdButtons() {
  const container = document.getElementById('qa-generate-prd-btn');
  if (container) container.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
}

// Show plan version action buttons (Run alongside / Replace / Just save)
function showPlanVersionActions(thread, newFile, originalFile) {
  const esc = newFile.replace(/'/g, "\\'");
  // Look up existing PRD for the original plan's project
  const allPlans = window._lastStatus?.plans || [];
  const origPlan = allPlans.find(p => p.file === originalFile);
  const project = origPlan?.project || '';
  const existingPrd = allPlans.find(p => p.file.endsWith('.json') && p.project === project && p.status !== 'completed');

  const btn = document.createElement('div');
  btn.id = 'qa-generate-prd-btn';
  btn.style.cssText = 'margin:8px 0;padding:8px 12px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:8px';

  if (existingPrd) {
    btn.innerHTML = '<span style="color:var(--green);font-weight:600;font-size:12px;width:100%">New plan version created — existing PRD running</span>' +
      '<button onclick="qaNewPrd(\'' + esc + '\')" style="background:var(--green);color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer" title="Execute this plan as a separate PRD alongside the current one">Run alongside</button>' +
      '<button onclick="qaReplacePrd(\'' + esc + '\')" style="background:var(--orange);color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer" title="Pause existing PRD, clean pending items, execute this plan instead">Replace old PRD</button>' +
      '<button onclick="qaJustSave(this)" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer" title="Keep the new version saved without dispatching any work">Just save</button>' +
      '<span style="color:var(--muted);font-size:10px;width:100%">Run alongside keeps current work going. Replace pauses it and starts fresh.</span>';
  } else {
    btn.innerHTML = '<span style="color:var(--green);font-weight:600;font-size:12px;width:100%">New plan version created</span>' +
      '<button onclick="qaNewPrd(\'' + esc + '\')" style="background:var(--green);color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer">Execute plan</button>' +
      '<button onclick="qaJustSave(this)" style="background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer">Just save</button>' +
      '<span style="color:var(--muted);font-size:10px">Execute dispatches an agent to create PRD items from this plan</span>';
  }
  // Remove any previous action buttons
  const old = thread.querySelector('#qa-generate-prd-btn');
  if (old) old.remove();
  thread.appendChild(btn);
}

function qaJustSave(el) {
  const container = el.closest('#qa-generate-prd-btn');
  if (container) container.innerHTML = '<span style="color:var(--muted);font-size:11px">Saved. No work dispatched.</span>';
}

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

async function planView(file) {
  try {
    const normalizedFile = normalizePlanFile(file);
    const planRes = await fetch('/api/plans/' + encodeURIComponent(normalizedFile));
    const lastMod = planRes.headers.get('Last-Modified');
    const resolvedPath = planRes.headers.get('X-Resolved-Path');
    const raw = await planRes.text();
    let title = normalizedFile;
    let text = '';

    if (normalizedFile.endsWith('.json')) {
      // PRD JSON — format nicely
      const plan = JSON.parse(raw);
      title = plan.plan_summary || normalizedFile;
      const items = (plan.missing_features || []).map((f, i) =>
        (i + 1) + '. [' + f.id + '] ' + f.name + ' (' + (f.estimated_complexity || '?') + ', ' + (f.priority || '?') + ')' +
        (f.depends_on?.length ? ' → depends on: ' + f.depends_on.join(', ') : '') +
        '\n   ' + (f.description || '').slice(0, 200) +
        (f.acceptance_criteria?.length ? '\n   Criteria: ' + f.acceptance_criteria.join('; ') : '')
      ).join('\n\n');
      text = 'Project: ' + (plan.project || '?') +
        '\nStrategy: ' + (plan.branch_strategy || 'parallel') +
        '\nBranch: ' + (plan.feature_branch || 'per-item') +
        '\nStatus: ' + (plan.status || 'active') +
        '\nGenerated by: ' + (plan.generated_by || '?') + ' on ' + (plan.generated_at || '?') +
        '\n\n--- Items (' + (plan.missing_features || []).length + ') ---\n\n' + items +
        (plan.open_questions?.length ? '\n\n--- Open Questions ---\n\n' + plan.open_questions.map(q => '• ' + q).join('\n') : '');
    } else {
      // Markdown plan — show as-is
      text = raw;
      const titleMatch = raw.match(/^#\s+(?:Plan:\s*)?(.+)/m);
      if (titleMatch) title = titleMatch[1];
    }

    // Version badge for the modal title
    const vMatch = normalizedFile.match(/-v(\d+)/);
    const versionLabel = vMatch ? ' (v' + vMatch[1] + ')' : '';

    // Determine plan type and status for action buttons
    const isMdPlan = normalizedFile.endsWith('.md');
    let planStatus = '';
    try { if (normalizedFile.endsWith('.json')) planStatus = JSON.parse(raw).status || ''; } catch {}
    const isActive = planStatus === 'approved' || planStatus === 'active';
    const isPaused = planStatus === 'awaiting-approval' || planStatus === 'paused';
    // Check if work is in progress for this plan
    const wi = window._lastWorkItems || [];
    const hasActiveWork = wi.some(w =>
      (w.status === 'pending' || w.status === 'dispatched') &&
      (w.planFile === normalizedFile || w.sourcePlan === normalizedFile ||
       // For .md plans: any work item with a sourcePlan .json means the plan is being executed
        (isMdPlan && w.sourcePlan && w.sourcePlan.endsWith('.json')))
    );
    const prdCompleted = wi.some(w => w.type === 'plan-to-prd' && w.status === 'done' && w.planFile === normalizedFile);
    // Check if a PRD already exists for this plan (via plans list sourcePlan linkage)
    const hasPrd = (window._lastStatus?.plans || []).some(p => p.sourcePlan === normalizedFile && p.format === 'prd');
    const modalShowResume = isPaused;
    const modalExecuteBtn = isMdPlan && !modalShowResume && !hasActiveWork && !prdCompleted && !hasPrd ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green);font-weight:600" ' +
      'onclick="planExecute(\'' + escHtml(normalizedFile) + '\',\'\',this)">Execute</button>' : '';
    const modalCompletedLabel = prdCompleted && !hasActiveWork ? '<span style="font-size:10px;color:var(--green);font-weight:600">Completed</span>' : '';
    const modalInProgressLabel = hasActiveWork ? '<span style="font-size:10px;color:var(--blue)">In Progress</span>' : '';
    const isModalCompleted = planStatus === 'completed';
    const modalPauseBtn = isActive && !isMdPlan && !isModalCompleted ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--yellow)" ' +
      'onclick="planPause(\'' + escHtml(normalizedFile) + '\');closeModal()">Pause</button>' : '';
    const modalResumeBtn = isPaused ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green)" ' +
      'onclick="planApprove(\'' + escHtml(normalizedFile) + '\');closeModal()">Resume</button>' : '';

    const lastModLabel = lastMod ? '<div style="font-size:10px;color:var(--muted);font-weight:400;margin-top:2px">Last updated: ' + new Date(lastMod).toLocaleString() + '</div>' : '';
    const actionBtns = '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">' +
      (modalCompletedLabel || '') + (modalInProgressLabel || '') + (modalExecuteBtn || '') + (modalPauseBtn || '') + (modalResumeBtn || '') +
      ' <button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--red)" ' +
      'onclick="planDelete(\'' + escHtml(normalizedFile) + '\')">Delete</button>' +
    '</div>';
    document.getElementById('modal-title').innerHTML = escHtml(title) + (versionLabel ? ' <span style="font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px;background:rgba(56,139,253,0.15);color:var(--blue)">' + escHtml(versionLabel) + '</span>' : '') + lastModLabel + actionBtns;
    document.getElementById('modal-body').textContent = text;
    document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
    document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
    _modalDocContext = { title, content: text, selection: '' };
    _modalFilePath = resolvedPath || ((normalizedFile.endsWith('.json') ? 'prd/' : 'plans/') + normalizedFile); showModalQa();
    // Clear notification badge when opening this document
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    // steer btn removed — unified send
    document.getElementById('modal').classList.add('open');
  } catch (e) { console.error(e); }
}

async function planApprove(file) {
  try {
    const res = await fetch('/api/plans/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    if (res.ok) {
      showToast('cmd-toast', 'Plan approved — work will begin on next engine tick', true);
      refreshPlans();
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Approve failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function planDelete(file) {
  if (!confirm('Delete plan "' + file + '"? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/plans/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    if (res.ok) {
      closeModal();
      showToast('cmd-toast', 'Plan deleted', true);
      refreshPlans();
      refresh();
    } else {
      const d = await res.json();
      alert('Failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function planPause(file) {
  try {
    const res = await fetch('/api/plans/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
    if (res.ok) {
      showToast('cmd-toast', 'Plan paused — no new items will be dispatched', true);
      refreshPlans();
      refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Pause failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
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
    document.getElementById('modal-body').textContent = text;
    document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
    document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
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

async function openVerifyGuide(file) {
  try {
    const normalizedFile = normalizePlanFile(file);
    const content = await fetch('/api/plans/' + encodeURIComponent(normalizedFile)).then(r => r.text());
    document.getElementById('modal-title').innerHTML = 'Manual Testing Guide' +
      ' <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;margin-left:8px;vertical-align:middle" onclick="openArchivedPrdModal()">Back</button>';
    document.getElementById('modal-body').textContent = content;
    document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
    document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
    _modalDocContext = { title: 'Manual Testing Guide', content, selection: '' };
    _modalFilePath = 'prd/' + normalizedFile; showModalQa();
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    document.getElementById('modal').classList.add('open');
  } catch (e) { alert('Failed to load guide: ' + e.message); }
}

async function triggerVerify(file) {
  try {
    const res = await fetch('/api/plans/trigger-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const d = await res.json();
    if (res.ok && d.ok) {
      closeModal();
      refresh();
      showToast('cmd-toast', d.verifyId ? 'Verify task ' + d.verifyId + ' created' : (d.message || 'Done'), true);
    } else {
      alert('Failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}
