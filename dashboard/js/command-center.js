// command-center.js — Command center panel functions extracted from dashboard.html

let _ccSessionId = localStorage.getItem('cc-session-id') || null;
let _ccMessages = JSON.parse(localStorage.getItem('cc-messages') || '[]');
let _ccOpen = false;
let _ccSending = false;
let _ccQueue = [];
// Clear stale sending state on page load — SSE streams don't survive refresh
try { localStorage.removeItem('cc-sending'); } catch {}

function toggleCommandCenter() {
  _ccOpen = !_ccOpen;
  const drawer = document.getElementById('cc-drawer');
  if (_ccOpen) ccApplySavedWidth();
  drawer.style.display = _ccOpen ? 'flex' : 'none';
  if (_ccOpen) {
    clearNotifBadge(document.getElementById('cc-toggle-btn'));
    document.getElementById('cc-input').focus();
    ccRestoreMessages();
  } else if (_ccSending) {
    showNotifBadge(document.getElementById('cc-toggle-btn'), 'processing');
  }
}


function ccNewSession() {
  fetch('/api/command-center/new-session', { method: 'POST' }).catch(() => {});
  _ccSessionId = null;
  _ccMessages = [];
  localStorage.removeItem('cc-session-id');
  localStorage.removeItem('cc-messages');
  document.getElementById('cc-messages').innerHTML = '';
  ccUpdateSessionIndicator();
}

function ccRestoreMessages() {
  const el = document.getElementById('cc-messages');
  if (el.children.length > 0 || _ccMessages.length === 0) return; // Already rendered or nothing to restore
  for (const msg of _ccMessages) {
    ccAddMessage(msg.role, msg.html, true);
  }
  // Restore "thinking" indicator if CC was mid-request when page refreshed
  try {
    const sendingState = JSON.parse(localStorage.getItem('cc-sending') || 'null');
    // Only restore sending state if very recent (< 10s) — page refresh kills the SSE stream
    if (sendingState?.sending && (Date.now() - sendingState.startedAt) < 10000) {
      _ccSending = true;
      const elapsed = Date.now() - sendingState.startedAt;
      const thinking = document.createElement('div');
      thinking.id = 'cc-thinking';
      thinking.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:11px;color:var(--muted);align-self:flex-start;display:flex;align-items:center;gap:8px';
      thinking.innerHTML = '<span class="dot-pulse" style="display:inline-flex;gap:3px"><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.2s"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.4s"></span></span> <span id="cc-thinking-text">Still working...</span> <span id="cc-thinking-time" style="font-size:10px;color:var(--border)">' + Math.floor(elapsed / 1000) + 's</span>' +
        ' <button onclick="ccNewSession()" style="font-size:9px;padding:2px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--red);cursor:pointer">Reset</button>';
      el.appendChild(thinking);
      el.scrollTop = el.scrollHeight;
      // Update timer
      const startTime = sendingState.startedAt;
      const restoreTimer = setInterval(function() {
        var timeEl = document.getElementById('cc-thinking-time');
        if (!timeEl || !_ccSending) { clearInterval(restoreTimer); return; }
        timeEl.textContent = Math.floor((Date.now() - startTime) / 1000) + 's';
      }, 1000);
    }
  } catch {}
}

function ccSaveState() {
  try {
    if (_ccSessionId) localStorage.setItem('cc-session-id', _ccSessionId);
    // Keep last 30 messages for display
    const toSave = _ccMessages.slice(-30);
    localStorage.setItem('cc-messages', JSON.stringify(toSave));
  } catch { /* localStorage might be full */ }
}

function ccUpdateSessionIndicator() {
  const el = document.getElementById('cc-session-info');
  if (!el) return;
  if (_ccSessionId) {
    const turns = _ccMessages.filter(m => m.role === 'user').length;
    el.textContent = `Session: ${turns} turn${turns !== 1 ? 's' : ''}`;
    el.style.color = 'var(--green)';
  } else {
    el.textContent = 'Ready';
    el.style.color = 'var(--muted)';
  }
}

function ccAddMessage(role, html, skipSave) {
  const el = document.getElementById('cc-messages');
  const isUser = role === 'user';
  const div = document.createElement('div');
  const isAssistant = !isUser;
  div.className = isAssistant ? 'cc-msg-assistant' : '';
  div.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.6;max-width:95%;' +
    (isUser ? 'background:var(--blue);color:#fff;align-self:flex-end' : 'background:var(--surface2);color:var(--text);align-self:flex-start;border:1px solid var(--border);position:relative');
  div.innerHTML = (isAssistant && !html.includes('color:var(--red)') && !html.includes('cc-queued-pill') ? llmCopyBtn() : '') + html;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  if (!skipSave) {
    _ccMessages.push({ role, html });
    ccSaveState();
  }
}

