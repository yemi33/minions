// dashboard/js/state.js — Global state and page navigation extracted from dashboard.html

let inboxData = [];
let agentData = [];
let currentAgentId = null;
let currentTab = 'thought-process';
const DASHBOARD_TAB_ID = (function() {
  try {
    var existing = sessionStorage.getItem('minions-dashboard-tab-id');
    if (existing) return existing;
    var id = 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('minions-dashboard-tab-id', id);
    return id;
  } catch {
    return 'tab-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
})();

// Sidebar page navigation — URL-routed
function getPageFromUrl() {
  const path = window.location.pathname.replace(/^\//, '') || 'home';
  if (document.querySelector('.sidebar-link[data-page="' + path + '"]')) return path;
  return 'home';
}

let currentPage = getPageFromUrl();

function switchPage(page, pushState) {
  // Clean up intervals and panels from previous page
  try { _stopPlanPoll(); } catch {}
  try { _stopMeetingPoll(); } catch {}
  try { closeDetail(); } catch {}

  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  const link = document.querySelector('.sidebar-link[data-page="' + page + '"]');
  if (link) {
    link.classList.add('active');
    // Clear notification badge when visiting a page
    try { clearNotifBadge(link); } catch { /* clearNotifBadge may not be loaded yet */ }
  }
  if (pushState !== false) {
    const url = page === 'home' ? '/' : '/' + page;
    history.pushState({ page }, '', url);
  }
}

// Browser back/forward navigation
window.addEventListener('popstate', (e) => {
  switchPage(e.state?.page || getPageFromUrl(), false);
});
window._prdRequeueUi = window._prdRequeueUi || {};

function getPrdRequeueState(workItemId) {
  const map = window._prdRequeueUi || {};
  const state = map[workItemId];
  if (!state) return null;
  const now = Date.now();
  if (state.until && now > state.until) {
    delete map[workItemId];
    return null;
  }
  return state;
}

function setPrdRequeueState(workItemId, state) {
  window._prdRequeueUi = window._prdRequeueUi || {};
  window._prdRequeueUi[workItemId] = Object.assign({ updatedAt: Date.now() }, state);
}

function clearPrdRequeueState(workItemId) {
  const map = window._prdRequeueUi || {};
  delete map[workItemId];
}

function prunePrdRequeueState(workItems) {
  const map = window._prdRequeueUi || {};
  if (!Object.keys(map).length) return;
  const byId = {};
  for (const w of (workItems || [])) {
    if (w.id) byId[w.id] = w;
  }
  for (const [id, state] of Object.entries(map)) {
    if (!state) continue;
    const wi = byId[id];
    if (state.status === 'pending') {
      if (!wi || (wi.status !== 'failed' && wi.status !== 'paused')) delete map[id];
      continue;
    }
    if (state.status === 'queued') {
      if (wi && wi.status !== 'failed') delete map[id];
      continue;
    }
    if (state.status === 'error' && state.until && Date.now() > state.until) delete map[id];
  }
}

function _dashboardPresencePayload(closed) {
  return JSON.stringify({
    tabId: DASHBOARD_TAB_ID,
    closed: !!closed,
    url: location.pathname + location.search + location.hash,
    visibility: document.visibilityState || '',
  });
}

function _sendDashboardPresence(closed) {
  var payload = _dashboardPresencePayload(closed);
  try {
    if (navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon('/api/browser-presence', blob)) return;
    }
  } catch {}
  try {
    fetch('/api/browser-presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(function() {});
  } catch {}
}

window.addEventListener('pagehide', function() { _sendDashboardPresence(true); });
window.addEventListener('beforeunload', function() { _sendDashboardPresence(true); });
document.addEventListener('visibilitychange', function() { _sendDashboardPresence(false); });

function rerenderPrdFromCache() {
  if (!window._lastStatus || !window._lastStatus.prdProgress) return;
  renderPrdProgress(window._lastStatus.prdProgress);
  renderPrd(window._lastStatus.prd, window._lastStatus.prdProgress);
}

// Global fetch wrapper with timeout — prevents connection exhaustion from hung requests.
// Use for all short API calls. Long-lived streams (CC, doc-chat) manage their own AbortControllers.
function safeFetch(url, opts) {
  var timeout = (opts && opts.timeout) || 15000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  var fetchOpts = Object.assign({}, opts, { signal: controller.signal });
  if (typeof url === 'string' && url.indexOf('/api/') === 0) {
    var headers = Object.assign({}, fetchOpts.headers || {});
    headers['X-Minions-Dashboard-Tab'] = DASHBOARD_TAB_ID;
    headers['X-Minions-Dashboard-Url'] = location.pathname + location.search + location.hash;
    headers['X-Minions-Dashboard-Visibility'] = document.visibilityState || '';
    fetchOpts.headers = headers;
  }
  delete fetchOpts.timeout;
  return fetch(url, fetchOpts).finally(function() { clearTimeout(timer); });
}

window.MinionsState = { getPageFromUrl, switchPage, getPrdRequeueState, setPrdRequeueState, clearPrdRequeueState, prunePrdRequeueState, rerenderPrdFromCache, safeFetch };
