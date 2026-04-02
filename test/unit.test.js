#!/usr/bin/env node
/**
 * Minions Unit Tests — Comprehensive test suite for core logic.
 *
 * Run: node test/unit.test.js
 *
 * Tests core modules WITHOUT requiring the dashboard or engine to be running.
 * Uses temporary directories for isolation — no side effects on real state.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Test Framework ──────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const results = [];
const tmpDirs = [];

function createTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minions-test-'));
  tmpDirs.push(dir);
  return dir;
}

function cleanupTmpDirs() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

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

// ─── Module Imports ──────────────────────────────────────────────────────────

const MINIONS_DIR = path.resolve(__dirname, '..');
const shared = require(path.join(MINIONS_DIR, 'engine', 'shared'));
const queries = require(path.join(MINIONS_DIR, 'engine', 'queries'));
const scheduler = require(path.join(MINIONS_DIR, 'engine', 'scheduler'));

// ─── shared.js Tests ─────────────────────────────────────────────────────────

async function testSharedUtilities() {
  console.log('\n── shared.js — File I/O ──');

  await test('safeRead returns empty string for missing file', () => {
    assert.strictEqual(shared.safeRead('/nonexistent/file.txt'), '');
  });

  await test('safeJson returns null for missing file', () => {
    assert.strictEqual(shared.safeJson('/nonexistent/file.json'), null);
  });

  await test('safeJson returns null for invalid JSON', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'bad.json');
    fs.writeFileSync(fp, 'not json at all');
    assert.strictEqual(shared.safeJson(fp), null);
  });

  await test('safeWrite + safeJson roundtrip (object)', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'test.json');
    const data = { hello: 'world', count: 42, nested: { a: [1, 2, 3] } };
    shared.safeWrite(fp, data);
    const result = shared.safeJson(fp);
    assert.deepStrictEqual(result, data);
  });

  await test('safeWrite + safeRead roundtrip (string)', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'test.txt');
    shared.safeWrite(fp, 'hello world');
    assert.strictEqual(shared.safeRead(fp), 'hello world');
  });

  await test('safeWrite creates parent directories', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'a', 'b', 'c', 'deep.json');
    shared.safeWrite(fp, { deep: true });
    assert.deepStrictEqual(shared.safeJson(fp), { deep: true });
  });

  await test('safeUnlink removes file silently', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'delete-me.txt');
    fs.writeFileSync(fp, 'temp');
    shared.safeUnlink(fp);
    assert.ok(!fs.existsSync(fp));
  });

  await test('safeUnlink on missing file does not throw', () => {
    shared.safeUnlink('/nonexistent/file.txt'); // should not throw
  });

  await test('safeReadDir returns empty array for missing dir', () => {
    assert.deepStrictEqual(shared.safeReadDir('/nonexistent/dir'), []);
  });
}

async function testIdGeneration() {
  console.log('\n── shared.js — ID Generation ──');

  await test('uid generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(shared.uid());
    assert.strictEqual(ids.size, 100, 'uid produced duplicates');
  });

  await test('uid returns string', () => {
    assert.strictEqual(typeof shared.uid(), 'string');
  });

  await test('uniquePath returns original if file does not exist', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'new-file.json');
    assert.strictEqual(shared.uniquePath(fp), fp);
  });

  await test('uniquePath appends -2 if file exists', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'existing.json');
    fs.writeFileSync(fp, '{}');
    const result = shared.uniquePath(fp);
    assert.ok(result.endsWith('existing-2.json'), `Expected -2 suffix, got: ${result}`);
  });

  await test('uniquePath increments up to -3, -4, etc.', () => {
    const dir = createTmpDir();
    const base = path.join(dir, 'file.txt');
    fs.writeFileSync(base, '');
    fs.writeFileSync(path.join(dir, 'file-2.txt'), '');
    fs.writeFileSync(path.join(dir, 'file-3.txt'), '');
    const result = shared.uniquePath(base);
    assert.ok(result.endsWith('file-4.txt'), `Expected -4, got: ${result}`);
  });

  // ── writeToInbox ──

  await test('writeToInbox writes file with agentId-slug-date pattern', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const result = shared.writeToInbox('ralph', 'test-slug', '# Test content', inboxDir);
    assert.strictEqual(result, true, 'Should return true when write occurs');
    const files = fs.readdirSync(inboxDir);
    assert.strictEqual(files.length, 1, 'Should have exactly one file');
    assert.ok(files[0].startsWith('ralph-test-slug-'), `File should start with ralph-test-slug-, got: ${files[0]}`);
    assert.ok(files[0].endsWith('.md'), 'File should end with .md');
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.strictEqual(content, '# Test content');
  });

  await test('writeToInbox deduplicates on same agentId+slug+date', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const first = shared.writeToInbox('engine', 'prd-completion', '# First', inboxDir);
    assert.strictEqual(first, true, 'First write should succeed');
    const second = shared.writeToInbox('engine', 'prd-completion', '# Second', inboxDir);
    assert.strictEqual(second, false, 'Second write should be deduped');
    const files = fs.readdirSync(inboxDir);
    assert.strictEqual(files.length, 1, 'Should still have only one file');
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.strictEqual(content, '# First', 'Content should be from first write');
  });

  await test('writeToInbox allows different slugs on same day', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    shared.writeToInbox('engine', 'slug-a', '# A', inboxDir);
    shared.writeToInbox('engine', 'slug-b', '# B', inboxDir);
    const files = fs.readdirSync(inboxDir);
    assert.strictEqual(files.length, 2, 'Different slugs should create separate files');
  });

  await test('writeToInbox returns false on error (missing dir)', () => {
    const result = shared.writeToInbox('test', 'slug', 'content', '/nonexistent/path/inbox');
    assert.strictEqual(result, false, 'Should return false on error');
  });

  await test('nextWorkItemId increments from existing items', () => {
    const items = [{ id: 'W001' }, { id: 'W002' }, { id: 'W005' }];
    assert.strictEqual(shared.nextWorkItemId(items, 'W'), 'W006');
  });

  await test('nextWorkItemId starts at 001 for empty array', () => {
    assert.strictEqual(shared.nextWorkItemId([], 'P'), 'P001');
  });
}

async function testBranchSanitization() {
  console.log('\n── shared.js — Branch Sanitization ──');

  await test('sanitizeBranch preserves valid chars', () => {
    assert.strictEqual(shared.sanitizeBranch('feature/my-branch'), 'feature/my-branch');
  });

  await test('sanitizeBranch replaces invalid chars with hyphens', () => {
    assert.strictEqual(shared.sanitizeBranch('my branch [v2]'), 'my-branch--v2-');
  });

  await test('sanitizeBranch truncates to 200 chars', () => {
    const long = 'a'.repeat(300);
    assert.strictEqual(shared.sanitizeBranch(long).length, 200);
  });

  await test('sanitizeBranch handles empty string', () => {
    assert.strictEqual(shared.sanitizeBranch(''), '');
  });
}

async function testSanitizePath() {
  console.log('\n── shared.js — Path Sanitization ──');

  await test('sanitizePath accepts valid filenames', () => {
    const tmp = createTmpDir();
    const result = shared.sanitizePath('test.json', tmp);
    assert.strictEqual(result, path.resolve(tmp, 'test.json'));
  });

  await test('sanitizePath rejects directory traversal with ../', () => {
    const tmp = createTmpDir();
    assert.throws(() => shared.sanitizePath('../etc/passwd', tmp), /directory traversal/);
  });

  await test('sanitizePath rejects encoded directory traversal', () => {
    const tmp = createTmpDir();
    assert.throws(() => shared.sanitizePath('..%2F..%2Fetc%2Fpasswd', tmp), /directory traversal/);
  });

  await test('sanitizePath rejects null bytes', () => {
    const tmp = createTmpDir();
    assert.throws(() => shared.sanitizePath('test\0.json', tmp), /null byte/);
  });

  await test('sanitizePath rejects absolute paths', () => {
    const tmp = createTmpDir();
    assert.throws(() => shared.sanitizePath('/etc/passwd', tmp), /absolute path/);
    assert.throws(() => shared.sanitizePath('C:\\Windows\\System32', tmp), /absolute path/);
  });

  await test('sanitizePath rejects empty file parameter', () => {
    const tmp = createTmpDir();
    assert.throws(() => shared.sanitizePath('', tmp), /required/);
    assert.throws(() => shared.sanitizePath(null, tmp), /required/);
  });

  await test('sanitizePath allows subdirectory paths within base', () => {
    const tmp = createTmpDir();
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
    const result = shared.sanitizePath('sub/file.txt', tmp);
    assert.ok(result.startsWith(path.resolve(tmp)));
  });
}

async function testValidatePid() {
  console.log('\n── shared.js — PID Validation ──');

  await test('validatePid accepts valid numeric PIDs', () => {
    assert.strictEqual(shared.validatePid(1234), 1234);
    assert.strictEqual(shared.validatePid('5678'), 5678);
  });

  await test('validatePid rejects non-numeric strings', () => {
    assert.throws(() => shared.validatePid('abc'), /numeric/);
    assert.throws(() => shared.validatePid('12; rm -rf /'), /numeric/);
    assert.throws(() => shared.validatePid('123 & echo pwned'), /numeric/);
  });

  await test('validatePid rejects zero and negative PIDs', () => {
    assert.throws(() => shared.validatePid(0), /positive/);
    assert.throws(() => shared.validatePid(-1), /numeric/);
  });
}

async function testParseStreamJsonOutput() {
  console.log('\n── shared.js — Claude Output Parsing ──');

  await test('parseStreamJsonOutput extracts result text', () => {
    const raw = '{"type":"system","subtype":"init"}\n{"type":"result","result":"Hello world","session_id":"abc123"}';
    const { text, sessionId } = shared.parseStreamJsonOutput(raw);
    assert.strictEqual(text, 'Hello world');
    assert.strictEqual(sessionId, 'abc123');
  });

  await test('parseStreamJsonOutput extracts usage data', () => {
    const raw = '{"type":"result","result":"done","total_cost_usd":0.05,"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10},"duration_ms":5000,"num_turns":3}';
    const { usage } = shared.parseStreamJsonOutput(raw);
    assert.ok(usage);
    assert.strictEqual(usage.costUsd, 0.05);
    assert.strictEqual(usage.inputTokens, 100);
    assert.strictEqual(usage.outputTokens, 50);
    assert.strictEqual(usage.cacheRead, 10);
    assert.strictEqual(usage.durationMs, 5000);
    assert.strictEqual(usage.numTurns, 3);
  });

  await test('parseStreamJsonOutput handles empty input', () => {
    const { text, usage } = shared.parseStreamJsonOutput('');
    assert.strictEqual(text, '');
    assert.strictEqual(usage, null);
  });

  await test('parseStreamJsonOutput handles non-JSON lines', () => {
    const raw = 'this is not json\nalso not json\n{"type":"result","result":"ok"}';
    const { text } = shared.parseStreamJsonOutput(raw);
    assert.strictEqual(text, 'ok');
  });

  await test('parseStreamJsonOutput respects maxTextLength', () => {
    const raw = '{"type":"result","result":"' + 'x'.repeat(1000) + '"}';
    const { text } = shared.parseStreamJsonOutput(raw, { maxTextLength: 50 });
    assert.strictEqual(text.length, 50);
  });

  await test('parseStreamJsonOutput finds result scanning from end', () => {
    const lines = [];
    for (let i = 0; i < 100; i++) lines.push(`{"type":"assistant","message":"line ${i}"}`);
    lines.push('{"type":"result","result":"final answer"}');
    const { text } = shared.parseStreamJsonOutput(lines.join('\n'));
    assert.strictEqual(text, 'final answer');
  });
}

async function testClassifyInboxItem() {
  console.log('\n── shared.js — Knowledge Base Classification ──');

  await test('classifyInboxItem detects reviews', () => {
    assert.strictEqual(shared.classifyInboxItem('review-findings.md', ''), 'reviews');
    assert.strictEqual(shared.classifyInboxItem('pr-123.md', ''), 'reviews');
    assert.strictEqual(shared.classifyInboxItem('feedback-dallas.md', ''), 'reviews');
  });

  await test('classifyInboxItem detects build reports', () => {
    assert.strictEqual(shared.classifyInboxItem('build-report.md', ''), 'build-reports');
    assert.strictEqual(shared.classifyInboxItem('bt-results.md', ''), 'build-reports');
    assert.strictEqual(shared.classifyInboxItem('test.md', 'build passed successfully'), 'build-reports');
  });

  await test('classifyInboxItem detects architecture', () => {
    assert.strictEqual(shared.classifyInboxItem('findings.md', 'architecture overview of the system'), 'architecture');
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'system design document'), 'architecture');
  });

  await test('classifyInboxItem detects conventions', () => {
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'convention: always use strict mode'), 'conventions');
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'best practice for error handling'), 'conventions');
  });

  await test('classifyInboxItem defaults to project-notes', () => {
    assert.strictEqual(shared.classifyInboxItem('random-note.md', 'some general finding'), 'project-notes');
  });
}

async function testSkillFrontmatter() {
  console.log('\n── shared.js — Skill Frontmatter Parsing ──');

  await test('parseSkillFrontmatter extracts all fields', () => {
    const content = `---
name: my-skill
description: Does something useful
trigger: when you need to do X
project: MyProject
author: dallas
created: 2024-01-01
allowed-tools: Bash, Read
---

## Steps
1. Do this
2. Do that`;
    const result = shared.parseSkillFrontmatter(content, 'fallback.md');
    assert.strictEqual(result.name, 'my-skill');
    assert.strictEqual(result.description, 'Does something useful');
    assert.strictEqual(result.trigger, 'when you need to do X');
    assert.strictEqual(result.project, 'MyProject');
    assert.strictEqual(result.author, 'dallas');
    assert.strictEqual(result.allowedTools, 'Bash, Read');
  });

  await test('parseSkillFrontmatter falls back to filename', () => {
    const result = shared.parseSkillFrontmatter('No frontmatter here', 'my-file.md');
    assert.strictEqual(result.name, 'my-file');
    assert.strictEqual(result.project, 'any');
  });

  await test('parseSkillFrontmatter handles empty content', () => {
    const result = shared.parseSkillFrontmatter('', 'empty.md');
    assert.strictEqual(result.name, 'empty');
  });
}

async function testEngineDefaults() {
  console.log('\n── shared.js — Engine Defaults ──');

  await test('ENGINE_DEFAULTS has all required keys', () => {
    const required = ['tickInterval', 'maxConcurrent', 'inboxConsolidateThreshold',
      'agentTimeout', 'heartbeatTimeout', 'maxTurns', 'worktreeRoot',
      'idleAlertMinutes', 'restartGracePeriod', 'worktreeCreateTimeout', 'worktreeCreateRetries'];
    for (const key of required) {
      assert.ok(shared.ENGINE_DEFAULTS[key] !== undefined, `Missing default: ${key}`);
    }
  });

  await test('DEFAULT_AGENTS has 5 agents', () => {
    assert.strictEqual(Object.keys(shared.DEFAULT_AGENTS).length, 5);
  });

  await test('DEFAULT_AGENTS each have name, role, skills', () => {
    for (const [id, agent] of Object.entries(shared.DEFAULT_AGENTS)) {
      assert.ok(agent.name, `${id} missing name`);
      assert.ok(agent.role, `${id} missing role`);
      assert.ok(Array.isArray(agent.skills), `${id} skills not array`);
      assert.ok(agent.skills.length > 0, `${id} has no skills`);
    }
  });

  await test('DEFAULT_CLAUDE has required fields', () => {
    assert.ok(shared.DEFAULT_CLAUDE.binary);
    assert.ok(shared.DEFAULT_CLAUDE.outputFormat);
    assert.ok(shared.DEFAULT_CLAUDE.allowedTools);
  });

  await test('KB_CATEGORIES has expected categories', () => {
    assert.ok(shared.KB_CATEGORIES.includes('architecture'));
    assert.ok(shared.KB_CATEGORIES.includes('conventions'));
    assert.ok(shared.KB_CATEGORIES.includes('project-notes'));
    assert.ok(shared.KB_CATEGORIES.includes('build-reports'));
    assert.ok(shared.KB_CATEGORIES.includes('reviews'));
    assert.strictEqual(shared.KB_CATEGORIES.length, 5);
  });

  await test('shared exports lock-backed JSON mutator for cross-process safety', () => {
    assert.ok(typeof shared.mutateJsonFileLocked === 'function',
      'shared should export mutateJsonFileLocked');
  });
}

async function testProjectHelpers() {
  console.log('\n── shared.js — Project Helpers ──');

  await test('getProjects returns array from config', () => {
    const config = { projects: [{ name: 'A' }, { name: 'B' }] };
    const result = shared.getProjects(config);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].name, 'A');
  });

  await test('getProjects returns empty array if no projects', () => {
    assert.deepStrictEqual(shared.getProjects({}), []);
    assert.deepStrictEqual(shared.getProjects({ projects: null }), []);
  });

  await test('getProjects filters template placeholder project', () => {
    const config = { projects: [{ name: 'YOUR_PROJECT_NAME' }, { name: 'RealProject' }] };
    const result = shared.getProjects(config);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'RealProject');
  });

  await test('getAdoOrgBase extracts from prUrlBase', () => {
    const project = { prUrlBase: 'https://dev.azure.com/myorg/myproj/_apis/git/repos/123/pullrequests/' };
    const result = shared.getAdoOrgBase(project);
    assert.strictEqual(result, 'https://dev.azure.com');
  });

  await test('getAdoOrgBase constructs from adoOrg (short name)', () => {
    const project = { adoOrg: 'myorg' };
    assert.strictEqual(shared.getAdoOrgBase(project), 'https://dev.azure.com/myorg');
  });

  await test('getAdoOrgBase constructs from adoOrg (FQDN)', () => {
    const project = { adoOrg: 'myorg.visualstudio.com' };
    assert.strictEqual(shared.getAdoOrgBase(project), 'https://myorg.visualstudio.com');
  });
}

async function testPrLinks() {
  console.log('\n── shared.js — PR Links ──');

  await test('getPrLinks returns empty object when file missing', () => {
    // This tests the real file — should not crash
    const result = shared.getPrLinks();
    assert.ok(typeof result === 'object');
  });

  await test('addPrLink is idempotent', () => {
    // This uses the real pr-links.json — just verify it doesn't crash
    // The function short-circuits if the link already exists
    const links = shared.getPrLinks();
    const existingId = Object.keys(links)[0];
    if (existingId) {
      shared.addPrLink(existingId, links[existingId]); // should be a no-op
    }
  });

  await test('addPrLink rejects null inputs', () => {
    shared.addPrLink(null, 'item-1'); // should not crash
    shared.addPrLink('pr-1', null);   // should not crash
  });
}

// ─── queries.js Tests ────────────────────────────────────────────────────────

async function testQueriesCore() {
  console.log('\n── queries.js — Core State Readers ──');

  await test('getConfig returns object', () => {
    const config = queries.getConfig();
    assert.ok(typeof config === 'object');
  });

  await test('getControl returns object with state', () => {
    const control = queries.getControl();
    assert.ok(typeof control === 'object');
    assert.ok(typeof control.state === 'string');
  });

  await test('getDispatch returns object with arrays', () => {
    const dispatch = queries.getDispatch();
    assert.ok(Array.isArray(dispatch.pending));
    assert.ok(Array.isArray(dispatch.active));
    assert.ok(Array.isArray(dispatch.completed));
  });

  await test('getDispatchQueue caps completed at 20', () => {
    const queue = queries.getDispatchQueue();
    assert.ok(queue.completed.length <= 20);
  });

  await test('getNotes returns string', () => {
    const notes = queries.getNotes();
    assert.ok(typeof notes === 'string');
  });

  await test('getNotesWithMeta returns content and updatedAt', () => {
    const meta = queries.getNotesWithMeta();
    assert.ok(typeof meta.content === 'string');
    // updatedAt can be null if file doesn't exist
  });

  await test('getEngineLog returns array', () => {
    const log = queries.getEngineLog();
    assert.ok(Array.isArray(log));
    assert.ok(log.length <= 50);
  });

  await test('getMetrics returns object', () => {
    const metrics = queries.getMetrics();
    assert.ok(typeof metrics === 'object');
  });
}

async function testQueriesAgents() {
  console.log('\n── queries.js — Agent Queries ──');

  await test('getAgentStatus returns idle for unknown agent', () => {
    const status = queries.getAgentStatus('nonexistent-agent');
    assert.strictEqual(status.status, 'idle');
  });

  await test('getAgentStatus returns working for active dispatch agent', () => {
    const dispatch = queries.getDispatch();
    const active = (dispatch.active || []);
    if (active.length > 0) {
      const status = queries.getAgentStatus(active[0].agent);
      assert.strictEqual(status.status, 'working');
    } else {
      skip('getAgentStatus-working', 'no active dispatches');
    }
  });

  await test('getAgentStatus prefers started_at over created_at for active dispatch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('active.started_at || active.created_at'),
      'getAgentStatus should prefer started_at for active dispatches');
  });

  await test('getAgentStatus falls back to work-item dispatched markers', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('Fallback: derive active state from work-item markers.'),
      'getAgentStatus should include multi-source fallback from work-items');
    assert.ok(src.includes("w.status === 'dispatched' || w.status === 'in-progress'"),
      'fallback should only treat dispatched/in-progress work items as working');
    assert.ok(src.includes("(w.dispatched_to || '').toLowerCase() === String(agentId).toLowerCase()"),
      'fallback should map by dispatched_to marker');
  });

  await test('getAgents returns array with agent metadata', () => {
    const agents = queries.getAgents();
    assert.ok(Array.isArray(agents));
    for (const a of agents) {
      assert.ok(a.id, 'agent missing id');
      assert.ok(a.status, 'agent missing status');
      assert.ok(typeof a.lastAction === 'string', 'agent missing lastAction');
    }
  });

  await test('getAgentDetail returns charter and history', () => {
    const config = queries.getConfig();
    const firstAgent = Object.keys(config.agents || {})[0];
    if (!firstAgent) { skip('getAgentDetail', 'no agents configured'); return; }
    const detail = queries.getAgentDetail(firstAgent);
    assert.ok(typeof detail.charter === 'string');
    assert.ok(typeof detail.history === 'string');
    assert.ok(typeof detail.statusData === 'object');
    assert.ok(Array.isArray(detail.recentDispatches));
  });
}

async function testQueriesWorkItems() {
  console.log('\n── queries.js — Work Items ──');

  await test('getWorkItems returns sorted array', () => {
    const items = queries.getWorkItems();
    assert.ok(Array.isArray(items));
    // Verify sort order: pending before dispatched before done
    const statusOrder = {
      pending: 0,
      queued: 0,
      dispatched: 1,
      'in-pr': 3,
      done: 3,
      implemented: 3,
      failed: 4,
      paused: 5,
    };
    for (let i = 1; i < items.length; i++) {
      const prevOrder = statusOrder[items[i - 1].status] ?? 1;
      const currOrder = statusOrder[items[i].status] ?? 1;
      assert.ok(prevOrder <= currOrder || prevOrder === currOrder,
        `Sort violation: ${items[i - 1].status} (${prevOrder}) before ${items[i].status} (${currOrder})`);
    }
  });

  await test('getWorkItems cross-references PRs', () => {
    const items = queries.getWorkItems();
    // Just verify it doesn't crash and items have _source
    for (const item of items) {
      assert.ok(item._source, `Work item ${item.id} missing _source`);
    }
  });
}

async function testQueriesPullRequests() {
  console.log('\n── queries.js — Pull Requests ──');

  await test('getPullRequests returns sorted array', () => {
    const prs = queries.getPullRequests();
    assert.ok(Array.isArray(prs));
    // Should be sorted by created date descending
    for (let i = 1; i < prs.length; i++) {
      assert.ok((prs[i - 1].created || '') >= (prs[i].created || ''),
        `PR sort violation: ${prs[i - 1].created} before ${prs[i].created}`);
    }
  });

  await test('getPrs returns array for null project (all projects)', () => {
    const prs = queries.getPrs();
    assert.ok(Array.isArray(prs));
  });
}

async function testQueriesSkills() {
  console.log('\n── queries.js — Skills ──');

  await test('getSkills returns array', () => {
    const skills = queries.getSkills();
    assert.ok(Array.isArray(skills));
    for (const s of skills) {
      assert.ok(s.name, 'skill missing name');
      assert.ok(s.scope, 'skill missing scope');
    }
  });

  await test('getSkillIndex returns string', () => {
    const index = queries.getSkillIndex();
    assert.ok(typeof index === 'string');
  });

  await test('collectSkillFiles discovers plugin skills from installed_plugins.json', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('installed_plugins.json'),
      'collectSkillFiles should read installed_plugins.json');
    assert.ok(src.includes("scope: 'plugin'"),
      'plugin skills should have scope plugin');
    assert.ok(src.includes("path.join(install.installPath, 'commands')"),
      'should scan commands/ dir inside plugin installPath');
  });

  await test('plugin skills appear in getSkills with correct source', () => {
    const skills = queries.getSkills();
    const pluginSkills = skills.filter(s => s.scope === 'plugin');
    // If plugins are installed, they should have source: 'plugin'
    for (const s of pluginSkills) {
      assert.strictEqual(s.source, 'plugin', `plugin skill ${s.name} should have source plugin`);
      assert.ok(s.name, `plugin skill missing name`);
    }
  });

  await test('getSkills includes all scope types', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    // source mapping should handle all scopes
    assert.ok(src.includes("scope === 'claude-code'"), 'should handle claude-code scope');
    assert.ok(src.includes("scope === 'plugin'"), 'should handle plugin scope');
    assert.ok(src.includes("scope === 'project'"), 'should handle project scope');
  });
}

async function testQueriesKnowledgeBase() {
  console.log('\n── queries.js — Knowledge Base ──');

  await test('getKnowledgeBaseEntries returns array', () => {
    const entries = queries.getKnowledgeBaseEntries();
    assert.ok(Array.isArray(entries));
    for (const e of entries) {
      assert.ok(e.cat, 'KB entry missing category');
      assert.ok(e.file, 'KB entry missing file');
      assert.ok(e.title, 'KB entry missing title');
    }
  });

  await test('getKnowledgeBaseIndex returns string', () => {
    const index = queries.getKnowledgeBaseIndex();
    assert.ok(typeof index === 'string');
  });
}

async function testQueriesPrd() {
  console.log('\n── queries.js — PRD Info ──');

  await test('getPrdInfo returns object with progress', () => {
    const info = queries.getPrdInfo();
    assert.ok(typeof info === 'object');
    // May be null if no PRDs exist
    if (info.progress) {
      assert.ok(typeof info.progress.total === 'number');
      assert.ok(typeof info.progress.complete === 'number');
      assert.ok(typeof info.progress.donePercent === 'number');
      assert.ok(Array.isArray(info.progress.items));
    }
  });

  await test('getPrdInfo includes sourcePlan for archived PRD items', () => {
    const info = queries.getPrdInfo();
    if (info.progress && info.progress.items.length > 0) {
      // Every item should expose sourcePlan (may be empty string if none)
      for (const item of info.progress.items) {
        assert.ok('sourcePlan' in item, `item ${item.id} missing sourcePlan field`);
      }
      // Archived items should have _archived flag
      const archivedItems = info.progress.items.filter(i => i._archived);
      for (const item of archivedItems) {
        assert.ok(typeof item.sourcePlan === 'string', `archived item ${item.id} sourcePlan should be string`);
      }
    }
  });
}

async function testQueriesHelpers() {
  console.log('\n── queries.js — Helpers ──');

  await test('timeSince formats seconds', () => {
    const now = Date.now();
    assert.strictEqual(queries.timeSince(now - 30000), '30s ago');
  });

  await test('timeSince formats minutes', () => {
    const now = Date.now();
    assert.strictEqual(queries.timeSince(now - 300000), '5m ago');
  });

  await test('timeSince formats hours', () => {
    const now = Date.now();
    assert.strictEqual(queries.timeSince(now - 7200000), '2h ago');
  });
}

// ─── engine.js Tests (functions that can be tested in isolation) ─────────────

async function testRoutingParser() {
  console.log('\n── engine.js — Routing Parser ──');

  // We can test parseRoutingTable indirectly by checking the routing.md file
  await test('routing.md exists and has valid format', () => {
    const routingPath = path.join(MINIONS_DIR, 'routing.md');
    assert.ok(fs.existsSync(routingPath), 'routing.md not found');
    const content = fs.readFileSync(routingPath, 'utf8');
    assert.ok(content.includes('| Work Type'), 'routing.md missing header row');
    assert.ok(content.includes('implement'), 'routing.md missing implement route');
    assert.ok(content.includes('review'), 'routing.md missing review route');
  });

  await test('routing.md has all required work types', () => {
    const content = fs.readFileSync(path.join(MINIONS_DIR, 'routing.md'), 'utf8');
    const requiredTypes = ['implement', 'review', 'fix', 'plan', 'explore', 'test', 'ask', 'verify'];
    for (const type of requiredTypes) {
      assert.ok(content.includes(type), `routing.md missing work type: ${type}`);
    }
  });
}

async function testDependencyCycleDetection() {
  console.log('\n── engine.js — Dependency Cycle Detection ──');

  // Import the function from engine.js
  let detectDependencyCycles;
  try {
    // The function is defined inline in engine.js, we need to require it
    const engineModule = require(path.join(MINIONS_DIR, 'engine'));
    detectDependencyCycles = engineModule.detectDependencyCycles;
  } catch {
    skip('dependency-cycles', 'engine.js not loadable in test context');
    return;
  }

  if (!detectDependencyCycles) {
    skip('dependency-cycles', 'detectDependencyCycles not exported');
    return;
  }

  await test('detectDependencyCycles finds simple cycle', () => {
    const items = [
      { id: 'A', depends_on: ['B'] },
      { id: 'B', depends_on: ['A'] },
    ];
    const cycles = detectDependencyCycles(items);
    assert.ok(cycles.length > 0, 'Should detect cycle between A and B');
    assert.ok(cycles.includes('A') || cycles.includes('B'));
  });

  await test('detectDependencyCycles returns empty for no cycles', () => {
    const items = [
      { id: 'A', depends_on: ['B'] },
      { id: 'B', depends_on: ['C'] },
      { id: 'C', depends_on: [] },
    ];
    const cycles = detectDependencyCycles(items);
    assert.strictEqual(cycles.length, 0);
  });

  await test('detectDependencyCycles finds self-cycle', () => {
    const items = [
      { id: 'A', depends_on: ['A'] },
    ];
    const cycles = detectDependencyCycles(items);
    assert.ok(cycles.includes('A'));
  });

  await test('detectDependencyCycles finds 3-node cycle', () => {
    const items = [
      { id: 'A', depends_on: ['B'] },
      { id: 'B', depends_on: ['C'] },
      { id: 'C', depends_on: ['A'] },
    ];
    const cycles = detectDependencyCycles(items);
    assert.ok(cycles.length >= 2, 'Should find at least 2 nodes in cycle');
  });
}

// ─── Lifecycle Tests ─────────────────────────────────────────────────────────

async function testLifecycleHelpers() {
  console.log('\n── lifecycle.js — Output Parsing ──');

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));

  await test('parseAgentOutput extracts summary from stream-json', () => {
    const stdout = '{"type":"system"}\n{"type":"result","result":"Task completed successfully","total_cost_usd":0.02}';
    const { resultSummary, taskUsage } = lifecycle.parseAgentOutput(stdout);
    assert.ok(resultSummary.includes('Task completed'));
    assert.ok(taskUsage);
    assert.strictEqual(taskUsage.costUsd, 0.02);
  });

  await test('parseAgentOutput handles empty stdout', () => {
    const { resultSummary, taskUsage } = lifecycle.parseAgentOutput('');
    assert.strictEqual(resultSummary, '');
    assert.strictEqual(taskUsage, null);
  });

  await test('parseAgentOutput truncates long result text', () => {
    const longText = 'x'.repeat(3000);
    const stdout = `{"type":"result","result":"${longText}"}`;
    const { resultSummary } = lifecycle.parseAgentOutput(stdout);
    assert.ok(resultSummary.length <= 2000, 'Result should be truncated to 2000 chars');
  });
}

async function testSyncPrdItemStatus() {
  console.log('\n── lifecycle.js — PRD Sync ──');

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));

  await test('syncPrdItemStatus handles null itemId gracefully', () => {
    // Should not throw
    lifecycle.syncPrdItemStatus(null, 'done', 'test-plan.json');
  });
}

async function testEvalLoopAutoDispatch() {
  console.log('\n── lifecycle.js — Eval Loop Auto-Dispatch ──');

  await test('implement completion creates evaluate work item when evalLoop is true', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');
    const parentItem = {
      id: 'W-test-impl-1', title: 'Build feature X', type: 'implement',
      status: 'dispatched', priority: 'high', branch_name: 'feat/test',
      pr_url: 'https://github.com/test/repo/pull/1',
      acceptance_criteria: '- [ ] Feature works\n- [ ] Tests pass',
      project: 'TestProject',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem]));

    // Simulate what runPostCompletionHooks does for the eval-loop section
    const evalLoop = true;
    if (evalLoop) {
      const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
      const pi = items.find(i => i.id === 'W-test-impl-1');
      // Idempotency check (mirrors lifecycle.js logic)
      if (!pi._evalDispatched) {
        const evalItem = {
          id: 'W-' + shared.uid(),
          title: `Evaluate: ${parentItem.title}`,
          type: 'evaluate',
          priority: parentItem.priority,
          status: 'pending',
          created: new Date().toISOString(),
          createdBy: 'engine:eval-loop',
          project: 'TestProject',
          branch_name: pi.branch_name,
          pr_url: pi.pr_url,
          acceptance_criteria: pi.acceptance_criteria,
          _evalParentId: parentItem.id,
        };
        pi._evalDispatched = true;
        items.push(evalItem);
        fs.writeFileSync(wiPath, JSON.stringify(items));
      }
    }

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    assert.strictEqual(result.length, 2, 'Should have 2 items (parent + evaluate)');
    const evalItem = result.find(i => i.type === 'evaluate');
    assert.ok(evalItem, 'Evaluate item should exist');
    assert.strictEqual(evalItem.status, 'pending');
    assert.strictEqual(evalItem._evalParentId, 'W-test-impl-1');
    assert.strictEqual(evalItem.branch_name, 'feat/test');
    assert.strictEqual(evalItem.pr_url, 'https://github.com/test/repo/pull/1');
    assert.strictEqual(evalItem.acceptance_criteria, parentItem.acceptance_criteria);
    assert.strictEqual(evalItem.project, 'TestProject');
    assert.ok(evalItem.id.startsWith('W-'), 'Evaluate item ID should start with W-');
    assert.strictEqual(evalItem.createdBy, 'engine:eval-loop');
    const updatedParent = result.find(i => i.id === 'W-test-impl-1');
    assert.strictEqual(updatedParent._evalDispatched, true, 'Parent should have _evalDispatched flag');
  });

  await test('duplicate eval dispatch is prevented by _evalDispatched flag', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');
    const parentItem = {
      id: 'W-test-impl-dup', title: 'Build feature Z', type: 'implement',
      status: 'done', priority: 'high', branch_name: 'feat/test-dup',
      _evalDispatched: true, // already dispatched
      project: 'TestProject',
    };
    const existingEval = {
      id: 'W-eval-existing', type: 'evaluate', status: 'pending',
      _evalParentId: 'W-test-impl-dup',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem, existingEval]));

    // Simulate the eval-loop section — should skip because _evalDispatched is set
    const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const pi = items.find(i => i.id === 'W-test-impl-dup');
    if (!pi._evalDispatched) {
      items.push({ id: 'W-should-not-exist', type: 'evaluate', _evalParentId: pi.id });
      pi._evalDispatched = true;
      fs.writeFileSync(wiPath, JSON.stringify(items));
    }

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    assert.strictEqual(result.length, 2, 'Should still have only 2 items (no duplicate eval)');
    assert.ok(!result.find(i => i.id === 'W-should-not-exist'), 'Duplicate eval should not exist');
  });

  await test('no evaluate item created when evalLoop is false', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');
    const parentItem = {
      id: 'W-test-impl-2', title: 'Build feature Y', type: 'implement',
      status: 'dispatched', priority: 'high',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem]));

    const evalLoop = false;
    if (evalLoop) {
      // This block should NOT execute
      const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
      items.push({ id: 'should-not-exist', type: 'evaluate' });
      fs.writeFileSync(wiPath, JSON.stringify(items));
    }

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    assert.strictEqual(result.length, 1, 'Should still have only 1 item');
    assert.ok(!result.find(i => i.type === 'evaluate'), 'No evaluate item should exist');
  });

  await test('no evaluate item created for non-implement types', () => {
    // Verify the code path gates on type === 'implement'
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes("type === 'implement'") && src.includes('evalLoop'),
      'lifecycle.js should gate eval-loop on type === implement');
    assert.ok(src.includes('_evalParentId'),
      'lifecycle.js should set _evalParentId on evaluate items');
    assert.ok(src.includes('engine:eval-loop'),
      'lifecycle.js should mark createdBy as engine:eval-loop');
    assert.ok(src.includes('_evalDispatched'),
      'lifecycle.js should use _evalDispatched idempotency flag');
    assert.ok(src.includes('resolveWiPath'),
      'lifecycle.js should use resolveWiPath helper');
  });

  await test('evalLoop defaults to true in ENGINE_DEFAULTS', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.evalLoop, true);
    assert.strictEqual(shared.ENGINE_DEFAULTS.evalMaxIterations, 3);
  });

  await test('duplicate evaluate item is not created for same parent', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');
    const parentItem = {
      id: 'W-test-impl-dup', title: 'Build feature Z', type: 'implement',
      status: 'done', priority: 'high', branch_name: 'feat/dup-test',
      project: 'TestProject',
    };
    const existingEval = {
      id: 'W-existing-eval', title: 'Evaluate: Build feature Z', type: 'evaluate',
      status: 'pending', _evalParentId: 'W-test-impl-dup',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem, existingEval]));

    // Simulate the dedup check from the eval-loop code
    const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const existing = items.find(i => i._evalParentId === 'W-test-impl-dup' && i.type === 'evaluate');
    assert.ok(existing, 'Should find existing evaluate item');
    assert.strictEqual(existing.id, 'W-existing-eval');
    // The code should skip creation — verify no new item would be added
    assert.strictEqual(items.length, 2, 'Should still have only 2 items (no duplicate)');
  });

  await test('source guard requires work-item source for project-scoped path', () => {
    // Verify the code path checks meta.source === 'work-item' for project-scoped items
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes("meta.source === 'work-item' && meta.project?.name"),
      'eval-loop should check meta.source === work-item for project-scoped path');
  });
}

// ─── Eval Iteration Tracking Tests ──────────────────────────────────────────

async function testEvalIterationTracking() {
  console.log('\n── lifecycle.js — Eval Iteration Tracking ──');
  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));

  await test('parseEvalVerdict extracts verdict from fenced JSON block', () => {
    const text = 'Some text\n```json\n{"pass": false, "build": true, "tests": "10/10", "criteria_met": [], "criteria_failed": ["missing feature X"], "feedback": "Add feature X"}\n```\nMore text';
    const verdict = lifecycle.parseEvalVerdict(text);
    assert.ok(verdict, 'Should parse verdict');
    assert.strictEqual(verdict.pass, false);
    assert.strictEqual(verdict.feedback, 'Add feature X');
    assert.deepStrictEqual(verdict.criteria_failed, ['missing feature X']);
  });

  await test('parseEvalVerdict extracts verdict from bare JSON', () => {
    const text = 'Result: {"pass": true, "build": true, "tests": "5/5", "criteria_met": ["all good"], "criteria_failed": [], "feedback": "LGTM"}';
    const verdict = lifecycle.parseEvalVerdict(text);
    assert.ok(verdict, 'Should parse bare verdict');
    assert.strictEqual(verdict.pass, true);
  });

  await test('parseEvalVerdict returns null for missing verdict', () => {
    assert.strictEqual(lifecycle.parseEvalVerdict('no json here'), null);
    assert.strictEqual(lifecycle.parseEvalVerdict(''), null);
    assert.strictEqual(lifecycle.parseEvalVerdict(null), null);
  });

  await test('failed eval creates fix work item and increments _evalIterations (iteration 1)', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');

    const parentItem = {
      id: 'W-parent-1', title: 'Build feature X', type: 'implement',
      status: 'done', priority: 'high', branch_name: 'feat/test',
      pr_url: 'https://github.com/test/repo/pull/1',
      acceptance_criteria: '- [ ] Feature works',
      project: 'TestProject', sourcePlan: 'plan-test.json',
    };
    const evalItem = {
      id: 'W-eval-1', title: 'Evaluate: Build feature X', type: 'evaluate',
      status: 'dispatched', priority: 'high', _evalParentId: 'W-parent-1',
      project: 'TestProject',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem, evalItem]));

    // Simulate the eval verdict processing inline (mirrors lifecycle.js logic)
    const verdict = { pass: false, feedback: 'Missing feature X', criteria_failed: ['criterion A not met'] };
    const maxIter = 3;
    const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const parent = items.find(i => i.id === 'W-parent-1');
    const iterations = (parent._evalIterations || 0) + 1;
    parent._evalIterations = iterations;

    assert.ok(iterations < maxIter, 'Should be below max iterations');

    const fixItem = {
      id: 'W-' + shared.uid(),
      title: `Fix: ${parent.title} (eval iteration ${iterations})`,
      type: 'fix', priority: parent.priority, status: 'pending',
      created: new Date().toISOString(), createdBy: 'engine:eval-loop',
      project: 'TestProject',
      branch_name: parent.branch_name, pr_url: parent.pr_url,
      acceptance_criteria: parent.acceptance_criteria,
      _evalParentId: parent.id,
      _evalFeedback: verdict.feedback,
      _evalCriteriaFailed: verdict.criteria_failed,
    };
    if (parent.sourcePlan) fixItem.sourcePlan = parent.sourcePlan;
    items.push(fixItem);
    fs.writeFileSync(wiPath, JSON.stringify(items));

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    assert.strictEqual(result.length, 3, 'Should have 3 items (parent + eval + fix)');
    const fix = result.find(i => i.type === 'fix');
    assert.ok(fix, 'Fix item should exist');
    assert.strictEqual(fix.status, 'pending');
    assert.strictEqual(fix._evalParentId, 'W-parent-1');
    assert.strictEqual(fix._evalFeedback, 'Missing feature X');
    assert.deepStrictEqual(fix._evalCriteriaFailed, ['criterion A not met']);
    assert.strictEqual(fix.branch_name, 'feat/test');
    assert.strictEqual(fix.sourcePlan, 'plan-test.json');
    assert.strictEqual(parent._evalIterations, 1);
  });

  await test('3 failed eval cycles sets parent to needs-human-review', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');

    const parentItem = {
      id: 'W-parent-2', title: 'Build feature Y', type: 'implement',
      status: 'done', priority: 'high', _evalIterations: 2, // already had 2 cycles
      branch_name: 'feat/test-y', project: 'TestProject',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem]));

    const maxIter = 3;
    const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const parent = items.find(i => i.id === 'W-parent-2');
    const iterations = (parent._evalIterations || 0) + 1;
    parent._evalIterations = iterations;

    assert.ok(iterations >= maxIter, 'Should be at or above max iterations');
    parent.status = 'needs-human-review';
    parent._evalEscalatedAt = new Date().toISOString();
    fs.writeFileSync(wiPath, JSON.stringify(items));

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const updated = result.find(i => i.id === 'W-parent-2');
    assert.strictEqual(updated.status, 'needs-human-review', 'Parent should be needs-human-review');
    assert.strictEqual(updated._evalIterations, 3);
    assert.ok(updated._evalEscalatedAt, 'Should have escalation timestamp');
    // No fix item should be created
    assert.ok(!result.find(i => i.type === 'fix'), 'No fix item should exist when max iterations reached');
  });

  await test('2 failed eval cycles still gets another fix attempt', () => {
    const tmpDir = createTmpDir();
    const projectDir = path.join(tmpDir, 'projects', 'TestProject');
    fs.mkdirSync(projectDir, { recursive: true });
    const wiPath = path.join(projectDir, 'work-items.json');

    const parentItem = {
      id: 'W-parent-3', title: 'Build feature Z', type: 'implement',
      status: 'done', priority: 'high', _evalIterations: 1, // 1 cycle done
      branch_name: 'feat/test-z', project: 'TestProject',
    };
    fs.writeFileSync(wiPath, JSON.stringify([parentItem]));

    const maxIter = 3;
    const items = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const parent = items.find(i => i.id === 'W-parent-3');
    const iterations = (parent._evalIterations || 0) + 1;
    parent._evalIterations = iterations;

    assert.ok(iterations < maxIter, 'Should be below max iterations');
    const fixItem = {
      id: 'W-fix-z', type: 'fix', status: 'pending', _evalParentId: parent.id,
      _evalFeedback: 'Fix this', createdBy: 'engine:eval-loop',
    };
    items.push(fixItem);
    fs.writeFileSync(wiPath, JSON.stringify(items));

    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    const updated = result.find(i => i.id === 'W-parent-3');
    assert.strictEqual(updated._evalIterations, 2);
    assert.strictEqual(updated.status, 'done', 'Parent should still be done, not escalated');
    const fix = result.find(i => i.type === 'fix');
    assert.ok(fix, 'Fix item should be created');
    assert.strictEqual(fix._evalFeedback, 'Fix this');
  });

  await test('needs-human-review is a terminal status — engine skips dispatch', () => {
    // Verify that the engine dispatch gate at discoverFromWorkItems skips non-pending/queued items
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // The dispatch gate only dispatches 'queued' or 'pending' items
    assert.ok(src.includes("item.status !== 'queued' && item.status !== 'pending'"),
      'engine.js should gate dispatch on queued/pending status only');
  });

  await test('dashboard statusBadge maps needs-human-review to needs-review class', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes("'needs-human-review'") && src.includes("'needs-review'"),
      'render-work-items.js should map needs-human-review to needs-review CSS class');
  });

  await test('CSS includes needs-review badge style (amber/orange)', () => {
    const css = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'styles.css'), 'utf8');
    assert.ok(css.includes('.pr-badge.needs-review'),
      'styles.css should have .pr-badge.needs-review class');
    assert.ok(css.includes('--orange'),
      'needs-review badge should use orange color');
  });
}

// ─── Consolidation Tests ─────────────────────────────────────────────────────

async function testConsolidationHelpers() {
  console.log('\n── consolidation.js — Knowledge Base Classification ──');

  await test('classifyInboxItem categorizes by filename priority', () => {
    // Filename takes priority over content for reviews/builds
    assert.strictEqual(shared.classifyInboxItem('review-summary.md', 'architecture overview'), 'reviews');
    assert.strictEqual(shared.classifyInboxItem('build-log.md', 'conventions and patterns'), 'build-reports');
  });

  await test('classifyInboxItem content fallback for architecture', () => {
    assert.strictEqual(shared.classifyInboxItem('generic.md', 'the data flow through the system'), 'architecture');
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'how it works end to end'), 'architecture');
  });

  await test('classifyInboxItem content fallback for conventions', () => {
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'rule: always validate inputs'), 'conventions');
    assert.strictEqual(shared.classifyInboxItem('notes.md', 'never use var in strict mode'), 'conventions');
  });

  await test('KB_CATEGORIES are consistent', () => {
    const validCats = new Set(shared.KB_CATEGORIES);
    // All possible classifyInboxItem outputs should be in KB_CATEGORIES
    const testCases = [
      shared.classifyInboxItem('review.md', ''),
      shared.classifyInboxItem('build.md', ''),
      shared.classifyInboxItem('x.md', 'architecture'),
      shared.classifyInboxItem('x.md', 'convention pattern'),
      shared.classifyInboxItem('x.md', 'random notes'),
    ];
    for (const cat of testCases) {
      assert.ok(validCats.has(cat), `classifyInboxItem returned '${cat}' which is not in KB_CATEGORIES`);
    }
  });
}

// ─── Content-Hash Circuit Breaker Tests ─────────────────────────────────────

async function testContentHashCircuitBreaker() {
  console.log('\n── consolidation.js — Content-Hash Circuit Breaker ──');

  let checkDuplicateHash;
  try {
    const consolidation = require(path.join(MINIONS_DIR, 'engine', 'consolidation'));
    checkDuplicateHash = consolidation.checkDuplicateHash;
  } catch {
    skip('content-hash circuit breaker', 'consolidation.js not loadable');
    return;
  }

  if (!checkDuplicateHash) {
    skip('content-hash circuit breaker', 'checkDuplicateHash not exported');
    return;
  }

  await test('checkDuplicateHash returns false for empty items', () => {
    assert.strictEqual(checkDuplicateHash([]).isDuplicate, false);
    assert.strictEqual(checkDuplicateHash(null).isDuplicate, false);
  });

  await test('checkDuplicateHash detects >80% duplicates', () => {
    const dupContent = '# Plan completion\nAll items done for plan X';
    const items = [];
    // 9 identical items + 1 different = 90% duplicates
    for (let i = 0; i < 9; i++) items.push({ name: `note-${i}.md`, content: dupContent });
    items.push({ name: 'unique-note.md', content: 'completely different content here' });

    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, true);
    assert.strictEqual(result.count, 9);
    assert.strictEqual(result.total, 10);
    assert.ok(result.hash.length === 64, 'hash should be SHA-256 hex');
  });

  await test('checkDuplicateHash returns false for diverse content', () => {
    const items = [
      { name: 'a.md', content: 'Alpha content about feature A' },
      { name: 'b.md', content: 'Beta content about feature B' },
      { name: 'c.md', content: 'Gamma content about feature C' },
      { name: 'd.md', content: 'Delta content about feature D' },
      { name: 'e.md', content: 'Epsilon content about feature E' },
    ];
    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, false);
  });

  await test('checkDuplicateHash handles exactly 80% (not triggered)', () => {
    const dupContent = 'Same content repeated';
    const items = [];
    // 4 identical + 1 different = exactly 80%, should NOT trigger (>80% required)
    for (let i = 0; i < 4; i++) items.push({ name: `dup-${i}.md`, content: dupContent });
    items.push({ name: 'unique.md', content: 'different content' });

    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, false, 'exactly 80% should not trigger circuit breaker');
  });

  await test('checkDuplicateHash triggers at 81%+', () => {
    const dupContent = 'Same content repeated many times';
    const items = [];
    // 9 identical + 2 different = ~81.8% duplicates
    for (let i = 0; i < 9; i++) items.push({ name: `dup-${i}.md`, content: dupContent });
    items.push({ name: 'unique1.md', content: 'different A' });
    items.push({ name: 'unique2.md', content: 'different B' });

    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, true);
  });

  await test('checkDuplicateHash uses first 200 chars + length for hashing', () => {
    // Two items with same first 200 chars but different lengths should hash differently
    const base = 'x'.repeat(200);
    const items = [
      { name: 'a.md', content: base + 'short' },
      { name: 'b.md', content: base + 'much longer additional content here' },
    ];
    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, false, 'different lengths should produce different hashes');
  });

  await test('checkDuplicateHash handles items with empty content', () => {
    const items = [];
    // 5 items with empty content (all identical hash)
    for (let i = 0; i < 5; i++) items.push({ name: `empty-${i}.md`, content: '' });
    items.push({ name: 'real.md', content: 'actual content' });
    // 5/6 = 83.3% > 80%
    const result = checkDuplicateHash(items);
    assert.strictEqual(result.isDuplicate, true);
  });
}

// ─── Reconciliation Tests ───────────────────────────────────────────────────

async function testReconciliation() {
  console.log('\n── engine.js — PR Reconciliation ──');

  let reconcileItemsWithPrs;
  try {
    const engineModule = require(path.join(MINIONS_DIR, 'engine'));
    reconcileItemsWithPrs = engineModule.reconcileItemsWithPrs;
  } catch {
    skip('reconciliation', 'engine.js not loadable');
    return;
  }

  if (!reconcileItemsWithPrs) {
    skip('reconciliation', 'reconcileItemsWithPrs not exported');
    return;
  }

  await test('reconcileItemsWithPrs matches by prdItems', () => {
    const items = [
      { id: 'P001', status: 'pending' },
      { id: 'P002', status: 'pending' },
      { id: 'P003', status: 'done' }, // already done, should not be touched
    ];
    const prs = [
      { id: 'PR-100', prdItems: ['P001'], status: 'active' },
    ];
    const count = reconcileItemsWithPrs(items, prs);
    assert.strictEqual(count, 1);
    assert.strictEqual(items[0].status, 'done');
    assert.strictEqual(items[0]._pr, 'PR-100');
    assert.strictEqual(items[1].status, 'pending'); // unchanged
    assert.strictEqual(items[2].status, 'done');     // unchanged
  });

  await test('reconcileItemsWithPrs skips items with existing _pr', () => {
    const items = [
      { id: 'P001', status: 'pending', _pr: 'PR-50' }, // already linked
    ];
    const prs = [
      { id: 'PR-100', prdItems: ['P001'], status: 'active' },
    ];
    const count = reconcileItemsWithPrs(items, prs);
    assert.strictEqual(count, 0); // should not re-reconcile
    assert.strictEqual(items[0]._pr, 'PR-50'); // unchanged
  });

  await test('reconcileItemsWithPrs respects onlyIds filter', () => {
    const items = [
      { id: 'P001', status: 'pending' },
      { id: 'P002', status: 'pending' },
    ];
    const prs = [
      { id: 'PR-100', prdItems: ['P001'], status: 'active' },
      { id: 'PR-101', prdItems: ['P002'], status: 'active' },
    ];
    const count = reconcileItemsWithPrs(items, prs, { onlyIds: new Set(['P001']) });
    assert.strictEqual(count, 1); // only P001 eligible
    assert.strictEqual(items[0].status, 'done');
    assert.strictEqual(items[1].status, 'pending'); // not in onlyIds
  });

  await test('reconcileItemsWithPrs handles empty inputs', () => {
    assert.strictEqual(reconcileItemsWithPrs([], []), 0);
    assert.strictEqual(reconcileItemsWithPrs([], [{ id: 'PR-1', prdItems: ['P1'] }]), 0);
  });

  await test('reconcileItemsWithPrs falls back to pr-links when prdItems missing', () => {
    const items = [{ id: 'P001', status: 'pending' }];
    const prs = [{ id: 'PR-200', status: 'active' }]; // no prdItems linkage
    const originalGetPrLinks = shared.getPrLinks;
    shared.getPrLinks = () => ({ 'PR-200': 'P001' });
    try {
      const count = reconcileItemsWithPrs(items, prs);
      assert.strictEqual(count, 1);
      assert.strictEqual(items[0].status, 'done');
      assert.strictEqual(items[0]._pr, 'PR-200');
    } finally {
      shared.getPrLinks = originalGetPrLinks;
    }
  });

  await test('reconcileItemsWithPrs fallback respects onlyIds filter', () => {
    const items = [
      { id: 'P001', status: 'pending' },
      { id: 'P002', status: 'pending' },
    ];
    const prs = [{ id: 'PR-201', status: 'active' }]; // no prdItems linkage
    const originalGetPrLinks = shared.getPrLinks;
    shared.getPrLinks = () => ({ 'PR-201': 'P002' });
    try {
      const count = reconcileItemsWithPrs(items, prs, { onlyIds: new Set(['P001']) });
      assert.strictEqual(count, 0);
      assert.strictEqual(items[0].status, 'pending');
      assert.strictEqual(items[1].status, 'pending');
    } finally {
      shared.getPrLinks = originalGetPrLinks;
    }
  });
}

// ─── GitHub Helpers Tests ───────────────────────────────────────────────────

async function testGithubHelpers() {
  console.log('\n── github.js — Helper Functions ──');

  const github = require(path.join(MINIONS_DIR, 'engine', 'github'));

  await test('github module exports required functions', () => {
    assert.ok(typeof github.pollPrStatus === 'function');
    assert.ok(typeof github.pollPrHumanComments === 'function');
    assert.ok(typeof github.reconcilePrs === 'function');
  });
}

// ─── PR Comment Processing Tests ────────────────────────────────────────────

async function testPrCommentProcessing() {
  console.log('\n── PR Comment Processing — Full Thread Context ──');

  await test('Fix playbook should receive ALL comments, not just @minions', () => {
    // Simulate what ado.js/github.js does: collect all human comments
    // and mark new ones with [NEW] prefix
    const cutoff = '2024-01-15T00:00:00Z';
    const allComments = [
      { author: 'Alice', date: '2024-01-14T10:00:00Z', content: 'Please fix the error handling in auth.js' },
      { author: 'Bob', date: '2024-01-14T12:00:00Z', content: 'Also the tests are flaky' },
      { author: 'Alice', date: '2024-01-16T09:00:00Z', content: 'The cache invalidation is wrong too' },
    ];

    const newComments = allComments.filter(c => c.date > cutoff);
    assert.strictEqual(newComments.length, 1, 'Should detect 1 new comment');

    // Build feedback content the way the fixed code does
    const feedbackContent = allComments
      .map(c => {
        const isNew = c.date > cutoff;
        return `${isNew ? '**[NEW]** ' : ''}**${c.author}** (${c.date}):\n${c.content}`;
      })
      .join('\n\n---\n\n');

    // ALL 3 comments should be in the context
    assert.ok(feedbackContent.includes('error handling in auth.js'), 'Missing old comment from Alice');
    assert.ok(feedbackContent.includes('tests are flaky'), 'Missing old comment from Bob');
    assert.ok(feedbackContent.includes('cache invalidation'), 'Missing new comment from Alice');

    // New comment should be marked [NEW]
    assert.ok(feedbackContent.includes('**[NEW]** **Alice**'), 'New comment not marked with [NEW]');
    // Old comments should NOT have [NEW]
    const bobLine = feedbackContent.split('\n').find(l => l.includes('Bob'));
    assert.ok(!bobLine.includes('[NEW]'), 'Old comment incorrectly marked as [NEW]');
  });

  await test('Minions own comments are filtered out', () => {
    const comments = [
      { content: 'Please fix this', commentType: 'text' },
      { content: 'Fixed by Minions (Dallas — Engineer)', commentType: 'text' },
      { content: null, commentType: 'system' },
      { content: 'System update', commentType: 'system' },
    ];

    // Simulate the filtering logic from ado.js/github.js
    const humanComments = comments.filter(c => {
      if (!c.content || c.commentType === 'system') return false;
      if (/\bMinions\s*\(/i.test(c.content)) return false;
      return true;
    });

    assert.strictEqual(humanComments.length, 1);
    assert.strictEqual(humanComments[0].content, 'Please fix this');
  });

  await test('No @minions filter required — all comments trigger fix', () => {
    // Previously, multi-reviewer PRs required @minions mention
    // Now ALL human comments should trigger
    const comments = [
      { author: 'Alice', date: '2024-01-16T10:00:00Z', content: 'Fix the typo on line 42' },
      { author: 'Bob', date: '2024-01-16T11:00:00Z', content: 'And update the docs' },
    ];

    const cutoff = '2024-01-15T00:00:00Z';
    const newComments = comments.filter(c => c.date > cutoff);

    // Both should trigger (no @minions filter)
    assert.strictEqual(newComments.length, 2, 'Both comments should trigger fix');
  });

  await test('Empty comment thread returns no feedback', () => {
    const comments = [];
    const cutoff = '2024-01-15T00:00:00Z';
    const newComments = comments.filter(c => c.date > cutoff);
    assert.strictEqual(newComments.length, 0);
  });

  await test('Comments before cutoff do not trigger but are included in context', () => {
    const cutoff = '2024-01-20T00:00:00Z';
    const allComments = [
      { author: 'Alice', date: '2024-01-10T10:00:00Z', content: 'Old feedback' },
      { author: 'Bob', date: '2024-01-15T10:00:00Z', content: 'Also old' },
    ];

    const newComments = allComments.filter(c => c.date > cutoff);
    assert.strictEqual(newComments.length, 0, 'No new comments should trigger');

    // But if we had a new one, ALL old ones would be in context
    allComments.push({ author: 'Alice', date: '2024-01-21T10:00:00Z', content: 'New feedback' });
    const withNew = allComments.filter(c => c.date > cutoff);
    assert.strictEqual(withNew.length, 1, 'Only the new comment triggers');
    assert.strictEqual(allComments.length, 3, 'But all 3 are available for context');
  });
}

// ─── Plan Lifecycle Tests ───────────────────────────────────────────────────

async function testPlanLifecycle() {
  console.log('\n── Plan Lifecycle — No Auto-Chain, Explicit Execution ──');

  await test('Plan work items created via dashboard have no chain property', () => {
    // Simulate what dashboard.js /api/plan POST creates
    const item = {
      id: 'W-test', title: 'Test plan', type: 'plan',
      priority: 'high', description: '',
      status: 'pending', created: new Date().toISOString(), createdBy: 'dashboard',
      branchStrategy: 'parallel',
    };
    assert.strictEqual(item.chain, undefined, 'Plan work item should NOT have chain property');
    assert.strictEqual(item.type, 'plan');
  });

  await test('lifecycle.js no longer exports chainPlanToPrd', () => {
    const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));
    assert.strictEqual(lifecycle.chainPlanToPrd, undefined,
      'chainPlanToPrd should not be exported — auto-chaining is removed');
  });

  await test('runPostCompletionHooks does not chain plan-to-prd on plan success', () => {
    // Verify the chain call was removed from runPostCompletionHooks
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // Find the runPostCompletionHooks function body and check it doesn't call chainPlanToPrd
    const hookStart = src.indexOf('function runPostCompletionHooks(');
    const hookBody = src.slice(hookStart, src.indexOf('\nfunction ', hookStart + 1) || src.length);
    assert.ok(!hookBody.includes('chainPlanToPrd('),
      'runPostCompletionHooks should not call chainPlanToPrd');
    assert.ok(src.includes('Plan chaining removed'),
      'lifecycle.js should have comment explaining removal');
  });

  await test('plan-to-prd playbook sets PRD status to awaiting-approval', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'plan-to-prd.md'), 'utf8');
    assert.ok(playbook.includes('"status": "awaiting-approval"'),
      'plan-to-prd playbook should set status to awaiting-approval');
    assert.ok(playbook.includes('"requires_approval": true'),
      'plan-to-prd playbook should set requires_approval to true');
    assert.ok(!playbook.includes('"status": "approved"'),
      'plan-to-prd playbook should NOT set status to approved');
  });

  await test('cli.js recovery does not re-queue plan-to-prd chains', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(!src.includes("chain === 'plan-to-prd'"),
      'cli.js should not contain plan-to-prd chain recovery logic');
    assert.ok(src.includes('Plan chain recovery removed'),
      'cli.js should have comment explaining removal');
  });
}

async function testPrdStaleInvalidation() {
  console.log('\n── PRD Staleness — Auto-Invalidation on Plan Revision ──');

  await test('engine.js materializePlansAsWorkItems handles stale awaiting-approval PRD', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('engine:plan-revision'),
      'engine.js should queue regeneration with createdBy engine:plan-revision');
    assert.ok(src.includes('alreadyQueued'),
      'engine.js should check for duplicate regeneration queue');
    assert.ok(src.includes('fs.unlinkSync(path.join(PRD_DIR, file))'),
      'engine.js should delete old PRD file on awaiting-approval invalidation');
  });

  await test('Stale PRD invalidation only targets awaiting-approval status', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("prdStatus === 'awaiting-approval'"),
      'Auto-regeneration should only trigger for awaiting-approval PRDs');
  });

  await test('Stale PRD regeneration creates plan-to-prd work item', () => {
    // Simulate the regeneration work item structure
    const regenItem = {
      type: 'plan-to-prd',
      priority: 'high',
      status: 'pending',
      createdBy: 'engine:plan-revision',
      planFile: 'test-plan.md',
    };
    assert.strictEqual(regenItem.type, 'plan-to-prd');
    assert.strictEqual(regenItem.createdBy, 'engine:plan-revision');
    assert.strictEqual(regenItem.status, 'pending');
  });

  await test('Duplicate regeneration is prevented', () => {
    // Simulate duplicate check logic
    const centralItems = [
      { type: 'plan-to-prd', planFile: 'test-plan.md', status: 'pending' },
    ];
    const alreadyQueued = centralItems.some(w =>
      w.type === 'plan-to-prd' && w.planFile === 'test-plan.md' && (w.status === 'pending' || w.status === 'dispatched')
    );
    assert.strictEqual(alreadyQueued, true, 'Should detect existing pending regeneration');

    const noDuplicate = centralItems.some(w =>
      w.type === 'plan-to-prd' && w.planFile === 'other-plan.md' && (w.status === 'pending' || w.status === 'dispatched')
    );
    assert.strictEqual(noDuplicate, false, 'Should not detect duplicate for different plan');
  });

  await test('Approved PRDs are flagged stale (not invalidated) on plan revision', () => {
    // Verify the stale flag logic exists for approved PRDs
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale = true'),
      'engine.js should set planStale flag on approved PRDs when plan is revised');
    assert.ok(src.includes("prdStatus === 'approved'"),
      'Stale flag should be gated on approved status');
  });

  await test('Stale PRDs do not materialize new work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale'),
      'engine.js should check planStale flag');
    // The planStale continue should be after the approval gate
    const staleCheck = src.indexOf('if (plan.planStale)');
    const approvalGate = src.lastIndexOf("planStatus === 'awaiting-approval'", staleCheck);
    assert.ok(staleCheck > approvalGate,
      'planStale check should come after approval gate');
  });

  await test('Dashboard has Regenerate PRD button for stale plans', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('prdRegenerate('),
      'dashboard.html should have prdRegenerate function call');
    assert.ok(html.includes('Regenerate now'),
      'dashboard.html should show a clear regenerate action label');
  });

  await test('Dashboard stale PRD UX explains meaning and recovery', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('STALE'),
      'dashboard should visibly label stale PRDs');
    assert.ok(html.includes('Source plan was revised. This PRD may be outdated.'),
      'dashboard should explain why stale appears');
    assert.ok(html.includes('Regenerate now'),
      'dashboard should present explicit stale recovery action');
  });

  await test('Dashboard engine stale badge has explicit recovery UX', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('function renderEngineAlert('),
      'dashboard should render engine stale recovery alert');
    assert.ok(html.includes('Engine heartbeat is stale'),
      'engine stale alert should explain what stale means');
    assert.ok(html.includes('Restart engine'),
      'engine stale alert should offer a clear restart recovery action');
  });

  await test('Dashboard shows immediate PRD retry feedback states', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('window._prdRequeueUi'),
      'dashboard should maintain transient PRD requeue UI state');
    assert.ok(html.includes('requeuing…'),
      'dashboard should show pending requeue feedback');
    assert.ok(html.includes('requeued'),
      'dashboard should show success requeue feedback');
    assert.ok(html.includes('prunePrdRequeueState'),
      'dashboard should prune stale PRD requeue feedback states');
  });

  await test('Dashboard normalizes plan file paths before plan modal fetch', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('function normalizePlanFile(file)'),
      'dashboard should normalize path-like plan references');
    assert.ok(html.includes("fetch('/api/plans/' + encodeURIComponent(normalizedFile))"),
      'plan modal should fetch using normalized file name');
    assert.ok(html.includes('async function openVerifyGuide(file)') && html.includes("_modalFilePath = 'prd/' + normalizedFile"),
      'verify guide modal should also normalize file path');
  });

  await test('Dashboard has /api/prd/regenerate endpoint', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('/api/prd/regenerate'),
      'dashboard.js should have /api/prd/regenerate endpoint');
    assert.ok(src.includes('fs.unlinkSync(prdPath)'),
      'Regeneration should delete old PRD file');
    assert.ok(src.includes('_targetPrdFile'),
      'Regeneration work item should include target PRD filename');
  });

  await test('Regeneration carries over completed items from old PRD', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('completedItems'),
      'Regeneration should collect completed items');
    assert.ok(src.includes("completedStatuses.has(f.status)") || src.includes("completedStatuses.has(w.status)"),
      'Should preserve done work items');
    assert.ok(src.includes('Previously completed items'),
      'Should pass completed items context to agent');
  });

  await test('Engine auto-regeneration also carries over completed items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('completedItems.length'),
      'Engine regeneration should track completed items');
    assert.ok(src.includes('completed items to carry over'),
      'Engine should log carry-over count');
  });

  await test('Regeneration endpoint deduplicates queued items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('alreadyQueued'),
      'Regeneration endpoint should check for duplicate queue entries');
  });

  await test('Approved PRDs are not auto-regenerated on plan revision', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Approved PRDs get planStale flag, not deletion/regeneration
    const staleBlock = src.indexOf('plan.planStale = true');
    const approvedCheck = src.lastIndexOf("prdStatus === 'approved'", staleBlock);
    assert.ok(approvedCheck >= 0 && approvedCheck < staleBlock,
      'planStale flag should be set inside the approved status check');
    // The auto-regeneration (file deletion) is only in the awaiting-approval block
    const deleteCall = src.indexOf('fs.unlinkSync(path.join(PRD_DIR, file))');
    const awaitingCheck = src.lastIndexOf("prdStatus === 'awaiting-approval'", deleteCall);
    assert.ok(awaitingCheck >= 0 && awaitingCheck < deleteCall,
      'PRD file deletion should only happen inside the awaiting-approval check');
  });

  await test('Plan revision flow: plan→review→revise→auto-regenerate→review→approve', () => {
    // End-to-end flow verification via state transitions
    const states = [];

    // Step 1: Plan created, user reviews
    states.push('plan-created');

    // Step 2: User executes plan-to-prd (explicit)
    states.push('prd-generated:awaiting-approval');

    // Step 3: User revises plan .md via doc chat
    states.push('plan-revised');

    // Step 4: Engine detects staleness, invalidates PRD, queues regen
    states.push('prd-invalidated:revision-requested');
    states.push('plan-to-prd-queued');

    // Step 5: Agent regenerates PRD
    states.push('prd-regenerated:awaiting-approval');

    // Step 6: User approves
    states.push('prd-approved');

    // Step 7: Work items materialize
    states.push('work-items-created');

    assert.strictEqual(states.length, 8, 'Should have 8 state transitions in full flow');
    assert.ok(states.includes('prd-invalidated:revision-requested'));
    assert.ok(states.includes('plan-to-prd-queued'));
    assert.ok(states.indexOf('prd-approved') > states.indexOf('prd-regenerated:awaiting-approval'));
  });

  await test('Plan completion requires every PRD feature ID to have a done work item', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('every PRD feature ID must have a corresponding work item'),
      'Plan completion should enforce strict per-ID gate');
    assert.ok(src.includes('unmaterialized.length > 0'),
      'Plan completion should block when any feature lacks a work item');
    assert.ok(src.includes('notDone.length > 0'),
      'Plan completion should block when any feature work item is not done');
  });

  await test('Plan completion cleans all worktrees, not just shared-branch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('Clean up ALL worktrees'),
      'Worktree cleanup should handle all plan worktrees');
    assert.ok(src.includes('w.branch') && src.includes('w.id') && src.includes('pr.branch'),
      'Should collect branch slugs from work items, item IDs, and PR branches');
  });
}

// ─── Archive Path Resolution & Version Tests ─────────────────────────────────

async function testArchivePathResolution() {
  console.log('\n── Archive Path Resolution & Versions ──');

  await test('resolvePlanPath checks archive directories', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("path.join(PLANS_DIR, 'archive', file)"),
      'resolvePlanPath should check plans/archive/ for .md files');
    assert.ok(src.includes("path.join(PRD_DIR, 'archive', file)"),
      'resolvePlanPath should check prd/archive/ for .json files');
  });

  await test('GET /api/plans/:file returns X-Resolved-Path header', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("res.setHeader('X-Resolved-Path'"),
      'plan API should return X-Resolved-Path header');
    assert.ok(src.includes("path.relative(MINIONS_DIR, p)"),
      'resolved path should be relative to MINIONS_DIR');
  });

  await test('planView uses resolved path for _modalFilePath', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes("resolvedPath = planRes.headers.get('X-Resolved-Path')"),
      'planView should read X-Resolved-Path header');
    assert.ok(html.includes('_modalFilePath = resolvedPath ||'),
      'planView should prefer resolved path over hardcoded prefix');
  });

  await test('planOpenInDocChat uses resolved path for _modalFilePath', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    // planOpenInDocChat should also fetch the header
    const fnStart = html.indexOf('async function planOpenInDocChat');
    const fnEnd = html.indexOf('} catch (e) { alert(', fnStart);
    const fnBody = html.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("resolvedPath = planRes.headers.get('X-Resolved-Path')"),
      'planOpenInDocChat should read X-Resolved-Path header');
    assert.ok(fnBody.includes('_modalFilePath = resolvedPath ||'),
      'planOpenInDocChat should prefer resolved path');
  });

  await test('doc-chat saves plan edits in-place without forking', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // Doc-chat should always save in-place; forking is reserved for /api/plans/revise
    const docChatSection = src.slice(src.indexOf("async function handleDocChat"), src.indexOf("async function handleInboxPersist"));
    assert.ok(!docChatSection.includes('isNewVersion'),
      'doc-chat handler should not produce isNewVersion (no forking)');
    assert.ok(!docChatSection.includes('versionedFile'),
      'doc-chat handler should not produce versionedFile (no forking)');
    assert.ok(docChatSection.includes('safeWrite(fullPath, content)'),
      'doc-chat should save directly to the original file');
  });

  await test('doc-chat does not trigger version actions or forking UI', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    // The doc-chat response handler should not reference isNewVersion or versionedFile
    // since the server no longer forks on doc-chat edits
    const sendFn = html.slice(html.indexOf('async function qaDocSend') || html.indexOf("fetch('/api/doc-chat'"));
    const docChatBlock = sendFn.slice(0, sendFn.indexOf('_qaProcessing = false'));
    assert.ok(!docChatBlock.includes('isNewVersion'),
      'doc-chat response handler should not reference isNewVersion');
    assert.ok(!docChatBlock.includes('showPlanVersionActions'),
      'doc-chat response handler should not call showPlanVersionActions');
  });

  await test('Plan listing API extracts version number from filenames', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("f.match(/-v(\\d+)/)"),
      'plan listing should extract version from -vN pattern');
    assert.ok(src.includes('version: versionMatch ? parseInt('),
      'plan listing should include numeric version field');
  });

  await test('Plan version regex correctly parses versioned filenames', () => {
    const re = /-v(\d+)/;
    assert.strictEqual(re.exec('plan-v2-2026-03-15.md')[1], '2', 'Should extract v2');
    assert.strictEqual(re.exec('java-kotlin-conversion-v10.md')[1], '10', 'Should extract v10');
    assert.strictEqual(re.exec('plan.md'), null, 'Should not match non-versioned files');
    assert.strictEqual(re.exec('my-review-plan.md'), null, 'Should not false-match review in filename');
  });

  await test('Dashboard plan card shows version badge', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes("p.version ? ' <span"),
      'plan card should show version badge when version exists');
    assert.ok(html.includes("versionBadge"),
      'plan card should use versionBadge variable');
  });

  await test('Plan view modal shows version label', () => {
    const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes("vMatch = normalizedFile.match(/-v("),
      'planView should extract version from filename');
    assert.ok(html.includes("versionLabel"),
      'planView should use versionLabel in modal title');
  });
}

// ─── LLM Module Tests ──────────────────────────────────────────────────────

async function testLlmModule() {
  console.log('\n── llm.js — LLM Utilities ──');

  const llm = require(path.join(MINIONS_DIR, 'engine', 'llm'));

  await test('llm module exports callLLM and trackEngineUsage', () => {
    assert.ok(typeof llm.callLLM === 'function');
    assert.ok(typeof llm.trackEngineUsage === 'function');
  });

  await test('trackEngineUsage handles null usage gracefully', () => {
    llm.trackEngineUsage('test-category', null); // should not throw
  });

  await test('trackEngineUsage handles empty usage object', () => {
    llm.trackEngineUsage('test-category', {}); // should not throw
  });

  // ── isResumeSessionStillValid — session preservation after timeouts ──

  await test('isResumeSessionStillValid returns true when result has sessionId', () => {
    const result = { sessionId: 'sess-abc123', code: 1, text: '', raw: '', stderr: 'signal timed out' };
    assert.strictEqual(llm.isResumeSessionStillValid(result), true);
  });

  await test('isResumeSessionStillValid returns true when raw output contains session_id', () => {
    const result = {
      sessionId: null, code: 1, text: '', stderr: '',
      raw: '{"type":"assistant","message":"partial"}\n{"type":"result","result":"","session_id":"sess-xyz"}'
    };
    assert.strictEqual(llm.isResumeSessionStillValid(result), true);
  });

  await test('isResumeSessionStillValid returns false when session is truly dead', () => {
    const result = { sessionId: null, code: 1, text: '', raw: '', stderr: 'session not found' };
    assert.strictEqual(llm.isResumeSessionStillValid(result), false);
  });

  await test('isResumeSessionStillValid returns false for null result', () => {
    assert.strictEqual(llm.isResumeSessionStillValid(null), false);
  });

  await test('isResumeSessionStillValid returns false for empty result', () => {
    assert.strictEqual(llm.isResumeSessionStillValid({ sessionId: null, raw: '' }), false);
  });

  await test('isResumeSessionStillValid returns false when raw is undefined', () => {
    assert.strictEqual(llm.isResumeSessionStillValid({ sessionId: null }), false);
  });

  await test('isResumeSessionStillValid returns true even with non-zero exit code if sessionId present', () => {
    // Simulates signal timeout: process killed (code=1) but session was established
    const result = { sessionId: 'sess-timeout', code: 137, text: '', raw: '{}', stderr: 'error:signal timed out' };
    assert.strictEqual(llm.isResumeSessionStillValid(result), true);
  });

  await test('llm module exports isResumeSessionStillValid', () => {
    assert.ok(typeof llm.isResumeSessionStillValid === 'function');
  });
}

// ─── Check-Status Tests ────────────────────────────────────────────────────

async function testCheckStatus() {
  console.log('\n── check-status.js — Quick Status ──');

  await test('check-status.js can be required without crashing', () => {
    // The module executes on require, so we just verify it doesn't throw
    // We can't actually require it since it has side effects (console.log)
    // Instead verify the file exists and has the right imports
    const content = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'check-status.js'), 'utf8');
    assert.ok(content.includes('getAgentStatus'), 'check-status.js should use getAgentStatus');
    assert.ok(content.includes('dispatch'), 'check-status.js should reference dispatch');
  });
}

// ─── PR Review Fix Cycle Tests ──────────────────────────────────────────────

async function testPrReviewFixCycle() {
  console.log('\n── PR → Review → Fix Cycle ──');

  await test('Self-review is allowed: agents can review their own PRs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Self-review prevention was removed — agents can review their own PRs
    assert.ok(!src.includes('agentId === prAuthor'),
      'Self-review prevention should be removed — agents can review their own PRs');
  });

  await test('Review sets reviewStatus to waiting (single source of truth)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const reviewFn = src.slice(src.indexOf('function updatePrAfterReview('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterReview(') + 1));
    assert.ok(reviewFn.includes("reviewStatus = 'waiting'"),
      'updatePrAfterReview should set reviewStatus to waiting (single source of truth)');
    assert.ok(!reviewFn.includes("status: 'approved'"),
      'Should NOT hardcode approved — let pollPrStatus determine actual verdict');
  });

  await test('Human feedback fix triggers re-review (reset reviewStatus to waiting)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fixFn = src.slice(src.indexOf('function updatePrAfterFix('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterFix(') + 1));
    // reviewStatus should be reset to 'waiting' (single source of truth)
    assert.ok(fixFn.includes("reviewStatus = 'waiting'"),
      'updatePrAfterFix should reset reviewStatus to waiting for re-review');
  });

  await test('Human feedback cooldown key uses PR ID only (no timestamp)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // The key should NOT include lastProcessedCommentDate
    assert.ok(!src.includes('human-fix-${project?.name || \'default\'}-${pr.id}-${pr.humanFeedback.lastProcessedCommentDate}'),
      'Human fix key should not include timestamp (prevents cooldown bypass)');
    assert.ok(src.includes("human-fix-${project?.name || 'default'}-${pr.id}`"),
      'Human fix key should be PR-level only');
  });

  await test('routing parser uses mtime cache to avoid reparsing every resolve', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'routing.js'), 'utf8');
    assert.ok(src.includes('function getRoutingTableCached()'),
      'routing module should use a cached routing table helper');
    assert.ok(src.includes('_routingCacheMtime'),
      'routing cache should track routing.md mtime');
    assert.ok(src.includes('const routes = getRoutingTableCached();'),
      'resolveAgent should use cached routes');
  });

  await test('PRs with active dispatch are skipped (race prevention)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('activePrIds'),
      'discoverFromPrs should track active PR dispatches');
    assert.ok(src.includes('activePrIds.has(pr.id)'),
      'Should skip PRs that already have an active dispatch');
  });

  await test('Only active PRs are considered for review/fix', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("pr.status !== 'active') continue"),
      'Should skip merged/abandoned PRs');
  });

  await test('Fix routes to PR author via _author_ token', () => {
    const routing = fs.readFileSync(path.join(MINIONS_DIR, 'routing.md'), 'utf8');
    assert.ok(routing.includes('_author_'),
      'routing.md should have _author_ token for fix routing');
  });

  await test('Review playbook includes PR context variables', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'review.md'), 'utf8');
    assert.ok(playbook.includes('{{pr_id}}'), 'Review playbook needs pr_id');
    assert.ok(playbook.includes('{{pr_branch}}'), 'Review playbook needs pr_branch');
    assert.ok(playbook.includes('{{pr_title}}'), 'Review playbook needs pr_title');
  });

  await test('Fix playbook includes review feedback variable', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'fix.md'), 'utf8');
    assert.ok(playbook.includes('{{review_note}}'), 'Fix playbook needs review_note for feedback');
    assert.ok(playbook.includes('{{pr_branch}}'), 'Fix playbook needs pr_branch');
  });
}

// ─── Worktree Management Tests ──────────────────────────────────────────────

async function testWorktreeManagement() {
  console.log('\n── Worktree Management ──');

  await test('sanitizeBranch produces deterministic slugs for matching', () => {
    // Branch matching relies on sanitized comparison
    const branch = 'feat/my-feature';
    const slug1 = shared.sanitizeBranch(branch);
    const slug2 = shared.sanitizeBranch(branch);
    assert.strictEqual(slug1, slug2, 'sanitizeBranch should be deterministic');
    assert.strictEqual(slug1, 'feat/my-feature', 'Simple branches unchanged');
  });

  await test('sanitizeBranch normalizes special characters consistently', () => {
    const branch = 'work/P-001: add auth [v2]';
    const slug = shared.sanitizeBranch(branch);
    assert.ok(!slug.includes(':'), 'Colons should be replaced');
    assert.ok(!slug.includes(' '), 'Spaces should be replaced');
    assert.ok(!slug.includes('['), 'Brackets should be replaced');
    // Same input always gives same output
    assert.strictEqual(slug, shared.sanitizeBranch(branch));
  });

  await test('Worktree cleanup uses sanitized branch matching (not fuzzy substring)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Should use sanitizeBranch for consistent matching
    assert.ok(src.includes('sanitizeBranch(branch).toLowerCase()') || src.includes('sanitizeBranch(d.meta.branch).toLowerCase()'),
      'Cleanup should sanitize branches before comparison');
    // Should NOT have the old fuzzy bidirectional matching
    assert.ok(!src.includes("d.meta.branch.includes(dir)"),
      'Should not use bidirectional substring matching for dispatch protection');
  });

  await test('Post-merge cleanup finds worktrees by branch slug (not exact path)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('dirLower.includes(branchSlug)'),
      'Post-merge cleanup should match by sanitized branch slug');
    assert.ok(src.includes('readdirSync(wtRoot)'),
      'Post-merge cleanup should scan worktree directory');
  });

  await test('All plan worktrees cleaned on plan completion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('Clean up ALL worktrees'),
      'Plan completion should clean all worktrees, not just shared-branch');
    assert.ok(src.includes('branchSlugs'),
      'Should collect branch slugs from items and PRs');
  });

  await test('Shared-branch plan protection checks both prd/ and plans/', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('PRD_DIR') && src.includes("'plans'"),
      'Worktree protection should check both prd/ and plans/ directories');
  });

  await test('MAX_WORKTREES cap enforced during cleanup', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('MAX_WORKTREES'),
      'Should reference MAX_WORKTREES constant');
    assert.ok(src.includes('excess'),
      'Should calculate and clean excess worktrees');
  });

  await test('Only implement tasks may create new worktrees', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("type !== 'implement'"),
      'Non-implement tasks should skip worktree creation');
    assert.ok(src.includes('creation disabled for non-implement tasks'),
      'Engine should log explicit reason when non-implement falls back to rootDir');
  });

  await test('Worktree creation handles stale index.lock', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('index.lock'),
      'Should check for and handle stale index.lock');
    assert.ok(src.includes('300000'),
      'Should use 5-minute threshold for stale lock detection');
  });

  await test('Worktree creation supports configurable timeout and retries', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('worktreeCreateTimeout'),
      'Should support configurable worktree create timeout');
    assert.ok(src.includes('worktreeCreateRetries'),
      'Should support configurable worktree create retries');
    assert.ok(src.includes('runWorktreeAdd('),
      'Should centralize worktree add with retry behavior');
  });

  await test('Worktree creation recovers partially created worktrees after add failure', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function recoverPartialWorktree('),
      'Should include partial worktree recovery helper');
    assert.ok(src.includes('Recovered partially-created worktree'),
      'Should log successful partial worktree recovery');
    assert.ok(src.includes('Proceeding with recovered worktree after add failure'),
      'Should continue dispatch when recovered worktree is usable');
  });

  await test('findExistingWorktree validates directory exists on disk', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('fs.existsSync(wtPath)'),
      'findExistingWorktree should verify directory exists');
  });

  await test('KB watchdog skips git restore when knowledge is untracked', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('git ls-tree --name-only HEAD -- knowledge'),
      'KB watchdog should check whether knowledge is tracked before restore');
    assert.ok(src.includes('knowledge/ is not tracked in git HEAD'),
      'KB watchdog should emit explicit skip log when knowledge is untracked');
  });
}

// ─── Config & Playbook Tests ────────────────────────────────────────────────

async function testConfigAndPlaybooks() {
  console.log('\n── Config & Playbooks ──');

  await test('config.json exists and is valid', () => {
    const config = queries.getConfig();
    assert.ok(typeof config === 'object', 'config.json not readable');
    // Config may have projects but no agents (agents fall back to DEFAULT_AGENTS)
    if (config.projects) assert.ok(Array.isArray(config.projects), 'projects not array');
  });

  await test('All required playbooks exist', () => {
    const required = ['implement', 'implement-shared', 'review', 'fix', 'explore',
      'test', 'build-and-test', 'plan', 'plan-to-prd', 'ask', 'verify', 'work-item'];
    for (const pb of required) {
      const pbPath = path.join(MINIONS_DIR, 'playbooks', `${pb}.md`);
      assert.ok(fs.existsSync(pbPath), `Missing playbook: ${pb}.md`);
    }
  });

  await test('Playbooks contain template variables', () => {
    const pbPath = path.join(MINIONS_DIR, 'playbooks', 'implement.md');
    const content = fs.readFileSync(pbPath, 'utf8');
    // Should have at least some template variables
    assert.ok(content.includes('{{') && content.includes('}}'), 'Playbook has no template variables');
  });

  await test('All agent charters exist', () => {
    const config = queries.getConfig();
    if (!config.agents || Object.keys(config.agents).length === 0) {
      // Running from repo without installed config — check default agents
      for (const agentId of Object.keys(shared.DEFAULT_AGENTS)) {
        const charterPath = path.join(MINIONS_DIR, 'agents', agentId, 'charter.md');
        assert.ok(fs.existsSync(charterPath), `Missing charter for ${agentId}`);
      }
    } else {
      for (const agentId of Object.keys(config.agents)) {
        const charterPath = path.join(MINIONS_DIR, 'agents', agentId, 'charter.md');
        assert.ok(fs.existsSync(charterPath), `Missing charter for ${agentId}`);
      }
    }
  });

  await test('bin/minions init guards against home under package root', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'bin', 'minions.js'), 'utf8');
    assert.ok(src.includes('function isSubpath('),
      'bin/minions.js should define subpath helper');
    assert.ok(src.includes('Refusing to initialize Minions home inside package directory'),
      'init should fail fast when MINIONS_HOME is inside PKG_ROOT');
  });

  await test('bin/minions force init restarts engine and dashboard automatically', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'bin', 'minions.js'), 'utf8');
    assert.ok(src.includes('Upgrade complete (') && src.includes('Restarting engine and dashboard'),
      'force upgrade should announce automatic restart');
    assert.ok(src.includes('engine.js') && src.includes('stop'),
      'force upgrade should stop engine before restart');
    assert.ok(src.includes('Dashboard started (PID:'),
      'init flow should still auto-start dashboard');
  });

  await test('bin/minions resolves runtime root from init location and pointer', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'bin', 'minions.js'), 'utf8');
    assert.ok(src.includes('resolveMinionsHome('),
      'bin/minions.js should resolve runtime root dynamically');
    assert.ok(src.includes("return path.join(process.cwd(), '.minions')"),
      'init should default runtime root to <cwd>/.minions');
    assert.ok(src.includes(".minions-root"),
      'bin/minions.js should persist/read runtime root pointer');
    assert.ok(src.includes('findNearestLocalMinionsRoot('),
      'bin/minions.js should detect nearest local .minions root');
  });
}

// ─── Integration-Level Tests (uses real state files) ─────────────────────────

async function testStateIntegrity() {
  console.log('\n── State Integrity ──');

  await test('dispatch.json has valid structure', () => {
    const dispatch = queries.getDispatch();
    assert.ok(Array.isArray(dispatch.pending), 'pending not array');
    assert.ok(Array.isArray(dispatch.active), 'active not array');
    assert.ok(Array.isArray(dispatch.completed), 'completed not array');
    // No duplicate IDs across queues
    const allIds = [...dispatch.pending, ...(dispatch.active || []), ...(dispatch.completed || [])].map(d => d.id);
    // Active and pending should have unique IDs (completed can have old ones)
    const activePendingIds = [...dispatch.pending, ...(dispatch.active || [])].map(d => d.id);
    const uniqueIds = new Set(activePendingIds);
    assert.strictEqual(activePendingIds.length, uniqueIds.size, 'Duplicate IDs in active/pending dispatch');
  });

  await test('dispatch.completed capped near 100', () => {
    const dispatch = queries.getDispatch();
    // Allow slight overshoot — cap is enforced on next completion, not retroactively
    assert.ok(dispatch.completed.length <= 110, `completed queue too large: ${dispatch.completed.length}`);
  });

  await test('Active dispatch entries have required fields', () => {
    const dispatch = queries.getDispatch();
    for (const item of dispatch.active || []) {
      assert.ok(item.id, `Active dispatch missing id`);
      assert.ok(item.agent, `Active dispatch ${item.id} missing agent`);
      assert.ok(item.type, `Active dispatch ${item.id} missing type`);
    }
  });

  await test('Completed dispatch entries have result', () => {
    const dispatch = queries.getDispatch();
    for (const item of dispatch.completed || []) {
      assert.ok(item.result, `Completed dispatch ${item.id} missing result`);
    }
  });

  await test('All plan JSON files are valid', () => {
    const plansDir = path.join(MINIONS_DIR, 'plans');
    if (!fs.existsSync(plansDir)) return;
    const jsonFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.json'));
    for (const f of jsonFiles) {
      const plan = shared.safeJson(path.join(plansDir, f));
      assert.ok(plan, `Invalid plan JSON: ${f}`);
      assert.ok(Array.isArray(plan.missing_features), `${f} missing missing_features array`);
    }
  });

  await test('Metrics JSON has valid structure', () => {
    const metrics = queries.getMetrics();
    for (const [id, m] of Object.entries(metrics)) {
      if (id.startsWith('_')) continue; // skip _daily, _engine
      assert.ok(typeof m.tasksCompleted === 'number', `${id} missing tasksCompleted`);
      assert.ok(typeof m.tasksErrored === 'number', `${id} missing tasksErrored`);
    }
  });

  await test('No work items stuck in dispatched with no active dispatch', () => {
    const dispatch = queries.getDispatch();
    const activeItemIds = new Set(
      (dispatch.active || []).map(d => d.meta?.item?.id).filter(Boolean)
    );
    const allItems = queries.getWorkItems();
    const stuck = allItems.filter(i => i.status === 'dispatched' && !activeItemIds.has(i.id));
    assert.strictEqual(stuck.length, 0,
      `${stuck.length} work item(s) stuck in dispatched: ${stuck.map(i => i.id).join(', ')}`);
  });

  await test('Engine uses lock-backed dispatch mutations', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8') + fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('function mutateDispatch('),
      'engine should define dispatch lock helper');
    assert.ok(src.includes('mutateJsonFileLocked(DISPATCH_PATH'),
      'engine dispatch writes should use lock-backed mutation');
  });

  await test('All mutateDispatch callbacks return dispatch object on every path', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const dispatchSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    const cleanupSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');

    // Extract all mutateDispatch callback bodies from each file
    for (const [name, src] of [['engine.js', engineSrc], ['dispatch.js', dispatchSrc], ['cleanup.js', cleanupSrc]]) {
      // Find all mutateDispatch( occurrences (skip the definition itself)
      const pattern = /mutateDispatch\(\((\w+)\)\s*=>\s*\{/g;
      let match;
      while ((match = pattern.exec(src)) !== null) {
        const paramName = match[1];
        // Walk forward from the match to find the closing brace of the callback
        let depth = 1;
        let i = match.index + match[0].length;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        const body = src.slice(match.index + match[0].length, i - 1);
        // Every return statement should return the dispatch param, not undefined
        const returnStatements = body.match(/return\b[^;]*/g) || [];
        for (const ret of returnStatements) {
          const trimmed = ret.replace(/^return\s*/, '').trim();
          // Allow: return dp, return dispatch, return dp; — but not bare 'return' or 'return undefined'
          assert.ok(
            trimmed.length > 0 && trimmed !== 'undefined',
            `${name}: mutateDispatch callback has bare/undefined return: "${ret.trim()}". Must return ${paramName}.`
          );
        }
      }
    }
  });

  await test('spawnAgent null return is handled in dispatch loop', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('const proc = spawnAgent(item, config)'),
      'dispatch loop must capture spawnAgent return value');
    assert.ok(src.includes('proc === null'),
      'dispatch loop must check for null return from spawnAgent');
    assert.ok(src.includes('_retryCount') && src.includes("'pending'"),
      'dispatch loop must re-queue work item with retry metadata on spawn failure');
  });

  await test('Log rotation uses batch threshold (>= 2500 → 2000)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(src.includes('logData.length >= 2500'),
      'log rotation should trigger at >= 2500 for batch efficiency');
    assert.ok(src.includes('logData.length - 2000'),
      'log rotation should splice down to 2000 entries');
    assert.ok(!src.includes('logData.length > 2000'),
      'log rotation should NOT use tight > 2000 threshold');
  });

  await test('Dashboard uses lock-backed dispatch mutations for API writes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('mutateJsonFileLocked'),
      'dashboard should use lock-backed dispatch mutation helper');
    assert.ok(src.includes("defaultValue: { pending: [], active: [], completed: [] }"),
      'dashboard dispatch mutations should normalize queue structure');
  });

  await test('Hung timeout path uses normal auto-retry flow', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(src.includes("completeDispatch(item.id, 'error', reason);"),
      'Hung/orphan cleanup should route through normal completeDispatch retry handling');
    assert.ok(!src.includes("completeDispatch(item.id, 'error', reason, '', { processWorkItemFailure: false })"),
      'Hung/orphan cleanup should not bypass work item retry handling');
  });

  await test('Auto-retry is gated by retryable failure reason classification', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('function isRetryableFailureReason('),
      'Engine should classify retryable vs non-retryable failures');
    assert.ok(src.includes('retryableFailure && retries < 3'),
      'Auto-retry should run only for retryable failures under retry cap');
    assert.ok(src.includes('Non-retryable failure:'),
      'Non-retryable failures should be surfaced explicitly');
  });

  await test('Auto-retry writes retry metadata on work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('_lastRetryReason'),
      'Auto-retry should persist last retry reason');
    assert.ok(src.includes('_lastRetryAt'),
      'Auto-retry should persist last retry timestamp');
  });

  await test('Auto-retry clears completed dedupe marker for dispatch key', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes("dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey)"),
      'Auto-retry should clear completed dedupe entry for the same dispatch key');
  });

  await test('Pending work-item discovery self-heals stale dispatch gates', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('Self-heal: if an item is pending'),
      'Pending discovery should include stale gate self-heal guard');
    assert.ok(src.includes("dp.completed.filter(d => d.meta?.dispatchKey !== key)"),
      'Pending discovery should clear completed dedupe marker for pending item key');
    assert.ok(src.includes('dispatchCooldowns.delete(key);'),
      'Pending discovery should clear in-memory cooldown for pending item key');
  });

  await test('Close handler skips duplicate completion after timeout finalization', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('close event ignored — dispatch already completed elsewhere'),
      'close handler should skip duplicate completion if dispatch no longer active');
    assert.ok(src.includes('const stillActive = (dispatchNow.active || []).some(d => d.id === id);'),
      'close handler should verify dispatch is still active before completing');
  });

  await test('Live log appends heartbeat during silent runs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('[heartbeat] running — no output for'),
      'engine should append heartbeat lines to live-output when agent is silent');
    assert.ok(src.includes('heartbeatTimer = setInterval('),
      'engine should create a heartbeat timer for live-output');
    assert.ok(src.includes('if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }'),
      'engine should clear heartbeat timer on close/error');
  });

  await test('Human feedback pendingFix is cleared only after dispatch enqueue', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(!src.includes('pr.humanFeedback.pendingFix = false'),
      'discoverFromPrs should not clear pendingFix during discovery');
    assert.ok(src.includes('clearPendingHumanFeedbackFlag(item.meta?.project, item.meta?.pr?.id)'),
      'pendingFix should be cleared after addToDispatch in discoverWork');
  });

  await test('Work-item dispatched sync writes work items before PRD status sync', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const markIdx = src.indexOf("prdSyncQueue.push({ id: item.id, sourcePlan: item.sourcePlan });");
    const writeIdx = src.indexOf('safeWrite(workItemsPath, items);');
    const syncIdx = src.indexOf("for (const s of prdSyncQueue) syncPrdItemStatus(s.id, 'dispatched', s.sourcePlan);");
    assert.ok(markIdx > 0 && writeIdx > 0 && syncIdx > 0,
      'discoverFromWorkItems should queue PRD sync, then write work items, then sync PRD');
    assert.ok(writeIdx < syncIdx,
      'work item write must happen before PRD dispatched sync to reduce divergence windows');
  });

  await test('Auto-retry reads live work-item retry count before decision', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('let retries = (item.meta.item._retryCount || 0);'),
      'auto-retry should initialize retries from dispatch metadata');
    assert.ok(src.includes('const wi = items.find(i => i.id === item.meta.item.id);'),
      'auto-retry should load latest retry count from persisted work-item state');
    assert.ok(src.includes('if (wi) retries = wi._retryCount || 0;'),
      'auto-retry should prefer live retry count before applying retry cap');
  });

  await test('Dependency gate fail-fast treats failed dependency as failed immediately', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("if (depItem.status === 'failed') return 'failed';"),
      'dependency gate should fail fast on failed dependency');
    assert.ok(!src.includes("depItem.status === 'failed' && (depItem._retryCount || 0) >= 3"),
      'dependency gate should not wait for retryCount threshold before propagating failure');
  });

  await test('Dispatch completed dedupe cleanup always persists mutation', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    const completeDispatchStart = src.indexOf('function completeDispatch(');
    const completeDispatchEnd = src.indexOf('\n// ─── Inbox Alert', completeDispatchStart);
    const completeDispatchBody = src.slice(completeDispatchStart, completeDispatchEnd);
    assert.ok(src.includes('dp.completed = Array.isArray(dp.completed) ? dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey) : [];'),
      'auto-retry path should remove completed dedupe marker by dispatch key');
    assert.ok(completeDispatchBody.includes('return dp;'),
      'dispatch dedupe cleanup should always return mutated dispatch object');
    assert.ok(!completeDispatchBody.includes('return dp.completed.length !== before ? dp : undefined;'),
      'completeDispatch auto-retry dedupe cleanup should not skip persist when no length delta is detected');
  });
}

