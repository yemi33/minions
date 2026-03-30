// dashboard/js/render-dispatch.js — Engine status, dispatch, and log rendering extracted from dashboard.html

function renderEngineStatus(engine) {
  const badge = document.getElementById('engine-badge');
  let state = engine?.state || 'stopped';
  let staleMs = 0;

  // Detect stale engine — says running but heartbeat is old (>2 min)
  if (state === 'running' && engine?.heartbeat) {
    staleMs = Date.now() - engine.heartbeat;
    if (staleMs > 120000) {
      state = 'stale';
    }
  } else if (state === 'running' && !engine?.heartbeat) {
    // Running but no heartbeat yet — engine just started or old version
    state = 'running';
  }

  badge.className = 'engine-badge ' + (state === 'stale' ? 'stopped' : state);
  badge.textContent = state === 'stale' ? 'STALE' : state.toUpperCase();
  badge.title = state === 'stale'
    ? 'Engine claims running but heartbeat is stale (>2min). It may have crashed. Run: node engine.js start'
    : state === 'stopped' ? 'Engine is stopped. Run: node engine.js start' : '';
  renderEngineAlert(state, staleMs);
}

function renderEngineAlert(state, staleMs) {
  const el = document.getElementById('engine-alert');
  if (!el) return;
  if (state !== 'stale') {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const mins = Math.max(1, Math.round(staleMs / 60000));
  el.innerHTML =
    '<span class="engine-alert-msg">&#x26A0;&#xFE0F; Engine heartbeat is stale (' + mins + 'm old). Dispatch may be stuck.</span>' +
    '<span class="engine-alert-action" id="engine-alert-restart">Restart engine</span>';
  document.getElementById('engine-alert-restart').onclick = async function() {
    this.classList.add('clicked');
    this.textContent = 'Restarting...';
    try {
      const res = await fetch('/api/engine/restart', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        this.textContent = 'Restarted (PID ' + data.pid + ')';
        setTimeout(() => refresh(), 3000);
      } else {
        this.textContent = 'Failed: ' + (data.error || 'unknown');
        this.classList.remove('clicked');
      }
    } catch (e) {
      this.textContent = 'Failed: ' + e.message;
      this.classList.remove('clicked');
    }
  };
  el.style.display = 'flex';
}

function renderDispatch(dispatch) {
  if (!dispatch) return;

  // Stats
  const stats = document.getElementById('dispatch-stats');
  stats.innerHTML =
    '<div class="dispatch-stat"><div class="dispatch-stat-num yellow">' + (dispatch.active || []).length + '</div><div class="dispatch-stat-label">Active</div></div>' +
    '<div class="dispatch-stat"><div class="dispatch-stat-num blue">' + (dispatch.pending || []).length + '</div><div class="dispatch-stat-label">Pending</div></div>' +
    '<div class="dispatch-stat"><div class="dispatch-stat-num green">' + (dispatch.completed || []).length + '</div><div class="dispatch-stat-label">Completed</div></div>';

  // Active
  const activeEl = document.getElementById('dispatch-active');
  if ((dispatch.active || []).length > 0) {
    activeEl.innerHTML = '<div style="font-size:11px;color:var(--green);margin-bottom:6px;font-weight:600">ACTIVE</div><div class="dispatch-list">' +
      dispatch.active.map(d =>
        '<div class="dispatch-item">' +
          '<span class="dispatch-type ' + (d.type || '') + '">' + escHtml(d.type || '') + '</span>' +
          '<span class="dispatch-agent">' + escHtml(d.agentName || d.agent || '') + '</span>' +
          '<span class="dispatch-task" title="' + escHtml(d.task || '') + '">' + escHtml(d.task || '') + '</span>' +
          '<span class="dispatch-time">' + shortTime(d.started_at) + '</span>' +
        '</div>'
      ).join('') + '</div>';
  } else {
    activeEl.innerHTML = '<div style="color:var(--muted);font-size:11px;margin-bottom:8px">No active dispatches</div>';
  }

  // Pending
  const pendingEl = document.getElementById('dispatch-pending');
  if ((dispatch.pending || []).length > 0) {
    pendingEl.innerHTML = '<div style="font-size:11px;color:var(--yellow);margin:8px 0 6px;font-weight:600">PENDING</div><div class="dispatch-list">' +
      dispatch.pending.map(d =>
        '<div class="dispatch-item">' +
          '<span class="dispatch-type ' + (d.type || '') + '">' + escHtml(d.type || '') + '</span>' +
          '<span class="dispatch-agent">' + escHtml(d.agentName || d.agent || '') + '</span>' +
          '<span class="dispatch-task" title="' + escHtml(d.task || '') + '">' + escHtml(d.task || '') + '</span>' +
          (d.skipReason ? '<span style="font-size:9px;color:var(--muted);margin-left:6px" title="' + escHtml(d.skipReason) + '">' + escHtml(d.skipReason.replace(/_/g, ' ')) + '</span>' : '') +
        '</div>'
      ).join('') + '</div>';
  } else {
    pendingEl.innerHTML = '';
  }

  // Completed
  const completedEl = document.getElementById('completed-content');
  const completedCount = document.getElementById('completed-count');
  const completed = (dispatch.completed || []).slice().reverse();
  completedCount.textContent = completed.length;

  if (completed.length > 0) {
    completedEl.innerHTML = '<table class="pr-table"><thead><tr><th>ID</th><th>Type</th><th>Agent</th><th>Task</th><th>Result</th><th>Completed</th></tr></thead><tbody>' +
      completed.map(d => {
        const isError = d.result === 'error';
        const agentId = (d.agent || '').toLowerCase();
        const errorBtn = isError
          ? ' <button class="error-details-btn" data-agent="' + escHtml(agentId) + '" data-reason="' + escHtml(d.reason || 'No reason recorded') + '" data-task="' + escHtml((d.task || '').slice(0, 100)) + '" onclick="showErrorDetails(this.dataset.agent, this.dataset.reason, this.dataset.task)" title="View error details">details</button>'
          : '';
        return '<tr>' +
          '<td style="font-family:Consolas;font-size:10px" title="' + escHtml(d.id || '') + '">' + escHtml(d.id || '') + '</td>' +
          '<td><span class="dispatch-type ' + (d.type || '') + '">' + escHtml(d.type || '') + '</span></td>' +
          '<td>' + escHtml(d.agentName || d.agent || '') + '</td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml((d.task || '').slice(0, 60)) + '</td>' +
          '<td style="color:' + (d.result === 'success' ? 'var(--green)' : 'var(--red)') + '">' + escHtml(d.result || '') + errorBtn + '</td>' +
          '<td class="pr-date">' + shortTime(d.completed_at) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  } else {
    completedEl.innerHTML = '<p class="empty">No completed dispatches yet.</p>';
  }
}

function renderEngineLog(log) {
  const el = document.getElementById('engine-log');
  if (!log || log.length === 0) {
    el.innerHTML = '<div class="empty">No log entries yet.</div>';
    return;
  }
  el.innerHTML = log.slice().reverse().map(e =>
    '<div class="log-entry">' +
      '<span class="log-ts">' + shortTime(e.timestamp) + '</span> ' +
      '<span class="log-level-' + (e.level || 'info') + '">[' + (e.level || 'info') + ']</span> ' +
      escHtml(e.message || '') +
    '</div>'
  ).join('');
}

function shortTime(t) {
  if (!t) return '';
  try { return new Date(t).toLocaleTimeString(); } catch { return t; }
}

async function showErrorDetails(agentId, reason, task) {
  document.getElementById('modal-title').textContent = 'Error: ' + task;
  document.getElementById('modal-body').textContent = 'Reason: ' + reason + '\n\nLoading agent output...';
  document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
  document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
  document.getElementById('modal').classList.add('open');

  try {
    const output = await fetch('/api/agent/' + agentId + '/output').then(r => r.text());
    const lines = output.split('\n');
    const stderrIdx = lines.findIndex(l => l.startsWith('## stderr'));
    let summary = '';
    if (stderrIdx >= 0) {
      const stderr = lines.slice(stderrIdx + 1).join('\n').trim();
      if (stderr) summary = 'STDERR:\n' + stderr.slice(-2000);
    }
    if (!summary) summary = output.slice(-3000);
    document.getElementById('modal-body').textContent = 'Reason: ' + reason + '\n\n---\n\n' + summary;
  } catch {
    document.getElementById('modal-body').textContent = 'Reason: ' + reason + '\n\n(Could not load agent output)';
  }
}

window.MinionsDispatch = { renderEngineStatus, renderEngineAlert, renderDispatch, renderEngineLog, shortTime, showErrorDetails };
