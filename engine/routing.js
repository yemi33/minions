/**
 * engine/routing.js — Agent routing, budget checks, and routing table parsing.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, safeRead, log, ts } = shared;
const { ENGINE_DIR, DISPATCH_PATH } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;
const ROUTING_PATH = path.join(MINIONS_DIR, 'routing.md');

// ─── Temp Agents ─────────────────────────────────────────────────────────────

const tempAgents = new Map(); // tempAgentId → { name, role, createdAt }

// ─── Routing Parser ─────────────────────────────────────────────────────────

function getRouting() {
  return safeRead(ROUTING_PATH);
}

let _routingCache = null;
let _routingCacheMtime = 0;

function parseRoutingTable() {
  const content = getRouting() || '';
  const routes = {};
  const lines = content.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('| Work Type')) { inTable = true; continue; }
    if (line.startsWith('|---')) continue;
    if (!inTable || !line.startsWith('|')) {
      if (inTable && !line.startsWith('|')) inTable = false;
      continue;
    }
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 3) {
      routes[cells[0].toLowerCase()] = {
        preferred: cells[1].toLowerCase(),
        fallback: cells[2].toLowerCase()
      };
    }
  }
  return routes;
}

function getRoutingTableCached() {
  let mtime = 0;
  try { mtime = fs.statSync(ROUTING_PATH).mtimeMs; } catch { /* optional */ }
  if (_routingCache && _routingCacheMtime === mtime) return _routingCache;
  _routingCache = parseRoutingTable();
  _routingCacheMtime = mtime;
  return _routingCache;
}

// ─── Budget ──────────────────────────────────────────────────────────────────

function getMonthlySpend(agentId) {
  const metrics = safeJson(path.join(ENGINE_DIR, 'metrics.json')) || {};
  const daily = metrics._daily || {};
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let total = 0;
  for (const [date, data] of Object.entries(daily)) {
    if (date.startsWith(monthPrefix)) {
      total += (data.perAgent?.[agentId]?.costUsd || 0);
    }
  }
  // Fallback: if no per-agent daily data, use cumulative (less accurate for monthly)
  if (total === 0 && metrics[agentId]?.totalCostUsd) {
    // Can't distinguish monthly from cumulative — treat as monthly estimate
    // This path is for backward compat before per-agent daily tracking was added
  }
  return total;
}

function getAgentErrorRate(agentId) {
  const metricsPath = path.join(ENGINE_DIR, 'metrics.json');
  const metrics = safeJson(metricsPath) || {};
  const m = metrics[agentId];
  if (!m) return 0;
  const total = m.tasksCompleted + m.tasksErrored;
  return total > 0 ? m.tasksErrored / total : 0;
}

