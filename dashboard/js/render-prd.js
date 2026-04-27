// render-prd.js — PRD-related rendering functions extracted from dashboard.html

function _prdItemDeleteKey(source, itemId) {
  return 'prd-item:' + (source || '') + ':' + (itemId || '');
}

function renderPrd(prd, prog) {
  const section = document.getElementById('prd-content');
  const badge = document.getElementById('prd-badge');
  if (!prd) {
    section.innerHTML = '<p class="prd-pending" style="margin-bottom:0">No PRD found.</p>';
    badge.innerHTML = '';
    return;
  }
  if (prd.error) {
    section.innerHTML = '<p style="color:var(--orange);margin-bottom:0">PRD file found but has parse errors.</p>';
    return;
  }

  const statusColors = { 'completed': 'var(--green)', 'dispatched': 'var(--blue)', 'awaiting-approval': 'var(--yellow)', 'paused': 'var(--muted)', 'approved': 'var(--green)' };
  const statusLabels = { 'completed': 'Completed', 'dispatched': 'In Progress', 'awaiting-approval': 'Awaiting Approval', 'paused': 'Paused', 'approved': 'Approved' };

  // Show per-PRD status summary in header when multiple PRDs exist
  const existing = (prd.existing || []).filter(function(p) { return !isDeleted('plan:' + (p.file || '')); });
  const allWi = window._lastWorkItems || [];
  const prdItems = (prog?.items || []).filter(i => !i._archived && !isDeleted('plan:' + (i.source || '')) && !isDeleted(_prdItemDeleteKey(i.source, i.id)));

  if (existing.length === 0 && prdItems.length === 0) {
    section.innerHTML = '<p class="prd-pending" style="margin-bottom:0">No PRD found.</p>';
    badge.innerHTML = '';
    return;
  }

  if (existing.length <= 1) {
    // Single PRD — show status + actions in header
    const implementItems = allWi.filter(w => prdItems.some(pi => pi.id === w.id));
    const allDone = implementItems.length > 0 && implementItems.every(w => w.status === 'done');
    const hasActive = implementItems.some(w => w.status === 'pending' || w.status === 'dispatched');
    const prdFile = existing[0]?.file || '';
    const prdStatus = existing[0]?.status || '';
    const effectiveStatus = allDone && !hasActive ? 'completed' : hasActive ? 'dispatched' : prdStatus || 'active';

    const headerStale = existing[0]?.planStale || prdItems.some(i => i.planStale);
    let actions = '';
    if (prdFile && !headerStale) {
      if (effectiveStatus === 'awaiting-approval') {
        actions = ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--green);border-color:var(--green);margin-left:4px" onclick="planApprove(\'' + escHtml(prdFile) + '\',this)">Approve</button>';
      } else if (effectiveStatus === 'completed') {
        const hasVerifyWi = allWi.some(w => w.itemType === 'verify' && w.sourcePlan === prdFile);
        actions = (hasVerifyWi ? '' : ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--green);border-color:var(--green);margin-left:4px" onclick="triggerVerify(\'' + escHtml(prdFile) + '\',this)">Verify</button>') +
          ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;margin-left:4px" onclick="planArchive(\'' + escHtml(prdFile) + '\',this)">Archive</button>';
      } else if (effectiveStatus === 'dispatched') {
        actions = ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--yellow);border-color:var(--yellow);margin-left:4px" onclick="planPause(\'' + escHtml(prdFile) + '\',this)">Pause</button>';
      } else if (effectiveStatus === 'paused') {
        actions = ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--green);border-color:var(--green);margin-left:4px" onclick="planApprove(\'' + escHtml(prdFile) + '\',this)">Resume</button>' +
          ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;margin-left:4px" onclick="planArchive(\'' + escHtml(prdFile) + '\',this)">Archive</button>';
      }
    }
    badge.innerHTML = '<span style="font-weight:600;font-size:11px;color:' + (statusColors[effectiveStatus] || 'var(--muted)') + '">' + (statusLabels[effectiveStatus] || effectiveStatus) + '</span>' +
      ' <span style="color:var(--muted);font-size:10px">' + (prd.age || '') + '</span>' + actions;
  } else {
    // Multiple PRDs — show count summary, per-PRD details are in renderPrdProgress groups
    const counts = { completed: 0, 'dispatched': 0, 'awaiting-approval': 0, paused: 0 };
    for (const p of existing) {
      const items = prdItems.filter(i => i.source === p.file);
      const wiForPrd = allWi.filter(w => items.some(pi => pi.id === w.id));
      const allDone = wiForPrd.length > 0 && wiForPrd.every(w => w.status === 'done');
      const hasActive = wiForPrd.some(w => w.status === 'pending' || w.status === 'dispatched');
      const s = allDone && !hasActive ? 'completed' : hasActive ? 'dispatched' : p.status || 'active';
      counts[s] = (counts[s] || 0) + 1;
    }
    const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) =>
      '<span style="font-size:10px;color:' + (statusColors[s] || 'var(--muted)') + '">' + n + ' ' + (statusLabels[s] || s).toLowerCase() + '</span>'
    );
    badge.innerHTML = '<span style="font-weight:600;font-size:11px;color:var(--text)">' + existing.length + ' PRDs</span> ' + parts.join(' · ');
  }
  section.innerHTML = '';
}

