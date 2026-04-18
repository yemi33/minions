// render-pipelines.js — Pipeline list, run detail, and create modal

let _pipelinesData = [];
let _pipelinePollId = null;
let _pipelinePollInterval = null;
function _stopPipelinePoll() { if (_pipelinePollInterval) { clearInterval(_pipelinePollInterval); _pipelinePollInterval = null; } _pipelinePollId = null; }

/**
 * Collect all monitoredResources from a pipeline (pipeline-level + all stages).
 * Returns a deduplicated array of resource objects.
 */
function _collectMonitoredResources(pipeline) {
  var seen = new Set();
  var result = [];
  function add(r) {
    var key = typeof r === 'string' ? r : (r.url || r.label || JSON.stringify(r));
    if (seen.has(key)) return;
    seen.add(key);
    result.push(typeof r === 'string' ? { label: r, url: r } : r);
  }
  (pipeline.monitoredResources || []).forEach(add);
  (pipeline.stages || []).forEach(function(s) { (s.monitoredResources || []).forEach(add); });
  return result;
}

/**
 * Render monitored resources as compact pills on a pipeline card or stage detail.
 * Supports both string resources (URLs/IDs) and objects with {type, label, url}.
 * @param {Array} resources - array of resource strings or {type?, label, url?} objects
 * @param {Object} [options] - { compact: true } limits display and shows "+N more"
 * @returns {string} HTML string
 */
function _renderMonitoredResources(resources, options) {
  if (!resources || resources.length === 0) return '';
  var compact = options && options.compact;
  var maxShow = compact ? 4 : resources.length;
  var shown = resources.slice(0, maxShow);
  var overflow = resources.length - maxShow;

  var iconMap = { pr: '🔀', workitem: '⚙', url: '🔗', issue: '🐛' };
  var pillStyle = 'display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;font-size:10px;text-decoration:none;' +
    'color:var(--text);background:color-mix(in srgb, var(--muted) 10%, transparent);border:1px solid color-mix(in srgb, var(--muted) 20%, transparent);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

  var pills = shown.map(function(r) {
    var res = typeof r === 'string' ? { label: r, url: r.startsWith('http') ? r : '' } : r;
    var icon = iconMap[res.type] || (res.url ? '🔗' : '📌');
    var label = res.label || res.url || '(resource)';
    // Truncate label for compact view
    var displayLabel = compact && label.length > 28 ? label.slice(0, 26) + '…' : label;
    if (res.url) {
      return '<a href="' + escHtml(res.url) + '" target="_blank" rel="noopener" style="' + pillStyle + ';cursor:pointer" onclick="event.stopPropagation()" title="' + escHtml(label) + '">' + icon + ' ' + escHtml(displayLabel) + '</a>';
    }
    return '<span style="' + pillStyle + ';cursor:default" title="' + escHtml(label) + '">' + icon + ' ' + escHtml(displayLabel) + '</span>';
  });

  if (overflow > 0) {
    pills.push('<span style="' + pillStyle + ';cursor:default;opacity:0.7" title="' + overflow + ' more resource' + (overflow !== 1 ? 's' : '') + '">+' + overflow + ' more</span>');
  }

  var heading = compact ? '' : '<span style="font-size:10px;color:var(--muted);margin-right:4px">Monitoring:</span>';
  return '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:3px;align-items:center">' + heading + pills.join('') + '</div>';
}

/**
 * Render clickable artifact links for a pipeline stage.
 * Each artifact type gets an icon and navigates to the relevant detail view.
 * @param {Object} artifacts - artifact map from stage run
 * @param {string} [pipelineId] - pipeline ID for modal back-navigation
 */
