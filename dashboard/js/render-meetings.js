// render-meetings.js — Team meeting rendering

let _showArchived = false;
const MTG_PER_PAGE = 10;
let _mtgPage = 0;
let _lastMeetingHash = '';

function renderMeetings(meetings) {
  meetings = (meetings || []).filter(function(m) { return !isDeleted('mtg:' + m.id); });
  meetings.sort((a, b) => (b.createdAt || b.completedAt || '').localeCompare(a.createdAt || a.completedAt || ''));
  const el = document.getElementById('meetings-content');
  const countEl = document.getElementById('meetings-count');
  if (!meetings || meetings.length === 0) {
    countEl.textContent = '0';
    el.innerHTML = '<p class="empty">No meetings yet. Start one to have agents investigate, debate, and conclude on a topic.</p>';
    return;
  }

  const active = meetings.filter(m => m.status !== 'archived');
  const archived = meetings.filter(m => m.status === 'archived');
  countEl.textContent = active.length;

  const statusColors = { investigating: 'var(--blue)', debating: 'var(--purple,#a855f7)', concluding: 'var(--yellow)', completed: 'var(--green)', archived: 'var(--muted)' };
  const statusLabels = { investigating: 'Round 1 — Investigating', debating: 'Round 2 — Debating', concluding: 'Round 3 — Concluding', completed: 'Completed', archived: 'Archived' };

  const visible = _showArchived ? meetings : active;
  if (visible.length === 0) {
    el.innerHTML = '<p class="empty">No active meetings.</p>';
    if (archived.length) el.innerHTML += '<div style="text-align:center;margin-top:8px"><button class="pr-pager-btn" style="font-size:10px" onclick="_toggleArchivedMeetings()">Show ' + archived.length + ' archived</button></div>';
    return;
  }

  const totalPages = Math.ceil(visible.length / MTG_PER_PAGE);
  if (_mtgPage >= totalPages) _mtgPage = totalPages - 1;
  const start = _mtgPage * MTG_PER_PAGE;
  const pageItems = visible.slice(start, start + MTG_PER_PAGE);

  el.innerHTML = pageItems.map(m => {
    const statusColor = statusColors[m.status] || 'var(--muted)';
    const statusLabel = statusLabels[m.status] || m.status;
    const participantBadges = (m.participants || []).map(p => {
      const hasFindings = m.findings?.[p];
      const hasDebate = m.debate?.[p];
      const icon = m.status === 'completed' ? '✓' : m.status === 'debating' ? (hasDebate ? '✓' : (hasFindings ? '⏳' : '○')) : (hasFindings ? '✓' : '⏳');
      return '<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:10px">' + icon + ' ' + escHtml(p) + '</span>';
    }).join(' ');

    const dt = m.completedAt || m.createdAt;
    const timeStr = dt ? new Date(dt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

    return '<div data-file="meetings/' + escHtml(m.id) + '.json" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer;position:relative" onclick="if(shouldIgnoreSelectionClick(event))return;openMeetingDetail(\'' + escHtml(m.id) + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:13px">' + escHtml(m.title) + '</strong>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="color:' + statusColor + ';font-size:11px;font-weight:600">' + statusLabel + '</span>' +
          (m.status === 'archived'
            ? '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px" onclick="event.stopPropagation();_unarchiveMeeting(\'' + escHtml(m.id) + '\')">Unarchive</button>'
            : (m.status === 'completed' ? '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px" onclick="event.stopPropagation();_archiveMeeting(\'' + escHtml(m.id) + '\')">Archive</button>' : '')) +
          '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--red);border-color:var(--red)" onclick="event.stopPropagation();_deleteMeeting(\'' + escHtml(m.id) + '\')">Delete</button>' +
        '</div>' +
      '</div>' +
      (timeStr ? '<div style="margin-top:4px;font-size:10px;color:var(--muted)">' + escHtml(timeStr) + '</div>' : '') +
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + participantBadges + '</div>' +
      '<div style="margin-top:6px;font-size:11px;color:var(--muted)">' + escHtml((m.agenda || '').slice(0, 100)) + (m.agenda?.length > 100 ? '...' : '') + '</div>' +
    '</div>';
  }).join('');

  if (visible.length > MTG_PER_PAGE) {
    el.innerHTML += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (start + 1) + ' to ' + Math.min(start + MTG_PER_PAGE, visible.length) + ' of ' + visible.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_mtgPage === 0 ? 'disabled' : '') + '" onclick="_mtgPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_mtgPage >= totalPages - 1 ? 'disabled' : '') + '" onclick="_mtgNext()">Next</button>' +
      '</div></div>';
  }

  if (archived.length > 0) {
    el.innerHTML += '<div style="text-align:center;margin-top:8px"><button class="pr-pager-btn" style="font-size:10px" onclick="_toggleArchivedMeetings()">' +
      (_showArchived ? 'Hide' : 'Show') + ' ' + archived.length + ' archived</button></div>';
  }
  restoreNotifBadges();
}

