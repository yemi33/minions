/**
 * engine/watches.js -- Persistent watch jobs that survive engine restarts.
 * Zero dependencies -- uses only Node.js built-ins + engine/shared.js.
 *
 * Watches monitor targets (PRs, work items, branches) for conditions (merged,
 * build-fail, completed, etc.) and fire inbox notifications when triggered.
 *
 * State stored in engine/watches.json — concurrency-safe via mutateJsonFileLocked.
 */

const path = require('path');
const shared = require('./shared');
const { safeJson, mutateJsonFileLocked, ts, uid, log, writeToInbox,
  WATCH_STATUS, WATCH_TARGET_TYPE, WATCH_CONDITION, WATCH_ABSOLUTE_CONDITIONS } = shared;

// Dynamic path — respects MINIONS_TEST_DIR for test isolation
function _watchesPath() { return path.join(shared.MINIONS_DIR, 'engine', 'watches.json'); }

// Default check interval: 5 minutes (300000ms). Engine tick runs every 60s,
// so watches are checked every N ticks where N = ceil(interval / tickInterval).
const DEFAULT_WATCH_INTERVAL = 300000;

/**
 * Read all watches from disk.
 * @returns {Array<object>}
 */
function getWatches() {
  return safeJson(_watchesPath()) || [];
}

/**
 * Create a new watch. Validates required fields and writes atomically.
 * @param {object} opts - Watch definition
 * @returns {object} - Created watch
 */
function createWatch({ target, targetType, condition, interval, owner, description, project, notify, stopAfter, onNotMet }) {
  if (!target) throw new Error('target is required');
  if (!targetType || !Object.values(WATCH_TARGET_TYPE).includes(targetType)) {
    throw new Error(`targetType must be one of: ${Object.values(WATCH_TARGET_TYPE).join(', ')}`);
  }
  if (!condition || !Object.values(WATCH_CONDITION).includes(condition)) {
    throw new Error(`condition must be one of: ${Object.values(WATCH_CONDITION).join(', ')}`);
  }

  const watch = {
    id: 'watch-' + uid(),
    target,
    targetType,
    condition,
    interval: Math.max(60000, Number(interval) || DEFAULT_WATCH_INTERVAL),
    owner: owner || 'human',
    status: WATCH_STATUS.ACTIVE,
    description: description || `Watch ${target} for ${condition}`,
    project: project || null,
    notify: notify || 'inbox',
    stopAfter: Number(stopAfter) || 0,   // 0 = run forever; N = expire after N triggers
    onNotMet: onNotMet || null,          // null | 'notify' — action per poll when condition not met
    triggerCount: 0,
    created_at: ts(),
    last_checked: null,
    last_triggered: null,
  };

  mutateJsonFileLocked(_watchesPath(), (watches) => {
    if (!Array.isArray(watches)) watches = [];
    watches.push(watch);
    return watches;
  }, { defaultValue: [] });

  log('info', `Watch created: ${watch.id} → ${watch.target} (${watch.condition})`);
  return watch;
}

/**
 * Update a watch by ID. Only updates provided fields.
 * @param {string} id - Watch ID
 * @param {object} updates - Fields to update
 * @returns {object|null} - Updated watch or null if not found
 */
function updateWatch(id, updates) {
  if (!id) throw new Error('id is required');
  // Validate status before entering the lock — reject early, never persist invalid values
  if (updates.status !== undefined && !Object.values(WATCH_STATUS).includes(updates.status)) {
    log('warn', `Invalid watch status: ${updates.status}`);
    return null;
  }
  let found = null;
  mutateJsonFileLocked(_watchesPath(), (watches) => {
    if (!Array.isArray(watches)) return watches;
    const watch = watches.find(w => w.id === id);
    if (!watch) return watches;
    // Only allow safe field updates
    const allowed = ['status', 'interval', 'description', 'notify', 'stopAfter', 'onNotMet', 'condition'];
    for (const key of allowed) {
      if (updates[key] !== undefined) watch[key] = updates[key];
    }
    found = { ...watch };
    return watches;
  }, { defaultValue: [] });
  return found;
}

/**
 * Delete a watch by ID.
 * @param {string} id
 * @returns {boolean} - true if deleted
 */
