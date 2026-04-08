// render-other.js — Projects, MCP servers, metrics, token usage renderers extracted from dashboard.html

function renderProjects(projects) {
  const list = document.getElementById('projects-list');
  if (!projects.length) {
    list.innerHTML = '<span style="color:var(--muted);font-style:italic">No projects linked.</span>' +
      '<span onclick="addProject()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--green);font-weight:500;cursor:pointer;border-style:dashed;margin-left:8px">+ Add Project</span>';
    return;
  }
  list.innerHTML = projects.map(p =>
    '<span title="' + escHtml(p.description || p.path || '') + '" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--blue);font-weight:500;cursor:help">' +
      escHtml(p.name) +
      (p.description ? '<span style="color:var(--muted);font-weight:400;margin-left:6px;font-size:10px">' + escHtml(p.description.slice(0, 60)) + (p.description.length > 60 ? '...' : '') + '</span>' : '') +
    '</span>'
  ).join('') +
  '<span onclick="addProject()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--muted);font-weight:500;cursor:pointer;border-style:dashed">+ Add</span>' +
  '<span onclick="openScanProjectsModal()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--blue);font-weight:500;cursor:pointer;border-style:dashed;font-size:10px">Scan</span>';

}

function renderMcpServers(servers) {
  const el = document.getElementById('mcp-list');
  const countEl = document.getElementById('mcp-count');
  countEl.textContent = servers.length;
  if (!servers.length) {
    el.innerHTML = '<p class="empty">No MCP servers found. Add them to <code>~/.claude.json</code> and they\'ll appear here automatically.</p>';
    return;
  }
  el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' +
    servers.map(s =>
      '<div style="font-size:11px;padding:5px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text)" title="' + escHtml(s.args || s.command) + '">' +
        escHtml(s.name) +
      '</div>'
    ).join('') +
  '</div>' +
  '<p style="font-size:10px;color:var(--muted);margin:0">Synced from <code style="color:var(--blue)">~/.claude.json</code> — add MCP servers there to make them available to all agents.</p>';
}

