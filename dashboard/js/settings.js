// settings.js — Settings panel functions extracted from dashboard.html

async function openSettings() {
  document.getElementById('modal-title').textContent = 'Settings';
  document.getElementById('modal-body').innerHTML = '<p style="color:var(--muted)">Loading...</p>';
  document.getElementById('modal').classList.add('open');

  let data;
  try {
    const res = await fetch('/api/settings');
    data = await res.json();
  } catch (e) { showToast('cmd-toast', 'Failed to load settings: ' + e.message, false); return; }

  const e = data.engine || {};
  const c = data.claude || {};
  const agents = data.agents || {};
  const t = data.teams || {};

  const agentRows = Object.entries(agents).map(function([id, a]) {
    return '<tr>' +
      '<td style="font-weight:600">' + escHtml(a.emoji || '') + ' ' + escHtml(a.name || id) + '</td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="role" value="' + escHtml(a.role || '') + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="skills" value="' + escHtml((a.skills || []).join(', ')) + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="monthlyBudgetUsd" value="' + escHtml(a.monthlyBudgetUsd != null ? String(a.monthlyBudgetUsd) : '') + '" placeholder="unlimited" style="width:70px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;text-align:right"></td>' +
    '</tr>';
  }).join('');

  const html = '<div style="padding:8px 0;max-height:70vh;overflow-y:auto">' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Engine</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Tick Interval', 'set-tickInterval', e.tickInterval || 60000, 'ms', 'How often the engine runs discovery + dispatch') +
      settingsField('Max Concurrent Agents', 'set-maxConcurrent', e.maxConcurrent || 5, '', 'Max agents working simultaneously') +
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
      settingsToggle('Eval Loop', 'set-evalLoop', e.evalLoop !== false, 'Auto-review implementations and iterate fix cycles until pass') +
      settingsToggle('Auto-decompose', 'set-autoDecompose', e.autoDecompose !== false, 'Large implement items are auto-split into sub-tasks') +
      settingsToggle('Allow Temp Agents', 'set-allowTempAgents', !!e.allowTempAgents, 'Spawn ephemeral agents when all permanent agents are busy') +
      settingsToggle('Auto-archive Plans', 'set-autoArchive', !!e.autoArchive, 'Automatically archive plans after verify completes (off = manual archive via dashboard)') +
      settingsToggle('Auto-fix Conflicts', 'set-autoFixConflicts', e.autoFixConflicts !== false, 'Auto-dispatch fix agents when a PR has merge conflicts') +
      settingsToggle('ADO Polling', 'set-adoPollEnabled', e.adoPollEnabled !== false, 'Poll ADO PR status and comments each tick (reconciliation always runs)') +
      settingsToggle('GitHub Polling', 'set-ghPollEnabled', e.ghPollEnabled !== false, 'Poll GitHub PR status and comments each tick (reconciliation always runs)') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('ADO Status Poll Frequency', 'set-adoPollStatusEvery', e.adoPollStatusEvery || 6, 'ticks', 'Poll ADO PR build/review/merge status every N ticks (~6 min at default tick rate)') +
      settingsField('ADO Comments Poll Frequency', 'set-adoPollCommentsEvery', e.adoPollCommentsEvery || 12, 'ticks', 'Poll ADO PR human comments every N ticks (~12 min at default tick rate)') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Eval Max Iterations', 'set-evalMaxIterations', e.evalMaxIterations || 3, '', 'Max review→fix cycles before escalating (1-10)') +
      settingsField('Eval Max Cost', 'set-evalMaxCost', e.evalMaxCost === null || e.evalMaxCost === undefined ? '' : e.evalMaxCost, '$', 'USD ceiling per work item across all eval iterations (blank = no limit)') +
      settingsField('Max Build Fix Attempts', 'set-maxBuildFixAttempts', e.maxBuildFixAttempts || 3, '', 'Max auto-fix dispatches per PR before escalating to human (1-10)') +
      settingsField('Agent Busy Reassign', 'set-agentBusyReassignMs', e.agentBusyReassignMs || 600000, 'ms', 'Reassign work to another agent after it waits this long on a busy agent') +
      settingsField('Version Check Interval', 'set-versionCheckInterval', e.versionCheckInterval || 3600000, 'ms', 'How often to check npm for updates (default: 1 hour)') +
      settingsField('Ignored Comment Authors', 'set-ignoredCommentAuthors', (e.ignoredCommentAuthors || []).join(', '), '', 'Comma-separated usernames — comments auto-closed, never trigger fixes') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Projects</h3>' +
    '<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">' +
    (data.projects || []).map(function(p) {
      return '<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">' +
        '<div style="font-size:12px;font-weight:600;margin-bottom:8px">' + escHtml(p.name) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
        settingsToggle('Discover from PRs', 'set-ws-prs-' + p.name, p.workSources.pullRequests.enabled, 'Auto-discover work from open pull requests') +
        settingsToggle('Discover from Work Items', 'set-ws-wi-' + p.name, p.workSources.workItems.enabled, 'Auto-discover work from ADO/GitHub work items') +
        '</div></div>';
    }).join('') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Max Turns by Task Type</h3>' +
    '<div style="font-size:10px;color:var(--muted);margin-bottom:6px">How many tool-use turns each task type gets before forced stop. Blank = built-in default.</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Explore', 'set-mt-explore', (e.maxTurnsByType || {}).explore || '', '', 'Default: 30') +
      settingsField('Ask', 'set-mt-ask', (e.maxTurnsByType || {}).ask || '', '', 'Default: 20') +
      settingsField('Review', 'set-mt-review', (e.maxTurnsByType || {}).review || '', '', 'Default: 30') +
      settingsField('Implement', 'set-mt-implement', (e.maxTurnsByType || {}).implement || '', '', 'Default: 75') +
      settingsField('Fix', 'set-mt-fix', (e.maxTurnsByType || {}).fix || '', '', 'Default: 75') +
      settingsField('Test', 'set-mt-test', (e.maxTurnsByType || {}).test || '', '', 'Default: 50') +
      settingsField('Verify', 'set-mt-verify', (e.maxTurnsByType || {}).verify || '', '', 'Default: 100') +
      settingsField('Plan', 'set-mt-plan', (e.maxTurnsByType || {}).plan || '', '', 'Default: 30') +
      settingsField('Decompose', 'set-mt-decompose', (e.maxTurnsByType || {}).decompose || '', '', 'Default: 15') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Command Center / Doc Chat</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      '<div>' +
        '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Model</label>' +
        '<select id="set-ccModel" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
          '<option value="sonnet"' + ((e.ccModel || 'sonnet') === 'sonnet' ? ' selected' : '') + '>Sonnet (default)</option>' +
          '<option value="haiku"' + (e.ccModel === 'haiku' ? ' selected' : '') + '>Haiku (faster, cheaper)</option>' +
          '<option value="opus"' + (e.ccModel === 'opus' ? ' selected' : '') + '>Opus (most capable)</option>' +
        '</select>' +
        '<div style="font-size:9px;color:var(--muted);margin-top:1px">Model used for CC and doc-chat conversations</div>' +
      '</div>' +
      '<div>' +
        '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Effort Level</label>' +
        '<select id="set-ccEffort" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
          '<option value=""' + (!e.ccEffort ? ' selected' : '') + '>Default</option>' +
          '<option value="low"' + (e.ccEffort === 'low' ? ' selected' : '') + '>Low (quick responses)</option>' +
          '<option value="medium"' + (e.ccEffort === 'medium' ? ' selected' : '') + '>Medium</option>' +
          '<option value="high"' + (e.ccEffort === 'high' ? ' selected' : '') + '>High (thorough)</option>' +
        '</select>' +
        '<div style="font-size:9px;color:var(--muted);margin-top:1px">Controls response depth and reasoning effort</div>' +
      '</div>' +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Teams Integration</h3>' +
    '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">' +
      settingsToggle('Enable Teams', 'set-teams-enabled', !!t.enabled, 'Connect Minions to Microsoft Teams') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
      settingsField('App ID', 'set-teams-appId', t.appId || '', '', 'Microsoft App ID from Azure Bot Configuration') +
      settingsField('App Password', 'set-teams-appPassword', t.appPassword || '', '', 'Client secret (leave blank for certificate auth)') +
    '</div>' +
    '<div style="font-size:10px;color:var(--muted);margin-bottom:4px;font-weight:600">Certificate Auth (alternative to client secret)</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
      settingsField('Certificate Path', 'set-teams-certPath', t.certPath || '', '', 'Path to PEM certificate file') +
      settingsField('Private Key Path', 'set-teams-privateKeyPath', t.privateKeyPath || '', '', 'Path to PEM private key file') +
      settingsField('Tenant ID', 'set-teams-tenantId', t.tenantId || '', '', 'Azure AD tenant ID (required for cert auth)') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Notify Events', 'set-teams-notifyEvents', (t.notifyEvents || []).join(', '), '', 'Comma-separated event types to notify') +
      settingsField('Inbox Poll Interval', 'set-teams-inboxPollInterval', t.inboxPollInterval || 15000, 'ms', 'How often to check for Teams messages') +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">' +
      settingsToggle('CC Mirror', 'set-teams-ccMirror', t.ccMirror !== false, 'Mirror Command Center responses to Teams') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Claude CLI</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">' +
      settingsField('Output Format', 'set-outputFormat', c.outputFormat || 'stream-json', '', '') +
      settingsField('Allowed Tools', 'set-allowedTools', c.allowedTools || '', '', 'Tools agents can use without permission prompts. Add MCP tools here if using non-bypass mode (e.g. mcp__azure-ado__*)') +
    '</div>' +
    '<div style="margin-bottom:16px">' +
      '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Permission Mode <span style="opacity:0.6">(how agents handle tool approvals)</span></label>' +
      '<select id="set-permissionMode" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
        '<option value="bypassPermissions"' + ((c.permissionMode || 'bypassPermissions') === 'bypassPermissions' ? ' selected' : '') + '>Bypass (recommended) — agents run autonomously without permission prompts</option>' +
        '<option value="auto"' + ((c.permissionMode) === 'auto' ? ' selected' : '') + '>Auto — auto-approve safe tools, prompt for risky ones (agents may hang on risky tools)</option>' +
        '<option value="default"' + ((c.permissionMode) === 'default' ? ' selected' : '') + '>Default — prompt for every tool (agents WILL hang — not recommended)</option>' +
      '</select>' +
      '<div id="set-permissionMode-warn" style="font-size:9px;margin-top:4px;padding:4px 8px;border-radius:4px;' + ((c.permissionMode && c.permissionMode !== 'bypassPermissions') ? 'display:block;background:rgba(248,81,73,0.1);color:var(--red)' : 'display:none') + '">' +
        '\u26A0 Tools listed in Allowed Tools above are auto-approved even in non-bypass modes. Agents will only hang if they try to use a tool NOT on that list (e.g. MCP tools). In bypass mode, all tools are approved automatically.' +
      '</div>' +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Agents</h3>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px">' +
      '<tr style="text-align:left;color:var(--muted)"><th style="padding:4px">Agent</th><th style="padding:4px">Role</th><th style="padding:4px">Skills</th><th style="padding:4px">Budget $/mo</th></tr>' +
      agentRows +
    '</table>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Routing Table</h3>' +
    '<textarea id="set-routing" rows="12" style="width:100%;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:monospace;font-size:11px;resize:vertical">' + escHtml(data.routing || '') + '</textarea>' +

  '</div>';

  document.getElementById('modal-title').textContent = 'Settings';

  // Add save button to modal header actions (next to copy/close)
  const actions = document.querySelector('.modal-header-actions');
  if (!actions) return;
  if (!document.getElementById('modal-settings-reset')) {
    const resetBtn = document.createElement('button');
    resetBtn.id = 'modal-settings-reset';
    resetBtn.className = 'modal-copy';
    resetBtn.style.cssText = 'color:var(--red);border-color:var(--red)';
    resetBtn.textContent = 'Reset';
    resetBtn.onclick = resetSettingsToDefaults;
    actions.insertBefore(resetBtn, actions.lastElementChild);
  }
  if (!document.getElementById('modal-settings-save')) {
    const saveBtn = document.createElement('button');
    saveBtn.id = 'modal-settings-save';
    saveBtn.className = 'modal-copy';
    saveBtn.style.cssText = 'color:var(--green);border-color:var(--green)';
    saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Save';
    saveBtn.onclick = saveSettings;
    actions.insertBefore(saveBtn, actions.lastElementChild);
  }
  document.getElementById('modal-body').innerHTML = '<div id="settings-status" style="font-size:11px;min-height:16px;margin-bottom:4px"></div>' + html;
  document.getElementById('modal-body').style.fontFamily = '';
  document.getElementById('modal-body').style.whiteSpace = '';
  document.getElementById('modal').classList.add('open');

  // Wire permission mode warning toggle
  var pmSelect = document.getElementById('set-permissionMode');
  if (pmSelect) pmSelect.addEventListener('change', function() {
    var warn = document.getElementById('set-permissionMode-warn');
    if (!warn) return;
    if (this.value !== 'bypassPermissions') {
      warn.style.display = 'block';
      warn.style.background = 'rgba(248,81,73,0.1)';
      warn.style.color = 'var(--red)';
    } else {
      warn.style.display = 'none';
    }
  });
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
  const saveBtn = document.getElementById('modal-settings-save');
  status.textContent = 'Saving...';
  status.style.color = 'var(--blue)';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.6'; saveBtn.innerHTML = 'Saving...'; }

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
      evalLoop: document.getElementById('set-evalLoop').checked,
      autoDecompose: document.getElementById('set-autoDecompose').checked,
      allowTempAgents: document.getElementById('set-allowTempAgents').checked,
      autoArchive: document.getElementById('set-autoArchive').checked,
      autoFixConflicts: document.getElementById('set-autoFixConflicts').checked,
      adoPollEnabled: document.getElementById('set-adoPollEnabled').checked,
      ghPollEnabled: document.getElementById('set-ghPollEnabled').checked,
      adoPollStatusEvery: document.getElementById('set-adoPollStatusEvery').value,
      adoPollCommentsEvery: document.getElementById('set-adoPollCommentsEvery').value,
      evalMaxIterations: document.getElementById('set-evalMaxIterations').value,
      evalMaxCost: document.getElementById('set-evalMaxCost').value || null,
      maxBuildFixAttempts: document.getElementById('set-maxBuildFixAttempts').value,
      agentBusyReassignMs: document.getElementById('set-agentBusyReassignMs').value,
      ignoredCommentAuthors: document.getElementById('set-ignoredCommentAuthors').value,
      versionCheckInterval: document.getElementById('set-versionCheckInterval').value,
      ccModel: document.getElementById('set-ccModel').value,
      ccEffort: document.getElementById('set-ccEffort').value || null,
      maxTurnsByType: (function() {
        var mbt = {};
        var types = ['explore', 'ask', 'review', 'implement', 'fix', 'test', 'verify', 'plan', 'decompose'];
        for (var i = 0; i < types.length; i++) {
          var v = document.getElementById('set-mt-' + types[i])?.value?.trim();
          if (v) mbt[types[i]] = Number(v);
        }
        return mbt;
      })(),
    };

    const claudePayload = {
      outputFormat: document.getElementById('set-outputFormat').value,
      allowedTools: document.getElementById('set-allowedTools').value,
      permissionMode: document.getElementById('set-permissionMode').value,
    };

    const teamsPayload = {
      enabled: document.getElementById('set-teams-enabled').checked,
      appId: document.getElementById('set-teams-appId').value,
      appPassword: document.getElementById('set-teams-appPassword').value,
      certPath: document.getElementById('set-teams-certPath').value,
      privateKeyPath: document.getElementById('set-teams-privateKeyPath').value,
      tenantId: document.getElementById('set-teams-tenantId').value,
      notifyEvents: document.getElementById('set-teams-notifyEvents').value,
      inboxPollInterval: document.getElementById('set-teams-inboxPollInterval').value,
      ccMirror: document.getElementById('set-teams-ccMirror').checked,
    };

    const agentsPayload = {};
    document.querySelectorAll('[data-agent][data-field]').forEach(function(el) {
      const id = el.dataset.agent;
      const field = el.dataset.field;
      if (!agentsPayload[id]) agentsPayload[id] = {};
      agentsPayload[id][field] = el.value;
    });

    const projectsPayload = (data.projects || []).map(function(p) {
      return {
        name: p.name,
        workSources: {
          pullRequests: { enabled: document.getElementById('set-ws-prs-' + p.name)?.checked ?? true },
          workItems: { enabled: document.getElementById('set-ws-wi-' + p.name)?.checked ?? true }
        }
      };
    });

    // Save config
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: enginePayload, claude: claudePayload, agents: agentsPayload, teams: teamsPayload, projects: projectsPayload })
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

    if (result.clamped && result.clamped.length > 0) {
      status.textContent = 'Saved — some values adjusted: ' + result.clamped.join(', ');
      status.style.color = 'var(--yellow)';
      showToast('cmd-toast', 'Settings saved (some values clamped to allowed range)', false);
    } else {
      status.textContent = 'Saved. Engine picks up changes on next tick.';
      status.style.color = 'var(--green)';
      showToast('cmd-toast', 'Settings saved', true);
    }
    if (saveBtn) { saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Saved'; saveBtn.style.color = 'var(--green)'; saveBtn.style.borderColor = 'var(--green)'; }
    setTimeout(function() {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Save'; }
    }, 2000);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = 'var(--red)';
    if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; saveBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Save'; }
    showToast('cmd-toast', 'Settings save failed: ' + e.message, false);
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

async function resetSettingsToDefaults() {
  if (!confirm('Reset all engine, CLI, and agent settings to defaults? This cannot be undone.')) return;
  const status = document.getElementById('settings-status');
  try {
    status.textContent = 'Resetting...';
    status.style.color = 'var(--blue)';
    const res = await fetch('/api/settings/reset', { method: 'POST' });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Reset failed'); }
    status.textContent = 'Reset complete. Reloading...';
    status.style.color = 'var(--green)';
    showToast('cmd-toast', 'Settings reset to defaults', true);
    setTimeout(() => openSettings(), 500);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    status.style.color = 'var(--red)';
  }
}

window.MinionsSettings = { openSettings, saveSettings, addProject, resetSettingsToDefaults };