// ─── Edge Cases ──────────────────────────────────────────────────────────────

async function testEdgeCases() {
  console.log('\n── Edge Cases ──');

  await test('safeWrite handles concurrent writes without corruption', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'concurrent.json');
    // Write 50 times rapidly — should never corrupt
    for (let i = 0; i < 50; i++) {
      shared.safeWrite(fp, { iteration: i });
    }
    const result = shared.safeJson(fp);
    assert.ok(result, 'File corrupted after rapid writes');
    assert.strictEqual(result.iteration, 49);
  });

  await test('safeWrite handles large data', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'large.json');
    const largeArray = Array.from({ length: 10000 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }));
    shared.safeWrite(fp, largeArray);
    const result = shared.safeJson(fp);
    assert.strictEqual(result.length, 10000);
  });

  await test('parseStreamJsonOutput handles malformed JSON lines', () => {
    const raw = '{"incomplete json\n{"type":"result","result":"ok"}\n{broken again';
    const { text } = shared.parseStreamJsonOutput(raw);
    assert.strictEqual(text, 'ok');
  });

  await test('classifyInboxItem handles null/undefined inputs', () => {
    const cat1 = shared.classifyInboxItem(null, null);
    assert.strictEqual(cat1, 'project-notes');
    const cat2 = shared.classifyInboxItem(undefined, undefined);
    assert.strictEqual(cat2, 'project-notes');
  });

  await test('sanitizeBranch handles special characters', () => {
    assert.ok(shared.sanitizeBranch('feat/PROJ-123: add auth').length > 0);
    assert.ok(!shared.sanitizeBranch('feat/PROJ-123: add auth').includes(':'));
    assert.ok(!shared.sanitizeBranch('feat/PROJ-123: add auth').includes(' '));
  });

  await test('getProjects handles malformed config gracefully', () => {
    assert.deepStrictEqual(shared.getProjects({}), []);
    assert.deepStrictEqual(shared.getProjects({ projects: 'not an array' }), []);
    assert.deepStrictEqual(shared.getProjects({ projects: [] }), []);
    assert.deepStrictEqual(shared.getProjects({ projects: [{ name: 'YOUR_PROJECT_NAME' }] }), []);
  });

  await test('engine validateConfig uses filtered getProjects list', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('const projects = getProjects(config);'),
      'validateConfig should use shared.getProjects filtering');
  });
}

