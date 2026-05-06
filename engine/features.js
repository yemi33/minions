/**
 * engine/features.js — Feature flag registry. Recipe in CLAUDE.md → "Feature Flags".
 */

// Entry shape: id → { description, default: bool, addedIn?: version, expires?: ISO-date }
const FEATURES = {
  // Example:
  // 'ux-sidebar-v2': { description: '…', default: false, addedIn: '0.1.1738', expires: '2026-06-01' },
};

const ENV_TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const ENV_FALSY = new Set(['0', 'false', 'off', 'no', '']);

function envKey(id) {
  return 'MINIONS_FEATURE_' + String(id).toUpperCase().replace(/-/g, '_');
}

function readEnvOverride(id) {
  const raw = process.env[envKey(id)];
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (ENV_TRUTHY.has(v)) return true;
  if (ENV_FALSY.has(v)) return false;
  return undefined;
}

function isFeatureOn(id, config, registry = FEATURES) {
  if (!Object.prototype.hasOwnProperty.call(registry, id)) {
    throw new Error(`Unknown feature flag: "${id}". Register it in engine/features.js.`);
  }
  const env = readEnvOverride(id);
  if (env !== undefined) return env;
  const fromConfig = config && config.features && config.features[id];
  if (typeof fromConfig === 'boolean') return fromConfig;
  return registry[id].default === true;
}

function listFeatures(config, registry = FEATURES) {
  const now = Date.now();
  return Object.entries(registry).map(([id, meta]) => {
    const expiresAt = meta.expires ? Date.parse(meta.expires) : NaN;
    return {
      id,
      description: meta.description || '',
      default: meta.default === true,
      enabled: isFeatureOn(id, config, registry),
      addedIn: meta.addedIn || null,
      expires: meta.expires || null,
      expired: expiresAt < now,
    };
  });
}

function hasFeature(id, registry = FEATURES) {
  return Object.prototype.hasOwnProperty.call(registry, id);
}

module.exports = { FEATURES, isFeatureOn, listFeatures, hasFeature };
