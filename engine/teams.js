/**
 * engine/teams.js — Microsoft Teams integration via Azure Bot Framework.
 * Provides adapter creation, message posting, and conversation reference persistence.
 * All functions are no-ops when Teams is disabled or botbuilder is not installed.
 */

const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { log, safeJson, mutateJsonFileLocked, ENGINE_DEFAULTS } = shared;
const { ENGINE_DIR, getConfig } = queries;

const TEAMS_STATE_PATH = path.join(ENGINE_DIR, 'teams-state.json');

// Lazy-load botbuilder — may not be installed
let _botbuilder = null;
function getBotbuilder() {
  if (_botbuilder) return _botbuilder;
  try {
    _botbuilder = require('botbuilder');
  } catch {
    log('warn', 'botbuilder package not installed — Teams integration unavailable');
    _botbuilder = null;
  }
  return _botbuilder;
}

/**
 * Merge user config.teams with ENGINE_DEFAULTS.teams.
 * Returns the merged teams config object.
 */
function getTeamsConfig() {
  const config = getConfig();
  const defaults = ENGINE_DEFAULTS.teams;
  const user = config.teams || {};
  return { ...defaults, ...user };
}

/**
 * Returns true if Teams integration is enabled and has required credentials.
 */
function isTeamsEnabled() {
  const cfg = getTeamsConfig();
  return cfg.enabled === true && !!cfg.appId && !!cfg.appPassword;
}

// Cached adapter instance — created once per process
let _adapter = null;

/**
 * Create and return a BotFrameworkAdapter instance.
 * Returns null when Teams is disabled or botbuilder is not installed.
 */
function createAdapter() {
  if (_adapter) return _adapter;

  if (!isTeamsEnabled()) {
    log('info', 'Teams adapter not created — integration disabled or missing credentials');
    return null;
  }

  const botbuilder = getBotbuilder();
  if (!botbuilder) return null;

  const cfg = getTeamsConfig();
  try {
    _adapter = new botbuilder.CloudAdapter(
      new botbuilder.ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: cfg.appId,
        MicrosoftAppPassword: cfg.appPassword,
        MicrosoftAppType: 'SingleTenant',
      })
    );
    log('info', 'Teams adapter created successfully');
    return _adapter;
  } catch (err) {
    log('warn', `Teams adapter creation failed: ${err.message}`);
    return null;
  }
}

/**
 * Save a conversation reference for later proactive messaging.
 * Uses mutateJsonFileLocked for concurrency safety.
 * @param {string} key — identifier for this conversation (e.g. channel ID or user ID)
 * @param {object} ref — conversation reference from TurnContext.getConversationReference()
 */
function saveConversationRef(key, ref) {
  if (!key || !ref) return;
  mutateJsonFileLocked(TEAMS_STATE_PATH, (state) => {
    if (!state.conversations) state.conversations = {};
    state.conversations[key] = { ref, savedAt: shared.ts() };
  });
  log('info', `Teams conversation ref saved: ${key}`);
}

/**
 * Retrieve a saved conversation reference.
 * @param {string} key — identifier used in saveConversationRef
 * @returns {object|null} — the conversation reference, or null if not found
 */
function getConversationRef(key) {
  if (!key) return null;
  const state = safeJson(TEAMS_STATE_PATH) || {};
  return state.conversations?.[key]?.ref || null;
}

/**
 * Reply to an existing Teams conversation turn.
 * No-op when adapter is null (Teams disabled or botbuilder missing).
 * @param {object} context — TurnContext from bot handler
 * @param {string} text — message text to send
 */
async function teamsReply(context, text) {
  const adapter = createAdapter();
  if (!adapter || !context) return;
  try {
    await context.sendActivity(text);
    log('info', `Teams reply sent (${text.length} chars)`);
  } catch (err) {
    log('warn', `Teams reply failed: ${err.message}`);
  }
}

/**
 * Proactively post a message to a saved Teams conversation.
 * No-op when adapter is null or conversation ref is not found.
 * @param {string} key — conversation key used in saveConversationRef
 * @param {string} text — message text to send
 */
async function teamsPost(key, text) {
  const adapter = createAdapter();
  if (!adapter) return;

  const ref = getConversationRef(key);
  if (!ref) {
    log('warn', `Teams post skipped — no conversation ref for key: ${key}`);
    return;
  }

  try {
    await adapter.continueConversationAsync(getTeamsConfig().appId, ref, async (context) => {
      await context.sendActivity(text);
    });
    log('info', `Teams proactive message sent to ${key} (${text.length} chars)`);
  } catch (err) {
    log('warn', `Teams proactive post failed for ${key}: ${err.message}`);
  }
}

// Reset cached adapter (for testing)
function _resetAdapter() { _adapter = null; _botbuilder = null; }

module.exports = {
  getTeamsConfig,
  isTeamsEnabled,
  createAdapter,
  saveConversationRef,
  getConversationRef,
  teamsReply,
  teamsPost,
  TEAMS_STATE_PATH,
  _resetAdapter, // exported for testing
};