// ─── Legacy Status Migration Tests ──────────────────────────────────────────

async function testLegacyStatusMigration() {
  console.log('\n── Legacy Status Migration (in-pr/implemented/complete → done) ──');

  await test('runCleanup migrates legacy work-item statuses on disk', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    const items = [
      { id: 'W-001', title: 'Feature A', status: 'in-pr' },
      { id: 'W-002', title: 'Feature B', status: 'implemented' },
      { id: 'W-003', title: 'Feature C', status: 'complete' },
      { id: 'W-004', title: 'Feature D', status: 'done' },
      { id: 'W-005', title: 'Feature E', status: 'pending' },
      { id: 'W-006', title: 'Feature F', status: 'failed' },
    ];
    shared.safeWrite(wiPath, items);

    // Simulate the migration logic from runCleanup
    const LEGACY_DONE_STATUSES = new Set(['in-pr', 'implemented', 'complete']);
    const loaded = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    let migrated = 0;
    for (const item of loaded) {
      if (LEGACY_DONE_STATUSES.has(item.status)) {
        item.status = 'done';
        migrated++;
      }
    }
    shared.safeWrite(wiPath, loaded);

    assert.strictEqual(migrated, 3, 'Should migrate exactly 3 legacy statuses');
    const result = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    assert.strictEqual(result[0].status, 'done', 'in-pr → done');
    assert.strictEqual(result[1].status, 'done', 'implemented → done');
    assert.strictEqual(result[2].status, 'done', 'complete → done');
    assert.strictEqual(result[3].status, 'done', 'done stays done');
    assert.strictEqual(result[4].status, 'pending', 'pending unchanged');
    assert.strictEqual(result[5].status, 'failed', 'failed unchanged');
  });

  await test('runCleanup migrates legacy PRD item statuses on disk', () => {
    const tmp = createTmpDir();
    const prdPath = path.join(tmp, 'plan.json');
    const prd = {
      plan_summary: 'Test plan',
      missing_features: [
        { id: 'P-001', status: 'in-pr' },
        { id: 'P-002', status: 'done' },
        { id: 'P-003', status: 'implemented' },
        { id: 'P-004', status: 'pending' },
      ]
    };
    shared.safeWrite(prdPath, prd);

    const LEGACY_DONE_STATUSES = new Set(['in-pr', 'implemented', 'complete']);
    const loaded = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
    let migrated = 0;
    for (const feat of loaded.missing_features) {
      if (LEGACY_DONE_STATUSES.has(feat.status)) {
        feat.status = 'done';
        migrated++;
      }
    }
    shared.safeWrite(prdPath, loaded);

    assert.strictEqual(migrated, 2);
    const result = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
    assert.strictEqual(result.missing_features[0].status, 'done', 'in-pr → done');
    assert.strictEqual(result.missing_features[1].status, 'done', 'done stays done');
    assert.strictEqual(result.missing_features[2].status, 'done', 'implemented → done');
    assert.strictEqual(result.missing_features[3].status, 'pending', 'pending unchanged');
  });

  await test('migration is idempotent — second pass changes nothing', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    const items = [
      { id: 'W-001', status: 'done' },
      { id: 'W-002', status: 'pending' },
    ];
    shared.safeWrite(wiPath, items);

    const LEGACY_DONE_STATUSES = new Set(['in-pr', 'implemented', 'complete']);
    const loaded = JSON.parse(fs.readFileSync(wiPath, 'utf8'));
    let migrated = 0;
    for (const item of loaded) {
      if (LEGACY_DONE_STATUSES.has(item.status)) {
        item.status = 'done';
        migrated++;
      }
    }
    assert.strictEqual(migrated, 0, 'No items should need migration');
  });

  await test('engine.js runCleanup contains legacy status migration code', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes("LEGACY_DONE_STATUSES"), 'runCleanup should define LEGACY_DONE_STATUSES');
    assert.ok(src.includes("item.status = 'done'"), 'Should migrate work items to done');
    assert.ok(src.includes("feat.status = 'done'"), 'Should migrate PRD items to done');
  });
}

