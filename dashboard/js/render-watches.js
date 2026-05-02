// render-watches.js — Watch rendering and CRUD functions for the dashboard

// ─── Helpers ────────────────────────────────────────────────────────────────

const _WATCH_STATUS_BADGES = {
  active: '<span class="pr-badge approved">active</span>',
  paused: '<span class="pr-badge rejected">paused</span>',
  triggered: '<span class="pr-badge" style="background:rgba(210,153,34,0.15);color:var(--yellow);border-color:var(--yellow)">triggered</span>',
  expired: '<span class="pr-badge" style="background:rgba(139,148,158,0.15);color:var(--muted);border-color:var(--muted)">expired</span>',
};

const _WATCH_TARGET_LABELS = {
  pr: 'PR',
  'work-item': 'Work Item',
};

const _WATCH_CONDITION_LABELS = {
  merged: 'Merged',
  'build-fail': 'Build Fail',
  'build-pass': 'Build Pass',
  completed: 'Completed',
  failed: 'Failed',
  'status-change': 'Status Change',
  any: 'Any Change',
  'new-comments': 'New Comments',
  'vote-change': 'Vote Change',
};

function _intervalToHuman(ms) {
  if (!ms) return 'default';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

// Parse human-friendly interval strings: "15m", "2h", "30s", "90000" (ms)
function _parseIntervalStr(s) {
  if (!s) return 300000;
  s = String(s).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 1000 ? n : n * 1000; // bare numbers: ≥1000 treated as ms, else seconds
  }
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hours?)$/);
  if (!match) return 300000;
  const n = parseFloat(match[1]);
  const unit = match[2][0];
  if (unit === 's') return Math.round(n * 1000);
  if (unit === 'm') return Math.round(n * 60000);
  if (unit === 'h') return Math.round(n * 3600000);
  return 300000;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

let _watchPage = 0;
const WATCH_PER_PAGE = 15;

function renderWatches(watchesData) {
  var watches = (watchesData || []).filter(function(w) { return !isDeleted('watch:' + w.id); });
  var el = document.getElementById('watches-content');
  var countEl = document.getElementById('watches-count');
  if (!el) return;
  if (countEl) countEl.textContent = watches.length;
  window._lastWatches = watches;

  if (!watches.length) {
    el.innerHTML = '<p class="empty">No active watches. Create one to monitor PRs or work items.</p>';
    return;
  }

  var totalPages = Math.ceil(watches.length / WATCH_PER_PAGE);
  if (_watchPage >= totalPages) _watchPage = totalPages - 1;
  var start = _watchPage * WATCH_PER_PAGE;
  var pageItems = watches.slice(start, start + WATCH_PER_PAGE);

  var html = '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
    '<th>ID</th><th>Target</th><th>Type</th><th>Condition</th><th>Interval</th><th>Owner</th><th>Status</th><th>Triggers</th><th>Last Checked</th><th></th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < pageItems.length; i++) {
    var w = pageItems[i];
    var statusBadge = _WATCH_STATUS_BADGES[w.status] || escHtml(w.status || 'unknown');
    var targetLabel = _WATCH_TARGET_LABELS[w.targetType] || escHtml(w.targetType || '');
    var condLabel = _WATCH_CONDITION_LABELS[w.condition] || escHtml(w.condition || '');
    var lastChecked = w.last_checked ? timeAgo(w.last_checked) : 'never';
    var lastTriggered = w.last_triggered ? timeAgo(w.last_triggered) : 'never';
    var triggerInfo = (w.triggerCount || 0) + (w.stopAfter > 0 ? '/' + w.stopAfter : '');

    html += '<tr style="cursor:pointer" onclick="if(shouldIgnoreSelectionClick(event))return;openWatchDetail(\'' + escHtml(w.id) + '\')">' +
      '<td><span class="pr-id">' + escHtml(w.id) + '</span></td>' +
      '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(w.description || w.target) + '">' + escHtml(w.target) + '</td>' +
      '<td><span class="dispatch-type explore">' + escHtml(targetLabel) + '</span></td>' +
      '<td><span style="font-size:11px;color:var(--blue)">' + escHtml(condLabel) + '</span></td>' +
      '<td><span style="font-size:10px;color:var(--muted)">' + escHtml(_intervalToHuman(w.interval)) + '</span></td>' +
      '<td><span class="pr-agent">' + escHtml(w.owner || 'human') + '</span></td>' +
      '<td>' + statusBadge + '</td>' +
      '<td title="Last triggered: ' + escHtml(lastTriggered) + '"><span style="font-size:11px">' + escHtml(triggerInfo) + '</span></td>' +
      '<td><span class="pr-date">' + escHtml(lastChecked) + '</span></td>' +
      '<td style="white-space:nowrap">';

    // Pause/Resume button
    if (w.status === 'active') {
      html += '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--yellow);border-color:var(--yellow);margin-right:4px" onclick="event.stopPropagation();toggleWatchPause(\'' + escHtml(w.id) + '\',true)" title="Pause">&#x23F8;</button>';
    } else if (w.status === 'paused') {
      html += '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--green);border-color:var(--green);margin-right:4px" onclick="event.stopPropagation();toggleWatchPause(\'' + escHtml(w.id) + '\',false)" title="Resume">&#x25B6;</button>';
    }

    // Delete button
    html += '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--red);border-color:var(--red)" onclick="event.stopPropagation();deleteWatch(\'' + escHtml(w.id) + '\')" title="Delete">&#x2715;</button>';
    html += '</td></tr>';
  }

  html += '</tbody></table></div>';

  if (watches.length > WATCH_PER_PAGE) {
    html += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (start + 1) + ' to ' + Math.min(start + WATCH_PER_PAGE, watches.length) + ' of ' + watches.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_watchPage === 0 ? 'disabled' : '') + '" onclick="_watchPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_watchPage >= totalPages - 1 ? 'disabled' : '') + '" onclick="_watchNext()">Next</button>' +
      '</div>' +
    '</div>';
  }

  el.innerHTML = html;
}

