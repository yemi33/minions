// modal.js — Modal and notification badge functions extracted from dashboard.html

function closeModal() {
  const modalEl = document.querySelector('#modal .modal');
  if (modalEl) modalEl.classList.remove('modal-wide');
  document.getElementById('modal').classList.remove('open');
  // Hide Q&A section (only shown for document modals)
  document.getElementById('modal-qa').style.display = 'none';
  // Remove settings save button if present
  const settingsBtn = document.getElementById('modal-settings-save');
  if (settingsBtn) settingsBtn.remove();
  // Save Q&A session for this document (persist across modal open/close)
  if (_qaSessionKey && (_qaHistory.length > 0 || _qaQueue.length > 0)) {
    _qaSessions.set(_qaSessionKey, {
      history: _qaHistory,
      threadHtml: document.getElementById('modal-qa-thread').innerHTML,
      docContext: { ..._modalDocContext },
      filePath: _modalFilePath,
    });
    _saveQaSessions();
  }
  // If still processing, show animated badge on the source card
  if (_qaProcessing && _modalFilePath) {
    const card = findCardForFile(_modalFilePath);
    if (card) showNotifBadge(card, 'processing');
  }
  // Reset UI state but don't kill processing/queue — they run in background
  _modalDocContext = { title: '', content: '', selection: '' };
  // Keep session key alive if processing is in flight — result will save when it completes
  if (!_qaProcessing) _qaSessionKey = '';
  document.getElementById('modal-qa-input').value = '';
  document.getElementById('modal-qa-input').placeholder = 'Ask about this document (or select text first)...';
  document.getElementById('modal-qa-pill').style.display = 'none';
  document.getElementById('ask-selection-btn').style.display = 'none';
  // Clear edit/steer state
  _modalEditable = null;
  _modalFilePath = null;
  _modalOriginalPlan = null;
  // steer btn removed — unified send
  const body = document.getElementById('modal-body');
  body.contentEditable = 'false';
  body.style.border = '';
  body.style.padding = '';
  document.getElementById('modal-edit-btn').style.display = 'none';
  document.getElementById('modal-save-btn').style.display = 'none';
  document.getElementById('modal-cancel-edit-btn').style.display = 'none';
}

function copyModalContent() {
  const body = document.getElementById('modal-body');
  const btn = document.getElementById('modal-copy-btn');
  navigator.clipboard.writeText(body.textContent).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg> Copy';
    }, 2000);
  });
}

// ─── Notification Badges ──────────────────────────────────────────────────────
// Show a red dot on a card/button when a background response arrives
// _activeBadges tracks badges by filePath so they survive DOM re-renders
const _activeBadges = new Map(); // filePath → state ('done' | 'processing')

function showNotifBadge(targetEl, state) {
  if (!targetEl) return;
  clearNotifBadge(targetEl);
  targetEl.style.position = 'relative';
  const badge = document.createElement('span');
  badge.className = 'notif-badge ' + (state || 'done');
  if (state === 'processing') {
    badge.innerHTML = '<span></span><span></span><span></span>';
  }
  targetEl.appendChild(badge);
  // Track by data-file so badge can be restored after DOM re-render
  const fileKey = targetEl.getAttribute('data-file');
  if (fileKey) _activeBadges.set(fileKey, state || 'done');
}
function clearNotifBadge(targetEl) {
  if (!targetEl) return;
  const dot = targetEl.querySelector('.notif-badge');
  if (dot) dot.remove();
  const fileKey = targetEl.getAttribute('data-file');
  if (fileKey) _activeBadges.delete(fileKey);
}
// Re-apply tracked badges after DOM re-renders (called after renderInbox, renderPlans, renderKnowledgeBase)
function restoreNotifBadges() {
  for (const [filePath, state] of _activeBadges) {
    const card = findCardForFile(filePath);
    if (card && !card.querySelector('.notif-badge')) {
      card.style.position = 'relative';
      const badge = document.createElement('span');
      badge.className = 'notif-badge ' + state;
      if (state === 'processing') {
        badge.innerHTML = '<span></span><span></span><span></span>';
      }
      card.appendChild(badge);
    }
  }
}
// Find the plan/KB/inbox card that matches a filePath
function findCardForFile(filePath) {
  if (!filePath) return null;
  // Direct match by data-file attribute
  var card = document.querySelector('[data-file="' + CSS.escape(filePath) + '"]');
  if (card) return card;
  // Plan cards may have data-file="plans/x.json" but filePath="prd/x.json" (PRD variant)
  if (filePath.startsWith('prd/')) {
    card = document.querySelector('[data-file="' + CSS.escape('plans/' + filePath.slice(4)) + '"]');
    if (card) return card;
  }
  // Archived items: badge the "View Archives" button
  if (filePath.includes('archive')) {
    if (filePath.startsWith('prd/') || filePath.startsWith('plans/')) {
      card = document.querySelector('[data-file="prd-archives"]') || document.querySelector('[data-file="plan-archives"]');
      if (card) return card;
    }
  }
  return null;
}

function renderArchiveButtons(archives) {
  archivedPrds = archives;
  const el = document.getElementById('archive-btns');
  if (!archives.length) { el.innerHTML = ''; return; }
  el.innerHTML = archives.map((a, i) =>
    '<button class="archive-btn" onclick="openArchive(' + i + ')">Archived: ' + escHtml(a.version) + ' (' + a.total + ' items)</button>'
  ).join(' ');
}

window.MinionsModal = { closeModal, copyModalContent, showNotifBadge, clearNotifBadge, restoreNotifBadges, findCardForFile, renderArchiveButtons };
