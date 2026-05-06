/**
 * engine/scheduler.js -- Cron-style scheduled task discovery.
 * Zero dependencies -- uses only Node.js built-ins.
 *
 * Config schema:
 *   config.schedules: Array<{
 *     id: string,          -- unique schedule ID
 *     cron: string,        -- simplified cron: "minute hour dayOfWeek" (0=Sun..6=Sat)
 *     type: string,        -- work item type (implement, test, explore, ask, etc.)
 *     title: string,       -- work item title
 *     description?: string,
 *     project?: string,    -- target project name
 *     agent?: string,      -- preferred agent ID
 *     enabled?: boolean    -- default true
 *   }>
 *
 * Cron field syntax:
 *   *     -- every value
 *   N     -- exact value (e.g., "0" = minute 0, "2" = 2am, "1" = Monday)
 *   N,M   -- multiple values (e.g., "1,3,5" = Mon/Wed/Fri)
 *   * /N  -- every Nth value (e.g., "* /15" = every 15 minutes) [no space -- formatting only]
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const routing = require('./routing');
const { safeJson, safeWrite, mutateJsonFileLocked, ts, dateStamp, WI_STATUS, WORK_TYPE } = shared;

const SCHEDULE_RUNS_PATH = path.join(shared.MINIONS_DIR, 'engine', 'schedule-runs.json');

/**
 * Substitute schedule-time template variables in a string.
 * Currently supports:
 *   {{date}} — today's date as YYYY-MM-DD (UTC, via dateStamp())
 *
 * Downstream playbook rendering (engine/playbook.js) is a single-pass replace,
 * so any {{date}} embedded in a schedule's title/description would survive
 * substitution of {{task_description}} and surface as an "unresolved template
 * variables: date" warning plus a literal "{{date}}" in agent filenames.
 * Resolve these fields at schedule time so the work item carries a concrete
 * date string from the moment it's created.
 *
 * Safe on undefined/null/empty/non-string inputs — returns the input unchanged.
 */
function resolveScheduleTemplateVars(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str.replace(/\{\{date\}\}/g, dateStamp());
}

// Parse a single cron field into a matcher function.
// field: e.g., "*", "5", "1,3,5", "*/15"
// min/max: valid range (0-59 for minute, 0-23 for hour, 0-6 for dow)
//
// Bounds policy (P-h4cron-2ab8): out-of-range fields produce a matcher that
// never fires (`() => false`), rather than null. This keeps the function's
// contract (always returns a function) and matches existing behavior for
// other invalid forms (`*/0`, `*/abc`, unparseable syntax). parseCronExpr
// still returns its wrapper object — but its `.matches()` returns false for
// every Date when any field is out of range, so the schedule never fires.
// This catches typos like minute=99, hour=24, dow=9 that today are accepted
// as exact-value matchers and silently never trigger.
function parseCronField(field, min, max) {
  field = field.trim();
  if (field === '*') return () => true;

  const hasMin = typeof min === 'number';
  const hasMax = typeof max === 'number';

  // Step: */N — step must be > 0 AND not exceed the field's max.
  // A step larger than max either matches only val=0 (e.g., */60 for minute)
  // or nothing meaningful — treat as never-fires for predictability.
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return () => false;
    if (hasMax && step > max) return () => false;
    return (val) => val % step === 0;
  }

  // List: N,M,O — drop NaN entries AND entries outside [min, max] before
  // building the Set. A list with no surviving entries falls through to the
  // empty-Set matcher, which never matches anything.
  if (field.includes(',')) {
    const values = new Set(
      field
        .split(',')
        .map(v => parseInt(v.trim(), 10))
        .filter(v => !isNaN(v) && (!hasMin || v >= min) && (!hasMax || v <= max))
    );
    return (val) => values.has(val);
  }

  // Single value: N — out-of-range exact values never fire.
  const exact = parseInt(field, 10);
  if (!isNaN(exact)) {
    if ((hasMin && exact < min) || (hasMax && exact > max)) return () => false;
    return (val) => val === exact;
  }

  return () => false;
}

// Parse a 3-field cron expression: "minute hour dayOfWeek"
// expr: e.g., "0 2 *" (2am daily), "0 9 1" (9am Monday), "*/30 * *" (every 30 min)
// Returns { matches(date) } or null if invalid
function parseCronExpr(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 3) return null;

  const minuteMatcher = parseCronField(parts[0], 0, 59);
  const hourMatcher = parseCronField(parts[1], 0, 23);
  const dowMatcher = parseCronField(parts[2], 0, 6);

  return {
    matches(date) {
      return minuteMatcher(date.getMinutes()) &&
             hourMatcher(date.getHours()) &&
             dowMatcher(date.getDay());
    }
  };
}