function renderMetrics(metrics) {
  const el = document.getElementById('metrics-content');
  const agents = Object.entries(metrics).filter(([k]) => !k.startsWith('_'));
  if (agents.length === 0) {
    el.innerHTML = '<p class="empty">No metrics yet. Metrics appear after agents complete tasks.</p>';
    renderTokenUsage(metrics);
    return;
  }
  // Consolidate temp-* agents into one row
  var permanent = agents.filter(function(a) { return !a[0].startsWith('temp-'); });
  var temps = agents.filter(function(a) { return a[0].startsWith('temp-'); });
  var rows = permanent.slice();
  if (temps.length > 0) {
    var merged = { tasksCompleted: 0, tasksErrored: 0, prsCreated: 0, prsApproved: 0, prsRejected: 0, reviewsDone: 0 };
    for (var t = 0; t < temps.length; t++) {
      var tm = temps[t][1];
      merged.tasksCompleted += tm.tasksCompleted || 0;
      merged.tasksErrored += tm.tasksErrored || 0;
      merged.prsCreated += tm.prsCreated || 0;
      merged.prsApproved += tm.prsApproved || 0;
      merged.prsRejected += tm.prsRejected || 0;
      merged.reviewsDone += tm.reviewsDone || 0;
      merged.totalRuntimeMs = (merged.totalRuntimeMs || 0) + (tm.totalRuntimeMs || 0);
    }
    rows.push(['Temp Agents (' + temps.length + ')', merged]);
  }

  function fmtAvgRuntime(m) {
    const total = m.totalRuntimeMs || 0;
    const count = m.timedTasks || 0;
    if (!count || !total) return '-';
    const avgMin = total / count / 60000;
    return avgMin < 1 ? '<1m' : Math.round(avgMin) + 'm';
  }

  let html = '<table class="pr-table"><thead><tr><th>Agent</th><th>Done</th><th>Errors</th><th>PRs</th><th>Approved</th><th>Rejected</th><th>Rate</th><th>Reviews</th><th>Avg Runtime</th></tr></thead><tbody>';
  for (const [id, m] of rows) {
    const rate = m.prsCreated > 0 ? Math.round((m.prsApproved / m.prsCreated) * 100) + '%' : '-';
    const rateColor = m.prsCreated > 0 ? (m.prsApproved / m.prsCreated >= 0.7 ? 'var(--green)' : 'var(--red)') : 'var(--muted)';
    html += '<tr>' +
      '<td style="font-weight:600">' + escHtml(id) + '</td>' +
      '<td style="color:var(--green)">' + (m.tasksCompleted || 0) + '</td>' +
      '<td style="color:' + (m.tasksErrored > 0 ? 'var(--red)' : 'var(--muted)') + '">' + (m.tasksErrored || 0) + '</td>' +
      '<td>' + (m.prsCreated || 0) + '</td>' +
      '<td style="color:var(--green)">' + (m.prsApproved || 0) + '</td>' +
      '<td style="color:' + (m.prsRejected > 0 ? 'var(--red)' : 'var(--muted)') + '">' + (m.prsRejected || 0) + '</td>' +
      '<td style="color:' + rateColor + ';font-weight:600">' + rate + '</td>' +
      '<td>' + (m.reviewsDone || 0) + '</td>' +
      '<td style="color:var(--muted)">' + fmtAvgRuntime(m) + '</td>' +
    '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  renderLlmPerf(metrics);
  renderTokenUsage(metrics);
}

function renderLlmPerf(metrics) {
  const el = document.getElementById('llm-perf-content');
  if (!el) return;
  const engine = metrics._engine;
  if (!engine || Object.keys(engine).length === 0) {
    el.innerHTML = '<p class="empty">No LLM performance data yet.</p>';
    return;
  }
  let html = '<table class="pr-table"><thead><tr><th>Call Type</th><th>Calls</th><th>Total Time</th><th>Avg Time</th><th>Cost</th></tr></thead><tbody>';
  const entries = Object.entries(engine).filter(([k]) => !k.startsWith('test')).sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0));
  for (const [type, m] of entries) {
    const calls = m.calls || 0;
    const totalMs = m.totalDurationMs || 0;
    const timedCalls = m.timedCalls || 0;
    const avgMs = timedCalls > 0 ? totalMs / timedCalls : 0;
    const fmtTotal = totalMs < 60000 ? Math.round(totalMs / 1000) + 's' : Math.round(totalMs / 60000) + 'm';
    const fmtAvg = avgMs < 1000 ? Math.round(avgMs) + 'ms' : avgMs < 60000 ? Math.round(avgMs / 1000) + 's' : Math.round(avgMs / 60000) + 'm';
    const cost = m.costUsd ? '$' + m.costUsd.toFixed(2) : '-';
    html += '<tr><td style="font-weight:600">' + escHtml(type) + '</td>' +
      '<td>' + calls + '</td>' +
      '<td style="color:var(--muted)">' + (totalMs ? fmtTotal : '-') + '</td>' +
      '<td style="color:var(--blue)">' + (avgMs ? fmtAvg : '-') + '</td>' +
      '<td style="color:var(--muted)">' + cost + '</td></tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderTokenUsage(metrics) {
  const el = document.getElementById('token-usage-content');
  const agents = Object.entries(metrics).filter(([k]) => !k.startsWith('_'));
  const daily = metrics._daily || {};
  const engine = metrics._engine || {};

  // Aggregate agent totals
  let agentCost = 0, agentInput = 0, agentOutput = 0, agentCache = 0;
  for (const [, m] of agents) {
    agentCost += m.totalCostUsd || 0;
    agentInput += m.totalInputTokens || 0;
    agentOutput += m.totalOutputTokens || 0;
    agentCache += m.totalCacheRead || 0;
  }

  // Aggregate engine totals
  let engineCost = 0, engineInput = 0, engineOutput = 0, engineCache = 0, engineCalls = 0;
  for (const [, e] of Object.entries(engine)) {
    engineCost += e.costUsd || 0;
    engineInput += e.inputTokens || 0;
    engineOutput += e.outputTokens || 0;
    engineCache += e.cacheRead || 0;
    engineCalls += e.calls || 0;
  }

  const totalCost = agentCost + engineCost;
  const totalInput = agentInput + engineInput;
  const totalOutput = agentOutput + engineOutput;
  const totalCache = agentCache + engineCache;

  if (totalCost === 0 && Object.keys(daily).length === 0) {
    el.innerHTML = '<p class="empty">No usage data yet. Token tracking starts on next agent completion.</p>';
    return;
  }

  const fmtTokens = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'K' : String(n);
  const fmtCost = (n) => '$' + n.toFixed(2);

  // Summary tiles
  let html = '<div class="token-tiles">';
  html += '<div class="token-tile"><div class="token-tile-label">Total Cost</div><div class="token-tile-value">' + fmtCost(totalCost) + '</div></div>';
  html += '<div class="token-tile"><div class="token-tile-label">Input Tokens</div><div class="token-tile-value">' + fmtTokens(totalInput) + '</div></div>';
  html += '<div class="token-tile"><div class="token-tile-label">Output Tokens</div><div class="token-tile-value">' + fmtTokens(totalOutput) + '</div></div>';
  html += '<div class="token-tile"><div class="token-tile-label">Cache Reads</div><div class="token-tile-value">' + fmtTokens(totalCache) + '</div></div>';

  // Today's cost
  const today = new Date().toISOString().slice(0, 10);
  const todayData = daily[today];
  if (todayData) {
    html += '<div class="token-tile"><div class="token-tile-label">Today</div><div class="token-tile-value">' + fmtCost(todayData.costUsd) + '</div><div class="token-tile-sub">' + (todayData.tasks || 0) + ' tasks</div></div>';
  }
  html += '</div>';

  // Daily bar chart (last 14 days)
  const days = Object.keys(daily).sort().slice(-14);
  if (days.length > 1) {
    const maxCost = Math.max(...days.map(d => daily[d].costUsd || 0), 0.01);
    html += '<div style="font-size:10px;color:var(--muted);margin:8px 0 4px">Daily Cost (last ' + days.length + ' days)</div>';
    html += '<div class="token-chart">';
    for (const day of days) {
      const d = daily[day];
      const pct = Math.max(((d.costUsd || 0) / maxCost) * 100, 2);
      html += '<div class="token-bar" style="height:' + pct + '%"><div class="token-bar-tip">' + day.slice(5) + ': ' + fmtCost(d.costUsd) + ' / ' + (d.tasks || 0) + ' tasks</div></div>';
    }
    html += '</div>';
    html += '<div class="token-chart-labels">';
    for (const day of days) {
      html += '<span>' + day.slice(8) + '</span>';
    }
    html += '</div>';
  }

  // Per-agent token table (consolidate temp agents)
  var permAgents = agents.filter(function(a) { return !a[0].startsWith('temp-'); });
  var tempAgents = agents.filter(function(a) { return a[0].startsWith('temp-'); });
  var tokenRows = permAgents.slice();
  if (tempAgents.length > 0) {
    var tempMerged = { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0, tasksCompleted: 0, tasksErrored: 0, model: '' };
    for (var ti = 0; ti < tempAgents.length; ti++) {
      var tm = tempAgents[ti][1];
      tempMerged.totalCostUsd += tm.totalCostUsd || 0;
      tempMerged.totalInputTokens += tm.totalInputTokens || 0;
      tempMerged.totalOutputTokens += tm.totalOutputTokens || 0;
      tempMerged.totalCacheRead += tm.totalCacheRead || 0;
      tempMerged.tasksCompleted += tm.tasksCompleted || 0;
      tempMerged.tasksErrored += tm.tasksErrored || 0;
      if (!tempMerged.model && tm.model) tempMerged.model = tm.model;
    }
    tokenRows.push(['Temp Agents (' + tempAgents.length + ')', tempMerged]);
  }
  var agentsWithUsage = tokenRows.filter(function(a) { return (a[1].totalCostUsd || 0) > 0; });
  if (agentsWithUsage.length > 0) {
    html += '<div style="font-size:10px;color:var(--muted);margin:12px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Agent Usage</div>';
    html += '<table class="token-agent-table"><thead><tr><th>Agent</th><th>Model</th><th>Cost</th><th>Input</th><th>Output</th><th>Cache</th><th>$/task</th></tr></thead><tbody>';
    for (const [id, m] of agentsWithUsage.sort((a, b) => (b[1].totalCostUsd || 0) - (a[1].totalCostUsd || 0))) {
      const tasks = (m.tasksCompleted || 0) + (m.tasksErrored || 0);
      const perTask = tasks > 0 ? fmtCost((m.totalCostUsd || 0) / tasks) : '-';
      const modelLabel = (m.model || '').replace(/^claude-/, '').replace(/\[.*\]$/, '') || '-';
      html += '<tr>' +
        '<td style="font-weight:600">' + escHtml(id) + '</td>' +
        '<td style="color:var(--muted);font-size:10px">' + escHtml(modelLabel) + '</td>' +
        '<td>' + fmtCost(m.totalCostUsd || 0) + '</td>' +
        '<td>' + fmtTokens(m.totalInputTokens || 0) + '</td>' +
        '<td>' + fmtTokens(m.totalOutputTokens || 0) + '</td>' +
        '<td>' + fmtTokens(m.totalCacheRead || 0) + '</td>' +
        '<td style="color:var(--muted)">' + perTask + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
  }

  // Engine (Haiku) usage table
  const engineEntries = Object.entries(engine).filter(([, e]) => (e.costUsd || 0) > 0 || (e.calls || 0) > 0);
  if (engineEntries.length > 0) {
    const labels = { 'consolidation': 'Consolidation', 'command-center': 'Command Center', 'doc-chat': 'Doc Chat', 'kb-sweep': 'KB Sweep', 'schedule-parse': 'Schedule Parse' };
    html += '<div style="font-size:10px;color:var(--muted);margin:12px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Engine Usage</div>';
    html += '<table class="token-agent-table"><thead><tr><th>Operation</th><th>Calls</th><th>Cost</th><th>Input</th><th>Output</th><th>Cache</th><th>$/call</th></tr></thead><tbody>';
    for (const [cat, e] of engineEntries.sort((a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0))) {
      const perCall = (e.calls || 0) > 0 ? fmtCost((e.costUsd || 0) / e.calls) : '-';
      html += '<tr>' +
        '<td style="font-weight:600">' + escHtml(labels[cat] || cat) + '</td>' +
        '<td>' + (e.calls || 0) + '</td>' +
        '<td>' + fmtCost(e.costUsd || 0) + '</td>' +
        '<td>' + fmtTokens(e.inputTokens || 0) + '</td>' +
        '<td>' + fmtTokens(e.outputTokens || 0) + '</td>' +
        '<td>' + fmtTokens(e.cacheRead || 0) + '</td>' +
        '<td style="color:var(--muted)">' + perCall + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
  }

  el.innerHTML = html;
}


async function openScanProjectsModal() {
  document.getElementById('modal-title').textContent = 'Scan for Projects';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<div style="display:flex;gap:8px;align-items:flex-end">' +
        '<label style="flex:1;color:var(--text);font-size:var(--text-md)">Directory to scan' +
          '<input id="scan-path" value="' + escHtml(window.__MINIONS_HOME || '~') + '" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md)">' +
        '</label>' +
        '<label style="width:60px;color:var(--text);font-size:var(--text-md)">Depth' +
          '<input id="scan-depth" type="number" value="3" min="1" max="6" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md)">' +
        '</label>' +
        '<button onclick="_runProjectScan()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;white-space:nowrap">Scan</button>' +
      '</div>' +
      '<div id="scan-results" style="color:var(--muted);font-size:12px">Click Scan to find git repos in the directory.</div>' +
    '</div>';
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal').classList.add('open');
}

async function _runProjectScan() {
  var scanPath = document.getElementById('scan-path')?.value?.trim();
  var depth = document.getElementById('scan-depth')?.value || '3';
  var resultsEl = document.getElementById('scan-results');
  if (!scanPath) { alert('Enter a path'); return; }
  resultsEl.innerHTML = '<span style="color:var(--blue)">Scanning...</span>';

  try {
    var res = await fetch('/api/projects/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: scanPath, depth: Number(depth) })
    });
    var data = await res.json();
    if (!res.ok) { resultsEl.innerHTML = '<span style="color:var(--red)">Error: ' + escHtml(data.error) + '</span>'; return; }
    var repos = data.repos || [];
    if (repos.length === 0) { resultsEl.innerHTML = '<span style="color:var(--muted)">No git repos found in ' + escHtml(scanPath) + '</span>'; return; }

    var html = '<div style="margin-bottom:8px;font-size:11px;color:var(--muted)">' + repos.length + ' repos found — select to add:</div>';
    html += '<div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">';
    repos.forEach(function(r, i) {
      var linked = r.linked;
      var hostBadge = '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' +
        (r.host === 'GitHub' ? 'rgba(88,166,255,0.15);color:var(--blue)' : r.host === 'ADO' ? 'rgba(188,140,255,0.15);color:var(--purple)' : 'var(--surface2);color:var(--muted)') +
        '">' + escHtml(r.host) + '</span>';
      html += '<label style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;cursor:' + (linked ? 'default' : 'pointer') + ';opacity:' + (linked ? '0.5' : '1') + '">' +
        '<input type="checkbox" data-scan-idx="' + i + '" ' + (linked ? 'disabled checked' : '') + ' style="accent-color:var(--blue);width:16px;height:16px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;font-size:12px">' + escHtml(r.name) + ' ' + hostBadge + (linked ? ' <span style="font-size:9px;color:var(--green)">linked</span>' : '') + '</div>' +
          '<div style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(r.path) + '</div>' +
          (r.description ? '<div style="font-size:10px;color:var(--muted)">' + escHtml(r.description) + '</div>' : '') +
        '</div>' +
      '</label>';
    });
    html += '</div>';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">' +
      '<div style="display:flex;gap:8px">' +
        '<span onclick="_scanSelectAll()" style="font-size:10px;color:var(--blue);cursor:pointer;text-decoration:underline">Select all</span>' +
        '<span onclick="_scanSelectNone()" style="font-size:10px;color:var(--muted);cursor:pointer;text-decoration:underline">Clear</span>' +
      '</div>' +
      '<button onclick="_addSelectedProjects()" style="padding:6px 16px;background:var(--green);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Add Selected</button>' +
    '</div>';
    resultsEl.innerHTML = html;
    window._scanRepos = repos;
  } catch (e) { resultsEl.innerHTML = '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>'; }
}

function _scanSelectAll() {
  document.querySelectorAll('[data-scan-idx]').forEach(function(cb) { if (!cb.disabled) cb.checked = true; });
}
function _scanSelectNone() {
  document.querySelectorAll('[data-scan-idx]').forEach(function(cb) { if (!cb.disabled) cb.checked = false; });
}

async function _addSelectedProjects() {
  var checkboxes = document.querySelectorAll('[data-scan-idx]:checked:not(:disabled)');
  if (checkboxes.length === 0) { alert('Select at least one repo'); return; }
  var repos = window._scanRepos || [];
  var added = 0;
  for (var cb of checkboxes) {
    var repo = repos[parseInt(cb.dataset.scanIdx)];
    if (!repo) continue;
    try {
      var res = await fetch('/api/projects/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repo.path })
      });
      if (res.ok) { added++; cb.disabled = true; cb.closest('label').style.opacity = '0.5'; }
    } catch { /* continue with next */ }
  }
  if (added > 0) {
    showToast('cmd-toast', added + ' project(s) added', true);
    refresh();
  }
}

window.MinionsOther = { renderProjects, renderMcpServers, renderMetrics, renderLlmPerf, renderTokenUsage, openScanProjectsModal };
