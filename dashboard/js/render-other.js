// render-other.js — Projects, MCP servers, metrics, token usage renderers extracted from dashboard.html

function renderProjects(projects) {
  const header = document.getElementById('header-projects');
  const list = document.getElementById('projects-list');
  if (!projects.length) {
    header.textContent = 'No projects';
    list.innerHTML = '<span style="color:var(--muted);font-style:italic">No projects linked.</span>' +
      '<span onclick="addProject()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--green);font-weight:500;cursor:pointer;border-style:dashed;margin-left:8px">+ Add Project</span>';
    return;
  }
  header.textContent = projects.map(p => p.name).join(' + ');
  list.innerHTML = projects.map(p =>
    '<span title="' + escHtml(p.description || p.path || '') + '" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--blue);font-weight:500;cursor:help">' +
      escHtml(p.name) +
      (p.description ? '<span style="color:var(--muted);font-weight:400;margin-left:6px;font-size:10px">' + escHtml(p.description.slice(0, 60)) + (p.description.length > 60 ? '...' : '') + '</span>' : '') +
    '</span>'
  ).join('') +
  '<span onclick="addProject()" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 10px;color:var(--muted);font-weight:500;cursor:pointer;border-style:dashed">+ Add</span>';

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
  let html = '<table class="pr-table"><thead><tr><th>Agent</th><th>Done</th><th>Errors</th><th>PRs</th><th>Approved</th><th>Rejected</th><th>Rate</th><th>Reviews</th></tr></thead><tbody>';
  for (const [id, m] of agents) {
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
    '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  renderTokenUsage(metrics);
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

  // Per-agent token table
  const agentsWithUsage = agents.filter(([, m]) => (m.totalCostUsd || 0) > 0);
  if (agentsWithUsage.length > 0) {
    html += '<div style="font-size:10px;color:var(--muted);margin:12px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Agent Usage</div>';
    html += '<table class="token-agent-table"><thead><tr><th>Agent</th><th>Cost</th><th>Input</th><th>Output</th><th>Cache</th><th>$/task</th></tr></thead><tbody>';
    for (const [id, m] of agentsWithUsage.sort((a, b) => (b[1].totalCostUsd || 0) - (a[1].totalCostUsd || 0))) {
      const tasks = (m.tasksCompleted || 0) + (m.tasksErrored || 0);
      const perTask = tasks > 0 ? fmtCost((m.totalCostUsd || 0) / tasks) : '-';
      html += '<tr>' +
        '<td style="font-weight:600">' + escHtml(id) + '</td>' +
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
    const labels = { 'consolidation': 'Consolidation', 'command-center': 'Command Center', 'doc-chat': 'Doc Chat' };
    html += '<div style="font-size:10px;color:var(--muted);margin:12px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Engine Usage (Haiku)</div>';
    html += '<table class="token-agent-table"><thead><tr><th>Operation</th><th>Cost</th><th>Calls</th><th>Input</th><th>Output</th><th>$/call</th></tr></thead><tbody>';
    for (const [cat, e] of engineEntries.sort((a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0))) {
      const perCall = (e.calls || 0) > 0 ? fmtCost((e.costUsd || 0) / e.calls) : '-';
      html += '<tr>' +
        '<td style="font-weight:600">' + escHtml(labels[cat] || cat) + '</td>' +
        '<td>' + fmtCost(e.costUsd || 0) + '</td>' +
        '<td>' + (e.calls || 0) + '</td>' +
        '<td>' + fmtTokens(e.inputTokens || 0) + '</td>' +
        '<td>' + fmtTokens(e.outputTokens || 0) + '</td>' +
        '<td style="color:var(--muted)">' + perCall + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';
  }

  el.innerHTML = html;
}
