// render-prs.js — PR tracker rendering functions extracted from dashboard.html

let allPrs = [];
let prPage = 0;
const PR_PER_PAGE = 25;

function prRow(pr) {
  // Minions review (agent) state — separate from ADO human review
  const sq = pr.minionsReview || {};
  // If PR is merged/abandoned, treat 'waiting' review as resolved
  const effectiveReviewStatus = (pr.status === 'merged' || pr.status === 'abandoned') && pr.reviewStatus === 'waiting' ? (pr.status === 'merged' ? 'approved' : 'pending') : pr.reviewStatus;
  const reviewSource = sq.status || effectiveReviewStatus || 'pending';
  const reviewClass = reviewSource === 'approved' ? 'approved' : (reviewSource === 'changes-requested' || reviewSource === 'rejected') ? 'rejected' : reviewSource === 'waiting' ? 'building' : 'draft';
  const reviewLabel = sq.status === 'waiting' ? 'reviewing (minions)' : sq.status ? sq.status + ' (minions)' : (effectiveReviewStatus || 'pending');
  const buildClass = pr.buildStatus === 'passing' ? 'build-pass' : pr.buildStatus === 'failing' ? 'build-fail' : pr.buildStatus === 'running' ? 'building' : 'no-build';
  const buildLabel = pr.buildStatus || 'none';
  const statusClass = pr.status === 'merged' ? 'merged' : pr.status === 'abandoned' ? 'rejected' : pr.status === 'active' ? 'active' : 'draft';
  const statusLabel = pr.status || 'active';
  const url = pr.url || '#';
  const prId = pr.id || '—';
  return '<tr>' +
    '<td><span class="pr-id">' + escHtml(String(prId)) + '</span></td>' +
    '<td><a class="pr-title" href="' + escHtml(safeUrl(url)) + '" target="_blank" rel="noopener">' + escHtml(pr.title || 'Untitled') + '</a></td>' +
    '<td><span class="pr-agent">' + escHtml(pr.agent || '—') + '</span></td>' +
    '<td><span class="pr-branch">' + escHtml(pr.branch || '—') + '</span></td>' +
    '<td><span class="pr-badge ' + reviewClass + '">' + escHtml(reviewLabel) + '</span></td>' +
    '<td>' + (sq.reviewer && sq.status !== 'waiting' ? '<span class="pr-agent" title="' + escHtml(sq.note || '') + '">' + escHtml(sq.reviewer) + '</span>' : sq.reviewer && sq.status === 'waiting' ? '<span class="pr-agent" style="color:var(--muted)" title="Vote pending confirmation">' + escHtml(sq.reviewer) + '…</span>' : pr.reviewedBy && pr.reviewedBy.length ? '<span class="pr-agent">' + escHtml(pr.reviewedBy.join(', ')) + '</span>' : '<span style="color:var(--muted);font-size:11px">—</span>') + '</td>' +
    '<td><span class="pr-badge ' + buildClass + '">' + escHtml(buildLabel) + '</span></td>' +
    '<td><span class="pr-badge ' + statusClass + '">' + escHtml(statusLabel) + '</span></td>' +
    '<td><span class="pr-date">' + escHtml((pr.created || '—').slice(0, 16).replace('T', ' ')) + '</span></td>' +
    '</tr>';
}

function prTableHtml(rows) {
  return '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
    '<th>PR</th><th>Title</th><th>Agent</th><th>Branch</th><th>Review</th><th>Signed Off By</th><th>Build</th><th>Status</th><th>Created</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderPrs(prs) {
  allPrs = prs;
  const el = document.getElementById('pr-content');
  const count = document.getElementById('pr-count');
  count.textContent = prs.length;
  if (!prs.length) {
    el.innerHTML = '<p class="pr-empty">No pull requests yet. PRs created by agents will appear here with review, build, and merge status.</p>';
    return;
  }
  const totalPages = Math.ceil(prs.length / PR_PER_PAGE);
  if (prPage >= totalPages) prPage = totalPages - 1;
  const start = prPage * PR_PER_PAGE;
  const pagePrs = prs.slice(start, start + PR_PER_PAGE);
  const rows = pagePrs.map(prRow).join('');

  let pager = '';
  if (prs.length > PR_PER_PAGE) {
    pager = '<div class="pr-pager">' +
      '<span class="pr-page-info">Showing ' + (start+1) + ' to ' + Math.min(start+PR_PER_PAGE, prs.length) + ' of ' + prs.length + '</span>' +
      '<div class="pr-pager-btns">' +
        '<button class="pr-pager-btn ' + (prPage === 0 ? 'disabled' : '') + '" onclick="prPrev()">Prev</button>' +
        '<button class="pr-pager-btn ' + (prPage >= totalPages-1 ? 'disabled' : '') + '" onclick="prNext()">Next</button>' +
        '<button class="pr-pager-btn see-all" onclick="openAllPrs()">See all ' + prs.length + ' PRs</button>' +
      '</div>' +
    '</div>';
  }

  el.innerHTML = prTableHtml(rows) + pager;
}

