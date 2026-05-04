// command-center.js — Command center panel functions extracted from dashboard.html

// ── Multi-tab state ──────────────────────────────────────────────────────────
var CC_MAX_TABS = 20;
var CC_MAX_MESSAGES_PER_TAB = 30;
var CC_TITLE_MAX_LENGTH = 40;

var _ccTabs = [];         // [{id, title, sessionId, messages: [{role, html}]}]
var _ccActiveTabId = null;
var _ccOpen = false;
var _ccRetrySeq = 0;
// Per-tab sending state stored on tab objects: tab._sending, tab._queue, tab._abortController
// Legacy globals for backward compat (badge, drawer close check)
var _ccSending = false; // true if active tab is sending (UI indicator only)
// Clear stale sending state on page load — SSE streams don't survive refresh
try { localStorage.removeItem('cc-sending'); } catch {}

function _ccStripActionBlockFromText(value) {
  var text = value || '';
  if (!text) return text;
  // Tier 1 — strict: 3 leading + 0-3 trailing equals on its own line.
  var full = /(?:^|\r?\n)===ACTIONS={0,3}[ \t]*(?=\r?\n|$)/m.exec(text);
  if (full) return text.slice(0, full.index + full[0].indexOf('===ACTIONS')).trim();
  // Tier 2 — loose: ===ACTIONS followed by punctuation/extra-equals to EOL.
  var block = /(?:^|\r?\n)===ACTIONS\b[^\r\n]*(?=\r?\n|$)/m.exec(text);
  if (block) return text.slice(0, block.index + block[0].indexOf('===ACTIONS')).trim();
  // Tier 3 — very loose: 2+ leading equals + ACTIONS keyword + 0+ trailing
  // equals, case-insensitive. Catches ====ACTIONS===, ===actions===, etc.
  var veryLoose = /(?:^|\r?\n)={2,}[ \t]*ACTIONS[ \t]*={0,}[ \t]*(?=\r?\n|$)/im.exec(text);
  if (veryLoose) {
    var offset = veryLoose[0].search(/=/);
    var headerStart = veryLoose.index + (offset >= 0 ? offset : 0);
    return text.slice(0, headerStart).trim();
  }
  // Partial delimiter at chunk tail (streaming): strip "=", "==", "===", etc.,
  // and prefixes of "===ACTIONS===" so the user never sees a raw partial.
  var delimiter = '===ACTIONS===';
  var lineStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  var trailingLine = text.slice(lineStart).trimEnd();
  if (!trailingLine) return text;
  if (/^=+$/.test(trailingLine)) return text.slice(0, lineStart).trimEnd();
  if (trailingLine.length >= 1 && trailingLine.length < delimiter.length
      && delimiter.toLowerCase().indexOf(trailingLine.toLowerCase()) === 0) {
    return text.slice(0, lineStart).trimEnd();
  }
  return text;
}

// ── Migration from legacy single-session format ─────────────────────────────
(function _ccMigrateLegacy() {
  try {
    var legacyTabs = localStorage.getItem('cc-tabs');
    if (legacyTabs) {
      // Already migrated — load tabs
      _ccTabs = JSON.parse(legacyTabs) || [];
      // P-1: clean any historical action-block dirt persisted by prior buggy
      // versions before the strip pipeline was hardened. Runs once per load;
      // ccSaveState applies the same strip on the way out so future writes
      // can't reintroduce it.
      for (var ti = 0; ti < _ccTabs.length; ti++) {
        var msgs = _ccTabs[ti].messages || [];
        for (var mi = 0; mi < msgs.length; mi++) {
          var m = msgs[mi];
          if (m && typeof m.html === 'string') {
            var stripped = _ccStripActionBlockFromText(m.html);
            if (stripped !== m.html) m.html = stripped;
          }
        }
      }
      _ccActiveTabId = localStorage.getItem('cc-active-tab') || (_ccTabs.length > 0 ? _ccTabs[0].id : null);
      return;
    }
    var legacySessionId = localStorage.getItem('cc-session-id');
    var legacyMessages = JSON.parse(localStorage.getItem('cc-messages') || '[]');
    if (legacySessionId || legacyMessages.length > 0) {
      var tabId = 'cc-' + Date.now().toString(36);
      var title = 'New chat';
      if (legacyMessages.length > 0) {
        var firstUser = legacyMessages.find(function(m) { return m.role === 'user'; });
        if (firstUser) {
          var tmp = document.createElement('div');
          tmp.innerHTML = firstUser.html;
          var txt = (tmp.textContent || tmp.innerText || '').trim();
          if (txt.length > 0) title = txt.slice(0, CC_TITLE_MAX_LENGTH);
        }
      }
      _ccTabs = [{ id: tabId, title: title, sessionId: legacySessionId, messages: legacyMessages.slice(-CC_MAX_MESSAGES_PER_TAB) }];
      _ccActiveTabId = tabId;
      // Remove legacy keys
      localStorage.removeItem('cc-session-id');
      localStorage.removeItem('cc-messages');
      ccSaveState();
    }
  } catch { /* ignore migration errors */ }
})();

// ── Tab helper: get active tab ──────────────────────────────────────────────
function _ccActiveTab() {
  if (!_ccActiveTabId || _ccTabs.length === 0) return null;
  return _ccTabs.find(function(t) { return t.id === _ccActiveTabId; }) || null;
}

function _ccMergeStreamText(prev, incoming) {
  // `prev` is already merged-clean from prior frames (server strips actions
  // before SSE emission, and any leaked partial was sanitized by the previous
  // _ccMergeStreamText call). Only strip `incoming` defensively — re-stripping
  // `prev` every frame is O(n²) over the response length for nothing.
  var current = prev || '';
  var next = _ccStripActionBlockFromText(incoming || '');
  if (!current) return next;
  if (!next) return current;
  if (next === current) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;
  for (var overlap = Math.min(current.length, next.length); overlap > 0; overlap--) {
    if (current.slice(-overlap) === next.slice(0, overlap)) {
      return current + next.slice(overlap);
    }
  }
  return current + '\n\n' + next;
}

async function _ccDashboardHealth() {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 3000);
  try {
    var res = await fetch('/api/status', { signal: controller.signal, cache: 'no-store' });
    if (!(res && res.ok)) return { reachable: false, restarted: false };
    var data = await res.json().catch(function() { return null; });
    var currentDashId = data && data.version ? data.version.dashboardStartedAt : null;
    var knownDashId = window._lastStatus && window._lastStatus.version ? window._lastStatus.version.dashboardStartedAt : null;
    return {
      reachable: true,
      restarted: !!(currentDashId && knownDashId && currentDashId !== knownDashId)
    };
  } catch {
    return { reachable: false, restarted: false };
  } finally {
    clearTimeout(timer);
  }
}

function _ccIsReconnectableStreamError(err) {
  if (!err) return false;
  var name = String(err.name || '').toLowerCase();
  var message = String(err.message || err || '').toLowerCase();
  if (name === 'aborterror') return true;
  return message === 'failed to fetch'
    || message === 'load failed'
    || message.includes('networkerror')
    || message.includes('network request failed')
    || message.includes('the internet connection appears to be offline')
    || message.includes('network connection was lost')
    || message.includes('cancelled')
    || message.includes('canceled')
    || message.includes('aborted');
}

function _ccJsArg(value) {
  return escHtml(JSON.stringify(value == null ? '' : String(value)));
}

function _ccStoreRetryRequest(tab, tabId, message) {
  if (!tab) return { id: '', tabId: tabId || '', message: String(message || '') };
  var id = 'cc-retry-' + Date.now().toString(36) + '-' + (++_ccRetrySeq);
  var request = { id: id, tabId: tabId || tab.id, message: String(message || ''), createdAt: Date.now() };
  if (!tab._retryRequests) tab._retryRequests = {};
  tab._retryRequests[id] = request;
  tab._lastRetryRequestId = id;
  tab._retryRequest = request;
  return request;
}

function _ccFindRetryRequest(tab, retryId) {
  if (!tab) return null;
  if (retryId && tab._retryRequests && tab._retryRequests[retryId]) return tab._retryRequests[retryId];
  if (tab._retryRequest) return tab._retryRequest;
  if (tab._lastRetryRequestId && tab._retryRequests) return tab._retryRequests[tab._lastRetryRequestId] || null;
  return null;
}

