/**
 * engine/auth.js — OAuth2 Authentication Middleware
 *
 * JWT-based authentication with refresh token rotation and token blacklisting.
 * Zero external dependencies — uses Node.js built-in crypto module.
 *
 * Architecture:
 *   - Access tokens: HS256 JWT, short-lived (configurable, default 15min)
 *   - Refresh tokens: opaque random tokens, longer-lived (default 7d), rotated on use
 *   - Token blacklist: in-memory Set with periodic file-backed persistence
 *   - User store: file-backed JSON (engine/auth-users.json)
 *
 * Usage:
 *   const auth = require('./engine/auth');
 *   // In http.createServer handler:
 *   if (auth.isProtectedRoute(url)) {
 *     const user = auth.authenticate(req);
 *     if (!user) return auth.unauthorized(res);
 *   }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENGINE_DIR = __dirname;
const AUTH_USERS_PATH = path.join(ENGINE_DIR, 'auth-users.json');
const AUTH_TOKENS_PATH = path.join(ENGINE_DIR, 'auth-tokens.json');
const AUTH_BLACKLIST_PATH = path.join(ENGINE_DIR, 'auth-blacklist.json');

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  accessTokenTTL: 15 * 60,          // 15 minutes (seconds)
  refreshTokenTTL: 7 * 24 * 60 * 60, // 7 days (seconds)
  issuer: 'minions-engine',
  audience: 'minions-dashboard',
  bcryptRounds: 10,                  // not used — we use PBKDF2
  pbkdf2Iterations: 100000,
  pbkdf2KeyLen: 64,
  pbkdf2Digest: 'sha512',
  blacklistPersistInterval: 60000,   // persist blacklist every 60s
  maxRefreshTokensPerUser: 10,       // limit refresh tokens per user
};

let _config = { ...DEFAULT_CONFIG };
let _jwtSecret = null;

// ── Secret Management ──────────────────────────────────────────────────────

const SECRET_PATH = path.join(ENGINE_DIR, 'auth-secret.key');

/**
 * Get or create the JWT signing secret.
 * Persisted to disk so tokens survive restarts.
 */
function getJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  try {
    const existing = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (existing.length >= 32) {
      _jwtSecret = existing;
      return _jwtSecret;
    }
  } catch { /* file doesn't exist — generate */ }

  _jwtSecret = crypto.randomBytes(64).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    fs.writeFileSync(SECRET_PATH, _jwtSecret, { mode: 0o600 });
  } catch (e) {
    console.error('[auth] Warning: could not persist JWT secret:', e.message);
  }
  return _jwtSecret;
}

// ── Password Hashing (PBKDF2) ─────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(
    password, salt,
    _config.pbkdf2Iterations, _config.pbkdf2KeyLen, _config.pbkdf2Digest
  ).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHash] = stored.split(':');
  if (!salt || !expectedHash) return false;
  const hash = crypto.pbkdf2Sync(
    password, salt,
    _config.pbkdf2Iterations, _config.pbkdf2KeyLen, _config.pbkdf2Digest
  ).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// ── JWT Implementation (HS256) ─────────────────────────────────────────────

