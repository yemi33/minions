// render-kb.js — Knowledge base rendering functions extracted from dashboard.html

let _kbActiveTab = 'all';

async function refreshKnowledgeBase() {
  try {
    _kbData = await fetch('/api/knowledge').then(r => r.json());
    renderKnowledgeBase();
  } catch (e) { console.error('kb refresh:', e.message); }
}

function renderKnowledgeBase() {
  const tabsEl = document.getElementById('kb-tabs');
  const listEl = document.getElementById('kb-list');
  const countEl = document.getElementById('kb-count');

  // Count total (skip non-array keys like lastSwept)
  let total = 0;
  for (const [k, v] of Object.entries(_kbData)) if (Array.isArray(v)) total += v.length;
  countEl.textContent = total;

  // Last swept timestamp
  const sweptEl = document.getElementById('kb-swept-time');
  if (sweptEl) sweptEl.textContent = _kbData.lastSwept ? 'swept ' + timeSinceStr(new Date(_kbData.lastSwept)) : '';

  if (total === 0) {
    tabsEl.innerHTML = '';
    listEl.innerHTML = '<p class="empty">No knowledge entries yet. Notes are classified here after consolidation.</p>';
    return;
  }

  // Render tabs
  let tabsHtml = '<button class="kb-tab ' + (_kbActiveTab === 'all' ? 'active' : '') + '" onclick="kbSetTab(\'all\')">All <span class="badge">' + total + '</span></button>';
  for (const [cat, items] of Object.entries(_kbData)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const label = KB_CAT_LABELS[cat] || cat;
    tabsHtml += '<button class="kb-tab ' + (_kbActiveTab === cat ? 'active' : '') + '" onclick="kbSetTab(\'' + cat + '\')">' + label + ' <span class="badge">' + items.length + '</span></button>';
  }
  tabsEl.innerHTML = tabsHtml;

  // Collect items for active tab
  let items = [];
  if (_kbActiveTab === 'all') {
    for (const [cat, catItems] of Object.entries(_kbData)) {
      if (!Array.isArray(catItems)) continue;
      for (const item of catItems) items.push({ ...item, category: cat });
    }
    items.sort((a, b) => b.date.localeCompare(a.date));
  } else {
    items = (_kbData[_kbActiveTab] || []).map(i => ({ ...i, category: _kbActiveTab }));
  }

  if (items.length === 0) {
    listEl.innerHTML = '<p class="empty">No entries in this category.</p>';
    return;
  }

  listEl.innerHTML = items.slice(0, 50).map(item => {
    const icon = KB_CAT_ICONS[item.category] || '\u{1F4C4}';
    const label = KB_CAT_LABELS[item.category] || item.category;
    return '<div class="kb-item" data-file="knowledge/' + escHtml(item.category) + '/' + escHtml(item.file) + '" onclick="kbOpenItem(\'' + escHtml(item.category) + '\', \'' + escHtml(item.file) + '\')">' +
      '<div class="kb-item-body">' +
        '<div class="kb-item-title">' + icon + ' ' + escHtml(item.title) + '</div>' +
        '<div class="kb-item-meta">' +
          '<span>' + label + '</span>' +
          (item.agent ? '<span>' + item.agent + '</span>' : '') +
          '<span>' + (item.date || '') + '</span>' +
          '<span>' + Math.round(item.size / 1024) + 'KB</span>' +
        '</div>' +
        (item.preview ? '<div class="kb-item-preview">' + escHtml(item.preview) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  restoreNotifBadges();
}

function kbSetTab(tab) {
  _kbActiveTab = tab;
  renderKnowledgeBase();
}

async function kbSweep() {
  const btn = document.getElementById('kb-sweep-btn');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'sweeping...';
  btn.style.color = 'var(--blue)';
  try {
    const res = await fetch('/api/knowledge/sweep', { method: 'POST', signal: AbortSignal.timeout(300000) });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = 'done';
      btn.style.color = 'var(--green)';
      showToast('cmd-toast', 'KB sweep: ' + (data.summary || 'complete'), true);
      refreshKnowledgeBase();
    } else {
      btn.style.color = 'var(--red)';
      btn.textContent = 'failed';
      showToast('cmd-toast', 'Sweep failed: ' + (data.error || 'unknown'), false);
    }
  } catch (e) {
    btn.style.color = 'var(--red)';
    btn.textContent = 'failed';
    showToast('cmd-toast', 'Sweep error: ' + e.message, false);
  }
  setTimeout(() => { btn.textContent = origText; btn.style.color = 'var(--muted)'; btn.disabled = false; }, 3000);
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
  const category = document.getElementById('kb-new-category').value;
  const title = document.getElementById('kb-new-title').value;
  const content = document.getElementById('kb-new-content').value;
  if (!title || !content) { alert('Title and content are required'); return; }
  try {
    const res = await fetch('/api/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, title, content })
    });
    if (res.ok) { closeModal(); refreshKnowledgeBase(); showToast('cmd-toast', 'KB entry created', true); }
    else { const d = await res.json(); alert('Error: ' + (d.error || 'unknown')); }
  } catch (e) { alert('Error: ' + e.message); }
}

async function kbOpenItem(category, file) {
  try {
    const content = await fetch('/api/knowledge/' + category + '/' + encodeURIComponent(file)).then(r => r.text());
    const display = content.replace(/^---[\s\S]*?---\n*/m, '');
    document.getElementById('modal-title').textContent = file;
    document.getElementById('modal-body').textContent = display;
    _modalDocContext = { title: file, content: display, selection: '' };
    _modalFilePath = 'knowledge/' + category + '/' + file; showModalQa();
    // Clear notification badge when opening this document
    const card = findCardForFile(_modalFilePath);
    if (card) clearNotifBadge(card);
    // steer btn removed — unified send
    document.getElementById('modal').classList.add('open');
  } catch (e) {
    console.error('Failed to load KB item:', e);
  }
}
