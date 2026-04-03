/**
 * engine/pipeline.js — Multi-stage pipeline orchestration.
 * Pipelines chain stages (task, meeting, plan, merge-prs, api, wait, parallel)
 * with dependency tracking and artifact discovery.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeJson, safeWrite, safeRead, safeReadDir, uid, log, ts, dateStamp, mutateJsonFileLocked, WI_STATUS, WORK_TYPE, PLAN_STATUS, PR_STATUS } = shared;
const { parseCronExpr, shouldRunNow } = require('./scheduler');

const PIPELINES_DIR = path.join(__dirname, '..', 'pipelines');
const PIPELINE_RUNS_PATH = path.join(__dirname, 'pipeline-runs.json');

// ── Pipeline CRUD ────────────────────────────────────────────────────────────

function getPipelines() {
  if (!fs.existsSync(PIPELINES_DIR)) return [];
  return safeReadDir(PIPELINES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => safeJson(path.join(PIPELINES_DIR, f)))
    .filter(Boolean);
}

function getPipeline(id) {
  const filePath = path.join(PIPELINES_DIR, id + '.json');
  return safeJson(filePath);
}

function savePipeline(pipeline) {
  if (!fs.existsSync(PIPELINES_DIR)) fs.mkdirSync(PIPELINES_DIR, { recursive: true });
  safeWrite(path.join(PIPELINES_DIR, pipeline.id + '.json'), pipeline);
}

function deletePipeline(id) {
  const filePath = path.join(PIPELINES_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ── Run State ────────────────────────────────────────────────────────────────

function getPipelineRuns() {
  return safeJson(PIPELINE_RUNS_PATH) || {};
}

function savePipelineRuns(runs) {
  safeWrite(PIPELINE_RUNS_PATH, runs);
}

function getActiveRun(pipelineId) {
  const runs = getPipelineRuns();
  const pipelineRuns = runs[pipelineId] || [];
  return pipelineRuns.find(r => r.status === 'running' || r.status === 'paused');
}

function startRun(pipelineId, pipeline) {
  const runId = `run-${uid()}`;
  const stages = {};
  for (const stage of (pipeline.stages || [])) {
    stages[stage.id] = { status: 'pending', artifacts: {} };
  }
  const run = { runId, pipelineId, startedAt: ts(), status: 'running', stages };

  mutateJsonFileLocked(PIPELINE_RUNS_PATH, (data) => {
    if (!data[pipelineId]) data[pipelineId] = [];
    // Keep last 10 runs per pipeline
    if (data[pipelineId].length >= 10) data[pipelineId] = data[pipelineId].slice(-9);
    data[pipelineId].push(run);
    return data;
  }, { defaultValue: {} });

  log('info', `Pipeline ${pipelineId}: started run ${runId}`);
  return run;
}

function updateRunStage(pipelineId, runId, stageId, updates) {
  mutateJsonFileLocked(PIPELINE_RUNS_PATH, (data) => {
    const runs = data[pipelineId] || [];
    const run = runs.find(r => r.runId === runId);
    if (run && run.stages[stageId]) {
      Object.assign(run.stages[stageId], updates);
    }
    return data;
  }, { defaultValue: {} });
}

function completeRun(pipelineId, runId, status) {
  mutateJsonFileLocked(PIPELINE_RUNS_PATH, (data) => {
    const runs = data[pipelineId] || [];
    const run = runs.find(r => r.runId === runId);
    if (run) { run.status = status; run.completedAt = ts(); }
    return data;
  }, { defaultValue: {} });
  log('info', `Pipeline ${pipelineId}: run ${runId} → ${status}`);
}

// ── Template Resolution ──────────────────────────────────────────────────────

function resolveTemplate(str, run) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\{\{stages\.(\w+)\.(\w+)\}\}/g, (_, stageId, field) => {
    const stage = run?.stages?.[stageId];
    if (!stage) return '';
    if (field === 'output') return stage.output || '';
    if (field === 'artifacts') return JSON.stringify(stage.artifacts || {});
    return stage[field] || '';
  });
}

function resolveStageConfig(stage, run) {
  const resolved = { ...stage };
  for (const key of ['title', 'description', 'agenda', 'body']) {
    if (typeof resolved[key] === 'string') resolved[key] = resolveTemplate(resolved[key], run);
    if (typeof resolved[key] === 'object' && resolved[key]) {
      for (const k of Object.keys(resolved[key])) {
        if (typeof resolved[key][k] === 'string') resolved[key][k] = resolveTemplate(resolved[key][k], run);
      }
    }
  }
  return resolved;
}

// ── Stage Execution ──────────────────────────────────────────────────────────

function executeStage(stage, run, pipeline, config) {
  const resolved = resolveStageConfig(stage, run);
  const stageState = run.stages[stage.id];

  switch (resolved.type) {
    case 'task':
      return executeTaskStage(resolved, stageState, run, config);
    case 'meeting':
      return executeMeetingStage(resolved, stageState, run, config);
    case 'plan':
      return executePlanStage(resolved, stageState, run, config);
    case 'api':
      return executeApiStage(resolved, stageState, run);
    case 'merge-prs':
      return executeMergePrsStage(resolved, stageState, run, config);
    case 'schedule':
      return executeScheduleStage(resolved, stageState, config);
    case 'wait':
      // wait stages just sit in waiting-human status until continued via API
      return { status: 'waiting-human' };
    case 'parallel':
      return executeParallelStage(resolved, stageState, run, pipeline, config);
    default:
      log('warn', `Pipeline: unknown stage type '${resolved.type}' in stage ${stage.id}`);
      return { status: 'failed', error: 'unknown stage type' };
  }
}

function executeTaskStage(stage, stageState, run, config) {
  // Create work item(s) for the task
  const items = stage.items || [{ title: stage.title, description: stage.description || '', type: stage.taskType || 'explore', agent: stage.agent }];
  const count = stage.count || items.length;
  const wiPath = path.join(__dirname, '..', 'work-items.json');
  const workItems = safeJson(wiPath) || [];
  const createdIds = [];

  for (let i = 0; i < count; i++) {
    const item = items[i % items.length];
    const id = `PL-${run.runId.slice(4, 12)}-${stage.id}-${i}`;
    if (workItems.some(w => w.id === id)) { createdIds.push(id); continue; }
    workItems.push({
      id,
      title: item.title || stage.title,
      description: item.description || stage.description || '',
      type: item.type || stage.taskType || 'explore',
      priority: item.priority || stage.priority || 'medium',
      agent: item.agent || stage.agent || '',
      status: WI_STATUS.PENDING,
      created: ts(),
      createdBy: 'pipeline:' + run.pipelineId,
      branch: `pipeline/${run.pipelineId}/${stage.id}`,
      _pipelineRun: run.runId,
      _pipelineStage: stage.id,
    });
    createdIds.push(id);
  }

  safeWrite(wiPath, workItems);
  return { status: 'running', artifacts: { workItems: createdIds } };
}

function executeMeetingStage(stage, stageState, run, config) {
  const { createMeeting } = require('./meeting');
  const agents = config.agents || {};
  const participants = stage.participants?.[0] === 'all'
    ? Object.keys(agents)
    : (stage.participants || Object.keys(agents));

  const meetings = stage.meetings || [{ title: stage.title, agenda: stage.agenda || stage.title }];
  const createdIds = [];

  for (const mtg of meetings) {
    const meeting = createMeeting({
      title: resolveTemplate(mtg.title, run),
      agenda: resolveTemplate(mtg.agenda || mtg.title, run),
      participants,
    });
    createdIds.push(meeting.id);
  }

  return { status: 'running', artifacts: { meetings: createdIds } };
}

function executePlanStage(stage, stageState, run, config) {
  // Create a plan .md file from the stage config + previous stage output
  const plansDir = path.join(__dirname, '..', 'plans');
  if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });

  const slug = (stage.title || 'pipeline-plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const filename = `${slug}-${dateStamp()}.md`;
  const filePath = shared.uniquePath(path.join(plansDir, filename));

  let content = `# ${stage.title}\n\n`;
  content += `**Created by:** Pipeline ${run.pipelineId}\n`;
  content += `**Date:** ${dateStamp()}\n\n---\n\n`;

  // Include output from dependency stages
  if (stage.dependsOn) {
    for (const depId of stage.dependsOn) {
      const depStage = run.stages[depId];
      if (depStage?.output) {
        content += `## From: ${depId}\n\n${depStage.output}\n\n`;
      }
    }
  }

  if (stage.description) content += stage.description + '\n';

  safeWrite(filePath, content);

  // Create plan-to-prd work item
  const wiPath = path.join(__dirname, '..', 'work-items.json');
  const workItems = safeJson(wiPath) || [];
  const wiId = `PL-${run.runId.slice(4, 12)}-${stage.id}-prd`;
  if (!workItems.some(w => w.id === wiId)) {
    workItems.push({
      id: wiId,
      title: `Convert plan to PRD: ${path.basename(filePath)}`,
      type: WORK_TYPE.PLAN_TO_PRD,
      priority: 'high',
      status: WI_STATUS.PENDING,
      planFile: path.basename(filePath),
      created: ts(),
      createdBy: 'pipeline:' + run.pipelineId,
      branch: `pipeline/${run.pipelineId}/${stage.id}`,
      _pipelineRun: run.runId,
      _pipelineStage: stage.id,
    });
    safeWrite(wiPath, workItems);
  }

  return {
    status: 'running',
    artifacts: {
      plans: [path.basename(filePath)],
      workItems: [wiId],
      prds: [], // discovered later when PRD materializes
      prs: [],  // discovered later when agents create PRs
    }
  };
}

function executeApiStage(stage, stageState, run) {
  const calls = stage.calls || [{ endpoint: stage.endpoint, method: stage.method || 'POST', body: stage.body }];
  for (const call of calls) {
    const url = `http://localhost:${process.env.MINIONS_PORT || 7331}${call.endpoint}`;
    const body = typeof call.body === 'string' ? call.body : JSON.stringify(call.body || {});
    // Fire and forget — use Node's http module
    try {
      const http = require('http');
      const parsed = new URL(url);
      const req = http.request({
        hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
        method: call.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      req.write(body);
      req.end();
    } catch (e) { log('warn', `Pipeline API call failed: ${e.message}`); }
  }
  return { status: 'completed', completedAt: ts() };
}

function executeMergePrsStage(stage, stageState, run, config) {
  // Collect all PR IDs from all previous stages in this run
  const prIds = [];
  for (const [, s] of Object.entries(run.stages)) {
    if (s.artifacts?.prs) prIds.push(...s.artifacts.prs);
  }
  if (prIds.length === 0) {
    return { status: 'completed', completedAt: ts(), output: 'No PRs to merge' };
  }
  // The actual merge will be handled by the PR polling/merge logic
  // We just need to track which PRs to watch
  return { status: 'running', artifacts: { prs: prIds } };
}

function executeScheduleStage(stage, stageState, config) {
  // Create/update schedules in config
  const schedules = stage.schedules || [{ id: stage.id + '-sched', cron: stage.cron, title: stage.title, type: stage.taskType || 'implement' }];
  // Write to config via shared
  for (const sched of schedules) {
    const existing = (config.schedules || []).find(s => s.id === sched.id);
    if (!existing) {
      config.schedules = config.schedules || [];
      config.schedules.push({ ...sched, enabled: true });
    }
  }
  safeWrite(path.join(__dirname, '..', 'config.json'), config);
  return { status: 'completed', completedAt: ts() };
}

function executeParallelStage(stage, stageState, run, pipeline, config) {
  const subStages = stage.stages || [];
  const subResults = {};
  for (const sub of subStages) {
    if (!run.stages[sub.id] || run.stages[sub.id].status === 'pending') {
      const result = executeStage(sub, run, pipeline, config);
      subResults[sub.id] = result;
      run.stages[sub.id] = { ...run.stages[sub.id] || {}, ...result, startedAt: ts() };
    }
  }
  // Parent is running until all subs complete
  return { status: 'running', artifacts: { subStages: subStages.map(s => s.id) } };
}

// ── Stage Completion Checks ──────────────────────────────────────────────────

function isStageComplete(stage, stageState, run, config) {
  if (stageState.status === 'completed' || stageState.status === 'failed') return true;
  if (stageState.status === 'pending' || stageState.status === 'waiting-human') return false;

  const artifacts = stageState.artifacts || {};

  switch (stage.type) {
    case 'task': {
      const wiPath = path.join(__dirname, '..', 'work-items.json');
      const workItems = safeJson(wiPath) || [];
      const ids = artifacts.workItems || [];
      if (ids.length === 0) return false;
      return ids.every(id => {
        const wi = workItems.find(w => w.id === id);
        return !wi || wi.status === WI_STATUS.DONE || wi.status === WI_STATUS.FAILED; // missing = treat as done
      });
    }
    case 'meeting': {
      const { getMeeting } = require('./meeting');
      const ids = artifacts.meetings || [];
      if (ids.length === 0) return false;
      return ids.every(id => {
        const m = getMeeting(id);
        return m && (m.status === 'completed' || m.status === 'archived');
      });
    }
    case 'plan': {
      // Plan stage completion: PRD conversion done + all materialized work items done
      const wiPath = path.join(__dirname, '..', 'work-items.json');
      const workItems = safeJson(wiPath) || [];
      const allProjectWi = shared.getProjects(config).reduce((acc, p) => {
        return acc.concat(safeJson(shared.projectWorkItemsPath(p)) || []);
      }, []);
      const all = [...workItems, ...allProjectWi];

      // Check if plan-to-prd work item is done
      const prdWiIds = artifacts.workItems || [];
      const prdDone = prdWiIds.every(id => {
        const wi = all.find(w => w.id === id);
        return !wi || wi.status === WI_STATUS.DONE || wi.status === WI_STATUS.FAILED; // missing = treat as done
      });
      if (!prdDone) return false;

      // Discover PRDs and their work items
      const prdDir = path.join(__dirname, '..', 'prd');
      const plans = artifacts.plans || [];
      for (const planFile of plans) {
        const prdFiles = fs.existsSync(prdDir) ? safeReadDir(prdDir).filter(f => f.endsWith('.json')) : [];
        for (const pf of prdFiles) {
          const prd = safeJson(path.join(prdDir, pf));
          if (prd?.source_plan === planFile && !(artifacts.prds || []).includes(pf)) {
            artifacts.prds = artifacts.prds || [];
            artifacts.prds.push(pf);
          }
        }
        // Find materialized work items for discovered PRDs
        for (const prdFile of (artifacts.prds || [])) {
          const prdItems = all.filter(w => w.sourcePlan === prdFile && w.type !== WORK_TYPE.PLAN_TO_PRD);
          for (const wi of prdItems) {
            if (!(artifacts.workItems || []).includes(wi.id)) {
              artifacts.workItems = artifacts.workItems || [];
              artifacts.workItems.push(wi.id);
            }
          }
        }
      }

      // Auto-approve if configured
      if (stage.autoApprove && artifacts.prds?.length > 0) {
        for (const prdFile of artifacts.prds) {
          const prdPath = path.join(prdDir, prdFile);
          const prd = safeJson(prdPath);
          if (prd && prd.status === PLAN_STATUS.AWAITING_APPROVAL) {
            prd.status = PLAN_STATUS.APPROVED;
            prd.approvedAt = ts();
            prd.approvedBy = 'pipeline:' + run.pipelineId;
            safeWrite(prdPath, prd);
            log('info', `Pipeline ${run.pipelineId}: auto-approved PRD ${prdFile}`);
          }
        }
      }

      // Check all materialized implement items are done
      const implementIds = (artifacts.workItems || []).filter(id => !prdWiIds.includes(id));
      if (implementIds.length === 0 && artifacts.prds?.length > 0) return false; // items not materialized yet
      return implementIds.every(id => {
        const wi = all.find(w => w.id === id);
        return !wi || wi.status === WI_STATUS.DONE || wi.status === WI_STATUS.FAILED; // missing = treat as done
      });
    }
    case 'merge-prs': {
      const prIds = artifacts.prs || [];
      if (prIds.length === 0) return true; // nothing to merge
      const projects = shared.getProjects(config);
      for (const project of projects) {
        const prs = safeJson(shared.projectPrPath(project)) || [];
        for (const prId of prIds) {
          const pr = prs.find(p => p.id === prId);
          if (pr && pr.status !== PR_STATUS.MERGED && pr.status !== PR_STATUS.ABANDONED) return false;
        }
      }
      return true;
    }
    case 'api':
    case 'schedule':
      return true; // fire-and-forget
    case 'wait':
      return stageState.status === 'completed';
    case 'parallel': {
      const subIds = artifacts.subStages || [];
      return subIds.every(id => {
        const sub = run.stages[id];
        return sub && (sub.status === 'completed' || sub.status === 'failed');
      });
    }
    default:
      return false;
  }
}

// ── Discovery (called per tick) ──────────────────────────────────────────────

function discoverPipelineWork(config) {
  const pipelines = getPipelines();
  if (pipelines.length === 0) return;

  const now = new Date();

  for (const pipeline of pipelines) {
    if (pipeline.enabled === false) continue;

    // Check for active run
    let activeRun = getActiveRun(pipeline.id);

    // Cron trigger: start new run if no active run
    if (!activeRun && pipeline.trigger?.cron) {
      try {
        const lastRuns = (getPipelineRuns()[pipeline.id] || []);
        const lastRun = lastRuns[lastRuns.length - 1];
        const lastRunAt = lastRun?.startedAt ? new Date(lastRun.startedAt) : null;
        if (shouldRunNow({ cron: pipeline.trigger.cron }, lastRunAt)) {
          activeRun = startRun(pipeline.id, pipeline);
        }
      } catch (e) { log('warn', `Pipeline cron check failed for ${pipeline.id}: ${e.message}`); }
    }

    if (!activeRun) continue;

    // Process active run — check stage completions and start ready stages
    let anyRunning = false;
    let anyFailed = false;
    let allComplete = true;
    const stages = pipeline.stages || [];

    for (const stage of stages) {
      const stageState = activeRun.stages[stage.id];
      if (!stageState) continue;

      // Check if running stage completed
      if (stageState.status === 'running') {
        if (isStageComplete(stage, stageState, activeRun, config)) {
          // Collect output
          let output = '';
          if (stage.type === 'task') {
            const wiPath = path.join(__dirname, '..', 'work-items.json');
            const workItems = safeJson(wiPath) || [];
            output = (stageState.artifacts?.workItems || []).map(id => {
              const wi = workItems.find(w => w.id === id);
              return wi?.resultSummary || wi?.title || id;
            }).join('\n');
          } else if (stage.type === 'meeting') {
            const { getMeeting } = require('./meeting');
            output = (stageState.artifacts?.meetings || []).map(id => {
              const m = getMeeting(id);
              return m?.conclusion?.content || '';
            }).join('\n\n');
          }

          updateRunStage(pipeline.id, activeRun.runId, stage.id, {
            status: 'completed', completedAt: ts(), output
          });
          stageState.status = 'completed';
          stageState.output = output;
          log('info', `Pipeline ${pipeline.id}: stage ${stage.id} completed`);
        } else {
          anyRunning = true;
          allComplete = false;
        }
      }

      if (stageState.status === 'waiting-human') { allComplete = false; continue; }

      // Check if pending stage is ready to start
      if (stageState.status === 'pending') {
        allComplete = false;
        const depsReady = (stage.dependsOn || []).every(depId => {
          const dep = activeRun.stages[depId];
          return dep && dep.status === 'completed';
        });
        const depsFailed = (stage.dependsOn || []).some(depId => {
          const dep = activeRun.stages[depId];
          return dep && dep.status === 'failed';
        });

        if (depsFailed) {
          updateRunStage(pipeline.id, activeRun.runId, stage.id, { status: 'failed', error: 'dependency failed' });
          stageState.status = 'failed';
          anyFailed = true;
        } else if (depsReady) {
          const result = executeStage(stage, activeRun, pipeline, config);
          updateRunStage(pipeline.id, activeRun.runId, stage.id, { ...result, startedAt: ts() });
          Object.assign(stageState, result, { startedAt: ts() });
          if (result.status === 'running') anyRunning = true;
          log('info', `Pipeline ${pipeline.id}: started stage ${stage.id} (${stage.type})`);
        }
      }

      if (stageState.status === 'failed') anyFailed = true;
      if (stageState.status !== 'completed') allComplete = false;
    }

    // Check if run is done
    if (allComplete) {
      completeRun(pipeline.id, activeRun.runId, 'completed');
    } else if (anyFailed && !anyRunning) {
      completeRun(pipeline.id, activeRun.runId, 'failed');
    }
  }
}

module.exports = {
  PIPELINES_DIR,
  getPipelines, getPipeline, savePipeline, deletePipeline,
  getPipelineRuns, getActiveRun, startRun, updateRunStage, completeRun,
  discoverPipelineWork,
};