function _watchPrev() { if (_watchPage > 0) { _watchPage--; renderWatches(window._lastWatches || []); } }
function _watchNext() { var tp = Math.ceil((window._lastWatches || []).length / WATCH_PER_PAGE); if (_watchPage < tp - 1) { _watchPage++; renderWatches(window._lastWatches || []); } }

// ─── Detail Modal ───────────────────────────────────────────────────────────

function openWatchDetail(id) {
  var w = (window._lastWatches || []).find(function(x) { return x.id === id; });
  if (!w) return;
  var statusBadge = _WATCH_STATUS_BADGES[w.status] || escHtml(w.status || '');
  var lastChecked = w.last_checked ? new Date(w.last_checked).toLocaleString() : 'never';
  var lastTriggered = w.last_triggered ? new Date(w.last_triggered).toLocaleString() : 'never';
  var createdAt = w.created_at ? new Date(w.created_at).toLocaleString() : 'unknown';
  var targetLabel = _WATCH_TARGET_LABELS[w.targetType] || w.targetType;
  var condLabel = _WATCH_CONDITION_LABELS[w.condition] || w.condition;

  document.getElementById('modal-title').innerHTML = escHtml(w.description || w.target) +
    ' <div style="display:flex;gap:4px;margin-top:4px">' +
      (w.status === 'active' ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--yellow)" onclick="toggleWatchPause(\'' + escHtml(w.id) + '\',true);closeModal()">Pause</button>' : '') +
      (w.status === 'paused' ? '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--green)" onclick="toggleWatchPause(\'' + escHtml(w.id) + '\',false);closeModal()">Resume</button>' : '') +
      '<button class="pr-pager-btn" style="font-size:10px;padding:2px 10px;color:var(--red)" onclick="deleteWatch(\'' + escHtml(w.id) + '\');closeModal()">Delete</button>' +
    '</div>';

  var body = '<div style="display:flex;flex-direction:column;gap:10px;font-size:12px;line-height:1.6">' +
    '<div><strong style="color:var(--muted)">ID:</strong> ' + escHtml(w.id) + '</div>' +
    '<div><strong style="color:var(--muted)">Target:</strong> ' + escHtml(w.target) + '</div>' +
    '<div><strong style="color:var(--muted)">Target Type:</strong> <span class="dispatch-type explore">' + escHtml(targetLabel) + '</span></div>' +
    '<div><strong style="color:var(--muted)">Condition:</strong> <span style="color:var(--blue)">' + escHtml(condLabel) + '</span></div>' +
    '<div><strong style="color:var(--muted)">Check Interval:</strong> ' + escHtml(_intervalToHuman(w.interval)) + '</div>' +
    '<div><strong style="color:var(--muted)">Owner:</strong> ' + escHtml(w.owner || 'human') + '</div>' +
    '<div><strong style="color:var(--muted)">Status:</strong> ' + statusBadge + '</div>' +
    '<div><strong style="color:var(--muted)">Notify:</strong> ' + escHtml(w.notify || 'inbox') + '</div>' +
    '<div><strong style="color:var(--muted)">Triggers:</strong> ' + (w.triggerCount || 0) + (w.stopAfter > 0 ? ' / ' + w.stopAfter + ' (expires after)' : ' (runs forever)') + '</div>' +
    (w.onNotMet ? '<div><strong style="color:var(--muted)">On Each Poll (not met):</strong> ' + escHtml(w.onNotMet) + '</div>' : '') +
    '<div><strong style="color:var(--muted)">Created:</strong> ' + escHtml(createdAt) + '</div>' +
    '<div><strong style="color:var(--muted)">Last Checked:</strong> ' + escHtml(lastChecked) + '</div>' +
    '<div><strong style="color:var(--muted)">Last Triggered:</strong> ' + escHtml(lastTriggered) + '</div>' +
    (w._lastTriggerMessage ? '<div><strong style="color:var(--muted)">Last Trigger Message:</strong><div style="margin-top:4px;padding:8px;background:var(--surface2);border-radius:4px;font-size:11px">' + escHtml(w._lastTriggerMessage) + '</div></div>' : '') +
    (w.project ? '<div><strong style="color:var(--muted)">Project:</strong> ' + escHtml(w.project) + '</div>' : '') +
    (w.description ? '<div><strong style="color:var(--muted)">Description:</strong> ' + escHtml(w.description) + '</div>' : '') +
  '</div>';

  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal').classList.add('open');
}

