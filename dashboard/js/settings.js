// settings.js — Settings panel functions extracted from dashboard.html

async function openSettings() {
  let data;
  try {
    const res = await fetch('/api/settings');
    data = await res.json();
  } catch (e) { showToast('cmd-toast', 'Failed to load settings: ' + e.message, false); return; }

  const e = data.engine || {};
  const c = data.claude || {};
  const agents = data.agents || {};

  const agentRows = Object.entries(agents).map(function([id, a]) {
    return '<tr>' +
      '<td style="font-weight:600">' + escHtml(a.emoji || '') + ' ' + escHtml(a.name || id) + '</td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="role" value="' + escHtml(a.role || '') + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="skills" value="' + escHtml((a.skills || []).join(', ')) + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
    '</tr>';
  }).join('');

  const html = '<div style="padding:8px 0;max-height:70vh;overflow-y:auto">' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Engine</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Tick Interval', 'set-tickInterval', e.tickInterval || 60000, 'ms', 'How often the engine runs discovery + dispatch') +
      settingsField('Max Concurrent Agents', 'set-maxConcurrent', e.maxConcurrent || 3, '', 'Max agents working simultaneously') +
      settingsField('Consolidation Threshold', 'set-inboxConsolidateThreshold', e.inboxConsolidateThreshold || 5, 'notes', 'Inbox notes before auto-consolidation') +
      settingsField('Agent Timeout', 'set-agentTimeout', e.agentTimeout || 18000000, 'ms', 'Kill agent after this duration') +
      settingsField('Max Turns', 'set-maxTurns', e.maxTurns || 100, '', 'Claude CLI --max-turns per agent') +
      settingsField('Heartbeat Timeout', 'set-heartbeatTimeout', e.heartbeatTimeout || 300000, 'ms', 'No output = dead after this') +
      settingsField('Worktree Create Timeout', 'set-worktreeCreateTimeout', e.worktreeCreateTimeout || 300000, 'ms', 'Timeout for git worktree add (increase for large repos/Windows)') +
      settingsField('Worktree Create Retries', 'set-worktreeCreateRetries', e.worktreeCreateRetries || 1, '', 'Retry count for transient worktree add failures (0-3)') +
      settingsField('Worktree Root', 'set-worktreeRoot', e.worktreeRoot || '../worktrees', '', 'Relative path for git worktrees') +
      settingsField('Idle Alert', 'set-idleAlertMinutes', e.idleAlertMinutes || 15, 'min', 'Alert after agent idle this long') +
      settingsField('Shutdown Timeout', 'set-shutdownTimeout', e.shutdownTimeout || 300000, 'ms', 'Max wait for agents during graceful shutdown') +
      settingsField('Restart Grace Period', 'set-restartGracePeriod', e.restartGracePeriod || 1200000, 'ms', 'Grace period before orphan detection on restart') +
      settingsField('Meeting Round Timeout', 'set-meetingRoundTimeout', e.meetingRoundTimeout || 600000, 'ms', 'Auto-advance meeting round after this') +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">' +
      settingsToggle('Auto-approve Plans', 'set-autoApprovePlans', !!e.autoApprovePlans, 'PRDs are approved automatically without human review') +
      settingsToggle('Auto-decompose', 'set-autoDecompose', e.autoDecompose !== false, 'Large implement items are auto-split into sub-tasks') +
      settingsToggle('Allow Temp Agents', 'set-allowTempAgents', !!e.allowTempAgents, 'Spawn ephemeral agents when all permanent agents are busy') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Claude CLI</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Output Format', 'set-outputFormat', c.outputFormat || 'stream-json', '', '') +
      settingsField('Allowed Tools', 'set-allowedTools', c.allowedTools || '', '', 'Comma-separated (empty = all)') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Agents</h3>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px">' +
      '<tr style="text-align:left;color:var(--muted)"><th style="padding:4px">Agent</th><th style="padding:4px">Role</th><th style="padding:4px">Skills</th></tr>' +
      agentRows +
    '</table>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Routing Table</h3>' +
    '<textarea id="set-routing" rows="12" style="width:100%;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:monospace;font-size:11px;resize:vertical">' + escHtml(data.routing || '') + '</textarea>' +

    '<span id="settings-status" style="font-size:11px;color:var(--muted)"></span>' +
  '</div>';

  document.getElementById('modal-title').textContent = 'Settings';

  // Add save button to modal header actions (next to copy/close)
  const actions = document.querySelector('.modal-header-actions');
  const existingSaveBtn = document.getElementById('modal-settings-save');
  if (!existingSaveBtn) {
    const saveBtn = document.createElement('button');
    saveBtn.id = 'modal-settings-save';
    saveBtn.className = 'modal-copy';
    saveBtn.style.cssText = 'color:var(--green);border-color:var(--green)';
    saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Save';
    saveBtn.onclick = saveSettings;
    // Insert before the close button (last child)
    actions.insertBefore(saveBtn, actions.lastElementChild);
  }
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').style.whiteSpace = '';
  document.getElementById('modal').classList.add('open');
}

