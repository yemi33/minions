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
  sidecarDispatchPrompt, deleteDispatchPromptSidecar,
  WI_STATUS, DISPATCH_RESULT, ENGINE_DEFAULTS, AGENT_STATUS, FAILURE_CLASS, PR_STATUS } = shared;
const { getConfig, getDispatch, DISPATCH_PATH, INBOX_DIR } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;

// Lazy require to break circular dependency with engine.js
let _lifecycle = null;
function lifecycle() { if (!_lifecycle) _lifecycle = require('./lifecycle'); return _lifecycle; }
let _recovery = null;
function recovery() { if (!_recovery) _recovery = require('./recovery'); return _recovery; }

// ─── Dispatch Mutation ───────────────────────────────────────────────────────

/**
 * Sweep pending + active dispatch entries and move any oversized prompts to
 * sidecar files. Keeps dispatch.json from bloating to hundreds of MB when
 * fix-type prompts inline PR diffs / build logs / coalesced feedback (#1167).
 * Safe to call on every mutation: small prompts are untouched.
 */
function _sidecarOversizedPrompts(dispatch) {
  const threshold = ENGINE_DEFAULTS.maxDispatchPromptBytes;
  const lists = [dispatch.pending, dispatch.active];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item.prompt === 'string') sidecarDispatchPrompt(item, threshold);
    }
  }
}

