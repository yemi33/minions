// render-prs.js — PR tracker rendering functions extracted from dashboard.html

let allPrs = [];
let prPage = 0;
const PR_PER_PAGE = 3;

function prRow(pr) {
  // Minions review (agent) state — separate from ADO human review
  const sq = pr.minionsReview || {};
  const reviewSource = sq.status || pr.reviewStatus || 'pending';
  const reviewClass = reviewSource === 'approved' ? 'approved' : (reviewSource === 'changes-requested' || reviewSource === 'rejected') ? 'rejected' : reviewSource === 'waiting' ? 'building' : 'draft';
  const reviewLabel = sq.status === 'waiting' ? 'reviewing (minions)' : sq.status ? sq.status + ' (minions)' : (pr.reviewStatus || 'pending');
  const buildClass = pr.buildStatus === 'passing' ? 'build-pass' : pr.buildStatus === 'failing' ? 'build-fail' : pr.buildStatus === 'running' ? 'building' : 'no-build';
  const buildLabel = pr.buildStatus || 'none';
  const statusClass = pr.status === 'merged' ? 'merged' : pr.status === 'abandoned' ? 'rejected' : pr.status === 'active' ? 'active' : 'draft';
  const statusLabel = pr.status || 'active';
  const url = pr.url || '#';
  const prId = pr.id || '—';
  return '<tr>' +
    '<td><span class="pr-id">' + escHtml(String(prId)) + '</span></td>' +
    '<td><a class="pr-title" href="' + escHtml(url) + '" target="_blank">' + escHtml(pr.title || 'Untitled') + '</a></td>' +
    '<td><span class="pr-agent">' + escHtml(pr.agent || '—') + '</span></td>' +
    '<td><span class="pr-branch">' + escHtml(pr.branch || '—') + '</span></td>' +
    '<td><span class="pr-badge ' + reviewClass + '">' + escHtml(reviewLabel) + '</span></td>' +
    '<td>' + (sq.reviewer && sq.status !== 'waiting' ? '<span class="pr-agent" title="' + escHtml(sq.note || '') + '">' + escHtml(sq.reviewer) + '</span>' : sq.reviewer && sq.status === 'waiting' ? '<span class="pr-agent" style="color:var(--muted)" title="Vote pending confirmation">' + escHtml(sq.reviewer) + '…</span>' : '<span style="color:var(--muted);font-size:11px">—</span>') + '</td>' +
    '<td><span class="pr-badge ' + buildClass + '">' + escHtml(buildLabel) + '</span></td>' +
    '<td><span class="pr-badge ' + statusClass + '">' + escHtml(statusLabel) + '</span></td>' +
    '<td><span class="pr-date">' + escHtml(pr.created || '—') + '</span></td>' +
    '</tr>';
}

function prTableHtml(rows) {
  return '<div class="pr-table-wrap"><table class="pr-table"><thead><tr>' +
    '<th>PR</th><th>Title</th><th>Agent</th><th>Branch</th><th>Review</th><th>Signed Off By</th><th>Build</th><th>Status</th><th>Created</th><th></th>' +
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
    '<pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font-family:Consolas,monospace;font-size:12px;line-height:1.7;color:var(--muted)">' + escHtml(item.content) + '</pre>';
  _modalDocContext = { title: item.name, content: item.content, selection: '' };
  _modalFilePath = 'notes/inbox/' + item.name; showModalQa();
  // Clear notification badge when opening this document
  const card = findCardForFile(_modalFilePath);
  if (card) clearNotifBadge(card);
  document.getElementById('modal').classList.add('open');
}
