/**
 * engine/cli.js — CLI command handlers for Minions engine.
 * Extracted from engine.js to reduce monolith size.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite, WI_STATUS, WORK_TYPE, PLAN_STATUS, PR_STATUS, DISPATCH_RESULT } = shared;
const queries = require('./queries');
const { getConfig, getControl, getDispatch, getAgentStatus,
  MINIONS_DIR, ENGINE_DIR, AGENTS_DIR, PLANS_DIR, PRD_DIR, CONTROL_PATH, DISPATCH_PATH } = queries;

// Lazy require — only for engine-specific functions (log, ts, tick, addToDispatch, etc.)
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

function handleCommand(cmd, args) {
  if (!cmd) {
    commands.start();
  } else if (commands[cmd]) {
    commands[cmd](...args);
  } else {
    console.log(`Unknown command: ${cmd}`);
    console.log('Commands:');
    console.log('  start            Start engine daemon');
    console.log('  stop             Stop engine');
    console.log('  pause / resume   Pause/resume dispatching');
    console.log('  status           Show engine + agent state');
    console.log('  queue            Show dispatch queue');
    console.log('  sources          Show work source status');
    console.log('  discover         Dry-run work discovery');
    console.log('  dispatch         Force a dispatch cycle');
    console.log('  spawn <a> <p>    Manually spawn agent with prompt');
    console.log('  work <title> [o] Add to work-items.json queue');
    console.log('  plan <src> [p]   Generate PRD from a plan (file or text)');
    console.log('  kill             Kill all active agents, reset to pending');
    console.log('  complete <id>    Mark a dispatch as done');
    console.log('  cleanup          Clean temp files, worktrees, zombies');
    console.log('  mcp-sync         Sync MCP servers from ~/.claude.json');
    console.log('  doctor           Check prerequisites and runtime health');
    process.exit(1);
  }
}

const commands = {
  start() {
    // Run preflight checks (warn but don't block — engine may still be useful)
    try {
      const { runPreflight, printPreflight } = require('./preflight');
      const { results } = runPreflight();
      const hasFatal = results.some(r => r.ok === false);
      if (hasFatal) {
        printPreflight(results, { label: 'Preflight checks' });
        console.log('  Some checks failed — agents may not work. Run `minions doctor` for details.\n');
      }
    } catch (e) { console.error('preflight:', e.message); }

    const e = engine();
    const control = getControl();
    if (control.state === 'running') {
      let alive = false;
      if (control.pid) {
        try {
          if (process.platform === 'win32') {
            // On Windows, process.kill(pid, 0) can false-positive if the PID was recycled.
            // Use tasklist and verify the process is actually node.
            const { execSync } = require('child_process');
            const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
            alive = out.includes(String(control.pid)) && out.toLowerCase().includes('node');
          } else {
            process.kill(control.pid, 0);
            alive = true;
          }
        } catch { /* process may be dead */ }
      }
      if (alive) {
        console.log(`Engine is already running (PID ${control.pid}).`);
        return;
      }
      console.log(`Engine was running (PID ${control.pid}) but process is dead — restarting.`);
    }

    safeWrite(CONTROL_PATH, { state: 'running', pid: process.pid, started_at: e.ts() });
    e.log('info', 'Engine started');
    console.log(`Engine started (PID: ${process.pid})`);

    const config = getConfig();
    const interval = config.engine?.tickInterval || shared.ENGINE_DEFAULTS.tickInterval;

    const { getProjects } = require('./shared');
    const projects = getProjects(config);
    if (projects.length === 0) {
      console.log('  \x1b[33mNo projects configured.\x1b[0m Link one with: minions add <path-to-repo>');
      console.log('  Agents can still work on tasks via the Command Center without a project.');
    }
    for (const p of projects) {
      const root = p.localPath ? path.resolve(p.localPath) : null;
      if (!root || !fs.existsSync(root)) {
        e.log('warn', `Project "${p.name}" path not found: ${p.localPath} — skipping`);
        console.log(`  WARNING: ${p.name} path not found: ${p.localPath}`);
      } else {
        console.log(`  Project: ${p.name} (${root})`);
      }
    }

    e.validateConfig(config);
    e.loadCooldowns();

    // Re-attach to surviving agent processes from previous session
    const { exec } = require('./shared');
    const dispatch = getDispatch();
    const activeOnStart = (dispatch.active || []);
    if (activeOnStart.length > 0) {
      let reattached = 0;
      for (const item of activeOnStart) {
        const agentId = item.agent;
        let agentPid = null;

        const pidFile = path.join(ENGINE_DIR, `pid-${item.id}.pid`);
        try {
          const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
          if (pidStr) agentPid = parseInt(pidStr);
        } catch { /* optional */ }

        if (!agentPid) {
          const status = getAgentStatus(agentId);
          if (status.dispatch_id === item.id) {
            const liveLog = path.join(AGENTS_DIR, agentId, 'live-output.log');
            try {
              const stat = fs.statSync(liveLog);
              const ageMs = Date.now() - stat.mtimeMs;
              if (ageMs < 300000) {
                agentPid = -1;
              }
            } catch { /* optional */ }
          }
        }

        if (agentPid && agentPid > 0) {
          try {
            if (process.platform === 'win32') {
              const out = exec(`tasklist /FI "PID eq ${agentPid}" /NH`, { encoding: 'utf8', timeout: 3000 });
              if (!out.includes(String(agentPid))) agentPid = null;
            } else {
              process.kill(agentPid, 0);
            }
          } catch { agentPid = null; }
        }

        if (agentPid) {
          e.activeProcesses.set(item.id, { proc: { pid: agentPid > 0 ? agentPid : null }, agentId, startedAt: item.created_at, reattached: true });
          // Sync work item status to dispatched — direct file write to avoid lifecycle lazy init issues
          if (item.meta?.item?.id && item.meta?.project?.localPath) {
            try {
              const wiPath = path.join(MINIONS_DIR, "projects", item.meta.project.name, "work-items.json");
              const wiItems = safeJson(wiPath) || [];
              const wi = wiItems.find(w => w.id === item.meta.item.id);
              if (wi && wi.status !== WI_STATUS.DISPATCHED) {
                wi.status = WI_STATUS.DISPATCHED;
                wi.dispatched_to = wi.dispatched_to || agentId;
                wi.dispatched_at = wi.dispatched_at || new Date().toISOString();
                safeWrite(wiPath, wiItems);
              }
            } catch (err) { console.log(`    Warning: failed to sync work item status: ${err.message}`); }
          }
          reattached++;
          e.log('info', `Re-attached to ${agentId} (${item.id}) — PID ${agentPid > 0 ? agentPid : 'unknown (active output)'}`);
        }
      }

      const unattached = activeOnStart.length - reattached;
      if (unattached > 0) {
        const gracePeriod = config.engine?.restartGracePeriod || shared.ENGINE_DEFAULTS.restartGracePeriod;
        e.engineRestartGraceUntil = Date.now() + gracePeriod;
        console.log(`  ${unattached} unattached dispatch(es) — ${gracePeriod / 60000}min grace period`);
      }
      if (reattached > 0) {
        console.log(`  Re-attached to ${reattached} surviving agent(s)`);
      }
      for (const item of activeOnStart) {
        const attached = e.activeProcesses.has(item.id);
        console.log(`    ${attached ? '\u2713' : '?'} ${item.agentName || item.agent}: ${(item.task || '').slice(0, 70)}`);
      }
    }

    // Orphan completion detection: for dispatch entries that couldn't re-attach,
    // check if the agent actually completed by scanning its output file.
    // If it did, run the post-completion hooks now so work items get updated.
    (function detectOrphanCompletions() {
      const shared = require('./shared');
      const lifecycle = require('./lifecycle');
      let recovered = 0;

      for (const item of activeOnStart) {
        if (e.activeProcesses.has(item.id)) continue; // re-attached, skip

        const agentId = item.agent;
        const outputPath = path.join(MINIONS_DIR, 'agents', agentId, 'live-output.log');
        try {
          const stat = fs.statSync(outputPath);
          const output = fs.readFileSync(outputPath, 'utf8');

          // Check for completion markers in output
          const hasResult = output.includes('"type":"result"') || output.includes('"type": "result"');
          const hasError = output.includes('"is_error":true') || output.includes('"is_error": true');
          if (!hasResult && !hasError) continue;

          const isSuccess = hasResult && !hasError;
          const result = isSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;

          e.log('info', `Orphan recovery: ${agentId} (${item.id}) completed while engine was down — result: ${result}`);

          // Extract PRs from output
          let prsCreated = 0;
          try {
            prsCreated = lifecycle.syncPrsFromOutput(output, agentId, item.meta, config);
          } catch (err) { e.log('warn', `Orphan PR sync: ${err.message}`); }

          // Update work item status
          if (item.meta?.item?.id) {
            const status = isSuccess ? WI_STATUS.DONE : WI_STATUS.FAILED;
            try {
              lifecycle.updateWorkItemStatus(item.meta, status, isSuccess ? '' : 'Completed while engine was down');
            } catch {
              // Direct file write fallback
              try {
                const projName = item.meta.project?.name;
                if (projName) {
                  const wiPath = path.join(MINIONS_DIR, 'projects', projName, 'work-items.json');
                  const items = safeJson(wiPath) || [];
                  const wi = items.find(w => w.id === item.meta.item.id);
                  if (wi) {
                    wi.status = status;
                    if (isSuccess) { wi.completedAt = new Date().toISOString(); delete wi.failReason; }
                    else { wi.failedAt = new Date().toISOString(); wi.failReason = 'Completed while engine was down'; }
                    safeWrite(wiPath, items);
                  }
                }
              } catch (err) { e.log('warn', `Orphan WI fallback: ${err.message}`); }
            }
          }

          // Move from active to completed in dispatch
          try {
            e.completeDispatch(
              item.id,
              result,
              isSuccess ? 'Completed (orphan recovery)' : 'Failed (orphan recovery)',
              '',
              { processWorkItemFailure: false }
            );
          } catch (err) { e.log('warn', `Orphan dispatch complete: ${err.message}`); }

          // Check plan completion
          if (isSuccess && item.meta?.item?.sourcePlan) {
            try { lifecycle.checkPlanCompletion(item.meta, config); } catch (err) { e.log('warn', `Orphan plan completion: ${err.message}`); }
          }

          recovered++;
          console.log(`    ✓ Recovered ${agentId}: ${(item.task || '').slice(0, 60)} → ${result}${prsCreated ? ' (' + prsCreated + ' PR)' : ''}`);
        } catch (err) { e.log('warn', `Orphan recovery: ${err.message}`); }
      }
      if (recovered > 0) {
        e.log('info', `Orphan recovery: processed ${recovered} completion(s) from previous session`);
        console.log(`  Recovered ${recovered} orphaned completion(s)`);
      }
    })();

    // Recovery sweep
    (function recoverBrokenState() {
      const shared = require('./shared');
      const projects = shared.getProjects(config);
      let fixes = 0;

      const activeIds = new Set((dispatch.active || []).map(d => d.meta?.item?.id).filter(Boolean));
      const allWiPaths = [path.join(MINIONS_DIR, 'work-items.json')];
      for (const p of projects) {
        allWiPaths.push(path.join(MINIONS_DIR, "projects", p.name, "work-items.json"));
      }
      for (const wiPath of allWiPaths) {
        try {
          const items = safeJson(wiPath) || [];
          let changed = false;
          for (const item of items) {
            if (item.status === WI_STATUS.DISPATCHED && !activeIds.has(item.id)) {
              item.status = WI_STATUS.PENDING;
              delete item.dispatched_at;
              delete item.dispatched_to;
              changed = true;
              fixes++;
              e.log('info', `Recovery: reset stuck item ${item.id} from dispatched → pending`);
            }
          }
          if (changed) safeWrite(wiPath, items);
        } catch (err) { e.log('warn', `Recovery WI reset: ${err.message}`); }
      }

      // Plan chain recovery removed — plans require explicit user execution via dashboard

      if (fixes > 0) {
        console.log(`  Recovery: fixed ${fixes} broken state issue(s)`);
      }
    })();

    // Initial tick
    e.tick();

    // Start tick loop
    const tickTimer = setInterval(() => e.tick(), interval);

    // Fast poll for immediate wakeup signals (checks control.json every 2s)
    const wakeupTimer = setInterval(() => {
      const ctrl = getControl();
      if (ctrl._wakeupAt && Date.now() - ctrl._wakeupAt < 5000) {
        delete ctrl._wakeupAt;
        safeWrite(CONTROL_PATH, ctrl);
        e.tick();
      }
    }, 2000);

    console.log(`Tick interval: ${interval / 1000}s | Max concurrent: ${config.engine?.maxConcurrent || 5}`);
    console.log('Press Ctrl+C to stop');

    // File-change-driven work discovery — trigger tick when work-items or PRDs change
    const _watchedFiles = new Set();
    let _globalDebounce = null;
    function watchForWorkChanges() {
      const filesToWatch = [
        path.join(MINIONS_DIR, 'work-items.json'),
        path.join(ENGINE_DIR, 'dispatch.json'),
      ];
      // Watch project-specific work-items.json
      const { getProjects } = require('./shared');
      for (const p of getProjects(config)) {
        filesToWatch.push(shared.projectWorkItemsPath(p));
      }
      // Watch PRD files
      const prdDir = path.join(MINIONS_DIR, 'prd');
      try {
        for (const f of fs.readdirSync(prdDir).filter(f => f.endsWith('.json'))) {
          filesToWatch.push(path.join(prdDir, f));
        }
      } catch { /* optional */ }

      for (const filePath of filesToWatch) {
        if (_watchedFiles.has(filePath)) continue;
        _watchedFiles.add(filePath);
        try {
          fs.watchFile(filePath, { interval: 2000 }, () => {
            // Global debounce — coalesce rapid multi-file changes into one tick
            if (_globalDebounce) clearTimeout(_globalDebounce);
            _globalDebounce = setTimeout(() => {
              _globalDebounce = null;
              e.log('info', `File change detected — triggering tick`);
              e.tick();
            }, 1000);
          });
        } catch { /* optional */ }
      }
    }
    watchForWorkChanges();

    // Graceful shutdown — wait for active agents before exiting
    let shuttingDown = false;
    function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} received — initiating graceful shutdown...`);
      clearInterval(tickTimer);
      clearInterval(wakeupTimer);
      for (const f of _watchedFiles) { try { fs.unwatchFile(f); } catch { /* cleanup */ } }
      safeWrite(CONTROL_PATH, { state: 'stopping', pid: process.pid, stopping_at: e.ts() });
      e.log('info', `Graceful shutdown initiated (${signal})`);

      if (e.activeProcesses.size === 0) {
        safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: e.ts() });
        e.log('info', 'Graceful shutdown complete (no active agents)');
        console.log('No active agents — stopped.');
        process.exit(0);
      }

      console.log(`Waiting for ${e.activeProcesses.size} active agent(s) to finish...`);
      const timeout = config.engine?.shutdownTimeout || shared.ENGINE_DEFAULTS.shutdownTimeout;
      const deadline = Date.now() + timeout;

      const poll = setInterval(() => {
        if (e.activeProcesses.size === 0) {
          clearInterval(poll);
          safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: e.ts() });
          e.log('info', 'Graceful shutdown complete (all agents finished)');
          console.log('All agents finished — stopped.');
          process.exit(0);
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: e.ts() });
          e.log('warn', `Graceful shutdown timed out after ${timeout / 1000}s with ${e.activeProcesses.size} agent(s) still active`);
          console.log(`Shutdown timeout (${timeout / 1000}s) — force exiting with ${e.activeProcesses.size} agent(s) still running.`);
          process.exit(1);
        }
      }, 2000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  },

  stop() {
    const e = engine();
    const dispatch = getDispatch();
    const active = (dispatch.active || []);
    if (active.length > 0) {
      console.log(`\n  WARNING: ${active.length} agent(s) are still working:`);
      for (const item of active) {
        console.log(`    - ${item.agentName || item.agent}: ${(item.task || '').slice(0, 80)}`);
      }
      console.log('\n  These agents will continue running but the engine won\'t monitor them.');
      console.log('  On next start, they\'ll get a 20-min grace period before being marked as orphans.');
      console.log('  To kill them now, run: node engine.js kill\n');
    }
    const control = getControl();
    if (control.pid && control.pid !== process.pid) {
      try { process.kill(control.pid); } catch { /* process may be dead */ }
    }
    safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: e.ts() });
    e.log('info', 'Engine stopped');
    console.log('Engine stopped.');
  },

  pause() {
    const e = engine();
    safeWrite(CONTROL_PATH, { state: 'paused', paused_at: e.ts() });
    e.log('info', 'Engine paused');
    console.log('Engine paused. Run `node .minions/engine.js resume` to resume.');
  },

  resume() {
    const e = engine();
    const control = getControl();
    if (control.state === 'running') {
      console.log('Engine is already running.');
      return;
    }
    safeWrite(CONTROL_PATH, { state: 'running', resumed_at: e.ts() });
    e.log('info', 'Engine resumed');
    console.log('Engine resumed.');
  },

  status() {
    const e = engine();
    const config = getConfig();
    const control = getControl();
    const dispatch = getDispatch();
    const agents = config.agents || {};

    const { getProjects } = require('./shared');
    const projects = getProjects(config);

    // Version info
    let version = '?';
    try {
      const vFile = path.join(MINIONS_DIR, '.minions-version');
      version = fs.readFileSync(vFile, 'utf8').trim();
    } catch { /* optional */ }

    console.log('\n=== Minions Engine ===\n');
    console.log(`Version: ${version}`);

    // Engine state with liveness check
    let engineAlive = false;
    if (control.state === 'running' && control.pid) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
          engineAlive = out.includes(String(control.pid)) && out.toLowerCase().includes('node');
        } else {
          process.kill(control.pid, 0);
          engineAlive = true;
        }
      } catch { /* process may be dead */ }
    }
    if (control.state === 'running' && !engineAlive) {
      console.log(`Engine: stale (PID ${control.pid} is dead) — run: minions start`);
    } else {
      console.log(`Engine: ${control.state} (PID ${control.pid || 'N/A'})`);
    }

    // Dashboard check
    const http = require('http');
    const dashCheck = new Promise(resolve => {
      const req = http.get('http://localhost:7331/api/health', { timeout: 2000 }, () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    dashCheck.then(dashUp => {
      if (dashUp) console.log('Dashboard: running (http://localhost:7331)');
      else console.log('Dashboard: not running — start with: minions dash');
    }).catch(() => {});

    // Projects with health
    const healthyProjects = projects.filter(p => p.localPath && fs.existsSync(path.resolve(p.localPath)));
    const missingProjects = projects.filter(p => !p.localPath || !fs.existsSync(path.resolve(p.localPath)));
    console.log(`Projects: ${healthyProjects.length} linked${missingProjects.length ? ` (${missingProjects.length} path missing)` : ''}`);
    console.log('');

    console.log('Agents:');
    console.log(`  ${'ID'.padEnd(12)} ${'Name (Role)'.padEnd(30)} ${'Status'.padEnd(10)} Task`);
    console.log('  ' + '-'.repeat(70));
    for (const [id, agent] of Object.entries(agents)) {
      const status = getAgentStatus(id);
      console.log(`  ${id.padEnd(12)} ${`${agent.emoji} ${agent.name} (${agent.role})`.padEnd(30)} ${(status.status || 'idle').padEnd(10)} ${status.task || '-'}`);
    }

    console.log('');
    console.log(`Dispatch: ${dispatch.pending.length} pending | ${(dispatch.active || []).length} active | ${(dispatch.completed || []).length} completed`);
    console.log(`Active processes: ${e.activeProcesses.size}`);

    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metrics = safeJson(metricsPath);
    if (metrics && Object.keys(metrics).length > 0) {
      console.log('\nMetrics:');
      console.log(`  ${'Agent'.padEnd(12)} ${'Done'.padEnd(6)} ${'Err'.padEnd(6)} ${'PRs'.padEnd(6)} ${'Appr'.padEnd(6)} ${'Rej'.padEnd(6)} ${'Reviews'.padEnd(8)} ${'Cost'.padEnd(8)}`);
      console.log('  ' + '-'.repeat(64));
      for (const [id, m] of Object.entries(metrics)) {
        if (id.startsWith('_')) continue;
        const cost = m.totalCostUsd ? '$' + m.totalCostUsd.toFixed(1) : '-';
        console.log(`  ${id.padEnd(12)} ${String(m.tasksCompleted || 0).padEnd(6)} ${String(m.tasksErrored || 0).padEnd(6)} ${String(m.prsCreated || 0).padEnd(6)} ${String(m.prsApproved || 0).padEnd(6)} ${String(m.prsRejected || 0).padEnd(6)} ${String(m.reviewsDone || 0).padEnd(8)} ${cost.padEnd(8)}`);
      }
    }
    console.log('');
  },

  queue() {
    const e = engine();
    const dispatch = getDispatch();

    console.log('\n=== Dispatch Queue ===\n');

    if (dispatch.pending.length) {
      console.log('PENDING:');
      for (const d of dispatch.pending) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.task}`);
      }
    } else {
      console.log('No pending dispatches.');
    }

    if ((dispatch.active || []).length) {
      console.log('\nACTIVE:');
      for (const d of dispatch.active) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.task} (since ${d.started_at})`);
      }
    }

    if ((dispatch.completed || []).length) {
      console.log(`\nCOMPLETED (last 5):`);
      for (const d of dispatch.completed.slice(-5)) {
        console.log(`  [${d.id}] ${d.type} → ${d.agent}: ${d.result} (${d.completed_at})`);
      }
    }
    console.log('');
  },

  complete(id) {
    if (!id) {
      console.log('Usage: minions complete <dispatch-id>');
      return;
    }
    const dispatch = getDispatch();
    const found = (dispatch.active || []).some(d => d.id === id);
    if (!found) {
      console.log(`  Dispatch "${id}" not found in active queue.`);
      const pending = (dispatch.pending || []).some(d => d.id === id);
      if (pending) console.log('  (It is in pending — it hasn\'t started yet.)');
      return;
    }
    engine().completeDispatch(id, 'success');
    console.log(`  Marked ${id} as completed.`);
  },

  dispatch() {
    const e = engine();
    console.log('Forcing dispatch cycle...');
    const control = getControl();
    const prevState = control.state;
    safeWrite(CONTROL_PATH, { ...control, state: 'running' });
    e.tick();
    if (prevState !== 'running') {
      safeWrite(CONTROL_PATH, { ...control, state: prevState });
    }
    console.log('Dispatch cycle complete.');
  },

  spawn(agentId, ...promptParts) {
    const e = engine();
    const prompt = promptParts.join(' ');
    if (!agentId || !prompt) {
      console.log('Usage: node .minions/engine.js spawn <agent-id> "<prompt>"');
      return;
    }

    const config = getConfig();
    if (!config.agents[agentId]) {
      console.log(`Unknown agent: ${agentId}. Available: ${Object.keys(config.agents).join(', ')}`);
      return;
    }

    const id = e.addToDispatch({
      type: 'manual',
      agent: agentId,
      agentName: config.agents[agentId].name,
      agentRole: config.agents[agentId].role,
      task: prompt.substring(0, 100),
      prompt: prompt,
      meta: {}
    });

    const dispatch = getDispatch();
    const item = dispatch.pending.find(d => d.id === id);
    if (item) {
      e.spawnAgent(item, config);
    }
  },

  work(title, ...rest) {
    const e = engine();
    if (!title) {
      console.log('Usage: node .minions/engine.js work "<title>" [options-json]');
      console.log('Options: {"type":"implement","priority":"high","agent":"dallas","description":"...","branch":"feature/..."}');
      return;
    }

    let opts = {};
    const optStr = rest.join(' ');
    if (optStr) {
      try { opts = JSON.parse(optStr); } catch {
        console.log('Warning: Could not parse options JSON, using defaults');
      }
    }

    const config = getConfig();
    const { getProjects, projectWorkItemsPath } = require('./shared');
    const projects = getProjects(config);
    const targetProject = opts.project
      ? projects.find(p => p.name?.toLowerCase() === opts.project?.toLowerCase()) || projects[0]
      : projects[0];
    const wiPath = projectWorkItemsPath(targetProject);
    const items = safeJson(wiPath) || [];

    const item = {
      id: `W${String(items.length + 1).padStart(3, '0')}`,
      title: title,
      type: opts.type || 'implement',
      status: WI_STATUS.QUEUED,
      priority: opts.priority || 'medium',
      complexity: opts.complexity || 'medium',
      description: opts.description || title,
      agent: opts.agent || null,
      branch: opts.branch || null,
      prompt: opts.prompt || null,
      created_at: e.ts()
    };

    items.push(item);
    safeWrite(wiPath, items);

    console.log(`Queued work item: ${item.id} — ${item.title} (project: ${targetProject.name || 'default'})`);
    console.log(`  Type: ${item.type} | Priority: ${item.priority} | Agent: ${item.agent || 'auto'}`);
  },

  plan(source, projectName) {
    const e = engine();
    if (!source) {
      console.log('Usage: node .minions/engine.js plan <source> [project]');
      console.log('');
      console.log('Source can be:');
      console.log('  - A file path (markdown, txt, or json)');
      console.log('  - Inline text wrapped in quotes');
      console.log('');
      console.log('Examples:');
      console.log('  node engine.js plan ./my-plan.md');
      console.log('  node engine.js plan ./my-plan.md MyProject');
      console.log('  node engine.js plan "Add auth middleware with JWT tokens and role-based access"');
      return;
    }

    const config = getConfig();
    const { getProjects } = require('./shared');
    const projects = getProjects(config);
    const targetProject = projectName
      ? projects.find(p => p.name?.toLowerCase() === projectName.toLowerCase()) || projects[0]
      : projects[0];

    if (!targetProject) {
      console.log('No projects configured. Run: minions add <dir>');
      return;
    }

    let planContent;
    let planSummary;
    const sourcePath = path.resolve(source);
    if (fs.existsSync(sourcePath)) {
      planContent = fs.readFileSync(sourcePath, 'utf8');
      planSummary = path.basename(sourcePath, path.extname(sourcePath));
      console.log(`Reading plan from: ${sourcePath}`);
    } else {
      planContent = source;
      planSummary = source.substring(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim();
      console.log('Using inline plan text.');
    }

    console.log(`Target project: ${targetProject.name}`);
    console.log(`Plan summary: ${planSummary}`);
    console.log('');

    const agentId = e.resolveAgent('analyze', config) || e.resolveAgent('explore', config);
    if (!agentId) {
      console.log('No agents available. All agents are busy.');
      return;
    }

    const vars = {
      agent_id: agentId,
      agent_name: config.agents[agentId]?.name,
      agent_role: config.agents[agentId]?.role,
      project_name: targetProject.name || 'Unknown',
      project_path: targetProject.localPath || '',
      main_branch: targetProject.mainBranch || 'main',
      ado_org: targetProject.adoOrg || 'Unknown',
      ado_project: targetProject.adoProject || 'Unknown',
      repo_name: targetProject.repoName || 'Unknown',
      team_root: MINIONS_DIR,
      date: e.dateStamp(),
      plan_content: planContent,
      plan_summary: planSummary,
      project_name_lower: (targetProject.name || 'project').toLowerCase()
    };

    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });

    const prompt = e.renderPlaybook('plan-to-prd', vars);
    if (!prompt) {
      console.log('Error: Could not render plan-to-prd playbook.');
      return;
    }

    const id = e.addToDispatch({
      type: WORK_TYPE.PLAN_TO_PRD,
      agent: agentId,
      agentName: config.agents[agentId]?.name,
      agentRole: config.agents[agentId]?.role,
      task: `[${targetProject.name}] Generate PRD from plan: ${planSummary}`,
      prompt,
      meta: {
        source: 'plan',
        project: { name: targetProject.name, localPath: targetProject.localPath },
        planSummary
      }
    });

    console.log(`Dispatched: ${id} → ${config.agents[agentId]?.name} (${agentId})`);
    console.log('The agent will analyze your plan and generate a PRD in prd/.');

    const control = getControl();
    if (control.state === 'running') {
      const dispatch = getDispatch();
      const item = dispatch.pending.find(d => d.id === id);
      if (item) {
        e.spawnAgent(item, config);
        console.log('Agent spawned immediately.');
      }
    } else {
      console.log('Engine is not running — dispatch will happen on next tick after start.');
    }
  },

  sources() {
    const e = engine();
    const config = getConfig();
    const shared = require('./shared');
    const projects = shared.getProjects(config);

    console.log('\n=== Work Sources ===\n');

    for (const project of projects) {
      const root = shared.projectRoot(project);
      console.log(`── ${project.name || 'Project'} (${root}) ──\n`);

      const sources = project.workSources || config.workSources || {};
      for (const [name, src] of Object.entries(sources)) {
        const status = src.enabled ? 'ENABLED' : 'DISABLED';
        console.log(`  ${name}: ${status}`);

        let filePath = null;
        if (name === 'workItems') filePath = shared.projectWorkItemsPath(project);
        else if (name === 'pullRequests') filePath = shared.projectPrPath(project);
        else if (src.path) filePath = path.resolve(root, src.path);
        const exists = filePath && fs.existsSync(filePath);
        if (filePath) {
          console.log(`    Path: ${filePath} ${exists ? '(found)' : '(NOT FOUND)'}`);
        }
        console.log(`    Cooldown: ${src.cooldownMinutes || 0}m`);

        if (exists && name === 'prd') {
          const prd = safeJson(filePath);
          if (prd) {
            const missing = (prd.missing_features || []).filter(f => f.status === 'missing' || !f.status);
            console.log(`    Items: ${missing.length} missing features`);
          }
        }
        if (exists && name === 'pullRequests') {
          const prs = safeJson(filePath) || [];
          const pending = prs.filter(p => p.status === PR_STATUS.ACTIVE && (p.reviewStatus === 'pending' || p.reviewStatus === 'waiting'));
          const needsFix = prs.filter(p => p.status === PR_STATUS.ACTIVE && p.reviewStatus === 'changes-requested');
          console.log(`    PRs: ${pending.length} pending review, ${needsFix.length} need fixes`);
        }
        if (exists && name === 'workItems') {
          const items = safeJson(filePath) || [];
          const queued = items.filter(i => i.status === WI_STATUS.QUEUED);
          console.log(`    Items: ${queued.length} queued`);
        }
        if (name === 'specs' || name === 'mergedDesignDocs') {
          const trackerFile = path.join(shared.projectStateDir(project), 'spec-tracker.json');
          const tracker = safeJson(trackerFile) || { processedPrs: {} };
          const processed = Object.keys(tracker.processedPrs).length;
          const matched = Object.values(tracker.processedPrs).filter(p => p.matched).length;
          console.log(`    Processed: ${processed} merged PRs (${matched} had specs)`);
        }
        console.log('');
      }
    }
  },

  kill() {
    const e = engine();
    console.log('\n=== Kill All Active Work ===\n');
    const config = getConfig();
    const dispatch = getDispatch();
    const shared = require('./shared');

    const pidFiles = fs.readdirSync(ENGINE_DIR).filter(f => f.startsWith('pid-'));
    for (const f of pidFiles) {
      const pid = safeRead(path.join(ENGINE_DIR, f)).trim();
      try { process.kill(Number(pid)); console.log(`Killed process ${pid} (${f})`); } catch { console.log(`Process ${pid} already dead`); }
      fs.unlinkSync(path.join(ENGINE_DIR, f));
    }

    const killed = dispatch.active || [];
    for (const item of killed) {
      if (item.meta) {
        e.updateWorkItemStatus(item.meta, WI_STATUS.PENDING, '');
        const itemId = item.meta.item?.id;
        if (itemId) {
          const wiPath = (item.meta.source === 'central-work-item' || item.meta.source === 'central-work-item-fanout')
            ? path.join(MINIONS_DIR, 'work-items.json')
            : item.meta.project?.localPath
              ? shared.projectWorkItemsPath({ localPath: item.meta.project.localPath, name: item.meta.project.name, workSources: config.projects?.find(p => p.name === item.meta.project.name)?.workSources })
              : null;
          if (wiPath) {
            const items = safeJson(wiPath) || [];
            const target = items.find(i => i.id === itemId);
            if (target) {
              target.status = WI_STATUS.PENDING;
              delete target.dispatched_at;
              delete target.dispatched_to;
              delete target.failReason;
              delete target.failedAt;
              safeWrite(wiPath, items);
            }
          }
        }
      }

      console.log(`Killed dispatch: ${item.id} (${item.agent}) — work item reset to pending`);
    }
    dispatch.active = [];
    safeWrite(DISPATCH_PATH, dispatch);

    // Agent status derived from dispatch.json — clearing dispatch.active is sufficient.
    console.log('All agents reset to idle (dispatch cleared)');

    console.log(`\nDone: ${killed.length} dispatches killed, agents reset.`);
  },

  cleanup() {
    const e = engine();
    const config = getConfig();
    console.log('\n=== Cleanup ===\n');
    const result = e.runCleanup(config, true);
    console.log(`\nDone: ${result.tempFiles} temp files, ${result.liveOutputs} live outputs, ${result.worktrees} worktrees, ${result.zombies} zombies cleaned.`);
  },

  'mcp-sync'() {
    console.log('MCP servers are read directly from ~/.claude.json — no sync needed.');
  },

  doctor() {
    const { doctor } = require('./preflight');
    doctor(MINIONS_DIR).then(ok => {
      if (!ok) process.exit(1);
    });
  },

  discover() {
    const e = engine();
    const config = getConfig();
    console.log('\n=== Work Discovery (dry run) ===\n');

    e.materializePlansAsWorkItems(config);
    const prWork = e.discoverFromPrs(config);
    const workItemWork = e.discoverFromWorkItems(config);

    const all = [...prWork, ...workItemWork];

    if (all.length === 0) {
      console.log('No new work discovered from any source.');
    } else {
      console.log(`Found ${all.length} items:\n`);
      for (const w of all) {
        console.log(`  [${w.meta?.source}] ${w.type} → ${w.agent}: ${w.task}`);
      }
    }
    console.log('');
  }
};

module.exports = { handleCommand };

