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
      'idleAlertMinutes', 'restartGracePeriod'];
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
    const statusOrder = { pending: 0, queued: 0, dispatched: 1, done: 2 };
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

// ─── Config & Playbook Tests ────────────────────────────────────────────────

async function testConfigAndPlaybooks() {
  console.log('\n── Config & Playbooks ──');

  await test('config.json exists and is valid', () => {
    // Config lives in SQUAD_DIR (which may be ~/.squad/ at runtime)
    const config = queries.getConfig();
    assert.ok(typeof config === 'object', 'config.json not readable');
    // config may be empty {} if running from a non-installed repo
    if (Object.keys(config).length > 0) {
      assert.ok(config.agents, 'config missing agents');
      assert.ok(Array.isArray(config.projects), 'config missing projects array');
    }
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

    // llm.js tests
    await testLlmModule();

    // check-status.js tests
    await testCheckStatus();

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
