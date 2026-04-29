#!/usr/bin/env node
/**
 * Minions System Regression Tests
 *
 * Run: node test/minions-tests.js
 *
 * Tests against the live dashboard API and verifies file-system state.
 * Dashboard must be running on port 7331.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE = process.env.MINIONS_TEST_BASE || 'http://localhost:7331';
const REPO_ROOT = path.resolve(__dirname, '..');
const REQUESTED_MINIONS_DIR = process.env.MINIONS_TEST_DIR ? path.resolve(process.env.MINIONS_TEST_DIR) : null;
const ALLOW_REAL_ROOT = process.env.MINIONS_TEST_ALLOW_REAL_ROOT === '1';
const MINIONS_DIR = REQUESTED_MINIONS_DIR || REPO_ROOT;
const PLANS_DIR = path.join(MINIONS_DIR, 'plans');
const PRD_DIR = path.join(MINIONS_DIR, 'prd');
const ENGINE_DIR = path.join(MINIONS_DIR, 'engine');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeRootForCompare(root) {
  const resolved = path.resolve(String(root || '')).replace(/[\\/]+$/, '');
  const normalized = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertDashboardRootMatchesLocal(health, localDir = MINIONS_DIR) {
  const servedDir = health?.minionsDir;
  if (!servedDir) {
    throw new Error(`Dashboard at ${BASE} did not report minionsDir; refusing to run mutating integration tests`);
  }
  const served = normalizeRootForCompare(servedDir);
  const local = normalizeRootForCompare(localDir);
  const requested = REQUESTED_MINIONS_DIR ? normalizeRootForCompare(REQUESTED_MINIONS_DIR) : null;
  const repoRoot = normalizeRootForCompare(REPO_ROOT);

  if (requested) {
    if (served !== requested || local !== requested) {
      throw new Error(`Dashboard at ${BASE} is serving ${servedDir}, but MINIONS_TEST_DIR is ${REQUESTED_MINIONS_DIR}; refusing to run mutating integration tests`);
    }
    return true;
  }

  if (!ALLOW_REAL_ROOT) {
    throw new Error(`Refusing to run mutating integration tests without MINIONS_TEST_DIR pointing at an isolated test root`);
  }

  if (served !== repoRoot || local !== repoRoot) {
    throw new Error(`Dashboard at ${BASE} is serving ${servedDir}, but the explicit real-root override expects ${REPO_ROOT}; refusing to run mutating integration tests`);
  }
  return true;
}

function httpReq(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const extraHeaders = opts.headers || {};
    // opts.rawBody (string) takes precedence for Content-Type stress tests.
    // opts.contentType overrides Content-Type (e.g. 'text/plain' to test 415).
    const rawBody = opts.rawBody != null ? String(opts.rawBody) : (body ? JSON.stringify(body) : null);
    const contentType = opts.contentType !== undefined ? opts.contentType : (body ? 'application/json' : null);
    const reqOpts = { method, hostname: url.hostname, port: url.port, path: url.pathname + (url.search || ''), headers: { ...extraHeaders } };
    if (rawBody != null) {
      if (contentType !== null && contentType !== undefined && contentType !== '') {
        reqOpts.headers['Content-Type'] = contentType;
      }
      reqOpts.headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    const req = http.request(reqOpts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: d, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: d, json: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (rawBody != null) req.write(rawBody);
    req.end();
  });
}
const GET = (p, opts) => httpReq('GET', p, null, opts);
const POST = (p, b, opts) => httpReq('POST', p, b, opts);

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeJson(fp, data) {
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

let passed = 0, failed = 0, skipped = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${name}\n`);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${name}: ${e.message}\n`);
  }
}

function skip(name, reason) {
  skipped++;
  results.push({ name, status: 'SKIP', reason });
  process.stdout.write(`  \x1b[33mSKIP\x1b[0m ${name}: ${reason}\n`);
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

async function testApiEndpoints() {
  console.log('\n── API Endpoints ──');

  await test('GET /api/status returns full state', async () => {
    const r = await GET('/api/status');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.agents, 'missing agents');
    assert.ok(r.json.dispatch, 'missing dispatch');
    assert.ok(r.json.projects, 'missing projects');
    assert.ok(r.json.timestamp, 'missing timestamp');
    assert.ok(Array.isArray(r.json.workItems), 'workItems not array');
  });

  await test('GET /api/health returns health check', async () => {
    const r = await GET('/api/health');
    assert.strictEqual(r.status, 200);
    assert.ok(['healthy', 'degraded', 'stopped'].includes(r.json.status), 'invalid health status: ' + r.json.status);
    assert.ok(Array.isArray(r.json.agents));
    assert.ok(typeof r.json.uptime === 'number');
    assert.strictEqual(normalizeRootForCompare(r.json.minionsDir), normalizeRootForCompare(MINIONS_DIR));
  });

  await test('GET /api/plans returns array', async () => {
    const r = await GET('/api/plans');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json));
  });

  await test('GET /api/plans only returns .md files', async () => {
    const r = await GET('/api/plans');
    assert.strictEqual(r.status, 200);
    for (const p of r.json) {
      assert.ok(p.file.endsWith('.md'), 'non-.md file in plans list: ' + p.file);
    }
  });

  await test('GET /api/knowledge returns object', async () => {
    const r = await GET('/api/knowledge');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.json === 'object');
  });

  await test('CORS preflight returns 204', async () => {
    const r = await httpReq('OPTIONS', '/api/status');
    assert.strictEqual(r.status, 204);
  });

  await test('Path traversal blocked on plans', async () => {
    const r = await GET('/api/plans/..%2Fconfig.json');
    assert.strictEqual(r.status, 400);
  });

  await test('Prototype pollution guard rejects __proto__ in request body', async () => {
    // JSON.parse creates __proto__ as an own enumerable data property; JSON.stringify round-trips it.
    const poisoned = JSON.parse('{"message":"hi","__proto__":{"polluted":true}}');
    const r = await POST('/api/command-center', poisoned);
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status} (body: ${r.body})`);
    assert.ok(r.json && /forbidden key/.test(r.json.error || ''),
      `expected forbidden-key error, got: ${JSON.stringify(r.json)}`);
    // Verify the native Object prototype was not mutated as a side effect
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype was polluted!');
  });

  await test('Prototype pollution guard rejects constructor in request body', async () => {
    const r = await POST('/api/command-center', { message: 'hi', constructor: { bad: true } });
    assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
    assert.ok(r.json && /forbidden key/.test(r.json.error || ''),
      `expected forbidden-key error, got: ${JSON.stringify(r.json)}`);
  });

  await test('Prototype pollution guard allows clean request bodies', async () => {
    // Use a fast endpoint that also goes through readBody — proves the guard doesn't over-trigger.
    const r = await POST('/api/work-items', { title: 'Pollution guard — clean body', type: 'implement', priority: 'low' });
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} (body: ${r.body})`);
    assert.ok(r.json.id, 'expected an id on successful work-item create');
    // Clean up so we don't leak test state
    await POST('/api/work-items/delete', { id: r.json.id, source: 'central' });
  });
}

async function testWorkItemCrud() {
  console.log('\n── Work Item CRUD ──');

  await test('POST /api/work-items creates item', async () => {
    const r = await POST('/api/work-items', { title: 'Test item', type: 'implement', priority: 'medium' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.id, 'no id returned');
    // Clean up
    await POST('/api/work-items/delete', { id: r.json.id, source: 'central' });
  });

  await test('POST /api/work-items rejects empty title', async () => {
    const r = await POST('/api/work-items', { title: '', type: 'implement' });
    assert.strictEqual(r.status, 400);
  });

  await test('POST /api/work-items/retry resets status', async () => {
    // Create a failed item
    const cr = await POST('/api/work-items', { title: 'Retry test', type: 'implement' });
    const wiPath = path.join(MINIONS_DIR, 'work-items.json');
    const items = readJson(wiPath);
    const item = items.find(i => i.id === cr.json.id);
    item.status = 'failed';
    item.failReason = 'test failure';
    item.dispatched_to = 'dallas';
    writeJson(wiPath, items);

    const r = await POST('/api/work-items/retry', { id: cr.json.id, source: 'central' });
    assert.strictEqual(r.status, 200);

    const after = readJson(wiPath);
    const retried = after.find(i => i.id === cr.json.id);
    assert.strictEqual(retried.status, 'pending');
    assert.strictEqual(retried.failReason, undefined);
    assert.strictEqual(retried.dispatched_to, undefined);

    // Clean up
    await POST('/api/work-items/delete', { id: cr.json.id, source: 'central' });
  });

  await test('POST /api/work-items/delete removes item', async () => {
    const cr = await POST('/api/work-items', { title: 'Delete test', type: 'implement' });
    const r = await POST('/api/work-items/delete', { id: cr.json.id, source: 'central' });
    assert.strictEqual(r.status, 200);
    const items = readJson(path.join(MINIONS_DIR, 'work-items.json'));
    assert.ok(!items.find(i => i.id === cr.json.id), 'item still exists');
  });
}

async function testPlanFlow() {
  console.log('\n── Plan Flow ──');

  await test('POST /api/plan creates plan work item', async () => {
    const r = await POST('/api/plan', { title: 'Test plan', priority: 'medium' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.id);
    const items = readJson(path.join(MINIONS_DIR, 'work-items.json'));
    const item = items.find(i => i.id === r.json.id);
    assert.strictEqual(item.type, 'plan');
    // Clean up
    await POST('/api/work-items/delete', { id: r.json.id, source: 'central' });
  });

  await test('POST /api/plans/execute queues plan-to-prd for .md', async () => {
    // Seed a test plan
    const testPlan = path.join(PLANS_DIR, 'test-execute.md');
    fs.writeFileSync(testPlan, '# Test Plan\n\nDo stuff.');
    try {
      const r = await POST('/api/plans/execute', { file: 'test-execute.md' });
      assert.strictEqual(r.status, 200);
      const items = readJson(path.join(MINIONS_DIR, 'work-items.json'));
      const item = items.find(i => i.type === 'plan-to-prd' && i.planFile === 'test-execute.md');
      assert.ok(item, 'plan-to-prd work item not queued');
      assert.strictEqual(item.type, 'plan-to-prd');
      assert.strictEqual(item.planFile, 'test-execute.md');
      // Clean up
      await POST('/api/work-items/delete', { id: item.id, source: 'central' });
    } finally {
      try { fs.unlinkSync(testPlan); } catch {}
    }
  });

  await test('POST /api/plans/execute rejects .json', async () => {
    const r = await POST('/api/plans/execute', { file: 'test.json' });
    assert.strictEqual(r.status, 400);
  });

  await test('POST /api/plans/execute deduplicates', async () => {
    const testPlan = path.join(PLANS_DIR, 'test-dedup.md');
    fs.writeFileSync(testPlan, '# Dedup Test');
    try {
      const r1 = await POST('/api/plans/execute', { file: 'test-dedup.md' });
      assert.strictEqual(r1.status, 200);
      const firstItems = readJson(path.join(MINIONS_DIR, 'work-items.json'));
      const firstQueued = firstItems.find(i => i.type === 'plan-to-prd' && i.planFile === 'test-dedup.md');
      assert.ok(firstQueued, 'first plan-to-prd work item not queued');
      const r2 = await POST('/api/plans/execute', { file: 'test-dedup.md' });
      assert.strictEqual(r2.json.alreadyQueued, true);
      const secondItems = readJson(path.join(MINIONS_DIR, 'work-items.json'));
      const queued = secondItems.filter(i => i.type === 'plan-to-prd' && i.planFile === 'test-dedup.md');
      assert.strictEqual(queued.length, 1, 'duplicate plan-to-prd work item queued');
      assert.strictEqual(queued[0].id, firstQueued.id);
      await POST('/api/work-items/delete', { id: firstQueued.id, source: 'central' });
    } finally {
      try { fs.unlinkSync(testPlan); } catch {}
    }
  });

  await test('POST /api/plans/pause sets paused', async () => {
    const testFile = 'test-pause.json';
    writeJson(path.join(PRD_DIR, testFile), { status: 'approved', missing_features: [] });
    try {
      const r = await POST('/api/plans/pause', { file: testFile });
      assert.strictEqual(r.status, 200);
      const plan = readJson(path.join(PRD_DIR, testFile));
      assert.strictEqual(plan.status, 'paused');
    } finally {
      try { fs.unlinkSync(path.join(PRD_DIR, testFile)); } catch {}
    }
  });

  await test('POST /api/plans/delete cascades to work items', async () => {
    const testFile = 'test-cascade.json';
    writeJson(path.join(PRD_DIR, testFile), {
      status: 'approved', project: 'OfficeAgent',
      missing_features: [{ id: 'T001', name: 'Test', status: 'missing', priority: 'medium' }]
    });
    // Seed a work item referencing this plan
    const wiPath = path.join(MINIONS_DIR, 'work-items.json');
    const items = readJson(wiPath);
    items.push({ id: 'T001', sourcePlan: testFile, status: 'pending', title: 'Test' });
    writeJson(wiPath, items);

    const r = await POST('/api/plans/delete', { file: testFile });
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(path.join(PRD_DIR, testFile)), 'plan file still exists');
    const afterItems = readJson(wiPath);
    assert.ok(!afterItems.find(i => i.id === 'T001'), 'work item still exists');
  });
}

async function testPrdFlow() {
  console.log('\n── PRD Flow ──');

  await test('PRD status derived from work items (not plan JSON)', async () => {
    const r = await GET('/api/status');
    if (!r.json.prdProgress || !r.json.prdProgress.items || r.json.prdProgress.items.length === 0) {
      skip('prd-status-derived', 'no PRD items to test');
      return;
    }
    // Verify items have statuses derived from work items
    const wi = r.json.workItems || [];
    for (const item of r.json.prdProgress.items) {
      const workItem = wi.find(w => w.id === item.id);
      if (workItem) {
        const expectedStatus =
          workItem.status === 'done' ? 'implemented' :
          workItem.status === 'failed' ? 'failed' :
          workItem.status === 'dispatched' ? 'in-progress' :
          workItem.status === 'pending' ? 'missing' : item.status;
        assert.strictEqual(item.status, expectedStatus,
          `PRD item ${item.id}: expected '${expectedStatus}' from work item '${workItem.status}', got '${item.status}'`);
      }
    }
  });

  await test('PRD items include depends_on field', async () => {
    const r = await GET('/api/status');
    if (!r.json.prdProgress || !r.json.prdProgress.items) return;
    for (const item of r.json.prdProgress.items) {
      assert.ok(Array.isArray(item.depends_on), `item ${item.id} missing depends_on array`);
    }
  });

  await test('POST /api/prd-items/update modifies plan JSON', async () => {
    const testFile = 'test-edit.json';
    writeJson(path.join(PRD_DIR, testFile), {
      status: 'approved',
      missing_features: [{ id: 'E001', name: 'Original', description: '', priority: 'low', status: 'missing' }]
    });
    try {
      const r = await POST('/api/prd-items/update', {
        source: testFile, itemId: 'E001', name: 'Updated', priority: 'high'
      });
      assert.strictEqual(r.status, 200);
      const plan = readJson(path.join(PRD_DIR, testFile));
      assert.strictEqual(plan.missing_features[0].name, 'Updated');
      assert.strictEqual(plan.missing_features[0].priority, 'high');
    } finally {
      try { fs.unlinkSync(path.join(PRD_DIR, testFile)); } catch {}
    }
  });

  await test('POST /api/prd-items/remove deletes item from plan', async () => {
    const testFile = 'test-remove.json';
    writeJson(path.join(PRD_DIR, testFile), {
      status: 'approved',
      missing_features: [
        { id: 'R001', name: 'Keep', status: 'missing' },
        { id: 'R002', name: 'Remove', status: 'missing' }
      ]
    });
    try {
      const r = await POST('/api/prd-items/remove', { source: testFile, itemId: 'R002' });
      assert.strictEqual(r.status, 200);
      const plan = readJson(path.join(PRD_DIR, testFile));
      assert.strictEqual(plan.missing_features.length, 1);
      assert.strictEqual(plan.missing_features[0].id, 'R001');
    } finally {
      try { fs.unlinkSync(path.join(PRD_DIR, testFile)); } catch {}
    }
  });
}

async function testInboxAndNotes() {
  console.log('\n── Inbox & Notes ──');

  await test('POST /api/notes creates inbox file', async () => {
    const r = await POST('/api/notes', { title: 'Test note', what: 'Testing', context: 'test' });
    assert.strictEqual(r.status, 200);
    // Verify file exists in inbox
    const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
    const files = fs.readdirSync(inboxDir).filter(f => f.includes('test-note'));
    assert.ok(files.length > 0, 'no inbox file created');
    // Clean up
    for (const f of files) try { fs.unlinkSync(path.join(inboxDir, f)); } catch {}
  });

  await test('POST /api/inbox/delete removes file', async () => {
    const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
    const testFile = 'test-delete-note.md';
    fs.writeFileSync(path.join(inboxDir, testFile), 'test');
    const r = await POST('/api/inbox/delete', { name: testFile });
    assert.strictEqual(r.status, 200);
    assert.ok(!fs.existsSync(path.join(inboxDir, testFile)));
  });

  await test('POST /api/inbox/delete rejects path traversal', async () => {
    const r = await POST('/api/inbox/delete', { name: '../config.json' });
    assert.strictEqual(r.status, 400);
  });
}

async function testDispatchIntegrity() {
  console.log('\n── Dispatch Integrity ──');

  await test('Dispatch queue has valid structure', async () => {
    const dispatch = readJson(path.join(ENGINE_DIR, 'dispatch.json'));
    assert.ok(dispatch, 'dispatch.json missing');
    assert.ok(Array.isArray(dispatch.pending), 'pending not array');
    assert.ok(Array.isArray(dispatch.active), 'active not array');
    assert.ok(Array.isArray(dispatch.completed), 'completed not array');
  });

  await test('No orphaned dispatch entries (items exist for active dispatches)', async () => {
    const dispatch = readJson(path.join(ENGINE_DIR, 'dispatch.json'));
    if (!dispatch || !dispatch.active) return;
    // Collect all work item IDs
    const allIds = new Set();
    const centralItems = readJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
    centralItems.forEach(i => allIds.add(i.id));
    const config = readJson(path.join(MINIONS_DIR, 'config.json'));
    for (const proj of (config.projects || [])) {
      try {
        const items = readJson(path.join(proj.localPath, '.minions', 'work-items.json')) || [];
        items.forEach(i => allIds.add(i.id));
      } catch {}
    }
    for (const d of dispatch.active) {
      const itemId = d.meta?.item?.id;
      if (itemId) {
        assert.ok(allIds.has(itemId), `Active dispatch references missing work item: ${itemId}`);
      }
    }
  });

  await test('Completed dispatches capped at 100', async () => {
    const dispatch = readJson(path.join(ENGINE_DIR, 'dispatch.json'));
    assert.ok(dispatch.completed.length <= 100, 'completed queue exceeds 100: ' + dispatch.completed.length);
  });
}

async function testDataIntegrity() {
  console.log('\n── Data Integrity ──');

  await test('config.json is valid', async () => {
    const config = readJson(path.join(MINIONS_DIR, 'config.json'));
    assert.ok(config, 'config.json missing or invalid');
    assert.ok(config.agents, 'no agents defined');
    assert.ok(Array.isArray(config.projects), 'projects not array');
  });

  await test('Agent status is derivable from dispatch.json', async () => {
    const dispatch = readJson(path.join(ENGINE_DIR, 'dispatch.json'));
    assert.ok(dispatch, 'dispatch.json missing');
    assert.ok(Array.isArray(dispatch.pending), 'pending not array');
    assert.ok(Array.isArray(dispatch.active), 'active not array');
    assert.ok(Array.isArray(dispatch.completed), 'completed not array');
    for (const entry of dispatch.active) {
      assert.ok(entry.agent, `Active dispatch entry missing agent field: ${JSON.stringify(entry)}`);
    }
  });

  await test('All plan JSON files are valid', async () => {
    if (!fs.existsSync(PLANS_DIR)) return;
    const jsonFiles = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.json'));
    for (const f of jsonFiles) {
      const plan = readJson(path.join(PLANS_DIR, f));
      assert.ok(plan, `Invalid plan JSON: ${f}`);
      assert.ok(Array.isArray(plan.missing_features), `${f} missing missing_features array`);
    }
  });

  await test('Metrics JSON is valid', async () => {
    const metrics = readJson(path.join(ENGINE_DIR, 'metrics.json'));
    assert.ok(metrics, 'metrics.json missing or invalid');
    for (const [id, m] of Object.entries(metrics)) {
      if (id.startsWith('_')) continue;
      assert.ok(typeof m.tasksCompleted === 'number', `${id} missing tasksCompleted`);
      assert.ok(typeof m.tasksErrored === 'number', `${id} missing tasksErrored`);
    }
  });

  await test('PRD item status matches work item status', async () => {
    const r = await GET('/api/status');
    if (!r.json.prdProgress || !r.json.prdProgress.items) return;
    const statusMap = { 'done': 'implemented', 'failed': 'failed', 'dispatched': 'in-progress', 'pending': 'missing' };
    const projectWi = [];
    const config = readJson(path.join(MINIONS_DIR, 'config.json'));
    for (const proj of (config.projects || [])) {
      try {
        const items = readJson(path.join(proj.localPath, '.minions', 'work-items.json')) || [];
        projectWi.push(...items);
      } catch {}
    }
    for (const prdItem of r.json.prdProgress.items) {
      const wi = projectWi.find(w => w.id === prdItem.id && w.sourcePlan === prdItem.source);
      if (wi) {
        const expected = statusMap[wi.status] || prdItem.status;
        assert.strictEqual(prdItem.status, expected,
          `PRD ${prdItem.id} status mismatch: PRD='${prdItem.status}' work-item='${wi.status}' expected='${expected}'`);
      }
    }
  });
}

async function testSecurityHeaders() {
  console.log('\n── Security Headers & Origin Gate ──');

  // 1. Security response headers on GET /api/status
  await test('GET /api/status includes CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy', async () => {
    const r = await GET('/api/status');
    assert.strictEqual(r.status, 200);
    const h = r.headers;
    assert.ok(h['content-security-policy'], 'missing Content-Security-Policy');
    assert.ok(h['content-security-policy'].includes("default-src 'self'"), 'CSP missing default-src');
    assert.ok(h['content-security-policy'].includes("script-src 'self'"), 'CSP missing script-src');
    // API responses must keep strict script-src (no 'unsafe-inline')
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(h['content-security-policy']),
      "API CSP must not allow 'unsafe-inline' scripts");
    assert.strictEqual(h['x-frame-options'], 'DENY');
    assert.strictEqual(h['x-content-type-options'], 'nosniff');
    assert.strictEqual(h['referrer-policy'], 'same-origin');
  });

  // 2. POST with disallowed Origin → 403
  await test('POST /api/command-center with Origin: https://evil.example returns 403', async () => {
    const r = await POST('/api/command-center',
      { message: 'hi', tabId: 'sec-test-bad-origin' },
      { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status} body=${r.body}`);
    assert.ok(r.json, 'response must be JSON');
    assert.ok(/not allowed/i.test(r.json.error || ''), 'error must mention origin');
  });

  // 3. POST with valid localhost Origin → proceeds (not 403)
  await test('POST /api/work-items with Origin: http://localhost:7331 succeeds (not blocked by origin gate)', async () => {
    const r = await POST('/api/work-items',
      { title: 'Security test work item (safe to delete)', type: 'implement', priority: 'low' },
      { headers: { Origin: 'http://localhost:7331' } });
    assert.notStrictEqual(r.status, 403, 'valid localhost Origin must not be blocked');
    assert.ok(r.status === 200 || r.status === 201, `unexpected status ${r.status} body=${r.body}`);
    // Clean up the test item
    if (r.json && r.json.id) {
      try { await POST('/api/work-items/delete', { id: r.json.id }); } catch {}
    }
  });

  // 4. Content-Type enforcement — text/plain on POST → 415
  await test('POST /api/command-center with Content-Type: text/plain returns 415', async () => {
    const r = await POST('/api/command-center',
      null,
      { rawBody: JSON.stringify({ message: 'hi', tabId: 'sec-test-bad-ct' }),
        contentType: 'text/plain',
        headers: { Origin: 'http://localhost:7331' } });
    assert.strictEqual(r.status, 415, `expected 415, got ${r.status} body=${r.body}`);
    assert.ok(r.json && /application\/json/i.test(r.json.error || ''),
      'error must mention application/json');
  });

  // 5. Missing Content-Type on POST → 415
  await test('POST /api/command-center with no Content-Type returns 415', async () => {
    const r = await POST('/api/command-center',
      null,
      { rawBody: JSON.stringify({ message: 'hi', tabId: 'sec-test-no-ct' }),
        contentType: '',
        headers: { Origin: 'http://localhost:7331' } });
    assert.strictEqual(r.status, 415, `expected 415, got ${r.status} body=${r.body}`);
  });

  // 6. Content-Type: application/json → allowed (not 415, gate not triggered)
  await test('POST /api/work-items with application/json Content-Type is not blocked by 415 gate', async () => {
    const r = await POST('/api/work-items',
      { title: 'Content-Type allow test item (safe to delete)', type: 'implement', priority: 'low' },
      { headers: { Origin: 'http://localhost:7331' } });
    assert.notStrictEqual(r.status, 415, 'application/json must not trigger 415');
    assert.notStrictEqual(r.status, 403, 'valid origin must not trigger 403');
    assert.ok(r.status === 200 || r.status === 201, `unexpected status ${r.status} body=${r.body}`);
    if (r.json && r.json.id) {
      try { await POST('/api/work-items/delete', { id: r.json.id }); } catch {}
    }
  });

  // 7. Second mutating endpoint: POST /api/work-items with evil Origin → 403
  await test('POST /api/work-items with cross-origin header returns 403', async () => {
    const r = await POST('/api/work-items',
      { title: 'should never be created', type: 'implement' },
      { headers: { Origin: 'https://attacker.example.com' } });
    assert.strictEqual(r.status, 403, `expected 403, got ${r.status} body=${r.body}`);
  });

  // 8. SSE endpoint Origin rejection — must 403 before upgrade
  await test('GET /api/agent/dallas/live-stream with cross-origin header returns 403 (not SSE upgrade)', async () => {
    const r = await GET('/api/agent/dallas/live-stream',
      { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.status, 403, `SSE must reject before upgrade; got ${r.status}`);
    assert.ok(r.headers['content-type'] && r.headers['content-type'].includes('application/json'),
      'rejection must be JSON, not text/event-stream');
  });

  // 9. Same-origin GET without Origin header is allowed (legacy tooling, polling)
  await test('GET /api/status without Origin header is allowed', async () => {
    const r = await GET('/api/status');
    assert.strictEqual(r.status, 200);
  });

  // 10. POST without Origin and without Referer is allowed (curl / legacy tooling)
  await test('POST /api/work-items with no Origin and no Referer is allowed (legacy curl)', async () => {
    const r = await POST('/api/work-items',
      { title: 'Legacy curl test item (safe to delete)', type: 'implement', priority: 'low' });
    assert.notStrictEqual(r.status, 403, 'no-origin requests must not be blocked');
    assert.ok(r.status === 200 || r.status === 201, `unexpected status ${r.status}`);
    if (r.json && r.json.id) {
      try { await POST('/api/work-items/delete', { id: r.json.id }); } catch {}
    }
  });

  // 11. POST with disallowed Referer (no Origin) → 403
  await test('POST /api/work-items with disallowed Referer (no Origin) returns 403', async () => {
    const r = await POST('/api/work-items',
      { title: 'should never be created', type: 'implement' },
      { headers: { Referer: 'https://evil.example/attack.html' } });
    assert.strictEqual(r.status, 403, `expected 403 on disallowed Referer, got ${r.status}`);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Minions Regression Tests');
  console.log('======================');
  console.log(`Dashboard: ${BASE}`);
  console.log(`Minions dir: ${MINIONS_DIR}\n`);

  // Verify dashboard is running
  try {
    const r = await GET('/api/health');
    if (r.status !== 200) throw new Error('unhealthy');
    assertDashboardRootMatchesLocal(r.json);
    console.log(`Dashboard status: ${r.json.status}`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }

  await testApiEndpoints();
  await testSecurityHeaders();
  await testWorkItemCrud();
  await testPlanFlow();
  await testPrdFlow();
  await testInboxAndNotes();
  await testDispatchIntegrity();
  await testDataIntegrity();

  console.log(`\n══════════════════════════════`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`══════════════════════════════\n`);

  // Write results to file for CI/hooks
  writeJson(path.join(ENGINE_DIR, 'test-results.json'), {
    timestamp: new Date().toISOString(),
    passed, failed, skipped,
    results
  });

  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  normalizeRootForCompare,
  assertDashboardRootMatchesLocal,
  main,
};