function base64UrlEncode(data) {
  return Buffer.from(data).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * Create a signed JWT token.
 * @param {Object} payload - Token claims
 * @param {number} ttlSeconds - Time-to-live in seconds
 * @returns {string} Signed JWT
 */
function createJwt(payload, ttlSeconds) {
  const secret = getJwtSecret();
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    ...payload,
    iss: _config.issuer,
    aud: _config.audience,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify and decode a JWT token.
 * @param {string} token - JWT string
 * @returns {Object|null} Decoded payload or null if invalid/expired
 */
function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const secret = getJwtSecret();

  // Verify signature
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signatureB64, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  // Decode and validate claims
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) return null; // expired
    if (payload.iss && payload.iss !== _config.issuer) return null;
    if (payload.aud && payload.aud !== _config.audience) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Token Blacklist ────────────────────────────────────────────────────────

const _blacklist = new Set();
let _blacklistDirty = false;
let _blacklistTimer = null;

function blacklistToken(jti) {
  if (!jti) return;
  _blacklist.add(jti);
  _blacklistDirty = true;
}

function isBlacklisted(jti) {
  return _blacklist.has(jti);
}

/**
 * Remove expired entries from the blacklist.
 * Called periodically to prevent unbounded growth.
 */
function pruneBlacklist() {
  // We store jti:expiry pairs for pruning
  // Since the basic Set only has jtis, we track expiry separately
  const now = Math.floor(Date.now() / 1000);
  for (const entry of _blacklistExpiry.entries()) {
    if (entry[1] < now) {
      _blacklist.delete(entry[0]);
      _blacklistExpiry.delete(entry[0]);
    }
  }
}

const _blacklistExpiry = new Map(); // jti → expiry timestamp

function blacklistTokenWithExpiry(jti, exp) {
  if (!jti) return;
  _blacklist.add(jti);
  if (exp) _blacklistExpiry.set(jti, exp);
  _blacklistDirty = true;
}

function persistBlacklist() {
  if (!_blacklistDirty) return;
  try {
    const data = [];
    for (const jti of _blacklist) {
      data.push({ jti, exp: _blacklistExpiry.get(jti) || 0 });
    }
    fs.writeFileSync(AUTH_BLACKLIST_PATH, JSON.stringify(data, null, 2));
    _blacklistDirty = false;
  } catch (e) {
    console.error('[auth] Failed to persist blacklist:', e.message);
  }
}

function loadBlacklist() {
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_BLACKLIST_PATH, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    for (const entry of data) {
      if (!entry.exp || entry.exp > now) {
        _blacklist.add(entry.jti);
        if (entry.exp) _blacklistExpiry.set(entry.jti, entry.exp);
      }
    }
  } catch { /* no blacklist file yet */ }
}

// ── Refresh Token Store ────────────────────────────────────────────────────

// Map: userId → [{ token, family, exp, createdAt }]
const _refreshTokens = new Map();
let _refreshDirty = false;

/**
 * Create a refresh token for a user.
 * Uses token family for rotation detection (reuse = compromise).
 */
function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const family = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const entry = {
    token: hashTokenForStorage(token),
    family,
    exp: now + _config.refreshTokenTTL,
    createdAt: now,
  };

  if (!_refreshTokens.has(userId)) _refreshTokens.set(userId, []);
  const tokens = _refreshTokens.get(userId);

  // Enforce per-user limit — evict oldest
  while (tokens.length >= _config.maxRefreshTokensPerUser) {
    tokens.shift();
  }
  tokens.push(entry);
  _refreshDirty = true;

  return { token, family };
}

/**
 * Rotate a refresh token: invalidate old, issue new in same family.
 * Returns { newToken, family } or null if token invalid/reused.
 */
function rotateRefreshToken(userId, oldToken) {
  const tokens = _refreshTokens.get(userId);
  if (!tokens) return null;

  const hashedOld = hashTokenForStorage(oldToken);
  const now = Math.floor(Date.now() / 1000);

  const idx = tokens.findIndex(t => t.token === hashedOld && t.exp > now);
  if (idx === -1) {
    // Token not found or expired — possible reuse attack.
    // Revoke entire family if we can identify it.
    const expired = tokens.find(t => t.token === hashedOld);
    if (expired) {
      // Revoke all tokens in this family (compromise detected)
      const family = expired.family;
      const before = tokens.length;
      const remaining = tokens.filter(t => t.family !== family);
      tokens.length = 0;
      tokens.push(...remaining);
      if (remaining.length < before) _refreshDirty = true;
      console.warn(`[auth] Refresh token reuse detected for user ${userId}, family ${family} revoked`);
    }
    return null;
  }

  const entry = tokens[idx];
  const family = entry.family;

  // Remove old token
  tokens.splice(idx, 1);

  // Issue new token in same family
  const newToken = crypto.randomBytes(48).toString('hex');
  tokens.push({
    token: hashTokenForStorage(newToken),
    family,
    exp: now + _config.refreshTokenTTL,
    createdAt: now,
  });
  _refreshDirty = true;

  return { token: newToken, family };
}

/**
 * Revoke all refresh tokens for a user (logout).
 */
function revokeRefreshTokens(userId) {
  _refreshTokens.delete(userId);
  _refreshDirty = true;
}

function hashTokenForStorage(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function persistRefreshTokens() {
  if (!_refreshDirty) return;
  try {
    const data = {};
    for (const [userId, tokens] of _refreshTokens) {
      data[userId] = tokens;
    }
    fs.writeFileSync(AUTH_TOKENS_PATH, JSON.stringify(data, null, 2));
    _refreshDirty = false;
  } catch (e) {
    console.error('[auth] Failed to persist refresh tokens:', e.message);
  }
}

function loadRefreshTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    for (const [userId, tokens] of Object.entries(data)) {
      const valid = tokens.filter(t => t.exp > now);
      if (valid.length > 0) _refreshTokens.set(userId, valid);
    }
  } catch { /* no tokens file yet */ }
}