function _renderArtifactLinks(artifacts, pipelineId) {
  if (!artifacts) return '';
  var links = [];
  var linkStyle = 'display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;font-size:10px;cursor:pointer;text-decoration:none;color:var(--blue);background:color-mix(in srgb, var(--blue) 10%, transparent);border:1px solid color-mix(in srgb, var(--blue) 20%, transparent)';

  // Pushes current pipeline modal onto back stack so detail modals can navigate back
  var backFn = pipelineId ? "pushModalBack(function(){openPipelineDetail('" + escHtml(pipelineId) + "')});" : '';

  (artifacts.workItems || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();' + backFn + 'openWorkItemDetail(\'' + escHtml(id) + '\')" title="Open work item ' + escHtml(id) + '">⚙ ' + escHtml(id) + '</span>');
  });
  (artifacts.meetings || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();' + backFn + 'openMeetingDetail(\'' + escHtml(id) + '\')" title="Open meeting ' + escHtml(id) + '">💬 ' + escHtml(id) + '</span>');
  });
  (artifacts.plans || []).forEach(function(name) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();' + backFn + 'planView(\'' + escHtml(name) + '\')" title="Plan: ' + escHtml(name) + '">📋 ' + escHtml(name.replace(/\.md$/, '').slice(0, 30)) + '</span>');
  });
  (artifacts.prds || []).forEach(function(name) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();' + backFn + 'planView(\'' + escHtml(name) + '\')" title="PRD: ' + escHtml(name) + '">📄 ' + escHtml(name.replace(/\.json$/, '').slice(0, 30)) + '</span>');
  });
  (artifacts.prs || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'prs\')" title="Pull request ' + escHtml(id) + '">🔀 PR-' + escHtml(id) + '</span>');
  });
  (artifacts.subStages || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + ';cursor:default;color:var(--muted);background:color-mix(in srgb, var(--muted) 8%, transparent);border-color:color-mix(in srgb, var(--muted) 15%, transparent)" title="Sub-stage ' + escHtml(id) + '">⚓ ' + escHtml(id) + '</span>');
  });
  (artifacts.notes || []).forEach(function(name) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'inbox\')" title="Note: ' + escHtml(name) + '">📝 ' + escHtml(name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').slice(0, 30)) + '</span>');
  });

  if (links.length === 0) return '';
  return '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">' + links.join('') + '</div>';
}

/**
 * Collect and deduplicate artifacts from all stages in a run.
 * Returns { merged: { workItems, meetings, plans, prds, prs, subStages }, total }.
 */
function _collectRunArtifacts(run) {
  var merged = { workItems: [], meetings: [], plans: [], prds: [], prs: [], subStages: [] };
  var stages = run.stages || {};
  for (var stageId in stages) {
    var a = stages[stageId].artifacts || {};
    ['workItems', 'meetings', 'plans', 'prds', 'prs', 'subStages'].forEach(function(key) {
      (a[key] || []).forEach(function(v) {
        if (merged[key].indexOf(v) === -1) merged[key].push(v);
      });
    });
  }
  var total = merged.workItems.length + merged.meetings.length + merged.plans.length + merged.prds.length + merged.prs.length;
  return { merged: merged, total: total };
}

/**
 * Build a segmented progress bar from pipeline stages and a run.
 * @param {Array} stages - pipeline stage definitions
 * @param {Object} run - the run object containing stages status map
 * @param {Object} [options] - optional config: { height: '8px', detailLabel: true }
 * @returns {string} HTML string for the progress bar
 */
function _buildProgressBar(stages, run, options) {
  var totalStages = stages.length;
  var completedCount = 0;
  var runningCount = 0;
  var failedCount = 0;
  stages.forEach(function(s) {
    var st = run.stages?.[s.id]?.status;
    if (st === 'completed') completedCount++;
    else if (st === 'running') runningCount++;
    else if (st === 'failed') failedCount++;
  });
  var pct = Math.round((completedCount / totalStages) * 100);

  var segments = stages.map(function(s) {
    var st = run.stages?.[s.id]?.status || 'pending';
    var cls = st === 'completed' ? 'complete' : st === 'running' ? 'running' : st === 'failed' ? 'failed' : st === 'waiting-human' ? 'waiting' : 'pending';
    return '<div class="pl-prog-seg ' + cls + '" style="width:' + (100 / totalStages) + '%" title="' + escHtml(s.id) + ': ' + st + '"></div>';
  }).join('');

  var barStyle = options && options.height ? ' style="height:' + options.height + '"' : '';

  var label;
  if (options && options.detailLabel) {
    label = '<span style="font-weight:600;color:' + (pct === 100 ? 'var(--green)' : failedCount ? 'var(--red)' : 'var(--blue)') + '">' + pct + '% complete</span> <span style="color:var(--muted)">(' + completedCount + '/' + totalStages + ' stages)</span>';
  } else {
    var statusParts = [];
    if (completedCount) statusParts.push(completedCount + ' done');
    if (runningCount) statusParts.push(runningCount + ' running');
    if (failedCount) statusParts.push(failedCount + ' failed');
    var remaining = totalStages - completedCount - runningCount - failedCount;
    if (remaining > 0) statusParts.push(remaining + ' pending');
    label = '<span style="font-weight:600;color:' + (pct === 100 ? 'var(--green)' : failedCount ? 'var(--red)' : 'var(--blue)') + '">' + pct + '%</span>' +
      '<span style="color:var(--muted)">' + statusParts.join(' \u00b7 ') + '</span>';
  }

  return '<div class="pl-progress-wrap">' +
    '<div class="pl-progress-bar"' + barStyle + '>' + segments + '</div>' +
    '<div class="pl-progress-label">' + label + '</div>' +
  '</div>';
}

