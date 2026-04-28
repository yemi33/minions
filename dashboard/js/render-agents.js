// dashboard/js/render-agents.js — Agent grid rendering extracted from dashboard.html

// Per-runtime inline SVG logo + accent color. Each entry must define `label`
// (used as title/tooltip + accessibility fallback) and `svg` (full inline
// markup, currentColor-themed). Add a new entry here when a new runtime is
// registered in engine/runtimes/index.js.
const RUNTIME_TAGS = {
  // Anthropic Claude — 8-pointed orange asterisk/burst
  claude: {
    label: 'Claude',
    color: '#cc785c',
    svg: '<svg viewBox="-12 -12 24 24" width="13" height="13" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-2px"><g fill="currentColor"><path d="M-1.6 -10 L1.6 -10 L1 -1 L10 -1.6 L10 1.6 L1 1 L1.6 10 L-1.6 10 L-1 1 L-10 1.6 L-10 -1.6 L-1 -1 Z"/><path d="M-1.6 -10 L1.6 -10 L1 -1 L10 -1.6 L10 1.6 L1 1 L1.6 10 L-1.6 10 L-1 1 L-10 1.6 L-10 -1.6 L-1 -1 Z" transform="rotate(45)"/></g></svg>',
  },
  // GitHub Copilot — rounded "pilot" face from the official Octicons set
  copilot: {
    label: 'Copilot',
    color: '#8957e5',
    svg: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-2px;fill:currentColor"><path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.71.354-2.434.13-.418.305-.808.516-1.142.218-.345.516-.648.886-.804.397-.167.832-.156 1.236-.014.404.142.858.396 1.342.762.227.171.487.367.733.557l.083.064c.16.124.305.236.434.337.265-.077.566-.142.879-.198a.877.877 0 0 1 .093-.013l.045-.005c.135-.018.273-.029.41-.034.137.005.275.016.41.034l.045.005a.877.877 0 0 1 .093.013c.313.056.614.121.879.198.129-.101.274-.213.434-.337l.083-.064c.246-.19.506-.386.733-.557.484-.366.938-.62 1.342-.762.404-.142.839-.153 1.236.014.37.156.668.459.886.804.21.334.385.724.516 1.142.226.724.354 1.564.354 2.434 0 .572-.053 1.148-.254 1.656.066.228.097.429.126.612.012.075.023.148.036.218.911.379 1.503 1.437 1.588 2.065v1.948c-.125.835-3.436 3.749-7.998 3.749ZM5.485 12.343a4.07 4.07 0 0 0 1.014-.214 1 1 0 0 1 .622-.001c.14.045.31.097.502.143.456.111.99.196 1.379.196.39 0 .923-.085 1.379-.196.192-.046.362-.098.502-.143a1 1 0 0 1 .622.001c.31.105.65.184 1.014.214.348.029.674-.027.927-.114a.535.535 0 0 0 .362-.51v-1.61a4.474 4.474 0 0 0-1.5-.339c-.456 0-.923.085-1.379.196-.192.046-.362.098-.502.143a1 1 0 0 1-.622-.001 11.91 11.91 0 0 1-1.014-.214 4.07 4.07 0 0 0-1.014.214 1 1 0 0 1-.622.001 13.92 13.92 0 0 0-.502-.143A6.474 6.474 0 0 0 4.5 9.769a4.474 4.474 0 0 0-1.5.339v1.611a.535.535 0 0 0 .362.51 1.95 1.95 0 0 0 .927.113Z"/></svg>',
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
