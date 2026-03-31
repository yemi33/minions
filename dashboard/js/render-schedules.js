// render-schedules.js — Schedule rendering functions extracted from dashboard.html

// ─── Helpers ────────────────────────────────────────────────────────────────

const _DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** Convert 3-field cron (minute hour dayOfWeek) to human-readable text */
function _cronToHuman(cron) {
  if (!cron || typeof cron !== 'string') return cron || '';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 3) return cron;
  const [minute, hour, dow] = parts;

  if (minute === '*' && hour === '*' && dow === '*') return 'Every minute';

  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (isNaN(h) || isNaN(m)) return cron;

  const timeStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

  if (dow === '*') return 'Daily at ' + timeStr;

  // Normalize comma-separated days
  const normalized = dow.split(',').map(d => d.trim()).sort().join(',');
  if (dow === '1-5' || normalized === '1,2,3,4,5') return 'Weekdays at ' + timeStr;
  if (normalized === '0,6' || normalized === '6,0') return 'Weekends at ' + timeStr;

  // Single day
  const dayNum = parseInt(dow, 10);
  if (!isNaN(dayNum) && dayNum >= 0 && dayNum <= 6 && String(dayNum) === dow) {
    return _DAY_NAMES[dayNum] + ' at ' + timeStr;
  }

  return cron;
}

/** Parse a cron string back into picker state: { hour, minute, days } */
function _parseCronToPicker(cron) {
  const result = { hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }; // default weekdays 9am
  if (!cron || typeof cron !== 'string') return result;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 3) return result;
  const [minStr, hourStr, dowStr] = parts;
  const h = parseInt(hourStr, 10);
  const m = parseInt(minStr, 10);
  if (!isNaN(h)) result.hour = h;
  if (!isNaN(m)) result.minute = m;

  if (dowStr === '*') {
    result.days = [0, 1, 2, 3, 4, 5, 6];
  } else if (dowStr === '1-5') {
    result.days = [1, 2, 3, 4, 5];
  } else {
    result.days = dowStr.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d) && d >= 0 && d <= 6);
  }
  return result;
}

/** Build cron string from picker state */
function _pickerToCron(hour, minute, days) {
  if (!days || !days.length) return '';
  const sorted = [...days].sort((a, b) => a - b);
  const dowStr = sorted.length === 7 ? '*'
    : (sorted.join(',') === '1,2,3,4,5' ? '1-5' : sorted.join(','));
  return minute + ' ' + hour + ' ' + dowStr;
}

/** Auto-generate an ID from a title */
function _generateScheduleId(title) {
  const slug = (title || 'task').toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return (slug || 'task') + '-' + suffix;
}

/** Show inline error in the schedule form */
function _showScheduleError(msg) {
  const el = document.getElementById('sched-form-error');
  if (el) {
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }
}

/** Update the cron preview label from current picker state */
function _updateCronPreview() {
  const hourEl = document.getElementById('sched-pick-hour');
  const minEl = document.getElementById('sched-pick-minute');
  if (!hourEl || !minEl) return;
  const hour = parseInt(hourEl.value, 10);
  const minute = parseInt(minEl.value, 10);
  const dayBtns = document.querySelectorAll('.sched-day-pill');
  const days = [];
  dayBtns.forEach(btn => { if (btn.classList.contains('active')) days.push(parseInt(btn.dataset.day, 10)); });
  const cron = _pickerToCron(hour, minute, days);
  const previewEl = document.getElementById('sched-cron-preview');
  if (previewEl) {
    previewEl.textContent = cron ? '\u2192 cron: ' + cron : '(select at least one day)';
  }
  window._schedComputedCron = cron;
}

/** Toggle a day pill */
function _toggleDayPill(btn) {
  btn.classList.toggle('active');
  if (btn.classList.contains('active')) {
    btn.style.background = 'var(--blue)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--blue)';
  } else {
    btn.style.background = 'var(--bg)';
    btn.style.color = 'var(--text)';
    btn.style.borderColor = 'var(--border)';
  }
  _updateCronPreview();
}

