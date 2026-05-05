// refresh.js — Main refresh loop and initialization extracted from dashboard.html

// Sidebar activity indicators — detect changes between refreshes
// Registry: add one line per page. Counter returns a value; badge shows when value increases.
const _pageCounters = {
  home:      function(d) { return (d.dispatch?.completed || []).length; },
  work:      function(d) { return (d.workItems || []).length + '|' + (d.workItems || []).filter(function(w) { return w.status === 'done' || w.status === 'failed'; }).length; },
  plans:     function(d) { return (d.prdProgress?.complete || 0) + '|' + (d.plans || []).length + '|' + (d.plans || []).map(function(p) { return p.status || ''; }).join(','); },
  prs:       function(d) { return (d.pullRequests || []).length + '|' + (d.pullRequests || []).filter(function(p) { return p.status === 'merged'; }).length; },
  inbox:     function(d) { return (d.inbox || []).length + '|' + (d.notes?.content || '').length; },
  watches:   function(d) { return (d.watches || []).length + '|' + (d.watches || []).map(function(w) { return [w.id || '', w.status || '', w.triggerCount || 0, w.last_triggered || ''].join(':'); }).join(','); },
  meetings:  function(d) { return (d.meetings || []).length + '|' + (d.meetings || []).reduce(function(s, m) { return s + (m.round || 0); }, 0); },
  pipelines: function(d) { return (d.pipelines || []).length + '|' + (d.pipelines || []).reduce(function(s, p) { return s + (p.runs || []).length; }, 0); },
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

// Change detection — skip renders for sections that haven't changed since last refresh
const _sectionCache = {};
function _changed(key, value) {
  var json = JSON.stringify(value);
  if (_sectionCache[key] === json) return false;
  _sectionCache[key] = json;
  return true;
}

function _formatCcPowerLabel(autoMode) {
  var runtime = autoMode && autoMode.ccCli ? String(autoMode.ccCli) : 'claude';
  var runtimeLabel = runtime.charAt(0).toUpperCase() + runtime.slice(1);
  var model = autoMode && autoMode.ccModel ? String(autoMode.ccModel) : '';
  return 'Ask anything, dispatch work, manage plans — powered by ' + runtimeLabel + (model ? ' (' + model + ')' : '');
}

function _formatCcDrawerLabel(autoMode) {
  var runtime = autoMode && autoMode.ccCli ? String(autoMode.ccCli) : 'claude';
  var runtimeLabel = runtime.charAt(0).toUpperCase() + runtime.slice(1);
  var model = autoMode && autoMode.ccModel ? String(autoMode.ccModel) : '';
  return runtimeLabel + (model ? ' (' + model + ')' : '') + '-powered. Full minions context. Enter to send, Shift+Enter for newline.';
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
  // Always update cheap elements
  document.getElementById('ts').textContent = formatLocalTime(data.timestamp);
  const engineState = (data.engine && data.engine.state) ? data.engine.state : 'stopped';
  document.getElementById('setup-banner').style.display = (!data.initialized && engineState !== 'stopped') ? 'block' : 'none';
  const autoEl = document.getElementById('auto-approve-badge');
  if (autoEl) autoEl.innerHTML = data.autoMode?.approvePlans
    ? '<span style="font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;background:rgba(63,185,80,0.15);color:var(--green);border:1px solid rgba(63,185,80,0.3)">AUTO-APPROVE</span>'
    : '';
  const ccLabelEl = document.getElementById('cmd-powered-by');
  if (ccLabelEl) ccLabelEl.textContent = _formatCcPowerLabel(data.autoMode);
  const ccDrawerLabelEl = document.getElementById('cc-powered-by');
  if (ccDrawerLabelEl) ccDrawerLabelEl.textContent = _formatCcDrawerLabel(data.autoMode);
  const threshEl = document.getElementById('inbox-threshold');
  if (threshEl && data.autoMode?.inboxThreshold) threshEl.textContent = data.autoMode.inboxThreshold;

  // Render only changed sections
  if (_changed('agents', data.agents)) { renderAgents(data.agents); cmdUpdateAgentList(data.agents); }
  if (_changed('prdProgress', data.prdProgress) || _changed('prdPrs', data.pullRequests?.length)) { renderPrdProgress(data.prdProgress); _cachePrdItems(data.prdProgress); }
  if (_changed('inbox', data.inbox)) renderInbox(data.inbox || []);
  if (_changed('projects', data.projects)) { cmdUpdateProjectList(data.projects || []); renderProjects(data.projects || []); }
  if (_changed('notes', data.notes)) renderNotes(data.notes);
  if (_changed('prd', [data.prd, data.prdProgress])) renderPrd(data.prd, data.prdProgress);
  if (_changed('prs', data.pullRequests)) renderPrs(data.pullRequests || []);
  if (_changed('archivedPrds', data.archivedPrds)) renderArchiveButtons(data.archivedPrds || []);
  if (_changed('engine', data.engine)) {
    renderEngineStatus(data.engine);
    var qs = document.getElementById('engine-quick-stats');
    if (qs && data.engine) {
      var wt = data.engine.worktreeCount != null ? data.engine.worktreeCount : '-';
      var tick = data.engine.tick || '-';
      var pid = data.engine.pid || '-';
      qs.innerHTML = '<span>PID: <b>' + pid + '</b></span><span>Tick: <b>' + tick + '</b></span><span>Worktrees: <b>' + wt + '</b></span>';
    }
  }
  if (_changed('version', data.version)) renderVersionBanner(data.version);
  if (_changed('adoThrottle', data.adoThrottle)) renderAdoThrottleAlert(data.adoThrottle);
  if (_changed('ghThrottle', data.ghThrottle)) renderGhThrottleAlert(data.ghThrottle);
  if (_changed('dispatch', data.dispatch)) renderDispatch(data.dispatch);
  window._lastDispatch = data.dispatch;
  window._lastWorkItems = data.workItems || [];
  window._lastStatus = data;
  prunePrdRequeueState(window._lastWorkItems);
  if (_changed('engineLog', data.engineLog)) renderEngineLog(data.engineLog || []);
  if (_changed('metrics', data.metrics)) renderMetrics(data.metrics || {});
  if (_changed('workItems', data.workItems)) renderWorkItems(data.workItems || []);
  if (_changed('skills', data.skills)) renderSkills(data.skills || []);
  if (_changed('mcpServers', data.mcpServers)) renderMcpServers(data.mcpServers || []);
  if (_changed('schedules', data.schedules)) renderSchedules(data.schedules || []);
  if (_changed('watches', data.watches)) renderWatches(data.watches || []);
  if (_changed('meetings', data.meetings)) renderMeetings(data.meetings || []);
  if (_changed('pipelines', data.pipelines) && typeof renderPipelines === 'function') renderPipelines(data.pipelines || []);
  if (_changed('pinned', data.pinned)) renderPinned(data.pinned || []);
  // Sidebar counts (cheap)
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
_syncPinsFromServer(); // Load server-side pins on startup

// Poll for status updates (SSE caused HTTP/1.1 connection exhaustion — CC fetch would fail)
setInterval(refresh, 4000);

// Wire sidebar navigation
document.querySelectorAll('.sidebar-link').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); switchPage(link.dataset.page); });
});
switchPage(currentPage);

window.MinionsRefresh = { refresh };
