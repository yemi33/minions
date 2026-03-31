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

// --- Simple Picker mode for cron input ---

// Try to parse a 3-field cron into { minute, hour, days[] } for the picker.
// Returns null if the cron is too complex (e.g. ranges in minute/hour, step values).
function _parseCronForPicker(cron) {
  if (!cron || typeof cron !== 'string') return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return null;
  const [minField, hourField, dowField] = [parts[0], parts[1], parts[2] || '*'];

  const min = parseInt(minField, 10);
  const hour = parseInt(hourField, 10);
  if (isNaN(min) || isNaN(hour) || String(min) !== minField.trim() || String(hour) !== hourField.trim()) return null;
  if (min < 0 || min > 59 || hour < 0 || hour > 23) return null;

  let days = [];
  if (dowField === '*') {
    days = [0, 1, 2, 3, 4, 5, 6];
  } else if (/^\d+-\d+$/.test(dowField)) {
    const [a, b] = dowField.split('-').map(Number);
    if (isNaN(a) || isNaN(b) || a < 0 || b > 6) return null;
    for (let i = a; i <= b; i++) days.push(i);
  } else if (/^\d+$/.test(dowField)) {
    const d = parseInt(dowField, 10);
    if (d < 0 || d > 6) return null;
    days = [d];
  } else if (/^[\d,]+$/.test(dowField)) {
    days = dowField.split(',').map(Number).sort((a, b) => a - b);
    if (days.some(d => isNaN(d) || d < 0 || d > 6)) return null;
  } else {
    return null;
  }

  return { minute: min, hour: hour, days: days };
}

// Build the picker HTML. If the cron is unparseable, show a raw text input fallback.
function _schedulePickerHtml(cronVal, inputStyle) {
  const parsed = _parseCronForPicker(cronVal);
  const usePicker = !cronVal || parsed !== null;

  // Minute options (0-59, common values highlighted)
  let minOpts = '';
  for (let m = 0; m < 60; m++) {
    const label = String(m).padStart(2, '0');
    const sel = parsed && parsed.minute === m ? ' selected' : (!cronVal && m === 0 ? ' selected' : '');
    minOpts += '<option value="' + m + '"' + sel + '>' + label + '</option>';
  }

  // Hour options (0-23)
  let hourOpts = '';
  for (let h = 0; h < 24; h++) {
    const label = String(h).padStart(2, '0');
    const sel = parsed && parsed.hour === h ? ' selected' : (!cronVal && h === 9 ? ' selected' : '');
    hourOpts += '<option value="' + h + '"' + sel + '>' + label + '</option>';
  }

  // Day-of-week pills (Sun=0 .. Sat=6, displayed Mon-first)
  const dayLabels = [
    { idx: 1, short: 'Mon' }, { idx: 2, short: 'Tue' }, { idx: 3, short: 'Wed' },
    { idx: 4, short: 'Thu' }, { idx: 5, short: 'Fri' }, { idx: 6, short: 'Sat' },
    { idx: 0, short: 'Sun' }
  ];
  const activeDays = parsed ? parsed.days : [0, 1, 2, 3, 4, 5, 6]; // default: all days
  let dayPillsHtml = '';
  for (const d of dayLabels) {
    const active = activeDays.includes(d.idx);
    dayPillsHtml += '<button type="button" class="sched-day-pill" data-day="' + d.idx + '"' +
      ' style="padding:4px 8px;font-size:var(--text-sm);border-radius:var(--radius-sm);cursor:pointer;border:1px solid ' +
      (active ? 'var(--blue)' : 'var(--border)') + ';background:' +
      (active ? 'rgba(88,166,255,0.15)' : 'var(--bg)') + ';color:' +
      (active ? 'var(--blue)' : 'var(--muted)') + ';font-weight:' +
      (active ? '600' : '400') + ';font-family:inherit;transition:all 0.15s">' + d.short + '</button>';
  }

  // Preset buttons
  const presetBtnStyle = 'padding:2px 8px;font-size:var(--text-xs);border-radius:var(--radius-sm);cursor:pointer;border:1px solid var(--border);background:var(--surface2);color:var(--muted);font-family:inherit';

  const pickerHtml =
    '<div id="sched-picker-wrap" style="display:' + (usePicker ? 'block' : 'none') + '">' +
      '<div style="color:var(--text);font-size:var(--text-md);margin-bottom:4px">Schedule</div>' +
      // Time row
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<label style="color:var(--muted);font-size:var(--text-sm)">Time:</label>' +
        '<select id="sched-pick-hour" style="' + inputStyle + ';width:auto;display:inline-block;margin-top:0">' + hourOpts + '</select>' +
        '<span style="color:var(--muted)">:</span>' +
        '<select id="sched-pick-minute" style="' + inputStyle + ';width:auto;display:inline-block;margin-top:0">' + minOpts + '</select>' +
      '</div>' +
      // Day pills
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">' +
        '<label style="color:var(--muted);font-size:var(--text-sm)">Days:</label>' +
        dayPillsHtml +
      '</div>' +
      // Presets
      '<div style="display:flex;gap:6px;margin-bottom:8px;margin-left:34px">' +
        '<button type="button" onclick="_schedPickerPreset(\'all\')" style="' + presetBtnStyle + '">Every day</button>' +
        '<button type="button" onclick="_schedPickerPreset(\'weekdays\')" style="' + presetBtnStyle + '">Weekdays</button>' +
        '<button type="button" onclick="_schedPickerPreset(\'weekends\')" style="' + presetBtnStyle + '">Weekends</button>' +
      '</div>' +
      // Live preview
      '<div id="sched-picker-preview" style="font-size:var(--text-sm);color:var(--muted);padding:4px 8px;background:var(--surface2);border-radius:var(--radius-sm);margin-bottom:4px"></div>' +
    '</div>' +
    // Raw fallback (shown for unparseable cron in edit mode)
    '<div id="sched-raw-cron-wrap" style="display:' + (usePicker ? 'none' : 'block') + '">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Cron <span style="font-size:10px;color:var(--muted)">(minute hour dayOfWeek)</span>' +
        '<input id="sched-raw-cron" value="' + escHtml(cronVal) + '" placeholder="0 2 *" style="' + inputStyle + '"' +
          ' oninput="document.getElementById(\'sched-edit-cron\').value=this.value">' +
      '</label>' +
    '</div>' +
    // Toggle link between picker and raw
    '<div style="margin-top:2px">' +
      '<a href="#" id="sched-picker-toggle" onclick="event.preventDefault();_toggleSchedulePicker()" style="font-size:var(--text-xs);color:var(--blue);text-decoration:none">' +
        (usePicker ? 'Edit raw cron' : 'Use time picker') +
      '</a>' +
    '</div>';

  return pickerHtml;
}

