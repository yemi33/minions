// dashboard/js/utils.js — Utility functions extracted from dashboard.html

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function normalizePlanFile(file) {
  return String(file || '').replace(/\\/g, '/').split('/').pop();
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function statusColor(s) {
  return s === 'working' ? 'working' : s === 'done' ? 'done' : '';
}

function llmCopyBtn() {
  return '<button class="llm-copy-btn" onclick="event.stopPropagation();copyLlmText(this)" title="Copy">&#x2398;</button>';
}
function copyLlmText(btn) {
  const container = btn.parentElement;
  const clone = container.cloneNode(true);
  clone.querySelectorAll('.llm-copy-btn').forEach(b => b.remove());
  navigator.clipboard.writeText(clone.textContent.trim());
  btn.innerHTML = '&#10003;';
  setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 1500);
}