function _ccForgetRetryRequest(tab, retryId) {
  if (!tab || !retryId) return;
  if (tab._retryRequests) delete tab._retryRequests[retryId];
  if (tab._lastRetryRequestId === retryId) delete tab._lastRetryRequestId;
  if (tab._retryRequest && tab._retryRequest.id === retryId) delete tab._retryRequest;
}

function _ccRemoveRetryMessage(tab, retryId) {
  var removed = false;
  if (tab && retryId) {
    for (var i = tab.messages.length - 1; i >= 0; i--) {
      if (tab.messages[i] && tab.messages[i]._retryId === retryId) {
        tab.messages.splice(i, 1);
        removed = true;
        break;
      }
    }
  }
  if (retryId && tab && tab.id === _ccActiveTabId) {
    var msgs = document.getElementById('cc-messages');
    if (msgs) {
      Array.prototype.slice.call(msgs.children).some(function(child) {
        if (child.getAttribute && child.getAttribute('data-cc-retry-id') === retryId) {
          child.remove();
          removed = true;
          return true;
        }
        return false;
      });
    }
  }
  return removed;
}

function _ccFindPinTarget(query) {
  for (var i = 0; i < (inboxData || []).length; i++) {
    if (inboxData[i].name.toLowerCase().includes(query)) {
      return { key: inboxPinKey(inboxData[i].name), label: inboxData[i].name };
    }
  }
  for (var [cat, items] of Object.entries(_kbData || {})) {
    if (!Array.isArray(items)) continue;
    for (var j = 0; j < items.length; j++) {
      if ((items[j].title || '').toLowerCase().includes(query) || (items[j].file || '').toLowerCase().includes(query)) {
        return { key: kbPinKey(cat, items[j].file), label: items[j].title || items[j].file };
      }
    }
  }
  return null;
}

function ccAbort() {
  var tab = _ccActiveTab();
  if (tab && tab._abortController) {
    tab._userAborted = true;
    try {
      fetch('/api/command-center/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: tab.id })
      }).catch(function() {});
    } catch {}
    tab._abortController.abort();
    tab._abortController = null;
  }
}

function toggleCommandCenter() {
  _ccOpen = !_ccOpen;
  var drawer = document.getElementById('cc-drawer');
  var overlay = document.getElementById('cc-overlay');
  if (_ccOpen) ccApplySavedWidth();
  drawer.style.display = _ccOpen ? 'flex' : 'none';
  if (overlay) overlay.style.display = _ccOpen ? 'block' : 'none';
  if (_ccOpen) {
    // Ensure at least one tab exists
    if (_ccTabs.length === 0) ccNewTab(true);
    clearNotifBadge(document.getElementById('cc-toggle-btn'));
    var activeTabOnOpen = _ccActiveTab();
    if (activeTabOnOpen) activeTabOnOpen._unread = false;
    ccRenderTabBar();
    document.getElementById('cc-input').focus();
    ccRestoreMessages();
  } else if (_ccSending) {
    showNotifBadge(document.getElementById('cc-toggle-btn'), 'processing');
  }
}


function ccNewSession() {
  // Legacy wrapper — just creates a new tab
  ccNewTab();
}

function ccNewTab(skipServerReset) {
  if (_ccTabs.length >= CC_MAX_TABS) {
    // Remove oldest tab to make room
    var oldest = _ccTabs.shift();
    if (oldest && oldest.id === _ccActiveTabId) _ccActiveTabId = null;
  }
  var tabId = 'cc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  var tab = { id: tabId, title: 'New chat', sessionId: null, messages: [] };
  _ccTabs.push(tab);
  _ccActiveTabId = tabId;
  // New tab starts with null sessionId — server creates fresh session on first message
  document.getElementById('cc-messages').innerHTML = '';
  ccRenderTabBar();
  ccUpdateSessionIndicator();
  ccSaveState();
  var input = document.getElementById('cc-input');
  if (input) input.focus();
}

function ccSwitchTab(id) {
  if (id === _ccActiveTabId) return;
  var tab = _ccTabs.find(function(t) { return t.id === id; });
  if (!tab) return;
  // If there is an active request, keep it running but switch view
  _ccActiveTabId = id;
  tab._unread = false;
  var el = document.getElementById('cc-messages');
  el.innerHTML = '';
  // Re-render messages from the tab's data
  for (var i = 0; i < tab.messages.length; i++) {
    ccAddMessage(tab.messages[i].role, tab.messages[i].html, true);
  }
  // If this tab is still processing, restore the full streaming UX (tools, partial text, thinking)
  if (tab._sending) {
    var dotPulse = '<span style="display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle"><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.2s"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.4s"></span></span>';
    var restoreStart = tab._sendStartedAt || Date.now();
    var phases = [[0,'Thinking...'],[3000,'Reading minions context...'],[8000,'Analyzing...'],[15000,'Using tools to dig deeper...'],[30000,'Still working (multi-turn)...'],[60000,'Deep research in progress...']];
    function _restoreStreamHtml() {
      var html = '';
      var tools = tab._toolsUsed || [];
      if (tools.length > 0) {
        html += '<div style="margin-bottom:6px">';
        tools.forEach(function(t) {
          var name = typeof t === 'string' ? t : t.name;
          var input = typeof t === 'string' ? {} : (t.input || {});
          html += '<div style="color:var(--muted);font-size:10px;font-family:monospace"><span style="flex-shrink:0">&#9679;</span> ' + formatToolSummary(name, input) + '</div>';
        });
        html += '</div>';
      }
      var text = tab._streamedText || '';
      if (text) html += renderMd(text);
      var ms = Date.now() - restoreStart;
      var label = 'Thinking...';
      for (var pi = phases.length - 1; pi >= 0; pi--) { if (ms >= phases[pi][0]) { label = phases[pi][1]; break; } }
      var secs = Math.floor(ms / 1000);
      html += '<div style="margin-top:' + (text ? '6px' : '0') + ';display:flex;align-items:center;gap:6px"><span style="color:var(--muted);font-size:11px">' + label + '</span>' + dotPulse + '<span style="margin-left:auto;font-size:10px;color:var(--muted)">' + secs + 's</span>' +
        '<button onclick="ccAbort()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer;margin-left:4px">Stop</button></div>';
      return html;
    }
    ccAddMessage('assistant', _restoreStreamHtml(), true);
    var restoreDiv = el.lastElementChild;
    restoreDiv.id = 'cc-restore-thinking';
    restoreDiv.setAttribute('data-stream-tab', tab.id);
    el.scrollTop = el.scrollHeight;
    // Live update — stops when tab switches away or request completes
    var restoreInterval = setInterval(function() {
      var re = document.getElementById('cc-restore-thinking');
      if (!re || !tab._sending || _ccActiveTabId !== tab.id) { clearInterval(restoreInterval); return; }
      re.innerHTML = _restoreStreamHtml();
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) el.scrollTop = el.scrollHeight;
    }, 1000);
  }
  ccRenderTabBar();
  ccUpdateSessionIndicator();
  ccSaveState();
  var input = document.getElementById('cc-input');
  if (input) input.focus();
}

function ccCloseTab(id) {
  var idx = _ccTabs.findIndex(function(t) { return t.id === id; });
  if (idx === -1) return;
  var closingTab = _ccTabs.find(function(t) { return t.id === id; });
  if (closingTab && closingTab._sending) {
    if (!confirm('This tab has an active request. Close anyway?')) return;
    try {
      fetch('/api/command-center/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: id })
      }).catch(function() {});
    } catch {}
    closingTab._userAborted = true;
    if (closingTab._abortController) { closingTab._abortController.abort(); closingTab._abortController = null; }
    closingTab._sending = false;
    closingTab._queue = [];
    _ccSending = (_ccTabs.some(function(t) { return t._sending; }));
  }
  _ccTabs.splice(idx, 1);
  if (_ccActiveTabId === id) {
    // Switch to adjacent tab or create new
    if (_ccTabs.length === 0) {
      ccNewTab(true);
      return;
    }
    var newIdx = Math.min(idx, _ccTabs.length - 1);
    ccSwitchTab(_ccTabs[newIdx].id);
    return;
  }
  ccRenderTabBar();
  ccSaveState();
}