var _nodeIcons = { task: '\u2699', meeting: '\uD83D\uDCAC', plan: '\uD83D\uDCCB', 'merge-prs': '\uD83D\uDD04', condition: '\u2753', wait: '\u23F8', parallel: '\u2693', schedule: '\u23F0', api: '\uD83C\uDF10' };

function _buildNodeChain(stages, run, options) {
  var compact = options && options.compact;
  var pipeline = options && options.pipeline;
  var html = '<div class="pl-node-chain">';

  for (var i = 0; i < stages.length; i++) {
    var s = stages[i];
    var stageRun = run?.stages?.[s.id];
    var st = stageRun?.status || 'pending';
    var cls = st === 'completed' ? 'complete' : st === 'running' ? 'running' : st === 'failed' ? 'failed' : st === 'waiting-human' ? 'waiting' : 'pending';
    var icon = _nodeIcons[s.type] || '\u2699';
    var isCondition = s.type === 'condition';
    var isWait = s.type === 'wait';

    // Arrow before node (except first)
    if (i > 0) html += '<div class="pl-node-arrow">\u2192</div>';

    html += '<div class="pl-node">';
    var label = compact ? (s.id || '').slice(0, 16) : (s.title || s.id || '').slice(0, 24);
    html += '<div class="pl-node-box ' + cls + (isCondition ? ' condition' : '') + '" title="' + escHtml((s.title || s.id) + ': ' + st) + '">';
    html += icon + ' ' + escHtml(label);
    if (isWait && s.duration) html += ' ' + escHtml(s.duration);
    html += '</div>';

    // Meta line (agent, timing) — skip in compact mode
    if (!compact) {
      var meta = [];
      var agent = stageRun?.agent || s.agent;
      if (agent) meta.push(escHtml(agent));
      if (st === 'completed' && stageRun?.completedAt) meta.push(timeSinceStr(new Date(stageRun.completedAt)));
      if (st === 'running' && stageRun?.startedAt) meta.push(timeSinceStr(new Date(stageRun.startedAt)));
      // Artifact counts
      var arts = stageRun?.artifacts || {};
      var artCounts = [];
      if (arts.workItems?.length) artCounts.push(arts.workItems.length + ' WI');
      if (arts.prs?.length) artCounts.push(arts.prs.length + ' PR');
      if (arts.notes?.length) artCounts.push(arts.notes.length + ' notes');
      if (artCounts.length) meta.push(artCounts.join(', '));
      if (meta.length) html += '<div class="pl-node-meta">' + meta.join(' \u00b7 ') + '</div>';
    }

    // Condition fork labels
    if (isCondition) {
      html += '<div class="pl-node-meta" style="font-style:italic">';
      if (s.onMet) html += '\u2714 ' + escHtml(s.onMet);
      if (s.onMet && s.onUnmet) html += ' / ';
      if (s.onUnmet) html += '\u2718 ' + escHtml(s.onUnmet);
      html += '</div>';
    }

    html += '</div>';
  }

  // Stop/exit condition terminal node
  var stopWhen = pipeline?.stopWhen;
  if (stopWhen) {
    html += '<div class="pl-node-arrow">\u2192</div>';
    html += '<div class="pl-node"><div class="pl-node-box pl-node-stop">\u23F9 Stop</div>';
    html += '<div class="pl-node-meta">' + escHtml(stopWhen) + '</div></div>';
  }

  html += '</div>';

  // Loop indicator — only for pipelines with stopWhen or condition stages (repeat-until pattern)
  var hasStopWhen = !!pipeline?.stopWhen;
  var hasConditionStage = (pipeline?.stages || []).some(function(s) { return s.type === 'condition'; });
  if (hasStopWhen || hasConditionStage) {
    var runCount = (pipeline.runs || []).length;
    var cronLabel = pipeline?.trigger?.cron ? _cronToHuman(pipeline.trigger.cron) : 'until condition met';
    html += '<div class="pl-node-loop">\u21BA Loop (' + escHtml(cronLabel) + ')';
    if (runCount > 0) html += ' \u00b7 Run ' + runCount;
    html += '</div>';
  }

  return html;
}

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
    const statusColor = activeRun ? 'var(--blue)' : lastRun?.status === 'completed' ? 'var(--green)' : lastRun?.status === 'failed' ? 'var(--red)' : lastRun?.status === 'stopped' ? 'var(--yellow)' : 'var(--muted)';
    const statusLabel = activeRun ? 'Running' : lastRun ? (lastRun.status === 'completed' ? 'Completed' : lastRun.status === 'failed' ? 'Failed' : lastRun.status === 'stopped' ? 'Stopped' : lastRun.status) : 'Never run';
    const trigger = p.trigger?.cron ? _cronToHuman(p.trigger.cron) : 'Manual';

    // Build node chain (renders for all pipelines, even never-run)
    var progressHtml = '';
    var displayRun = activeRun || lastRun;
    if ((p.stages || []).length > 0) {
      progressHtml = _buildNodeChain(p.stages || [], displayRun, { compact: true, pipeline: p });
    }

    // Monitored resources (pipeline-level + stage-level, compact on card)
    var allResources = _collectMonitoredResources(p);
    var resourcesHtml = _renderMonitoredResources(allResources, { compact: true });

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer" onclick="if(shouldIgnoreSelectionClick(event))return;openPipelineDetail(\'' + escHtml(p.id) + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:13px">' + escHtml(p.title) + '</strong>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="color:' + statusColor + ';font-size:11px;font-weight:600">' + statusLabel + '</span>' +
          '<span style="font-size:10px;color:var(--muted)">' + escHtml(trigger) + '</span>' +
          (p.stopWhen ? '<span style="font-size:9px;color:var(--yellow)" title="Auto-stops when condition met: ' + escHtml(typeof p.stopWhen === 'string' ? p.stopWhen : (p.stopWhen.check || 'condition')) + '">STOP-WHEN</span>' : '') +
          (p.enabled === false ? '<span style="font-size:9px;color:var(--red)"' + (p._stopReason ? ' title="' + escHtml(p._stopReason) + '"' : '') + '>' + (p._stoppedBy ? 'AUTO-STOPPED' : 'DISABLED') + '</span>' : '') +
        '</div>' +
      '</div>' +
      resourcesHtml +
      progressHtml +
    '</div>';
  }).join('');
}

