/**
 * engine/cooldown.js — Dispatch cooldowns, deduplication, and context coalescing.
 * Extracted from engine.js.
 */

const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, safeWrite, log } = shared;
const { ENGINE_DIR } = queries;

const COOLDOWN_PATH = path.join(ENGINE_DIR, 'cooldowns.json');
const dispatchCooldowns = new Map(); // key → { timestamp, failures }

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
  log('info', `Loaded ${dispatchCooldowns.size} cooldowns from disk`);
}

let _cooldownWriteTimer = null;
function saveCooldowns() {
  // Debounce: reset timer on each call so latest state is always written
  if (_cooldownWriteTimer) clearTimeout(_cooldownWriteTimer);
  _cooldownWriteTimer = setTimeout(() => {
    _cooldownWriteTimer = null;
    // Prune expired entries (>24h) before saving
    const now = Date.now();
    for (const [k, v] of dispatchCooldowns) {
      if (now - v.timestamp > 24 * 60 * 60 * 1000) dispatchCooldowns.delete(k);
    }
    const obj = Object.fromEntries(dispatchCooldowns);
    try {
      safeWrite(COOLDOWN_PATH, obj);
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
  const pendingContexts = existing?.pendingContexts || [];
  if (context) pendingContexts.push(context);
  dispatchCooldowns.set(key, {
    timestamp: Date.now(),
    failures: existing?.failures || 0,
    pendingContexts
  });
  saveCooldowns();
}

function getCoalescedContexts(key) {
  const entry = dispatchCooldowns.get(key);
  const contexts = entry?.pendingContexts || [];
  if (contexts.length > 0 && entry) {
    entry.pendingContexts = []; // Clear after retrieval
  }
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
  getCoalescedContexts,
  setCooldownFailure,
  isAlreadyDispatched,
  isBranchActive,
};
