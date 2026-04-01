// dashboard/js/render-pinned.js — Pinned context notes rendering and management

function renderPinned(entries) {
  entries = (entries || []).filter(function(e) { return !isDeleted('pin:' + e.title); });
  const el = document.getElementById('pinned-content');
  if (!el) return;
  if (!entries || entries.length === 0) {
    el.innerHTML = '<p class="empty">No pinned notes. Pin important context that all agents should see.</p>';
    return;
  }
  el.innerHTML = entries.map(e =>
    '<div style="padding:8px 12px;margin-bottom:6px;background:var(--surface2);border-left:3px solid ' +
      (e.level === 'critical' ? 'var(--red)' : e.level === 'warning' ? 'var(--yellow)' : 'var(--blue)') +
      ';border-radius:4px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<strong style="font-size:var(--text-md)">' + escHtml(e.title) + '</strong>' +
        '<button class="pr-pager-btn" style="font-size:9px;padding:1px 6px;color:var(--red);border-color:var(--red)" onclick="removePinnedNote(\'' + escHtml(e.title) + '\')">Unpin</button>' +
      '</div>' +
      '<div style="font-size:var(--text-sm);color:var(--muted);margin-top:4px">' + renderMd(e.content.slice(0, 200)) + '</div>' +
    '</div>'
  ).join('');
}

function openPinNoteModal() {
  document.getElementById('modal-title').textContent = 'Pin a Note';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title<input id="pin-title" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)" placeholder="e.g. API freeze until Friday"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Content<textarea id="pin-content" rows="4" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);resize:vertical;font-family:inherit" placeholder="Context all agents should see..."></textarea></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Level<select id="pin-level" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)"><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button onclick="closeModal()" class="pr-pager-btn">Cancel</button><button onclick="submitPinnedNote()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Pin</button></div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitPinnedNote() {
  const title = document.getElementById('pin-title').value;
  const content = document.getElementById('pin-content').value;
  const level = document.getElementById('pin-level').value;
  if (!title || !content) { alert('Title and content required'); return; }
  try { closeModal(); } catch { /* may not be open */ }
  showToast('cmd-toast', 'Note pinned', true);
  try {
    const res = await fetch('/api/pinned', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, level }) });
    if (res.ok) { refresh(); } else { const d = await res.json().catch(() => ({})); alert('Pin failed: ' + (d.error || 'unknown')); openPinNoteModal(); }
  } catch (e) { alert('Error: ' + e.message); openPinNoteModal(); }
}

async function removePinnedNote(title) {
  if (!confirm('Unpin "' + title + '"?')) return;
  markDeleted('pin:' + title);
  const btn = event?.target; if (btn) { const card = btn.closest('.pinned-card') || btn.parentElement?.parentElement; if (card) card.remove(); }
  try {
    const res = await fetch('/api/pinned/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (!res.ok) { alert('Unpin failed'); refresh(); }
  } catch (e) { alert('Error: ' + e.message); refresh(); }
}

window.MinionsPinned = { renderPinned, openPinNoteModal, submitPinnedNote, removePinnedNote };
