// dashboard/js/render-agents.js — Agent grid rendering extracted from dashboard.html

function renderAgents(agents) {
  agentData = agents;
  const grid = document.getElementById('agents-grid');
  grid.innerHTML = agents.map(a => `
    <div class="agent-card ${statusColor(a.status)}" onclick="openAgentDetail('${escHtml(a.id)}')">
      <div class="agent-card-header">
        <span class="agent-name"><span class="agent-emoji">${escHtml(a.emoji)}</span>${escHtml(a.name)}</span>
        <span class="status-badge ${escHtml(a.status)}">${escHtml(a.status)}</span>
      </div>
      <div class="agent-role">${escHtml(a.role)}</div>
      <div class="agent-action" title="${escHtml(a.lastAction)}">${escHtml(a.lastAction)}</div>
      ${a._warning ? `<div style="margin-top:4px;padding:4px 8px;background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.3);border-radius:4px;font-size:10px;color:var(--yellow)">&#x26A0; ${escHtml(a._warning)}</div>` : ''}
      ${a._permissionMode && a._permissionMode !== 'bypassPermissions' && !a._warning ? `<div style="margin-top:4px;font-size:9px;color:var(--muted)">Permission mode: ${escHtml(a._permissionMode)}</div>` : ''}
      ${a.resultSummary ? `<div class="agent-result" title="${escHtml(a.resultSummary)}">${renderMd(a.resultSummary.slice(0, 200))}${a.resultSummary.length > 200 ? '...' : ''}</div>` : ''}
    </div>
  `).join('');
}

async function openAgentDetail(id) {
  const agent = agentData.find(a => a.id === id);
  if (!agent) return;
  currentAgentId = id;
  currentTab = (agent.status === 'working') ? 'live' : 'thought-process';

  document.getElementById('detail-agent-name').innerHTML =
    '<span style="font-size:22px">' + escHtml(agent.emoji) + '</span> ' + escHtml(agent.name) + ' — ' + escHtml(agent.role);

  const badgeClass = agent.status;
  document.getElementById('detail-status-line').innerHTML =
    '<span class="status-badge ' + badgeClass + '">' + agent.status.toUpperCase() + '</span> ' +
    '<span style="color:var(--muted)">' + escHtml(agent.lastAction) + '</span>' +
    (agent.resultSummary ? '<div style="margin-top:4px;font-size:11px;color:var(--text);line-height:1.4">' + renderMd(agent.resultSummary.slice(0, 300)) + '</div>' : '');

  try {
    const detail = await safeFetch('/api/agent/' + id).then(r => r.json());
    renderDetailTabs(detail);
    renderDetailContent(detail, currentTab);
  } catch(e) {
    document.getElementById('detail-content').innerHTML =
      '<div style="padding:24px;text-align:center">' +
        '<div style="color:var(--red);margin-bottom:12px">Error loading agent detail: ' + escHtml(e.message) + '</div>' +
        '<button onclick="openAgentDetail(\'' + escHtml(id) + '\')" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:12px">Retry</button>' +
        ' <button onclick="closeDetail()" style="padding:6px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;color:var(--text)">Close</button>' +
      '</div>';
  }

  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');
}

window.MinionsAgents = { renderAgents, openAgentDetail };
