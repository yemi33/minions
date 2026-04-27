// dashboard/js/utils.js — Utility functions extracted from dashboard.html

// Signal the engine to tick immediately (pick up new work without waiting 60s)
function wakeEngine() { fetch('/api/engine/wakeup', { method: 'POST' }).catch(() => {}); }

// Optimistic delete suppression
const _deletedIds = new Map();
function markDeleted(key) { _deletedIds.set(key, Date.now() + 10000); }
function clearDeleted(key) { _deletedIds.delete(key); }
function isDeleted(key) { const exp = _deletedIds.get(key); if (!exp) return false; if (Date.now() > exp) { _deletedIds.delete(key); return false; } return true; }

// Pin-to-top — persisted server-side so CC and agents can also pin items
let _pinsCache = [];
function invalidatePinsCache() { /* no-op — cache updated by sync and togglePin only */ }
function getPinnedItems() {
  return _pinsCache;
}
function isPinned(key) { return getPinnedItems().includes(key); }
var _pinWriteInFlight = false;
function togglePin(key) {
  const pins = getPinnedItems();
  const idx = pins.indexOf(key);
  if (idx >= 0) pins.splice(idx, 1); else pins.unshift(key);
  _pinsCache = pins;
  _pinWriteInFlight = true;
  fetch('/api/kb-pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pins }) })
    .finally(function() { _pinWriteInFlight = false; });
  return idx < 0; // true if now pinned
}
function _syncPinsFromServer() {
  fetch('/api/kb-pins').then(function(r) { return r.json(); }).then(function(d) {
    var serverPins = Array.isArray(d.pins) ? d.pins : [];
    // Migrate: merge localStorage pins into server if not already there
    var localPins = [];
    try { localPins = JSON.parse(localStorage.getItem('minions-pinned-items') || '[]'); } catch {}
    if (localPins.length > 0) {
      var merged = serverPins.slice();
      var changed = false;
      for (var i = 0; i < localPins.length; i++) {
        if (merged.indexOf(localPins[i]) < 0) { merged.unshift(localPins[i]); changed = true; }
      }
      if (changed) {
        fetch('/api/kb-pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pins: merged }) }).catch(function() {});
        serverPins = merged;
      }
      localStorage.removeItem('minions-pinned-items');
    }
    if (!_pinWriteInFlight) _pinsCache = serverPins;
  }).catch(function() {});
}
function inboxPinKey(name) { return 'notes/inbox/' + name; }
function kbPinKey(cat, file) { return 'knowledge/' + cat + '/' + file; }
function _togglePinAndRefresh(key, source) {
  var pinned = togglePin(key);
  showToast('cmd-toast', pinned ? 'Pinned to top' : 'Unpinned', true);
  if (source === 'inbox') renderInbox(inboxData);
  else if (source === 'kb') renderKnowledgeBase();
}

// Modal navigation stack — enables back button when opening a modal from another modal
var _modalBackStack = [];
function pushModalBack(reopenFn) {
  _modalBackStack.push(reopenFn);
  var btn = document.getElementById('modal-back-btn');
  if (btn) btn.style.display = '';
}
function modalGoBack() {
  var fn = _modalBackStack.pop();
  var btn = document.getElementById('modal-back-btn');
  if (btn && _modalBackStack.length === 0) btn.style.display = 'none';
  if (fn) fn();
}
function clearModalBackStack() {
  _modalBackStack = [];
  var btn = document.getElementById('modal-back-btn');
  if (btn) btn.style.display = 'none';
}

function updateModalPinBtn() {
  var btn = document.getElementById('modal-pin-btn');
  if (!btn) return;
  // Only show for inbox and KB docs (pinnable paths)
  if (!_modalFilePath || (!_modalFilePath.startsWith('notes/inbox/') && !_modalFilePath.startsWith('knowledge/'))) {
    btn.style.display = 'none'; return;
  }
  btn.style.display = '';
  var pinned = isPinned(_modalFilePath);
  btn.textContent = pinned ? 'Unpin' : 'Pin';
  btn.classList.toggle('pinned', pinned);
}
function toggleModalPin() {
  if (!_modalFilePath) return;
  var pinned = togglePin(_modalFilePath);
  showToast('cmd-toast', pinned ? 'Pinned to top' : 'Unpinned', true);
  updateModalPinBtn();
  if (_modalFilePath.startsWith('notes/inbox/')) renderInbox(inboxData);
  else if (_modalFilePath.startsWith('knowledge/')) renderKnowledgeBase();
}

// Canonical HTML-escape helper (SEC-03). Use this in all new code and for any user-controlled
// field that reaches `.innerHTML` / a template literal. Escapes the 6 HTML metacharacters
// (& < > " ' /) — the `/` escape closes the `<\/script>` break-out path that a 5-char escape
// leaves open. Returns '' for null/undefined so missing fields never render the literal strings
// "null"/"undefined". Idempotent for non-metacharacter input (double-escaping only expands `&`).
// NOTE: the `<\/script>` spelling above is deliberate. dashboard.js inlines every module in
// dashboard/js/ into a single inline <script> block; a raw closing-script-tag literal in any
// comment or string closes that block early and spills the rest as document text (issue #1746).
// The HTML5 tokenizer's script-data end-tag match is byte-level and ignores JS comment/string
// boundaries, so the only safe way to reference the token in-source is to break the match —
// `<` followed by `\/` works because after `<` only `/` (not `\`) triggers end-tag-open state.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

// Legacy 5-char escape. Kept as a backward-compat alias so files not yet migrated under
// SEC-03 Phase A still compile. Prefer `escapeHtml` in new code — it adds the `/` escape
// and null/undefined handling. Phase B will remove this once the remaining renderers move.
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function safeUrl(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s === '#' || s === '') return '#';
  return '#'; // block javascript:, data:, etc.
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
  return s === 'working' ? 'working' : s === 'done' ? 'done' : s === 'error' ? 'error' : '';
}

var SELECTION_CLICK_GUARD_MS = 300;
var _lastTextSelectionAt = 0;

function _selectionHasText() {
  var sel = window.getSelection ? window.getSelection() : null;
  return !!(sel && !sel.isCollapsed && sel.toString().trim());
}

function _markRecentTextSelection() {
  if (_selectionHasText()) _lastTextSelectionAt = Date.now();
}

document.addEventListener('selectionchange', _markRecentTextSelection);
document.addEventListener('mouseup', _markRecentTextSelection);

function shouldIgnoreSelectionClick() {
  if (_selectionHasText()) return true;
  return (Date.now() - _lastTextSelectionAt) < SELECTION_CLICK_GUARD_MS;
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

/**
 * Lightweight markdown → HTML renderer. XSS-safe (escapes first, then transforms).
 * Handles: headings, bold, italic, inline code, code blocks, links, blockquotes,
 * horizontal rules, ordered/unordered/checkbox lists, and tables.
 */
function renderMd(s) {
  if (!s) return '';
  if (s.length > 10000) return _renderMdChunked(s);
  return _renderMdCore(s);
}

function _normalizeCodeFences(s) {
  var fenceCount = (s.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) s = s + '\n```';
  return s;
}

function _renderMdCore(s) {
  let html = escHtml(s);

  // Close unclosed code fences before any regex processing
  html = _normalizeCodeFences(html);

  // 1. Extract code blocks and inline code into placeholders (protect from other transforms)
  const codeSlots = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    codeSlots.push('<pre style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;font-size:11px;margin:4px 0"><code>' + code + '</code></pre>');
    return '\x00CB' + (codeSlots.length - 1) + '\x00';
  });

  // Close lone unclosed backticks per-line before inline code extraction
  html = html.split('\n').map(function(line) {
    // Skip code block placeholders
    if (/^\x00CB\d+\x00$/.test(line)) return line;
    var ticks = (line.match(/`/g) || []).length;
    return (ticks % 2 !== 0) ? line + '`' : line;
  }).join('\n');

  html = html.replace(/`([^`\n]+)`/g, function(_, code) {
    codeSlots.push('<code style="background:var(--bg);padding:1px 4px;border-radius:3px;font-size:0.9em">' + code + '</code>');
    return '\x00CB' + (codeSlots.length - 1) + '\x00';
  });

  // 2. Inline transforms (before block processing so they work inside list items etc.)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, text, href) {
    if (/^(javascript|data|vbscript):/i.test(href)) return text;
    return '<a href="' + href + '" target="_blank" rel="noopener" style="color:var(--blue)">' + text + '</a>';
  });

  // 3. Block-level processing (line by line)
  var lines = html.split('\n');
  var out = [];
  var inList = false;
  var listType = '';

  function closeList() { if (inList) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); inList = false; } }
  function nextNonEmptyLine(startIdx) {
    for (var ni = startIdx; ni < lines.length; ni++) {
      if (lines[ni].trim()) return lines[ni];
    }
    return '';
  }
  function continuesCurrentList(nextLine) {
    if (!inList || !nextLine) return false;
    if (listType === 'ol') return /^(\s*)\d+\.\s+(.+)/.test(nextLine);
    return /^(\s*)[-*]\s+(.+)/.test(nextLine);
  }
  function openList(type) {
    if (inList && listType !== type) closeList();
    if (!inList) {
      var style = type === 'ol' ? 'margin:2px 0 2px 20px;padding:0' : type === 'cb' ? 'margin:2px 0 2px 16px;padding:0;list-style:none' : 'margin:2px 0 2px 16px;padding:0';
      out.push('<' + (type === 'ol' ? 'ol' : 'ul') + ' style="' + style + '">');
      inList = true; listType = type === 'cb' ? 'ul' : type;
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Code block placeholder — pass through as-is
    if (line.match(/^\x00CB\d+\x00$/)) { closeList(); out.push(line); continue; }

    // Headings
    var headMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headMatch) {
      closeList();
      var sizes = { 1: '16px', 2: '14px', 3: '13px', 4: '12px' };
      out.push('<div style="font-weight:600;font-size:' + sizes[headMatch[1].length] + ';margin:8px 0 4px">' + headMatch[2] + '</div>');
      continue;
    }

    // Horizontal rule (only bare ---, ***, ___ lines)
    if (/^[-*_]{3,}\s*$/.test(line) && !/\S/.test(line.replace(/[-*_]/g, ''))) {
      closeList();
      out.push('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">');
      continue;
    }

    // Blockquote
    if (line.match(/^&gt;\s?/)) {
      closeList();
      out.push('<div style="border-left:3px solid var(--border);padding-left:8px;color:var(--muted);margin:2px 0">' + line.replace(/^(&gt;\s?)+/, '') + '</div>');
      continue;
    }

    // Table: detect | col | col | rows, consume until non-table line
    if (line.match(/^\|.+\|/)) {
      closeList();
      var tableRows = [];
      var sepIdx = -1;
      while (i < lines.length && lines[i].match(/^\|.+\|/)) {
        var row = lines[i].replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(c) { return c.trim(); });
        if (lines[i].match(/^\|[\s:]*-{2,}[\s:]*\|/)) { sepIdx = tableRows.length; }
        else { tableRows.push(row); }
        i++;
      }
      i--; // back up one since the for loop will increment
      var tableHtml = '<div class="md-table-wrap"><table style="font-size:11px"><thead><tr>';
      if (tableRows.length > 0) {
        tableRows[0].forEach(function(c) { tableHtml += '<th>' + c + '</th>'; });
        tableHtml += '</tr></thead><tbody>';
        for (var ti = 1; ti < tableRows.length; ti++) {
          tableHtml += '<tr>';
          tableRows[ti].forEach(function(c) { tableHtml += '<td>' + c + '</td>'; });
          tableHtml += '</tr>';
        }
        tableHtml += '</tbody></table></div>';
      }
      out.push(tableHtml);
      continue;
    }

    // Checkbox list (must come before UL — both start with - )
    var cbMatch = line.match(/^(\s*)[-*]\s\[([ xX])\]\s(.+)/);
    if (cbMatch) {
      openList('cb');
      out.push('<li>' + (cbMatch[2] !== ' ' ? '\u2611' : '\u2610') + ' ' + cbMatch[3] + '</li>');
      continue;
    }

    // Unordered list (- or * followed by space and content, not bare --- or ***)
    var ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      openList('ul');
      out.push('<li>' + ulMatch[2] + '</li>');
      continue;
    }

    // Ordered list
    var olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      openList('ol');
      out.push('<li>' + olMatch[2] + '</li>');
      continue;
    }

    // Blank line → spacer
    if (!line.trim()) {
      if (continuesCurrentList(nextNonEmptyLine(i + 1))) continue;
      closeList();
      out.push('<div style="height:4px"></div>');
      continue;
    }

    // Non-list line — close any open list
    closeList();

    out.push('<div>' + line + '</div>');
  }
  closeList();
  html = out.join('\n');

  // 4. Restore code placeholders
  html = html.replace(/\x00CB(\d+)\x00/g, function(_, idx) { return codeSlots[idx]; });

  return '<div class="md-content">' + html + '</div>';
}

var MD_CHUNK_SIZE = 10000;
var _mdChunkUid = 0;

function _renderMdChunked(fullText) {
  // Close unclosed code fences before chunking
  fullText = _normalizeCodeFences(fullText);

  // Split at blank-line boundaries to avoid breaking code blocks and other multi-line elements
  var chunks = [];
  var pos = 0;
  while (pos < fullText.length) {
    if (pos + MD_CHUNK_SIZE >= fullText.length) {
      chunks.push(fullText.slice(pos));
      break;
    }
    var target = pos + MD_CHUNK_SIZE;
    var searchStart = Math.max(pos + Math.floor(MD_CHUNK_SIZE * 0.7), pos);
    var searchEnd = Math.min(target + 500, fullText.length);
    // Find the last \n\n in [searchStart, searchEnd] that isn't inside a code fence
    var fencesBefore = (fullText.slice(pos, searchStart).match(/```/g) || []).length;
    var inFence = (fencesBefore % 2) === 1;
    var best = null;
    for (var si = searchStart; si < searchEnd - 1; si++) {
      if (fullText[si] === '`' && fullText[si + 1] === '`' && fullText[si + 2] === '`') {
        inFence = !inFence;
        si += 2;
      } else if (!inFence && fullText[si] === '\n' && fullText[si + 1] === '\n') {
        best = si + 2;
      }
    }
    if (best === null) {
      var nl = fullText.indexOf('\n', target);
      best = (nl !== -1 && nl - target < 500) ? nl + 1 : target;
    }
    chunks.push(fullText.slice(pos, best));
    pos = best;
  }

  var firstHtml = _renderMdCore(chunks[0]);
  var uid = '_mdChunk' + (++_mdChunkUid);
  if (chunks.length <= 1) return firstHtml;

  var sentinel = '<div id="' + uid + '" style="padding:12px 0;color:var(--muted);font-size:11px">Loading more content...</div>';

  setTimeout(function() {
    var el = document.getElementById(uid);
    if (!el) return;
    var scrollParent = el.closest('.modal-body') || el.parentElement;
    var idx = 1;
    var obs = null;
    function loadNext() {
      if (idx >= chunks.length) {
        if (obs) obs.disconnect();
        el.remove();
        return;
      }
      el.insertAdjacentHTML('beforebegin', _renderMdCore(chunks[idx]));
      idx++;
      if (idx >= chunks.length) {
        if (obs) obs.disconnect();
        el.remove();
      }
    }
    if (typeof IntersectionObserver !== 'undefined') {
      obs = new IntersectionObserver(function(entries) {
        if (!entries[0].isIntersecting) return;
        loadNext();
        // Yield to browser for paint before re-observing, so rapid chunk loads don't block rendering
        if (idx < chunks.length && el.parentNode) {
          obs.unobserve(el);
          requestAnimationFrame(function() { if (el.parentNode) obs.observe(el); });
        }
      }, { root: scrollParent, rootMargin: '200px' });
      obs.observe(el);
    } else {
      var timer = setInterval(function() { loadNext(); if (idx >= chunks.length) clearInterval(timer); }, 100);
    }
  }, 0);

  return firstHtml + sentinel;
}

