// dashboard/js/detail-panel.js — Agent detail panel extracted from dashboard.html

function closeDetail() {
  document.getElementById('detail-overlay').classList.remove('open');
  document.getElementById('detail-panel').classList.remove('open');
  currentAgentId = null;
  stopLiveStream();
}

function renderDetailTabs(detail) {
  const isWorking = detail.statusData?.status === 'working';
  const tabs = [
    ...(isWorking ? [{ id: 'live', label: 'Live Output' }] : []),
    { id: 'thought-process', label: 'Thought Process' },
    { id: 'charter', label: 'Charter' },
    { id: 'history', label: 'History' },
    { id: 'output', label: 'Output Log' },
  ];
  document.getElementById('detail-tabs').innerHTML = tabs.map(t =>
    '<div class="detail-tab ' + (t.id === currentTab ? 'active' : '') + '" onclick="switchTab(\'' + t.id + '\')">' + t.label + '</div>'
  ).join('');

  document.getElementById('detail-panel').dataset.detail = JSON.stringify(detail);
}

function switchTab(tabId) {
  currentTab = tabId;
  const detail = JSON.parse(document.getElementById('detail-panel').dataset.detail || '{}');
  renderDetailTabs(detail);
  renderDetailContent(detail, tabId);
}

function renderDetailContent(detail, tab) {
  const el = document.getElementById('detail-content');

  if (tab === 'thought-process') {
    let html = '';

    if (detail.statusData) {
      html += '<h4>Current Status</h4><div class="section">';
      html += 'Status: <span style="color:var(--' + (detail.statusData.status === 'working' ? 'yellow' : detail.statusData.status === 'done' ? 'green' : 'muted') + ')">' + (detail.statusData.status || 'idle').toUpperCase() + '</span>\n';
      if (detail.statusData.task) html += 'Task: ' + escHtml(detail.statusData.task) + '\n';
      if (detail.statusData.started_at) html += 'Started: ' + detail.statusData.started_at + '\n';
      if (detail.statusData.completed_at) html += 'Completed: ' + detail.statusData.completed_at + '\n';
      html += '</div>';
      if (detail.statusData.resultSummary) {
        html += '<h4>Last Result</h4><div class="section" style="border-left:3px solid var(--green);padding-left:12px">' + escHtml(detail.statusData.resultSummary) + '</div>';
      }
    }

    if (detail.inboxContents && detail.inboxContents.length > 0) {
      html += '<h4>Notes & Findings (' + detail.inboxContents.length + ')</h4>';
      detail.inboxContents.forEach(item => {
        html += '<div class="section"><strong style="color:var(--purple)">' + escHtml(item.name) + '</strong>\n\n' + escHtml(item.content) + '</div>';
      });
    } else {
      html += '<h4>Notes & Findings</h4><div class="section" style="color:var(--muted);font-style:italic">No notes or findings written yet.</div>';
    }

    if (detail.outputLog) {
      html += '<h4>Latest Output</h4><div class="section">' + escHtml(detail.outputLog) + '</div>';
    }

    el.innerHTML = html;
  } else if (tab === 'live') {
    el.innerHTML = '<div class="section" id="live-output" style="max-height:60vh;overflow-y:auto;font-size:11px;line-height:1.6">Loading live output...</div>' +
      '<div style="margin-top:8px;display:flex;gap:8px;align-items:center">' +
        '<span class="pulse"></span><span id="live-status-label" style="font-size:11px;color:var(--green)">Streaming live</span>' +
        '<button class="pr-pager-btn" onclick="refreshLiveOutput()" style="font-size:10px">Refresh now</button>' +
      '</div>';
    startLiveStream(currentAgentId);
  } else if (tab === 'charter') {
    el.innerHTML = '<div class="section">' + escHtml(detail.charter || 'No charter found.') + '</div>';
  } else if (tab === 'history') {
    let html = '';
    // Recent dispatch results
    if (detail.recentDispatches && detail.recentDispatches.length > 0) {
      html += '<h4>Recent Dispatches</h4><table class="pr-table" style="margin-bottom:16px"><thead><tr><th>Task</th><th>Type</th><th>Result</th><th>Completed</th></tr></thead><tbody>';
      detail.recentDispatches.forEach(d => {
        const isError = d.result === 'error';
        const color = isError ? 'var(--red)' : 'var(--green)';
        const reason = d.reason ? ' title="' + escHtml(d.reason) + '"' : '';
        html += '<tr>' +
          '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(d.task) + '">' + escHtml(d.task.slice(0, 80)) + '</td>' +
          '<td><span class="dispatch-type ' + d.type + '">' + escHtml(d.type) + '</span></td>' +
          '<td style="color:' + color + '"' + reason + '>' + escHtml(d.result) + (isError && d.reason ? ' <span style="font-size:10px;color:var(--muted)">(' + escHtml(d.reason.slice(0, 50)) + ')</span>' : '') + '</td>' +
          '<td style="font-size:10px;color:var(--muted)">' + (d.completed_at ? new Date(d.completed_at).toLocaleString() : '') + '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
    }
    // Raw history.md
    html += '<h4>Task History</h4><div class="section">' + escHtml(detail.history || 'No history yet.') + '</div>';
    el.innerHTML = html;
  } else if (tab === 'output') {
    el.innerHTML = '<div class="section">' + escHtml(detail.outputLog || 'No output log. The coordinator will save agent output here when tasks complete.') + '</div>';
  }
}
