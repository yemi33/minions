/**
 * engine/model-discovery.js — Per-runtime model catalog cache + REST helpers.
 *
 * Backs the dashboard endpoints:
 *   GET  /api/runtimes                        → listAllRuntimes()
 *   GET  /api/runtimes/:name/models           → getRuntimeModels(name)
 *   POST /api/runtimes/:name/models/refresh   → invalidateRuntimeModelsCache(name)
 *                                              → getRuntimeModels(name, { force: true })
 *
 * Cache shape (per-runtime file at `adapter.modelsCache`):
 *   { runtime: 'copilot', models: [{ id, name, provider }, ...] | null, cachedAt: ISO }
 *
 * Returning `{ models: null }` is the universal "free-text fallback" signal —
 * the settings UI renders a free-text input instead of a dropdown. It happens in
 * four cases:
 *   1. `config.engine.disableModelDiscovery === true` (fleet-wide opt-out)
 *   2. `adapter.capabilities.modelDiscovery !== true` (e.g. Claude — no API)
 *   3. `adapter.listModels()` resolves to null/empty (no token, network error)
 *   4. `adapter.listModels()` throws (transient API error — caller treats as null)
 *
 * Cache is persisted only when discovery actually ran (cases 3+4 still write a
 * `{ models: null }` cache so we don't hammer the API on every refresh — TTL
 * eventually re-tries). Cases 1+2 skip the cache write entirely.
 */

const fs = require('fs');
const { resolveRuntime, listRuntimes } = require('./runtimes');

// 1 hour — matches the spec ("< 1hr TTL"). Keep separate from ENGINE_DEFAULTS
// so the test suite can override per-call without polluting the global config.
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

function _readCacheFile(p) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch { /* missing / malformed → cache miss */ }
  return null;
}

function _writeCacheFile(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch { /* best effort */ }
}

/**
 * Return the registered runtime catalog for `GET /api/runtimes`.
 *
 * Shape: `[{ name, capabilities }, ...]`. Capabilities are spread into a fresh
 * object so callers can't mutate the adapter's authoritative capability block.
 */
function listAllRuntimes() {
  const names = listRuntimes();
  const runtimes = [];
  for (const name of names) {
    let adapter;
    try { adapter = resolveRuntime(name); } catch { continue; }
    runtimes.push({
      name,
      capabilities: { ...(adapter && adapter.capabilities ? adapter.capabilities : {}) },
    });
  }
  return runtimes;
}

/**
 * Read or refresh the cached model list for a runtime.
 *
 * @param {string} runtimeName  Must be a registered runtime — caller maps the
 *                              `Unknown runtime` throw onto an HTTP 404.
 * @param {object} opts
 * @param {boolean} opts.force  Skip the cache and call `listModels()` directly.
 * @param {number}  opts.ttlMs  Cache freshness window (default 1h). Tests use a
 *                              tiny window to exercise the miss path.
 * @param {object}  opts.config Pass `getConfig()` result so the helper can
 *                              honour `config.engine.disableModelDiscovery`
 *                              without re-reading the file on every request.
 * @returns {Promise<{runtime: string, models: object[]|null, cachedAt: string|null}>}
 */
async function getRuntimeModels(runtimeName, { force = false, ttlMs = MODEL_CACHE_TTL_MS, config = null } = {}) {
  // Throws "Unknown runtime ..." for unregistered names. Caller turns this into
  // a 404; bubbling the throw is intentional so misconfigurations surface loudly
  // (mirrors the registry contract documented in engine/runtimes/index.js).
  const adapter = resolveRuntime(runtimeName);

  // Case 1: fleet-wide opt-out. Skip the adapter entirely — never call its
  // listModels() (which can hit the network) when the user explicitly disabled
  // discovery. No cache write either; flipping the flag back on must produce a
  // fresh fetch, not a stale `null` cache hit.
  if (config && config.engine && config.engine.disableModelDiscovery === true) {
    return { runtime: runtimeName, models: null, cachedAt: null };
  }

  // Case 2: adapter doesn't support discovery (Claude). Same short-circuit —
  // don't write a cache file (`engine/claude-models.json` stays absent / empty
  // per the spec: "engine/claude-models.json (always null)").
  if (!adapter.capabilities || adapter.capabilities.modelDiscovery !== true) {
    return { runtime: runtimeName, models: null, cachedAt: null };
  }

  const cachePath = adapter.modelsCache || null;

  // Cache hit path — only on non-forced reads. We accept any cached payload
  // whose `cachedAt` parses to a valid timestamp within the TTL window;
  // `models: null` cached entries also count as fresh so we don't re-hit the
  // API every page load when the token is missing.
  if (!force && cachePath) {
    const cached = _readCacheFile(cachePath);
    if (cached && typeof cached.cachedAt === 'string') {
      const ts = Date.parse(cached.cachedAt);
      if (Number.isFinite(ts)) {
        const age = Date.now() - ts;
        if (age >= 0 && age < ttlMs) {
          const models = Array.isArray(cached.models) ? cached.models : null;
          return { runtime: runtimeName, models, cachedAt: cached.cachedAt };
        }
      }
    }
  }

  // Cache miss / forced refresh — call the adapter. Any failure (null return,
  // empty array, throw) collapses to `models: null` so the dashboard falls back
  // to free-text input. We do NOT distinguish "API unreachable" from "API
  // returned an empty list" — both are unactionable from a UI standpoint.
  let models = null;
  try {
    const result = await adapter.listModels();
    if (Array.isArray(result) && result.length > 0) {
      // Defensive copy — adapter caches its own result internally and we don't
      // want that to be mutable through the response we return.
      models = result.map(m => ({ ...m }));
    }
  } catch { /* swallow — network/transient errors map to null */ }

  const cachedAt = new Date().toISOString();
  if (cachePath) {
    _writeCacheFile(cachePath, { runtime: runtimeName, models, cachedAt });
  }
  return { runtime: runtimeName, models, cachedAt };
}

/**
 * Delete the cached models file for a runtime. Returns `true` if a file was
 * removed, `false` if there was nothing to remove. Throws on unknown runtime
 * (caller maps to 404). Filesystem errors other than ENOENT propagate so the
 * route handler can surface a real I/O failure to the operator instead of
 * silently no-oping.
 */
function invalidateRuntimeModelsCache(runtimeName) {
  const adapter = resolveRuntime(runtimeName);
  const cachePath = adapter && adapter.modelsCache;
  if (!cachePath) return false;
  try {
    fs.unlinkSync(cachePath);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = {
  listAllRuntimes,
  getRuntimeModels,
  invalidateRuntimeModelsCache,
  MODEL_CACHE_TTL_MS,
};
