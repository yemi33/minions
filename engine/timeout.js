/**
 * engine/timeout.js — Runtime timeout, stale-orphan cleanup, steering, and idle checks.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');
const steering = require('./steering');

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

    const alreadyPending = new Set((info._pendingSteeringFiles || []).map(entry => entry.path || entry));
    const unread = steering.listUnreadSteeringMessages(info.agentId);
    for (const empty of unread.filter(entry => !entry.message.trim())) {
      shared.safeUnlink(empty.path);
    }
    const steerEntry = unread.find(entry => entry.message.trim() && !alreadyPending.has(entry.path));
    if (!steerEntry) continue; // ENOENT/no agents/<id>/inbox/steering-*.md message
    const message = steerEntry.message.trim();

    const sessionId = info.sessionId;
    if (!sessionId) {
      // No session to resume — kill agent and leave message unread in inbox for retry.
      // Previously this silently skipped for up to 5m then deleted the message (#627).
      log('info', `Steering: no sessionId for ${info.agentId} (${id}) — killing and keeping unread message in inbox`);

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
    info._steeringEntry = steerEntry;
    info._steeringAt = Date.now();

    shared.killImmediate(info.proc);
  }
}

// ─── Timeout Checker ─────────────────────────────────────────────────────────

function trackedProcessPid(procInfo) {
  const pid = Number(procInfo?.proc?.pid || procInfo?.pid || 0);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isTrackedProcessAlive(procInfo) {
  if (!procInfo) return false;
  const proc = procInfo.proc;
  if (proc && Object.prototype.hasOwnProperty.call(proc, 'exitCode') && proc.exitCode !== null) {
    return false;
  }

  const pid = trackedProcessPid(procInfo);
  if (!pid) return !!proc && proc.killed !== true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkTimeouts(config) {
  const activeProcesses = engine().activeProcesses;
  const engineRestartGraceUntil = engine().engineRestartGraceUntil;
  const engineRestartGraceExempt = engine().engineRestartGraceExempt;
  const { completeDispatch } = dispatch();
  const { runPostCompletionHooks, parseAgentOutput, parseStructuredCompletion, detectNonTerminalResultSummary } = require('./lifecycle');

  const timeout = config.engine?.agentTimeout || ENGINE_DEFAULTS.agentTimeout;
  const defaultStaleOrphanTimeout = config.engine?.heartbeatTimeout || ENGINE_DEFAULTS.heartbeatTimeout;

  // Optional per-type stale-orphan timeouts: merge ENGINE_DEFAULTS ← config overrides.
  const perTypeStaleOrphanTimeouts = { ...ENGINE_DEFAULTS.heartbeatTimeouts, ...(config.engine?.heartbeatTimeouts || {}) };

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

  // 2. Stale-orphan check — for ALL active dispatch items (catches lost process handles after restart).
  //    Silence is not a failure for tracked live processes: long CLI commands can legitimately
  //    produce no stdout/stderr for extended periods.
  const dispatchData = getDispatch();
  const deadItems = [];
  const legacyAnnotationClears = new Set();

  for (const item of (dispatchData.active || [])) {
    if (!item.agent) continue;

    // Per-type stale-orphan timeout: look up work type from dispatch item, fall back to default.
    const workType = item.workType || item.meta?.item?.type;
    const staleOrphanTimeout = (workType && perTypeStaleOrphanTimeouts[workType]) || defaultStaleOrphanTimeout;

    const procInfo = activeProcesses.get(item.id);
    const hasProcess = !!procInfo;
    const processAlive = isTrackedProcessAlive(procInfo);
    const liveLogPath = path.join(AGENTS_DIR, item.agent, 'live-output.log');
    let lastActivity = item.started_at ? new Date(item.started_at).getTime() : 0;

    // live-output.log mtime is only used for stale-orphan cleanup and completion recovery.
    // It is not used as an output-silence timeout for live tracked processes.
    try {
      const stat = fs.statSync(liveLogPath);
      lastActivity = Math.max(lastActivity, stat.mtimeMs);
    } catch { /* optional */ }

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

        const fullLogForHooks = safeRead(liveLogPath) || liveLogTail;
        let completionDetection = null;
        let outputResultSummary = '';
        try {
          const runtimeName = item.meta?.runtimeName || item.runtimeName || 'claude';
          outputResultSummary = parseAgentOutput(fullLogForHooks, runtimeName).resultSummary || '';
          const gateSummary = outputResultSummary || (!fullLogForHooks.includes('"type":') ? fullLogForHooks : '');
          completionDetection = isSuccess
            ? detectNonTerminalResultSummary(gateSummary, parseStructuredCompletion(fullLogForHooks, runtimeName))
            : null;
        } catch (e) { log('warn', 'completion summary gate: ' + e.message); }

        completeDispatch(item.id, completionDetection ? DISPATCH_RESULT.ERROR : (isSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR),
          completionDetection ? completionDetection.reason : (isSuccess ? 'Completed (detected from output)' : `Exited with code ${processExitCode} (detected from output)`),
          outputResultSummary,
          completionDetection ? { processWorkItemFailure: false } : {});

        // Run post-completion hooks via shared helper (async — fire and forget in timeout context).
        // Pass the actual exit code so autoRecovery (PR-created-but-failed) still works correctly.
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

    // Blocking tool annotations are no longer needed: live tracked processes are allowed to
    // be quiet regardless of which command/tool is running.
    if (item._blockingToolCall) {
      legacyAnnotationClears.add(item.id);
    }

    // Skip recently-steered agents — they're being killed and re-spawned
    if (procInfo?._steeringAt && Date.now() - procInfo._steeringAt < 60000) continue;

    if (processAlive) {
      continue;
    }

    // Capture live-output.log file state for orphan diagnostics
    // (#W-mo248lkjwgsu original, #W-mo25loq8kjer pid annotation).
    // Four distinguishable failure modes:
    //   logExists=false                         → spawn call itself threw, no log ever written
    //   logExists=true pidPresent=false         → engine stub written but spawn died before emitting pid line
    //   logExists=true pidPresent=true silent   → process spawned (pid recorded) but no recent output
    //   logExists=true pidPresent=true size>pid → process handle was lost after output was written
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

    if (!processAlive && silentMs > staleOrphanTimeout && (Date.now() > engineRestartGraceUntil || engineRestartGraceExempt?.has(item.id))) {
      // No tracked process AND no recent output past stale-orphan timeout AND (grace period expired OR confirmed-dead at restart) → orphaned
      log('warn', `Orphan detected: ${item.agent} (${item.id}) — no live process tracked, silent for ${silentSec}s [${_logState}]`);
      dispatch().updateAgentStatus(item.id, AGENT_STATUS.TIMED_OUT, `Orphaned — no process, silent for ${silentSec}s`);
      // Clear session so retry starts fresh
      try { shared.safeUnlink(path.join(AGENTS_DIR, item.agent, 'session.json')); } catch {}
      deadItems.push({ item, reason: `Orphaned — no process, silent for ${silentSec}s` });
      activeProcesses.delete(item.id);
    }
  }

  // Clean up dead items
  for (const { item, reason } of deadItems) {
    completeDispatch(item.id, DISPATCH_RESULT.ERROR, reason);
  }

  // Clear legacy blocking-tool annotations; process liveness no longer depends on tool parsing.
  if (legacyAnnotationClears.size > 0) {
    const { mutateDispatch: mutateDispatchFn } = dispatch();
    mutateDispatchFn((dp) => {
      for (const activeItem of dp.active) {
        if (legacyAnnotationClears.has(activeItem.id)) delete activeItem._blockingToolCall;
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
