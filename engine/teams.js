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
const TEAMS_INBOX_PATH = path.join(ENGINE_DIR, 'teams-inbox.json');
const TEAMS_INBOX_CAP = 200;

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

/**
 * Process unread messages in the Teams inbox.
 * Reads engine/teams-inbox.json, sends each unprocessed message through CC
 * via the dashboard HTTP API, posts the CC response as a Teams reply,
 * and marks the message as processed. Prunes oldest processed messages
 * when inbox exceeds TEAMS_INBOX_CAP.
 */
async function processTeamsInbox() {
  if (!isTeamsEnabled()) return;

  // Read inbox — snapshot unprocessed messages, then release lock
  const inbox = safeJson(TEAMS_INBOX_PATH);
  if (!Array.isArray(inbox) || inbox.length === 0) return;

  const unprocessed = inbox.filter(m => !m._processedAt);
  if (unprocessed.length === 0) return;

  log('info', `Teams inbox: ${unprocessed.length} unprocessed message(s)`);
  const cfg = getTeamsConfig();
  const port = process.env.PORT || 7331;

  // Process sequentially to avoid CC session conflicts
  for (const msg of unprocessed) {
    try {
      // Call CC via dashboard HTTP API
      const ccRes = await fetch(`http://localhost:${port}/api/command-center`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.text, tabId: `teams-${msg.id}` }),
      });
      const ccData = await ccRes.json().catch(() => ({}));
      const responseText = ccData.text || ccData.error || 'No response from Command Center';

      // Track usage under 'teams' category
      const llm = require('./llm');
      llm.trackEngineUsage('teams', ccData.usage || null);

      // Post reply to Teams
      if (msg.conversationRef?.conversation?.id) {
        await teamsPost(msg.conversationRef.conversation.id, responseText);
      }

      // Mark as processed
      mutateJsonFileLocked(TEAMS_INBOX_PATH, (data) => {
        if (!Array.isArray(data)) return data;
        const entry = data.find(m => m.id === msg.id);
        if (entry) entry._processedAt = new Date().toISOString();

        // Prune oldest processed messages when inbox exceeds cap
        if (data.length > TEAMS_INBOX_CAP) {
          const processed = data.filter(m => m._processedAt).sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
          const toRemove = data.length - TEAMS_INBOX_CAP;
          const removeIds = new Set(processed.slice(0, toRemove).map(m => m.id));
          return data.filter(m => !removeIds.has(m.id));
        }
      }, { defaultValue: [] });

      log('info', `Teams inbox: processed message ${msg.id} from ${msg.from}`);
    } catch (err) {
      log('warn', `Teams inbox: failed to process message ${msg.id}: ${err.message}`);
    }
  }
}

// ── CC Mirror to Teams ─────────────────────────────────────────────────────

const CC_MIRROR_RATE_LIMIT_MS = 5000;
let _lastCCMirrorPost = 0;

/**
 * Mirror a CC response to Teams so the team sees orchestration activity.
 * Truncates response at 4000 chars with a dashboard link suffix.
 * Rate-limited to 1 post per 5 seconds — excess posts silently skipped.
 * @param {string} userMessage — the user's CC input
 * @param {string} ccResponse — the CC response text
 */
async function teamsPostCCResponse(userMessage, ccResponse) {
  if (!isTeamsEnabled()) return;
  const cfg = getTeamsConfig();
  if (!cfg.ccMirror) return;

  // Rate limit
  const now = Date.now();
  if (now - _lastCCMirrorPost < CC_MIRROR_RATE_LIMIT_MS) return;
  _lastCCMirrorPost = now;

  const maxLen = 4000;
  const truncatedResponse = ccResponse.length > maxLen
    ? ccResponse.slice(0, maxLen) + '... [see dashboard](http://localhost:7331)'
    : ccResponse;

  const formatted = `**CC** — _${userMessage.slice(0, 200)}_\n\n${truncatedResponse}`;

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) {
    log('info', 'Teams CC mirror skipped — no conversation refs stored');
    return;
  }

  await teamsPost(convKeys[0], formatted);
  log('info', `Teams CC mirror sent (${formatted.length} chars)`);
}

// ── Post-Completion Notifications ──────────────────────────────────────────

/**
 * Notify Teams when an agent completes or fails a task.
 * Only posts if the event type is in config.teams.notifyEvents.
 * @param {object} dispatchItem — the dispatch entry (id, type, task, meta)
 * @param {string} result — 'success', 'error', or 'timeout'
 * @param {string} agentId — the agent that ran the task
 */
