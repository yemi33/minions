/**
 * engine/cooldown.js — Dispatch cooldowns, deduplication, and context coalescing.
 * Extracted from engine.js.
 */

const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, mutateCooldowns, log, ENGINE_DEFAULTS } = shared;
const { ENGINE_DIR } = queries;

/**
 * Truncate any string fields on a pendingContexts entry so a single huge PR
 * comment / build log cannot bloat cooldowns.json to hundreds of MB (#1167).
 * Returns a new entry object (does not mutate the caller's copy).
 */
function _truncateContextEntry(entry, maxBytes) {
  if (entry == null) return entry;
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : ENGINE_DEFAULTS.maxPendingContextEntryBytes;
  if (typeof entry === 'string') {
    return Buffer.byteLength(entry, 'utf8') > limit
      ? entry.slice(0, limit) + `\n\n... [truncated: context exceeded ${Math.round(limit / 1024)} KB]`
      : entry;
  }
  if (typeof entry !== 'object') return entry;
  const out = Array.isArray(entry) ? [] : {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > limit) {
      out[k] = v.slice(0, limit) + `\n\n... [truncated: ${k} exceeded ${Math.round(limit / 1024)} KB]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const COOLDOWN_PATH = path.join(ENGINE_DIR, 'cooldowns.json');
const dispatchCooldowns = new Map(); // key → { timestamp, failures }
let _lastDiskCooldownKeys = new Set();

function loadCooldowns() {
  const saved = safeJson(COOLDOWN_PATH);
  if (!saved) return;
  const now = Date.now();
  for (const [k, v] of Object.entries(saved)) {
    // Prune entries older than 24 hours
    if (now - v.timestamp < 24 * 60 * 60 * 1000) {
      dispatchCooldowns.set(k, v);
    }
  }
  _lastDiskCooldownKeys = new Set(dispatchCooldowns.keys());
  log('info', `Loaded ${dispatchCooldowns.size} cooldowns from disk`);
}

let _cooldownWriteTimer = null;
function saveCooldowns() {
  // Debounce: reset timer on each call so latest state is always written
  if (_cooldownWriteTimer) clearTimeout(_cooldownWriteTimer);
  _cooldownWriteTimer = setTimeout(() => {
    _cooldownWriteTimer = null;
    try {
      mutateCooldowns((diskCooldowns) => {
        for (const key of Array.from(dispatchCooldowns.keys())) {
          if (_lastDiskCooldownKeys.has(key) && !Object.prototype.hasOwnProperty.call(diskCooldowns, key)) {
            dispatchCooldowns.delete(key);
          }
        }
        // Prune expired entries (>24h) before saving
        const now = Date.now();
        for (const [k, v] of dispatchCooldowns) {
          if (now - v.timestamp > 24 * 60 * 60 * 1000) dispatchCooldowns.delete(k);
        }
        // Trim pendingContexts arrays before writing to prevent bloat
        const cap = ENGINE_DEFAULTS.maxPendingContexts;
        const entryLimit = ENGINE_DEFAULTS.maxPendingContextEntryBytes;
        for (const [, v] of dispatchCooldowns) {
          if (Array.isArray(v.pendingContexts)) {
            if (v.pendingContexts.length > cap) {
              v.pendingContexts = v.pendingContexts.slice(-cap);
            }
            // Also truncate oversized individual entries — #1167 showed
            // 20 entries × 25 MB each still produced a 500 MB cooldowns.json.
            v.pendingContexts = v.pendingContexts.map(e => _truncateContextEntry(e, entryLimit));
          }
        }
        const obj = Object.fromEntries(dispatchCooldowns);
        _lastDiskCooldownKeys = new Set(Object.keys(obj));
        return obj;
      });
    } catch (err) {
      log('warn', `saveCooldowns failed writing ${COOLDOWN_PATH}: ${err.message}`);
    }
  }, 1000); // debounce — write at most once per second
}

function isOnCooldown(key, cooldownMs) {
  const entry = dispatchCooldowns.get(key);
  if (!entry) return false;
  const backoff = Math.min(Math.pow(2, entry.failures || 0), 8);
  return (Date.now() - entry.timestamp) < (cooldownMs * backoff);
}

function setCooldown(key) {
  const existing = dispatchCooldowns.get(key);
  dispatchCooldowns.set(key, { timestamp: Date.now(), failures: existing?.failures || 0 });
  saveCooldowns();
}

function setCooldownWithContext(key, context) {
  const existing = dispatchCooldowns.get(key);
  let pendingContexts = existing?.pendingContexts || [];
  if (context) {
    // Truncate oversized string fields per-entry BEFORE storing so a single
    // huge payload (PR diff, build log, full repo dump) cannot bloat
    // cooldowns.json regardless of array cap (#1167).
    pendingContexts.push(_truncateContextEntry(context, ENGINE_DEFAULTS.maxPendingContextEntryBytes));
  }
  // Cap to last N entries to prevent unbounded growth (cooldowns.json bloat)
  const cap = ENGINE_DEFAULTS.maxPendingContexts;
  if (pendingContexts.length > cap) pendingContexts = pendingContexts.slice(-cap);
  dispatchCooldowns.set(key, {
    timestamp: Date.now(),
    failures: existing?.failures || 0,
    pendingContexts
  });
  saveCooldowns();
}

// Drain pending coalesced contexts for a key, clearing the entry's
// pendingContexts and persisting the change. Returns [] for unknown / empty
// keys without side effects (no save, no phantom entry creation).
function drainCoalescedContexts(key) {
  const entry = dispatchCooldowns.get(key);
  if (!entry || !Array.isArray(entry.pendingContexts) || entry.pendingContexts.length === 0) {
    return [];
  }
  const contexts = entry.pendingContexts;
  entry.pendingContexts = [];
  saveCooldowns();
  return contexts;
}

function setCooldownFailure(key) {
  const existing = dispatchCooldowns.get(key);
  const failures = (existing?.failures || 0) + 1;
  dispatchCooldowns.set(key, { timestamp: Date.now(), failures });
  if (failures >= 3) {
    log('warn', `${key} has failed ${failures} times — cooldown is now ${Math.min(Math.pow(2, failures), 8)}x`);
  }
  saveCooldowns();
}

function clearCooldown(key) {
  if (!dispatchCooldowns.has(key)) return false;
  dispatchCooldowns.delete(key);
  saveCooldowns();
  return true;
}

function isAlreadyDispatched(key) {
  const dispatch = queries.getDispatch();
  // Check pending and active
  const inFlight = [...dispatch.pending, ...(dispatch.active || [])];
  if (inFlight.some(d => d.meta?.dispatchKey === key)) return true;
  // Also check recently completed — shorter window for errors (15min) vs success (1hr)
  const now = Date.now();
  const recentCompleted = (dispatch.completed || []).filter(d => {
    if (!d.completed_at) return false;
    const windowMs = d.result === 'error' ? 900000 : 3600000; // 15 min for errors, 1 hr for success
    return now - new Date(d.completed_at).getTime() < windowMs;
  });
  return recentCompleted.some(d => d.meta?.dispatchKey === key);
}

/**
 * Check if a branch is currently locked by an active dispatch.
 * Returns the conflicting dispatch item, or null if the branch is free.
 */
function isBranchActive(branch) {
  if (!branch) return null;
  const { sanitizeBranch } = require('./shared');
  const normalized = sanitizeBranch(branch);
  const dispatch = queries.getDispatch();
  return (dispatch.active || []).find(d => {
    const dBranch = d.meta?.branch;
    return dBranch && sanitizeBranch(dBranch) === normalized;
  }) || null;
}

module.exports = {
  COOLDOWN_PATH,
  dispatchCooldowns,
  loadCooldowns,
  saveCooldowns,
  isOnCooldown,
  setCooldown,
  setCooldownWithContext,
  drainCoalescedContexts,
  setCooldownFailure,
  clearCooldown,
  isAlreadyDispatched,
  isBranchActive,
  _truncateContextEntry, // exported for testing
};