// ── User Store ─────────────────────────────────────────────────────────────

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_USERS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(AUTH_USERS_PATH, JSON.stringify(users, null, 2));
}

function findUser(username) {
  const users = loadUsers();
  return users[username] || null;
}

function createUser(username, password, roles = ['user']) {
  const users = loadUsers();
  if (users[username]) return null; // already exists

  users[username] = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password),
    roles,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);
  return users[username];
}

// ── HTTP Helpers ───────────────────────────────────────────────────────────

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Send 401 Unauthorized response.
 */
function unauthorized(res, message = 'Unauthorized') {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('WWW-Authenticate', 'Bearer realm="minions"');
  res.statusCode = 401;
  res.end(JSON.stringify({ error: message }));
}

/**
 * Send 403 Forbidden response.
 */
function forbidden(res, message = 'Forbidden') {
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 403;
  res.end(JSON.stringify({ error: message }));
}

// ── Authentication Middleware ──────────────────────────────────────────────

/**
 * Authenticate a request via JWT Bearer token.
 * @param {http.IncomingMessage} req
 * @returns {Object|null} Decoded user claims or null
 */
function authenticate(req) {
  const token = extractBearerToken(req);
  if (!token) return null;

  const payload = verifyJwt(token);
  if (!payload) return null;

  // Check blacklist
  if (payload.jti && isBlacklisted(payload.jti)) return null;

  return payload;
}

/**
 * Check if auth is enabled (at least one user registered).
 * Auth is opt-in — if no users exist, all routes are public.
 */
function isAuthEnabled() {
  try {
    const users = loadUsers();
    return Object.keys(users).length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a route requires authentication.
 * Public routes: login, register, health, dashboard HTML, static assets.
 * Returns false for ALL routes when auth is not enabled (no users registered).
 */
function isProtectedRoute(url) {
  // Auth is opt-in — if no users exist, nothing is protected
  if (!isAuthEnabled()) return false;

  const publicPrefixes = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/health',
    '/api/routes',
  ];

  // Dashboard HTML and assets are public
  if (!url.startsWith('/api/')) return false;

  for (const prefix of publicPrefixes) {
    if (url.startsWith(prefix)) return false;
  }

  return true;
}

/**
 * Require specific role(s) for access.
 * @param {Object} user - Decoded JWT claims
 * @param {string|string[]} roles - Required role(s)
 * @returns {boolean}
 */
function requireRole(user, roles) {
  if (!user || !user.roles) return false;
  const required = Array.isArray(roles) ? roles : [roles];
  return required.some(r => user.roles.includes(r));
}

// ── Auth Route Handlers ────────────────────────────────────────────────────

/**
 * Handle POST /api/auth/login
 * Body: { username, password }
 * Returns: { accessToken, refreshToken, expiresIn }
 */
function handleLogin(body) {
  const { username, password } = body || {};
  if (!username || !password) {
    return { status: 400, body: { error: 'username and password required' } };
  }

  const user = findUser(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { status: 401, body: { error: 'Invalid credentials' } };
  }

  const accessToken = createJwt(
    { sub: user.id, username: user.username, roles: user.roles },
    _config.accessTokenTTL
  );
  const refresh = createRefreshToken(user.id);

  return {
    status: 200,
    body: {
      accessToken,
      refreshToken: refresh.token,
      tokenType: 'Bearer',
      expiresIn: _config.accessTokenTTL,
    },
  };
}

/**
 * Handle POST /api/auth/refresh
 * Body: { refreshToken }
 * Returns: { accessToken, refreshToken, expiresIn }
 */
function handleRefresh(body) {
  const { refreshToken } = body || {};
  if (!refreshToken) {
    return { status: 400, body: { error: 'refreshToken required' } };
  }

  // Find which user owns this token
  for (const [userId, tokens] of _refreshTokens) {
    const hashed = hashTokenForStorage(refreshToken);
    const match = tokens.find(t => t.token === hashed);
    if (match) {
      const rotated = rotateRefreshToken(userId, refreshToken);
      if (!rotated) {
        return { status: 401, body: { error: 'Token reuse detected — all sessions revoked' } };
      }

      // Look up user info for new access token
      const users = loadUsers();
      const user = Object.values(users).find(u => u.id === userId);
      if (!user) {
        return { status: 401, body: { error: 'User not found' } };
      }

      const accessToken = createJwt(
        { sub: user.id, username: user.username, roles: user.roles },
        _config.accessTokenTTL
      );

      return {
        status: 200,
        body: {
          accessToken,
          refreshToken: rotated.token,
          tokenType: 'Bearer',
          expiresIn: _config.accessTokenTTL,
        },
      };
    }
  }

  return { status: 401, body: { error: 'Invalid refresh token' } };
}

/**
 * Handle POST /api/auth/logout
 * Requires: Authorization header with valid JWT
 * Body (optional): { refreshToken } — also revokes refresh token
 */
function handleLogout(req, body) {
  const payload = authenticate(req);
  if (!payload) {
    return { status: 401, body: { error: 'Not authenticated' } };
  }

  // Blacklist the access token
  blacklistTokenWithExpiry(payload.jti, payload.exp);

  // Revoke refresh tokens for this user
  if (payload.sub) {
    revokeRefreshTokens(payload.sub);
  }

  return { status: 200, body: { message: 'Logged out successfully' } };
}

/**
 * Handle POST /api/auth/register
 * Body: { username, password }
 * Returns: { user: { id, username, roles } }
 */
function handleRegister(body) {
  const { username, password, roles } = body || {};
  if (!username || !password) {
    return { status: 400, body: { error: 'username and password required' } };
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 64) {
    return { status: 400, body: { error: 'username must be 3-64 characters' } };
  }
  if (typeof password !== 'string' || password.length < 8) {
    return { status: 400, body: { error: 'password must be at least 8 characters' } };
  }
  // Validate username format (alphanumeric + underscores/hyphens)
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { status: 400, body: { error: 'username may only contain letters, numbers, underscores, and hyphens' } };
  }

  const user = createUser(username, password, roles || ['user']);
  if (!user) {
    return { status: 409, body: { error: 'Username already exists' } };
  }

  return {
    status: 201,
    body: {
      user: { id: user.id, username: user.username, roles: user.roles },
    },
  };
}

