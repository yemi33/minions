// dashboard/js/render-work-items.js — Work item rendering and management extracted from dashboard.html

let allWorkItems = [];
let wiPage = 0;
const WI_PER_PAGE = 6;

function wiRow(item) {
  const statusBadge = (s) => {
    const cls = s === 'failed' ? 'rejected' : s === 'dispatched' ? 'building' : s === 'pending' || s === 'queued' ? 'active' : s === 'done' ? 'approved' : 'draft';
    return '<span class="pr-badge ' + cls + '">' + escHtml(s) + '</span>';
  };
  const typeBadge = (t) => '<span class="dispatch-type ' + (t || 'implement') + '">' + escHtml(t || 'implement') + '</span>';
  const priBadge = (p) => '<span class="prd-item-priority ' + (p || '') + '">' + escHtml(p || 'medium') + '</span>';
  const prLink = item._pr
    ? '<a class="pr-title" href="' + escHtml(item._prUrl || '#') + '" target="_blank" style="font-size:10px">' + escHtml(item._pr) + '</a>'
    : '<span style="color:var(--muted)">—</span>';
  return '<tr>' +
    '<td><span class="pr-id">' + escHtml(item.id || '') + '</span></td>' +
    '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(item.description || item.title || '') + '">' + escHtml(item.title || '') + '</td>' +
    '<td><span style="font-size:10px;color:var(--muted)">' + escHtml(item._source || '') + '</span>' +
      (item.scope === 'fan-out' ? ' <span class="pr-badge ' + (item.status === 'done' || item.status === 'failed' ? 'draft' : 'building') + '" style="font-size:8px">fan-out</span>' : '') + '</td>' +
    '<td>' + typeBadge(item.type) + '</td>' +
    '<td>' + priBadge(item.priority) + '</td>' +
    '<td>' + statusBadge(item.status || 'pending') +
      (item._pendingReason ? ' <span style="font-size:9px;color:var(--muted);margin-left:4px" title="Pending reason: ' + escHtml(item._pendingReason) + '">' + escHtml(item._pendingReason.replace(/_/g, ' ')) + '</span>' : '') +
      (item.status === 'failed' ? ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--yellow);border-color:var(--yellow);margin-left:4px" onclick="event.stopPropagation();retryWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\')">Retry</button>' : '') +
    '</td>' +
    '<td>' +
      (item.completedAgents && item.completedAgents.length > 0
        ? '<span class="pr-agent">' + escHtml(item.completedAgents.join(', ')) + '</span>'
        : '<span class="pr-agent">' + escHtml(item.dispatched_to || '—') + '</span>') +
      (item.failReason ? '<span style="display:block;font-size:9px;color:var(--red)" title="' + escHtml(item.failReason) + '">' + escHtml(item.failReason.slice(0, 30)) + '</span>' : '') +
    '</td>' +
    '<td>' + prLink + '</td>' +
    '<td><span class="pr-date">' + shortTime(item.created) + '</span></td>' +
    '<td style="white-space:nowrap;font-size:9px;color:var(--muted)">' +
      (item.references && item.references.length ? '<span title="' + item.references.length + ' reference(s)" style="margin-right:4px">&#x1F517;' + item.references.length + '</span>' : '') +
      (item.acceptanceCriteria && item.acceptanceCriteria.length ? '<span title="' + item.acceptanceCriteria.length + ' acceptance criteria">&#x2611;' + item.acceptanceCriteria.length + '</span>' : '') +
    '</td>' +
    '<td style="white-space:nowrap">' +
      ((item.status === 'pending' || item.status === 'failed') ? '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--blue);border-color:var(--blue);margin-right:4px" onclick="event.stopPropagation();editWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\')" title="Edit work item">&#x270E;</button>' : '') +
      ((item.status === 'done' || item.status === 'failed') ? '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--muted);border-color:var(--border);margin-right:4px" onclick="event.stopPropagation();archiveWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\')" title="Archive work item">&#x1F4E6;</button>' : '') +
      ((item.status === 'done' || item.status === 'failed') && !item._humanFeedback ? '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--green);border-color:var(--green);margin-right:4px" onclick="event.stopPropagation();feedbackWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\')" title="Give feedback">&#x1F44D;&#x1F44E;</button>' : (item._humanFeedback ? '<span style="font-size:9px" title="Feedback given">' + (item._humanFeedback.rating === 'up' ? '&#x1F44D;' : '&#x1F44E;') + '</span> ' : '')) +
      '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--red);border-color:var(--red)" onclick="event.stopPropagation();deleteWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\')" title="Delete work item and kill agent">&#x2715;</button>' +
    '</td>' +
  '</tr>';
}

