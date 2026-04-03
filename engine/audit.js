/**
 * engine/audit.js — Structured audit logging for auth and compliance events.
 *
 * Provides a dedicated audit trail separate from the general engine log.
 * Events are stored in engine/audit-log.json with structured fields for
 * searchability: user, action, resource, details, timestamp.
 *
 * Categories:
 *   auth      — login, logout, session events
 *   access    — permission checks, role changes
 *   mutation  — work item / plan / config changes
 *   admin     — settings changes, engine control
 */

const path = require('path');
const shared = require('./shared');

const AUDIT_LOG_PATH = path.join(__dirname, 'audit-log.json');
const MAX_ENTRIES = 5000;
const TRIM_TO = 4000;

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Record an audit event.
 * @param {string} action   — e.g. 'login', 'logout', 'permission_change', 'work_item_create'
 * @param {object} opts
 * @param {string} opts.user      — who performed the action (username, agent ID, 'system')
 * @param {string} opts.category  — 'auth' | 'access' | 'mutation' | 'admin'
 * @param {string} [opts.resource] — what was acted on (work item ID, plan file, config key)
 * @param {string} [opts.details]  — human-readable description
 * @param {object} [opts.meta]     — arbitrary metadata (old/new values, IP, etc.)
 */
function auditLog(action, { user, category, resource, details, meta } = {}) {
  const entry = {
    id: 'AUD-' + shared.uid(),
    timestamp: shared.ts(),
    action,
    category: category || 'mutation',
    user: user || 'unknown',
    resource: resource || null,
    details: details || null,
    meta: meta || null,
  };

  try {
    shared.mutateJsonFileLocked(AUDIT_LOG_PATH, (log) => {
      if (!Array.isArray(log)) log = [];
      log.push(entry);
      // Rotate when exceeding max
      if (log.length > MAX_ENTRIES) log.splice(0, log.length - TRIM_TO);
      return log;
    }, { defaultValue: [] });
  } catch (err) {
    // Audit logging should never crash the caller — fall back to general log
    shared.log('warn', `audit.js: failed to write audit entry: ${err.message}`);
  }

  return entry;
}

// ── Convenience helpers ─────────────────────────────────────────────────────

function auditLogin(user, details) {
  return auditLog('login', { user, category: 'auth', details: details || `User ${user} logged in` });
}

function auditLogout(user, details) {
  return auditLog('logout', { user, category: 'auth', details: details || `User ${user} logged out` });
}

function auditSessionCreate(user, sessionId) {
  return auditLog('session_create', { user, category: 'auth', resource: sessionId, details: `Session created for ${user}` });
}

function auditSessionExpire(user, sessionId) {
  return auditLog('session_expire', { user, category: 'auth', resource: sessionId, details: `Session expired for ${user}` });
}

function auditPermissionChange(user, targetUser, oldRole, newRole) {
  return auditLog('permission_change', {
    user, category: 'access',
    resource: targetUser,
    details: `Role changed for ${targetUser}: ${oldRole} -> ${newRole}`,
    meta: { targetUser, oldRole, newRole },
  });
}

function auditAccessDenied(user, resource, reason) {
  return auditLog('access_denied', {
    user, category: 'access',
    resource,
    details: reason || `Access denied to ${resource}`,
  });
}

function auditMutation(action, user, resource, details, meta) {
  return auditLog(action, { user, category: 'mutation', resource, details, meta });
}

function auditAdmin(action, user, details, meta) {
  return auditLog(action, { user, category: 'admin', details, meta });
}

// ── Query / Search ──────────────────────────────────────────────────────────

/**
 * Search the audit log with optional filters.
 * @param {object} filters
 * @param {string} [filters.user]      — exact match on user
 * @param {string} [filters.action]    — exact match on action
 * @param {string} [filters.category]  — exact match on category
 * @param {string} [filters.resource]  — substring match on resource
 * @param {string} [filters.q]         — full-text search across action, details, resource, user
 * @param {string} [filters.from]      — ISO date string lower bound (inclusive)
 * @param {string} [filters.to]        — ISO date string upper bound (inclusive)
 * @param {number} [filters.limit]     — max results (default 100)
 * @param {number} [filters.offset]    — skip N results (default 0)
 * @returns {{ entries: object[], total: number, hasMore: boolean }}
 */
function searchAuditLog(filters = {}) {
  const log = shared.safeJson(AUDIT_LOG_PATH);
  if (!Array.isArray(log)) return { entries: [], total: 0, hasMore: false };

  let results = log;

  // Filter by category
  if (filters.category) {
    results = results.filter(e => e.category === filters.category);
  }

  // Filter by user (exact)
  if (filters.user) {
    const u = filters.user.toLowerCase();
    results = results.filter(e => (e.user || '').toLowerCase() === u);
  }

  // Filter by action (exact)
  if (filters.action) {
    results = results.filter(e => e.action === filters.action);
  }

  // Filter by resource (substring)
  if (filters.resource) {
    const r = filters.resource.toLowerCase();
    results = results.filter(e => e.resource && e.resource.toLowerCase().includes(r));
  }

  // Full-text search
  if (filters.q) {
    const q = filters.q.toLowerCase();
    results = results.filter(e => {
      const haystack = [e.action, e.details, e.resource, e.user]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  // Date range
  if (filters.from) {
    results = results.filter(e => e.timestamp >= filters.from);
  }
  if (filters.to) {
    // Add a day to make 'to' inclusive for date-only strings
    const toDate = filters.to.length === 10 ? filters.to + 'T23:59:59.999Z' : filters.to;
    results = results.filter(e => e.timestamp <= toDate);
  }

  // Sort newest first
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = results.length;
  const offset = Math.max(0, parseInt(filters.offset) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(filters.limit) || 100));
  const page = results.slice(offset, offset + limit);

  return {
    entries: page,
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Get audit log summary stats (for dashboard widgets).
 */
function getAuditSummary() {
  const log = shared.safeJson(AUDIT_LOG_PATH);
  if (!Array.isArray(log)) return { total: 0, byCategory: {}, byAction: {}, recent: [] };

  const byCategory = {};
  const byAction = {};
  for (const entry of log) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    byAction[entry.action] = (byAction[entry.action] || 0) + 1;
  }

  return {
    total: log.length,
    byCategory,
    byAction,
    recent: log.slice(-10).reverse(),
  };
}

module.exports = {
  AUDIT_LOG_PATH,
  auditLog,
  auditLogin,
  auditLogout,
  auditSessionCreate,
  auditSessionExpire,
  auditPermissionChange,
  auditAccessDenied,
  auditMutation,
  auditAdmin,
  searchAuditLog,
  getAuditSummary,
};
