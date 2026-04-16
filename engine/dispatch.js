/**
 * engine/dispatch.js — Dispatch queue management: add, complete, mutate, alerts.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');
const { setCooldownFailure } = require('./cooldown');

const { safeJson, safeWrite, safeReadDir, mutateJsonFileLocked, mutateWorkItems,
  mutatePullRequests, getProjects, projectWorkItemsPath, projectPrPath, log, ts, dateStamp,
  WI_STATUS, DISPATCH_RESULT, ENGINE_DEFAULTS, AGENT_STATUS, FAILURE_CLASS } = shared;
const { getConfig, getDispatch, DISPATCH_PATH, INBOX_DIR } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;

// Lazy require to break circular dependency with engine.js
let _lifecycle = null;
function lifecycle() { if (!_lifecycle) _lifecycle = require('./lifecycle'); return _lifecycle; }
let _recovery = null;
function recovery() { if (!_recovery) _recovery = require('./recovery'); return _recovery; }

// ─── Dispatch Mutation ───────────────────────────────────────────────────────

function mutateDispatch(mutator) {
  const defaultDispatch = { pending: [], active: [], completed: [] };
  const result = mutateJsonFileLocked(DISPATCH_PATH, (dispatch) => {
    dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
    dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
    dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
    return mutator(dispatch) ?? dispatch;
  }, { defaultValue: defaultDispatch });
  // Invalidate the read cache so next getDispatch() sees fresh data
  try { require('./queries').invalidateDispatchCache(); } catch {}
  return result;
}

// ─── Add to Dispatch ─────────────────────────────────────────────────────────

function addToDispatch(item) {
  item.id = item.id || `${item.agent}-${item.type}-${shared.uid()}`;
  item.created_at = ts();
  let added = false;
  mutateDispatch((dispatch) => {
    // Dedup: skip if same work item ID is already pending or active
    const wiId = item.meta?.item?.id;
    if (wiId) {
      const existing = [...dispatch.pending, ...(dispatch.active || [])].find(d => d.meta?.item?.id === wiId);
      if (existing) {
        log('info', `Dedup: skipping ${item.id} — work item ${wiId} already in ${existing.id}`);
        return dispatch;
      }
    }
    // Also dedup by dispatchKey
    if (item.meta?.dispatchKey) {
      const existing = [...dispatch.pending, ...(dispatch.active || [])].find(d => d.meta?.dispatchKey === item.meta.dispatchKey);
      if (existing) {
        log('info', `Dedup: skipping ${item.id} — dispatchKey ${item.meta.dispatchKey} already in ${existing.id}`);
        return dispatch;
      }
    }
    dispatch.pending.push(item);
    added = true;
    return dispatch;
  });
  if (added) log('info', `Queued dispatch: ${item.id} (${item.type} → ${item.agent})`);
  return item.id;
}

// ─── Retryable Failure Classification ────────────────────────────────────────

function isRetryableFailureReason(reason = '', failureClass = '') {
  // FAILURE_CLASS-based classification takes precedence when available
  if (failureClass) {
    const neverRetry = new Set([FAILURE_CLASS.CONFIG_ERROR, FAILURE_CLASS.PERMISSION_BLOCKED]);
    if (neverRetry.has(failureClass)) return false;
  }
  const r = String(reason || '').toLowerCase();
  if (!r) return true; // unknown error from tool exit — keep retryable
  const nonRetryable = [
    'no playbook rendered',
    'failed to render',
    'no target project available',
    'no plan files found',
    'plan file not found',
    'invalid filename',
    'invalid file path',
    'missing required',
    'validation failed',
  ];
  return !nonRetryable.some(s => r.includes(s));
}

// ─── Complete Dispatch ───────────────────────────────────────────────────────

function completeDispatch(id, result = DISPATCH_RESULT.SUCCESS, reason = '', resultSummary = '', opts = {}) {
  const { processWorkItemFailure = true, failureClass } = opts;
  let item = null;

  mutateDispatch((dispatch) => {
    // Check active list first
    let idx = dispatch.active.findIndex(d => d.id === id);
    if (idx >= 0) {
      item = dispatch.active.splice(idx, 1)[0];
    } else {
      // Also check pending list (e.g., worktree failure before spawn)
      idx = dispatch.pending.findIndex(d => d.id === id);
      if (idx >= 0) item = dispatch.pending.splice(idx, 1)[0];
    }

    if (!item) return dispatch;
    item.completed_at = ts();
    item.result = result;
    if (reason) item.reason = reason;
    if (resultSummary) item.resultSummary = resultSummary;
    if (failureClass && result === DISPATCH_RESULT.ERROR) item.failureClass = failureClass;
    delete item.prompt;
    if (dispatch.completed.length >= 100) {
      dispatch.completed = dispatch.completed.slice(-100);
    }
    dispatch.completed.push(item);
    return dispatch;
  });

  if (item) {
    log('info', `Completed dispatch: ${id} (${result}${reason ? ': ' + reason : ''})`);

    // Update source work item status on failure + auto-retry with backoff
    const retryableFailure = isRetryableFailureReason(reason, failureClass);
    if (result === DISPATCH_RESULT.ERROR && item.meta?.dispatchKey && retryableFailure) setCooldownFailure(item.meta.dispatchKey);

    if (processWorkItemFailure && result === DISPATCH_RESULT.ERROR && item.meta?.item?.id) {
      let retries = (item.meta.item._retryCount || 0);
      try {
        const wi = queries.getWorkItems().find(i => i.id === item.meta.item.id);
        if (wi) retries = wi._retryCount || 0;
      } catch (e) { log('warn', 'read retry count: ' + e.message); }
      const maxRetries = ENGINE_DEFAULTS.maxRetries;
      // Use per-class retry limits from recovery.js when failureClass is available
      const classAllowsRetry = failureClass ? recovery().shouldRetry(failureClass, retries) : (retries < maxRetries);
      if (retryableFailure && classAllowsRetry) {
        log('info', `Dispatch error for ${item.meta.item.id} — auto-retry ${retries + 1}/${maxRetries}${failureClass ? ' [' + failureClass + ']' : ''}`);
        lifecycle().updateWorkItemStatus(item.meta, WI_STATUS.PENDING, '');
        // Remove this dispatch key from completed so dedupe doesn't block immediate redispatch.
        if (item.meta?.dispatchKey) {
          try {
            mutateDispatch((dp) => {
              dp.completed = Array.isArray(dp.completed) ? dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey) : [];
              return dp;
            });
          } catch (e) { log('warn', 'clear dispatch for retry: ' + e.message); }
        }
        // Increment retry counter on the source work item
        try {
          const wiPath = lifecycle().resolveWorkItemPath(item.meta);
          if (wiPath) {
            mutateWorkItems(wiPath, items => {
              const wi = items.find(i => i.id === item.meta.item.id);
              if (wi && wi.status !== WI_STATUS.PAUSED && wi.status !== WI_STATUS.DONE && !wi.completedAt) {
                wi._retryCount = retries + 1;
                wi.status = WI_STATUS.PENDING;
                wi._lastRetryReason = reason || '';
                wi._lastRetryAt = ts();
                delete wi.failReason;
                delete wi.failedAt;
                delete wi.dispatched_at;
                delete wi.dispatched_to;
              }
            });
          }
        } catch (e) { log('warn', 'increment retry counter: ' + e.message); }
      } else {
        // Human-readable labels for each failure class — used as fallback when reason is empty
        const CLASS_LABELS = {
          [FAILURE_CLASS.EMPTY_OUTPUT]: 'agent produced no output \u2014 likely crashed on startup',
          [FAILURE_CLASS.BUILD_FAILURE]: 'build/test/lint failure in output',
          [FAILURE_CLASS.MERGE_CONFLICT]: 'merge conflict',
          [FAILURE_CLASS.MAX_TURNS]: 'reached max turn limit',
          [FAILURE_CLASS.TIMEOUT]: 'timed out waiting for agent',
          [FAILURE_CLASS.SPAWN_ERROR]: 'agent process failed to start',
          [FAILURE_CLASS.NETWORK_ERROR]: 'network or API error',
          [FAILURE_CLASS.OUT_OF_CONTEXT]: 'context window exhausted',
          [FAILURE_CLASS.CONFIG_ERROR]: 'configuration error',
          [FAILURE_CLASS.PERMISSION_BLOCKED]: 'permission or auth failure',
          [FAILURE_CLASS.UNKNOWN]: 'unknown error',
        };
        const classLabel = failureClass ? (CLASS_LABELS[failureClass] || failureClass) : '';
        const effectiveReason = reason || classLabel || 'Unknown error';
        const classSuffix = failureClass ? ` [${failureClass.toUpperCase().replace(/-/g, '_')}]` : '';
        const finalReason = !retryableFailure
          ? `Non-retryable failure: ${effectiveReason}${classSuffix}`
          : (reason || `Failed after ${maxRetries} retries${classSuffix}`);
        lifecycle().updateWorkItemStatus(item.meta, WI_STATUS.FAILED, finalReason);
        // Alert: find items blocked by this failure and write inbox note
        try {
          const config = getConfig();
          const failedId = item.meta.item.id;
          const blockedItems = [];
          const allItems = queries.getWorkItems(config);
          allItems.filter(w => w.status === WI_STATUS.PENDING && (w.depends_on || []).includes(failedId))
            .forEach(w => blockedItems.push(`- \`${w.id}\` — ${w.title}`));

          writeInboxAlert(`failed-${failedId}`,
            `# Work Item Failed — \`${failedId}\`\n\n` +
            `**Item:** ${item.meta.item.title || failedId}\n` +
            `**Reason:** ${finalReason}\n\n` +
            (blockedItems.length > 0
              ? `**Blocked dependents (${blockedItems.length}):**\n${blockedItems.join('\n')}\n\n` +
                `These items cannot dispatch until \`${failedId}\` is fixed and reset to \`pending\`.\n`
              : `No downstream items are blocked.\n`)
          );
        } catch (e) { log('warn', 'write failure alert: ' + e.message); }
      }
    }

    // Restore pendingFix on failed human-feedback fix so engine re-dispatches on next tick
    if (result === DISPATCH_RESULT.ERROR && item.meta?.source === 'pr-human-feedback') {
      const prId = item.meta.pr?.id;
      const project = item.meta.project;
      if (prId && project) {
        try {
          const prsPath = projectPrPath(project);
          mutatePullRequests(prsPath, prs => {
            const target = shared.findPrRecord(prs, { id: prId }, project);
            if (target?.humanFeedback) target.humanFeedback.pendingFix = true;
          });
          log('info', `Restored pendingFix=true on ${prId} after failed human-feedback fix`);
        } catch (e) { log('warn', `restore pendingFix: ${e.message}`); }
      }
      // Clear completed dispatch entry so dedup doesn't block re-dispatch
      if (item.meta?.dispatchKey) {
        try {
          mutateDispatch((dp) => {
            dp.completed = Array.isArray(dp.completed) ? dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey) : [];
            return dp;
          });
        } catch (e) { log('warn', 'clear human-feedback dispatch for retry: ' + e.message); }
      }
    }
  }
}

// ─── Inbox Alert ─────────────────────────────────────────────────────────────

function writeInboxAlert(slug, content) {
  try {
    const safeSlug = shared.safeSlugComponent(slug, 100);
    const file = path.join(INBOX_DIR, `engine-alert-${safeSlug}-${dateStamp()}.md`);
    // Dedupe: don't write the same alert twice in the same day
    const existing = safeReadDir(INBOX_DIR).find(f => f.startsWith(`engine-alert-${safeSlug}-${dateStamp()}`));
    if (existing) return;
    safeWrite(file, content);
  } catch (e) { log('warn', 'write inbox alert: ' + e.message); }
}

// ─── Agent Worker Status ────────────────────────────────────────────────────

/**
 * Update the worker-state fields on an active dispatch entry.
 * Uses mutateDispatch() for atomic read-modify-write.
 * @param {string} dispatchId — dispatch entry ID
 * @param {string} status — one of AGENT_STATUS values
 * @param {string} [detail] — optional human-readable detail string
 */
function updateAgentStatus(dispatchId, status, detail) {
  if (!dispatchId || !status) return;
  mutateDispatch((dispatch) => {
    const entry = (dispatch.active || []).find(d => d.id === dispatchId)
      || (dispatch.pending || []).find(d => d.id === dispatchId);
    if (entry) {
      entry.workerState = status;
      entry.workerStateAt = ts();
      if (detail !== undefined) entry.workerStateDetail = detail;
    }
    return dispatch;
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  mutateDispatch,
  addToDispatch,
  isRetryableFailureReason,
  completeDispatch,
  writeInboxAlert,
  updateAgentStatus,
};