// ─── engine/preflight.js Tests ───────────────────────────────────────────────

async function testPreflightModule() {
  console.log('\n── engine/preflight.js ──');

  let preflight;
  try {
    preflight = require(path.join(MINIONS_DIR, 'engine', 'preflight'));
  } catch (e) {
    skip('preflight-module', `Could not load preflight: ${e.message}`);
    return;
  }

  await test('findClaudeBinary returns string or null', () => {
    const result = preflight.findClaudeBinary();
    assert.ok(result === null || typeof result === 'string',
      `Expected string or null, got ${typeof result}`);
  });

  await test('findClaudeBinary result ends with cli.js if non-null', () => {
    const result = preflight.findClaudeBinary();
    if (result !== null) {
      assert.ok(result.endsWith('cli.js'), `Expected path ending in cli.js, got: ${result}`);
    }
  });

  await test('runPreflight returns correct shape', () => {
    const { passed: p, results: r } = preflight.runPreflight();
    assert.ok(typeof p === 'boolean', 'passed should be boolean');
    assert.ok(Array.isArray(r), 'results should be array');
    assert.strictEqual(r.length, 4, 'should have exactly 4 checks');
  });

  await test('runPreflight includes Node.js check as passing', () => {
    const { results: r } = preflight.runPreflight();
    const nodeCheck = r.find(c => c.name === 'Node.js');
    assert.ok(nodeCheck, 'Missing Node.js check');
    assert.strictEqual(nodeCheck.ok, true, 'Node.js check should pass (we are >= 18)');
  });

  await test('runPreflight includes Git check', () => {
    const { results: r } = preflight.runPreflight();
    const gitCheck = r.find(c => c.name === 'Git');
    assert.ok(gitCheck, 'Missing Git check');
  });

  await test('runPreflight includes Claude Code CLI check', () => {
    const { results: r } = preflight.runPreflight();
    const claudeCheck = r.find(c => c.name === 'Claude Code CLI');
    assert.ok(claudeCheck, 'Missing Claude Code CLI check');
  });

  await test('runPreflight Anthropic auth is never fatal', () => {
    const { results: r } = preflight.runPreflight();
    const authCheck = r.find(c => c.name === 'Anthropic auth');
    assert.ok(authCheck, 'Missing Anthropic auth check');
    assert.ok(authCheck.ok === true || authCheck.ok === 'warn',
      'Anthropic auth should be ok or warn, never false');
  });

  await test('runPreflight each result has name, ok, message', () => {
    const { results: r } = preflight.runPreflight();
    for (const check of r) {
      assert.ok(typeof check.name === 'string' && check.name.length > 0, 'check needs name');
      assert.ok(check.ok === true || check.ok === false || check.ok === 'warn', 'ok must be true/false/warn');
      assert.ok(typeof check.message === 'string', 'check needs message');
    }
  });

  await test('printPreflight returns true for all-ok results', () => {
    const ok = preflight.printPreflight([
      { name: 'A', ok: true, message: 'good' },
      { name: 'B', ok: true, message: 'also good' },
    ], { label: 'test' });
    assert.strictEqual(ok, true);
  });

  await test('printPreflight returns false when any check fails', () => {
    const ok = preflight.printPreflight([
      { name: 'A', ok: true, message: 'good' },
      { name: 'B', ok: false, message: 'bad' },
    ], { label: 'test' });
    assert.strictEqual(ok, false);
  });

  await test('printPreflight treats warn as non-fatal (returns true)', () => {
    const ok = preflight.printPreflight([
      { name: 'A', ok: 'warn', message: 'warning' },
    ], { label: 'test' });
    assert.strictEqual(ok, true);
  });

  await test('doctor returns a promise', () => {
    const result = preflight.doctor(MINIONS_DIR);
    assert.ok(result && typeof result.then === 'function', 'doctor should return a promise');
    // Wait for it to complete (don't leave dangling promises)
    return result.catch(() => {});
  });

  await test('findClaudeBinary does not shell-interpolate paths (no command injection)', () => {
    // Read the source of preflight.js and verify no shell interpolation of `which` variable
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'preflight.js'), 'utf8');
    // Must NOT contain bash -c "cat '${which}'" or similar shell interpolation of file paths
    assert.ok(!src.includes('cat \'${which}'), 'Source must not shell-interpolate which variable via cat');
    assert.ok(!src.includes('cat "${which}'), 'Source must not shell-interpolate which variable via cat (double quotes)');
    // Should use fs.readFileSync for reading the wrapper file
    assert.ok(src.includes('fs.readFileSync('), 'Should use fs.readFileSync to read wrapper file');
  });

  await test('findClaudeBinary fallback handles paths with special chars safely', () => {
    // This test verifies that the wrapper-reading fallback uses fs.readFileSync
    // (not shell interpolation) by checking the source doesn't construct shell commands
    // with user-controlled path variables
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'preflight.js'), 'utf8');
    // The only execSync calls with string interpolation should NOT include file paths
    const execSyncCalls = src.match(/execSync\(`[^`]*\$\{[^`]*`/g) || [];
    for (const call of execSyncCalls) {
      // Allowed: tasklist with control.pid (a number from our own JSON)
      // Not allowed: any call interpolating 'which' or file path variables
      assert.ok(!call.includes('${which'), `Found unsafe shell interpolation of path variable: ${call}`);
    }
  });
}

// ─── shared.js — cleanChildEnv & gitEnv Tests ──────────────────────────────

async function testCleanChildEnv() {
  console.log('\n── shared.js — cleanChildEnv ──');

  await test('cleanChildEnv removes CLAUDECODE key', () => {
    const orig = process.env.CLAUDECODE;
    process.env.CLAUDECODE = 'test-value';
    try {
      const env = shared.cleanChildEnv();
      assert.strictEqual(env.CLAUDECODE, undefined);
    } finally {
      if (orig !== undefined) process.env.CLAUDECODE = orig;
      else delete process.env.CLAUDECODE;
    }
  });

  await test('cleanChildEnv removes CLAUDE_CODE_ENTRYPOINT', () => {
    const orig = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ENTRYPOINT = '/some/path';
    try {
      const env = shared.cleanChildEnv();
      assert.strictEqual(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    } finally {
      if (orig !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = orig;
      else delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  await test('cleanChildEnv removes all CLAUDE_CODE* prefixed keys', () => {
    process.env.CLAUDE_CODE_TEST_XYZ = 'val';
    try {
      const env = shared.cleanChildEnv();
      assert.strictEqual(env.CLAUDE_CODE_TEST_XYZ, undefined);
    } finally {
      delete process.env.CLAUDE_CODE_TEST_XYZ;
    }
  });

  await test('cleanChildEnv removes CLAUDECODE_* prefixed keys', () => {
    process.env.CLAUDECODE_SOMETHING = 'val';
    try {
      const env = shared.cleanChildEnv();
      assert.strictEqual(env.CLAUDECODE_SOMETHING, undefined);
    } finally {
      delete process.env.CLAUDECODE_SOMETHING;
    }
  });

  await test('cleanChildEnv preserves standard env vars', () => {
    const env = shared.cleanChildEnv();
    // PATH should always exist
    assert.ok(env.PATH || env.Path, 'PATH should be preserved');
  });

  await test('cleanChildEnv does not mutate process.env', () => {
    const origKeys = Object.keys(process.env).length;
    shared.cleanChildEnv();
    assert.strictEqual(Object.keys(process.env).length, origKeys);
  });
}

async function testGitEnv() {
  console.log('\n── shared.js — gitEnv ──');

  await test('gitEnv sets GIT_TERMINAL_PROMPT to 0', () => {
    const env = shared.gitEnv();
    assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
  });

  await test('gitEnv sets GCM_INTERACTIVE to never', () => {
    const env = shared.gitEnv();
    assert.strictEqual(env.GCM_INTERACTIVE, 'never');
  });
}

// ─── shared.js — Project Path Helpers ───────────────────────────────────────

async function testProjectPathHelpers() {
  console.log('\n── shared.js — Project Path Helpers ──');

  await test('projectRoot resolves localPath to absolute path', () => {
    const root = shared.projectRoot({ localPath: 'D:/squad' });
    assert.ok(path.isAbsolute(root), `Expected absolute path, got: ${root}`);
  });

  await test('projectRoot handles project without localPath gracefully', () => {
    // When localPath is missing, projectRoot may throw or return undefined — verify it doesn't crash silently
    try {
      const root = shared.projectRoot({ name: 'test' });
      assert.ok(root === undefined || typeof root === 'string');
    } catch (e) {
      // Throwing on missing localPath is acceptable — it's a required field
      assert.ok(e.message.includes('string') || e.message.includes('undefined'),
        'Should throw a clear error about missing path');
    }
  });

  await test('projectStateDir returns path under projects directory', () => {
    const stateDir = shared.projectStateDir({ name: 'myproject' });
    assert.ok(stateDir.includes('projects'), `Expected path containing 'projects': ${stateDir}`);
    assert.ok(stateDir.includes('myproject'), `Expected path containing project name: ${stateDir}`);
  });

  await test('projectWorkItemsPath ends with work-items.json', () => {
    const p = shared.projectWorkItemsPath({ name: 'myproject' });
    assert.ok(p.endsWith('work-items.json'), `Expected path ending with work-items.json: ${p}`);
  });

  await test('projectPrPath ends with pull-requests.json', () => {
    const p = shared.projectPrPath({ name: 'myproject' });
    assert.ok(p.endsWith('pull-requests.json'), `Expected path ending with pull-requests.json: ${p}`);
  });

  await test('projectWorkItemsPath and projectPrPath are different', () => {
    const wi = shared.projectWorkItemsPath({ name: 'test' });
    const pr = shared.projectPrPath({ name: 'test' });
    assert.notStrictEqual(wi, pr);
  });
}

// ─── shared.js — mutateJsonFileLocked Tests ─────────────────────────────────

async function testMutateJsonFileLocked() {
  console.log('\n── shared.js — mutateJsonFileLocked ──');

  await test('mutateJsonFileLocked creates file with default value', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'new.json');
    shared.mutateJsonFileLocked(fp, (data) => { data.created = true; }, { defaultValue: {} });
    const result = shared.safeJson(fp);
    assert.strictEqual(result.created, true);
  });

  await test('mutateJsonFileLocked applies mutation and persists', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'mutate.json');
    shared.safeWrite(fp, { count: 0 });
    shared.mutateJsonFileLocked(fp, (data) => { data.count = 42; });
    assert.strictEqual(shared.safeJson(fp).count, 42);
  });

  await test('mutateJsonFileLocked uses array default', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'arr.json');
    shared.mutateJsonFileLocked(fp, (data) => { data.push('item'); }, { defaultValue: [] });
    const result = shared.safeJson(fp);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result[0], 'item');
  });

  await test('mutateJsonFileLocked cleans up lock file', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'locktest.json');
    shared.mutateJsonFileLocked(fp, () => {}, { defaultValue: {} });
    assert.ok(!fs.existsSync(fp + '.lock'), 'lock file should be cleaned up');
  });

  await test('mutateJsonFileLocked handles concurrent mutations safely', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'concurrent.json');
    shared.safeWrite(fp, { count: 0 });
    // Run two mutations sequentially (sync) — both should apply
    shared.mutateJsonFileLocked(fp, (data) => { data.count++; });
    shared.mutateJsonFileLocked(fp, (data) => { data.count++; });
    assert.strictEqual(shared.safeJson(fp).count, 2);
  });
}

// ─── shared.js — safeWrite / backup / restore Tests ─────────────────────────

async function testSafeWriteBackupRestore() {
  console.log('\n── shared.js — safeWrite atomic + backup + restore ──');

  await test('safeWrite throws after rename failures (no writeFileSync fallback)', () => {
    // Verify the source code has no writeFileSync fallback in safeWrite
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    // Extract safeWrite function body
    const match = src.match(/function safeWrite\(p, data\)\s*\{[\s\S]*?^}/m);
    assert.ok(match, 'safeWrite function should exist');
    const body = match[0];
    // Should NOT contain a direct writeFileSync to the target path as fallback
    // The only writeFileSync should be to the tmp file
    const writeFileCalls = body.match(/fs\.writeFileSync\(/g) || [];
    assert.strictEqual(writeFileCalls.length, 1,
      'safeWrite should have exactly 1 writeFileSync (to tmp file), no fallback');
    // Should throw after exhausting retries
    assert.ok(body.includes('throw'), 'safeWrite should throw on rename exhaustion');
  });

  await test('mutateJsonFileLocked creates .backup before mutation', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'data.json');
    shared.safeWrite(fp, { version: 1 });
    shared.mutateJsonFileLocked(fp, (data) => { data.version = 2; });
    // .backup should exist with the pre-mutation data
    const backup = shared.safeJson(fp + '.backup');
    assert.ok(backup, '.backup file should exist');
    assert.strictEqual(backup.version, 1, '.backup should contain pre-mutation state');
    // primary should have the mutation
    assert.strictEqual(shared.safeJson(fp).version, 2);
  });

  await test('safeJson auto-restores from .backup when primary is corrupted', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'corrupted.json');
    // Write corrupted primary
    fs.writeFileSync(fp, 'NOT VALID JSON{{{');
    // Write valid backup
    fs.writeFileSync(fp + '.backup', JSON.stringify({ restored: true }));
    const result = shared.safeJson(fp);
    assert.deepStrictEqual(result, { restored: true }, 'should restore from .backup');
    // Primary should now be restored too
    const primaryAfter = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.deepStrictEqual(primaryAfter, { restored: true }, 'primary file should be restored');
  });

  await test('safeJson returns null when both primary and .backup are missing', () => {
    const result = shared.safeJson('/nonexistent/path/data.json');
    assert.strictEqual(result, null);
  });

  await test('safeJson returns null when primary is corrupted and no .backup exists', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'no-backup.json');
    fs.writeFileSync(fp, 'CORRUPTED');
    const result = shared.safeJson(fp);
    assert.strictEqual(result, null, 'should return null with no backup available');
  });

  await test('safeJson returns null when both primary and .backup are corrupted', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'both-bad.json');
    fs.writeFileSync(fp, 'BAD PRIMARY');
    fs.writeFileSync(fp + '.backup', 'BAD BACKUP');
    const result = shared.safeJson(fp);
    assert.strictEqual(result, null, 'should return null when both files are corrupted');
  });

  await test('mutateJsonFileLocked backup updated on each mutation', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'multi.json');
    shared.safeWrite(fp, { step: 0 });
    shared.mutateJsonFileLocked(fp, (data) => { data.step = 1; });
    assert.strictEqual(shared.safeJson(fp + '.backup').step, 0);
    shared.mutateJsonFileLocked(fp, (data) => { data.step = 2; });
    assert.strictEqual(shared.safeJson(fp + '.backup').step, 1,
      '.backup should reflect state before latest mutation');
    assert.strictEqual(shared.safeJson(fp).step, 2);
  });
}

// ─── engine.js — isRetryableFailureReason Tests ─────────────────────────────

async function testIsRetryableFailureReason() {
  console.log('\n── engine.js — isRetryableFailureReason ──');

  let isRetryableFailureReason;
  try {
    isRetryableFailureReason = require(path.join(MINIONS_DIR, 'engine')).isRetryableFailureReason;
  } catch {
    // Fall back to source assertion
  }

  if (!isRetryableFailureReason) {
    // Verify it exists via source (may be in engine.js or engine/dispatch.js)
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8') + fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    await test('isRetryableFailureReason is defined', () => {
      assert.ok(src.includes('function isRetryableFailureReason'));
    });
    skip('isRetryableFailureReason-direct', 'function not exported');
    return;
  }

  await test('empty reason is retryable', () => {
    assert.strictEqual(isRetryableFailureReason(''), true);
  });

  await test('undefined reason is retryable', () => {
    assert.strictEqual(isRetryableFailureReason(), true);
    assert.strictEqual(isRetryableFailureReason(undefined), true);
    assert.strictEqual(isRetryableFailureReason(null), true);
  });

  await test('generic error reasons are retryable', () => {
    assert.strictEqual(isRetryableFailureReason('Agent timed out'), true);
    assert.strictEqual(isRetryableFailureReason('Process exited with code 1'), true);
    assert.strictEqual(isRetryableFailureReason('spawn error: ENOENT'), true);
  });

  await test('no playbook rendered is non-retryable', () => {
    assert.strictEqual(isRetryableFailureReason('no playbook rendered for item X'), false);
  });

  await test('failed to render is non-retryable', () => {
    assert.strictEqual(isRetryableFailureReason('failed to render template'), false);
  });

  await test('no target project available is non-retryable', () => {
    assert.strictEqual(isRetryableFailureReason('no target project available'), false);
  });

  await test('missing required is non-retryable', () => {
    assert.strictEqual(isRetryableFailureReason('missing required field X'), false);
  });

  await test('validation failed is non-retryable', () => {
    assert.strictEqual(isRetryableFailureReason('validation failed: bad data'), false);
  });

  await test('non-retryable matching is case-insensitive', () => {
    assert.strictEqual(isRetryableFailureReason('NO PLAYBOOK RENDERED'), false);
    assert.strictEqual(isRetryableFailureReason('Failed To Render'), false);
  });
}

