// render-kb.js — Knowledge base rendering functions extracted from dashboard.html

const KB_CAT_LABELS = {
  architecture: 'Architecture', conventions: 'Conventions',
  'project-notes': 'Project Notes', 'build-reports': 'Build Reports',
  reviews: 'Reviews', learnings: 'Learnings', decisions: 'Decisions',
  incidents: 'Incidents', 'api-notes': 'API Notes',
};
const KB_CAT_ICONS = {
  architecture: '\u{1F3D7}', conventions: '\u{1F4CF}',
  'project-notes': '\u{1F4DD}', 'build-reports': '\u{1F6E0}',
  reviews: '\u{1F50D}', learnings: '\u{1F4A1}', decisions: '\u{2696}',
  incidents: '\u{1F6A8}', 'api-notes': '\u{1F517}',
};
let _kbData = {};
let _kbActiveTab = 'all';
const KB_PER_PAGE = 30;
let _kbPage = 0;

function _kbPrev() { if (_kbPage > 0) { _kbPage--; renderKnowledgeBase(); } }
function _kbNext() { _kbPage++; renderKnowledgeBase(); }

async function refreshKnowledgeBase() {
  try {
    _kbData = await fetch('/api/knowledge').then(r => r.json());
    renderKnowledgeBase();
  } catch (e) { console.error('kb refresh:', e.message); }
}

function kbNewestFirst(a, b) {
  return (b.sortTs || 0) - (a.sortTs || 0) ||
    (b.date || '').localeCompare(a.date || '') ||
    (a.title || '').localeCompare(b.title || '');
}

function kbPinnedNewestFirst(a, b) {
  const aPinned = isPinned(kbPinKey(a.category, a.file));
  const bPinned = isPinned(kbPinKey(b.category, b.file));
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  return kbNewestFirst(a, b);
}

