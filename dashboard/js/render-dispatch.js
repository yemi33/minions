// dashboard/js/render-dispatch.js — Engine status, dispatch, and log rendering extracted from dashboard.html

const COMPLETED_PER_PAGE = 20;
const LOG_PER_PAGE = 50;
let _completedPage = 0;
let _logPage = 0;

function _completedPrev() { if (_completedPage > 0) { _completedPage--; refresh(); } }
function _completedNext() { _completedPage++; refresh(); } // clamped in renderDispatch
function _logPrev() { if (_logPage > 0) { _logPage--; refresh(); } }
function _logNext() { _logPage++; refresh(); } // clamped in renderEngineLog

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
  if (state !== 'stale' || (window._engineRestartedAt && Date.now() - window._engineRestartedAt < 30000)) {
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
        this.textContent = '\u2713 Restarted (PID ' + data.pid + ')';
        this.style.color = 'var(--green)';
        this.style.borderColor = 'var(--green)';
        showToast('cmd-toast', 'Engine restarted — PID ' + data.pid, true);
        // Suppress stale banner for 30s while new engine writes its first heartbeat
        window._engineRestartedAt = Date.now();
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

function renderAdoThrottleAlert(adoThrottle) {
  const el = document.getElementById('ado-throttle-alert');
  if (!el) return;
  if (!adoThrottle || !adoThrottle.throttled) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const resumeTime = new Date(adoThrottle.retryAfter).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML =
    '<span class="engine-alert-msg">&#x26A0;&#xFE0F; ADO rate-limited — resume ~' + resumeTime + ' (' + adoThrottle.consecutiveHits + ' consecutive hit' + (adoThrottle.consecutiveHits !== 1 ? 's' : '') + ')</span>';
  el.style.display = 'flex';
}

function renderDispatch(dispatch) {
  if (!dispatch) return;

  // Stats
  const stats = document.getElementById('dispatch-stats');
  stats.innerHTML =
    '<div class="dispatch-stat"><div class="dispatch-stat-num yellow">' + (dispatch.active || []).length + '</div><div class="dispatch-stat-label">Active</div></div>' +
    '<div class="dispatch-stat"><div class="dispatch-stat-num blue">' + (dispatch.pending || []).length + '</div><div class="dispatch-stat-label">Pending</div></div>' +
    '<div class="dispatch-stat"><div class="dispatch-stat-num green">' + (dispatch.completedTotal || (dispatch.completed || []).length) + '</div><div class="dispatch-stat-label">Completed</div></div>';

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
    const totalCompPages = Math.ceil(completed.length / COMPLETED_PER_PAGE);
    if (_completedPage >= totalCompPages) _completedPage = totalCompPages - 1;
    if (_completedPage < 0) _completedPage = 0;
    const compStart = _completedPage * COMPLETED_PER_PAGE;
    const pageCompleted = completed.slice(compStart, compStart + COMPLETED_PER_PAGE);

    completedEl.innerHTML = '<table class="pr-table"><thead><tr><th>ID</th><th>Type</th><th>Agent</th><th>Task</th><th>Result</th><th>Completed</th></tr></thead><tbody>' +
      pageCompleted.map(d => {
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
    if (completed.length > COMPLETED_PER_PAGE) {
      completedEl.innerHTML += '<div class="pr-pager">' +
        '<span class="pr-page-info">Showing ' + (compStart + 1) + ' to ' + Math.min(compStart + COMPLETED_PER_PAGE, completed.length) + ' of ' + completed.length + '</span>' +
        '<div class="pr-pager-btns">' +
          '<button class="pr-pager-btn ' + (_completedPage === 0 ? 'disabled' : '') + '" onclick="_completedPrev()">Prev</button>' +
          '<button class="pr-pager-btn ' + (_completedPage >= totalCompPages - 1 ? 'disabled' : '') + '" onclick="_completedNext()">Next</button>' +
        '</div></div>';
    }
  } else {
    completedEl.innerHTML = '<p class="empty">No completed dispatches yet.</p>';
  }
}

function renderEngineLog(log) {
  const el = document.getElementById('engine-log');
  if (!el) return;
  if (!log || log.length === 0) {
    el.innerHTML = '<div class="empty">No log entries yet.</div>';
    return;
  }
  const reversed = log.slice().reverse();
  const totalLogPages = Math.ceil(reversed.length / LOG_PER_PAGE);
  if (_logPage >= totalLogPages) _logPage = totalLogPages - 1;
  if (_logPage < 0) _logPage = 0;
  const logStart = _logPage * LOG_PER_PAGE;
  const pageLog = reversed.slice(logStart, logStart + LOG_PER_PAGE);

  el.innerHTML = pageLog.map(e =>
    '<div class="log-entry">' +
      '<span class="log-ts">' + shortTime(e.timestamp) + '</span> ' +
      '<span class="log-level-' + (e.level || 'info') + '">[' + (e.level || 'info') + ']</span> ' +
      escHtml(e.message || '') +
    '</div>'
  ).join('');
  if (reversed.length > LOG_PER_PAGE) {
    el.innerHTML += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (logStart + 1) + ' to ' + Math.min(logStart + LOG_PER_PAGE, reversed.length) + ' of ' + reversed.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_logPage === 0 ? 'disabled' : '') + '" onclick="_logPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_logPage >= totalLogPages - 1 ? 'disabled' : '') + '" onclick="_logNext()">Next</button>' +
      '</div></div>';
  }
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

function renderVersionBanner(version) {
  const el = document.getElementById('version-banner');
  if (!el) return;
  if (!version) { el.style.display = 'none'; return; }

  const v = version.dashboardRunning || version.running || version.disk || '?';
  const commitLabel = version.dashboardRunningCommit ? ' (' + version.dashboardRunningCommit + ')' : '';
  const warnStyle = 'font-size:9px;padding:2px 8px;background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.3);border-radius:4px;color:var(--yellow);cursor:help';

  if (version.engineStale && version.dashboardStale) {
    el.style.cssText = warnStyle;
    el.textContent = '\u26A0 Engine + Dashboard running old code. Run: minions restart';
    el.title = 'Both processes are running v' + (version.running || '?') + ' but disk has v' + (version.disk || '?');
  } else if (version.engineStale) {
    el.style.cssText = warnStyle;
    el.textContent = '\u26A0 Engine running v' + (version.running || '?') + ' — disk has v' + (version.disk || '?') + '. Restart engine.';
    el.title = 'The engine process is running older code. Run: minions restart';
  } else if (version.dashboardStale) {
    el.style.cssText = warnStyle;
    el.textContent = '\u26A0 Dashboard running v' + (version.dashboardRunning || '?') + ' — disk has v' + (version.disk || '?') + '. Run: minions restart';
    el.title = 'The dashboard process is running older code. Run: minions restart';
  } else if (version.updateAvailable) {
    el.style.cssText = 'font-size:9px;padding:2px 8px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:4px;color:var(--green);cursor:help';
    el.textContent = 'v' + v + commitLabel + ' — v' + version.latest + ' available. Run: minions update or npm update -g @yemi33/minions';
    el.title = 'A newer version is available on npm. Run minions update to upgrade and restart.';
  } else {
    el.style.cssText = 'font-size:9px;color:var(--muted)';
    el.textContent = 'v' + v + commitLabel;
    el.title = 'Minions v' + v + (version.latest ? ' (latest)' : '');
  }
}

window.MinionsDispatch = { renderEngineStatus, renderEngineAlert, renderAdoThrottleAlert, renderVersionBanner, renderDispatch, renderEngineLog, shortTime, showErrorDetails };