function _mtgPrev() { if (_mtgPage > 0) { _mtgPage--; refresh(); } }
function _mtgNext() { _mtgPage++; refresh(); }

function _toggleArchivedMeetings() {
  _showArchived = !_showArchived;
  _mtgPage = 0;
  refresh();
}

let _meetingPollInterval = null;
let _meetingPollId = null;

function _stopMeetingPoll() {
  if (_meetingPollInterval) { clearInterval(_meetingPollInterval); _meetingPollInterval = null; }
  _meetingPollId = null;
}

function _renderMeetingDetail(m) {
      const statusColors = { investigating: 'var(--blue)', debating: 'var(--purple,#a855f7)', concluding: 'var(--yellow)', completed: 'var(--green)' };
      const statusLabels = { investigating: 'Round 1 — Investigating', debating: 'Round 2 — Debating', concluding: 'Round 3 — Concluding', completed: 'Completed' };

      let html = '<div style="display:flex;flex-direction:column;gap:12px">';

      // Status bar
      html += '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="color:' + (statusColors[m.status] || 'var(--muted)') + ';font-weight:600">' + (statusLabels[m.status] || m.status) + '</span>' +
        '<span style="font-size:10px;color:var(--muted)">' + escHtml(m.createdAt?.slice(0, 16).replace('T', ' ') || '') + '</span>' +
      '</div>';

      // Agenda — render markdown-like formatting
      html += '<div style="background:var(--surface2);padding:8px 12px;border-radius:6px;font-size:12px;white-space:pre-wrap;line-height:1.6">' +
        '<strong>Agenda:</strong>\n' + renderMd(m.agenda || '') + '</div>';

      // Per-agent panels
      for (const agent of (m.participants || [])) {
        html += '<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">';
        html += '<div style="background:var(--surface2);padding:6px 12px;font-weight:600;font-size:12px">' + escHtml(agent) + '</div>';

        // Findings
        if (m.findings?.[agent]) {
          html += '<div style="padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border)">' +
            '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Round 1 — Findings</div>' +
            '<div style="word-break:break-word;max-height:300px;overflow-y:auto">' + renderMd(m.findings[agent].content || '') + '</div></div>';
        }

        // Debate
        if (m.debate?.[agent]) {
          html += '<div style="padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border)">' +
            '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Round 2 — Debate</div>' +
            '<div style="word-break:break-word;max-height:300px;overflow-y:auto">' + renderMd(m.debate[agent].content || '') + '</div></div>';
        }

        // Status
        if (!m.findings?.[agent] && m.status !== 'completed') {
          html += '<div style="padding:6px 12px;font-size:10px;color:var(--muted)">⏳ Waiting...</div>';
        }

        html += '</div>';
      }

      // Conclusion
      if (m.conclusion) {
        html += '<div style="background:rgba(63,185,80,0.08);border:1px solid var(--green);border-radius:6px;padding:10px 14px">' +
          '<div style="color:var(--green);font-weight:600;font-size:12px;margin-bottom:6px">Conclusion (by ' + escHtml(m.conclusion.agent || '?') + ')</div>' +
          '<div style="font-size:12px;word-break:break-word;max-height:400px;overflow-y:auto">' + renderMd(m.conclusion.content || '') + '</div></div>';
      }

      // Human notes
      if (m.humanNotes?.length > 0) {
        html += '<div style="border-top:1px solid var(--border);padding-top:8px">' +
          '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Human Notes</div>' +
          m.humanNotes.map(n => '<div style="font-size:11px;margin-bottom:2px">• ' + escHtml(n) + '</div>').join('') +
        '</div>';
      }

      // Actions
      if (m.status === 'archived') {
        html += '<div style="display:flex;gap:8px;border-top:1px solid var(--border);padding-top:8px">' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="_unarchiveMeeting(\'' + escHtml(m.id) + '\')">Unarchive</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_deleteMeeting(\'' + escHtml(m.id) + '\')">Delete</button>' +
        '</div>';
      } else if (m.status === 'completed') {
        const linkedPlan = _findLinkedPlan(m);
        html += '<div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:8px">' +
          (linkedPlan
            ? '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--blue);border-color:var(--blue)" onclick="_viewPlanWithBack(\'' + escHtml(linkedPlan.file) + '\',\'' + escHtml(m.id) + '\')">View Plan</button>' +
              '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green)" onclick="_createPlanFromMeeting(\'' + escHtml(m.id) + '\',this)">New Plan</button>'
            : '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--green);border-color:var(--green)" onclick="_createPlanFromMeeting(\'' + escHtml(m.id) + '\',this)">Create Plan from Meeting</button>') +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="_archiveMeeting(\'' + escHtml(m.id) + '\')">Archive</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_deleteMeeting(\'' + escHtml(m.id) + '\')">Delete</button>' +
        '</div>' +
        '<div style="font-size:9px;color:var(--muted);margin-top:4px">Use the Q&amp;A below to discuss action items' + (linkedPlan ? '' : ', then create a plan to execute them') + '.</div>';
      } else {
        html += '<div style="display:flex;gap:8px;border-top:1px solid var(--border);padding-top:8px">' +
          '<input id="meeting-note-input" type="text" placeholder="Add context for all agents..." style="flex:1;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:12px" onkeydown="if(event.key===\'Enter\')_submitMeetingNote(\'' + escHtml(m.id) + '\')">' +
          '<button onclick="_submitMeetingNote(\'' + escHtml(m.id) + '\',this)" style="padding:6px 12px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:11px">Add Note</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow);border-color:var(--yellow)" onclick="_advanceMeeting(\'' + escHtml(m.id) + '\',this)">Skip to Next Round</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_endMeeting(\'' + escHtml(m.id) + '\',this)">End Meeting</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_deleteMeeting(\'' + escHtml(m.id) + '\')">Delete</button>' +
        '</div>';
      }

      html += '</div>';

      document.getElementById('modal-title').textContent = 'Meeting: ' + m.title;
      var body = document.getElementById('modal-body');
      var scrollTop = body.scrollTop;
      body.innerHTML = html;
      body.style.fontFamily = "'Segoe UI', system-ui, sans-serif";
      body.style.whiteSpace = 'normal';
      body.scrollTop = scrollTop;

      // Wire up doc-chat Q&A panel for the meeting transcript
      const transcript = (m.transcript || []).map(t =>
        '### ' + (t.agent || 'agent') + ' (' + (t.type || '') + ', Round ' + (t.round || '?') + ')\n\n' + (t.content || '')
      ).join('\n\n---\n\n');
      const meetingDoc = '# Meeting: ' + m.title + '\n\n**Agenda:** ' + m.agenda + '\n\n' + transcript;
      _modalDocContext = { title: 'Meeting: ' + m.title, content: meetingDoc, selection: '' };
      // Always set filePath so doc-chat detects this as a meeting (uses Sonnet with tools).
      // Server-side handleDocChat prevents writes to completed meeting JSON.
      _modalFilePath = 'meetings/' + m.id + '.json';
      try { showModalQa(); } catch { /* expected if QA not loaded */ }

      document.getElementById('modal').classList.add('open');
}

function openMeetingDetail(id) {
  _stopMeetingPoll();
  fetch('/api/meetings/' + encodeURIComponent(id))
    .then(r => r.json())
    .then(data => {
      if (!data.meeting) { alert('Meeting not found'); return; }
      _lastMeetingHash = JSON.stringify(data.meeting);
      _renderMeetingDetail(data.meeting);

      // Live-poll while modal is open
      _meetingPollId = id;
      _meetingPollInterval = setInterval(function() {
        if (!document.getElementById('modal')?.classList?.contains('open') || _meetingPollId !== id) {
          _stopMeetingPoll(); return;
        }
        fetch('/api/meetings/' + encodeURIComponent(id))
          .then(r => r.json())
          .then(d => {
            if (d.meeting && _meetingPollId === id) {
              const hash = JSON.stringify(d.meeting);
              if (hash === _lastMeetingHash) return; // no change — skip re-render
              _lastMeetingHash = hash;
              _renderMeetingDetail(d.meeting);
            }
          })
          .catch(function() {});
      }, 3000);
    })
    .catch(e => alert('Error: ' + e.message));
}

function openCreateMeetingModal() {
  const agentOpts = (typeof cmdAgents !== 'undefined' ? cmdAgents : []).map(a =>
    '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" value="' + escHtml(a.id) + '" checked style="accent-color:var(--blue)"> ' + escHtml(a.name) + ' (' + escHtml(a.role || '') + ')</label>'
  ).join('');
  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  document.getElementById('modal-title').textContent = 'New Team Meeting';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title<input id="mtg-title" style="' + inputStyle + '" placeholder="e.g. Should we add SQLite?"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Agenda<textarea id="mtg-agenda" rows="4" style="' + inputStyle + ';resize:vertical" placeholder="What should agents investigate and debate? Be specific about the question to resolve."></textarea></label>' +
      '<div style="color:var(--text);font-size:var(--text-md)">Participants<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px" id="mtg-participants">' + agentOpts + '</div></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitCreateMeeting()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Start Meeting</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function _submitCreateMeeting() {
  var btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
  const title = document.getElementById('mtg-title')?.value?.trim();
  const agenda = document.getElementById('mtg-agenda')?.value?.trim();
  if (!title || !agenda) { if (btn) { btn.disabled = false; btn.textContent = 'Start Meeting'; } alert('Title and agenda required'); return; }
  const checks = document.querySelectorAll('#mtg-participants input[type="checkbox"]:checked');
  const participants = [...checks].map(c => c.value);
  if (participants.length < 2) { if (btn) { btn.disabled = false; btn.textContent = 'Start Meeting'; } alert('Select at least 2 participants'); return; }
  try { closeModal(); } catch { /* expected */ }
  showToast('cmd-toast', 'Meeting started with ' + participants.length + ' agents', true);
  try {
    const res = await fetch('/api/meetings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, agenda, participants })
    });
    const data = await res.json();
    if (res.ok) { wakeEngine(); refresh(); }
    else { showToast('cmd-toast', 'Failed: ' + (data.error || 'unknown'), false); openCreateMeetingModal(); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); openCreateMeetingModal(); }
}

async function _submitMeetingNote(id, btn) {
  const input = document.getElementById('meeting-note-input');
  if (!input?.value?.trim()) return;
  const note = input.value.trim();
  input.value = '';
  if (btn) { btn.textContent = 'Adding...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Note added', true);
  try {
    const res = await fetch('/api/meetings/note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, note })
    });
    if (res.ok) { /* already toasted */ }
    else { input.value = note; showToast('cmd-toast', 'Failed to add note', false); }
  } catch (e) { input.value = note; showToast('cmd-toast', 'Error: ' + e.message, false); }
  if (btn) { btn.textContent = 'Add Note'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
}

async function _advanceMeeting(id, btn) {
  if (!confirm('Skip to next round? Agents that haven\'t finished will be skipped.')) return;
  if (btn) { btn.textContent = 'Advancing...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Advanced to next round', true);
  try {
    const res = await fetch('/api/meetings/advance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (res.ok) {
      wakeEngine();
    } else {
      const d = await res.json().catch(function() { return {}; });
      showToast('cmd-toast', 'Advance failed: ' + (d.error || 'unknown'), false);
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); }
  if (btn) { btn.textContent = 'Skip to Next Round'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
}

async function _endMeeting(id, btn) {
  if (!confirm('End this meeting? Current round will be stopped.')) return;
  if (btn) { btn.textContent = 'Ending...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  showToast('cmd-toast', 'Meeting ended', true);
  try {
    const res = await fetch('/api/meetings/end', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (res.ok) { /* already toasted */ }
    else {
      const d = await res.json().catch(function() { return {}; });
      showToast('cmd-toast', 'End failed: ' + (d.error || 'unknown'), false);
      if (btn) { btn.textContent = 'End Meeting'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
    }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); if (btn) { btn.textContent = 'End Meeting'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
}

async function _archiveMeeting(id) {
  markDeleted('mtg:' + id);
  try { closeModal(); } catch { /* may not be open */ }
  document.querySelectorAll('[onclick*="openMeetingDetail(\'' + id + '\')"]').forEach(function(el) { el.remove(); });
  showToast('cmd-toast', 'Meeting archived', true);
  try {
    const res = await fetch('/api/meetings/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) { _deletedIds.delete('mtg:' + id); const d = await res.json().catch(() => ({})); showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false); refresh(); }
  } catch (e) { _deletedIds.delete('mtg:' + id); showToast('cmd-toast', 'Error: ' + e.message, false); refresh(); }
}

async function _unarchiveMeeting(id) {
  try { closeModal(); } catch { /* may not be open */ }
  document.querySelectorAll('[onclick*="openMeetingDetail(\'' + id + '\')"]').forEach(function(el) { el.remove(); });
  showToast('cmd-toast', 'Meeting unarchived', true);
  try {
    const res = await fetch('/api/meetings/unarchive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); showToast('cmd-toast', 'Unarchive failed: ' + (d.error || 'unknown'), false); refresh(); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); refresh(); }
}

function _viewPlanWithBack(file, meetingId) {
  _stopMeetingPoll();
  planView(file);
  // After modal opens, prepend a back button to return to meeting
  setTimeout(function() {
    const title = document.getElementById('modal-title');
    if (title && !title.querySelector('.mtg-back-btn')) {
      const back = document.createElement('button');
      back.className = 'pr-pager-btn mtg-back-btn';
      back.style.cssText = 'font-size:9px;padding:2px 8px;margin-right:8px;vertical-align:middle';
      back.textContent = '\u2190 Back to Meeting';
      back.onclick = function() { openMeetingDetail(meetingId); };
      title.prepend(back);
    }
  }, 100);
}

function _findLinkedPlan(meeting) {
  var plans = window._lastStatus?.plans || [];
  // Check 1: regex in conclusion text (agent may reference plan path)
  if (meeting?.conclusion?.content) {
    var match = meeting.conclusion.content.match(/plans\/([\w-]+\.md)/);
    if (match) {
      var file = match[1];
      return plans.find(function(p) { return p.file === file; }) || { file, summary: file };
    }
  }
  // Check 2: title-slug filename match (dashboard naming convention: "meeting-follow-up-{title}")
  if (meeting?.title) {
    var titleSlug = ('Meeting follow-up: ' + meeting.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    var found = plans.find(function(p) { return p.file && p.file.startsWith(titleSlug); });
    if (found) return found;
  }
  return null;
}

async function _createPlanFromMeeting(id, btn) {
  if (btn) { btn.dataset.origText = btn.textContent; btn.textContent = 'Checking...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  function resetBtn() { if (btn) { btn.textContent = btn.dataset.origText || 'Create Plan'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } }
  try {
    const res = await fetch('/api/meetings/' + encodeURIComponent(id));
    const data = await res.json();
    if (!data.meeting) { resetBtn(); showToast('cmd-toast', 'Meeting not found', false); return; }
    const m = data.meeting;

    // Check if a plan already exists for this meeting
    const existing = _findLinkedPlan(m);
    if (existing) {
      resetBtn();
      if (!confirm('A plan already exists: "' + existing.summary + '"\n\nCreate a new one anyway?')) return;
    }

    if (btn) btn.textContent = 'Generating plan...';
    showToast('cmd-toast', 'Generating plan from meeting...', true);

    // Use doc-chat to generate a structured plan from the meeting
    const transcript = (m.transcript || []).map(function(t) {
      return '### ' + (t.agent || 'agent') + ' (' + (t.type || '') + ', Round ' + (t.round || '?') + ')\n\n' + (t.content || '');
    }).join('\n\n---\n\n');
    const meetingDoc = '# Meeting: ' + m.title + '\n\n**Agenda:** ' + m.agenda + '\n\n' + transcript;

    // Include Q&A thread if present
    let humanContext = '';
    const qaThread = document.getElementById('modal-qa-thread');
    if (qaThread) {
      const qaText = qaThread.innerText.trim();
      if (qaText.length > 20) humanContext = '\n\n## Human Discussion\n\n' + qaText.slice(0, 3000);
    }

    const genRes = await fetch('/api/doc-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Create an actionable implementation plan from this meeting. Extract concrete action items from the conclusion and debates. For each item include: what to do, which files/areas to change, priority (high/medium/low), and estimated complexity (small/medium/large). Structure it as a plan ready for execution. Do NOT include preamble — start with the plan title.' + humanContext,
        document: meetingDoc,
        title: 'Meeting: ' + m.title,
        freshSession: true,
      })
    });
    const genData = await genRes.json();
    if (!genRes.ok || !genData.ok) { resetBtn(); showToast('cmd-toast', 'Failed to generate plan: ' + (genData.error || 'unknown'), false); return; }

    const planContent = genData.answer || '';
    // Guard: reject doc-chat meta-responses that aren't plan content
    if (!planContent.trim() || !/^(#|\*\*|[-*] )/.test(planContent.trim())) {
      resetBtn();
      showToast('cmd-toast', 'Generated content does not look like a plan — try again', false);
      return;
    }
    const title = 'Meeting follow-up: ' + (m.title || id);
    const planRes = await fetch('/api/plans/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content: planContent, meetingId: id })
    });
    const planData = await planRes.json();
    if (planRes.ok && planData.ok) {
      showToast('cmd-toast', 'Plan created: ' + planData.file, true);
      if (btn) {
        btn.textContent = 'Plan created';
        btn.style.color = 'var(--green)';
        btn.style.borderColor = 'var(--green)';
        btn.style.opacity = '1';
        const viewLink = document.createElement('button');
        viewLink.className = 'pr-pager-btn';
        viewLink.style.cssText = 'font-size:9px;padding:2px 8px;color:var(--blue);border-color:var(--blue);pointer-events:auto';
        viewLink.textContent = 'View Plan';
        viewLink.onclick = function() { _viewPlanWithBack(planData.file, id); };
        btn.parentElement.insertBefore(viewLink, btn.nextSibling);
      }
    } else {
      resetBtn();
      showToast('cmd-toast', 'Failed: ' + (planData.error || 'unknown'), false);
    }
  } catch (e) { resetBtn(); showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function _deleteMeeting(id) {
  if (!confirm('Delete this meeting? This cannot be undone.')) return;
  markDeleted('mtg:' + id);
  try { closeModal(); } catch { /* may not be open */ }
  document.querySelectorAll('[onclick*="openMeetingDetail(\'' + id + '\')"]').forEach(function(el) { el.remove(); });
  showToast('cmd-toast', 'Meeting deleted', true);
  try {
    const res = await fetch('/api/meetings/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); showToast('cmd-toast', 'Failed: ' + (d.error || 'unknown'), false); refresh(); }
  } catch (e) { showToast('cmd-toast', 'Error: ' + e.message, false); refresh(); }
}

window.MinionsMeetings = { renderMeetings, openMeetingDetail, openCreateMeetingModal };
