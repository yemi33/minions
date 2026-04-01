// dashboard/js/render-work-items.js — Work item rendering and management extracted from dashboard.html

let allWorkItems = [];
let wiPage = 0;
const WI_PER_PAGE = 20;

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
  return '<tr style="cursor:pointer" onclick="openWorkItemDetail(\'' + escHtml(item.id) + '\')">' +
    '<td><span class="pr-id">' + escHtml(item.id || '') + '</span></td>' +
    '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(item.description || item.title || '') + '">' + escHtml(item.title || '') + '</td>' +
    '<td><span style="font-size:10px;color:var(--muted)">' + escHtml(item._source || '') + '</span>' +
      (item.scope === 'fan-out' ? ' <span class="pr-badge ' + (item.status === 'done' || item.status === 'failed' ? 'draft' : 'building') + '" style="font-size:8px">fan-out</span>' : '') + '</td>' +
    '<td>' + typeBadge(item.type) + '</td>' +
    '<td>' + priBadge(item.priority) + '</td>' +
    '<td>' + statusBadge(item.status || 'pending') +
      (item._pendingReason ? ' <span style="font-size:9px;color:var(--muted);margin-left:4px" title="Pending reason: ' + escHtml(item._pendingReason) + '">' + escHtml(item._pendingReason.replace(/_/g, ' ')) + '</span>' : '') +
      (item.status === 'failed' ? ' <button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--yellow);border-color:var(--yellow);margin-left:4px" onclick="event.stopPropagation();retryWorkItem(\'' + escHtml(item.id) + '\',\'' + escHtml(item._source || '') + '\',this)">Retry</button>' : '') +
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
  items = items.filter(function(w) { return !isDeleted('wi:' + w.id); });
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
  const agentOpts = (cmdAgents || []).map(a => '<option value="' + escHtml(a.id) + '"' + (item.agent === a.id ? ' selected' : '') + '>' + escHtml(a.name) + '</option>').join('');
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
  try { closeModal(); } catch { /* may not be open */ }
  showToast('cmd-toast', 'Work item updated', true);
  try {
    const res = await fetch('/api/work-items/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined, title, description, type, priority, agent, references, acceptanceCriteria })
    });
    if (res.ok) { refresh(); } else { const d = await res.json().catch(() => ({})); alert('Update failed: ' + (d.error || 'unknown')); editWorkItem(id, source); }
  } catch (e) { alert('Update error: ' + e.message); editWorkItem(id, source); }
}

