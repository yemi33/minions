/**
 * engine/timeout.js — Timeout detection, steering, and idle threshold checks.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeRead, safeWrite, safeJson, mutateJsonFileLocked, getProjects, projectWorkItemsPath, log, ts,
  ENGINE_DEFAULTS, WI_STATUS, WORK_TYPE, DISPATCH_RESULT, AGENT_STATUS } = shared;
const { getDispatch, getAgentStatus } = queries;
const AGENTS_DIR = queries.AGENTS_DIR;
const MINIONS_DIR = shared.MINIONS_DIR;

// Lazy require to break circular dependency with engine.js
// Only needed for engine().activeProcesses and engine().engineRestartGraceUntil — log/ts come from shared.js
let _engine = null;
function engine() { if (!_engine) _engine = require('../engine'); return _engine; }

// Lazy require for dispatch module (also circular via engine)
let _dispatch = null;
function dispatch() { if (!_dispatch) _dispatch = require('./dispatch'); return _dispatch; }

// ─── Idle Alert State ────────────────────────────────────────────────────────

let _lastActivityTime = Date.now();
let _idleAlertSent = false;

// ─── Idle Threshold Check ────────────────────────────────────────────────────

function checkIdleThreshold(config) {
  const { isAgentIdle } = require('./routing');
  const thresholdMs = (config.engine?.idleAlertMinutes || 15) * 60 * 1000;
  const agents = Object.keys(config.agents || {});
  const allIdle = agents.every(id => isAgentIdle(id));
  const dispatchData = getDispatch();
  const hasPending = (dispatchData.pending || []).length > 0;

  if (!allIdle || hasPending) {
    _lastActivityTime = Date.now();
    _idleAlertSent = false;
    return;
  }

  const idleMs = Date.now() - _lastActivityTime;
  if (idleMs > thresholdMs && !_idleAlertSent) {
    const mins = Math.round(idleMs / 60000);
    log('warn', `All agents idle for ${mins} minutes — no work sources producing items`);
    _idleAlertSent = true;
  }
}

// ─── Steering Checker ────────────────────────────────────────────────────────

// How long to wait for a steered agent to exit before retrying the kill
const STEERING_KILL_RETRY_MS = 30000;

function checkSteering(config) {
  const activeProcesses = engine().activeProcesses;
  for (const [id, info] of activeProcesses) {
    // Recovery: if steering kill hasn't resulted in process exit within 30s, force-retry.
    // This catches cases where killImmediate silently failed (e.g., orphaned subprocess
    // on Unix where SIGKILL only hit spawn-agent.js, not the Claude CLI tree).
    if (info._steeringAt && Date.now() - info._steeringAt > STEERING_KILL_RETRY_MS) {
      if (!info._steeringRetried) {
        log('warn', `Steering: ${info.agentId} (${id}) didn't exit ${STEERING_KILL_RETRY_MS / 1000}s after kill — retrying`);
        shared.killImmediate(info.proc);
        // On Unix, also try to kill children that may have been orphaned
        if (process.platform !== 'win32' && info.proc?.pid) {
          try { shared.exec(`pkill -KILL -P ${info.proc.pid}`, { timeout: 3000 }); } catch { /* children may already be dead */ }
        }
        info._steeringRetried = true;
      }
      continue;
    }

    // Skip if already being steered (prevents double-kill race)
    if (info._steeringMessage || info._steeringAt) continue;

    const steerPath = path.join(AGENTS_DIR, info.agentId, 'steer.md');
    let steerMtime;
    try { steerMtime = fs.statSync(steerPath).mtimeMs; } catch { continue; } // ENOENT = no steering message

    // Read and consume the message immediately — always delete to prevent stale messages
    const message = safeRead(steerPath);
    try { fs.unlinkSync(steerPath); } catch { /* cleanup */ }
    if (!message) continue;

    const sessionId = info.sessionId;
    if (!sessionId) {
      // No session to resume — kill agent and deliver message via inbox for retry.
      // Previously this silently skipped for up to 5m then deleted the message (#627).
      log('info', `Steering: no sessionId for ${info.agentId} (${id}) — killing and forwarding message to inbox`);

      // Write steering message to agent inbox so it survives the retry
      const inboxDir = path.join(AGENTS_DIR, info.agentId, 'inbox');
      try { fs.mkdirSync(inboxDir, { recursive: true }); } catch {}
      safeWrite(path.join(inboxDir, `steering-${Date.now()}.md`), `# Steering Message (Forwarded)\n\nOriginal steering from human:\n\n${message}\n`);

      // Append to live output so user sees confirmation in the dashboard
      try {
        const liveLogPath = path.join(AGENTS_DIR, info.agentId, 'live-output.log');
        fs.appendFileSync(liveLogPath, `\n[steering] Message received but no session to resume. Killing agent — your message will be delivered on retry.\n`);
      } catch { /* optional */ }

      shared.killImmediate(info.proc);
      info._steeringAt = Date.now();
      info._steeringNoSession = true;
      continue;
    }

    log('info', `Steering: killing ${info.agentId} (${id}) for session resume with human message`);

    // Set steering state BEFORE kill — close event may fire synchronously on some platforms
    info._steeringMessage = message;
    info._steeringSessionId = sessionId;
    info._steeringAt = Date.now();

    shared.killImmediate(info.proc);
  }
}