// Toggle between picker and raw cron input
function _toggleSchedulePicker() {
  const pickerWrap = document.getElementById('sched-picker-wrap');
  const rawWrap = document.getElementById('sched-raw-cron-wrap');
  const toggle = document.getElementById('sched-picker-toggle');
  if (!pickerWrap || !rawWrap) return;

  const pickerVisible = pickerWrap.style.display !== 'none';
  if (pickerVisible) {
    // Switch to raw — copy current cron value into raw input
    pickerWrap.style.display = 'none';
    rawWrap.style.display = 'block';
    const rawInput = document.getElementById('sched-raw-cron');
    if (rawInput) rawInput.value = document.getElementById('sched-edit-cron').value;
    toggle.textContent = 'Use time picker';
  } else {
    // Switch to picker — try to parse current raw cron
    const cronVal = document.getElementById('sched-edit-cron').value;
    const parsed = _parseCronForPicker(cronVal);
    if (parsed) {
      document.getElementById('sched-pick-hour').value = parsed.hour;
      document.getElementById('sched-pick-minute').value = parsed.minute;
      _schedPickerSetDays(parsed.days);
    }
    rawWrap.style.display = 'none';
    pickerWrap.style.display = 'block';
    toggle.textContent = 'Edit raw cron';
    _updateCronFromPicker();
  }
}

