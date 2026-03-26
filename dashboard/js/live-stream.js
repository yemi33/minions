// dashboard/js/live-stream.js — Live streaming and polling extracted from dashboard.html

let livePollingInterval = null;
let liveEventSource = null;

function startLiveStream(agentId) {
  stopLiveStream();
  if (!agentId) return;

  const outputEl = document.getElementById('live-output');
  if (outputEl) outputEl.textContent = '';

  liveEventSource = new EventSource('/api/agent/' + agentId + '/live-stream');

  liveEventSource.onmessage = function(e) {
    try {
      const chunk = JSON.parse(e.data);
      const el = document.getElementById('live-output');
      if (el) {
        const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        el.textContent += chunk;
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
      }
    } catch {}
  };

  liveEventSource.addEventListener('done', function() {
    stopLiveStream();
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
    const el = document.getElementById('live-output');
    if (el) {
      const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      el.textContent = text;
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
    }
  } catch {}
}
