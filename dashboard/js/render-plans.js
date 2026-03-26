// render-plans.js — Plan rendering functions extracted from dashboard.html

async function refreshPlans() {
  try {
    const plans = await fetch('/api/plans').then(r => r.json());
    renderPlans(plans);
  } catch {}
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
  const pausedPlanFiles = new Set();
  const awaitingApprovalPlanFiles = new Set();
  const planToPrdFile = {}; // .md filename → .json PRD filename
  for (const p of plans) {
    if (p.format === 'prd' && !p.archived && p.sourcePlan) {
      const sourceKeys = [p.sourcePlan, normalizeSourcePlanKey(p.sourcePlan)];
      for (const sourceKey of sourceKeys) {
        if (!sourceKey) continue;
        planToPrdFile[sourceKey] = p.file;
        if (p.status === 'paused') pausedPlanFiles.add(sourceKey);
        if (p.status === 'awaiting-approval') awaitingApprovalPlanFiles.add(sourceKey);
      }
    }
  }

  const activePlans = plans.filter(p => !p.archived && p.format !== 'prd');
  const archivedPlans = plans.filter(p => p.archived && p.format !== 'prd');
  countEl.textContent = activePlans.length + (archivedPlans.length ? ' + ' + archivedPlans.length + ' archived' : '');

  function renderPlanCard(p) {
    const status = p.status || 'active';
    const isWorking = workingPlanFiles.has(p.file);
    const isPrdPaused = pausedPlanFiles.has(p.file);
    const isPrdAwaitingApproval = awaitingApprovalPlanFiles.has(p.file);
    const isPrdBlocked = isPrdPaused || isPrdAwaitingApproval;
    const isArchived = p.archived;
    const label = isArchived
      ? 'Completed'
      : isPrdAwaitingApproval
        ? 'Awaiting Approval'
        : isPrdPaused
          ? 'Paused'
          : isWorking
            ? 'In Progress'
            : (statusLabels[status] || status);
    const needsAction = (status === 'awaiting-approval' || status === 'paused' || isPrdAwaitingApproval || isPrdPaused) && !isArchived;
    const isRevision = status === 'revision-requested' && !isArchived;
    const isCompleted = status === 'completed';
    const isDraft = (p.format === 'draft' || status === 'draft') && !isCompleted;
    const isAwaitingApproval = status === 'awaiting-approval';
    const isPaused = status === 'paused';
    const isApproved = status === 'approved' || status === 'active';
    // For .md drafts: show Execute only if no PRD exists yet (not already executed)
    const prdFile = planToPrdFile[p.file] || (p.file.endsWith('.json') ? p.file : '');

    let actions = '';
    const resumeVisible = ((isPrdBlocked || isAwaitingApproval || isPaused) && prdFile && !isArchived);
    if (needsAction && !resumeVisible) {
      actions = '<div class="plan-card-actions" onclick="event.stopPropagation()">' +
        '<button class="plan-btn approve" onclick="planApprove(\'' + escHtml(p.file) + '\')">Approve</button>' +
        '<button class="plan-btn" style="color:var(--blue);border-color:var(--blue)" onclick="planDiscuss(\'' + escHtml(p.file) + '\')">Discuss &amp; Revise</button>' +
        '<button class="plan-btn reject" onclick="planReject(\'' + escHtml(p.file) + '\')">Reject</button>' +
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

    const executeBtn = isDraft && !isWorking && !isPrdBlocked && !isArchived && !prdFile ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);font-weight:600" ' +
      'onclick="event.stopPropagation();planExecute(\'' + escHtml(p.file) + '\',\'' + escHtml(p.project) + '\',this)">Execute</button>' : '';
    // Pause/Resume: target the PRD .json file if it exists, otherwise the plan itself
    const effectivelyPaused = isPrdBlocked || isAwaitingApproval || isPaused;
    const showPause = !effectivelyPaused && prdFile && !isArchived && !isCompleted;
    const showResume = effectivelyPaused && prdFile && !isArchived;
    const pauseBtn = showPause ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow)" ' +
      'onclick="event.stopPropagation();planPause(\'' + escHtml(prdFile) + '\')">Pause</button>' : '';
    const resumeBtn = showResume
      ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green)" ' +
        'onclick="event.stopPropagation();planApprove(\'' + escHtml(prdFile) + '\')">' + (isPrdAwaitingApproval || isAwaitingApproval ? 'Approve' : 'Resume') + '</button>'
      : '';
    const deleteBtn = !isArchived ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red)" ' +
      'onclick="event.stopPropagation();planDelete(\'' + escHtml(p.file) + '\')">Delete</button>' : '';

    const versionBadge = p.version ? ' <span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(56,139,253,0.15);color:var(--blue);vertical-align:middle">v' + p.version + '</span>' : '';
    return '<div class="plan-card ' + statusClass(status) + (isWorking && !isPrdBlocked ? ' working' : '') + (isPrdBlocked ? ' awaiting' : '') + '" data-file="plans/' + escHtml(p.file) + '" style="cursor:pointer' + (isArchived ? ';opacity:0.7' : '') + '" onclick="planView(\'' + escHtml(p.file) + '\')">' +
      '<div class="plan-card-header">' +
        '<div><div class="plan-card-title">' + escHtml(p.summary || p.file) + versionBadge + '</div>' +
          '<div class="plan-card-meta">' +
            '<span style="font-weight:600;color:' + (isArchived || isCompleted ? 'var(--green)' : isPrdAwaitingApproval ? 'var(--yellow)' : isPrdPaused ? 'var(--muted)' : isWorking ? 'var(--blue)' : needsAction ? 'var(--yellow,#d29922)' : status === 'approved' ? 'var(--green)' : 'var(--muted)') + '">' + label + '</span>' +
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
