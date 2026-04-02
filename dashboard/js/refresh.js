// refresh.js — Main refresh loop and initialization extracted from dashboard.html

// Sidebar activity indicators — detect changes between refreshes
let _prevCounts = {};
let _prevEngineAlert = false;
function _detectPageChanges(data) {
  const counts = {
    completions: (data.dispatch?.completed || []).length,
    activeDispatches: (data.dispatch?.active || []).length,
    workDone: (data.workItems || []).filter(w => w.status === 'done' || w.status === 'failed').length,
    workTotal: (data.workItems || []).length,
    workDispatched: (data.workItems || []).filter(w => w.status === 'dispatched').length,
    prdComplete: data.prdProgress?.complete || 0,
    prdInProgress: data.prdProgress?.inProgress || 0,
    plansTotal: (data.plans || []).length,
    prsTotal: (data.pullRequests || []).length,
    prsMerged: (data.pullRequests || []).filter(p => p.status === 'merged').length,
    prsReviewed: (data.pullRequests || []).filter(p => p.reviewStatus === 'approved' || p.reviewStatus === 'changes-requested').length,
    inbox: (data.inbox?.items || []).length,
    kbTotal: Object.values(data.knowledgeBase || {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0),
    skillsTotal: (data.skills || []).length,
    mcpTotal: (data.mcpServers || []).length,
    scheduleTotal: (data.schedules || []).length,
    pipelineRuns: (data.pipelines || []).reduce((s, p) => s + (p.runs || []).length, 0),
    pipelineActive: (data.pipelines || []).filter(p => (p.runs || []).some(r => r.status === 'running')).length,
    meetingRounds: (data.meetings || []).reduce((s, m) => s + (m.round || 0), 0),
    meetingTotal: (data.meetings || []).length,
  };
  const changes = {};
  if (_prevCounts.completions !== undefined) {
    if (counts.completions > _prevCounts.completions || counts.activeDispatches > _prevCounts.activeDispatches) changes.home = true;
    if (counts.workDone > _prevCounts.workDone || counts.workTotal > _prevCounts.workTotal || counts.workDispatched !== _prevCounts.workDispatched) changes.work = true;
    if (counts.prdComplete > _prevCounts.prdComplete || counts.prdInProgress > _prevCounts.prdInProgress || counts.plansTotal > _prevCounts.plansTotal) changes.plans = true;
    if (counts.prsTotal > _prevCounts.prsTotal || counts.prsMerged > _prevCounts.prsMerged || counts.prsReviewed > _prevCounts.prsReviewed) changes.prs = true;
    if (counts.inbox > _prevCounts.inbox || counts.kbTotal > _prevCounts.kbTotal) changes.inbox = true;
    if (counts.skillsTotal > _prevCounts.skillsTotal || counts.mcpTotal > _prevCounts.mcpTotal) changes.tools = true;
    if (counts.scheduleTotal > _prevCounts.scheduleTotal) changes.schedule = true;
    if (counts.pipelineRuns > _prevCounts.pipelineRuns || counts.pipelineActive > _prevCounts.pipelineActive) changes.pipelines = true;
    if (counts.meetingRounds > _prevCounts.meetingRounds || counts.meetingTotal > _prevCounts.meetingTotal) changes.meetings = true;
  }
  _prevCounts = counts;

  // Engine page — only badge for genuine problems, not routine activity
  const engineAlert = _isEngineAlertWorthy(data);
  if (engineAlert && !_prevEngineAlert) changes.engine = true;
  // Clear the engine badge when alert condition resolves
  if (!engineAlert && _prevEngineAlert) {
    const engineLink = document.querySelector('.sidebar-link[data-page="engine"]');
    if (engineLink) clearNotifBadge(engineLink);
  }
  _prevEngineAlert = engineAlert;

  return changes;
}

/**
 * Determine if the engine state warrants a notification dot.
 * Returns true only for genuine problems:
 * - Engine stopped, stale, or in error state
 * - 3+ failed work items in the last hour
 * - Agent timeout/crash detected (error results in recent completions)
 */
function _isEngineAlertWorthy(data) {
  // 1. Engine not running (stopped, stale, or error)
  const engineState = data.engine?.state || 'stopped';
  if (engineState === 'stopped' || engineState === 'error') return true;
  // Stale heartbeat (>2 min old while claiming running)
  if (engineState === 'running' && data.engine?.heartbeat) {
    if (Date.now() - data.engine.heartbeat > 120000) return true;
  }

  // 2. 3+ failed work items in the last hour
  const oneHourAgo = Date.now() - 3600000;
  const recentFailures = (data.workItems || []).filter(w =>
    w.status === 'failed' && w.updated_at && new Date(w.updated_at).getTime() > oneHourAgo
  );
  if (recentFailures.length >= 3) return true;

  // 3. Agent timeout/crash — 3+ error results in recent completed dispatches
  const recentErrors = (data.dispatch?.completed || []).filter(d =>
    d.result === 'error' && d.completed_at && new Date(d.completed_at).getTime() > oneHourAgo
  );
  if (recentErrors.length >= 3) return true;

  return false;
}

function _processStatusUpdate(data) {
  // Detect fresh install — clear stale browser state if install ID changed
  if (data.installId) {
    const prev = localStorage.getItem('minions-install-id');
    if (prev && prev !== data.installId) {
      localStorage.clear();
      console.log('Minions: fresh install detected, cleared browser state');
    }
    localStorage.setItem('minions-install-id', data.installId);
  }
  document.getElementById('ts').textContent = new Date(data.timestamp).toLocaleTimeString();
  const engineState = (data.engine && data.engine.state) ? data.engine.state : 'stopped';
  document.getElementById('setup-banner').style.display = (!data.initialized && engineState !== 'stopped') ? 'block' : 'none';
  renderAgents(data.agents);
  renderPrdProgress(data.prdProgress);
  _cachePrdItems(data.prdProgress);
  renderInbox(data.inbox);
  cmdUpdateAgentList(data.agents);
  cmdUpdateProjectList(data.projects || []);
  renderNotes(data.notes);
  renderPrd(data.prd, data.prdProgress);
  // Auto-approve badge
  const autoEl = document.getElementById('auto-approve-badge');
  if (autoEl) autoEl.innerHTML = data.autoMode?.approvePlans
    ? '<span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;background:rgba(63,185,80,0.15);color:var(--green);border:1px solid rgba(63,185,80,0.3)">AUTO-APPROVE</span>'
    : '';
  // Inbox consolidation threshold from config
  const threshEl = document.getElementById('inbox-threshold');
  if (threshEl && data.autoMode?.inboxThreshold) threshEl.textContent = data.autoMode.inboxThreshold;
  renderPrs(data.pullRequests || []);
  renderArchiveButtons(data.archivedPrds || []);
  renderEngineStatus(data.engine);
  renderDispatch(data.dispatch);
  window._lastDispatch = data.dispatch;
  window._lastWorkItems = data.workItems || [];
  window._lastStatus = data;
  prunePrdRequeueState(window._lastWorkItems);
  renderEngineLog(data.engineLog || []);
  renderProjects(data.projects || []);
  renderMetrics(data.metrics || {});
  renderWorkItems(data.workItems || []);
  renderSkills(data.skills || []);
  renderMcpServers(data.mcpServers || []);
  renderSchedules(data.schedules || []);
  renderMeetings(data.meetings || []);
  if (typeof renderPipelines === 'function') renderPipelines(data.pipelines || []);
  renderPinned(data.pinned || []);
  // Update sidebar counts
  const swi = document.getElementById('sidebar-wi');
  if (swi) swi.textContent = (data.workItems || []).length || '';
  const spr = document.getElementById('sidebar-pr');
  if (spr) spr.textContent = (data.pullRequests || []).length || '';
  // Refresh KB and plans less frequently (every 3rd cycle = ~12s)
  if (!window._kbRefreshCount) window._kbRefreshCount = 0;
  if (window._kbRefreshCount++ % 3 === 0) { refreshKnowledgeBase(); refreshPlans(); }

  // Sidebar activity indicators — show red dot on pages with new activity
  try {
    const changes = _detectPageChanges(data);
    for (const page of Object.keys(changes)) {
      if (currentPage === page) continue; // don't badge the active page
      const link = document.querySelector('.sidebar-link[data-page="' + page + '"]');
      if (link && !link.querySelector('.notif-badge')) showNotifBadge(link, 'done');
    }
  } catch { /* expected on first load */ }
}

async function refresh() {
  try {
    const data = await fetch('/api/status').then(r => r.json());
    _processStatusUpdate(data);
  } catch(e) { console.error('refresh error', e); }
}

refresh();

// Poll for status updates (SSE caused HTTP/1.1 connection exhaustion — CC fetch would fail)
setInterval(refresh, 4000);

// Wire sidebar navigation
document.querySelectorAll('.sidebar-link').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); switchPage(link.dataset.page); });
});
switchPage(currentPage);

window.MinionsRefresh = { refresh };
