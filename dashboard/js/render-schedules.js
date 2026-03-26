// render-schedules.js — Schedule rendering functions extracted from dashboard.html

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
      '<td><code style="font-size:10px;color:var(--blue)">' + escHtml(s.cron || '') + '</code></td>' +
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
      '<label style="color:var(--text);font-size:var(--text-md)">ID (unique slug)' +
        '<input id="sched-edit-id" value="' + escHtml(sched.id || '') + '" placeholder="e.g. nightly-tests" style="' + inputStyle + '">' +
      '</label>') +
    '<label style="color:var(--text);font-size:var(--text-md)">Title' +
      '<input id="sched-edit-title" value="' + escHtml(sched.title || '') + '" style="' + inputStyle + '">' +
    '</label>' +
    '<label style="color:var(--text);font-size:var(--text-md)">Cron <span style="font-size:10px;color:var(--muted)">(minute hour dayOfWeek)</span>' +
      '<input id="sched-edit-cron" value="' + escHtml(sched.cron || '') + '" placeholder="0 2 *" style="' + inputStyle + '">' +
    '</label>' +
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

  if (!id) { alert('ID is required'); return; }
  if (!title) { alert('Title is required'); return; }
  if (!cron) { alert('Cron expression is required'); return; }

  const payload = { id, title, cron, type, priority, project: project || undefined, agent: agent || undefined, description: description || undefined, enabled: true };
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
