/**
 * engine/pipeline.js — Multi-stage pipeline orchestration.
 * Pipelines chain stages (task, meeting, plan, merge-prs, api, wait, parallel, condition)
 * with dependency tracking, artifact discovery, and conditional stop/termination.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeJson, safeWrite, safeRead, safeReadDir, uid, log, ts, dateStamp, mutateJsonFileLocked, mutateWorkItems, WI_STATUS, WORK_TYPE, PLAN_STATUS, PR_STATUS, PIPELINE_STATUS, STAGE_TYPE, MEETING_STATUS, ENGINE_DEFAULTS } = shared;
const http = require('http');
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
  return pipelineRuns.find(r => r.status === PIPELINE_STATUS.RUNNING || r.status === PIPELINE_STATUS.PAUSED);
}

function startRun(pipelineId, pipeline) {
  const runId = `run-${uid()}`;
  const stages = {};
  for (const stage of (pipeline.stages || [])) {
    stages[stage.id] = { status: PIPELINE_STATUS.PENDING, artifacts: {} };
  }
  const run = { runId, pipelineId, startedAt: ts(), status: PIPELINE_STATUS.RUNNING, stages };

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
  return str.replace(/\{\{stages\.([\w-]+)\.([\w-]+)\}\}/g, (_, stageId, field) => {
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

// ── Condition Evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a pipeline condition. Used by both `stopWhen` and `condition` stages.
 * @param {string|object} condition — condition name (string shorthand) or { check, ... } object
 * @param {{ run, pipeline, config }} ctx — evaluation context
 * @returns {boolean} whether the condition is met
 */
function evaluateCondition(condition, ctx) {
  const { run, pipeline, config } = ctx;
  // Normalize: string shorthand → { check: string }
  const cond = typeof condition === 'string' ? { check: condition } : (condition || {});

  switch (cond.check) {
    case 'runSucceeded': {
      // True when the current/last run completed with all stages succeeded (none failed)
      if (!run) return false;
      return Object.values(run.stages || {}).every(
        s => s.status === PIPELINE_STATUS.COMPLETED || s.status === PIPELINE_STATUS.PENDING
      );
    }
    case 'noFailedItems': {
      // True when all work items created by the pipeline are done (not failed)
      if (!run) return false;
      const wiPath = path.join(__dirname, '..', 'work-items.json');
      const workItems = safeJson(wiPath) || [];
      const allProjectWi = shared.getProjects(config).reduce((acc, p) => {
        return acc.concat(safeJson(shared.projectWorkItemsPath(p)) || []);
      }, []);
      const all = [...workItems, ...allProjectWi];
      const pipelineWis = all.filter(w => w._pipelineRun === run.runId);
      if (pipelineWis.length === 0) return true; // no items = nothing failed
      return pipelineWis.every(w => w.status !== WI_STATUS.FAILED);
    }
    case 'maxRuns': {
      // True when total run count for this pipeline >= threshold
      const threshold = cond.value || 1;
      const runs = getPipelineRuns();
      const pipelineRuns = runs[pipeline?.id] || [];
      return pipelineRuns.length >= threshold;
    }
    case 'allBuildsGreen': {
      // True when all PRs in monitoredResources (or run artifacts) have buildStatus 'passing'
      const projects = shared.getProjects(config);
      const allPrs = projects.reduce((acc, p) => {
        return acc.concat(safeJson(shared.projectPrPath(p)) || []);
      }, []);

      // Collect PR IDs to check: from monitoredResources (type: 'pr') or run artifact PRs
      const prIds = new Set();
      for (const res of (pipeline?.monitoredResources || [])) {
        const r = typeof res === 'string' ? { label: res } : res;
        if (r.type === 'pr' && r.label) prIds.add(r.label);
      }
      // Also check PRs from run artifacts
      if (run) {
        for (const [, s] of Object.entries(run.stages || {})) {
          for (const prId of (s.artifacts?.prs || [])) prIds.add(prId);
        }
      }
      if (prIds.size === 0) return false; // no PRs to check = can't confirm green
      for (const prId of prIds) {
        const pr = allPrs.find(p => p.id === prId);
        if (!pr || pr.buildStatus !== 'passing') return false;
      }
      return true;
    }
    default:
      log('warn', `Pipeline condition: unknown check '${cond.check}'`);
      return false;
  }
}

