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
const QA_STREAM_STALL_MS = 6 * 60 * 1000; // allow the full doc-chat timeout before treating heartbeat-only streams as stalled
let _qaSessionKey = ''; // key for current conversation (title or filePath)

// Insert html at the bottom of the thread but above any pending "Queued: ..."
// strips, so queued messages always remain visually below the active progress
// UX / answer / errors.
function _qaInsertBeforeQueued(container, html) {
  if (!container) return;
  const firstQueued = container.querySelector && container.querySelector('.qa-queued-item');
  if (firstQueued) firstQueued.insertAdjacentHTML('beforebegin', html);
  else container.insertAdjacentHTML('beforeend', html);
}

function _renderQaUserMessage(thread, message, selection) {
  let qHtml = '<div class="modal-qa-q">' + escHtml(message);
  if (selection) {
    qHtml += '<span class="selection-ref">Re: "' + escHtml(selection.slice(0, 100)) + ((selection.length > 100) ? '...' : '') + '"</span>';
  }
  qHtml += '</div>';
  _qaInsertBeforeQueued(thread, qHtml);
  thread.scrollTop = thread.scrollHeight;
  _showThreadWrap();
}
const _qaSessions = new Map(); // persist conversations across modal open/close {key → {history, threadHtml}}
const _qaRuntime = new Map(); // key → {history, processing, abortController, queue}
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

function _qaCloneQueue(queue) {
  return Array.isArray(queue) ? queue.map(item => ({ ...item })) : [];
}

function _qaGetRuntime(key) {
  if (!key) return null;
  let runtime = _qaRuntime.get(key);
  if (!runtime) {
    const prior = _qaSessions.get(key);
    runtime = {
      history: Array.isArray(prior?.history) ? prior.history.slice() : [],
      processing: false,
      abortController: null,
      queue: _qaCloneQueue(prior?.queue),
    };
    _qaRuntime.set(key, runtime);
  }
  return runtime;
}

function _qaThreadEl() {
  return document.getElementById('modal-qa-thread');
}

function _qaThreadHtml() {
  return (_qaThreadEl() || {}).innerHTML || '';
}

function _qaIsActiveSession(key) {
  return !!key && _qaSessionKey === key && document.getElementById('modal')?.classList?.contains('open');
}

function _qaSyncActiveRuntime() {
  if (!_qaSessionKey) return;
  const runtime = _qaGetRuntime(_qaSessionKey);
  if (!runtime) return;
  runtime.history = _qaHistory.slice();
  runtime.processing = _qaProcessing;
  runtime.abortController = _qaAbortController || null;
  runtime.queue = _qaCloneQueue(_qaQueue);
}

function _qaPersistSession(key, { threadHtml, docContext, filePath, history, queue } = {}) {
  if (!key) return;
  const runtime = _qaGetRuntime(key);
  const prior = _qaSessions.get(key) || {};
  const persistedHistory = Array.isArray(history)
    ? history.slice()
    : Array.isArray(runtime?.history)
      ? runtime.history.slice()
      : Array.isArray(prior.history)
        ? prior.history.slice()
        : [];
  _qaSessions.set(key, {
    history: persistedHistory,
    threadHtml: threadHtml != null ? threadHtml : (prior.threadHtml || ''),
    docContext: docContext ? { ...docContext } : (prior.docContext ? { ...prior.docContext } : { title: '', content: '', selection: '' }),
    filePath: filePath !== undefined ? filePath : prior.filePath,
    queue: Array.isArray(queue) ? _qaCloneQueue(queue) : _qaCloneQueue(runtime?.queue),
  });
  _saveQaSessions();
}

// Debounced wrapper for the streaming hot path. Each chunk event currently
// fires _qaPersistSession, which serializes the entire thread HTML into
// localStorage — fine at one or two writes a second, expensive at the dozens
// per second a fast LLM stream produces. Coalesce into a single write per
// _QA_PERSIST_DEBOUNCE_MS window. Terminal writes (done / error / abort /
// queue advance) keep using _qaPersistSession directly so the final state
// always lands; they call _qaFlushPersistDebounce first to drop any pending
// stale chunk-period write.
//
// State is kept per-session on the runtime so two simultaneously-streaming
// sessions don't share a timer (the second session's pending payload would
// otherwise overwrite the first's, dropping a write).
const _QA_PERSIST_DEBOUNCE_MS = 250;