function mutateDispatch(mutator) {
  const defaultDispatch = { pending: [], active: [], completed: [] };
  const result = mutateJsonFileLocked(DISPATCH_PATH, (dispatch) => {
    dispatch.pending = Array.isArray(dispatch.pending) ? dispatch.pending : [];
    dispatch.active = Array.isArray(dispatch.active) ? dispatch.active : [];
    dispatch.completed = Array.isArray(dispatch.completed) ? dispatch.completed : [];
    const next = mutator(dispatch) ?? dispatch;
    // Prompt-size guard: runs on every write so a single bad item cannot bloat
    // dispatch.json. Sidecars live in engine/contexts/<id>.md.
    _sidecarOversizedPrompts(next);
    return next;
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

function _resolveDispatchProject(projectRef, config) {
  if (!projectRef) return null;
  const projects = getProjects(config);
  if (projectRef.name) {
    const byName = projects.find(p => p.name === projectRef.name);
    if (byName) return byName;
  }
  if (projectRef.localPath) {
    const refPath = path.resolve(projectRef.localPath);
    const byPath = projects.find(p => p.localPath && path.resolve(p.localPath) === refPath);
    if (byPath) return byPath;
  }
  return projectRef;
}

function _isPrBackedDispatch(entry) {
  return !!(entry?.meta?.pr && entry.meta?.project);
}

function getStalePrDispatchReason(entry, config) {
  if (!_isPrBackedDispatch(entry)) return '';
  const project = _resolveDispatchProject(entry.meta.project, config);
  if (!project) return 'missing project metadata';

  const tracked = shared.findPrRecord(queries.getPrs(project), entry.meta.pr, project);
  const prLabel = entry.meta.pr?.id || entry.meta.pr?.url || entry.id;
  if (!tracked) return `PR ${prLabel} is no longer tracked`;
  if (tracked.status !== PR_STATUS.ACTIVE) return `PR ${tracked.id || prLabel} is ${tracked.status || 'missing status'}`;
  if (tracked._contextOnly) return `PR ${tracked.id || prLabel} is context-only`;

  const queuedBranch = entry.meta.branch || entry.meta.pr?.branch || '';
  const trackedBranch = tracked.branch || '';
  if (queuedBranch && trackedBranch && shared.sanitizeBranch(queuedBranch) !== shared.sanitizeBranch(trackedBranch)) {
    return `PR ${tracked.id || prLabel} branch changed from ${queuedBranch} to ${trackedBranch}`;
  }

  return '';
}

function pruneStalePrDispatches(config = queries.getConfig()) {
  const removed = [];
  mutateDispatch((dispatch) => {
    dispatch.pending = (dispatch.pending || []).filter(entry => {
      const reason = getStalePrDispatchReason(entry, config);
      if (!reason) return true;
      removed.push({ entry, reason });
      return false;
    });
    return dispatch;
  });

  for (const { entry, reason } of removed) {
    try { deleteDispatchPromptSidecar(entry); } catch { /* cleanup best-effort */ }
    log('info', `Dropped stale PR dispatch ${entry.id}: ${reason}`);
  }
  return removed.length;
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
    'auth failure',
    'authentication failed',
    'authentication failure',
    'unauthorized',
    'invalid api key',
    'please log in',
    'budget-exceeded',
    'budget exceeded',
    'budget cap exceeded',
    'max-budget-usd',
    'cost limit',
  ];
  return !nonRetryable.some(s => r.includes(s));
}

function isCompletedWorkItemForFailure(item) {
  return !!item && (
    item.status === WI_STATUS.DONE ||
    (!!item.completedAt && (!!item._pr || !!item._prUrl))
  );
}

function readLiveWorkItem(meta) {
  const itemId = meta?.item?.id;
  if (!itemId) return null;
  const wiPath = lifecycle().resolveWorkItemPath(meta);
  if (!wiPath) return null;
  const items = safeJson(wiPath) || [];
  return Array.isArray(items) ? items.find(i => i.id === itemId) || null : null;
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
    // Drop prompt (and sidecar file, if any) — completed entries don't need
    // replayable content and it would accumulate forever (#1167).
    try { deleteDispatchPromptSidecar(item); } catch { /* best-effort */ }
    delete item.prompt;
    delete item._promptFile;
    delete item._promptBytes;
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
    let completedWorkItemFailure = false;
    if (processWorkItemFailure && result === DISPATCH_RESULT.ERROR && item.meta?.item?.id) {
      // If the live item cannot be resolved, keep the existing retry path.
      try {
        completedWorkItemFailure = isCompletedWorkItemForFailure(readLiveWorkItem(item.meta));
      } catch (e) { log('warn', 'read live work item before retry: ' + e.message); }
    }
    if (result === DISPATCH_RESULT.ERROR && item.meta?.dispatchKey && retryableFailure && !completedWorkItemFailure) {
      setCooldownFailure(item.meta.dispatchKey);
    }

    if (processWorkItemFailure && result === DISPATCH_RESULT.ERROR && item.meta?.item?.id) {
      if (completedWorkItemFailure) {
        log('info', `Dispatch error for ${item.meta.item.id} ignored — work item is already completed`);
      } else {
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
                  delete wi._pendingReason;
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
          // Surface blocked dependents in logs without creating failure inbox noise.
          try {
            const config = getConfig();
            const failedId = item.meta.item.id;
            const blockedItems = [];
            const allItems = queries.getWorkItems(config);
            allItems.filter(w => w.status === WI_STATUS.PENDING && (w.depends_on || []).includes(failedId))
              .forEach(w => blockedItems.push(`- \`${w.id}\` — ${w.title}`));

            log('warn', `Work item ${failedId} failed: ${finalReason}` +
              (blockedItems.length > 0 ? `; blocked dependents: ${blockedItems.map(line => line.replace(/^- `([^`]+)`.*/, '$1')).join(', ')}` : '; no downstream items blocked'));
          } catch (e) { log('warn', 'summarize failure dependents: ' + e.message); }
        }
      }
    }

    // Restore pendingFix on failed human-feedback fix so engine re-dispatches on next tick
    if (result === DISPATCH_RESULT.ERROR && item.meta?.source === 'pr-human-feedback') {
      const prId = item.meta.pr?.id;
      const project = item.meta.project;
      if (prId && project) {
        try {
          const prsPath = projectPrPath(project);
          let restored = false;
          mutatePullRequests(prsPath, prs => {
            const target = shared.findPrRecord(prs, { id: prId }, project);
            if (target?.humanFeedback) {
              target.humanFeedback.pendingFix = true;
              restored = true;
            }
          });
          if (restored) log('info', `Restored pendingFix=true on ${prId} after failed human-feedback fix`);
          else log('info', `Skipped pendingFix restore for ${prId} — PR is no longer tracked`);
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

// ─── Cancel Pending Dispatches for Closed PR ───────────────────────────────

/**
 * Cancel all pending dispatch entries that reference a specific PR.
 * Called when a PR transitions to merged/abandoned/closed — any pending
 * review, fix, or re-review dispatches for that PR are stale and should
 * not be spawned.
 * @param {string} prId — PR identifier (e.g. 'PR-100')
 * @returns {number} count of cancelled entries
 */
function cancelPendingDispatchesForPr(prId) {
  if (!prId) return 0;
  let cancelled = 0;
  mutateDispatch((dispatch) => {
    const before = dispatch.pending.length;
    dispatch.pending = dispatch.pending.filter(d => d.meta?.pr?.id !== prId);
    cancelled = before - dispatch.pending.length;
    return dispatch;
  });
  if (cancelled > 0) {
    log('info', `Cancelled ${cancelled} pending dispatch(es) for closed PR ${prId}`);
  }
  return cancelled;
}

/**
 * Remove dispatch entries matching a predicate from pending/active/completed.
 * For matched active entries, kills the agent process and deletes its
 * pid file + prompt sidecars in engine/tmp/. Lock callback only mutates state;
 * kills and unlinks happen after release.
 *
 * @param {(entry) => boolean} matchFn
 * @returns {number} count of removed entries
 */
function cleanDispatchEntries(matchFn) {
  const dispatchPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
  const tmpDir = path.join(MINIONS_DIR, 'engine', 'tmp');
  let removed = 0;
  const pidsToKill = [];
  const filesToDelete = [];
  try {
    mutateJsonFileLocked(dispatchPath, (dispatch) => {
      for (const queue of ['pending', 'active', 'completed']) {
        dispatch[queue] = Array.isArray(dispatch[queue]) ? dispatch[queue] : [];
        const before = dispatch[queue].length;
        if (queue === 'active') {
          for (const d of dispatch[queue]) {
            if (!matchFn(d)) continue;
            // PID files live in engine/tmp/ (see engine/spawn-agent.js:220 — derived
            // from the prompt-<id>.md path that engine.js builds in engine/tmp/).
            const pidFile = path.join(tmpDir, `pid-${d.id}.pid`);
            try {
              const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
              if (pid) pidsToKill.push(pid);
            } catch { /* PID file may not exist */ }
            filesToDelete.push(pidFile);
            filesToDelete.push(path.join(tmpDir, `prompt-${d.id}.md`));
            filesToDelete.push(path.join(tmpDir, `sysprompt-${d.id}.md`));
            filesToDelete.push(path.join(tmpDir, `sysprompt-${d.id}.md.tmp`));
          }
        }
        dispatch[queue] = dispatch[queue].filter(d => !matchFn(d));
        removed += before - dispatch[queue].length;
      }
      return dispatch;
    }, { defaultValue: { pending: [], active: [], completed: [] } });
  } catch { return 0; }
  // Kill processes outside the lock — taskkill on Windows can take hundreds of ms
  for (const pid of pidsToKill) {
    try {
      const safePid = shared.validatePid(pid);
      if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        execFileSync('taskkill', ['/PID', String(safePid), '/T'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
      } else {
        process.kill(safePid, 'SIGTERM');
      }
    } catch { /* may already be dead */ }
  }
  for (const fp of filesToDelete) {
    try { fs.unlinkSync(fp); } catch { /* may not exist */ }
  }
  return removed;
}

/**
 * Cancel pending/queued work items matching a predicate. Done items pass through.
 * Sets status=CANCELLED + _cancelledBy=reason. Returns count cancelled.
 */
function cancelPendingWorkItems(wiPath, matchFn, reason) {
  if (!fs.existsSync(wiPath)) return 0;
  let cancelled = 0;
  try {
    mutateWorkItems(wiPath, items => {
      for (const w of items) {
        if (!matchFn(w)) continue;
        if (w.status !== WI_STATUS.PENDING && w.status !== WI_STATUS.QUEUED) continue;
        w.status = WI_STATUS.CANCELLED;
        if (reason) w._cancelledBy = reason;
        cancelled++;
      }
    });
  } catch { /* file unwritable */ }
  return cancelled;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  mutateDispatch,
  addToDispatch,
  isRetryableFailureReason,
  completeDispatch,
  writeInboxAlert,
  updateAgentStatus,
  getStalePrDispatchReason,
  pruneStalePrDispatches,
  cancelPendingDispatchesForPr,
  cleanDispatchEntries,
  cancelPendingWorkItems,
};