async function ccSend() {
  const input = document.getElementById('cc-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  // If already processing, queue the message and show it — it'll send when current finishes
  if (_ccSending) {
    _ccQueue.push(message);
    ccAddMessage('user', escHtml(message));
    const preview = message.split(/\s+/).slice(0, 6).join(' ') + (message.split(/\s+/).length > 6 ? '...' : '');
    ccAddMessage('assistant', '<span class="cc-queued-pill" style="color:var(--muted);font-size:10px">Queued: "' + escHtml(preview) + '" — will send after current request</span>');
    return;
  }
  await _ccDoSend(message);

  // Drain queue
  while (_ccQueue.length > 0) {
    const next = _ccQueue.shift();
    // Remove the "Queued" placeholder for this message
    const msgs = document.getElementById('cc-messages');
    const queuedPills = msgs.querySelectorAll('.cc-queued-pill');
    for (const pill of queuedPills) {
      if (pill.closest('div')) { pill.closest('div').remove(); break; }
    }
    await _ccDoSend(next, true); // skipUserMsg=true since already shown when queued
  }
}

async function _ccDoSend(message, skipUserMsg) {
  _ccSending = true;
  try { localStorage.setItem('cc-sending', JSON.stringify({ sending: true, startedAt: Date.now() })); } catch {}

  if (!skipUserMsg) ccAddMessage('user', escHtml(message));

  // Show thinking indicator with timer + queue count
  const queueCount = _ccQueue.length;
  const queueBadge = queueCount > 0 ? ' <span style="font-size:9px;background:var(--surface);padding:1px 5px;border-radius:8px;border:1px solid var(--border)">+' + queueCount + ' queued</span>' : '';
  const thinking = document.createElement('div');
  thinking.id = 'cc-thinking';
  thinking.style.cssText = 'padding:8px 12px;border-radius:8px;font-size:11px;color:var(--muted);align-self:flex-start;display:flex;align-items:center;gap:8px';
  thinking.innerHTML = '<span class="dot-pulse" style="display:inline-flex;gap:3px"><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.2s"></span><span style="width:4px;height:4px;background:var(--blue);border-radius:50%;animation:dotPulse 1.2s infinite;animation-delay:0.4s"></span></span> <span id="cc-thinking-text">Thinking...</span> <span id="cc-thinking-time" style="font-size:10px;color:var(--border)"></span>' + queueBadge;
  document.getElementById('cc-messages').appendChild(thinking);
  const ccMsgs = document.getElementById('cc-messages');
  ccMsgs.scrollTop = ccMsgs.scrollHeight;

  const ccStartTime = Date.now();
  const phases = [
    [0, 'Thinking...'],
    [3000, 'Reading minions context...'],
    [8000, 'Analyzing...'],
    [15000, 'Using tools to dig deeper...'],
    [30000, 'Still working (multi-turn)...'],
    [60000, 'Deep research in progress...'],
    [180000, 'Still going (this is unusually long)...'],
    [300000, 'Timing out soon...'],
  ];
  const ccTimer = setInterval(() => {
    const elapsed = Date.now() - ccStartTime;
    const secs = Math.floor(elapsed / 1000);
    const timeEl = document.getElementById('cc-thinking-time');
    const textEl = document.getElementById('cc-thinking-text');
    if (timeEl) timeEl.textContent = secs + 's';
    if (textEl) {
      for (let i = phases.length - 1; i >= 0; i--) {
        if (elapsed >= phases[i][0]) { textEl.textContent = phases[i][1]; break; }
      }
    }
  }, 500);

  try {
    // Stream response via SSE — shows text as it arrives
    const res = await fetch('/api/command-center/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(960000)
    });

    if (!res.ok) {
      clearInterval(ccTimer);
      thinking.remove();
      const errText = await res.text();
      ccAddMessage('assistant', '<span style="color:var(--red)">' + escHtml(errText || 'CC error') + '</span>' +
        (errText.includes('busy') ? ' <button onclick="ccNewSession()" style="margin-top:4px;padding:3px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--blue);cursor:pointer;font-size:10px">Reset CC</button>' : ''));
      return;
    }

    // Use a temporary streaming div for live updates, then replace with ccAddMessage on completion
    clearInterval(ccTimer);
    try { thinking.remove(); } catch { /* may already be removed */ }
    // Add a temporary placeholder via ccAddMessage so it gets proper styling
    ccAddMessage('assistant', '<span style="color:var(--muted);font-size:11px">Thinking...</span>', true);
    const msgs = document.getElementById('cc-messages');
    const streamDiv = msgs.lastElementChild; // the message we just added
    let streamedText = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'chunk') {
            streamedText = evt.text;
            streamDiv.innerHTML = renderMd(streamedText);
            if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
          } else if (evt.type === 'tool') {
            streamDiv.innerHTML = '<span style="color:var(--blue);font-size:11px">\uD83D\uDD27 Using ' + escHtml(evt.name) + '...</span>';
            if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 150) msgs.scrollTop = msgs.scrollHeight;
          } else if (evt.type === 'done') {
            // Replace streaming div with a proper ccAddMessage
            streamDiv.remove();
            _ccMessages.pop(); // remove the placeholder we pushed
            const ccElapsed = Math.round((Date.now() - ccStartTime) / 1000);
            const rendered = renderMd(evt.text || streamedText || '');
            ccAddMessage('assistant', rendered + '<div style="font-size:9px;color:var(--muted);margin-top:6px;display:flex;justify-content:flex-end;padding-right:30px">' + ccElapsed + 's</div>');
            if (evt.sessionId) { _ccSessionId = evt.sessionId; ccSaveState(); ccUpdateSessionIndicator(); }
            if (evt.actions && evt.actions.length > 0) {
              for (const action of evt.actions) { await ccExecuteAction(action); }
            }
          } else if (evt.type === 'error') {
            streamDiv.remove();
            _ccMessages.pop();
            ccAddMessage('assistant', '<span style="color:var(--red)">' + escHtml(evt.error) + '</span>');
          }
        } catch { /* incomplete JSON */ }
      }
    }
  } catch (e) {
    clearInterval(ccTimer);
    try { thinking.remove(); } catch { /* may already be removed */ }
    const retryId = 'cc-retry-' + Date.now();
    ccAddMessage('assistant', '<span style="color:var(--red)">Error: ' + escHtml(e.message) + '</span>' +
      '<button id="' + retryId + '" onclick="ccRetryLast()" style="margin-top:6px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--blue);cursor:pointer;font-size:11px">Retry</button>');
  } finally {
    _ccSending = false;
    try { localStorage.removeItem('cc-sending'); } catch {}
    // Show notification badge on CC button if drawer is closed
    if (!_ccOpen) showNotifBadge(document.getElementById('cc-toggle-btn'));
  }
}

