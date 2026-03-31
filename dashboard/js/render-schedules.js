// render-schedules.js — Schedule rendering functions extracted from dashboard.html

// Convert a 3-field cron expression (minute hour dayOfWeek) to human-readable text.
// Returns the raw cron string for patterns that don't match common cases.
function _cronToHuman(cron) {
  if (!cron || typeof cron !== 'string') return cron || '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return cron;

  const [minField, hourField, dowField] = [parts[0], parts[1], parts[2] || '*'];
  const dayNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

  // Every minute
  if (minField === '*' && hourField === '*' && dowField === '*') return 'Every minute';

  // We only produce readable strings when minute and hour are single numbers
  const min = parseInt(minField, 10);
  const hour = parseInt(hourField, 10);
  if (isNaN(min) || isNaN(hour) || String(min) !== minField.trim() || String(hour) !== hourField.trim()) return cron;

  const timeStr = String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');

  // Parse day-of-week field into a sorted set of day numbers
  let days = null;
  if (dowField === '*') {
    days = null; // all days
  } else if (/^\d+-\d+$/.test(dowField)) {
    // Range: "1-5"
    const [a, b] = dowField.split('-').map(Number);
    if (isNaN(a) || isNaN(b)) return cron;
    days = [];
    for (let i = a; i <= b; i++) days.push(i);
  } else if (/^\d+$/.test(dowField)) {
    // Single value: "0"
    days = [parseInt(dowField, 10)];
  } else if (/^[\d,]+$/.test(dowField)) {
    // List: "0,6" or "1,2,3,4,5"
    days = dowField.split(',').map(Number).sort((a, b) => a - b);
  } else {
    return cron; // Complex expression — fall back
  }

  if (days === null) return 'Daily at ' + timeStr;

  // Weekdays: 1,2,3,4,5
  if (days.length === 5 && [1,2,3,4,5].every(d => days.includes(d))) return 'Weekdays at ' + timeStr;

  // Weekends: 0,6
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends at ' + timeStr;

  // Single day
  if (days.length === 1 && days[0] >= 0 && days[0] <= 6) return dayNames[days[0]] + ' at ' + timeStr;

  // Multiple specific days
  if (days.length > 0 && days.every(d => d >= 0 && d <= 6)) {
    return days.map(d => dayNames[d]).join(', ') + ' at ' + timeStr;
  }

  return cron;
}