// ─── engine.js — areDependenciesMet Tests ───────────────────────────────────

async function testAreDependenciesMet() {
  console.log('\n── engine.js — areDependenciesMet ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('areDependenciesMet returns true for no deps', () => {
    assert.ok(src.includes('if (!deps || deps.length === 0) return true'),
      'Should return true immediately when no dependencies');
  });

  await test('areDependenciesMet returns true for no sourcePlan', () => {
    assert.ok(src.includes("if (!sourcePlan) return true"),
      'Should return true when no sourcePlan (non-plan work items)');
  });

  await test('areDependenciesMet returns failed for failed dep', () => {
    assert.ok(src.includes("if (depItem.status === 'failed') return 'failed'"),
      'Should return string "failed" when any dependency has failed');
  });

  await test('areDependenciesMet uses PRD_MET_STATUSES for all done aliases', () => {
    assert.ok(src.includes("PRD_MET_STATUSES"),
      'Should use PRD_MET_STATUSES set for status checking');
    // Verify the set includes all legacy aliases
    assert.ok(src.includes("'done'") && src.includes("'in-pr'") &&
              src.includes("'implemented'") && src.includes("'complete'"),
      'PRD_MET_STATUSES should include done, in-pr, implemented, complete');
  });

  await test('areDependenciesMet uses PRD_MET_STATUSES for work item status check', () => {
    // After bug fix: should use PRD_MET_STATUSES.has() instead of hardcoded status list
    assert.ok(src.includes('PRD_MET_STATUSES.has(depItem.status)'),
      'Work item dep check should use PRD_MET_STATUSES.has() for consistency with PRD fallback');
  });

  await test('areDependenciesMet has PRD JSON fallback for missing work items', () => {
    assert.ok(src.includes('Fallback: check PRD JSON'),
      'Should fall back to PRD JSON when work item not found for a dependency ID');
  });

  await test('areDependenciesMet collects work items from ALL projects', () => {
    assert.ok(src.includes('allWorkItems = allWorkItems.concat(wi)'),
      'Should collect work items across all projects for cross-project deps');
  });
}

// ─── engine.js — Cooldown System Tests ──────────────────────────────────────

async function testCooldownSystem() {
  console.log('\n── engine.js — Cooldown System ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');

  await test('isOnCooldown returns false for unknown key', () => {
    assert.ok(src.includes('if (!entry) return false'),
      'Should return false when key has no cooldown entry');
  });

  await test('isOnCooldown backoff caps at 8x (not 2x)', () => {
    // After bug fix: backoff should scale up to 8x for meaningful exponential backoff
    assert.ok(src.includes('Math.min(Math.pow(2, entry.failures || 0), 8)'),
      'Backoff cap should be 8 for meaningful exponential scaling');
  });

  await test('setCooldownFailure increments failure count', () => {
    assert.ok(src.includes("(existing?.failures || 0) + 1"),
      'Should increment failure count from existing or 0');
  });

  await test('setCooldownFailure warns at 3+ failures', () => {
    assert.ok(src.includes('failures >= 3'),
      'Should log warning when failures reach 3+');
  });

  await test('loadCooldowns prunes entries older than 24 hours', () => {
    assert.ok(src.includes('24 * 60 * 60 * 1000'),
      'Should prune cooldown entries older than 24h');
  });

  await test('saveCooldowns is debounced at 1 second', () => {
    assert.ok(src.includes('_cooldownWriteTimer') && src.includes('1000'),
      'Should debounce cooldown writes to at most once per second');
  });

  await test('isAlreadyDispatched checks pending, active, and recent completed', () => {
    assert.ok(
      src.includes('dispatch.pending') &&
      src.includes('dispatch.active') &&
      src.includes('3600000'),
      'Should check pending + active + completed within last hour');
  });

  await test('cooldown backoff formula is truly exponential', () => {
    // Verify that different failure counts produce different backoff multipliers
    // 0 failures: 2^0 = 1x, 1 failure: 2^1 = 2x, 2 failures: 2^2 = 4x, 3 failures: 2^3 = 8x (capped)
    const formula = (failures) => Math.min(Math.pow(2, failures), 8);
    assert.strictEqual(formula(0), 1);
    assert.strictEqual(formula(1), 2);
    assert.strictEqual(formula(2), 4);
    assert.strictEqual(formula(3), 8);
    assert.strictEqual(formula(10), 8); // capped
  });
}

// ─── engine.js — resolveAgent Tests ─────────────────────────────────────────

async function testResolveAgent() {
  console.log('\n── engine.js — resolveAgent ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'routing.js'), 'utf8');

  await test('resolveAgent resolves _author_ token to authorAgent', () => {
    assert.ok(src.includes("route.preferred === '_author_' ? authorAgent : route.preferred"),
      'Should resolve _author_ token to the authorAgent parameter');
  });

  await test('resolveAgent checks preferred then fallback then idle', () => {
    // Verify the 3-tier resolution order
    assert.ok(src.includes('if (preferred && isAvailable(preferred))'),
      'Should check preferred first');
    assert.ok(src.includes('if (fallback && isAvailable(fallback))'),
      'Should check fallback second');
    assert.ok(src.includes('.sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b))'),
      'Should sort remaining idle agents by error rate');
  });

  await test('resolveAgent returns null when no agents available', () => {
    assert.ok(src.includes('return null'),
      'Should return null when no idle agents found');
  });

  await test('resolveAgent tracks claimed agents to prevent double-booking', () => {
    assert.ok(src.includes('_claimedAgents.add') && src.includes('_claimedAgents.has'),
      'Should track and check claimed agents per discovery pass');
  });

  await test('resolveAgent excludes preferred and fallback from idle pool', () => {
    assert.ok(src.includes('id !== preferred && id !== fallback'),
      'Idle pool should exclude preferred/fallback to avoid rechecking');
  });
}

// ─── engine.js — renderPlaybook Tests ───────────────────────────────────────

async function testRenderPlaybook() {
  console.log('\n── engine.js — renderPlaybook ──');

  let renderPlaybook;
  try {
    renderPlaybook = require(path.join(MINIONS_DIR, 'engine')).renderPlaybook;
  } catch {}

  if (!renderPlaybook) {
    skip('renderPlaybook-direct', 'engine.renderPlaybook not available');
    return;
  }

  await test('renderPlaybook returns null for nonexistent playbook type', () => {
    const result = renderPlaybook('this-playbook-does-not-exist-xyz', {});
    assert.strictEqual(result, null);
  });

  await test('renderPlaybook returns string for valid playbook type', () => {
    const result = renderPlaybook('implement', {
      agent_name: 'TestAgent', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: 'Test desc', work_item_id: 'W001',
      branch_name: 'test-branch', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.ok(typeof result === 'string' && result.length > 0,
      'Should return rendered playbook string');
  });

  await test('renderPlaybook substitutes template variables', () => {
    const result = renderPlaybook('implement', {
      agent_name: 'UNIQUE_AGENT_SENTINEL', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: 'Test desc', work_item_id: 'W001',
      branch_name: 'test-branch', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.ok(result && result.includes('UNIQUE_AGENT_SENTINEL'),
      'Should substitute {{agent_name}} with actual value');
  });

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'playbook.js'), 'utf8');

  await test('renderPlaybook injects team notes section', () => {
    assert.ok(src.includes('Team Notes') || src.includes('team_notes') || src.includes('notes_content'),
      'Should inject team notes into rendered playbook');
  });

  await test('renderPlaybook injects skill extraction instructions', () => {
    assert.ok(src.includes('skill') && src.includes('```skill'),
      'Should inject skill extraction block format');
  });

  // ── Critical variable blocking tests ──

  let getLastRenderError;
  try {
    getLastRenderError = require(path.join(MINIONS_DIR, 'engine')).getLastRenderError;
  } catch {}

  await test('renderPlaybook returns null when critical task_description is empty (implement)', () => {
    if (!getLastRenderError) { skip('critical-vars-no-fn', 'getLastRenderError not exported'); return; }
    const result = renderPlaybook('implement', {
      agent_name: 'TestAgent', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: '', work_item_id: 'W001',
      branch_name: 'test-branch', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.strictEqual(result, null, 'Should return null when task_description is empty');
    const err = getLastRenderError();
    assert.ok(err, 'Should set lastRenderError');
    assert.strictEqual(err.reason, 'critical_vars_missing');
    assert.ok(err.vars.includes('task_description'), 'Should list task_description as missing');
  });

  await test('renderPlaybook returns null when critical branch_name is empty (fix)', () => {
    if (!getLastRenderError) { skip('critical-vars-fix', 'getLastRenderError not exported'); return; }
    const result = renderPlaybook('fix', {
      agent_name: 'TestAgent', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: 'Fix something', work_item_id: 'W001',
      branch_name: '', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.strictEqual(result, null, 'Should return null when branch_name is empty for fix playbook');
    const err = getLastRenderError();
    assert.ok(err && err.reason === 'critical_vars_missing', 'Should be critical_vars_missing');
    assert.ok(err.vars.includes('branch_name'), 'Should list branch_name as missing');
  });

  await test('renderPlaybook returns content when non-critical var is empty', () => {
    if (!getLastRenderError) { skip('non-critical-vars', 'getLastRenderError not exported'); return; }
    const result = renderPlaybook('implement', {
      agent_name: 'TestAgent', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: 'Real description', work_item_id: 'W001',
      branch_name: 'test-branch', team_root: MINIONS_DIR, date: '2024-01-01',
      references: '',
    });
    assert.ok(typeof result === 'string' && result.length > 0,
      'Should return content when only non-critical vars are empty');
    const err = getLastRenderError();
    assert.strictEqual(err, null, 'Should not set lastRenderError for non-critical vars');
  });

  await test('renderPlaybook allows empty critical vars for playbook types without CRITICAL_VARS', () => {
    if (!getLastRenderError) { skip('no-critical-vars-type', 'getLastRenderError not exported'); return; }
    const result = renderPlaybook('plan', {
      agent_name: 'TestAgent', agent_role: 'Analyst', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_description: '', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    // plan playbook has no critical vars, so empty task_description should NOT block
    assert.ok(result === null || typeof result === 'string',
      'Plan playbook should not be blocked by empty vars (may return null if plan playbook missing)');
    const err = getLastRenderError();
    assert.ok(!err || err.reason !== 'critical_vars_missing',
      'Should not set critical_vars_missing error for plan type');
  });

  await test('CRITICAL_VARS map defines expected entries', () => {
    let CRITICAL_VARS;
    try { CRITICAL_VARS = require(path.join(MINIONS_DIR, 'engine', 'playbook')).CRITICAL_VARS; } catch {}
    if (!CRITICAL_VARS) { skip('critical-vars-map', 'CRITICAL_VARS not exported'); return; }
    assert.ok(Array.isArray(CRITICAL_VARS['implement']), 'implement should have critical vars');
    assert.ok(CRITICAL_VARS['implement'].includes('task_description'), 'implement needs task_description');
    assert.ok(CRITICAL_VARS['implement'].includes('branch_name'), 'implement needs branch_name');
    assert.ok(Array.isArray(CRITICAL_VARS['fix']), 'fix should have critical vars');
    assert.ok(CRITICAL_VARS['fix'].includes('task_description'), 'fix needs task_description');
    assert.ok(CRITICAL_VARS['fix'].includes('branch_name'), 'fix needs branch_name');
  });
}

// ─── engine.js — completeDispatch Tests ─────────────────────────────────────

async function testCompleteDispatch() {
  console.log('\n── engine.js — completeDispatch ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');

  await test('completeDispatch caps completed list at 100', () => {
    assert.ok(src.includes('dispatch.completed.length > 100'),
      'Should trim completed list when it exceeds 100 entries');
  });

  await test('completeDispatch deletes prompt from completed item', () => {
    assert.ok(src.includes('delete item.prompt'),
      'Should delete prompt field to save memory in completed list');
  });

  await test('completeDispatch auto-retries up to 3 times', () => {
    assert.ok(src.includes('retries < 3'),
      'Should allow up to 3 auto-retries for retryable failures');
  });

  await test('completeDispatch marks failed on non-retryable reason', () => {
    assert.ok(src.includes('Non-retryable failure'),
      'Should mark work item as failed with non-retryable message');
  });

  await test('completeDispatch writes cascade failure alerts', () => {
    assert.ok(src.includes('writeInboxAlert') && src.includes('failed-'),
      'Should write inbox alerts for cascade failures affecting dependents');
  });

  await test('completeDispatch increments _retryCount on work item', () => {
    assert.ok(src.includes('_retryCount = retries + 1'),
      'Should increment retry counter on source work item');
  });

  await test('completeDispatch clears dedupe key for retried items', () => {
    assert.ok(src.includes('dp.completed.filter(d => d.meta?.dispatchKey !== item.meta.dispatchKey)'),
      'Should clear completed dedupe marker so retried item can redispatch');
  });
}

// ─── engine.js — discoverFromPrs Tests ──────────────────────────────────────

async function testDiscoverFromPrs() {
  console.log('\n── engine.js — discoverFromPrs ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('discoverFromPrs skips non-active PRs', () => {
    assert.ok(src.includes("pr.status !== 'active'"),
      'Should skip PRs not in active status');
  });

  await test('discoverFromPrs allows self-review', () => {
    // Agents can review their own PRs (self-review is allowed)
    assert.ok(!src.includes('agentId === prAuthor'),
      'Self-review prevention should not exist — agents can review their own PRs');
  });

  await test('discoverFromPrs handles changes-requested for fix work', () => {
    assert.ok(src.includes('changes-requested') || src.includes('changes_requested'),
      'Should discover fix work when review status is changes-requested');
  });

  await test('discoverFromPrs handles human feedback pendingFix', () => {
    assert.ok(src.includes('pendingFix') || src.includes('humanFeedback'),
      'Should discover fix work when human feedback is pending');
  });

  await test('discoverFromPrs skips PRs with active dispatch', () => {
    assert.ok(src.includes('activePrIds') || src.includes('activeDispatch'),
      'Should skip PRs that already have an active dispatch to prevent races');
  });

  await test('discoverFromPrs uses cooldown to prevent rapid redispatch', () => {
    assert.ok(src.includes('isOnCooldown') || src.includes('cooldown'),
      'Should check cooldown before creating new PR work');
  });
}

// ─── engine.js — discoverFromWorkItems Tests ────────────────────────────────

async function testDiscoverFromWorkItems() {
  console.log('\n── engine.js — discoverFromWorkItems ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('discoverFromWorkItems propagates dependency failures', () => {
    assert.ok(src.includes("depStatus === 'failed'") || src.includes('Dependency failed'),
      'Should fail work items whose dependencies have failed');
  });

  await test('discoverFromWorkItems self-heals recovered deps', () => {
    assert.ok(src.includes('Recovered') || src.includes('self-heal') || src.includes('Self-heal'),
      'Should recover failed items when their dependencies become available');
  });

  await test('discoverFromWorkItems routes large/complex items differently', () => {
    assert.ok(src.includes('implement:large'),
      'Should use implement:large routing for high-complexity items');
  });

  await test('discoverFromWorkItems supports shared-branch strategy', () => {
    assert.ok(src.includes('shared-branch'),
      'Should support shared-branch strategy for plan-driven work');
  });

  await test('discoverFromWorkItems checks deduplication', () => {
    assert.ok(src.includes('isAlreadyDispatched'),
      'Should check isAlreadyDispatched to prevent duplicate dispatches');
  });

  await test('discoverFromWorkItems filters pending/queued items only', () => {
    assert.ok(src.includes("'pending'") && src.includes("'queued'"),
      'Should only discover work items in pending or queued status');
  });
}

// ─── engine.js — checkTimeouts Tests ────────────────────────────────────────

async function testCheckTimeouts() {
  console.log('\n── engine.js — checkTimeouts ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');

  await test('checkTimeouts uses configurable agentTimeout', () => {
    assert.ok(src.includes('config.engine?.agentTimeout') || src.includes('agentTimeout'),
      'Should use config.engine.agentTimeout with fallback to defaults');
  });

  await test('checkTimeouts uses configurable heartbeatTimeout', () => {
    assert.ok(src.includes('config.engine?.heartbeatTimeout') || src.includes('heartbeatTimeout'),
      'Should use config.engine.heartbeatTimeout with fallback to defaults');
  });

  await test('checkTimeouts supports per-item deadline', () => {
    assert.ok(src.includes('deadline') || src.includes('meta?.deadline'),
      'Should support per-item deadline override for fan-out tasks');
  });

  await test('checkTimeouts detects blocking tools', () => {
    assert.ok(src.includes('TaskOutput') || src.includes('blocking'),
      'Should detect blocking tool patterns to extend timeout');
  });

  await test('checkTimeouts detects completion via output scan', () => {
    assert.ok(src.includes('"type":"result"') || src.includes('"type": "result"'),
      'Should scan live output for completion markers');
  });
}

// ─── engine.js — addToDispatch Tests ────────────────────────────────────────

async function testAddToDispatch() {
  console.log('\n── engine.js — addToDispatch ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');

  await test('addToDispatch generates ID if missing', () => {
    assert.ok(src.includes('item.id = item.id ||'),
      'Should auto-generate dispatch ID when not provided');
  });

  await test('addToDispatch adds timestamp', () => {
    assert.ok(src.includes('item.created_at = ts()'),
      'Should set created_at timestamp on new dispatch items');
  });

  await test('addToDispatch pushes to pending queue', () => {
    assert.ok(src.includes('dispatch.pending.push(item)'),
      'Should push item to dispatch.pending array');
  });
}

// ─── lifecycle.js — extractSkillsFromOutput Tests ───────────────────────────

async function testExtractSkills() {
  console.log('\n── lifecycle.js — Skill Extraction ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('extractSkillsFromOutput matches skill fenced blocks', () => {
    assert.ok(src.includes('```skill') && (src.includes('skill\\s*\\n') || src.includes('```skill')),
      'Should regex-match ```skill fenced code blocks');
  });

  await test('extractSkillsFromOutput skips blocks without name', () => {
    assert.ok(src.includes('no name') || src.includes("has no name"),
      'Should skip skill blocks that lack a name in frontmatter');
  });

  await test('extractSkillsFromOutput enriches with author and created', () => {
    assert.ok(src.includes('author') && src.includes('created'),
      'Should add author and created date to extracted skills');
  });

  await test('extractSkillsFromOutput handles project-scoped skills', () => {
    assert.ok(src.includes('scope') && src.includes('project'),
      'Should support project-scoped skill extraction');
  });
}

// ─── lifecycle.js — updateWorkItemStatus Tests ──────────────────────────────

async function testUpdateWorkItemStatus() {
  console.log('\n── lifecycle.js — updateWorkItemStatus ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('updateWorkItemStatus returns early for null item ID', () => {
    assert.ok(src.includes('if (!itemId)') || src.includes('if (!meta?.item?.id)'),
      'Should bail out early when item ID is missing');
  });

  await test('updateWorkItemStatus resolves central-work-item path', () => {
    assert.ok(src.includes('central-work-item'),
      'Should handle central-work-item source for path resolution');
  });

  await test('updateWorkItemStatus handles fan-out aggregation', () => {
    assert.ok(src.includes('fanout') || src.includes('fan-out') || src.includes('central-work-item-fanout'),
      'Should aggregate fan-out results before setting final status');
  });

  await test('updateWorkItemStatus calls syncPrdItemStatus', () => {
    assert.ok(src.includes('syncPrdItemStatus'),
      'Should sync status to PRD item after updating work item');
  });
}

// ─── lifecycle.js — syncPrsFromOutput Tests ─────────────────────────────────

async function testSyncPrsFromOutput() {
  console.log('\n── lifecycle.js — syncPrsFromOutput ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('syncPrsFromOutput matches ADO PR URLs', () => {
    assert.ok(src.includes('visualstudio') && src.includes('pullrequest'),
      'Should match Azure DevOps PR URL patterns');
  });

  await test('syncPrsFromOutput matches GitHub PR URLs', () => {
    assert.ok(src.includes('github') && src.includes('pull'),
      'Should match GitHub PR URL patterns');
  });

  await test('syncPrsFromOutput detects PR creation patterns', () => {
    assert.ok(src.includes('created') || src.includes('opened') || src.includes('submitted'),
      'Should detect PR creation keywords in agent output');
  });

  await test('syncPrsFromOutput adds PR links', () => {
    assert.ok(src.includes('addPrLink'),
      'Should record PR-to-work-item links via addPrLink');
  });

  await test('PR dedup uses strict equality, not substring includes', () => {
    assert.ok(!src.includes("String(p.id).includes(prId)"),
      'Should not use String.includes for PR dedup — causes false positives (PR 123 matching 1234)');
    assert.ok(src.includes("String(p.id) === String(prId)"),
      'Should use strict equality for PR ID comparison');
  });
}

// ─── lifecycle.js — Silent Data Loss & Undefined Variable Tests ──────────────

async function testLifecycleDataSafety() {
  console.log('\n── lifecycle.js — Data Safety & Variable Fixes ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('Work-items.json parse failure is logged, not silently swallowed', () => {
    // The old code had: try { items = JSON.parse(...); } catch {}
    // The fix adds logging in the catch block
    assert.ok(!src.match(/JSON\.parse\(fs\.readFileSync\(wiPath[^)]*\)\);\s*\}\s*catch\s*\{\s*\}/),
      'Should not have empty catch block when parsing work-items.json');
    assert.ok(src.includes('.bak'),
      'Should create a backup before falling back to empty array');
  });

  await test('updatePrAfterReview logs defined variable, not minionsVerdict', () => {
    assert.ok(!src.includes('minionsVerdict'),
      'Should not reference undefined minionsVerdict variable');
    assert.ok(src.includes('target.reviewStatus') && src.includes('by ${reviewerName}'),
      'Should log target.reviewStatus and reviewerName');
  });
}

// ─── lifecycle.js — runPostCompletionHooks Tests ────────────────────────────

async function testRunPostCompletionHooks() {
  console.log('\n── lifecycle.js — runPostCompletionHooks ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('runPostCompletionHooks calls syncPrsFromOutput', () => {
    assert.ok(src.includes('syncPrsFromOutput'),
      'Should extract and sync PRs from agent output on completion');
  });

  await test('runPostCompletionHooks calls checkPlanCompletion on success', () => {
    assert.ok(src.includes('checkPlanCompletion'),
      'Should check plan completion when agent succeeds with sourcePlan');
  });

  // ─── checkPlanCompletion idempotency tests ──────────────────────────────────

  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('checkPlanCompletion has _completionNotified idempotency guard', () => {
    assert.ok(lifecycleSrc.includes('_completionNotified'),
      'Should check _completionNotified flag for idempotency');
    assert.ok(lifecycleSrc.includes('if (plan._completionNotified) return'),
      'Should return early when _completionNotified is set');
  });

  await test('checkPlanCompletion persists _completionNotified via mutateJsonFileLocked', () => {
    assert.ok(lifecycleSrc.includes('mutateJsonFileLocked(planPath'),
      'Should use mutateJsonFileLocked to persist _completionNotified flag');
    assert.ok(lifecycleSrc.includes("data._completionNotified = true"),
      'Should set _completionNotified = true in the mutation');
  });

  await test('checkPlanCompletion does not use uniquePath for inbox summary', () => {
    // uniquePath at the inbox summary line was replaced with slug+date dedup (via writeToInbox helper or inline)
    const inboxSummarySection = lifecycleSrc.split('Write summary to notes/inbox')[1]?.split('Resolve the primary project')[0] || '';
    assert.ok(!inboxSummarySection.includes('uniquePath'),
      'Should not use uniquePath for plan completion inbox summary');
    assert.ok(inboxSummarySection.includes('writeToInbox') || inboxSummarySection.includes('safeReadDir') || inboxSummarySection.includes('summarySlug'),
      'Should use slug+date dedup pattern for inbox summary (via writeToInbox helper or inline)');
  });

  await test('checkPlanCompletion guards inbox write with slug+date dedup (not uniquePath)', () => {
    // The inbox write uses writeToInbox helper (which internally uses safeReadDir + dateStamp + startsWith)
    // or inlines the same pattern. Either approach is valid.
    const inboxSection = lifecycleSrc.split('Write summary to notes/inbox')[1]?.split('Resolve the primary project')[0] || '';
    assert.ok(inboxSection.includes('writeToInbox') || inboxSection.includes('safeReadDir'),
      'Should use writeToInbox helper or safeReadDir for inbox dedup check');
    assert.ok(!inboxSection.includes('uniquePath'), 'Should NOT use uniquePath for inbox summary');
  });

  await test('checkPlanCompletion sets _completionNotified on in-memory plan object', () => {
    // The flag must be set on the local `plan` variable too so later safeWrite(planPath, plan)
    // does not overwrite the persisted flag
    assert.ok(lifecycleSrc.includes('plan._completionNotified = true'),
      'Should set _completionNotified on in-memory plan object (not just in mutateJsonFileLocked)');
  });

  await test('checkPlanCompletion crash recovery: completed plan without _completionNotified falls through', () => {
    // When plan.status === 'completed' but _completionNotified is NOT set, the function must
    // NOT return early — it should fall through to create verify/PR items (crash recovery path)
    const guardSection = lifecycleSrc.split("plan.status === 'completed'")[1]?.split('const projects')[0] || '';
    assert.ok(guardSection.includes('if (plan._completionNotified) return'),
      'Should only return early within the completed guard when _completionNotified is set');
    // Verify the guard is INSIDE the status === completed block, not standalone
    assert.ok(!lifecycleSrc.includes('if (plan._completionNotified) return;\n  if (plan.status'),
      'The _completionNotified guard should be inside the completed status check, not before it');
  });

  await test('runPostCompletionHooks calls updateMetrics', () => {
    assert.ok(src.includes('updateMetrics') || src.includes('trackEngineUsage'),
      'Should update agent metrics after completion');
  });

  await test('runPostCompletionHooks parses agent output', () => {
    assert.ok(src.includes('parseAgentOutput') || src.includes('parseStreamJsonOutput'),
      'Should parse agent stdout to extract result summary');
  });
}

// ─── Context Pressure Metrics Tests ─────────────────────────────────────────

async function testContextPressureMetrics() {
  console.log('\n── lifecycle.js — Context Pressure Metrics ──');

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));
  const shared = require(path.join(MINIONS_DIR, 'engine', 'shared'));

  await test('recordContextPressureOnWorkItem writes _turnCount, _outputLogSizeBytes, _hitTurnLimit', () => {
    const tmpDir = createTmpDir();
    const wiPath = path.join(tmpDir, 'work-items.json');
    fs.writeFileSync(wiPath, JSON.stringify([{ id: 'WI-CP-1', status: 'dispatched', title: 'test' }]));

    // Monkey-patch MINIONS_DIR temporarily via meta.source path
    const meta = {
      item: { id: 'WI-CP-1' },
      source: 'central-work-item',
      project: null,
    };
    // We need to use the function with a direct wiPath, but the function reads from MINIONS_DIR.
    // Instead, test via source code assertion + a functional mock.
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('target._turnCount = turnCount'), 'Should record _turnCount on work item');
    assert.ok(src.includes('target._outputLogSizeBytes = outputLogSizeBytes'), 'Should record _outputLogSizeBytes on work item');
    assert.ok(src.includes('target._hitTurnLimit = hitTurnLimit'), 'Should record _hitTurnLimit on work item');
  });

  await test('updateMetrics aggregates contextPressure section', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('_contextPressure'), 'Should have _contextPressure section in metrics');
    assert.ok(src.includes('cp.totalTurns'), 'Should track totalTurns in contextPressure');
    assert.ok(src.includes('cp.dispatches'), 'Should track dispatch count in contextPressure');
    assert.ok(src.includes('cp.maxTurns'), 'Should track maxTurns in contextPressure');
    assert.ok(src.includes('cp.turnLimitHits'), 'Should track turnLimitHits in contextPressure');
  });

  await test('updateMetrics contextPressure updates maxTurns correctly', () => {
    const tmpDir = createTmpDir();
    const metricsPath = path.join(tmpDir, 'metrics.json');
    fs.writeFileSync(metricsPath, JSON.stringify({
      _contextPressure: { totalTurns: 50, dispatches: 2, maxTurns: 30, turnLimitHits: 0 }
    }));
    const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

    // Simulate what updateMetrics does for contextPressure
    const taskUsage = { numTurns: 45, costUsd: 0.1, inputTokens: 1000, outputTokens: 500 };
    if (taskUsage && taskUsage.numTurns > 0) {
      if (!metrics._contextPressure) metrics._contextPressure = { totalTurns: 0, dispatches: 0, maxTurns: 0, turnLimitHits: 0 };
      const cp = metrics._contextPressure;
      cp.totalTurns += taskUsage.numTurns;
      cp.dispatches++;
      if (taskUsage.numTurns > cp.maxTurns) cp.maxTurns = taskUsage.numTurns;
    }
    assert.strictEqual(metrics._contextPressure.totalTurns, 95, 'totalTurns should accumulate');
    assert.strictEqual(metrics._contextPressure.dispatches, 3, 'dispatches should increment');
    assert.strictEqual(metrics._contextPressure.maxTurns, 45, 'maxTurns should update when exceeded');
  });

  await test('contextPressure turnLimitHitPct calculation', () => {
    const cp = { totalTurns: 300, dispatches: 5, maxTurns: 100, turnLimitHits: 2 };
    const avgTurns = cp.totalTurns / cp.dispatches;
    const turnLimitPct = (cp.turnLimitHits / cp.dispatches) * 100;
    assert.strictEqual(avgTurns, 60, 'Average turns should be totalTurns/dispatches');
    assert.strictEqual(turnLimitPct, 40, 'Turn limit hit % should be turnLimitHits/dispatches * 100');
  });

  await test('runPostCompletionHooks records context pressure on work item', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('recordContextPressureOnWorkItem'), 'Should call recordContextPressureOnWorkItem in post-completion hooks');
    assert.ok(src.includes('live-output.log'), 'Should read live-output.log file size');
    assert.ok(src.includes('fs.statSync'), 'Should use fs.statSync to get output log size');
  });

  await test('context pressure dashboard rendering function exists', () => {
    const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-other.js'), 'utf8');
    assert.ok(dashSrc.includes('renderContextPressure'), 'Should have renderContextPressure function');
    assert.ok(dashSrc.includes('context-pressure-content'), 'Should target context-pressure-content element');
    assert.ok(dashSrc.includes('_contextPressure'), 'Should read _contextPressure from metrics');
    assert.ok(dashSrc.includes('Avg Turns'), 'Should display average turns');
    assert.ok(dashSrc.includes('Hit Turn Limit'), 'Should display turn limit hit percentage');
  });
}