async function teamsNotifyCompletion(dispatchItem, result, agentId) {
  if (!isTeamsEnabled()) return;
  const cfg = getTeamsConfig();
  const eventType = result === 'success' ? 'agent-completed' : 'agent-failed';
  if (!cfg.notifyEvents || !cfg.notifyEvents.includes(eventType)) return;

  const emoji = result === 'success' ? 'Done' : 'Failed';
  const title = dispatchItem.task || dispatchItem.meta?.item?.title || dispatchItem.id;
  const prLink = dispatchItem.meta?.pr?.url || dispatchItem.pr || '';
  const prText = prLink ? ` | [PR](${prLink})` : '';

  const text = `**${emoji}** — _${agentId}_ ${result}: ${title}${prText} | [dashboard](http://localhost:7331)`;

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], text);
    log('info', `Teams completion notification sent for ${dispatchItem.id} (${result})`);
  } catch (err) {
    log('warn', `Teams completion notification failed: ${err.message}`);
  }
}

// ── PR Lifecycle Notifications ─────────────────────────────────────────────

/**
 * Notify Teams about a PR lifecycle event (merge, abandon, build-failed, approved).
 * Deduplicates via _teamsNotifiedEvents on PR object.
 * @param {object} pr — the PR object from pull-requests.json
 * @param {string} event — event type: 'pr-merged', 'pr-abandoned', 'build-failed', 'pr-approved'
 * @param {object} project — the project config object
 * @param {string} prFilePath — path to pull-requests.json for dedup write
 */
async function teamsNotifyPrEvent(pr, event, project, prFilePath) {
  if (!isTeamsEnabled()) return;
  const cfg = getTeamsConfig();
  if (!cfg.notifyEvents || !cfg.notifyEvents.includes(event)) return;

  // Dedup check — don't re-notify the same event
  if (pr._teamsNotifiedEvents && pr._teamsNotifiedEvents.includes(event)) return;

  const prLink = pr.url || '';
  const linkText = prLink ? ` | [PR](${prLink})` : '';
  const projectName = project?.name || 'unknown';
  const agent = pr.agent || 'unknown';
  const title = pr.title || pr.id || 'Untitled PR';

  const text = `**${event}** — _${agent}_ | ${title} (${projectName})${linkText} | [dashboard](http://localhost:7331)`;

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], text);
    log('info', `Teams PR notification sent: ${event} for ${pr.id}`);

    // Record dedup — update _teamsNotifiedEvents on PR via lock
    if (prFilePath) {
      mutateJsonFileLocked(prFilePath, (prs) => {
        if (!Array.isArray(prs)) return prs;
        const target = prs.find(p => p.id === pr.id);
        if (target) {
          if (!target._teamsNotifiedEvents) target._teamsNotifiedEvents = [];
          if (!target._teamsNotifiedEvents.includes(event)) {
            target._teamsNotifiedEvents.push(event);
          }
        }
      }, { defaultValue: [] });
    }
  } catch (err) {
    log('warn', `Teams PR notification failed for ${pr.id}: ${err.message}`);
  }
}

// ── Plan Lifecycle Notifications ───────────────────────────────────────────

/**
 * Notify Teams about a plan lifecycle event (completed, approved, rejected, verify-created).
 * @param {object} planInfo — { name, file, project, doneCount, totalCount } or similar
 * @param {string} event — 'plan-completed', 'plan-approved', 'plan-rejected', 'verify-created'
 */
async function teamsNotifyPlanEvent(planInfo, event) {
  if (!isTeamsEnabled()) return;
  const cfg = getTeamsConfig();
  if (!cfg.notifyEvents || !cfg.notifyEvents.includes(event)) return;

  const planName = planInfo.name || planInfo.file || 'Unknown plan';
  const counts = planInfo.doneCount != null ? ` (${planInfo.doneCount}/${planInfo.totalCount} items)` : '';
  const text = `**${event}** — ${planName}${counts} | [dashboard](http://localhost:7331)`;

  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], text);
    log('info', `Teams plan notification sent: ${event} for ${planName}`);
  } catch (err) {
    log('warn', `Teams plan notification failed: ${err.message}`);
  }
}

// Reset cached adapter (for testing)
function _resetAdapter() { _adapter = null; _botbuilder = null; _lastCCMirrorPost = 0; }

module.exports = {
  getTeamsConfig,
  isTeamsEnabled,
  createAdapter,
  saveConversationRef,
  getConversationRef,
  teamsReply,
  teamsPost,
  processTeamsInbox,
  teamsPostCCResponse,
  teamsNotifyCompletion,
  teamsNotifyPrEvent,
  teamsNotifyPlanEvent,
  CC_MIRROR_RATE_LIMIT_MS,
  TEAMS_STATE_PATH,
  TEAMS_INBOX_PATH,
  TEAMS_INBOX_CAP,
  _resetAdapter, // exported for testing
};