// ─── Timeout Checker ─────────────────────────────────────────────────────────

function checkTimeouts(config) {
  const activeProcesses = engine().activeProcesses;
  const engineRestartGraceUntil = engine().engineRestartGraceUntil;
  const engineRestartGraceExempt = engine().engineRestartGraceExempt;
  const { completeDispatch } = dispatch();
  const { runPostCompletionHooks } = require('./lifecycle');

  const timeout = config.engine?.agentTimeout || ENGINE_DEFAULTS.agentTimeout;
  const defaultHeartbeatTimeout = config.engine?.heartbeatTimeout || ENGINE_DEFAULTS.heartbeatTimeout;

  // Per-type heartbeat timeouts: merge ENGINE_DEFAULTS ← config overrides
  const perTypeTimeouts = { ...ENGINE_DEFAULTS.heartbeatTimeouts, ...(config.engine?.heartbeatTimeouts || {}) };

  // 1. Check tracked processes for hard timeout (supports per-item deadline from fan-out)
  for (const [id, info] of activeProcesses.entries()) {
    const itemTimeout = info.meta?.deadline ? Math.max(0, info.meta.deadline - new Date(info.startedAt).getTime()) : timeout;
    const elapsed = Date.now() - new Date(info.startedAt).getTime();
    if (elapsed > itemTimeout) {
      log('warn', `Agent ${info.agentId} (${id}) hit hard timeout after ${Math.round(elapsed / 1000)}s — killing`);
      dispatch().updateAgentStatus(id, AGENT_STATUS.TIMED_OUT, `Hard timeout after ${Math.round(elapsed / 1000)}s`);
      shared.killGracefully(info.proc, 5000);
    }
  }

  // 2. Heartbeat check — for ALL active dispatch items (catches orphans after engine restart)
  //    Uses live-output.log mtime as heartbeat. If no output for heartbeatTimeout, agent is dead.
  const dispatchData = getDispatch();
  const deadItems = [];
  const blockingAnnotations = new Map(); // id → { tool, silentMs, remainingMs } or null (clear)

  for (const item of (dispatchData.active || [])) {
    if (!item.agent) continue;

    // Per-type heartbeat: look up work type from dispatch item, fall back to default
    const workType = item.workType || item.meta?.item?.type;
    const heartbeatTimeout = (workType && perTypeTimeouts[workType]) || defaultHeartbeatTimeout;

    const hasProcess = activeProcesses.has(item.id);
    const liveLogPath = path.join(AGENTS_DIR, item.agent, 'live-output.log');
    let lastActivity = item.started_at ? new Date(item.started_at).getTime() : 0;

    // For tracked processes, use realActivityMap (tracks actual agent stdout/stderr only,
    // NOT engine heartbeat writes). This prevents the feedback loop where engine heartbeat
    // writes to live-output.log reset the mtime that the timeout check reads (#724).
    const realActivityMap = engine().realActivityMap;
    if (hasProcess && realActivityMap?.has(item.id)) {
      lastActivity = Math.max(lastActivity, realActivityMap.get(item.id));
    } else {
      // Orphan case (no tracked process): use live-output.log mtime as fallback.
      // No heartbeat timer is running for orphans, so mtime is accurate.
      try {
        const stat = fs.statSync(liveLogPath);
        lastActivity = Math.max(lastActivity, stat.mtimeMs);
      } catch { /* optional */ }
    }

    const silentMs = Date.now() - lastActivity;
    const silentSec = Math.round(silentMs / 1000);

    // Check if the agent actually completed by looking for the [process-exit] sentinel.
    //
    // The sentinel is written synchronously by spawn-agent.js's proc.on('close') handler
    // BEFORE spawn-agent itself exits, in the form:
    //   "\n[process-exit] code=<N>\n"        — normal exit (any exit code)
    //   "\n[process-exit] spawn-failed\n"    — synchronous spawn() throw before runFile returned
    //
    // This sentinel is the single source of truth for "process is gone" + "what was the
    // exit code". We rely on the actual exit code — NOT a "subtype":"success" substring
    // match — to decide success/error. Substring-matching `subtype:"success"` was the
    // false-positive vector for #1792: a resumed --resume turn emits subtype:"success"
    // even when the agent did no real work, while the OS exit code can still be 1, so
    // the dispatch was being marked SUCCESS for a no-op resumed session. Exit code from
    // the [process-exit] sentinel reflects what the OS actually reported.
    //
    // We tail 64KB — process-exit is always the last non-empty line of the file.
    // No time cap: a stuck dispatch whose process has exited must always be detected (#716).
    let completedViaOutput = false;
    try {
      let liveLogTail;
      try {
        const fd = fs.openSync(liveLogPath, 'r');
        try {
          const stat = fs.fstatSync(fd);
          const TAIL_SIZE = 65536; // 64KB
          const tailSize = Math.min(stat.size, TAIL_SIZE);
          const buf = Buffer.alloc(tailSize);
          fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
          liveLogTail = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch { /* ENOENT or read failure — liveLogTail stays undefined */ }

      // Parse the LAST [process-exit] sentinel — code=N or "spawn-failed".
      // Use the global regex with a manual loop so we always pick up the latest occurrence,
      // not the first (defends against logs that somehow contain stale sentinel lines).
      let processExited = false;
      let processExitCode = null;
      if (liveLogTail) {
        const exitPattern = /\n\[process-exit\]\s+(?:code=)?(-?\d+|spawn-failed)/g;
        let lastMatch = null;
        let m;
        while ((m = exitPattern.exec(liveLogTail)) !== null) lastMatch = m;
        if (lastMatch) {
          processExited = true;
          processExitCode = lastMatch[1] === 'spawn-failed' ? -1 : parseInt(lastMatch[1], 10);
        }
      }

      if (processExited) {
        completedViaOutput = true;
        const isSuccess = processExitCode === 0;
        log('info', `Agent ${item.agent} (${item.id}) completed via output detection (exit code ${processExitCode}, ${isSuccess ? 'success' : 'error'})`);

        // Extract output text for the output.log — read full file for complete parsing
        const outputLogPath = path.join(AGENTS_DIR, item.agent, 'output.log');
        try {
          const fullLog = safeRead(liveLogPath) || liveLogTail;
          const { text } = shared.parseStreamJsonOutput(fullLog);
          safeWrite(outputLogPath, `# Output for dispatch ${item.id}\n# Exit code: ${processExitCode}\n# Completed: ${ts()}\n# Detected via output scan\n\n## Result\n${text || '(no text)'}\n`);
        } catch (e) { log('warn', 'parse output result: ' + e.message); }

        completeDispatch(item.id, isSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR,
          isSuccess ? 'Completed (detected from output)' : `Exited with code ${processExitCode} (detected from output)`);

        // Run post-completion hooks via shared helper (async — fire and forget in timeout context).
        // Pass the actual exit code so autoRecovery (PR-created-but-failed) still works correctly.
        const fullLogForHooks = safeRead(liveLogPath) || liveLogTail;
        runPostCompletionHooks(item, item.agent, processExitCode, fullLogForHooks, config).catch(e => log('warn', 'post-completion hooks: ' + e.message));

        if (hasProcess) {
          shared.killImmediate(activeProcesses.get(item.id)?.proc);
          activeProcesses.delete(item.id);
        }
        continue; // Skip orphan/hung detection — we handled it
      }
      // Note: we DO NOT trigger on `"type":"result"` alone. There is a ~1s race between
      // claude CLI emitting the result event and spawn-agent.js writing [process-exit] —
      // engine.js's onAgentClose handler fires within that window for tracked processes
      // and handles completion correctly. Triggering on result-event here would race the
      // close handler and risk marking SUCCESS based on subtype before the actual exit
      // code is known (#1792).
    } catch (e) { log('warn', 'output completion detection: ' + e.message); }

    // Resolve per-type heartbeat timeout: per-type map → base heartbeatTimeout fallback
    const itemHeartbeat = perTypeTimeouts[item.type] || heartbeatTimeout;

    // Check if agent is in a blocking tool call (TaskOutput block:true, Bash with long timeout, etc.)
    // These tools produce no stdout for extended periods — don't kill them prematurely
    // Check for BOTH tracked and untracked processes (orphan case after engine restart)
    // Skip if agent already completed — blocking tool detection on stale tool calls
    // would extend the timeout indefinitely for dead agents (#716).
    let isBlocking = false;
    let blockingTimeout = itemHeartbeat;
    let blockingTool = '';
    if (silentMs > itemHeartbeat) {
      try {
        const liveLog = safeRead(liveLogPath);
        if (liveLog) {
          // If the output contains a result event or process-exit sentinel, the agent is done.
          // Don't extend timeout for stale blocking tool calls from before the result (#716).
          if (liveLog.includes('"type":"result"') || liveLog.includes('\n[process-exit]')) {
            // Agent completed but close event didn't fire — let orphan/hung detection handle it.
            // Don't set isBlocking — use base heartbeat timeout.
          } else {
          // Find the last tool_use call in the output — check if it's a known blocking tool.
          //
          // Lookback depth (1000 lines) is sized for the heartbeat-noise scenario from #1792:
          // a long-running Monitor / Bash / PowerShell call goes silent for 15+ minutes while
          // a cold Gradle build runs. During that silence the ENGINE writes a heartbeat line
          // every 30s (engine.js heartbeatTimer), so the live log accumulates ~120 heartbeat
          // lines per hour AFTER the original tool_use line. A 30-line lookback misses the
          // tool_use entirely, the detector treats the silence as non-blocking, and the
          // agent gets killed at heartbeatTimeout despite legitimately waiting on a
          // background process. 1000 lines covers ~8 hours of pure heartbeat noise — well
          // beyond Monitor's 30 min effective timeout floor.
          const lines = liveLog.split('\n');
          const TOOL_USE_LOOKBACK = 1000;
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - TOOL_USE_LOOKBACK); i--) {
            const line = lines[i];
            if (!line.includes('"tool_use"')) continue;
            try {
              const parsed = JSON.parse(line);
              const toolUse = parsed?.message?.content?.find?.(c => c.type === 'tool_use');
              if (!toolUse) continue;
              const input = toolUse.input || {};
              const name = toolUse.name || '';
              // TaskOutput with block:true — waiting for a background task
              if (name === 'TaskOutput' && input.block === true) {
                const taskTimeout = input.timeout || 600000; // default 10min
                blockingTimeout = Math.max(itemHeartbeat, taskTimeout + 60000); // task timeout + 1min grace
                isBlocking = true;
                blockingTool = 'TaskOutput';
              }
              // Bash tool call — may be running a long build/install with no stdout
              if (name === 'Bash') {
                // Use explicit timeout if set, otherwise match Claude Code's actual Bash default (120s)
                const bashTimeout = input.timeout || 120000;
                blockingTimeout = Math.max(itemHeartbeat, bashTimeout + 60000);
                isBlocking = true;
                blockingTool = 'Bash';
              }
              // PowerShell tool call — Windows-native shell with same explicit-timeout
              // semantics as Bash (input.timeout, max 600s). Required for projects that
              // build via PowerShell on Windows (gradlew.bat, MSBuild, dotnet test) where
              // the cold-start phase produces no stdout for several minutes (#1786).
              if (name === 'PowerShell') {
                const psTimeout = input.timeout || 120000;
                blockingTimeout = Math.max(itemHeartbeat, psTimeout + 60000);
                isBlocking = true;
                blockingTool = 'PowerShell';
              }
              // Monitor tool call — blocks waiting for stdout-line notifications from a
              // background process started via Bash with run_in_background. Between
              // notifications the call produces no output, so the heartbeat monitor
              // must extend timeout. No fixed timeout on Monitor — match Agent (30min)
              // since both are inherently long-running waits (#1786).
              if (name === 'Monitor') {
                blockingTimeout = Math.max(itemHeartbeat, 1800000); // 30min for background process waits
                isBlocking = true;
                blockingTool = 'Monitor';
              }
              // Agent (subagent) tool call — parent waits silently for child to complete
              if (name === 'Agent') {
                blockingTimeout = Math.max(itemHeartbeat, 1800000); // 30min for subagents
                isBlocking = true;
                blockingTool = 'Agent';
              }
              break; // only check the most recent tool_use
            } catch { /* JSON parse — line may not be valid JSON */ }
          }
          if (isBlocking) {
            // Only log on transition — avoid spamming every tick while blocking persists
            if (!item._blockingToolCall) {
              log('info', `Agent ${item.agent} (${item.id}) is in a blocking tool call (${blockingTool}) — extended timeout to ${Math.round(blockingTimeout / 1000)}s (silent for ${silentSec}s)`, { event: 'blocking_tool_call_detected' });
            }
            blockingAnnotations.set(item.id, {
              tool: blockingTool,
              silentMs,
              remainingMs: Math.max(0, blockingTimeout - silentMs),
            });
          }
          } // close else
        } // close if (liveLog)
      } catch (e) { log('warn', 'blocking tool detection: ' + e.message); }
    }
    // Agent recovered from blocking state — clear annotation
    if (!isBlocking && item._blockingToolCall) {
      blockingAnnotations.set(item.id, null);
    }

    const effectiveTimeout = isBlocking ? blockingTimeout : itemHeartbeat;

    // Skip recently-steered agents — they're being killed and re-spawned
    const procInfo = activeProcesses.get(item.id);
    if (procInfo?._steeringAt && Date.now() - procInfo._steeringAt < 60000) continue;

    // Capture live-output.log file state for orphan/hung diagnostics
    // (#W-mo248lkjwgsu original, #W-mo25loq8kjer pid annotation).
    // Four distinguishable failure modes:
    //   logExists=false                         → spawn call itself threw, no log ever written
    //   logExists=true pidPresent=false         → engine stub written but spawn died before emitting pid line
    //   logExists=true pidPresent=true silent   → process spawned (pid recorded) but never produced stdout
    //   logExists=true pidPresent=true size>pid → genuine hang (process wrote output then stopped)
    //
    // The pid line `[<iso>] pid: <N>` is stamped by engine.js immediately after runFile() returns.
    // Its presence → the child process was actually spawned; absence → spawn itself failed or the
    // appendFileSync on the pid line threw (rare).
    let _logState = 'logExists=false logSize=0 pidPresent=false';
    try {
      const lst = fs.statSync(liveLogPath);
      // Read only the head (4KB) — pid line is written right after the stub, always near the top.
      // Avoids loading the full log just for a diagnostic annotation.
      let pidPresent = false;
      try {
        const fd = fs.openSync(liveLogPath, 'r');
        const headSize = Math.min(lst.size, 4096);
        const headBuf = Buffer.alloc(headSize);
        fs.readSync(fd, headBuf, 0, headSize, 0);
        fs.closeSync(fd);
        // Match `] pid: <digits>` — agnostic to ISO timestamp format at the start.
        pidPresent = /\]\s+pid:\s+\d+/.test(headBuf.toString('utf8'));
      } catch { /* read failure — pidPresent stays false */ }
      _logState = `logExists=true logSize=${lst.size} pidPresent=${pidPresent}`;
    } catch { /* ENOENT — keep default */ }

    if (!hasProcess && silentMs > effectiveTimeout && (Date.now() > engineRestartGraceUntil || engineRestartGraceExempt?.has(item.id))) {
      // No tracked process AND no recent output past effective timeout AND (grace period expired OR confirmed-dead at restart) → orphaned
      log('warn', `Orphan detected: ${item.agent} (${item.id}) — no process tracked, silent for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''} [${_logState}]`);
      dispatch().updateAgentStatus(item.id, AGENT_STATUS.TIMED_OUT, `Orphaned — no process, silent for ${silentSec}s`);
      // Clear session so retry starts fresh
      try { shared.safeUnlink(path.join(AGENTS_DIR, item.agent, 'session.json')); } catch {}
      deadItems.push({ item, reason: `Orphaned — no process, silent for ${silentSec}s` });
    } else if (hasProcess && silentMs > effectiveTimeout) {
      // Has process but no output past effective timeout → hung
      log('warn', `Hung agent: ${item.agent} (${item.id}) — process exists but no output for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''} [${_logState}]`);
      dispatch().updateAgentStatus(item.id, AGENT_STATUS.TIMED_OUT, `Hung — no output for ${silentSec}s`);
      const procInfo = activeProcesses.get(item.id);
      if (procInfo) {
        shared.killGracefully(procInfo.proc, 5000);
        // On Unix, also kill child process tree (killGracefully only hits parent PID)
        if (process.platform !== 'win32' && procInfo.proc?.pid) {
          setTimeout(() => {
            try { shared.exec(`pkill -KILL -P ${procInfo.proc.pid}`, { timeout: 3000 }); } catch { /* children may already be dead */ }
          }, 6000); // after grace period
        }
        activeProcesses.delete(item.id);
      }
      // Clear session so retry starts fresh instead of resuming the killed session
      try { shared.safeUnlink(path.join(AGENTS_DIR, item.agent, 'session.json')); } catch {}
      deadItems.push({ item, reason: `Hung — no output for ${silentSec}s` });
    }
    // If has process and recent output → healthy, let it run
  }

  // Clean up dead items
  for (const { item, reason } of deadItems) {
    completeDispatch(item.id, DISPATCH_RESULT.ERROR, reason);
  }

  // Batch-write blocking tool call annotations to dispatch entries.
  // This surfaces blocking state via GET /api/status → dashboard badges.
  if (blockingAnnotations.size > 0) {
    const { mutateDispatch: mutateDispatchFn } = dispatch();
    mutateDispatchFn((dp) => {
      for (const activeItem of dp.active) {
        if (!blockingAnnotations.has(activeItem.id)) continue;
        const ann = blockingAnnotations.get(activeItem.id);
        if (ann) {
          activeItem._blockingToolCall = ann;
        } else {
          delete activeItem._blockingToolCall;
        }
      }
    });
  }

  // Agent status is now derived from dispatch.json at read time (getAgentStatus).
  // No reconcile sweep needed — dispatch IS the source of truth.

  // Reconcile: find work items stuck in "dispatched" with no matching active dispatch
  const activeKeys = new Set((dispatchData.active || []).map(d => d.meta?.dispatchKey).filter(Boolean));
  const allWiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
  for (const project of getProjects(config)) {
    allWiPaths.push(projectWorkItemsPath(project));
  }
  for (const wiPath of allWiPaths) {
    // skipWriteIfUnchanged is critical — checkTimeouts runs every tick, and
    // without this gate the file's mtime updates on every call (no real
    // change), tripping the cli.js work-items.json watcher → triggering tick
    // → calling checkTimeouts → ... a 5-6s loop of "File change detected".
    mutateJsonFileLocked(wiPath, (items) => {
      if (!items || !Array.isArray(items)) return items;
      let changed = false;
      for (const item of items) {
        if (item.status !== WI_STATUS.DISPATCHED) continue;
        // Never revert completed items
        if (item.completedAt || item.status === WI_STATUS.DONE) continue;
        // Skip recently-steered agents (being killed and re-spawned)
        const steerInfo = activeProcesses.get(item.id) || [...activeProcesses.values()].find(p => p.agentId && item.dispatched_to === p.agentId);
        if (steerInfo?._steeringAt && Date.now() - steerInfo._steeringAt < 60000) continue;
        // Check if any active dispatch references this item
        const projectNames = getProjects(config).map(p => p.name);
        const possibleKeys = [
          `central-work-${item.id}`,
          ...projectNames.map(p => `work-${p}-${item.id}`),
        ];
        const isActive = possibleKeys.some(k => activeKeys.has(k)) ||
          (dispatchData.active || []).some(d => d.meta?.item?.id === item.id);
        if (!isActive) {
          const retries = (item._retryCount || 0);
          const maxRetries = ENGINE_DEFAULTS.maxRetries;
          if (retries < maxRetries) {
            log('info', `Reconcile: work item ${item.id} agent died — auto-retry ${retries + 1}/${maxRetries}`);
            item.status = WI_STATUS.PENDING;
            item._retryCount = retries + 1;
            delete item.dispatched_at;
            delete item.dispatched_to;
            delete item._pendingReason;
            delete item.failReason;
          } else {
            log('warn', `Reconcile: work item ${item.id} failed after ${retries} retries — marking as failed`);
            item.status = WI_STATUS.FAILED;
            item.failReason = `Agent died or was killed (${maxRetries} retries exhausted)`;
            item.failedAt = ts();
            delete item._pendingReason;
          }
          changed = true;
        }
      }
      return items;
    }, { defaultValue: [], skipWriteIfUnchanged: true });
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  checkTimeouts,
  checkSteering,
  checkIdleThreshold,
};
