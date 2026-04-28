/**
 * engine/runtimes/index.js — Runtime adapter registry.
 *
 * The registry is the single resolution point for everything CLI-runtime-
 * specific in the engine. Engine code MUST go through `resolveRuntime(name)`
 * — never `require('./runtimes/<name>')` directly — so a typo or unknown
 * runtime name fails loudly with a clear list of registered options.
 *
 * Adding a new runtime:
 *   1. Implement the full adapter contract documented in claude.js.
 *   2. `registry.set('<name>', require('./<name>'));` below.
 *   3. Expose its capabilities via the `/api/runtimes` endpoint (free).
 *
 * Engine code MUST gate behavior on `runtime.capabilities.*` flags, not on
 * `runtime.name === 'claude'` comparisons. The whole point of this layer.
 */

const registry = new Map();
registry.set('claude', require('./claude'));

/**
 * Look up a runtime adapter by name. Throws when the name is unknown so
 * misconfigurations surface immediately at dispatch time instead of producing
 * silent fallbacks or undefined-method crashes deep inside spawn logic.
 */
function resolveRuntime(name) {
  const key = name == null ? 'claude' : String(name);
  const adapter = registry.get(key);
  if (!adapter) {
    const known = Array.from(registry.keys()).sort().join(', ');
    throw new Error(`Unknown runtime "${key}". Registered runtimes: ${known}`);
  }
  return adapter;
}

/**
 * Return the names of every registered runtime, sorted. Used by the dashboard
 * `/api/runtimes` endpoint and the CLI `--cli` validator.
 */
function listRuntimes() {
  return Array.from(registry.keys()).sort();
}

/**
 * Register a runtime adapter. Exposed for tests and for downstream tooling
 * that wants to register a custom runtime without editing this file.
 */
function registerRuntime(name, adapter) {
  if (!name || typeof name !== 'string') throw new Error('registerRuntime: name must be a non-empty string');
  if (!adapter || typeof adapter !== 'object') throw new Error('registerRuntime: adapter must be an object');
  registry.set(name, adapter);
}

module.exports = {
  resolveRuntime,
  listRuntimes,
  registerRuntime,
  // Exposed for tests — engine code MUST go through resolveRuntime/listRuntimes
  _registry: registry,
};
