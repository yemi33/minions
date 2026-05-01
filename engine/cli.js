/**
 * engine/cli.js — CLI command handlers for Minions engine.
 * Extracted from engine.js to reduce monolith size.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite, mutateControl, mutateWorkItems, ts, WI_STATUS, WORK_TYPE, PLAN_STATUS, PR_STATUS, DISPATCH_RESULT } = shared;
const queries = require('./queries');
const { getConfig, getControl, getDispatch, getAgentStatus,
  MINIONS_DIR, ENGINE_DIR, AGENTS_DIR, PLANS_DIR, PRD_DIR, CONTROL_PATH, DISPATCH_PATH } = queries;

// Lazy require — only for engine-specific functions (log, ts, tick, addToDispatch, etc.)
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

let _dispatchModule = null;
function dispatchModule() { if (!_dispatchModule) _dispatchModule = require('./dispatch'); return _dispatchModule; }

function isEngineProcessAlive(control) {
  if (!control?.pid) return false;
  if (control.pid === process.pid) return true;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      return new RegExp(`\\b${control.pid}\\b`).test(out) && out.toLowerCase().includes('node');
    }
    process.kill(control.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function handleCommand(cmd, args) {
  if (!cmd) {
    return commands.start();
  } else if (commands[cmd]) {
    return commands[cmd](...args);
  } else {
    console.log(`Unknown command: ${cmd}`);
    console.log('Commands:');
    console.log('  start [--cli R] [--model M]   Start engine daemon (R = registered runtime)');
    console.log('  stop                          Stop engine');
    console.log('  pause / resume                Pause/resume dispatching');
    console.log('  status                        Show engine + agent state + fleet config');
    console.log('  queue                         Show dispatch queue');
    console.log('  sources                       Show work source status');
    console.log('  discover                      Dry-run work discovery');
    console.log('  dispatch                      Force a dispatch cycle');
    console.log('  spawn <a> <p>                 Manually spawn agent with prompt');
    console.log('  work <title> [o]              Add to work-items.json queue');
    console.log('  plan <src> [p]                Generate PRD from a plan (file or text)');
    console.log('  kill                          Kill all active agents, reset to pending');
    console.log('  complete <id>                 Mark a dispatch as done');
    console.log('  cleanup                       Clean temp files, worktrees, zombies');
    console.log('  mcp-sync                      Sync MCP servers from ~/.claude.json');
    console.log('  doctor                        Check prerequisites and runtime health');
    console.log('  config set-cli <R> [--model M]  Persist defaultCli/defaultModel without starting');
    process.exit(1);
  }
}

// ─── Runtime fleet flags (--cli / --model / --effort) ────────────────────────
//
// Shared by `start`, `restart`, and `config set-cli`. Single source of truth
// for: flag parsing, runtime validation, incompatibility heuristics, and the
// atomic config write. AC: "All config writes use mutateJsonFileLocked on
// config.json" — the helper below is the only caller that mutates fleet keys.

/**
 * Strip `--cli <name>` / `--model <value>` / `--effort <level>` from `args`
 * (in-place), including `--flag=value` forms. Returns
 * `{ cli, model, effort, modelExplicit, errors }`. `modelExplicit` distinguishes
 * "user passed --model with empty string" (clear) from "no flag" (no-op).
 *
 * Errors (e.g. `--cli` with no follow-up token) are collected for the caller
 * to print + exit-non-zero, instead of throwing — matches existing CLI flow.
 */
