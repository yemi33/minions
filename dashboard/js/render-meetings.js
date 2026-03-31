// render-meetings.js — Team meeting rendering

function renderMeetings(meetings) {
  const el = document.getElementById('meetings-content');
  const countEl = document.getElementById('meetings-count');
  if (!meetings || meetings.length === 0) {
    countEl.textContent = '0';
    el.innerHTML = '<p class="empty">No meetings yet. Start one to have agents investigate, debate, and conclude on a topic.</p>';
    return;
  }
  countEl.textContent = meetings.length;

  const statusColors = { investigating: 'var(--blue)', debating: 'var(--purple,#a855f7)', concluding: 'var(--yellow)', completed: 'var(--green)' };
  const statusLabels = { investigating: 'Round 1 — Investigating', debating: 'Round 2 — Debating', concluding: 'Round 3 — Concluding', completed: 'Completed' };

  el.innerHTML = meetings.map(m => {
    const statusColor = statusColors[m.status] || 'var(--muted)';
    const statusLabel = statusLabels[m.status] || m.status;
    const participantBadges = (m.participants || []).map(p => {
      const hasFindings = m.findings?.[p];
      const hasDebate = m.debate?.[p];
      const icon = m.status === 'completed' ? '✓' : m.status === 'debating' ? (hasDebate ? '✓' : (hasFindings ? '⏳' : '○')) : (hasFindings ? '✓' : '⏳');
      return '<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:10px">' + icon + ' ' + escHtml(p) + '</span>';
    }).join(' ');

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer" onclick="openMeetingDetail(\'' + escHtml(m.id) + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:13px">' + escHtml(m.title) + '</strong>' +
        '<span style="color:' + statusColor + ';font-size:11px;font-weight:600">' + statusLabel + '</span>' +
      '</div>' +
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + participantBadges + '</div>' +
      '<div style="margin-top:6px;font-size:11px;color:var(--muted)">' + escHtml((m.agenda || '').slice(0, 100)) + (m.agenda?.length > 100 ? '...' : '') + '</div>' +
    '</div>';
  }).join('');
}

function openMeetingDetail(id) {
  fetch('/api/meetings/' + encodeURIComponent(id))
    .then(r => r.json())
    .then(data => {
      if (!data.meeting) { alert('Meeting not found'); return; }
      const m = data.meeting;
      const statusColors = { investigating: 'var(--blue)', debating: 'var(--purple,#a855f7)', concluding: 'var(--yellow)', completed: 'var(--green)' };
      const statusLabels = { investigating: 'Round 1 — Investigating', debating: 'Round 2 — Debating', concluding: 'Round 3 — Concluding', completed: 'Completed' };

      let html = '<div style="display:flex;flex-direction:column;gap:12px">';

      // Status bar
      html += '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span style="color:' + (statusColors[m.status] || 'var(--muted)') + ';font-weight:600">' + (statusLabels[m.status] || m.status) + '</span>' +
        '<span style="font-size:10px;color:var(--muted)">' + escHtml(m.createdAt?.slice(0, 16).replace('T', ' ') || '') + '</span>' +
      '</div>';

      // Agenda
      html += '<div style="background:var(--surface2);padding:8px 12px;border-radius:6px;font-size:12px">' +
        '<strong>Agenda:</strong> ' + escHtml(m.agenda) + '</div>';

      // Per-agent panels
      for (const agent of (m.participants || [])) {
        html += '<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">';
        html += '<div style="background:var(--surface2);padding:6px 12px;font-weight:600;font-size:12px">' + escHtml(agent) + '</div>';

        // Findings
        if (m.findings?.[agent]) {
          html += '<div style="padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border)">' +
            '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Round 1 — Findings</div>' +
            '<div style="white-space:pre-wrap;word-break:break-word">' + escHtml(m.findings[agent].content?.slice(0, 500) || '') + (m.findings[agent].content?.length > 500 ? '...' : '') + '</div></div>';
        }

        // Debate
        if (m.debate?.[agent]) {
          html += '<div style="padding:8px 12px;font-size:11px;border-bottom:1px solid var(--border)">' +
            '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Round 2 — Debate</div>' +
            '<div style="white-space:pre-wrap;word-break:break-word">' + escHtml(m.debate[agent].content?.slice(0, 500) || '') + (m.debate[agent].content?.length > 500 ? '...' : '') + '</div></div>';
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
          '<div style="font-size:12px;white-space:pre-wrap;word-break:break-word">' + escHtml(m.conclusion.content?.slice(0, 1000) || '') + '</div></div>';
      }

      // Human notes
      if (m.humanNotes?.length > 0) {
        html += '<div style="border-top:1px solid var(--border);padding-top:8px">' +
          '<div style="color:var(--muted);font-size:10px;margin-bottom:4px">Human Notes</div>' +
          m.humanNotes.map(n => '<div style="font-size:11px;margin-bottom:2px">• ' + escHtml(n) + '</div>').join('') +
        '</div>';
      }

      // Actions
      if (m.status !== 'completed') {
        html += '<div style="display:flex;gap:8px;border-top:1px solid var(--border);padding-top:8px">' +
          '<input id="meeting-note-input" type="text" placeholder="Add context for all agents..." style="flex:1;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:12px" onkeydown="if(event.key===\'Enter\')_submitMeetingNote(\'' + escHtml(m.id) + '\')">' +
          '<button onclick="_submitMeetingNote(\'' + escHtml(m.id) + '\')" style="padding:6px 12px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:11px">Add Note</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:4px">' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--yellow);border-color:var(--yellow)" onclick="_advanceMeeting(\'' + escHtml(m.id) + '\')">Skip to Next Round</button>' +
          '<button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red);border-color:var(--red)" onclick="_endMeeting(\'' + escHtml(m.id) + '\')">End Meeting</button>' +
        '</div>';
      }

      html += '</div>';

      document.getElementById('modal-title').textContent = 'Meeting: ' + m.title;
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
      document.getElementById('modal-body').style.whiteSpace = 'normal';
      document.getElementById('modal').classList.add('open');
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
  const title = document.getElementById('mtg-title')?.value?.trim();
  const agenda = document.getElementById('mtg-agenda')?.value?.trim();
  if (!title || !agenda) { alert('Title and agenda required'); return; }
  const checks = document.querySelectorAll('#mtg-participants input[type="checkbox"]:checked');
  const participants = [...checks].map(c => c.value);
  if (participants.length < 2) { alert('Select at least 2 participants'); return; }

  try {
    const res = await fetch('/api/meetings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, agenda, participants })
    });
    const data = await res.json();
    if (res.ok) {
      try { closeModal(); } catch { /* expected */ }
      wakeEngine();
      refresh();
      try { showToast('cmd-toast', 'Meeting started with ' + participants.length + ' agents', true); } catch { /* expected */ }
    } else { alert('Failed: ' + (data.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

async function _submitMeetingNote(id) {
  const input = document.getElementById('meeting-note-input');
  if (!input?.value?.trim()) return;
  try {
    await fetch('/api/meetings/note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, note: input.value.trim() })
    });
    input.value = '';
    openMeetingDetail(id); // refresh the modal
  } catch (e) { alert('Error: ' + e.message); }
}

async function _advanceMeeting(id) {
  if (!confirm('Skip to next round? Agents that haven\'t finished will be skipped.')) return;
  try {
    await fetch('/api/meetings/advance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    wakeEngine();
    openMeetingDetail(id);
  } catch (e) { alert('Error: ' + e.message); }
}

async function _endMeeting(id) {
  if (!confirm('End this meeting? Current round will be stopped.')) return;
  try {
    await fetch('/api/meetings/end', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    try { closeModal(); } catch { /* expected */ }
    refresh();
  } catch (e) { alert('Error: ' + e.message); }
}

window.MinionsMeetings = { renderMeetings, openMeetingDetail, openCreateMeetingModal };