/**
 * Check if a schedule should fire now, given its last run time.
 * Prevents double-firing within the same cron minute.
 *
 * Uses a calendar-minute comparison (year/month/date/hour/minute) instead of a
 * fixed elapsed-time threshold. A cron minute window spans a full 60 seconds
 * (e.g. 05:00:00 → 05:00:59), so an elapsed-time guard must also be ≥ 60s —
 * but then two fires at 04:59:58 and 05:00:00 (different cron windows) would
 * collapse incorrectly. Calendar-minute comparison handles both cases cleanly:
 * any two fires in the same wall-clock minute are the same cron window, and
 * any two fires in different wall-clock minutes are distinct cron windows.
 *
 * Regression note (W-mo3zu273f8tm): the old 55s threshold let two fires 58s
 * apart inside the same cron minute (05:00:01, 05:00:59) both pass the guard
 * when the first work item failed fast and cleared engine.js's active-dedup
 * check.
 *
 * @param {{ cron: string }} schedule
 * @param {string|null} lastRunAt -- ISO timestamp of last run
 * @returns {boolean}
 */
function shouldRunNow(schedule, lastRunAt) {
  const cron = parseCronExpr(schedule.cron);
  if (!cron) return false;

  const now = new Date();
  if (!cron.matches(now)) return false;

  // Don't fire twice in the same calendar minute (same cron window).
  if (lastRunAt) {
    const last = new Date(lastRunAt);
    if (!isNaN(last.getTime()) &&
        last.getFullYear() === now.getFullYear() &&
        last.getMonth() === now.getMonth() &&
        last.getDate() === now.getDate() &&
        last.getHours() === now.getHours() &&
        last.getMinutes() === now.getMinutes()) {
      return false;
    }
  }

  return true;
}

function createScheduledWorkItem(sched) {
  if (!sched || !sched.id || !sched.title) {
    throw new Error('schedule id and title are required');
  }
  const workItemId = `sched-${sched.id}-${Date.now()}`;
  return {
    id: workItemId,
    title: resolveScheduleTemplateVars(sched.title),
    type: routing.normalizeWorkType(sched.type, WORK_TYPE.IMPLEMENT),
    priority: sched.priority || 'medium',
    description: resolveScheduleTemplateVars(sched.description || sched.title),
    status: WI_STATUS.PENDING,
    created: ts(),
    createdBy: 'scheduler',
    agent: sched.agent || null,
    ...(sched.agentLock === true || sched.hardAgent === true ? { agentLock: true } : {}),
    project: sched.project || null,
    _scheduleId: sched.id,
  };
}

function writeScheduleRunEntry(runs, scheduleId, workItemId) {
  const existing = typeof runs[scheduleId] === 'object' && runs[scheduleId] ? runs[scheduleId] : {};
  runs[scheduleId] = { ...existing, lastRun: ts(), lastWorkItemId: workItemId };
  return runs[scheduleId];
}

function recordScheduleRun(scheduleId, workItemId) {
  let entry = null;
  mutateJsonFileLocked(SCHEDULE_RUNS_PATH, (runs) => {
    entry = writeScheduleRunEntry(runs, scheduleId, workItemId);
    return runs;
  }, { defaultValue: {} });
  return entry;
}

/**
 * Discover work items from configured schedules.
 * @param {object} config -- full config object
 * @returns {Array<object>} -- work items to create
 */
function discoverScheduledWork(config) {
  const schedules = config.schedules;
  if (!Array.isArray(schedules) || schedules.length === 0) return [];

  // Use file-locked mutation to prevent race conditions on rapid calls
  const work = [];
  mutateJsonFileLocked(SCHEDULE_RUNS_PATH, (runs) => {
    for (const sched of schedules) {
      if (!sched.id || !sched.cron || !sched.title) continue;
      if (sched.enabled === false) continue; // strict false check — undefined/null default to enabled per schema

      // Backward compat: runs[sched.id] can be a string (old format) or object (new format)
      const runEntry = runs[sched.id] || null;
      const lastRun = typeof runEntry === 'string' ? runEntry : (runEntry?.lastRun || null);
      if (!shouldRunNow(sched, lastRun)) continue;

      // Substitute schedule-time template vars (e.g. {{date}}) before the work
      // item is written — single-pass playbook rendering can't reach placeholders
      // embedded inside task_description, so they must be resolved up front.
      const workItem = createScheduledWorkItem(sched);
      work.push(workItem);

      // Record run time AND work-item ID at dispatch time — preserve existing
      // completion fields (lastResult, lastCompletedAt). Writing lastWorkItemId
      // here (not only on completion) keeps the schedule-runs entry durable if
      // the dispatched work item crashes or the engine restarts before
      // lifecycle.runPostCompletionHooks runs. This is the fix that closes
      // the double-fire window alongside the same-minute guard (W-mo3zu273f8tm).
      writeScheduleRunEntry(runs, sched.id, workItem.id);
    }
  }, { defaultValue: {} });

  return work;
}

module.exports = {
  parseCronExpr,
  parseCronField,
  shouldRunNow,
  discoverScheduledWork,
  createScheduledWorkItem,
  recordScheduleRun,
  resolveScheduleTemplateVars,
  SCHEDULE_RUNS_PATH,
};
