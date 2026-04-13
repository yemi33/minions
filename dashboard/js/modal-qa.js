// modal-qa.js — Modal Q&A (document chat) functions extracted from dashboard.html

let _modalDocContext = { title: '', content: '', selection: '' };
let _modalFilePath = null; // file path for steering (null = read-only Q&A only)

function showModalQa() {
  document.getElementById('modal-qa').style.display = '';
  updateModalPinBtn();
  _initQaSession();
}

function _qaNotifySidebar(filePath) {
  if (!filePath) return;
  let page = '';
  if (/^plans\//.test(filePath) || /^prd\//.test(filePath)) page = 'plans';
  else if (/^knowledge\//.test(filePath) || /^notes/.test(filePath) || /^pinned/.test(filePath)) page = 'inbox';
  else if (/^meetings\//.test(filePath)) page = 'inbox';
  else return;
  // Don't badge if user is already on that page
  const currentPage = document.querySelector('.sidebar-link.active')?.getAttribute('data-page');
  if (currentPage === page) return;
  const link = document.querySelector('.sidebar-link[data-page="' + page + '"]');
  if (link && !link.querySelector('.notif-badge')) showNotifBadge(link);
}
let _qaHistory = []; // multi-turn conversation history [{role:'user',text:''},{role:'assistant',text:''}]
let _qaProcessing = false; // true while waiting for response
let _qaAbortController = null;
let _qaQueue = []; // queued messages while processing
const QA_QUEUE_CAP = 10; // max queued messages
let _qaSessionKey = ''; // key for current conversation (title or filePath)

function _renderQaUserMessage(thread, message, selection) {
  let qHtml = '<div class="modal-qa-q">' + escHtml(message);
  if (selection) {
    qHtml += '<span class="selection-ref">Re: "' + escHtml(selection.slice(0, 100)) + ((selection.length > 100) ? '...' : '') + '"</span>';
  }
  qHtml += '</div>';
  thread.insertAdjacentHTML('beforeend', qHtml);
  thread.scrollTop = thread.scrollHeight;
  _showThreadWrap();
}
const _qaSessions = new Map(); // persist conversations across modal open/close {key → {history, threadHtml}}
// Restore from localStorage
try {
  const saved = JSON.parse(localStorage.getItem('qa-sessions') || '{}');
  for (const [k, v] of Object.entries(saved)) _qaSessions.set(k, v);
} catch { /* optional */ }
function _saveQaSessions() {
  try {
    const obj = {};
    // Only persist last 10 sessions, cap threadHtml at 50KB each
    const entries = [..._qaSessions.entries()].slice(-10);
    for (const [k, v] of entries) obj[k] = { ...v, threadHtml: (v.threadHtml || '').slice(0, 50000) };
    localStorage.setItem('qa-sessions', JSON.stringify(obj));
  } catch { /* localStorage might be full */ }
}

function modalAskAboutSelection() {
  document.getElementById('ask-selection-btn').style.display = 'none';

  // If the modal isn't open but we have a selection (from detail panel), open modal for Q&A
  const modal = document.getElementById('modal');
  if (!modal.classList.contains('open')) {
    document.getElementById('modal-title').textContent = 'Q&A: ' + (_modalDocContext.title || 'Document');
    document.getElementById('modal-body').textContent = _modalDocContext.content.slice(0, 3000) + (_modalDocContext.content.length > 3000 ? '\n\n...(truncated for display)' : '');
    modal.classList.add('open');
  }

  // Show the selection pill
  const pill = document.getElementById('modal-qa-pill');
  const pillText = document.getElementById('modal-qa-pill-text');
  const sel = _modalDocContext.selection || '';
  if (sel) {
    pillText.textContent = sel.slice(0, 80) + (sel.length > 80 ? '...' : '');
    pill.style.display = 'flex';
  }

  const input = document.getElementById('modal-qa-input');
  input.value = '';
  input.placeholder = 'What do you want to know about this?';
  input.focus();
}

function clearQaSelection() {
  _modalDocContext.selection = '';
  document.getElementById('modal-qa-pill').style.display = 'none';
  document.getElementById('modal-qa-input').placeholder = 'Ask about this document (or select text first)...';
}


function _initQaSession() {
  var key = _modalFilePath || _modalDocContext.title || '';
  if (!key || _qaSessionKey === key) return;
  _qaSessionKey = key;
  // Clear notification badge on the source card when reopening
  const card = findCardForFile(_modalFilePath);
  if (card) clearNotifBadge(card);
  var prior = _qaSessions.get(key);
  if (prior) {
    _qaHistory = prior.history;
    document.getElementById('modal-qa-thread').innerHTML = prior.threadHtml;
    if (prior.docContext) {
      // Preserve freshly-fetched content and title — prior session may have stale/empty content
      const freshContent = _modalDocContext.content;
      const freshTitle = _modalDocContext.title;
      _modalDocContext = Object.assign({}, prior.docContext, {
        selection: _modalDocContext.selection,
        content: freshContent || prior.docContext.content || '',
        title: freshTitle || prior.docContext.title || '',
      });
    }
    if (prior.filePath) _modalFilePath = prior.filePath;
    _showThreadWrap();
    // Defer scroll — container just transitioned from display:none, layout not yet computed
    requestAnimationFrame(function() {
      var thread = document.getElementById('modal-qa-thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
  } else {
    _qaHistory = [];
    document.getElementById('modal-qa-thread').innerHTML = '';
    var wrap = document.getElementById('modal-qa-thread-wrap');
    var expandBar = document.getElementById('qa-expand-bar');
    if (wrap) wrap.style.display = 'none';
    if (expandBar) expandBar.style.display = 'none';
  }
}

function clearQaConversation() {
  _qaHistory = [];
  _qaQueue = [];
  _qaProcessing = false;
  document.getElementById('modal-qa-thread').innerHTML = '';
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  if (wrap) wrap.style.display = 'none';
  if (expandBar) expandBar.style.display = 'none';
  if (_qaSessionKey) _qaSessions.delete(_qaSessionKey);
}

function modalSend() {
  var input = document.getElementById('modal-qa-input');
  var message = input.value.trim();
  if (!message) return;

  if (!_modalDocContext.content) {
    var body = document.getElementById('modal-body');
    if (body) {
      _modalDocContext.content = body.textContent || body.innerText || '';
      _modalDocContext.title = document.getElementById('modal-title')?.textContent || '';
    }
  }
  if (!_modalDocContext.content) {
    showToast('cmd-toast', 'No document content', false);
    return;
  }

  _initQaSession();
  document.getElementById('qa-clear-btn').style.display = 'block';

  var thread = document.getElementById('modal-qa-thread');
  const selection = _modalDocContext.selection || '';

  // Clear input immediately so user can type next message
  input.value = '';
  _modalDocContext.selection = '';
  document.getElementById('modal-qa-pill').style.display = 'none';

  if (_qaProcessing) {
    if (_qaQueue.length >= QA_QUEUE_CAP) {
      showToast('cmd-toast', 'Queue full — wait for current response', false);
      return;
    }
    // Queue the message — show only grey queued indicator (blue bubble shows when processing starts)
    _qaQueue.push({ message, selection });
    const preview = escHtml(message.length > 60 ? message.slice(0, 57) + '...' : message);
    thread.insertAdjacentHTML('beforeend', '<div class="qa-queued-item" style="color:var(--muted);font-size:10px;padding:4px 8px">Queued: "' + preview + '"</div>');
    thread.scrollTop = thread.scrollHeight;
    _showThreadWrap();
    return;
  }

  // Show message in thread when processing starts (not when queued)
  _renderQaUserMessage(thread, message, selection);

  _processQaMessage(message, selection);
}

async function _processQaMessage(message, selection) {
  const thread = document.getElementById('modal-qa-thread');
  const btn = document.getElementById('modal-send-btn');
  _qaProcessing = true;

  // Capture state now — closeModal may null these while we're awaiting
  const capturedFilePath = _modalFilePath;
  const capturedDocContext = { ..._modalDocContext };

  // Show processing badge on the source card
  const sourceCard = findCardForFile(capturedFilePath);
  if (sourceCard) showNotifBadge(sourceCard, 'processing');

  const loadingId = 'chat-loading-' + Date.now();
  const qaQueueBadge = _qaQueue.length > 0 ? ' <span style="font-size:9px;color:var(--muted);background:var(--surface);padding:1px 5px;border-radius:8px;border:1px solid var(--border)">+' + _qaQueue.length + ' queued</span>' : '';
  _qaAbortController = new AbortController();
  thread.insertAdjacentHTML('beforeend', '<div class="modal-qa-loading" id="' + loadingId + '">' +
    '<div class="dot-pulse"><span></span><span></span><span></span></div> ' +
    '<span id="' + loadingId + '-text">Thinking...</span> ' +
    '<span id="' + loadingId + '-time" style="font-size:10px;color:var(--muted)"></span>' +
    ' <button onclick="qaAbort()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer">Stop</button>' +
    qaQueueBadge + '</div>');
  thread.scrollTop = thread.scrollHeight;

  const isPlanEdit = _modalFilePath && _modalFilePath.match(/^plans\/.*\.md$/);
  const qaStartTime = Date.now();
  const qaPhases = isPlanEdit
    ? [[0,'Reading plan...'],[3000,'Analyzing structure...'],[8000,'Researching context...'],[15000,'Drafting revisions...'],[30000,'Writing updated plan...'],[60000,'Still working (large document)...'],[120000,'Deep edit in progress...'],[300000,'Almost there...']]
    : [[0,'Thinking...'],[3000,'Reading document...'],[8000,'Analyzing...'],[20000,'Still working...'],[60000,'Taking a while...']];
  const qaTimer = setInterval(() => {
    const elapsed = Date.now() - qaStartTime;
    const timeEl = document.getElementById(loadingId + '-time');
    const textEl = document.getElementById(loadingId + '-text');
    if (timeEl) timeEl.textContent = Math.floor(elapsed / 1000) + 's';
    if (textEl) { for (let i = qaPhases.length - 1; i >= 0; i--) { if (elapsed >= qaPhases[i][0]) { textEl.textContent = qaPhases[i][1]; break; } } }
  }, 500);

  try {
    const res = await fetch('/api/doc-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: _qaAbortController ? _qaAbortController.signal : undefined,
      body: JSON.stringify({
        message,
        document: capturedDocContext.content,
        title: capturedDocContext.title,
        selection: selection,
        filePath: capturedFilePath || null,
        model: window._lastStatus?.autoMode?.ccModel || undefined,
      }),
    });
    const data = await res.json();
    clearInterval(qaTimer);
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (data.ok) {
      const borderColor = data.edited ? 'var(--green)' : 'var(--blue)';
      const suffix = data.edited ? '\n\n\u2713 Document saved.' : '';
      const qaElapsed = Math.round((Date.now() - qaStartTime) / 1000);
      const qaTimeLabel = '<div style="font-size:9px;color:var(--muted);margin-top:4px;text-align:right;padding-right:24px">' + qaElapsed + 's</div>';
      thread.insertAdjacentHTML('beforeend', '<div class="modal-qa-a" style="border-left-color:' + borderColor + '">' + llmCopyBtn() + renderMd(data.answer + suffix) + qaTimeLabel + '</div>');

      // Track conversation history
      _qaHistory.push({ role: 'user', text: message });
      _qaHistory.push({ role: 'assistant', text: data.answer });

      // Notify sidebar page link
      _qaNotifySidebar(capturedFilePath);

      // Execute any CC actions (dispatch, note, etc.)
      if (data.actions && data.actions.length > 0) {
        for (const action of data.actions) { await ccExecuteAction(action); }
      }

      // Refresh modal body if document was edited
      if (data.edited && data.content) {
        const display = data.content.replace(/^---[\s\S]*?---\n*/m, '');
        const isJson = capturedFilePath && capturedFilePath.endsWith('.json');
        const body = document.getElementById('modal-body');
        if (isJson) {
          body.textContent = display;
        } else {
          body.innerHTML = renderMd(display);
          body.style.fontFamily = "'Segoe UI', system-ui, sans-serif";
          body.style.whiteSpace = 'normal';
        }
        _modalDocContext.content = display;
      }
    } else {
      const qaElapsedErr = Math.round((Date.now() - qaStartTime) / 1000);
      thread.insertAdjacentHTML('beforeend', '<div class="modal-qa-a" style="color:var(--red)">Error: ' + escHtml(data.error || 'Failed') + '<div style="font-size:9px;color:var(--muted);margin-top:4px;text-align:right">' + qaElapsedErr + 's</div></div>');
    }
  } catch (e) {
    clearInterval(qaTimer);
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    const qaElapsedExc = Math.round((Date.now() - qaStartTime) / 1000);
    if (e.name === 'AbortError') {
      thread.insertAdjacentHTML('beforeend', '<div class="modal-qa-a" style="color:var(--muted)">Stopped<div style="font-size:9px;margin-top:4px;text-align:right">' + qaElapsedExc + 's</div></div>');
    } else {
      thread.insertAdjacentHTML('beforeend', '<div class="modal-qa-a" style="color:var(--red)">Error: ' + escHtml(e.message) + '<div style="font-size:9px;color:var(--muted);margin-top:4px;text-align:right">' + qaElapsedExc + 's</div></div>');
    }
  }

  _qaProcessing = false;
  _qaAbortController = null;
  thread.scrollTop = thread.scrollHeight;

  // Clear processing badge on source card (unless more messages queued)
  if (_qaQueue.length === 0) {
    const doneCard = findCardForFile(capturedFilePath);
    if (doneCard) clearNotifBadge(doneCard);
  }

  // Save session (persists even if modal was closed during processing)
  const modalIsOpen = document.getElementById('modal').classList.contains('open');
  if (_qaSessionKey) {
    // Use captured values if closeModal nulled the globals during processing
    const sessionFilePath = _modalFilePath || capturedFilePath;
    const sessionDocContext = _modalDocContext.title ? { ..._modalDocContext } : { ...capturedDocContext, ..._modalDocContext, title: capturedDocContext.title };
    _qaSessions.set(_qaSessionKey, {
      history: _qaHistory,
      threadHtml: thread.innerHTML,
      docContext: sessionDocContext,
      filePath: sessionFilePath,
    });
    _saveQaSessions();
    // Show notification badge on source card when modal was closed during processing
    if (!modalIsOpen) {
      const card = findCardForFile(sessionFilePath);
      if (card) showNotifBadge(card, _qaQueue.length > 0 ? 'processing' : 'done');
      _qaSessionKey = '';
    }
  }

  // Process next queued message
  if (_qaQueue.length > 0) {
    const next = _qaQueue.shift();
    // Remove the queued indicator and show the blue user bubble now that it's processing
    const queuedEl = thread.querySelector('.qa-queued-item');
    if (queuedEl) queuedEl.remove();
    _renderQaUserMessage(thread, next.message, next.selection);
    _processQaMessage(next.message, next.selection);
  } else if (modalIsOpen) {
    document.getElementById('modal-qa-input')?.focus();
  }
}

function qaAbort() {
  if (_qaAbortController) {
    _qaAbortController.abort();
    _qaAbortController = null;
  }
  // Don't reset _qaProcessing here — the catch block in _processQaMessage handles it,
  // avoiding a double-drain race on _qaQueue from a microtask gap.
  // Don't clear _qaQueue — queued messages auto-process after abort.
}

function toggleDocChat() {
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  if (!wrap) return;
  var visible = wrap.style.display !== 'none';
  wrap.style.display = visible ? 'none' : '';
  if (expandBar) expandBar.style.display = visible ? '' : 'none';
}

function _showThreadWrap() {
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  if (wrap) wrap.style.display = '';
  if (expandBar) expandBar.style.display = 'none';
}

// ── Drag-to-resize doc chat thread ──────────────────────────────────────────
(function() {
  var _dragging = false, _startY = 0, _startH = 0, _thread = null;
  var COLLAPSE_THRESHOLD = 40;
  var MIN_HEIGHT = 60;
  var MAX_HEIGHT = 500;

  document.addEventListener('pointerdown', function(e) {
    var handle = e.target.closest('#qa-resize-handle');
    if (!handle) return;
    _thread = document.getElementById('modal-qa-thread');
    if (!_thread) return;
    _dragging = true;
    _startY = e.clientY;
    _startH = _thread.offsetHeight || 200;
    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('pointermove', function(e) {
    if (!_dragging || !_thread) return;
    var delta = _startY - e.clientY;
    var newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, _startH + delta));
    _thread.style.maxHeight = newH + 'px';
  });

  document.addEventListener('pointerup', function(e) {
    if (!_dragging) return;
    _dragging = false;
    document.body.style.userSelect = '';
    if (!_thread) return;
    var delta = _startY - e.clientY;
    var finalH = _startH + delta;
    if (finalH < COLLAPSE_THRESHOLD) {
      _thread.style.maxHeight = '';
      toggleDocChat();
    }
    _thread = null;
  });
})();

// ── Text selection → "Ask about this" button ─────────────────────────────────
document.addEventListener('mouseup', function() {
  var askBtn = document.getElementById('ask-selection-btn');
  if (!askBtn) return;
  // Only act inside modal body
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    askBtn.style.display = 'none';
    return;
  }
  var modalBody = document.getElementById('modal-body');
  if (!modalBody || !modalBody.contains(sel.anchorNode)) {
    askBtn.style.display = 'none';
    return;
  }
  var text = sel.toString().trim();
  if (!text) { askBtn.style.display = 'none'; return; }
  _modalDocContext.selection = text;
  // Position near the selection
  var range = sel.getRangeAt(0);
  var rect = range.getBoundingClientRect();
  askBtn.style.top = (rect.bottom + 4) + 'px';
  askBtn.style.left = rect.left + 'px';
  askBtn.style.display = 'block';
});

window.MinionsQA = { showModalQa, modalAskAboutSelection, clearQaSelection, clearQaConversation, modalSend, qaAbort, toggleDocChat, _showThreadWrap };