function renderSchedules(schedules) {
  const el = document.getElementById('scheduled-content');
  const countEl = document.getElementById('scheduled-count');
  countEl.textContent = schedules.length;
  if (!schedules.length) {
    el.innerHTML = '<p class="empty">No scheduled tasks. Add one to automate recurring work.</p>';
    return;
  }
  let html = '<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>ID</th><th>Title</th><th>Cron</th><th>Type</th><th>Project</th><th>Agent</th><th>Enabled</th><th>Last Run</th><th></th></tr></thead><tbody>';
  for (const s of schedules) {
    const enabledBadge = s.enabled
      ? '<span class="pr-badge approved">enabled</span>'
      : '<span class="pr-badge rejected">disabled</span>';
    const lastRun = s._lastRun ? timeAgo(s._lastRun) : 'never';
    const typeBadge = '<span class="dispatch-type ' + escHtml(s.type || 'implement') + '">' + escHtml(s.type || 'implement') + '</span>';
    html += '<tr>' +
      '<td><span class="pr-id">' + escHtml(s.id || '') + '</span></td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(s.title || '') + '">' + escHtml(s.title || '') + '</td>' +
      '<td title="' + escHtml(s.cron || '') + '"><code style="font-size:10px;color:var(--blue)">' + escHtml(_cronToHuman(s.cron || '')) + '</code></td>' +
      '<td>' + typeBadge + '</td>' +
      '<td><span style="font-size:10px;color:var(--muted)">' + escHtml(s.project || '') + '</span></td>' +
      '<td><span class="pr-agent">' + escHtml(s.agent || 'auto') + '</span></td>' +
      '<td>' + enabledBadge + '</td>' +
      '<td><span class="pr-date">' + escHtml(lastRun) + '</span></td>' +
      '<td style="white-space:nowrap">' +
        '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:' + (s.enabled ? 'var(--yellow)' : 'var(--green)') + ';border-color:' + (s.enabled ? 'var(--yellow)' : 'var(--green)') + ';margin-right:4px" onclick="event.stopPropagation();toggleScheduleEnabled(\'' + escHtml(s.id) + '\',' + !s.enabled + ')" title="' + (s.enabled ? 'Disable' : 'Enable') + '">' + (s.enabled ? '&#x23F8;' : '&#x25B6;') + '</button>' +
        '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--blue);border-color:var(--blue);margin-right:4px" onclick="event.stopPropagation();openEditScheduleModal(\'' + escHtml(s.id) + '\')" title="Edit">&#x270E;</button>' +
        '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--red);border-color:var(--red)" onclick="event.stopPropagation();deleteSchedule(\'' + escHtml(s.id) + '\')" title="Delete">&#x2715;</button>' +
      '</td>' +
    '</tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
  window._lastSchedules = schedules;
}

function _scheduleFormHtml(sched, isEdit) {
  const types = ['implement', 'test', 'explore', 'ask', 'review', 'fix'];
  const priorities = ['high', 'medium', 'low'];
  const typeOpts = types.map(t => '<option value="' + t + '"' + ((sched.type || 'implement') === t ? ' selected' : '') + '>' + t + '</option>').join('');
  const priOpts = priorities.map(p => '<option value="' + p + '"' + ((sched.priority || 'medium') === p ? ' selected' : '') + '>' + p + '</option>').join('');
  const projOpts = '<option value="">Any</option>' + cmdProjects.map(p => '<option value="' + escHtml(p.name) + '"' + (sched.project === p.name ? ' selected' : '') + '>' + escHtml(p.name) + '</option>').join('');
  const agentOpts = '<option value="">Auto</option>' + cmdAgents.map(a => '<option value="' + escHtml(a.id) + '"' + (sched.agent === a.id ? ' selected' : '') + '>' + escHtml(a.name) + '</option>').join('');

  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  return '<div style="display:flex;flex-direction:column;gap:12px;font-family:inherit">' +
    (isEdit ? '' :
      '<label style="color:var(--text);font-size:var(--text-md)">ID <span style="font-size:10px;color:var(--muted)">(optional — auto-generated from title)</span>' +
        '<input id="sched-edit-id" value="' + escHtml(sched.id || '') + '" placeholder="leave blank to auto-generate" style="' + inputStyle + '">' +
      '</label>') +
    '<label style="color:var(--text);font-size:var(--text-md)">Title' +
      '<input id="sched-edit-title" value="' + escHtml(sched.title || '') + '" style="' + inputStyle + '">' +
    '</label>' +
    '<input type="hidden" id="sched-edit-cron" value="' + escHtml(sched.cron || '') + '">' +
    _schedulePickerHtml(sched.cron || '', inputStyle) +
    '<div style="display:flex;gap:12px">' +
      '<label style="color:var(--text);font-size:var(--text-md);flex:1">Type' +
        '<select id="sched-edit-type" style="' + inputStyle + '">' + typeOpts + '</select>' +
      '</label>' +
      '<label style="color:var(--text);font-size:var(--text-md);flex:1">Priority' +
        '<select id="sched-edit-priority" style="' + inputStyle + '">' + priOpts + '</select>' +
      '</label>' +
    '</div>' +
    '<div style="display:flex;gap:12px">' +
      '<label style="color:var(--text);font-size:var(--text-md);flex:1">Project' +
        '<select id="sched-edit-project" style="' + inputStyle + '">' + projOpts + '</select>' +
      '</label>' +
      '<label style="color:var(--text);font-size:var(--text-md);flex:1">Agent' +
        '<select id="sched-edit-agent" style="' + inputStyle + '">' + agentOpts + '</select>' +
      '</label>' +
    '</div>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Description' +
      '<textarea id="sched-edit-desc" rows="3" style="' + inputStyle + ';resize:vertical">' + escHtml(sched.description || '') + '</textarea>' +
    '</label>' +
    '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">' +
      '<button onclick="closeModal()" class="pr-pager-btn" style="padding:6px 16px;font-size:var(--text-md)">Cancel</button>' +
      '<button onclick="submitSchedule(' + isEdit + ')" style="padding:6px 16px;font-size:var(--text-md);background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">' + (isEdit ? 'Save' : 'Create') + '</button>' +
    '</div>' +
  '</div>';
}

function openCreateScheduleModal() {
  document.getElementById('modal-title').textContent = 'New Scheduled Task';
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').innerHTML = _scheduleFormHtml({}, false);
  document.getElementById('modal').classList.add('open');
}

function openEditScheduleModal(id) {
  const sched = (window._lastSchedules || []).find(s => s.id === id);
  if (!sched) return;
  document.getElementById('modal-title').textContent = 'Edit Schedule: ' + id;
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').innerHTML = _scheduleFormHtml(sched, true);
  window._editScheduleId = id;
  document.getElementById('modal').classList.add('open');
}

async function submitSchedule(isEdit) {
  const title = document.getElementById('sched-edit-title').value.trim();
  const cron = document.getElementById('sched-edit-cron').value.trim();
  const type = document.getElementById('sched-edit-type').value;
  const priority = document.getElementById('sched-edit-priority').value;
  const project = document.getElementById('sched-edit-project').value;
  const agent = document.getElementById('sched-edit-agent').value;
  const description = document.getElementById('sched-edit-desc').value;
  const id = isEdit ? window._editScheduleId : (document.getElementById('sched-edit-id') ? document.getElementById('sched-edit-id').value.trim() : '');

  if (!title) { alert('Title is required'); return; }
  if (!cron) { alert('Cron expression is required'); return; }

  const payload = { title, cron, type, priority, project: project || undefined, agent: agent || undefined, description: description || undefined, enabled: true };
  if (id) payload.id = id;
  const url = isEdit ? '/api/schedules/update' : '/api/schedules';
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) { closeModal(); refresh(); showToast('cmd-toast', isEdit ? 'Schedule updated' : 'Schedule created', true); } else {
      const d = await res.json().catch(() => ({}));
      alert((isEdit ? 'Update' : 'Create') + ' failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function toggleScheduleEnabled(id, enabled) {
  try {
    const res = await fetch('/api/schedules/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled })
    });
    if (res.ok) { refresh(); } else {
      const d = await res.json().catch(() => ({}));
      alert('Toggle failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Toggle error: ' + e.message); }
}

async function deleteSchedule(id) {
  if (!confirm('Delete scheduled task "' + id + '"?')) return;
  try {
    const res = await fetch('/api/schedules/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (res.ok) { refresh(); showToast('cmd-toast', 'Schedule deleted', true); } else {
      const d = await res.json().catch(() => ({}));
      alert('Delete failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Delete error: ' + e.message); }
}

window.MinionsSchedules = { renderSchedules, openCreateScheduleModal, openEditScheduleModal, submitSchedule, toggleScheduleEnabled, deleteSchedule, _cronToHuman };
