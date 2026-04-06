// refresh.js — Main refresh loop and initialization extracted from dashboard.html

// Sidebar activity indicators — detect changes between refreshes
// Registry: add one line per page. Counter returns a value; badge shows when value increases.
const _pageCounters = {
  home:      function(d) { return (d.dispatch?.completed || []).length; },
  work:      function(d) { return (d.workItems || []).length + '|' + (d.workItems || []).filter(function(w) { return w.status === 'done' || w.status === 'failed'; }).length; },
  plans:     function(d) { return (d.prdProgress?.complete || 0) + '|' + (d.plans || []).length; },
  prs:       function(d) { return (d.pullRequests || []).filter(function(p) { return p.status === 'merged'; }).length; },
  inbox:     function(d) { return (d.inbox || []).length + '|' + (d.notes?.content || '').length; },
  meetings:  function(d) { return (d.meetings || []).reduce(function(s, m) { return s + (m.round || 0); }, 0); },
  pipelines: function(d) { return (d.pipelines || []).reduce(function(s, p) { return s + (p.runs || []).length; }, 0); },
  schedule:  function(d) { return (d.schedules || []).length; },
  engine:    function(d) { return (d.dispatch?.completed || []).filter(function(c) { return c.result === 'error'; }).length; },
};
let _prevCounts = {};
function _detectPageChanges(data) {
  var changes = {};
  var counts = {};
  for (var page in _pageCounters) {
    counts[page] = String(_pageCounters[page](data));
    if (_prevCounts[page] !== undefined && counts[page] !== _prevCounts[page]) changes[page] = true;
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
  renderInbox(data.inbox || []);
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
  renderVersionBanner(data.version);
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

let _knownDashboardStartId = null;
async function refresh() {
  try {
    const data = await safeFetch('/api/status').then(r => r.json());
    // Auto-reload when dashboard restarts (stale connections cause "Failed to fetch" on CC/doc-chat)
    const dashId = (data.version && data.version.dashboardStartedAt) || null;
    if (dashId && _knownDashboardStartId && dashId !== _knownDashboardStartId) {
      console.log('Dashboard restarted — reloading page');
      location.reload();
      return;
    }
    if (dashId) _knownDashboardStartId = dashId;
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