/** Quick-select days */
function _quickSelectDays(preset) {
  const map = { all: [0,1,2,3,4,5,6], weekdays: [1,2,3,4,5], weekends: [0,6] };
  const days = map[preset] || [];
  document.querySelectorAll('.sched-day-pill').forEach(btn => {
    const d = parseInt(btn.dataset.day, 10);
    const active = days.includes(d);
    btn.classList.toggle('active', active);
    btn.style.background = active ? 'var(--blue)' : 'var(--bg)';
    btn.style.color = active ? '#fff' : 'var(--text)';
    btn.style.borderColor = active ? 'var(--blue)' : 'var(--border)';
  });
  _updateCronPreview();
}

/** Toggle between picker and natural language modes */
function _toggleCronMode() {
  const pickerEl = document.getElementById('sched-cron-picker');
  const nlEl = document.getElementById('sched-cron-nl');
  const toggleLink = document.getElementById('sched-cron-mode-toggle');
  if (!pickerEl || !nlEl) return;
  const showingPicker = pickerEl.style.display !== 'none';
  pickerEl.style.display = showingPicker ? 'none' : 'block';
  nlEl.style.display = showingPicker ? 'block' : 'none';
  if (toggleLink) toggleLink.textContent = showingPicker ? 'Use time picker' : 'Use natural language';
}

