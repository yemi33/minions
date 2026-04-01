// dashboard/js/render-agents.js — Agent grid rendering extracted from dashboard.html

function renderAgents(agents) {
  agentData = agents;
  const grid = document.getElementById('agents-grid');
  grid.innerHTML = agents.map(a => `
    <div class="agent-card ${statusColor(a.status)}" onclick="openAgentDetail('${a.id}')">
      <div class="agent-card-header">
        <span class="agent-name"><span class="agent-emoji">${a.emoji}</span>${a.name}</span>
        <span class="status-badge ${a.status}">${a.status}</span>
      </div>
      <div class="agent-role">${a.role}</div>
      <div class="agent-action" title="${escHtml(a.lastAction)}">${escHtml(a.lastAction)}</div>
      ${a.resultSummary ? `<div class="agent-result" title="${escHtml(a.resultSummary)}">${renderMd(a.resultSummary.slice(0, 200))}${a.resultSummary.length > 200 ? '...' : ''}</div>` : ''}
    </div>
  `).join('');
}

async function openAgentDetail(id) {
  currentAgentId = id;
  const agent = agentData.find(a => a.id === id);
  currentTab = (agent?.status === 'working') ? 'live' : 'thought-process';
  if (!agent) return;

  document.getElementById('detail-agent-name').innerHTML =
    '<span style="font-size:22px">' + agent.emoji + '</span> ' + agent.name + ' — ' + agent.role;

  const badgeClass = agent.status;
  document.getElementById('detail-status-line').innerHTML =
    '<span class="status-badge ' + badgeClass + '">' + agent.status.toUpperCase() + '</span> ' +
    '<span style="color:var(--muted)">' + escHtml(agent.lastAction) + '</span>' +
    (agent.resultSummary ? '<div style="margin-top:4px;font-size:11px;color:var(--text);line-height:1.4">' + renderMd(agent.resultSummary.slice(0, 300)) + '</div>' : '');

  try {
    const detail = await fetch('/api/agent/' + id).then(r => r.json());
    renderDetailTabs(detail);
    renderDetailContent(detail, currentTab);
  } catch(e) {
    document.getElementById('detail-content').textContent = 'Error loading agent detail: ' + e.message;
  }

  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');
}

window.MinionsAgents = { renderAgents, openAgentDetail };
