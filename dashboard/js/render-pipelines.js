// render-pipelines.js — Pipeline list, run detail, and create modal

let _pipelinesData = [];
let _pipelinePollId = null;
let _pipelinePollInterval = null;
function _stopPipelinePoll() { if (_pipelinePollInterval) { clearInterval(_pipelinePollInterval); _pipelinePollInterval = null; } _pipelinePollId = null; }

/**
 * Render clickable artifact links for a pipeline stage.
 * Each artifact type gets an icon and navigates to the relevant detail view.
 */
function _renderArtifactLinks(artifacts) {
  if (!artifacts) return '';
  var links = [];
  var linkStyle = 'display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;font-size:10px;cursor:pointer;text-decoration:none;color:var(--blue);background:color-mix(in srgb, var(--blue) 10%, transparent);border:1px solid color-mix(in srgb, var(--blue) 20%, transparent)';

  // Work items → navigate to work page & open detail
  (artifacts.workItems || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'work\');setTimeout(function(){openWorkItemDetail(\'' + escHtml(id) + '\')},200)" title="Open work item ' + escHtml(id) + '">⚙ ' + escHtml(id) + '</span>');
  });

  // Meetings → navigate to meetings page & open detail
  (artifacts.meetings || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'meetings\');setTimeout(function(){openMeetingDetail(\'' + escHtml(id) + '\')},200)" title="Open meeting ' + escHtml(id) + '">💬 ' + escHtml(id) + '</span>');
  });

  // Plans → navigate to plans page
  (artifacts.plans || []).forEach(function(name) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'plans\')" title="Plan: ' + escHtml(name) + '">📋 ' + escHtml(name.replace(/\.md$/, '').slice(0, 30)) + '</span>');
  });

  // PRDs → navigate to PRD page
  (artifacts.prds || []).forEach(function(name) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'prd\')" title="PRD: ' + escHtml(name) + '">📄 ' + escHtml(name.replace(/\.json$/, '').slice(0, 30)) + '</span>');
  });

  // PRs → navigate to PRs page
  (artifacts.prs || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + '" onclick="event.stopPropagation();closeModal();switchPage(\'prs\')" title="Pull request ' + escHtml(id) + '">🔀 PR-' + escHtml(id) + '</span>');
  });

  // Sub-stages (parallel) — just label them, no nav needed
  (artifacts.subStages || []).forEach(function(id) {
    links.push('<span style="' + linkStyle + ';cursor:default;color:var(--muted);background:color-mix(in srgb, var(--muted) 8%, transparent);border-color:color-mix(in srgb, var(--muted) 15%, transparent)" title="Sub-stage ' + escHtml(id) + '">⚓ ' + escHtml(id) + '</span>');
  });

  // Notes → navigate to inbox page
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

    // Build step-progress indicator for pipelines with a run
    var progressHtml = '';
    var displayRun = activeRun || lastRun;
    if (displayRun && (p.stages || []).length > 0) {
      progressHtml = _buildProgressBar(p.stages || [], displayRun);
    }

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
  if (detailRun && (p.stages || []).length > 0) {
    html += _buildProgressBar(p.stages || [], detailRun, { height: '8px', detailLabel: true });
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
      '<div style="font-size:10px;color:var(--muted);margin-top:4px">Type: ' + escHtml(s.type) + ' | Depends on: ' + escHtml(deps) + (s.agent ? ' | Agent: ' + escHtml(s.agent) : '') + '</div>' +
      _renderArtifactLinks(stageRun.artifacts) +
      (stageRun.output ? '<div style="margin-top:6px;font-size:11px;max-height:150px;overflow-y:auto">' + renderMd(stageRun.output.slice(0, 500)) + '</div>' : '') +
      (stageStatus === 'waiting-human' ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green);margin-top:6px" onclick="_continuePipeline(\'' + escHtml(id) + '\',\'' + escHtml(s.id) + '\',this)">Continue</button>' : '') +
    '</div>';
  });

  // Run history
  var runs = (p.runs || []).slice(-5).reverse();
  if (runs.length > 0) {
    html += '<h4 style="font-size:12px;color:var(--blue);margin:0">Recent Runs</h4>';
    runs.forEach(function(r, ri) {
      var color = r.status === 'completed' ? 'var(--green)' : r.status === 'failed' ? 'var(--red)' : r.status === 'running' ? 'var(--blue)' : 'var(--muted)';
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
        (artifactCount > 0 ? '<div id="' + toggleId + '" style="display:none;flex-wrap:wrap;gap:4px;margin-top:4px;margin-left:12px">' + _renderArtifactLinks(runArtifacts.merged) + '</div>' : '') +
      '</div>';
    });
  }

  html += '</div>';

  document.getElementById('modal-title').textContent = 'Pipeline: ' + p.title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal').classList.add('open');

  // Live-poll while modal is open and pipeline has an active run
  if (activeRun) {
    _pipelinePollId = id;
    _pipelinePollInterval = setInterval(function() {
      if (!document.getElementById('modal')?.classList?.contains('open') || _pipelinePollId !== id) {
        _stopPipelinePoll(); return;
      }
      fetch('/api/pipelines').then(function(r) { return r.json(); }).then(function(d) {
        if (_pipelinePollId !== id) return;
        var fresh = (d.pipelines || []).find(function(x) { return x.id === id; });
        if (fresh) {
          // Only re-render if data changed
          var newHash = JSON.stringify(fresh.runs || []);
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

async function _triggerPipeline(id, btn) {
  if (btn) { btn.textContent = 'Starting...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    var res = await fetch('/api/pipelines/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    var d = await res.json();
    if (res.ok) { showToast('cmd-toast', 'Pipeline triggered: ' + (d.runId || ''), true); try { closeModal(); } catch {} refresh(); }
    else { if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { if (btn) { btn.textContent = 'Run Now'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Error: ' + e.message); }
}

async function _abortPipeline(id, btn) {
  if (!confirm('Abort the active run for "' + id + '"?')) return;
  if (btn) { btn.textContent = 'Aborting...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    var res = await fetch('/api/pipelines/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    if (res.ok) {
      showToast('cmd-toast', 'Pipeline run aborted', true);
      if (btn) { btn.textContent = '\u2713 Aborted'; btn.style.color = 'var(--red)'; }
      setTimeout(function() { openPipelineDetail(id); }, 1500);
    } else { var d = await res.json().catch(function() { return {}; }); alert('Abort failed: ' + (d.error || 'unknown')); if (btn) { btn.textContent = 'Abort'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
  } catch (e) { alert('Error: ' + e.message); if (btn) { btn.textContent = 'Abort'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
}

async function _retriggerPipeline(id, btn) {
  if (!confirm('Abort current run and start a fresh one for "' + id + '"?')) return;
  if (btn) { btn.textContent = 'Retriggering...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    var res = await fetch('/api/pipelines/retrigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    var d = await res.json();
    if (res.ok) {
      showToast('cmd-toast', 'Pipeline retriggered: ' + (d.runId || ''), true);
      if (btn) { btn.textContent = '\u2713 Retriggered'; btn.style.color = 'var(--green)'; }
      setTimeout(function() { openPipelineDetail(id); }, 1500);
    } else { alert('Retrigger failed: ' + (d.error || 'unknown')); if (btn) { btn.textContent = 'Retrigger'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
  } catch (e) { alert('Error: ' + e.message); if (btn) { btn.textContent = 'Retrigger'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
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
  if (btn) { btn.textContent = 'Continuing...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    var res = await fetch('/api/pipelines/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, stageId: stageId }) });
    if (res.ok) {
      showToast('cmd-toast', 'Stage continued — dispatching next tick', true);
      if (btn) { btn.textContent = '\u2713 Continued'; btn.style.color = 'var(--green)'; btn.style.borderColor = 'var(--green)'; btn.style.opacity = '1'; }
      setTimeout(function() { openPipelineDetail(id); }, 2000);
    } else {
      var d = await res.json().catch(function() { return {}; }); alert('Failed: ' + (d.error || 'unknown'));
      if (btn) { btn.textContent = 'Continue'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
    }
  } catch (e) {
    alert('Error: ' + e.message);
    if (btn) { btn.textContent = 'Continue'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
  }
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
