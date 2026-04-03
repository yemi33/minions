/**
 * engine/cooldown.js — Dispatch cooldowns, deduplication, and context coalescing.
 * Extracted from engine.js.
 */

const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { createHash } = require('crypto');
const { safeJson, safeWrite, log } = shared;
const { ENGINE_DIR } = queries;

const COOLDOWN_PATH = path.join(ENGINE_DIR, 'cooldowns.json');
const PENDING_CONTEXTS_CAP = 10;
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
  // One-time purge of bloated pendingContexts on startup
  purgeBloatedCooldowns();
}

/** Deduplicate and cap pendingContexts in all loaded cooldown entries. */
function purgeBloatedCooldowns() {
  let totalRemoved = 0;
  for (const [k, v] of dispatchCooldowns) {
    if (!Array.isArray(v.pendingContexts) || v.pendingContexts.length <= 1) continue;
    const seen = new Set();
    const deduped = [];
    for (const ctx of v.pendingContexts) {
      const hash = _contentHash(ctx);
      if (!seen.has(hash)) {
        seen.add(hash);
        deduped.push(ctx);
      }
    }
    const before = v.pendingContexts.length;
    // Apply FIFO cap after dedup — keep the most recent entries
    v.pendingContexts = deduped.length > PENDING_CONTEXTS_CAP
      ? deduped.slice(deduped.length - PENDING_CONTEXTS_CAP)
      : deduped;
    totalRemoved += before - v.pendingContexts.length;
  }
  if (totalRemoved > 0) {
    log('info', `Purged ${totalRemoved} duplicate/excess pendingContexts entries from cooldowns`);
    saveCooldowns();
  }
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
    safeWrite(COOLDOWN_PATH, obj);
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

function _contentHash(content) {
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  return createHash('sha256').update(str).digest('hex');
}

function setCooldownWithContext(key, context) {
  const existing = dispatchCooldowns.get(key);
  const pendingContexts = existing?.pendingContexts || [];
  if (context) {
    // Dedup: only append if content differs from all existing entries
    const newHash = _contentHash(context);
    const isDuplicate = pendingContexts.some(c => _contentHash(c) === newHash);
    if (!isDuplicate) {
      pendingContexts.push(context);
      // FIFO cap: drop oldest entries when exceeding cap
      while (pendingContexts.length > PENDING_CONTEXTS_CAP) {
        pendingContexts.shift();
      }
    }
  }
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
  // Also check recently completed (last hour) to prevent re-dispatch
  const oneHourAgo = Date.now() - 3600000;
  const recentCompleted = (dispatch.completed || []).filter(d =>
    d.completed_at && new Date(d.completed_at).getTime() > oneHourAgo
  );
  return recentCompleted.some(d => d.meta?.dispatchKey === key);
}

module.exports = {
  COOLDOWN_PATH,
  PENDING_CONTEXTS_CAP,
  dispatchCooldowns,
  loadCooldowns,
  saveCooldowns,
  purgeBloatedCooldowns,
  isOnCooldown,
  setCooldown,
  setCooldownWithContext,
  getCoalescedContexts,
  setCooldownFailure,
  isAlreadyDispatched,
  _contentHash,
};
