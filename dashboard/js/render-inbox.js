// render-inbox.js — Inbox and notes rendering functions extracted from dashboard.html

function renderInbox(inbox) {
  inboxData = inbox;
  const list = document.getElementById('inbox-list');
  const count = document.getElementById('inbox-count');
  count.textContent = inbox.length;
  if (!inbox.length) { list.innerHTML = '<p class="empty">No messages yet.</p>'; return; }
  list.innerHTML = inbox.map((item, i) => `
    <div class="inbox-item" data-file="notes/inbox/${escHtml(item.name)}">
      <div class="inbox-name" onclick="openModal(${i})" style="cursor:pointer">
        <span>${escHtml(item.name)}</span><span>${item.age}</span>
      </div>
      <div class="inbox-preview" onclick="openModal(${i})" style="cursor:pointer">${escHtml(item.content.slice(0,200))}</div>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="event.stopPropagation();promoteToKB('${escHtml(item.name)}')">Add to Knowledge Base</button>
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" onclick="event.stopPropagation();openInboxInExplorer('${escHtml(item.name)}')">Open in Explorer</button>
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red)" onclick="event.stopPropagation();deleteInboxItem('${escHtml(item.name)}')">Delete</button>
      </div>
    </div>
  `).join('');
  restoreNotifBadges();
}

function promoteToKB(name) {
  const categories = [
    { id: 'architecture', label: 'Architecture' },
    { id: 'conventions', label: 'Conventions' },
    { id: 'project-notes', label: 'Project Notes' },
    { id: 'build-reports', label: 'Build Reports' },
    { id: 'reviews', label: 'Reviews' },
  ];
  const picker = '<div style="padding:16px 20px">' +
    '<p style="font-size:13px;color:var(--text);margin-bottom:12px">Choose a category for <strong>' + escHtml(name) + '</strong>:</p>' +
    '<div style="display:flex;flex-direction:column;gap:8px">' +
    categories.map(c =>
      '<button class="pr-pager-btn" style="font-size:12px;padding:8px 16px;text-align:left" onclick="doPromoteToKB(\'' + escHtml(name) + '\',\'' + c.id + '\')">' + c.label + '</button>'
    ).join('') +
    '</div></div>';
  document.getElementById('modal-title').textContent = 'Add to Knowledge Base';
  document.getElementById('modal-body').innerHTML = picker;
  document.getElementById('modal').classList.add('open');
}

function renderNotes(notes) {
  const el = document.getElementById('notes-list');
  const content = typeof notes === 'object' ? notes.content : notes;
  const updatedAt = typeof notes === 'object' ? notes.updatedAt : null;

  // Show last updated timestamp
  const updatedEl = document.getElementById('notes-updated');
  if (updatedEl && updatedAt) {
    const d = new Date(updatedAt);
    updatedEl.textContent = 'updated ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  if (!content || !content.trim()) { el.innerHTML = '<p class="empty">No team notes yet.</p>'; return; }
  el.innerHTML = '<div class="notes-preview" onclick="openNotesModal()" title="Click to expand">' + escHtml(content) + '</div>';
}

function openNotesModal() {
  const preview = document.querySelector('.notes-preview');
  if (!preview) return;
  const content = preview.textContent;
  document.getElementById('modal-title').textContent = 'Team Notes';
  document.getElementById('modal-body').textContent = content;
  document.getElementById('modal-body').style.fontFamily = 'Consolas, monospace';
  document.getElementById('modal-body').style.whiteSpace = 'pre-wrap';
  _modalDocContext = { title: 'Team Notes', content, selection: '' };
  _modalEditable = 'notes.md';
  _modalFilePath = 'notes.md'; showModalQa();
  document.getElementById('modal-edit-btn').style.display = '';
  // steer btn removed — unified send
  document.getElementById('modal').classList.add('open');
}

function modalToggleEdit() {
  const body = document.getElementById('modal-body');
  body.contentEditable = 'true';
  body.style.border = '1px solid var(--blue)';
  body.style.borderRadius = '4px';
  body.style.padding = '12px';
  body.style.outline = 'none';
  body.focus();
  document.getElementById('modal-edit-btn').style.display = 'none';
  document.getElementById('modal-save-btn').style.display = '';
  document.getElementById('modal-cancel-edit-btn').style.display = '';
}

async function modalSaveEdit() {
  if (!_modalEditable) return;
  const body = document.getElementById('modal-body');
  const content = body.innerText;

  try {
    const res = await fetch('/api/notes-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: _modalEditable, content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    body.contentEditable = 'false';
    body.style.border = '';
    body.style.padding = '';
    document.getElementById('modal-edit-btn').style.display = '';
    document.getElementById('modal-save-btn').style.display = 'none';
    document.getElementById('modal-cancel-edit-btn').style.display = 'none';
    _modalDocContext.content = content;
    showToast('cmd-toast', 'Team Notes saved', true);
  } catch (e) {
    showToast('cmd-toast', 'Error: ' + e.message, false);
  }
}

function modalCancelEdit() {
  const body = document.getElementById('modal-body');
  body.contentEditable = 'false';
  body.textContent = _modalDocContext.content; // revert
  body.style.border = '';
  body.style.padding = '';
  document.getElementById('modal-edit-btn').style.display = '';
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-cancel-edit-btn').style.display = 'none';
}

async function deleteInboxItem(name) {
  if (!confirm('Delete "' + name + '" from inbox?')) return;
  try {
    const res = await fetch('/api/inbox/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (res.ok) { refresh(); } else { const d = await res.json(); alert('Failed: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

async function openInboxInExplorer(name) {
  try {
    await fetch('/api/inbox/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  } catch (e) { console.error('inbox open:', e.message); }
}

function openQuickNoteModal() {
  document.getElementById('modal-title').textContent = 'Quick Note';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title' +
        '<input id="note-title" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)" placeholder="Decision, observation, or context..."></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Content' +
        '<textarea id="note-content" rows="6" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);resize:vertical;font-family:inherit" placeholder="Write your note... Agents will see this after consolidation."></textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="submitQuickNote()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Save Note</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitQuickNote() {
  const titleEl = document.getElementById('note-title');
  const contentEl = document.getElementById('note-content');
  if (!titleEl || !contentEl) { alert('Form elements not found'); return; }
  const title = titleEl.value;
  const content = contentEl.value;
  if (!title && !content) { alert('Title or content required'); return; }
  try {
    const res = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'Quick note', what: content || title })
    });
    if (res.ok) {
      try { closeModal(); } catch { /* expected */ }
      refresh();
      try { showToast('cmd-toast', 'Note saved to inbox', true); } catch { /* expected */ }
    }
    else { const d = await res.json().catch(() => ({})); alert('Error: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error saving note: ' + e.message); }
}

async function doPromoteToKB(name, category) {
  try {
    const res = await fetch('/api/inbox/promote-kb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category })
    });
    const data = await res.json();
    if (res.ok) {
      closeModal();
      refresh();
      refreshKnowledgeBase();
    } else {
      alert('Failed: ' + (data.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}
