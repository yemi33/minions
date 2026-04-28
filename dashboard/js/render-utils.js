// dashboard/js/render-utils.js — Shared formatting helpers for agent output rendering
// Depends on: escHtml() and renderMd() from utils.js (loaded before this file)

/**
 * Returns a one-line human-readable summary for a Claude tool call.
 * @param {string} name - Tool name (e.g. 'Bash', 'Read', 'Edit')
 * @param {object} input - Tool input object
 * @returns {string} Human-readable summary (HTML-escaped)
 */
function formatToolSummary(name, input) {
  var inp = input || {};
  switch (name) {
    case 'Bash': {
      var cmd = String(inp.command || '');
      if (cmd.length > 80) cmd = cmd.slice(0, 77) + '...';
      return '$ ' + escHtml(cmd);
    }
    case 'Read':
      return 'Reading ' + escHtml(inp.file_path || '');
    case 'Edit':
      return 'Editing ' + escHtml(inp.file_path || '');
    case 'Write':
      return 'Writing ' + escHtml(inp.file_path || '');
    case 'Grep': {
      var pat = escHtml(inp.pattern || '');
      var gPath = escHtml(inp.path || '.');
      return 'Searching `' + pat + '` in ' + gPath;
    }
    case 'Glob':
      return 'Glob ' + escHtml(inp.pattern || '');
    case 'Agent':
      return 'Spawning agent: ' + escHtml(inp.description || '');
    case 'WebFetch':
      return 'Fetch ' + escHtml(inp.url || '');
    case 'WebSearch':
      return 'Search "' + escHtml(inp.query || '') + '"';
    case 'TodoWrite': {
      var items = Array.isArray(inp.todos) ? inp.todos : [];
      return 'Update todos (' + items.length + ' items)';
    }
    default: {
      var keys = Object.keys(inp);
      if (keys.length === 0) return escHtml(name) + '()';
      var firstKey = keys[0];
      var firstVal = String(inp[firstKey] || '');
      if (firstVal.length > 40) firstVal = firstVal.slice(0, 37) + '...';
      return escHtml(name) + '(' + escHtml(firstKey) + ': ' + escHtml(firstVal) + ')';
    }
  }
}

/**
 * Internal helper: renders a single parsed JSON object into an HTML fragment.
 * @param {object} obj - Parsed JSON object from agent JSONL output
 * @returns {string} HTML fragment
 */
function _renderJsonObj(obj, state) {
  state = state || {};
  var parts = [];
  if (!(state.copilotToolKeys instanceof Set)) state.copilotToolKeys = new Set();
  if (typeof state.copilotDeltaBuffer !== 'string') state.copilotDeltaBuffer = '';
  if (typeof state.copilotReasoningPending !== 'boolean') state.copilotReasoningPending = false;

  function assistantBubbleHtml(text) {
    return '<div style="display:flex;align-items:baseline;gap:6px;margin:4px 0">' +
      '<span style="color:var(--muted);font-size:10px;flex-shrink:0">&#9679;</span>' +
      '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 12px 2px;max-width:90%;font-size:12px;word-break:break-word">' + renderMd(text) + '</div>' +
      '</div>';
  }
  function toolUseHtml(name, input) {
    var summary = formatToolSummary(name || 'tool', input || {});
    var rawJson = escHtml(JSON.stringify(input || {}, null, 2).slice(0, 500));
    return '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;font-size:10px;color:var(--muted);font-family:monospace">' +
        '<span style="flex-shrink:0">&#9679;</span>' +
        '<span>' + summary + '</span>' +
        '<span style="cursor:pointer;opacity:0.6;margin-left:4px" onclick="var t=this.parentElement.nextElementSibling;t.style.display=t.style.display===\'none\'?\'block\':\'none\';this.textContent=t.style.display===\'none\'?\'[+]\':\'[-]\'">[+]</span>' +
      '</div>' +
      '<div style="display:none;background:var(--bg);padding:4px 8px;border-radius:4px;margin:0 0 4px 16px;font-size:10px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:var(--muted)">' + rawJson + '</div>';
  }
  function toolResultHtml(text) {
    if (!text || text.length <= 10) return '';
    var truncated = text.length > 3000;
    var displayText = truncated ? text.slice(0, 3000) + '...' : text;
    return '<div style="background:var(--surface);border-left:2px solid var(--border);padding:2px 8px;margin:0 0 2px 16px;font-size:9px;font-family:monospace;color:var(--muted);max-height:160px;overflow-y:auto;white-space:pre-wrap;cursor:pointer" onclick="this.style.maxHeight=this.style.maxHeight===\'160px\'?\'none\':\'160px\'">' + escHtml(displayText) + '</div>';
  }
  function toolKey(name, input) {
    try { return String(name || 'tool') + '|' + JSON.stringify(input || {}); }
    catch { return String(name || 'tool'); }
  }

  if (obj.type === 'assistant' && obj.message && obj.message.content) {
    var content = obj.message.content;
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (block.type === 'thinking') {
        parts.push('<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>');
      }
      if (block.type === 'text' && block.text) {
        parts.push(assistantBubbleHtml(block.text));
      }
      if (block.type === 'tool_use') {
        parts.push(toolUseHtml(block.name, block.input));
      }
    }
  }

  if (obj.type === 'tool_result' || (obj.type === 'user' && obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].type === 'tool_result')) {
    var tc = (obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].content) || obj.content || '';
    var text = typeof tc === 'string' ? tc : JSON.stringify(tc);
    parts.push(toolResultHtml(text));
  }

  if (obj.type === 'assistant.reasoning' || obj.type === 'assistant.reasoning_delta') {
    state.copilotReasoningPending = true;
  }

  if (obj.type === 'assistant.message_delta' && typeof obj.data?.deltaContent === 'string') {
    if (state.copilotReasoningPending) {
      parts.push('<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>');
      state.copilotReasoningPending = false;
    }
    state.copilotDeltaBuffer += obj.data.deltaContent;
  }

  if (obj.type === 'assistant.message') {
    if (state.copilotReasoningPending) {
      parts.push('<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>');
      state.copilotReasoningPending = false;
    }
    state.copilotDeltaBuffer = '';
    if (typeof obj.data?.content === 'string' && obj.data.content) {
      parts.push(assistantBubbleHtml(obj.data.content));
    }
    var toolRequests = Array.isArray(obj.data?.toolRequests) ? obj.data.toolRequests : [];
    for (var trIdx = 0; trIdx < toolRequests.length; trIdx++) {
      var tr = toolRequests[trIdx];
      if (!tr || !tr.name) continue;
      var trInput = tr.arguments || {};
      var trKey = toolKey(tr.name, trInput);
      if (state.copilotToolKeys.has(trKey)) continue;
      state.copilotToolKeys.add(trKey);
      parts.push(toolUseHtml(tr.name, trInput));
    }
  }

  if (obj.type === 'tool.execution_start' && obj.data?.toolName) {
    var startInput = obj.data.arguments || {};
    var startKey = toolKey(obj.data.toolName, startInput);
    if (!state.copilotToolKeys.has(startKey)) {
      state.copilotToolKeys.add(startKey);
      parts.push(toolUseHtml(obj.data.toolName, startInput));
    }
  }

  if (obj.type === 'tool.execution_complete') {
    var resultData = obj.data?.result;
    var resultText = resultData?.content || resultData?.detailedContent || '';
    if (!resultText && resultData && typeof resultData !== 'string') resultText = JSON.stringify(resultData);
    if (!resultText && obj.data?.success === false) resultText = 'Tool failed';
    parts.push(toolResultHtml(typeof resultText === 'string' ? resultText : String(resultText || '')));
  }

  if (obj.type === 'result') {
    parts.push('<div style="background:rgba(63,185,80,0.1);border:1px solid var(--green);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--green)">\u2713 Task complete</div>');
  }

  return parts.join('');
}

