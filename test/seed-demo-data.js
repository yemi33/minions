#!/usr/bin/env node
/**
 * Seed demo data for dashboard recording.
 * Run: node test/seed-demo-data.js
 * Clean: node test/seed-demo-data.js --clean
 */
const fs = require('fs');
const path = require('path');

const MINIONS_DIR = path.resolve(__dirname, '..');
const safeWrite = (p, data) => {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const safeJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const DEMO_TAG = '__demo__';

if (process.argv.includes('--clean')) {
  console.log('Cleaning demo data...');

  // Clean work items
  const wiPath = path.join(MINIONS_DIR, 'work-items.json');
  const items = safeJson(wiPath) || [];
  const filtered = items.filter(i => !i._demo);
  safeWrite(wiPath, filtered);
  console.log(`  Work items: removed ${items.length - filtered.length} demo items`);

  // Clean plans
  const plansDir = path.join(MINIONS_DIR, 'plans');
  if (fs.existsSync(plansDir)) {
    for (const f of fs.readdirSync(plansDir)) {
      if (f.startsWith('demo-')) { fs.unlinkSync(path.join(plansDir, f)); console.log(`  Removed plans/${f}`); }
    }
  }

  // Clean PRDs
  const prdDir = path.join(MINIONS_DIR, 'prd');
  if (fs.existsSync(prdDir)) {
    for (const f of fs.readdirSync(prdDir)) {
      if (f.startsWith('demo-')) { fs.unlinkSync(path.join(prdDir, f)); console.log(`  Removed prd/${f}`); }
    }
  }

  // Clean inbox
  const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
  if (fs.existsSync(inboxDir)) {
    for (const f of fs.readdirSync(inboxDir)) {
      if (f.startsWith('demo-')) { fs.unlinkSync(path.join(inboxDir, f)); console.log(`  Removed inbox/${f}`); }
    }
  }

  // Clean dispatch demo entries
  const dispPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
  const disp = safeJson(dispPath) || { pending: [], active: [], completed: [] };
  disp.active = (disp.active || []).filter(d => !d._demo);
  disp.completed = (disp.completed || []).filter(d => !d._demo);
  safeWrite(dispPath, disp);

  // Clean live output logs for demo agents
  const agentsDir = path.join(MINIONS_DIR, 'agents');
  for (const agentId of ['dallas', 'ripley', 'rebecca']) {
    const livePath = path.join(agentsDir, agentId, 'live-output.log');
    if (fs.existsSync(livePath)) { try { fs.unlinkSync(livePath); console.log(`  Removed ${agentId}/live-output.log`); } catch {} }
  }

  console.log('Demo data cleaned.');
  process.exit(0);
}

console.log('Seeding demo data...');

// 1. Work items (mix of statuses)
const wiPath = path.join(MINIONS_DIR, 'work-items.json');
const existingItems = safeJson(wiPath) || [];
const demoItems = [
  { id: 'DEMO-001', title: 'Add OAuth2 authentication middleware', type: 'implement', priority: 'high', status: 'done', created: '2026-03-18T10:00:00Z', createdBy: 'dashboard', completedAt: '2026-03-18T14:30:00Z', dispatched_to: 'dallas', _demo: true },
  { id: 'DEMO-002', title: 'Implement role-based access control', type: 'implement', priority: 'high', status: 'done', created: '2026-03-18T11:00:00Z', createdBy: 'dashboard', dispatched_to: 'rebecca', _pr: 'PR-4521', _demo: true },
  { id: 'DEMO-003', title: 'Fix login page CSS on mobile', type: 'implement', priority: 'medium', status: 'pending', created: '2026-03-19T08:00:00Z', createdBy: 'dashboard', _demo: true },
  { id: 'DEMO-004', title: 'Add rate limiting to API endpoints', type: 'implement', priority: 'high', status: 'dispatched', dispatched_to: 'dallas', dispatched_at: '2026-03-19T09:30:00Z', created: '2026-03-19T09:00:00Z', createdBy: 'dashboard', _demo: true },
  { id: 'DEMO-005', title: 'Review PR for auth middleware', type: 'review', priority: 'medium', status: 'done', created: '2026-03-18T15:00:00Z', createdBy: 'engine', dispatched_to: 'ripley', completedAt: '2026-03-18T16:00:00Z', _demo: true },
  { id: 'DEMO-006', title: 'Explore codebase authentication patterns', type: 'explore', priority: 'low', status: 'failed', failReason: 'Agent timeout after 3 retries', created: '2026-03-17T10:00:00Z', _demo: true },
];
const mergedItems = [...existingItems.filter(i => !i._demo), ...demoItems];
safeWrite(wiPath, mergedItems);
console.log(`  Work items: ${demoItems.length} demo items seeded`);

// 2. Plans (.md draft)
const plansDir = path.join(MINIONS_DIR, 'plans');
if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
safeWrite(path.join(plansDir, 'demo-auth-plan.md'), `# Plan: User Authentication & Authorization

**Project:** OfficeAgent
**Author:** Ripley (Lead)
**Date:** 2026-03-18

## Overview
Implement comprehensive authentication and authorization for the OfficeAgent platform.

## Features

1. **OAuth2 Authentication Middleware** — JWT-based auth with refresh tokens
2. **Role-Based Access Control (RBAC)** — Admin, Editor, Viewer roles with granular permissions
3. **API Rate Limiting** — Per-user and per-endpoint rate limits with Redis backing
4. **Session Management** — Secure session handling with configurable expiry
5. **Audit Logging** — Track all auth events for compliance

## Technical Approach
- Use passport.js for OAuth2 strategy
- Redis for rate limit counters and session store
- PostgreSQL for role/permission storage
- Middleware chain: auth -> rate-limit -> rbac -> handler
`);
console.log('  Plans: demo-auth-plan.md created');

// 3. PRD (.json with awaiting-approval)
const prdDir = path.join(MINIONS_DIR, 'prd');
if (!fs.existsSync(prdDir)) fs.mkdirSync(prdDir, { recursive: true });
safeWrite(path.join(prdDir, 'demo-auth-prd.json'), {
  project: 'OfficeAgent',
  plan_summary: 'User Authentication & Authorization',
  generated_by: 'Lambert',
  generated_at: '2026-03-18',
  source_plan: 'demo-auth-plan.md',
  status: 'approved',
  requires_approval: false,
  branch_strategy: 'parallel',
  missing_features: [
    { id: 'DEMO-P001', name: 'OAuth2 Authentication Middleware', description: 'JWT-based auth with refresh tokens using passport.js', priority: 'high', estimated_complexity: 'large', status: 'done', acceptance_criteria: ['JWT tokens issued on login', 'Refresh token rotation', 'Token blacklisting on logout'], depends_on: [] },
    { id: 'DEMO-P002', name: 'Role-Based Access Control', description: 'Admin/Editor/Viewer roles with granular permissions', priority: 'high', estimated_complexity: 'large', status: 'done', acceptance_criteria: ['Role assignment API', 'Permission middleware', 'Role hierarchy support'], depends_on: ['DEMO-P001'] },
    { id: 'DEMO-P003', name: 'API Rate Limiting', description: 'Per-user rate limits with Redis backing', priority: 'medium', estimated_complexity: 'medium', status: 'missing', acceptance_criteria: ['Configurable rate limits', 'Redis-backed counters', '429 response with retry-after'], depends_on: ['DEMO-P001'] },
    { id: 'DEMO-P004', name: 'Session Management', description: 'Secure sessions with configurable expiry', priority: 'medium', estimated_complexity: 'small', status: 'missing', acceptance_criteria: ['Session creation/destruction', 'Configurable TTL', 'Redis session store'], depends_on: ['DEMO-P001'] },
    { id: 'DEMO-P005', name: 'Audit Logging', description: 'Track all auth events for compliance', priority: 'low', estimated_complexity: 'small', status: 'missing', acceptance_criteria: ['Login/logout events logged', 'Permission changes tracked', 'Searchable audit trail'], depends_on: ['DEMO-P001', 'DEMO-P002'] },
  ]
});
console.log('  PRD: demo-auth-prd.json created (awaiting-approval)');

// 4. Inbox notes
const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
safeWrite(path.join(inboxDir, 'demo-dallas-2026-03-18.md'), `# Auth Middleware Implementation Notes

## Findings
1. **Passport.js v0.7 breaking changes** — The new version dropped callback-based auth in favor of async/await. All existing auth middleware needs updating. (source: node_modules/@passport/oauth2/CHANGELOG.md)

2. **Token storage pattern** — Using httpOnly secure cookies for access tokens, localStorage for refresh tokens is the current best practice. (source: OWASP Session Management Cheat Sheet)

3. **Convention: error responses** — All auth errors should return \`{ error: string, code: string }\` format consistent with the existing API error handler in \`src/middleware/error-handler.ts:42\`.

## Gotchas
- Redis connection must use TLS in production (currently hardcoded to localhost)
- JWT secret rotation requires coordinated deployment across all services
`);
safeWrite(path.join(inboxDir, 'demo-ripley-2026-03-18.md'), `# Auth PR Review Findings

## Code Review: PR-4521 (OAuth2 Middleware)

### Approved with suggestions

1. **Token expiry too long** — Access tokens set to 24h, should be 15min with refresh flow (source: src/auth/config.ts:15)
2. **Missing CORS origin validation** — Auth endpoints accept any origin, needs allowlist (source: src/middleware/cors.ts:8)
3. **Good pattern: middleware chain** — The auth -> validate -> handler pattern is clean and reusable

### Architecture Note
The middleware chain pattern established here should become the standard for all protected endpoints.
`);
console.log('  Inbox: 2 demo notes created');

// 5. Dispatch completed entries (for agent history)
const dispPath = path.join(MINIONS_DIR, 'engine', 'dispatch.json');
const disp = safeJson(dispPath) || { pending: [], active: [], completed: [] };
// Active dispatches — these make agents show as "working"
const now = new Date().toISOString();
const demoActive = [
  { id: 'demo-a1', agent: 'dallas', agentName: 'Dallas', type: 'implement', task: '[OfficeAgent] Implement: API Rate Limiting with Redis', created_at: now, started_at: now, meta: { branch: 'work/DEMO-004', item: { id: 'DEMO-004' } }, _demo: true },
  { id: 'demo-a2', agent: 'ripley', agentName: 'Ripley', type: 'review', task: '[OfficeAgent] Review PR-4521: Role-Based Access Control', created_at: now, started_at: now, meta: { pr: { id: 'PR-4521' } }, _demo: true },
  { id: 'demo-a3', agent: 'rebecca', agentName: 'Rebecca', type: 'implement', task: '[OfficeAgent] Implement: Session Management with Redis', created_at: now, started_at: now, meta: { branch: 'work/DEMO-P004', item: { id: 'DEMO-P004' } }, _demo: true },
];
const demoCompleted = [
  { id: 'demo-d1', agent: 'dallas', agentName: 'Dallas', type: 'implement', task: '[OfficeAgent] Implement: OAuth2 Authentication Middleware', result: 'success', completed_at: '2026-03-18T14:30:00Z', resultSummary: 'Implemented JWT auth with passport.js, created PR-4520', _demo: true },
  { id: 'demo-d2', agent: 'ripley', agentName: 'Ripley', type: 'review', task: '[OfficeAgent] Review PR-4520: Auth Middleware', result: 'success', completed_at: '2026-03-18T16:00:00Z', resultSummary: 'Approved with suggestions — token expiry and CORS fixes needed', _demo: true },
  { id: 'demo-d3', agent: 'rebecca', agentName: 'Rebecca', type: 'implement', task: '[OfficeAgent] Implement: Role-Based Access Control', result: 'success', completed_at: '2026-03-19T09:00:00Z', resultSummary: 'RBAC implemented with role hierarchy, created PR-4521', _demo: true },
  { id: 'demo-d4', agent: 'lambert', agentName: 'Lambert', type: 'plan-to-prd', task: '[OfficeAgent] Generate PRD from plan: auth-plan', result: 'success', completed_at: '2026-03-18T11:30:00Z', resultSummary: 'Generated PRD with 5 features, dependency graph mapped', _demo: true },
];
disp.active = [...(disp.active || []).filter(d => !d._demo), ...demoActive];
disp.completed = [...(disp.completed || []).filter(d => !d._demo), ...demoCompleted];
safeWrite(dispPath, disp);
console.log(`  Dispatch: ${demoActive.length} active + ${demoCompleted.length} completed seeded`);

// 6. Live output logs — makes working agents show recent activity
const agentsDir = path.join(MINIONS_DIR, 'agents');
const liveOutputs = {
  dallas: `# Live output for dallas — demo-a1
# Started: ${now}
# Task: [OfficeAgent] Implement: API Rate Limiting with Redis

{"type":"assistant","message":{"content":[{"type":"text","text":"I'll implement the rate limiting middleware using Redis. Let me start by reading the existing middleware patterns..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/middleware/auth.ts"}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Good, I can see the middleware chain pattern. Now let me create the rate limiter..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/middleware/rate-limiter.ts"}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Rate limiter created. Now implementing the Redis connection and configuring per-endpoint limits..."}]}}
`,
  ripley: `# Live output for ripley — demo-a2
# Started: ${now}
# Task: [OfficeAgent] Review PR-4521: Role-Based Access Control

{"type":"assistant","message":{"content":[{"type":"text","text":"Reviewing PR-4521 for RBAC implementation. Let me check the permission model..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git diff origin/main...origin/work/DEMO-P002 --stat"}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"14 files changed. Reviewing the role hierarchy implementation and permission middleware..."}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Found a potential issue: the permission check doesn't handle inherited roles correctly. The Admin role should inherit all Editor permissions..."}]}}
`,
  rebecca: `# Live output for rebecca — demo-a3
# Started: ${now}
# Task: [OfficeAgent] Implement: Session Management with Redis

{"type":"assistant","message":{"content":[{"type":"text","text":"Implementing secure session management. Starting with the Redis session store configuration..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob","input":{"pattern":"src/config/**/*.ts"}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Found the config structure. Creating session store with configurable TTL and secure cookie settings..."}]}}
`,
};
for (const [agentId, content] of Object.entries(liveOutputs)) {
  const agentDir = path.join(agentsDir, agentId);
  if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
  safeWrite(path.join(agentDir, 'live-output.log'), content);
}
console.log(`  Live output: ${Object.keys(liveOutputs).length} agents with active output`);

console.log('\nDemo data seeded. Run with --clean to remove.');
