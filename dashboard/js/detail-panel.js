// dashboard/js/detail-panel.js — Agent detail panel extracted from dashboard.html

let _charterRawCache = ''; // stored outside DOM to survive innerHTML rewrites on tab switch

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
        html += '<h4>Last Result</h4><div class="section" style="border-left:3px solid var(--green);padding-left:12px">' + renderMd(detail.statusData.resultSummary) + '</div>';
      }
    }

    if (detail.inboxContents && detail.inboxContents.length > 0) {
      html += '<h4>Notes & Findings (' + detail.inboxContents.length + ')</h4>';
      detail.inboxContents.forEach(item => {
        html += '<div class="section"><strong style="color:var(--purple)">' + escHtml(item.name) + '</strong><div style="margin-top:4px">' + renderMd(item.content) + '</div></div>';
      });
    } else {
      html += '<h4>Notes & Findings</h4><div class="section" style="color:var(--muted);font-style:italic">No notes or findings written yet.</div>';
    }

    if (detail.outputLog) {
      html += '<h4>Latest Output</h4><div class="section">' + renderMd(detail.outputLog) + '</div>';
    }

    el.innerHTML = html;
  } else if (tab === 'live') {
    el.innerHTML =
      '<div id="live-chat" style="display:flex;flex-direction:column;height:60vh">' +
        '<div id="live-messages" style="flex:1;overflow-y:auto;padding:8px;font-size:11px;line-height:1.6"></div>' +
        '<div id="live-status-bar" style="padding:4px 8px;display:flex;align-items:center;gap:8px;border-top:1px solid var(--border)">' +
          '<span class="pulse"></span><span id="live-status-label" style="font-size:11px;color:var(--green)">Streaming live</span>' +
          '<button class="pr-pager-btn" onclick="refreshLiveOutput()" style="font-size:10px">Refresh</button>' +
        '</div>' +
        '<div id="live-steer-bar" style="display:flex;gap:8px;padding:8px;border-top:1px solid var(--border)">' +
          '<input id="live-steer-input" type="text" placeholder="Message this agent — ask for status, give context, or redirect..." ' +
            'style="flex:1;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:12px;font-family:inherit" ' +
            'onkeydown="if(event.key===\'Enter\')sendSteering()" />' +
          '<button onclick="sendSteering()" style="padding:6px 12px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:11px">Send</button>' +
        '</div>' +
      '</div>';
    startLiveStream(currentAgentId);
  } else if (tab === 'charter') {
    const charterContent = detail.charter || '';
    el.innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:8px">' +
        '<button class="pr-pager-btn" id="charter-edit-btn" style="font-size:10px;padding:2px 10px" onclick="_toggleCharterEdit()">Edit</button>' +
        '<button class="pr-pager-btn" id="charter-save-btn" style="font-size:10px;padding:2px 10px;color:var(--green);border-color:var(--green);display:none" onclick="_saveCharter()">Save</button>' +
        '<button class="pr-pager-btn" id="charter-cancel-btn" style="font-size:10px;padding:2px 10px;display:none" onclick="_cancelCharterEdit()">Cancel</button>' +
      '</div>' +
      '<div id="charter-view" class="section">' + renderMd(charterContent || 'No charter found. Click Edit to create one.') + '</div>' +
      '<textarea id="charter-editor" style="display:none;width:100%;min-height:300px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:Consolas,monospace;font-size:12px;resize:vertical">' + escHtml(charterContent) + '</textarea>';
    _charterRawCache = charterContent;
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
    html += '<h4>Task History</h4><div class="section">' + renderMd(detail.history || 'No history yet.') + '</div>';
    el.innerHTML = html;
  } else if (tab === 'output') {
    el.innerHTML = '<div class="section">' + renderMd(detail.outputLog || 'No output log. The coordinator will save agent output here when tasks complete.') + '</div>';
  }
}

function _toggleCharterEdit() {
  document.getElementById('charter-view').style.display = 'none';
  document.getElementById('charter-editor').style.display = '';
  document.getElementById('charter-edit-btn').style.display = 'none';
  document.getElementById('charter-save-btn').style.display = '';
  document.getElementById('charter-cancel-btn').style.display = '';
  document.getElementById('charter-editor').focus();
}

function _cancelCharterEdit() {
  const el = document.getElementById('detail-content');
  document.getElementById('charter-editor').value = _charterRawCache || '';
  document.getElementById('charter-view').style.display = '';
  document.getElementById('charter-editor').style.display = 'none';
  document.getElementById('charter-edit-btn').style.display = '';
  document.getElementById('charter-save-btn').style.display = 'none';
  document.getElementById('charter-cancel-btn').style.display = 'none';
}

async function _saveCharter() {
  if (!currentAgentId) { alert('No agent selected'); return; }
  const content = document.getElementById('charter-editor').value;
  const btn = document.getElementById('charter-save-btn');
  btn.textContent = 'Saving...'; btn.style.pointerEvents = 'none';
  try {
    const res = await fetch('/api/agents/charter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: currentAgentId, content })
    });
    if (res.ok) {
      document.getElementById('charter-view').innerHTML = renderMd(content);
      _charterRawCache = content;
      _cancelCharterEdit();
      showToast('cmd-toast', 'Charter saved', true);
    } else {
      const d = await res.json().catch(() => ({}));
      alert('Save failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Save failed: ' + e.message); }
  btn.textContent = 'Save'; btn.style.pointerEvents = '';
}

window.MinionsDetail = { closeDetail, renderDetailTabs, switchTab, renderDetailContent };