function deleteWatch(id) {
  if (!id) return false;
  let deleted = false;
  mutateJsonFileLocked(_watchesPath(), (watches) => {
    if (!Array.isArray(watches)) return watches;
    const idx = watches.findIndex(w => w.id === id);
    if (idx >= 0) {
      watches.splice(idx, 1);
      deleted = true;
    }
    return watches;
  }, { defaultValue: [] });
  if (deleted) log('info', `Watch deleted: ${id}`);
  return deleted;
}

/**
 * Evaluate whether a watch condition is met given current state.
 * @param {object} watch - The watch object
 * @param {object} state - { pullRequests, workItems } current state
 * @returns {{ triggered: boolean, message: string }}
 */
function evaluateWatch(watch, state) {
  const { target, targetType, condition } = watch;

  if (targetType === WATCH_TARGET_TYPE.PR) {
    const pr = (state.pullRequests || []).find(p =>
      String(p.prNumber) === String(target) || p.id === target
    );
    if (!pr) return { triggered: false, message: `PR ${target} not found` };

    // Store previous state for status-change detection
    const prevState = watch._lastState || {};

    switch (condition) {
      case WATCH_CONDITION.MERGED:
        return { triggered: pr.status === 'merged', message: pr.status === 'merged' ? `PR ${target} was merged` : '' };
      case WATCH_CONDITION.BUILD_FAIL:
        return { triggered: pr.buildStatus === 'failing', message: pr.buildStatus === 'failing' ? `PR ${target} build is failing` : '' };
      case WATCH_CONDITION.BUILD_PASS:
        return { triggered: pr.buildStatus === 'passing', message: pr.buildStatus === 'passing' ? `PR ${target} build is passing` : '' };
      case WATCH_CONDITION.STATUS_CHANGE: {
        const changed = prevState.status !== undefined && prevState.status !== pr.status;
        return { triggered: changed, message: changed ? `PR ${target} status changed: ${prevState.status} → ${pr.status}` : '' };
      }
      case WATCH_CONDITION.ANY: {
        const anyChanged = prevState.status !== undefined && (
          prevState.status !== pr.status ||
          prevState.buildStatus !== pr.buildStatus ||
          prevState.reviewStatus !== pr.reviewStatus
        );
        return { triggered: anyChanged, message: anyChanged ? `PR ${target} changed` : '' };
      }
      case WATCH_CONDITION.NEW_COMMENTS: {
        const lastCommentDate = pr.humanFeedback?.lastProcessedCommentDate || null;
        const prevCommentDate = prevState.lastCommentDate || null;
        const hasNew = lastCommentDate && lastCommentDate !== prevCommentDate;
        return { triggered: !!hasNew, message: hasNew ? `PR ${target} has a new comment (${lastCommentDate})` : '' };
      }
      case WATCH_CONDITION.VOTE_CHANGE: {
        const changed = prevState.reviewStatus !== undefined && prevState.reviewStatus !== pr.reviewStatus;
        return { triggered: changed, message: changed ? `PR ${target} vote changed: ${prevState.reviewStatus} → ${pr.reviewStatus}` : '' };
      }
      default:
        return { triggered: false, message: `Unknown condition: ${condition}` };
    }
  }

  if (targetType === WATCH_TARGET_TYPE.WORK_ITEM) {
    const wi = (state.workItems || []).find(w => w.id === target);
    if (!wi) return { triggered: false, message: `Work item ${target} not found` };

    const prevState = watch._lastState || {};

    switch (condition) {
      case WATCH_CONDITION.COMPLETED:
        return { triggered: shared.DONE_STATUSES.has(wi.status), message: shared.DONE_STATUSES.has(wi.status) ? `Work item ${target} completed (${wi.status})` : '' };
      case WATCH_CONDITION.FAILED:
        return { triggered: wi.status === shared.WI_STATUS.FAILED, message: wi.status === shared.WI_STATUS.FAILED ? `Work item ${target} failed` : '' };
      case WATCH_CONDITION.STATUS_CHANGE: {
        const changed = prevState.status !== undefined && prevState.status !== wi.status;
        return { triggered: changed, message: changed ? `Work item ${target} status: ${prevState.status} → ${wi.status}` : '' };
      }
      case WATCH_CONDITION.ANY: {
        const anyChanged = prevState.status !== undefined && prevState.status !== wi.status;
        return { triggered: anyChanged, message: anyChanged ? `Work item ${target} changed (${wi.status})` : '' };
      }
      default:
        return { triggered: false, message: `Unknown condition: ${condition}` };
    }
  }

  return { triggered: false, message: `Unknown target type: ${targetType}` };
}

