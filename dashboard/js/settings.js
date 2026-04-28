// settings.js — Settings panel functions extracted from dashboard.html

let _settingsData = null;

async function openSettings() {
  document.getElementById('modal-title').textContent = 'Settings';
  document.getElementById('modal-body').innerHTML = '<p style="color:var(--muted)">Loading...</p>';
  document.getElementById('modal').classList.add('open');

  _settingsData = null;
  let data;
  try {
    const res = await fetch('/api/settings');
    data = await res.json();
    _settingsData = data;
  } catch (e) { showToast('cmd-toast', 'Failed to load settings: ' + e.message, false); return; }

  const e = data.engine || {};
  const c = data.claude || {};
  const agents = data.agents || {};
  const t = data.teams || {};

  // Per-agent override placeholders surface the inherited fleet defaults as
  // muted text — operators see exactly what each agent will resolve to without
  // chasing config files. Empty input clears the override → re-inherit fleet.
  const fleetCliLabel = e.defaultCli || 'claude';
  const fleetModelLabel = e.defaultModel ? String(e.defaultModel) : 'CLI default';
  const agentRows = Object.entries(agents).map(function([id, a]) {
    return '<tr>' +
      '<td style="font-weight:600">' + escHtml(a.emoji || '') + ' ' + escHtml(a.name || id) + '</td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="role" value="' + escHtml(a.role || '') + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
      '<td><input data-agent="' + escHtml(id) + '" data-field="skills" value="' + escHtml((a.skills || []).join(', ')) + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px"></td>' +
      '<td data-runtime-cli="' + escHtml(id) + '" style="min-width:110px">' +
        // Initial loading placeholder — initRuntimeFleetUI() replaces this with a
        // <select> populated from /api/runtimes once the registry resolves.
        '<input value="' + escHtml(a.cli || '') + '" placeholder="' + escHtml(fleetCliLabel) + ' (fleet)" disabled style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:11px">' +
      '</td>' +
      '<td data-runtime-model="' + escHtml(id) + '" style="min-width:140px">' +
        // Loading placeholder — initRuntimeFleetUI() replaces this with a
        // <select> populated from /api/runtimes/<resolved-cli>/models.
        '<input value="' + escHtml(a.model || '') + '" placeholder="' + escHtml(fleetModelLabel) + ' (fleet)" disabled style="width:120px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:11px">' +
      '</td>' +
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
      settingsField('Meeting Round Timeout', 'set-meetingRoundTimeout', e.meetingRoundTimeout || 900000, 'ms', 'Auto-advance meeting round after this') +
    '</div>' +
    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Automation</h3>' +
    '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">' +
      settingsToggle('Auto-approve Plans', 'set-autoApprovePlans', !!e.autoApprovePlans, 'PRDs are approved automatically without human review') +
      settingsToggle('Eval Loop', 'set-evalLoop', e.evalLoop !== false, 'Auto-review implementations and iterate fix cycles until pass') +
      settingsToggle('Auto-decompose', 'set-autoDecompose', e.autoDecompose !== false, 'Large implement items are auto-split into sub-tasks') +
      settingsToggle('Allow Temp Agents', 'set-allowTempAgents', !!e.allowTempAgents, 'Spawn ephemeral agents when all permanent agents are busy') +
      settingsToggle('Auto-archive Plans', 'set-autoArchive', !!e.autoArchive, 'Automatically archive plans after verify completes (off = manual archive via dashboard)') +
      settingsToggle('Auto-complete PRs', 'set-autoCompletePrs', !!e.autoCompletePrs, 'Auto-merge PRs when builds pass and review is approved (opt-in)') +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">PR Polling &amp; Dispatch Gates</h3>' +
    '<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:16px">' +
      '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">' +
        settingsToggle('ADO Polling', 'set-adoPollEnabled', e.adoPollEnabled !== false, 'Keeps ADO PR build results, votes, and comments fresh each tick — the two fix gates below are silently inert when this is off') +
        '<div style="margin-left:20px;padding-left:10px;border-left:2px solid var(--border);display:flex;flex-direction:column;gap:4px">' +
          settingsToggle('Auto-fix Builds', 'set-autoFixBuilds', e.autoFixBuilds !== false, 'Dispatch gate: auto-fix agent when build fails (downstream of ADO Polling)') +
          settingsToggle('Auto-fix Conflicts', 'set-autoFixConflicts', e.autoFixConflicts !== false, 'Dispatch gate: auto-fix agent when merge conflict detected (downstream of ADO Polling)') +
        '</div>' +
      '</div>' +
      settingsToggle('GitHub Polling', 'set-ghPollEnabled', e.ghPollEnabled !== false, 'Keeps GitHub PR build results, votes, and comments fresh each tick (reconciliation always runs regardless)') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">' +
        settingsField('PR Status Poll Frequency', 'set-prPollStatusEvery', e.prPollStatusEvery ?? e.adoPollStatusEvery ?? 12, 'ticks', 'Poll PR build/review/merge status every N ticks for both ADO and GitHub (~12 min at default tick rate)') +
        settingsField('PR Comments Poll Frequency', 'set-prPollCommentsEvery', e.prPollCommentsEvery ?? e.adoPollCommentsEvery ?? 12, 'ticks', 'Poll PR human comments every N ticks for both ADO and GitHub (~12 min at default tick rate)') +
      '</div>' +
    '</div>' +

    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Limits &amp; Thresholds</h3>' +
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
      return '<div data-settings-project="' + escHtml(p.name) + '" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' +
          '<div style="font-size:12px;font-weight:600">' + escHtml(p.name) + '</div>' +
          '<button onclick="MinionsSettings.removeProject(\'' + escHtml(p.name) + '\')" style="font-size:9px;padding:2px 8px;background:transparent;color:var(--red);border:1px solid var(--red);border-radius:3px;cursor:pointer">Remove</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
        settingsToggle('Discover from PRs', 'set-ws-prs-' + p.name, p.workSources.pullRequests.enabled, 'Discovery gate: scan repo for open PRs and surface them as review tasks. Independent of ADO/GitHub polling — does not affect already-tracked PRs.') +
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

    // ── Runtime (P-7a5c1f8e) — unified fleet runtime + CC overrides + advanced ──
    '<h3 style="font-size:13px;color:var(--blue);margin-bottom:8px">Runtime</h3>' +
    '<div id="set-runtime-section" style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:16px">' +
      '<div style="font-size:10px;color:var(--muted);margin-bottom:8px">Single source of truth for which CLI runtime + model the fleet spawns. Per-agent overrides live in the Agents table below.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;margin-bottom:8px">' +
        '<div>' +
          '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Default CLI</label>' +
          '<select id="set-defaultCli" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
            '<option value="">Loading…</option>' +
          '</select>' +
          '<div style="font-size:9px;color:var(--muted);margin-top:1px">Fleet-wide runtime — registered adapters from <code>/api/runtimes</code></div>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Default Model</label>' +
          '<div id="set-defaultModel-wrap"><input id="set-defaultModel" value="' + escHtml(e.defaultModel || '') + '" placeholder="Default (CLI chooses)" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px"></div>' +
          '<div style="font-size:9px;color:var(--muted);margin-top:1px">Empty = let the runtime pick its own default</div>' +
        '</div>' +
      '</div>' +
      // CC overrides — collapsed by default
      '<details id="set-cc-overrides-details"' + ((e.ccCli || e.ccModel) ? ' open' : '') + ' style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
        '<summary style="cursor:pointer;font-size:11px;color:var(--text);user-select:none">Customize CC separately ' +
          '<span style="font-size:9px;color:var(--muted)">(Command Center + doc-chat use the fleet defaults unless overridden)</span>' +
        '</summary>' +
        '<div style="display:grid;grid-template-columns:1fr 2fr 1fr;gap:8px;margin-top:8px">' +
          '<div>' +
            '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">CC CLI</label>' +
            '<select id="set-ccCli" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
              '<option value="">Loading…</option>' +
            '</select>' +
            '<div style="font-size:9px;color:var(--muted);margin-top:1px">Empty = inherit Default CLI</div>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">CC Model</label>' +
            '<input id="set-ccModel" value="' + escHtml(e.ccModel || '') + '" placeholder="(inherits Default Model)" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
            '<div style="font-size:9px;color:var(--muted);margin-top:1px">Empty = inherit Default Model</div>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Effort</label>' +
            '<select id="set-ccEffort" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
              '<option value=""' + (!e.ccEffort ? ' selected' : '') + '>Default</option>' +
              '<option value="low"' + (e.ccEffort === 'low' ? ' selected' : '') + '>Low</option>' +
              '<option value="medium"' + (e.ccEffort === 'medium' ? ' selected' : '') + '>Medium</option>' +
              '<option value="high"' + (e.ccEffort === 'high' ? ' selected' : '') + '>High</option>' +
            '</select>' +
            '<div style="font-size:9px;color:var(--muted);margin-top:1px">CC reasoning depth</div>' +
          '</div>' +
        '</div>' +
      '</details>' +
      // Advanced runtime settings — collapsed by default
      '<details id="set-runtime-advanced-details" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">' +
        '<summary style="cursor:pointer;font-size:11px;color:var(--text);user-select:none">Advanced runtime settings ' +
          '<span style="font-size:9px;color:var(--muted)">(per-runtime feature flags)</span>' +
        '</summary>' +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">' +
          settingsToggle('Claude bare mode', 'set-claudeBareMode', !!e.claudeBareMode, '--bare suppresses CLAUDE.md auto-discovery; pair with explicit ccSystemPrompt or context will be lost') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
          settingsField('Claude fallback model', 'set-claudeFallbackModel', e.claudeFallbackModel || '', '', 'Used by --fallback-model on rate-limit / overload (Claude only)') +
          settingsField('Max budget (USD)', 'set-maxBudgetUsd', e.maxBudgetUsd != null ? String(e.maxBudgetUsd) : '', '', 'Fleet ceiling for --max-budget-usd. 0 is a valid cap (read-only / dry-run). Empty = no cap. Claude only.') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">' +
          // Tooltip on copilotDisableBuiltinMcps MUST warn about the split-brain risk
          settingsToggle('Copilot: disable built-in MCPs', 'set-copilotDisableBuiltinMcps', e.copilotDisableBuiltinMcps !== false,
            '⚠ When OFF, Copilot agents can autonomously create PRs/labels/comments via the github-mcp-server, bypassing pull-requests.json tracking — Minions and Copilot end up with split views of the same PR. Keep ON unless you understand the risk.') +
          settingsToggle('Copilot: suppress AGENTS.md', 'set-copilotSuppressAgentsMd', e.copilotSuppressAgentsMd !== false, '--no-custom-instructions: stops AGENTS.md auto-load from fighting Minions playbook prompts') +
          settingsToggle('Copilot: reasoning summaries', 'set-copilotReasoningSummaries', !!e.copilotReasoningSummaries, '--enable-reasoning-summaries (Anthropic-family models only)') +
          settingsToggle('Disable model discovery', 'set-disableModelDiscovery', !!e.disableModelDiscovery, 'Skip /api/runtimes/<name>/models REST calls fleet-wide. Settings UI falls back to free-text.') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 3fr;gap:8px;margin-top:8px">' +
          '<div>' +
            '<label style="font-size:10px;color:var(--muted);display:block;margin-bottom:2px">Copilot stream</label>' +
            '<select id="set-copilotStreamMode" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' +
              '<option value="on"' + ((e.copilotStreamMode || 'on') === 'on' ? ' selected' : '') + '>on (incremental)</option>' +
              '<option value="off"' + (e.copilotStreamMode === 'off' ? ' selected' : '') + '>off (batched)</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
      '</details>' +
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
    '<div style="font-size:10px;color:var(--muted);margin-bottom:6px">CLI / Model placeholders show the fleet default each agent will inherit. Pick a value to pin per-agent; clear to re-inherit.</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px">' +
      '<tr style="text-align:left;color:var(--muted)"><th style="padding:4px">Agent</th><th style="padding:4px">Role</th><th style="padding:4px">Skills</th><th style="padding:4px">CLI</th><th style="padding:4px">Model</th><th style="padding:4px">Budget $/mo</th></tr>' +
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

  // ── Runtime fleet wiring (P-7a5c1f8e) ──────────────────────────────────────
  // 1. Load registered runtimes into the defaultCli + ccCli dropdowns.
  // 2. Load models for the selected defaultCli into the defaultModel input.
  // 3. On defaultCli change → re-fetch models so the input never shows stale list.
  // The same pattern wires ccCli → ccModel; ccCli inherits defaultCli when unset.
  initRuntimeFleetUI(e, agents);
}

async function initRuntimeFleetUI(engineCfg, agentsCfg) {
  const cliSelect = document.getElementById('set-defaultCli');
  const ccCliSelect = document.getElementById('set-ccCli');
  if (!cliSelect || !ccCliSelect) return;

  // Fetch the registry; render an empty fallback on failure so the rest of the
  // settings panel still works.
  let runtimes = [];
  try {
    const r = await fetch('/api/runtimes');
    const d = await r.json();
    runtimes = Array.isArray(d.runtimes) ? d.runtimes : [];
  } catch { /* ignore — we'll surface a free-text-only path below */ }

  // Always include 'claude' as a fallback option even if /api/runtimes is empty;
  // legacy installs without the registry endpoint should still see something pickable.
  const names = runtimes.length ? runtimes.map(rt => rt.name) : ['claude'];
  const currentDefault = engineCfg.defaultCli || 'claude';
  const currentCc = engineCfg.ccCli || '';
  cliSelect.innerHTML = names.map(n =>
    '<option value="' + escHtml(n) + '"' + (n === currentDefault ? ' selected' : '') + '>' + escHtml(n) + '</option>'
  ).join('');
  ccCliSelect.innerHTML =
    '<option value=""' + (!currentCc ? ' selected' : '') + '>Inherit Default CLI</option>' +
    names.map(n =>
      '<option value="' + escHtml(n) + '"' + (n === currentCc ? ' selected' : '') + '>' + escHtml(n) + '</option>'
    ).join('');

  // Hydrate per-agent CLI dropdowns now that we know the registered names. The
  // Agents table renders cells with `data-runtime-cli="<id>"` as a hook.
  const cliCells = document.querySelectorAll('[data-runtime-cli]');
  for (const cell of cliCells) {
    const agentId = cell.getAttribute('data-runtime-cli');
    const agent = (agentsCfg || {})[agentId] || {};
    const current = agent.cli || '';
    cell.innerHTML =
      '<select data-agent="' + escHtml(agentId) + '" data-field="cli" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px">' +
        '<option value=""' + (!current ? ' selected' : '') + '>(fleet default)</option>' +
        names.map(n =>
          '<option value="' + escHtml(n) + '"' + (n === current ? ' selected' : '') + '>' + escHtml(n) + '</option>'
        ).join('') +
      '</select>';
  }
  // Hydrate per-agent model dropdowns. The model list is keyed off the
  // agent's RESOLVED runtime: per-agent override → fleet default. Without
  // this the input was free-text and a user could (and did) save an agent
  // with cli=claude + model=<some gpt> — invalid combination that crashed
  // dispatch. Refreshing on CLI change clears stale model values.
  const fleetDefaultCli = engineCfg.defaultCli || 'claude';
  for (const cell of cliCells) {
    const agentId = cell.getAttribute('data-runtime-cli');
    const agent = (agentsCfg || {})[agentId] || {};
    const resolvedCli = agent.cli || fleetDefaultCli;
    loadModelsForAgent(agentId, resolvedCli, agent.model || '');
    // CLI dropdown change → refresh that agent's model dropdown to match.
    const sel = cell.querySelector('select[data-field="cli"]');
    if (sel) {
      sel.addEventListener('change', () => {
        const newCli = sel.value || fleetDefaultCli;
        loadModelsForAgent(agentId, newCli, ''); // clear value: previous model may not exist for the new runtime
      });
    }
  }

  // Models load for the resolved default + CC CLIs. ccCli falls back to
  // defaultCli when unset — same rule as resolveCcCli().
  loadModelsForRuntime(cliSelect.value, 'set-defaultModel', engineCfg.defaultModel || '');
  loadModelsForRuntime(currentCc || cliSelect.value, 'set-ccModel', engineCfg.ccModel || '');

  // CLI change → re-fetch models. NEVER carry the previous runtime's list over.
  cliSelect.addEventListener('change', () => {
    loadModelsForRuntime(cliSelect.value, 'set-defaultModel', '');
    if (!ccCliSelect.value) {
      // CC inherits defaultCli — its model list must follow.
      loadModelsForRuntime(cliSelect.value, 'set-ccModel', '');
    }
  });
  ccCliSelect.addEventListener('change', () => {
    const target = ccCliSelect.value || cliSelect.value;
    loadModelsForRuntime(target, 'set-ccModel', '');
  });
}

/**
 * Replace the input/select at `inputId` with a dropdown when the runtime
 * exposes a model list, or a free-text input when `{ models: null }` (e.g.
 * Claude or model-discovery disabled). The "Default (CLI chooses)" option is
 * always present and submits empty string.
 */
async function loadModelsForRuntime(runtimeName, inputId, currentValue) {
  const wrap = document.getElementById(inputId)?.parentElement;
  if (!wrap) return;
  if (!runtimeName) {
    wrap.innerHTML = '<input id="' + inputId + '" value="' + escHtml(currentValue || '') + '" placeholder="(no runtime selected)" disabled style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:12px">';
    return;
  }
  let payload = { models: null };
  try {
    const res = await fetch('/api/runtimes/' + encodeURIComponent(runtimeName) + '/models');
    if (res.ok) payload = await res.json();
  } catch { /* fall through to free-text */ }

  const models = Array.isArray(payload.models) ? payload.models : null;
  if (!models || models.length === 0) {
    // Free-text fallback — let the user type anything (custom Anthropic /
    // OpenAI model IDs, future models, etc.).
    wrap.innerHTML = '<input id="' + inputId + '" value="' + escHtml(currentValue || '') + '" placeholder="Default (CLI chooses)" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">';
    return;
  }
  // Dropdown. The first option submits empty string → "Default (CLI chooses)".
  let opts = '<option value=""' + (!currentValue ? ' selected' : '') + '>Default (CLI chooses)</option>';
  for (const m of models) {
    const id = m.id || m.name || '';
    if (!id) continue;
    const label = m.name && m.name !== id ? (id + ' — ' + m.name) : id;
    opts += '<option value="' + escHtml(id) + '"' + (id === currentValue ? ' selected' : '') + '>' + escHtml(label) + '</option>';
  }
  // If the current value isn't in the model list (custom / older choice),
  // surface it as a selectable option so the user doesn't lose it on next save.
  if (currentValue && !models.some(m => (m.id || m.name) === currentValue)) {
    opts += '<option value="' + escHtml(currentValue) + '" selected>' + escHtml(currentValue) + ' (custom)</option>';
  }
  wrap.innerHTML = '<select id="' + inputId + '" style="width:100%;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">' + opts + '</select>';
}

/**
 * Per-agent model hydrator. Replaces the placeholder input in the cell
 * `[data-runtime-model="<agentId>"]` with a <select> of valid models for the
 * given runtime. Output element keeps `data-agent` + `data-field="model"` so
 * the existing save flow picks it up unchanged. Free-text input fallback
 * when the runtime returns no model list (Claude / discovery disabled).
 */
async function loadModelsForAgent(agentId, runtimeName, currentValue) {
  const cell = document.querySelector('[data-runtime-model="' + agentId + '"]');
  if (!cell) return;
  const baseAttrs = 'data-agent="' + escHtml(agentId) + '" data-field="model"';
  const baseStyle = 'width:120px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px';
  if (!runtimeName) {
    cell.innerHTML = '<input ' + baseAttrs + ' value="' + escHtml(currentValue || '') + '" placeholder="(no runtime)" disabled style="' + baseStyle + ';color:var(--muted)">';
    return;
  }
  let payload = { models: null };
  try {
    const res = await fetch('/api/runtimes/' + encodeURIComponent(runtimeName) + '/models');
    if (res.ok) payload = await res.json();
  } catch { /* fall through to free-text */ }

  const models = Array.isArray(payload.models) ? payload.models : null;
  if (!models || models.length === 0) {
    cell.innerHTML = '<input ' + baseAttrs + ' value="' + escHtml(currentValue || '') + '" placeholder="' + escHtml(runtimeName) + ' default" style="' + baseStyle + '">';
    return;
  }
  let opts = '<option value=""' + (!currentValue ? ' selected' : '') + '>(fleet/default)</option>';
  for (const m of models) {
    const id = m.id || m.name || '';
    if (!id) continue;
    const label = m.name && m.name !== id ? (id + ' — ' + m.name) : id;
    opts += '<option value="' + escHtml(id) + '"' + (id === currentValue ? ' selected' : '') + '>' + escHtml(label) + '</option>';
  }
  // Preserve unknown saved values so a user-set custom ID survives the next save.
  if (currentValue && !models.some(m => (m.id || m.name) === currentValue)) {
    opts += '<option value="' + escHtml(currentValue) + '" selected>' + escHtml(currentValue) + ' (custom — invalid for ' + escHtml(runtimeName) + '?)</option>';
  }
  cell.innerHTML = '<select ' + baseAttrs + ' style="' + baseStyle + '">' + opts + '</select>';
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
      autoFixBuilds: document.getElementById('set-autoFixBuilds').checked,
      autoFixConflicts: document.getElementById('set-autoFixConflicts').checked,
      autoCompletePrs: document.getElementById('set-autoCompletePrs').checked,
      adoPollEnabled: document.getElementById('set-adoPollEnabled').checked,
      ghPollEnabled: document.getElementById('set-ghPollEnabled').checked,
      prPollStatusEvery: document.getElementById('set-prPollStatusEvery').value,
      prPollCommentsEvery: document.getElementById('set-prPollCommentsEvery').value,
      evalMaxIterations: document.getElementById('set-evalMaxIterations').value,
      evalMaxCost: document.getElementById('set-evalMaxCost').value || null,
      maxBuildFixAttempts: document.getElementById('set-maxBuildFixAttempts').value,
      agentBusyReassignMs: document.getElementById('set-agentBusyReassignMs').value,
      ignoredCommentAuthors: document.getElementById('set-ignoredCommentAuthors').value,
      versionCheckInterval: document.getElementById('set-versionCheckInterval').value,
      // Runtime fleet (P-7a5c1f8e). Empty strings are intentional — they signal
      // "clear this override". The server deletes the key from config.engine.
      defaultCli: (document.getElementById('set-defaultCli')?.value ?? '').trim(),
      defaultModel: (document.getElementById('set-defaultModel')?.value ?? '').trim(),
      ccCli: (document.getElementById('set-ccCli')?.value ?? '').trim(),
      ccModel: (document.getElementById('set-ccModel')?.value ?? '').trim(),
      ccEffort: document.getElementById('set-ccEffort').value || null,
      claudeBareMode: !!document.getElementById('set-claudeBareMode')?.checked,
      claudeFallbackModel: (document.getElementById('set-claudeFallbackModel')?.value ?? '').trim(),
      copilotDisableBuiltinMcps: !!document.getElementById('set-copilotDisableBuiltinMcps')?.checked,
      copilotSuppressAgentsMd: !!document.getElementById('set-copilotSuppressAgentsMd')?.checked,
      copilotStreamMode: document.getElementById('set-copilotStreamMode')?.value || 'on',
      copilotReasoningSummaries: !!document.getElementById('set-copilotReasoningSummaries')?.checked,
      maxBudgetUsd: (document.getElementById('set-maxBudgetUsd')?.value ?? '').trim(),
      disableModelDiscovery: !!document.getElementById('set-disableModelDiscovery')?.checked,
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

    const currentProjects = (_settingsData && Array.isArray(_settingsData.projects)) ? _settingsData.projects : [];
    const projectsPayload = currentProjects.map(function(p) {
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
    const addedProject = {
      name: addData.name,
      description: (addData.detected && addData.detected.description) || '',
      path: addData.path,
      localPath: addData.path,
    };
    if (_settingsData && Array.isArray(_settingsData.projects)) {
      const exists = _settingsData.projects.some(function(p) {
        return p.name === addedProject.name || String(p.localPath || p.path || '').replace(/\\/g, '/') === String(addedProject.localPath || '').replace(/\\/g, '/');
      });
      if (!exists) _settingsData.projects = _settingsData.projects.concat([addedProject]);
    }
    if (typeof optimisticallyAddProject === 'function') optimisticallyAddProject(addedProject);
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

async function removeProject(name) {
  if (!confirm('Remove project "' + name + '"? Pending work cancels, active agents are killed, data dir is archived to projects/.archived/.')) return;
  const prevProjects = (_settingsData && Array.isArray(_settingsData.projects)) ? _settingsData.projects.slice() : null;
  showToast('cmd-toast', 'Removing project "' + name + '"...', true);
  markDeleted('project:' + name);
  if (_settingsData && Array.isArray(_settingsData.projects)) {
    _settingsData.projects = _settingsData.projects.filter(function(p) { return p.name !== name; });
  }
  const card = document.querySelector('[data-settings-project="' + CSS.escape(name) + '"]');
  if (card) card.remove();
  if (window._lastStatus && Array.isArray(window._lastStatus.projects) && typeof renderProjects === 'function') {
    renderProjects(window._lastStatus.projects);
  }
  try {
    const res = await fetch('/api/projects/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      if (prevProjects) _settingsData.projects = prevProjects;
      clearDeleted('project:' + name);
      if (window._lastStatus && Array.isArray(window._lastStatus.projects) && typeof renderProjects === 'function') {
        renderProjects(window._lastStatus.projects);
      }
      showToast('cmd-toast', 'Remove failed: ' + (d.error || 'unknown'), false);
      openSettings();
      return;
    }
    var parts = ['Removed "' + name + '"'];
    if (d.cancelledItems) parts.push(d.cancelledItems + ' WI cancelled');
    if (d.drainedDispatches) parts.push(d.drainedDispatches + ' dispatch drained');
    if (d.cleanedWorktrees) parts.push(d.cleanedWorktrees + ' worktree(s) cleaned');
    if (d.archivedPlans?.length) parts.push(d.archivedPlans.length + ' plan/PRD archived');
    if (d.archivedTo) parts.push('archived to ' + d.archivedTo);
    if (d.pipelineRefs?.length) parts.push('! pipelines still reference: ' + d.pipelineRefs.join(', '));
    showToast('cmd-toast', parts.join(' — '), true);
    setTimeout(() => openSettings(), 600);
  } catch (e) {
    if (prevProjects) _settingsData.projects = prevProjects;
    clearDeleted('project:' + name);
    if (window._lastStatus && Array.isArray(window._lastStatus.projects) && typeof renderProjects === 'function') {
      renderProjects(window._lastStatus.projects);
    }
    showToast('cmd-toast', 'Error: ' + e.message, false);
    openSettings();
  }
}

window.MinionsSettings = { openSettings, saveSettings, addProject, removeProject, resetSettingsToDefaults };
