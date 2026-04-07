// dashboard/js/live-stream.js — Live streaming and polling extracted from dashboard.html

let livePollingInterval = null;
let liveEventSource = null;
let _steerInFlight = false;

function renderLiveChatMessage(raw) {
  const el = document.getElementById('live-messages');
  if (!el) return;

  function renderJsonObj(obj) {
    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'thinking') {
          el.innerHTML += '<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>';
        }
        if (block.type === 'text' && block.text) {
          el.innerHTML += '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 12px 2px;max-width:90%;margin:4px 0;font-size:12px;word-break:break-word">' + renderMd(block.text) + '</div>';
        }
        if (block.type === 'tool_use') {
          el.innerHTML += '<div style="background:var(--surface);border:1px solid var(--border);padding:4px 8px;border-radius:4px;margin:2px 0;font-size:10px;color:var(--muted);cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'">' +
            '\u{1F527} ' + escHtml(block.name || 'tool') + '</div>' +
            '<div style="display:none;background:var(--bg);padding:4px 8px;border-radius:4px;margin:0 0 4px;font-size:10px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:var(--muted)">' + escHtml(JSON.stringify(block.input || {}, null, 2).slice(0, 500)) + '</div>';
        }
      }
    }
    if (obj.type === 'tool_result' || (obj.type === 'user' && obj.message?.content?.[0]?.type === 'tool_result')) {
      const content = obj.message?.content?.[0]?.content || obj.content || '';
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      if (text.length > 10) {
        el.innerHTML += '<div style="background:var(--bg);border-left:2px solid var(--border);padding:2px 8px;margin:0 0 2px 16px;font-size:9px;font-family:monospace;color:var(--muted);max-height:100px;overflow-y:auto;white-space:pre-wrap;cursor:pointer" onclick="this.style.maxHeight=this.style.maxHeight===\'100px\'?\'none\':\'100px\'">' + escHtml(text.slice(0, 1000)) + (text.length > 1000 ? '...' : '') + '</div>';
      }
    }
    if (obj.type === 'result') {
      el.innerHTML += '<div style="background:rgba(63,185,80,0.1);border:1px solid var(--green);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--green)">\u2713 Task complete</div>';
    }
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Human steering messages
    if (trimmed.startsWith('[human-steering]')) {
      const msg = trimmed.replace('[human-steering] ', '');
      el.innerHTML += '<div style="align-self:flex-end;background:var(--blue);color:#fff;padding:6px 12px;border-radius:12px 12px 2px 12px;max-width:80%;margin:4px 0;font-size:12px">' + escHtml(msg) +
        '<div style="font-size:9px;opacity:0.7;margin-top:2px">\u2713 Queued</div></div>';
      continue;
    }

    // Heartbeat lines
    if (trimmed.startsWith('[heartbeat]')) {
      continue;
    }

    // JSON array format (--output-format json)
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) { for (const obj of arr) renderJsonObj(obj); continue; }
      } catch { /* fall through to raw text */ }
    }

    // Single JSON object (--output-format stream-json)
    if (trimmed.startsWith('{')) {
      try { renderJsonObj(JSON.parse(trimmed)); continue; } catch { /* fall through */ }
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

  // Use polling instead of SSE to avoid HTTP/1.1 connection exhaustion
  // (SSE holds a persistent connection, blocking CC and other API calls)
  startLivePolling();
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
  if (_steerInFlight) return; // Don't clobber immediate steering feedback
  try {
    const text = await safeFetch('/api/agent/' + currentAgentId + '/live?tail=16384').then(r => r.text());
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

  // Pause polling so the immediate feedback isn't clobbered
  _steerInFlight = true;

  // Immediate feedback — show the message right away
  const el = document.getElementById('live-messages');
  if (el) {
    el.innerHTML += '<div style="align-self:flex-end;background:var(--blue);color:#fff;padding:6px 12px;border-radius:12px 12px 2px 12px;max-width:80%;margin:4px 0;font-size:12px">' + escHtml(message) +
      '<div id="steer-pending" style="font-size:9px;opacity:0.7;margin-top:2px">Sending...</div></div>';
    el.scrollTop = el.scrollHeight;
  }

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
    setTimeout(() => { _steerInFlight = false; refreshLiveOutput(); }, 500);
  }
}

window.MinionsLive = { renderLiveChatMessage, startLiveStream, stopLiveStream, startLivePolling, stopLivePolling, refreshLiveOutput, sendSteering };
