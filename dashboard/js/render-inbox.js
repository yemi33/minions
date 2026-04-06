// render-inbox.js — Inbox and notes rendering functions extracted from dashboard.html

const INBOX_PER_PAGE = 15;
let _inboxPage = 0;

function _inboxPrev() { if (_inboxPage > 0) { _inboxPage--; renderInbox(inboxData); } }
function _inboxNext() { _inboxPage++; renderInbox(inboxData); }

function renderInbox(inbox) {
  inbox = inbox.filter(function(item) { return !isDeleted('inbox:' + item.name); });
  inboxData = inbox;
  const list = document.getElementById('inbox-list');
  const count = document.getElementById('inbox-count');
  count.textContent = inbox.length;
  if (!inbox.length) { list.innerHTML = '<p class="empty">No messages yet.</p>'; return; }

  const totalInboxPages = Math.ceil(inbox.length / INBOX_PER_PAGE);
  if (_inboxPage >= totalInboxPages) _inboxPage = totalInboxPages - 1;
  if (_inboxPage < 0) _inboxPage = 0;
  const inboxStart = _inboxPage * INBOX_PER_PAGE;
  const pageInbox = inbox.slice(inboxStart, inboxStart + INBOX_PER_PAGE);

  list.innerHTML = pageInbox.map((item, i) => {
    const idx = inboxStart + i;
    return `<div class="inbox-item" data-file="notes/inbox/${escHtml(item.name)}">
      <div class="inbox-name" onclick="openModal(${idx})" style="cursor:pointer">
        <span>${escHtml(item.name)}</span><span>${escHtml(item.age || '')}</span>
      </div>
      <div class="inbox-preview" onclick="openModal(${idx})" style="cursor:pointer">${escHtml(item.content.slice(0,200))}</div>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" data-inbox-name="${escHtml(item.name)}" onclick="event.stopPropagation();promoteToKB(this.dataset.inboxName)">Add to Knowledge Base</button>
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px" data-inbox-name="${escHtml(item.name)}" onclick="event.stopPropagation();openInboxInExplorer(this.dataset.inboxName)">Open in Explorer</button>
        <button class="pr-pager-btn" style="font-size:9px;padding:2px 8px;color:var(--red)" data-inbox-name="${escHtml(item.name)}" onclick="event.stopPropagation();deleteInboxItem(this.dataset.inboxName)">Delete</button>
      </div>
    </div>`;
  }).join('');
  if (inbox.length > INBOX_PER_PAGE) {
    list.innerHTML += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (inboxStart + 1) + ' to ' + Math.min(inboxStart + INBOX_PER_PAGE, inbox.length) + ' of ' + inbox.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_inboxPage === 0 ? 'disabled' : '') + '" onclick="_inboxPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_inboxPage >= totalInboxPages - 1 ? 'disabled' : '') + '" onclick="_inboxNext()">Next</button>' +
      '</div></div>';
  }
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
  el.innerHTML = '<div class="notes-preview" onclick="openNotesModal()" title="Click to expand">' + renderMd(content) + '</div>';
  el.querySelector('.notes-preview')._rawContent = content;
}

function openNotesModal() {
  const preview = document.querySelector('.notes-preview');
  if (!preview) return;
  const content = preview._rawContent || preview.textContent;
  document.getElementById('modal-title').textContent = 'Team Notes';
  document.getElementById('modal-body').innerHTML = renderMd(content);
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  _modalDocContext = { title: 'Team Notes', content, selection: '' };
  _modalEditable = 'notes.md';
  _modalFilePath = 'notes.md'; showModalQa();
  document.getElementById('modal-edit-btn').style.display = '';
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
  body.innerHTML = renderMd(_modalDocContext.content); // revert (render Markdown, not raw text)
  body.style.border = '';
  body.style.padding = '';
  document.getElementById('modal-edit-btn').style.display = '';
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-cancel-edit-btn').style.display = 'none';
}

async function deleteInboxItem(name) {
  if (!confirm('Delete "' + name + '" from inbox?')) return;
  markDeleted('inbox:' + name);
  const card = document.querySelector('.inbox-item[data-file="notes/inbox/' + CSS.escape(name) + '"]');
  if (card) card.remove();
  try {
    const res = await fetch('/api/inbox/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert('Delete failed: ' + (d.error || 'unknown')); refresh(); }
  } catch (e) { alert('Delete error: ' + e.message); refresh(); }
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
  try { closeModal(); } catch { /* expected */ }
  showToast('cmd-toast', 'Note saved to inbox', true);
  try {
    const res = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'Quick note', what: content || title })
    });
    if (res.ok) {
      refresh();
      const currentPage = document.querySelector('.sidebar-link.active')?.getAttribute('data-page');
      if (currentPage !== 'inbox') {
        const link = document.querySelector('.sidebar-link[data-page="inbox"]');
        if (link && !link.querySelector('.notif-badge')) showNotifBadge(link);
      }
    }
    else { const d = await res.json().catch(() => ({})); alert('Note failed: ' + (d.error || 'unknown')); openQuickNoteModal(); }
  } catch (e) { alert('Error saving note: ' + e.message); openQuickNoteModal(); }
}

async function doPromoteToKB(name, category) {
  try { closeModal(); } catch { /* expected */ }
  markDeleted('inbox:' + name);
  const card = document.querySelector('.inbox-item[data-file="notes/inbox/' + CSS.escape(name) + '"]');
  if (card) card.remove();
  showToast('cmd-toast', 'Promoted to Knowledge Base', true);
  try {
    const res = await fetch('/api/inbox/promote-kb', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category })
    });
    const data = await res.json();
    if (res.ok) { refreshKnowledgeBase(); }
    else { alert('Failed: ' + (data.error || 'unknown')); refresh(); }
  } catch (e) { alert('Error: ' + e.message); refresh(); }
}

window.MinionsInbox = { renderInbox, promoteToKB, renderNotes, openNotesModal, modalToggleEdit, modalSaveEdit, modalCancelEdit, deleteInboxItem, openInboxInExplorer, openQuickNoteModal, submitQuickNote, doPromoteToKB };
