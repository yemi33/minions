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
 * @param {object} [ctx] - Render context. ctx.isFinalResult flags the LAST result line
 *   before the [process-exit] sentinel — only the final result fires the banner.
 *   Intermediate result lines (one per ScheduleWakeup resume cycle) render nothing.
 *   ctx.exitInfo, when present, is { code, success } parsed from [process-exit].
 * @returns {string} HTML fragment
 */
function _renderJsonObj(obj, ctx) {
  var parts = [];

  if (obj.type === 'assistant' && obj.message && obj.message.content) {
    var content = obj.message.content;
    for (var i = 0; i < content.length; i++) {
      var block = content[i];
      if (block.type === 'thinking') {
        parts.push('<div style="font-size:10px;color:var(--muted);padding:2px 8px;font-style:italic">\u{1F4AD} Thinking...</div>');
      }
      if (block.type === 'text' && block.text) {
        parts.push('<div style="display:flex;align-items:baseline;gap:6px;margin:4px 0">' +
          '<span style="color:var(--muted);font-size:10px;flex-shrink:0">&#9679;</span>' +
          '<div style="background:var(--surface2);padding:8px 12px;border-radius:12px 12px 12px 2px;max-width:90%;font-size:12px;word-break:break-word">' + renderMd(block.text) + '</div>' +
          '</div>');
      }
      if (block.type === 'tool_use') {
        var summary = formatToolSummary(block.name || 'tool', block.input || {});
        var rawJson = escHtml(JSON.stringify(block.input || {}, null, 2).slice(0, 500));
        parts.push(
          '<div style="display:flex;align-items:center;gap:4px;margin:2px 0;font-size:10px;color:var(--muted);font-family:monospace">' +
            '<span style="flex-shrink:0">&#9679;</span>' +
            '<span>' + summary + '</span>' +
            '<span style="cursor:pointer;opacity:0.6;margin-left:4px" onclick="var t=this.parentElement.nextElementSibling;t.style.display=t.style.display===\'none\'?\'block\':\'none\';this.textContent=t.style.display===\'none\'?\'[+]\':\'[-]\'">[+]</span>' +
          '</div>' +
          '<div style="display:none;background:var(--bg);padding:4px 8px;border-radius:4px;margin:0 0 4px 16px;font-size:10px;font-family:monospace;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:var(--muted)">' + rawJson + '</div>'
        );
      }
    }
  }

  if (obj.type === 'tool_result' || (obj.type === 'user' && obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].type === 'tool_result')) {
    var tc = (obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].content) || obj.content || '';
    var text = typeof tc === 'string' ? tc : JSON.stringify(tc);
    if (text.length > 10) {
      var truncated = text.length > 3000;
      var displayText = truncated ? text.slice(0, 3000) + '...' : text;
      parts.push('<div style="background:var(--surface);border-left:2px solid var(--border);padding:2px 8px;margin:0 0 2px 16px;font-size:9px;font-family:monospace;color:var(--muted);max-height:160px;overflow-y:auto;white-space:pre-wrap;cursor:pointer" onclick="this.style.maxHeight=this.style.maxHeight===\'160px\'?\'none\':\'160px\'">' + escHtml(displayText) + '</div>');
    }
  }

  if (obj.type === 'result') {
    // Banner is gated on TWO conditions: (a) this is the LAST result line in the output,
    // and (b) the [process-exit] sentinel has been seen. Intermediate result lines from
    // ScheduleWakeup resume cycles fall through and render nothing.
    if (ctx && ctx.isFinalResult) {
      var subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
      var resultIsError = obj.is_error === true || subtype.startsWith('error');
      var exitFailed = ctx.exitInfo && ctx.exitInfo.success === false;
      if (resultIsError || exitFailed) {
        parts.push('<div style="background:rgba(248,81,73,0.1);border:1px solid var(--red);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--red)">\u2717 Task ended with error</div>');
      } else {
        parts.push('<div style="background:rgba(63,185,80,0.1);border:1px solid var(--green);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--green)">\u2713 Task complete</div>');
      }
    }
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

  // ── Pre-scan ──────────────────────────────────────────────────────────────
  // ScheduleWakeup-based polling agents emit one `"type":"result"` JSONL line
  // per resume cycle, followed by another resume — only the LAST result line
  // before spawn-agent.js writes its `[process-exit]` sentinel is the true
  // final result. Intermediate result lines must NOT trigger the banner.
  //
  // spawn-agent.js writes:
  //   "\n[process-exit] code=N\n"        on normal close (engine/spawn-agent.js:202)
  //   "\n[process-exit] spawn-failed\n"  on synchronous spawn() throw
  //
  // We pre-scan to find: (1) whether [process-exit] was emitted at all, (2) its
  // exit code (success vs failure), and (3) the line index of the last result
  // strictly before that sentinel.
  var exitInfo = null; // null = process still running (no banner ever fires)
  var exitLineIdx = -1;
  var lastResultLineIdx = -1;
  var exitRe = /^\[process-exit\]\s+(?:code=)?(-?\d+|spawn-failed)\s*$/;
  for (var k = 0; k < lines.length; k++) {
    var t = lines[k].trim();
    if (!t) continue;
    var em = exitRe.exec(t);
    if (em) {
      var token = em[1];
      var code = token === 'spawn-failed' ? -1 : parseInt(token, 10);
      exitInfo = { code: code, success: code === 0 };
      exitLineIdx = k;
    }
  }

  if (exitLineIdx !== -1) {
    for (var r = 0; r < exitLineIdx; r++) {
      var rt = lines[r].trim();
      if (!rt || rt.charCodeAt(0) !== 123 /* '{' */) continue;
      try {
        var probe = JSON.parse(rt);
        if (probe && probe.type === 'result') lastResultLineIdx = r;
      } catch (e) { /* ignore parse errors during scan */ }
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Heartbeat — filter out
    if (trimmed.startsWith('[heartbeat]')) continue;

    // Process-exit sentinel — internal signal, never displayed
    if (trimmed.startsWith('[process-exit]')) continue;

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

    // JSON array line — never holds the canonical result, banner never fires here
    if (trimmed.startsWith('[')) {
      try {
        var arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          for (var j = 0; j < arr.length; j++) fragments.push(_renderJsonObj(arr[j], null));
          continue;
        }
      } catch (e) { /* fall through */ }
    }

    // JSON object line — banner fires only when this is the final result AND process exited
    if (trimmed.startsWith('{')) {
      try {
        var parsed = JSON.parse(trimmed);
        var isFinalResult = (i === lastResultLineIdx) && (exitInfo !== null);
        fragments.push(_renderJsonObj(parsed, { isFinalResult: isFinalResult, exitInfo: exitInfo }));
        continue;
      } catch (e) { /* fall through */ }
    }

    // Stderr
    if (trimmed.startsWith('[stderr]')) {
      fragments.push('<div style="font-size:9px;color:var(--red);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>');
    } else {
      // Plain text fallback
      fragments.push('<div style="font-size:10px;color:var(--muted);font-family:monospace;padding:1px 4px">' + escHtml(trimmed) + '</div>');
    }
  }

  // Fallback error banner: process exited with non-zero code but never emitted
  // a `"type":"result"` line (CLI crashed before producing one). Without this,
  // the user would see only stderr noise with no terminal-state indicator.
  if (exitInfo && !exitInfo.success && lastResultLineIdx === -1) {
    fragments.push('<div style="background:rgba(248,81,73,0.1);border:1px solid var(--red);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px;color:var(--red)">✗ Task ended with error</div>');
  }

  return fragments.join('');
}

window.MinionsRenderUtils = { formatToolSummary, renderAgentOutput };
