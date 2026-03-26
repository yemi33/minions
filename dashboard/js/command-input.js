// command-input.js — Command input UI functions extracted from dashboard.html

// Auto-resize textarea
function cmdAutoResize() {
  const ta = document.getElementById('cmd-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

function cmdUpdateHighlight() {
  const text = document.getElementById('cmd-input').value;
  const hl = document.getElementById('cmd-highlight');
  if (!text) { hl.innerHTML = ''; return; }
  // Escape HTML then wrap tokens with highlight spans
  let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/(\/(?:plan|note|decide)\b)/gi, '<span class="hl-cmd">$1</span>');
  html = html.replace(/(@\w+)/g, '<span class="hl-mention">$1</span>');
  html = html.replace(/(![a-z]+\b)/gi, '<span class="hl-priority">$1</span>');
  html = html.replace(/(#\S+)/g, '<span class="hl-project">$1</span>');
  html = html.replace(/(--(?:stack|parallel)\b)/gi, '<span class="hl-flag">$1</span>');
  hl.innerHTML = html + '\n'; // trailing newline prevents layout shift
}

function syncHighlightScroll() {
  const ta = document.getElementById('cmd-input');
  const hl = document.getElementById('cmd-highlight');
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
}

function cmdInputChanged() {
  cmdAutoResize();
  cmdUpdateHighlight();
  cmdRenderMeta();

  // Check for @ mention or # project trigger
  const input = document.getElementById('cmd-input');
  const cursor = input.selectionStart;
  const before = input.value.slice(0, cursor);
  const atMatch = before.match(/@(\w*)$/);
  const hashMatch = before.match(/#(\w*)$/);
  if (atMatch) {
    cmdShowMentions(atMatch[1]);
  } else if (hashMatch) {
    cmdShowProjects(hashMatch[1]);
  } else {
    cmdHidePopup();
  }
}

function cmdKeyDown(e) {
  const popup = document.getElementById('cmd-mention-popup');
  const isPopupVisible = popup.classList.contains('visible');

  // Navigate mention popup with arrow keys
  if (isPopupVisible) {
    const items = popup.querySelectorAll('.cmd-mention-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      cmdMentionIdx = (cmdMentionIdx + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === cmdMentionIdx));
      items[cmdMentionIdx]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      cmdMentionIdx = (cmdMentionIdx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === cmdMentionIdx));
      items[cmdMentionIdx]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const active = items[cmdMentionIdx >= 0 ? cmdMentionIdx : 0];
      if (active) cmdInsertPopupItem(active.dataset.id);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cmdHidePopup();
      return;
    }
  }

  // ArrowUp/ArrowDown to navigate command history (only when no popup visible)
  if (e.key === 'ArrowUp' && !isPopupVisible) {
    const input = document.getElementById('cmd-input');
    // Only intercept if cursor is at start of input (or input is single-line)
    if (input.selectionStart === 0 || !input.value.includes('\n')) {
      const history = cmdGetHistory();
      if (history.length === 0) return;
      if (_cmdHistoryIdx === -1) _cmdHistoryDraft = input.value; // Save current draft
      if (_cmdHistoryIdx < history.length - 1) {
        _cmdHistoryIdx++;
        input.value = history[_cmdHistoryIdx].text;
        cmdAutoResize();
        cmdRenderMeta();
        e.preventDefault();
        // Move cursor to end
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
      return;
    }
  }
  if (e.key === 'ArrowDown' && !isPopupVisible) {
    const input = document.getElementById('cmd-input');
    if (input.selectionStart === input.value.length || !input.value.includes('\n')) {
      if (_cmdHistoryIdx >= 0) {
        _cmdHistoryIdx--;
        const history = cmdGetHistory();
        input.value = _cmdHistoryIdx >= 0 ? history[_cmdHistoryIdx].text : (_cmdHistoryDraft || '');
        cmdAutoResize();
        cmdRenderMeta();
        e.preventDefault();
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
      return;
    }
  }

  // Ctrl+Enter to submit
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    cmdSubmit();
  }
}

async function cmdSubmit() {
  const input = document.getElementById('cmd-input');
  const raw = input.value.trim();
  if (!raw) return showToast('cmd-toast', 'Type something first', false);

  // Route to Command Center panel
  input.value = '';
  if (!_ccOpen) toggleCommandCenter();
  document.getElementById('cc-input').value = raw;
  ccSend();
  cmdSaveHistory(raw, 'cc');
  return;
}

// Render the parsed meta chips below input
function cmdRenderMeta() {
  const el = document.getElementById('cmd-meta');
  const input = document.getElementById('cmd-input').value;
  if (!input.trim()) { el.innerHTML = ''; return; }

  const parsed = cmdParseInput(input);
  let chips = [];

  // Intent chip
  if (parsed.intent === 'plan') {
    const strategy = parsed.branchStrategy || 'parallel';
    const stratLabel = strategy === 'parallel' ? 'parallel branches' : 'stacked';
    chips.push('<span class="cmd-chip" style="background:var(--purple,#a855f7);color:#fff">Plan → PRD → Dispatch (' + stratLabel + ')</span>');
  } else {
    const intentLabels = { 'work-item': 'Work Item', 'note': 'Note', 'plan': 'Plan' };
    chips.push('<span class="cmd-chip intent">' + intentLabels[parsed.intent] + '</span>');
  }

  // Type chip (only for work items)
  if (parsed.intent === 'work-item') {
    chips.push('<span class="cmd-chip">' + parsed.type + '</span>');
  }

  // Priority chip
  chips.push('<span class="cmd-chip priority-' + parsed.priority + '">' + parsed.priority + ' priority</span>');

  // Agent chips
  if (parsed.fanout) {
    chips.push('<span class="cmd-chip fanout">@everyone (fan-out)</span>');
  }
  for (const agentId of parsed.agents) {
    const agent = cmdAgents.find(a => a.id === agentId);
    if (agent) {
      chips.push('<span class="cmd-chip agent-chip">' + agent.emoji + ' @' + agent.name + '</span>');
    }
  }

  // Project chip(s)
  if (parsed.projects.length > 0) {
    parsed.projects.forEach(p => chips.push('<span class="cmd-chip project-chip">#' + escHtml(p) + '</span>'));
  } else if (parsed.project) {
    chips.push('<span class="cmd-chip project-chip">#' + escHtml(parsed.project) + '</span>');
  }

  el.innerHTML = chips.join('');
}

// Autocomplete popup (shared for @mentions and #projects)
let cmdPopupMode = ''; // '@' or '#'

function cmdShowMentions(query) {
  cmdPopupMode = '@';
  const popup = document.getElementById('cmd-mention-popup');
  const q = query.toLowerCase();
  let items = [];

  // Always show @everyone option
  items.push({ id: 'everyone', name: 'everyone', emoji: '\u{1F4E2}', role: 'Fan-out to all agents' });

  for (const a of cmdAgents) {
    if (!q || a.id.includes(q) || a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)) {
      items.push(a);
    }
  }

  if (items.length === 0) { popup.classList.remove('visible'); return; }

  cmdMentionIdx = 0;
  popup.innerHTML = items.map((a, i) =>
    '<div class="cmd-mention-item' + (i === 0 ? ' active' : '') + '" data-id="' + a.id + '" onclick="cmdInsertPopupItem(\'' + escHtml(a.id) + '\')">' +
      '<span class="mention-emoji">' + a.emoji + '</span>' +
      '<span class="mention-name">@' + escHtml(a.name) + '</span>' +
      '<span class="mention-role">' + escHtml(a.role) + '</span>' +
    '</div>'
  ).join('');
  popup.classList.add('visible');
  popup.scrollTop = 0;
}

function cmdShowProjects(query) {
  cmdPopupMode = '#';
  const popup = document.getElementById('cmd-mention-popup');
  const q = query.toLowerCase();
  let items = cmdProjects.filter(p => !q || p.name.toLowerCase().includes(q));

  if (items.length === 0) { popup.classList.remove('visible'); return; }

  cmdMentionIdx = 0;
  popup.innerHTML = items.map((p, i) =>
    '<div class="cmd-mention-item' + (i === 0 ? ' active' : '') + '" data-id="' + escHtml(p.name) + '" onclick="cmdInsertPopupItem(\'' + escHtml(p.name) + '\')">' +
      '<span class="mention-emoji">\u{1F4C1}</span>' +
      '<span class="mention-name" style="color:var(--green)">#' + escHtml(p.name) + '</span>' +
      '<span class="mention-role">' + escHtml(p.description.slice(0, 50)) + (p.description.length > 50 ? '...' : '') + '</span>' +
    '</div>'
  ).join('');
  popup.classList.add('visible');
  popup.scrollTop = 0;
}

function cmdHidePopup() {
  document.getElementById('cmd-mention-popup').classList.remove('visible');
  cmdMentionIdx = -1;
  cmdPopupMode = '';
}

function cmdInsertPopupItem(id) {
  const input = document.getElementById('cmd-input');
  const val = input.value;
  const cursor = input.selectionStart;
  const before = val.slice(0, cursor);
  const trigger = cmdPopupMode; // '@' or '#'
  const triggerIdx = before.lastIndexOf(trigger);
  if (triggerIdx === -1) return;
  const after = val.slice(cursor);
  input.value = before.slice(0, triggerIdx) + trigger + id + ' ' + after;
  input.focus();
  const newPos = triggerIdx + id.length + 2;
  input.setSelectionRange(newPos, newPos);
  cmdHidePopup();
  cmdRenderMeta();
}
