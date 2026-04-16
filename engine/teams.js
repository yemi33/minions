/**
 * engine/teams.js — Microsoft Teams integration via Azure Bot Framework.
 * Provides adapter creation, message posting, and conversation reference persistence.
 * All functions are no-ops when Teams is disabled or botbuilder is not installed.
 */

const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { log, safeRead, safeJson, mutateJsonFileLocked, ENGINE_DEFAULTS } = shared;
const { ENGINE_DIR, getConfig } = queries;
const cards = require('./teams-cards');

const TEAMS_STATE_PATH = path.join(ENGINE_DIR, 'teams-state.json');
const TEAMS_INBOX_PATH = path.join(ENGINE_DIR, 'teams-inbox.json');
const TEAMS_INBOX_CAP = 200;

// ── Rate Limiting & Circuit Breaker Constants ─────────────────────────────
const MAX_RETRIES_429 = 2;
const MAX_RETRIES_5XX = 3;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RECOVERY_MS = 10 * 60 * 1000; // 10 minutes
const OUTBOUND_QUEUE_MAX = 100;
const OUTBOUND_DRAIN_INTERVAL_MS = 250; // 4 messages per second

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
 * Supports two auth modes:
 *   (1) Client secret: appId + appPassword
 *   (2) Certificate:   appId + certPath + privateKeyPath + tenantId
 */
function isTeamsEnabled() {
  const cfg = getTeamsConfig();
  if (cfg.enabled !== true || !cfg.appId) return false;
  const hasSecret = !!cfg.appPassword;
  const hasCert = !!cfg.certPath && !!cfg.privateKeyPath && !!cfg.tenantId;
  return hasSecret || hasCert;
}

// Cached adapter instance — created once per process
let _adapter = null;

/**
 * Create and return a BotFrameworkAdapter instance.
 * Returns null when Teams is disabled or botbuilder is not installed.
 * Supports two auth modes:
 *   (1) Client secret: uses ConfigurationBotFrameworkAuthentication with appPassword
 *   (2) Certificate:   uses CertificateServiceClientCredentialsFactory with PEM cert + key
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
  const useCert = !!cfg.certPath && !!cfg.privateKeyPath && !!cfg.tenantId;

  try {
    if (useCert) {
      let connector;
      try {
        connector = require('botframework-connector');
      } catch {
        log('warn', 'botframework-connector not installed — certificate auth unavailable. Install via: npm install botframework-connector');
        return null;
      }
      const cert = safeRead(cfg.certPath);
      const privateKey = safeRead(cfg.privateKeyPath);
      if (!cert || !privateKey) {
        log('warn', `Teams cert auth failed — could not read cert (${cfg.certPath}) or key (${cfg.privateKeyPath})`);
        return null;
      }
      const credentialsFactory = new connector.CertificateServiceClientCredentialsFactory(
        cfg.appId, cert, privateKey, cfg.tenantId
      );
      _adapter = new botbuilder.CloudAdapter(
        new botbuilder.ConfigurationBotFrameworkAuthentication(
          { MicrosoftAppId: cfg.appId, MicrosoftAppType: 'SingleTenant', MicrosoftAppTenantId: cfg.tenantId },
          credentialsFactory
        )
      );
      log('info', 'Teams adapter created (certificate auth)');
    } else {
      _adapter = new botbuilder.CloudAdapter(
        new botbuilder.ConfigurationBotFrameworkAuthentication({
          MicrosoftAppId: cfg.appId,
          MicrosoftAppPassword: cfg.appPassword,
          MicrosoftAppType: 'SingleTenant',
        })
      );
      log('info', 'Teams adapter created (client secret auth)');
    }
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

// ── Circuit Breaker ───────────────────────────────────────────────────────

const _circuit = {
  state: 'closed', // 'closed' | 'open' | 'half-open'
  failures: 0,
  openedAt: 0,
};

function _isCircuitOpen() {
  if (_circuit.state === 'closed') return false;
  if (_circuit.state === 'open') {
    if (Date.now() - _circuit.openedAt >= CIRCUIT_RECOVERY_MS) {
      _circuit.state = 'half-open';
      log('info', 'Teams circuit breaker: half-open — allowing probe request');
      return false;
    }
    return true;
  }
  return false; // half-open allows one probe
}

function _onSendSuccess() {
  if (_circuit.state !== 'closed') {
    log('info', `Teams circuit breaker: closed (was ${_circuit.state})`);
  }
  _circuit.state = 'closed';
  _circuit.failures = 0;
}

function _onSendFailure() {
  _circuit.failures++;
  if (_circuit.state === 'half-open') {
    _circuit.state = 'open';
    _circuit.openedAt = Date.now();
    log('warn', 'Teams circuit breaker: probe failed — reopening for 10 minutes');
  } else if (_circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    _circuit.state = 'open';
    _circuit.openedAt = Date.now();
    log('warn', `Teams circuit breaker: OPEN after ${_circuit.failures} consecutive failures — disabling for 10 minutes`);
  }
}

// ── Retry Logic ───────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute sendFn with retry on 429 (Retry-After) and 5xx (exponential backoff).
 * @param {Function} sendFn — async function that performs the actual send
 */
