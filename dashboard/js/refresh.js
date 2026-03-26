// refresh.js — Main refresh loop and initialization extracted from dashboard.html

async function refresh() {
  try {
    const data = await fetch('/api/status').then(r => r.json());
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
    // Update sidebar counts
    const swi = document.getElementById('sidebar-wi');
    if (swi) swi.textContent = (data.workItems || []).length || '';
    const spr = document.getElementById('sidebar-pr');
    if (spr) spr.textContent = (data.pullRequests || []).length || '';
    // Refresh KB and plans less frequently (every 3rd cycle = ~12s)
    if (!window._kbRefreshCount) window._kbRefreshCount = 0;
    if (window._kbRefreshCount++ % 3 === 0) { refreshKnowledgeBase(); refreshPlans(); }
  } catch(e) { console.error('refresh error', e); }
}

refresh();
setInterval(refresh, 4000);

// Wire sidebar navigation
document.querySelectorAll('.sidebar-link').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); switchPage(link.dataset.page); });
});
switchPage(currentPage);