function ccRetryLast() {
  // Find the last user message and resend it
  const last = _ccMessages.filter(m => m.role === 'user').pop();
  if (!last) return;
  // Extract text from the HTML (strip tags)
  const tmp = document.createElement('div');
  tmp.innerHTML = last.html;
  const text = tmp.textContent || tmp.innerText || '';
  if (!text.trim()) return;
  // Remove the error message (last assistant message)
  const el = document.getElementById('cc-messages');
  if (el?.lastElementChild) el.lastElementChild.remove();
  _ccMessages = _ccMessages.slice(0, -1); // remove error from history
  // Resend
  _ccDoSend(text.trim());
}

async function ccExecuteAction(action) {
  const msgs = document.getElementById('cc-messages');
  const status = document.createElement('div');
  status.style.cssText = 'padding:4px 10px;border-radius:4px;font-size:10px;align-self:flex-start;border:1px dashed var(--border);color:var(--muted)';

  try {
    switch (action.type) {
      case 'dispatch': {
        const res = await fetch('/api/work-items', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: action.title, type: action.workType || 'implement',
            priority: action.priority || 'medium', description: action.description || '',
            project: action.project || '', agents: action.agents || [],
          })
        });
        const d = await res.json();
        status.innerHTML = '&#10003; Dispatched: <strong>' + escHtml(d.id || action.title) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'note': {
        const today = new Date().toISOString().slice(0, 10);
        await fetch('/api/notes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, what: action.content || action.description, author: 'command-center' })
        });
        status.innerHTML = '&#10003; Note saved: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'pin': {
        await fetch('/api/pinned', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, content: action.content || action.description, level: action.level || '' })
        });
        status.innerHTML = '&#x1F4CC; Pinned: <strong>' + escHtml(action.title) + '</strong> — visible to all agents';
        status.style.color = 'var(--green)';
        refresh();
        break;
      }
      case 'plan': {
        await fetch('/api/plan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, description: action.description, project: action.project, branchStrategy: action.branchStrategy || 'parallel' })
        });
        status.innerHTML = '&#10003; Plan queued: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'cancel': {
        await fetch('/api/agents/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: action.agent, reason: action.reason || 'Cancelled via command center' })
        });
        status.innerHTML = '&#10003; Cancelled agent: <strong>' + escHtml(action.agent) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'retry': {
        for (const id of (action.ids || [])) {
          await fetch('/api/work-items/retry', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, source: '' })
          });
        }
        status.innerHTML = '&#10003; Retried: <strong>' + escHtml((action.ids || []).join(', ')) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'pause-plan': {
        await fetch('/api/plans/pause', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: action.file })
        });
        status.innerHTML = '&#10003; Paused plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'approve-plan': {
        await fetch('/api/plans/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: action.file })
        });
        status.innerHTML = '&#10003; Approved plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'edit-prd-item': {
        await fetch('/api/prd-items/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: action.source, itemId: action.itemId, name: action.name, description: action.description, priority: action.priority, estimated_complexity: action.complexity })
        });
        status.innerHTML = '&#10003; Updated PRD item: <strong>' + escHtml(action.itemId) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'remove-prd-item': {
        await fetch('/api/prd-items/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: action.source, itemId: action.itemId })
        });
        status.innerHTML = '&#10003; Removed PRD item: <strong>' + escHtml(action.itemId) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'delete-work-item': {
        await fetch('/api/work-items/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id, source: action.source || '' })
        });
        status.innerHTML = '&#10003; Deleted work item: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'plan-edit': {
        // Read the plan, send instruction to doc-chat, show version actions
        const normalizedFile = normalizePlanFile(action.file);
        const planContent = await fetch('/api/plans/' + encodeURIComponent(normalizedFile)).then(r => r.text());
        const res = await fetch('/api/doc-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: action.instruction,
            document: planContent,
            title: normalizedFile,
            filePath: 'plans/' + normalizedFile,
          }),
        });
        const data = await res.json();
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
        await fetch('/api/plans/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: action.file, project: action.project || '' })
        });
        status.innerHTML = '&#10003; Plan execution queued: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        refreshPlans();
        break;
      }
      case 'file-edit': {
        // doc-chat reads current content from disk via filePath — pass placeholder for required field
        const res = await fetch('/api/doc-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: action.instruction,
            document: '(loaded from disk)',
            title: action.file.split('/').pop(),
            filePath: action.file,
          }),
        });
        const data = await res.json();
        if (data.ok && data.edited) {
          status.innerHTML = '&#10003; Edited: <strong>' + escHtml(action.file) + '</strong>';
          status.style.color = 'var(--green)';
        } else {
          status.innerHTML = data.answer ? renderMd(data.answer) : '&#10007; Could not edit file';
          status.style.color = data.answer ? 'var(--muted)' : 'var(--red)';
        }
        break;
      }
      case 'schedule': {
        const url = action._update ? '/api/schedules/update' : '/api/schedules';
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: action.id, title: action.title, cron: action.cron,
            type: action.workType || 'implement',
            project: action.project, agent: action.agent,
            description: action.description, priority: action.priority,
            enabled: action.enabled !== false,
          })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Schedule create failed'); }
        status.innerHTML = '&#10003; Schedule ' + (action._update ? 'updated' : 'created') + ': <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'delete-schedule': {
        const res = await fetch('/api/schedules/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Schedule delete failed'); }
        status.innerHTML = '&#10003; Deleted schedule: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'create-meeting': {
        const res = await fetch('/api/meetings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title, agenda: action.agenda, participants: action.agents, rounds: action.rounds, project: action.project })
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Meeting create failed'); }
        const d = await res.json();
        status.innerHTML = '&#10003; Meeting started: <strong>' + escHtml(action.title) + '</strong>' + (d.id ? ' (' + escHtml(d.id) + ')' : '');
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'set-config': {
        const payload = { engine: { [action.setting]: action.value } };
        const res = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Config update failed'); }
        status.innerHTML = '&#10003; Set <strong>' + escHtml(action.setting) + '</strong> = ' + escHtml(String(action.value));
        status.style.color = 'var(--green)';
        break;
      }
      case 'edit-pipeline': {
        const body = { id: action.id };
        if (action.title) body.title = action.title;
        if (action.stages) body.stages = action.stages;
        if (action.trigger !== undefined) body.trigger = action.trigger;
        const res = await fetch('/api/pipelines/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Pipeline update failed'); }
        status.innerHTML = '&#10003; Updated pipeline: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'unpin': {
        await fetch('/api/pinned/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: action.title })
        });
        status.innerHTML = '&#10003; Unpinned: <strong>' + escHtml(action.title) + '</strong>';
        status.style.color = 'var(--green)';
        refresh();
        break;
      }
      case 'archive-plan': {
        await fetch('/api/plans/archive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: action.file })
        });
        status.innerHTML = '&#10003; Archived plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--green)';
        refresh();
        break;
      }
      case 'reject-plan': {
        await fetch('/api/plans/reject', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: action.file, reason: action.reason || '' })
        });
        status.innerHTML = '&#10003; Rejected plan: <strong>' + escHtml(action.file) + '</strong>';
        status.style.color = 'var(--orange)';
        break;
      }
      case 'steer-agent': {
        await fetch('/api/agents/steer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: action.agent, message: action.message || action.content })
        });
        status.innerHTML = '&#10003; Steering message sent to <strong>' + escHtml(action.agent) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'add-meeting-note': {
        await fetch('/api/meetings/note', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id, note: action.note || action.content })
        });
        status.innerHTML = '&#10003; Note added to meeting <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        break;
      }
      case 'trigger-pipeline': {
        var res = await fetch('/api/pipelines/trigger', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id })
        });
        if (!res.ok) { var d = await res.json().catch(function() { return {}; }); throw new Error(d.error || 'Pipeline trigger failed'); }
        status.innerHTML = '&#10003; Pipeline triggered: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        wakeEngine();
        break;
      }
      case 'link-pr': {
        await fetch('/api/pull-requests/link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: action.url, title: action.title || '', project: action.project || '', autoObserve: action.autoObserve !== false })
        });
        status.innerHTML = '&#10003; PR linked: <strong>' + escHtml(action.url) + '</strong>';
        status.style.color = 'var(--green)';
        refresh();
        break;
      }
      case 'archive-meeting': {
        await fetch('/api/meetings/archive', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: action.id })
        });
        status.innerHTML = '&#10003; Meeting archived: <strong>' + escHtml(action.id) + '</strong>';
        status.style.color = 'var(--green)';
        refresh();
        break;
      }
      case 'update-routing': {
        await fetch('/api/settings/routing', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: action.content })
        });
        status.innerHTML = '&#10003; Routing updated';
        status.style.color = 'var(--green)';
        break;
      }
      default:
        status.innerHTML = '? Unknown action: ' + escHtml(action.type);
        status.style.color = 'var(--muted)';
    }
  } catch (e) {
    status.innerHTML = '&#10007; Action failed: ' + escHtml(e.message);
    status.style.color = 'var(--red)';
  }

  msgs.appendChild(status);
  msgs.scrollTop = msgs.scrollHeight;
  refresh();
}