function _qaPersistSessionDebounced(key, payload) {
  if (!key) return;
  const runtime = _qaGetRuntime(key);
  if (!runtime) return;
  runtime._persistPending = payload;
  if (runtime._persistTimer) return;
  runtime._persistTimer = setTimeout(() => {
    runtime._persistTimer = null;
    const pending = runtime._persistPending;
    runtime._persistPending = null;
    if (pending) _qaPersistSession(key, pending);
  }, _QA_PERSIST_DEBOUNCE_MS);
}

function _qaFlushPersistDebounce(key) {
  if (!key) return;
  const runtime = _qaGetRuntime(key);
  if (!runtime) return;
  if (runtime._persistTimer) {
    clearTimeout(runtime._persistTimer);
    runtime._persistTimer = null;
  }
  runtime._persistPending = null;
}

function _qaSaveActiveSessionState() {
  if (!_qaSessionKey) return;
  _qaSyncActiveRuntime();
  _qaPersistSession(_qaSessionKey, {
    threadHtml: _qaThreadHtml(),
    docContext: { ..._modalDocContext },
    filePath: _modalFilePath,
    history: _qaHistory,
    queue: _qaQueue,
  });
}

function _qaLoadSessionState(key) {
  const prior = _qaSessions.get(key);
  const runtime = _qaGetRuntime(key);
  _qaHistory = Array.isArray(runtime?.history) && runtime.history.length
    ? runtime.history.slice()
    : Array.isArray(prior?.history)
      ? prior.history.slice()
      : [];
  _qaProcessing = !!runtime?.processing;
  _qaAbortController = runtime?.abortController || null;
  _qaQueue = _qaCloneQueue(runtime?.queue);
  const thread = _qaThreadEl();
  if (thread) {
    const tmp = document.createElement('div');
    tmp.innerHTML = prior?.threadHtml || '';
    if (!_qaProcessing) tmp.querySelectorAll('.modal-qa-loading').forEach(el => el.remove());
    thread.innerHTML = tmp.innerHTML;
  }
}

function _qaResetActiveState() {
  _qaHistory = [];
  _qaProcessing = false;
  _qaAbortController = null;
  _qaQueue = [];
  _qaSessionKey = '';
}

function _qaBuildUserMessageHtml(message, selection) {
  let qHtml = '<div class="modal-qa-q">' + escHtml(message);
  if (selection) {
    qHtml += '<span class="selection-ref">Re: "' + escHtml(selection.slice(0, 100)) + ((selection.length > 100) ? '...' : '') + '"</span>';
  }
  qHtml += '</div>';
  return qHtml;
}

function _qaBuildQueuedHtml(message) {
  const preview = escHtml(message.length > 60 ? message.slice(0, 57) + '...' : message);
  return '<div class="qa-queued-item" style="color:var(--muted);font-size:10px;padding:4px 8px">Queued: "' + preview + '"</div>';
}

function _qaBuildLoadingHtml(loadingId, queueCount) {
  const qaQueueBadge = queueCount > 0 ? ' <span style="font-size:9px;color:var(--muted);background:var(--surface);padding:1px 5px;border-radius:8px;border:1px solid var(--border)">+' + queueCount + ' queued</span>' : '';
  return '<div class="modal-qa-loading" id="' + loadingId + '">' +
    '<div class="dot-pulse"><span></span><span></span><span></span></div> ' +
    '<span id="' + loadingId + '-text">Thinking...</span> ' +
    '<span id="' + loadingId + '-time" style="font-size:10px;color:var(--muted)"></span>' +
    ' <button onclick="qaAbort()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer">Stop</button>' +
    qaQueueBadge + '</div>';
}

