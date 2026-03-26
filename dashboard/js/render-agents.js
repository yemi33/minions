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
      ${a.resultSummary ? `<div class="agent-result" title="${escHtml(a.resultSummary)}">${escHtml(a.resultSummary.slice(0, 200))}${a.resultSummary.length > 200 ? '...' : ''}</div>` : ''}
    </div>
  `).join('');
}