function renderKnowledgeBase() {
  _syncPinsFromServer();
  const tabsEl = document.getElementById('kb-tabs');
  const listEl = document.getElementById('kb-list');
  const countEl = document.getElementById('kb-count');

  // Single pass: flatten all KB items and count pinned
  const allItems = [];
  let pinnedCount = 0;
  for (const [cat, catItems] of Object.entries(_kbData)) {
    if (!Array.isArray(catItems)) continue;
    for (const item of catItems) {
      const entry = { ...item, category: cat };
      allItems.push(entry);
      if (isPinned(kbPinKey(cat, item.file))) pinnedCount++;
    }
  }
  countEl.textContent = allItems.length;

  const sweptEl = document.getElementById('kb-swept-time');
  if (sweptEl) sweptEl.textContent = _kbData.lastSwept ? 'swept ' + timeSinceStr(new Date(_kbData.lastSwept)) : '';

  if (allItems.length === 0) {
    tabsEl.innerHTML = '';
    listEl.innerHTML = '<p class="empty">No knowledge entries yet. Notes are classified here after consolidation.</p>';
    return;
  }

  if (_kbActiveTab === 'pinned' && pinnedCount === 0) _kbActiveTab = 'all';

  // Render tabs
  let tabsHtml = '';
  if (pinnedCount > 0) {
    tabsHtml += '<button class="kb-tab ' + (_kbActiveTab === 'pinned' ? 'active' : '') + '" style="color:var(--yellow)" onclick="kbSetTab(\'pinned\')">Pinned <span class="badge">' + pinnedCount + '</span></button>';
  }
  tabsHtml += '<button class="kb-tab ' + (_kbActiveTab === 'all' ? 'active' : '') + '" onclick="kbSetTab(\'all\')">All <span class="badge">' + allItems.length + '</span></button>';
  for (const [cat, catArr] of Object.entries(_kbData)) {
    if (!Array.isArray(catArr) || catArr.length === 0) continue;
    const label = KB_CAT_LABELS[cat] || cat;
    tabsHtml += '<button class="kb-tab ' + (_kbActiveTab === cat ? 'active' : '') + '" onclick="kbSetTab(\'' + cat + '\')">' + label + ' <span class="badge">' + catArr.length + '</span></button>';
  }
  tabsEl.innerHTML = tabsHtml;

  // Filter items for active tab
  let items;
  if (_kbActiveTab === 'pinned') {
    items = allItems.filter(i => isPinned(kbPinKey(i.category, i.file)));
    items.sort(kbNewestFirst);
  } else if (_kbActiveTab === 'all') {
    items = allItems.slice();
    items.sort(kbPinnedNewestFirst);
  } else {
    items = allItems.filter(i => i.category === _kbActiveTab);
    items.sort(kbPinnedNewestFirst);
  }

  if (items.length === 0) {
    listEl.innerHTML = '<p class="empty">No entries in this category.</p>';
    return;
  }

  const totalKbPages = Math.ceil(items.length / KB_PER_PAGE);
  if (_kbPage >= totalKbPages) _kbPage = totalKbPages - 1;
  if (_kbPage < 0) _kbPage = 0;
  const kbStart = _kbPage * KB_PER_PAGE;
  const pageItems = items.slice(kbStart, kbStart + KB_PER_PAGE);

  listEl.innerHTML = pageItems.map(item => {
    const icon = KB_CAT_ICONS[item.category] || '\u{1F4C4}';
    const label = KB_CAT_LABELS[item.category] || item.category;
    var pinKey = kbPinKey(item.category, item.file);
    var pinned = isPinned(pinKey);
    return '<div class="kb-item' + (pinned ? ' item-pinned' : '') + '" data-file="knowledge/' + escapeHtml(item.category) + '/' + escapeHtml(item.file) + '" onclick="kbOpenItem(\'' + escapeHtml(item.category) + '\', \'' + escapeHtml(item.file) + '\')">' +
      '<div class="kb-item-body">' +
        '<div class="kb-item-title">' + icon + ' ' + escapeHtml(item.title) +
          ' <button class="pr-pager-btn pin-btn' + (pinned ? ' pinned' : '') + '" style="font-size:9px;padding:1px 6px;margin-left:6px;vertical-align:middle" data-pin-key="' + escapeHtml(pinKey) + '" onclick="event.stopPropagation();_togglePinAndRefresh(this.dataset.pinKey,\'kb\')">' + (pinned ? 'Unpin' : 'Pin') + '</button>' +
        '</div>' +
        '<div class="kb-item-meta">' +
          '<span>' + label + '</span>' +
          (item.agent ? '<span>' + escapeHtml(item.agent) + '</span>' : '') +
          '<span>' + (item.date || '') + '</span>' +
          '<span>' + Math.round(item.size / 1024) + 'KB</span>' +
        '</div>' +
        (item.preview ? '<div class="kb-item-preview">' + escapeHtml(item.preview) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  if (items.length > KB_PER_PAGE) {
    listEl.innerHTML += '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (kbStart + 1) + ' to ' + Math.min(kbStart + KB_PER_PAGE, items.length) + ' of ' + items.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (_kbPage === 0 ? 'disabled' : '') + '" onclick="_kbPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (_kbPage >= totalKbPages - 1 ? 'disabled' : '') + '" onclick="_kbNext()">Next</button>' +
      '</div></div>';
  }
  restoreNotifBadges();
}

function kbSetTab(tab) {
  _kbActiveTab = tab;
  _kbPage = 0;
  renderKnowledgeBase();
}

async function kbSweep() {
  const btn = document.getElementById('kb-sweep-btn');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'sweeping...';
  btn.style.color = 'var(--blue)';
  try {
    showToast('cmd-toast', 'KB sweep started', true);
    const triggerRes = await fetch('/api/knowledge/sweep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinnedKeys: getPinnedItems().filter(function(k) { return k.startsWith('knowledge/'); }) }) });
    const triggerData = await triggerRes.json();
    if (!triggerData.ok) {
      btn.style.color = 'var(--red)';
      btn.textContent = 'failed';
      showToast('cmd-toast', 'Sweep failed: ' + (triggerData.error || 'unknown'), false);
      setTimeout(function() { btn.textContent = origText; btn.style.color = 'var(--muted)'; btn.disabled = false; }, 60000);
      return;
    }
    // Poll status until sweep completes (every 3s, up to 10 min)
    var maxPolls = 200;
    var pollCount = 0;
    while (pollCount < maxPolls) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      pollCount++;
      try {
        var statusRes = await fetch('/api/knowledge/sweep/status');
        var statusData = await statusRes.json();
        if (!statusData.inFlight) {
          var result = statusData.lastResult;
          if (result && result.ok) {
            btn.textContent = 'done';
            btn.style.color = 'var(--green)';
            showToast('cmd-toast', 'KB sweep complete: ' + (result.summary || 'done'), true);
            refreshKnowledgeBase();
          } else {
            btn.style.color = 'var(--red)';
            btn.textContent = 'failed';
            showToast('cmd-toast', 'Sweep failed: ' + ((result && result.error) || 'unknown'), false);
          }
          break;
        }
      } catch { /* poll error — retry */ }
    }
    if (pollCount >= maxPolls) {
      btn.textContent = 'timeout';
      btn.style.color = 'var(--red)';
      showToast('cmd-toast', 'Sweep polling timed out — check status later', false);
    }
    // Show notification on sidebar if user is on a different page
    var kbLink = document.querySelector('.sidebar-link[data-page="inbox"]');
    var activePage = document.querySelector('.sidebar-link.active')?.getAttribute('data-page');
    if (kbLink && activePage !== 'inbox') showNotifBadge(kbLink, 'done');
  } catch (e) {
    btn.style.color = 'var(--red)';
    btn.textContent = 'failed';
    showToast('cmd-toast', 'Sweep error: ' + e.message, false);
    var kbLink2 = document.querySelector('.sidebar-link[data-page="inbox"]');
    var activePage2 = document.querySelector('.sidebar-link.active')?.getAttribute('data-page');
    if (kbLink2 && activePage2 !== 'inbox') showNotifBadge(kbLink2);
  }
  var isError = btn.textContent === 'failed' || btn.textContent === 'timeout';
  setTimeout(function() { btn.textContent = origText; btn.style.color = 'var(--muted)'; btn.disabled = false; }, isError ? 60000 : 3000);
}

function openCreateKbModal() {
  document.getElementById('modal-title').textContent = 'New Knowledge Base Entry';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">Category' +
        '<select id="kb-new-category" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)">' +
          '<option value="architecture">Architecture</option>' +
          '<option value="conventions">Conventions</option>' +
          '<option value="project-notes">Project Notes</option>' +
          '<option value="build-reports">Build Reports</option>' +
          '<option value="reviews">Reviews</option>' +
        '</select></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title' +
        '<input id="kb-new-title" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)" placeholder="Entry title"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Content' +
        '<textarea id="kb-new-content" rows="8" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);resize:vertical;font-family:inherit" placeholder="Write your knowledge entry..."></textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="submitKbEntry()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Save</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitKbEntry() {
  var btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }
  const category = document.getElementById('kb-new-category').value;
  const title = document.getElementById('kb-new-title').value;
  const content = document.getElementById('kb-new-content').value;
  if (!title || !content) { if (btn) { btn.disabled = false; btn.textContent = 'Create'; } alert('Title and content are required'); return; }
  try {
    showToast('cmd-toast', 'KB entry created', true);
    const res = await fetch('/api/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, title, content })
    });
    if (res.ok) { closeModal(); refreshKnowledgeBase(); }
    else { if (btn) { btn.disabled = false; btn.textContent = 'Create'; } const d = await res.json().catch(() => ({})); showToast('cmd-toast', 'KB create failed: ' + (d.error || 'unknown'), false); }
  } catch (e) { if (btn) { btn.disabled = false; btn.textContent = 'Create'; } showToast('cmd-toast', 'Error: ' + e.message, false); }
}

async function kbOpenItem(category, file) {
  try {
    const content = await fetch('/api/knowledge/' + category + '/' + encodeURIComponent(file)).then(r => r.text());
    const display = content.replace(/^---[\s\S]*?---\n*/m, '');
    document.getElementById('modal-title').textContent = file;
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = renderMd(display);
    _modalDocContext = { title: file, content: display, selection: '' };
    _modalFilePath = 'knowledge/' + category + '/' + file; showModalQa();
    // Clear notification badge when opening this document
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    document.getElementById('modal').classList.add('open');
  } catch (e) {
    console.error('Failed to load KB item:', e);
  }
}

window.MinionsKb = { refreshKnowledgeBase, renderKnowledgeBase, kbSetTab, kbSweep, openCreateKbModal, submitKbEntry, kbOpenItem };