// --- CC Resize Logic ---
const CC_MIN_WIDTH = 320;
const CC_MAX_WIDTH_RATIO = 0.8; // 80% of viewport
const CC_DEFAULT_WIDTH = 420;
const CC_WIDTH_KEY = 'cc-drawer-width';

function ccApplySavedWidth() {
  const drawer = document.getElementById('cc-drawer');
  if (!drawer) return;
  const saved = parseInt(localStorage.getItem(CC_WIDTH_KEY), 10);
  if (saved && saved >= CC_MIN_WIDTH) {
    const maxW = Math.floor(window.innerWidth * CC_MAX_WIDTH_RATIO);
    drawer.style.width = Math.min(saved, maxW) + 'px';
  }
}

function ccInitResize() {
  const handle = document.getElementById('cc-resize-handle');
  const drawer = document.getElementById('cc-drawer');
  if (!handle || !drawer) return;

  let startX = 0;
  let startW = 0;

  function onMouseMove(e) {
    const maxW = Math.floor(window.innerWidth * CC_MAX_WIDTH_RATIO);
    const delta = startX - e.clientX; // dragging left = wider
    const newW = Math.max(CC_MIN_WIDTH, Math.min(startW + delta, maxW));
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

  handle.addEventListener('mousedown', (e) => {
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

window.MinionsCC = { toggleCommandCenter, ccNewSession, ccRestoreMessages, ccSaveState, ccUpdateSessionIndicator, ccAddMessage, ccSend, ccExecuteAction };
