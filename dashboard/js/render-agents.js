// dashboard/js/render-agents.js — Agent grid rendering extracted from dashboard.html

function renderAgents(agents) {
  agentData = agents;
  const grid = document.getElementById('agents-grid');
  grid.innerHTML = agents.map(a => `
    <div class="agent-card ${statusColor(a.status)}" onclick="if(shouldIgnoreSelectionClick(event))return;openAgentDetail('${escapeHtml(a.id)}')">
      <div class="agent-card-header">
        <span class="agent-name"><span class="agent-emoji">${escapeHtml(a.emoji)}</span>${escapeHtml(a.name)}</span>
        <span class="status-badge ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span>
      </div>
      <div class="agent-role">${escapeHtml(a.role)}</div>
      <div class="agent-action" title="${escapeHtml(a.lastAction)}">${escapeHtml(a.lastAction)}</div>
      ${(function() {
        var s = a.started_at, c = a.completed_at;
        if (s && c) { var d = new Date(c) - new Date(s); if (d > 0) { var sec = Math.floor(d/1000)%60, min = Math.floor(d/60000)%60, hr = Math.floor(d/3600000); return '<div style="font-size:9px;color:var(--muted)">Last run: ' + (hr > 0 ? hr + 'h ' : '') + min + 'm ' + sec + 's</div>'; } }
        if (s && a.status === 'working') return '<div class="agent-runtime-tick" data-started="' + s + '" style="font-size:9px;color:var(--yellow)"></div>';
        return '';
      })()}
      ${a._blockingToolCall ? `<div style="margin-top:4px;padding:4px 8px;background:rgba(130,160,210,0.13);border:1px solid rgba(130,160,210,0.3);border-radius:4px;font-size:10px;color:var(--muted)">&#x23F3; Blocking tool call (${escapeHtml(a._blockingToolCall.tool)}) &mdash; silent ${Math.round(a._blockingToolCall.silentMs/60000)}min, timeout in ${Math.round(a._blockingToolCall.remainingMs/60000)}min</div>` : ''}
      ${a._warning ? `<div style="margin-top:4px;padding:4px 8px;background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.3);border-radius:4px;font-size:10px;color:var(--yellow)">&#x26A0; ${escapeHtml(a._warning)}</div>` : ''}
      ${a._permissionMode && a._permissionMode !== 'bypassPermissions' && !a._warning ? `<div style="margin-top:4px;font-size:9px;color:var(--muted)">Permission mode: ${escapeHtml(a._permissionMode)}</div>` : ''}
      ${a.resultSummary ? `<div class="agent-result" title="${escapeHtml(a.resultSummary)}">${renderMd(a.resultSummary.slice(0, 200))}${a.resultSummary.length > 200 ? '...' : ''}</div>` : ''}
    </div>
  `).join('');
}

async function openAgentDetail(id) {
  const agent = agentData.find(a => a.id === id);
  if (!agent) return;
  currentAgentId = id;
  currentTab = (agent.status === 'working') ? 'live' : 'thought-process';

  // SEC-03 Phase A: Build the detail header via DOM + textContent instead of innerHTML.
  // Emoji, name and role are all user-controlled fields; routing them through textContent
  // guarantees no HTML interpretation even if the escape function were ever bypassed.
  const nameEl = document.getElementById('detail-agent-name');
  const emojiSpan = document.createElement('span');
  emojiSpan.style.fontSize = '22px';
  emojiSpan.textContent = agent.emoji || '';
  nameEl.replaceChildren(
    emojiSpan,
    document.createTextNode(' ' + (agent.name || '') + ' \u2014 ' + (agent.role || ''))
  );

  const badgeClass = agent.status;
  document.getElementById('detail-status-line').innerHTML =
    '<span class="status-badge ' + badgeClass + '">' + agent.status.toUpperCase() + '</span> ' +
    '<span style="color:var(--muted)">' + escapeHtml(agent.lastAction) + '</span>' +
    (agent._blockingToolCall ? '<div style="margin-top:4px;padding:4px 8px;background:rgba(130,160,210,0.13);border:1px solid rgba(130,160,210,0.3);border-radius:4px;font-size:11px;color:var(--muted)">&#x23F3; Blocking tool call (' + escapeHtml(agent._blockingToolCall.tool) + ') &mdash; silent ' + Math.round(agent._blockingToolCall.silentMs/60000) + 'min, timeout in ' + Math.round(agent._blockingToolCall.remainingMs/60000) + 'min</div>' : '') +
    (agent.resultSummary ? '<div style="margin-top:4px;font-size:11px;color:var(--text);line-height:1.4">' + renderMd(agent.resultSummary.slice(0, 300)) + '</div>' : '');

  // Show panel immediately with loading state — don't wait for API
  document.getElementById('detail-content').innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted)">Loading...</div>';
  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');

  try {
    const detail = await safeFetch('/api/agent/' + id).then(r => r.json());
    renderDetailTabs(detail);
    renderDetailContent(detail, currentTab);
  } catch(e) {
    document.getElementById('detail-content').innerHTML =
      '<div style="padding:24px;text-align:center">' +
        '<div style="color:var(--red);margin-bottom:12px">Error loading agent detail: ' + escapeHtml(e.message) + '</div>' +
        '<button onclick="openAgentDetail(\'' + escapeHtml(id) + '\')" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:12px">Retry</button>' +
        ' <button onclick="closeDetail()" style="padding:6px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;color:var(--text)">Close</button>' +
      '</div>';
  }

}

// Tick running agent timers on cards every second
var _agentRuntimeTimer = null;
function _tickAgentRuntimes() {
  var els = document.querySelectorAll('.agent-runtime-tick');
  if (els.length === 0) { if (_agentRuntimeTimer) { clearInterval(_agentRuntimeTimer); _agentRuntimeTimer = null; } return; }
  var now = Date.now();
  els.forEach(function(el) {
    var ms = now - new Date(el.dataset.started).getTime();
    if (ms < 0) ms = 0;
    var sec = Math.floor(ms / 1000) % 60, min = Math.floor(ms / 60000) % 60, hr = Math.floor(ms / 3600000);
    el.textContent = 'Running: ' + (hr > 0 ? hr + 'h ' : '') + min + 'm ' + sec + 's';
  });
}
// Start ticker after each render if working agents exist
var _origRenderAgents = renderAgents;
renderAgents = function(agents) {
  _origRenderAgents(agents);
  if (_agentRuntimeTimer) { clearInterval(_agentRuntimeTimer); _agentRuntimeTimer = null; }
  if (agents.some(function(a) { return a.status === 'working' && a.started_at; })) {
    _tickAgentRuntimes();
    _agentRuntimeTimer = setInterval(_tickAgentRuntimes, 1000);
  }
};

window.MinionsAgents = { renderAgents, openAgentDetail };
