/**
 * engine/routing.js — Agent routing, budget checks, and routing table parsing.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, safeRead } = shared;
const { ENGINE_DIR, DISPATCH_PATH } = queries;

const MINIONS_DIR = path.resolve(__dirname, '..');
const ROUTING_PATH = path.join(MINIONS_DIR, 'routing.md');

// Lazy require to avoid circular dependency with engine.js
let _engine = null;
function engine() { if (!_engine) _engine = require('../engine'); return _engine; }

// ─── Temp Agents ─────────────────────────────────────────────────────────────

const tempAgents = new Map(); // tempAgentId → { name, role, createdAt }

// ─── Routing Parser ─────────────────────────────────────────────────────────

function getRouting() {
  return safeRead(ROUTING_PATH);
}

let _routingCache = null;
let _routingCacheMtime = 0;

function parseRoutingTable() {
  const content = getRouting();
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

function resolveAgent(workType, config, authorAgent = null) {
  const routes = getRoutingTableCached();
  const route = routes[workType] || routes['implement'];
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

  // Check preferred and fallback first (routing table order)
  if (preferred && isAvailable(preferred)) { _claimedAgents.add(preferred); return preferred; }
  if (fallback && isAvailable(fallback)) { _claimedAgents.add(fallback); return fallback; }

  // Fall back to any idle agent, preferring lower error rates
  const idle = Object.keys(agents)
    .filter(id => id !== preferred && id !== fallback && isAvailable(id))
    .sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b));

  if (idle[0]) { _claimedAgents.add(idle[0]); return idle[0]; }

  // No idle configured agent — try temp agent if enabled
  if (config.engine?.allowTempAgents) {
    const tempId = `temp-${shared.uid()}`;
    _claimedAgents.add(tempId);
    tempAgents.set(tempId, { name: `Temp-${tempId.slice(5, 9)}`, role: 'Temporary Agent', createdAt: engine().ts() });
    engine().log('info', `Spawning temp agent ${tempId} — all permanent agents busy`);
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
  _claimedAgents,
  resetClaimedAgents,
  resolveAgent,
};