// ── Stage Execution ──────────────────────────────────────────────────────────

async function executeStage(stage, run, pipeline, config) {
  const resolved = resolveStageConfig(stage, run);
  const stageState = run.stages[stage.id];

  switch (resolved.type) {
    case STAGE_TYPE.TASK:
      return executeTaskStage(resolved, stageState, run, config);
    case STAGE_TYPE.MEETING:
      return executeMeetingStage(resolved, stageState, run, config);
    case STAGE_TYPE.PLAN:
      return executePlanStage(resolved, stageState, run, config);
    case STAGE_TYPE.API:
      return executeApiStage(resolved, stageState, run);
    case STAGE_TYPE.MERGE_PRS:
      return executeMergePrsStage(resolved, stageState, run, config);
    case STAGE_TYPE.SCHEDULE:
      return executeScheduleStage(resolved, stageState, config);
    case STAGE_TYPE.CONDITION:
      return executeConditionStage(resolved, stageState, run, pipeline, config);
    case STAGE_TYPE.WAIT:
      // wait stages just sit in waiting-human status until continued via API
      return { status: PIPELINE_STATUS.WAITING_HUMAN };
    case STAGE_TYPE.PARALLEL:
      return executeParallelStage(resolved, stageState, run, pipeline, config);
    default:
      log('warn', `Pipeline: unknown stage type '${resolved.type}' in stage ${stage.id}`);
      return { status: PIPELINE_STATUS.FAILED, error: 'unknown stage type' };
  }
}

function executeTaskStage(stage, stageState, run, config) {
  // Create work item(s) for the task
  const items = stage.items || [{ title: stage.title, description: stage.description || '', type: stage.taskType || 'explore', agent: stage.agent }];
  const count = stage.count || items.length;
  const wiPath = path.join(__dirname, '..', 'work-items.json');
  const createdIds = [];

  mutateWorkItems(wiPath, workItems => {
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
        // Only set agent if explicitly specified — otherwise engine routing assigns any available agent
        ...(item.agent || stage.agent ? { agent: item.agent || stage.agent } : {}),
        status: WI_STATUS.PENDING,
        created: ts(),
        createdBy: 'pipeline:' + run.pipelineId,
        branch: `pipeline/${run.pipelineId}/${stage.id}`,
        _pipelineRun: run.runId,
        _pipelineStage: stage.id,
      });
      createdIds.push(id);
    }
  });
  return { status: PIPELINE_STATUS.RUNNING, artifacts: { workItems: createdIds } };
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

  return { status: PIPELINE_STATUS.RUNNING, artifacts: { meetings: createdIds } };
}

// Find meeting artifacts from any stage in the run (not just direct deps)
function _findMeetingsInRun(run) {
  const meetings = [];
  for (const [, stageState] of Object.entries(run.stages || {})) {
    for (const mid of (stageState.artifacts?.meetings || [])) {
      if (!meetings.includes(mid)) meetings.push(mid);
    }
  }
  return meetings;
}