// ─── CRUD Actions ───────────────────────────────────────────────────────────

function toggleWatchPause(id, pause) {
  var newStatus = pause ? 'paused' : 'active';
  showToast('cmd-toast', (pause ? 'Pausing' : 'Resuming') + ' watch...', true);
  fetch('/api/watches/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, status: newStatus })
  }).then(async function(res) {
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok || data.error) showToast('cmd-toast', 'Error: ' + (data.error || ('HTTP ' + res.status)), false);
    else if (typeof refresh === 'function') refresh();
  }).catch(function(err) {
    showToast('cmd-toast', 'Error: ' + err.message, false);
  });
}

function deleteWatch(id) {
  if (!confirm('Delete this watch?')) return;
  showToast('cmd-toast', 'Deleting watch...', true);
  markDeleted('watch:' + id);
  renderWatches(window._lastWatches || []);
  fetch('/api/watches/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  }).then(async function(res) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      clearDeleted('watch:' + id);
      showToast('cmd-toast', 'Delete failed: ' + (data.error || 'unknown'), false);
      if (typeof refresh === 'function') refresh();
      return;
    }
    renderWatches(window._lastWatches || []);
  }).catch(function(err) {
    clearDeleted('watch:' + id);
    showToast('cmd-toast', 'Delete error: ' + err.message, false);
    if (typeof refresh === 'function') refresh();
  });
}

// ─── Create Watch Modal ─────────────────────────────────────────────────────

