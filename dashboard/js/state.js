// dashboard/js/state.js — Global state and page navigation extracted from dashboard.html

let inboxData = [];
let agentData = [];
let currentAgentId = null;
let currentTab = 'thought-process';

// Sidebar page navigation — URL-routed
function getPageFromUrl() {
  const path = window.location.pathname.replace(/^\//, '') || 'home';
  if (document.querySelector('.sidebar-link[data-page="' + path + '"]')) return path;
  return 'home';
}

let currentPage = getPageFromUrl();

function switchPage(page, pushState) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  const link = document.querySelector('.sidebar-link[data-page="' + page + '"]');
  if (link) link.classList.add('active');
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

function rerenderPrdFromCache() {
  if (!window._lastStatus || !window._lastStatus.prdProgress) return;
  renderPrd(window._lastStatus.prd, window._lastStatus.prdProgress);
}