function settingsToggle(label, id, checked, hint) {
  return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
    '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + ' style="accent-color:var(--blue);width:16px;height:16px;cursor:pointer">' +
    '<label for="' + id + '" style="font-size:12px;color:var(--text);cursor:pointer">' + escHtml(label) + '</label>' +
    (hint ? '<span style="font-size:9px;color:var(--muted)">' + escHtml(hint) + '</span>' : '') +
  '</div>';
}

function settingsField(label, id, value, unit, hint) {
  return '<div>' +
    '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">' + escHtml(label) + (unit ? ' <span style="opacity:0.6">(' + escHtml(unit) + ')</span>' : '') + '</label>' +
    '<input id="' + id + '" value="' + escHtml(String(value)) + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
    (hint ? '<div style="font-size:9px;color:var(--muted);margin-top:1px">' + escHtml(hint) + '</div>' : '') +
  '</div>';
}

async function saveSettings() {
  const status = document.getElementById('settings-status');
  status.textContent = 'Saving...';
  status.style.color = 'var(--blue)';

  try {
    const enginePayload = {
      tickInterval: document.getElementById('set-tickInterval').value,
      maxConcurrent: document.getElementById('set-maxConcurrent').value,
      inboxConsolidateThreshold: document.getElementById('set-inboxConsolidateThreshold').value,
      agentTimeout: document.getElementById('set-agentTimeout').value,
      maxTurns: document.getElementById('set-maxTurns').value,
      heartbeatTimeout: document.getElementById('set-heartbeatTimeout').value,
      worktreeCreateTimeout: document.getElementById('set-worktreeCreateTimeout').value,
      worktreeCreateRetries: document.getElementById('set-worktreeCreateRetries').value,
      worktreeRoot: document.getElementById('set-worktreeRoot').value,
      idleAlertMinutes: document.getElementById('set-idleAlertMinutes').value,
      shutdownTimeout: document.getElementById('set-shutdownTimeout').value,
      restartGracePeriod: document.getElementById('set-restartGracePeriod').value,
      meetingRoundTimeout: document.getElementById('set-meetingRoundTimeout').value,
      autoApprovePlans: document.getElementById('set-autoApprovePlans').checked,
      autoDecompose: document.getElementById('set-autoDecompose').checked,
      allowTempAgents: document.getElementById('set-allowTempAgents').checked,
    };

    const claudePayload = {
      outputFormat: document.getElementById('set-outputFormat').value,
      allowedTools: document.getElementById('set-allowedTools').value,
    };

    const agentsPayload = {};
    document.querySelectorAll('[data-agent][data-field]').forEach(function(el) {
      const id = el.dataset.agent;
      const field = el.dataset.field;
      if (!agentsPayload[id]) agentsPayload[id] = {};
      agentsPayload[id][field] = el.value;
    });

    // Save config
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: enginePayload, claude: claudePayload, agents: agentsPayload })
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);

    // Save routing separately
    const routing = document.getElementById('set-routing').value;
    const rRes = await fetch('/api/settings/routing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: routing })
    });
    if (!rRes.ok) { const d = await rRes.json(); throw new Error(d.error); }

    status.textContent = 'Saved. Restart engine for full effect.';
    status.style.color = 'var(--green)';
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = 'var(--red)';
  }
}

async function addProject() {
  try {
    const browseRes = await fetch('/api/projects/browse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const browseData = await browseRes.json();
    if (!browseRes.ok) { alert('Error: ' + (browseData.error || 'unknown')); return; }
    if (browseData.cancelled || !browseData.path) return;

    const addRes = await fetch('/api/projects/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: browseData.path })
    });
    const addData = await addRes.json();
    if (!addRes.ok) { alert('Failed: ' + (addData.error || 'unknown')); return; }
    try { showToast('cmd-toast', 'Project "' + addData.name + '" added — restart engine to pick it up', true); } catch { /* expected */ }
    refresh();
  } catch (e) { alert('Error: ' + e.message); }
}

window.MinionsSettings = { openSettings, saveSettings, addProject };