async function deleteWorkItem(id, source) {
  if (!confirm('Delete work item ' + id + '? This will kill any running agent and remove all dispatch history.')) return;
  markDeleted('wi:' + id);
  var wiTable = document.getElementById('work-items-content');
  (wiTable || document).querySelectorAll('tr').forEach(function(r) { if (r.textContent.includes(id)) r.remove(); });
  try {
    const res = await fetch('/api/work-items/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert('Delete failed: ' + (d.error || 'unknown')); refresh(); }
  } catch (e) { alert('Delete error: ' + e.message); refresh(); }
}

async function archiveWorkItem(id, source) {
  markDeleted('wi:' + id);
  var wiTable = document.getElementById('work-items-content');
  (wiTable || document).querySelectorAll('tr').forEach(function(r) { if (r.textContent.includes(id)) r.remove(); });
  showToast('cmd-toast', 'Archived ' + id, true);
  try {
    const res = await fetch('/api/work-items/archive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert('Archive failed: ' + (d.error || 'unknown')); refresh(); return; }
  } catch (e) { alert('Archive error: ' + e.message); refresh(); }
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

async function retryWorkItem(id, source, btn) {
  if (btn) { btn.dataset.origText = btn.textContent; btn.textContent = 'Retrying...'; btn.style.pointerEvents = 'none'; btn.style.opacity = '0.6'; }
  try {
    const res = await fetch('/api/work-items/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source: source || undefined })
    });
    if (res.ok) {
      showToast('cmd-toast', 'Work item ' + id + ' reset to pending', true);
      wakeEngine();
      refresh();
    } else {
      if (btn) { btn.textContent = btn.dataset.origText || 'Retry'; btn.style.pointerEvents = ''; btn.style.opacity = ''; }
      const d = await res.json().catch(() => ({}));
      alert('Retry failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { if (btn) { btn.textContent = btn.dataset.origText || 'Retry'; btn.style.pointerEvents = ''; btn.style.opacity = ''; } alert('Retry error: ' + e.message); }
}

function wiPrev() { if (wiPage > 0) { wiPage--; renderWorkItems(allWorkItems); } }
function wiNext() { const tp = Math.ceil(allWorkItems.length / WI_PER_PAGE); if (wiPage < tp-1) { wiPage++; renderWorkItems(allWorkItems); } }

let _feedbackRating = null;
function feedbackWorkItem(id, source) {
  _feedbackRating = null;
  document.getElementById('modal-title').textContent = 'Feedback on ' + id;
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:16px">' +
      '<div style="display:flex;gap:16px;justify-content:center">' +
        '<button id="fb-up" onclick="_selectRating(\'up\')" style="font-size:36px;background:none;border:2px solid var(--border);border-radius:12px;padding:12px 20px;cursor:pointer;transition:all 0.2s">&#x1F44D;</button>' +
        '<button id="fb-down" onclick="_selectRating(\'down\')" style="font-size:36px;background:none;border:2px solid var(--border);border-radius:12px;padding:12px 20px;cursor:pointer;transition:all 0.2s">&#x1F44E;</button>' +
      '</div>' +
      '<textarea id="feedback-comment" rows="3" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:inherit;resize:vertical" placeholder="What was good or needs improvement?"></textarea>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button id="fb-send" onclick="submitFeedback(\'' + escHtml(id) + '\',\'' + escHtml(source) + '\')" style="padding:6px 16px;background:var(--surface2);color:var(--muted);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:not-allowed" disabled>Select rating first</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}
function _selectRating(r) {
  _feedbackRating = r;
  document.getElementById('fb-up').style.borderColor = r === 'up' ? 'var(--green)' : 'var(--border)';
  document.getElementById('fb-up').style.background = r === 'up' ? 'rgba(63,185,80,0.1)' : 'none';
  document.getElementById('fb-down').style.borderColor = r === 'down' ? 'var(--red)' : 'var(--border)';
  document.getElementById('fb-down').style.background = r === 'down' ? 'rgba(248,81,73,0.1)' : 'none';
  const btn = document.getElementById('fb-send');
  btn.disabled = false;
  btn.style.background = 'var(--blue)';
  btn.style.color = '#fff';
  btn.style.cursor = 'pointer';
  btn.style.borderColor = 'var(--blue)';
  btn.textContent = 'Send Feedback';
}

async function submitFeedback(id, source) {
  const rating = _feedbackRating;
  if (!rating) { alert('Please select a rating first'); return; }
  const comment = document.getElementById('feedback-comment')?.value || '';
  try { closeModal(); } catch { /* may not be open */ }
  showToast('cmd-toast', 'Feedback saved — agents will learn from it', true);
  try {
    const res = await fetch('/api/work-items/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, source, rating, comment })
    });
    if (res.ok) { refresh(); } else { const d = await res.json().catch(() => ({})); alert('Feedback failed: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

function openCreateWorkItemModal() {
  const typeOpts = ['implement', 'fix', 'explore', 'test', 'review', 'ask', 'plan'].map(t =>
    '<option value="' + t + '"' + (t === 'implement' ? ' selected' : '') + '>' + t + '</option>'
  ).join('');
  const priOpts = ['high', 'medium', 'low'].map(p =>
    '<option value="' + p + '"' + (p === 'medium' ? ' selected' : '') + '>' + p + '</option>'
  ).join('');
  const agentOpts = (typeof cmdAgents !== 'undefined' ? cmdAgents : []).map(a =>
    '<option value="' + escHtml(a.id) + '">' + escHtml(a.name) + '</option>'
  ).join('');
  const projOpts = (typeof cmdProjects !== 'undefined' ? cmdProjects : []).map(p =>
    '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>'
  ).join('');
  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  document.getElementById('modal-title').textContent = 'Create Work Item';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title <input id="wi-new-title" style="' + inputStyle + '" placeholder="What needs to be done?"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Description <textarea id="wi-new-desc" rows="3" style="' + inputStyle + ';resize:vertical" placeholder="Detailed description..."></textarea></label>' +
      '<div style="display:flex;gap:8px">' +
        '<label style="flex:1;color:var(--text);font-size:var(--text-md)">Type <select id="wi-new-type" style="' + inputStyle + '">' + typeOpts + '</select></label>' +
        '<label style="flex:1;color:var(--text);font-size:var(--text-md)">Priority <select id="wi-new-priority" style="' + inputStyle + '">' + priOpts + '</select></label>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<label style="flex:1;color:var(--text);font-size:var(--text-md)">Agent <select id="wi-new-agent" style="' + inputStyle + '"><option value="">Auto</option>' + agentOpts + '</select></label>' +
        '<label style="flex:1;color:var(--text);font-size:var(--text-md)">Project <select id="wi-new-project" style="' + inputStyle + '"><option value="">Central</option>' + projOpts + '</select></label>' +
      '</div>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Acceptance Criteria <textarea id="wi-new-ac" rows="2" style="' + inputStyle + ';resize:vertical" placeholder="One criterion per line (optional)"></textarea></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">References <textarea id="wi-new-refs" rows="2" style="' + inputStyle + ';resize:vertical" placeholder="url | title | type — one per line (optional)"></textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitCreateWorkItem()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Create</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('wi-new-title')?.focus(), 100);
}

async function _submitCreateWorkItem() {
  const title = document.getElementById('wi-new-title')?.value?.trim();
  if (!title) { alert('Title is required'); return; }
  const desc = document.getElementById('wi-new-desc')?.value || '';
  const type = document.getElementById('wi-new-type')?.value || 'implement';
  const priority = document.getElementById('wi-new-priority')?.value || 'medium';
  const agent = document.getElementById('wi-new-agent')?.value || '';
  const project = document.getElementById('wi-new-project')?.value || '';
  const acRaw = document.getElementById('wi-new-ac')?.value || '';
  const acceptanceCriteria = acRaw.split('\n').map(l => l.trim()).filter(Boolean);
  const refsRaw = document.getElementById('wi-new-refs')?.value || '';
  const references = refsRaw.split('\n').filter(l => l.trim()).map(l => {
    const parts = l.split('|').map(s => s.trim());
    return { url: parts[0], title: parts[1] || parts[0], type: parts[2] || 'link' };
  });

  try {
    const body = { title, description: desc, type, priority };
    if (agent) body.agents = [agent];
    if (project) body.project = project;
    if (acceptanceCriteria.length) body.acceptanceCriteria = acceptanceCriteria;
    if (references.length && references[0].url) body.references = references;

    try { closeModal(); } catch { /* expected */ }
    showToast('cmd-toast', 'Creating work item...', true);
    const res = await fetch('/api/work-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      wakeEngine();
      refresh();
      showToast('cmd-toast', 'Work item ' + (data.id || '') + ' created', true);
    } else {
      alert('Failed: ' + (data.error || 'unknown'));
      openCreateWorkItemModal();
    }
  } catch (e) { alert('Error: ' + e.message); openCreateWorkItemModal(); }
}

function openWorkItemDetail(id) {
  const item = allWorkItems.find(i => i.id === id);
  if (!item) return;

  const field = (label, value) => value ? '<div style="margin-bottom:8px"><span style="color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</span><div style="margin-top:2px">' + value + '</div></div>' : '';
  const badge = (cls, text) => '<span class="pr-badge ' + cls + '">' + escHtml(text) + '</span>';
  const statusCls = item.status === 'failed' ? 'rejected' : item.status === 'dispatched' ? 'building' : item.status === 'done' ? 'approved' : 'active';

  let html = '<div style="display:flex;flex-direction:column;gap:4px;font-size:13px">';
  html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
    badge(statusCls, item.status || 'pending') + ' ' +
    '<span class="dispatch-type ' + (item.type || 'implement') + '">' + escHtml(item.type || 'implement') + '</span>' +
    '<span class="prd-item-priority ' + (item.priority || '') + '">' + escHtml(item.priority || 'medium') + '</span>' +
    '</div>';
  html += field('Description', '<div style="font-size:12px">' + renderMd(item.description || item.title || '—') + '</div>');
  html += field('Agent', escHtml(item.dispatched_to || item.agent || 'Auto'));
  html += field('Source', escHtml(item._source || 'central'));
  if (item.created) html += field('Created', escHtml(new Date(item.created).toLocaleString()));
  if (item.dispatched_at) html += field('Dispatched', escHtml(new Date(item.dispatched_at).toLocaleString()) + ' to ' + escHtml(item.dispatched_to || '?'));
  if (item.completedAt) html += field('Completed', escHtml(new Date(item.completedAt).toLocaleString()));
  if (item.failReason) html += field('Failure Reason', '<span style="color:var(--red)">' + escHtml(item.failReason) + '</span>');
  if (item._pendingReason) html += field('Pending Reason', escHtml(item._pendingReason.replace(/_/g, ' ')));
  if (item.depends_on?.length) html += field('Depends On', item.depends_on.map(d => '<code>' + escHtml(d) + '</code>').join(', '));
  if (item.acceptanceCriteria?.length) html += field('Acceptance Criteria', '<ul style="margin:0;padding-left:20px">' + item.acceptanceCriteria.map(c => '<li>' + escHtml(c) + '</li>').join('') + '</ul>');
  if (item.references?.length) html += field('References', item.references.map(r => '<a href="' + escHtml(r.url) + '" target="_blank" style="color:var(--blue)">' + escHtml(r.title || r.url) + '</a>' + (r.type ? ' <span style="color:var(--muted);font-size:10px">(' + escHtml(r.type) + ')</span>' : '')).join('<br>'));
  if (item._humanFeedback) html += field('Human Feedback', (item._humanFeedback.rating === 'up' ? '👍' : '👎') + (item._humanFeedback.comment ? ' — ' + escHtml(item._humanFeedback.comment) : ''));
  if (item._pr) html += field('Pull Request', '<a href="' + escHtml(item._prUrl || '#') + '" target="_blank" style="color:var(--blue)">' + escHtml(item._pr) + '</a>');
  html += '</div>';

  document.getElementById('modal-title').textContent = item.title || item.id;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
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

window.MinionsWork = { wiRow, renderWorkItems, editWorkItem, submitWorkItemEdit, deleteWorkItem, archiveWorkItem, toggleWorkItemArchive, retryWorkItem, wiPrev, wiNext, feedbackWorkItem, submitFeedback, openCreateWorkItemModal, openWorkItemDetail, openAllWorkItems };
