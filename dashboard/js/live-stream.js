// dashboard/js/live-stream.js — Live streaming and polling extracted from dashboard.html

let livePollingInterval = null;
let liveEventSource = null;
let _steerInFlight = false;
let _lastRenderedText = '';
let _runtimeTimer = null;

function _currentAgentRuntime() {
  var agent = (agentData || []).find(function(a) { return a.id === currentAgentId; });
  return agent && agent.runtime ? agent.runtime : '';
}

function _updateRuntimeCounter() {
  var el = document.getElementById('live-runtime');
  if (!el) return;
  var started = el.dataset.started;
  if (!started) return;
  var ms = Date.now() - new Date(started).getTime();
  if (ms < 0) ms = 0;
  var sec = Math.floor(ms / 1000) % 60;
  var min = Math.floor(ms / 60000) % 60;
  var hr = Math.floor(ms / 3600000);
  el.textContent = (hr > 0 ? hr + 'h ' : '') + min + 'm ' + sec + 's';
}

function renderLiveChatMessage(raw) {
  const el = document.getElementById('live-messages');
  if (!el) return;
  const html = renderAgentOutput(raw);
  if (html) el.insertAdjacentHTML('beforeend', html);

  // Auto-scroll
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
    el.scrollTop = el.scrollHeight;
  }
}

function startLiveStream(agentId) {
  stopLiveStream();
  if (!agentId) return;

  const msgEl = document.getElementById('live-messages');
  if (msgEl) msgEl.innerHTML = '';
  _lastRenderedText = '';

  // Start runtime counter
  _updateRuntimeCounter();
  _runtimeTimer = setInterval(_updateRuntimeCounter, 1000);

  // Use polling instead of SSE to avoid HTTP/1.1 connection exhaustion
  // (SSE holds a persistent connection, blocking CC and other API calls)
  startLivePolling();
}

function stopLiveStream() {
  if (liveEventSource) {
    liveEventSource.close();
    liveEventSource = null;
  }
  if (_runtimeTimer) { clearInterval(_runtimeTimer); _runtimeTimer = null; }
  stopLivePolling();
}

function startLivePolling() {
  stopLivePolling();
  refreshLiveOutput();
  livePollingInterval = setInterval(refreshLiveOutput, 3000);
}

function stopLivePolling() {
  if (livePollingInterval) { clearInterval(livePollingInterval); livePollingInterval = null; }
}

async function refreshLiveOutput() {
  if (!currentAgentId || currentTab !== 'live') { stopLivePolling(); return; }
  if (_steerInFlight) return; // Don't clobber immediate steering feedback
  try {
    const text = await safeFetch('/api/agent/' + currentAgentId + '/live?tail=16384').then(r => r.text());
    const el = document.getElementById('live-messages');
    if (el) {
      const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      const incrementalSafe = _currentAgentRuntime() !== 'copilot';
      // Incremental render: only parse new content if text is an extension of previous
      if (incrementalSafe && _lastRenderedText && text.length > _lastRenderedText.length && text.startsWith(_lastRenderedText.slice(0, 200))) {
        renderLiveChatMessage(text.slice(_lastRenderedText.length));
      } else {
        el.innerHTML = '';
        renderLiveChatMessage(text);
      }
      _lastRenderedText = text;
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
    }
  } catch (e) { console.error('live-stream reload:', e.message); }
}

async function sendSteering() {
  const input = document.getElementById('live-steer-input');
  if (!input || !input.value.trim() || !currentAgentId) return;
  const message = input.value.trim();
  input.value = '';

  // Pause polling so the immediate feedback isn't clobbered
  _steerInFlight = true;

  // Immediate feedback — show the message right away
  const el = document.getElementById('live-messages');
  if (el) {
    el.insertAdjacentHTML('beforeend', '<div style="align-self:flex-end;background:var(--blue);color:#fff;padding:6px 12px;border-radius:12px 12px 2px 12px;max-width:80%;margin:4px 0;font-size:12px">' + escHtml(message) +
      '<div id="steer-pending" style="font-size:9px;opacity:0.7;margin-top:2px">\u2197 Sending...</div></div>');
    el.scrollTop = el.scrollHeight;
  }
  showToast('cmd-toast', 'Steering message sent to ' + currentAgentId, true);

  try {
    const res = await fetch('/api/agents/steer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: currentAgentId, message })
    });
    const pending = document.getElementById('steer-pending');
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (pending) { pending.textContent = '\u26A0 Failed: ' + (d.error || 'unknown'); pending.style.opacity = '1'; }
    } else {
      if (pending) {
        pending.textContent = '\u2713 Sent — waiting for agent to respond...';
        // Poll for agent acknowledgment (new output after steering)
        let ackChecks = 0;
        const ackInterval = setInterval(async () => {
          ackChecks++;
          if (ackChecks > 30) { // Give up after 30s
            clearInterval(ackInterval);
            if (pending.textContent.includes('waiting')) pending.textContent = '\u2713 Sent — agent may respond shortly';
            return;
          }
          try {
            const liveRes = await fetch('/api/agent/' + encodeURIComponent(currentAgentId) + '/live-output');
            const text = await liveRes.text();
            // Check if there's new output after the [human-steering] line
            const steerIdx = text.lastIndexOf('[human-steering]');
            if (steerIdx >= 0) {
              const afterSteer = text.slice(steerIdx + 100);
              // Look for assistant response (JSON with type:assistant or readable text)
              if (afterSteer.length > 200 && (afterSteer.includes('"type":"assistant"') || afterSteer.includes('"type":"text"'))) {
                clearInterval(ackInterval);
                pending.textContent = '\u2713 Agent acknowledged';
                pending.style.color = 'var(--green)';
              }
            }
          } catch {}
        }, 1000);
      }
    }
  } catch (e) {
    const pending = document.getElementById('steer-pending');
    if (pending) { pending.textContent = '\u26A0 ' + e.message; pending.style.opacity = '1'; }
  } finally {
    // Resume polling — delay slightly so the [human-steering] line is in the log
    setTimeout(() => {
      _steerInFlight = false;
      refreshLiveOutput();
      // Ensure polling continues (may have stopped if tab switched during steering)
      if (!livePollingInterval && currentTab === 'live') startLivePolling();
    }, 1000);
  }
}

window.MinionsLive = { renderLiveChatMessage, startLiveStream, stopLiveStream, startLivePolling, stopLivePolling, refreshLiveOutput, sendSteering };
