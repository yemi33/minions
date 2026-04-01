// render-pipelines.js — Pipeline list, run detail, and create modal

let _pipelinesData = [];

function renderPipelines(pipelines) {
  _pipelinesData = pipelines || [];
  const el = document.getElementById('pipelines-content');
  const countEl = document.getElementById('pipelines-count');
  if (!el) return;
  if (!pipelines || pipelines.length === 0) {
    countEl.textContent = '0';
    el.innerHTML = '<p class="empty">No pipelines yet. Create one to chain stages like audit \u2192 meeting \u2192 plan \u2192 merge.</p>';
    return;
  }
  countEl.textContent = pipelines.length;

  el.innerHTML = pipelines.map(function(p) {
    const activeRun = (p.runs || []).find(function(r) { return r.status === 'running'; });
    const lastRun = (p.runs || []).slice(-1)[0];
    const statusColor = activeRun ? 'var(--blue)' : lastRun?.status === 'completed' ? 'var(--green)' : lastRun?.status === 'failed' ? 'var(--red)' : 'var(--muted)';
    const statusLabel = activeRun ? 'Running' : lastRun ? (lastRun.status === 'completed' ? 'Completed' : lastRun.status === 'failed' ? 'Failed' : lastRun.status) : 'Never run';
    const trigger = p.trigger?.cron ? _cronToHuman(p.trigger.cron) : 'Manual';

    // Stage flow visualization
    var stageFlow = (p.stages || []).map(function(s) {
      var icon = { task: '\u2699', meeting: '\uD83D\uDCAC', plan: '\uD83D\uDCCB', 'merge-prs': '\uD83D\uDD00', api: '\uD83C\uDF10', wait: '\u23F8', parallel: '\u2693', schedule: '\u23F0' }[s.type] || '\u2022';
      var stageStatus = activeRun?.stages?.[s.id]?.status || 'pending';
      var color = stageStatus === 'completed' ? 'var(--green)' : stageStatus === 'running' ? 'var(--blue)' : stageStatus === 'failed' ? 'var(--red)' : stageStatus === 'waiting-human' ? 'var(--yellow)' : 'var(--muted)';
      return '<span style="color:' + color + ';font-size:11px" title="' + escHtml(s.id) + ': ' + escHtml(s.title || s.type) + ' (' + stageStatus + ')">' + icon + ' ' + escHtml(s.id) + '</span>';
    }).join(' <span style="color:var(--border)">\u2192</span> ');

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer" onclick="openPipelineDetail(\'' + escHtml(p.id) + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:13px">' + escHtml(p.title) + '</strong>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="color:' + statusColor + ';font-size:11px;font-weight:600">' + statusLabel + '</span>' +
          '<span style="font-size:10px;color:var(--muted)">' + escHtml(trigger) + '</span>' +
          (p.enabled === false ? '<span style="font-size:9px;color:var(--red)">DISABLED</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="margin-top:6px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">' + stageFlow + '</div>' +
    '</div>';
  }).join('');
}

function openPipelineDetail(id) {
  var p = _pipelinesData.find(function(x) { return x.id === id; });
  if (!p) { alert('Pipeline not found'); return; }

  var html = '<div style="display:flex;flex-direction:column;gap:12px">';

  // Status + actions
  var activeRun = (p.runs || []).find(function(r) { return r.status === 'running'; });
  html += '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<span style="font-size:10px;color:var(--muted)">' + (p.trigger?.cron ? escHtml(_cronToHuman(p.trigger.cron)) + ' <span style="opacity:0.6">(' + escHtml(p.trigger.cron) + ', ' + escHtml(Intl.DateTimeFormat().resolvedOptions().timeZone) + ')</span>' : 'Manual trigger') + '</span>' +
    '<div style="display:flex;gap:6px">' +
      (activeRun ? '' : '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green)" onclick="_triggerPipeline(\'' + escHtml(id) + '\',this)">Run Now</button>') +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="openEditPipelineModal(\'' + escHtml(id) + '\')">Edit</button>' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="_togglePipelineEnabled(\'' + escHtml(id) + '\',' + !p.enabled + ',this)">' + (p.enabled !== false ? 'Disable' : 'Enable') + '</button>' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_deletePipelineConfirm(\'' + escHtml(id) + '\')">Delete</button>' +
    '</div>' +
  '</div>';

  // Stage detail
  html += '<h4 style="font-size:12px;color:var(--blue);margin:0">Stages</h4>';
  (p.stages || []).forEach(function(s, i) {
    var stageRun = activeRun?.stages?.[s.id] || {};
    var stageStatus = stageRun.status || 'pending';
    var statusColor = stageStatus === 'completed' ? 'var(--green)' : stageStatus === 'running' ? 'var(--blue)' : stageStatus === 'failed' ? 'var(--red)' : stageStatus === 'waiting-human' ? 'var(--yellow)' : 'var(--muted)';
    var deps = (s.dependsOn || []).join(', ') || 'none';

    html += '<div style="border:1px solid var(--border);border-radius:6px;padding:8px 12px;background:var(--surface2)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-weight:600;font-size:12px">' + (i + 1) + '. ' + escHtml(s.title || s.id) + '</span>' +
        '<span style="color:' + statusColor + ';font-size:10px;font-weight:600">' + stageStatus.toUpperCase() + '</span>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--muted);margin-top:4px">Type: ' + escHtml(s.type) + ' | Depends on: ' + escHtml(deps) + (s.agent ? ' | Agent: ' + escHtml(s.agent) : '') + '</div>' +
      (stageRun.output ? '<div style="margin-top:6px;font-size:11px;max-height:150px;overflow-y:auto">' + renderMd(stageRun.output.slice(0, 500)) + '</div>' : '') +
      (stageStatus === 'waiting-human' ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green);margin-top:6px" onclick="_continuePipeline(\'' + escHtml(id) + '\',\'' + escHtml(s.id) + '\',this)">Continue</button>' : '') +
    '</div>';
  });

  // Run history
  var runs = (p.runs || []).slice(-5).reverse();
  if (runs.length > 0) {
    html += '<h4 style="font-size:12px;color:var(--blue);margin:0">Recent Runs</h4>';
    runs.forEach(function(r) {
      var color = r.status === 'completed' ? 'var(--green)' : r.status === 'failed' ? 'var(--red)' : r.status === 'running' ? 'var(--blue)' : 'var(--muted)';
      html += '<div style="font-size:10px;display:flex;gap:8px;align-items:center">' +
        '<span style="color:' + color + ';font-weight:600">' + r.status + '</span>' +
        '<span style="color:var(--muted)">' + (r.startedAt ? new Date(r.startedAt).toLocaleString() : '') + '</span>' +
        (r.completedAt ? '<span style="color:var(--muted)">\u2192 ' + new Date(r.completedAt).toLocaleString() + '</span>' : '') +
      '</div>';
    });
  }

  html += '</div>';

  document.getElementById('modal-title').textContent = 'Pipeline: ' + p.title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}

async function _triggerPipeline(id, btn) {
  if (btn) { btn.textContent = 'Starting...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    var res = await fetch('/api/pipelines/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    var d = await res.json();
    if (res.ok) { showToast('cmd-toast', 'Pipeline triggered: ' + (d.runId || ''), true); try { closeModal(); } catch {} refresh(); }
    else { if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Error: ' + e.message); }
}

async function _togglePipelineEnabled(id, enabled, btn) {
  if (btn) { btn.textContent = enabled ? 'Enabling...' : 'Disabling...'; btn.style.pointerEvents = 'none'; }
  try {
    var res = await fetch('/api/pipelines/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, enabled: enabled }) });
    if (res.ok) { showToast('cmd-toast', enabled ? 'Pipeline enabled' : 'Pipeline disabled', true); refresh(); }
    else { alert('Failed'); }
  } catch (e) { alert('Error: ' + e.message); }
  if (btn) { btn.textContent = enabled ? 'Disable' : 'Enable'; btn.style.pointerEvents = ''; }
}

async function _continuePipeline(id, stageId, btn) {
  if (btn) { btn.textContent = 'Continuing...'; btn.style.pointerEvents = 'none'; }
  try {
    var res = await fetch('/api/pipelines/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, stageId: stageId }) });
    if (res.ok) { showToast('cmd-toast', 'Stage continued', true); openPipelineDetail(id); }
    else { var d = await res.json().catch(function() { return {}; }); alert('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
  if (btn) { btn.textContent = 'Continue'; btn.style.pointerEvents = ''; }
}

async function _deletePipelineConfirm(id) {
  if (!confirm('Delete pipeline "' + id + '"?')) return;
  markDeleted('pipeline:' + id);
  try { closeModal(); } catch {}
  try {
    var res = await fetch('/api/pipelines/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (!res.ok) { alert('Delete failed'); refresh(); }
  } catch (e) { alert('Error: ' + e.message); refresh(); }
}

function openCreatePipelineModal() {
  var inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';
  var pillStyle = 'display:inline-block;padding:4px 10px;margin:2px;border:1px solid var(--border);border-radius:12px;cursor:pointer;font-size:11px;color:var(--text);background:var(--bg);user-select:none;transition:all 0.15s';
  var linkStyle = 'font-size:10px;color:var(--blue);cursor:pointer;text-decoration:underline;margin-right:8px';
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Hour options (0-23)
  var hourOpts = '';
  for (var h = 0; h < 24; h++) hourOpts += '<option value="' + h + '"' + (h === 9 ? ' selected' : '') + '>' + String(h).padStart(2, '0') + '</option>';
  // Minute options (0, 5, 10, ..., 55)
  var minOpts = '';
  for (var m = 0; m <= 55; m += 5) minOpts += '<option value="' + m + '"' + (m === 0 ? ' selected' : '') + '>' + String(m).padStart(2, '0') + '</option>';

  var dayOrder = [0, 1, 2, 3, 4, 5, 6];
  var dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var dayPills = dayOrder.map(function(d) {
    var active = d >= 1 && d <= 5; // default weekdays
    return '<span class="sched-day-pill' + (active ? ' active' : '') + '" data-day="' + d + '" ' +
      'style="' + pillStyle + (active ? ';background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" ' +
      'onclick="_toggleDayPill(this);_updatePlCronPreview()">' + dayLabels[d] + '</span>';
  }).join('');

  document.getElementById('modal-title').textContent = 'New Pipeline';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">ID<input id="pl-id" style="' + inputStyle + '" placeholder="e.g. daily-audit-cycle"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title<input id="pl-title" style="' + inputStyle + '" placeholder="e.g. Daily audit and improvement cycle"></label>' +
      '<div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<label style="color:var(--text);font-size:var(--text-md);margin:0">Schedule</label>' +
          '<label style="font-size:11px;color:var(--muted);cursor:pointer"><input type="checkbox" id="pl-use-cron" checked onchange="_updatePlCronPreview()" style="accent-color:var(--blue)"> Enable automatic trigger</label>' +
        '</div>' +
        '<div id="pl-cron-picker">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<select id="pl-pick-hour" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updatePlCronPreview()">' + hourOpts + '</select>' +
            '<span style="color:var(--muted)">:</span>' +
            '<select id="pl-pick-minute" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updatePlCronPreview()">' + minOpts + '</select>' +
            '<span style="font-size:10px;color:var(--muted)">' + escHtml(tz) + '</span>' +
          '</div>' +
          '<div style="margin-top:8px">' + dayPills + '</div>' +
          '<div style="margin-top:6px">' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'all\');_updatePlCronPreview()">Every day</span>' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'weekdays\');_updatePlCronPreview()">Weekdays</span>' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'weekends\');_updatePlCronPreview()">Weekends</span>' +
          '</div>' +
          '<div id="pl-cron-preview" style="margin-top:4px;font-size:11px;color:var(--blue)"></div>' +
        '</div>' +
      '</div>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Stages (JSON array)<textarea id="pl-stages" rows="10" style="' + inputStyle + ';resize:vertical;font-family:Consolas,monospace" placeholder=\'[{"id":"audit","type":"task","title":"Audit codebase","taskType":"explore"},{"id":"discuss","type":"meeting","title":"Discuss findings","dependsOn":["audit"],"participants":["all"]}]\'></textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitCreatePipeline()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Create Pipeline</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
  _updatePlCronPreview();
}

function _updatePlCronPreview() {
  var useCron = document.getElementById('pl-use-cron')?.checked;
  var pickerEl = document.getElementById('pl-cron-picker');
  if (pickerEl) pickerEl.style.opacity = useCron ? '1' : '0.4';
  if (pickerEl) pickerEl.style.pointerEvents = useCron ? '' : 'none';
  if (!useCron) { window._plComputedCron = ''; var prev = document.getElementById('pl-cron-preview'); if (prev) prev.textContent = 'Manual trigger only'; return; }
  var hour = parseInt(document.getElementById('pl-pick-hour')?.value || '9', 10);
  var minute = parseInt(document.getElementById('pl-pick-minute')?.value || '0', 10);
  var days = [];
  document.querySelectorAll('.sched-day-pill').forEach(function(btn) { if (btn.classList.contains('active')) days.push(parseInt(btn.dataset.day, 10)); });
  var cron = _pickerToCron(hour, minute, days);
  window._plComputedCron = cron;
  var prev = document.getElementById('pl-cron-preview');
  if (prev) prev.textContent = cron ? '\u2192 ' + _cronToHuman(cron) : '(select at least one day)';
}

async function _submitCreatePipeline() {
  var id = document.getElementById('pl-id')?.value?.trim();
  var title = document.getElementById('pl-title')?.value?.trim();
  var useCron = document.getElementById('pl-use-cron')?.checked;
  var cron = useCron ? (window._plComputedCron || '') : '';
  var stagesRaw = document.getElementById('pl-stages')?.value?.trim();
  if (!id || !title) { alert('ID and title required'); return; }
  var stages;
  try { stages = JSON.parse(stagesRaw); } catch (e) { alert('Invalid JSON in stages: ' + e.message); return; }
  if (!Array.isArray(stages) || stages.length === 0) { alert('Stages must be a non-empty array'); return; }

  var body = { id: id, title: title, stages: stages };
  if (cron) body.trigger = { cron: cron };

  try { closeModal(); } catch {}
  showToast('cmd-toast', 'Pipeline created', true);
  try {
    var res = await fetch('/api/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { refresh(); } else { var d = await res.json().catch(function() { return {}; }); alert('Failed: ' + (d.error || 'unknown')); openCreatePipelineModal(); }
  } catch (e) { alert('Error: ' + e.message); openCreatePipelineModal(); }
}

function openEditPipelineModal(id) {
  var p = _pipelinesData.find(function(x) { return x.id === id; });
  if (!p) return;
  var inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';
  var pillStyle = 'display:inline-block;padding:4px 10px;margin:2px;border:1px solid var(--border);border-radius:12px;cursor:pointer;font-size:11px;color:var(--text);background:var(--bg);user-select:none;transition:all 0.15s';
  var linkStyle = 'font-size:10px;color:var(--blue);cursor:pointer;text-decoration:underline;margin-right:8px';
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var hasCron = !!p.trigger?.cron;
  var picker = hasCron ? _parseCronToPicker(p.trigger.cron) : { hour: 9, minute: 0, days: [1,2,3,4,5] };

  var hourOpts = '';
  for (var h = 0; h < 24; h++) hourOpts += '<option value="' + h + '"' + (h === picker.hour ? ' selected' : '') + '>' + String(h).padStart(2, '0') + '</option>';
  var minOpts = '';
  for (var m = 0; m <= 55; m += 5) minOpts += '<option value="' + m + '"' + (m === picker.minute ? ' selected' : '') + '>' + String(m).padStart(2, '0') + '</option>';

  var dayOrder = [0, 1, 2, 3, 4, 5, 6];
  var dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var dayPills = dayOrder.map(function(d) {
    var active = picker.days.includes(d);
    return '<span class="sched-day-pill' + (active ? ' active' : '') + '" data-day="' + d + '" ' +
      'style="' + pillStyle + (active ? ';background:var(--blue);color:#fff;border-color:var(--blue)' : '') + '" ' +
      'onclick="_toggleDayPill(this);_updatePlCronPreview()">' + dayLabels[d] + '</span>';
  }).join('');

  window._editPipelineId = id;

  document.getElementById('modal-title').textContent = 'Edit Pipeline: ' + p.title;
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<div style="color:var(--muted);font-size:11px">ID: <strong style="color:var(--text)">' + escHtml(id) + '</strong></div>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title<input id="pl-title" value="' + escHtml(p.title || '') + '" style="' + inputStyle + '"></label>' +
      '<div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<label style="color:var(--text);font-size:var(--text-md);margin:0">Schedule</label>' +
          '<label style="font-size:11px;color:var(--muted);cursor:pointer"><input type="checkbox" id="pl-use-cron"' + (hasCron ? ' checked' : '') + ' onchange="_updatePlCronPreview()" style="accent-color:var(--blue)"> Enable automatic trigger</label>' +
        '</div>' +
        '<div id="pl-cron-picker">' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<select id="pl-pick-hour" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updatePlCronPreview()">' + hourOpts + '</select>' +
            '<span style="color:var(--muted)">:</span>' +
            '<select id="pl-pick-minute" style="' + inputStyle + ';width:auto;display:inline-block" onchange="_updatePlCronPreview()">' + minOpts + '</select>' +
            '<span style="font-size:10px;color:var(--muted)">' + escHtml(tz) + '</span>' +
          '</div>' +
          '<div style="margin-top:8px">' + dayPills + '</div>' +
          '<div style="margin-top:6px">' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'all\');_updatePlCronPreview()">Every day</span>' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'weekdays\');_updatePlCronPreview()">Weekdays</span>' +
            '<span style="' + linkStyle + '" onclick="_quickSelectDays(\'weekends\');_updatePlCronPreview()">Weekends</span>' +
          '</div>' +
          '<div id="pl-cron-preview" style="margin-top:4px;font-size:11px;color:var(--blue)"></div>' +
        '</div>' +
      '</div>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Stages (JSON array)<textarea id="pl-stages" rows="10" style="' + inputStyle + ';resize:vertical;font-family:Consolas,monospace">' + escHtml(JSON.stringify(p.stages || [], null, 2)) + '</textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitEditPipeline()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Save</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal').classList.add('open');
  _updatePlCronPreview();
}

async function _submitEditPipeline() {
  var id = window._editPipelineId;
  if (!id) return;
  var title = document.getElementById('pl-title')?.value?.trim();
  var useCron = document.getElementById('pl-use-cron')?.checked;
  var cron = useCron ? (window._plComputedCron || '') : '';
  var stagesRaw = document.getElementById('pl-stages')?.value?.trim();
  if (!title) { alert('Title required'); return; }
  var stages;
  try { stages = JSON.parse(stagesRaw); } catch (e) { alert('Invalid JSON in stages: ' + e.message); return; }
  if (!Array.isArray(stages) || stages.length === 0) { alert('Stages must be a non-empty array'); return; }

  var body = { id: id, title: title, stages: stages, trigger: cron ? { cron: cron } : null };
  try {
    var res = await fetch('/api/pipelines/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { closeModal(); showToast('cmd-toast', 'Pipeline updated', true); refresh(); }
    else { var d = await res.json().catch(function() { return {}; }); alert('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

window.MinionsPipelines = { renderPipelines, openPipelineDetail, openCreatePipelineModal, openEditPipelineModal };
