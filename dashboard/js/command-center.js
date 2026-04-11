// command-center.js — Command center panel functions extracted from dashboard.html

// ── Multi-tab state ──────────────────────────────────────────────────────────
var CC_MAX_TABS = 20;
var CC_MAX_MESSAGES_PER_TAB = 30;
var CC_TITLE_MAX_LENGTH = 40;

var _ccTabs = [];         // [{id, title, sessionId, messages: [{role, html}]}]
var _ccActiveTabId = null;
var _ccOpen = false;
// Per-tab sending state stored on tab objects: tab._sending, tab._queue, tab._abortController
// Legacy globals for backward compat (badge, drawer close check)
var _ccSending = false; // true if active tab is sending (UI indicator only)
// Clear stale sending state on page load — SSE streams don't survive refresh
try { localStorage.removeItem('cc-sending'); } catch {}

// ── Migration from legacy single-session format ─────────────────────────────
(function _ccMigrateLegacy() {
  try {
    var legacyTabs = localStorage.getItem('cc-tabs');
    if (legacyTabs) {
      // Already migrated — load tabs
      _ccTabs = JSON.parse(legacyTabs) || [];
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
        tools.forEach(function(t) { html += '<div style="color:var(--blue);font-size:11px">\uD83D\uDD27 ' + escHtml(t) + '</div>'; });
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

function ccShowAllConversations() {
  var dropdown = document.getElementById('cc-all-conversations');
  if (dropdown) { dropdown.remove(); return; } // toggle off
  dropdown = document.createElement('div');
  dropdown.id = 'cc-all-conversations';
  dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-top:none;max-height:300px;overflow-y:auto;z-index:360;box-shadow:0 4px 12px rgba(0,0,0,0.3)';
  var html = '';
  for (var i = _ccTabs.length - 1; i >= 0; i--) {
    var t = _ccTabs[i];
    var isActive = t.id === _ccActiveTabId;
    var preview = '';
    if (t.messages.length > 0) {
      var lastMsg = t.messages[t.messages.length - 1];
      var tmp = document.createElement('div');
      tmp.innerHTML = lastMsg.html;
      preview = (tmp.textContent || tmp.innerText || '').slice(0, 60);
    }
    html += '<div style="padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:8px' + (isActive ? ';background:rgba(56,139,253,0.1)' : '') + '" onclick="ccSwitchTab(\'' + t.id + '\');document.getElementById(\'cc-all-conversations\')?.remove()">';
    html += '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:600;color:' + (isActive ? 'var(--blue)' : 'var(--text)') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.title) + '</div>';
    if (preview) html += '<div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">' + escHtml(preview) + '</div>';
    html += '</div>';
    html += '<span style="font-size:10px;color:var(--muted)">' + t.messages.length + ' msg</span>';
    html += '<button onclick="event.stopPropagation();ccCloseTab(\'' + t.id + '\');document.getElementById(\'cc-all-conversations\')?.remove();ccShowAllConversations()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:2px 4px">&times;</button>';
    html += '</div>';
  }
  if (_ccTabs.length === 0) html = '<div style="padding:12px;color:var(--muted);font-size:11px;text-align:center">No conversations yet</div>';
  dropdown.innerHTML = html;
  var tabBar = document.getElementById('cc-tab-bar');
  if (tabBar) { tabBar.style.position = 'relative'; tabBar.appendChild(dropdown); }
  // Close on click outside
  function closeDropdown(e) { if (!dropdown.contains(e.target) && e.target.id !== 'cc-all-btn') { dropdown.remove(); document.removeEventListener('click', closeDropdown); } }
  setTimeout(function() { document.addEventListener('click', closeDropdown); }, 0);
}

function ccRenderTabBar() {
  var bar = document.getElementById('cc-tab-bar');
  if (!bar) return;
  var html = '';
  for (var i = 0; i < _ccTabs.length; i++) {
    var t = _ccTabs[i];
    var isActive = t.id === _ccActiveTabId;
    html += '<div class="cc-tab' + (isActive ? ' active' : '') + (t._sending ? ' working' : '') + '" onclick="ccSwitchTab(\'' + t.id + '\')" title="' + escHtml(t.title) + '">';
    html += '<span class="cc-tab-text">' + escHtml(t.title) + '</span>';
    html += '<span class="cc-tab-close" onclick="event.stopPropagation();ccCloseTab(\'' + t.id + '\')">&times;</span>';
    html += '</div>';
  }
  html += '<div class="cc-tab" onclick="ccNewTab()" title="New tab" style="color:var(--muted);padding:4px 8px">+</div>';
  html += '<button id="cc-all-btn" onclick="ccShowAllConversations()" style="background:none;border:none;color:var(--muted);font-size:11px;padding:4px 6px;cursor:pointer;white-space:nowrap;flex-shrink:0;margin-left:auto" title="All conversations">&#x25BC;</button>';
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
      // Save tabs with trimmed messages
      var toSave = _ccTabs.map(function(t) {
        return { id: t.id, title: t.title, sessionId: t.sessionId, messages: t.messages.slice(-CC_MAX_MESSAGES_PER_TAB) };
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

function ccAddMessage(role, html, skipSave, targetTabId) {
  var isUser = role === 'user';
  var isSystem = role === 'system';
  var isAssistant = !isUser && !isSystem;
  var targetTab = targetTabId ? _ccTabs.find(function(t) { return t.id === targetTabId; }) : _ccActiveTab();
  // Only render to DOM if this message is for the currently visible tab
  var isVisible = !targetTabId || targetTabId === _ccActiveTabId;
  if (isVisible) {
    var el = document.getElementById('cc-messages');
    var div = document.createElement('div');
    div.className = isAssistant ? 'cc-msg-assistant' : '';
    div.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;max-width:95%;' +
      (isUser ? 'background:var(--blue);color:#fff;align-self:flex-end' : isSystem ? 'align-self:center;max-width:100%' : 'background:var(--surface2);color:var(--text);align-self:flex-start;border:1px solid var(--border);position:relative');
    div.innerHTML = (isAssistant && !html.includes('color:var(--red)') && !html.includes('cc-queued-pill') ? llmCopyBtn() : '') + html;
    var wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    el.appendChild(div);
    if (wasNearBottom || isUser) requestAnimationFrame(function() { el.scrollTop = el.scrollHeight; });
  }
  if (!skipSave) {
    var tab = targetTab;
    if (tab) {
      tab.messages.push({ role: role, html: html });
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
  if (!tab) return;
  if (!tab._queue) tab._queue = [];

  // If this tab is already processing, queue the message
  if (tab._sending) {
    tab._queue.push(message);
    _renderQueueIndicator();
    return;
  }
  var wasAborted = await _ccDoSend(message);

  // Flush queued messages one at a time, pausing after abort to let server release ccInFlight
  while (tab._queue && tab._queue.length > 0) {
    if (wasAborted) {
      await new Promise(function(r) { setTimeout(r, 1500); });
    }
    var next = tab._queue.shift();
    _renderQueueIndicator();
    wasAborted = await _ccDoSend(next);
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

async function _ccDoSend(message, skipUserMsg) {
  // Client-side /pin and /unpin — no LLM round-trip needed
  var pinMatch = message.match(/^\/(pin|unpin)\s+(.+)/i);
  if (pinMatch) {
    if (!skipUserMsg) ccAddMessage('user', escHtml(message));
    var pinAction = pinMatch[1].toLowerCase();
    var pinQuery = pinMatch[2].toLowerCase().trim();
    var found = _ccFindPinTarget(pinQuery);
    if (found) {
      var wasPinned = isPinned(found.key);
      if (pinAction === 'pin' && !wasPinned) { togglePin(found.key); ccAddMessage('assistant', 'Pinned <strong>' + escHtml(found.label) + '</strong> to top'); }
      else if (pinAction === 'unpin' && wasPinned) { togglePin(found.key); ccAddMessage('assistant', 'Unpinned <strong>' + escHtml(found.label) + '</strong>'); }
      else { ccAddMessage('assistant', '<strong>' + escHtml(found.label) + '</strong> is already ' + (wasPinned ? 'pinned' : 'unpinned')); }
      showToast('cmd-toast', pinAction === 'pin' ? 'Pinned to top' : 'Unpinned', true);
      renderInbox(inboxData); renderKnowledgeBase();
    } else {
      ccAddMessage('assistant', 'No inbox or KB item matching "' + escHtml(pinQuery) + '"');
    }
    return;
  }

  var activeTab = _ccActiveTab();
  var activeTabId = _ccActiveTabId;
  if (!activeTab) return;
  activeTab._sending = true;
  activeTab._sendStartedAt = Date.now();
  activeTab._abortController = new AbortController();
  _ccSending = true;
  ccRenderTabBar();
  var _wasAborted = false;
  try { localStorage.setItem('cc-sending', JSON.stringify({ sending: true, startedAt: Date.now() })); } catch {}

  // Scoped helper — always targets the originating tab, even if user switches tabs
  function addMsg(role, html, skipSave) { ccAddMessage(role, html, skipSave, activeTabId); }

  if (!skipUserMsg) addMsg('user', escHtml(message));

  // Remove queue indicator before processing (it'll be re-added if more queued)
  var existingQueueEl = document.getElementById('cc-queue-indicator');
  if (existingQueueEl) existingQueueEl.remove();

  var ccStartTime = Date.now();
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
          html += '<div style="color:var(--blue);font-size:11px">\uD83D\uDD27 ' + escHtml(t) + '</div>';
        });
        html += '</div>';
      }
      if (streamedText) {
        html += renderMd(streamedText);
      }
      html += '<div style="margin-top:' + (streamedText ? '6px' : '0') + '">' + _getThinkingHtml() + '</div>';
      streamDiv.innerHTML = html;
      // Re-append queue indicators so they stay below the streaming content
      if (activeTab._queue && activeTab._queue.length > 0) _renderQueueIndicator();
      if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
    }
    // Start phase timer immediately so thinking text updates while waiting for SSE
    var phaseTimer = setInterval(updateStreamDiv, 1000);
    updateStreamDiv(); // render proper layout immediately (not raw "Thinking..." text)

  try {
    // Stream response via SSE — shows text as it arrives
    var res = await fetch('/api/command-center/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, tabId: activeTabId, sessionId: activeTab.sessionId || null }),
      signal: activeTab._abortController ? activeTab._abortController.signal : AbortSignal.timeout(960000)
    });

    if (!res.ok) {
      // 429 = server still processing previous request (abort race) — retry silently up to 3 times
      if (res.status === 429 && (!activeTab._429retries || activeTab._429retries < 3)) {
        activeTab._429retries = (activeTab._429retries || 0) + 1;
        _cleanupStreamDiv();
        await new Promise(function(r) { setTimeout(r, 1500); });
        return await _ccDoSend(message, true);
      }
      activeTab._429retries = 0;
      _cleanupStreamDiv();
      var errText = await res.text();
      addMsg('assistant', '<span style="color:var(--red)">' + escHtml(errText || 'CC error') + '</span>' +
        (errText.includes('busy') ? ' <button onclick="ccNewTab()" style="margin-top:4px;padding:3px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--blue);cursor:pointer;font-size:10px">Reset CC</button>' : ''));
      return;
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;
      buf += decoder.decode(readResult.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line.startsWith('data: ')) continue;
        try {
          var evt = JSON.parse(line.slice(6));
          if (evt.type === 'chunk') {
            streamedText = evt.text;
            if (activeTab) activeTab._streamedText = streamedText;
            updateStreamDiv();
          } else if (evt.type === 'tool') {
            toolsUsed.push(evt.name);
            if (activeTab) activeTab._toolsUsed = toolsUsed.slice();
            updateStreamDiv();
            if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
          } else if (evt.type === 'done') {
            _cleanupStreamDiv();
            // If system prompt changed, show a notice before the response
            if (evt.sessionReset) {
              addMsg('system', '<div style="text-align:center;padding:6px 12px;font-size:11px;color:var(--muted);background:var(--surface2);border-radius:6px;margin:4px 0">Minions was updated — started a fresh session with latest context.</div>', false, activeTabId);
            }
            // placeholder was added with skipSave=true — nothing to pop
            var ccElapsed = Math.round((Date.now() - ccStartTime) / 1000);
            var rendered = renderMd(evt.text || streamedText || '');
            addMsg('assistant', rendered + '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">' + ccElapsed + 's</div>');
            if (evt.sessionId !== undefined) {
              // Save session to the originating tab, not whichever tab is active now
              var originTab = _ccTabs.find(function(t) { return t.id === activeTabId; });
              if (originTab) { originTab.sessionId = evt.sessionId || null; }
              ccSaveState(); ccUpdateSessionIndicator();
            }
            if (evt.actions && evt.actions.length > 0) {
              _tagServerExecuted(evt.actions, evt.actionResults);
              for (var ai = 0; ai < evt.actions.length; ai++) { await ccExecuteAction(evt.actions[ai], activeTabId); }
            }
          } else if (evt.type === 'error') {
            _cleanupStreamDiv();
            // placeholder was skipSave — no pop needed
            addMsg('assistant', '<span style="color:var(--red)">' + escHtml(evt.error) + '</span>');
          }
        } catch { /* incomplete JSON */ }
      }
    }
    // Process any remaining buffered data after stream ends
    if (buf.trim()) {
      var remainingLines = buf.split('\n');
      for (var ri = 0; ri < remainingLines.length; ri++) {
        var rline = remainingLines[ri];
        if (!rline.startsWith('data: ')) continue;
        try {
          var revt = JSON.parse(rline.slice(6));
          if (revt.type === 'done') {
            _cleanupStreamDiv();
            // placeholder was skipSave — no pop needed
            var ccElapsed2 = Math.round((Date.now() - ccStartTime) / 1000);
            var rendered2 = renderMd(revt.text || streamedText || '');
            addMsg('assistant', rendered2 + '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">' + ccElapsed2 + 's</div>');
            if (revt.sessionId !== undefined) {
              var originTab2 = _ccTabs.find(function(t) { return t.id === activeTabId; });
              if (originTab2) { originTab2.sessionId = revt.sessionId || null; }
              ccSaveState(); ccUpdateSessionIndicator();
            }
            if (revt.actions && revt.actions.length > 0) {
              _tagServerExecuted(revt.actions, revt.actionResults);
              for (var ai2 = 0; ai2 < revt.actions.length; ai2++) { await ccExecuteAction(revt.actions[ai2], activeTabId); }
            }
          } else if (revt.type === 'chunk') {
            streamedText = revt.text;
            updateStreamDiv();
          }
        } catch {}
      }
    }
    // If stream ended without a 'done' event, finalize with whatever we have
    if (streamDiv.parentNode || document.getElementById('cc-restore-thinking') || document.querySelector('[data-stream-tab="' + activeTabId + '"]')) {
      _cleanupStreamDiv();
      if (streamedText) {
        var ccElapsed3 = Math.round((Date.now() - ccStartTime) / 1000);
        addMsg('assistant', renderMd(streamedText) + '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">' + ccElapsed3 + 's</div>');
      }
    }
  } catch (e) {
    _cleanupStreamDiv();
    if (e.name === 'AbortError') {
      _wasAborted = true;
      if (streamedText) {
        var ccElapsed4 = Math.round((Date.now() - ccStartTime) / 1000);
        addMsg('assistant', renderMd(streamedText) + '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">Stopped after ' + ccElapsed4 + 's</div>');
      } else {
        addMsg('assistant', '<span style="color:var(--red);font-size:11px">Stopped</span>');
      }
    } else {
      var retryId = 'cc-retry-' + Date.now();
      var isNetworkError = e.message === 'Failed to fetch' || e.message.includes('NetworkError');
      addMsg('assistant', '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>' +
        (isNetworkError ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">Dashboard connection lost. Reload the page to reconnect.</div>' : '') +
        '<button id="' + retryId + '" onclick="ccRetryLast()" style="margin-top:6px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--blue);cursor:pointer;font-size:11px">Retry</button>' +
        (isNetworkError ? ' <button onclick="location.reload()" style="margin-top:6px;padding:4px 12px;background:var(--orange);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">Reload Page</button>' : '') +
        ' <button onclick="ccNewTab()" style="margin-top:6px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:11px">New Session</button>');
    }
  } finally {
    if (activeTab) { activeTab._sending = false; activeTab._abortController = null; activeTab._429retries = 0; delete activeTab._streamedText; delete activeTab._toolsUsed; delete activeTab._sendStartedAt; }
    _ccSending = (_ccTabs.some(function(t) { return t._sending; }));
    ccRenderTabBar();
    try { clearInterval(phaseTimer); } catch { /* may not be defined if error before reader */ }
    try { localStorage.removeItem('cc-sending'); } catch {}
    if (!_ccOpen) showNotifBadge(document.getElementById('cc-toggle-btn'));
  }
  return _wasAborted;
}

function ccRetryLast() {
  // Find the last user message and resend it
  var tab = _ccActiveTab();
  if (!tab) return;
  var last = tab.messages.filter(function(m) { return m.role === 'user'; }).pop();
  if (!last) return;
  // Extract text from the HTML (strip tags)
  var tmp = document.createElement('div');
  tmp.innerHTML = last.html;
  var text = tmp.textContent || tmp.innerText || '';
  if (!text.trim()) return;
  // Remove the error message (last assistant message)
  var el = document.getElementById('cc-messages');
  if (el?.lastElementChild) el.lastElementChild.remove();
  tab.messages = tab.messages.slice(0, -1); // remove error from history
  // Resend, then drain queue
  _ccDoSend(text.trim()).then(async function() {
    var retryTab = _ccActiveTab();
    while (retryTab && retryTab._queue && retryTab._queue.length > 0) {
      var next = retryTab._queue.shift();
      _renderQueueIndicator();
      await _ccDoSend(next);
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
    ccAddMessage('assistant', status.outerHTML, false, targetTabId);
    if (['dispatch','fix','implement','explore','review','test'].includes(action.type)) wakeEngine();
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
        var res = await _ccFetch('/api/work-items', {
            title: action.title, type: workType,
            priority: action.priority || 'medium', description: action.description || '',
            project: action.project || '', agents: action.agents || [],
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
        var res6 = await fetch('/api/meetings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, agenda: action.agenda, participants: action.agents, rounds: action.rounds, project: action.project })
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
        if (d10.url) {
          status.innerHTML = '&#128027; Bug filed: <a href="' + escHtml(d10.url) + '" target="_blank" style="color:var(--blue)">' + escHtml(action.title) + '</a>';
        } else {
          status.innerHTML = '&#128027; Bug filed: <strong>' + escHtml(action.title) + '</strong> — <a href="https://github.com/yemi33/minions/issues" target="_blank" style="color:var(--blue)">view issues</a>';
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

  ccAddMessage('assistant', status.outerHTML, false, targetTabId);
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

window.MinionsCC = { toggleCommandCenter, ccNewSession, ccNewTab, ccSwitchTab, ccCloseTab, ccShowAllConversations, ccRenderTabBar, ccRestoreMessages, ccSaveState, ccUpdateSessionIndicator, ccAddMessage, ccSend, ccAbort, ccExecuteAction };
