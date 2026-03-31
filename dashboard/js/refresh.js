// refresh.js — Main refresh loop and initialization extracted from dashboard.html

// Sidebar activity indicators — detect changes between refreshes
let _prevCounts = {};
function _detectPageChanges(data) {
  const counts = {
    completions: (data.dispatch?.completed || []).length,
    workDone: (data.workItems || []).filter(w => w.status === 'done' || w.status === 'failed').length,
    workTotal: (data.workItems || []).length,
    prdComplete: data.prdProgress?.complete || 0,
    prsMerged: (data.pullRequests || []).filter(p => p.status === 'merged').length,
    inbox: (data.inbox?.items || []).length,
    meetingRounds: (data.meetings || []).reduce((s, m) => s + (m.round || 0), 0),
  };
  const changes = {};
  if (_prevCounts.completions !== undefined) {
    if (counts.completions > _prevCounts.completions) changes.home = true;
    if (counts.workDone > _prevCounts.workDone || counts.workTotal > _prevCounts.workTotal) changes.work = true;
    if (counts.prdComplete > _prevCounts.prdComplete) changes.plans = true;
    if (counts.prsMerged > _prevCounts.prsMerged) changes.prs = true;
    if (counts.inbox > _prevCounts.inbox) changes.inbox = true;
    if (counts.meetingRounds > _prevCounts.meetingRounds) changes.meetings = true;
  }
  _prevCounts = counts;
  return changes;
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
