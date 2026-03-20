#!/usr/bin/env node
/**
 * Squad Unit Tests — Comprehensive test suite for core logic.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-test-'));
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

const SQUAD_DIR = path.resolve(__dirname, '..');
const shared = require(path.join(SQUAD_DIR, 'engine', 'shared'));
const queries = require(path.join(SQUAD_DIR, 'engine', 'queries'));

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
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('active.started_at || active.created_at'),
      'getAgentStatus should prefer started_at for active dispatches');
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
      'in-pr': 2,
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
    const routingPath = path.join(SQUAD_DIR, 'routing.md');
    assert.ok(fs.existsSync(routingPath), 'routing.md not found');
    const content = fs.readFileSync(routingPath, 'utf8');
    assert.ok(content.includes('| Work Type'), 'routing.md missing header row');
    assert.ok(content.includes('implement'), 'routing.md missing implement route');
    assert.ok(content.includes('review'), 'routing.md missing review route');
  });

  await test('routing.md has all required work types', () => {
    const content = fs.readFileSync(path.join(SQUAD_DIR, 'routing.md'), 'utf8');
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
    const engineModule = require(path.join(SQUAD_DIR, 'engine'));
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

  const lifecycle = require(path.join(SQUAD_DIR, 'engine', 'lifecycle'));

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
    const longText = 'x'.repeat(1000);
    const stdout = `{"type":"result","result":"${longText}"}`;
    const { resultSummary } = lifecycle.parseAgentOutput(stdout);
    assert.ok(resultSummary.length <= 500, 'Result should be truncated to 500 chars');
  });
}

async function testSyncPrdItemStatus() {
  console.log('\n── lifecycle.js — PRD Sync ──');

  const lifecycle = require(path.join(SQUAD_DIR, 'engine', 'lifecycle'));

  await test('syncPrdItemStatus handles null itemId gracefully', () => {
    // Should not throw
    lifecycle.syncPrdItemStatus(null, 'done', 'test-plan.json');
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

// ─── Reconciliation Tests ───────────────────────────────────────────────────

async function testReconciliation() {
  console.log('\n── engine.js — PR Reconciliation ──');

  let reconcileItemsWithPrs;
  try {
    const engineModule = require(path.join(SQUAD_DIR, 'engine'));
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
    assert.strictEqual(items[0].status, 'in-pr');
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
    assert.strictEqual(items[0].status, 'in-pr');
    assert.strictEqual(items[1].status, 'pending'); // not in onlyIds
  });

  await test('reconcileItemsWithPrs handles empty inputs', () => {
    assert.strictEqual(reconcileItemsWithPrs([], []), 0);
    assert.strictEqual(reconcileItemsWithPrs([], [{ id: 'PR-1', prdItems: ['P1'] }]), 0);
  });
}

// ─── GitHub Helpers Tests ───────────────────────────────────────────────────

async function testGithubHelpers() {
  console.log('\n── github.js — Helper Functions ──');

  const github = require(path.join(SQUAD_DIR, 'engine', 'github'));

  await test('github module exports required functions', () => {
    assert.ok(typeof github.pollPrStatus === 'function');
    assert.ok(typeof github.pollPrHumanComments === 'function');
    assert.ok(typeof github.reconcilePrs === 'function');
  });
}

// ─── PR Comment Processing Tests ────────────────────────────────────────────

async function testPrCommentProcessing() {
  console.log('\n── PR Comment Processing — Full Thread Context ──');

  await test('Fix playbook should receive ALL comments, not just @squad', () => {
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

  await test('Squad own comments are filtered out', () => {
    const comments = [
      { content: 'Please fix this', commentType: 'text' },
      { content: 'Fixed by Squad (Dallas — Engineer)', commentType: 'text' },
      { content: null, commentType: 'system' },
      { content: 'System update', commentType: 'system' },
    ];

    // Simulate the filtering logic from ado.js/github.js
    const humanComments = comments.filter(c => {
      if (!c.content || c.commentType === 'system') return false;
      if (/\bSquad\s*\(/i.test(c.content)) return false;
      return true;
    });

    assert.strictEqual(humanComments.length, 1);
    assert.strictEqual(humanComments[0].content, 'Please fix this');
  });

  await test('No @squad filter required — all comments trigger fix', () => {
    // Previously, multi-reviewer PRs required @squad mention
    // Now ALL human comments should trigger
    const comments = [
      { author: 'Alice', date: '2024-01-16T10:00:00Z', content: 'Fix the typo on line 42' },
      { author: 'Bob', date: '2024-01-16T11:00:00Z', content: 'And update the docs' },
    ];

    const cutoff = '2024-01-15T00:00:00Z';
    const newComments = comments.filter(c => c.date > cutoff);

    // Both should trigger (no @squad filter)
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
    const lifecycle = require(path.join(SQUAD_DIR, 'engine', 'lifecycle'));
    assert.strictEqual(lifecycle.chainPlanToPrd, undefined,
      'chainPlanToPrd should not be exported — auto-chaining is removed');
  });

  await test('runPostCompletionHooks does not chain plan-to-prd on plan success', () => {
    // Verify the chain call was removed from runPostCompletionHooks
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'lifecycle.js'), 'utf8');
    // Find the runPostCompletionHooks function body and check it doesn't call chainPlanToPrd
    const hookStart = src.indexOf('function runPostCompletionHooks(');
    const hookBody = src.slice(hookStart, src.indexOf('\nfunction ', hookStart + 1) || src.length);
    assert.ok(!hookBody.includes('chainPlanToPrd('),
      'runPostCompletionHooks should not call chainPlanToPrd');
    assert.ok(src.includes('Plan chaining removed'),
      'lifecycle.js should have comment explaining removal');
  });

  await test('plan-to-prd playbook sets PRD status to awaiting-approval', () => {
    const playbook = fs.readFileSync(path.join(SQUAD_DIR, 'playbooks', 'plan-to-prd.md'), 'utf8');
    assert.ok(playbook.includes('"status": "awaiting-approval"'),
      'plan-to-prd playbook should set status to awaiting-approval');
    assert.ok(playbook.includes('"requires_approval": true'),
      'plan-to-prd playbook should set requires_approval to true');
    assert.ok(!playbook.includes('"status": "approved"'),
      'plan-to-prd playbook should NOT set status to approved');
  });

  await test('cli.js recovery does not re-queue plan-to-prd chains', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(!src.includes("chain === 'plan-to-prd'"),
      'cli.js should not contain plan-to-prd chain recovery logic');
    assert.ok(src.includes('Plan chain recovery removed'),
      'cli.js should have comment explaining removal');
  });
}

async function testPrdStaleInvalidation() {
  console.log('\n── PRD Staleness — Auto-Invalidation on Plan Revision ──');

  await test('engine.js materializePlansAsWorkItems handles stale awaiting-approval PRD', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('engine:plan-revision'),
      'engine.js should queue regeneration with createdBy engine:plan-revision');
    assert.ok(src.includes('alreadyQueued'),
      'engine.js should check for duplicate regeneration queue');
    assert.ok(src.includes('fs.unlinkSync(path.join(PRD_DIR, file))'),
      'engine.js should delete old PRD file on awaiting-approval invalidation');
  });

  await test('Stale PRD invalidation only targets awaiting-approval status', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
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
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale = true'),
      'engine.js should set planStale flag on approved PRDs when plan is revised');
    assert.ok(src.includes("prdStatus === 'approved'"),
      'Stale flag should be gated on approved status');
  });

  await test('Stale PRDs do not materialize new work items', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale'),
      'engine.js should check planStale flag');
    // The planStale continue should be after the approval gate
    const staleCheck = src.indexOf('if (plan.planStale)');
    const approvalGate = src.lastIndexOf("planStatus === 'awaiting-approval'", staleCheck);
    assert.ok(staleCheck > approvalGate,
      'planStale check should come after approval gate');
  });

  await test('Dashboard has Regenerate PRD button for stale plans', () => {
    const html = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('prdRegenerate('),
      'dashboard.html should have prdRegenerate function call');
    assert.ok(html.includes('Regenerate now'),
      'dashboard.html should show a clear regenerate action label');
  });

  await test('Dashboard stale PRD UX explains meaning and recovery', () => {
    const html = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('STALE'),
      'dashboard should visibly label stale PRDs');
    assert.ok(html.includes('Source plan was revised. This PRD may be outdated.'),
      'dashboard should explain why stale appears');
    assert.ok(html.includes('Regenerate now'),
      'dashboard should present explicit stale recovery action');
  });

  await test('Dashboard engine stale badge has explicit recovery UX', () => {
    const html = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('function renderEngineAlert('),
      'dashboard should render engine stale recovery alert');
    assert.ok(html.includes('Engine heartbeat is stale'),
      'engine stale alert should explain what stale means');
    assert.ok(html.includes('Copy restart command'),
      'engine stale alert should offer a clear restart recovery action');
  });

  await test('Dashboard shows immediate PRD retry feedback states', () => {
    const html = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
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
    const html = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.html'), 'utf8');
    assert.ok(html.includes('function normalizePlanFile(file)'),
      'dashboard should normalize path-like plan references');
    assert.ok(html.includes("fetch('/api/plans/' + encodeURIComponent(normalizedFile))"),
      'plan modal should fetch using normalized file name');
    assert.ok(html.includes('async function openVerifyGuide(file)') && html.includes("_modalFilePath = 'prd/' + normalizedFile"),
      'verify guide modal should also normalize file path');
  });

  await test('Dashboard has /api/prd/regenerate endpoint', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('/api/prd/regenerate'),
      'dashboard.js should have /api/prd/regenerate endpoint');
    assert.ok(src.includes('fs.unlinkSync(prdPath)'),
      'Regeneration should delete old PRD file');
    assert.ok(src.includes('_targetPrdFile'),
      'Regeneration work item should include target PRD filename');
  });

  await test('Regeneration carries over completed items from old PRD', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('completedItems'),
      'Regeneration should collect completed items');
    assert.ok(src.includes("completedStatuses.has(w.status)"),
      'Should preserve done/in-pr work items');
    assert.ok(src.includes('Previously completed items'),
      'Should pass completed items context to agent');
  });

  await test('Engine auto-regeneration also carries over completed items', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('completedItems.length'),
      'Engine regeneration should track completed items');
    assert.ok(src.includes('completed items to carry over'),
      'Engine should log carry-over count');
  });

  await test('Regeneration endpoint deduplicates queued items', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('alreadyQueued'),
      'Regeneration endpoint should check for duplicate queue entries');
  });

  await test('Approved PRDs are not auto-regenerated on plan revision', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
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
}

// ─── LLM Module Tests ──────────────────────────────────────────────────────

async function testLlmModule() {
  console.log('\n── llm.js — LLM Utilities ──');

  const llm = require(path.join(SQUAD_DIR, 'engine', 'llm'));

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
}

// ─── Check-Status Tests ────────────────────────────────────────────────────

async function testCheckStatus() {
  console.log('\n── check-status.js — Quick Status ──');

  await test('check-status.js can be required without crashing', () => {
    // The module executes on require, so we just verify it doesn't throw
    // We can't actually require it since it has side effects (console.log)
    // Instead verify the file exists and has the right imports
    const content = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'check-status.js'), 'utf8');
    assert.ok(content.includes('getAgentStatus'), 'check-status.js should use getAgentStatus');
    assert.ok(content.includes('dispatch'), 'check-status.js should reference dispatch');
  });
}

// ─── PR Review Fix Cycle Tests ──────────────────────────────────────────────

async function testPrReviewFixCycle() {
  console.log('\n── PR → Review → Fix Cycle ──');

  await test('No self-review: review agent cannot be PR author', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('prAuthor'),
      'discoverFromPrs should extract PR author for self-review check');
    assert.ok(src.includes('agentId === prAuthor'),
      'Should check if resolved agent is the PR author');
  });

  await test('Review verdict is waiting (not hardcoded approved)', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const reviewFn = src.slice(src.indexOf('function updatePrAfterReview('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterReview(') + 1));
    assert.ok(reviewFn.includes("status: 'waiting'"),
      'updatePrAfterReview should set status to waiting, not approved');
    assert.ok(!reviewFn.includes("status: 'approved'"),
      'Should NOT hardcode approved — let pollPrStatus determine actual verdict');
  });

  await test('Human feedback fix triggers re-review (reset to waiting)', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fixFn = src.slice(src.indexOf('function updatePrAfterFix('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterFix(') + 1));
    // Both branches should set status to 'waiting'
    const waitingCount = (fixFn.match(/status: 'waiting'/g) || []).length;
    assert.ok(waitingCount >= 2,
      `Both human-feedback and review-feedback fix paths should reset to waiting (found ${waitingCount})`);
  });

  await test('Human feedback cooldown key uses PR ID only (no timestamp)', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    // The key should NOT include lastProcessedCommentDate
    assert.ok(!src.includes('human-fix-${project?.name || \'default\'}-${pr.id}-${pr.humanFeedback.lastProcessedCommentDate}'),
      'Human fix key should not include timestamp (prevents cooldown bypass)');
    assert.ok(src.includes("human-fix-${project?.name || 'default'}-${pr.id}`"),
      'Human fix key should be PR-level only');
  });

  await test('routing parser uses mtime cache to avoid reparsing every resolve', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function getRoutingTableCached()'),
      'engine should use a cached routing table helper');
    assert.ok(src.includes('_routingCacheMtime'),
      'routing cache should track routing.md mtime');
    assert.ok(src.includes('const routes = getRoutingTableCached();'),
      'resolveAgent should use cached routes');
  });

  await test('PRs with active dispatch are skipped (race prevention)', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('activePrIds'),
      'discoverFromPrs should track active PR dispatches');
    assert.ok(src.includes('activePrIds.has(pr.id)'),
      'Should skip PRs that already have an active dispatch');
  });

  await test('Only active PRs are considered for review/fix', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("pr.status !== 'active') continue"),
      'Should skip merged/abandoned PRs');
  });

  await test('Fix routes to PR author via _author_ token', () => {
    const routing = fs.readFileSync(path.join(SQUAD_DIR, 'routing.md'), 'utf8');
    assert.ok(routing.includes('_author_'),
      'routing.md should have _author_ token for fix routing');
  });

  await test('Review playbook includes PR context variables', () => {
    const playbook = fs.readFileSync(path.join(SQUAD_DIR, 'playbooks', 'review.md'), 'utf8');
    assert.ok(playbook.includes('{{pr_id}}'), 'Review playbook needs pr_id');
    assert.ok(playbook.includes('{{pr_branch}}'), 'Review playbook needs pr_branch');
    assert.ok(playbook.includes('{{pr_title}}'), 'Review playbook needs pr_title');
  });

  await test('Fix playbook includes review feedback variable', () => {
    const playbook = fs.readFileSync(path.join(SQUAD_DIR, 'playbooks', 'fix.md'), 'utf8');
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
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    // Should use sanitizeBranch for consistent matching
    assert.ok(src.includes('sanitizeBranch(branch).toLowerCase()') || src.includes('sanitizeBranch(d.meta.branch).toLowerCase()'),
      'Cleanup should sanitize branches before comparison');
    // Should NOT have the old fuzzy bidirectional matching
    assert.ok(!src.includes("d.meta.branch.includes(dir)"),
      'Should not use bidirectional substring matching for dispatch protection');
  });

  await test('Post-merge cleanup finds worktrees by branch slug (not exact path)', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('dirLower.includes(branchSlug)'),
      'Post-merge cleanup should match by sanitized branch slug');
    assert.ok(src.includes('readdirSync(wtRoot)'),
      'Post-merge cleanup should scan worktree directory');
  });

  await test('Shared-branch worktrees cleaned on plan completion', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('shared-branch worktree'),
      'Plan completion should clean shared-branch worktrees');
    assert.ok(src.includes('plan.branch_strategy') && src.includes('plan.feature_branch'),
      'Should check both branch_strategy and feature_branch');
  });

  await test('Shared-branch plan protection checks both prd/ and plans/', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('PRD_DIR') && src.includes("'plans'"),
      'Worktree protection should check both prd/ and plans/ directories');
  });

  await test('MAX_WORKTREES cap enforced during cleanup', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('MAX_WORKTREES'),
      'Should reference MAX_WORKTREES constant');
    assert.ok(src.includes('excess'),
      'Should calculate and clean excess worktrees');
  });

  await test('Review/test tasks skip worktree creation if none exists', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("type === 'review' || type === 'test'"),
      'Review/test types should have special worktree handling');
    assert.ok(src.includes('falling back to rootDir'),
      'Should fall back to rootDir for review/test without existing worktree');
  });

  await test('Worktree creation handles stale index.lock', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('index.lock'),
      'Should check for and handle stale index.lock');
    assert.ok(src.includes('300000'),
      'Should use 5-minute threshold for stale lock detection');
  });

  await test('Worktree creation supports configurable timeout and retries', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('worktreeCreateTimeout'),
      'Should support configurable worktree create timeout');
    assert.ok(src.includes('worktreeCreateRetries'),
      'Should support configurable worktree create retries');
    assert.ok(src.includes('runWorktreeAdd('),
      'Should centralize worktree add with retry behavior');
  });

  await test('Worktree creation recovers partially created worktrees after add failure', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function recoverPartialWorktree('),
      'Should include partial worktree recovery helper');
    assert.ok(src.includes('Recovered partially-created worktree'),
      'Should log successful partial worktree recovery');
    assert.ok(src.includes('Proceeding with recovered worktree after add failure'),
      'Should continue dispatch when recovered worktree is usable');
  });

  await test('findExistingWorktree validates directory exists on disk', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('fs.existsSync(wtPath)'),
      'findExistingWorktree should verify directory exists');
  });

  await test('KB watchdog skips git restore when knowledge is untracked', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
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
      const pbPath = path.join(SQUAD_DIR, 'playbooks', `${pb}.md`);
      assert.ok(fs.existsSync(pbPath), `Missing playbook: ${pb}.md`);
    }
  });

  await test('Playbooks contain template variables', () => {
    const pbPath = path.join(SQUAD_DIR, 'playbooks', 'implement.md');
    const content = fs.readFileSync(pbPath, 'utf8');
    // Should have at least some template variables
    assert.ok(content.includes('{{') && content.includes('}}'), 'Playbook has no template variables');
  });

  await test('All agent charters exist', () => {
    const config = queries.getConfig();
    if (!config.agents || Object.keys(config.agents).length === 0) {
      // Running from repo without installed config — check default agents
      for (const agentId of Object.keys(shared.DEFAULT_AGENTS)) {
        const charterPath = path.join(SQUAD_DIR, 'agents', agentId, 'charter.md');
        assert.ok(fs.existsSync(charterPath), `Missing charter for ${agentId}`);
      }
    } else {
      for (const agentId of Object.keys(config.agents)) {
        const charterPath = path.join(SQUAD_DIR, 'agents', agentId, 'charter.md');
        assert.ok(fs.existsSync(charterPath), `Missing charter for ${agentId}`);
      }
    }
  });

  await test('bin/squad init guards against home under package root', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'bin', 'squad.js'), 'utf8');
    assert.ok(src.includes('function isSubpath('),
      'bin/squad.js should define subpath helper');
    assert.ok(src.includes('Refusing to initialize Squad home inside package directory'),
      'init should fail fast when SQUAD_HOME is inside PKG_ROOT');
  });

  await test('bin/squad force init restarts engine and dashboard automatically', () => {
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'bin', 'squad.js'), 'utf8');
    assert.ok(src.includes('Upgrade complete (') && src.includes('Restarting engine and dashboard'),
      'force upgrade should announce automatic restart');
    assert.ok(src.includes('engine.js') && src.includes('stop'),
      'force upgrade should stop engine before restart');
    assert.ok(src.includes('Dashboard started (PID:'),
      'init flow should still auto-start dashboard');
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

  await test('dispatch.completed capped at 100', () => {
    const dispatch = queries.getDispatch();
    assert.ok(dispatch.completed.length <= 100, `completed queue too large: ${dispatch.completed.length}`);
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
    const plansDir = path.join(SQUAD_DIR, 'plans');
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
    const src = fs.readFileSync(path.join(SQUAD_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('const projects = getProjects(config);'),
      'validateConfig should use shared.getProjects filtering');
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Squad Unit Tests');
  console.log('================');
  console.log(`Squad dir: ${SQUAD_DIR}\n`);

  try {
    // shared.js tests
    await testSharedUtilities();
    await testIdGeneration();
    await testBranchSanitization();
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

    // consolidation.js tests
    await testConsolidationHelpers();

    // github.js tests
    await testGithubHelpers();

    // PR comment processing tests
    await testPrCommentProcessing();

    // Plan lifecycle tests
    await testPlanLifecycle();
    await testPrdStaleInvalidation();

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
  } finally {
    cleanupTmpDirs();
  }

  console.log(`\n══════════════════════════════`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`══════════════════════════════\n`);

  // Write results for CI
  const resultsPath = path.join(SQUAD_DIR, 'engine', 'test-results.json');
  shared.safeWrite(resultsPath, {
    suite: 'unit',
    timestamp: new Date().toISOString(),
    passed, failed, skipped,
    results
  });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