function _renderPrLink(pr, opts) {
  var size = (opts && opts.size) || '10px';
  var statusColor = pr.status === 'merged' ? 'var(--green)' : pr.status === 'abandoned' ? 'var(--red)' : 'var(--blue)';
  var statusIcon = pr.status === 'merged' ? '✓' : pr.status === 'abandoned' ? '✗' : '○';
  return '<a href="' + escHtml(pr.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:' + size + ';color:' + statusColor + ';text-decoration:underline;cursor:pointer;margin-left:4px" title="' + escHtml((pr.title || '') + ' (' + (pr.status || 'active') + ')') + '">' + statusIcon + ' ' + escHtml(pr.id) + '</a>';
}

function renderPrdProgress(prog) {
  const el = document.getElementById('prd-progress-content');
  const countEl = document.getElementById('prd-progress-count');
  if (!prog) { el.innerHTML = ''; countEl.textContent = '—'; return; }
  const visibleItems = (prog.items || []).filter(i => !isDeleted('plan:' + (i.source || '')) && !isDeleted(_prdItemDeleteKey(i.source, i.id)));

  // Compute overall progress from active (non-archived) items
  const activeItems = visibleItems.filter(i => !i._archived);
  if (activeItems.length > 0) {
    const activeDone = activeItems.filter(i => i.status === 'done').length;
    countEl.textContent = Math.round((activeDone / activeItems.length) * 100) + '%';
  } else {
    countEl.textContent = '—';
  }

  function renderGroupStats(items) {
    const total = items.length;
    if (total === 0) return '';
    const done = items.filter(i => i.status === 'done').length;
    const inProgress = items.filter(i => i.status === 'in-progress').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const paused = items.filter(i => i.status === 'paused').length;
    const updated = items.filter(i => i.status === 'updated').length;
    const missing = items.filter(i => i.status === 'missing' || !i.status).length;
    const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : 0;

    const stats = '<div class="prd-stats" style="margin:0">' +
      '<div class="prd-stat"><div class="prd-stat-num green">' + done + '</div><div class="prd-stat-label">Done</div></div>' +
      '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--yellow)">' + inProgress + '</div><div class="prd-stat-label">Active</div></div>' +
      (failed ? '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--red)">' + failed + '</div><div class="prd-stat-label">Failed</div></div>' : '') +
      (paused ? '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--muted)">' + paused + '</div><div class="prd-stat-label">Paused</div></div>' : '') +
      (updated ? '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--purple)">' + updated + '</div><div class="prd-stat-label">Needs Redo</div></div>' : '') +
      '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--muted)">' + missing + '</div><div class="prd-stat-label">To Do</div></div>' +
      '<div class="prd-stat"><div class="prd-stat-num" style="color:var(--text)">' + total + '</div><div class="prd-stat-label">Total</div></div>' +
    '</div>';

    const bar = '<div class="prd-progress-bar">' +
      '<div class="seg complete" style="width:' + pct(done) + '%"></div>' +
      '<div class="seg in-progress" style="width:' + pct(inProgress) + '%"></div>' +
      '<div class="seg updated" style="width:' + pct(updated) + '%"></div>' +
      '<div class="seg paused" style="width:' + pct(paused) + '%"></div>' +
      '<div class="seg missing" style="width:' + pct(missing) + '%"></div>' +
    '</div>';

    return '<div style="margin:6px 0 8px 0;padding:0 8px">' + stats + '<div style="margin-top:8px">' + bar + '</div></div>';
  }

  // PRD item statuses: missing → in-progress → done
  const statusBadge = (s, itemId) => {
    // Decomposed: show WIP if children still running, DONE if all children done
    if (s === 'decomposed' && itemId) {
      const children = (window._lastWorkItems || []).filter(w => w.parent_id === itemId);
      const allChildrenDone = children.length > 0 && children.every(c => c.status === 'done');
      if (allChildrenDone) { s = 'done'; }
      else { s = 'in-progress'; } // show as WIP while children are running
    }
    const styles = {
      'done': 'background:rgba(63,185,80,0.15);color:var(--green)',
      'in-progress': 'background:rgba(210,153,34,0.15);color:var(--yellow);animation:wipPulse 1.5s infinite',
      'failed':      'background:rgba(248,81,73,0.15);color:var(--red)',
      'paused':      'background:rgba(139,148,158,0.15);color:var(--muted)',
      'updated':     'background:rgba(188,140,255,0.15);color:var(--purple)',
    };
    const labels = { 'done': 'DONE', 'in-progress': 'WIP', 'failed': 'FAIL', 'paused': 'PAUSED', 'missing': '\u2014', 'updated': 'REDO' };
    const style = styles[s] || 'background:var(--surface);color:var(--muted)';
    const label = labels[s] || '—';
    return '<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:0.5px;white-space:nowrap;' + style + '">' + label + '</span>';
  };

  // Build work item lookup: PRD item ID → work item info
  const wiById = {};
  for (const w of (window._lastWorkItems || [])) {
    if (w.id) wiById[w.id] = w;
  }

  // Group items by source plan
  const grouped = {};
  for (const i of visibleItems) {
    const key = i.source || '_ungrouped';
    if (!grouped[key]) grouped[key] = { summary: i.planSummary || i.source || 'Items', _projects: [], file: i.source || '', items: [], archived: !!i._archived, planStatus: i.planStatus || 'active', sourcePlan: i.sourcePlan || '', branchStrategy: i.branchStrategy || 'parallel', planStale: i.planStale || false, lastSyncedFromPlan: i.lastSyncedFromPlan || null, prdUpdatedAt: i.prdUpdatedAt || null, completedAt: i.prdCompletedAt || '' };
    grouped[key].items.push(i);
    // Collect all unique projects across items in this group
    for (const p of (i.projects || [])) { if (p && !grouped[key]._projects.includes(p)) grouped[key]._projects.push(p); }
    if (i.project && !grouped[key]._projects.includes(i.project)) grouped[key]._projects.push(i.project);
    if (i.planProject && !grouped[key]._projects.includes(i.planProject)) grouped[key]._projects.push(i.planProject);
  }

  const renderItem = (i) => {
    const prLinks = (i.prs || []).map(function(pr) { return _renderPrLink(pr); }).join(' ');
    const projBadges = (i.projects || []).map(p =>
      '<span class="prd-project-badge">' + escHtml(p) + '</span>'
    ).join(' ');
    const src = escHtml(i.source || '');
    const iid = escHtml(i.id || '');

    // Linked work item info
    const wi = wiById[i.id];
    const wiAgent = wi?.dispatched_to ? (agentData.find(a => a.id === wi.dispatched_to) || {}) : null;
    const wiLabel = wi ? '<span style="font-size:9px;color:var(--muted);background:var(--surface);padding:1px 5px;border-radius:3px;border:1px solid var(--border)" title="Work item: ' + escHtml(wi.id) + '">' +
      escHtml(wi.id) + '</span>' : '';
    const agentLabel = wiAgent ? '<span style="font-size:9px;color:var(--muted)" title="' + escHtml(wiAgent.name || wi.dispatched_to) + '">' +
      (wiAgent.emoji || '') + ' ' + escHtml(wiAgent.name || wi.dispatched_to) + '</span>' : '';

    // Branch label — show the target branch for this item
    const wiBranch = wi ? (wi.branch || wi.featureBranch || (wi._artifacts && wi._artifacts.branch) || '') : '';
    const branchLabel = wiBranch
      ? '<span style="font-size:9px;color:var(--muted);background:var(--surface);padding:1px 5px;border-radius:3px;border:1px solid var(--border);font-family:monospace;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle" title="Branch: ' + escHtml(wiBranch) + '">&#x1F33F; ' + escHtml(wiBranch) + '</span>'
      : '';

    // Requeue button for failed items or PRD items with no work item (orphaned/deleted)
    const canRequeue = (wi && (wi.status === 'failed' || i.status === 'failed')) ||
      (!wi && i.status && i.status !== 'missing' && i.status !== 'done' && i.status !== 'planned');
    const requeueState = getPrdRequeueState(wi ? wi.id : i.id);
    let requeueBtn = '';
    if (requeueState && requeueState.status === 'pending') {
      requeueBtn = '<span style="color:var(--yellow);cursor:wait;font-size:9px;padding:1px 5px;background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.35);border-radius:3px" title="Retry request in progress">requeuing…</span>';
    } else if (requeueState && requeueState.status === 'queued') {
      requeueBtn = '<span style="color:var(--green);cursor:default;font-size:9px;padding:1px 5px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.35);border-radius:3px" title="Successfully requeued">requeued</span>';
    } else if (requeueState && requeueState.status === 'error') {
      requeueBtn = '<span style="color:var(--red);cursor:default;font-size:9px;padding:1px 5px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:3px" title="' + escHtml(requeueState.message || 'Retry failed') + '">retry failed</span>';
    } else if (canRequeue) {
      requeueBtn = '<span onclick="event.stopPropagation();prdItemRequeue(\'' + escHtml(wi ? wi.id : i.id) + '\',\'' + escHtml(wi ? (wi._source || '') : '') + '\',\'' + escHtml(i.source || '') + '\')" style="color:var(--green);cursor:pointer;font-size:9px;padding:1px 5px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:3px" title="Requeue this work item">retry</span>';
    }

    // Re-open button for done items — sets PRD item to "updated" so engine re-dispatches
    const isDone = i.status === 'done' || (wi && wi.status === 'done');
    const reopenBtn = isDone
      ? '<span onclick="event.stopPropagation();prdItemReopen(\'' + escHtml(i.source || '') + '\',\'' + escHtml(i.id) + '\')" style="color:var(--blue);cursor:pointer;font-size:9px;padding:1px 5px;background:rgba(56,139,253,0.1);border:1px solid rgba(56,139,253,0.3);border-radius:3px" title="Re-open: set to updated so engine re-dispatches on existing branch">re-open</span>'
      : '';

    return '<div class="prd-item-row st-' + (i.status || 'missing') + '" style="flex-wrap:wrap;cursor:pointer" onclick="if(shouldIgnoreSelectionClick(event))return;prdItemEdit(\'' + src + '\',\'' + iid + '\')">' +
      statusBadge(i.status, i.id) +
      '<span class="prd-item-id">' + escHtml(i.id) + '</span>' +
      '<span class="prd-item-name" title="' + escHtml(i.name) + '">' + escHtml(i.name) + '</span>' +
      wiLabel +
      agentLabel +
      requeueBtn +
      reopenBtn +
      (projBadges ? '<span>' + projBadges + '</span>' : '') +
      (prLinks ? '<span>' + prLinks + '</span>' : '') +
      branchLabel +
      '<span class="prd-item-priority ' + (i.priority || '') + '">' + escHtml(i.priority || '') + '</span>' +
      '<span onclick="event.stopPropagation();prdItemRemove(\'' + src + '\',\'' + iid + '\')" style="color:var(--red);cursor:pointer;font-size:10px;padding:0 4px" title="Remove item">x</span>' +
      (i.description ? '<div style="width:100%;font-size:11px;color:var(--muted);padding:2px 0 2px 42px;line-height:1.4">' + renderMd(i.description) + '</div>' : '') +
      // Show decomposed children inline
      (i.status === 'decomposed' ? (function() {
        const children = (window._lastWorkItems || []).filter(w => w.parent_id === i.id);
        if (children.length === 0) return '';
        return '<div style="width:100%;padding:4px 0 4px 42px;display:flex;flex-direction:column;gap:2px">' +
          children.map(c => {
            const childAgent = c.dispatched_to ? (agentData.find(a => a.id === c.dispatched_to) || {}) : null;
            return '<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text);padding:2px 6px;background:var(--surface);border-radius:4px;border:1px solid var(--border)">' +
              statusBadge(c.status) +
              '<span style="color:var(--muted);font-size:9px">' + escHtml(c.id) + '</span>' +
              '<span style="flex:1">' + escHtml((c.title || '').replace('Implement: ', '').slice(0, 60)) + '</span>' +
              (childAgent ? '<span style="font-size:9px;color:var(--muted)">' + (childAgent.emoji || '') + ' ' + escHtml(childAgent.name || c.dispatched_to) + '</span>' : '') +
            '</div>';
          }).join('') +
        '</div>';
      })() : '') +
    '</div>';
  };

  const keys = Object.keys(grouped);
  const formatDuration = (ms) => {
    if (!ms || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  };

  const timings = prog.planTimings || {};

  const renderGroupHeader = (g) => {
    const done = g.items.filter(i => i.status === 'done').length;
    const wip = g.items.filter(i => i.status === 'in-progress' || i.status === 'missing').length;
    const summary = (g.summary || '').replace(/^Convert plan to PRD:\s*/i, '').slice(0, 80);
    const isAwaitingApproval = g.planStatus === 'awaiting-approval';
    const isPaused = g.planStatus === 'paused';
    const isBlocked = isAwaitingApproval || isPaused;

    // Runtime: from first dispatch to last completion (or now if still running, frozen if paused)
    const t = timings[g.file];
    let runtimeLabel = '';
    if (t && t.firstDispatched) {
      const end = t.allDone && t.lastCompleted ? t.lastCompleted : isBlocked ? (t.lastCompleted || t.firstDispatched) : Date.now();
      const elapsed = end - t.firstDispatched;
      const icon = t.allDone ? '&#x2713;' : isBlocked ? '&#x23F8;' : '&#x23F1;';
      runtimeLabel = '<span style="color:' + (t.allDone ? 'var(--green)' : isBlocked ? 'var(--muted)' : 'var(--yellow)') + ';font-weight:400;font-size:10px">' +
        icon + ' ' + formatDuration(elapsed) + (t.allDone ? '' : isAwaitingApproval ? ' (awaiting approval)' : isPaused ? ' (paused)' : ' elapsed') + '</span>';
    }

    const pausedLabel = isAwaitingApproval
      ? '<span style="color:var(--yellow);font-weight:600;font-size:10px;padding:1px 6px;border:1px solid var(--yellow);border-radius:3px">AWAITING APPROVAL</span>'
      : isPaused
        ? '<span style="color:var(--muted);font-weight:600;font-size:10px;padding:1px 6px;border:1px solid var(--muted);border-radius:3px">PAUSED</span>'
        : '';
    const showStale = (!isBlocked || isPaused) && g.planStale;
    const staleLabel = showStale
      ? '<span style="color:var(--orange);font-weight:700;font-size:10px;padding:1px 6px;border:1px solid var(--orange);border-radius:3px;background:rgba(210,153,34,0.12)" title="Source plan changed after this PRD was generated">STALE</span>'
      : '';
    const staleRecovery = showStale
      ? '<div style="width:100%;margin-top:4px;padding:6px 8px;border:1px solid rgba(210,153,34,0.35);border-radius:4px;background:rgba(210,153,34,0.08);display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span style="color:var(--orange);font-size:10px;font-weight:600">&#x26A0;&#xFE0F; Source plan was revised. This PRD may be outdated.</span>' +
          '<span onclick="event.stopPropagation();prdRegenerate(\'' + escHtml(g.file) + '\')" style="color:var(--green);cursor:pointer;font-size:10px;font-weight:700;padding:2px 8px;background:rgba(63,185,80,0.12);border:1px solid rgba(63,185,80,0.35);border-radius:4px" title="Compare revised plan against existing PRD and update items">Regenerate PRD</span>' +
          '<span onclick="event.stopPropagation();prdResumeWithoutRegen(\'' + escHtml(g.file) + '\')" style="color:var(--muted);cursor:pointer;font-size:10px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px" title="Resume without regenerating — use current PRD as-is">Resume as-is</span>' +
          '<span onclick="event.stopPropagation();planView(\'' + escHtml(g.sourcePlan || g.file) + '\')" style="color:var(--blue);cursor:pointer;font-size:10px;padding:2px 8px;background:rgba(56,139,253,0.1);border:1px solid rgba(56,139,253,0.3);border-radius:4px" title="Review latest plan changes">Review plan</span>' +
        '</div>'
      : '';
    const isCompleted = done > 0 && done === g.items.length;
    // Hide regular action buttons when stale banner is showing — stale banner has its own actions
    const isStale = showStale;
    const pauseResumeBtn = isStale ? '' : isAwaitingApproval
      ? '<span onclick="event.stopPropagation();planApprove(\'' + escHtml(g.file) + '\',this)" style="color:var(--green);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:3px">Approve</span>'
      : isPaused
        ? '<span onclick="event.stopPropagation();planApprove(\'' + escHtml(g.file) + '\',this)" style="color:var(--green);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:3px">Resume</span>'
        : isCompleted && !(window._lastWorkItems || []).some(w => w.itemType === 'verify' && w.sourcePlan === g.file)
          ? '<span onclick="event.stopPropagation();triggerVerify(\'' + escHtml(g.file) + '\',this)" style="color:var(--green);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:3px">Verify</span>'
          : isCompleted ? '' : '<span onclick="event.stopPropagation();planPause(\'' + escHtml(g.file) + '\',this)" style="color:var(--yellow);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.3);border-radius:3px">Pause</span>';
    const archiveBtn = (!isStale && (isCompleted || isPaused)) ? '<span onclick="event.stopPropagation();planArchive(\'' + escHtml(g.file) + '\',this)" style="color:var(--muted);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(139,148,158,0.1);border:1px solid rgba(139,148,158,0.3);border-radius:3px">Archive</span>' : '';
    const deleteBtn = '<span onclick="event.stopPropagation();planDelete(\'' + escHtml(g.file) + '\')" style="color:var(--red);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.3);border-radius:3px">Delete</span>';
    const sourcePlanLink = g.sourcePlan
      ? '<span onclick="event.stopPropagation();planView(\'' + escHtml(g.sourcePlan) + '\')" style="color:var(--blue);cursor:pointer;font-size:9px;padding:1px 6px;background:rgba(56,139,253,0.1);border:1px solid rgba(56,139,253,0.3);border-radius:3px" title="View source plan">&#x1F4C4; Plan</span>'
      : '';

    return '<div style="font-size:11px;font-weight:600;color:var(--blue);margin-bottom:4px;padding:6px 8px;background:var(--surface2);border-radius:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      (g._projects.length > 0 ? g._projects.map(function(p) { return '<span class="prd-project-badge">' + escHtml(p) + '</span>'; }).join(' ') : '') +
      '<span style="color:var(--text)">' + escHtml(summary || g.file) + '</span>' +
      (g.branchStrategy === 'shared-branch'
        ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(210,153,34,0.15);color:var(--yellow);font-weight:400" title="All items commit to a single shared feature branch">&#x1F333; shared branch</span>'
        : '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(56,139,253,0.12);color:var(--blue);font-weight:400" title="Each item gets its own branch (work/P-xxx) and PR">&#x1F500; parallel branches</span>') +
      pausedLabel +
      staleLabel +
      '<span style="font-weight:700;font-size:11px;color:' + (done === g.items.length && g.items.length > 0 ? 'var(--green)' : 'var(--text)') + '">' + (g.items.length > 0 ? Math.round((done / g.items.length) * 100) : 0) + '%</span>' +
      '<span style="color:var(--muted);font-weight:400;font-size:10px">' + g.items.length + ' items' +
        (done ? ' · ' + done + ' done' : '') + (wip ? ' · ' + wip + ' active' : '') +
      '</span>' +
      (g.prdUpdatedAt ? '<span style="color:var(--muted);font-weight:400;font-size:10px" title="PRD last updated: ' + g.prdUpdatedAt + '">PRD updated ' + timeAgo(g.prdUpdatedAt) + '</span>' : '') +
      runtimeLabel +
      (g.archived
        ? '<span style="color:var(--muted);font-weight:400;font-size:10px;margin-left:auto;display:flex;align-items:center;gap:6px">' +
            (g.sourcePlan
              ? '<span onclick="event.stopPropagation();planView(\'' + escHtml(g.sourcePlan) + '\')" style="color:var(--blue);cursor:pointer;font-size:10px;text-decoration:underline" title="View source plan">&#x1F4C4; ' + escHtml(g.sourcePlan) + '</span>'
              : '<span>' + escHtml(g.file) + '</span>') +
          '</span>'
        : '<span style="color:var(--muted);font-weight:400;font-size:10px;margin-left:auto;display:flex;align-items:center;gap:6px">' +
            sourcePlanLink +
            pauseResumeBtn +
            archiveBtn +
            deleteBtn +
          '</span>') +
      staleRecovery +
    '</div>';
  };

  // Graph view: render items as a dependency DAG
  const renderGraph = (items) => {
    // Build adjacency: compute depth (longest path from root)
    const byId = {};
    items.forEach(i => { byId[i.id] = i; });
    const depths = {};
    function getDepth(id, visited) {
      if (depths[id] !== undefined) return depths[id];
      if (!visited) visited = new Set();
      if (visited.has(id)) return 0;
      visited.add(id);
      const item = byId[id];
      if (!item || !item.depends_on || item.depends_on.length === 0) { depths[id] = 0; return 0; }
      let maxDep = 0;
      for (const depId of item.depends_on) {
        if (byId[depId]) maxDep = Math.max(maxDep, getDepth(depId, visited) + 1);
      }
      depths[id] = maxDep;
      return maxDep;
    }
    items.forEach(i => getDepth(i.id));

    // Group by depth
    const columns = {};
    let maxDepth = 0;
    items.forEach(i => {
      const d = depths[i.id] || 0;
      if (!columns[d]) columns[d] = [];
      columns[d].push(i);
      if (d > maxDepth) maxDepth = d;
    });

    const statusColor = (s, itemId) => {
      if (s === 'decomposed' && itemId) {
        const ch = (window._lastWorkItems || []).filter(w => w.parent_id === itemId);
        if (ch.length > 0 && ch.every(c => c.status === 'done')) return 'var(--green)';
        return 'var(--yellow)'; // children still running
      }
      if (s === 'done') return 'var(--green)';
      if (s === 'in-progress') return 'var(--yellow)';
      if (s === 'failed') return 'var(--red)';
      if (s === 'updated') return 'var(--purple)';
      if (s === 'paused') return 'var(--muted)';
      return 'var(--border)';
    };

    const wi = wiById;
    let html = '<div style="display:flex;gap:8px;padding:8px;min-height:120px">';
    for (let d = 0; d <= maxDepth; d++) {
      const col = columns[d] || [];
      const colLabel = d === 0 ? 'Root' : 'Wave ' + d;
      html += '<div style="flex:1;min-width:0">' +
        '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;text-align:center">' + colLabel + '</div>';
      for (const i of col) {
        const borderColor = statusColor(i.status, i.id);
        const src = escHtml(i.source || '');
        const iid = escHtml(i.id || '');
        const agentId = wi[i.id]?.dispatched_to || '';
        const agentInfo = agentId ? (agentData.find(a => a.id === agentId) || {}) : null;
        const agentDisplay = agentInfo ? (agentInfo.emoji || '') + ' ' + escHtml(agentInfo.name || agentId) : (agentId ? escHtml(agentId) : '');
        const deps = (i.depends_on || []).join(', ');
        const wipAnim = i.status === 'in-progress' ? 'animation:prdWipPulse 2s infinite;' : '';
        html += '<div onclick="prdItemEdit(\'' + src + '\',\'' + iid + '\')" ' +
          'style="background:var(--surface2);border:1px solid var(--border);border-left:3px solid ' + borderColor + ';' + wipAnim +
          'border-radius:4px;padding:6px 8px;margin-bottom:6px;cursor:pointer;font-size:11px">' +
          '<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">' +
            statusBadge(i.status, i.id) +
            '<span style="font-weight:600;color:var(--text)">' + escHtml(i.id) + '</span>' +
          '</div>' +
          '<div style="color:var(--text);font-size:11px;line-height:1.3;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + escHtml(i.name) + '</div>' +
          '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' +
            '<span class="prd-item-priority ' + (i.priority || '') + '" style="font-size:8px;padding:1px 4px">' + escHtml(i.priority || '') + '</span>' +
            (agentDisplay ? '<span style="font-size:8px;color:var(--muted)">' + agentDisplay + '</span>' : '') +
            (function() {
              const w = wi[i.id];
              const rqId = w ? w.id : i.id;
              const rq = getPrdRequeueState(rqId);
              if (rq && rq.status === 'pending') {
                return '<span style="font-size:8px;color:var(--yellow);cursor:wait;padding:1px 4px;background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.35);border-radius:3px">requeuing…</span>';
              }
              if (rq && rq.status === 'queued') {
                return '<span style="font-size:8px;color:var(--green);cursor:default;padding:1px 4px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.35);border-radius:3px">requeued</span>';
              }
              if (rq && rq.status === 'error') {
                return '<span style="font-size:8px;color:var(--red);cursor:default;padding:1px 4px;background:rgba(248,81,73,0.1);border:1px solid rgba(248,81,73,0.35);border-radius:3px" title="' + escHtml(rq.message || 'Retry failed') + '">failed</span>';
              }
              // Show retry for failed items, or PRD items with no work item (orphaned/deleted)
              const canRetry = (w && i.status === 'failed') ||
                (!w && i.status && i.status !== 'missing' && i.status !== 'done' && i.status !== 'planned');
              if (!canRetry) return '';
              return '<span onclick="event.stopPropagation();prdItemRequeue(\'' + escHtml(rqId) + '\',\'' + escHtml(w ? (w._source || '') : '') + '\',\'' + escHtml(i.source || '') + '\')" style="font-size:8px;color:var(--green);cursor:pointer;padding:1px 4px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:3px">retry</span>';
            })() +
            (deps ? '<span style="font-size:8px;color:var(--muted)" title="Depends on: ' + escHtml(deps) + '">deps: ' + escHtml(deps) + '</span>' : '') +
            (function() {
              var w = wi[i.id];
              var b = w ? (w.branch || w.featureBranch || (w._artifacts && w._artifacts.branch) || '') : '';
              if (!b) return '';
              return '<span style="font-size:8px;color:var(--muted);font-family:monospace;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle" title="Branch: ' + escHtml(b) + '">&#x1F33F; ' + escHtml(b) + '</span>';
            })() +
          '</div>' +
          ((i.prs || []).length ? '<div style="margin-top:3px">' + (i.prs || []).map(function(pr) { return _renderPrLink(pr, { size: '9px' }); }).join(' ') + '</div>' : '') +
          (i.status === 'decomposed' ? (function() {
            var children = (window._lastWorkItems || []).filter(function(w) { return w.parent_id === i.id; });
            if (!children.length) return '';
            return '<div style="margin-top:4px;border-top:1px solid var(--border);padding-top:4px">' +
              children.map(function(c) {
                var cAgent = c.dispatched_to ? (agentData.find(function(a) { return a.id === c.dispatched_to; }) || {}) : null;
                return '<div style="font-size:9px;display:flex;align-items:center;gap:4px;padding:1px 0">' +
                  statusBadge(c.status) +
                  '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml((c.title || '').replace('Implement: ', '').slice(0, 40)) + '</span>' +
                  (cAgent ? '<span style="font-size:8px;color:var(--muted)">' + (cAgent.emoji || '') + '</span>' : '') +
                '</div>';
              }).join('') +
            '</div>';
          })() : '') +
        '</div>';
      }
      html += '</div>';
      if (d < maxDepth) html += '<div style="display:flex;align-items:center;color:var(--border);font-size:14px;padding:0 2px">&#x2192;</div>';
    }
    html += '</div>';
    return html;
  };

  // View toggle state
  if (!window._prdViewMode) window._prdViewMode = 'graph';

  const renderViewToggle = () => {
    const isGraph = window._prdViewMode === 'graph';
    return '<div style="display:flex;gap:4px;margin-bottom:8px;padding:0 8px">' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;' + (isGraph ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" onclick="window._prdViewMode=\'graph\';rerenderPrdFromCache()">Graph</button>' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;' + (!isGraph ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" onclick="window._prdViewMode=\'list\';rerenderPrdFromCache()">List</button>' +
    '</div>';
  };

  // E2E / verification PRs — group by sourcePlan
  const allPrs = window._lastStatus?.pullRequests || [];
  const e2eByPlan = {};
  for (const pr of allPrs) {
    // Match by explicit sourcePlan (robust), or fall back to title/branch heuristic (legacy)
    const isE2e = pr.itemType === 'verify' || pr.itemType === 'pr' || pr.e2e || pr.title?.startsWith('[E2E]');
    if (!isE2e) continue;
    const planKey = pr.sourcePlan || keys.find(k => pr.branch?.includes(k.replace('.json', ''))) || '_unlinked';
    if (!e2eByPlan[planKey]) e2eByPlan[planKey] = [];
    e2eByPlan[planKey].push(pr);
  }

  // Find testing guides in prd/ (verify-*.md files)
  const verifyGuides = (window._lastStatus?.verifyGuides || []);
  const guideByPlan = {};
  for (const g of verifyGuides) {
    guideByPlan[g.planFile] = g;
  }

  function renderE2eSection(planFile) {
    // Filter out abandoned E2E PRs — superseded aggregate branches should not
    // linger in the E2E section after their constituents merged individually.
    const prs = (e2eByPlan[planFile] || []).filter(pr => pr.status !== 'abandoned');
    const guide = guideByPlan[planFile];
    if (prs.length === 0 && !guide) return '';
    let html = '<div style="margin:6px 0 10px;padding:6px 10px;background:rgba(56,139,253,0.08);border:1px solid rgba(56,139,253,0.25);border-radius:4px">';
    if (prs.length > 0) {
      html += '<div style="font-size:10px;font-weight:600;color:var(--blue);margin-bottom:4px">E2E Aggregate PRs</div>';
      html += prs.map(pr => {
        const statusColor = pr.status === 'active' ? 'var(--green)' : pr.status === 'merged' ? 'var(--purple)' : 'var(--muted)';
        return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px">' +
          '<span style="color:' + statusColor + ';font-size:8px;font-weight:600;padding:1px 4px;border:1px solid;border-radius:3px">' + escHtml(pr.status || 'active') + '</span>' +
          '<a href="' + escHtml(pr.url || '#') + '" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:underline;font-weight:500">' + escHtml(pr.id) + '</a>' +
          '<span style="color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(pr.title || '') + '</span>' +
          '<span style="color:var(--muted);font-size:9px">' + escHtml(pr._project || '') + '</span>' +
        '</div>';
      }).join('');
    }
    if (guide) {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:' + (prs.length ? '4px' : '0') + ' 0 0;font-size:11px">' +
        '<span style="font-size:8px;color:var(--green);font-weight:600;padding:1px 4px;border:1px solid var(--green);border-radius:3px">GUIDE</span>' +
        '<span onclick="openVerifyGuide(\'' + escHtml(guide.file) + '\')" style="color:var(--blue);cursor:pointer;text-decoration:underline;font-weight:500">Manual Testing Guide</span>' +
        '<span style="color:var(--muted);font-size:9px">Build instructions, test steps, known issues</span>' +
      '</div>';
    }
    html += '</div>';
    return html;
  }

  const activeKeys = keys.filter(k => !grouped[k].archived);
  const archivedKeys = keys.filter(k => grouped[k].archived);

  function renderGroup(k) {
    const g = grouped[k];
    const viewContent = window._prdViewMode === 'graph'
      ? renderGraph(g.items)
      : '<div class="prd-items-list">' + g.items.map(renderItem).join('') + '</div>';
    return '<div style="margin-bottom:16px">' +
      renderGroupHeader(g) +
      renderE2eSection(g.file) +
      renderGroupStats(g.items) +
      viewContent +
    '</div>';
  }

  let html = renderViewToggle() + activeKeys.map(renderGroup).join('');

  if (archivedKeys.length > 0) {
    // Store archived data for the modal
    window._archivedPrdGroups = archivedKeys.map(k => grouped[k]);
    window._archivedPrdRenderGroup = renderGroup;
    window._archivedPrdRenderItem = renderItem;
    window._archivedPrdRenderGraph = renderGraph;
    window._archivedPrdRenderGroupHeader = renderGroupHeader;
    window._archivedPrdRenderGroupStats = renderGroupStats;
    window._archivedPrdRenderE2eSection = renderE2eSection;
    html += '<div style="margin-top:8px;text-align:right;position:relative" data-file="prd-archives">' +
      '<button class="pr-pager-btn" style="font-size:10px;padding:3px 10px;color:var(--muted)" onclick="openArchivedPrdModal()">' +
        'View Archives (' + archivedKeys.length + ')' +
      '</button>' +
    '</div>';
  }

  el.innerHTML = html;
  restoreNotifBadges();
}

let _prdItems = []; // cache for edit lookups
function _cachePrdItems(prog) { _prdItems = prog?.items || []; }

function openArchivedPrdModal() {
  const groups = (window._archivedPrdGroups || []).slice().sort((a, b) =>
    (b.completedAt || b.prdUpdatedAt || '').localeCompare(a.completedAt || a.prdUpdatedAt || '')
  );
  window._archivedPrdGroups = groups;
  const renderGroup = window._archivedPrdRenderGroup;
  if (!groups.length || !renderGroup) return;

  // If only one archived plan, show detail directly
  // If multiple, show a picker first
  let html = '';
  if (groups.length === 1) {
    showArchivedPrdDetail(0);
    return;
  } else {
    // Picker: list archived plans, click to expand
    html = '<div style="margin-bottom:12px;font-size:12px;color:var(--muted)">Select an archived PRD to view:</div>';
    html += groups.map((g, i) => {
      const done = g.items.filter(it => it.status === 'done').length;
      const failed = g.items.filter(it => it.status === 'failed').length;
      const completed = g.completedAt ? new Date(g.completedAt).toLocaleDateString() : '';
      return '<div class="plan-card" style="cursor:pointer;margin-bottom:8px" onclick="if(shouldIgnoreSelectionClick(event))return;showArchivedPrdDetail(\'' + escHtml(g.file) + '\')">' +
        '<div class="plan-card-title" style="font-size:13px">' + escHtml(g.summary || g.file) + '</div>' +
        '<div class="plan-card-meta">' +
          (g._projects.length > 0 ? g._projects.map(function(p) { return '<span>' + escHtml(p) + '</span>'; }).join(' ') : '') +
          '<span>' + g.items.length + ' items</span>' +
          '<span style="color:var(--green)">' + done + ' done</span>' +
          (failed ? '<span style="color:var(--red)">' + failed + ' failed</span>' : '') +
          (completed ? '<span>Completed ' + completed + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  document.getElementById('modal-title').textContent = 'Archived PRDs';
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}

function showArchivedPrdDetail(idxOrFile) {
  const groups = window._archivedPrdGroups || [];
  const idx = typeof idxOrFile === 'string' ? groups.findIndex(g => g.file === idxOrFile) : idxOrFile;
  const g = groups[idx];
  if (!g) return;

  // View mode toggle for archived
  const isGraph = window._archivedPrdViewMode !== 'list';
  const toggleHtml = '<div style="display:flex;gap:4px;margin-bottom:8px">' +
    '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;' + (isGraph ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" onclick="window._archivedPrdViewMode=\'graph\';showArchivedPrdDetail(\'' + escHtml(g.file) + '\')">Graph</button>' +
    '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;' + (!isGraph ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" onclick="window._archivedPrdViewMode=\'list\';showArchivedPrdDetail(\'' + escHtml(g.file) + '\')">List</button>' +
    '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);margin-left:auto" onclick="triggerVerify(\'' + escHtml(g.file) + '\')">Trigger Verify</button>' +
    '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="planUnarchive(\'' + escHtml(g.file) + '\',this)">Unarchive</button>' +
    '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="openArchivedPrdModal()">Back</button>' +
  '</div>';

  // Render directly from the archived group data (not from stale renderGroup closure)
  const renderItem = window._archivedPrdRenderItem;
  const renderGraph = window._archivedPrdRenderGraph;
  const renderGroupHeader = window._archivedPrdRenderGroupHeader;
  const renderGroupStats = window._archivedPrdRenderGroupStats;
  const renderE2eSection = window._archivedPrdRenderE2eSection;
  const viewContent = (renderItem && renderGraph)
    ? (isGraph ? renderGraph(g.items) : '<div class="prd-items-list">' + g.items.map(renderItem).join('') + '</div>')
    : '<p>Error rendering</p>';
  const content = '<div style="margin-bottom:16px">' +
    (renderGroupHeader ? renderGroupHeader(g) : '') +
    (renderE2eSection ? renderE2eSection(g.file) : '') +
    (renderGroupStats ? renderGroupStats(g.items) : '') +
    viewContent +
  '</div>';

  document.getElementById('modal-title').textContent = g.summary || g.file;
  document.getElementById('modal-body').innerHTML = toggleHtml + content;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}

async function prdItemEdit(source, itemId) {
  let item = _prdItems.find(i => i.source === source && i.id === itemId);
  // Also search archived groups if not found in active items
  if (!item && window._archivedPrdGroups) {
    for (const g of window._archivedPrdGroups) {
      item = (g.items || []).find(i => i.source === source && i.id === itemId);
      if (item) break;
    }
  }
  if (!item) return;

  // Look up work item and dispatch completion info
  const wi = (window._lastWorkItems || []).find(w => w.id === itemId && w.sourcePlan === source);
  const dispatch = window._lastStatus?.dispatch || {};
  const completedEntry = (dispatch.completed || []).find(d =>
    d.meta?.item?.id === itemId && d.meta?.item?.sourcePlan === source
  );

  // Build completion summary section
  let completionHtml = '';
  const isDone = item.status === 'done';
  const isFailed = item.status === 'failed';
  const isActive = item.status === 'in-progress' || item.status === 'missing';

  if (isDone || isFailed || isActive) {
    const agent = wi?.dispatched_to || completedEntry?.agent || '';
    const completedAt = wi?.completedAt || completedEntry?.completed_at || '';
    const summary = completedEntry?.resultSummary || '';
    const prLinks = (item.prs || []).map(function(pr) {
      return '<a href="' + escHtml(pr.url || '#') + '" target="_blank" rel="noopener" style="color:var(--green);text-decoration:underline">' + escHtml(pr.id) + '</a>';
    }).join(', ');

    const statusColor = isDone ? 'var(--green)' : isFailed ? 'var(--red)' : 'var(--blue)';
    const statusLabel = isDone ? 'Completed' : isFailed ? 'Failed' : 'In Progress';

    completionHtml = '<div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ' + statusColor + ';border-radius:4px;padding:10px 12px;margin-bottom:12px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<span style="font-size:11px;font-weight:700;color:' + statusColor + '">' + statusLabel + '</span>' +
        (agent ? '<span style="font-size:11px;color:var(--muted)">by ' + escHtml(agent) + '</span>' : '') +
        (completedAt ? '<span style="font-size:10px;color:var(--muted)">' + escHtml(completedAt.slice(0, 16).replace('T', ' ')) + '</span>' : '') +
      '</div>' +
      (prLinks ? '<div style="font-size:11px;margin-bottom:6px">PR: ' + prLinks + '</div>' : '') +
      (summary ? '<div style="font-size:12px;color:var(--text);line-height:1.5;white-space:pre-wrap;max-height:300px;overflow-y:auto">' + escHtml(summary) + '</div>' : '') +
      (isFailed && completedEntry?.reason ? '<div style="font-size:11px;color:var(--red);margin-top:4px">' + escHtml(completedEntry.reason) + '</div>' : '') +
    '</div>';
  }

  const html = '<div style="padding:8px 0">' +
    completionHtml +
    '<label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Name</label>' +
    '<input id="prd-edit-name" value="' + escHtml(item.name || '') + '" style="width:100%;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;margin-bottom:10px">' +
    '<label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Description</label>' +
    '<textarea id="prd-edit-desc" rows="4" style="width:100%;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;resize:vertical;margin-bottom:10px">' + escHtml(item.description || '') + '</textarea>' +
    '<div style="display:flex;gap:12px;margin-bottom:12px">' +
      '<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Priority</label>' +
        '<select id="prd-edit-priority" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text)">' +
          '<option value="high"' + (item.priority === 'high' ? ' selected' : '') + '>High</option>' +
          '<option value="medium"' + (item.priority === 'medium' ? ' selected' : '') + '>Medium</option>' +
          '<option value="low"' + (item.priority === 'low' ? ' selected' : '') + '>Low</option>' +
        '</select></div>' +
      '<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Complexity</label>' +
        '<select id="prd-edit-complexity" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text)">' +
          '<option value="small"' + ((item.estimated_complexity || item.complexity) === 'small' ? ' selected' : '') + '>Small</option>' +
          '<option value="medium"' + ((item.estimated_complexity || item.complexity) === 'medium' ? ' selected' : '') + '>Medium</option>' +
          '<option value="large"' + ((item.estimated_complexity || item.complexity) === 'large' ? ' selected' : '') + '>Large</option>' +
        '</select></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button class="plan-btn approve" onclick="prdItemSave(\'' + escHtml(source) + '\',\'' + escHtml(itemId) + '\')">Save</button>' +
      '<button class="plan-btn" onclick="closeModal()">Cancel</button>' +
      '<button class="plan-btn reject" style="margin-left:auto" onclick="prdItemRemove(\'' + escHtml(source) + '\',\'' + escHtml(itemId) + '\')">Remove Item</button>' +
    '</div>' +
  '</div>';

  document.getElementById('modal-title').textContent = item.id + ' — ' + (item.name || '').slice(0, 60);
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').style.whiteSpace = '';
  document.getElementById('modal').classList.add('open');
}

async function prdItemSave(source, itemId) {
  var btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  const body = {
    source, itemId,
    name: document.getElementById('prd-edit-name').value,
    description: document.getElementById('prd-edit-desc').value,
    priority: document.getElementById('prd-edit-priority').value,
    estimated_complexity: document.getElementById('prd-edit-complexity').value,
  };
  closeModal(); showToast('cmd-toast', 'Item updated', true);
  try {
    const res = await fetch('/api/prd-items/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) { refresh(); }
    else { const d = await res.json().catch(() => ({})); showToast('cmd-toast', 'Save failed: ' + (d.error || 'unknown'), false); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function prdItemRemove(source, itemId) {
  if (!confirm('Remove item ' + itemId + '? This also cancels any pending work item.')) return;
  showToast('cmd-toast', 'Item removed', true);
  markDeleted(_prdItemDeleteKey(source, itemId));
  closeModal();
  if (typeof rerenderPrdFromCache === 'function') rerenderPrdFromCache();
  try {
    const res = await fetch('/api/prd-items/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, itemId })
    });
    if (res.ok) { refresh(); }
    else { const d = await res.json().catch(() => ({})); clearDeleted(_prdItemDeleteKey(source, itemId)); showToast('cmd-toast', 'Remove failed: ' + (d.error || 'unknown'), false); refresh(); }
  } catch (e) { clearDeleted(_prdItemDeleteKey(source, itemId)); showToast('cmd-toast', 'Error: ' + e.message, false); refresh(); }
}

async function prdItemRequeue(workItemId, source, prdFile) {
  setPrdRequeueState(workItemId, { status: 'pending', message: '' });
  rerenderPrdFromCache();
  try {
    const payload = { id: workItemId, source };
    if (prdFile) payload.prdFile = prdFile;
    const res = await fetch('/api/work-items/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      setPrdRequeueState(workItemId, { status: 'queued', until: Date.now() + 10000 });
      rerenderPrdFromCache();
      wakeEngine();
      refresh();
      showToast('cmd-toast', workItemId + ' requeued', true);
    } else {
      const d = await res.json();
      const msg = d.error || 'unknown';
      setPrdRequeueState(workItemId, { status: 'error', message: msg, until: Date.now() + 10000 });
      rerenderPrdFromCache();
      alert('Failed: ' + msg);
    }
  } catch (e) {
    setPrdRequeueState(workItemId, { status: 'error', message: e.message, until: Date.now() + 10000 });
    rerenderPrdFromCache();
    alert('Error: ' + e.message);
  }
}

async function prdItemReopen(source, itemId) {
  if (!confirm('Re-open this item? It will be set to "updated" and the engine will re-dispatch it on the existing branch.')) return;
  showToast('cmd-toast', 'Item re-opened — will dispatch on next tick', true);
  try {
    const res = await fetch('/api/prd-items/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, itemId, status: 'updated' })
    });
    if (res.ok) {
      await fetch('/api/plans/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: source, skipRegen: true })
      });
      refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Re-open failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function _planApproveAction(prdFile, skipRegen, confirmMsg, successMsg) {
  if (!confirm(confirmMsg)) return;
  showToast('cmd-toast', successMsg || (skipRegen ? 'Plan resumed' : 'PRD regeneration queued'), true);
  try {
    const res = await fetch('/api/plans/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: prdFile, skipRegen: skipRegen || undefined })
    });
    if (res.ok) {
      refresh();
    } else {
      const d = await res.json().catch(() => ({}));
      showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false);
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

function prdRegenerate(prdFile) {
  _planApproveAction(prdFile, false,
    'Source plan was revised.\n\nRegenerate PRD? An agent will compare the updated plan against existing implementation and update items accordingly.\n\nDone items stay done unless modified. New items are added. Removed items are cancelled.');
}

function prdResumeWithoutRegen(prdFile) {
  _planApproveAction(prdFile, true,
    'Resume this plan without regenerating the PRD?\n\nThe current PRD items will be used as-is. New work items will be materialized from any missing/planned items.',
    'Plan resumed (PRD unchanged)');
}

function openArchive(i) {
  const a = archivedPrds[i];
  if (!a) return;

  document.getElementById('modal-title').textContent = 'Archived PRD — ' + a.version + ' (' + a.total + ' items)';

  let html = '<div style="font-family:\'Segoe UI\',system-ui,sans-serif;white-space:normal">';

  // Summary
  if (a.summary) {
    html += '<div class="archive-detail-section"><h4>Summary</h4><p style="font-size:12px;color:var(--muted);line-height:1.6">' + escHtml(a.summary) + '</p></div>';
  }

  // Existing features
  if (a.existing_features.length) {
    html += '<div class="archive-detail-section"><h4>Existing Features (' + a.existing_features.length + ')</h4>';
    a.existing_features.forEach(f => {
      html += '<div class="archive-feature">' +
        '<span class="feat-id">' + escHtml(f.id) + '</span>' +
        '<div class="feat-name">' + escHtml(f.name) + '</div>' +
        '<div class="feat-desc">' + escHtml(f.description || '') + '</div>' +
        '<div class="feat-meta">' +
          (f.agent ? '<span>Agent: ' + escHtml(f.agent) + '</span>' : '') +
          (f.status ? '<span>Status: ' + escHtml(f.status) + '</span>' : '') +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }

  // Missing features
  if (a.missing_features.length) {
    html += '<div class="archive-detail-section"><h4>Gap Items (' + a.missing_features.length + ')</h4>';
    a.missing_features.forEach(f => {
      const pClass = f.priority === 'high' ? 'high' : f.priority === 'medium' ? 'medium' : 'low';
      html += '<div class="archive-feature">' +
        '<span class="feat-id">' + escHtml(f.id) + '</span> ' +
        '<span class="prd-item-priority ' + pClass + '">' + escHtml(f.priority || '') + '</span>' +
        (f.status ? ' <span class="pr-badge ' + (f.status === 'done' ? 'approved' : 'draft') + '" style="font-size:9px">' + escHtml(f.status) + '</span>' : '') +
        '<div class="feat-name">' + escHtml(f.name) + '</div>' +
        '<div class="feat-desc">' + escHtml(f.description || '') + '</div>' +
        (f.rationale ? '<div class="feat-desc" style="margin-top:4px;color:var(--yellow)">Rationale: ' + escHtml(f.rationale) + '</div>' : '') +
        '<div class="feat-meta">' +
          (f.estimated_complexity ? '<span>Complexity: ' + escHtml(f.estimated_complexity) + '</span>' : '') +
          (f.affected_areas ? '<span>Areas: ' + escHtml(f.affected_areas.join(', ')) + '</span>' : '') +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }

  // Open questions
  if (a.open_questions.length) {
    html += '<div class="archive-detail-section"><h4>Open Questions (' + a.open_questions.length + ')</h4>';
    a.open_questions.forEach(q => {
      html += '<div class="archive-question">' +
        '<span class="q-id">' + escHtml(q.id) + '</span>' +
        '<div class="q-text">' + escHtml(q.question) + '</div>' +
        (q.context ? '<div class="q-context">' + escHtml(q.context) + '</div>' : '') +
      '</div>';
    });
    html += '</div>';
  }

  html += '</div>';

  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}

window.MinionsPrd = { renderPrd, renderPrdProgress, openArchivedPrdModal, showArchivedPrdDetail, prdItemEdit, prdItemSave, prdItemRemove, prdItemRequeue, prdItemReopen, prdRegenerate, openArchive };
