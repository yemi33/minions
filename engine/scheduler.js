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
const { safeJson, safeWrite, mutateJsonFileLocked } = shared;

const SCHEDULE_RUNS_PATH = path.join(__dirname, 'schedule-runs.json');

// Parse a single cron field into a matcher function.
// field: e.g., "*", "5", "1,3,5", "*/15"
// min/max: valid range (0-59 for minute, 0-23 for hour, 0-6 for dow)
function parseCronField(field, min, max) {
  field = field.trim();
  if (field === '*') return () => true;

  // Step: */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return () => false;
    return (val) => val % step === 0;
  }

  // List: N,M,O
  if (field.includes(',')) {
    const values = new Set(field.split(',').map(v => parseInt(v.trim(), 10)).filter(v => !isNaN(v)));
    return (val) => values.has(val);
  }

  // Single value: N
  const exact = parseInt(field, 10);
  if (!isNaN(exact)) return (val) => val === exact;

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
 * Prevents double-firing within the same minute window.
 * @param {{ cron: string }} schedule
 * @param {string|null} lastRunAt -- ISO timestamp of last run
 * @returns {boolean}
 */
function shouldRunNow(schedule, lastRunAt) {
  const cron = parseCronExpr(schedule.cron);
  if (!cron) return false;

  const now = new Date();
  if (!cron.matches(now)) return false;

  // Don't fire again if already ran within the last 55 seconds
  // (uses elapsed time instead of field comparison to handle DST/clock adjustments)
  if (lastRunAt) {
    const last = new Date(lastRunAt);
    if (Date.now() - last.getTime() < 55000) return false;
  }

  return true;
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
      if (sched.enabled === false) continue;

      const lastRun = runs[sched.id] || null;
      if (!shouldRunNow(sched, lastRun)) continue;

      work.push({
        id: `sched-${sched.id}-${Date.now()}`,
        title: sched.title,
        type: sched.type || 'implement',
        priority: sched.priority || 'medium',
        description: sched.description || sched.title,
        status: 'pending',
        created: new Date().toISOString(),
        createdBy: 'scheduler',
        agent: sched.agent || null,
        project: sched.project || null,
        _scheduleId: sched.id,
      });

      // Record run time inside the lock
      runs[sched.id] = new Date().toISOString();
    }
  }, { defaultValue: {} });

  return work;
}

module.exports = { parseCronExpr, parseCronField, shouldRunNow, discoverScheduledWork, SCHEDULE_RUNS_PATH };