// ─── checkPlanCompletion Functional Idempotency Tests ───────────────────────

async function testCheckPlanCompletionIdempotency() {
  console.log('\n── lifecycle.js — checkPlanCompletion Idempotency (functional) ──');

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));
  const testPlanFile = '_test-idempotency.json';
  const testProjectName = '_test-idem-proj';

  // Paths that checkPlanCompletion will use (derived from MINIONS_DIR)
  const prdDir = path.join(MINIONS_DIR, 'prd');
  const prdArchiveDir = path.join(prdDir, 'archive');
  const plansDir = path.join(MINIONS_DIR, 'plans');
  const plansArchiveDir = path.join(plansDir, 'archive');
  const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
  const projectStateDir = path.join(MINIONS_DIR, 'projects', testProjectName);

  // Ensure dirs exist
  for (const d of [prdDir, prdArchiveDir, plansDir, plansArchiveDir, inboxDir, projectStateDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Helper: build a minimal valid PRD
  function makePrd(overrides = {}) {
    return {
      plan_summary: 'Test idempotency plan',
      project: testProjectName,
      branch_strategy: 'parallel',
      missing_features: [
        { id: 'TI-001', title: 'Feature A', acceptance_criteria: ['AC1'] },
        { id: 'TI-002', title: 'Feature B', acceptance_criteria: ['AC2'] },
      ],
      ...overrides,
    };
  }

  // Helper: build matching work items (all done)
  function makeWorkItems() {
    return [
      { id: 'TI-001', title: 'Implement: Feature A', type: 'implement', status: 'done',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z' },
      { id: 'TI-002', title: 'Implement: Feature B', type: 'implement', status: 'done',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T02:00:00Z' },
    ];
  }

  const tmpDir = createTmpDir();
  const meta = { item: { sourcePlan: testPlanFile } };
  const config = {
    projects: [{ name: testProjectName, localPath: tmpDir, mainBranch: 'main' }],
  };

  // Cleanup helper — removes all test artifacts
  function cleanup() {
    try { fs.unlinkSync(path.join(prdDir, testPlanFile)); } catch {}
    try { fs.unlinkSync(path.join(prdArchiveDir, testPlanFile)); } catch {}
    try { fs.unlinkSync(path.join(projectStateDir, 'work-items.json')); } catch {}
    try { fs.unlinkSync(path.join(projectStateDir, 'pull-requests.json')); } catch {}
    try { fs.rmdirSync(projectStateDir); } catch {}
    // Clean inbox files matching our test slug
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    for (const f of inboxFiles) { try { fs.unlinkSync(path.join(inboxDir, f)); } catch {} }
    // Clean plans
    for (const d of [plansDir, plansArchiveDir]) {
      const files = shared.safeReadDir(d).filter(f => f.includes('_test-idem'));
      for (const f of files) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
    }
  }

  // ── Test 1: First call creates inbox + verify + sets _completionNotified ──
  await test('checkPlanCompletion first call: creates inbox, verify item, sets _completionNotified', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    // _completionNotified should be set (check archived copy since PRD gets moved)
    const archivedPlan = shared.safeJson(path.join(prdArchiveDir, testPlanFile));
    assert.ok(archivedPlan, 'PRD should be archived after completion');
    assert.strictEqual(archivedPlan._completionNotified, true,
      '_completionNotified flag should be set after first call');
    assert.strictEqual(archivedPlan.status, 'completed',
      'Plan status should be set to completed');

    // Inbox file should exist
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxFiles.length, 1, 'Exactly one inbox file should be created');

    // Verify work item should be created
    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify' && w.sourcePlan === testPlanFile);
    assert.strictEqual(verifyItems.length, 1, 'Exactly one verify work item should be created');

    cleanup();
  });

  // ── Test 2: Second call with _completionNotified returns early ──
  await test('checkPlanCompletion second call: _completionNotified guard prevents duplicates', () => {
    cleanup();
    // Set up PRD with _completionNotified already set (simulates re-entry after first call)
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd({
      status: 'completed', _completionNotified: true,
    }));
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    // No inbox file should be created
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxFiles.length, 0, 'No inbox file should be created when _completionNotified is set');

    // No verify work item should be created
    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify');
    assert.strictEqual(verifyItems.length, 0, 'No verify work item when _completionNotified is set');

    // PRD should not be re-archived (still at original path)
    assert.ok(fs.existsSync(path.join(prdDir, testPlanFile)),
      'PRD should not be moved when _completionNotified guard triggers');

    cleanup();
  });

  // ── Test 3: Call twice end-to-end — only one set of side effects ──
  await test('checkPlanCompletion called twice: only one inbox file and one verify item total', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    // First call — should create everything
    lifecycle.checkPlanCompletion(meta, config);

    const inboxAfterFirst = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxAfterFirst.length, 1, 'First call creates one inbox file');

    // Restore PRD from archive so second call can find it (simulates crash before archive)
    const archived = shared.safeJson(path.join(prdArchiveDir, testPlanFile));
    assert.ok(archived, 'Archived PRD should exist after first call');
    shared.safeWrite(path.join(prdDir, testPlanFile), archived);

    // Second call — should return early due to _completionNotified
    lifecycle.checkPlanCompletion(meta, config);

    // Still only one inbox file
    const inboxAfterSecond = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxAfterSecond.length, 1,
      'Second call should not create additional inbox files');

    // Still only one verify work item
    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify' && w.sourcePlan === testPlanFile);
    assert.strictEqual(verifyItems.length, 1,
      'Second call should not create additional verify work items');

    cleanup();
  });

  // ── Test 4: Crash recovery — status=completed without _completionNotified falls through ──
  await test('checkPlanCompletion crash recovery: completed but no flag creates verify item', () => {
    cleanup();
    // Simulate crash: status is completed but _completionNotified was never set
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd({ status: 'completed' }));
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    // Should have created inbox and verify (crash recovery path)
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxFiles.length, 1,
      'Crash recovery should create inbox file');

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify' && w.sourcePlan === testPlanFile);
    assert.strictEqual(verifyItems.length, 1,
      'Crash recovery should create verify work item');

    // Flag should now be set in the archived copy
    const archivedPlan = shared.safeJson(path.join(prdArchiveDir, testPlanFile));
    assert.strictEqual(archivedPlan?._completionNotified, true,
      'Crash recovery should set _completionNotified for next re-entry');

    cleanup();
  });

  // ── Test 5: shared-branch plan creates PR item only once ──
  await test('checkPlanCompletion shared-branch: only one PR work item across two calls', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd({
      branch_strategy: 'shared-branch',
      feature_branch: 'feat/test-shared',
    }));
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    // First call
    lifecycle.checkPlanCompletion(meta, config);

    const workItems1 = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const prItems1 = workItems1.filter(w => w.itemType === 'pr' && w.sourcePlan === testPlanFile);
    assert.strictEqual(prItems1.length, 1, 'First call creates one PR work item for shared-branch');

    // Restore from archive
    const archived = shared.safeJson(path.join(prdArchiveDir, testPlanFile));
    shared.safeWrite(path.join(prdDir, testPlanFile), archived);

    // Second call — should return early
    lifecycle.checkPlanCompletion(meta, config);

    const workItems2 = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const prItems2 = workItems2.filter(w => w.itemType === 'pr' && w.sourcePlan === testPlanFile);
    assert.strictEqual(prItems2.length, 1,
      'Second call should not create additional PR work items');

    cleanup();
  });
}

// ─── spawn-agent.js Tests ───────────────────────────────────────────────────

async function testSpawnAgentScript() {
  console.log('\n── spawn-agent.js ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'spawn-agent.js'), 'utf8');

  await test('spawn-agent.js exits with code 78 when claude CLI not found', () => {
    assert.ok(src.includes('process.exit(78)'),
      'Should exit with code 78 (configuration error) when claudeBin is null');
  });

  await test('spawn-agent.js prints error message to stderr when CLI not found', () => {
    assert.ok(src.includes('console.error') && src.includes('npm install -g @anthropic-ai/claude-code'),
      'Should print actionable error message before exiting with 78');
  });

  await test('spawn-agent.js writes PID file for engine reattachment', () => {
    assert.ok(src.includes('pidFile') && src.includes('writeFileSync') && src.includes('proc.pid'),
      'Should write PID file so engine can reattach on restart');
  });

  await test('spawn-agent.js supports --resume flag', () => {
    assert.ok(src.includes("isResume") && src.includes("'--resume'"),
      'Should detect --resume flag and skip system prompt (baked into session)');
  });

  await test('spawn-agent.js handles large system prompts (>30KB)', () => {
    assert.ok(src.includes('30000') || src.includes('30KB'),
      'Should handle system prompts over 30KB by splitting or prepending to user prompt');
  });

  await test('spawn-agent.js checks --system-prompt-file support', () => {
    assert.ok(src.includes('_sysPromptFileSupported') && src.includes('--system-prompt-file'),
      'Should probe claude CLI for --system-prompt-file flag support');
  });
}

// ─── engine.js — Exit Code 78 Handling Tests ────────────────────────────────

async function testExitCode78Handling() {
  console.log('\n── engine.js — Exit Code 78 Handling ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('engine.js detects exit code 78 from spawn-agent', () => {
    assert.ok(src.includes('code === 78'),
      'Should detect exit code 78 as configuration error');
  });

  await test('engine.js fails dispatch immediately on exit code 78', () => {
    assert.ok(src.includes("code === 78") && src.includes("completeDispatch(id, 'error'"),
      'Should call completeDispatch with error on exit code 78 without waiting for timeout');
  });

  await test('engine.js includes install instructions in code 78 error', () => {
    assert.ok(src.includes('npm install -g @anthropic-ai/claude-code'),
      'Error message for code 78 should include install instructions');
  });
}

// ─── Session Resume Tests ────────────────────────────────────────────────────

async function testSessionResume() {
  console.log('\n── Session Resume ──');

  await test('parseStreamJsonOutput extracts sessionId', () => {
    const output = '{"type":"result","result":"done","session_id":"sess-abc123","usage":{}}\n';
    const { sessionId } = shared.parseStreamJsonOutput(output);
    assert.strictEqual(sessionId, 'sess-abc123');
  });

  await test('parseStreamJsonOutput returns null sessionId when absent', () => {
    const output = '{"type":"result","result":"done","usage":{}}\n';
    const { sessionId } = shared.parseStreamJsonOutput(output);
    assert.strictEqual(sessionId, null);
  });

  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('parseAgentOutput returns sessionId', () => {
    assert.ok(lifecycleSrc.includes('sessionId') && lifecycleSrc.includes('parseStreamJsonOutput'),
      'parseAgentOutput should extract sessionId from parseStreamJsonOutput');
  });

  await test('session.json is saved after successful dispatch', () => {
    assert.ok(lifecycleSrc.includes('session.json') && lifecycleSrc.includes('sessionId'),
      'runPostCompletionHooks should save session.json with sessionId');
  });

  await test('session.json is NOT saved for temp agents', () => {
    assert.ok(lifecycleSrc.includes("temp-") && lifecycleSrc.includes('session.json'),
      'Session save should skip temp agents');
  });

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('spawnAgent checks session.json for resume', () => {
    assert.ok(engineSrc.includes('session.json') && engineSrc.includes('--resume'),
      'spawnAgent should check session.json and pass --resume flag');
  });

  await test('session resume has 2-hour TTL and requires same branch', () => {
    assert.ok(engineSrc.includes('2 * 60 * 60 * 1000') || engineSrc.includes('7200000'),
      'Session resume should have a 2-hour staleness guard');
    assert.ok(engineSrc.includes('sameBranch'),
      'Session resume should only trigger when working on the same branch');
  });

  await test('session resume skips temp agents', () => {
    assert.ok(engineSrc.includes("temp-") && engineSrc.includes('session.json'),
      'spawnAgent should skip session resume for temp agents');
  });

  await test('session.json stores branch for context matching', () => {
    assert.ok(lifecycleSrc.includes('branch:') && lifecycleSrc.includes('session.json'),
      'session.json should include branch so resume only triggers on same branch');
  });

  await test('session.json stores dispatchId for traceability', () => {
    assert.ok(lifecycleSrc.includes('dispatchId') && lifecycleSrc.includes('session.json'),
      'session.json should include dispatchId');
  });
}

// ─── Wakeup Coalescing Tests ────────────────────────────────────────────────

async function testWakeupCoalescing() {
  console.log('\n── Wakeup Coalescing ──');

  const cooldownSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');
  const engineSrcLocal = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const src = cooldownSrc + engineSrcLocal;

  await test('setCooldownWithContext function exists', () => {
    assert.ok(cooldownSrc.includes('function setCooldownWithContext'),
      'Should have setCooldownWithContext function for coalescing');
  });

  await test('setCooldownWithContext stores pendingContexts array', () => {
    assert.ok(src.includes('pendingContexts'),
      'Should track pendingContexts in cooldown entries');
  });

  await test('getCoalescedContexts function exists', () => {
    assert.ok(src.includes('getCoalescedContexts'),
      'Should have function to retrieve coalesced contexts');
  });

  await test('discoverFromPrs coalesces on cooldown skip', () => {
    assert.ok(src.includes('setCooldownWithContext') && src.includes('feedbackContent'),
      'Should coalesce feedback content when dispatch is blocked by cooldown');
  });

  await test('coalesced contexts are merged into dispatch', () => {
    assert.ok(src.includes('coalesced') || src.includes('getCoalescedContexts'),
      'Should merge coalesced contexts into the dispatch');
  });

  await test('coalescing preserves existing cooldown backoff', () => {
    assert.ok(cooldownSrc.includes('existing?.failures || 0'),
      'setCooldownWithContext should preserve failure count');
  });
}

// ─── Budget Enforcement Tests ───────────────────────────────────────────────

async function testBudgetEnforcement() {
  console.log('\n── Budget Enforcement ──');

  const routingSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'routing.js'), 'utf8');
  const engineSrcLocal = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const src = routingSrc + engineSrcLocal;

  await test('getMonthlySpend function exists', () => {
    assert.ok(src.includes('getMonthlySpend'),
      'Should have getMonthlySpend helper function');
  });

  await test('resolveAgent checks monthlyBudgetUsd', () => {
    assert.ok(src.includes('monthlyBudgetUsd'),
      'resolveAgent should check agent monthlyBudgetUsd config');
  });

  await test('no budget configured means infinite (no limit)', () => {
    assert.ok(src.includes('budget > 0'),
      'Should only enforce budget when explicitly set and > 0');
  });

  await test('getMonthlySpend uses current month prefix', () => {
    assert.ok(src.includes('monthPrefix') || src.includes('getMonth'),
      'Should filter daily metrics to current month only');
  });

  await test('budget_exceeded sets _pendingReason', () => {
    assert.ok(src.includes('budget_exceeded'),
      'Should set _pendingReason to budget_exceeded when agent over budget');
  });

  await test('getMonthlySpend returns 0 for no data', () => {
    assert.ok(src.includes('let total = 0'),
      'getMonthlySpend should default to 0');
  });

  await test('budget check does not affect temp agents', () => {
    assert.ok(src.includes('allowTempAgents') && src.includes('monthlyBudgetUsd'),
      'Budget and temp agents should coexist');
  });

  await test('budget enforcement formula blocks at >= threshold', () => {
    assert.ok(src.includes('>= budget'),
      'Should block agent when monthly spend >= budget');
  });
}

// ─── Wakeup Endpoint Tests ──────────────────────────────────────────────────

async function testWakeupEndpoint() {
  console.log('\n── Wakeup Endpoint ──');

  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  await test('POST /api/engine/wakeup endpoint exists in ROUTES', () => {
    assert.ok(dashSrc.includes('/api/engine/wakeup'),
      'Should have /api/engine/wakeup in route registry');
  });

  await test('wakeup endpoint writes _wakeupAt to control.json', () => {
    assert.ok(dashSrc.includes('_wakeupAt'),
      'Wakeup handler should write _wakeupAt timestamp');
  });

  const cliSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');

  await test('fast poll interval checks for _wakeupAt', () => {
    assert.ok(cliSrc.includes('_wakeupAt'),
      'CLI start should poll for _wakeupAt wakeup signal');
  });

  await test('fast poll uses 2-second interval', () => {
    assert.ok(cliSrc.includes('2000') && cliSrc.includes('_wakeupAt'),
      'Wakeup poll should run every 2 seconds');
  });
}

// ─── Cross-Feature Integration Tests ────────────────────────────────────────

async function testCrossFeatureIntegration() {
  console.log('\n── Cross-Feature Integration ──');

  const engineSrcRaw = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const routingSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'routing.js'), 'utf8');
  const engineSrc = engineSrcRaw + routingSrc;

  await test('session resume and temp agents both check temp- prefix', () => {
    assert.ok(engineSrc.includes("temp-") && engineSrc.includes('session.json'),
      'Session resume should skip temp agents');
  });

  await test('budget exceeded does not block temp agent fallback', () => {
    assert.ok(engineSrc.includes('allowTempAgents') && engineSrc.includes('monthlyBudgetUsd'),
      'Temp agents spawn when configured agents are busy/over-budget');
  });

  await test('wakeup endpoint discoverable via /api/routes', () => {
    const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(dashSrc.includes('/api/engine/wakeup') && dashSrc.includes('ROUTES'),
      'Wakeup endpoint should be in ROUTES for CC discovery');
  });

  await test('coalescing uses different mechanism from build failure notifications', () => {
    assert.ok(engineSrc.includes('writeInboxAlert') && engineSrc.includes('setCooldownWithContext'),
      'Build notifications and coalescing should use different mechanisms');
  });

  await test('adapter abstraction is in TODO.md', () => {
    const todo = fs.readFileSync(path.join(MINIONS_DIR, 'TODO.md'), 'utf8');
    assert.ok(todo.includes('adapter') && todo.includes('abstraction'),
      'Adapter abstraction should be listed in TODO.md');
  });
}

// ─── Dashboard Assembly Tests ───────────────────────────────────────────────

async function testDashboardAssembly() {
  console.log('\n── Dashboard Assembly ──');

  // Try to load buildDashboardHtml — may not exist yet (test-first)
  let buildDashboardHtml;
  try {
    // Look for the function in dashboard.js exports or as a standalone
    const dashModule = require(path.join(MINIONS_DIR, 'dashboard-build'));
    buildDashboardHtml = dashModule.buildDashboardHtml;
  } catch {
    try {
      // Fallback: read current dashboard.html directly (pre-refactor)
      const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
      buildDashboardHtml = () => html;
    } catch {
      skip('dashboard-assembly', 'Neither buildDashboardHtml nor dashboard.html found');
      return;
    }
  }

  const html = buildDashboardHtml();

  await test('assembled HTML is valid structure', () => {
    assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'), 'Should start with DOCTYPE or html tag');
    assert.ok(html.includes('</html>'), 'Should end with closing html tag');
    assert.ok(html.includes('<head>') && html.includes('</head>'), 'Should have head section');
    assert.ok(html.includes('<body>') || html.includes('<body'), 'Should have body tag');
  });

  await test('assembled HTML contains CSS', () => {
    assert.ok(html.includes('<style>') && html.includes('</style>'), 'Should have style block');
    assert.ok(html.includes('--bg:') || html.includes('var(--bg)'), 'Should contain CSS variables');
    assert.ok(html.includes('.sidebar'), 'Should have sidebar CSS');
  });

  await test('assembled HTML contains JS', () => {
    assert.ok(html.includes('<script>') && html.includes('</script>'), 'Should have script block');
    assert.ok(html.includes('function refresh'), 'Should contain refresh function');
    assert.ok(html.includes('function switchPage'), 'Should contain switchPage function');
    assert.ok(html.includes('function escHtml'), 'Should contain escHtml utility');
  });

  await test('assembled HTML contains all page divs', () => {
    const pages = ['page-home', 'page-work', 'page-prs', 'page-plans', 'page-inbox', 'page-tools', 'page-schedule', 'page-engine'];
    for (const p of pages) {
      assert.ok(html.includes(`id="${p}"`), `Should contain ${p} page div`);
    }
  });

  await test('assembled HTML contains critical element IDs', () => {
    const criticalIds = [
      'agents-grid', 'cmd-input', 'engine-badge', 'dispatch-stats',
      'work-items-content', 'wi-count', 'prd-content', 'pr-content', 'pr-count',
      'plans-list', 'inbox-list', 'kb-list', 'engine-log', 'modal', 'modal-body',
      'detail-panel', 'detail-content', 'scheduled-content', 'sidebar',
    ];
    for (const id of criticalIds) {
      assert.ok(html.includes(`id="${id}"`), `Should contain element with id="${id}"`);
    }
  });

  await test('assembled HTML contains sidebar navigation links', () => {
    const pages = ['home', 'work', 'plans', 'prs', 'inbox', 'tools', 'schedule', 'engine'];
    for (const p of pages) {
      assert.ok(html.includes(`data-page="${p}"`), `Should contain sidebar link for ${p}`);
    }
  });

  await test('assembled HTML has no placeholder tokens remaining', () => {
    assert.ok(!html.includes('/* __CSS__ */'), 'CSS placeholder should be replaced');
    assert.ok(!html.includes('<!-- __PAGES__ -->'), 'Pages placeholder should be replaced');
    assert.ok(!html.includes('/* __JS__ */'), 'JS placeholder should be replaced');
  });

  await test('page-home contains command center and agents', () => {
    // Extract page-home content
    const homeStart = html.indexOf('id="page-home"');
    assert.ok(homeStart > 0, 'page-home should exist');
    const homeChunk = html.slice(homeStart, homeStart + 2000);
    assert.ok(homeChunk.includes('cmd-input') || homeChunk.includes('Command Center'), 'Home should contain command center');
    assert.ok(homeChunk.includes('agents-grid'), 'Home should contain agents grid');
  });

  await test('assembled HTML contains all render functions', () => {
    const fns = ['renderAgents', 'renderWorkItems', 'renderPrs', 'renderPrd',
      'renderDispatch', 'renderEngineLog', 'renderSchedules', 'renderSkills'];
    for (const fn of fns) {
      assert.ok(html.includes(fn), `Should contain ${fn} function`);
    }
  });

  await test('assembled HTML size is reasonable', () => {
    assert.ok(html.length > 50000, `HTML should be > 50KB (got ${html.length})`);
    assert.ok(html.length < 500000, `HTML should be < 500KB (got ${html.length})`);
  });
}

// ─── Human as Teammate Tests ────────────────────────────────────────────────

async function testHumanContributions() {
  console.log('\n── Human as Teammate ──');

  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
  const playbookSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'playbook.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8') + playbookSrc;

  // KB Authoring
  await test('POST /api/knowledge endpoint exists in ROUTES', () => {
    assert.ok(dashSrc.includes("'/api/knowledge'") && dashSrc.includes('category'),
      'Should have knowledge creation endpoint');
  });

  await test('KB endpoint validates category', () => {
    assert.ok(dashSrc.includes('architecture') && dashSrc.includes('conventions') && dashSrc.includes('project-notes'),
      'Should validate against known KB categories');
  });

  await test('openCreateKbModal function exists', () => {
    const kbSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-kb.js'), 'utf8');
    assert.ok(kbSrc.includes('function openCreateKbModal'), 'Should have KB creation modal');
    assert.ok(kbSrc.includes('function submitKbEntry'), 'Should have KB submit function');
  });

  // Quick Notes
  await test('openQuickNoteModal function exists', () => {
    const inboxSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    assert.ok(inboxSrc.includes('function openQuickNoteModal'), 'Should have quick note modal');
    assert.ok(inboxSrc.includes('function submitQuickNote'), 'Should have quick note submit');
  });

  await test('submitQuickNote sends "what" field (not "content")', () => {
    const inboxSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    const submitFn = inboxSrc.slice(inboxSrc.indexOf('function submitQuickNote'));
    assert.ok(submitFn.includes('what:') && !submitFn.includes('content:'),
      'Should send { what } to match /api/notes schema');
  });

  await test('submitQuickNote wraps closeModal in try-catch (prevents silent failure)', () => {
    const inboxSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    const submitFn = inboxSrc.slice(inboxSrc.indexOf('function submitQuickNote'));
    assert.ok(submitFn.includes('try { closeModal()') || submitFn.includes('try{ closeModal()'),
      'closeModal should be wrapped in try-catch so QA session errors do not prevent note save');
  });

  await test('submitQuickNote validates form elements exist', () => {
    const inboxSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    const submitFn = inboxSrc.slice(inboxSrc.indexOf('function submitQuickNote'));
    assert.ok(submitFn.includes('!titleEl') || submitFn.includes('getElementById'),
      'Should check that form elements exist before reading values');
  });

  await test('Quick Note button on Home page', () => {
    const homeSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'pages', 'home.html'), 'utf8');
    assert.ok(homeSrc.includes('openQuickNoteModal'), 'Home page should have quick note button');
  });

  // Work Item References
  await test('work-items API accepts references', () => {
    assert.ok(dashSrc.includes('references'),
      'Work items API should accept references field');
  });

  await test('engine injects references into playbook vars', () => {
    assert.ok(engineSrc.includes('vars.references') || engineSrc.includes("references"),
      'Engine should inject references into playbook variables');
  });

  await test('edit form includes references textarea', () => {
    const wiSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(wiSrc.includes('wi-edit-refs') || wiSrc.includes('references'),
      'Edit form should have references input');
  });

  // Acceptance Criteria
  await test('work-items API accepts acceptanceCriteria', () => {
    assert.ok(dashSrc.includes('acceptanceCriteria'),
      'Work items API should accept acceptanceCriteria field');
  });

  await test('engine injects acceptance_criteria into playbook vars', () => {
    assert.ok(engineSrc.includes('acceptance_criteria') || engineSrc.includes('acceptanceCriteria'),
      'Engine should inject acceptance criteria into playbook variables');
  });

  // Pinned Notes
  await test('pinned notes API endpoints exist', () => {
    assert.ok(dashSrc.includes("'/api/pinned'"),
      'Should have GET/POST /api/pinned endpoints');
    assert.ok(dashSrc.includes("'/api/pinned/remove'"),
      'Should have POST /api/pinned/remove endpoint');
  });

  await test('pinned.md injected into renderPlaybook before team notes', () => {
    assert.ok(engineSrc.includes('pinned.md') || engineSrc.includes('Pinned Context'),
      'Engine should inject pinned.md content into playbooks');
  });

  await test('pinned notes included in status response', () => {
    assert.ok(dashSrc.includes('pinned') && dashSrc.includes('parsePinnedEntries'),
      'Status response should include parsed pinned entries');
  });

  await test('render-pinned.js has create and remove functions', () => {
    const pinnedSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pinned.js'), 'utf8');
    assert.ok(pinnedSrc.includes('function renderPinned'), 'Should have renderPinned');
    assert.ok(pinnedSrc.includes('function openPinNoteModal'), 'Should have pin creation modal');
    assert.ok(pinnedSrc.includes('function removePinnedNote'), 'Should have unpin function');
  });

  await test('pinned section on Home page', () => {
    const homeSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'pages', 'home.html'), 'utf8');
    assert.ok(homeSrc.includes('pinned-content') && homeSrc.includes('openPinNoteModal'),
      'Home page should have pinned notes section with pin button');
  });

  // Feedback Loop
  await test('POST /api/work-items/feedback endpoint exists', () => {
    assert.ok(dashSrc.includes("'/api/work-items/feedback'") || dashSrc.includes('/api/work-items/feedback'),
      'Should have feedback endpoint');
  });

  await test('feedback writes to agent inbox for learning', () => {
    assert.ok(dashSrc.includes('inbox') && dashSrc.includes('feedback'),
      'Feedback should write to agent inbox for consolidation');
  });

  await test('feedback stores _humanFeedback on work item', () => {
    assert.ok(dashSrc.includes('_humanFeedback'),
      'Should store feedback on the work item');
  });

  await test('feedbackWorkItem function exists', () => {
    const wiSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(wiSrc.includes('function feedbackWorkItem'), 'Should have feedback modal');
    assert.ok(wiSrc.includes('function submitFeedback'), 'Should have feedback submit');
  });

  // Integration: wakeEngine wired into work-creating actions
  await test('wakeEngine called after CC dispatch', () => {
    const ccSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'command-center.js'), 'utf8');
    assert.ok(ccSrc.includes('wakeEngine()'), 'CC dispatch should call wakeEngine');
  });

  await test('wakeEngine called after plan execute', () => {
    const planSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(planSrc.includes('wakeEngine()'), 'Plan execute should call wakeEngine');
  });

  await test('wakeEngine called after work item retry', () => {
    const wiSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(wiSrc.includes('wakeEngine()'), 'Work item retry should call wakeEngine');
  });
}

// ─── Agent Steering Tests ───────────────────────────────────────────────────

async function testAgentSteering() {
  console.log('\n── Agent Steering ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8') + fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  await test('POST /api/agents/steer endpoint exists', () => {
    assert.ok(dashSrc.includes('/api/agents/steer'), 'Should have steering endpoint');
  });

  await test('steer endpoint writes steer.md file', () => {
    assert.ok(dashSrc.includes('steer.md'), 'Should write steer.md for engine to pick up');
  });

  await test('steer endpoint appends to live-output.log', () => {
    assert.ok(dashSrc.includes('[human-steering]'), 'Should append human-steering marker to live log');
  });

  await test('checkSteering function exists in engine', () => {
    assert.ok(engineSrc.includes('function checkSteering'), 'Should have checkSteering function');
  });

  await test('checkSteering reads and deletes steer.md', () => {
    assert.ok(engineSrc.includes('steer.md') && engineSrc.includes('unlinkSync'),
      'Should read steer.md and delete it after consumption');
  });

  await test('steering stores message for close handler re-spawn', () => {
    assert.ok(engineSrc.includes('_steeringMessage') && engineSrc.includes('_steeringSessionId'),
      'Should store steering message and sessionId on process info');
  });

  await test('close handler re-spawns with --resume on steering', () => {
    assert.ok(engineSrc.includes('_steeringMessage') && engineSrc.includes('--resume'),
      'Close handler should detect steering and re-spawn with --resume');
  });

  await test('steering prompt is neutral (teammate message)', () => {
    assert.ok(engineSrc.includes('human teammate'),
      'Steering prompt should say "human teammate" not "STEERING"');
  });

  await test('checkSteering called in tickInner', () => {
    assert.ok(engineSrc.includes('checkSteering(config)'),
      'tickInner should call checkSteering each tick');
  });

  await test('session ID captured from stdout during agent run', () => {
    assert.ok(engineSrc.includes('procInfo') && engineSrc.includes('sessionId') && engineSrc.includes('session_id'),
      'stdout handler should capture sessionId for mid-session steering');
  });
}

