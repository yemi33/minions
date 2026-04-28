// dashboard/js/render-agents.js — Agent grid rendering extracted from dashboard.html

// Per-runtime inline SVG logo + accent color. Each entry must define `label`
// (used as title/tooltip + accessibility fallback) and `svg` (full inline
// markup, currentColor-themed). Add a new entry here when a new runtime is
// registered in engine/runtimes/index.js.
const RUNTIME_TAGS = {
  // Claude Code — pixel-art "crab" mascot in Anthropic orange. Wide blocky
  // body with two black square eyes, side fin protrusions, and four legs at
  // the bottom with a wide middle gap. Approximates the standalone Claude
  // Code sticker icon.
  claude: {
    label: 'Claude',
    color: '#cc785c',
    svg: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-2px"><g fill="currentColor"><rect x="4" y="3" width="16" height="15"/><rect x="2" y="8" width="2" height="4"/><rect x="20" y="8" width="2" height="4"/><rect x="4" y="18" width="2.5" height="3"/><rect x="8" y="18" width="2.5" height="3"/><rect x="13.5" y="18" width="2.5" height="3"/><rect x="17.5" y="18" width="2.5" height="3"/></g><g fill="#000"><rect x="7" y="7.5" width="2.5" height="3"/><rect x="14.5" y="7.5" width="2.5" height="3"/></g></svg>',
  },
  // GitHub Copilot mascot — a helmeted face with two BIG rounded goggles
  // dominating the upper half (almost touching the top), a tiny bridge
  // between them, and a white "bib" / chin-guard in the lower half with
  // two VERTICAL pill eyes inside it (not horizontal grill bars — that
  // was the prior misread). Color-inverted so the helmet is white-ish and
  // the cutouts pick up the runtime accent for visibility on dark theme.
  copilot: {
    label: 'Copilot',
    color: '#8957e5',
    svg: '<svg viewBox="0 0 24 18" width="17" height="13" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-2px"><g fill="#fff"><path d="M12 1 C18 1 21 4 21 8 V10 C22.5 10.5 23.5 12 23.5 14 C23.5 15.5 22.5 16.5 21 16.7 V17 C21 17.6 20.5 18 19.5 18 H4.5 C3.5 18 3 17.6 3 17 V16.7 C1.5 16.5 0.5 15.5 0.5 14 C0.5 12 1.5 10.5 3 10 V8 C3 4 6 1 12 1 Z"/></g><g fill="currentColor"><rect x="3.6" y="3.4" width="7.4" height="6.2" rx="2.7"/><rect x="13" y="3.4" width="7.4" height="6.2" rx="2.7"/><rect x="11" y="5.6" width="2" height="1.6" rx="0.4"/><path d="M7.4 9.6 H16.6 V15.4 C16.6 16.4 15.8 17 14.7 17 H9.3 C8.2 17 7.4 16.4 7.4 15.4 Z"/></g><g fill="#fff"><rect x="9.4" y="10.7" width="1.7" height="4.7" rx="0.85"/><rect x="12.9" y="10.7" width="1.7" height="4.7" rx="0.85"/></g></svg>',
  },
};
function _runtimeTagHtml(runtime) {
  const meta = RUNTIME_TAGS[runtime];
  if (meta && meta.svg) {
    return '<span class="agent-runtime-tag" title="Runtime: ' + escapeHtml(meta.label) + '" style="display:inline-block;margin-left:6px;color:' + meta.color + '" aria-label="' + escapeHtml(meta.label) + ' runtime">' + meta.svg + '</span>';
  }
  // Unknown runtime — fall back to a small text pill so the user still sees something
  const fallback = runtime || 'unknown';
  return '<span class="agent-runtime-tag" title="Runtime: ' + escapeHtml(fallback) + '" style="font-size:9px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;padding:1px 5px;margin-left:6px;border:1px solid var(--muted);border-radius:3px;color:var(--muted);background:transparent">' + escapeHtml(fallback) + '</span>';
}

function renderAgents(agents) {
  agentData = agents;
  const grid = document.getElementById('agents-grid');
  grid.innerHTML = agents.map(a => `
    <div class="agent-card ${statusColor(a.status)}" onclick="if(shouldIgnoreSelectionClick(event))return;openAgentDetail('${escapeHtml(a.id)}')">
      <div class="agent-card-header">
        <span class="agent-name"><span class="agent-emoji">${escapeHtml(a.emoji)}</span>${escapeHtml(a.name)}${_runtimeTagHtml(a.runtime)}</span>
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
  // Runtime tag \u2014 uses the inline-SVG logo from the same RUNTIME_TAGS map the
  // card uses, so the visual is consistent. The container's user-controlled
  // text fields stay on the textContent path; the SVG is a hardcoded literal
  // from RUNTIME_TAGS keyed by the runtime string (server-controlled, finite
  // set), so injecting via innerHTML on the icon-only span is safe.
  const runtimeMeta = RUNTIME_TAGS[agent.runtime];
  const runtimeSpan = document.createElement('span');
  runtimeSpan.title = 'Runtime: ' + (runtimeMeta?.label || agent.runtime || 'unknown');
  runtimeSpan.style.cssText = 'display:inline-block;margin-left:10px';
  if (runtimeMeta && runtimeMeta.svg) {
    runtimeSpan.style.color = runtimeMeta.color;
    runtimeSpan.innerHTML = runtimeMeta.svg.replace('width="13"', 'width="18"').replace('height="13"', 'height="18"');
    runtimeSpan.setAttribute('aria-label', runtimeMeta.label + ' runtime');
  } else {
    runtimeSpan.style.cssText += ';font-size:10px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;padding:2px 6px;border:1px solid var(--muted);border-radius:3px;color:var(--muted)';
    runtimeSpan.textContent = agent.runtime || 'unknown';
  }
  nameEl.replaceChildren(
    emojiSpan,
    document.createTextNode(' ' + (agent.name || '') + ' \u2014 ' + (agent.role || '')),
    runtimeSpan,
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
