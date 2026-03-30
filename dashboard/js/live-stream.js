// dashboard/js/live-stream.js — Live streaming and polling extracted from dashboard.html

let livePollingInterval = null;
let liveEventSource = null;

function renderLiveChatMessage(raw) {
  const el = document.getElementById('live-messages');
  if (!el) return;

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Human steering messages
    if (trimmed.startsWith('[human-steering]')) {
      const msg = trimmed.replace('[human-steering] ', '');
      el.innerHTML += '<div style="align-self:flex-end;background:var(--blue);color:#fff;padding:6px 12px;border-radius:12px 12px 2px 12px;max-width:80%;margin:4px 0;font-size:12px">' + escHtml(msg) + '</div>';
      continue;
    }

    // Heartbeat lines
    if (trimmed.startsWith('[heartbeat]')) {
      continue;
    }

    // Try to parse as JSON (stream-json format)
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);

        // Assistant text message
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) {
              el.innerHTML += '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 12px 2px;max-width:90%;margin:4px 0;font-size:12px;white-space:pre-wrap;word-break:break-word">' + escHtml(block.text) + '</div>';
            }
            if (block.type === 'tool_use') {
              el.innerHTML += '<div style="background:var(--surface);border:1px solid var(--border);padding:4px 8px;border-radius:4px;margin:2px 0;font-size:10px;color:var(--muted);cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'">' +
                '🔧 ' + escHtml(block.name || 'tool') + '</div>' +
                '<div style="display:none;background:var(--bg);padding:4px 8px;border-radius:4px;margin:0 0 4px;font-size:10px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:var(--muted)">' + escHtml(JSON.stringify(block.input, null, 2).slice(0, 500)) + '</div>';
            }
          }
        }

        // Tool result
        if (obj.type === 'tool_result' || (obj.type === 'user' && obj.message?.content?.[0]?.type === 'tool_result')) {
          const content = obj.message?.content?.[0]?.content || obj.content || '';
          const text = typeof content === 'string' ? content : JSON.stringify(content);
          if (text.length > 10) {
            el.innerHTML += '<div style="background:var(--bg);border-left:2px solid var(--border);padding:2px 8px;margin:0 0 2px 16px;font-size:9px;font-family:monospace;color:var(--muted);max-height:100px;overflow-y:auto;white-space:pre-wrap;cursor:pointer" onclick="this.style.maxHeight=this.style.maxHeight===\'100px\'?\'none\':\'100px\'">' + escHtml(text.slice(0, 1000)) + (text.length > 1000 ? '...' : '') + '</div>';
          }
        }

        // Result (final)
        if (obj.type === 'result') {
          el.innerHTML += '<div style="background:rgba(63,185,80,0.1);border:1px solid var(--green);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--green)">✓ Task complete</div>';
        }

        continue;
      } catch { /* JSON parse fallback */ }
    }

    // Fallback: raw text (stderr, non-JSON lines)
    if (trimmed.startsWith('[stderr]')) {
      el.innerHTML += '<div style="font-size:9px;color:var(--red);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>';
    } else {
      el.innerHTML += '<div style="font-size:10px;color:var(--muted);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>';
    }
  }

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

  liveEventSource = new EventSource('/api/agent/' + agentId + '/live-stream');

  liveEventSource.onmessage = function(e) {
    try {
      const chunk = JSON.parse(e.data);
      renderLiveChatMessage(chunk);
    } catch (e) { console.error('live-stream:', e.message); }
  };

  liveEventSource.addEventListener('done', function() {
    stopLiveStream();
    const steerBar = document.getElementById('live-steer-bar');
    if (steerBar) steerBar.style.display = 'none';
    const statusLabel = document.getElementById('live-status-label');
    if (statusLabel) { statusLabel.textContent = 'Completed'; statusLabel.style.color = 'var(--muted)'; }
  });

  liveEventSource.onerror = function() {
    // Fall back to polling on SSE error
    stopLiveStream();
    startLivePolling();
    const label = document.getElementById('live-status-label');
    if (label) label.textContent = 'Auto-refreshing every 3s';
  };
}

function stopLiveStream() {
  if (liveEventSource) {
    liveEventSource.close();
    liveEventSource = null;
  }
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
  try {
    const text = await fetch('/api/agent/' + currentAgentId + '/live?tail=16384').then(r => r.text());
    const el = document.getElementById('live-messages');
    if (el) {
      const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      el.innerHTML = '';
      renderLiveChatMessage(text);
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
    }
  } catch (e) { console.error('live-stream reload:', e.message); }
}

async function sendSteering() {
  const input = document.getElementById('live-steer-input');
  if (!input || !input.value.trim() || !currentAgentId) return;
  const message = input.value.trim();
  input.value = '';

  try {
    const res = await fetch('/api/agents/steer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: currentAgentId, message })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert('Steering failed: ' + (d.error || 'unknown'));
    }
  } catch (e) { alert('Error: ' + e.message); }
}

window.MinionsLive = { renderLiveChatMessage, startLiveStream, stopLiveStream, startLivePolling, stopLivePolling, refreshLiveOutput, sendSteering };