function renderWorkItems(items) {
  // Sort: active/dispatched first, then by most recent activity
  const statusOrder = { dispatched: 0, pending: 1, queued: 1, failed: 2, done: 3 };
  items.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2, sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    const ta = a.completedAt || a.dispatched_at || a.created || '';
    const tb = b.completedAt || b.dispatched_at || b.created || '';
    return tb.localeCompare(ta); // most recent first
  });
  allWorkItems = items;
  const el = document.getElementById('work-items-content');
  const countEl = document.getElementById('wi-count');
  countEl.textContent = items.length;
  if (!items.length) {
    el.innerHTML = '<p class="empty">No work items. Add tasks via Command Center above.</p>';
    return;
  }

  const totalPages = Math.ceil(items.length / WI_PER_PAGE);
  if (wiPage >= totalPages) wiPage = totalPages - 1;
  const start = wiPage * WI_PER_PAGE;
  const pageItems = items.slice(start, start + WI_PER_PAGE);

  let html = '<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>ID</th><th>Title</th><th>Source</th><th>Type</th><th>Priority</th><th>Status</th><th>Agent</th><th>PR</th><th>Created</th><th></th><th></th></tr></thead><tbody>';
  html += pageItems.map(wiRow).join('');
  html += '</tbody></table></div>';

  if (items.length > WI_PER_PAGE) {
    html += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (start+1) + ' to ' + Math.min(start+WI_PER_PAGE, items.length) + ' of ' + items.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (wiPage === 0 ? 'disabled' : '') + '" onclick="wiPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (wiPage >= totalPages-1 ? 'disabled' : '') + '" onclick="wiNext()">Next</button>' +
        '<button class="pr-pager-btn see-all" onclick="openAllWorkItems()">See all ' + items.length + '</button>' +
      '</div>' +
    '</div>';
  }

  el.innerHTML = html;
}

function editWorkItem(id, source) {
  const item = allWorkItems.find(i => i.id === id);
  if (!item) return;
  const types = ['implement', 'fix', 'review', 'plan', 'verify', 'investigate', 'refactor', 'test', 'docs'];
  const priorities = ['critical', 'high', 'medium', 'low'];
  const agentOpts = cmdAgents.map(a => '<option value="' + escHtml(a.id) + '"' + (item.agent === a.id ? ' selected' : '') + '>' + escHtml(a.name) + '</option>').join('');
  const typeOpts = types.map(t => '<option value="' + t + '"' + ((item.type || 'implement') === t ? ' selected' : '') + '>' + t + '</option>').join('');
  const priOpts = priorities.map(p => '<option value="' + p + '"' + ((item.priority || 'medium') === p ? ' selected' : '') + '>' + p + '</option>').join('');

  document.getElementById('modal-title').textContent = 'Edit Work Item ' + id;
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px;font-family:inherit">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title' +
        '<input id="wi-edit-title" value="' + escHtml(item.title || '') + '" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit">' +
      '</label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Description' +
        '<textarea id="wi-edit-desc" rows="3" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit;resize:vertical">' + escHtml(item.description || '') + '</textarea>' +
      '</label>' +
      '<div style="display:flex;gap:12px">' +
        '<label style="color:var(--text);font-size:var(--text-md);flex:1">Type' +
          '<select id="wi-edit-type" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md)">' + typeOpts + '</select>' +
        '</label>' +
        '<label style="color:var(--text);font-size:var(--text-md);flex:1">Priority' +
          '<select id="wi-edit-priority" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md)">' + priOpts + '</select>' +
        '</label>' +
        '<label style="color:var(--text);font-size:var(--text-md);flex:1">Agent' +
          '<select id="wi-edit-agent" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md)"><option value="">Auto</option>' + agentOpts + '</select>' +
        '</label>' +
      '</div>' +
      '<label style="color:var(--text);font-size:var(--text-md)">References (one per line: url | title | type)' +
        '<textarea id="wi-edit-refs" rows="3" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit;resize:vertical">' + escHtml((item.references || []).map(function(r) { return r.url + ' | ' + (r.title || '') + ' | ' + (r.type || 'link'); }).join('\n')) + '</textarea>' +
      '</label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Acceptance Criteria (one per line)' +
        '<textarea id="wi-edit-ac" rows="3" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit;resize:vertical">' + escHtml((item.acceptanceCriteria || []).join('\n')) + '</textarea>' +
      '</label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn" style="padding:6px 16px;font-size:var(--text-md)">Cancel</button>' +
        '<button onclick="submitWorkItemEdit(\'' + escHtml(id) + '\',\'' + escHtml(source || '') + '\')" style="padding:6px 16px;font-size:var(--text-md);background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Save</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitWorkItemEdit(id, source) {
  const title = document.getElementById('wi-edit-title').value.trim();
  const description = document.getElementById('wi-edit-desc').value;
  const type = document.getElementById('wi-edit-type').value;
  const priority = document.getElementById('wi-edit-priority').value;
  const agent = document.getElementById('wi-edit-agent').value;
  const refsRaw = document.getElementById('wi-edit-refs')?.value || '';
  const references = refsRaw.split('\n').filter(function(l) { return l.trim(); }).map(function(l) {
    var parts = l.split('|').map(function(s) { return s.trim(); });
    return { url: parts[0], title: parts[1] || parts[0], type: parts[2] || 'link' };
  });
  const acRaw = document.getElementById('wi-edit-ac')?.value || '';
  const acceptanceCriteria = acRaw.split('\n').filter(function(l) { return l.trim(); });
  if (!title) { alert('Title is required'); return; }
  try {
    const res = await fetch('/api/work-items/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined, title, description, type, priority, agent, references, acceptanceCriteria })
    });
    if (res.ok) { closeModal(); refresh(); showToast('cmd-toast', 'Work item updated', true); } else {
      const d = await res.json();
      alert('Update failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Update error: ' + e.message); }
}