async function _sendWithRetry(sendFn) {
  let lastErr;
  let retries429 = 0;
  let retries5xx = 0;
  const maxAttempts = 1 + MAX_RETRIES_429 + MAX_RETRIES_5XX;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await sendFn();
      return;
    } catch (err) {
      lastErr = err;
      const status = err.statusCode || err.status || 0;

      if (status === 429 && retries429 < MAX_RETRIES_429) {
        retries429++;
        const retryAfterSec = parseInt(err.headers?.['retry-after'] || '1', 10);
        const delayMs = Math.max(retryAfterSec, 1) * 1000;
        log('info', `Teams 429 — retry ${retries429}/${MAX_RETRIES_429} after ${delayMs}ms`);
        await _sleep(delayMs);
        continue;
      }

      if (status >= 500 && status < 600 && retries5xx < MAX_RETRIES_5XX) {
        retries5xx++;
        const backoffMs = Math.pow(2, retries5xx - 1) * 1000; // 1s, 2s, 4s
        log('info', `Teams ${status} — retry ${retries5xx}/${MAX_RETRIES_5XX} after ${backoffMs}ms`);
        await _sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }
  if (lastErr) throw lastErr;
}

// ── Outbound Queue ────────────────────────────────────────────────────────

const _outboundQueue = [];
let _drainTimer = null;

function _enqueueMessage(key, content) {
  if (_outboundQueue.length >= OUTBOUND_QUEUE_MAX) {
    log('warn', `Teams outbound queue full (${OUTBOUND_QUEUE_MAX}) — dropping message for ${key}`);
    return;
  }
  _outboundQueue.push({ key, content });
  _startDrainTimer();
}

function _startDrainTimer() {
  if (_drainTimer) return;
  _drainTimer = setInterval(_drainQueue, OUTBOUND_DRAIN_INTERVAL_MS);
}

function _stopDrainTimer() {
  if (_drainTimer) {
    clearInterval(_drainTimer);
    _drainTimer = null;
  }
}

async function _drainQueue() {
  if (_outboundQueue.length === 0) {
    _stopDrainTimer();
    return;
  }

  const item = _outboundQueue.shift();
  if (!item) return;

  try {
    await _sendProactive(item.key, item.content);
  } catch (err) {
    log('warn', `Teams queued message failed for ${item.key}: ${err.message}`);
  }
}

/**
 * Send a proactive message with circuit breaker and retry.
 * Called by the drain timer — not directly by callers.
 */
async function _sendProactive(key, content) {
  if (_isCircuitOpen()) {
    log('info', `Teams circuit open — skipping message to ${key}`);
    return;
  }

  const adapter = createAdapter();
  if (!adapter) return;

  const ref = getConversationRef(key);
  if (!ref) {
    log('warn', `Teams post skipped — no conversation ref for key: ${key}`);
    return;
  }

  try {
    const activity = toActivity(content);
    await _sendWithRetry(async () => {
      await adapter.continueConversationAsync(getTeamsConfig().appId, ref, async (context) => {
        await context.sendActivity(activity);
      });
    });
    _onSendSuccess();
    const len = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    log('info', `Teams proactive message sent to ${key} (${len} chars)`);
  } catch (err) {
    _onSendFailure();
    log('warn', `Teams proactive post failed for ${key}: ${err.message}`);
  }
}