function openBugReport() {
  document.getElementById('modal-title').textContent = 'Report a Bug';
  document.getElementById('modal-body').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:12px">' +
      '<p style="color:var(--muted);font-size:12px;margin:0">File a bug on the Minions repo (yemi33/minions).</p>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Title' +
        '<input id="bug-title" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text)" placeholder="Short description of the bug"></label>' +
      '<label style="color:var(--text);font-size:var(--text-md)">Description' +
        '<textarea id="bug-desc" rows="6" style="display:block;width:100%;margin-top:4px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);resize:vertical;font-family:inherit" placeholder="Steps to reproduce, expected vs actual behavior..."></textarea></label>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px">' +
        '<button onclick="closeModal()" class="pr-pager-btn">Cancel</button>' +
        '<button onclick="submitBugReport()" style="padding:6px 16px;background:var(--red);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">File Bug</button>' +
      '</div>' +
    '</div>';
  document.getElementById('modal').classList.add('open');
}

async function submitBugReport() {
  var title = document.getElementById('bug-title')?.value?.trim();
  var desc = document.getElementById('bug-desc')?.value?.trim();
  if (!title) { alert('Title is required'); return; }

  // Show progress inside the modal
  var btn = document.querySelector('#modal button[onclick="submitBugReport()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Filing...'; }

  try {
    var res = await fetch('/api/issues/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, description: desc || '' })
    });
    var d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed');

    // Show success inside the modal
    document.getElementById('modal-body').innerHTML =
      '<div style="padding:24px;text-align:center">' +
        '<div style="font-size:32px;margin-bottom:12px">&#128027;</div>' +
        '<div style="color:var(--green);font-weight:600;margin-bottom:8px">Bug filed!</div>' +
        (d.url ? '<a href="' + escHtml(d.url) + '" target="_blank" style="color:var(--blue);font-size:13px">View issue on GitHub</a>' : '<span style="color:var(--muted);font-size:12px">Issue created on yemi33/minions</span>') +
        '<div style="margin-top:16px"><button onclick="closeModal()" style="padding:6px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;color:var(--text)">Close</button></div>' +
      '</div>';
  } catch (e) {
    // Show error inside the modal — let user retry
    if (btn) { btn.disabled = false; btn.textContent = 'File Bug'; }
    var errDiv = document.getElementById('bug-error');
    if (!errDiv) {
      errDiv = document.createElement('div');
      errDiv.id = 'bug-error';
      errDiv.style.cssText = 'color:var(--red);font-size:12px;padding:8px;background:rgba(248,81,73,0.1);border-radius:4px';
      btn?.parentElement?.parentElement?.appendChild(errDiv);
    }
    errDiv.textContent = 'Error: ' + e.message;
  }
}

window.MinionsUtils = { wakeEngine, markDeleted, clearDeleted, escapeHtml, escHtml, renderMd, normalizePlanFile, timeAgo, statusColor, shouldIgnoreSelectionClick, llmCopyBtn, copyLlmText, openBugReport, submitBugReport };