async function deleteWorkItem(id, source) {
  if (!confirm('Delete work item ' + id + '? This will kill any running agent and remove all dispatch history.')) return;
  try {
    const res = await fetch('/api/work-items/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (res.ok) { refresh(); } else {
      const d = await res.json();
      alert('Delete failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Delete error: ' + e.message); }
}

async function archiveWorkItem(id, source) {
  try {
    const res = await fetch('/api/work-items/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (res.ok) { refresh(); } else {
      const d = await res.json();
      alert('Archive failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Archive error: ' + e.message); }
}

let wiArchiveVisible = false;
async function toggleWorkItemArchive() {
  const el = document.getElementById('work-items-archive');
  wiArchiveVisible = !wiArchiveVisible;
  if (!wiArchiveVisible) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<p class="empty">Loading archive...</p>';
  try {
    const items = await fetch('/api/work-items/archive').then(r => r.json());
    if (!items.length) { el.innerHTML = '<p class="empty">No archived work items.</p>'; return; }
    el.innerHTML = '<div style="font-size:10px;color:var(--muted);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Archived (' + items.length + ')</div>' +
      '<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>ID</th><th>Title</th><th>Type</th><th>Status</th><th>Agent</th><th>Archived</th></tr></thead><tbody>' +
      items.map(function(i) {
        return '<tr style="opacity:0.6">' +
          '<td><span class="pr-id">' + escHtml(i.id || '') + '</span></td>' +
          '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(i.title || '') + '</td>' +
          '<td><span class="dispatch-type ' + (i.type || '') + '">' + escHtml(i.type || '') + '</span></td>' +
          '<td style="color:' + (i.status === 'done' ? 'var(--green)' : 'var(--red)') + '">' + escHtml(i.status || '') + '</td>' +
          '<td>' + escHtml(i.dispatched_to || '—') + '</td>' +
          '<td class="pr-date">' + shortTime(i.archivedAt) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  } catch (e) { el.innerHTML = '<p class="empty">Failed to load archive.</p>'; }
}

async function retryWorkItem(id, source) {
  try {
    const res = await fetch('/api/work-items/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (res.ok) { wakeEngine(); refresh(); } else {
      const d = await res.json();
      alert('Retry failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Retry error: ' + e.message); }
}

function wiPrev() { if (wiPage > 0) { wiPage--; renderWorkItems(allWorkItems); } }
function wiNext() { const tp = Math.ceil(allWorkItems.length / WI_PER_PAGE); if (wiPage < tp-1) { wiPage++; renderWorkItems(allWorkItems); } }

function feedbackWorkItem(id, source) {
  document.getElementById('modal-title').textContent = 'Feedback on ' + id;
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:16px;align-items:center">' +
      '<div style="display:flex;gap:24px">' +
        '<button onclick="submitFeedback(\'' + escHtml(id) + '\',\'' + escHtml(source) + '\',\'up\')" style="font-size:40px;background:none;border:2px solid var(--border);border-radius:12px;padding:16px 24px;cursor:pointer;transition:all 0.2s" onmouseover="this.style.borderColor=\'var(--green)\'" onmouseout="this.style.borderColor=\'var(--border)\'">&#x1F44D;</button>' +
        '<button onclick="submitFeedback(\'' + escHtml(id) + '\',\'' + escHtml(source) + '\',\'down\')" style="font-size:40px;background:none;border:2px solid var(--border);border-radius:12px;padding:16px 24px;cursor:pointer;transition:all 0.2s" onmouseover="this.style.borderColor=\'var(--red)\'" onmouseout="this.style.borderColor=\'var(--border)\'">&#x1F44E;</button>' +
      '</div>' +
      '<textarea id="feedback-comment" rows="3" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:inherit;resize:vertical" placeholder="Optional: what was good or needs improvement?"></textarea>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitFeedback(id, source, rating) {
  const comment = document.getElementById('feedback-comment')?.value || '';
  try {
    const res = await fetch('/api/work-items/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source, rating, comment })
    });
    if (res.ok) { closeModal(); refresh(); showToast('cmd-toast', 'Feedback saved — agents will learn from it', true); }
    else { const d = await res.json(); alert('Error: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

function openAllWorkItems() {
  document.getElementById('modal-title').textContent = 'All Work Items (' + allWorkItems.length + ')';
  const html = '<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>ID</th><th>Title</th><th>Source</th><th>Type</th><th>Priority</th><th>Status</th><th>Agent</th><th>PR</th><th>Created</th><th></th><th></th></tr></thead><tbody>' +
    allWorkItems.map(wiRow).join('') + '</tbody></table></div>';
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}
