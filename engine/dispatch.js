/**
 * engine/dispatch.js — Dispatch queue management: add, complete, mutate, alerts.
 * Extracted from engine.js for modularity. No logic changes.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');
const { setCooldownFailure } = require('./cooldown');

const { safeJson, safeWrite, safeReadDir, mutateJsonFileLocked,
  getProjects, projectWorkItemsPath, log, ts, dateStamp,
  WI_STATUS, DISPATCH_RESULT, ENGINE_DEFAULTS } = shared;
const { getConfig, getDispatch, DISPATCH_PATH, INBOX_DIR } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;

// Lazy require to break circular dependency with engine.js
let _lifecycle = null;
function lifecycle() { if (!_lifecycle) _lifecycle = require('./lifecycle'); return _lifecycle; }

// ─── Dispatch Mutation ───────────────────────────────────────────────────────

function mutateDispatch(mutator) {
  const defaultDispatch = { pending: [], active: [], completed: [] };
  return mutateJsonFileLocked(DISPATCH_PATH, (dispatch) => {
    dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
    dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
    dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
    return mutator(dispatch) || dispatch;
  }, { defaultValue: defaultDispatch });
}

// ─── Add to Dispatch ─────────────────────────────────────────────────────────

function addToDispatch(item) {
  item.id = item.id || `${item.agent}-${item.type}-${shared.uid()}`;
  item.created_at = ts();
  mutateDispatch((dispatch) => {
    dispatch.pending.push(item);
    return dispatch;
  });
  log('info', `Queued dispatch: ${item.id} (${item.type} → ${item.agent})`);
  return item.id;
}

// ─── Retryable Failure Classification ────────────────────────────────────────

function isRetryableFailureReason(reason = '') {
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
  const { processWorkItemFailure = true } = opts;
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
    delete item.prompt;
    if (dispatch.completed.length > 100) {
      dispatch.completed = dispatch.completed.slice(-100);
    }
    dispatch.completed.push(item);
    return dispatch;
  });

  if (item) {
    log('info', `Completed dispatch: ${id} (${result}${reason ? ': ' + reason : ''})`);

    // Update source work item status on failure + auto-retry with backoff
    const retryableFailure = isRetryableFailureReason(reason);
    if (result === DISPATCH_RESULT.ERROR && item.meta?.dispatchKey && retryableFailure) setCooldownFailure(item.meta.dispatchKey);

    if (processWorkItemFailure && result === DISPATCH_RESULT.ERROR && item.meta?.item?.id) {
      let retries = (item.meta.item._retryCount || 0);
      try {
        const wiPath = lifecycle().resolveWorkItemPath(item.meta);
        if (wiPath) {
          const items = safeJson(wiPath);
          if (items && Array.isArray(items)) {
            const wi = items.find(i => i.id === item.meta.item.id);
            if (wi) retries = wi._retryCount || 0;
          }
        }
      } catch (e) { log('warn', 'read retry count: ' + e.message); }
      const maxRetries = ENGINE_DEFAULTS.maxRetries;
      if (retryableFailure && retries < maxRetries) {
        log('info', `Dispatch error for ${item.meta.item.id} — auto-retry ${retries + 1}/${maxRetries}`);
        lifecycle().updateWorkItemStatus(item.meta, 'pending', '');
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
            const items = safeJson(wiPath);
            if (!items || !Array.isArray(items)) throw new Error('work items unreadable');
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
              safeWrite(wiPath, items);
            }
          }
        } catch (e) { log('warn', 'increment retry counter: ' + e.message); }
      } else {
        const finalReason = !retryableFailure
          ? `Non-retryable failure: ${reason || 'Unknown error'}`
          : (reason || `Failed after ${maxRetries} retries`);
        lifecycle().updateWorkItemStatus(item.meta, 'failed', finalReason);
        // Alert: find items blocked by this failure and write inbox note
        try {
          const config = getConfig();
          const failedId = item.meta.item.id;
          const blockedItems = [];
          for (const p of getProjects(config)) {
            const items = safeJson(projectWorkItemsPath(p)) || [];
            items.filter(w => w.status === WI_STATUS.PENDING && (w.depends_on || []).includes(failedId))
              .forEach(w => blockedItems.push(`- \`${w.id}\` — ${w.title}`));
          }
          const centralItems = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
          centralItems.filter(w => w.status === WI_STATUS.PENDING && (w.depends_on || []).includes(failedId))
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
  }
}

// ─── Inbox Alert ─────────────────────────────────────────────────────────────

function writeInboxAlert(slug, content) {
  try {
    const file = path.join(INBOX_DIR, `engine-alert-${slug}-${dateStamp()}.md`);
    // Dedupe: don't write the same alert twice in the same day
    const existing = safeReadDir(INBOX_DIR).find(f => f.startsWith(`engine-alert-${slug}-${dateStamp()}`));
    if (existing) return;
    safeWrite(file, content);
  } catch (e) { log('warn', 'write inbox alert: ' + e.message); }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  mutateDispatch,
  addToDispatch,
  isRetryableFailureReason,
  completeDispatch,
  writeInboxAlert,
};