function isAgentIdle(agentId) {
  // Dispatch queue is the single source of truth for agent availability
  const dispatch = safeJson(DISPATCH_PATH) || {};
  return !(dispatch.active || []).some(d => d.agent === agentId);
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

// Track agents claimed during a single discovery pass to distribute work
const _claimedAgents = new Set();
function resetClaimedAgents() { _claimedAgents.clear(); }

// Per-tick temp-agent creation budget. Defaults to Infinity (unbounded) so
// routing.js in isolation keeps previous behaviour. The engine calls
// setTempBudget() once per tick with `maxConcurrent - activeCount` to ensure
// temp agents count against maxConcurrent exactly like named agents.
// Without this, a batch discovery (e.g. PR-poll sweep over many failing PRs)
// would register one temp agent per pending item, overwhelming the OS and
// causing mass orphans when the dispatch loop spawns them on later ticks.
// Closes #1209.
let _tempBudget = Infinity;
function setTempBudget(n) {
  _tempBudget = (typeof n === 'number' && n >= 0 && Number.isFinite(n)) ? n : Infinity;
}
function getTempBudget() { return _tempBudget; }

// Centralizes the work-item shape used to derive routing hints. Engine code
// previously inlined `item.preferred_agent || item.agents || null` at four
// call sites; hoisting keeps the contract in one place.
function extractAgentHints(item) {
  if (!item || typeof item !== 'object') return null;
  return item.preferred_agent || item.agents || null;
}

// Normalize a list of agent-hint inputs. Accepts:
//   - Comma-separated string ("dallas,ripley")
//   - Array of strings
//   - Single string
// Resolves the `_author_` token to authorAgent (when provided), validates
// each hint against the configured agents map (case-insensitive lookup,
// returning the canonical ID), dedups, and drops anything unknown.
function normalizeAgentHints(agentHints, authorAgent = null, agents = null) {
  const raw = Array.isArray(agentHints)
    ? agentHints
    : (agentHints ? String(agentHints).split(',') : []);
  const expanded = raw
    .map(id => String(id).trim())
    .map(id => id.toLowerCase() === '_author_' && authorAgent ? String(authorAgent).trim() : id)
    .filter(Boolean);
  // When no agents map is supplied, return lowercased IDs (legacy behaviour
  // used by tests and pre-validation callers).
  if (!agents || typeof agents !== 'object') {
    return expanded.map(id => id.toLowerCase());
  }
  const byLower = new Map(Object.keys(agents).map(id => [id.toLowerCase(), id]));
  const seen = new Set();
  const normalized = [];
  for (const hint of expanded) {
    const id = byLower.get(hint.toLowerCase());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function resolveAgent(workType, config, opts = {}) {
  const { authorAgent = null, agentHints = null } = opts || {};
  const routes = getRoutingTableCached();
  const route = routes[workType] || routes['implement'] || { preferred: '_any_', fallback: '_any_' };
  const agents = config.agents || {};

  // Resolve _author_ token
  let preferred = route.preferred === '_author_' ? authorAgent : route.preferred;
  let fallback = route.fallback === '_author_' ? authorAgent : route.fallback;

  const isAvailable = (id) => {
    if (!agents[id] || !isAgentIdle(id) || _claimedAgents.has(id)) return false;
    // Budget check — no budget means infinite (no limit)
    const budget = agents[id].monthlyBudgetUsd;
    if (budget && budget > 0) {
      if (getMonthlySpend(id) >= budget) return false;
    }
    return true;
  };

  // Helper: pick any idle agent sorted by error rate
  const pickAnyIdle = (exclude = []) => {
    const excludeSet = new Set(exclude.filter(Boolean));
    const idle = Object.keys(agents)
      .filter(id => !excludeSet.has(id) && isAvailable(id))
      .sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b));
    if (idle[0]) { _claimedAgents.add(idle[0]); return idle[0]; }
    return null;
  };

  const hintedAgents = normalizeAgentHints(agentHints, authorAgent, agents);
  if (hintedAgents.length > 0) {
    for (const id of hintedAgents) {
      if (isAvailable(id)) { _claimedAgents.add(id); return id; }
    }
    return null;
  }

  // Resolve _any_ token — pick any available agent (#480)
  if (preferred === '_any_') { const pick = pickAnyIdle(); if (pick) return pick; }
  else if (preferred && isAvailable(preferred)) { _claimedAgents.add(preferred); return preferred; }

  if (fallback === '_any_') { const pick = pickAnyIdle([preferred]); if (pick) return pick; }
  else if (fallback && isAvailable(fallback)) { _claimedAgents.add(fallback); return fallback; }

  // Fall back to any idle agent, preferring lower error rates
  const anyIdle = pickAnyIdle([preferred, fallback]);
  if (anyIdle) return anyIdle;

  // No idle configured agent — try temp agent if enabled
  if (config.engine?.allowTempAgents) {
    // Enforce per-tick temp-agent budget so temps count against maxConcurrent.
    // Without this guard, a mass-discovery pass (e.g. 20 PR build failures) would
    // register one temp agent per pending item regardless of concurrency cap,
    // leaking orphan temp IDs into tempAgents/dispatch and, over subsequent ticks,
    // spawning far more processes than maxConcurrent allows (#1209).
    if (_tempBudget <= 0) {
      log('info', `Temp agent refused for ${workType} — per-tick budget exhausted (maxConcurrent reached)`);
      return null;
    }
    _tempBudget--;
    const tempId = `temp-${shared.uid()}`;
    _claimedAgents.add(tempId);
    tempAgents.set(tempId, { name: `Temp-${tempId.slice(5, 9)}`, role: 'Temporary Agent', createdAt: ts() });
    log('info', `Spawning temp agent ${tempId} — all permanent agents busy`);
    return tempId;
  }

  // No idle agent available — return null, item stays pending until next tick
  return null;
}

module.exports = {
  tempAgents,
  getRouting,
  parseRoutingTable,
  getRoutingTableCached,
  getMonthlySpend,
  getAgentErrorRate,
  isAgentIdle,
  normalizeAgentHints,
  extractAgentHints,
  _claimedAgents,
  resetClaimedAgents,
  resolveAgent,
  setTempBudget,
  getTempBudget,
};
