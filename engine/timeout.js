/**
 * engine/timeout.js — Timeout detection, steering, and idle threshold checks.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeRead, safeWrite, safeJson, getProjects, projectWorkItemsPath, ENGINE_DEFAULTS: DEFAULTS } = shared;
const { getDispatch, getAgentStatus } = queries;
const AGENTS_DIR = queries.AGENTS_DIR;
const MINIONS_DIR = shared.MINIONS_DIR;

// Lazy require to break circular dependency with engine.js
let _engine = null;
function engine() { if (!_engine) _engine = require('../engine'); return _engine; }
function log(level, msg, meta) { return engine().log(level, msg, meta); }
function ts() { return engine().ts(); }

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

function checkSteering(config) {
  const activeProcesses = engine().activeProcesses;
  for (const [id, info] of activeProcesses) {
    const steerPath = path.join(AGENTS_DIR, info.agentId, 'steer.md');
    if (!fs.existsSync(steerPath)) continue;

    const message = safeRead(steerPath);
    try { fs.unlinkSync(steerPath); } catch { /* cleanup */ }
    if (!message) continue;

    const sessionId = info.sessionId;
    if (!sessionId) {
      log('warn', `Steering: no sessionId for ${info.agentId} — cannot resume. Message dropped.`);
      continue;
    }

    log('info', `Steering: killing ${info.agentId} (${id}) for session resume with human message`);

    // Kill current process
    try { info.proc.kill('SIGTERM'); } catch { /* process may be dead */ }

    // Store steering context for re-spawn on close
    info._steeringMessage = message;
    info._steeringSessionId = sessionId;
  }
}

// ─── Timeout Checker ─────────────────────────────────────────────────────────

