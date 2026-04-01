// dashboard/js/utils.js — Utility functions extracted from dashboard.html

// Signal the engine to tick immediately (pick up new work without waiting 60s)
function wakeEngine() { fetch('/api/engine/wakeup', { method: 'POST' }).catch(() => {}); }

// Optimistic delete suppression — prevent auto-refresh from re-showing deleted items
const _deletedIds = new Map(); // key → expiry timestamp
function markDeleted(key) { _deletedIds.set(key, Date.now() + 10000); } // suppress for 10s
function isDeleted(key) { const exp = _deletedIds.get(key); if (!exp) return false; if (Date.now() > exp) { _deletedIds.delete(key); return false; } return true; }

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

/**
 * Lightweight markdown → HTML renderer. XSS-safe (escapes first, then transforms).
 * Handles: headings, bold, italic, inline code, code blocks, links, blockquotes,
 * horizontal rules, ordered/unordered/checkbox lists, and tables.
 */
function renderMd(s) {
  if (!s) return '';
  let html = escHtml(s);

  // 1. Extract code blocks and inline code into placeholders (protect from other transforms)
  const codeSlots = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    codeSlots.push('<pre style="background:var(--bg);padding:8px;border-radius:4px;overflow-x:auto;font-size:11px;margin:4px 0"><code>' + code + '</code></pre>');
    return '\x00CB' + (codeSlots.length - 1) + '\x00';
  });
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
      var tableHtml = '<table class="pr-table" style="margin:4px 0;font-size:11px"><thead><tr>';
      if (tableRows.length > 0) {
        tableRows[0].forEach(function(c) { tableHtml += '<th>' + c + '</th>'; });
        tableHtml += '</tr></thead><tbody>';
        for (var ti = 1; ti < tableRows.length; ti++) {
          tableHtml += '<tr>';
          tableRows[ti].forEach(function(c) { tableHtml += '<td>' + c + '</td>'; });
          tableHtml += '</tr>';
        }
        tableHtml += '</tbody></table>';
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

    // Non-list line — close any open list
    closeList();

    // Blank line → spacer
    if (!line.trim()) { out.push('<div style="height:4px"></div>'); continue; }

    out.push('<div>' + line + '</div>');
  }
  closeList();
  html = out.join('\n');

  // 4. Restore code placeholders
  html = html.replace(/\x00CB(\d+)\x00/g, function(_, idx) { return codeSlots[idx]; });

  return html;
}

window.MinionsUtils = { wakeEngine, escHtml, renderMd, normalizePlanFile, timeAgo, statusColor, llmCopyBtn, copyLlmText };