function ccRenderTabBar() {
  var bar = document.getElementById('cc-tab-bar');
  if (!bar) return;
  var html = '<div class="cc-tab-scroll">';
  for (var i = 0; i < _ccTabs.length; i++) {
    var t = _ccTabs[i];
    var isActive = t.id === _ccActiveTabId;
    html += '<div class="cc-tab' + (isActive ? ' active' : '') + (t._sending ? ' working' : '') + '" onclick="ccSwitchTab(\'' + t.id + '\')" title="' + escHtml(t.title) + '">';
    html += '<span class="cc-tab-text">' + escHtml(t.title) + '</span>';
    if (t._unread) html += '<span class="notif-badge done"></span>';
    html += '<span class="cc-tab-close" onclick="event.stopPropagation();ccCloseTab(\'' + t.id + '\')">&times;</span>';
    html += '</div>';
  }
  html += '<div class="cc-tab cc-tab-new" onclick="ccNewTab()" title="New tab">+</div>';
  html += '</div>';
  bar.innerHTML = html;
}

function ccRestoreMessages() {
  var el = document.getElementById('cc-messages');
  var tab = _ccActiveTab();
  if (!tab) return;
  if (el.children.length > 0 || tab.messages.length === 0) return; // Already rendered or nothing to restore
  for (var i = 0; i < tab.messages.length; i++) {
    ccAddMessage(tab.messages[i].role, tab.messages[i].html, true);
  }
  // Restore "thinking" indicator if CC was mid-request when page refreshed
  try {
    var sendingState = JSON.parse(localStorage.getItem('cc-sending') || 'null');
    // Only restore sending state if very recent (< 10s) — page refresh kills the SSE stream
    if (sendingState?.sending && (Date.now() - sendingState.startedAt) < 10000) {
      _ccSending = true;
      var elapsed = Date.now() - sendingState.startedAt;
      var thinking = document.createElement('div');
      thinking.id = 'cc-thinking';
      thinking.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:11px;color:var(--muted);align-self:flex-start;display:flex;align-items:center;gap:8px';
      thinking.innerHTML = '<span class="dot-pulse" style="display:inline-flex;gap:3px"><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.2s"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.4s"></span></span> <span id="cc-thinking-text">Still working...</span> <span id="cc-thinking-time" style="font-size:10px;color:var(--border)">' + Math.floor(elapsed / 1000) + 's</span>' +
        ' <button onclick="ccNewTab()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer">Reset</button>';
      el.appendChild(thinking);
      el.scrollTop = el.scrollHeight;
      // Update timer
      var startTime = sendingState.startedAt;
      var restoreTimer = setInterval(function() {
        var timeEl = document.getElementById('cc-thinking-time');
        if (!timeEl || !_ccSending) { clearInterval(restoreTimer); return; }
        timeEl.textContent = Math.floor((Date.now() - startTime) / 1000) + 's';
      }, 1000);
    }
  } catch {}
}

var _ccSaveDebounce = null;
function ccSaveState() {
  // Trim per-tab messages to prevent unbounded growth
  for (var i = 0; i < _ccTabs.length; i++) {
    if (_ccTabs[i].messages.length > 100) _ccTabs[i].messages = _ccTabs[i].messages.slice(-100);
  }
  // Debounce localStorage writes — no need to serialize on every message during streaming
  if (_ccSaveDebounce) return;
  _ccSaveDebounce = setTimeout(function() {
    _ccSaveDebounce = null;
    try {
      // P-1: Re-strip persisted message html as a final-line defense against
      // any future server-side regression. Messages are stored as rendered
      // HTML, but a leaked ===ACTIONS=== delimiter would survive markdown
      // rendering as literal text and round-trip into localStorage. Strip on
      // the way out so the persisted state is always clean.
      var toSave = _ccTabs.map(function(t) {
        var msgs = t.messages.slice(-CC_MAX_MESSAGES_PER_TAB).map(function(m) {
          if (!m || typeof m.html !== 'string') return m;
          var stripped = _ccStripActionBlockFromText(m.html);
          if (stripped === m.html) return m;
          return { role: m.role, html: stripped };
        });
        return { id: t.id, title: t.title, sessionId: t.sessionId, messages: msgs };
      });
      localStorage.setItem('cc-tabs', JSON.stringify(toSave));
      if (_ccActiveTabId) localStorage.setItem('cc-active-tab', _ccActiveTabId);
    } catch { /* localStorage might be full */ }
  }, 500);
}

function ccUpdateSessionIndicator() {
  var el = document.getElementById('cc-session-info');
  if (!el) return;
  var tab = _ccActiveTab();
  if (tab && tab.sessionId) {
    var turns = tab.messages.filter(function(m) { return m.role === 'user'; }).length;
    el.textContent = 'Session: ' + turns + ' turn' + (turns !== 1 ? 's' : '');
    el.style.color = 'var(--green)';
  } else {
    el.textContent = 'Ready';
    el.style.color = 'var(--muted)';
  }
}

function ccAddMessage(role, html, skipSave, targetTabId, meta) {
  var isUser = role === 'user';
  var isSystem = role === 'system';
  var isAction = role === 'action';
  var isAssistant = !isUser && !isSystem && !isAction;
  var targetTab = targetTabId ? _ccTabs.find(function(t) { return t.id === targetTabId; }) : _ccActiveTab();
  // Only render to DOM if this message is for the currently visible tab
  var isVisible = !targetTabId || targetTabId === _ccActiveTabId;
  if (isVisible) {
    var el = document.getElementById('cc-messages');
    var div = document.createElement('div');
    div.className = isAssistant ? 'cc-msg-assistant' : '';
    if (meta && meta.retryId) div.setAttribute('data-cc-retry-id', meta.retryId);
    div.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;max-width:95%;' +
      (isUser ? 'background:var(--blue);color:#fff;align-self:flex-end' : isSystem ? 'align-self:center;max-width:100%' : isAction ? 'align-self:flex-start;padding:2px 0' : 'background:var(--surface2);color:var(--text);align-self:flex-start;border:1px solid var(--border);position:relative');
    div.innerHTML = (isAssistant && !html.includes('color:var(--red)') && !html.includes('cc-queued-pill') ? llmCopyBtn() : '') + html;
    var wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    el.appendChild(div);
    if (wasNearBottom || isUser) requestAnimationFrame(function() { el.scrollTop = el.scrollHeight; });
  }
  if (!skipSave) {
    var tab = targetTab;
    if (tab) {
      var msg = { role: role, html: html };
      if (meta && meta.retryId) msg._retryId = meta.retryId;
      tab.messages.push(msg);
      // Auto-title from first user message
      if (role === 'user' && tab.title === 'New chat') {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var txt = (tmp.textContent || tmp.innerText || '').trim();
        if (txt.length > 0) {
          tab.title = txt.slice(0, CC_TITLE_MAX_LENGTH);
          ccRenderTabBar();
        }
      }
    }
    ccSaveState();
  }
}

async function ccSend() {
  var input = document.getElementById('cc-input');
  var message = input.value.trim();
  if (!message) return;
  input.value = '';

  var tab = _ccActiveTab();
  var originTabId = _ccActiveTabId;
  if (!tab) return;
  if (!tab._queue) tab._queue = [];

  // If this tab is already processing, queue the message
  if (tab._sending) {
    tab._queue.push(message);
    _renderQueueIndicator();
    return;
  }
  var wasAborted = await _ccDoSend(message, false, originTabId);

  // Flush queued messages to the ORIGINAL tab, even if user switched tabs
  while (tab._queue && tab._queue.length > 0) {
    if (wasAborted) {
      await new Promise(function(r) { setTimeout(r, 1500); });
    }
    var next = tab._queue.shift();
    _renderQueueIndicator();
    wasAborted = await _ccDoSend(next, false, originTabId);
  }
}

function _renderQueueIndicator() {
  // Remove all existing queue indicators
  document.querySelectorAll('.cc-queue-item').forEach(function(el) { el.remove(); });
  var tab = _ccActiveTab();
  var queue = (tab && tab._queue) || [];
  if (queue.length === 0) return;
  var msgs = document.getElementById('cc-messages');
  queue.forEach(function(m) {
    var el = document.createElement('div');
    el.className = 'cc-queue-item';
    el.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;max-width:95%;align-self:flex-end;background:var(--blue);color:#fff;opacity:0.5;order:9999';
    el.innerHTML = escHtml(m) + '<div style="font-size:9px;opacity:0.7;font-style:italic;margin-top:2px">queued</div>';
    msgs.appendChild(el);
  });
  if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
}