function _watchFormHtml() {
  var inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  var targetTypes = [
    { value: 'pr', label: 'Pull Request' },
    { value: 'work-item', label: 'Work Item' },
  ];
  var conditions = [
    { value: 'merged', label: 'Merged' },
    { value: 'build-fail', label: 'Build Fail' },
    { value: 'build-pass', label: 'Build Pass' },
    { value: 'completed', label: 'Completed' },
    { value: 'failed', label: 'Failed' },
    { value: 'status-change', label: 'Status Change' },
    { value: 'any', label: 'Any Change' },
    { value: 'new-comments', label: 'New Comments' },
    { value: 'vote-change', label: 'Vote Change' },
  ];
  var ttOpts = targetTypes.map(function(t) { return '<option value="' + t.value + '">' + t.label + '</option>'; }).join('');
  var condOpts = conditions.map(function(c) { return '<option value="' + c.value + '">' + c.label + '</option>'; }).join('');
  var agentOpts = '<option value="">human</option>' + (cmdAgents || []).map(function(a) { return '<option value="' + escHtml(a.id) + '">' + escHtml(a.name) + '</option>'; }).join('');
  var projOpts = '<option value="">Any</option>' + (cmdProjects || []).map(function(p) { return '<option value="' + escHtml(p.name) + '">' + escHtml(p.name) + '</option>'; }).join('');

  return '<div style="display:flex;flex-direction:column;gap:12px;font-family:inherit">' +
    '<div id="watch-form-error" style="display:none;color:var(--red);font-size:12px;padding:6px 10px;background:rgba(255,50,50,0.1);border-radius:var(--radius-sm)"></div>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Target (PR number or Work Item ID)<input id="watch-edit-target" placeholder="e.g. 1057, W-abc123" style="' + inputStyle + '"></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Target Type<select id="watch-edit-target-type" style="' + inputStyle + '">' + ttOpts + '</select></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Condition<select id="watch-edit-condition" style="' + inputStyle + '">' + condOpts + '</select></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Check Interval <span style="font-size:10px;color:var(--muted)">(e.g. 5m, 15m, 1h — default 5m)</span><input id="watch-edit-interval" placeholder="5m" style="' + inputStyle + '"></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Owner (who gets notified)<select id="watch-edit-owner" style="' + inputStyle + '">' + agentOpts + '</select></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Project<select id="watch-edit-project" style="' + inputStyle + '">' + projOpts + '</select></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Description<input id="watch-edit-desc" placeholder="Optional description" style="' + inputStyle + '"></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Stop After N Triggers <span style="font-size:10px;color:var(--muted)">(0 = run forever, 1 = expire on first match)</span><input id="watch-edit-stop-after" type="number" value="0" min="0" style="' + inputStyle + '"></label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">On Each Poll (if condition not met)<select id="watch-edit-on-not-met" style="' + inputStyle + '"><option value="">None — do nothing</option><option value="notify">Notify — write to inbox each poll</option></select></label>' +
  '</div>';
}

function openCreateWatchModal() {
  document.getElementById('modal-title').innerHTML = 'Create Watch' +
    ' <button class="pr-pager-btn" style="font-size:10px;padding:2px 12px;color:var(--green);border-color:var(--green);margin-left:8px" onclick="submitWatch()">Create</button>';
  document.getElementById('modal-body').innerHTML = _watchFormHtml();
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal').classList.add('open');
}

function submitWatch() {
  var target = (document.getElementById('watch-edit-target') || {}).value || '';
  var targetType = (document.getElementById('watch-edit-target-type') || {}).value || 'pr';
  var condition = (document.getElementById('watch-edit-condition') || {}).value || 'merged';
  var interval = _parseIntervalStr((document.getElementById('watch-edit-interval') || {}).value);
  var owner = (document.getElementById('watch-edit-owner') || {}).value || '';
  var project = (document.getElementById('watch-edit-project') || {}).value || '';
  var description = (document.getElementById('watch-edit-desc') || {}).value || '';
  var stopAfter = parseInt((document.getElementById('watch-edit-stop-after') || {}).value, 10) || 0;
  var onNotMet = (document.getElementById('watch-edit-on-not-met') || {}).value || '';

  if (!target.trim()) {
    var errEl = document.getElementById('watch-form-error');
    if (errEl) { errEl.textContent = 'Target is required'; errEl.style.display = 'block'; }
    return;
  }

  showToast('cmd-toast', 'Creating watch...', true);
  fetch('/api/watches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: target.trim(),
      targetType: targetType,
      condition: condition,
      interval: interval,
      owner: owner || 'human',
      project: project || null,
      description: description || null,
      notify: 'inbox',
      stopAfter: stopAfter,
      onNotMet: onNotMet || null,
    })
  }).then(async function(res) {
    var data = await res.json().catch(function() { return {}; });
    if (!res.ok || data.error) {
      showToast('cmd-toast', 'Error: ' + (data.error || ('HTTP ' + res.status)), false);
    } else {
      showToast('cmd-toast', 'Watch created: ' + (data.watch && data.watch.id || ''), true);
      closeModal();
      if (typeof refresh === 'function') refresh();
    }
  }).catch(function(err) {
    showToast('cmd-toast', 'Error: ' + err.message, false);
  });
}

// ─── Exports ────────────────────────────────────────────────────────────────

window.MinionsWatches = {
  renderWatches: renderWatches,
  openCreateWatchModal: openCreateWatchModal,
  openWatchDetail: openWatchDetail,
  submitWatch: submitWatch,
  toggleWatchPause: toggleWatchPause,
  deleteWatch: deleteWatch,
  _watchPrev: _watchPrev,
  _watchNext: _watchNext,
};