// Render the raw error envelope (stderr + metadata) returned by ccDocCallStreaming
// when the runtime fails. Always shown — collapsed by default — so the user can
// inspect the actual CLI output instead of relying on the friendly summary.
function _qaBuildRawErrorHtml(err) {
  if (!err) return '';
  const meta = [];
  if (err.runtime) meta.push('runtime: ' + escHtml(String(err.runtime)));
  if (err.errorClass) meta.push('class: ' + escHtml(String(err.errorClass)));
  if (err.code !== null && err.code !== undefined) meta.push('exit: ' + escHtml(String(err.code)));
  const metaLine = meta.length
    ? '<div style="font-size:10px;color:var(--muted);margin-bottom:4px">' + meta.join(' · ') + '</div>'
    : '';
  const adapterMessage = err.errorMessage
    ? '<div style="font-size:11px;color:var(--text);margin-bottom:6px;white-space:pre-wrap">' + escHtml(String(err.errorMessage)) + '</div>'
    : '';
  const stderrText = err.stderr ? String(err.stderr) : '';
  const stderrBlock = stderrText
    ? '<pre style="margin:0;padding:6px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto">' + escHtml(stderrText) + '</pre>'
    : '<div style="font-size:11px;color:var(--muted)">(no stderr captured)</div>';
  return '<details class="modal-qa-raw-error" style="margin:6px 0 12px;padding:6px 8px;border:1px solid var(--red);border-radius:4px;background:var(--surface)">' +
    '<summary style="cursor:pointer;font-size:11px;color:var(--red)">Raw error output</summary>' +
    '<div style="margin-top:6px">' + metaLine + adapterMessage + stderrBlock + '</div>' +
    '</details>';
}

function _qaBuildAssistantHtml(text, opts) {
  const body = opts?.isError ? escHtml(text) : renderMd(text);
  const style = opts?.isError
    ? 'color:' + (opts?.color || 'var(--red)')
    : 'border-left-color:' + (opts?.borderColor || 'var(--blue)');
  const pad = opts?.isError ? '' : 'padding-right:24px;';
  return '<div class="modal-qa-a" style="' + style + '">' +
    (opts?.isError ? '' : llmCopyBtn()) +
    body +
    '<div style="font-size:9px;color:var(--muted);margin-top:4px;text-align:right;' + pad + '">' + opts.elapsed + 's</div>' +
    '</div>';
}

const QA_WORK_ITEM_ACTION_TYPES = new Set(['dispatch', 'fix', 'implement', 'explore', 'review', 'test']);

function _qaActionFeedbackHandled(action, actionResult) {
  const type = String(actionResult?.type || action?.type || '');
  return QA_WORK_ITEM_ACTION_TYPES.has(type) && !!(actionResult?.ok || actionResult?.error);
}

function _qaRunHandledActionSideEffects(action, actionResult) {
  const type = String(actionResult?.type || action?.type || '');
  if (!QA_WORK_ITEM_ACTION_TYPES.has(type)) return;
  if (typeof wakeEngine === 'function') wakeEngine();
  if (typeof refresh === 'function') refresh();
}

function _qaBuildActionFeedbackHtml(actionFeedback) {
  if (!Array.isArray(actionFeedback) || actionFeedback.length === 0) return '';
  return actionFeedback.map(function(item) {
    const type = escHtml(item.type || 'dispatch');
    const baseStyle = 'padding:4px 10px;border-radius:4px;font-size:10px;align-self:flex-start;border:1px dashed var(--border);margin:4px 0;';
    if (item.error) {
      return '<div class="modal-qa-action-feedback" style="' + baseStyle + 'color:var(--red)">&#10007; ' + type + ' failed: ' + escHtml(item.error) + '</div>';
    }
    const label = escHtml(item.id || item.duplicateOf || '');
    const duplicate = item.duplicate ? ' <span style="color:var(--orange)">already exists</span>' : '';
    const warning = item.warning ? '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + escHtml(item.warning) + '</div>' : '';
    return '<div class="modal-qa-action-feedback" style="' + baseStyle + 'color:' + (item.duplicate ? 'var(--orange)' : 'var(--green)') + '">&#10003; ' + type + ': <strong>' + label + '</strong>' + duplicate + warning + '</div>';
  }).join('');
}