// Check if a plan already exists for a given meeting (created manually via dashboard)
function _findExistingPlanForMeeting(meetingIds, plansDir) {
  const files = safeReadDir(plansDir).filter(f => f.endsWith('.md'));
  // Build slug prefixes for both pipeline and dashboard naming conventions
  const slugPrefixes = [];
  for (const mid of meetingIds) {
    const mtg = safeJson(path.join(__dirname, '..', 'meetings', mid + '.json'));
    if (mtg?.title) {
      // Dashboard convention: "Meeting follow-up: {title}" → slug
      const dashSlug = ('meeting-follow-up-' + mtg.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      slugPrefixes.push(dashSlug.slice(0, 30));
    }
  }
  let slugMatch = null;
  for (const file of files) {
    if (!slugMatch && slugPrefixes.some(p => file.startsWith(p))) slugMatch = file;
    const content = safeRead(path.join(plansDir, file));
    if (!content) continue;
    for (const mid of meetingIds) {
      if (content.includes('**Source Meeting:** ' + mid)) return file;
    }
  }
  return slugMatch;
}

async function executePlanStage(stage, stageState, run, config) {
  const plansDir = path.join(__dirname, '..', 'plans');
  if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });

  const slug = (stage.title || 'pipeline-plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const wiPath = path.join(__dirname, '..', 'work-items.json');
  const wiId = `PL-${run.runId.slice(4, 12)}-${stage.id}-prd`;

  // ── Reconciliation: check if a plan already exists for a meeting in this run ──
  const meetingIds = _findMeetingsInRun(run);
  if (meetingIds.length > 0) {
    const existingPlanFile = _findExistingPlanForMeeting(meetingIds, plansDir);
    if (existingPlanFile) {
      log('info', `Pipeline ${run.pipelineId}: reconciling plan stage — adopting existing plan "${existingPlanFile}"`);
      // Adopt or create plan-to-prd WI atomically under lock
      let adoptedWiId = wiId;
      mutateWorkItems(wiPath, workItems => {
        const existing = workItems.find(w => w.type === WORK_TYPE.PLAN_TO_PRD && w.planFile === existingPlanFile);
        if (existing) {
          existing._pipelineRun = run.runId;
          existing._pipelineStage = stage.id;
          adoptedWiId = existing.id;
        } else if (!workItems.some(w => w.id === wiId)) {
          workItems.push({
            id: wiId, title: `Convert plan to PRD: ${existingPlanFile}`,
            type: WORK_TYPE.PLAN_TO_PRD, priority: 'high', status: WI_STATUS.PENDING,
            planFile: existingPlanFile, created: ts(), createdBy: 'pipeline:' + run.pipelineId,
            branch: `pipeline/${run.pipelineId}/${stage.id}`, _pipelineRun: run.runId, _pipelineStage: stage.id,
          });
        }
      });
      return {
        status: PIPELINE_STATUS.RUNNING,
        artifacts: { plans: [existingPlanFile], workItems: [adoptedWiId], prds: [], prs: [] },
      };
    }
  }

  // ── No existing plan — build meeting context from ALL run stages (not just direct deps) ──
  let meetingContext = '';
  for (const mid of meetingIds) {
    try {
      const mtg = safeJson(path.join(__dirname, '..', 'meetings', mid + '.json'));
      if (mtg) {
        const transcript = (mtg.transcript || []).map(t =>
          '### ' + (t.agent || 'agent') + ' (' + (t.type || '') + ', Round ' + (t.round || '?') + ')\n\n' + (t.content || '')
        ).join('\n\n---\n\n');
        meetingContext += '# Meeting: ' + (mtg.title || mid) + '\n\n**Agenda:** ' + (mtg.agenda || '') + '\n\n' + transcript + '\n\n';
      }
    } catch (e) { log('warn', `Pipeline plan: failed to read meeting ${mid}: ${e.message}`); }
  }
  // Also include direct dep output (for non-meeting stages)
  if (stage.dependsOn) {
    for (const depId of stage.dependsOn) {
      const depStage = run.stages[depId];
      if (depStage?.output && !depStage.artifacts?.meetings?.length) {
        meetingContext += '## From: ' + depId + '\n\n' + depStage.output + '\n\n';
      }
    }
  }

  // Use LLM to generate a structured plan (same approach as dashboard "Create Plan from Meeting" button)
  let content = '';
  try {
    const llm = require('./llm');
    const planPrompt = 'Create an actionable implementation plan from this meeting. ' +
      'Extract concrete action items from the conclusion and debates. ' +
      'For each item include: what to do, which files/areas to change, priority (high/medium/low), and estimated complexity (small/medium/large). ' +
      'Structure it as a plan ready for execution. Do NOT include preamble — start with the plan title.' +
      (stage.description ? '\n\nAdditional instructions: ' + stage.description : '');
    const fullPrompt = meetingContext + '\n\n---\n\n' + planPrompt;
    const result = await llm.callLLM(fullPrompt, '', {
      timeout: 120000, label: 'pipeline-plan', model: 'sonnet', maxTurns: 1,
    });
    if (result.text) {
      content = result.text;
      log('info', `Pipeline plan: LLM generated ${content.length} chars from meeting context`);
    }
  } catch (e) { log('warn', `Pipeline plan LLM failed: ${e.message} — falling back to raw meeting context`); }

  // Fallback: raw meeting context if LLM failed
  if (!content) {
    content = `# ${stage.title}\n\n`;
    content += `**Created by:** Pipeline ${run.pipelineId}\n`;
    content += `**Date:** ${dateStamp()}\n\n---\n\n`;
    content += meetingContext;
    if (stage.description) content += stage.description + '\n';
  }

  const filename = `${slug}-${dateStamp()}.md`;
  const filePath = shared.uniquePath(path.join(plansDir, filename));
  safeWrite(filePath, content);

  // Create plan-to-prd work item — atomic write to prevent race with dispatch status updates
  mutateWorkItems(wiPath, workItems => {
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
    }
  });

  return {
    status: PIPELINE_STATUS.RUNNING,
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
    const maxAttempts = ENGINE_DEFAULTS.pipelineApiRetries;
    const retryDelay = ENGINE_DEFAULTS.pipelineApiRetryDelay;
    const makeRequest = (attempt) => {
      try {
        const parsed = new URL(url);
        const req = http.request({
          hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
          method: call.method || 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          res.resume(); // drain body to free socket
          if (res.statusCode >= 400) {
            log('warn', `Pipeline API call to ${call.endpoint} returned ${res.statusCode} (attempt ${attempt})`);
            if (attempt < maxAttempts) setTimeout(() => makeRequest(attempt + 1), retryDelay);
          }
        });
        req.on('error', (err) => {
          log('warn', `Pipeline API call to ${call.endpoint} failed: ${err.message} (attempt ${attempt})`);
          if (attempt < maxAttempts) setTimeout(() => makeRequest(attempt + 1), retryDelay);
        });
        req.write(body);
        req.end();
      } catch (e) {
        log('warn', `Pipeline API call to ${call.endpoint} threw: ${e.message} (attempt ${attempt})`);
        if (attempt < maxAttempts) setTimeout(() => makeRequest(attempt + 1), retryDelay);
      }
    };
    makeRequest(1);
  }
  return { status: PIPELINE_STATUS.COMPLETED, completedAt: ts() };
}