function _parseRuntimeFlags(args) {
  const out = { cli: undefined, model: undefined, effort: undefined, modelExplicit: false, errors: [] };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const eq = typeof a === 'string' ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = eq > 0 ? a.slice(eq + 1) : undefined;
    const readValue = (name, { allowEmpty = false, hint = '' } = {}) => {
      if (inlineValue !== undefined) {
        if (!allowEmpty && inlineValue === '') {
          out.errors.push(`${name} requires a value${hint}`);
          args.splice(i, 1);
          return { ok: false };
        }
        args.splice(i, 1);
        return { ok: true, value: inlineValue };
      }
      if (i + 1 >= args.length || String(args[i + 1]).startsWith('--')) {
        out.errors.push(`${name} requires a value${hint}`);
        args.splice(i, 1);
        return { ok: false };
      }
      const value = String(args[i + 1]);
      args.splice(i, 2);
      return { ok: true, value };
    };
    if (flag === '--cli') {
      const parsed = readValue('--cli');
      if (parsed.ok) out.cli = parsed.value;
    } else if (flag === '--model') {
      const parsed = readValue('--model', { allowEmpty: true, hint: ' (use --model "" to clear)' });
      if (!parsed.ok) continue;
      out.model = parsed.value;
      out.modelExplicit = true;
    } else if (flag === '--effort') {
      const parsed = readValue('--effort');
      if (parsed.ok) out.effort = parsed.value;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Heuristic flag for "this model is obviously wrong for this runtime". Used
 * to surface the "pass --model '' to clear" hint when a user switches CLIs
 * but leaves a stale model behind. Errs on the side of false-negatives —
 * unknown runtime → no opinion, unknown model on Copilot → no opinion.
 */
function _modelLooksIncompatible(runtime, model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (runtime === 'claude') {
    if (m.startsWith('claude-')) return false;
    if (m === 'sonnet' || m === 'opus' || m === 'haiku') return false;
    return true; // gpt-*, o3-*, codex, etc. — wrong CLI for these
  }
  if (runtime === 'copilot') {
    // Copilot accepts the full catalog by ID; only Claude shorthands are wrong.
    return m === 'sonnet' || m === 'opus' || m === 'haiku';
  }
  return false;
}

/**
 * Apply parsed `--cli`/`--model` flags to `config.json`. Returns
 * `{ warnings, applied }`. Throws when the runtime name is unknown — caller
 * decides whether to exit (start/restart/config-set-cli all do).
 *
 * Per-agent `cli` / `model` overrides under `config.agents.*` are NEVER
 * touched. Only `engine.defaultCli`, `engine.defaultModel`, `engine.ccCli`,
 * `engine.ccModel` are written. CC overrides are cleared on every fleet
 * change so the user's intent ("switch the whole fleet to X") is honored.
 */
function _applyRuntimeFlags({ cli, model, modelExplicit }) {
  const warnings = [];
  if (cli === undefined && !modelExplicit) {
    return { warnings, applied: false };
  }

  // Validate the runtime name BEFORE touching disk so typos fail loudly with
  // a list of registered runtimes — same UX shape as resolveRuntime() throws.
  let registered = [];
  try { registered = require('./runtimes').listRuntimes(); }
  catch { /* registry missing during partial install — skip validation */ }
  if (cli !== undefined && registered.length > 0 && !registered.includes(cli)) {
    const err = new Error(`Unknown CLI runtime "${cli}". Registered runtimes: ${registered.join(', ')}`);
    err._unknownCli = true;
    throw err;
  }

  const CONFIG_PATH = path.join(shared.MINIONS_DIR, 'config.json');
  shared.mutateJsonFileLocked(CONFIG_PATH, (cfg) => {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return cfg;
    cfg.engine = cfg.engine || {};
    const e = cfg.engine;

    if (cli !== undefined) {
      // Effective post-write defaultModel: if the same call also passed --model,
      // use that value; otherwise the existing on-disk defaultModel wins.
      let effectiveModel;
      if (modelExplicit) effectiveModel = (model === '' ? undefined : model);
      else effectiveModel = e.defaultModel;
      if (_modelLooksIncompatible(cli, effectiveModel)) {
        warnings.push(`defaultModel "${effectiveModel}" appears incompatible with --cli ${cli}. Pass --model '' to clear it.`);
      }

      // Surface the implicit clear of an explicitly-set ccCli before doing it,
      // so users discover that fleet flags reset CC overrides.
      if (e.ccCli !== undefined && e.ccCli !== null && e.ccCli !== '') {
        warnings.push(`Clearing engine.ccCli (was "${e.ccCli}") so CC inherits the new defaultCli.`);
      }

      e.defaultCli = cli;
      delete e.ccCli;
    }

    if (modelExplicit) {
      if (model === '') delete e.defaultModel;
      else e.defaultModel = model;
      delete e.ccModel;
    }
    return cfg;
  });

  return { warnings, applied: true };
}

const commands = {
  start(...startArgs) {
    // Apply --cli / --model fleet flags before any engine wiring touches
    // config — the rest of start() reads config.engine assuming it's already
    // been mutated. Unknown runtime exits non-zero with the registered list.
    const flags = _parseRuntimeFlags(startArgs);
    if (flags.errors.length > 0) {
      for (const msg of flags.errors) console.error(`error: ${msg}`);
      process.exit(2); // 2 = misuse of shell builtins / bad CLI args
    }
    try {
      const { warnings } = _applyRuntimeFlags(flags);
      for (const w of warnings) console.log(`  ! ${w}`);
    } catch (err) {
      if (err && err._unknownCli) {
        console.error(`error: ${err.message}`);
        process.exit(2);
      }
      throw err;
    }

    // Startup state-file size guard (#1167): dispatch.json / cooldowns.json
    // bloated past 100 MB silently OOMed V8 on JSON.parse at startup. Fail fast
    // with an actionable message instead.
    try {
      for (const fp of [DISPATCH_PATH, path.join(ENGINE_DIR, 'cooldowns.json')]) {
        shared.assertStateFileSize(fp);
      }
    } catch (stateErr) {
      console.error('\n[engine] STARTUP ABORTED — ' + stateErr.message + '\n');
      process.exit(78); // 78 = configuration error
    }

    // Run preflight checks (warn but don't block — engine may still be useful)
    try {
      const { runPreflight, printPreflight } = require('./preflight');
      // Pass config so runtime-fleet warnings (P-3b8e5f1d) can fire pre-start.
      // getConfig() is cheap (cached); failure here is non-fatal — preflight
      // simply skips the runtime-config warnings when config is missing.
      let preflightConfig = null;
      try { preflightConfig = getConfig(); } catch { /* missing config handled below */ }
      const { results } = runPreflight({ config: preflightConfig });
      const hasFatal = results.some(r => r.ok === false);
      if (hasFatal) {
        printPreflight(results, { label: 'Preflight checks' });
        console.log('  Some checks failed — agents may not work. Run `minions doctor` for details.\n');
      } else {
        // Even on no-fatal startup, surface fleet-config warnings so users see
        // them inline during `minions start` (rather than only via doctor).
        const warns = results.filter(r => r.ok === 'warn');
        for (const w of warns) console.log(`  ! ${w.name}: ${w.message}`);
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

    // Record version + git commit so dashboard can detect stale engine code
    // Bust require cache so npm updates are detected after minions restart
    let codeVersion = null;
    try {
      const pkgPath = require.resolve('../package.json');
      delete require.cache[pkgPath];
      codeVersion = require('../package.json').version;
    } catch {}
    if (!codeVersion) {
      try {
        const pkgPath = require.resolve('@yemi33/minions/package.json');
        delete require.cache[pkgPath];
        codeVersion = require('@yemi33/minions/package.json').version;
      } catch {}
    }
    let codeCommit = null;
    try { codeCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000, windowsHide: true }).trim(); } catch {}
    mutateControl(() => ({ state: 'running', pid: process.pid, started_at: e.ts(), codeVersion, codeCommit }));
    // Keep .minions-version in sync so `minions version` stays accurate after git pulls
    if (codeVersion) {
      try { fs.writeFileSync(path.join(shared.MINIONS_DIR, '.minions-version'), codeVersion); } catch {}
    }
    e.log('info', 'Engine started');
    console.log(`Engine started (PID: ${process.pid})`);

    const config = getConfig();
    // P-3b8e5f1d: promote legacy `engine.ccModel` to `engine.defaultModel` in
    // memory so single-model installs keep working after the runtime fleet
    // refactor. No disk write — the on-disk config still carries `ccModel`.
    try { shared.applyLegacyCcModelMigration(config, { logger: e.log }); }
    catch (err) { e.log('warn', `legacy ccModel migration failed: ${err.message}`); }
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

        const safeId = item.id.replace(/[:\\/*?"<>|]/g, '-');
        const pidFile = path.join(ENGINE_DIR, 'tmp', `pid-${safeId}.pid`);
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

        const hadPid = agentPid && agentPid > 0; // track before liveness check
        if (agentPid && agentPid > 0) {
          try {
            if (process.platform === 'win32') {
              const out = exec(`tasklist /FI "PID eq ${agentPid}" /NH`, { encoding: 'utf8', timeout: 3000 }).trim();
              if (!new RegExp(`\\b${agentPid}\\b`).test(out)) agentPid = null;
            } else {
              process.kill(agentPid, 0);
            }
          } catch { agentPid = null; }
        }

        // PID was found but confirmed dead — exempt from restart grace period (#869)
        if (hadPid && !agentPid) {
          e.engineRestartGraceExempt.add(item.id);
        }

        if (agentPid) {
          // Load sessionId from session.json for steering support
          let sessionId = null;
          try {
            const sj = safeJson(path.join(AGENTS_DIR, agentId, 'session.json'));
            if (sj?.sessionId) sessionId = sj.sessionId;
          } catch {}
          e.activeProcesses.set(item.id, { proc: { pid: agentPid > 0 ? agentPid : null }, agentId, startedAt: item.created_at, reattached: true, sessionId });
          // Sync work item status to dispatched — atomic write to avoid lifecycle lazy init issues
          if (item.meta?.item?.id && item.meta?.project?.localPath) {
            try {
              const wiPath = path.join(MINIONS_DIR, "projects", item.meta.project.name, "work-items.json");
              mutateWorkItems(wiPath, items => {
                const wi = items.find(w => w.id === item.meta.item.id);
                if (wi && wi.status !== WI_STATUS.DISPATCHED) {
                  wi.status = WI_STATUS.DISPATCHED;
                  wi.dispatched_to = wi.dispatched_to || agentId;
                  wi.dispatched_at = wi.dispatched_at || ts();
                }
              });
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
          const output = fs.readFileSync(outputPath, 'utf8');

          // Only process if the session actually emitted a result line — no result means the
          // session was still running when the engine died and should be requeued, not failed.
          // Tool-level is_error:true (e.g. a Read on a missing file) must not be confused with
          // a session-level error, so we scope the is_error check to the result line only.
          const resultIdx = output.search(/"type"\s*:\s*"result"/);
          if (resultIdx === -1) continue;

          const resultLineEnd = output.indexOf('\n', resultIdx);
          const resultLine = output.slice(resultIdx, resultLineEnd === -1 ? output.length : resultLineEnd);
          const hasError = resultLine.includes('"is_error":true') || resultLine.includes('"is_error": true');

          let isSuccess = !hasError;

          // Extract PRs from output first — if PRs were created, the agent succeeded
          // regardless of intermediate error lines in the log
          let prsCreated = 0;
          try {
            prsCreated = lifecycle.syncPrsFromOutput(output, agentId, item.meta, config);
          } catch (err) { e.log('warn', `Orphan PR sync: ${err.message}`); }

          // If PRs were created or a matching PR exists, treat as success
          if (!isSuccess && prsCreated > 0) {
            e.log('info', `Orphan recovery: ${agentId} (${item.id}) has ${prsCreated} PR(s) — overriding to success`);
            isSuccess = true;
          }

          // Fallback: check pull-requests.json for a matching PR by work item ID
          if (!isSuccess && item.meta?.item?.id) {
            try {
              const projName = item.meta.project?.name;
              if (projName) {
                const prPath = path.join(MINIONS_DIR, 'projects', projName, 'pull-requests.json');
                const prs = safeJson(prPath) || [];
                const matchingPr = prs.find(pr =>
                  (pr.prdItems || []).includes(item.meta.item.id) &&
                  pr.status !== 'abandoned' && pr.status !== 'closed'
                );
                if (matchingPr) {
                  e.log('info', `Orphan recovery: ${agentId} (${item.id}) has matching PR ${matchingPr.id} — overriding to success`);
                  isSuccess = true;
                }
              }
            } catch (err) { e.log('warn', `Orphan PR lookup: ${err.message}`); }
          }

          const result = isSuccess ? DISPATCH_RESULT.SUCCESS : DISPATCH_RESULT.ERROR;
          e.log('info', `Orphan recovery: ${agentId} (${item.id}) completed while engine was down — result: ${result}`);

          // Update work item status
          if (item.meta?.item?.id) {
            const status = isSuccess ? WI_STATUS.DONE : WI_STATUS.FAILED;
            try {
              lifecycle.updateWorkItemStatus(item.meta, status, isSuccess ? '' : 'Completed while engine was down');
            } catch {
              // Atomic file write fallback
              try {
                const projName = item.meta.project?.name;
                if (projName) {
                  const wiPath = path.join(MINIONS_DIR, 'projects', projName, 'work-items.json');
                  mutateWorkItems(wiPath, items => {
                    const wi = items.find(w => w.id === item.meta.item.id);
                    if (wi) {
                      wi.status = status;
                      if (isSuccess) { wi.completedAt = ts(); delete wi.failReason; }
                      else { wi.failedAt = ts(); wi.failReason = 'Completed while engine was down'; }
                    }
                  });
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
          mutateWorkItems(wiPath, items => {
            for (const item of items) {
              if (item.status === WI_STATUS.DISPATCHED && !activeIds.has(item.id)) {
                item.status = WI_STATUS.PENDING;
                delete item.dispatched_at;
                delete item.dispatched_to;
                fixes++;
                e.log('info', `Recovery: reset stuck item ${item.id} from dispatched → pending`);
              }
            }
          });
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

    // Fast poll: check steering every 1s (lightweight — just fs.stat per agent)
    // and wakeup signals every 1s (control.json read)
    const { checkSteering } = require('./timeout');
    const fastPollTimer = setInterval(() => {
      try { checkSteering(); } catch {}
      const ctrl = getControl();
      if (ctrl._wakeupAt && Date.now() - ctrl._wakeupAt < 5000) {
        delete ctrl._wakeupAt;
        mutateControl((control) => {
          delete control._wakeupAt;
          return control;
        });
        e.tick();
      }
    }, 1000);

    // Teams inbox poll timer — process incoming Teams messages through CC
    const teams = require('./teams');
    const teamsInboxInterval = config.teams?.inboxPollInterval ?? shared.ENGINE_DEFAULTS.teams.inboxPollInterval;
    const teamsInboxTimer = teams.isTeamsEnabled() ? setInterval(() => {
      try {
        const ctrl = getControl();
        if (ctrl.state !== 'running') return;
        teams.processTeamsInbox().catch(err => {
          shared.log('warn', `Teams inbox poll error: ${err.message}`);
        });
      } catch {}
    }, teamsInboxInterval) : null;

    console.log(`Tick interval: ${interval / 1000}s | Max concurrent: ${config.engine?.maxConcurrent || 5}`);
    console.log('Press Ctrl+C to stop');

    // File-change-driven work discovery — trigger tick when work-items or PRDs change
    const _watchedFiles = new Set();
    let _globalDebounce = null;
    function watchForWorkChanges() {
      const filesToWatch = [
        path.join(MINIONS_DIR, 'work-items.json'),
        // dispatch.json excluded — it changes every tick, causing a feedback loop
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
            }, 5000);
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
      clearInterval(fastPollTimer);
      if (teamsInboxTimer) clearInterval(teamsInboxTimer);
      for (const f of _watchedFiles) { try { fs.unwatchFile(f); } catch { /* cleanup */ } }
      mutateControl(() => ({ state: 'stopping', pid: process.pid, stopping_at: e.ts() }));
      e.log('info', `Graceful shutdown initiated (${signal})`);

      if (e.activeProcesses.size === 0) {
        mutateControl(() => ({ state: 'stopped', stopped_at: e.ts() }));
        e.log('info', 'Graceful shutdown complete (no active agents)');
        shared.flushLogs(); // drain buffered log entries before exit
        console.log('No active agents — stopped.');
        process.exit(0);
      }

      console.log(`Waiting for ${e.activeProcesses.size} active agent(s) to finish...`);
      const timeout = config.engine?.shutdownTimeout || shared.ENGINE_DEFAULTS.shutdownTimeout;
      const deadline = Date.now() + timeout;

      const poll = setInterval(() => {
        if (e.activeProcesses.size === 0) {
          clearInterval(poll);
          mutateControl(() => ({ state: 'stopped', stopped_at: e.ts() }));
          e.log('info', 'Graceful shutdown complete (all agents finished)');
          shared.flushLogs(); // drain buffered log entries before exit
          console.log('All agents finished — stopped.');
          process.exit(0);
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          mutateControl(() => ({ state: 'stopped', stopped_at: e.ts() }));
          e.log('warn', `Graceful shutdown timed out after ${timeout / 1000}s with ${e.activeProcesses.size} agent(s) still active`);
          shared.flushLogs(); // drain buffered log entries before exit
          console.log(`Shutdown timeout (${timeout / 1000}s) — force exiting with ${e.activeProcesses.size} agent(s) still running.`);
          process.exit(1);
        }
      }, 2000);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Crash handlers — log the error and exit cleanly so the process is detectable as crashed
    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
      console.error(`[FATAL] Unhandled promise rejection: ${msg}`);
      try { shared.log('fatal', `Unhandled promise rejection: ${msg}`); } catch { /* best effort */ }
      try { shared.flushLogs(); } catch { /* best effort */ }
      process.exit(1);
    });

    process.on('uncaughtException', (err) => {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      console.error(`[FATAL] Uncaught exception: ${msg}`);
      try { shared.log('fatal', `Uncaught exception: ${msg}`); } catch { /* best effort */ }
      try { shared.flushLogs(); } catch { /* best effort */ }
      process.exit(1);
    });
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
    mutateControl(() => ({ state: 'stopped', stopped_at: e.ts() }));
    e.log('info', 'Engine stopped');
    console.log('Engine stopped.');
  },

  pause() {
    const e = engine();
    mutateControl(() => ({ state: 'paused', paused_at: e.ts() }));
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
    mutateControl(() => ({ state: 'running', resumed_at: e.ts() }));
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

    // Fleet runtime config — what every spawn defaults to + every override.
    // Only fields that diverge from ENGINE_DEFAULTS are listed under "Flags",
    // so a clean install prints nothing extra and a tweaked install reads at
    // a glance. Per AC: defaultCli/defaultModel always shown, non-default
    // flags + CC overrides shown when set.
    const eng = config.engine || {};
    const defaultCli = shared.resolveAgentCli(null, eng);
    const defaultModelResolved = shared.resolveAgentModel(null, eng);
    console.log(`Default CLI: ${defaultCli}${eng.defaultCli ? '' : ' (default)'}`);
    console.log(`Default model: ${defaultModelResolved || '(runtime default)'}`);
    const ccCliOverride = (eng.ccCli !== undefined && eng.ccCli !== null && eng.ccCli !== '') ? String(eng.ccCli) : null;
    const ccModelOverride = (eng.ccModel !== undefined && eng.ccModel !== null && eng.ccModel !== '') ? String(eng.ccModel) : null;
    if (ccCliOverride || ccModelOverride) {
      console.log(`CC overrides: cli=${ccCliOverride || '(inherit)'}, model=${ccModelOverride || '(inherit)'}`);
    }
    const flagFields = [
      'claudeBareMode', 'claudeFallbackModel',
      'copilotDisableBuiltinMcps', 'copilotSuppressAgentsMd', 'copilotStreamMode', 'copilotReasoningSummaries',
      'maxBudgetUsd', 'disableModelDiscovery',
    ];
    const activeFlags = [];
    for (const f of flagFields) {
      if (eng[f] === undefined || eng[f] === null || eng[f] === '') continue;
      if (eng[f] === shared.ENGINE_DEFAULTS[f]) continue;
      activeFlags.push(`${f}=${JSON.stringify(eng[f])}`);
    }
    if (activeFlags.length > 0) console.log(`Flags: ${activeFlags.join(', ')}`);
    console.log('');

    console.log('Agents:');
    console.log(`  ${'ID'.padEnd(12)} ${'Name (Role)'.padEnd(30)} ${'Status'.padEnd(10)} Task`);
    console.log('  ' + '-'.repeat(70));
    for (const [id, agent] of Object.entries(agents)) {
      const status = getAgentStatus(id);
      console.log(`  ${id.padEnd(12)} ${`${agent.emoji} ${agent.name} (${agent.role})`.padEnd(30)} ${(status.status || 'idle').padEnd(10)} ${status.task || '-'}`);
    }

    console.log('');
    const metrics = shared.safeJson(path.join(__dirname, 'metrics.json')) || {};
    const lifetimeCompleted = Object.entries(metrics).filter(([k]) => !k.startsWith('_')).reduce((sum, [, m]) => sum + (m.tasksCompleted || 0) + (m.tasksErrored || 0), 0);
    console.log(`Dispatch: ${dispatch.pending.length} pending | ${(dispatch.active || []).length} active | ${lifetimeCompleted} completed`);
    console.log(`Active processes: ${e.activeProcesses.size}`);

    const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
    const metricsData = safeJson(metricsPath);
    if (metricsData && Object.keys(metricsData).length > 0) {
      console.log('\nMetrics:');
      console.log(`  ${'Agent'.padEnd(12)} ${'Done'.padEnd(6)} ${'Err'.padEnd(6)} ${'PRs'.padEnd(6)} ${'Appr'.padEnd(6)} ${'Rej'.padEnd(6)} ${'Reviews'.padEnd(8)} ${'Cost'.padEnd(8)}`);
      console.log('  ' + '-'.repeat(64));
      for (const [id, m] of Object.entries(metricsData)) {
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
    const control = getControl();
    if (control.state === 'running' && isEngineProcessAlive(control)) {
      mutateControl((c) => ({ ...c, _wakeupAt: Date.now() }));
      console.log(`Dispatch wakeup requested from running engine (PID ${control.pid}).`);
      return;
    }

    const activeCount = (getDispatch().active || []).length;
    if (activeCount > 0) {
      console.log(`Engine is not running, but ${activeCount} dispatch(es) are active.`);
      console.log('Refusing to run a local dispatch tick because it cannot track live agent processes.');
      console.log('Start the engine to re-attach or recover: node engine.js start');
      return;
    }

    console.log('Engine is not running. Start it to dispatch work: node engine.js start');
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
    let item;
    mutateWorkItems(wiPath, items => {
      item = {
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
    });

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
      main_branch: targetProject.localPath ? shared.resolveMainBranch(targetProject.localPath, targetProject.mainBranch) : (targetProject.mainBranch || 'main'),
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
    const shared = require('./shared');

    // Kill processes via PID files (expensive — outside dispatch lock).
    // PID files live in engine/tmp/ (see engine/spawn-agent.js:220 — derived from
    // the prompt-<id>.md sidecar path that engine.js builds in engine/tmp/).
    // Reading from ENGINE_DIR directly is a no-op: spawn-agent never writes there.
    const pidDir = path.join(ENGINE_DIR, 'tmp');
    const pidFiles = shared.safeReadDir(pidDir).filter(f => f.startsWith('pid-') && f.endsWith('.pid'));
    for (const f of pidFiles) {
      const pidPath = path.join(pidDir, f);
      const raw = safeRead(pidPath).trim();
      // Guard against falsy/zero/NaN PIDs. Empty pid files would resolve to
      // Number('') === 0, and process.kill(0) on POSIX targets the entire
      // calling process group — which would kill the engine itself.
      let pidNum = NaN;
      try { pidNum = shared.validatePid(raw); } catch { /* invalid — skip */ }
      if (pidNum > 0) {
        try { process.kill(pidNum); console.log(`Killed process ${pidNum} (${f})`); }
        catch { console.log(`Process ${pidNum} already dead`); }
      } else {
        console.log(`Skipping ${f}: invalid or empty PID`);
      }
      try { fs.unlinkSync(pidPath); } catch { /* may not exist */ }
    }

    // Atomically read and clear dispatch.active (locked read-modify-write)
    let killed = [];
    e.mutateDispatch((dispatch) => {
      killed = dispatch.active || [];
      dispatch.active = [];
      return dispatch;
    });

    // Reset work items outside the dispatch lock (work-items.json has its own lock)
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
            mutateWorkItems(wiPath, items => {
              const target = items.find(i => i.id === itemId);
              if (target) {
                target.status = WI_STATUS.PENDING;
                delete target.dispatched_at;
                delete target.dispatched_to;
                delete target.failReason;
                delete target.failedAt;
              }
            });
          }
        }
      }

      console.log(`Killed dispatch: ${item.id} (${item.agent}) — work item reset to pending`);
    }

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
    return doctor(MINIONS_DIR).then(ok => {
      if (!ok) process.exit(1);
    });
  },

  config(...configArgs) {
    const sub = configArgs[0];
    const rest = configArgs.slice(1);
    if (sub === 'set-cli') {
      const cliName = rest[0];
      if (!cliName || cliName.startsWith('--')) {
        console.error('Usage: minions config set-cli <runtime> [--model <model>]');
        let registered = [];
        try { registered = require('./runtimes').listRuntimes(); } catch {}
        if (registered.length > 0) console.error(`Registered runtimes: ${registered.join(', ')}`);
        process.exit(2);
      }
      // Drop the positional <runtime> token; whatever's left is parsed as flags.
      const flagArgs = rest.slice(1);
      const parsed = _parseRuntimeFlags(flagArgs);
      if (parsed.errors.length > 0) {
        for (const msg of parsed.errors) console.error(`error: ${msg}`);
        process.exit(2);
      }
      // Reject any leftover non-flag args — keeps the surface tight + catches typos.
      if (flagArgs.length > 0) {
        console.error(`error: unexpected arguments after set-cli: ${flagArgs.join(' ')}`);
        process.exit(2);
      }
      try {
        const { warnings } = _applyRuntimeFlags({
          cli: cliName,
          model: parsed.model,
          modelExplicit: parsed.modelExplicit,
        });
        for (const w of warnings) console.log(`  ! ${w}`);
        const modelDesc = parsed.modelExplicit
          ? (parsed.model === '' ? '(cleared)' : `"${parsed.model}"`)
          : '(unchanged)';
        console.log(`config: defaultCli="${cliName}", defaultModel=${modelDesc}, ccCli/ccModel cleared.`);
      } catch (err) {
        if (err && err._unknownCli) {
          console.error(`error: ${err.message}`);
          process.exit(2);
        }
        throw err;
      }
      return;
    }
    console.error('Usage: minions config set-cli <runtime> [--model <model>]');
    process.exit(2);
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

module.exports = {
  handleCommand,
  // exported for testing
  _parseRuntimeFlags,
  _modelLooksIncompatible,
  _applyRuntimeFlags,
};