function openPipelineDetail(id) {
  _stopPipelinePoll();
  var p = _pipelinesData.find(function(x) { return x.id === id; });
  if (!p) { alert('Pipeline not found'); return; }

  var html = '<div style="display:flex;flex-direction:column;gap:12px">';

  // Status + actions
  var activeRun = (p.runs || []).find(function(r) { return r.status === 'running'; });
  html += '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<span style="font-size:10px;color:var(--muted)">' + (p.trigger?.cron ? escHtml(_cronToHuman(p.trigger.cron)) + ' <span style="opacity:0.6">(' + escHtml(p.trigger.cron) + ', ' + escHtml(Intl.DateTimeFormat().resolvedOptions().timeZone) + ')</span>' : 'Manual trigger') + '</span>' +
    '<div style="display:flex;gap:6px">' +
      (activeRun
        ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_abortPipeline(\'' + escHtml(id) + '\',this)">Abort</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow);border-color:var(--yellow)" onclick="_retriggerPipeline(\'' + escHtml(id) + '\',this)">Retrigger</button>'
        : '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green)" onclick="_triggerPipeline(\'' + escHtml(id) + '\',this)">Run Now</button>') +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="openEditPipelineModal(\'' + escHtml(id) + '\')">Edit</button>' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="_togglePipelineEnabled(\'' + escHtml(id) + '\',' + !p.enabled + ',this)">' + (p.enabled !== false ? 'Disable' : 'Enable') + '</button>' +
      '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_deletePipelineConfirm(\'' + escHtml(id) + '\')">Delete</button>' +
    '</div>' +
  '</div>';

  // Stage detail with progress bar
  var detailRun = activeRun || (p.runs || []).slice(-1)[0];
  if ((p.stages || []).length > 0) {
    html += _buildNodeChain(p.stages || [], detailRun, { compact: false, pipeline: p });
  }
  // Pipeline-level monitored resources (full view in detail)
  var pipelineResources = _collectMonitoredResources(p);
  if (pipelineResources.length > 0) {
    html += '<div style="border:1px solid color-mix(in srgb, var(--blue) 20%, transparent);border-radius:6px;padding:6px 10px;background:color-mix(in srgb, var(--blue) 4%, transparent)">' +
      '<span style="font-size:10px;font-weight:600;color:var(--blue)">📡 Monitored Resources</span>' +
      _renderMonitoredResources(pipelineResources) +
    '</div>';
  }

  // stopWhen info
  if (p.stopWhen) {
    var swLabel = typeof p.stopWhen === 'string' ? p.stopWhen : (p.stopWhen.check || JSON.stringify(p.stopWhen));
    html += '<div style="border:1px solid color-mix(in srgb, var(--yellow) 30%, transparent);border-radius:6px;padding:4px 10px;background:color-mix(in srgb, var(--yellow) 6%, transparent);font-size:11px">' +
      '<span style="color:var(--yellow);font-weight:600">Stop When:</span> <span style="color:var(--text)">' + escHtml(swLabel) + '</span>' +
      (p._stoppedBy ? ' <span style="color:var(--green);font-size:10px">\u2714 triggered' + (p._stoppedAt ? ' at ' + escHtml(p._stoppedAt.slice(0, 16).replace('T', ' ')) : '') + '</span>' : '') +
    '</div>';
  }
  if (p._stopReason && p.enabled === false) {
    html += '<div style="border:1px solid color-mix(in srgb, var(--red) 30%, transparent);border-radius:6px;padding:4px 10px;background:color-mix(in srgb, var(--red) 6%, transparent);font-size:11px">' +
      '<span style="color:var(--red);font-weight:600">Auto-stopped:</span> <span style="color:var(--text)">' + escHtml(p._stopReason) + '</span>' +
    '</div>';
  }

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
      '<div style="font-size:10px;color:var(--muted);margin-top:4px">Type: ' + escHtml(s.type) + ' | Depends on: ' + escHtml(deps) + (s.agent ? ' | Agent: ' + escHtml(s.agent) : '') +
        (s.type === 'condition' ? ' | Check: ' + escHtml(typeof (s.check || s.condition) === 'string' ? (s.check || s.condition) : ((s.check || s.condition || {}).check || '?')) + (s.onMet ? ' | onMet: ' + escHtml(s.onMet) : '') + (s.onUnmet ? ' | onUnmet: ' + escHtml(s.onUnmet) : '') : '') +
      '</div>' +
      _renderMonitoredResources(s.monitoredResources || []) +
      _renderArtifactLinks(stageRun.artifacts, id) +
      (stageRun.output ? '<div style="margin-top:6px;font-size:11px;max-height:150px;overflow-y:auto">' + renderMd(stageRun.output.slice(0, 500)) + '</div>' : '') +
      (stageStatus === 'waiting-human' ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green);margin-top:6px" onclick="_continuePipeline(\'' + escHtml(id) + '\',\'' + escHtml(s.id) + '\',this)">Continue</button>' : '') +
    '</div>';
  });

  // Run history
  var runs = (p.runs || []).slice(-5).reverse();
  if (runs.length > 0) {
    html += '<h4 style="font-size:12px;color:var(--blue);margin:0">Recent Runs</h4>';
    runs.forEach(function(r, ri) {
      var color = r.status === 'completed' ? 'var(--green)' : r.status === 'failed' ? 'var(--red)' : r.status === 'running' ? 'var(--blue)' : r.status === 'stopped' ? 'var(--yellow)' : 'var(--muted)';
      // Collect all artifacts across stages for this run
      var runArtifacts = _collectRunArtifacts(r);
      var artifactCount = runArtifacts.total;
      var toggleId = 'run-artifacts-' + ri;
      html += '<div style="font-size:10px">' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<span style="color:' + color + ';font-weight:600">' + r.status + '</span>' +
          '<span style="color:var(--muted)">' + (r.startedAt ? new Date(r.startedAt).toLocaleString() : '') + '</span>' +
          (r.completedAt ? '<span style="color:var(--muted)">\u2192 ' + new Date(r.completedAt).toLocaleString() + '</span>' : '') +
          (artifactCount > 0 ? '<span style="color:var(--blue);cursor:pointer;user-select:none" onclick="var el=document.getElementById(\'' + toggleId + '\');el.style.display=el.style.display===\'none\'?\'flex\':\'none\'" title="Toggle artifacts">' + artifactCount + ' artifact' + (artifactCount !== 1 ? 's' : '') + ' ▾</span>' : '') +
        '</div>' +
        (artifactCount > 0 ? '<div id="' + toggleId + '" style="display:none;flex-wrap:wrap;gap:4px;margin-top:4px;margin-left:12px">' + _renderArtifactLinks(runArtifacts.merged, id) + '</div>' : '') +
      '</div>';
    });
  }

  html += '</div>';

  document.getElementById('modal-title').textContent = 'Pipeline: ' + p.title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.add('open');

  // Live-poll while modal is open — always poll (not just active runs)
  // so the modal updates when stages advance, pipelines get triggered, etc.
  _pipelinePollId = id;
  if (!_pipelinePollInterval) {
    _pipelinePollInterval = setInterval(function() {
      if (!document.getElementById('modal')?.classList?.contains('open') || _pipelinePollId !== id) {
        _stopPipelinePoll(); return;
      }
      fetch('/api/pipelines').then(function(r) { return r.json(); }).then(function(d) {
        if (_pipelinePollId !== id) return;
        var list = Array.isArray(d) ? d : (d.pipelines || []);
        var fresh = list.find(function(x) { return x.id === id; });
        if (fresh) {
          // Only re-render if data changed
          var newHash = JSON.stringify({ runs: fresh.runs || [], enabled: fresh.enabled, _stoppedBy: fresh._stoppedBy, _stopReason: fresh._stopReason });
          if (newHash !== _pipelinePollHash) {
            _pipelinePollHash = newHash;
            _pipelinesData = _pipelinesData.map(function(x) { return x.id === id ? fresh : x; });
            openPipelineDetail(id);
          }
        }
      }).catch(function() {});
    }, 4000);
  }
}
var _pipelinePollHash = '';

