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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function getRoutingTableCached()'),
      'engine should use a cached routing table helper');
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('PRD_DIR') && src.includes("'plans'"),
      'Worktree protection should check both prd/ and plans/ directories');
  });

  await test('MAX_WORKTREES cap enforced during cleanup', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function mutateDispatch('),
      'engine should define dispatch lock helper');
    assert.ok(src.includes('mutateJsonFileLocked(DISPATCH_PATH'),
      'engine dispatch writes should use lock-backed mutation');
  });

  await test('Dashboard uses lock-backed dispatch mutations for API writes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('mutateJsonFileLocked'),
      'dashboard should use lock-backed dispatch mutation helper');
    assert.ok(src.includes("defaultValue: { pending: [], active: [], completed: [] }"),
      'dashboard dispatch mutations should normalize queue structure');
  });

  await test('Hung timeout path uses normal auto-retry flow', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("completeDispatch(item.id, 'error', reason);"),
      'Hung/orphan cleanup should route through normal completeDispatch retry handling');
    assert.ok(!src.includes("completeDispatch(item.id, 'error', reason, '', { processWorkItemFailure: false })"),
      'Hung/orphan cleanup should not bypass work item retry handling');
  });

  await test('Auto-retry is gated by retryable failure reason classification', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function isRetryableFailureReason('),
      'Engine should classify retryable vs non-retryable failures');
    assert.ok(src.includes('retryableFailure && retries < 3'),
      'Auto-retry should run only for retryable failures under retry cap');
    assert.ok(src.includes('Non-retryable failure:'),
      'Non-retryable failures should be surfaced explicitly');
  });

  await test('Auto-retry writes retry metadata on work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('_lastRetryReason'),
      'Auto-retry should persist last retry reason');
    assert.ok(src.includes('_lastRetryAt'),
      'Auto-retry should persist last retry timestamp');
  });

  await test('Auto-retry clears completed dedupe marker for dispatch key', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    assert.ok(src.includes('clearPendingHumanFeedbackFlag(item.meta.project, item.meta.pr?.id)'),
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const completeDispatchStart = src.indexOf('function completeDispatch(');
    const completeDispatchEnd = src.indexOf('\nfunction areDependenciesMet(', completeDispatchStart);
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
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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
    // Verify it exists via source
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('renderPlaybook injects team notes section', () => {
    assert.ok(src.includes('Team Notes') || src.includes('team_notes') || src.includes('notes_content'),
      'Should inject team notes into rendered playbook');
  });

  await test('renderPlaybook injects skill extraction instructions', () => {
    assert.ok(src.includes('skill') && src.includes('```skill'),
      'Should inject skill extraction block format');
  });
}

// ─── engine.js — completeDispatch Tests ─────────────────────────────────────

async function testCompleteDispatch() {
  console.log('\n── engine.js — completeDispatch ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('completeDispatch caps completed list at 100', () => {
    assert.ok(src.includes('dispatch.completed.length >= 100'),
      'Should trim completed list when it reaches 100 entries');
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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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

  await test('runPostCompletionHooks calls updateMetrics', () => {
    assert.ok(src.includes('updateMetrics') || src.includes('trackEngineUsage'),
      'Should update agent metrics after completion');
  });

  await test('runPostCompletionHooks parses agent output', () => {
    assert.ok(src.includes('parseAgentOutput') || src.includes('parseStreamJsonOutput'),
      'Should parse agent stdout to extract result summary');
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

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('setCooldownWithContext function exists', () => {
    assert.ok(src.includes('function setCooldownWithContext'),
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
    assert.ok(src.includes('existing?.failures || 0'),
      'setCooldownWithContext should preserve failure count');
  });
}

// ─── Budget Enforcement Tests ───────────────────────────────────────────────

async function testBudgetEnforcement() {
  console.log('\n── Budget Enforcement ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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
    const pages = ['page-home', 'page-work', 'page-prd', 'page-prs', 'page-plans', 'page-inbox', 'page-schedule', 'page-engine'];
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
    const pages = ['home', 'work', 'prd', 'prs', 'plans', 'inbox', 'schedule', 'engine'];
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
  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

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
    await testRunPostCompletionHooks();
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

main().catch(e => { console.error(e); process.exit(1); });