function executeMergePrsStage(stage, stageState, run, config) {
  // Collect all PR IDs from all previous stages in this run
  const prIds = [];
  for (const [, s] of Object.entries(run.stages)) {
    if (s.artifacts?.prs) prIds.push(...s.artifacts.prs);
  }
  if (prIds.length === 0) {
    return { status: PIPELINE_STATUS.COMPLETED, completedAt: ts(), output: 'No PRs to merge' };
  }
  // The actual merge will be handled by the PR polling/merge logic
  // We just need to track which PRs to watch
  return { status: PIPELINE_STATUS.RUNNING, artifacts: { prs: prIds } };
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
  return { status: PIPELINE_STATUS.COMPLETED, completedAt: ts() };
}

function executeConditionStage(stage, stageState, run, pipeline, config) {
  const check = stage.check || stage.condition;
  if (!check) {
    log('warn', `Pipeline ${pipeline.id}: condition stage ${stage.id} has no check defined`);
    return { status: PIPELINE_STATUS.FAILED, error: 'no check defined' };
  }

  const met = evaluateCondition(check, { run, pipeline, config });
  const action = met ? (stage.onMet || 'complete') : (stage.onUnmet || 'fail');
  log('info', `Pipeline ${pipeline.id}: condition '${typeof check === 'string' ? check : check.check}' → ${met ? 'met' : 'unmet'}, action: ${action}`);

  switch (action) {
    case 'complete':
    case 'continue':
      return { status: PIPELINE_STATUS.COMPLETED, completedAt: ts(), output: `Condition ${met ? 'met' : 'unmet'}` };
    case 'fail':
      return { status: PIPELINE_STATUS.FAILED, error: `Condition ${met ? 'met' : 'unmet'}` };
    case 'stop-pipeline':
      // Disable the pipeline and complete the run
      pipeline.enabled = false;
      pipeline._stoppedBy = stage.id;
      pipeline._stoppedAt = ts();
      pipeline._stopReason = `Condition '${typeof check === 'string' ? check : check.check}' ${met ? 'met' : 'unmet'}`;
      savePipeline(pipeline);
      log('info', `Pipeline ${pipeline.id}: auto-disabled by condition stage ${stage.id}`);
      return { status: PIPELINE_STATUS.COMPLETED, completedAt: ts(), output: `Pipeline stopped: condition ${met ? 'met' : 'unmet'}`, _stopPipeline: true };
    default:
      log('warn', `Pipeline ${pipeline.id}: unknown condition action '${action}'`);
      return { status: PIPELINE_STATUS.FAILED, error: `unknown action '${action}'` };
  }
}