/**
 * Fetch fresh pipeline data and re-render the detail modal immediately.
 * Used after actions (continue, trigger, abort) to avoid waiting for the 4s poll.
 */
async function _refreshPipelineDetail(id) {
  try {
    var res = await fetch('/api/pipelines');
    var d = await res.json();
    var list = Array.isArray(d) ? d : (d.pipelines || []);
    var fresh = list.find(function(x) { return x.id === id; });
    if (fresh) {
      _pipelinesData = _pipelinesData.map(function(x) { return x.id === id ? fresh : x; });
      _pipelinePollHash = JSON.stringify({ runs: fresh.runs || [], enabled: fresh.enabled, _stoppedBy: fresh._stoppedBy, _stopReason: fresh._stopReason });
      openPipelineDetail(id);
    }
  } catch (e) { /* silent — next poll will catch up */ }
}

async function _triggerPipeline(id, btn) {
  if (btn) { btn.textContent = 'Starting...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Pipeline triggered', true);
  // Optimistic: inject a running state so the UI updates immediately
  var p = _pipelinesData.find(function(x) { return x.id === id; });
  if (p) {
    if (!p.runs) p.runs = [];
    p.runs.push({ status: 'running', startedAt: new Date().toISOString(), stages: {} });
    openPipelineDetail(id);
  }
  try {
    var res = await fetch('/api/pipelines/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (res.ok) { refresh(); await _refreshPipelineDetail(id); }
    else { var d = await res.json().catch(function() { return {}; }); if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false); }
  } catch (e) { if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function _abortPipeline(id, btn) {
  if (!confirm('Abort the active run for "' + id + '"?')) return;
  if (btn) { btn.textContent = 'Aborting...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Pipeline aborted', true);
  try {
    var res = await fetch('/api/pipelines/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (res.ok) {
      if (btn) { btn.textContent = 'Abort'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      refresh();
      await _refreshPipelineDetail(id);
    } else { var d = await res.json().catch(function() { return {}; }); showToast('cmd-toast', 'Abort failed: ' + (d.error || 'unknown'), false); if (btn) { btn.textContent = 'Abort'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); if (btn) { btn.textContent = 'Abort'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
}

async function _retriggerPipeline(id, btn) {
  if (!confirm('Abort current run and start a fresh one for "' + id + '"?')) return;
  if (btn) { btn.textContent = 'Retriggering...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Pipeline retriggered', true);
  try {
    var res = await fetch('/api/pipelines/retrigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (res.ok) {
      if (btn) { btn.textContent = 'Retrigger'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      refresh();
      await _refreshPipelineDetail(id);
    } else { var d = await res.json().catch(function() { return {}; }); showToast('cmd-toast', 'Retrigger failed: ' + (d.error || 'unknown'), false); if (btn) { btn.textContent = 'Retrigger'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); if (btn) { btn.textContent = 'Retrigger'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
}

async function _togglePipelineEnabled(id, enabled, btn) {
  if (btn) { btn.textContent = enabled ? 'Enabling...' : 'Disabling...'; btn.style.pointerEvents = 'none'; }
  showToast('cmd-toast', enabled ? 'Pipeline enabled' : 'Pipeline disabled', true);
  try {
    var res = await fetch('/api/pipelines/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, enabled: enabled }) });
    if (res.ok) { refresh(); await _refreshPipelineDetail(id); }
    else { showToast('cmd-toast', 'Failed to ' + (enabled ? 'enable' : 'disable') + ' pipeline', false); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
  if (btn) { btn.textContent = enabled ? 'Disable' : 'Enable'; btn.style.pointerEvents = ''; }
}

async function _continuePipeline(id, stageId, btn) {
  if (btn) { btn.textContent = 'Continuing...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Stage continued — dispatching next tick', true);
  try {
    var res = await fetch('/api/pipelines/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, stageId: stageId }) });
    if (res.ok) {
      if (btn) { btn.textContent = '\u2713 Continued'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; btn.style.opacity = '1'; }
      refresh();
      await _refreshPipelineDetail(id);
    } else {
      var d = await res.json().catch(function() { return {}; }); showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false);
      if (btn) { btn.textContent = 'Continue'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
    }
  } catch (e) {
    showToast('cmd-toast', 'Error: ' + e.message, false);
    if (btn) { btn.textContent = 'Continue'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
  }
}

async function _deletePipelineConfirm(id) {
  if (!confirm('Delete pipeline "' + id + '"?')) return;
  markDeleted('pipeline:' + id);
  try { closeModal(); } catch {}
  showToast('cmd-toast', 'Pipeline deleted', true);
  try {
    var res = await fetch('/api/pipelines/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (!res.ok) { showToast('cmd-toast', 'Delete failed', false); }
    refresh();
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); refresh(); }
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
    if (res.ok) { refresh(); } else { var d = await res.json().catch(function() { return {}; }); showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false); openCreatePipelineModal(); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); openCreatePipelineModal(); }
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
  closeModal();
  showToast('cmd-toast', 'Pipeline updated', true);
  try {
    var res = await fetch('/api/pipelines/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) { refresh(); }
    else { var d = await res.json().catch(function() { return {}; }); showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
}

window.MinionsPipelines = { renderPipelines, openPipelineDetail, openCreatePipelineModal, openEditPipelineModal };