/**
 * Build an activity object from text or Adaptive Card.
 * @param {string|object} content — plain text string or Adaptive Card object (with type: 'AdaptiveCard')
 * @returns {string|object} — activity-compatible value for sendActivity
 */
function toActivity(content) {
  if (typeof content === 'string') return content;
  if (content && content.type === 'AdaptiveCard') {
    return {
      type: 'message',
      text: content.fallbackText || '',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content,
      }],
    };
  }
  return String(content);
}

/**
 * Reply to an existing Teams conversation turn.
 * No-op when adapter is null (Teams disabled or botbuilder missing).
 * @param {object} context — TurnContext from bot handler
 * @param {string|object} content — message text or Adaptive Card object
 */
async function teamsReply(context, content) {
  const adapter = createAdapter();
  if (!adapter || !context) return;
  if (_isCircuitOpen()) {
    log('info', 'Teams circuit open — skipping reply');
    return;
  }
  try {
    await _sendWithRetry(async () => {
      await context.sendActivity(toActivity(content));
    });
    _onSendSuccess();
    const len = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    log('info', `Teams reply sent (${len} chars)`);
  } catch (err) {
    _onSendFailure();
    log('warn', `Teams reply failed: ${err.message}`);
  }
}

/**
 * Proactively post a message to a saved Teams conversation.
 * No-op when adapter is null or conversation ref is not found.
 * @param {string} key — conversation key used in saveConversationRef
 * @param {string|object} content — message text or Adaptive Card object
 */
async function teamsPost(key, content) {
  if (!createAdapter()) return;
  _enqueueMessage(key, content);
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

  const card = cards.buildCCResponseCard(userMessage, ccResponse);

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) {
    log('info', 'Teams CC mirror skipped — no conversation refs stored');
    return;
  }

  await teamsPost(convKeys[0], card);
  log('info', `Teams CC mirror sent`);
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

  const title = dispatchItem.task || dispatchItem.meta?.item?.title || dispatchItem.id;
  const prUrl = dispatchItem.meta?.pr?.url || dispatchItem.pr || '';
  const item = { title, id: dispatchItem.meta?.item?.id || dispatchItem.id };
  const card = cards.buildCompletionCard(agentId, item, result, prUrl || undefined);

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], card);
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

  const card = cards.buildPrCard(pr, event, project);

  // Find first available conversation ref
  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], card);
    log('info', `Teams PR notification sent: ${event} for ${pr.id}`);

    // Record dedup — update _teamsNotifiedEvents on PR via lock
    if (prFilePath) {
      mutateJsonFileLocked(prFilePath, (prs) => {
        if (!Array.isArray(prs)) return prs;
        const target = shared.findPrRecord(prs, pr);
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
  const card = cards.buildPlanCard(planInfo, event);

  const state = safeJson(TEAMS_STATE_PATH) || {};
  const convKeys = Object.keys(state.conversations || {});
  if (convKeys.length === 0) return;

  try {
    await teamsPost(convKeys[0], card);
    log('info', `Teams plan notification sent: ${event} for ${planName}`);
  } catch (err) {
    log('warn', `Teams plan notification failed: ${err.message}`);
  }
}

// Reset cached adapter and internal state (for testing)
function _resetAdapter() {
  _adapter = null;
  _botbuilder = null;
  _lastCCMirrorPost = 0;
  _circuit.state = 'closed';
  _circuit.failures = 0;
  _circuit.openedAt = 0;
  _outboundQueue.length = 0;
  _stopDrainTimer();
}

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
  MAX_RETRIES_429,
  MAX_RETRIES_5XX,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_RECOVERY_MS,
  OUTBOUND_QUEUE_MAX,
  OUTBOUND_DRAIN_INTERVAL_MS,
  _circuit, // exported for testing
  _outboundQueue, // exported for testing
  _resetAdapter, // exported for testing
  _stopDrainTimer, // exported for testing
};