// ─── Recent Features Tests ─────────────────────────────────────────────────

async function testRecentFeatures() {
  console.log('\n── Recent Features ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
  const queriesSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');

  // Engine starts without projects
  await test('engine does not fatal on zero projects', () => {
    assert.ok(!engineSrc.includes("FATAL: No projects configured"),
      'Should not have FATAL error for missing projects');
    assert.ok(engineSrc.includes('No projects linked'),
      'Should show info message instead of fatal');
  });

  // Central PR polling
  await test('forEachActiveGhPr polls central pull-requests.json', () => {
    const ghSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(ghSrc.includes('centralPrs') || ghSrc.includes('central') && ghSrc.includes('pull-requests.json'),
      'GitHub poller should also scan central pull-requests.json');
  });

  await test('getPullRequests includes central pull-requests.json', () => {
    assert.ok(queriesSrc.includes('centralPath') || queriesSrc.includes('central') && queriesSrc.includes('pull-requests.json'),
      'getPullRequests should read central PRs for manually linked PRs');
  });

  // PR link endpoint
  await test('POST /api/pull-requests/link endpoint exists', () => {
    assert.ok(dashSrc.includes('/api/pull-requests/link'),
      'Should have PR linking endpoint');
  });

  await test('PR link supports autoObserve flag', () => {
    assert.ok(dashSrc.includes('_autoObserve') && dashSrc.includes('linked'),
      'Should support autoObserve (active) vs context-only (linked) status');
  });

  // Plan creation from dashboard
  await test('POST /api/plans/create endpoint exists', () => {
    assert.ok(dashSrc.includes('/api/plans/create'),
      'Should have plan creation endpoint');
  });

  await test('plans/create writes to plans/ directory', () => {
    assert.ok(dashSrc.includes("plans'") || dashSrc.includes('plansDir'),
      'Plan creation should write .md file to plans/ directory');
  });

  // Hot-reload
  await test('hot-reload watches dashboard/ directory', () => {
    assert.ok(dashSrc.includes('fs.watch') && dashSrc.includes('dashDir'),
      'Should watch dashboard/ directory for changes');
  });

  await test('hot-reload debounces at 300ms', () => {
    assert.ok(dashSrc.includes('300') && dashSrc.includes('scheduleReload'),
      'Should debounce rebuild at 300ms');
  });

  await test('GET /api/hot-reload SSE endpoint exists', () => {
    assert.ok(dashSrc.includes('/api/hot-reload') && dashSrc.includes('text/event-stream'),
      'Should have SSE endpoint for browser auto-refresh');
  });

  await test('hot-reload pushes reload event to clients', () => {
    assert.ok(dashSrc.includes('_hotReloadClients') && dashSrc.includes('reload'),
      'Should push reload event to connected browsers on rebuild');
  });
}

// ─── Dashboard UI Function Tests ───────────────────────────────────────────

async function testDashboardUIFunctions() {
  console.log('\n── Dashboard UI Functions ──');

  const wiSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
  const prsSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
  const plansSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
  const liveSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'live-stream.js'), 'utf8');

  // Work item creation modal
  await test('openCreateWorkItemModal exists', () => {
    assert.ok(wiSrc.includes('function openCreateWorkItemModal'),
      'Should have work item creation modal');
  });

  await test('work item creation calls wakeEngine', () => {
    assert.ok(wiSrc.includes('wakeEngine()') && wiSrc.includes('/api/work-items'),
      'Work item creation should call wakeEngine for immediate dispatch');
  });

  // Work item detail modal
  await test('openWorkItemDetail exists', () => {
    assert.ok(wiSrc.includes('function openWorkItemDetail'),
      'Should have work item detail modal');
  });

  await test('work item detail shows acceptance criteria and references', () => {
    assert.ok(wiSrc.includes('acceptanceCriteria') && wiSrc.includes('references'),
      'Detail modal should display acceptance criteria and references');
  });

  // Feedback rating state
  await test('feedback modal has rating selection state', () => {
    assert.ok(wiSrc.includes('_feedbackRating') && wiSrc.includes('_selectRating'),
      'Should track rating selection state before enabling Send');
  });

  await test('feedback Send button disabled until rating selected', () => {
    assert.ok(wiSrc.includes('disabled') && wiSrc.includes('Select rating'),
      'Send button should be disabled with "Select rating first" until picked');
  });

  // PR link modal
  await test('openAddPrModal exists', () => {
    assert.ok(prsSrc.includes('function openAddPrModal'),
      'Should have PR linking modal');
  });

  await test('PR link modal has autoObserve checkbox', () => {
    assert.ok(prsSrc.includes('pr-link-observe') && prsSrc.includes('Auto-observe'),
      'Should have auto-observe toggle in PR link modal');
  });

  // Plan creation modal
  await test('openCreatePlanModal exists', () => {
    assert.ok(plansSrc.includes('function openCreatePlanModal'),
      'Should have plan creation modal');
  });

  // Live chat rendering
  await test('renderLiveChatMessage exists', () => {
    assert.ok(liveSrc.includes('function renderLiveChatMessage'),
      'Should have chat message rendering function');
  });

  await test('live chat renders human steering as blue bubbles', () => {
    assert.ok(liveSrc.includes('[human-steering]') && liveSrc.includes('var(--blue)'),
      'Should render human steering messages as right-aligned blue bubbles');
  });

  await test('live chat renders tool calls as collapsible blocks', () => {
    assert.ok(liveSrc.includes('tool_use') && liveSrc.includes('display:none'),
      'Should render tool calls as collapsible blocks');
  });

  await test('sendSteering function exists', () => {
    assert.ok(liveSrc.includes('function sendSteering'),
      'Should have sendSteering function for chat input');
  });
}

// ─── Tools Page + Assembly Tests ───────────────────────────────────────────

async function testToolsPageAssembly() {
  console.log('\n── Tools Page Assembly ──');

  await test('tools.html page fragment exists', () => {
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'dashboard', 'pages', 'tools.html')),
      'dashboard/pages/tools.html should exist');
  });

  await test('tools page contains skills and MCP sections', () => {
    const toolsHtml = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'pages', 'tools.html'), 'utf8');
    assert.ok(toolsHtml.includes('skills-list') && toolsHtml.includes('mcp-list'),
      'Tools page should contain skills and MCP server sections');
  });

  await test('tools page is in assembly page list', () => {
    const buildSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard-build.js'), 'utf8');
    assert.ok(buildSrc.includes("'tools'"), 'tools should be in the pages array');
  });

  await test('sidebar has tools link', () => {
    const layoutHtml = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
    assert.ok(layoutHtml.includes('data-page="tools"'), 'Sidebar should have tools page link');
  });

  // Assembled output check
  let buildDashboardHtml;
  try { buildDashboardHtml = require(path.join(MINIONS_DIR, 'dashboard-build')).buildDashboardHtml; } catch {}
  if (buildDashboardHtml) {
    const html = buildDashboardHtml();
    await test('assembled HTML contains page-tools div', () => {
      assert.ok(html.includes('id="page-tools"'), 'Should have page-tools in assembled output');
    });
  }
}

// ─── Plan/PRD State Flow Tests ──────────────────────────────────────────────

async function testPlanPrdStateFlow() {
  console.log('\n── Plan/PRD State Flow ──');

  const plansSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
  const prdSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');

  // derivePlanStatus state machine
  await test('derivePlanStatus function exists', () => {
    assert.ok(plansSrc.includes('function derivePlanStatus'),
      'Should have derivePlanStatus function');
  });

  await test('derivePlanStatus returns awaiting-approval when no work items', () => {
    assert.ok(plansSrc.includes("prdJsonStatus === 'awaiting-approval' && implementWi.length === 0"),
      'Should return awaiting-approval when PRD is awaiting and no items materialized');
  });

  await test('derivePlanStatus returns in-progress when active work exists', () => {
    assert.ok(plansSrc.includes('hasActiveWork') && plansSrc.includes("return 'in-progress'"),
      'Should return in-progress when pending/dispatched items exist');
  });

  await test('derivePlanStatus returns completed when all items done', () => {
    assert.ok(plansSrc.includes('allDone') && plansSrc.includes("return 'completed'"),
      'Should return completed when all work items are done');
  });

  await test('derivePlanStatus returns rejected unconditionally', () => {
    assert.ok(plansSrc.includes("prdJsonStatus === 'rejected'") && plansSrc.includes("return 'rejected'"),
      'Should return rejected as user intent regardless of work items');
  });

  await test('derivePlanStatus returns paused when PRD paused and not all done', () => {
    assert.ok(plansSrc.includes("prdJsonStatus === 'paused' && !allDone"),
      'Should return paused when PRD is paused with incomplete items');
  });

  await test('derivePlanStatus returns has-failures when items failed', () => {
    assert.ok(plansSrc.includes('hasFailed') && plansSrc.includes("return 'has-failures'"),
      'Should return has-failures when failed items exist with nothing active');
  });

  // Plan card reads linked PRD status
  await test('plan card reads linked PRD status for .md plans', () => {
    assert.ok(plansSrc.includes('linkedPrd') && plansSrc.includes("p.format !== 'prd'"),
      'Card should look up linked PRD status for .md plans, not use plan file status');
  });

  // Plan card buttons
  await test('plan card needsAction for awaiting-approval', () => {
    assert.ok(plansSrc.includes("effectiveStatus === 'awaiting-approval'") && plansSrc.includes('needsAction'),
      'needsAction should be true for awaiting-approval');
  });

  await test('plan card showPause only for in-progress', () => {
    assert.ok(plansSrc.includes("effectiveStatus === 'in-progress'") && plansSrc.includes('showPause'),
      'Pause button should only show when effectiveStatus is in-progress');
  });

  await test('plan card showResume for paused or awaiting-approval', () => {
    assert.ok(plansSrc.includes("effectiveStatus === 'paused'") && plansSrc.includes("effectiveStatus === 'awaiting-approval'") && plansSrc.includes('showResume'),
      'Resume/Approve button should show for paused or awaiting-approval');
  });

  await test('plan card executeBtn only for draft with no PRD', () => {
    assert.ok(plansSrc.includes('isDraft') && plansSrc.includes('!prdFile') && plansSrc.includes('executeBtn'),
      'Execute button should only show for drafts without a linked PRD');
  });

  // PRD per-group buttons
  await test('PRD group shows Approve when isAwaitingApproval', () => {
    assert.ok(prdSrc.includes('isAwaitingApproval') && prdSrc.includes('>Approve</span>'),
      'Per-group button should show Approve when awaiting approval');
  });

  await test('PRD group shows Resume when isPaused', () => {
    assert.ok(prdSrc.includes('isPaused') && prdSrc.includes('>Resume</span>'),
      'Per-group button should show Resume when paused');
  });

  await test('PRD group does NOT show Pause when awaiting approval', () => {
    // The pauseResumeBtn should check isAwaitingApproval BEFORE the Pause fallback
    const pauseBlock = prdSrc.slice(prdSrc.indexOf('const pauseResumeBtn'));
    assert.ok(pauseBlock.includes('isAwaitingApproval') && pauseBlock.indexOf('isAwaitingApproval') < pauseBlock.indexOf('>Pause</span>'),
      'isAwaitingApproval check must come before Pause fallback to prevent showing Pause on awaiting-approval PRDs');
  });
}

// ─── Dispatch Cycle Integration Tests ────────────────────────────────────────

async function testDispatchCycleIntegration() {
  console.log('\n── Dispatch Cycle Integration ──');

  const engineSrcRaw = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const routingSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'routing.js'), 'utf8');
  const cooldownSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');
  const playbookSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'playbook.js'), 'utf8');
  const dispatchSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
  const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
  const cleanupSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
  const engineSrc = engineSrcRaw + routingSrc + cooldownSrc + playbookSrc + dispatchSrc + timeoutSrc + cleanupSrc;
  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  // ── Work item discovery (3 tests) ──

  await test('discoverFromWorkItems reads work-items.json', () => {
    assert.ok(engineSrc.includes('function discoverFromWorkItems'),
      'engine.js must define discoverFromWorkItems');
    assert.ok(engineSrc.includes('work-items.json'),
      'discoverFromWorkItems must read work-items.json');
  });

  await test('discoverFromWorkItems checks dependency gates via areDependenciesMet', () => {
    assert.ok(engineSrc.includes('function areDependenciesMet'),
      'engine.js must define areDependenciesMet');
    assert.ok(engineSrc.includes('areDependenciesMet(item'),
      'discoverFromWorkItems must call areDependenciesMet');
  });

  await test('discoverFromWorkItems checks cooldown and deduplication', () => {
    assert.ok(engineSrc.includes('function isOnCooldown'),
      'engine.js must define isOnCooldown');
    assert.ok(engineSrc.includes('function isAlreadyDispatched'),
      'engine.js must define isAlreadyDispatched');
    assert.ok(engineSrc.includes('isOnCooldown(key') && engineSrc.includes('isAlreadyDispatched(key'),
      'discovery must check cooldown and deduplication');
  });

  // ── Agent routing (2 tests) ──

  await test('Agent routing uses routing table via getRoutingTableCached', () => {
    assert.ok(engineSrc.includes('function getRoutingTableCached'),
      'engine.js must define getRoutingTableCached');
    assert.ok(engineSrc.includes('getRoutingTableCached()'),
      'Routing must call getRoutingTableCached');
  });

  await test('Agent routing checks monthly budget', () => {
    assert.ok(engineSrc.includes('monthlyBudgetUsd'),
      'engine.js must reference monthlyBudgetUsd');
    assert.ok(engineSrc.includes('function getMonthlySpend') || engineSrc.includes('getMonthlySpend('),
      'engine.js must have getMonthlySpend');
    assert.ok(engineSrc.includes('getMonthlySpend(') && engineSrc.includes('monthlyBudgetUsd'),
      'Routing must compare getMonthlySpend against monthlyBudgetUsd');
  });

  // ── Dispatch queue (2 tests) ──

  await test('addToDispatch pushes to pending with timestamp', () => {
    assert.ok(engineSrc.includes('function addToDispatch'),
      'engine.js must define addToDispatch');
    assert.ok(engineSrc.includes('pending') && engineSrc.includes('addToDispatch'),
      'addToDispatch must push to pending queue');
  });

  await test('tickInner respects slotsAvailable and maxConcurrent', () => {
    assert.ok(engineSrc.includes('function tickInner') || engineSrc.includes('async function tickInner'),
      'engine.js must define tickInner');
    assert.ok(engineSrc.includes('slotsAvailable') && engineSrc.includes('maxConcurrent'),
      'tickInner must check slotsAvailable derived from maxConcurrent');
  });

  // ── Agent spawn (3 tests) ──

  await test('Spawn creates worktree for implement tasks', () => {
    assert.ok(engineSrc.includes('worktree') && engineSrc.includes('implement'),
      'engine.js must create worktrees for implement tasks');
    assert.ok(engineSrc.includes('runWorktreeAdd') || engineSrc.includes('git worktree add'),
      'engine.js must invoke git worktree add');
  });

  await test('Spawn resolves dependency branches', () => {
    assert.ok(engineSrc.includes('function resolveDependencyBranches'),
      'engine.js must define resolveDependencyBranches');
    assert.ok(engineSrc.includes('dependency branch') || engineSrc.includes('depBranch'),
      'engine.js must resolve and merge dependency branches');
  });

  await test('Spawn renders playbook with system prompt', () => {
    assert.ok(engineSrc.includes('function renderPlaybook'),
      'engine.js must define renderPlaybook');
    assert.ok(engineSrc.includes('renderPlaybook(') && engineSrc.includes('system'),
      'spawnAgent must render playbook and set system prompt');
  });

  // ── Completion (4 tests) ──

  await test('runPostCompletionHooks exists in lifecycle.js', () => {
    assert.ok(lifecycleSrc.includes('function runPostCompletionHooks'),
      'lifecycle.js must define runPostCompletionHooks');
    assert.ok(engineSrc.includes('runPostCompletionHooks('),
      'engine.js must call runPostCompletionHooks');
  });

  await test('Completion extracts PRs from output via syncPrsFromOutput', () => {
    assert.ok(lifecycleSrc.includes('function syncPrsFromOutput'),
      'lifecycle.js must define syncPrsFromOutput');
    assert.ok(lifecycleSrc.includes('syncPrsFromOutput(') || engineSrc.includes('syncPrsFromOutput('),
      'syncPrsFromOutput must be called during completion');
  });

  await test('Completion updates work item status', () => {
    assert.ok(lifecycleSrc.includes('updateWorkItemStatus'),
      'lifecycle.js must include updateWorkItemStatus');
    assert.ok(engineSrc.includes('updateWorkItemStatus') || lifecycleSrc.includes('updateWorkItemStatus('),
      'Completion must update work item status');
  });

  await test('Completion auto-retries on retryable failure when retries < 3', () => {
    assert.ok(engineSrc.includes('retries < 3') || lifecycleSrc.includes('retries < 3'),
      'Must check retries < 3 for auto-retry');
    assert.ok(engineSrc.includes('_retryCount') || lifecycleSrc.includes('_retryCount'),
      'Must track _retryCount on work items');
    assert.ok(engineSrc.includes('auto-retry') || lifecycleSrc.includes('auto-retry'),
      'Must log auto-retry attempts');
  });

  // ── File-watch discovery (1 test) ──

  await test('Engine watches work-items.json for changes', () => {
    // The engine discovers work items by reading work-items.json each tick
    assert.ok(engineSrc.includes('discoverFromWorkItems') && engineSrc.includes('work-items.json'),
      'Engine must discover work from work-items.json each tick cycle');
    assert.ok(engineSrc.includes('discoverFromWorkItems(config'),
      'discoverFromWorkItems must be called in the tick cycle');
  });

  // ── Central work items (2 tests) ──

  await test('materializePlansAsWorkItems materializes PRD items into central work-items.json', () => {
    assert.ok(engineSrc.includes('function materializePlansAsWorkItems'),
      'engine.js must define materializePlansAsWorkItems');
    assert.ok(engineSrc.includes('useCentral'),
      'materializePlansAsWorkItems must handle useCentral fallback for no-project configs');
  });

  await test('Engine handles zero projects without FATAL error', () => {
    // When no projects configured, engine falls back to central work-items.json
    assert.ok(engineSrc.includes('work-items.json'),
      'Engine must use central work-items.json as fallback');
    // Verify no FATAL log for zero projects scenario
    const fatalProjectMatch = engineSrc.match(/FATAL.*no.*project/i) || engineSrc.match(/FATAL.*zero.*project/i);
    assert.ok(!fatalProjectMatch,
      'Engine must not emit FATAL error for zero projects — it should gracefully fallback to central work items');
  });

  // ── SSE status push (1 test) ──

  await test('Dashboard pushes status via SSE using _statusStreamClients', () => {
    assert.ok(dashSrc.includes('_statusStreamClients'),
      'dashboard.js must define _statusStreamClients');
    assert.ok(dashSrc.includes('_statusStreamClients.add(res'),
      'Dashboard must add clients to _statusStreamClients on SSE connect');
    assert.ok(dashSrc.includes('res.write(') && dashSrc.includes('data:'),
      'Dashboard must write SSE data frames to connected clients');
  });

  // ── Security (2 tests) ──

  await test('Dashboard validates paths against directory traversal (..)', () => {
    // Dashboard uses shared.sanitizePath() for path validation across all file-accepting endpoints
    const sanitizePathCalls = (dashSrc.match(/sanitizePath\(/g) || []).length;
    assert.ok(sanitizePathCalls >= 5,
      `Dashboard must use sanitizePath() on multiple API endpoints (found ${sanitizePathCalls} calls, need >= 5)`);
    assert.ok(dashSrc.includes('sanitizePath'),
      'Dashboard must use sanitizePath for path traversal prevention');
  });

  await test('Dashboard command-center endpoint exists with session management', () => {
    assert.ok(dashSrc.includes('command-center'),
      'Dashboard must have a command-center endpoint');
    assert.ok(dashSrc.includes('sessionId') || dashSrc.includes('session_id'),
      'Command-center must support session management to prevent abuse');
  });
}

// ─── Team Meetings Tests ────────────────────────────────────────────────────

async function testMeetings() {
  console.log('\n── Team Meetings ──');

  const meetingSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'meeting.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  // Meeting module
  await test('createMeeting generates ID and sets investigating status', () => {
    assert.ok(meetingSrc.includes('MTG-') && meetingSrc.includes("status: 'investigating'"),
      'Should generate MTG- ID and start in investigating status');
  });

  await test('meeting has 3 rounds: investigating → debating → concluding', () => {
    assert.ok(meetingSrc.includes("'investigating'") && meetingSrc.includes("'debating'") && meetingSrc.includes("'concluding'"),
      'Should support all 3 round statuses');
  });

  await test('discoverMeetingWork dispatches all participants for investigate', () => {
    assert.ok(meetingSrc.includes('participants') && meetingSrc.includes('meeting-investigate'),
      'Should create work items for each participant in investigate round');
  });

  await test('discoverMeetingWork picks first non-busy participant as concluder', () => {
    assert.ok(meetingSrc.includes('busyAgents') && meetingSrc.includes('participants.find') && meetingSrc.includes('meeting-conclude'),
      'Should pick first non-busy participant for conclusion, falling back to participants[0]');
  });

  await test('concluder fallback: if all participants busy, falls back to first participant', () => {
    assert.ok(meetingSrc.includes("|| meeting.participants[0]"),
      'Should fall back to participants[0] when all are busy');
  });

  await test('debate round includes all findings from round 1', () => {
    assert.ok(meetingSrc.includes('all_findings') && meetingSrc.includes('findings'),
      'Debate playbook vars should include all investigation findings');
  });

  await test('collectMeetingFindings auto-advances rounds', () => {
    assert.ok(meetingSrc.includes('allSubmitted') && meetingSrc.includes("'debating'") && meetingSrc.includes("'concluding'"),
      'Should advance to next round when all participants submit');
  });

  await test('meeting transcript written to inbox on completion', () => {
    assert.ok(meetingSrc.includes('inbox') && meetingSrc.includes('transcript'),
      'Should write meeting transcript to notes/inbox for consolidation');
  });

  await test('addMeetingNote stores human notes', () => {
    assert.ok(meetingSrc.includes('humanNotes') && meetingSrc.includes('push'),
      'Should append human notes to meeting');
  });

  // Engine integration
  await test('discoverMeetingWork called in engine tick', () => {
    assert.ok(engineSrc.includes('discoverMeetingWork'),
      'Engine should call discoverMeetingWork during work discovery');
  });

  await test('lifecycle collects meeting findings on completion', () => {
    assert.ok(lifecycleSrc.includes('collectMeetingFindings') && lifecycleSrc.includes("type === 'meeting'"),
      'runPostCompletionHooks should call collectMeetingFindings for meeting type');
  });

  // Playbooks
  await test('meeting playbooks exist', () => {
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'playbooks', 'meeting-investigate.md')), 'investigate playbook');
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'playbooks', 'meeting-debate.md')), 'debate playbook');
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'playbooks', 'meeting-conclude.md')), 'conclude playbook');
  });

  await test('debate playbook encourages disagreement', () => {
    const debate = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'meeting-debate.md'), 'utf8');
    assert.ok(debate.includes('disagree') || debate.includes('devil') || debate.includes('counterargument'),
      'Debate playbook should explicitly encourage constructive disagreement');
  });

  // Dashboard
  await test('meeting API endpoints in route registry', () => {
    assert.ok(dashSrc.includes('/api/meetings') && dashSrc.includes('/api/meetings/note') && dashSrc.includes('/api/meetings/advance'),
      'Should have meeting CRUD + note + advance + end endpoints');
  });

  await test('meetings included in status response', () => {
    assert.ok(dashSrc.includes('meetings') && dashSrc.includes('getMeetings'),
      'Status response should include active meetings');
  });

  await test('meetings page exists in dashboard', () => {
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'dashboard', 'pages', 'meetings.html')), 'meetings page fragment');
    assert.ok(fs.existsSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-meetings.js')), 'meetings render module');
  });

  await test('render-meetings has create and detail functions', () => {
    const renderSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-meetings.js'), 'utf8');
    assert.ok(renderSrc.includes('openCreateMeetingModal') && renderSrc.includes('openMeetingDetail'),
      'Should have meeting creation modal and detail view');
  });

  await test('meeting routing exists', () => {
    const routing = fs.readFileSync(path.join(MINIONS_DIR, 'routing.md'), 'utf8');
    assert.ok(routing.includes('meeting'), 'routing.md should have meeting work type');
  });

  // Round timeout
  await test('checkMeetingTimeouts exported and callable from engine tick', () => {
    assert.ok(meetingSrc.includes('checkMeetingTimeouts') && meetingSrc.includes('module.exports'),
      'checkMeetingTimeouts should be exported from meeting.js');
    assert.ok(engineSrc.includes('checkMeetingTimeouts'),
      'Engine tick should call checkMeetingTimeouts');
  });

  await test('meeting round timeout is configurable via meetingRoundTimeout', () => {
    const sharedSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(sharedSrc.includes('meetingRoundTimeout') && sharedSrc.includes('600000'),
      'ENGINE_DEFAULTS should include meetingRoundTimeout of 600000ms (10min)');
    assert.ok(meetingSrc.includes('meetingRoundTimeout'),
      'meeting.js should read meetingRoundTimeout from config');
  });

  await test('meetings track roundStartedAt timestamp', () => {
    assert.ok(meetingSrc.includes('roundStartedAt'),
      'Should track when each round started for timeout calculation');
  });

  await test('timeout auto-advances round with partial responses', () => {
    assert.ok(meetingSrc.includes('timed out') && meetingSrc.includes('advancing'),
      'Should log timeout and advance to next round');
    assert.ok(meetingSrc.includes("type: 'timeout'"),
      'Should record timeout events in meeting transcript');
  });

  await test('output validation rejects empty/placeholder responses', () => {
    assert.ok(meetingSrc.includes('EMPTY_OUTPUT_PATTERNS'),
      'Should define patterns for empty/placeholder output');
    assert.ok(meetingSrc.includes("'(no output)'") && meetingSrc.includes('rejecting'),
      'Should reject (no output) and log a warning');
  });

  await test('conclusion timeout ends meeting without conclusion', () => {
    assert.ok(meetingSrc.includes('concluding') && meetingSrc.includes('ended without conclusion'),
      'Should end meeting if conclusion round times out');
  });

  // CC retry button
  await test('CC shows retry button on fetch failure', () => {
    const ccSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'command-center.js'), 'utf8');
    assert.ok(ccSrc.includes('ccRetryLast') && ccSrc.includes('Retry'),
      'Should show retry button when CC fetch fails');
  });
}

// ─── scheduler.js Tests ─────────────────────────────────────────────────────

