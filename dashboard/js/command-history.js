// command-history.js — Command history functions extracted from dashboard.html

const CMD_HISTORY_KEY = 'minions-cmd-history';
const CMD_HISTORY_MAX = 50;
let _cmdHistoryIdx = -1; // -1 = not browsing history
let _cmdHistoryDraft = ''; // saves current draft when browsing

function cmdGetHistory() {
  try { return JSON.parse(localStorage.getItem(CMD_HISTORY_KEY) || '[]'); } catch { return []; }
}

function cmdSaveHistory(raw, intent) {
  const history = cmdGetHistory();
  history.unshift({ text: raw, intent, timestamp: new Date().toISOString() });
  if (history.length > CMD_HISTORY_MAX) history.length = CMD_HISTORY_MAX;
  localStorage.setItem(CMD_HISTORY_KEY, JSON.stringify(history));
}

function cmdShowHistory() {
  const history = cmdGetHistory();
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  title.textContent = 'Past Commands (' + history.length + ')';

  if (history.length === 0) {
    body.innerHTML = '<div class="cmd-history-empty">No commands yet. Submit something from the command center.</div>';
  } else {
    const intentColors = { 'work-item': 'var(--blue)', 'note': 'var(--green)', 'plan': 'var(--purple,#a855f7)' };
    const intentLabels = { 'work-item': 'Work Item', 'note': 'Note', 'plan': 'Plan' };
    body.innerHTML = '<ul class="cmd-history-list">' + history.map((item, i) => {
      const date = new Date(item.timestamp);
      const ago = timeSinceStr(date);
      const intentLabel = intentLabels[item.intent] || item.intent || 'work-item';
      const intentColor = intentColors[item.intent] || 'var(--blue)';
      return '<li class="cmd-history-item">' +
        '<div class="cmd-history-item-body">' +
          '<div class="cmd-history-item-text">' + escHtml(item.text) + '</div>' +
          '<div class="cmd-history-item-meta">' +
            '<span class="chip" style="color:' + intentColor + '">' + intentLabel + '</span>' +
            '<span>' + ago + '</span>' +
            '<span>' + formatLocalDateTime(date) + '</span>' +
          '</div>' +
        '</div>' +
        '<button class="cmd-history-resubmit" onclick="cmdResubmit(' + i + ')">Resubmit</button>' +
      '</li>';
    }).join('') + '</ul>';
  }

  document.getElementById('modal').classList.add('open');
}

function cmdResubmit(idx) {
  const history = cmdGetHistory();
  const item = history[idx];
  if (!item) return;
  document.getElementById('modal').classList.remove('open');
  const input = document.getElementById('cmd-input');
  input.value = item.text;
  cmdAutoResize();
  cmdRenderMeta();
  input.focus();
}

function timeSinceStr(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

window.MinionsCmdHistory = { cmdGetHistory, cmdSaveHistory, cmdShowHistory, cmdResubmit, timeSinceStr };