function _qaBuildLiveProgressHtml(loadingId, label, elapsedSeconds, streamedText, toolsUsed, queueCount) {
  const qaQueueBadge = queueCount > 0 ? ' <span style="font-size:9px;color:var(--muted);background:var(--surface);padding:1px 5px;border-radius:8px;border:1px solid var(--border)">+' + queueCount + ' queued</span>' : '';
  // Wrap in a column-flex container so chain-of-thought (tool calls) stack
  // vertically on top and the progress block sits at the bottom. Overrides the
  // parent .modal-qa-loading row-flex (which is right for the simple
  // "Thinking..." initial state but wrong once tools/streamed text appear).
  let html = '<div style="display:flex;flex-direction:column;align-items:stretch;gap:6px;width:100%">';
  if (toolsUsed && toolsUsed.length > 0) {
    html += '<div style="display:flex;flex-direction:column;gap:2px">';
    toolsUsed.forEach(function(t) {
      const name = typeof t === 'string' ? t : t.name;
      const input = typeof t === 'string' ? {} : (t.input || {});
      html += '<div style="color:var(--muted);font-size:10px;font-family:monospace;display:flex;align-items:flex-start;gap:6px"><span style="flex-shrink:0">&#9679;</span><span style="word-break:break-all">' + formatToolSummary(name, input) + '</span></div>';
    });
    html += '</div>';
  }
  if (streamedText) html += '<div>' + renderMd(streamedText) + '</div>';
  html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<span class="dot-pulse"><span></span><span></span><span></span></span>' +
    '<span id="' + loadingId + '-text">' + escHtml(label) + '</span>' +
    '<span id="' + loadingId + '-time" style="font-size:10px;color:var(--muted)">' + elapsedSeconds + 's</span>' +
    '<button onclick="qaAbort()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer">Stop</button>' +
    qaQueueBadge +
  '</div>';
  html += '</div>';
  return html;
}

function _qaMutateThreadHtml(key, mutate) {
  const tmp = document.createElement('div');
  tmp.innerHTML = _qaIsActiveSession(key) ? _qaThreadHtml() : ((_qaSessions.get(key) || {}).threadHtml || '');
  mutate(tmp);
  const html = tmp.innerHTML;
  if (_qaIsActiveSession(key)) {
    const wasCollapsed = _qaIsThreadCollapsed();
    const thread = _qaThreadEl();
    if (thread) {
      thread.innerHTML = html;
      thread.scrollTop = thread.scrollHeight;
    }
    if (wasCollapsed) _setQaThreadCollapsed(true);
    else _showThreadWrap();
  }
  return html;
}

