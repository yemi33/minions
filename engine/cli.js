/**
 * engine/cli.js — CLI command handlers for Squad engine.
 * Extracted from engine.js to reduce monolith size.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeRead, safeJson, safeWrite } = shared;
const queries = require('./queries');
const { getConfig, getControl, getDispatch, getAgentStatus,
  SQUAD_DIR, ENGINE_DIR, AGENTS_DIR, PLANS_DIR, PRD_DIR, CONTROL_PATH, DISPATCH_PATH } = queries;

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
    console.log('  complete <id>    Mark dispatch as done');
    console.log('  cleanup           Clean temp files, worktrees, zombies');
    console.log('  mcp-sync         Sync MCP servers from ~/.claude.json');
    process.exit(1);
  }
}

const commands = {
  start() {
    const e = engine();
    const control = getControl();
    if (control.state === 'running') {
      let alive = false;
      if (control.pid) {
        try { process.kill(control.pid, 0); alive = true; } catch {}
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
    const interval = config.engine?.tickInterval || 60000;

    const { getProjects } = require('./shared');
    const projects = getProjects(config);
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
        } catch {}

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
            } catch {}
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
              const wiPath = path.join(SQUAD_DIR, "projects", item.meta.project.name, "work-items.json");
              const wiItems = safeJson(wiPath) || [];
              const wi = wiItems.find(w => w.id === item.meta.item.id);
              if (wi && wi.status !== 'dispatched') {
                wi.status = 'dispatched';
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
        const outputPath = path.join(SQUAD_DIR, 'agents', agentId, 'live-output.log');
        try {
          const stat = fs.statSync(outputPath);
          const output = fs.readFileSync(outputPath, 'utf8');

          // Check for completion markers in output
          const hasResult = output.includes('"type":"result"') || output.includes('"type": "result"');
          const hasError = output.includes('"is_error":true') || output.includes('"is_error": true');
          if (!hasResult && !hasError) continue;

          const isSuccess = hasResult && !hasError;
          const result = isSuccess ? 'success' : 'error';

          e.log('info', `Orphan recovery: ${agentId} (${item.id}) completed while engine was down — result: ${result}`);

          // Extract PRs from output
          let prsCreated = 0;
          try {
            prsCreated = lifecycle.syncPrsFromOutput(output, agentId, item.meta, config);
          } catch {}

          // Update work item status
          if (item.meta?.item?.id) {
            const status = isSuccess ? 'done' : 'failed';
            try {
              lifecycle.updateWorkItemStatus(item.meta, status, isSuccess ? '' : 'Completed while engine was down');
            } catch {
              // Direct file write fallback
              try {
                const projName = item.meta.project?.name;
                if (projName) {
                  const wiPath = path.join(SQUAD_DIR, 'projects', projName, 'work-items.json');
                  const items = safeJson(wiPath) || [];
                  const wi = items.find(w => w.id === item.meta.item.id);
                  if (wi) {
                    wi.status = status;
                    if (isSuccess) { wi.completedAt = new Date().toISOString(); delete wi.failReason; }
                    else { wi.failedAt = new Date().toISOString(); wi.failReason = 'Completed while engine was down'; }
                    safeWrite(wiPath, items);
                  }
                }
              } catch {}
            }
          }

          // Move from active to completed in dispatch
          try { e.completeDispatch(item.id, result, isSuccess ? 'Completed (orphan recovery)' : 'Failed (orphan recovery)'); } catch {}

          // Check plan completion
          if (isSuccess && item.meta?.item?.sourcePlan) {
            try { lifecycle.checkPlanCompletion(item.meta, config); } catch {}
          }

          recovered++;
          console.log(`    ✓ Recovered ${agentId}: ${(item.task || '').slice(0, 60)} → ${result}${prsCreated ? ' (' + prsCreated + ' PR)' : ''}`);
        } catch {}
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
      const allWiPaths = [path.join(SQUAD_DIR, 'work-items.json')];
      for (const p of projects) {
        allWiPaths.push(path.join(SQUAD_DIR, "projects", p.name, "work-items.json"));
      }
      for (const wiPath of allWiPaths) {
        try {
          const items = safeJson(wiPath) || [];
          let changed = false;
          for (const item of items) {
            if (item.status === 'dispatched' && !activeIds.has(item.id)) {
              item.status = 'pending';
              delete item.dispatched_at;
              delete item.dispatched_to;
              changed = true;
              fixes++;
              e.log('info', `Recovery: reset stuck item ${item.id} from dispatched → pending`);
            }
          }
          if (changed) safeWrite(wiPath, items);
        } catch {}
      }

      try {
        const centralItems = safeJson(path.join(SQUAD_DIR, 'work-items.json')) || [];
        const hasPlanToPrd = centralItems.some(w => w.type === 'plan-to-prd' && (w.status === 'pending' || w.status === 'dispatched'));
        const donePlanChains = centralItems.filter(w =>
          w.type === 'plan' && w.status === 'done' && w.chain === 'plan-to-prd'
        );
        if (donePlanChains.length > 0 && !hasPlanToPrd) {
          const planDir = path.join(SQUAD_DIR, 'plans');
          const prdDir = path.join(SQUAD_DIR, 'prd');
          const jsonFiles = fs.existsSync(prdDir) ? fs.readdirSync(prdDir).filter(f => f.endsWith('.json')) : [];
          const mdFiles = fs.existsSync(planDir) ? fs.readdirSync(planDir).filter(f => f.endsWith('.md')) : [];

          for (const planItem of donePlanChains) {
            const expectedMd = planItem._planFileName;
            const planFile = expectedMd || mdFiles[mdFiles.length - 1];
            const alreadyDone = centralItems.some(w =>
              w.type === 'plan-to-prd' && w.status === 'done' && w.planFile === planFile
            );
            if (alreadyDone) continue;
            const mdExists = expectedMd ? fs.existsSync(path.join(planDir, expectedMd)) : mdFiles.length > 0;
            if (mdExists && jsonFiles.length === 0) {
              centralItems.push({
                id: 'W-' + shared.uid(),
                title: 'Convert plan to PRD: ' + (planItem.title || planFile),
                type: 'plan-to-prd',
                priority: 'high',
                description: 'Plan file: plans/' + planFile + '\nRecovery: re-queued after engine restart',
                status: 'pending',
                created: e.ts(),
                createdBy: 'engine:recovery',
                project: planItem.project || '',
                planFile: planFile,
              });
              safeWrite(path.join(SQUAD_DIR, 'work-items.json'), centralItems);
              fixes++;
              e.log('info', `Recovery: re-queued plan-to-prd for ${planFile} (chain was broken)`);
              break;
            }
          }
        }
      } catch {}

      try {
        const centralItems = safeJson(path.join(SQUAD_DIR, 'work-items.json')) || [];
        const pendingPlanToPrd = centralItems.filter(w => w.type === 'plan-to-prd' && w.status === 'pending');
        if (pendingPlanToPrd.length === 0) {
          const planDir = path.join(SQUAD_DIR, 'plans');
          const prdDir = path.join(SQUAD_DIR, 'prd');
          if (fs.existsSync(planDir)) {
            const mdFiles = fs.readdirSync(planDir).filter(f => f.endsWith('.md'));
            const jsonFiles = fs.existsSync(prdDir) ? fs.readdirSync(prdDir).filter(f => f.endsWith('.json')) : [];
            for (const md of mdFiles) {
              const base = md.replace(/\.md$/, '');
              const hasJson = jsonFiles.some(j => j.includes(base) || j.includes(base.replace(/^plan-/, '')));
              if (!hasJson) {
                const alreadyDone = centralItems.some(w =>
                  w.type === 'plan-to-prd' && w.status === 'done' && w.planFile === md
                );
                // Only recover plans that were previously queued for conversion (not unexecuted drafts)
                const wasPreviouslyQueued = centralItems.some(w =>
                  w.type === 'plan-to-prd' && w.planFile === md
                );
                if (!alreadyDone && wasPreviouslyQueued) {
                  centralItems.push({
                    id: 'W-' + shared.uid(),
                    title: 'Convert plan to PRD: ' + md,
                    type: 'plan-to-prd',
                    priority: 'high',
                    description: 'Plan file: plans/' + md + '\nRecovery: orphaned plan with no PRD',
                    status: 'pending',
                    created: e.ts(),
                    createdBy: 'engine:recovery',
                    project: '',
                    planFile: md,
                  });
                  safeWrite(path.join(SQUAD_DIR, 'work-items.json'), centralItems);
                  fixes++;
                  e.log('info', `Recovery: queued plan-to-prd for orphaned plan ${md}`);
                  break;
                }
              }
            }
          }
        }
      } catch {}

      if (fixes > 0) {
        console.log(`  Recovery: fixed ${fixes} broken state issue(s)`);
      }
    })();

    // Initial tick
    e.tick();

    // Start tick loop
    setInterval(() => e.tick(), interval);
    console.log(`Tick interval: ${interval / 1000}s | Max concurrent: ${config.engine?.maxConcurrent || 3}`);
    console.log('Press Ctrl+C to stop');
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
      try { process.kill(control.pid); } catch {}
    }
    safeWrite(CONTROL_PATH, { state: 'stopped', stopped_at: e.ts() });
    e.log('info', 'Engine stopped');
    console.log('Engine stopped.');
  },

  pause() {
    const e = engine();
    safeWrite(CONTROL_PATH, { state: 'paused', paused_at: e.ts() });
    e.log('info', 'Engine paused');
    console.log('Engine paused. Run `node .squad/engine.js resume` to resume.');
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

    console.log('\n=== Squad Engine ===\n');
    console.log(`State: ${control.state}`);
    console.log(`PID: ${control.pid || 'N/A'}`);
    console.log(`Projects: ${projects.map(p => p.name || 'unnamed').join(', ')}`);
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
      console.log('Usage: node .squad/engine.js complete <dispatch-id>');
      return;
    }
    engine().completeDispatch(id, 'success');
    console.log(`Marked ${id} as completed.`);
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
      console.log('Usage: node .squad/engine.js spawn <agent-id> "<prompt>"');
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
      console.log('Usage: node .squad/engine.js work "<title>" [options-json]');
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
      status: 'queued',
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
      console.log('Usage: node .squad/engine.js plan <source> [project]');
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
      console.log('No projects configured. Run: node squad.js add <dir>');
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
      team_root: SQUAD_DIR,
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
      type: 'plan-to-prd',
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
            const missing = (prd.missing_features || []).filter(f => ['missing', 'planned'].includes(f.status));
            console.log(`    Items: ${missing.length} missing/planned features`);
          }
        }
        if (exists && name === 'pullRequests') {
          const prs = safeJson(filePath) || [];
          const pending = prs.filter(p => p.status === 'active' && (p.reviewStatus === 'pending' || p.reviewStatus === 'waiting'));
          const needsFix = prs.filter(p => p.status === 'active' && p.reviewStatus === 'changes-requested');
          console.log(`    PRs: ${pending.length} pending review, ${needsFix.length} need fixes`);
        }
        if (exists && name === 'workItems') {
          const items = safeJson(filePath) || [];
          const queued = items.filter(i => i.status === 'queued');
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
        e.updateWorkItemStatus(item.meta, 'pending', '');
        const itemId = item.meta.item?.id;
        if (itemId) {
          const wiPath = (item.meta.source === 'central-work-item' || item.meta.source === 'central-work-item-fanout')
            ? path.join(SQUAD_DIR, 'work-items.json')
            : item.meta.project?.localPath
              ? shared.projectWorkItemsPath({ localPath: item.meta.project.localPath, name: item.meta.project.name, workSources: config.projects?.find(p => p.name === item.meta.project.name)?.workSources })
              : null;
          if (wiPath) {
            const items = safeJson(wiPath) || [];
            const target = items.find(i => i.id === itemId);
            if (target) {
              target.status = 'pending';
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
