/**
 * engine/rbac.js — Role-Based Access Control for Minions dashboard.
 *
 * Roles: admin > editor > viewer (hierarchical).
 * Permissions are checked per-route via middleware that reads the
 * X-Minions-User header (or `user` query param) and resolves the
 * user's role from rbac.json.
 *
 * When RBAC is disabled (default) all requests pass through unchecked.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const RBAC_PATH = path.join(__dirname, '..', 'engine', 'rbac.json');

// ── Role Hierarchy ──────────────────────────────────────────────────────────

const ROLES = ['viewer', 'editor', 'admin'];
const ROLE_RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));

/**
 * Returns true if `role` is at least as privileged as `minRole`.
 */
function roleAtLeast(role, minRole) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? Infinity);
}

// ── Permission Definitions ──────────────────────────────────────────────────
// Maps route keys (METHOD /path) to the minimum role required.
// Routes not listed here default to 'viewer' (read-only safe default when
// RBAC is enabled).

const WRITE_ROUTES = new Set([
  'POST /api/work-items',
  'POST /api/work-items/update',
  'POST /api/work-items/retry',
  'POST /api/work-items/delete',
  'POST /api/work-items/archive',
  'POST /api/work-items/feedback',
  'POST /api/plan',
  'POST /api/plans/approve',
  'POST /api/plans/pause',
  'POST /api/plans/execute',
  'POST /api/plans/reject',
  'POST /api/plans/regenerate',
  'POST /api/plans/delete',
  'POST /api/plans/archive',
  'POST /api/plans/unarchive',
  'POST /api/plans/revise',
  'POST /api/plans/discuss',
  'POST /api/plans/trigger-verify',
  'POST /api/prd-items',
  'POST /api/prd-items/update',
  'POST /api/prd-items/remove',
  'POST /api/prd/regenerate',
  'POST /api/notes',
  'POST /api/notes-save',
  'POST /api/pinned',
  'POST /api/pinned/remove',
  'POST /api/agents/charter',
  'POST /api/agents/steer',
  'POST /api/agents/cancel',
  'POST /api/knowledge',
  'POST /api/knowledge/sweep',
  'POST /api/doc-chat',
  'POST /api/inbox/persist',
  'POST /api/inbox/promote-kb',
  'POST /api/inbox/open',
  'POST /api/inbox/delete',
  'POST /api/projects/browse',
  'POST /api/projects/scan',
  'POST /api/projects/add',
  'POST /api/command-center',
  'POST /api/command-center/new-session',
  'POST /api/schedules',
  'POST /api/schedules/update',
  'POST /api/schedules/delete',
  'POST /api/schedules/parse-natural',
  'POST /api/pipelines',
  'POST /api/pipelines/update',
  'POST /api/pipelines/delete',
  'POST /api/pipelines/trigger',
  'POST /api/pipelines/continue',
  'POST /api/meetings',
  'POST /api/meetings/note',
  'POST /api/meetings/advance',
  'POST /api/meetings/end',
  'POST /api/meetings/archive',
  'POST /api/meetings/unarchive',
  'POST /api/meetings/delete',
]);

const ADMIN_ROUTES = new Set([
  'POST /api/engine/wakeup',
  'POST /api/engine/restart',
  'POST /api/settings',
  'POST /api/settings/routing',
  'POST /api/rbac/users',
  'POST /api/rbac/users/update',
  'POST /api/rbac/users/delete',
]);

/**
 * Determine the minimum role required for a given method + pathname.
 */
function requiredRole(method, pathname) {
  const key = `${method} ${pathname}`;
  if (ADMIN_ROUTES.has(key)) return 'admin';
  if (WRITE_ROUTES.has(key)) return 'editor';
  return 'viewer';
}

// ── State I/O ───────────────────────────────────────────────────────────────

/**
 * Load RBAC state from disk. Returns:
 * { enabled: boolean, defaultRole: string, users: { [username]: { role, createdAt, updatedAt } } }
 */
function loadRbac() {
  const data = shared.safeJson(RBAC_PATH);
  return {
    enabled: false,
    defaultRole: 'editor',
    users: {},
    ...data,
  };
}

function saveRbac(state) {
  shared.safeWrite(RBAC_PATH, state);
}

// ── User Resolution ─────────────────────────────────────────────────────────

/**
 * Extract username from the request. Checks:
 *   1. X-Minions-User header
 *   2. `user` query parameter
 * Returns null if no user is identified.
 */
function resolveUser(req) {
  const header = req.headers['x-minions-user'];
  if (header) return header.trim().toLowerCase();
  const url = new URL(req.url, 'http://localhost');
  const param = url.searchParams.get('user');
  if (param) return param.trim().toLowerCase();
  return null;
}

/**
 * Get the effective role for a user. Falls back to defaultRole for
 * unknown users, or 'viewer' if defaultRole is not set.
 */