function _qaResumeQueuedMessages() {
  if (!_qaSessionKey || _qaProcessing || _qaQueue.length === 0) return;
  const next = _qaQueue.shift();
  const thread = _qaThreadEl();
  if (thread) {
    const queuedEl = thread.querySelector('.qa-queued-item');
    if (queuedEl) queuedEl.remove();
    _renderQaUserMessage(thread, next.message, next.selection);
  }
  _qaSaveActiveSessionState();
  _processQaMessage(next.message, next.selection);
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
  if (_qaSessionKey && _qaSessionKey !== key) _qaSaveActiveSessionState();
  _qaSessionKey = key;
  const card = findCardForFile(_modalFilePath);
  if (card) clearNotifBadge(card);
  var prior = _qaSessions.get(key);
  _qaLoadSessionState(key);
  if (prior) {
    if (prior.docContext) {
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
    requestAnimationFrame(function() {
      var thread = document.getElementById('modal-qa-thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    });
    if (_qaQueue.length > 0 && !_qaProcessing) {
      setTimeout(_qaResumeQueuedMessages, 0);
    }
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
  const runtime = _qaGetRuntime(_qaSessionKey);
  if (_qaAbortController) _qaAbortController.abort();
  if (runtime?.abortController && runtime.abortController !== _qaAbortController) runtime.abortController.abort();
  _qaHistory = [];
  _qaQueue = [];
  _qaProcessing = false;
  _qaAbortController = null;
  document.getElementById('modal-qa-thread').innerHTML = '';
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  if (wrap) wrap.style.display = 'none';
  if (expandBar) expandBar.style.display = 'none';
  if (_qaSessionKey) {
    _qaSessions.delete(_qaSessionKey);
    _qaRuntime.set(_qaSessionKey, { history: [], processing: false, abortController: null, queue: [] });
    _saveQaSessions();
  }
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

  input.value = '';
  _modalDocContext.selection = '';
  document.getElementById('modal-qa-pill').style.display = 'none';

  if (_qaProcessing) {
    if (_qaQueue.length >= QA_QUEUE_CAP) {
      showToast('cmd-toast', 'Queue full — wait for current response', false);
      return;
    }
    _qaQueue.push({ message, selection });
    thread.insertAdjacentHTML('beforeend', _qaBuildQueuedHtml(message));
    thread.scrollTop = thread.scrollHeight;
    _showThreadWrap();
    _qaSaveActiveSessionState();
    return;
  }

  _renderQaUserMessage(thread, message, selection);
  _qaSaveActiveSessionState();
  _processQaMessage(message, selection);
}

async function _processQaMessage(message, selection, opts) {
  const sessionKey = opts?.sessionKey || _qaSessionKey;
  if (!sessionKey) return;
  const runtime = _qaGetRuntime(sessionKey);
  if (!runtime) return;

  const prior = _qaSessions.get(sessionKey);
  const capturedFilePath = opts?.filePath !== undefined ? opts.filePath : (prior?.filePath || _modalFilePath);
  const capturedDocContext = Object.assign({}, prior?.docContext || {}, opts?.docContext || (_qaIsActiveSession(sessionKey) ? _modalDocContext : {}));
  const isActiveSession = _qaIsActiveSession(sessionKey);

  runtime.processing = true;
  const abortController = new AbortController();
  runtime.abortController = abortController;
  if (isActiveSession) {
    _qaProcessing = true;
    _qaAbortController = abortController;
  }

  const sourceCard = findCardForFile(capturedFilePath);
  if (sourceCard) showNotifBadge(sourceCard, 'processing');

  const loadingId = 'chat-loading-' + Date.now();
  const loadingHtml = _qaBuildLoadingHtml(loadingId, runtime.queue.length);
  const startThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
    _qaInsertBeforeQueued(tmp, loadingHtml);
  });
  _qaPersistSession(sessionKey, {
    threadHtml: startThreadHtml,
    docContext: capturedDocContext,
    filePath: capturedFilePath,
    history: runtime.history,
    queue: runtime.queue,
  });

  const isPlanEdit = capturedFilePath && capturedFilePath.match(/^plans\/.*\.md$/);
  const qaStartTime = Date.now();
  const qaPhases = isPlanEdit
    ? [[0,'Reading plan...'],[3000,'Analyzing structure...'],[8000,'Researching context...'],[15000,'Drafting revisions...'],[30000,'Writing updated plan...'],[60000,'Still working (large document)...'],[120000,'Deep edit in progress...'],[300000,'Almost there...']]
    : [[0,'Thinking...'],[3000,'Reading document...'],[8000,'Analyzing...'],[20000,'Still working...'],[60000,'Taking a while...']];
  let streamedText = '';
  let toolsUsed = [];
  let _qaStreamStalled = false;
  let _qaStallTimer = null;
  function _clearQaStreamWatchdog() {
    if (_qaStallTimer) {
      clearTimeout(_qaStallTimer);
      _qaStallTimer = null;
    }
  }
  function _resetQaStreamWatchdog() {
    _clearQaStreamWatchdog();
    _qaStallTimer = setTimeout(() => {
      _qaStreamStalled = true;
      try { abortController.abort(); } catch {}
    }, QA_STREAM_STALL_MS);
  }
  function _qaProgressLabel(elapsed) {
    let label = qaPhases[0][1];
    for (let i = qaPhases.length - 1; i >= 0; i--) {
      if (elapsed >= qaPhases[i][0]) {
        label = qaPhases[i][1];
        break;
      }
    }
    return label;
  }
  function _qaRenderProgress(persist) {
    const elapsed = Date.now() - qaStartTime;
    const updatedThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
      const loadingEl = tmp.querySelector('#' + loadingId);
      if (!loadingEl) return;
      loadingEl.innerHTML = _qaBuildLiveProgressHtml(
        loadingId,
        _qaProgressLabel(elapsed),
        Math.floor(elapsed / 1000),
        streamedText,
        toolsUsed,
        runtime.queue.length
      );
    });
    if (persist) {
      _qaPersistSessionDebounced(sessionKey, {
        threadHtml: updatedThreadHtml,
        docContext: capturedDocContext,
        filePath: capturedFilePath,
        history: runtime.history,
        queue: runtime.queue,
      });
    }
  }
  const qaTimer = setInterval(() => {
    _qaRenderProgress(false);
  }, 500);
  _qaRenderProgress(false);
  _resetQaStreamWatchdog();

  try {
    const res = await fetch('/api/doc-chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({
        message,
        document: capturedDocContext.content,
        title: capturedDocContext.title,
        selection: selection,
        filePath: capturedFilePath || null,
        model: window._lastStatus?.autoMode?.ccModel || undefined,
        contentHash: capturedDocContext.content ? (function(s) { const m = Math.floor(s.length / 2); return s.length + ':' + s.charCodeAt(0) + ':' + s.charCodeAt(m) + ':' + s.charCodeAt(s.length - 1); })(capturedDocContext.content) : undefined,
      }),
    });
    let sessionDocContext = { ...capturedDocContext };
    if (!res.ok) {
      const errText = await res.text();
      let errMsg = errText || 'Failed';
      try {
        const parsed = JSON.parse(errText);
        errMsg = parsed.error || errMsg;
      } catch { /* text/plain fallback */ }
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let terminalEventSeen = false;

    async function _qaHandleStreamEvent(evt) {
      if (!evt || !evt.type) return;
      if (evt.type === 'heartbeat') return;
      if (evt.type === 'progress') {
        // Backend is retrying (attempt 2 or 3) — reset stall watchdog so the next
        // attempt gets its own full stall window instead of sharing the first attempt's.
        _resetQaStreamWatchdog();
        return;
      }
      if (evt.type === 'chunk') {
        _resetQaStreamWatchdog();
        streamedText = evt.text || '';
        _qaRenderProgress(true);
        return;
      }
      if (evt.type === 'tool') {
        _resetQaStreamWatchdog();
        toolsUsed.push({ name: evt.name, input: evt.input || {} });
        _qaRenderProgress(true);
        return;
      }
      if (evt.type === 'done') {
        terminalEventSeen = true;
        clearInterval(qaTimer);
        _clearQaStreamWatchdog();
        const qaElapsed = Math.round((Date.now() - qaStartTime) / 1000);
        // Pick the border that best reflects what actually happened:
        //  - partial recovery (work landed despite a non-zero exit) \u2192 orange
        //    (checked first because partial responses now also carry an error
        //    envelope so the raw stderr can be surfaced)
        //  - hard error (no recoverable answer) \u2192 red
        //  - successful edit \u2192 green
        //  - normal answer \u2192 blue
        const borderColor = evt.partial
          ? 'var(--orange)'
          : evt.error
            ? 'var(--red)'
            : evt.edited ? 'var(--green)' : 'var(--blue)';
        const suffix = evt.edited ? '\n\n\u2713 Document saved.' : '';
        // Fall back to the live-streamed text when the backend produced no final
        // answer \u2014 covers the "stream had visible chunks then returned empty" case.
        const finalText = (evt.text && evt.text.trim()) ? evt.text : (streamedText || '');
        let bodyText = finalText + suffix;
        if (evt.partial && evt.warning) {
          bodyText += '\n\n_' + evt.warning + '_';
        }
        // On hard failures, surface tool side-effects so the user knows what
        // landed before the runtime gave up \u2014 silent destruction was the worst
        // class of "Failed to process request" UX.
        if (evt.error && Array.isArray(evt.toolUses) && evt.toolUses.length > 0) {
          const names = evt.toolUses.slice(0, 8).map(t => t.name).join(', ');
          const more = evt.toolUses.length > 8 ? '\u2026' : '';
          bodyText += '\n\n_Tools that ran before the failure: ' + names + more + ' \u2014 files or state may have been modified._';
        }
        const answerHtml = _qaBuildAssistantHtml(bodyText, { borderColor, elapsed: qaElapsed });
        const actionFeedbackHtml = _qaBuildActionFeedbackHtml(evt.actionFeedback);
        // On any runtime failure, surface the raw error so users can debug it
        // directly instead of guessing what the friendly summary was hiding.
        const rawErrorHtml = evt.error ? _qaBuildRawErrorHtml(evt.error) : '';
        let updatedThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
          const loadingEl = tmp.querySelector('#' + loadingId);
          if (loadingEl) loadingEl.remove();
          _qaInsertBeforeQueued(tmp, answerHtml);
          if (actionFeedbackHtml) _qaInsertBeforeQueued(tmp, actionFeedbackHtml);
          if (rawErrorHtml) _qaInsertBeforeQueued(tmp, rawErrorHtml);
        });

        runtime.history.push({ role: 'user', text: message });
        runtime.history.push({ role: 'assistant', text: finalText || '' });
        if (_qaIsActiveSession(sessionKey)) _qaHistory = runtime.history.slice();

        _qaNotifySidebar(capturedFilePath);
        if (evt.actions && evt.actions.length > 0) {
          const actionResults = Array.isArray(evt.actionResults) ? evt.actionResults : [];
          if (evt.actionResults && typeof _tagServerExecuted === 'function') _tagServerExecuted(evt.actions, evt.actionResults);
          for (let ai = 0; ai < evt.actions.length; ai++) {
            const action = evt.actions[ai];
            const actionResult = actionResults[ai];
            if (_qaActionFeedbackHandled(action, actionResult)) {
              _qaRunHandledActionSideEffects(action, actionResult);
              continue;
            }
            await ccExecuteAction(action);
          }
        } else if (evt.actionParseError) {
          const warning = '<div class="modal-qa-a" style="color:var(--red)">Actions block emitted but JSON could not be parsed — no actions were executed. Resend or rephrase. (' + escHtml(String(evt.actionParseError).slice(0, 200)) + ')</div>';
          updatedThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
            _qaInsertBeforeQueued(tmp, warning);
          });
        }

        if (evt.edited && evt.content) {
          const display = evt.content.replace(/^---[\s\S]*?---\n*/m, '');
          const isJson = capturedFilePath && capturedFilePath.endsWith('.json');
          sessionDocContext.content = display;
          sessionDocContext.selection = '';
          if (_qaIsActiveSession(sessionKey)) {
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
        }

        _qaFlushPersistDebounce(sessionKey);
        _qaPersistSession(sessionKey, {
          threadHtml: updatedThreadHtml,
          docContext: sessionDocContext,
          filePath: capturedFilePath,
          history: runtime.history,
          queue: runtime.queue,
        });
        return;
      }
      if (evt.type === 'error') {
        _clearQaStreamWatchdog();
        throw new Error(evt.error || 'Failed');
      }
    }

    while (true) {
      const readResult = await reader.read();
      if (readResult.done) break;
      buf += decoder.decode(readResult.value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('data: ')) continue;
        await _qaHandleStreamEvent(JSON.parse(line.slice(6)));
      }
    }
    if (buf.trim()) {
      const trailing = buf.split('\n');
      for (let i = 0; i < trailing.length; i++) {
        const line = trailing[i];
        if (!line.startsWith('data: ')) continue;
        await _qaHandleStreamEvent(JSON.parse(line.slice(6)));
      }
    }
    if (!terminalEventSeen) throw new Error('The response stream ended before completion.');
  } catch (e) {
    clearInterval(qaTimer);
    _clearQaStreamWatchdog();
    const qaElapsedExc = Math.round((Date.now() - qaStartTime) / 1000);
    const stallMessage = 'Doc chat stalled with no tool or text progress for 6 minutes.';
    const messageHtml = _qaStreamStalled
      ? (streamedText
          ? _qaBuildAssistantHtml(streamedText + '\n\nError: ' + stallMessage, { borderColor: 'var(--red)', elapsed: qaElapsedExc })
          : _qaBuildAssistantHtml('Error: ' + stallMessage, { color: 'var(--red)', isError: true, elapsed: qaElapsedExc }))
      : e.name === 'AbortError'
      ? (streamedText
          ? _qaBuildAssistantHtml(streamedText + '\n\n_Stopped._', { borderColor: 'var(--muted)', elapsed: qaElapsedExc })
          : _qaBuildAssistantHtml('Stopped', { color: 'var(--muted)', isError: true, elapsed: qaElapsedExc }))
      : (streamedText
          ? _qaBuildAssistantHtml(streamedText + '\n\nError: ' + e.message, { borderColor: 'var(--red)', elapsed: qaElapsedExc })
          : _qaBuildAssistantHtml('Error: ' + e.message, { color: 'var(--red)', isError: true, elapsed: qaElapsedExc }));
    const updatedThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
      const loadingEl = tmp.querySelector('#' + loadingId);
      if (loadingEl) loadingEl.remove();
      _qaInsertBeforeQueued(tmp, messageHtml);
    });
    _qaFlushPersistDebounce(sessionKey);
    _qaPersistSession(sessionKey, {
      threadHtml: updatedThreadHtml,
      docContext: capturedDocContext,
      filePath: capturedFilePath,
      history: runtime.history,
      queue: runtime.queue,
    });
  }

  runtime.processing = false;
  runtime.abortController = null;
  if (_qaIsActiveSession(sessionKey)) {
    _qaProcessing = false;
    _qaAbortController = null;
  }

  if (runtime.queue.length === 0) {
    const doneCard = findCardForFile(capturedFilePath);
    if (_qaIsActiveSession(sessionKey)) {
      if (doneCard) clearNotifBadge(doneCard);
    } else if (doneCard) {
      showNotifBadge(doneCard, 'done');
    }
  } else {
    const pendingCard = findCardForFile(capturedFilePath);
    if (pendingCard) showNotifBadge(pendingCard, 'processing');
  }

  if (runtime.queue.length > 0) {
    const next = runtime.queue.shift();
    const nextThreadHtml = _qaMutateThreadHtml(sessionKey, tmp => {
      const queuedEl = tmp.querySelector('.qa-queued-item');
      if (queuedEl) queuedEl.remove();
      _qaInsertBeforeQueued(tmp, _qaBuildUserMessageHtml(next.message, next.selection));
    });
    _qaFlushPersistDebounce(sessionKey);
    _qaPersistSession(sessionKey, {
      threadHtml: nextThreadHtml,
      docContext: (_qaSessions.get(sessionKey) || {}).docContext || capturedDocContext,
      filePath: capturedFilePath,
      history: runtime.history,
      queue: runtime.queue,
    });
    if (_qaIsActiveSession(sessionKey)) _qaQueue = _qaCloneQueue(runtime.queue);
    _processQaMessage(next.message, next.selection, {
      sessionKey,
      filePath: capturedFilePath,
      docContext: (_qaSessions.get(sessionKey) || {}).docContext || capturedDocContext,
    });
  } else if (_qaIsActiveSession(sessionKey)) {
    _qaQueue = [];
    document.getElementById('modal-qa-input')?.focus();
  }
}

function qaAbort() {
  const runtime = _qaGetRuntime(_qaSessionKey);
  if (runtime?.abortController) {
    runtime.abortController.abort();
    runtime.abortController = null;
  }
  if (_qaAbortController) _qaAbortController = null;
  // Don't reset _qaProcessing here — the catch block in _processQaMessage handles it.
  // Don't clear _qaQueue — queued messages auto-process after abort.
}

function toggleDocChat() {
  var wrap = document.getElementById('modal-qa-thread-wrap');
  if (!wrap) return;
  var visible = wrap.style.display !== 'none';
  _setQaThreadCollapsed(visible);
}

function _qaIsThreadCollapsed() {
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  return !!(wrap && wrap.style.display === 'none' && expandBar && expandBar.style.display !== 'none');
}

function _setQaThreadCollapsed(collapsed) {
  var wrap = document.getElementById('modal-qa-thread-wrap');
  var expandBar = document.getElementById('qa-expand-bar');
  if (wrap) wrap.style.display = collapsed ? 'none' : '';
  if (expandBar) expandBar.style.display = collapsed ? '' : 'none';
}

function _showThreadWrap() {
  _setQaThreadCollapsed(false);
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