function checkTimeouts(config) {
  const activeProcesses = engine().activeProcesses;
  const engineRestartGraceUntil = engine().engineRestartGraceUntil;
  const { completeDispatch } = dispatch();
  const { runPostCompletionHooks } = require('./lifecycle');

  const timeout = config.engine?.agentTimeout || DEFAULTS.agentTimeout;
  const heartbeatTimeout = config.engine?.heartbeatTimeout || DEFAULTS.heartbeatTimeout;

  // 1. Check tracked processes for hard timeout (supports per-item deadline from fan-out)
  for (const [id, info] of activeProcesses.entries()) {
    const itemTimeout = info.meta?.deadline ? Math.max(0, info.meta.deadline - new Date(info.startedAt).getTime()) : timeout;
    const elapsed = Date.now() - new Date(info.startedAt).getTime();
    if (elapsed > itemTimeout) {
      log('warn', `Agent ${info.agentId} (${id}) hit hard timeout after ${Math.round(elapsed / 1000)}s — killing`);
      try { info.proc.kill('SIGTERM'); } catch { /* process may be dead */ }
      setTimeout(() => {
        try { info.proc.kill('SIGKILL'); } catch { /* process may be dead */ }
      }, 5000);
    }
  }

  // 2. Heartbeat check — for ALL active dispatch items (catches orphans after engine restart)
  //    Uses live-output.log mtime as heartbeat. If no output for heartbeatTimeout, agent is dead.
  const dispatchData = getDispatch();
  const deadItems = [];

  for (const item of (dispatchData.active || [])) {
    if (!item.agent) continue;

    const hasProcess = activeProcesses.has(item.id);
    const liveLogPath = path.join(AGENTS_DIR, item.agent, 'live-output.log');
    let lastActivity = item.started_at ? new Date(item.started_at).getTime() : 0;

    // Check live-output.log mtime as heartbeat
    try {
      const stat = fs.statSync(liveLogPath);
      lastActivity = Math.max(lastActivity, stat.mtimeMs);
    } catch { /* optional */ }

    const silentMs = Date.now() - lastActivity;
    const silentSec = Math.round(silentMs / 1000);

    // Check if the agent actually completed (result event in live output)
    // Optimization: only read file if recent activity (avoids reading stale 1MB logs)
    let completedViaOutput = false;
    try {
      if (silentMs > 600000) throw new Error('skip'); // No point reading a file silent for >10min
      const liveLog = safeRead(liveLogPath);
      if (liveLog && liveLog.includes('"type":"result"')) {
        completedViaOutput = true;
        const isSuccess = liveLog.includes('"subtype":"success"');
        log('info', `Agent ${item.agent} (${item.id}) completed via output detection (${isSuccess ? 'success' : 'error'})`);

        // Extract output text for the output.log
        const outputLogPath = path.join(AGENTS_DIR, item.agent, 'output.log');
        try {
          const { text } = shared.parseStreamJsonOutput(liveLog);
          safeWrite(outputLogPath, `# Output for dispatch ${item.id}\n# Exit code: ${isSuccess ? 0 : 1}\n# Completed: ${ts()}\n# Detected via output scan\n\n## Result\n${text || '(no text)'}\n`);
        } catch (e) { log('warn', 'parse output result: ' + e.message); }

        completeDispatch(item.id, isSuccess ? 'success' : 'error', 'Completed (detected from output)');

        // Run post-completion hooks via shared helper
        runPostCompletionHooks(item, item.agent, isSuccess ? 0 : 1, liveLog, config);

        if (hasProcess) {
          try { activeProcesses.get(item.id)?.proc.kill('SIGTERM'); } catch { /* process may be dead */ }
          activeProcesses.delete(item.id);
        }
        continue; // Skip orphan/hung detection — we handled it
      }
    } catch (e) { log('warn', 'output completion detection: ' + e.message); }

    // Check if agent is in a blocking tool call (TaskOutput block:true, Bash with long timeout, etc.)
    // These tools produce no stdout for extended periods — don't kill them prematurely
    // Check for BOTH tracked and untracked processes (orphan case after engine restart)
    let isBlocking = false;
    let blockingTimeout = heartbeatTimeout;
    if (silentMs > heartbeatTimeout) {
      try {
        const liveLog = safeRead(liveLogPath);
        if (liveLog) {
          // Find the last tool_use call in the output — check if it's a known blocking tool
          const lines = liveLog.split('\n');
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
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
                blockingTimeout = Math.max(heartbeatTimeout, taskTimeout + 60000); // task timeout + 1min grace
                isBlocking = true;
              }
              // Bash with explicit long timeout (>5min)
              if (name === 'Bash' && input.timeout && input.timeout > heartbeatTimeout) {
                blockingTimeout = Math.max(heartbeatTimeout, input.timeout + 60000);
                isBlocking = true;
              }
              break; // only check the most recent tool_use
            } catch { /* JSON parse — line may not be valid JSON */ }
          }
          if (isBlocking) {
            log('info', `Agent ${item.agent} (${item.id}) is in a blocking tool call — extended timeout to ${Math.round(blockingTimeout / 1000)}s (silent for ${silentSec}s)`);
          }
        }
      } catch (e) { log('warn', 'blocking tool detection: ' + e.message); }
    }

    const effectiveTimeout = isBlocking ? blockingTimeout : heartbeatTimeout;

    if (!hasProcess && silentMs > effectiveTimeout && Date.now() > engineRestartGraceUntil) {
      // No tracked process AND no recent output past effective timeout AND grace period expired → orphaned
      log('warn', `Orphan detected: ${item.agent} (${item.id}) — no process tracked, silent for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''}`);
      deadItems.push({ item, reason: `Orphaned — no process, silent for ${silentSec}s` });
    } else if (hasProcess && silentMs > effectiveTimeout) {
      // Has process but no output past effective timeout → hung
      log('warn', `Hung agent: ${item.agent} (${item.id}) — process exists but no output for ${silentSec}s${isBlocking ? ' (blocking timeout exceeded)' : ''}`);
      const procInfo = activeProcesses.get(item.id);
      if (procInfo) {
        try { procInfo.proc.kill('SIGTERM'); } catch { /* process may be dead */ }
        setTimeout(() => { try { procInfo.proc.kill('SIGKILL'); } catch { /* process may be dead */ } }, 5000);
        activeProcesses.delete(item.id);
      }
      deadItems.push({ item, reason: `Hung — no output for ${silentSec}s` });
    }
    // If has process and recent output → healthy, let it run
  }

  // Clean up dead items
  for (const { item, reason } of deadItems) {
    completeDispatch(item.id, 'error', reason);
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
    const items = safeJson(wiPath);
    if (!items || !Array.isArray(items)) continue;
    let changed = false;
    for (const item of items) {
      if (item.status !== 'dispatched') continue;
      // Check if any active dispatch references this item
      // Dispatch keys include project name: work-{project}-{id} or central-work-{id}
      const projectNames = getProjects(config).map(p => p.name);
      const possibleKeys = [
        `central-work-${item.id}`,
        ...projectNames.map(p => `work-${p}-${item.id}`),
      ];
      const isActive = possibleKeys.some(k => activeKeys.has(k)) ||
        (dispatchData.active || []).some(d => d.meta?.item?.id === item.id);
      if (!isActive) {
        // Don't revive items that were explicitly failed for non-retryable reasons
        if (item.status === 'failed' && item.failReason && !item.failReason.includes('Agent died')) continue;
        const retries = (item._retryCount || 0);
        if (retries < 3) {
          log('info', `Reconcile: work item ${item.id} agent died — auto-retry ${retries + 1}/3`);
          item.status = 'pending';
          item._retryCount = retries + 1;
          delete item.dispatched_at;
          delete item.dispatched_to;
        } else {
          log('warn', `Reconcile: work item ${item.id} failed after ${retries} retries — marking as failed`);
          item.status = 'failed';
          item.failReason = 'Agent died or was killed (3 retries exhausted)';
          item.failedAt = ts();
        }
        changed = true;
      }
    }
    if (changed) safeWrite(wiPath, items);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  checkTimeouts,
  checkSteering,
  checkIdleThreshold,
};