function getUserRole(username, rbacState) {
  if (!username) return rbacState.defaultRole || 'editor';
  const entry = rbacState.users[username];
  if (entry) return entry.role;
  return rbacState.defaultRole || 'editor';
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * RBAC check function. Call at the top of the route dispatcher.
 * Returns null if the request is allowed, or an error object { code, error } if denied.
 *
 * @param {http.IncomingMessage} req
 * @param {string} method - HTTP method
 * @param {string} pathname - URL pathname (no query string)
 * @returns {{ code: number, error: string } | null}
 */
function checkAccess(req, method, pathname) {
  const rbac = loadRbac();
  if (!rbac.enabled) return null; // RBAC disabled — allow everything

  const username = resolveUser(req);
  const role = getUserRole(username, rbac);
  const minRole = requiredRole(method, pathname);

  if (!roleAtLeast(role, minRole)) {
    return {
      code: 403,
      error: `Forbidden: role '${role}' insufficient for ${method} ${pathname} (requires '${minRole}')`,
      user: username,
      role,
      required: minRole,
    };
  }

  // Attach user info to request for downstream handlers
  req._rbacUser = username;
  req._rbacRole = role;
  return null;
}

// ── API Handlers (mounted by dashboard.js) ──────────────────────────────────

/** GET /api/rbac — Return RBAC config and user list. */
function handleRbacStatus(_req, res, _match, jsonReply) {
  const rbac = loadRbac();
  return jsonReply(res, 200, {
    enabled: rbac.enabled,
    defaultRole: rbac.defaultRole,
    roles: ROLES,
    roleHierarchy: ROLE_RANK,
    users: Object.entries(rbac.users).map(([name, u]) => ({
      username: name,
      role: u.role,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    })),
  });
}

/** POST /api/rbac/toggle — Enable or disable RBAC. Body: { enabled: bool } */
function handleRbacToggle(req, res, _match, jsonReply, readBody) {
  return readBody(req).then(body => {
    if (typeof body.enabled !== 'boolean') {
      return jsonReply(res, 400, { error: 'enabled (boolean) required' });
    }
    const rbac = loadRbac();
    rbac.enabled = body.enabled;
    saveRbac(rbac);
    shared.log('info', `RBAC ${body.enabled ? 'enabled' : 'disabled'}`, { user: req._rbacUser });
    return jsonReply(res, 200, { ok: true, enabled: rbac.enabled });
  });
}

/** POST /api/rbac/default-role — Set the default role. Body: { role: string } */
function handleRbacDefaultRole(req, res, _match, jsonReply, readBody) {
  return readBody(req).then(body => {
    if (!body.role || !ROLES.includes(body.role)) {
      return jsonReply(res, 400, { error: `role must be one of: ${ROLES.join(', ')}` });
    }
    const rbac = loadRbac();
    rbac.defaultRole = body.role;
    saveRbac(rbac);
    shared.log('info', `RBAC default role set to '${body.role}'`, { user: req._rbacUser });
    return jsonReply(res, 200, { ok: true, defaultRole: rbac.defaultRole });
  });
}

/** POST /api/rbac/users — Create or update a user role. Body: { username, role } */
function handleRbacUsersCreate(req, res, _match, jsonReply, readBody) {
  return readBody(req).then(body => {
    const { username, role } = body;
    if (!username || typeof username !== 'string') {
      return jsonReply(res, 400, { error: 'username (string) required' });
    }
    if (!role || !ROLES.includes(role)) {
      return jsonReply(res, 400, { error: `role must be one of: ${ROLES.join(', ')}` });
    }
    const name = username.trim().toLowerCase();
    if (!name || name.length > 64 || /[^a-z0-9._@-]/.test(name)) {
      return jsonReply(res, 400, { error: 'username must be 1-64 chars: a-z, 0-9, . _ @ -' });
    }
    const rbac = loadRbac();
    const existing = rbac.users[name];
    const now = new Date().toISOString();
    rbac.users[name] = {
      role,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    saveRbac(rbac);
    shared.log('info', `RBAC user '${name}' set to role '${role}'`, { user: req._rbacUser });
    return jsonReply(res, 200, { ok: true, username: name, role });
  });
}

/** POST /api/rbac/users/update — Alias for create (upsert semantics). */
const handleRbacUsersUpdate = handleRbacUsersCreate;

/** POST /api/rbac/users/delete — Remove a user. Body: { username } */
function handleRbacUsersDelete(req, res, _match, jsonReply, readBody) {
  return readBody(req).then(body => {
    const { username } = body;
    if (!username) return jsonReply(res, 400, { error: 'username required' });
    const name = username.trim().toLowerCase();
    const rbac = loadRbac();
    if (!rbac.users[name]) {
      return jsonReply(res, 404, { error: `user '${name}' not found` });
    }
    delete rbac.users[name];
    saveRbac(rbac);
    shared.log('info', `RBAC user '${name}' deleted`, { user: req._rbacUser });
    return jsonReply(res, 200, { ok: true, deleted: name });
  });
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ROLES,
  ROLE_RANK,
  roleAtLeast,
  requiredRole,
  loadRbac,
  saveRbac,
  resolveUser,
  getUserRole,
  checkAccess,
  // Route handlers
  handleRbacStatus,
  handleRbacToggle,
  handleRbacDefaultRole,
  handleRbacUsersCreate,
  handleRbacUsersUpdate,
  handleRbacUsersDelete,
  // For testing
  RBAC_PATH,
  WRITE_ROUTES,
  ADMIN_ROUTES,
};