/**
 * Check all active watches against current state. Called from engine tick.
 * @param {object} config - Engine config
 * @param {object} state - { pullRequests, workItems } from queries
 */
function checkWatches(config, state) {
  const now = Date.now();
  // Collect notifications to fire AFTER lock is released — never do I/O inside the lock callback
  const notifications = [];

  mutateJsonFileLocked(_watchesPath(), (watches) => {
    if (!Array.isArray(watches) || watches.length === 0) return watches;

    for (const watch of watches) {
      try {
        if (watch.status !== WATCH_STATUS.ACTIVE) continue;

        // Check interval — skip if checked too recently
        if (watch.last_checked) {
          const elapsed = now - new Date(watch.last_checked).getTime();
          if (elapsed < watch.interval) continue;
        }

        watch.last_checked = ts();

        // Initialize baseline state on first check for change-detection conditions.
        // Without this, status-change/any conditions would have no previous state to compare.
        if (!watch._lastState || Object.keys(watch._lastState).length === 0) {
          watch._lastState = _captureState(watch, state);
        }

        const result = evaluateWatch(watch, state);
        if (result.triggered) {
          watch.triggerCount = (watch.triggerCount || 0) + 1;
          watch.last_triggered = ts();
          watch._lastTriggerMessage = result.message;

          // Queue trigger notification — unique key per trigger to avoid overwriting previous messages
          if (watch.notify === 'inbox' && watch.owner) {
            notifications.push({
              type: 'trigger', owner: watch.owner,
              slug: `watch-${watch.id}-${watch.triggerCount}`,
              body: `## Watch Triggered: ${watch.description}\n\n${result.message}\n\nWatch ID: ${watch.id} | Target: ${watch.target} | Condition: ${watch.condition}`,
            });
          }
          log('info', `Watch triggered: ${watch.id} — ${result.message}`);

          // Expire when stopAfter limit is reached. stopAfter=0 means run forever (no limit).
          if (watch.stopAfter > 0 && watch.triggerCount >= watch.stopAfter) {
            watch.status = WATCH_STATUS.EXPIRED;
            log('info', `Watch expired (stopAfter limit reached): ${watch.id}`);
          }
        } else if (watch.onNotMet === 'notify' && watch.owner) {
          // Queue per-poll notification when condition is not yet met — unique key per poll
          notifications.push({
            type: 'poll', owner: watch.owner,
            slug: `watch-poll-${watch.id}-${Date.now()}`,
            body: `## Watch Polling: ${watch.description}\n\nCondition not yet met (${watch.condition}) — still watching.\n\nWatch ID: ${watch.id} | Target: ${watch.target} | Checks so far: ${watch.triggerCount || 0}`,
          });
        }

        // Capture state for change detection on next check
        watch._lastState = _captureState(watch, state);
      } catch (err) {
        log('warn', `Watch check error (${watch.id}): ${err.message}`);
      }
    }

    return watches;
  }, { defaultValue: [] });

  // Fire notifications outside the lock — writeToInbox does disk I/O
  for (const n of notifications) {
    try {
      writeToInbox(n.owner, n.slug, n.body);
    } catch (err) {
      log('warn', `Watch notification error: ${err.message}`);
    }
  }
}

/**
 * Internal: capture state snapshot for a watch target.
 */
function _captureState(watch, state) {
  if (watch.targetType === WATCH_TARGET_TYPE.PR) {
    const pr = (state.pullRequests || []).find(p =>
      String(p.prNumber) === String(watch.target) || p.id === watch.target
    );
    if (pr) return { status: pr.status, buildStatus: pr.buildStatus, reviewStatus: pr.reviewStatus, lastCommentDate: pr.humanFeedback?.lastProcessedCommentDate || null };
  }
  if (watch.targetType === WATCH_TARGET_TYPE.WORK_ITEM) {
    const wi = (state.workItems || []).find(w => w.id === watch.target);
    if (wi) return { status: wi.status };
  }
  return {};
}

module.exports = {
  DEFAULT_WATCH_INTERVAL,
  getWatches,
  createWatch,
  updateWatch,
  deleteWatch,
  evaluateWatch,
  checkWatches,
  _captureState,  // exported for testing
  _watchesPath,   // exported for testing — dynamic, respects MINIONS_TEST_DIR
};