async function executeParallelStage(stage, stageState, run, pipeline, config) {
  const subStages = stage.stages || [];
  const subResults = {};
  for (const sub of subStages) {
    if (!run.stages[sub.id] || run.stages[sub.id].status === PIPELINE_STATUS.PENDING) {
      const result = await executeStage(sub, run, pipeline, config);
      subResults[sub.id] = result;
      run.stages[sub.id] = { ...run.stages[sub.id] || {}, ...result, startedAt: ts() };
    }
  }
  // Parent is running until all subs complete
  return { status: PIPELINE_STATUS.RUNNING, artifacts: { subStages: subStages.map(s => s.id) } };
}

// ── Stage Completion Checks ──────────────────────────────────────────────────

function isStageComplete(stage, stageState, run, config) {
  if (stageState.status === PIPELINE_STATUS.COMPLETED || stageState.status === PIPELINE_STATUS.FAILED) return true;
  if (stageState.status === PIPELINE_STATUS.PENDING || stageState.status === PIPELINE_STATUS.WAITING_HUMAN) return false;

  const artifacts = stageState.artifacts || {};

  switch (stage.type) {
    case STAGE_TYPE.TASK: {
      const wiPath = path.join(__dirname, '..', 'work-items.json');
      const workItems = safeJson(wiPath) || [];
      const ids = artifacts.workItems || [];
      if (ids.length === 0) return false;
      return ids.every(id => {
        const wi = workItems.find(w => w.id === id);
        return !wi || wi.status === WI_STATUS.DONE || wi.status === WI_STATUS.FAILED; // missing = treat as done
      });
    }
    case STAGE_TYPE.MEETING: {
      const { getMeeting } = require('./meeting');
      const ids = artifacts.meetings || [];
      if (ids.length === 0) return false;
      return ids.every(id => {
        const m = getMeeting(id);
        return m && (m.status === MEETING_STATUS.COMPLETED || m.status === MEETING_STATUS.ARCHIVED);
      });
    }
    case STAGE_TYPE.PLAN: {
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
    case STAGE_TYPE.MERGE_PRS: {
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
    case STAGE_TYPE.API:
    case STAGE_TYPE.SCHEDULE:
    case STAGE_TYPE.CONDITION:
      return true; // immediate — resolved synchronously on execute
    case STAGE_TYPE.WAIT:
      return stageState.status === PIPELINE_STATUS.COMPLETED;
    case STAGE_TYPE.PARALLEL: {
      const subIds = artifacts.subStages || [];
      return subIds.every(id => {
        const sub = run.stages[id];
        return sub && (sub.status === PIPELINE_STATUS.COMPLETED || sub.status === PIPELINE_STATUS.FAILED);
      });
    }
    default:
      return false;
  }
}

// ── Discovery (called per tick) ──────────────────────────────────────────────

async function discoverPipelineWork(config) {
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
      if (stageState.status === PIPELINE_STATUS.RUNNING) {
        if (isStageComplete(stage, stageState, activeRun, config)) {
          // Collect output
          let output = '';
          if (stage.type === STAGE_TYPE.TASK) {
            const wiPath = path.join(__dirname, '..', 'work-items.json');
            const workItems = safeJson(wiPath) || [];
            output = (stageState.artifacts?.workItems || []).map(id => {
              const wi = workItems.find(w => w.id === id);
              return wi?.resultSummary || wi?.title || id;
            }).join('\n');
          } else if (stage.type === STAGE_TYPE.MEETING) {
            const { getMeeting } = require('./meeting');
            output = (stageState.artifacts?.meetings || []).map(id => {
              const m = getMeeting(id);
              return m?.conclusion?.content || '';
            }).join('\n\n');
          }

          // Scan for inbox/archive notes created by this stage's agents
          try {
            const notesDirs = [
              path.join(__dirname, '..', 'notes', 'inbox'),
              path.join(__dirname, '..', 'notes', 'archive'),
            ];
            const stageWiIds = stageState.artifacts?.workItems || [];
            const notes = [];
            for (const dir of notesDirs) {
              for (const f of safeReadDir(dir).filter(n => n.endsWith('.md'))) {
                if (stageWiIds.some(id => f.includes(id)) || f.includes(stage.id) || f.includes(pipeline.id)) {
                  notes.push(f);
                }
              }
            }
            if (notes.length > 0) {
              stageState.artifacts = stageState.artifacts || {};
              stageState.artifacts.notes = notes;
            }
          } catch { /* optional */ }

          updateRunStage(pipeline.id, activeRun.runId, stage.id, {
            status: PIPELINE_STATUS.COMPLETED, completedAt: ts(), output,
            artifacts: stageState.artifacts,
          });
          stageState.status = PIPELINE_STATUS.COMPLETED;
          stageState.output = output;
          log('info', `Pipeline ${pipeline.id}: stage ${stage.id} completed${stageState.artifacts?.notes?.length ? ` (${stageState.artifacts.notes.length} notes)` : ''}`);
        } else {
          anyRunning = true;
          allComplete = false;
        }
      }

      if (stageState.status === PIPELINE_STATUS.WAITING_HUMAN) { allComplete = false; continue; }

      // Check if pending stage is ready to start
      if (stageState.status === PIPELINE_STATUS.PENDING) {
        allComplete = false;
        const depsReady = (stage.dependsOn || []).every(depId => {
          const dep = activeRun.stages[depId];
          return dep && dep.status === PIPELINE_STATUS.COMPLETED;
        });
        const depsFailed = (stage.dependsOn || []).some(depId => {
          const dep = activeRun.stages[depId];
          return dep && dep.status === PIPELINE_STATUS.FAILED;
        });

        if (depsFailed) {
          updateRunStage(pipeline.id, activeRun.runId, stage.id, { status: PIPELINE_STATUS.FAILED, error: 'dependency failed' });
          stageState.status = PIPELINE_STATUS.FAILED;
          anyFailed = true;
        } else if (depsReady) {
          const result = await executeStage(stage, activeRun, pipeline, config);
          updateRunStage(pipeline.id, activeRun.runId, stage.id, { ...result, startedAt: ts() });
          Object.assign(stageState, result, { startedAt: ts() });
          if (result.status === PIPELINE_STATUS.RUNNING) anyRunning = true;
          // Condition stage signaled pipeline stop — complete the run immediately
          if (result._stopPipeline) {
            completeRun(pipeline.id, activeRun.runId, PIPELINE_STATUS.STOPPED);
            allComplete = true;
            break;
          }
          log('info', `Pipeline ${pipeline.id}: started stage ${stage.id} (${stage.type})`);
        }
      }

      if (stageState.status === PIPELINE_STATUS.FAILED) anyFailed = true;
      if (stageState.status !== PIPELINE_STATUS.COMPLETED) allComplete = false;
    }

    // Check if run is done
    if (allComplete) {
      // Only complete if not already stopped by a condition stage
      if (activeRun.status !== PIPELINE_STATUS.STOPPED) {
        completeRun(pipeline.id, activeRun.runId, PIPELINE_STATUS.COMPLETED);
      }

      // Evaluate top-level stopWhen after successful run completion
      if (pipeline.stopWhen && pipeline.enabled !== false) {
        try {
          const stopMet = evaluateCondition(pipeline.stopWhen, { run: activeRun, pipeline, config });
          if (stopMet) {
            pipeline.enabled = false;
            pipeline._stoppedBy = 'stopWhen';
            pipeline._stoppedAt = ts();
            pipeline._stopReason = `stopWhen condition '${typeof pipeline.stopWhen === 'string' ? pipeline.stopWhen : (pipeline.stopWhen.check || 'unknown')}' met`;
            savePipeline(pipeline);
            log('info', `Pipeline ${pipeline.id}: auto-disabled by stopWhen condition`);
          }
        } catch (e) { log('warn', `Pipeline ${pipeline.id}: stopWhen evaluation failed: ${e.message}`); }
      }
    } else if (anyFailed && !anyRunning) {
      completeRun(pipeline.id, activeRun.runId, PIPELINE_STATUS.FAILED);
    }
  }
}

module.exports = {
  PIPELINES_DIR,
  getPipelines, getPipeline, savePipeline, deletePipeline,
  getPipelineRuns, getActiveRun, startRun, updateRunStage, completeRun,
  discoverPipelineWork,
  evaluateCondition, // exported for testing
};