/**
 * Takes raw JSONL agent output text and returns an HTML string with formatted rendering.
 * Parses JSON objects, tool summaries with ● prefix and [+] toggles for raw JSON,
 * tool results with surface tint and 160px max-height, assistant text with ● prefix
 * and markdown rendering, steering bubbles with ❯ prefix, completion indicator,
 * stderr lines, and heartbeat filtering.
 *
 * @param {string} text - Raw JSONL agent output
 * @returns {string} HTML string
 */
function renderAgentOutput(text) {
  if (!text) return '';
  var fragments = [];
  var lines = text.split('\n');
  var state = { copilotDeltaBuffer: '', copilotToolKeys: new Set(), copilotReasoningPending: false };

  function flushCopilotPending() {
    if (state.copilotReasoningPending) {
      fragments.push('<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>');
      state.copilotReasoningPending = false;
    }
    if (state.copilotDeltaBuffer) {
      fragments.push('<div style="display:flex;align-items:baseline;gap:6px;margin:4px 0">' +
        '<span style="color:var(--muted);font-size:10px;flex-shrink:0">&#9679;</span>' +
        '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 12px 2px;max-width:90%;font-size:12px;word-break:break-word">' + renderMd(state.copilotDeltaBuffer) + '</div>' +
        '</div>');
      state.copilotDeltaBuffer = '';
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Heartbeat — filter out
    if (trimmed.startsWith('[heartbeat]')) continue;

    // Human steering
    if (trimmed.startsWith('[human-steering]')) {
      var msg = trimmed.replace('[human-steering] ', '');
      fragments.push('<div style="align-self:flex-end;background:var(--blue);color:#fff;padding:6px 12px;border-radius:12px 12px 2px 12px;max-width:80%;margin:4px 0;font-size:12px">' +
        '<span style="margin-right:4px">❯</span>' + escHtml(msg) +
        '<div style="font-size:9px;opacity:0.7;margin-top:2px">\u2713 Queued</div></div>');
      continue;
    }

    // Steering failed
    if (trimmed.startsWith('[steering-failed]')) {
      var failMsg = trimmed.replace('[steering-failed] ', '');
      fragments.push('<div style="background:rgba(248,81,73,0.1);border:1px solid var(--red);color:var(--red);padding:6px 12px;border-radius:8px;margin:4px 0;font-size:11px">\u26A0 ' + escHtml(failMsg) + '</div>');
      continue;
    }

    // JSON array line
    if (trimmed.startsWith('[')) {
      try {
        var arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          for (var j = 0; j < arr.length; j++) fragments.push(_renderJsonObj(arr[j], state));
          continue;
        }
      } catch (e) { /* fall through */ }
    }

    // JSON object line
    if (trimmed.startsWith('{')) {
      try {
        var obj = JSON.parse(trimmed);
        if (obj.type !== 'assistant.message_delta' && obj.type !== 'assistant.reasoning' && obj.type !== 'assistant.reasoning_delta' && obj.type !== 'assistant.message') {
          flushCopilotPending();
        }
        fragments.push(_renderJsonObj(obj, state));
        continue;
      } catch (e) { /* fall through */ }
    }

    flushCopilotPending();

    // Stderr
    if (trimmed.startsWith('[stderr]')) {
      fragments.push('<div style="font-size:9px;color:var(--red);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>');
    } else {
      // Plain text fallback
      fragments.push('<div style="font-size:10px;color:var(--muted);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>');
    }
  }

  flushCopilotPending();
  return fragments.join('');
}

window.MinionsRenderUtils = { formatToolSummary, renderAgentOutput };