/** Parse natural language via API */
async function _parseNaturalCron() {
  const textarea = document.getElementById('sched-nl-input');
  const errEl = document.getElementById('sched-nl-error');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) { if (errEl) errEl.textContent = 'Enter a schedule description'; return; }
  if (errEl) errEl.textContent = '';

  try {
    const res = await fetch('/api/schedules/parse-natural', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.cron) {
      window._schedComputedCron = data.cron;
      const previewEl = document.getElementById('sched-cron-preview');
      if (previewEl) previewEl.textContent = '\u2192 cron: ' + data.cron + (data.description ? ' (' + data.description + ')' : '');
    } else {
      if (errEl) errEl.textContent = data.error || 'Failed to parse schedule';
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error: ' + e.message;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderSchedules(schedules) {
  const el = document.getElementById('scheduled-content');
  const countEl = document.getElementById('scheduled-count');
  countEl.textContent = schedules.length;
  if (!schedules.length) {
    el.innerHTML = '<p class="empty">No scheduled tasks. Add one to automate recurring work.</p>';
    return;
  }
  let html = '<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>ID</th><th>Title</th><th>Schedule</th><th>Type</th><th>Project</th><th>Agent</th><th>Enabled</th><th>Last Run</th><th></th></tr></thead><tbody>';
  for (const s of schedules) {
    const enabledBadge = s.enabled
      ? '<span class="pr-badge approved">enabled</span>'
      : '<span class="pr-badge rejected">disabled</span>';
    const lastRun = s._lastRun ? timeAgo(s._lastRun) : 'never';
    const typeBadge = '<span class="dispatch-type ' + escHtml(s.type || 'implement') + '">' + escHtml(s.type || 'implement') + '</span>';
    const humanCron = _cronToHuman(s.cron || '');
    html += '<tr>' +
      '<td><span class="pr-id">' + escHtml(s.id || '') + '</span></td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(s.title || '') + '">' + escHtml(s.title || '') + '</td>' +
      '<td><span title="' + escHtml(s.cron || '') + '" style="font-size:11px;color:var(--blue)">' + escHtml(humanCron) + '</span></td>' +
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

// ─── Form ───────────────────────────────────────────────────────────────────

function _scheduleFormHtml(sched, isEdit) {
  const types = ['implement', 'test', 'explore', 'ask', 'review', 'fix'];
  const priorities = ['high', 'medium', 'low'];
  const typeOpts = types.map(t => '<option value="' + t + '"' + ((sched.type || 'implement') === t ? ' selected' : '') + '>' + t + '</option>').join('');
  const priOpts = priorities.map(p => '<option value="' + p + '"' + ((sched.priority || 'medium') === p ? ' selected' : '') + '>' + p + '</option>').join('');
  const projOpts = '<option value="">Any</option>' + cmdProjects.map(p => '<option value="' + escHtml(p.name) + '"' + (sched.project === p.name ? ' selected' : '') + '>' + escHtml(p.name) + '</option>').join('');
  const agentOpts = '<option value="">Auto</option>' + cmdAgents.map(a => '<option value="' + escHtml(a.id) + '"' + (sched.agent === a.id ? ' selected' : '') + '>' + escHtml(a.name) + '</option>').join('');

  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';
  const pillStyle = 'display:inline-block;padding:4px 10px;margin:2px;border:1px solid var(--border);border-radius:12px;cursor:pointer;font-size:11px;color:var(--text);background:var(--bg);user-select:none;transition:all 0.15s';
  const pillActiveExtra = 'background:var(--blue);color:#fff;border-color:var(--blue)';
  const linkStyle = 'font-size:10px;color:var(--blue);cursor:pointer;text-decoration:underline;margin-right:8px';

  // Parse existing cron for picker defaults
  const picker = _parseCronToPicker(sched.cron || '');
  const computedCron = sched.cron || _pickerToCron(picker.hour, picker.minute, picker.days);

  // Hour options (0-23)
  let hourOpts = '';
  for (let h = 0; h < 24; h++) {
    hourOpts += '<option value="' + h + '"' + (picker.hour === h ? ' selected' : '') + '>' + String(h).padStart(2, '0') + '</option>';
  }
  // Minute options (0, 5, 10, ..., 55)
  let minOpts = '';
  for (let m = 0; m <= 55; m += 5) {
    minOpts += '<option value="' + m + '"' + (picker.minute === m ? ' selected' : '') + '>' + String(m).padStart(2, '0') + '</option>';
  }

  // Day pills
  const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon-Sun
  let dayPills = '';
  for (const d of dayOrder) {
    const isActive = picker.days.includes(d);
    dayPills += '<span class="sched-day-pill' + (isActive ? ' active' : '') + '" data-day="' + d + '" ' +
      'style="' + pillStyle + (isActive ? ';' + pillActiveExtra : '') + '" ' +
      'onclick="_toggleDayPill(this)">' + _DAYS[d] + '</span>';
  }

  // ID section: auto-generated for create, read-only label for edit
  let idSection = '';
  if (isEdit) {
    idSection = '<div style="color:var(--muted);font-size:11px;margin-bottom:4px">ID: <strong style="color:var(--text)">' + escHtml(sched.id || '') + '</strong></div>';
  } else {
    idSection = '<div id="sched-auto-id" style="color:var(--muted);font-size:11px;margin-bottom:4px">ID: <strong style="color:var(--text)">auto-generated from title</strong></div>';
  }

  return '<div style="display:flex;flex-direction:column;gap:12px;font-family:inherit">' +
    idSection +
    '<div id="sched-form-error" style="display:none;color:var(--red);font-size:12px;padding:6px 10px;background:rgba(255,50,50,0.1);border-radius:var(--radius-sm)"></div>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Title' +
      '<input id="sched-edit-title" value="' + escHtml(sched.title || '') + '" style="' + inputStyle + '"' +
      (!isEdit ? " oninput=\"(function(v){var el=document.querySelector('#sched-auto-id strong');if(el)el.textContent=v?window._generateScheduleId(v):'auto-generated from title'})(this.value)\"" : '') + '>' +
    '</label>' +
    '<div id="sched-cron-picker" style="display:block">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Schedule</label>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
        '<select id="sched-pick-hour" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updateCronPreview()">' + hourOpts + '</select>' +
        '<span style="color:var(--muted)">:</span>' +
        '<select id="sched-pick-minute" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updateCronPreview()">' + minOpts + '</select>' +
      '</div>' +
      '<div style="margin-top:8px">' + dayPills + '</div>' +
      '<div style="margin-top:6px">' +
        '<span style="' + linkStyle + "\" onclick=\"_quickSelectDays('all')\">Every day</span>" +
        '<span style="' + linkStyle + "\" onclick=\"_quickSelectDays('weekdays')\">Weekdays</span>" +
        '<span style="' + linkStyle + "\" onclick=\"_quickSelectDays('weekends')\">Weekends</span>" +
      '</div>' +
    '</div>' +
    '<div id="sched-cron-nl" style="display:none">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Schedule (natural language)</label>' +
      '<textarea id="sched-nl-input" rows="2" placeholder="every weekday at 9am" style="' + inputStyle + ';resize:vertical;margin-top:4px"></textarea>' +
      '<button onclick="_parseNaturalCron()" style="margin-top:6px;padding:4px 12px;font-size:11px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Parse \u2192</button>' +
      '<div id="sched-nl-error" style="color:var(--red);font-size:11px;margin-top:4px"></div>' +
    '</div>' +
    '<div style="margin-top:2px">' +
      '<span id="sched-cron-preview" style="font-size:11px;color:var(--blue)">\u2192 cron: ' + escHtml(computedCron) + '</span>' +
      '<br><span id="sched-cron-mode-toggle" style="' + linkStyle + ';margin-top:4px;display:inline-block" onclick="_toggleCronMode()">Use natural language</span>' +
    '</div>' +
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
  window._schedComputedCron = '';
  document.getElementById('modal-title').textContent = 'New Scheduled Task';
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').innerHTML = _scheduleFormHtml({}, false);
  document.getElementById('modal').classList.add('open');
  _updateCronPreview();
}

function openEditScheduleModal(id) {
  const sched = (window._lastSchedules || []).find(s => s.id === id);
  if (!sched) return;
  window._schedComputedCron = sched.cron || '';
  document.getElementById('modal-title').textContent = 'Edit Schedule: ' + id;
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').innerHTML = _scheduleFormHtml(sched, true);
  window._editScheduleId = id;
  document.getElementById('modal').classList.add('open');
}

async function submitSchedule(isEdit) {
  _showScheduleError('');
  const title = document.getElementById('sched-edit-title').value.trim();
  const cron = window._schedComputedCron || '';
  const type = document.getElementById('sched-edit-type').value;
  const priority = document.getElementById('sched-edit-priority').value;
  const project = document.getElementById('sched-edit-project').value;
  const agent = document.getElementById('sched-edit-agent').value;
  const description = document.getElementById('sched-edit-desc').value;

  let id;
  if (isEdit) {
    id = window._editScheduleId;
  } else {
    id = _generateScheduleId(title);
  }

  if (!title) { _showScheduleError('Title is required'); return; }
  if (!cron) { _showScheduleError('Schedule is required \u2014 select days and time, or use natural language'); return; }

  const payload = { id, title, cron, type, priority, project: project || undefined, agent: agent || undefined, description: description || undefined, enabled: true };
  const url = isEdit ? '/api/schedules/update' : '/api/schedules';
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) { closeModal(); refresh(); showToast('cmd-toast', isEdit ? 'Schedule updated' : 'Schedule created', true); } else {
      const d = await res.json().catch(() => ({}));
      _showScheduleError((isEdit ? 'Update' : 'Create') + ' failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { _showScheduleError('Error: ' + e.message); }
}

async function toggleScheduleEnabled(id, enabled) {
  try {
    const res = await fetch('/api/schedules/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled })
    });
    if (res.ok) { refresh(); } else {
      const d = await res.json().catch(() => ({}));
      _showScheduleError('Toggle failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { _showScheduleError('Toggle error: ' + e.message); }
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
      _showScheduleError('Delete failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { _showScheduleError('Delete error: ' + e.message); }
}

// Expose _generateScheduleId globally for the inline oninput handler
window._generateScheduleId = _generateScheduleId;

window.MinionsSchedules = { renderSchedules, openCreateScheduleModal, openEditScheduleModal, submitSchedule, toggleScheduleEnabled, deleteSchedule, _cronToHuman, _parseNaturalCron, _toggleCronMode, _quickSelectDays, _toggleDayPill, _updateCronPreview };