// Set day pill states programmatically
function _schedPickerSetDays(days) {
  const pills = document.querySelectorAll('.sched-day-pill');
  pills.forEach(pill => {
    const d = parseInt(pill.getAttribute('data-day'), 10);
    const active = days.includes(d);
    pill.style.borderColor = active ? 'var(--blue)' : 'var(--border)';
    pill.style.background = active ? 'rgba(88,166,255,0.15)' : 'var(--bg)';
    pill.style.color = active ? 'var(--blue)' : 'var(--muted)';
    pill.style.fontWeight = active ? '600' : '400';
    pill.setAttribute('data-active', active ? '1' : '0');
  });
}

// Apply a preset (all, weekdays, weekends)
function _schedPickerPreset(preset) {
  const presets = {
    all: [0, 1, 2, 3, 4, 5, 6],
    weekdays: [1, 2, 3, 4, 5],
    weekends: [0, 6]
  };
  _schedPickerSetDays(presets[preset] || []);
  _updateCronFromPicker();
}

// Compute the cron expression from the picker and update hidden field + preview
function _updateCronFromPicker() {
  const hourEl = document.getElementById('sched-pick-hour');
  const minEl = document.getElementById('sched-pick-minute');
  if (!hourEl || !minEl) return;

  const hour = parseInt(hourEl.value, 10);
  const minute = parseInt(minEl.value, 10);

  // Collect active days
  const days = [];
  document.querySelectorAll('.sched-day-pill').forEach(pill => {
    const active = pill.style.borderColor === 'var(--blue)' ||
      pill.getAttribute('data-active') === '1';
    if (active) days.push(parseInt(pill.getAttribute('data-day'), 10));
  });
  days.sort((a, b) => a - b);

  // Build day-of-week field
  let dowField;
  if (days.length === 0) {
    dowField = '*'; // no days selected = every day (safer default)
  } else if (days.length === 7) {
    dowField = '*';
  } else {
    // Check for contiguous range
    let isRange = true;
    for (let i = 1; i < days.length; i++) {
      if (days[i] !== days[i - 1] + 1) { isRange = false; break; }
    }
    dowField = isRange && days.length > 1
      ? days[0] + '-' + days[days.length - 1]
      : days.join(',');
  }

  const cron = minute + ' ' + hour + ' ' + dowField;

  // Update hidden field
  document.getElementById('sched-edit-cron').value = cron;

  // Update preview
  const previewEl = document.getElementById('sched-picker-preview');
  if (previewEl) {
    const human = _cronToHuman(cron);
    previewEl.innerHTML = '<span style="color:var(--blue)">' + escHtml(human) + '</span>' +
      (human !== cron ? ' <span style="color:var(--muted);font-size:var(--text-xs)">&rarr; ' + escHtml(cron) + '</span>' : '');
  }
}

// Initialize picker event handlers (called after form is inserted into DOM)
function _initSchedulePicker() {
  // Day pill click handlers
  document.querySelectorAll('.sched-day-pill').forEach(pill => {
    pill.addEventListener('click', function() {
      const isActive = this.style.borderColor === 'var(--blue)' ||
        this.getAttribute('data-active') === '1';
      const newActive = !isActive;
      this.style.borderColor = newActive ? 'var(--blue)' : 'var(--border)';
      this.style.background = newActive ? 'rgba(88,166,255,0.15)' : 'var(--bg)';
      this.style.color = newActive ? 'var(--blue)' : 'var(--muted)';
      this.style.fontWeight = newActive ? '600' : '400';
      this.setAttribute('data-active', newActive ? '1' : '0');
      _updateCronFromPicker();
    });
  });

  // Time dropdown change handlers
  const hourEl = document.getElementById('sched-pick-hour');
  const minEl = document.getElementById('sched-pick-minute');
  if (hourEl) hourEl.addEventListener('change', _updateCronFromPicker);
  if (minEl) minEl.addEventListener('change', _updateCronFromPicker);

  // Set initial data-active attributes on pills
  document.querySelectorAll('.sched-day-pill').forEach(pill => {
    const isActive = pill.style.borderColor === 'var(--blue)';
    pill.setAttribute('data-active', isActive ? '1' : '0');
  });

  // Run initial cron computation if picker is visible
  if (document.getElementById('sched-picker-wrap') &&
      document.getElementById('sched-picker-wrap').style.display !== 'none') {
    _updateCronFromPicker();
  }
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
  _initSchedulePicker();
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
  _initSchedulePicker();
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
