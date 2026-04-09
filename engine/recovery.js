/**
 * engine/recovery.js — Recovery recipes for classified agent failures.
 * Maps FAILURE_CLASS values to per-class retry limits and escalation policies.
 * Zero external dependencies — uses only Node.js built-ins and imports from shared.js.
 */

const { FAILURE_CLASS, ESCALATION_POLICY, ENGINE_DEFAULTS } = require('./shared');

// ─── Recovery Recipes ───────────────────────────────────────────────────────

/**
 * Each recipe defines:
 *   maxAttempts  — max retries for this failure class (0 = never retry)
 *   escalation   — ESCALATION_POLICY value
 *   freshSession — whether to clear session.json before retry
 *   description  — human-readable explanation for logs/dashboard
 */
const RECOVERY_RECIPES = new Map([
  [FAILURE_CLASS.CONFIG_ERROR, {
    maxAttempts: 0,
    escalation: ESCALATION_POLICY.NO_RETRY,
    freshSession: false,
    description: 'Configuration error — fix config before retrying',
  }],
  [FAILURE_CLASS.PERMISSION_BLOCKED, {
    maxAttempts: 0,
    escalation: ESCALATION_POLICY.NO_RETRY,
    freshSession: false,
    description: 'Permission/trust gate blocked — requires human intervention',
  }],
  [FAILURE_CLASS.MERGE_CONFLICT, {
    maxAttempts: 2,
    escalation: ESCALATION_POLICY.RETRY_SAME,
    freshSession: false,
    description: 'Merge conflict — retry may succeed after dependency updates',
  }],
  [FAILURE_CLASS.BUILD_FAILURE, {
    maxAttempts: 2,
    escalation: ESCALATION_POLICY.RETRY_SAME,
    freshSession: false,
    description: 'Build/test failure — retry with same context for iterative fix',
  }],
  [FAILURE_CLASS.TIMEOUT, {
    maxAttempts: 1,
    escalation: ESCALATION_POLICY.RETRY_FRESH,
    freshSession: true,
    description: 'Timeout — retry with fresh session to avoid stuck state',
  }],
  [FAILURE_CLASS.EMPTY_OUTPUT, {
    maxAttempts: 1,
    escalation: ESCALATION_POLICY.HUMAN_REVIEW,
    freshSession: true,
    description: 'Empty output — agent produced nothing useful, flag for review',
  }],
  [FAILURE_CLASS.SPAWN_ERROR, {
    maxAttempts: 2,
    escalation: ESCALATION_POLICY.RETRY_FRESH,
    freshSession: true,
    description: 'Spawn error — retry with fresh session after transient failure',
  }],
  [FAILURE_CLASS.NETWORK_ERROR, {
    maxAttempts: 3,
    escalation: ESCALATION_POLICY.AUTO,
    freshSession: false,
    description: 'Network/API error — retry with exponential backoff',
  }],
  [FAILURE_CLASS.OUT_OF_CONTEXT, {
    maxAttempts: 1,
    escalation: ESCALATION_POLICY.HUMAN_REVIEW,
    freshSession: true,
    description: 'Context exhausted — retry with fresh session, flag if repeated',
  }],
  [FAILURE_CLASS.UNKNOWN, {
    maxAttempts: null, // null = fall back to ENGINE_DEFAULTS.maxRetries
    escalation: ESCALATION_POLICY.AUTO,
    freshSession: false,
    description: 'Unclassified failure — use default retry behavior',
  }],
]);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the recovery recipe for a failure class.
 * @param {string} failureClass — one of FAILURE_CLASS values
 * @returns {object} recipe with maxAttempts, escalation, freshSession, description
 */
function getRecoveryRecipe(failureClass) {
  return RECOVERY_RECIPES.get(failureClass) || RECOVERY_RECIPES.get(FAILURE_CLASS.UNKNOWN);
}

/**
 * Determine whether a failed dispatch should be retried based on its failure class
 * and current attempt count.
 * @param {string} failureClass — one of FAILURE_CLASS values (or empty for unclassified)
 * @param {number} attemptCount — how many times this item has already been retried
 * @returns {boolean} true if another retry is allowed
 */
function shouldRetry(failureClass, attemptCount = 0) {
  const recipe = getRecoveryRecipe(failureClass || FAILURE_CLASS.UNKNOWN);
  // null maxAttempts = fall back to global ENGINE_DEFAULTS.maxRetries
  const limit = recipe.maxAttempts !== null ? recipe.maxAttempts : ENGINE_DEFAULTS.maxRetries;
  return attemptCount < limit;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  RECOVERY_RECIPES,
  getRecoveryRecipe,
  shouldRetry,
};