async function _ccDoSend(message, skipUserMsg, forceTabId) {
  // Client-side /pin and /unpin — no LLM round-trip needed
  var pinMatch = message.match(/^\/(pin|unpin)\s+(.+)/i);
  if (pinMatch) {
    if (!skipUserMsg) ccAddMessage('user', escHtml(message), false, forceTabId);
    var pinAction = pinMatch[1].toLowerCase();
    var pinQuery = pinMatch[2].toLowerCase().trim();
    var found = _ccFindPinTarget(pinQuery);
    if (found) {
      var wasPinned = isPinned(found.key);
      if (pinAction === 'pin' && !wasPinned) { togglePin(found.key); ccAddMessage('assistant', 'Pinned <strong>' + escHtml(found.label) + '</strong> to top', false, forceTabId); }
      else if (pinAction === 'unpin' && wasPinned) { togglePin(found.key); ccAddMessage('assistant', 'Unpinned <strong>' + escHtml(found.label) + '</strong>', false, forceTabId); }
      else { ccAddMessage('assistant', '<strong>' + escHtml(found.label) + '</strong> is already ' + (wasPinned ? 'pinned' : 'unpinned'), false, forceTabId); }
      showToast('cmd-toast', pinAction === 'pin' ? 'Pinned to top' : 'Unpinned', true);
      renderInbox(inboxData); renderKnowledgeBase();
    } else {
      ccAddMessage('assistant', 'No inbox or KB item matching "' + escHtml(pinQuery) + '"', false, forceTabId);
    }
    return;
  }

  // Use forced tab ID (from queue flush) or fall back to current active tab
  var activeTabId = forceTabId || _ccActiveTabId;
  var activeTab = _ccTabs.find(function(t) { return t.id === activeTabId; }) || _ccActiveTab();
  if (!activeTab) return;
  activeTab._sending = true;
  activeTab._sendStartedAt = Date.now();
  activeTab._abortController = new AbortController();
  activeTab._userAborted = false;
  _ccSending = true;
  ccRenderTabBar();
  var _wasAborted = false;
  try { localStorage.setItem('cc-sending', JSON.stringify({ sending: true, startedAt: Date.now() })); } catch {}

  // Scoped helper — always targets the originating tab, even if user switches tabs
  function addMsg(role, html, skipSave, meta) { ccAddMessage(role, html, skipSave, activeTabId, meta); }

  if (!skipUserMsg) addMsg('user', escHtml(message));

  // Remove queue indicator before processing (it'll be re-added if more queued)
  var existingQueueEl = document.getElementById('cc-queue-indicator');
  if (existingQueueEl) existingQueueEl.remove();

  var ccStartTime = Date.now();
  var reconnectAttempts = 0;
  var streamStatusNote = '';
  var phases = [
    [0, 'Thinking...'],
    [3000, 'Reading minions context...'],
    [8000, 'Analyzing...'],
    [15000, 'Using tools to dig deeper...'],
    [30000, 'Still working (multi-turn)...'],
    [60000, 'Deep research in progress...'],
    [180000, 'Still going (this is unusually long)...'],
    [300000, 'Timing out soon...'],
  ];

  // Streaming state — declared before try so updateStreamDiv works during fetch
  // Also saved on tab for restore when switching back
  var streamedText = '';
  var toolsUsed = [];
  if (activeTab) { activeTab._streamedText = ''; activeTab._toolsUsed = []; }

  // Get active tab's sessionId to send with request
  var tabSessionId = activeTab ? activeTab.sessionId : null;

  // Show thinking immediately — before fetch starts
  addMsg('assistant', '<span style="color:var(--muted);font-size:11px">Thinking...</span>', true);
  var msgs = document.getElementById('cc-messages');
  var streamDiv = msgs.lastElementChild;
  if (streamDiv) streamDiv.setAttribute('data-stream-tab', activeTabId);
  function _cleanupStreamDiv() {
    clearInterval(phaseTimer);
    if (streamDiv && streamDiv.parentNode) streamDiv.remove();
    // Only remove restore-thinking if it belongs to this tab (check data-stream-tab)
    var re = document.getElementById('cc-restore-thinking');
    if (re && re.getAttribute('data-stream-tab') === activeTabId) re.remove();
    var ds = document.querySelector('[data-stream-tab="' + activeTabId + '"]');
    if (ds) ds.remove();
  }
  var dotPulse = '<span style="display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle"><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.2s"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.4s"></span></span>';
    function _getThinkingHtml() {
      var elapsed = Date.now() - ccStartTime;
      var label = 'Thinking...';
      for (var pi = phases.length - 1; pi >= 0; pi--) {
        if (elapsed >= phases[pi][0]) { label = phases[pi][1]; break; }
      }
      var secs = Math.floor(elapsed / 1000);
      return '<div style="display:flex;align-items:center;gap:6px"><span style="color:var(--muted);font-size:11px">' + label + '</span>' + dotPulse + '<span style="margin-left:auto;font-size:10px;color:var(--muted)">' + secs + 's</span>' +
        '<button onclick="ccAbort()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer;margin-left:4px">Stop</button></div>';
    }
    function updateStreamDiv() {
      // Skip DOM updates if user switched to a different tab (restore interval handles that tab)
      if (_ccActiveTabId !== activeTabId) return;
      // Re-acquire streamDiv if it was detached (tab switch and back)
      if (!streamDiv.parentNode) {
        var re = document.getElementById('cc-restore-thinking') || document.querySelector('[data-stream-tab="' + activeTabId + '"]');
        if (re) { streamDiv = re; re.removeAttribute('id'); } else return;
      }
      var html = '';
      if (toolsUsed.length > 0) {
        html += '<div style="margin-bottom:6px">';
        toolsUsed.forEach(function(t) {
          var name = typeof t === 'string' ? t : t.name;
          var input = typeof t === 'string' ? {} : (t.input || {});
          html += '<div style="color:var(--muted);font-size:10px;font-family:monospace"><span style="flex-shrink:0">&#9679;</span> ' + formatToolSummary(name, input) + '</div>';
        });
        html += '</div>';
      }
      if (streamedText) {
        html += renderMd(streamedText);
      }
      if (streamStatusNote) {
        html += '<div style="margin-top:6px;font-size:10px;color:var(--muted)">' + escHtml(streamStatusNote) + '</div>';
      }
      html += '<div style="margin-top:' + (streamedText ? '6px' : '0') + '">' + _getThinkingHtml() + '</div>';
      streamDiv.innerHTML = html;
      // Re-append queue indicators so they stay below the streaming content
      if (activeTab._queue && activeTab._queue.length > 0) _renderQueueIndicator();
      if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
    }
    function _ccElapsedFooter(label) {
      var seconds = Math.round((Date.now() - ccStartTime) / 1000);
      return '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">' + label.replace('{seconds}', seconds) + '</div>';
    }
    function _ccRetryControls(retryRequest, extraHtml, showReload) {
      var retryTabId = retryRequest && retryRequest.tabId ? retryRequest.tabId : activeTabId;
      var retryId = retryRequest && retryRequest.id ? retryRequest.id : '';
      return (extraHtml || '') +
        '<button onclick="ccRetryLast(' + _ccJsArg(retryTabId) + ',' + _ccJsArg(retryId) + ')" style="margin-top:6px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--blue);cursor:pointer;font-size:11px">Retry</button>' +
        (showReload ? ' <button onclick="location.reload()" style="margin-top:6px;padding:4px 12px;background:var(--orange);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">Reload Page</button>' : '') +
        ' <button onclick="ccNewTab()" style="margin-top:6px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:11px">New Session</button>';
    }
    // Start phase timer immediately so thinking text updates while waiting for SSE
    var phaseTimer = setInterval(updateStreamDiv, 1000);
    updateStreamDiv(); // render proper layout immediately (not raw "Thinking..." text)

  async function _ccConsumeStream(requestBody, isReconnect) {
    var res = await fetch('/api/command-center/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: activeTab._abortController ? activeTab._abortController.signal : AbortSignal.timeout(960000)
    });

    if (!res.ok) {
      if (!isReconnect && res.status === 429 && (!activeTab._429retries || activeTab._429retries < 3)) {
        activeTab._429retries = (activeTab._429retries || 0) + 1;
        await new Promise(function(r) { setTimeout(r, 1500); });
        return await _ccConsumeStream({ message: message, tabId: activeTabId, sessionId: activeTab.sessionId || null }, false);
      }
      activeTab._429retries = 0;
      var errText = await res.text();
      if (isReconnect && res.status === 409) return { interrupted: true, reconnectable: false, reason: errText || 'No live stream' };
      throw new Error(errText || 'CC error');
    }

    activeTab._429retries = 0;
    streamStatusNote = '';
    updateStreamDiv();

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var terminalEventSeen = false;

    async function _handleEvent(evt) {
      if (evt.type === 'chunk') {
        streamedText = _ccMergeStreamText(streamedText, evt.text || '');
        if (activeTab) activeTab._streamedText = streamedText;
        updateStreamDiv();
      } else if (evt.type === 'heartbeat') {
        return;
      } else if (evt.type === 'thinking') {
        streamStatusNote = evt.text || 'Thinking...';
        if (activeTab) activeTab._streamStatusNote = streamStatusNote;
        updateStreamDiv();
      } else if (evt.type === 'tool') {
        toolsUsed.push({ name: evt.name, input: evt.input || {} });
        if (activeTab) activeTab._toolsUsed = toolsUsed.slice();
        updateStreamDiv();
        if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
      } else if (evt.type === 'done') {
        terminalEventSeen = true;
        _cleanupStreamDiv();
        if (evt.sessionReset) {
          addMsg('system', '<div style="text-align:center;padding:6px 12px;font-size:11px;color:var(--muted);background:var(--surface2);border-radius:6px;margin:4px 0">Minions was updated — started a fresh session with latest context.</div>', false, activeTabId);
        }
        var finalText = _ccMergeStreamText(streamedText, evt.text || '');
        var rendered = renderMd(finalText || streamedText || '');
        addMsg('assistant', rendered + _ccElapsedFooter('{seconds}s'));
        if (evt.sessionId !== undefined) {
          var originTab = _ccTabs.find(function(t) { return t.id === activeTabId; });
          if (originTab) { originTab.sessionId = evt.sessionId || null; }
          ccSaveState(); ccUpdateSessionIndicator();
        }
        if (evt.actions && evt.actions.length > 0) {
          _tagServerExecuted(evt.actions, evt.actionResults);
          for (var ai = 0; ai < evt.actions.length; ai++) { await ccExecuteAction(evt.actions[ai], activeTabId); }
          // Surface per-action errors/warnings inline alongside the prose so the user can see
          // exactly which actions failed or completed with caveats. Previously these only
          // appeared as a small "executed" pill which gave no detail.
          if (evt.actionResults && Array.isArray(evt.actionResults)) {
            var failures = evt.actionResults.filter(function(r) { return r && r.error; });
            var warnings = evt.actionResults.filter(function(r) { return r && r.warning; });
            if (failures.length > 0) {
              var failHtml = failures.map(function(r) { return '<li>' + escHtml(r.type || 'action') + ': ' + escHtml(r.error) + '</li>'; }).join('');
              addMsg('system', '<div style="padding:6px 12px;font-size:11px;color:var(--red);background:var(--surface2);border-radius:6px;margin:4px 0">⚠️ ' + failures.length + ' action' + (failures.length > 1 ? 's' : '') + ' failed:<ul style="margin:4px 0 0 16px;padding:0">' + failHtml + '</ul></div>', false, activeTabId);
            }
            if (warnings.length > 0) {
              var warnHtml = warnings.map(function(r) { return '<li>' + escHtml(r.type || 'action') + ': ' + escHtml(r.warning) + '</li>'; }).join('');
              addMsg('system', '<div style="padding:6px 12px;font-size:11px;color:var(--orange);background:var(--surface2);border-radius:6px;margin:4px 0">ℹ️ ' + warnings.length + ' action' + (warnings.length > 1 ? '' : '') + ' completed with warnings:<ul style="margin:4px 0 0 16px;padding:0">' + warnHtml + '</ul></div>', false, activeTabId);
            }
          }
        } else if (evt.actionParseError) {
          // Issue #1834: server saw ===ACTIONS=== but couldn't parse the JSON.
          // Surface as an inline warning so the user knows actions were dropped
          // (was previously silent — appeared as "actions failed" with no signal).
          addMsg('system', '<div style="padding:6px 12px;font-size:11px;color:var(--red);background:var(--surface2);border-radius:6px;margin:4px 0">⚠️ Actions block emitted but JSON could not be parsed — no actions were executed. Resend or rephrase. (' + escHtml(String(evt.actionParseError).slice(0, 200)) + ')</div>', false, activeTabId);
        }
      } else if (evt.type === 'error') {
        terminalEventSeen = true;
        _cleanupStreamDiv();
        addMsg('assistant', '<span style="color:var(--red)">' + escHtml(evt.error) + '</span>');
      }
    }

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;
      buf += decoder.decode(readResult.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        try { await _handleEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
    if (buf.trim()) {
      var remainingLines = buf.split('\n');
      for (var ri = 0; ri < remainingLines.length; ri++) {
        var rline = remainingLines[ri];
        if (!rline.startsWith('data: ')) continue;
        try { await _handleEvent(JSON.parse(rline.slice(6))); } catch {}
      }
    }
    return { interrupted: !terminalEventSeen, reconnectable: true };
  }

  try {
    while (true) {
      var consume = await _ccConsumeStream(
        reconnectAttempts === 0
          ? { message: message, tabId: activeTabId, sessionId: activeTab.sessionId || null }
          : { tabId: activeTabId, sessionId: activeTab.sessionId || null, reconnect: true },
        reconnectAttempts > 0
      );
      if (!consume.interrupted) break;
      if (!consume.reconnectable || reconnectAttempts >= 2) {
        _cleanupStreamDiv();
        var streamEndedHint = '<div style="font-size:10px;color:var(--muted);margin-top:4px">The response stream ended before completion. Retry to resend the interrupted message.</div>';
        var streamEndedRetry = _ccStoreRetryRequest(activeTab, activeTabId, message);
        if (streamedText) {
          addMsg('assistant', renderMd(streamedText) + _ccElapsedFooter('Stream interrupted after {seconds}s') + _ccRetryControls(streamEndedRetry, streamEndedHint, false), false, { retryId: streamEndedRetry.id });
        } else {
          addMsg('assistant', '<span style="color:var(--red)">The response stream ended before completion.</span>' + _ccRetryControls(streamEndedRetry, streamEndedHint, false), false, { retryId: streamEndedRetry.id });
        }
        break;
      }
      var reconnectHealth = await _ccDashboardHealth();
      if (!reconnectHealth.reachable || reconnectHealth.restarted) {
        _cleanupStreamDiv();
        var reconnectHint = reconnectHealth.restarted
          ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">Dashboard restarted while this response was streaming. Reload the page to reconnect to the new instance.</div>'
          : '<div style="font-size:10px;color:var(--muted);margin-top:4px">The request stream was interrupted, but the dashboard is still reachable. Retry or start a new session.</div>';
        var reconnectRetry = _ccStoreRetryRequest(activeTab, activeTabId, message);
        addMsg('assistant', (streamedText ? renderMd(streamedText) + _ccElapsedFooter('Stream interrupted after {seconds}s') : '') +
          _ccRetryControls(reconnectRetry, reconnectHint, reconnectHealth.restarted), false, { retryId: reconnectRetry.id });
        break;
      }
      reconnectAttempts++;
      streamedText = '';
      toolsUsed = [];
      if (activeTab) { activeTab._streamedText = ''; activeTab._toolsUsed = []; }
      streamStatusNote = 'Connection interrupted — reattaching to the live response...';
      updateStreamDiv();
      await new Promise(function(r) { setTimeout(r, 1000 * reconnectAttempts); });
    }
  } catch (e) {
    _cleanupStreamDiv();
    if (activeTab && activeTab._userAborted) {
      _wasAborted = true;
      if (streamedText) {
        addMsg('assistant', renderMd(streamedText) + _ccElapsedFooter('Stopped after {seconds}s'));
      } else {
        addMsg('assistant', '<span style="color:var(--red);font-size:11px">Stopped</span>');
      }
    } else {
      var isNetworkError = _ccIsReconnectableStreamError(e);
      var dashboardHealth = isNetworkError ? await _ccDashboardHealth() : { reachable: false, restarted: false };
      var connectionHint = '';
      if (isNetworkError) {
        connectionHint = dashboardHealth.restarted
          ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">Dashboard restarted while this response was streaming. Reload the page to reconnect to the new instance.</div>'
          : dashboardHealth.reachable
            ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">The request stream was interrupted, but the dashboard is still reachable. Retry or start a new session.</div>'
            : '<div style="font-size:10px;color:var(--muted);margin-top:4px">Dashboard connection lost. Reload the page to reconnect.</div>';
      }
      var errorRetry = _ccStoreRetryRequest(activeTab, activeTabId, message);
      addMsg('assistant', (streamedText ? renderMd(streamedText) + _ccElapsedFooter('Stream interrupted after {seconds}s') : '') +
        '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>' +
        _ccRetryControls(errorRetry, connectionHint, isNetworkError && (!dashboardHealth.reachable || dashboardHealth.restarted)), false, { retryId: errorRetry.id });
    }
  } finally {
    if (activeTab) { activeTab._sending = false; activeTab._abortController = null; activeTab._429retries = 0; delete activeTab._streamedText; delete activeTab._toolsUsed; delete activeTab._sendStartedAt; delete activeTab._userAborted; }
    _ccSending = (_ccTabs.some(function(t) { return t._sending; }));
    // Mark tab unread if response completed on a background tab or while drawer is closed
    if (activeTab && !_wasAborted && (activeTab.id !== _ccActiveTabId || !_ccOpen)) activeTab._unread = true;
    ccRenderTabBar();
    try { clearInterval(phaseTimer); } catch { /* may not be defined if error before reader */ }
    try { localStorage.removeItem('cc-sending'); } catch {}
    // Show red dot badge on CC button when response completes while drawer is closed.
    // Skip badge on user-initiated abort — they don't need notification for their own action.
    if (!_ccOpen && !_wasAborted) showNotifBadge(document.getElementById('cc-toggle-btn'));
  }
  return _wasAborted;
}

function ccRetryLast(tabId, retryId) {
  var tab = tabId ? _ccTabs.find(function(t) { return t.id === tabId; }) : _ccActiveTab();
  if (!tab) return;
  var retryRequest = _ccFindRetryRequest(tab, retryId);
  var text = retryRequest ? retryRequest.message : '';
  if (!text) {
    var last = tab.messages.filter(function(m) { return m.role === 'user'; }).pop();
    if (!last) return;
    // Backward-compatible fallback for retry buttons rendered before retry context existed.
    var tmp = document.createElement('div');
    tmp.innerHTML = last.html;
    text = tmp.textContent || tmp.innerText || '';
  }
  if (!text.trim()) return;
  var removed = _ccRemoveRetryMessage(tab, retryId);
  if (!removed && tab.id === _ccActiveTabId) {
    // Legacy fallback for old controls without retry ids: remove the visible error card.
    var el = document.getElementById('cc-messages');
    if (el?.lastElementChild) el.lastElementChild.remove();
    tab.messages = tab.messages.slice(0, -1);
  }
  _ccForgetRetryRequest(tab, retryId);
  ccSaveState();
  // Resend, then drain queue
  _ccDoSend(text.trim(), false, tab.id).then(async function() {
    var retryTab = _ccTabs.find(function(t) { return t.id === tab.id; });
    while (retryTab && retryTab._queue && retryTab._queue.length > 0) {
      var next = retryTab._queue.shift();
      _renderQueueIndicator();
      await _ccDoSend(next, false, retryTab.id);
    }
  });
}

async function _ccFetch(url, body) {
  var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { var d = await res.json().catch(function() { return {}; }); throw new Error(d.error || 'Request failed (' + res.status + ')'); }
  return res;
}

// Tag actions that the server already executed so ccExecuteAction skips the API call
function _tagServerExecuted(actions, actionResults) {
  if (!actionResults || !Array.isArray(actionResults)) return;
  for (var i = 0; i < actions.length && i < actionResults.length; i++) {
    var r = actionResults[i];
    if (r && r.ok) {
      actions[i]._serverExecuted = true;
      if (r.id) actions[i]._serverId = r.id;
    } else if (r && r.error) {
      actions[i]._serverExecuted = true;
      actions[i]._serverError = r.error;
    }
    // clientExecuted: false means server didn't handle it — frontend must execute
  }
}

async function ccExecuteAction(action, targetTabId) {
  var status = document.createElement('div');
  status.style.cssText = 'padding:4px 10px;border-radius:4px;font-size:10px;align-self:flex-start;border:1px dashed var(--border);color:var(--muted)';

  // Server-executed actions: just show status, don't re-fire the API
  if (action._serverExecuted) {
    if (action._serverError) {
      status.innerHTML = '&#10007; ' + escHtml(action.type) + ' failed: ' + escHtml(action._serverError);
      status.style.color = 'var(--red)';
    } else {
      var label = action._serverId ? escHtml(action._serverId) : escHtml(action.title || action.type);
      status.innerHTML = '&#10003; ' + escHtml(action.type) + ': <strong>' + label + '</strong>';
      status.style.color = 'var(--green)';
    }
    ccAddMessage('action', status.outerHTML, false, targetTabId);
    if (['dispatch','fix','implement','explore','review','test','create-meeting'].includes(action.type)) wakeEngine();
    refresh();
    return;
  }

  try {
    switch (action.type) {
      case 'dispatch':
      case 'fix':
      case 'implement':
      case 'explore':
      case 'review':
      case 'test': {
        var workType = action.workType || (action.type !== 'dispatch' ? action.type : 'implement');
        // Forward both singular (`agent`) and plural (`agents`) hint shapes —
        // the LLM emits either depending on phrasing ("assign to lambert" vs
        // "dispatch to dallas, ralph"). The server-side handler promotes a
        // single explicit agent to a hard pin so routing doesn't reassign it.
        var res = await _ccFetch('/api/work-items', {
            title: action.title, type: workType,
            priority: action.priority || 'medium', description: action.description || '',
            project: action.project || '',
            scope: action.scope || '',
            agent: action.agent || '',
            agents: action.agents || [],
        });
        var d = await res.json();
        status.innerHTML = '&#10003; Dispatched: <strong>' + escHtml(d.id || action.title) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'note': {
        await _ccFetch('/api/notes', { title: action.title, what: action.content || action.description, author: 'command-center' });
        status.innerHTML = '&#10003; Note saved: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        var notePageLink = document.querySelector('.sidebar-link[data-page="inbox"]');
        if (notePageLink && !notePageLink.querySelector('.notif-badge')) { var noteCurPage = document.querySelector('.sidebar-link.active')?.getAttribute('data-page'); if (noteCurPage !== 'inbox') showNotifBadge(notePageLink); }
        break;
      }
      case 'pin': {
        await _ccFetch('/api/pinned', { title: action.title, content: action.content || action.description, level: action.level || '' });
        status.innerHTML = '&#x1F4CC; Pinned: <strong>' + escHtml(action.title) + '</strong> — visible to all agents';
        status.style.color = 'var(--green)';
        break;
      }
      case 'plan': {
        await _ccFetch('/api/plan', { title: action.title, description: action.description, project: action.project, branchStrategy: action.branchStrategy || 'parallel' });
        status.innerHTML = '&#10003; Plan queued: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'cancel': {
        await _ccFetch('/api/agents/cancel', { agentId: action.agent, reason: action.reason || 'Cancelled via command center' });
        status.innerHTML = '&#10003; Cancelled agent: <strong>' + escHtml(action.agent) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'retry': {
        for (var ri = 0; ri < (action.ids || []).length; ri++) {
          await _ccFetch('/api/work-items/retry', { id: action.ids[ri], source: '' });
        }
        status.innerHTML = '&#10003; Retried: <strong>' + escHtml((action.ids || []).join(', ')) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'pause-plan': {
        await _ccFetch('/api/plans/pause', { file: action.file });
        status.innerHTML = '&#10003; Paused plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'approve-plan': {
        await _ccFetch('/api/plans/approve', { file: action.file });
        status.innerHTML = '&#10003; Approved plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'resume-plan': {
        // Update PRD items first (set modified→updated, new→missing), then approve
        if (action.updates && action.updates.length > 0) {
          for (var ui = 0; ui < action.updates.length; ui++) {
            var u = action.updates[ui];
            await _ccFetch('/api/prd-items/update', { source: action.file, itemId: u.id, status: u.status, name: u.name, description: u.description });
          }
        }
        if (action.newItems && action.newItems.length > 0) {
          for (var ni = 0; ni < action.newItems.length; ni++) {
            var n = action.newItems[ni];
            await _ccFetch('/api/prd-items', { source: action.file, id: n.id, name: n.name, description: n.description, priority: n.priority, estimated_complexity: n.complexity });
          }
        }
        await _ccFetch('/api/plans/approve', { file: action.file });
        var resumeCount = (action.updates || []).length + (action.newItems || []).length;
        status.innerHTML = '&#10003; Resumed plan: <strong>' + escHtml(action.file) + '</strong>' + (resumeCount > 0 ? ' (' + resumeCount + ' item(s) updated)' : '');
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'edit-prd-item': {
        await _ccFetch('/api/prd-items/update', { source: action.source, itemId: action.itemId, name: action.name, description: action.description, priority: action.priority, estimated_complexity: action.complexity });
        status.innerHTML = '&#10003; Updated PRD item: <strong>' + escHtml(action.itemId) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'remove-prd-item': {
        await _ccFetch('/api/prd-items/remove', { source: action.source, itemId: action.itemId });
        status.innerHTML = '&#10003; Removed PRD item: <strong>' + escHtml(action.itemId) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'delete-work-item': {
        await _ccFetch('/api/work-items/delete', { id: action.id, source: action.source || '' });
        status.innerHTML = '&#10003; Deleted work item: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'cancel-work-item': {
        await _ccFetch('/api/work-items/cancel', { id: action.id, source: action.source || '', reason: action.reason || 'cc' });
        status.innerHTML = '&#10003; Cancelled work item: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--orange)';
        wakeEngine();
        break;
      }
      case 'plan-edit': {
        // Read the plan, send instruction to doc-chat, show version actions
        var normalizedFile = normalizePlanFile(action.file);
        var planContent = await fetch('/api/plans/' + encodeURIComponent(normalizedFile)).then(function(r) { return r.text(); });
        var res2 = await fetch('/api/doc-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: action.instruction,
            document: planContent,
            title: normalizedFile,
            filePath: 'plans/' + normalizedFile,
          }),
        });
        var data = await res2.json();
        if (data.ok && data.edited) {
          status.innerHTML = '&#10003; Plan edited: <strong>' + escHtml(action.file) + '</strong>';
          status.style.color = 'var(--green)';
        } else {
          status.innerHTML = data.answer ? renderMd(data.answer) : '&#10007; Could not edit plan';
          status.style.color = data.answer ? 'var(--muted)' : 'var(--red)';
        }
        break;
      }
      case 'execute-plan': {
        await _ccFetch('/api/plans/execute', { file: action.file, project: action.project || '' });
        status.innerHTML = '&#10003; Plan execution queued: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'file-edit': {
        // doc-chat reads current content from disk via filePath — pass placeholder for required field
        var res3 = await fetch('/api/doc-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: action.instruction,
            document: '(loaded from disk)',
            title: action.file.split('/').pop(),
            filePath: action.file,
          }),
        });
        var data3 = await res3.json();
        if (data3.ok && data3.edited) {
          status.innerHTML = '&#10003; Edited: <strong>' + escHtml(action.file) + '</strong>';
          status.style.color = 'var(--green)';
        } else {
          status.innerHTML = data3.answer ? renderMd(data3.answer) : '&#10007; Could not edit file';
          status.style.color = data3.answer ? 'var(--muted)' : 'var(--red)';
        }
        break;
      }
      case 'schedule': {
        var url = action._update ? '/api/schedules/update' : '/api/schedules';
        var res4 = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: action.id, title: action.title, cron: action.cron,
            type: action.workType || 'implement',
            project: action.project, agent: action.agent,
            description: action.description, priority: action.priority,
            enabled: action.enabled !== false,
          })
        });
        if (!res4.ok) { var d4 = await res4.json().catch(function() { return {}; }); throw new Error(d4.error || 'Schedule create failed'); }
        status.innerHTML = '&#10003; Schedule ' + (action._update ? 'updated' : 'created') + ': <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'delete-schedule': {
        var res5 = await fetch('/api/schedules/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id })
        });
        if (!res5.ok) { var d5 = await res5.json().catch(function() { return {}; }); throw new Error(d5.error || 'Schedule delete failed'); }
        status.innerHTML = '&#10003; Deleted schedule: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'create-meeting': {
        var meetingParticipants = (Array.isArray(action.participants) && action.participants.length > 0) ? action.participants : (action.agents || []);
        var res6 = await fetch('/api/meetings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, agenda: action.agenda, participants: meetingParticipants, rounds: action.rounds, project: action.project })
        });
        if (!res6.ok) { var d6 = await res6.json().catch(function() { return {}; }); throw new Error(d6.error || 'Meeting create failed'); }
        var d6r = await res6.json();
        status.innerHTML = '&#10003; Meeting started: <strong>' + escHtml(action.title) + '</strong>' + (d6r.id ? ' (' + escHtml(d6r.id) + ')' : '');
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'set-config': {
        var payload = { engine: {} };
        payload.engine[action.setting] = action.value;
        var res7 = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res7.ok) { var d7 = await res7.json().catch(function() { return {}; }); throw new Error(d7.error || 'Config update failed'); }
        status.innerHTML = '&#10003; Set <strong>' + escHtml(action.setting) + '</strong> = ' + escHtml(String(action.value));
        status.style.color = 'var(--green)';
        break;
      }
      case 'edit-pipeline': {
        var body = { id: action.id };
        if (action.title) body.title = action.title;
        if (action.stages) body.stages = action.stages;
        if (action.trigger !== undefined) body.trigger = action.trigger;
        var res8 = await fetch('/api/pipelines/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res8.ok) { var d8 = await res8.json().catch(function() { return {}; }); throw new Error(d8.error || 'Pipeline update failed'); }
        status.innerHTML = '&#10003; Updated pipeline: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'unpin': {
        await _ccFetch('/api/pinned/remove', { title: action.title });
        status.innerHTML = '&#10003; Unpinned: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'archive-plan': {
        await _ccFetch('/api/plans/archive', { file: action.file });
        status.innerHTML = '&#10003; Archived plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'reject-plan': {
        await _ccFetch('/api/plans/reject', { file: action.file, reason: action.reason || '' });
        status.innerHTML = '&#10003; Rejected plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'steer-agent': {
        await _ccFetch('/api/agents/steer', { agent: action.agent, message: action.message || action.content });
        status.innerHTML = '&#10003; Steering message sent to <strong>' + escHtml(action.agent) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'add-meeting-note': {
        await _ccFetch('/api/meetings/note', { id: action.id, note: action.note || action.content });
        status.innerHTML = '&#10003; Note added to meeting <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'trigger-pipeline': {
        var res9 = await fetch('/api/pipelines/trigger', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id })
        });
        if (!res9.ok) { var d9 = await res9.json().catch(function() { return {}; }); throw new Error(d9.error || 'Pipeline trigger failed'); }
        status.innerHTML = '&#10003; Pipeline triggered: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'link-pr': {
        await _ccFetch('/api/pull-requests/link', { url: action.url, title: action.title || '', project: action.project || '', autoObserve: action.autoObserve !== false });
        status.innerHTML = '&#10003; PR linked: <strong>' + escHtml(action.url) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'archive-meeting': {
        await _ccFetch('/api/meetings/archive', { id: action.id });
        status.innerHTML = '&#10003; Meeting archived: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'update-routing': {
        await _ccFetch('/api/settings/routing', { content: action.content });
        status.innerHTML = '&#10003; Routing updated';
        status.style.color = 'var(--green)';
        break;
      }
      case 'file-bug': {
        var res10 = await _ccFetch('/api/issues/create', { title: action.title, description: action.description, labels: action.labels });
        var d10 = await res10.json();
        var labelWarning = d10.warning ? ' <span style="color:var(--orange)">(' + escHtml(d10.warning) + ')</span>' : '';
        if (d10.url) {
          status.innerHTML = '&#128027; Bug filed: <a href="' + escHtml(d10.url) + '" target="_blank" style="color:var(--blue)">' + escHtml(action.title) + '</a>' + labelWarning;
        } else {
          status.innerHTML = '&#128027; Bug filed: <strong>' + escHtml(action.title) + '</strong> — <a href="https://github.com/yemi33/minions/issues" target="_blank" style="color:var(--blue)">view issues</a>' + labelWarning;
        }
        status.style.color = 'var(--green)';
        break;
      }
      case 'create-pipeline': {
        await _ccFetch('/api/pipelines', { id: action.id, title: action.title, stages: action.stages || [], trigger: action.trigger || null, stopWhen: action.stopWhen || null, monitoredResources: action.monitoredResources || null });
        status.innerHTML = '&#10003; Pipeline created: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'delete-pipeline': {
        await _ccFetch('/api/pipelines/delete', { id: action.id });
        status.innerHTML = '&#10003; Pipeline deleted: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'abort-pipeline': {
        await _ccFetch('/api/pipelines/abort', { id: action.id });
        status.innerHTML = '&#10003; Pipeline aborted: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'retrigger-pipeline': {
        await _ccFetch('/api/pipelines/retrigger', { id: action.id });
        status.innerHTML = '&#10003; Pipeline retriggered: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'advance-meeting': {
        await _ccFetch('/api/meetings/advance', { id: action.id });
        status.innerHTML = '&#10003; Meeting advanced: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'end-meeting': {
        await _ccFetch('/api/meetings/end', { id: action.id });
        status.innerHTML = '&#10003; Meeting ended: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'delete-meeting': {
        await _ccFetch('/api/meetings/delete', { id: action.id });
        status.innerHTML = '&#10003; Meeting deleted: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'trigger-verify': {
        await _ccFetch('/api/plans/trigger-verify', { file: action.file });
        status.innerHTML = '&#10003; Verification triggered for: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'regenerate-plan': {
        await _ccFetch('/api/plans/approve', { file: action.file, forceRegen: true });
        status.innerHTML = '&#10003; PRD regeneration queued: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'unarchive-plan': {
        await _ccFetch('/api/plans/unarchive', { file: action.file });
        status.innerHTML = '&#10003; Plan unarchived: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'continue-pipeline': {
        await _ccFetch('/api/pipelines/continue', { id: action.id });
        status.innerHTML = '&#10003; Pipeline continued: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'work-item-feedback': {
        await _ccFetch('/api/work-items/feedback', { id: action.id, rating: action.rating || 'up', comment: action.comment || '' });
        status.innerHTML = '&#10003; Feedback submitted for: <strong>' + escHtml(action.id) + '</strong> (' + escHtml(action.rating || 'up') + ')';
        status.style.color = 'var(--green)';
        break;
      }
      case 'archive-work-item': {
        await _ccFetch('/api/work-items/archive', { id: action.id });
        status.innerHTML = '&#10003; Work item archived: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'reopen-work-item': {
        await _ccFetch('/api/work-items/reopen', { id: action.id, project: action.project || action.source || '', description: action.description });
        status.innerHTML = '&#10003; Work item reopened: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'reopen-prd-item': {
        await _ccFetch('/api/prd-items/update', { source: action.file, itemId: action.id, status: 'updated' });
        status.innerHTML = '&#10003; PRD item reopened: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'promote-to-kb': {
        await _ccFetch('/api/inbox/promote-kb', { name: action.file, category: action.category || 'project-notes' });
        status.innerHTML = '&#10003; Promoted to KB: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'revise-plan': {
        await _ccFetch('/api/plans/revise', { file: action.file, feedback: action.feedback || action.description, requestedBy: 'command-center' });
        status.innerHTML = '&#10003; Plan revision dispatched: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'kb-sweep': {
        await _ccFetch('/api/knowledge/sweep', {});
        status.innerHTML = '&#10003; KB sweep triggered';
        status.style.color = 'var(--green)';
        break;
      }
      case 'toggle-kb-pin': {
        await _ccFetch('/api/kb-pins/toggle', { key: action.key });
        status.innerHTML = '&#10003; KB pin toggled: <strong>' + escHtml(action.key) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'add-project': {
        await _ccFetch('/api/projects/add', { localPath: action.localPath, name: action.name || '', repoHost: action.repoHost || 'github' });
        status.innerHTML = '&#10003; Project added: <strong>' + escHtml(action.name || action.localPath) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'restart-engine': {
        await _ccFetch('/api/engine/restart', {});
        status.innerHTML = '&#10003; Engine restart requested';
        status.style.color = 'var(--green)';
        break;
      }
      case 'delete-pr': {
        await _ccFetch('/api/pull-requests/delete', { id: action.id, project: action.project || '' });
        status.innerHTML = '&#10003; PR unlinked: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'unarchive-meeting': {
        await _ccFetch('/api/meetings/unarchive', { id: action.id });
        status.innerHTML = '&#10003; Meeting unarchived: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'reset-settings': {
        await _ccFetch('/api/settings/reset', {});
        status.innerHTML = '&#10003; Settings reset to defaults';
        status.style.color = 'var(--green)';
        break;
      }
      default: {
        // Generic fallback: if action has an `endpoint` field, call it directly (local API only)
        if (action.endpoint && action.endpoint.startsWith('/api/') && !action.endpoint.includes('..') && !/\%2e/i.test(action.endpoint)) {
          var genRes = await _ccFetch(action.endpoint, action.params || {});
          var genData = await genRes.json().catch(function() { return {}; });
          status.innerHTML = '&#10003; ' + escHtml(action.type) + ': ' + escHtml(genData.message || genData.id || 'done');
          status.style.color = 'var(--green)';
        } else if (action.endpoint) {
          status.innerHTML = '&#10007; Blocked: endpoint must be a local /api/ path';
          status.style.color = 'var(--red)';
        } else {
          status.innerHTML = '? Unknown action: <strong>' + escHtml(action.type) + '</strong>';
          status.style.color = 'var(--muted)';
        }
      }
    }
  } catch (e) {
    status.innerHTML = '&#10007; Action failed: ' + escHtml(e.message);
    status.style.color = 'var(--red)';
  }

  ccAddMessage('action', status.outerHTML, false, targetTabId);
  refresh();
}