// ── Initialization & Cleanup ───────────────────────────────────────────────

function init(config = {}) {
  _config = { ...DEFAULT_CONFIG, ...config };
  loadBlacklist();
  loadRefreshTokens();

  // Periodic persistence + pruning
  _blacklistTimer = setInterval(() => {
    pruneBlacklist();
    persistBlacklist();
    persistRefreshTokens();
  }, _config.blacklistPersistInterval);

  // Don't keep process alive just for this timer
  if (_blacklistTimer.unref) _blacklistTimer.unref();

  console.log('[auth] Initialized — JWT HS256, access TTL %ds, refresh TTL %ds',
    _config.accessTokenTTL, _config.refreshTokenTTL);
}

function shutdown() {
  if (_blacklistTimer) {
    clearInterval(_blacklistTimer);
    _blacklistTimer = null;
  }
  persistBlacklist();
  persistRefreshTokens();
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Core
  init,
  shutdown,
  configure: (cfg) => { _config = { ...DEFAULT_CONFIG, ...cfg }; },

  // JWT
  createJwt,
  verifyJwt,

  // Password
  hashPassword,
  verifyPassword,

  // Token management
  blacklistToken: blacklistTokenWithExpiry,
  isBlacklisted,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokens,

  // User management
  findUser,
  createUser,

  // Middleware
  authenticate,
  isAuthEnabled,
  isProtectedRoute,
  requireRole,
  extractBearerToken,

  // HTTP helpers
  unauthorized,
  forbidden,

  // Route handlers
  handleLogin,
  handleRefresh,
  handleLogout,
  handleRegister,

  // For testing
  _testing: {
    getBlacklist: () => _blacklist,
    getBlacklistExpiry: () => _blacklistExpiry,
    getRefreshTokens: () => _refreshTokens,
    hashTokenForStorage,
    setSecret: (s) => { _jwtSecret = s; },
    resetState: () => {
      _blacklist.clear();
      _blacklistExpiry.clear();
      _refreshTokens.clear();
      _jwtSecret = null;
      _refreshDirty = false;
      _blacklistDirty = false;
    },
  },
};