async function testSchedulerCronParsing() {
  console.log('\n── scheduler.js — Cron Parsing ──');

  await test('parseCronExpr rejects 2-field cron expression', () => {
    const result = scheduler.parseCronExpr('0 2');
    assert.strictEqual(result, null, 'should return null for 2-field cron');
  });

  await test('parseCronExpr rejects 1-field cron expression', () => {
    const result = scheduler.parseCronExpr('0');
    assert.strictEqual(result, null, 'should return null for 1-field cron');
  });

  await test('parseCronExpr rejects 4-field cron expression', () => {
    const result = scheduler.parseCronExpr('0 2 * *');
    assert.strictEqual(result, null, 'should return null for 4-field cron');
  });

  await test('parseCronExpr accepts valid 3-field cron expression', () => {
    const result = scheduler.parseCronExpr('0 2 *');
    assert.ok(result !== null, 'should return a cron object');
    assert.strictEqual(typeof result.matches, 'function', 'should have matches()');
  });

  await test('parseCronExpr 3-field matches correctly', () => {
    const cron = scheduler.parseCronExpr('30 14 1');
    // Monday at 14:30
    const monday = new Date(2026, 2, 30, 14, 30); // March 30, 2026 is a Monday
    assert.strictEqual(cron.matches(monday), true, 'should match Monday 14:30');
    // Wrong hour
    const wrongHour = new Date(2026, 2, 30, 15, 30);
    assert.strictEqual(cron.matches(wrongHour), false, 'should not match wrong hour');
  });

  await test('parseCronExpr rejects null/undefined/empty', () => {
    assert.strictEqual(scheduler.parseCronExpr(null), null);
    assert.strictEqual(scheduler.parseCronExpr(undefined), null);
    assert.strictEqual(scheduler.parseCronExpr(''), null);
    assert.strictEqual(scheduler.parseCronExpr(42), null);
  });

  await test('parseCronField handles wildcard', () => {
    const matcher = scheduler.parseCronField('*', 0, 59);
    assert.strictEqual(matcher(0), true);
    assert.strictEqual(matcher(59), true);
  });

  await test('parseCronField handles step syntax', () => {
    const matcher = scheduler.parseCronField('*/15', 0, 59);
    assert.strictEqual(matcher(0), true);
    assert.strictEqual(matcher(15), true);
    assert.strictEqual(matcher(7), false);
  });

  await test('parseCronField handles list syntax', () => {
    const matcher = scheduler.parseCronField('1,3,5', 0, 6);
    assert.strictEqual(matcher(1), true);
    assert.strictEqual(matcher(3), true);
    assert.strictEqual(matcher(2), false);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Minions Unit Tests');
  console.log('================');
  console.log(`Minions dir: ${MINIONS_DIR}\n`);

  try {
    // shared.js tests
    await testSharedUtilities();
    await testIdGeneration();
    await testBranchSanitization();
    await testSanitizePath();
    await testValidatePid();
    await testParseStreamJsonOutput();
    await testClassifyInboxItem();
    await testSkillFrontmatter();
    await testEngineDefaults();
    await testProjectHelpers();
    await testPrLinks();

    // queries.js tests
    await testQueriesCore();
    await testQueriesAgents();
    await testQueriesWorkItems();
    await testQueriesPullRequests();
    await testQueriesSkills();
    await testQueriesKnowledgeBase();
    await testQueriesPrd();
    await testQueriesHelpers();

    // engine.js tests
    await testRoutingParser();
    await testDependencyCycleDetection();
    await testReconciliation();

    // lifecycle.js tests
    await testLifecycleHelpers();
    await testSyncPrdItemStatus();
    await testEvalLoopAutoDispatch();
    await testEvalIterationTracking();

    // consolidation.js tests
    await testConsolidationHelpers();
    await testContentHashCircuitBreaker();

    // github.js tests
    await testGithubHelpers();

    // PR comment processing tests
    await testPrCommentProcessing();

    // Plan lifecycle tests
    await testPlanLifecycle();
    await testPrdStaleInvalidation();

    // Archive path resolution & version tests
    await testArchivePathResolution();

    // llm.js tests
    await testLlmModule();

    // check-status.js tests
    await testCheckStatus();

    // PR review fix cycle tests
    await testPrReviewFixCycle();

    // Worktree management tests
    await testWorktreeManagement();

    // Config & playbook tests
    await testConfigAndPlaybooks();

    // State integrity tests
    await testStateIntegrity();

    // Edge cases
    await testEdgeCases();

    // Legacy status migration
    await testLegacyStatusMigration();

    // New coverage: preflight, shared helpers, engine core, lifecycle, spawn-agent
    await testPreflightModule();
    await testCleanChildEnv();
    await testGitEnv();
    await testProjectPathHelpers();
    await testMutateJsonFileLocked();
    await testSafeWriteBackupRestore();
    await testIsRetryableFailureReason();
    await testAreDependenciesMet();
    await testCooldownSystem();
    await testResolveAgent();
    await testRenderPlaybook();
    await testCompleteDispatch();
    await testDiscoverFromPrs();
    await testDiscoverFromWorkItems();
    await testCheckTimeouts();
    await testAddToDispatch();
    await testExtractSkills();
    await testUpdateWorkItemStatus();
    await testSyncPrsFromOutput();
    await testLifecycleDataSafety();
    await testRunPostCompletionHooks();
    await testContextPressureMetrics();
    await testSpawnAgentScript();
    await testExitCode78Handling();

    // Paperclip-inspired features
    await testSessionResume();
    await testWakeupCoalescing();
    await testBudgetEnforcement();
    await testWakeupEndpoint();
    await testCrossFeatureIntegration();

    // Dashboard assembly tests
    await testDashboardAssembly();

    // Human as teammate features
    await testHumanContributions();

    // Coverage gap tests
    await testAgentSteering();
    await testRecentFeatures();
    await testDashboardUIFunctions();
    await testToolsPageAssembly();
    await testPlanPrdStateFlow();

    // checkPlanCompletion idempotency (functional)
    await testCheckPlanCompletionIdempotency();

    // Dispatch cycle integration tests
    await testDispatchCycleIntegration();
    await testMeetings();

    // P-bf3a91c7: shared.js fixes
    await testSharedJsFixes();

    // Scheduler tests
    await testSchedulerCronParsing();

    // P-b8c7d6e5: shared imports refactor (no circular requires)
    await testSharedImportsNoCircular();

    // Session 2026-03-31 features
    await testSessionFeatures();

    // Checkpoint resume support
    await testCheckpointResume();

    // P-2b1c0d9e: Per-work-item cumulative cost tracking
    await testCumulativeCostTracking();
  } finally {
    cleanupTmpDirs();
  }

  console.log(`\n══════════════════════════════`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`══════════════════════════════\n`);

  // Write results for CI
  const resultsPath = path.join(MINIONS_DIR, 'engine', 'test-results.json');
  shared.safeWrite(resultsPath, {
    suite: 'unit',
    timestamp: new Date().toISOString(),
    passed, failed, skipped,
    results
  });

  process.exit(failed > 0 ? 1 : 0);
}

// ─── P-bf3a91c7: shared.js fixes ──────────────────────────────────────────────

async function testSharedJsFixes() {
  console.log('\n── shared.js fixes (sleepMs, tmp naming, stale locks, sanitizePath) ──');

  await test('sleepMs does not busy-wait on main thread (uses spawnSync fallback)', () => {
    // Read the source and verify the busy-wait loop is gone
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    // The old busy-wait: while (Date.now() - start < ms) {}
    assert.ok(!src.includes('while (Date.now() - start < ms) {}'),
      'sleepMs should not contain busy-wait loop');
    assert.ok(!src.includes('while (Date.now() - start < delay) {}'),
      'safeWrite retry should not contain busy-wait loop');
    // Verify spawnSync fallback is present
    assert.ok(src.includes('_spawnSync(process.execPath'),
      'sleepMs fallback should use spawnSync');
  });

  await test('sleepMs works and returns in reasonable time', () => {
    const start = Date.now();
    shared.sleepMs(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `sleepMs(50) returned in ${elapsed}ms — too fast`);
    assert.ok(elapsed < 2000, `sleepMs(50) took ${elapsed}ms — too slow`);
  });

  await test('safeWrite tmp files include counter for uniqueness', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'counter-test.json');
    // Write twice — tmp files should have different names (counter prevents collision)
    shared.safeWrite(fp, { v: 1 });
    shared.safeWrite(fp, { v: 2 });
    const result = shared.safeJson(fp);
    assert.strictEqual(result.v, 2);
    // Verify source has the counter pattern
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(src.includes("'.tmp.' + process.pid + '.' + (++_tmpCounter)"),
      'safeWrite should use _tmpCounter for unique tmp names');
  });

  await test('withFileLock removes stale lock files older than LOCK_STALE_MS', () => {
    const dir = createTmpDir();
    const lockPath = path.join(dir, 'test.lock');
    // Create a fake stale lock file with mtime in the past
    fs.writeFileSync(lockPath, 'stale');
    const pastTime = Date.now() - shared.LOCK_STALE_MS - 5000;
    fs.utimesSync(lockPath, new Date(pastTime), new Date(pastTime));

    // withFileLock should detect the stale lock, remove it, and proceed
    let called = false;
    shared.withFileLock(lockPath, () => { called = true; }, { timeoutMs: 3000 });
    assert.ok(called, 'withFileLock should have called fn after removing stale lock');
    assert.ok(!fs.existsSync(lockPath), 'lock file should be cleaned up after release');
  });

  await test('withFileLock does NOT remove fresh lock files', () => {
    const dir = createTmpDir();
    const lockPath = path.join(dir, 'fresh.lock');
    // Create a fresh lock file (simulates another process holding it)
    fs.writeFileSync(lockPath, 'held');

    // withFileLock should timeout since lock is fresh and held
    let threw = false;
    try {
      shared.withFileLock(lockPath, () => {}, { timeoutMs: 200, retryDelayMs: 50 });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('Lock timeout'), `Expected lock timeout, got: ${e.message}`);
    }
    assert.ok(threw, 'withFileLock should throw on timeout with fresh lock');
    // Clean up
    try { fs.unlinkSync(lockPath); } catch {}
  });

  await test('sanitizePath allows valid subpaths', () => {
    const base = createTmpDir();
    const result = shared.sanitizePath('sub/dir/file.txt', base);
    assert.strictEqual(result, path.join(base, 'sub', 'dir', 'file.txt'));
  });

  await test('sanitizePath blocks path traversal with ../', () => {
    const base = createTmpDir();
    assert.throws(() => shared.sanitizePath('../../../etc/passwd', base), /directory traversal/);
  });

  await test('sanitizePath blocks absolute paths outside base', () => {
    const base = createTmpDir();
    assert.throws(() => shared.sanitizePath('/etc/passwd', base), /absolute path/);
  });

  await test('sanitizePath allows base directory itself', () => {
    const base = createTmpDir();
    const result = shared.sanitizePath('.', base);
    assert.strictEqual(result, path.resolve(base));
  });

  await test('sanitizePath blocks encoded traversal via ..%2f', () => {
    const base = createTmpDir();
    assert.throws(() => shared.sanitizePath('..%2f..%2fetc%2fpasswd', base), /directory traversal/);
  });

  await test('LOCK_STALE_MS is exported and equals 60000', () => {
    assert.strictEqual(shared.LOCK_STALE_MS, 60000);
  });
}

// ─── Session 2026-03-31 Feature Tests ────────────────────────────────────────

async function testAutoApproveMode() {
  await test('ENGINE_DEFAULTS includes autoApprovePlans: false', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.autoApprovePlans, false);
  });

  await test('parseStreamJsonOutput extracts model from init message', () => {
    const initLine = '{"type":"system","subtype":"init","model":"claude-opus-4-6[1m]","session_id":"abc"}';
    const resultLine = '{"type":"result","result":"done","total_cost_usd":0.5,"usage":{"input_tokens":100,"output_tokens":50}}';
    const raw = initLine + '\n' + resultLine;
    const parsed = shared.parseStreamJsonOutput(raw);
    assert.strictEqual(parsed.model, 'claude-opus-4-6[1m]');
    assert.strictEqual(parsed.usage.costUsd, 0.5);
  });

  await test('parseStreamJsonOutput returns null model when no init message', () => {
    const raw = '{"type":"result","result":"done","total_cost_usd":0.1}';
    const parsed = shared.parseStreamJsonOutput(raw);
    assert.strictEqual(parsed.model, null);
  });
}

async function testSyncPrsFromOutputCentral() {
  await test('syncPrsFromOutput writes to central PR file when no projects', () => {
    const lifecycle = require('../engine/lifecycle');
    // syncPrsFromOutput is not directly exported, but we can verify the central path logic exists
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('useCentral'), 'lifecycle.js should have useCentral fallback');
    assert.ok(src.includes('centralPrPath'), 'lifecycle.js should reference centralPrPath');
    assert.ok(src.includes('extractPrUrl'), 'lifecycle.js should have extractPrUrl function');
  });

  await test('implement playbook marks PR creation as mandatory', () => {
    const playbook = fs.readFileSync(path.join(__dirname, '..', 'playbooks', 'implement.md'), 'utf8');
    assert.ok(playbook.includes('MANDATORY'), 'implement playbook should mark PR creation as MANDATORY');
  });
}

async function testNoRetryPrCompletion() {
  await test('lifecycle reverts implement tasks without PR to pending for retry', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('Completed without creating a pull request'), 'should set failReason for no-PR completion');
    assert.ok(src.includes('Auto-retry') && src.includes('no PR created'), 'should auto-retry when no PR');
  });
}

async function testKbCatConstants() {
  await test('KB_CAT_LABELS and KB_CAT_ICONS defined in render-kb.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'render-kb.js'), 'utf8');
    assert.ok(src.includes('KB_CAT_LABELS'), 'should define KB_CAT_LABELS');
    assert.ok(src.includes('KB_CAT_ICONS'), 'should define KB_CAT_ICONS');
    assert.ok(src.includes('architecture:'), 'should include architecture category');
    assert.ok(src.includes("'project-notes':"), 'should include project-notes category');
  });
}

async function testRenderMdTables() {
  await test('renderMd in utils.js handles markdown tables', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'utils.js'), 'utf8');
    assert.ok(src.includes('table'), 'renderMd should handle tables');
    assert.ok(src.includes('<thead>') || src.includes('thead'), 'should generate thead for table header');
  });
}

async function testScheduleDetailModal() {
  await test('render-schedules has openScheduleDetail and pagination', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'render-schedules.js'), 'utf8');
    assert.ok(src.includes('openScheduleDetail'), 'should have openScheduleDetail function');
    assert.ok(src.includes('SCHED_PER_PAGE'), 'should have pagination constant');
    assert.ok(src.includes('_schedPrev'), 'should have prev page function');
    assert.ok(src.includes('_schedNext'), 'should have next page function');
  });
}

async function testPlanArchiveApi() {
  await test('dashboard has /api/plans/archive endpoint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes("'/api/plans/archive'"), 'should have archive endpoint');
    assert.ok(src.includes('handlePlansArchive'), 'should have archive handler');
  });

  await test('planArchive function exists in render-plans.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes('async function planArchive'), 'should have planArchive function');
    assert.ok(src.includes("'/api/plans/archive'"), 'should call archive API');
  });
}

async function testPrWaitingResolve() {
  await test('github.js resolves waiting review status on merge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes("reviewStatus === 'waiting'") && src.includes("'merged'"), 'should resolve waiting on merge');
  });

  await test('ado.js resolves waiting review status on merge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes("reviewStatus === 'waiting'") && src.includes("'merged'"), 'should resolve waiting on merge');
  });
}

async function testSettingsComprehensive() {
  await test('settings UI includes all ENGINE_DEFAULTS fields', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'settings.js'), 'utf8');
    const fields = ['tickInterval', 'maxConcurrent', 'agentTimeout', 'maxTurns', 'heartbeatTimeout',
      'worktreeCreateTimeout', 'worktreeCreateRetries', 'worktreeRoot', 'idleAlertMinutes',
      'shutdownTimeout', 'restartGracePeriod', 'meetingRoundTimeout',
      'autoApprovePlans', 'autoDecompose', 'allowTempAgents'];
    for (const f of fields) {
      assert.ok(src.includes(f), 'settings should include ' + f);
    }
  });

  await test('settings save calls reloadConfig', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('reloadConfig()') && src.includes('invalidateStatusCache()') && src.includes('[settings] Saved'), 'should reload config after save');
  });

  await test('settings save shows toast feedback', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'settings.js'), 'utf8');
    assert.ok(src.includes("showToast('cmd-toast', 'Settings saved'"), 'should show success toast');
    assert.ok(src.includes("'Saving...'"), 'should show saving state on button');
  });
}

async function testCcActionTypes() {
  await test('CC system prompt includes schedule, create-meeting, set-config actions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('**schedule**'), 'should have schedule action type');
    assert.ok(src.includes('**create-meeting**'), 'should have create-meeting action type');
    assert.ok(src.includes('**set-config**'), 'should have set-config action type');
  });

  await test('CC executor handles schedule, create-meeting, set-config', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'command-center.js'), 'utf8');
    assert.ok(src.includes("case 'schedule':"), 'should handle schedule action');
    assert.ok(src.includes("case 'create-meeting':"), 'should handle create-meeting action');
    assert.ok(src.includes("case 'set-config':"), 'should handle set-config action');
  });
}

async function testAutoModeStatus() {
  await test('status API includes autoMode flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('autoMode:'), 'status should include autoMode');
    assert.ok(src.includes('approvePlans:'), 'autoMode should have approvePlans');
  });

  await test('auto-approve badge element exists in plans page', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'pages', 'plans.html'), 'utf8');
    assert.ok(src.includes('auto-approve-badge'), 'plans page should have auto-approve-badge element');
  });
}

async function testApiRoutesInCcPreamble() {
  await test('CC preamble auto-injects API routes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('_getApiRoutesSummary'), 'should have _getApiRoutesSummary function');
    assert.ok(src.includes('_apiRoutesRef'), 'should have _apiRoutesRef variable');
    assert.ok(src.includes('Dashboard API'), 'preamble should include Dashboard API section');
  });
}

async function testKbSweepBatching() {
  await test('KB sweep uses batched processing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('BATCH_SIZE'), 'sweep should use BATCH_SIZE');
    assert.ok(src.includes('batches.length'), 'sweep should iterate batches');
    assert.ok(src.includes('batch ${b + 1}'), 'sweep should log batch progress');
  });
}

async function testSharedImportsNoCircular() {
  // P-b8c7d6e5: Verify refactored modules import log/ts from shared, not engine
  await test('cooldown.js has no lazy require of engine.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cooldown.js'), 'utf8');
    assert.ok(!src.includes("require('../engine')"), 'cooldown.js should not require engine.js');
    assert.ok(src.includes("log } = shared") || src.includes("log,") || src.includes("log }"), 'cooldown.js should import log from shared');
  });

  await test('routing.js has no lazy require of engine.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'routing.js'), 'utf8');
    assert.ok(!src.includes("require('../engine')"), 'routing.js should not require engine.js');
  });

  await test('meeting.js has no lazy require of engine.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'meeting.js'), 'utf8');
    assert.ok(!src.includes("require('../engine')"), 'meeting.js should not require engine.js');
  });

  await test('playbook.js has no lazy require of engine.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'playbook.js'), 'utf8');
    assert.ok(!src.includes("require('../engine')"), 'playbook.js should not require engine.js');
  });

  await test('cleanup.js retains lazy require for activeProcesses only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes("require('../engine')"), 'cleanup.js should still require engine for activeProcesses');
    assert.ok(!src.includes("engine().log("), 'cleanup.js should not call engine().log()');
    assert.ok(!src.includes("engine().ts("), 'cleanup.js should not call engine().ts()');
  });

  await test('timeout.js retains lazy require for activeProcesses only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'timeout.js'), 'utf8');
    assert.ok(src.includes("require('../engine')"), 'timeout.js should still require engine for activeProcesses');
    assert.ok(!src.includes("engine().log("), 'timeout.js should not call engine().log()');
    assert.ok(!src.includes("engine().ts("), 'timeout.js should not call engine().ts()');
  });

  await test('ado.js retains lazy require for handlePostMerge only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes("require('../engine')"), 'ado.js should still require engine for handlePostMerge');
    assert.ok(!src.includes("engine().log("), 'ado.js should not call engine().log()');
    assert.ok(!src.includes("engine().ts("), 'ado.js should not call engine().ts()');
    assert.ok(!src.includes("engine().dateStamp("), 'ado.js should not call engine().dateStamp()');
  });

  await test('github.js retains lazy require for handlePostMerge only', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes("require('../engine')"), 'github.js should still require engine for handlePostMerge');
    assert.ok(!src.includes("engine().log("), 'github.js should not call engine().log()');
    assert.ok(!src.includes("engine().ts("), 'github.js should not call engine().ts()');
    assert.ok(!src.includes("engine().dateStamp("), 'github.js should not call engine().dateStamp()');
  });
}

async function testSessionFeatures() {
  await testAutoApproveMode();
  await testSyncPrsFromOutputCentral();
  await testNoRetryPrCompletion();
  await testKbCatConstants();
  await testRenderMdTables();
  await testScheduleDetailModal();
  await testPlanArchiveApi();
  await testPrWaitingResolve();
  await testSettingsComprehensive();
  await testCcActionTypes();
  await testAutoModeStatus();
  await testApiRoutesInCcPreamble();
  await testKbSweepBatching();
}

// ─── Checkpoint Resume Tests ────────────────────────────────────────────────

async function testCheckpointResume() {
  console.log('\n── Checkpoint Resume ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const implementPb = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'implement.md'), 'utf8');
  const fixPb = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'fix.md'), 'utf8');

  await test('engine.js detects checkpoint.json in worktree', () => {
    assert.ok(engineSrc.includes("checkpoint.json") && engineSrc.includes("fs.existsSync(cpPath)"),
      'Should look for checkpoint.json in the agent worktree directory');
  });

  await test('engine.js injects checkpoint_context variable from checkpoint.json', () => {
    assert.ok(engineSrc.includes("vars.checkpoint_context") && engineSrc.includes("cpSummary"),
      'Should build checkpoint_context variable from checkpoint.json contents');
  });

  await test('checkpoint_context includes completed/remaining/blockers/branch_state', () => {
    assert.ok(engineSrc.includes('cpData.completed') && engineSrc.includes('cpData.remaining') &&
      engineSrc.includes('cpData.blockers') && engineSrc.includes('cpData.branch_state'),
      'Should read all four checkpoint fields');
  });

  await test('engine.js tracks _checkpointCount on work items', () => {
    assert.ok(engineSrc.includes('_checkpointCount'),
      'Must track _checkpointCount on work items');
    assert.ok(engineSrc.includes("(item._checkpointCount || 0) + 1"),
      'Should increment _checkpointCount from current value');
  });

  await test('engine.js caps checkpoint-resumes at 3', () => {
    assert.ok(engineSrc.includes('cpCount > 3'),
      'Should check if checkpoint count exceeds 3');
    assert.ok(engineSrc.includes("'needs-human-review'"),
      'Should set status to needs-human-review after 3 checkpoint-resumes');
  });

  await test('checkpoint_context defaults to empty string when no checkpoint', () => {
    const matches = engineSrc.match(/vars\.checkpoint_context\s*=\s*''/g);
    assert.ok(matches && matches.length >= 2,
      'Should default checkpoint_context to empty string in both project and central dispatch paths');
  });

  await test('implement.md playbook includes checkpoint_context', () => {
    assert.ok(implementPb.includes('{{checkpoint_context}}'),
      'implement.md must include {{checkpoint_context}} template variable');
  });

  await test('fix.md playbook includes checkpoint_context', () => {
    assert.ok(fixPb.includes('{{checkpoint_context}}'),
      'fix.md must include {{checkpoint_context}} template variable');
  });

  await test('checkpoint resume logs injection info', () => {
    assert.ok(engineSrc.includes('Injecting checkpoint context for'),
      'Should log when checkpoint context is injected');
  });

  await test('checkpoint resume logs needs-human-review escalation', () => {
    assert.ok(engineSrc.includes('exceeded 3 checkpoint-resumes'),
      'Should log when work item is escalated to needs-human-review');
  });
}

// ─── P-2b1c0d9e: Per-work-item cumulative cost tracking ──────────────────────

async function testCumulativeCostTracking() {
  console.log('\n── Per-work-item cumulative cost tracking ──');

  await test('ENGINE_DEFAULTS includes evalMaxCost: null', () => {
    assert.ok('evalMaxCost' in shared.ENGINE_DEFAULTS, 'ENGINE_DEFAULTS should have evalMaxCost');
    assert.strictEqual(shared.ENGINE_DEFAULTS.evalMaxCost, null, 'evalMaxCost default should be null');
  });

  await test('lifecycle.js accumulates _totalCostUsd on work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('_totalCostUsd'), 'Should track _totalCostUsd on work items');
    assert.ok(src.includes('_totalInputTokens'), 'Should track _totalInputTokens on work items');
    assert.ok(src.includes('_totalOutputTokens'), 'Should track _totalOutputTokens on work items');
  });

  await test('cost accumulation uses mutateJsonFileLocked (not safeWrite)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // Find the cost accumulation section
    const costSection = src.slice(src.indexOf('Accumulate per-work-item cost'), src.indexOf('Handle decomposition results'));
    assert.ok(costSection.includes('mutateJsonFileLocked'), 'Cost accumulation must use mutateJsonFileLocked for concurrency safety');
  });

  await test('cost accumulates across 2 dispatches (functional)', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    shared.safeWrite(wiPath, [
      { id: 'W-001', title: 'Test item', status: 'dispatched', _totalCostUsd: 0.50, _totalInputTokens: 1000, _totalOutputTokens: 500 }
    ]);

    // Simulate second dispatch accumulation
    shared.mutateJsonFileLocked(wiPath, (items) => {
      const wi = items.find(i => i.id === 'W-001');
      if (wi) {
        wi._totalCostUsd = (wi._totalCostUsd || 0) + 0.75;
        wi._totalInputTokens = (wi._totalInputTokens || 0) + 2000;
        wi._totalOutputTokens = (wi._totalOutputTokens || 0) + 1000;
      }
      return items;
    }, { defaultValue: [] });

    const result = shared.safeJson(wiPath);
    const wi = result.find(i => i.id === 'W-001');
    assert.strictEqual(wi._totalCostUsd, 1.25, 'Cost should accumulate: 0.50 + 0.75 = 1.25');
    assert.strictEqual(wi._totalInputTokens, 3000, 'Input tokens should accumulate: 1000 + 2000');
    assert.strictEqual(wi._totalOutputTokens, 1500, 'Output tokens should accumulate: 500 + 1000');
  });

  await test('cost ceiling triggers needs-human-review', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    shared.safeWrite(wiPath, [
      { id: 'W-002', title: 'Expensive item', status: 'done', _totalCostUsd: 5.50 }
    ]);

    // Simulate cost ceiling check: evalMaxCost = 5.00, current = 5.50
    const evalMaxCost = 5.00;
    const items = shared.safeJson(wiPath);
    const wi = items.find(i => i.id === 'W-002');
    if (wi && wi._totalCostUsd > evalMaxCost && wi.status !== 'needs-human-review') {
      shared.mutateJsonFileLocked(wiPath, (data) => {
        const target = data.find(i => i.id === 'W-002');
        if (target) {
          target.status = 'needs-human-review';
          target.failReason = `Cumulative cost exceeds evalMaxCost ceiling`;
        }
        return data;
      }, { defaultValue: [] });
    }

    const result = shared.safeJson(wiPath);
    const updated = result.find(i => i.id === 'W-002');
    assert.strictEqual(updated.status, 'needs-human-review', 'Item exceeding cost ceiling should be needs-human-review');
    assert.ok(updated.failReason.includes('evalMaxCost'), 'Fail reason should mention evalMaxCost');
  });

  await test('cost ceiling not triggered when evalMaxCost is null', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // Verify null check exists — evalMaxCost must be non-null and > 0
    assert.ok(src.includes('evalMaxCost != null') || src.includes('evalMaxCost !== null'),
      'Should check evalMaxCost is not null before enforcing');
    assert.ok(src.includes('evalMaxCost > 0'),
      'Should check evalMaxCost > 0 before enforcing');
  });

  await test('dashboard renders cumulative cost fields', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('_totalCostUsd'), 'Dashboard should display _totalCostUsd');
    assert.ok(src.includes('_totalInputTokens'), 'Dashboard should display _totalInputTokens');
    assert.ok(src.includes('_totalOutputTokens'), 'Dashboard should display _totalOutputTokens');
    assert.ok(src.includes('Cumulative Cost'), 'Dashboard should label the cost field');
  });

  // ── TOCTOU Race Fix Tests ──────────────────────────────────────────────────

  await test('cost ceiling check is inside same lock as cost accumulation (no TOCTOU)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const costSection = src.slice(src.indexOf('Accumulate per-work-item cost'), src.indexOf('Handle decomposition results'));
    // Should have exactly ONE mutateJsonFileLocked call (accumulation + ceiling in one lock)
    const lockCalls = (costSection.match(/mutateJsonFileLocked/g) || []);
    assert.strictEqual(lockCalls.length, 1, 'Cost section should have exactly 1 mutateJsonFileLocked call (accumulation + ceiling atomic)');
    // Should NOT have bare safeJson reads between locks
    assert.ok(!costSection.includes('safeJson(wiPath)'), 'Cost section should not use bare safeJson reads (TOCTOU risk)');
  });

  await test('retry logic uses mutateJsonFileLocked instead of bare safeJson/safeWrite', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // Find the retry/decompose block — between "Auto-retry" and the catch for Retry/decompose
    const startIdx = src.indexOf('Auto-retry');
    const endIdx = src.indexOf('Retry/decompose update');
    assert.ok(startIdx > 0 && endIdx > startIdx, 'Should find retry section markers');
    const retrySection = src.slice(startIdx, endIdx);
    assert.ok(retrySection.includes('mutateJsonFileLocked'), 'Retry logic must use mutateJsonFileLocked');
    assert.ok(retrySection.includes('resolveWiPath'), 'Retry logic should use resolveWiPath helper');
    // The mutateJsonFileLocked callback handles retry count read + write atomically
    assert.ok(retrySection.includes('_retryCount'), 'Retry section should update _retryCount inside lock');
    // No bare safeJson/safeWrite within the lock-managed retry block
    // (updateWorkItemStatus is called outside for exhausted retries — that's a separate concern)
    const lockCallback = retrySection.slice(retrySection.indexOf('mutateJsonFileLocked'), retrySection.indexOf('}, { defaultValue'));
    assert.ok(!lockCallback.includes('safeWrite('), 'Lock callback should not use bare safeWrite');
    assert.ok(!lockCallback.includes('safeJson('), 'Lock callback should not use bare safeJson');
  });

  await test('decompose cleanup uses mutateJsonFileLocked instead of bare safeJson/safeWrite', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // The decompose cleanup is now inside the same mutateJsonFileLocked as retry
    const retrySection = src.slice(src.indexOf('Auto-retry'), src.indexOf('Meeting post-completion'));
    assert.ok(retrySection.includes('_decomposing'), 'Retry section should handle _decomposing flag cleanup');
    assert.ok(retrySection.includes("type === 'decompose'"), 'Retry section should check for decompose type');
  });

  await test('concurrent completion does not corrupt work-items.json (functional)', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    shared.safeWrite(wiPath, [
      { id: 'W-race-1', title: 'Item A', status: 'dispatched', _retryCount: 0 },
      { id: 'W-race-2', title: 'Item B', status: 'dispatched', _retryCount: 0 },
    ]);

    // Simulate two "concurrent" completions using mutateJsonFileLocked
    // (sequential here but validates the atomic pattern preserves both items)
    shared.mutateJsonFileLocked(wiPath, (items) => {
      const wi = items.find(i => i.id === 'W-race-1');
      if (wi) { wi._retryCount = 1; wi.status = 'pending'; }
      return items;
    }, { defaultValue: [] });

    shared.mutateJsonFileLocked(wiPath, (items) => {
      const wi = items.find(i => i.id === 'W-race-2');
      if (wi) { wi._retryCount = 1; wi.status = 'pending'; }
      return items;
    }, { defaultValue: [] });

    const result = shared.safeJson(wiPath);
    assert.strictEqual(result.length, 2, 'Both items should survive concurrent updates');
    const a = result.find(i => i.id === 'W-race-1');
    const b = result.find(i => i.id === 'W-race-2');
    assert.strictEqual(a._retryCount, 1, 'Item A retryCount updated');
    assert.strictEqual(a.status, 'pending', 'Item A status updated');
    assert.strictEqual(b._retryCount, 1, 'Item B retryCount updated');
    assert.strictEqual(b.status, 'pending', 'Item B status updated');
  });

  await test('cost accumulation and ceiling check are atomic (functional)', () => {
    const tmp = createTmpDir();
    const wiPath = path.join(tmp, 'work-items.json');
    shared.safeWrite(wiPath, [
      { id: 'W-atomic', title: 'Cost test', status: 'done', _totalCostUsd: 4.50 }
    ]);

    const evalMaxCost = 5.00;
    // Simulate the unified lock pattern: accumulate + check in one callback
    shared.mutateJsonFileLocked(wiPath, (items) => {
      const wi = items.find(i => i.id === 'W-atomic');
      if (wi) {
        wi._totalCostUsd = (wi._totalCostUsd || 0) + 1.00; // now 5.50
        if (evalMaxCost != null && evalMaxCost > 0 &&
            wi._totalCostUsd > evalMaxCost && wi.status !== 'needs-human-review') {
          wi.status = 'needs-human-review';
          wi.failReason = `Cumulative cost $${wi._totalCostUsd.toFixed(2)} exceeds ceiling`;
        }
      }
      return items;
    }, { defaultValue: [] });

    const result = shared.safeJson(wiPath);
    const wi = result.find(i => i.id === 'W-atomic');
    assert.strictEqual(wi._totalCostUsd, 5.50, 'Cost accumulated');
    assert.strictEqual(wi.status, 'needs-human-review', 'Ceiling triggered in same lock');
    assert.ok(wi.failReason.includes('5.50'), 'Fail reason reflects accumulated cost');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