function prPrev() { if (prPage > 0) { prPage--; renderPrs(allPrs); } }
function prNext() { const totalPages = Math.ceil(allPrs.length / PR_PER_PAGE); if (prPage < totalPages-1) { prPage++; renderPrs(allPrs); } }

function openAllPrs() {
  const modalEl = document.querySelector('#modal .modal');
  if (modalEl) modalEl.classList.add('modal-wide');
  document.getElementById('modal-title').textContent = 'All Pull Requests (' + allPrs.length + ')';
  document.getElementById('modal-body').innerHTML = prTableHtml(allPrs.map(prRow).join(''));
  document.getElementById('modal-body').style.fontFamily = "'Segoe UI', system-ui, sans-serif";
  document.getElementById('modal-body').style.whiteSpace = 'normal';
  document.getElementById('modal').classList.add('open');
}

function openModal(i) {
  const item = inboxData[i];
  if (!item) return;
  document.getElementById('modal-title').textContent = item.name;
  document.getElementById('modal-body').innerHTML =
    '<div style="margin-bottom:12px"><button class="pr-pager-btn" style="font-size:10px;padding:3px 10px" onclick="promoteToKB(\'' + escHtml(item.name) + '\')">Add to Knowledge Base</button></div>' +
    '<div style="font-size:12px;line-height:1.7;color:var(--muted)">' + renderMd(item.content) + '</div>';
  _modalDocContext = { title: item.name, content: item.content, selection: '' };
  _modalFilePath = 'notes/inbox/' + item.name; showModalQa();
  // Clear notification badge when opening this document
  const card = findCardForFile(_modalFilePath);
  if (card) clearNotifBadge(card);
  document.getElementById('modal').classList.add('open');
}

function openAddPrModal() {
  const projOpts = (typeof cmdProjects !== 'undefined' ? cmdProjects : []).map(p =>
    '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>'
  ).join('');
  const inputStyle = 'display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:var(--text-md);font-family:inherit';

  document.getElementById('modal-title').textContent = 'Link Pull Request';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:10px">' +
      '<label style="color:var(--text);font-size:var(--text-md)">PR URL <input id="pr-link-url" style="' + inputStyle + '" placeholder="https://github.com/org/repo/pull/123"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title <input id="pr-link-title" style="' + inputStyle + '" placeholder="Short description (optional — auto-detected from URL)"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Project <select id="pr-link-project" style="' + inputStyle + '"><option value="">Auto / Central</option>' + projOpts + '</select></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Context <textarea id="pr-link-context" rows="3" style="' + inputStyle + ';resize:vertical" placeholder="Why are you linking this? What should agents know about it?"></textarea></label>' +
      '<label style="display:flex;align-items:center;gap:8px;color:var(--text);font-size:var(--text-md);margin-top:4px;cursor:pointer">' +
        '<input type="checkbox" id="pr-link-observe" style="width:16px;height:16px;accent-color:var(--blue)">' +
        '<span>Auto-observe <span style="color:var(--muted);font-weight:400">(monitor builds, resolve comments, fix failures)</span></span>' +
      '</label>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:-4px;padding-left:24px">Off = context only (e.g. teammate\'s PR). On = agents actively monitor and fix issues.</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="_submitLinkPr()" style="padding:6px 16px;background:var(--blue);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Link PR</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('pr-link-url')?.focus(), 100);
}

async function _submitLinkPr() {
  var btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Linking...'; }
  const url = document.getElementById('pr-link-url')?.value?.trim();
  if (!url) { if (btn) { btn.disabled = false; btn.textContent = 'Link PR'; } alert('PR URL is required'); return; }
  const title = document.getElementById('pr-link-title')?.value?.trim() || '';
  const project = document.getElementById('pr-link-project')?.value || '';
  const context = document.getElementById('pr-link-context')?.value || '';
  const autoObserve = document.getElementById('pr-link-observe')?.checked || false;

  try { closeModal(); } catch { /* expected */ }
  showToast('cmd-toast', 'PR linked' + (autoObserve ? ' (auto-observe on)' : ''), true);
  try {
    const res = await fetch('/api/pull-requests/link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, project, context, autoObserve })
    });
    const data = await res.json();
    if (res.ok) { refresh(); } else { alert('Failed: ' + (data.error || 'unknown')); openAddPrModal(); }
  } catch (e) { alert('Error: ' + e.message); openAddPrModal(); }
}

window.MinionsPrs = { prRow, prTableHtml, renderPrs, prPrev, prNext, openAllPrs, openModal, openAddPrModal };