// --- CC Resize Logic ---
var CC_MIN_WIDTH = 320;
var CC_MAX_WIDTH_RATIO = 0.8; // 80% of viewport
var CC_DEFAULT_WIDTH = 420;
var CC_WIDTH_KEY = 'cc-drawer-width';

function ccApplySavedWidth() {
  var drawer = document.getElementById('cc-drawer');
  if (!drawer) return;
  var saved = parseInt(localStorage.getItem(CC_WIDTH_KEY), 10);
  if (saved && saved >= CC_MIN_WIDTH) {
    var maxW = Math.floor(window.innerWidth * CC_MAX_WIDTH_RATIO);
    drawer.style.width = Math.min(saved, maxW) + 'px';
  }
}

function ccInitResize() {
  var handle = document.getElementById('cc-resize-handle');
  var drawer = document.getElementById('cc-drawer');
  if (!handle || !drawer) return;

  var startX = 0;
  var startW = 0;

  function onMouseMove(e) {
    var maxW = Math.floor(window.innerWidth * CC_MAX_WIDTH_RATIO);
    var delta = startX - e.clientX; // dragging left = wider
    var newW = Math.max(CC_MIN_WIDTH, Math.min(startW + delta, maxW));
    drawer.style.width = newW + 'px';
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.classList.remove('cc-resizing');
    handle.classList.remove('active');
    // Persist
    try { localStorage.setItem(CC_WIDTH_KEY, parseInt(drawer.style.width, 10)); } catch {}
  }

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = drawer.offsetWidth;
    document.body.classList.add('cc-resizing');
    handle.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Init resize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ccInitResize);
} else {
  ccInitResize();
}

window.MinionsCC = { toggleCommandCenter, ccNewSession, ccNewTab, ccSwitchTab, ccCloseTab, ccRenderTabBar, ccRestoreMessages, ccSaveState, ccUpdateSessionIndicator, ccAddMessage, ccSend, ccAbort, ccExecuteAction };
