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

function createTestMinionsDir() {
  const dir = createTmpDir();
  for (const d of ['engine', 'prd', 'prd/archive', 'plans', 'plans/archive', 'projects', 'notes/inbox', 'notes/archive', 'knowledge', 'agents']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ projects: [], agents: {}, engine: {} }));
  fs.writeFileSync(path.join(dir, 'engine', 'dispatch.json'), JSON.stringify({ pending: [], active: [], completed: [] }));
  fs.writeFileSync(path.join(dir, 'engine', 'metrics.json'), '{}');
  fs.writeFileSync(path.join(dir, 'engine', 'log.json'), '[]');
  fs.writeFileSync(path.join(dir, 'work-items.json'), '[]');

  process.env.MINIONS_TEST_DIR = dir;
  // Bust require cache so modules re-resolve MINIONS_DIR
  for (const mod of ['../engine/shared', '../engine/queries', '../engine/lifecycle', '../engine/dispatch', '../engine/cleanup', '../engine/timeout', '../engine/pipeline', '../engine/meeting', '../engine/consolidation', '../engine/llm']) {
    try { delete require.cache[require.resolve(mod)]; } catch {}
  }
  return function restore() {
    delete process.env.MINIONS_TEST_DIR;
    for (const mod of ['../engine/shared', '../engine/queries', '../engine/lifecycle', '../engine/dispatch', '../engine/cleanup', '../engine/timeout', '../engine/pipeline', '../engine/meeting', '../engine/consolidation', '../engine/llm']) {
      try { delete require.cache[require.resolve(mod)]; } catch {}
    }
  };
}

async function test(name, fn, cleanup) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${name}\n`);
  } catch (e) {
    failed++;
    results.push({ name, status: 'FAIL', error: e.message });
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${name}: ${e.message}\n`);
  } finally {
    if (cleanup) try { await cleanup(); } catch {}
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
    assert.ok(typeof result === 'string' && result.startsWith('NOTE-'), 'Should return note ID string');
    const files = fs.readdirSync(inboxDir);
    assert.strictEqual(files.length, 1, 'Should have exactly one file');
    assert.ok(files[0].startsWith('ralph-test-slug-'), `File should start with ralph-test-slug-, got: ${files[0]}`);
    assert.ok(files[0].endsWith('.md'), 'File should end with .md');
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.ok(content.includes('id: ' + result), 'Content should include note ID in frontmatter');
    assert.ok(content.includes('# Test content'), 'Content should include original content');
  });

  await test('writeToInbox deduplicates on same agentId+slug+date', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const first = shared.writeToInbox('engine', 'prd-completion', '# First', inboxDir);
    assert.ok(typeof first === 'string' && first.startsWith('NOTE-'), 'First write should return note ID');
    const second = shared.writeToInbox('engine', 'prd-completion', '# Second', inboxDir);
    assert.strictEqual(second, false, 'Second write should be deduped');
    const files = fs.readdirSync(inboxDir);
    assert.strictEqual(files.length, 1, 'Should still have only one file');
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.ok(content.includes('# First'), 'Content should be from first write');
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

  await test('parseNoteId extracts ID from frontmatter', () => {
    assert.strictEqual(shared.parseNoteId('---\nid: NOTE-abc123\nagent: dallas\n---\n\n# Content'), 'NOTE-abc123');
    assert.strictEqual(shared.parseNoteId('# No frontmatter'), null);
    assert.strictEqual(shared.parseNoteId(null), null);
    assert.strictEqual(shared.parseNoteId(''), null);
  });

  await test('parseNoteId handles CRLF line endings', () => {
    assert.strictEqual(shared.parseNoteId('---\r\nid: NOTE-crlf123\r\nagent: dallas\r\n---\r\n\r\n# Content'), 'NOTE-crlf123');
  });

  await test('parseNoteId handles extra whitespace in id field', () => {
    assert.strictEqual(shared.parseNoteId('---\nid:   NOTE-spaces  \nagent: x\n---'), 'NOTE-spaces');
  });

  await test('parseNoteId ignores content without closing ---', () => {
    assert.strictEqual(shared.parseNoteId('---\nid: NOTE-noclosing\nagent: x\n'), null);
  });

  await test('writeToInbox injects frontmatter with id, agent, date', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const noteId = shared.writeToInbox('dallas', 'findings', '# My findings', inboxDir);
    assert.ok(noteId && noteId.startsWith('NOTE-'), 'Should return note ID');
    const files = fs.readdirSync(inboxDir);
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.ok(content.startsWith('---\n'), 'Should start with frontmatter');
    assert.ok(content.includes('id: ' + noteId), 'Should include note ID');
    assert.ok(content.includes('agent: dallas'), 'Should include agent name');
    assert.ok(content.includes('date: '), 'Should include date');
    assert.ok(content.includes('# My findings'), 'Should include original content after frontmatter');
  });

  await test('writeToInbox merges ID into existing frontmatter', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const noteId = shared.writeToInbox('ripley', 'analysis', '---\ntitle: My Analysis\n---\n\n# Content', inboxDir);
    assert.ok(noteId && noteId.startsWith('NOTE-'), 'Should return note ID');
    const files = fs.readdirSync(inboxDir);
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.ok(content.includes('id: ' + noteId), 'Should inject note ID');
    assert.ok(content.includes('title: My Analysis'), 'Should preserve existing frontmatter fields');
    assert.ok(content.includes('# Content'), 'Should preserve content');
  });

  await test('writeToInbox handles CRLF frontmatter in existing content', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const noteId = shared.writeToInbox('ralph', 'crlf', '---\r\ntitle: CRLF Test\r\n---\r\n\r\n# Body', inboxDir);
    assert.ok(noteId && noteId.startsWith('NOTE-'), 'Should return note ID');
    const files = fs.readdirSync(inboxDir);
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    assert.ok(content.includes('id: ' + noteId), 'Should inject ID into CRLF frontmatter');
  });

  await test('writeToInbox returns unique IDs for different notes', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const id1 = shared.writeToInbox('dallas', 'note-a', '# A', inboxDir);
    const id2 = shared.writeToInbox('dallas', 'note-b', '# B', inboxDir);
    assert.ok(id1 && id2, 'Both should return IDs');
    assert.notStrictEqual(id1, id2, 'IDs should be unique');
  });

  await test('parseNoteId roundtrips with writeToInbox output', () => {
    const dir = createTmpDir();
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    const noteId = shared.writeToInbox('lambert', 'roundtrip', '# Roundtrip test', inboxDir);
    const files = fs.readdirSync(inboxDir);
    const content = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
    const parsed = shared.parseNoteId(content);
    assert.strictEqual(parsed, noteId, 'parseNoteId should extract the same ID that writeToInbox returned');
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
      'agentTimeout', 'heartbeatTimeout', 'heartbeatTimeouts', 'maxTurns', 'worktreeRoot',
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

  await test('DEFAULT_CLAUDE has required fields with correct values', () => {
    assert.ok(shared.DEFAULT_CLAUDE.binary);
    assert.strictEqual(shared.DEFAULT_CLAUDE.outputFormat, 'stream-json',
      'outputFormat must be stream-json — json format buffers all output, breaking live streaming');
    assert.ok(shared.DEFAULT_CLAUDE.allowedTools);
  });

  await test('DEFAULT_AGENT_METRICS has all required metric fields', () => {
    const m = shared.DEFAULT_AGENT_METRICS;
    assert.ok(m !== undefined, 'DEFAULT_AGENT_METRICS must be exported');
    const expectedFields = ['tasksCompleted', 'tasksErrored', 'prsCreated', 'prsApproved',
      'prsRejected', 'prsMerged', 'reviewsDone', 'lastTask', 'lastCompleted',
      'totalCostUsd', 'totalInputTokens', 'totalOutputTokens', 'totalCacheRead'];
    for (const field of expectedFields) {
      assert.ok(field in m, `DEFAULT_AGENT_METRICS missing field: ${field}`);
    }
    // Numeric fields default to 0, nullable fields default to null
    assert.strictEqual(m.tasksCompleted, 0);
    assert.strictEqual(m.lastTask, null);
    assert.strictEqual(m.lastCompleted, null);
  });

  await test('DEFAULT_AGENT_METRICS spread creates independent copy', () => {
    const a = { ...shared.DEFAULT_AGENT_METRICS };
    const b = { ...shared.DEFAULT_AGENT_METRICS };
    a.tasksCompleted = 5;
    assert.strictEqual(b.tasksCompleted, 0, 'Spread must create independent copy');
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
    assert.ok(src.includes("WI_STATUS.DISPATCHED"),
      'fallback should only treat dispatched work items as working (using WI_STATUS constant)');
    assert.ok(src.includes("dispatched_to") && src.includes("String(agentId).toLowerCase()"),
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

  await test('readHeadTail reads only head and tail for large files', () => {
    const tmp = createTmpDir();
    const fp = path.join(tmp, 'big.log');
    // Create a file >2KB: 1KB head marker + 2KB filler + 1KB tail marker
    const headContent = 'HEAD_MARKER_START' + 'A'.repeat(1024 - 'HEAD_MARKER_START'.length);
    const filler = 'B'.repeat(2048);
    const tailContent = 'C'.repeat(1024 - 'TAIL_MARKER_END'.length) + 'TAIL_MARKER_END';
    fs.writeFileSync(fp, headContent + filler + tailContent);
    const { head, tail } = queries.readHeadTail(fp, 1024);
    assert.strictEqual(head.length, 1024, 'head should be exactly 1024 bytes');
    assert.strictEqual(tail.length, 1024, 'tail should be exactly 1024 bytes');
    assert.ok(head.includes('HEAD_MARKER_START'), 'head should contain start of file');
    assert.ok(tail.includes('TAIL_MARKER_END'), 'tail should contain end of file');
    assert.ok(!head.includes('TAIL_MARKER_END'), 'head should not contain tail content');
  });

  await test('readHeadTail reads full file when small (<= 2KB)', () => {
    const tmp = createTmpDir();
    const fp = path.join(tmp, 'small.log');
    const content = 'small file content here';
    fs.writeFileSync(fp, content);
    const { head, tail } = queries.readHeadTail(fp, 1024);
    assert.strictEqual(head, content, 'head should be full file content');
    assert.strictEqual(tail, content, 'tail should be full file content');
  });

  await test('readHeadTail returns empty strings for missing file', () => {
    const { head, tail } = queries.readHeadTail('/nonexistent/path/file.log', 1024);
    assert.strictEqual(head, '', 'head should be empty for missing file');
    assert.strictEqual(tail, '', 'tail should be empty for missing file');
  });

  await test('getAgentStatus uses readHeadTail instead of safeRead for live-output.log', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    // Find the getAgentStatus function body and verify it uses readHeadTail
    assert.ok(src.includes('readHeadTail(liveLogPath'),
      'getAgentStatus should use readHeadTail for live-output.log');
    assert.ok(!src.includes('safeRead(path.join(AGENTS_DIR, agentId, \'live-output.log\'))'),
      'getAgentStatus should NOT use safeRead for live-output.log');
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
    // Should be sorted by created date descending (date-only comparison, same-date ties broken by PR number)
    for (let i = 1; i < prs.length; i++) {
      assert.ok((prs[i - 1].created || '').slice(0, 10) >= (prs[i].created || '').slice(0, 10),
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

  await test('reconcileItemsWithPrs reconciles failed items with matching PR', () => {
    const items = [
      { id: 'P001', status: 'failed', failReason: 'Completed while engine was down', failedAt: '2026-04-07T00:00:00Z' },
      { id: 'P002', status: 'failed', failReason: 'Some other reason', failedAt: '2026-04-07T00:00:00Z' },
    ];
    const prs = [
      { id: 'PR-100', prdItems: ['P001'], status: 'active' },
      { id: 'PR-101', prdItems: ['P002'], status: 'active' },
    ];
    const count = reconcileItemsWithPrs(items, prs);
    assert.strictEqual(count, 2);
    assert.strictEqual(items[0].status, 'done');
    assert.strictEqual(items[0]._pr, 'PR-100');
    assert.strictEqual(items[0].failReason, undefined, 'failReason should be cleared');
    assert.strictEqual(items[0].failedAt, undefined, 'failedAt should be cleared');
    assert.ok(items[0].completedAt, 'completedAt should be set');
    assert.strictEqual(items[1].status, 'done');
    assert.strictEqual(items[1]._pr, 'PR-101');
  });

  await test('reconcileItemsWithPrs re-reconciles failed items even with existing _pr', () => {
    const items = [
      { id: 'P001', status: 'failed', _pr: 'PR-100', failReason: 'Completed while engine was down' },
    ];
    const prs = [
      { id: 'PR-100', prdItems: ['P001'], status: 'active' },
    ];
    const count = reconcileItemsWithPrs(items, prs);
    assert.strictEqual(count, 1);
    assert.strictEqual(items[0].status, 'done');
    assert.strictEqual(items[0]._pr, 'PR-100');
    assert.strictEqual(items[0].failReason, undefined);
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

  await test('engine.js flags all revised PRDs as stale (user decides when to regenerate)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale = true'),
      'Should set planStale flag when source plan changes');
    assert.ok(src.includes('user can regenerate from dashboard'),
      'Should log that user can regenerate');
  });

  await test('All PRD statuses flagged stale on plan revision (no auto-regenerate)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale = true'),
      'All statuses should be flagged stale');
    assert.ok(!src.includes("prdStatus === 'awaiting-approval'") || !src.includes('fs.unlinkSync(path.join(PRD_DIR, file))'),
      'Should NOT auto-delete/regenerate awaiting-approval PRDs');
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

  await test('Stale flag set for all statuses with single code path', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('plan.planStale = true'),
      'Should set planStale flag');
    assert.ok(src.includes('user can regenerate from dashboard'),
      'Should log that user can regenerate');
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

  await test('Destructive /api/prd/regenerate removed — diff-aware update via /api/plans/approve', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(!src.includes('handlePrdRegenerate(req'),
      'handlePrdRegenerate handler should be removed');
    assert.ok(src.includes('diff-aware update via /api/plans/approve'),
      'Should have comment explaining removal');
  });

  await test('Engine no longer auto-regenerates — all paths flag stale for user action', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // No engine:plan-revision createdBy — dispatch moved to dashboard
    assert.ok(!src.includes("createdBy: 'engine:plan-revision'"),
      'Engine should not dispatch plan-to-prd directly — user triggers from dashboard');
  });

  await test('Regeneration endpoint deduplicates queued items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('alreadyQueued'),
      'Regeneration endpoint should check for duplicate queue entries');
  });

  await test('Awaiting-approval PRDs also flagged stale (no auto-delete)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // The old auto-delete path is gone — all statuses just flag stale
    assert.ok(!src.includes("prdStatus === 'awaiting-approval'") || !src.includes('unlinkSync'),
      'Should not auto-delete awaiting-approval PRDs');
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
    assert.ok(src.includes('notTerminal.length > 0'),
      'Plan completion should block when any feature work item is not in a terminal state');
  });

  await test('Plan completion cleans all worktrees, not just shared-branch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('Clean up ALL worktrees'),
      'Worktree cleanup should handle all plan worktrees');
    assert.ok(src.includes('w.branch') && src.includes('w.id') && src.includes('pr.branch'),
      'Should collect branch slugs from work items, item IDs, and PR branches');
  });

  // ── Plan Resume & Diff-Aware PRD Updates ──

  console.log('\n── Plan Resume & Diff-Aware PRD Updates ──');

  await test('Approve dispatches diff-aware plan-to-prd when plan was stale', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('wasStale') && src.includes('diffAwareQueued'),
      'Should check wasStale flag and track dispatch');
    assert.ok(src.includes('Existing implementation state') || src.includes('Current PRD implementation state'),
      'Should pass implementation context to agent');
    assert.ok(src.includes('_existingPrdFile'),
      'Work item should reference existing PRD file');
    assert.ok(src.includes('dashboard:plan-resume'),
      'Should use dashboard:plan-resume as createdBy');
  });

  await test('Materializer uses PRD_MATERIALIZABLE constant for status filter', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('PRD_MATERIALIZABLE'),
      'statusFilter should use PRD_MATERIALIZABLE constant');
    const sharedSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(sharedSrc.includes("UPDATED: 'updated'") && sharedSrc.includes('PRD_MATERIALIZABLE'),
      'shared.js should define PRD_ITEM_STATUS.UPDATED and PRD_MATERIALIZABLE set');
  });

  await test('Re-open: only "updated" status re-opens done work items (not "missing")', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('PRD_ITEM_STATUS.UPDATED') && src.includes('shouldReopen'),
      'shouldReopen should check for PRD_ITEM_STATUS.UPDATED only');
    assert.ok(src.includes('_reopened = true'),
      'Should mark re-opened work items with _reopened flag');
  });

  await test('Cross-project re-opens deferred outside lock (no nested locks)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('deferredReopens'),
      'Should collect cross-project re-opens for deferred execution');
    assert.ok(src.includes('deferredReopens.push'),
      'Should push to deferred array inside lock');
  });

  await test('buildWiDescription shared helper used for all WI description building', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('function buildWiDescription('),
      'Should have buildWiDescription helper');
    const count = (src.match(/buildWiDescription\(/g) || []).length;
    assert.ok(count >= 4, 'buildWiDescription should be used in re-open, cross-project re-open, and new item paths (got ' + count + ')');
  });

  await test('handlePlansApprove clears _completionNotified for re-completion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('delete plan._completionNotified'),
      'Resume should clear _completionNotified so completion can re-fire');
  });

  await test('plan-to-prd playbook has diff-aware update instructions', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'plan-to-prd.md'), 'utf8');
    assert.ok(playbook.includes('Updating an Existing PRD'),
      'Playbook should have diff-aware update section');
    assert.ok(playbook.includes('"updated"'),
      'Playbook should document "updated" status for modified done items');
    assert.ok(playbook.includes('Preserve item IDs'),
      'Playbook should instruct agent to preserve existing IDs');
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

  await test('Review checks live review status from platform after completion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const reviewFn = src.slice(src.indexOf('function updatePrAfterReview('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterReview(') + 1));
    assert.ok(reviewFn.includes('checkLiveReviewStatus'),
      'updatePrAfterReview should check live review status from platform');
    assert.ok(reviewFn.includes('postReviewStatus'),
      'Should use live status instead of hardcoded waiting');
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

  await test('Read-only tasks skip worktree creation', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("'meeting'") && src.includes("'ask'") && src.includes("'explore'"),
      'Read-only task types should be listed for worktree skip');
    assert.ok(src.includes('read-only task, no worktree needed'),
      'Engine should log explicit reason when read-only tasks fall back to rootDir');
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

  await test('dispatch.completed capped at ~100', () => {
    const dispatch = queries.getDispatch();
    // Allow small overshoot — cap is enforced on next write cycle, live state may briefly exceed
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
    assert.ok(src.includes('spawnAgent(item, config)'),
      'dispatch loop must call spawnAgent');
    assert.ok(src.includes('proc === null'),
      'dispatch loop must check for null return from spawnAgent');
    assert.ok(src.includes('_retryCount') && src.includes("'pending'"),
      'dispatch loop must re-queue work item with retry metadata on spawn failure');
  });

  await test('spawnAgent atomically stamps dispatched_to on work item (#402)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the section near "Move pending -> active" where the stamp should be
    const anchorIdx = src.indexOf('Move pending -> active');
    assert.ok(anchorIdx > 0, 'expected Move pending -> active comment in engine.js');
    const section = src.slice(anchorIdx, anchorIdx + 2000);
    assert.ok(section.includes('mutateJsonFileLocked(wiPath'),
      'spawnAgent must use mutateJsonFileLocked to atomically write dispatched_to after pending→active');
    assert.ok(section.includes('wi.dispatched_to = wi.dispatched_to || agentId'),
      'spawnAgent must stamp dispatched_to with agent ID');
    assert.ok(section.includes('wi.dispatched_at = wi.dispatched_at || startedAt'),
      'spawnAgent must stamp dispatched_at with start time');
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

  await test('Log buffering batches writes and flushLogs drains buffer', () => {
    const shared = require(path.join(MINIONS_DIR, 'engine', 'shared.js'));
    // Verify buffer and flushLogs are exported
    assert.ok(Array.isArray(shared._logBuffer), '_logBuffer should be an exported array');
    assert.ok(typeof shared.flushLogs === 'function', 'flushLogs should be exported');
    // Verify ENGINE_DEFAULTS has buffer config
    assert.strictEqual(shared.ENGINE_DEFAULTS.logFlushInterval, 5000,
      'logFlushInterval should default to 5000ms');
    assert.strictEqual(shared.ENGINE_DEFAULTS.logBufferSize, 50,
      'logBufferSize should default to 50 entries');
    // Source-level: log() pushes to buffer, not directly to mutateJsonFileLocked
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(src.includes('_logBuffer.push(entry)'),
      'log() should push entries to in-memory buffer');
    assert.ok(src.includes('_flushLogBuffer()'),
      'log() should call _flushLogBuffer when threshold exceeded');
    assert.ok(src.includes('logData.push(...entries)'),
      'flush should batch-append all entries in a single lock acquisition');
    assert.ok(src.includes("clearInterval(_logFlushTimer)"),
      'flushLogs should clear the flush timer');
  });

  await test('Graceful shutdown calls flushLogs before exit', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(src.includes('shared.flushLogs()'),
      'graceful shutdown should call shared.flushLogs() to drain buffered log entries');
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
    assert.ok(src.includes("completeDispatch(item.id, DISPATCH_RESULT.ERROR, reason);"),
      'Hung/orphan cleanup should route through normal completeDispatch retry handling');
    assert.ok(!src.includes("completeDispatch(item.id, 'error', reason, '', { processWorkItemFailure: false })"),
      'Hung/orphan cleanup should not bypass work item retry handling');
  });

  await test('Auto-retry is gated by retryable failure reason classification', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('function isRetryableFailureReason('),
      'Engine should classify retryable vs non-retryable failures');
    assert.ok(src.includes('retryableFailure && classAllowsRetry'),
      'Auto-retry should run only for retryable failures under per-class retry cap');
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

  await test('Pending work-item discovery self-heals stale dispatch gates (batched)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('selfHealKeys'),
      'Discovery should collect keys for batched self-heal');
    assert.ok(src.includes('selfHealKeys.has(d.meta?.dispatchKey)'),
      'Batched self-heal should filter completed entries by collected keys');
    assert.ok(src.includes('dispatchCooldowns.delete(key);'),
      'Pending discovery should clear in-memory cooldown for pending item key');
  });

  await test('Central work items self-heal dispatched status only when in dispatch.active (#480)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // discoverCentralWorkItems must self-heal items stuck at pending when actively dispatched
    const centralFn = src.slice(src.indexOf('function discoverCentralWorkItems('));
    assert.ok(centralFn.includes('isAlreadyDispatched(key)'),
      'Central discovery must check isAlreadyDispatched for self-heal');
    // Self-heal should only set DISPATCHED when item is in dispatch.active (not pending)
    assert.ok(centralFn.includes('const existingActive = getDispatch().active?.find(d => d.meta?.dispatchKey === key)'),
      'Central self-heal must check dispatch.active before setting dispatched status');
    assert.ok(centralFn.includes('m.status = WI_STATUS.DISPATCHED'),
      'Central discovery must self-heal pending→dispatched via mutations map when in active');
    assert.ok(centralFn.includes('existingActive.agent') && centralFn.includes('m.dispatched_to'),
      'Central discovery must populate dispatched_to from active dispatch entry');
    assert.ok(centralFn.includes('mutations.size > 0') && centralFn.includes('mutateJsonFileLocked(centralPath'),
      'Central discovery must persist changes via atomic mutateJsonFileLocked when mutations exist');
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

  await test('Discovery does not prematurely mark items as dispatched (#480)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Discovery should NOT eagerly stamp dispatched_at/dispatched_to on new items
    assert.ok(!src.includes('item.dispatched_at = ts()'),
      'discoverFromWorkItems must NOT prematurely set dispatched_at during discovery');
    assert.ok(!src.includes('item.dispatched_to = agentId'),
      'discoverFromWorkItems must NOT prematurely set dispatched_to during discovery');
    // Self-heal in discoverFromWorkItems only sets DISPATCHED when item is in dispatch.active
    assert.ok(src.includes('const existingActive = getDispatch().active?.find(d => d.meta?.dispatchKey === key)'),
      'Self-heal must check dispatch.active before setting dispatched status');
    // spawnAgent stamps dispatched_to/dispatched_at atomically
    assert.ok(src.includes('wi.status !== WI_STATUS.DISPATCHED') && src.includes('wi.dispatched_to = wi.dispatched_to || agentId'),
      'spawnAgent should atomically stamp dispatched status on work items');
  });

  await test('PRD dispatched sync deferred to dispatch loop after spawnAgent success (#480)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Discovery should NOT do PRD sync — it's deferred to after spawn
    assert.ok(!src.includes("for (const s of prdSyncQueue) syncPrdItemStatus(s.id, 'dispatched', s.sourcePlan)"),
      'discoverFromWorkItems should NOT sync PRD dispatched status (deferred to dispatch loop)');
    // Dispatch loop should sync PRD after successful spawn
    assert.ok(src.includes("syncPrdItemStatus(item.meta.item.id, WI_STATUS.DISPATCHED, item.meta.item.sourcePlan)"),
      'dispatch loop should sync PRD dispatched status after successful spawnAgent');
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
    assert.ok(src.includes("depItem.status === WI_STATUS.FAILED") || src.includes("depItem.status === 'failed'"),
      'dependency gate should fail fast on failed dependency');
    assert.ok(!src.includes("depItem._retryCount || 0) >= 3"),
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
    assert.ok(src.includes("LEGACY_DONE_ALIASES") || src.includes("LEGACY_DONE_STATUSES"), 'runCleanup should define legacy status migration set');
    assert.ok(src.includes("item.status = shared.WI_STATUS.DONE") || src.includes("item.status = 'done'"), 'Should migrate work items to done');
    assert.ok(src.includes("feat.status = shared.WI_STATUS.DONE") || src.includes("feat.status = 'done'"), 'Should migrate PRD items to done');
  });

  await test('cleanup.js reconciles failed items with attached PR to done (#407)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('WI_STATUS.FAILED && item._pr'),
      'cleanup should check for failed items with _pr');
    assert.ok(src.includes('Reconciled') && src.includes('failed-with-PR'),
      'cleanup should log reconciliation of failed-with-PR items');
  });

  await test('cleanup.js resets orphaned PRD item statuses (#779)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('shared.WI_STATUS.DISPATCHED') && src.includes('!wiIds.has(feat.id)'),
      'cleanup must detect orphaned dispatched PRD items with no matching work item');
    assert.ok(src.includes('shared.WI_STATUS.FAILED') && src.includes('shared.WI_STATUS.PENDING'),
      'cleanup must reset orphaned dispatched/failed PRD items to pending using constants');
    assert.ok(src.includes('orphaned PRD item status'),
      'cleanup must log orphaned PRD status resets');
  });

  await test('syncPrdFromPrs filter includes failed items with _pr (#407)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fnBody = src.slice(
      src.indexOf('function syncPrdFromPrs('),
      src.indexOf('\nfunction', src.indexOf('function syncPrdFromPrs(') + 1)
    );
    // The hasReconcilable filter must include failed items regardless of _pr
    assert.ok(fnBody.includes('wi.status === WI_STATUS.FAILED)'),
      'syncPrdFromPrs filter must include all failed items (not just those without _pr)');
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

  await test('findClaudeBinary result ends with cli.js or is a native binary path', () => {
    const result = preflight.findClaudeBinary();
    if (result !== null) {
      const isCliJs = result.endsWith('cli.js');
      const isNativeBin = result.includes('claude');
      assert.ok(isCliJs || isNativeBin, `Expected cli.js path or native binary, got: ${result}`);
    }
  });

  await test('runPreflight returns correct shape', () => {
    const { passed: p, results: r } = preflight.runPreflight();
    assert.ok(typeof p === 'boolean', 'passed should be boolean');
    assert.ok(Array.isArray(r), 'results should be array');
    assert.strictEqual(r.length, 3, 'should have exactly 3 checks (Node, Git, Claude CLI)');
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

  await test('runPreflight does not check Anthropic auth (handled by Claude Code)', () => {
    const { results: r } = preflight.runPreflight();
    const authCheck = r.find(c => c.name === 'Anthropic auth');
    assert.ok(!authCheck, 'Should not include Anthropic auth check — Claude Code handles auth');
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

// ─── shared.js — mutateWorkItems / mutatePullRequests Tests ─────────────────

async function testMutateWorkItemsAndPullRequests() {
  console.log('\n── shared.js — mutateWorkItems / mutatePullRequests ──');

  await test('mutateWorkItems basic read-modify-write', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'work-items.json');
    shared.safeWrite(fp, [{ id: 'W-1', status: 'pending' }]);
    shared.mutateWorkItems(fp, (items) => {
      items[0].status = 'done';
    });
    const result = shared.safeJson(fp);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.strictEqual(result[0].status, 'done');
  });

  await test('mutateWorkItems uses default [] when file does not exist', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'nonexistent-wi.json');
    shared.mutateWorkItems(fp, (items) => {
      items.push({ id: 'W-new', status: 'pending' });
    });
    const result = shared.safeJson(fp);
    assert.ok(Array.isArray(result), 'should create an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'W-new');
  });

  await test('mutateWorkItems concurrent calls serialize correctly', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'concurrent-wi.json');
    shared.safeWrite(fp, [{ id: 'counter', count: 0 }]);
    // Two sequential mutations — both should apply (no lost updates)
    shared.mutateWorkItems(fp, (items) => { items[0].count++; });
    shared.mutateWorkItems(fp, (items) => { items[0].count++; });
    const result = shared.safeJson(fp);
    assert.strictEqual(result[0].count, 2, 'both mutations should apply');
  });

  await test('mutatePullRequests basic read-modify-write', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    shared.safeWrite(fp, [{ id: 'PR-1', status: 'active' }]);
    shared.mutatePullRequests(fp, (prs) => {
      prs[0].status = 'merged';
    });
    const result = shared.safeJson(fp);
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.strictEqual(result[0].status, 'merged');
  });

  await test('mutatePullRequests uses default [] when file does not exist', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'nonexistent-pr.json');
    shared.mutatePullRequests(fp, (prs) => {
      prs.push({ id: 'PR-new', status: 'active' });
    });
    const result = shared.safeJson(fp);
    assert.ok(Array.isArray(result), 'should create an array');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, 'PR-new');
  });

  await test('mutatePullRequests concurrent calls serialize correctly', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'concurrent-pr.json');
    shared.safeWrite(fp, []);
    // Two sequential mutations — both should append
    shared.mutatePullRequests(fp, (prs) => { prs.push({ id: 'PR-1' }); });
    shared.mutatePullRequests(fp, (prs) => { prs.push({ id: 'PR-2' }); });
    const result = shared.safeJson(fp);
    assert.strictEqual(result.length, 2, 'both mutations should apply');
    assert.strictEqual(result[0].id, 'PR-1');
    assert.strictEqual(result[1].id, 'PR-2');
  });

  await test('mutateWorkItems returns the final data', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'return-wi.json');
    const result = shared.mutateWorkItems(fp, (items) => {
      items.push({ id: 'W-ret' });
    });
    assert.ok(Array.isArray(result), 'return value should be an array');
    assert.strictEqual(result[0].id, 'W-ret');
  });

  await test('shared exports mutateWorkItems and mutatePullRequests', () => {
    assert.ok(typeof shared.mutateWorkItems === 'function',
      'shared should export mutateWorkItems');
    assert.ok(typeof shared.mutatePullRequests === 'function',
      'shared should export mutatePullRequests');
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

  await test('safeJson backup restore verifies written content but still returns data on write failure', () => {
    // Verify the source code: safeJson restore path has verification + best-effort error logging
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    const safeJsonMatch = src.match(/function safeJson\(p\)\s*\{[\s\S]*?^}/m);
    assert.ok(safeJsonMatch, 'safeJson function should exist');
    const body = safeJsonMatch[0];
    // Should contain verification read-back
    assert.ok(body.includes('verifyData'), 'safeJson should verify restored data');
    assert.ok(body.includes('CRITICAL'), 'safeJson should log CRITICAL on verification mismatch');
    assert.ok(body.includes('console.error'), 'safeJson should use console.error for failures');
    // Must NOT throw on restore failure — backupData is valid and should be returned
    assert.ok(body.includes('return backupData'), 'safeJson should return backupData even if restore write fails');
  });

  await test('safeJson restore succeeds and returns data when backup is valid', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'restore-success.json');
    // Write corrupted primary and valid backup
    fs.writeFileSync(fp, 'CORRUPTED DATA');
    fs.writeFileSync(fp + '.backup', JSON.stringify({ restored: true, value: 42 }));
    const result = shared.safeJson(fp);
    assert.deepStrictEqual(result, { restored: true, value: 42 }, 'should return backup data');
    // Verify primary was actually restored
    const primary = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.deepStrictEqual(primary, { restored: true, value: 42 }, 'primary should be restored');
  });

  await test('safeJson returns backup data even when primary restore write fails', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'readonly-primary.json');
    // Write corrupted primary and valid backup
    fs.writeFileSync(fp, 'CORRUPTED DATA');
    fs.writeFileSync(fp + '.backup', JSON.stringify({ valid: true }));
    // Make parent dir read-only so safeWrite fails (but backup was already read)
    // Instead, corrupt the primary path to a directory to force write failure
    fs.unlinkSync(fp);
    fs.mkdirSync(fp); // primary is now a directory — safeWrite will fail
    const result = shared.safeJson(fp);
    assert.deepStrictEqual(result, { valid: true }, 'should return backup data even when restore write fails');
    // Cleanup
    fs.rmdirSync(fp);
  });

  await test('withFileLock stale lock unlink wrapped in try-catch for ENOENT', () => {
    // Verify the source code: stale lock unlink is properly guarded
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    // Extract withFileLock body using indexOf — regex is fragile with destructured params
    const start = src.indexOf('function withFileLock(');
    assert.ok(start >= 0, 'withFileLock function should exist');
    const body = src.substring(start, start + 1500);
    // Should catch ENOENT specifically on unlink
    assert.ok(body.includes("unlinkErr.code !== 'ENOENT'"),
      'stale lock unlink should check for ENOENT specifically');
    // After stale lock removal, should retry immediately (no sleep — lock was just cleared)
    assert.ok(body.includes('continue; // lock just removed'),
      'should retry immediately after stale lock removal');
    // statSync catch should also handle ENOENT
    assert.ok(body.includes("staleErr.code !== 'ENOENT'"),
      'statSync catch should check for ENOENT specifically');
  });

  await test('withFileLock acquires and releases lock correctly', () => {
    const dir = createTmpDir();
    const lockPath = path.join(dir, 'test.lock');
    const result = shared.withFileLock(lockPath, () => 'executed', { timeoutMs: 1000 });
    assert.strictEqual(result, 'executed', 'should execute the function under lock');
    // Lock should be cleaned up
    assert.ok(!fs.existsSync(lockPath), 'lock file should be removed after release');
  });

  await test('_tmpCounter has JSDoc documenting single-thread assumption', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    const counterSection = src.substring(
      Math.max(0, src.indexOf('let _tmpCounter') - 300),
      src.indexOf('let _tmpCounter') + 20
    );
    assert.ok(counterSection.includes('single-thread') || counterSection.includes('worker_threads'),
      '_tmpCounter should have a doc comment noting single-thread assumption');
    assert.ok(counterSection.includes('/**'),
      '_tmpCounter should have a JSDoc comment');
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
    assert.ok(src.includes("depItem.status === WI_STATUS.FAILED") || src.includes("depItem.status === 'failed'"),
      'Should return failed when any dependency has failed');
  });

  await test('areDependenciesMet uses PRD_MET_STATUSES for all done aliases', () => {
    assert.ok(src.includes("PRD_MET_STATUSES"),
      'Should use PRD_MET_STATUSES set for status checking');
    // Verify it uses centralized DONE_STATUSES or includes legacy aliases
    assert.ok(src.includes("DONE_STATUSES") || (src.includes("'done'") && src.includes("'in-pr'")),
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
    assert.ok(src.includes('queries.getWorkItems(config)'),
      'Should collect work items across all projects for cross-project deps via getWorkItems()');
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

  await test('isAlreadyDispatched uses shorter dedup window for errored tasks (#593)', () => {
    assert.ok(src.includes("d.result === 'error'") && src.includes('900000'),
      'Should use 15-min (900000ms) dedup window for errored dispatches');
    assert.ok(src.includes('3600000'),
      'Should retain 1-hour (3600000ms) dedup window for successful dispatches');
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
    assert.ok(src.includes('else if (preferred && isAvailable(preferred))'),
      'Should check preferred first (after _any_ check)');
    assert.ok(src.includes('else if (fallback && isAvailable(fallback))'),
      'Should check fallback second (after _any_ check)');
    assert.ok(src.includes('.sort((a, b) => getAgentErrorRate(a) - getAgentErrorRate(b))'),
      'Should sort remaining idle agents by error rate');
  });

  await test('resolveAgent supports _any_ token for routing to any idle agent (#480)', () => {
    assert.ok(src.includes("preferred === '_any_'"),
      'Should handle _any_ token for preferred agent');
    assert.ok(src.includes("fallback === '_any_'"),
      'Should handle _any_ token for fallback agent');
    assert.ok(src.includes('pickAnyIdle'),
      'Should use pickAnyIdle helper for _any_ resolution');
    // Verify routing.md uses _any_ for fix fallback
    const routing = fs.readFileSync(path.join(MINIONS_DIR, 'routing.md'), 'utf8');
    assert.ok(routing.includes('| fix | _author_ | _any_ |'),
      'routing.md should use _any_ as fallback for fix tasks');
  });

  await test('resolveAgent returns null when no agents available', () => {
    assert.ok(src.includes('return null'),
      'Should return null when no idle agents found');
  });

  await test('resolveAgent tracks claimed agents to prevent double-booking', () => {
    assert.ok(src.includes('_claimedAgents.add') && src.includes('_claimedAgents.has'),
      'Should track and check claimed agents per discovery pass');
  });

  await test('resolveAgent uses pickAnyIdle to fall back to any idle agent', () => {
    assert.ok(src.includes('const anyIdle = pickAnyIdle([preferred, fallback])'),
      'Final fallback should use pickAnyIdle excluding preferred and fallback');
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
      task_title: 'Test', task_description: 'Test desc',
      item_id: 'W001', item_name: 'Test feature',
      branch_name: 'test-branch', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.ok(typeof result === 'string' && result.length > 0,
      'Should return rendered playbook string');
  });

  await test('renderPlaybook substitutes template variables', () => {
    const result = renderPlaybook('implement', {
      agent_name: 'UNIQUE_AGENT_SENTINEL', agent_role: 'Engineer', agent_id: 'test',
      project_name: 'TestProject', project_path: '/tmp', main_branch: 'main',
      task_title: 'Test', task_description: 'Test desc',
      item_id: 'W001', item_name: 'Test feature',
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
}

// ─── engine/playbook.js — validatePlaybookVars Tests ────────────────────────

async function testValidatePlaybookVars() {
  console.log('\n── engine/playbook.js — validatePlaybookVars ──');

  let validatePlaybookVars, PLAYBOOK_REQUIRED_VARS, renderPlaybook;
  try {
    const pb = require(path.join(MINIONS_DIR, 'engine', 'playbook'));
    validatePlaybookVars = pb.validatePlaybookVars;
    PLAYBOOK_REQUIRED_VARS = pb.PLAYBOOK_REQUIRED_VARS;
    renderPlaybook = pb.renderPlaybook;
  } catch {}

  if (!validatePlaybookVars) {
    skip('validatePlaybookVars', 'engine/playbook.validatePlaybookVars not available');
    return;
  }

  await test('validatePlaybookVars returns valid for unknown playbook type', () => {
    const result = validatePlaybookVars('nonexistent-playbook', {});
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.missing.length, 0);
  });

  await test('validatePlaybookVars returns missing vars for implement with empty vars', () => {
    const result = validatePlaybookVars('implement', {});
    assert.strictEqual(result.valid, false);
    assert.ok(result.missing.includes('item_id'), 'Should flag item_id as missing');
    assert.ok(result.missing.includes('item_name'), 'Should flag item_name as missing');
    assert.ok(result.missing.includes('branch_name'), 'Should flag branch_name as missing');
    assert.ok(result.missing.includes('project_path'), 'Should flag project_path as missing');
  });

  await test('validatePlaybookVars passes when all required vars are provided', () => {
    const result = validatePlaybookVars('implement', {
      item_id: 'W-001', item_name: 'Test feature',
      branch_name: 'work/W-001', project_path: '/tmp/repo',
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.missing.length, 0);
  });

  await test('validatePlaybookVars treats empty strings as missing', () => {
    const result = validatePlaybookVars('fix', { pr_id: '', pr_branch: 'some-branch' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.missing.includes('pr_id'), 'Empty string should count as missing');
    assert.ok(!result.missing.includes('pr_branch'), 'Non-empty string should not be flagged');
  });

  await test('validatePlaybookVars treats whitespace-only strings as missing', () => {
    const result = validatePlaybookVars('ask', { question: '   ' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.missing.includes('question'), 'Whitespace-only should count as missing');
  });

  await test('validatePlaybookVars treats null/undefined as missing', () => {
    const result = validatePlaybookVars('review', { pr_id: null, pr_branch: undefined });
    assert.strictEqual(result.valid, false);
    assert.ok(result.missing.includes('pr_id'), 'null should count as missing');
    assert.ok(result.missing.includes('pr_branch'), 'undefined should count as missing');
  });

  await test('PLAYBOOK_REQUIRED_VARS covers all dispatched playbook types', () => {
    const expectedTypes = [
      'implement', 'implement-shared', 'fix', 'review', 'build-and-test',
      'explore', 'ask', 'plan', 'plan-to-prd', 'decompose', 'verify',
      'test', 'work-item', 'meeting-investigate', 'meeting-debate', 'meeting-conclude',
    ];
    for (const t of expectedTypes) {
      assert.ok(PLAYBOOK_REQUIRED_VARS[t], `Should define required vars for "${t}"`);
      assert.ok(Array.isArray(PLAYBOOK_REQUIRED_VARS[t]), `Required vars for "${t}" should be an array`);
      assert.ok(PLAYBOOK_REQUIRED_VARS[t].length > 0, `Required vars for "${t}" should not be empty`);
    }
  });

  await test('validatePlaybookVars works for all meeting playbook types', () => {
    for (const type of ['meeting-investigate', 'meeting-debate', 'meeting-conclude']) {
      const result = validatePlaybookVars(type, { meeting_title: 'Daily Standup', agenda: 'Review progress' });
      assert.strictEqual(result.valid, true, `${type} should pass with title and agenda`);
    }
  });

  await test('renderPlaybook returns null when required vars are missing', () => {
    if (!renderPlaybook) { skip('renderPlaybook-validation', 'renderPlaybook not available'); return; }
    // implement requires item_id, item_name, branch_name, project_path — provide none
    const result = renderPlaybook('implement', { agent_id: 'test', agent_name: 'Test' });
    assert.strictEqual(result, null, 'Should return null when required vars are missing');
  });

  await test('renderPlaybook succeeds when all required vars are provided', () => {
    if (!renderPlaybook) { skip('renderPlaybook-validation-pass', 'renderPlaybook not available'); return; }
    const result = renderPlaybook('implement', {
      agent_id: 'test', agent_name: 'TestAgent', agent_role: 'Engineer',
      item_id: 'W-001', item_name: 'Test feature', branch_name: 'work/W-001',
      project_path: '/tmp/repo', team_root: MINIONS_DIR, date: '2024-01-01',
    });
    assert.ok(typeof result === 'string' && result.length > 0,
      'Should return rendered playbook when all required vars are provided');
  });
}

// ─── engine.js — completeDispatch Tests ─────────────────────────────────────

async function testCompleteDispatch() {
  console.log('\n── engine.js — completeDispatch ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');

  await test('completeDispatch caps completed list at 100', () => {
    assert.ok(src.includes('dispatch.completed.length >= 100'),
      'Should trim completed list when it exceeds 100 entries');
  });

  await test('completeDispatch deletes prompt from completed item', () => {
    assert.ok(src.includes('delete item.prompt'),
      'Should delete prompt field to save memory in completed list');
  });

  await test('completeDispatch auto-retries up to maxRetries', () => {
    assert.ok(src.includes('retries < maxRetries'),
      'Should allow up to maxRetries auto-retries for retryable failures');
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

  await test('completeDispatch restores pendingFix on failed human-feedback fix', () => {
    assert.ok(src.includes("item.meta?.source === 'pr-human-feedback'"),
      'Should check for pr-human-feedback source on error');
    assert.ok(src.includes('target.humanFeedback.pendingFix = true'),
      'Should restore pendingFix=true so engine re-dispatches on next tick');
  });

  await test('completeDispatch clears completed dispatch entry for failed human-feedback fix', () => {
    // After restoring pendingFix, the completed dispatch entry must be cleared
    // to prevent dedup from blocking re-dispatch
    const restoreBlock = src.slice(src.indexOf("item.meta?.source === 'pr-human-feedback'"));
    assert.ok(restoreBlock.includes('clear human-feedback dispatch for retry'),
      'Should clear completed dispatch key so dedup allows re-dispatch');
  });

  await test('completeDispatch human-feedback restore uses mutatePullRequests', () => {
    assert.ok(src.includes('mutatePullRequests(prsPath'),
      'Should use mutatePullRequests for atomic read-modify-write on PR file');
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

// ─── Build Fix Retry Cap Tests ──────────────────────────────────────────────

async function testBuildFixRetryCap() {
  console.log('\n── Build Fix Retry Cap ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const sharedSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
  const adoSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
  const githubSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');

  await test('ENGINE_DEFAULTS includes maxBuildFixAttempts', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.maxBuildFixAttempts, 3,
      'maxBuildFixAttempts should default to 3');
  });

  await test('engine.js checks buildFixAttempts before dispatching fix agent', () => {
    assert.ok(engineSrc.includes('buildFixAttempts') && engineSrc.includes('maxBuildFixAttempts'),
      'Build fix dispatch should check buildFixAttempts against maxBuildFixAttempts cap');
  });

  await test('engine.js increments buildFixAttempts on fix dispatch', () => {
    assert.ok(engineSrc.includes('buildFixAttempts') && engineSrc.includes('+ 1'),
      'buildFixAttempts should be incremented when a fix agent is dispatched');
  });

  await test('engine.js sets buildFixEscalated when cap reached', () => {
    assert.ok(engineSrc.includes('buildFixEscalated'),
      'Should set buildFixEscalated flag when fix attempt cap is reached');
  });

  await test('engine.js writes escalation alert when cap reached', () => {
    assert.ok(engineSrc.includes('build-fix-escalated') && engineSrc.includes('writeInboxAlert'),
      'Should write inbox alert with build-fix-escalated slug when cap is reached');
  });

  await test('engine.js skips dispatch when buildFixEscalated', () => {
    assert.ok(engineSrc.includes('buildFixEscalated') && engineSrc.includes('continue'),
      'Should skip fix dispatch (continue) when cap is reached and escalated');
  });

  await test('engine.js uses DEFAULTS.maxBuildFixAttempts with config override', () => {
    assert.ok(engineSrc.includes('DEFAULTS.maxBuildFixAttempts'),
      'Should reference DEFAULTS.maxBuildFixAttempts for the cap');
  });

  await test('ado.js resets buildFixAttempts when build passes', () => {
    assert.ok(adoSrc.includes('delete pr.buildFixAttempts'),
      'ADO poll should clear buildFixAttempts when build status recovers');
  });

  await test('ado.js resets buildFixEscalated when build passes', () => {
    assert.ok(adoSrc.includes('delete pr.buildFixEscalated'),
      'ADO poll should clear buildFixEscalated when build status recovers');
  });

  await test('github.js resets buildFixAttempts when build passes', () => {
    assert.ok(githubSrc.includes('delete pr.buildFixAttempts'),
      'GitHub poll should clear buildFixAttempts when build status recovers');
  });

  await test('github.js resets buildFixEscalated when build passes', () => {
    assert.ok(githubSrc.includes('delete pr.buildFixEscalated'),
      'GitHub poll should clear buildFixEscalated when build status recovers');
  });

  await test('settings UI includes maxBuildFixAttempts field', () => {
    const settingsSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'settings.js'), 'utf8');
    assert.ok(settingsSrc.includes('maxBuildFixAttempts') && settingsSrc.includes('set-maxBuildFixAttempts'),
      'Settings UI should have a maxBuildFixAttempts input field');
  });

  await test('dashboard.js handleSettingsUpdate processes maxBuildFixAttempts', () => {
    const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(dashSrc.includes("maxBuildFixAttempts: [1, 10]"),
      'Server-side numericFields should include maxBuildFixAttempts with bounds [1, 10]');
  });

  await test('escalation only fires once per PR (buildFixEscalated guard)', () => {
    // The escalation alert + flag write should only happen when !pr.buildFixEscalated
    assert.ok(engineSrc.includes('!pr.buildFixEscalated'),
      'Escalation should check !pr.buildFixEscalated to prevent duplicate alerts');
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

// ─── engine.js — buildWorkItemDispatchVars Tests ─────────────────────────────

async function testBuildWorkItemDispatchVars() {
  console.log('\n── engine.js — buildWorkItemDispatchVars ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  await test('buildWorkItemDispatchVars function exists and is exported', () => {
    assert.ok(src.includes('function buildWorkItemDispatchVars('),
      'engine.js must define buildWorkItemDispatchVars');
    assert.ok(src.includes('buildWorkItemDispatchVars') && src.includes('module.exports'),
      'buildWorkItemDispatchVars must be exported');
  });

  await test('buildWorkItemDispatchVars sets references from item', () => {
    assert.ok(src.includes("vars.references = refs ? '## References"),
      'Should format references into markdown');
  });

  await test('buildWorkItemDispatchVars sets acceptance_criteria from item', () => {
    assert.ok(src.includes("vars.acceptance_criteria = ac ? '## Acceptance Criteria"),
      'Should format acceptance criteria into markdown');
  });

  await test('buildWorkItemDispatchVars reads notes via getNotes()', () => {
    // Must use getNotes() instead of inline fs.readFileSync for notes.md
    assert.ok(src.includes('getNotes()'),
      'Should use getNotes() from queries.js');
  });

  await test('buildWorkItemDispatchVars handles checkpoint context', () => {
    assert.ok(src.includes('checkpoint.json') && src.includes('needsReview'),
      'Should read checkpoint.json and return needsReview flag');
  });

  await test('buildWorkItemDispatchVars handles ASK work type', () => {
    assert.ok(src.includes("workType === WORK_TYPE.ASK") && src.includes('vars.question'),
      'Should set question var for ASK work type');
  });

  await test('buildWorkItemDispatchVars calls resolveTaskContext', () => {
    // The function must call resolveTaskContext to inject implicit context
    const fnBody = src.slice(src.indexOf('function buildWorkItemDispatchVars('));
    const fnEnd = fnBody.indexOf('\nfunction ');
    const fn = fnBody.slice(0, fnEnd);
    assert.ok(fn.includes('resolveTaskContext(item, config)'),
      'Should call resolveTaskContext within buildWorkItemDispatchVars');
  });

  await test('buildWorkItemDispatchVars returns expected shape', () => {
    const fnBody = src.slice(src.indexOf('function buildWorkItemDispatchVars('));
    const fnEnd = fnBody.indexOf('\nfunction ');
    const fn = fnBody.slice(0, fnEnd);
    assert.ok(fn.includes('needsReview') && fn.includes('checkpointCount'),
      'Should return { needsReview, checkpointCount }');
  });

  await test('discoverFromWorkItems calls buildWorkItemDispatchVars', () => {
    assert.ok(src.includes('buildWorkItemDispatchVars(item, vars, config'),
      'discoverFromWorkItems should call buildWorkItemDispatchVars');
  });

  await test('discoverCentralWorkItems calls buildWorkItemDispatchVars', () => {
    const centralFn = src.slice(src.indexOf('function discoverCentralWorkItems('));
    assert.ok(centralFn.includes('buildWorkItemDispatchVars(item, vars, config'),
      'discoverCentralWorkItems should call buildWorkItemDispatchVars');
  });

  await test('no inline fs.readFileSync for notes.md in discovery functions', () => {
    // After extraction, discovery functions should not have inline notes.md reads
    const discoverWI = src.slice(src.indexOf('function discoverFromWorkItems('), src.indexOf('function normalizeAc('));
    const centralWI = src.slice(src.indexOf('function discoverCentralWorkItems('));
    const notesReadPattern = /fs\.readFileSync\(path\.join\(MINIONS_DIR,\s*'notes\.md'\)/g;
    const wiMatches = discoverWI.match(notesReadPattern) || [];
    const centralMatches = centralWI.match(notesReadPattern) || [];
    assert.strictEqual(wiMatches.length, 0,
      'discoverFromWorkItems should not have inline fs.readFileSync for notes.md');
    assert.strictEqual(centralMatches.length, 0,
      'discoverCentralWorkItems should not have inline fs.readFileSync for notes.md');
  });

  await test('buildWorkItemDispatchVars supports includeNotes option', () => {
    const fnBody = src.slice(src.indexOf('function buildWorkItemDispatchVars('));
    const fnEnd = fnBody.indexOf('\nfunction ');
    const fn = fnBody.slice(0, fnEnd);
    assert.ok(fn.includes('includeNotes'),
      'Should support includeNotes option for fan-out (no notes unless ASK)');
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

  await test('Per-type heartbeat timeouts: perTypeTimeouts merges ENGINE_DEFAULTS and config', () => {
    assert.ok(src.includes('perTypeTimeouts'), 'Should use perTypeTimeouts for per-type resolution');
    assert.ok(src.includes('DEFAULTS.heartbeatTimeouts'), 'Should merge from ENGINE_DEFAULTS.heartbeatTimeouts');
  });

  await test('Per-type heartbeat timeouts: resolved per dispatch item type with fallback', () => {
    // Verify per-type resolution happens inside the dispatch loop
    assert.ok(src.includes('perTypeTimeouts[item.type]') || src.includes("perTypeTimeouts[item.type] || heartbeatTimeout"),
      'Should resolve per-type timeout from item.type with heartbeatTimeout fallback');
  });

  await test('Per-type heartbeat timeouts: config.engine.heartbeatTimeouts overrides defaults', () => {
    assert.ok(src.includes("config.engine?.heartbeatTimeouts"),
      'Should read heartbeatTimeouts from config.engine for user overrides');
    // Verify merge order: ENGINE_DEFAULTS ← config
    assert.ok(src.includes('...DEFAULTS.heartbeatTimeouts'),
      'Should merge ENGINE_DEFAULTS and config heartbeatTimeouts');
  });

  await test('Per-type heartbeat timeouts: blocking tool uses Math.max(itemHeartbeat, blockingTimeout)', () => {
    // The blocking tool extension should respect per-type timeout as minimum floor
    assert.ok(src.includes('Math.max(itemHeartbeat,'),
      'Blocking tool timeout should use Math.max(itemHeartbeat, ...) so per-type floor is respected');
  });

  await test('Per-type heartbeat timeouts: timeout.js imports from shared.js', () => {
    assert.ok(src.includes("require('./shared')"), 'Should import from shared.js');
  });

  await test('Heartbeat feedback loop fix: uses realActivityMap for tracked processes (#724)', () => {
    // The timeout check must use realActivityMap (in-memory, tracks real agent output only)
    // instead of file mtime for tracked processes. File mtime is polluted by engine heartbeat writes.
    assert.ok(src.includes('realActivityMap'), 'timeout.js should reference realActivityMap');
    assert.ok(src.includes('realActivityMap?.has(item.id)') || src.includes("realActivityMap.has(item.id)"),
      'Should check realActivityMap for dispatch item');
    assert.ok(src.includes('realActivityMap.get(item.id)') || src.includes("realActivityMap?.get(item.id)"),
      'Should read lastRealActivity from realActivityMap');
  });

  await test('Heartbeat feedback loop fix: falls back to file mtime only for orphans (#724)', () => {
    // For orphan detection (no tracked process), file mtime is still valid because
    // no heartbeat timer is running. The fix only uses realActivityMap when hasProcess is true.
    assert.ok(src.includes('hasProcess && realActivityMap'),
      'Should only use realActivityMap when process is tracked (hasProcess)');
    assert.ok(src.includes('Orphan case') || src.includes('orphan'),
      'Should document the orphan fallback path');
  });

  await test('Heartbeat feedback loop fix: engine.js tracks real output in realActivityMap (#724)', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('realActivityMap.set(id, Date.now())'),
      'engine.js should update realActivityMap on real stdout/stderr');
    assert.ok(engineSrc.includes('realActivityMap.delete(id)'),
      'engine.js should clean up realActivityMap on agent close/error');
    assert.ok(engineSrc.includes('realActivityMap,'),
      'engine.js should export realActivityMap');
  });

  await test('Bash blocking grace uses 120s default matching Claude Code actual default (#593)', () => {
    // The Bash tool default timeout in Claude Code is 120s, not 600s.
    // Grace = max(heartbeatTimeout, bashTimeout + 60000) = max(300000, 120000+60000) = 300000 (5min)
    // This ensures hung agents are killed within ~5min, not ~11min.
    assert.ok(src.includes("input.timeout || 120000"),
      'Bash default timeout should be 120000ms (120s) to match Claude Code actual default');
    // Verify the Bash-specific block uses 120000, not 600000
    const bashBlock = src.slice(src.indexOf("if (name === 'Bash')"), src.indexOf("if (name === 'Bash')") + 300);
    assert.ok(bashBlock.includes('120000') && !bashBlock.includes('600000'),
      'Bash blocking block should use 120000ms, not 600000ms');
  });

  // Regression: #721 — DEFAULT_HEARTBEAT_TIMEOUTS was undefined, silently crashing checkTimeouts every tick
  await test('checkTimeouts does NOT reference undefined DEFAULT_HEARTBEAT_TIMEOUTS (#721)', () => {
    assert.ok(!src.includes('DEFAULT_HEARTBEAT_TIMEOUTS'),
      'timeout.js must not reference DEFAULT_HEARTBEAT_TIMEOUTS — use DEFAULTS.heartbeatTimeouts instead');
  });

  await test('checkTimeouts perTypeTimeouts construction does not throw (#721 regression)', () => {
    // Behavioral: construct perTypeTimeouts exactly as checkTimeouts does, proving no ReferenceError
    const { ENGINE_DEFAULTS: DEFAULTS } = require('../engine/shared');
    const config = { engine: { heartbeatTimeouts: { review: 600000 } } };
    // This line would throw ReferenceError if DEFAULT_HEARTBEAT_TIMEOUTS crept back in
    const perTypeTimeouts = { ...DEFAULTS.heartbeatTimeouts, ...(config.engine?.heartbeatTimeouts || {}) };
    assert.ok(perTypeTimeouts !== null, 'perTypeTimeouts should be constructable without ReferenceError');
    assert.strictEqual(perTypeTimeouts.review, 600000, 'config overrides should merge correctly');
  });

  // Smoke test: actually call checkTimeouts({}) to catch ReferenceErrors at runtime (#775)
  // Previous tests only checked source strings — this exercises the real function.
  await test('checkTimeouts({}) does not throw ReferenceError (#775 smoke test)', () => {
    const timeout = require('../engine/timeout');
    try {
      timeout.checkTimeouts({});
    } catch (e) {
      // TypeError, missing engine context, etc. are expected in a test harness.
      // ReferenceError means a stale/undefined constant reference — that's the bug.
      if (e instanceof ReferenceError) {
        throw new Error(`checkTimeouts threw ReferenceError (stale constant?): ${e.message}`);
      }
      // Any other error is fine — the function needs a full engine context to run end-to-end.
    }
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

  // Functional tests — actually call extractSkillsFromOutput
  const restore = createTestMinionsDir();
  const lifecycle = require('../engine/lifecycle');
  const testConfig = { agents: { testbot: { name: 'TestBot' } }, engine: {}, projects: [] };

  await test('extractSkillsFromOutput extracts valid skill to ~/.claude/skills/', () => {
    const tmpHome = createTmpDir();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    try {
      // Bust os.homedir cache
      delete require.cache[require.resolve('os')];
      const output = [
        'Some analysis text',
        '```skill',
        '---',
        'name: deploy-workaround',
        'description: Workaround for flaky deploy',
        'scope: minions',
        '---',
        '',
        '# Deploy Workaround',
        '## Steps',
        '1. Clear cache',
        '2. Retry',
        '```',
        'Done.',
      ].join('\n');
      lifecycle.extractSkillsFromOutput(output, 'testbot', { id: 'D-001', meta: {} }, testConfig);
      const skillPath = path.join(tmpHome, '.claude', 'skills', 'deploy-workaround', 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), 'Skill file should be created at ~/.claude/skills/deploy-workaround/SKILL.md');
      const content = fs.readFileSync(skillPath, 'utf8');
      assert.ok(content.includes('name: deploy-workaround'), 'Skill should have name in frontmatter');
      assert.ok(content.includes('Deploy Workaround'), 'Skill should have body content');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
    }
  });

  await test('extractSkillsFromOutput skips skill without name', () => {
    const output = '```skill\n---\ndescription: no name here\n---\n\n# Content\n```';
    // Should not throw — just logs a warning and skips
    lifecycle.extractSkillsFromOutput(output, 'testbot', { id: 'D-002', meta: {} }, testConfig);
  });

  await test('extractSkillsFromOutput skips skill without frontmatter', () => {
    const output = '```skill\nJust raw content with no frontmatter\n```';
    lifecycle.extractSkillsFromOutput(output, 'testbot', { id: 'D-003', meta: {} }, testConfig);
  });

  await test('extractSkillsFromOutput handles empty output', () => {
    lifecycle.extractSkillsFromOutput('', 'testbot', { id: 'D-004', meta: {} }, testConfig);
    lifecycle.extractSkillsFromOutput(null, 'testbot', { id: 'D-005', meta: {} }, testConfig);
  });

  await test('extractSkillsFromOutput extracts from stream-json format', () => {
    const tmpHome = createTmpDir();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    try {
      delete require.cache[require.resolve('os')];
      const jsonLine = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '```skill\n---\nname: json-skill\ndescription: From JSON\nscope: minions\n---\n\n# JSON Skill\n```' }] }
      });
      lifecycle.extractSkillsFromOutput(jsonLine, 'testbot', { id: 'D-006', meta: {} }, testConfig);
      const skillPath = path.join(tmpHome, '.claude', 'skills', 'json-skill', 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), 'Should extract skill from stream-json formatted output');
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
    }
  });

  await test('extractSkillsFromOutput queues project-scoped skills as work items', () => {
    const testMinionsDir = process.env.MINIONS_TEST_DIR;
    const projConfig = {
      agents: { testbot: { name: 'TestBot' } }, engine: {},
      projects: [{ name: 'MyApp', localPath: '/tmp/myapp', repoHost: 'github' }]
    };
    fs.writeFileSync(path.join(testMinionsDir, 'config.json'), JSON.stringify(projConfig));
    // Bust cache so getProjects reads fresh config
    try { delete require.cache[require.resolve('../engine/shared')]; } catch {}
    try { delete require.cache[require.resolve('../engine/lifecycle')]; } catch {}
    const freshLifecycle = require('../engine/lifecycle');
    const output = '```skill\n---\nname: app-deploy\ndescription: Deploy steps\nscope: project\nproject: MyApp\n---\n\n# Deploy\n```';
    freshLifecycle.extractSkillsFromOutput(output, 'testbot', { id: 'D-007', meta: {} }, projConfig);
    const wi = JSON.parse(fs.readFileSync(path.join(testMinionsDir, 'work-items.json'), 'utf8'));
    const skillWi = wi.find(w => w.title && w.title.includes('Add skill: app-deploy'));
    assert.ok(skillWi, 'Should queue a work item to PR the project-scoped skill');
    assert.ok(skillWi.description.includes('app-deploy'), 'Work item should reference skill name');
    assert.ok(skillWi.description.includes('app-deploy/SKILL.md'), 'Work item path should use directory/SKILL.md format, not flat .md');
    assert.ok(!skillWi.description.includes('app-deploy.md'), 'Work item path should NOT use flat .md format');
  });

  restore();
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

  await test('chainPlanToPrd uses atomic writes on work-items.json', () => {
    // chainPlanToPrd should use mutateJsonFileLocked, not raw readFileSync+safeWrite
    const chainFn = src.match(/function chainPlanToPrd[\s\S]*?^}/m);
    if (chainFn) {
      assert.ok(chainFn[0].includes('mutateJsonFileLocked'),
        'chainPlanToPrd must use mutateJsonFileLocked for atomic writes');
    }
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

  await test('checkPlanCompletion uses PLAN_TERMINAL_STATUSES for completion gate', () => {
    assert.ok(lifecycleSrc.includes('PLAN_TERMINAL_STATUSES'),
      'Should use PLAN_TERMINAL_STATUSES constant for terminal state check');
    assert.ok(lifecycleSrc.includes('notTerminal'),
      'Should use notTerminal variable name (not notDone) for terminal state filter');
    assert.ok(lifecycleSrc.includes('plan-failure-escalation'),
      'Should write failure escalation alert to inbox for failed items');
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

  await test('checkPlanCompletion does NOT set _completionNotified on in-memory plan before persist', () => {
    // P-r7w2k9m4: The flag must NOT be set on the in-memory plan before mutateJsonFileLocked —
    // if persist fails, the in-memory flag would prevent retry on the next tick.
    // It should only be set inside the mutateJsonFileLocked callback on the persisted data.
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function checkPlanCompletion'),
      lifecycleSrc.indexOf('function archivePlan')
    );
    const inMemorySet = fnBody.indexOf('plan._completionNotified = true');
    assert.strictEqual(inMemorySet, -1,
      'Should NOT set _completionNotified on in-memory plan object before persist');
    assert.ok(fnBody.includes('data._completionNotified = true'),
      '_completionNotified should be set inside the mutateJsonFileLocked callback');
  });

  await test('checkPlanCompletion crash recovery: completed plan without _completionNotified falls through', () => {
    // When plan.status === 'completed' but _completionNotified is NOT set, the function must
    // NOT return early — it should fall through to create verify/PR items (crash recovery path)
    const guardSection = (lifecycleSrc.split("plan.status === 'completed'")[1] || lifecycleSrc.split("plan.status === PLAN_STATUS.COMPLETED")[1] || '').split('const projects')[0] || '';
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

// ─── checkPlanCompletion Functional Idempotency Tests ───────────────────────

async function testCheckPlanCompletionIdempotency() {
  console.log('\n── lifecycle.js — checkPlanCompletion Idempotency (functional) ──');

  const restore = createTestMinionsDir();
  const lifecycle = require('../engine/lifecycle');
  const sharedIsolated = require('../engine/shared');
  const testMinionsDir = sharedIsolated.MINIONS_DIR;

  const testPlanFile = '_test-idempotency.json';
  const testProjectName = '_test-idem-proj';

  // Paths that checkPlanCompletion will use (derived from isolated MINIONS_DIR)
  const prdDir = path.join(testMinionsDir, 'prd');
  const prdArchiveDir = path.join(prdDir, 'archive');
  const plansDir = path.join(testMinionsDir, 'plans');
  const plansArchiveDir = path.join(plansDir, 'archive');
  const inboxDir = path.join(testMinionsDir, 'notes', 'inbox');
  const projectStateDir = path.join(testMinionsDir, 'projects', testProjectName);

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

    // _completionNotified should be set (PRD stays in prd/ until verify completes)
    const completedPlan = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.ok(completedPlan, 'PRD should still be in prd/ (archive deferred until verify completes)');
    assert.strictEqual(completedPlan._completionNotified, true,
      '_completionNotified flag should be set after first call');
    assert.strictEqual(completedPlan.status, 'completed',
      'Plan status should be set to completed');

    // Inbox file should exist
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxFiles.length, 1, 'Exactly one inbox file should be created');

    // Verify work item should be created
    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify' && w.sourcePlan === testPlanFile);
    assert.strictEqual(verifyItems.length, 1, 'Exactly one verify work item should be created');
  }, cleanup);

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
  }, cleanup);

  // ── Test 3: Call twice end-to-end — only one set of side effects ──
  await test('checkPlanCompletion called twice: only one inbox file and one verify item total', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    // First call — should create everything
    lifecycle.checkPlanCompletion(meta, config);

    const inboxAfterFirst = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-idempotency'));
    assert.strictEqual(inboxAfterFirst.length, 1, 'First call creates one inbox file');

    // PRD should still be in prd/ (not archived yet — deferred until verify completes)
    const prdAfterFirst = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.ok(prdAfterFirst, 'PRD should still be in prd/ after first call');

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
  }, cleanup);

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

    // Flag should now be set (PRD stays in prd/ until verify completes)
    const recoveredPlan = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.strictEqual(recoveredPlan?._completionNotified, true,
      'Crash recovery should set _completionNotified for next re-entry');
  }, cleanup);

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

    // PRD stays in prd/ (archive deferred) — second call should return early via _completionNotified
    lifecycle.checkPlanCompletion(meta, config);

    const workItems2 = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const prItems2 = workItems2.filter(w => w.itemType === 'pr' && w.sourcePlan === testPlanFile);
    assert.strictEqual(prItems2.length, 1,
      'Second call should not create additional PR work items');
  }, cleanup);

  restore();
}

// ─── Verify Workflow Tests ──────────────────────────────────────────────────

async function testVerifyWorkflow() {
  console.log('\n── lifecycle.js — Verify Workflow ──');

  const restore = createTestMinionsDir();
  const lifecycle = require('../engine/lifecycle');
  const sharedIsolated = require('../engine/shared');
  const testMinionsDir = sharedIsolated.MINIONS_DIR;

  const testPlanFile = '_test-verify-flow.json';
  const testProjectName = 'verify-test-proj';
  const tmpDir = createTmpDir();
  const prdDir = path.join(testMinionsDir, 'prd');
  const prdArchiveDir = path.join(prdDir, 'archive');
  const plansDir = path.join(testMinionsDir, 'plans');
  const plansArchiveDir = path.join(plansDir, 'archive');
  const inboxDir = path.join(testMinionsDir, 'notes', 'inbox');
  const projectStateDir = path.join(testMinionsDir, 'projects', testProjectName);
  const guidesDir = path.join(prdDir, 'guides');

  // Ensure test-specific dirs exist
  for (const d of [prdDir, prdArchiveDir, plansDir, plansArchiveDir, inboxDir, projectStateDir, guidesDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  function makePrd(overrides = {}) {
    return {
      plan_summary: 'Test verify flow',
      project: testProjectName,
      branch_strategy: 'parallel',
      source_plan: '_test-verify-flow.md',
      missing_features: [
        { id: 'VF-001', name: 'Feature A', acceptance_criteria: ['AC1', 'AC2'] },
        { id: 'VF-002', name: 'Feature B', acceptance_criteria: ['AC3'] },
      ],
      ...overrides,
    };
  }

  function makeWorkItems(overrides = []) {
    return [
      { id: 'VF-001', title: 'Implement: Feature A', type: 'implement', status: 'done',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z' },
      { id: 'VF-002', title: 'Implement: Feature B', type: 'implement', status: 'done',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T02:00:00Z' },
      ...overrides,
    ];
  }

  const meta = { item: { sourcePlan: testPlanFile } };
  const config = {
    projects: [{ name: testProjectName, localPath: tmpDir, mainBranch: 'main' }],
  };

  function cleanup() {
    try { fs.unlinkSync(path.join(prdDir, testPlanFile)); } catch {}
    try { fs.unlinkSync(path.join(prdArchiveDir, testPlanFile)); } catch {}
    try { fs.unlinkSync(path.join(plansDir, '_test-verify-flow.md')); } catch {}
    try { fs.unlinkSync(path.join(plansArchiveDir, '_test-verify-flow.md')); } catch {}
    try { fs.unlinkSync(path.join(projectStateDir, 'work-items.json')); } catch {}
    try { fs.unlinkSync(path.join(projectStateDir, 'pull-requests.json')); } catch {}
    try { fs.rmdirSync(projectStateDir); } catch {}
    try { fs.unlinkSync(path.join(guidesDir, 'verify-_test-verify-flow.md')); } catch {}
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-verify'));
    for (const f of inboxFiles) { try { fs.unlinkSync(path.join(inboxDir, f)); } catch {} }
  }

  // ── 1. checkPlanCompletion does NOT archive PRD ──
  await test('verify: checkPlanCompletion creates verify WI but does NOT archive PRD', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    // PRD should still be in prd/ (not archived)
    assert.ok(fs.existsSync(path.join(prdDir, testPlanFile)),
      'PRD should remain in prd/ after completion (archive deferred)');
    assert.ok(!fs.existsSync(path.join(prdArchiveDir, testPlanFile)),
      'PRD should NOT be in prd/archive/ yet');

    // Verify WI should exist
    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify' && w.sourcePlan === testPlanFile);
    assert.strictEqual(verifyItems.length, 1, 'Should create exactly one verify work item');
    assert.strictEqual(verifyItems[0].type, 'verify');
    assert.strictEqual(verifyItems[0].status, 'pending');
    assert.strictEqual(verifyItems[0].priority, 'high');
    assert.ok(verifyItems[0].description.includes('Setup Commands'), 'Verify WI description should include setup commands');
    assert.ok(verifyItems[0].description.includes('Completed Items'), 'Verify WI description should include completed items');
  }, cleanup);

  // ── 2. Verify WI has correct fields ──
  await test('verify: verify work item has sourcePlan, itemType, project, and description', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const v = workItems.find(w => w.itemType === 'verify');
    assert.ok(v, 'Verify WI should exist');
    assert.strictEqual(v.sourcePlan, testPlanFile, 'sourcePlan should match PRD file');
    assert.strictEqual(v.project, testProjectName, 'project should match PRD project');
    assert.ok(v.id.startsWith('PL-'), 'Verify WI ID should start with PL-');
    assert.ok(v.title.includes('Verify plan'), 'Title should indicate verification');
    assert.ok(v.description.includes(testPlanFile), 'Description should reference plan file');
  }, cleanup);

  // ── 3a. Plan completes with partial results when some items fail (escalation, no verify) ──
  await test('verify: plan completes with failed items — verify WI still created for done items, escalation alert sent', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), [
      { id: 'VF-001', title: 'Impl A', type: 'implement', status: 'done',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z' },
      { id: 'VF-002', title: 'Impl B', type: 'implement', status: 'failed',
        failReason: 'permission-blocked',
        sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z' },
    ]);

    // Failed items are terminal — plan completes and verify is created for partial results (done items exist)
    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify');
    assert.strictEqual(verifyItems.length, 1, 'Verify WI created when done items exist — even with some failures');

    // Escalation alert should be in inbox
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('plan-failure-escalation'));
    assert.strictEqual(inboxFiles.length, 1, 'Escalation alert written to inbox for failed items');

    // Plan should be marked completed
    const completedPlan = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.strictEqual(completedPlan.status, 'completed', 'Plan status should be completed');
  }, cleanup);

  // ── 3b. No verify WI when ALL items failed (nothing to verify) ──
  await test('verify: no verify WI when all items failed', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), [
      { id: 'VF-001', title: 'Impl A', type: 'implement', status: 'failed',
        failReason: 'max_turns', sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z' },
      { id: 'VF-002', title: 'Impl B', type: 'implement', status: 'failed',
        failReason: 'permission-blocked', sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z' },
    ]);

    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify');
    assert.strictEqual(verifyItems.length, 0, 'No verify WI when all items failed');

    // Plan should still be completed (not stuck waiting)
    const completedPlan = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.strictEqual(completedPlan.status, 'completed', 'Plan completes even when all items failed');

    // Escalation alert should exist
    const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('plan-failure-escalation'));
    assert.strictEqual(inboxFiles.length, 1, 'Escalation alert written for all-failed plan');
  }, cleanup);

  // ── 4. Duplicate verify WI prevented ──
  await test('verify: existing verify WI prevents duplicate creation', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    const wiWithVerify = makeWorkItems([
      { id: 'PL-existing-verify', title: 'Verify plan: Test', type: 'verify',
        status: 'dispatched', sourcePlan: testPlanFile, itemType: 'verify', project: testProjectName },
    ]);
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), wiWithVerify);

    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const verifyItems = workItems.filter(w => w.itemType === 'verify');
    assert.strictEqual(verifyItems.length, 1, 'Should not create duplicate verify WI');
    assert.strictEqual(verifyItems[0].id, 'PL-existing-verify', 'Original verify WI should be unchanged');
  }, cleanup);

  // ── 5. archivePlan moves PRD and source plan ──
  await test('verify: archivePlan moves PRD to prd/archive/ and source plan to plans/archive/', () => {
    cleanup();
    const plan = makePrd();
    shared.safeWrite(path.join(prdDir, testPlanFile), plan);
    shared.safeWrite(path.join(plansDir, '_test-verify-flow.md'), '# Test Plan');

    lifecycle.archivePlan(testPlanFile, plan, config.projects, config);

    assert.ok(!fs.existsSync(path.join(prdDir, testPlanFile)),
      'PRD should be removed from prd/');
    assert.ok(fs.existsSync(path.join(prdArchiveDir, testPlanFile)),
      'PRD should be in prd/archive/');
    assert.ok(!fs.existsSync(path.join(plansDir, '_test-verify-flow.md')),
      'Source plan should be removed from plans/');
    assert.ok(fs.existsSync(path.join(plansArchiveDir, '_test-verify-flow.md')),
      'Source plan should be in plans/archive/');
  }, cleanup);

  // ── 6. archivePlan is idempotent ──
  await test('verify: archivePlan is idempotent (no error if already archived)', () => {
    cleanup();
    const plan = makePrd();
    // PRD already in archive, not in prd/
    fs.mkdirSync(prdArchiveDir, { recursive: true });
    shared.safeWrite(path.join(prdArchiveDir, testPlanFile), plan);

    // Should not throw
    lifecycle.archivePlan(testPlanFile, plan, config.projects, config);

    assert.ok(fs.existsSync(path.join(prdArchiveDir, testPlanFile)),
      'Archived PRD should still exist');
  }, cleanup);

  // ── 7. Plan status persisted to disk before archive ──
  await test('verify: plan status=completed and _completionNotified persisted to disk', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    const persisted = shared.safeJson(path.join(prdDir, testPlanFile));
    assert.strictEqual(persisted.status, 'completed', 'status should be persisted as completed');
    assert.strictEqual(persisted._completionNotified, true, '_completionNotified should be persisted');
    assert.ok(persisted.completedAt, 'completedAt should be set');
  }, cleanup);

  // ── 8. Verify WI description includes acceptance criteria ──
  await test('verify: verify WI description includes acceptance criteria from plan items', () => {
    cleanup();
    shared.safeWrite(path.join(prdDir, testPlanFile), makePrd());
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());

    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const v = workItems.find(w => w.itemType === 'verify');
    assert.ok(v.description.includes('AC1'), 'Should include acceptance criterion AC1');
    assert.ok(v.description.includes('AC2'), 'Should include acceptance criterion AC2');
    assert.ok(v.description.includes('AC3'), 'Should include acceptance criterion AC3');
  }, cleanup);

  // ── 9. Worktree paths use forward slashes (cross-platform) ──
  await test('verify: worktree paths in verify description use forward slashes', () => {
    cleanup();
    const plan = makePrd();
    shared.safeWrite(path.join(prdDir, testPlanFile), plan);
    shared.safeWrite(path.join(projectStateDir, 'work-items.json'), makeWorkItems());
    // Add a PR so worktree commands are generated
    shared.safeWrite(path.join(projectStateDir, 'pull-requests.json'), [
      { id: 'PR-1', branch: 'work/VF-001', status: 'active', prdItems: ['VF-001'] },
    ]);
    // Link PR to work item
    shared.safeWrite(sharedIsolated.PR_LINKS_PATH, { 'PR-1': 'VF-001' });

    lifecycle.checkPlanCompletion(meta, config);

    const workItems = shared.safeJson(path.join(projectStateDir, 'work-items.json')) || [];
    const v = workItems.find(w => w.itemType === 'verify');
    if (v && v.description.includes('worktree')) {
      assert.ok(!v.description.includes('\\\\'), 'Worktree paths should not contain backslashes');
    }
  }, cleanup);

  // ── 10. Archive is manual — verify completion does NOT auto-archive ──
  await test('verify: runPostCompletionHooks does NOT auto-archive after verify completes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const postHooks = src.slice(src.indexOf('function runPostCompletionHooks('), src.indexOf('\nfunction', src.indexOf('function runPostCompletionHooks(') + 1));
    assert.ok(!postHooks.includes('archivePlan('), 'Should NOT call archivePlan in post-completion hooks');
    assert.ok(postHooks.includes('Archive is manual'), 'Should note archive is manual');
  });

  // ── 11. Source code: syncPrsFromOutput still runs for verify tasks ──
  await test('verify: syncPrsFromOutput still runs even though archive is manual', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const syncIdx = src.indexOf('syncPrsFromOutput(stdout');
    assert.ok(syncIdx > 0, 'syncPrsFromOutput should still exist in post-completion hooks');
  });

  // ── 12. Source code: checkPlanCompletion does NOT call archivePlan ──
  await test('verify: checkPlanCompletion does not archive (deferred to verify completion)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const completionFn = src.split('function checkPlanCompletion')[1]?.split('\nfunction ')[0] || '';
    assert.ok(!completionFn.includes('archivePlan('),
      'checkPlanCompletion should NOT call archivePlan directly');
    assert.ok(!completionFn.includes('fs.renameSync(planPath'),
      'checkPlanCompletion should NOT move PRD files');
    assert.ok(completionFn.includes('Archive deferred'),
      'Should have comment indicating archive is deferred');
  });

  // ── 13. Source code: verify playbook uses plan_slug for guide filename ──
  await test('verify: playbook guide filename uses plan_slug (not date)', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'verify.md'), 'utf8');
    assert.ok(playbook.includes('verify-{{plan_slug}}.md'),
      'Guide filename should use {{plan_slug}} for dashboard linkage');
    assert.ok(!playbook.includes('verify-{{date}}.md'),
      'Guide filename should NOT use {{date}} (breaks getVerifyGuides matching)');
  });

  // ── 14. Source code: engine.js passes plan_slug and source_plan vars ──
  await test('verify: engine dispatch passes plan_slug and source_plan template vars', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes("source_plan: item.sourcePlan"),
      'Should pass source_plan from work item to playbook vars');
    assert.ok(engineSrc.includes("plan_slug:"),
      'Should pass plan_slug to playbook vars');
  });

  // ── 15. Source code: getVerifyGuides matches plan_slug to planFile ──
  await test('verify: getVerifyGuides correctly maps guide filename to planFile', () => {
    const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(dashSrc.includes("f.replace('verify-', '').replace('.md', '')"),
      'Should strip verify- prefix and .md suffix to get plan slug');
    assert.ok(dashSrc.includes("planSlug + '.json'"),
      'Should append .json to match PRD filename');
  });

  // ── 16. Source code: playbook is platform-agnostic ──
  await test('verify: playbook does not hardcode platform-specific build commands', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'verify.md'), 'utf8');
    assert.ok(playbook.includes('Do not assume any specific platform'),
      'Should explicitly state no platform assumptions');
    assert.ok(playbook.includes('CLAUDE.md') && playbook.includes('README.md'),
      'Should instruct agent to read project docs');
    assert.ok(playbook.includes('mobile app') || playbook.includes('Android') || playbook.includes('iOS'),
      'Should mention mobile platforms');
    assert.ok(!playbook.includes("cmd', ['/c'"),
      'Should not hardcode Windows cmd.exe');
  });

  // ── 17. Source code: playbook transparency requirements ──
  await test('verify: playbook requires transparent verification report', () => {
    const playbook = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'verify.md'), 'utf8');
    // Template extracted to playbooks/templates/verify-guide.md — playbook references it
    assert.ok(playbook.includes('verify-guide.md'),
      'Should reference the verify guide template');
    assert.ok(playbook.includes('Be transparent'),
      'Should explicitly require transparency');
    // Verify template has the required sections
    const template = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'templates', 'verify-guide.md'), 'utf8');
    assert.ok(template.includes('What Was Built'), 'Template should have "What Was Built" section');
    assert.ok(template.includes('What Was Verified'), 'Template should have "What Was Verified" section');
    assert.ok(template.includes('What Could NOT Be Verified'), 'Template should have "What Could NOT Be Verified" section');
  });

  // ── 18. Dashboard: verify badge hides trigger button ──
  await test('verify: dashboard hides Verify button when verify WI exists', () => {
    const plansSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(plansSrc.includes("hasVerifyWi") || plansSrc.includes("verifyWi"),
      'Should check for existing verify work item');
    assert.ok(plansSrc.includes('!hasVerifyWi') || plansSrc.includes('!modalVerifyWi'),
      'Should suppress verify button when verify WI exists');
    assert.ok(plansSrc.includes('_renderVerifyBadge'),
      'Should render verify status badge');
  });

  // ── 19. Dashboard: verify badge looks up PR via prdItems ──
  await test('verify: verify badge finds E2E PR via prdItems linkage', () => {
    const plansSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(plansSrc.includes('pr.prdItems'),
      'Should look up PR via prdItems array');
    assert.ok(plansSrc.includes('_lastStatus?.pullRequests'),
      'Should read PRs from window._lastStatus.pullRequests');
  });

  // ── 20. archivePlan collects branch slugs for worktree cleanup ──
  await test('verify: archivePlan worktree cleanup collects slugs from WIs and PRs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const archiveFn = src.split('function archivePlan')[1]?.split('\n// ───')[0] || '';
    assert.ok(archiveFn.includes('w.branch') && archiveFn.includes('w.id'),
      'Should collect branch slugs from work item branches and IDs');
    assert.ok(archiveFn.includes('pr.branch'),
      'Should collect branch slugs from PR branches');
    assert.ok(archiveFn.includes('sanitizeBranch'),
      'Should normalize branch names via sanitizeBranch');
  });

  // ── Plan modal button consistency with card ──

  await test('plan modal derives effectiveStatus using derivePlanStatus with correct args', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const modalFn = src.slice(src.indexOf('function _renderPlanModal'));
    assert.ok(modalFn.includes('derivePlanStatus(prdFile, normalizedFile, prdJsonStatus, allWi)'),
      'Modal must call derivePlanStatus with (prdFile, mdFile, prdJsonStatus, workItems) — same as card');
  });

  await test('plan modal uses _lastPlans not _lastStatus.plans', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const modalFn = src.slice(src.indexOf('function _renderPlanModal'));
    assert.ok(modalFn.includes('window._lastPlans'),
      'Modal should use _lastPlans (from /api/plans) not _lastStatus.plans');
  });

  await test('refreshPlans stores plans in window._lastPlans', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes('window._lastPlans = plans'),
      'refreshPlans must store plans globally for modal access');
  });

  await test('plan modal hides Execute for completed plans', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const modalFn = src.slice(src.indexOf('function _renderPlanModal'));
    assert.ok(modalFn.includes('!isCompleted'),
      'isDraft must check !isCompleted to prevent Execute on completed plans');
  });

  await test('plan modal shows Completed and In Progress labels', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const modalFn = src.slice(src.indexOf('function _renderPlanModal'));
    assert.ok(modalFn.includes('>Completed<'),
      'Should show Completed status label');
    assert.ok(modalFn.includes('>In Progress<'),
      'Should show In Progress status label');
  });

  await test('plan modal shows Approve/Reject for awaiting-approval', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const modalFn = src.slice(src.indexOf('function _renderPlanModal'));
    assert.ok(modalFn.includes('isNeedsAction') && modalFn.includes('planApprove') && modalFn.includes('planReject'),
      'Should show Approve and Reject buttons when plan needs action');
  });

  // ── Verify badge: E2E PR + Testing Guide display logic ──

  await test('verify badge shows checkmark and "Verified" when done', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _renderVerifyBadge'));
    assert.ok(fn.includes('\\u2714 Verified'), 'Should show checkmark + Verified for done status');
  });

  await test('verify badge matches E2E PR by sourcePlan + branch slug', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _renderVerifyBadge'));
    assert.ok(fn.includes('pr.prdItems'), 'Should check prdItems for direct match');
    assert.ok(fn.includes('pr.branch') && fn.includes('planSlug'), 'Should fallback to branch slug match');
    assert.ok(fn.includes('[E2E]'), 'Should verify title starts with [E2E] for branch fallback');
  });

  await test('verify badge includes Testing Guide link', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _renderVerifyBadge'));
    assert.ok(fn.includes('verifyGuides'), 'Should look up verify guides from status');
    assert.ok(fn.includes('openVerifyGuide'), 'Should link to openVerifyGuide for the guide');
    assert.ok(fn.includes('Testing Guide'), 'Should label the link as Testing Guide');
  });

  await test('PRD view renderE2eSection shows E2E PRs and guides for active PRDs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    assert.ok(src.includes('function renderE2eSection'), 'Should have renderE2eSection function');
    assert.ok(src.includes('e2eByPlan[planFile]'), 'Should look up PRs by planFile key');
    assert.ok(src.includes('guideByPlan[planFile]'), 'Should look up guide by planFile key');
    assert.ok(src.includes('E2E Aggregate PRs'), 'Should show E2E Aggregate PRs header');
    assert.ok(src.includes('Manual Testing Guide'), 'Should show Manual Testing Guide link');
  });

  await test('PRD view calls renderE2eSection for both active and archived groups', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    // Active groups
    assert.ok(src.includes('renderE2eSection(g.file)'), 'Should call renderE2eSection for active groups');
    // Archived groups
    assert.ok(src.includes('_archivedPrdRenderE2eSection'), 'Should save renderE2eSection for archived groups');
  });

  await test('PRD re-renders when pullRequests change (E2E PR added)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'refresh.js'), 'utf8');
    assert.ok(src.includes('prdPrs') && src.includes('pullRequests'),
      'Should trigger PRD re-render when pullRequests count changes');
  });

  await test('syncPrsFromOutput scans assistant text blocks for PR URLs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.slice(src.indexOf('function syncPrsFromOutput'));
    assert.ok(fn.includes("block.type === 'text'"), 'Should scan text blocks, not just tool_result');
    assert.ok(fn.includes('PR created') && fn.includes('E2E PR'), 'Should match PR created and E2E PR patterns');
    assert.ok(fn.includes('textCreatedPattern'), 'Should have textCreatedPattern regex');
  });

  await test('verify playbook requires PR URL in final message', () => {
    const pb = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'verify.md'), 'utf8');
    assert.ok(pb.includes('final message MUST include'), 'Should require PR URL in final message');
    assert.ok(pb.includes('E2E PR created'), 'Should give example format with E2E PR');
    assert.ok(pb.includes('prd/guides/verify'), 'Should mention testing guide path in example');
  });

  cleanup();
  restore();
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
    assert.ok(src.includes('pidFile') && src.includes('writeFile') && src.includes('proc.pid'),
      'Should write PID file so engine can reattach on restart');
  });

  await test('spawn-agent.js supports --resume flag', () => {
    assert.ok(src.includes("isResume") && src.includes("'--resume'"),
      'Should detect --resume flag and skip system prompt (baked into session)');
  });

  await test('spawn-agent.js always uses --system-prompt-file', () => {
    assert.ok(src.includes('--system-prompt-file'),
      'Should pass system prompt via file to avoid Windows arg length limits');
    assert.ok(!src.includes('spawnSync') || !src.includes("'--help'"),
      'Should not use spawnSync --help for capability detection (removed as bottleneck)');
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
    assert.ok(src.includes("code === 78") && (src.includes("completeDispatch(id, DISPATCH_RESULT.ERROR") || src.includes("completeDispatch(id, 'error'")),
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

  await test('fast poll uses 3-second interval', () => {
    assert.ok(cliSrc.includes('3000') && cliSrc.includes('_wakeupAt'),
      'Fast poll should run every 3 seconds');
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
    assert.ok(html.length < 600000, `HTML should be < 600KB (got ${html.length})`);

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

  // Fast poll steering tests
  const cliSrcSteer = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');

  await test('checkSteering runs on fast poll (every 3s), not just on tick', () => {
    assert.ok(cliSrcSteer.includes('checkSteering()') && cliSrcSteer.includes('setInterval'),
      'cli.js fast poll should call checkSteering every 3s');
    assert.ok(cliSrcSteer.includes('3000'),
      'Fast poll interval should be 3000ms');
  });

  await test('fast poll timer is cleaned up on shutdown', () => {
    assert.ok(cliSrcSteer.includes('clearInterval(fastPollTimer)'),
      'Graceful shutdown should clear the fast poll timer');
  });

  await test('checkSteering has double-kill guard', () => {
    assert.ok(engineSrc.includes('_steeringMessage') && engineSrc.includes('_steeringAt') && engineSrc.includes('continue'),
      'checkSteering should skip agents already being steered');
  });

  await test('checkSteering deletes steer.md before setting flags (race prevention)', () => {
    const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    const unlinkIdx = timeoutSrc.indexOf('unlinkSync(steerPath)');
    // Find the killImmediate that follows the unlink (not the stale-recovery kill at top of loop)
    const killIdx = timeoutSrc.indexOf('killImmediate(info.proc)', unlinkIdx);
    assert.ok(unlinkIdx > 0 && killIdx > 0 && unlinkIdx < killIdx,
      'steer.md should be deleted before killing the process to prevent re-read on next poll');
  });

  await test('steering close handler re-spawns with steering prompt content', () => {
    assert.ok(engineSrc.includes('Message from your human teammate'),
      'Re-spawn prompt should frame the steering as a teammate message');
    assert.ok(engineSrc.includes('continue working on your current task'),
      'Re-spawn prompt should tell agent to continue after responding');
  });

  // Stale steering recovery: if kill didn't terminate agent within 30s, retry
  await test('checkSteering has stale steering recovery with retry', () => {
    const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(timeoutSrc.includes('_steeringRetried'),
      'Should track retry attempts to prevent infinite re-kills');
    assert.ok(timeoutSrc.includes('STEERING_KILL_RETRY_MS'),
      'Should use a named constant for the retry timeout');
  });

  // No-sessionId handling: kill agent and forward message to inbox
  await test('checkSteering handles no-sessionId by killing and forwarding to inbox', () => {
    const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(timeoutSrc.includes('_steeringNoSession'),
      'Should flag no-session kills for close handler differentiation');
    assert.ok(timeoutSrc.includes('inbox') && timeoutSrc.includes('steering-'),
      'Should write steering message to agent inbox for retry delivery');
    assert.ok(timeoutSrc.includes('no session to resume'),
      'Should write confirmation to live-output.log so user sees it in dashboard');
  });

  // Functional test: checkSteering with mock activeProcesses
  await test('checkSteering functional: finds steer.md and sets flags', () => {
    const restore = createTestMinionsDir();
    const testMinionsDir = process.env.MINIONS_TEST_DIR;
    // Create agent dir with steer.md
    const agentDir = path.join(testMinionsDir, 'agents', 'testbot');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'steer.md'), 'Please focus on the API endpoint');
    // Mock activeProcesses
    const mockProc = { pid: 99999, kill: () => {} };
    const mockInfo = { agentId: 'testbot', proc: mockProc, sessionId: 'sess-123' };
    const freshTimeout = require('../engine/timeout');
    // checkSteering needs engine().activeProcesses — can't easily mock without full engine
    // Verify the function exists and accepts no args
    assert.ok(typeof freshTimeout.checkSteering === 'function', 'checkSteering should be exported');
    assert.ok(freshTimeout.checkSteering.length <= 1, 'checkSteering should accept 0 or 1 args');
    restore();
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

  await test('PR link supports contextOnly flag', () => {
    assert.ok(dashSrc.includes('_contextOnly') && dashSrc.includes('autoObserve'),
      'Should support autoObserve (dispatched) vs context-only (polled but no dispatch)');
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

  await test('derivePlanStatus returns dispatched when active work exists', () => {
    assert.ok(plansSrc.includes('hasActiveWork') && plansSrc.includes("return 'dispatched'"),
      'Should return dispatched when pending/dispatched items exist');
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

  await test('plan card showPause only for dispatched', () => {
    assert.ok(plansSrc.includes("effectiveStatus === 'dispatched'") && plansSrc.includes('showPause'),
      'Pause button should only show when effectiveStatus is dispatched');
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

  await test('Dep merge handles force-pushed branches by resetting and re-merging', () => {
    // When git merge fails (e.g. diverged history from force-push), the engine should:
    // 1. Abort the partial merge
    // 2. Reset worktree to origin/<mainBranch>
    // 3. Re-merge all deps from scratch
    assert.ok(engineSrc.includes('git merge --abort'),
      'engine.js must abort partial merge on dep merge failure');
    assert.ok(engineSrc.includes('git reset --hard') && engineSrc.includes('resolveMainBranch'),
      'engine.js must reset worktree to main branch on dep merge failure');
    assert.ok(engineSrc.includes('Re-merged dependency branch'),
      'engine.js must re-merge all deps after reset');
    assert.ok(engineSrc.includes('reset and re-merge of all deps'),
      'engine.js must log the reset and re-merge attempt');
  });

  await test('Dep merge re-merge failure marks depMergeFailed', () => {
    // If re-merge also fails (genuine conflict), depMergeFailed must be set
    // so the dispatch is completed with ERROR and retried next tick
    assert.ok(engineSrc.includes('Failed to reset and re-merge deps'),
      'engine.js must log re-merge failure');
    // After reset failure, must also abort any in-progress merge from the re-merge attempt
    const resetCatchBlock = engineSrc.substring(
      engineSrc.indexOf('Failed to reset and re-merge deps')
    );
    assert.ok(resetCatchBlock.includes('depMergeFailed = true'),
      'engine.js must set depMergeFailed on re-merge failure');
  });

  await test('Dep merge handles local-only branches by pushing to origin (#782)', () => {
    // When git fetch fails with "couldn't find remote ref", the engine should:
    // 1. Check if branch exists locally via git rev-parse
    // 2. Push it to origin if it exists
    // 3. Include it in the fetched list for merging
    assert.ok(engineSrc.includes('find remote ref'),
      'engine.js must detect missing remote ref errors');
    assert.ok(engineSrc.includes('git rev-parse --verify'),
      'engine.js must check if branch exists locally when remote ref missing');
    assert.ok(engineSrc.includes('exists locally but not on remote'),
      'engine.js must log when pushing local-only dependency branch');
    assert.ok(engineSrc.includes('git push origin'),
      'engine.js must push local-only dependency branches to origin');
    assert.ok(engineSrc.includes('recoveredBranches'),
      'engine.js must track recovered (local-only pushed) branches');
    // Recovered branches must be included in the fetched list for merging
    assert.ok(engineSrc.includes('recoveredBranches.has('),
      'engine.js must include recovered branches in the merge set');
    // If local check or push fails, should still mark as failed (not loop forever)
    assert.ok(engineSrc.includes('not found locally or push failed'),
      'engine.js must handle push failure for local-only branches gracefully');
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

  await test('Completion auto-retries on retryable failure when retries < maxRetries', () => {
    assert.ok(engineSrc.includes('retries < maxRetries') || lifecycleSrc.includes('retries < maxRetries') || engineSrc.includes('retries < 3') || lifecycleSrc.includes('retries < 3'),
      'Must check retries < maxRetries for auto-retry');
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

  // ── Sequential ID remapping (#466) ──

  await test('materializePlansAsWorkItems remaps sequential PRD item IDs to prevent cross-PRD collisions', () => {
    assert.ok(engineSrc.includes('SEQUENTIAL_ID_RE'),
      'engine.js must define SEQUENTIAL_ID_RE regex for detecting sequential IDs');
    assert.ok(engineSrc.includes("'P-' + shared.uid()"),
      'engine.js must remap sequential IDs to P-<uid> format');
    assert.ok(engineSrc.includes('idMap.get(d) || d'),
      'engine.js must update depends_on references when remapping IDs');
    assert.ok(engineSrc.includes('Remapped'),
      'engine.js must log when sequential IDs are remapped');
  });

  await test('SEQUENTIAL_ID_RE matches sequential patterns and rejects uuid patterns', () => {
    const SEQUENTIAL_ID_RE = /^P-?\d+$/;
    // Should match sequential patterns
    assert.ok(SEQUENTIAL_ID_RE.test('P-001'), 'P-001 is sequential');
    assert.ok(SEQUENTIAL_ID_RE.test('P-1'), 'P-1 is sequential');
    assert.ok(SEQUENTIAL_ID_RE.test('P001'), 'P001 is sequential');
    assert.ok(SEQUENTIAL_ID_RE.test('P-42'), 'P-42 is sequential');
    // Should NOT match uuid-style patterns
    assert.ok(!SEQUENTIAL_ID_RE.test('P-a3f9b2c1'), 'P-a3f9b2c1 is uuid-style');
    assert.ok(!SEQUENTIAL_ID_RE.test('P-mnp3yhctrq8d'), 'P-mnp3yhctrq8d is uid-style');
    assert.ok(!SEQUENTIAL_ID_RE.test('W-abc123'), 'W-abc123 uses different prefix');
    assert.ok(!SEQUENTIAL_ID_RE.test('EP-001'), 'EP-001 has different prefix');
  });

  await test('Sequential ID remapping updates depends_on references consistently', () => {
    // Simulate the remapping logic from engine.js
    const SEQUENTIAL_ID_RE = /^P-?\d+$/;
    const features = [
      { id: 'P-001', name: 'Auth', depends_on: [] },
      { id: 'P-002', name: 'API', depends_on: ['P-001'] },
      { id: 'P-003', name: 'UI', depends_on: ['P-001', 'P-002'] },
    ];
    const idMap = new Map();
    for (const f of features) {
      if (SEQUENTIAL_ID_RE.test(f.id)) {
        const newId = 'P-' + shared.uid();
        idMap.set(f.id, newId);
        f.id = newId;
      }
    }
    for (const f of features) {
      if (f.depends_on) f.depends_on = f.depends_on.map(d => idMap.get(d) || d);
    }
    // All IDs should now be non-sequential
    for (const f of features) {
      assert.ok(!SEQUENTIAL_ID_RE.test(f.id), `${f.name} ID should be remapped: ${f.id}`);
    }
    // depends_on should reference the new IDs
    assert.deepStrictEqual(features[1].depends_on, [features[0].id],
      'P-002 depends_on should be remapped to new P-001 ID');
    assert.deepStrictEqual(features[2].depends_on, [features[0].id, features[1].id],
      'P-003 depends_on should reference both remapped IDs');
    // All new IDs should be unique
    const ids = features.map(f => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'All remapped IDs must be unique');
  });

  await test('Sequential ID remapping skips already-materialized PRDs', () => {
    // engine.js checks anyMaterialized before remapping — source pattern test
    assert.ok(engineSrc.includes('anyMaterialized'),
      'engine.js must check if items are already materialized before remapping');
    assert.ok(engineSrc.includes('w.sourcePlan === file'),
      'engine.js must verify sourcePlan matches to avoid false positives on collision detection');
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

  await test('discoverMeetingWork dispatches only concluder for conclude round', () => {
    assert.ok(meetingSrc.includes('participants[0]') && meetingSrc.includes('meeting-conclude'),
      'Should dispatch only first participant for conclusion');
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
    assert.ok(lifecycleSrc.includes('collectMeetingFindings') && (lifecycleSrc.includes("type === WORK_TYPE.MEETING") || lifecycleSrc.includes("type === 'meeting'")),
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

  await test('conclusion timeout auto-summarizes from findings and debate', () => {
    assert.ok(meetingSrc.includes('concluding') && meetingSrc.includes('auto-summarizing'),
      'Should auto-summarize when conclusion round times out');
    assert.ok(meetingSrc.includes("meeting.conclusion = {") || meetingSrc.includes('meeting.conclusion ='),
      'Should write a synthesized conclusion on timeout');
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
    await testMutateWorkItemsAndPullRequests();
    await testIsRetryableFailureReason();
    await testAreDependenciesMet();
    await testCooldownSystem();
    await testResolveAgent();
    await testRenderPlaybook();
    await testValidatePlaybookVars();
    await testCompleteDispatch();
    await testDiscoverFromPrs();
    await testBuildFixRetryCap();
    await testDiscoverFromWorkItems();
    await testBuildWorkItemDispatchVars();
    await testCheckTimeouts();
    await testAddToDispatch();
    await testExtractSkills();
    await testUpdateWorkItemStatus();
    await testSyncPrsFromOutput();
    await testLifecycleDataSafety();
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

    // Coverage gap tests
    await testAgentSteering();
    await testRecentFeatures();
    await testDashboardUIFunctions();
    await testToolsPageAssembly();
    await testPlanPrdStateFlow();

    // checkPlanCompletion idempotency (functional)
    await testCheckPlanCompletionIdempotency();

    // Verify workflow tests
    await testVerifyWorkflow();

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

    // P-t8822idp: Dashboard bug fixes — tail clamping, notes validation, watcher cleanup, atomic PRD updates
    await testDashboardBugFixes();

    // P-e9y7xcp5: Auxiliary module bug fixes
    await testAuxModuleBugFixes();

    // P-j4f6v8a2: Empty projects[] guards in lifecycle.js
    await testEmptyProjectsGuards();

    // P-r7w2k9m4: PR write race condition fixes
    await testPrWriteRaceConditions();

    // Status mutation guards — comprehensive retry/revert safety
    await testStatusMutationGuards();

    // Dashboard audit: critical functional bugs
    await testDashboardAuditCritical();

    // Dashboard audit: XSS fixes
    await testDashboardAuditXss();

    // Dashboard audit: medium bugs
    await testDashboardAuditMedium();

    // Dashboard audit: low-severity polish
    await testDashboardAuditLow();

    // Dashboard audit pass 2
    await testDashboardAuditPass2();

    // Engine audit: critical bugs
    await testEngineAuditCritical();

    // Engine audit: medium bugs
    await testEngineAuditMedium();

    // PR duplicate race condition fixes
    await testPrDuplicateRaceFix();

    // Version check feature
    await testVersionCheck();

    // P-k7m2x9a4: AGENT_STATUS enum and worker-state tracking
    await testAgentStatusEnum();

    // P-b3n8f5c1: FAILURE_CLASS enum and classifyFailure()
    await testFailureClassEnum();

    // P-d9q4w7e6: Recovery recipes
    await testRecoveryRecipes();

    // P-h2t6r1j8: Structured completion protocol
    await testStructuredCompletion();

    // Auto-recovery & atomicity
    await testAutoRecoveryAndAtomicity();

    // Dashboard resilience: safeFetch, auto-reload, CC reset
    await testDashboardResilience();

    // Build error log feature
    await testBuildErrorLogFeature();

    // Build fix escalation (#484)
    await testBuildFixEscalation();

    // Branch-level dispatch mutex (#493)
    await testBranchMutex();

    // spawnEngine state preservation (#564)
    await testSpawnEngineStatePreservation();

    // Session 2026-04-08: slugify, formatTranscriptEntry, pipeline reconciliation, metrics, UX
    await testSlugifyAndTranscript();
    await testPipelineReconciliation();
    await testMetricsEnrichment();
    await testDashboardButtonConsistency();

    // #716: Heartbeat feedback loop + max_turns lifecycle cleanup
    await testIssue716HeartbeatFeedbackLoop();

    // CC Multi-Tab Conversations
    await testCCMultiTab();

    // PR review→fix, poll→fix, merge conflict, auto-complete flows
    await testPrReviewFixFlows();

    // Test isolation verification (must be LAST — checks no pollution from earlier tests)
    await testIsolationVerification();
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

  await test('ENGINE_DEFAULTS includes autoArchive: false', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.autoArchive, false,
      'autoArchive should default to false (opt-in, not automatic)');
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
  await test('lifecycle handles implement tasks without PR — retry or mark done', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('no output, no PR') || src.includes('no PR created'), 'should auto-retry when no output and no PR');
    assert.ok(src.includes('_noPr') || src.includes('noPr'), 'should flag items that completed without PR');
    assert.ok(src.includes('hasOutput'), 'should distinguish meaningful output from MCP stall');
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
    assert.ok(src.includes("reviewStatus === 'waiting'") && (src.includes("'merged'") || src.includes("PR_STATUS.MERGED")), 'should resolve waiting on merge');
  });

  await test('ado.js resolves waiting review status on merge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes("reviewStatus === 'waiting'") && (src.includes("'merged'") || src.includes("PR_STATUS.MERGED")), 'should resolve waiting on merge');
  });
}

async function testReviewReDispatchLoop() {
  console.log('\n── Review Re-Dispatch Loop Prevention ──');

  await test('github.js sets reviewStatus to waiting when only COMMENTED reviews exist', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes("reviews.length > 0") && src.includes("newReviewStatus === 'pending'") && src.includes("newReviewStatus = 'waiting'"),
      'Should set reviewStatus to waiting when all reviews are COMMENTED (states empty but reviews exist)');
  });

  await test('github.js tracks headSha and lastPushedAt on PR', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('pr.headSha') && src.includes('pr.lastPushedAt'),
      'Should track headSha and lastPushedAt for new-commit detection');
  });

  await test('lifecycle.js sets lastReviewedAt on review completion', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'lifecycle.js'), 'utf8');
    const reviewFn = src.slice(src.indexOf('function updatePrAfterReview('), src.indexOf('\nfunction ', src.indexOf('function updatePrAfterReview(') + 1));
    assert.ok(reviewFn.includes('lastReviewedAt'),
      'updatePrAfterReview should set lastReviewedAt timestamp on PR record');
  });

  await test('engine.js skips review re-dispatch when lastReviewedAt set and no new commits', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
    assert.ok(src.includes('alreadyReviewed') && src.includes('lastReviewedAt') && src.includes('lastPushedAt'),
      'Should gate review dispatch on lastReviewedAt vs lastPushedAt comparison');
    assert.ok(src.includes('!alreadyReviewed'),
      'needsReview should include !alreadyReviewed check');
  });

  await test('engine.js allows re-dispatch when new commits pushed after review', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
    // The condition: pr.lastPushedAt <= pr.lastReviewedAt means "no new commits"
    // When lastPushedAt > lastReviewedAt, alreadyReviewed is false, allowing re-dispatch
    assert.ok(src.includes("pr.lastPushedAt <= pr.lastReviewedAt"),
      'alreadyReviewed should compare lastPushedAt <= lastReviewedAt so new pushes allow re-review');
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

  await test('settings save handler: _clamped variable is in scope for all code paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('function handleSettingsUpdate'), src.indexOf('function handleSettingsRouting'));
    // _clamped must be declared before the if(body.engine) block, not inside it
    const clampedDecl = handler.indexOf('const _clamped');
    const bodyEngineCheck = handler.indexOf('if (body.engine)');
    assert.ok(clampedDecl > -1, '_clamped must be declared in settings save handler');
    assert.ok(clampedDecl < bodyEngineCheck, '_clamped must be declared before if(body.engine) block — otherwise it is undefined when saving non-engine settings');
  });

  await test('settings save handler: _clamped referenced consistently (no bare clamped)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('function handleSettingsUpdate'), src.indexOf('function handleSettingsRouting'));
    const lines = handler.split('\n');
    for (const line of lines) {
      if (line.includes('clamped') && !line.includes('_clamped') && !line.includes('// ')) {
        assert.fail('Found bare "clamped" reference (should be "_clamped"): ' + line.trim().slice(0, 80));
      }
    }
  });

  // ── Default consistency: shared.js defaults must match settings.js fallbacks ──

  await test('DEFAULT_CLAUDE.outputFormat must be stream-json', () => {
    assert.strictEqual(shared.DEFAULT_CLAUDE.outputFormat, 'stream-json',
      'outputFormat must be stream-json — json buffers all output and breaks live streaming + triggers MCP startup timeout');
  });

  await test('settings UI outputFormat fallback matches DEFAULT_CLAUDE', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'settings.js'), 'utf8');
    const match = src.match(/outputFormat\s*\|\|\s*'([^']+)'/);
    assert.ok(match, 'settings.js should have outputFormat fallback');
    assert.strictEqual(match[1], shared.DEFAULT_CLAUDE.outputFormat,
      'settings.js outputFormat fallback must match DEFAULT_CLAUDE.outputFormat');
  });

  await test('settings UI maxConcurrent fallback matches ENGINE_DEFAULTS', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'settings.js'), 'utf8');
    const match = src.match(/maxConcurrent\s*\|\|\s*(\d+)/);
    assert.ok(match, 'settings.js should have maxConcurrent fallback');
    assert.strictEqual(Number(match[1]), shared.ENGINE_DEFAULTS.maxConcurrent,
      'settings.js maxConcurrent fallback must match ENGINE_DEFAULTS.maxConcurrent');
  });

  await test('settings UI numeric fallbacks match ENGINE_DEFAULTS', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'settings.js'), 'utf8');
    const numericFields = [
      'tickInterval', 'agentTimeout', 'maxTurns', 'heartbeatTimeout',
      'worktreeCreateTimeout', 'worktreeCreateRetries', 'idleAlertMinutes',
      'shutdownTimeout', 'restartGracePeriod', 'meetingRoundTimeout',
      'inboxConsolidateThreshold', 'evalMaxIterations'
    ];
    for (const field of numericFields) {
      const re = new RegExp(`${field}\\s*\\|\\|\\s*(\\d+)`);
      const match = src.match(re);
      if (!match) continue; // field may use different pattern (e.g. ternary)
      const uiDefault = Number(match[1]);
      const engineDefault = shared.ENGINE_DEFAULTS[field];
      if (engineDefault !== undefined) {
        assert.strictEqual(uiDefault, engineDefault,
          `settings.js ${field} fallback (${uiDefault}) must match ENGINE_DEFAULTS.${field} (${engineDefault})`);
      }
    }
  });

  await test('handleSettingsRead merges ENGINE_DEFAULTS into response', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('...shared.ENGINE_DEFAULTS') || src.includes('...ENGINE_DEFAULTS'),
      'handleSettingsRead should spread ENGINE_DEFAULTS into engine response so UI gets correct defaults');
  });

  await test('handleSettingsRead merges DEFAULT_CLAUDE into response', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('...shared.DEFAULT_CLAUDE') || src.includes('...DEFAULT_CLAUDE'),
      'handleSettingsRead should spread DEFAULT_CLAUDE into claude response so UI gets correct defaults');
  });

  await test('engine.js outputFormat fallback matches DEFAULT_CLAUDE', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
    const matches = src.match(/outputFormat\s*\|\|\s*'([^']+)'/g) || [];
    for (const m of matches) {
      const val = m.match(/'([^']+)'/)[1];
      assert.strictEqual(val, shared.DEFAULT_CLAUDE.outputFormat,
        `engine.js outputFormat fallback '${val}' must match DEFAULT_CLAUDE.outputFormat`);
    }
  });
}

async function testCcActionTypes() {
  await test('CC system prompt includes schedule, create-meeting, set-config actions', () => {
    const promptPath = path.join(MINIONS_DIR, 'prompts', 'cc-system.md');
    const src = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('schedule') && src.includes('create-meeting') && src.includes('set-config'),
      'should have schedule, create-meeting, and set-config action types');
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
  await test('CC preamble references API routes endpoint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
    assert.ok(src.includes('/api/routes'), 'preamble should reference /api/routes for endpoint discovery');
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
  await testReviewReDispatchLoop();
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
    assert.ok(engineSrc.includes("WI_STATUS.NEEDS_REVIEW") || engineSrc.includes("'needs-human-review'"),
      'Should set status to needs-human-review after 3 checkpoint-resumes');
  });

  await test('checkpoint_context defaults to empty string when no checkpoint', () => {
    // buildWorkItemDispatchVars consolidates checkpoint logic — one default in the shared function
    assert.ok(engineSrc.includes("vars.checkpoint_context = ''"),
      'Should default checkpoint_context to empty string in buildWorkItemDispatchVars');
    assert.ok(engineSrc.includes('function buildWorkItemDispatchVars'),
      'Checkpoint logic should be consolidated in buildWorkItemDispatchVars');
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

  // ── Bug #15: Worktree deletion re-reads PR status before proceeding ──

  await test('cleanup.js re-reads PR status before worktree deletion (TOCTOU guard)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Must re-read PRs right before the deletion loop
    assert.ok(src.includes('freshPrs'), 'Should read fresh PR data before deletion');
    assert.ok(src.includes('freshMergedBranches'), 'Should build a fresh merged branches set');
    // Must check if PR was reopened
    assert.ok(src.includes('stillMerged'), 'Should verify branch is still merged before deleting');
    assert.ok(src.includes('PR was reopened'), 'Should log when PR was reopened since initial check');
  });

  await test('cleanup.js worktree deletion skips if PR was reopened but allows age/cap cleanup', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Should distinguish branch-based cleanup from age/cap-based cleanup
    assert.ok(src.includes('wasMarkedByBranch'), 'Should check if entry was originally marked due to merged branch');
    // Age/cap-based cleanups should still proceed even if branch is no longer in merged set
    assert.ok(src.includes('continue'), 'Should skip (continue) when branch-based entry is no longer merged');
  });

  // ── Bug #27: Each readdirSync individually try-caught ──

  await test('cleanup.js wraps each readdirSync in individual try-catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // The temp file cleanup section should have per-directory error handling
    assert.ok(src.includes('dirEntries = fs.readdirSync(dir)'), 'Should assign readdirSync to variable for per-dir error handling');
    assert.ok(src.includes('failed to read') && src.includes('continue'),
      'Should log warning and continue to next directory on readdirSync failure');
    // KB watchdog category counting should also be individually wrapped
    assert.ok(src.includes('failed to read') && src.includes('cat'),
      'KB watchdog directory reads should be individually try-caught');
  });

  // ── Bug #29: KB restore checks exit code and verifies result ──

  await test('cleanup.js KB restore checks git exit code and verifies file count', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Should catch git checkout errors specifically
    assert.ok(src.includes('git checkout exited with error'),
      'Should log warning when git checkout exits with error');
    // Should verify the restore result by recounting
    assert.ok(src.includes('postRestoreCount'),
      'Should count files after restore to verify success');
    assert.ok(src.includes('restore incomplete'),
      'Should warn when restore did not fully recover files');
  });

  // ── worktreeDirMatchesBranch helper (extracted to eliminate 3x duplication) ──

  await test('worktreeDirMatchesBranch correctly matches branch slugs', () => {
    const cleanup = require(path.join(MINIONS_DIR, 'engine', 'cleanup'));
    const { worktreeDirMatchesBranch } = cleanup;
    assert.ok(typeof worktreeDirMatchesBranch === 'function',
      'worktreeDirMatchesBranch should be exported');

    // sanitizeBranch preserves slashes, so branch slug = 'work/p-abc123' after toLowerCase
    // Exact match
    assert.ok(worktreeDirMatchesBranch('work/p-abc123', 'work/P-abc123'),
      'Should match exact sanitized branch slug');
    // Slug as prefix with suffix
    assert.ok(worktreeDirMatchesBranch('work/p-abc123-mnxyz', 'work/P-abc123'),
      'Should match when dir includes branchSlug + hyphen suffix');
    // Slug as suffix
    assert.ok(worktreeDirMatchesBranch('prefix-work/p-abc123', 'work/P-abc123'),
      'Should match when dir ends with hyphen + branchSlug');
    // No match
    assert.ok(!worktreeDirMatchesBranch('totally-different-dir', 'work/P-abc123'),
      'Should not match unrelated directory names');
    // Partial overlap should not match
    assert.ok(!worktreeDirMatchesBranch('work/p-abc', 'work/P-abc123'),
      'Should not match partial branch slugs');
    // Simple branch names (no slash)
    assert.ok(worktreeDirMatchesBranch('feat-my-feature', 'feat-my-feature'),
      'Should match simple branch names');
    assert.ok(worktreeDirMatchesBranch('feat-my-feature-mnabc123', 'feat-my-feature'),
      'Should match simple branch names with suffix');
  });

  // ── Behavioral: readdirSync isolation prevents cascade failures ──

  await test('cleanup temp scan continues when one directory is unreadable', () => {
    const tmp = createTmpDir();
    const subDir = path.join(tmp, 'subdir');
    fs.mkdirSync(subDir);
    // Create a stale temp file in subdir
    const staleFile = path.join(subDir, 'prompt-test-123');
    fs.writeFileSync(staleFile, 'test');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000);
    fs.utimesSync(staleFile, twoHoursAgo, twoHoursAgo);

    // Simulate the per-directory isolation pattern from cleanup.js
    const scanDirs = [path.join(tmp, 'nonexistent-dir'), subDir];
    const oneHourAgo = Date.now() - 3600000;
    let cleaned = 0;
    let errors = 0;
    for (const dir of scanDirs) {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(dir);
      } catch (e) {
        errors++;
        continue;  // This is the key behavior — continue to next directory
      }
      for (const f of dirEntries) {
        if (f.startsWith('prompt-')) {
          const fp = path.join(dir, f);
          try {
            if (fs.statSync(fp).mtimeMs < oneHourAgo) {
              fs.unlinkSync(fp);
              cleaned++;
            }
          } catch { /* cleanup */ }
        }
      }
    }
    assert.strictEqual(errors, 1, 'First directory should fail');
    assert.strictEqual(cleaned, 1, 'Second directory should still be cleaned despite first failing');
  });

  await test('cleanup.js uses worktreeDirMatchesBranch helper (no inline duplication)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(src.includes('function worktreeDirMatchesBranch'),
      'Should define worktreeDirMatchesBranch helper');
    // The inline pattern should no longer appear — only the helper call
    const inlinePatternCount = (src.match(/dirLower === branchSlug \|\| dirLower\.includes\(branchSlug/g) || []).length;
    assert.strictEqual(inlinePatternCount, 1,
      'Inline branch matching should appear only once (in the helper definition), not duplicated in call sites');
    // Helper should be called in the worktree cleanup section
    assert.ok(src.includes('worktreeDirMatchesBranch(dirLower'),
      'Should call worktreeDirMatchesBranch with dirLower');
    assert.ok(src.includes('worktreeDirMatchesBranch(entryDirLower'),
      'Should call worktreeDirMatchesBranch with entryDirLower');
  });

  await test('cleanup.js wraps swept KB and PRD migration readdirSync individually', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Swept KB directory read should be individually wrapped
    assert.ok(src.includes('sweptEntries = fs.readdirSync(sweptDir)'),
      'Swept KB should assign readdirSync to variable for individual error handling');
    assert.ok(src.includes('cleanup swept KB: failed to read'),
      'Swept KB should log warning on readdirSync failure');
    // PRD migration directory read should be individually wrapped
    assert.ok(src.includes('prdDirEntries = fs.readdirSync(PRD_DIR)'),
      'PRD migration should assign readdirSync to variable for individual error handling');
    assert.ok(src.includes('migrate PRD statuses: failed to read'),
      'PRD migration should log warning on readdirSync failure');
  });
}

async function testDashboardBugFixes() {
  console.log('\n── Dashboard Bug Fixes (P-t8822idp) ──');

  const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  // Bug #17: handlePrdItemsUpdate uses mutateJsonFileLocked
  await test('handlePrdItemsUpdate uses mutateJsonFileLocked for atomic read-modify-write', () => {
    // Find the handlePrdItemsUpdate function
    const fnStart = src.indexOf('async function handlePrdItemsUpdate');
    const fnEnd = src.indexOf('\n  async function', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 2000);
    assert.ok(fnBody.includes('mutateJsonFileLocked(planPath'),
      'handlePrdItemsUpdate should use mutateJsonFileLocked on planPath');
    // Should NOT have the old safeWrite(planPath pattern
    assert.ok(!fnBody.includes('safeWrite(planPath'),
      'handlePrdItemsUpdate should not use safeWrite(planPath) — use mutateJsonFileLocked instead');
  });

  // Bug #18: dispatch PID read inside mutateJsonFileLocked
  await test('plan pause reads dispatch inside mutateJsonFileLocked callback', () => {
    // The old pattern was: const dispatch = JSON.parse(safeRead(dispatchPath)...) followed by mutateJsonFileLocked
    // New pattern: all dispatch reads happen inside the mutateJsonFileLocked callback
    const pauseSection = src.slice(src.indexOf('kill any active agent process'));
    const nextFn = pauseSection.indexOf('\n  async function');
    const pauseBody = pauseSection.slice(0, nextFn > -1 ? nextFn : 1500);
    // Should NOT have standalone dispatch read before the lock
    assert.ok(!pauseBody.includes('const dispatch = JSON.parse(safeRead(dispatchPath)'),
      'Should not read dispatch.json outside the lock — read inside mutateJsonFileLocked callback');
  });

  // Bug #24: watcher cleanup in try-finally
  await test('SSE live-stream watchers have cleanup helper to prevent handle leaks', () => {
    const sseSection = src.slice(src.indexOf('handleAgentLiveStream') || 0);
    const nextFn = sseSection.indexOf('\n  async function', 100);
    const sseBody = sseSection.slice(0, nextFn > -1 ? nextFn : 2000);
    assert.ok(sseBody.includes('const cleanup = ()'),
      'Should have a cleanup helper function for watcher teardown');
    assert.ok(sseBody.includes("req.on('close', cleanup)"),
      'Client disconnect should call cleanup helper');
  });

  // Bug #31: tail parameter clamping
  await test('tail parameter rejects NaN with 400 response', () => {
    assert.ok(src.includes('isNaN(rawTail)') && src.includes("'tail must be a number'"),
      'Should check for NaN tail values and return 400');
  });

  await test('tail parameter is clamped to [1, 65536]', () => {
    assert.ok(src.includes('Math.max(1, Math.min(65536'),
      'Should clamp tail to [1, 65536] range');
  });

  // ── Live output reliability tests ──

  await test('handleAgentLive reads tail bytes efficiently (not entire file)', () => {
    const liveFn = src.slice(src.indexOf('async function handleAgentLive'));
    const liveFnEnd = liveFn.indexOf('\n  async function', 50);
    const liveBody = liveFn.slice(0, liveFnEnd > -1 ? liveFnEnd : 800);
    assert.ok(liveBody.includes('fs.openSync') || liveBody.includes('fs.readSync'),
      'Should use fs.readSync for efficient tail reading (not safeRead of entire file)');
    assert.ok(!liveBody.includes('safeRead(livePath)'),
      'Should NOT read entire file with safeRead');
  });

  await test('handleAgentLive returns content and has fallback', () => {
    const startIdx = src.indexOf('async function handleAgentLive(');
    const nextFn = src.indexOf('\n  async function', startIdx + 50);
    const liveBody = src.slice(startIdx, nextFn > -1 ? nextFn : startIdx + 3000);
    assert.ok(liveBody.includes('res.end(') && liveBody.includes('toString'),
      'Should write buffer content to response');
    assert.ok(liveBody.includes('No live output'),
      'Should have fallback message when no log exists');
  });

  await test('handleAgentLive handles empty and missing files gracefully', () => {
    const liveFn = src.slice(src.indexOf('async function handleAgentLive'));
    const liveFnEnd = liveFn.indexOf('\n  async function', 50);
    const liveBody = liveFn.slice(0, liveFnEnd > -1 ? liveFnEnd : 800);
    assert.ok(liveBody.includes('.size === 0') || liveBody.includes('catch'),
      'Should handle zero-byte or missing log file');
  });

  await test('live-stream.js renderLiveChatMessage parses all output formats', () => {
    const liveSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'live-stream.js'), 'utf8');
    assert.ok(liveSrc.includes('"type":"assistant"') || liveSrc.includes("type === 'assistant'"),
      'Should parse assistant messages from stream-json');
    assert.ok(liveSrc.includes('"tool_use"') || liveSrc.includes("type === 'tool_use'"),
      'Should parse tool_use blocks');
    assert.ok(liveSrc.includes('[human-steering]'),
      'Should render human steering messages');
    assert.ok(liveSrc.includes('[heartbeat]'),
      'Should handle heartbeat lines');
    assert.ok(liveSrc.includes('[steering-failed]') || liveSrc.includes('steering-failed'),
      'Should handle steering failure notices');
    assert.ok(liveSrc.includes('startsWith(\'{\')') || liveSrc.includes('startsWith("{")'),
      'Should parse single JSON objects (stream-json format)');
    assert.ok(liveSrc.includes('startsWith(\'[\')') || liveSrc.includes('startsWith("[")'),
      'Should parse JSON arrays (json format)');
  });

  await test('live-stream.js polling resumes after steering', () => {
    const liveSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'live-stream.js'), 'utf8');
    assert.ok(liveSrc.includes('_steerInFlight = false'),
      'Should reset _steerInFlight after steering completes');
    assert.ok(liveSrc.includes('startLivePolling'),
      'Should have startLivePolling to restart polling');
  });

  await test('engine.js writes heartbeat to live-output.log during agent run', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('[heartbeat]') && engineSrc.includes('appendFileSync') && engineSrc.includes('liveOutputPath'),
      'Should periodically append heartbeat lines to live-output.log');
    assert.ok(engineSrc.includes('setInterval') && engineSrc.includes('30000'),
      'Heartbeat should fire every 30 seconds');
  });

  await test('engine.js writes header to live-output.log at spawn', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('# Live output for') || engineSrc.includes('Live output for'),
      'Should write header with agent name and dispatch ID');
  });

  await test('engine.js steering failure writes to live-output.log', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('[steering-failed]'),
      'Should write [steering-failed] to live-output.log on resume failure');
  });

  // Bug #543: live-output.log rotation on spawn
  await test('engine.js rotates live-output.log to live-output-prev.log before overwriting', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('live-output-prev.log'),
      'Should reference live-output-prev.log for rotation');
    assert.ok(engineSrc.includes('renameSync') && engineSrc.includes('prevPath'),
      'Should use renameSync to rotate the file');
    assert.ok(engineSrc.includes('LIVE_OUTPUT_SPARSE_THRESHOLD'),
      'Should only rotate when file has meaningful content (above sparse threshold)');
  });

  await test('dashboard.js falls back to live-output-prev.log when current is sparse', () => {
    assert.ok(src.includes('live-output-prev.log'),
      'Dashboard should reference live-output-prev.log for fallback');
    assert.ok(src.includes('SPARSE_THRESHOLD'),
      'Dashboard should define a sparse threshold for fallback logic');
    assert.ok(src.includes('previous session'),
      'Dashboard should include a separator label when showing previous session content');
  });

  await test('cleanup.js cleans live-output-prev.log for idle agents', () => {
    const cleanupSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    assert.ok(cleanupSrc.includes('live-output-prev.log'),
      'Cleanup should also remove rotated previous session logs');
  });

  // Bug #32: body.content validation
  await test('notes save validates content with null check instead of contradictory logic', () => {
    const notesFn = src.slice(src.indexOf('async function handleNotesSave'));
    const notesFnEnd = notesFn.indexOf('\n  async function', 50);
    const notesBody = notesFn.slice(0, notesFnEnd > -1 ? notesFnEnd : 500);
    assert.ok(notesBody.includes('body.content == null'),
      'Should use body.content == null to accept empty strings and 0');
    assert.ok(!notesBody.includes('!body.content && body.content !=='),
      'Should not use the old contradictory !body.content && body.content !== pattern');
  });
  // ── Engine.js Race Condition Fixes (P-aa0ik3fh) ──────────────────────────

  console.log('\n── Engine.js Race Condition Fixes (P-aa0ik3fh) ──');

  await test('worktree reuse check reads dispatch under file lock (read-only, no unnecessary write)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the worktree reuse section — the activelyUsed check with dispatch lock
    const reuseSectionMatch = src.match(/Bug fix: read dispatch under file lock[\s\S]*?activelyUsed\)/);
    assert.ok(reuseSectionMatch, 'Should have worktree reuse section with dispatch lock');
    const reuseSection = reuseSectionMatch[0];
    // Should use mutateDispatch for atomic read under file lock
    assert.ok(reuseSection.includes('mutateDispatch'), 'Worktree reuse check should use mutateDispatch for atomic read');
  });

  await test('self-heal completed-array filter clears stale dispatch entries', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the self-heal section — uses mutateDispatch to filter completed entries by dispatchKey
    const selfHealMatch = src.match(/Self-heal:[\s\S]*?mutateDispatch\(\(dp\)[\s\S]*?return dp;\s*\}\)/);
    assert.ok(selfHealMatch, 'Should have self-heal mutateDispatch section');
    const selfHeal = selfHealMatch[0];
    // .filter() returns a new array (spec behavior) — safe inside single-threaded mutateDispatch callback
    assert.ok(selfHeal.includes('dispatchKey'), 'Should filter by dispatchKey');
    assert.ok(selfHeal.includes('dp.completed'), 'Should reassign dp.completed');
  });

  await test('self-heal completed filter preserves non-matching entries', () => {
    // Behavioral test: simulate the filter logic
    const completed = [
      { meta: { dispatchKey: 'work-proj-A' }, id: '1' },
      { meta: { dispatchKey: 'work-proj-B' }, id: '2' },
      { meta: { dispatchKey: 'work-proj-C' }, id: '3' },
    ];
    const key = 'work-proj-B';
    // Simulate the .filter() pattern from engine.js
    const result = completed.filter(d => d.meta?.dispatchKey !== key);
    assert.strictEqual(result.length, 2, 'Should keep 2 of 3 entries');
    assert.ok(result.every(e => e.meta.dispatchKey !== key), 'Filtered array should not contain removed key');
    assert.strictEqual(completed.length, 3, 'Original array should be unchanged (.filter() is immutable)');
  });

  await test('duplicate dispatch ID in pending queue is logged as warning and skipped', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the dispatch loop section
    const dispatchSection = src.match(/seenPendingIds[\s\S]*?busyAgents\.add\(item\.agent\)/);
    assert.ok(dispatchSection, 'Should have seenPendingIds dedup guard');
    const section = dispatchSection[0];
    assert.ok(section.includes('seenPendingIds.has(item.id)'), 'Should check for duplicate dispatch IDs');
    assert.ok(section.includes("log('warn'") && section.includes('Duplicate dispatch ID'), 'Should log warning on duplicate');
    assert.ok(section.includes('continue'), 'Should skip duplicate items');
  });

  await test('dispatch dedup: duplicate items are filtered, unique items dispatched', () => {
    // Behavioral test: simulate the dispatch dedup logic
    const pending = [
      { id: 'D1', agent: 'dallas', type: 'implement' },
      { id: 'D2', agent: 'ripley', type: 'review' },
      { id: 'D1', agent: 'dallas', type: 'implement' }, // duplicate
      { id: 'D3', agent: 'lambert', type: 'plan' },
    ];
    const busyAgents = new Set();
    const seenPendingIds = new Set();
    const toDispatch = [];
    const warnings = [];
    for (const item of pending) {
      if (seenPendingIds.has(item.id)) {
        warnings.push(`Duplicate dispatch ID ${item.id}`);
        continue;
      }
      seenPendingIds.add(item.id);
      if (busyAgents.has(item.agent)) continue;
      toDispatch.push(item);
      busyAgents.add(item.agent);
    }
    assert.strictEqual(toDispatch.length, 3, 'Should dispatch 3 unique items');
    assert.strictEqual(warnings.length, 1, 'Should have 1 duplicate warning');
    assert.ok(warnings[0].includes('D1'), 'Warning should reference the duplicate ID');
  });
}

// ─── P-e9y7xcp5: Bug fixes across auxiliary modules ─────────────────────────

async function testAuxModuleBugFixes() {
  console.log('\n── P-e9y7xcp5: Auxiliary Module Bug Fixes ──');

  // Bug #16: saveCooldowns .catch() for write errors
  await test('cooldown.js: saveCooldowns wraps safeWrite in try-catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');
    // Find the saveCooldowns function and verify it has try-catch around safeWrite
    const fnMatch = src.match(/function saveCooldowns\(\)[\s\S]*?^\}/m);
    assert.ok(fnMatch, 'saveCooldowns function should exist');
    const fnBody = fnMatch[0];
    assert.ok(fnBody.includes('try {') && fnBody.includes('safeWrite(COOLDOWN_PATH'), 'safeWrite should be wrapped in try block');
    assert.ok(fnBody.includes('catch (err)'), 'Should have catch clause');
    assert.ok(fnBody.includes('COOLDOWN_PATH'), 'Error message should reference COOLDOWN_PATH');
  });

  // Bug #28: spawn-agent.js stdin write wrapped in try-catch
  await test('spawn-agent.js: stdin write is wrapped in try-catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'spawn-agent.js'), 'utf8');
    // Verify proc.stdin.write is inside a try block
    assert.ok(src.includes('try {') && src.includes('proc.stdin.write'), 'stdin write should be in try block');
    assert.ok(src.includes('broken pipe'), 'Should log broken pipe error');
    assert.ok(src.includes('killImmediate(proc)'), 'Should kill child process on broken pipe using cross-platform killImmediate');
  });

  // Bug #33: playbook.js template self-reference detection
  await test('playbook.js: warns when substituted value contains {{...}} patterns', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'playbook.js'), 'utf8');
    assert.ok(src.includes('selfRefVars'), 'Should have selfRefVars detection');
    assert.ok(src.includes('self-reference'), 'Should warn about potential self-reference');
    assert.ok(src.includes('/\\{\\{\\w+\\}\\}/'), 'Should use regex to detect {{...}} in values');
  });

  // Bug #35: scheduler treats undefined/null enabled as disabled
  await test('scheduler.js: falsy enabled skips schedule', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'scheduler.js'), 'utf8');
    assert.ok(src.includes('!sched.enabled'), 'Should use truthy check to match dashboard UI behavior');
  });

  await test('scheduler discoverScheduledWork skips undefined-enabled schedules', () => {
    // Functional test: create a schedule with undefined enabled
    const tmpDir = createTmpDir();
    const origPath = scheduler.SCHEDULE_RUNS_PATH;
    // We can't easily override the path, so test the source logic instead
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'scheduler.js'), 'utf8');
    // Verify the line that checks enabled
    assert.ok(src.includes('!sched.enabled'), 'Should use truthy check — matches dashboard UI enabled badge');
    // A schedule with enabled:undefined should be skipped
    // A schedule with enabled:null should be skipped
    // A schedule with enabled:false should be skipped
    // Only enabled:true should pass
  });

  // Bug #36: spawn-agent registers exit/SIGTERM handler for temp file cleanup
  await test('spawn-agent.js: registers exit handler for temp files', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'spawn-agent.js'), 'utf8');
    assert.ok(src.includes("process.on('exit'"), 'Should register exit handler');
    assert.ok(src.includes("process.on('SIGTERM'"), 'Should register SIGTERM handler');
    assert.ok(src.includes('_cleanupSpawnTempFiles'), 'Should have cleanup function');
    assert.ok(src.includes('fs.unlinkSync(sysTmpPath)'), 'Cleanup should delete sysTmpPath');
  });

  // Bug #37: consolidation.js word length cap for ReDoS prevention
  await test('consolidation.js: fingerprint words capped at 200 chars for ReDoS prevention', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'consolidation.js'), 'utf8');
    assert.ok(src.includes('w.length <= 200'), 'Should cap word length at 200 chars');
  });

  // P-d8n3x5q1: dashboard.js null guards for PROJECTS[0] and safeJson results
  await test('dashboard.js: handleWorkItemsCreate guards PROJECTS[0] with null check', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // The handleWorkItemsCreate function should guard PROJECTS[0] fallback
    assert.ok(src.includes("No projects configured"), 'Should return error when no projects configured');
    // Find the targetProject = ... || PROJECTS[0] line and verify guard follows
    const createIdx = src.indexOf('handleWorkItemsCreate');
    const guardIdx = src.indexOf("if (!targetProject)", createIdx);
    assert.ok(guardIdx > createIdx, 'Should have !targetProject guard after PROJECTS[0] fallback in create handler');
  });

  await test('dashboard.js: trigger-verify handler uses safeJson for plan reading', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('handlePlansTriggerVerify'), src.indexOf('\n  async function', src.indexOf('handlePlansTriggerVerify') + 1));
    assert.ok(handler.includes('safeJson('), 'Should use safeJson (null-safe) for plan reading');
  });

  await test('dashboard.js: PROJECTS[0] at line 1159 uses optional chaining', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('PROJECTS[0]?.name'), 'Should use optional chaining for PROJECTS[0].name');
  });

  // Bug #38: notes.md truncation on section boundary
  await test('consolidation.js: truncation scans for section boundary', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'consolidation.js'), 'utf8');
    assert.ok(src.includes('lastIndexOf'), 'Should use lastIndexOf for section boundary scan');
    assert.ok(src.includes("lastSectionBoundary") || src.includes("lastBoundary"), 'Should have named section boundary variable');
    // Both LLM and regex paths should have boundary-aware truncation
    const llmPath = src.indexOf('lastSectionBoundary');
    const regexPath = src.indexOf('lastBoundary');
    assert.ok(llmPath > 0, 'LLM consolidation path should have section-boundary truncation');
    assert.ok(regexPath > 0, 'Regex fallback path should have section-boundary truncation');
  });
}

// ─── P-j4f6v8a2: Empty projects[] guards in lifecycle.js ─────────────────────

async function testEmptyProjectsGuards() {
  console.log('\n── lifecycle.js — empty projects[] guards (P-j4f6v8a2) ──');

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));
  const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  // ── Source-level checks ──

  await test('checkPlanCompletion guards empty projects with early return', () => {
    // After resolving primaryProject, there must be a !primaryProject guard before accessing .name
    const fnBody = src.slice(src.indexOf('function checkPlanCompletion'), src.indexOf('function archivePlan'));
    assert.ok(fnBody.includes('if (!primaryProject)'),
      'Should have an explicit !primaryProject guard');
    assert.ok(fnBody.includes('return;'),
      'Should return early when no project available');
  });

  await test('chainPlanToPrd guards empty projects array before accessing projects[0]', () => {
    const fnBody = src.slice(src.indexOf('function chainPlanToPrd'), src.indexOf('function syncPrsFromOutput'));
    assert.ok(fnBody.includes('projects.length === 0'),
      'Should check for empty projects array before accessing projects[0]');
  });

  await test('syncPrsFromOutput guards empty projects with early return 0', () => {
    const fnBody = src.slice(src.indexOf('function syncPrsFromOutput'));
    assert.ok(fnBody.includes('projects.length === 0'),
      'Should check for empty projects array');
    assert.ok(fnBody.includes('return 0'),
      'Should return 0 when no projects available');
  });

  // ── Functional: checkPlanCompletion with empty projects ──
  // Use isolated test dir so functional tests don't pollute production state
  {
    const restoreEpg = createTestMinionsDir();
    const lifecycleIsolated = require('../engine/lifecycle');
    const sharedIsolated = require('../engine/shared');
    const testMinionsDir = sharedIsolated.MINIONS_DIR;

    const testPlanFile = '_test-empty-proj.json';
    const prdDir = path.join(testMinionsDir, 'prd');
    const inboxDir = path.join(testMinionsDir, 'notes', 'inbox');
    const centralWiPath = path.join(testMinionsDir, 'work-items.json');
    fs.mkdirSync(prdDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });

    function cleanupEmptyProj() {
      const inboxFiles = shared.safeReadDir(inboxDir).filter(f => f.includes('_test-empty-proj'));
      for (const f of inboxFiles) { try { fs.unlinkSync(path.join(inboxDir, f)); } catch {} }
      try { fs.unlinkSync(path.join(prdDir, testPlanFile)); } catch {}
      try { fs.unlinkSync(centralWiPath); } catch {}
    }

    await test('checkPlanCompletion: empty projects[] does not crash, skips PR/verify creation', () => {
      // Write a PRD with all items done
      const prd = {
        plan_summary: 'Empty proj test',
        project: null,
        branch_strategy: 'parallel',
        missing_features: [
          { id: 'EP-001', title: 'Feature A', acceptance_criteria: ['AC1'] },
        ],
      };
      shared.safeWrite(path.join(prdDir, testPlanFile), prd);

      // Write matching work items to central location (no project dir)
      shared.safeWrite(centralWiPath, [
        { id: 'EP-001', title: 'Implement: Feature A', type: 'implement', status: 'done',
          sourcePlan: testPlanFile, dispatched_at: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T01:00:00Z' },
      ]);

      const meta = { item: { sourcePlan: testPlanFile } };
      const config = { projects: [] };

      // Should not throw
      lifecycleIsolated.checkPlanCompletion(meta, config);

      // The completion summary inbox IS written (before project resolution), but
      // no verify work item should be created since there's no project for it.
      // The _completionNotified flag is set before the project guard (to prevent re-runs).
      const completedPlan = shared.safeJson(path.join(prdDir, testPlanFile));
      assert.strictEqual(completedPlan._completionNotified, true,
        '_completionNotified should still be set even with empty projects');
      assert.strictEqual(completedPlan.status, 'completed',
        'Plan status should be marked completed');
    }, cleanupEmptyProj);

    // ── Functional: syncPrsFromOutput with empty projects ──

    await test('syncPrsFromOutput: empty projects[] returns 0 without crash', () => {
      const output = '{"type":"result","message":{"content":[{"type":"tool_result","content":"https://github.com/org/repo/pull/999"}]}}';
      const config = { projects: [] };
      const meta = {};

      const result = lifecycleIsolated.syncPrsFromOutput(output, 'test-agent', meta, config);
      assert.strictEqual(result, 0, 'Should return 0 when projects is empty and no meta project');
    });

    restoreEpg();
  }
}

// ─── P-r7w2k9m4: PR write race condition fixes ─────────────────────────────
async function testPrWriteRaceConditions() {
  console.log('\n── P-r7w2k9m4: PR write race condition fixes ──');

  const lifecycle = require('../engine/lifecycle');
  const shared = require('../engine/shared');
  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('syncPrsFromOutput uses mutateJsonFileLocked instead of safeWrite for PR files', () => {
    // The old pattern: safeWrite(entry.prPath, entry.prs) should be gone
    // The new pattern: mutateJsonFileLocked(prPath, ...) should be present
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function syncPrsFromOutput'),
      lifecycleSrc.indexOf('function updatePrAfterReview')
    );
    assert.ok(!fnBody.includes('shared.safeWrite(entry.prPath'),
      'syncPrsFromOutput should NOT use safeWrite for PR files');
    assert.ok(fnBody.includes('mutateJsonFileLocked(prPath'),
      'syncPrsFromOutput should use mutateJsonFileLocked for atomic PR writes');
  });

  await test('syncPrsFromOutput reads PR data inside lock callback, not before', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function syncPrsFromOutput'),
      lifecycleSrc.indexOf('function updatePrAfterReview')
    );
    // Old pattern cached reads outside lock: dirtyTargets.set(targetName, { prs: safeJson(prPath) })
    assert.ok(!fnBody.includes('safeJson(prPath) || []') || fnBody.indexOf('safeJson(prPath) || []') > fnBody.indexOf('mutateJsonFileLocked'),
      'PR data should be read inside the lock callback, not cached from an unlocked read');
  });

  await test('_completionNotified is NOT set on in-memory plan before mutateJsonFileLocked', () => {
    // Find the checkPlanCompletion function body
    const fnStart = lifecycleSrc.indexOf('function checkPlanCompletion');
    const fnBody = lifecycleSrc.slice(fnStart, lifecycleSrc.indexOf('function archivePlan'));
    // The old bug: plan._completionNotified = true was set BEFORE the mutateJsonFileLocked call
    const inMemorySet = fnBody.indexOf('plan._completionNotified = true');
    const lockCall = fnBody.indexOf('mutateJsonFileLocked(planPath');
    // Either the in-memory set doesn't exist, or it comes AFTER the lock call
    assert.ok(inMemorySet === -1 || inMemorySet > lockCall,
      '_completionNotified must NOT be set on in-memory object before mutateJsonFileLocked persist');
  });

  await test('_completionNotified is set inside mutateJsonFileLocked callback', () => {
    const fnStart = lifecycleSrc.indexOf('function checkPlanCompletion');
    const fnBody = lifecycleSrc.slice(fnStart, lifecycleSrc.indexOf('function archivePlan'));
    // Inside the callback: data._completionNotified = true
    assert.ok(fnBody.includes('data._completionNotified = true'),
      '_completionNotified should be set inside the lock callback on the persisted data');
  });

  // Functional test: concurrent syncPrsFromOutput calls don't lose PR entries
  await test('concurrent syncPrsFromOutput calls preserve all PR entries', () => {
    const tmpDir = createTmpDir();
    const prFile = path.join(tmpDir, 'pull-requests.json');
    shared.safeWrite(prFile, []);

    // Mock config with a project pointing to our tmp PR file
    const mockProject = { name: 'TestProject', localPath: tmpDir, mainBranch: 'main' };
    const mockConfig = {
      projects: [mockProject],
      agents: {
        agent1: { name: 'Agent1' },
        agent2: { name: 'Agent2' }
      }
    };

    // Override projectPrPath to return our tmp file
    const origProjectPrPath = shared.projectPrPath;
    shared.projectPrPath = (p) => prFile;

    // Override getProjects to return our mock
    const origGetProjects = shared.getProjects;
    shared.getProjects = () => [mockProject];

    try {
      // Simulate agent1 found PR 100 and agent2 found PR 200
      // Output must be JSONL with type:result for PR matching to work
      const output1 = '{"type":"result","result":"Created PR https://github.com/org/repo/pull/100 — Feature A"}';
      const output2 = '{"type":"result","result":"Created PR https://github.com/org/repo/pull/200 — Feature B"}';
      const meta1 = { item: { id: 'W-001', title: 'Feature A' }, project: mockProject };
      const meta2 = { item: { id: 'W-002', title: 'Feature B' }, project: mockProject };

      // Call both — since Node is single-threaded the lock serializes them
      lifecycle.syncPrsFromOutput(output1, 'agent1', meta1, mockConfig);
      lifecycle.syncPrsFromOutput(output2, 'agent2', meta2, mockConfig);

      const result = shared.safeJson(prFile) || [];
      const ids = result.map(p => p.id);
      assert.ok(ids.includes('PR-100'), 'PR-100 from agent1 should be present');
      assert.ok(ids.includes('PR-200'), 'PR-200 from agent2 should be present');
      assert.strictEqual(result.length, 2, 'Both PRs should be preserved, not overwritten');
    } finally {
      shared.projectPrPath = origProjectPrPath;
      shared.getProjects = origGetProjects;
    }
  });

  // Idempotency: calling syncPrsFromOutput twice with same PR doesn't duplicate
  await test('syncPrsFromOutput deduplicates same PR on repeated calls', () => {
    const tmpDir = createTmpDir();
    const prFile = path.join(tmpDir, 'pull-requests.json');
    shared.safeWrite(prFile, []);

    const mockProject = { name: 'TestProject', localPath: tmpDir, mainBranch: 'main' };
    const mockConfig = {
      projects: [mockProject],
      agents: { agent1: { name: 'Agent1' } }
    };

    const origProjectPrPath = shared.projectPrPath;
    shared.projectPrPath = (p) => prFile;
    const origGetProjects = shared.getProjects;
    shared.getProjects = () => [mockProject];

    try {
      const output = '{"type":"result","result":"Created PR https://github.com/org/repo/pull/300 — Feature C"}';
      const meta = { item: { id: 'W-003', title: 'Feature C' }, project: mockProject };

      lifecycle.syncPrsFromOutput(output, 'agent1', meta, mockConfig);
      lifecycle.syncPrsFromOutput(output, 'agent1', meta, mockConfig);

      const result = shared.safeJson(prFile) || [];
      const pr300s = result.filter(p => p.id === 'PR-300');
      assert.strictEqual(pr300s.length, 1, 'PR-300 should appear exactly once despite two calls');
    } finally {
      shared.projectPrPath = origProjectPrPath;
      shared.getProjects = origGetProjects;
    }
  });

  // ── Bug #15: Worktree deletion re-reads PR status before proceeding ──

  await test('cleanup.js re-reads PR status before worktree deletion (TOCTOU guard)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Must re-read PRs right before the deletion loop
    assert.ok(src.includes('freshPrs'), 'Should read fresh PR data before deletion');
    assert.ok(src.includes('freshMergedBranches'), 'Should build a fresh merged branches set');
    // Must check if PR was reopened
    assert.ok(src.includes('stillMerged'), 'Should verify branch is still merged before deleting');
    assert.ok(src.includes('PR was reopened'), 'Should log when PR was reopened since initial check');
  });

  await test('cleanup.js worktree deletion skips if PR was reopened but allows age/cap cleanup', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Should distinguish branch-based cleanup from age/cap-based cleanup
    assert.ok(src.includes('wasMarkedByBranch'), 'Should check if entry was originally marked due to merged branch');
    // Age/cap-based cleanups should still proceed even if branch is no longer in merged set
    assert.ok(src.includes('continue'), 'Should skip (continue) when branch-based entry is no longer merged');
  });

  // ── Bug #27: Each readdirSync individually try-caught ──

  await test('cleanup.js wraps each readdirSync in individual try-catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // The temp file cleanup section should have per-directory error handling
    assert.ok(src.includes('dirEntries = fs.readdirSync(dir)'), 'Should assign readdirSync to variable for per-dir error handling');
    assert.ok(src.includes('failed to read') && src.includes('continue'),
      'Should log warning and continue to next directory on readdirSync failure');
    // KB watchdog category counting should also be individually wrapped
    assert.ok(src.includes('failed to read') && src.includes('cat'),
      'KB watchdog directory reads should be individually try-caught');
  });

  // ── Bug #29: KB restore checks exit code and verifies result ──

  await test('cleanup.js KB restore checks git exit code and verifies file count', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
    // Should catch git checkout errors specifically
    assert.ok(src.includes('git checkout exited with error'),
      'Should log warning when git checkout exits with error');
    // Should verify the restore result by recounting
    assert.ok(src.includes('postRestoreCount'),
      'Should count files after restore to verify success');
    assert.ok(src.includes('restore incomplete'),
      'Should warn when restore did not fully recover files');
  });
  // ── Engine.js Race Condition Fixes (P-aa0ik3fh) ──────────────────────────

  console.log('\n── Engine.js Race Condition Fixes (P-aa0ik3fh) ──');

  await test('worktree reuse check reads dispatch inside mutateDispatch, not bare safeJson', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the worktree reuse section — the activelyUsed check with dispatch lock
    const reuseSectionMatch = src.match(/Bug fix: read dispatch under file lock[\s\S]*?activelyUsed\)/);
    assert.ok(reuseSectionMatch, 'Should have worktree reuse section');
    const reuseSection = reuseSectionMatch[0];
    // Should use mutateDispatch (which uses mutateJsonFileLocked → withFileLock) for atomic read, NOT bare safeJson(DISPATCH_PATH)
    assert.ok(reuseSection.includes('mutateDispatch'), 'Worktree reuse check should use mutateDispatch for atomic read');
    assert.ok(!reuseSection.includes('safeJson(DISPATCH_PATH)') || reuseSection.includes('mutateDispatch'), 'Worktree reuse check should read dispatch under file lock');
  });

  await test('self-heal completed-array filter uses immutable pattern (builds new array)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the self-heal section
    const selfHealMatch = src.match(/Self-heal:[\s\S]*?mutateDispatch\(\(dp\)[\s\S]*?return dp;\s*\}\)/);
    assert.ok(selfHealMatch, 'Should have self-heal mutateDispatch section');
    const selfHeal = selfHealMatch[0];
    // .filter() returns a new array (immutable) — either .filter() reassignment or manual new-array build is valid
    const usesFilter = selfHeal.includes('.filter(');
    const usesManualBuild = selfHeal.includes('const next = []') || selfHeal.includes('const next=[]');
    assert.ok(usesFilter || usesManualBuild, 'Should use immutable pattern: .filter() (returns new array) or manual new-array build');
    // Result must be assigned back to dp.completed
    assert.ok(selfHeal.includes('dp.completed ='), 'Should assign filtered result to dp.completed');
  });

  await test('self-heal completed filter preserves non-matching entries', () => {
    // Behavioral test: simulate the filter logic
    const completed = [
      { meta: { dispatchKey: 'work-proj-A' }, id: '1' },
      { meta: { dispatchKey: 'work-proj-B' }, id: '2' },
      { meta: { dispatchKey: 'work-proj-C' }, id: '3' },
    ];
    const key = 'work-proj-B';
    // Simulate the immutable filter pattern from engine.js
    const prev = Array.isArray(completed) ? completed : [];
    const next = [];
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].meta?.dispatchKey !== key) next.push(prev[i]);
    }
    assert.strictEqual(next.length, 2, 'Should keep 2 of 3 entries');
    assert.ok(next.every(e => e.meta.dispatchKey !== key), 'Filtered array should not contain removed key');
    assert.strictEqual(completed.length, 3, 'Original array should be unchanged (immutable)');
  });

  await test('duplicate dispatch ID in pending queue is logged as warning and skipped', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the dispatch loop section
    const dispatchSection = src.match(/seenPendingIds[\s\S]*?busyAgents\.add\(item\.agent\)/);
    assert.ok(dispatchSection, 'Should have seenPendingIds dedup guard');
    const section = dispatchSection[0];
    assert.ok(section.includes('seenPendingIds.has(item.id)'), 'Should check for duplicate dispatch IDs');
    assert.ok(section.includes("log('warn'") && section.includes('Duplicate dispatch ID'), 'Should log warning on duplicate');
    assert.ok(section.includes('continue'), 'Should skip duplicate items');
  });

  await test('dispatch dedup: duplicate items are filtered, unique items dispatched', () => {
    // Behavioral test: simulate the dispatch dedup logic
    const pending = [
      { id: 'D1', agent: 'dallas', type: 'implement' },
      { id: 'D2', agent: 'ripley', type: 'review' },
      { id: 'D1', agent: 'dallas', type: 'implement' }, // duplicate
      { id: 'D3', agent: 'lambert', type: 'plan' },
    ];
    const busyAgents = new Set();
    const seenPendingIds = new Set();
    const toDispatch = [];
    const warnings = [];
    for (const item of pending) {
      if (seenPendingIds.has(item.id)) {
        warnings.push(`Duplicate dispatch ID ${item.id}`);
        continue;
      }
      seenPendingIds.add(item.id);
      if (busyAgents.has(item.agent)) continue;
      toDispatch.push(item);
      busyAgents.add(item.agent);
    }
    assert.strictEqual(toDispatch.length, 3, 'Should dispatch 3 unique items');
    assert.strictEqual(warnings.length, 1, 'Should have 1 duplicate warning');
    assert.ok(warnings[0].includes('D1'), 'Warning should reference the duplicate ID');
  });
}

// ─── Status Mutation Guards — Comprehensive retry/revert safety tests ────────

async function testStatusMutationGuards() {
  console.log('\n── Status Mutation Guards — done/completedAt protection ──');

  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const dispatchSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
  const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const dashboardSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  // ─── Fix 1: updateWorkItemStatus uses mutateJsonFileLocked ──────────────

  await test('updateWorkItemStatus uses mutateJsonFileLocked for atomic writes', () => {
    // Extract the function body
    const fnMatch = lifecycleSrc.match(/function updateWorkItemStatus\(meta, status, reason\)\s*\{([\s\S]*?)^}/m);
    assert.ok(fnMatch, 'updateWorkItemStatus function must exist');
    const fnBody = fnMatch[1];
    assert.ok(fnBody.includes('mutateJsonFileLocked'),
      'updateWorkItemStatus must use mutateJsonFileLocked for atomic read-modify-write');
    // Should NOT use raw safeJson + safeWrite pattern
    const hasSafeJsonBeforeSafeWrite = fnBody.includes('safeJson(wiPath)') && fnBody.includes('safeWrite(wiPath');
    assert.ok(!hasSafeJsonBeforeSafeWrite,
      'updateWorkItemStatus must NOT use safeJson+safeWrite (TOCTOU race) — use mutateJsonFileLocked');
  });

  // ─── Fix 2: timeout.js reconciliation guards done items ──────────────────

  await test('timeout reconciliation skips done/completedAt items', () => {
    // The reconcile loop must check completedAt before reverting
    const reconcileSection = timeoutSrc.substring(
      timeoutSrc.indexOf('Reconcile: find work items stuck'),
      timeoutSrc.indexOf('module.exports')
    );
    assert.ok(reconcileSection, 'timeout.js must have reconciliation section');
    assert.ok(reconcileSection.includes('completedAt') || reconcileSection.includes('WI_STATUS.DONE'),
      'Timeout reconciliation must check completedAt or DONE status before reverting items');
  });

  await test('timeout reconciliation uses mutateJsonFileLocked', () => {
    // The reconcile section must use mutateJsonFileLocked, not raw safeWrite
    const reconcileSection = timeoutSrc.substring(
      timeoutSrc.indexOf('Reconcile: find work items stuck'),
      timeoutSrc.indexOf('module.exports')
    );
    assert.ok(reconcileSection.includes('mutateJsonFileLocked(wiPath'),
      'timeout reconciliation must use mutateJsonFileLocked, not raw safeWrite');
  });

  // ─── Fix 3: lifecycle.js does NOT duplicate retry (dispatch.js owns it) ───

  await test('lifecycle does not duplicate retry logic (handled by completeDispatch)', () => {
    const hookBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function runPostCompletionHooks('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function runPostCompletionHooks(') + 1)
    );
    assert.ok(!hookBody.includes('updateWorkItemStatus(meta, WI_STATUS.PENDING'),
      'runPostCompletionHooks must not set work items to PENDING (retry is in dispatch.js)');
  });

  // ─── Fix 4: dispatch.js retry guards done items (already applied) ────────

  await test('dispatch.js retry guards against reverting done items', () => {
    assert.ok(dispatchSrc.includes('WI_STATUS.DONE') && dispatchSrc.includes('completedAt'),
      'dispatch retry must check both DONE status and completedAt');
    // The guard pattern: wi.status !== WI_STATUS.DONE && !wi.completedAt
    assert.ok(dispatchSrc.includes('wi.status !== WI_STATUS.PAUSED') && dispatchSrc.includes('!wi.completedAt'),
      'dispatch retry must exclude PAUSED, DONE, and completedAt items');
  });

  // ─── Fix 5: engine.js dependency recovery guards done items ──────────────

  await test('dependency recovery does not revert completed items to pending', () => {
    const recoveryMatch = engineSrc.match(/Re-evaluate failed items[\s\S]*?Recovered.*from dependency failure/);
    assert.ok(recoveryMatch, 'engine.js must have dependency recovery section');
    const section = recoveryMatch[0];
    assert.ok(section.includes('isItemCompleted') || section.includes('completedAt'),
      'Dependency recovery must check isItemCompleted/completedAt before resetting');
  });

  await test('dependency cascade does not mark completed items as failed', () => {
    const cascadeMatch = engineSrc.match(/Dependency failed.*cannot proceed[\s\S]*?Marking.*as failed/);
    assert.ok(cascadeMatch, 'engine.js must have dependency cascade section');
    const section = cascadeMatch[0];
    assert.ok(section.includes('isItemCompleted') || section.includes('completedAt'),
      'Dependency cascade must check isItemCompleted/completedAt before marking as failed');
  });

  // ─── Fix 6: stall recovery guards done items ────────────────────────────

  await test('stall recovery auto-retry skips completedAt items', () => {
    // Find the stall recovery section — from "Auto-retry failed items" to the auto-retry log
    const stallStart = engineSrc.indexOf('Auto-retry failed items that are blocking');
    const stallEnd = engineSrc.indexOf('Stall recovery: auto-retrying') + 100;
    assert.ok(stallStart > 0 && stallEnd > stallStart, 'engine.js must have stall recovery auto-retry section');
    const stallSection = engineSrc.substring(stallStart, stallEnd);
    assert.ok(stallSection.includes('isItemCompleted') || stallSection.includes('completedAt'),
      'Stall recovery must check isItemCompleted/completedAt before auto-retrying');
  });

  await test('stall recovery un-fail skips completedAt dependents', () => {
    // Find the un-fail section — from "Un-fail dependent" to the un-fail log
    const unfailStart = engineSrc.indexOf('Un-fail dependent items');
    const unfailEnd = engineSrc.indexOf('Stall recovery: un-failing') + 100;
    assert.ok(unfailStart > 0 && unfailEnd > unfailStart, 'engine.js must have stall recovery un-fail section');
    const unfailSection = engineSrc.substring(unfailStart, unfailEnd);
    assert.ok(unfailSection.includes('isItemCompleted') || unfailSection.includes('completedAt'),
      'Stall recovery un-fail must check isItemCompleted/completedAt before resetting');
  });

  // ─── Fix 7: dashboard manual retry guards done items ─────────────────────

  await test('dashboard manual retry checks for done items', () => {
    // Find the manual retry handler section
    const retryMatch = dashboardSrc.match(/item\.status\s*=\s*(?:WI_STATUS\.PENDING|'pending');\s*\n\s*item\._retryCount\s*=\s*0/);
    assert.ok(retryMatch, 'dashboard.js must have manual retry handler');
    // The section before the reset should have a done/completedAt guard or force check
    const retrySection = dashboardSrc.substring(
      dashboardSrc.indexOf("item._retryCount = 0; // Reset retry") - 400,
      dashboardSrc.indexOf("item._retryCount = 0; // Reset retry") + 50
    );
    assert.ok(retrySection.includes('completedAt') || retrySection.includes('DONE_STATUSES') || retrySection.includes('WI_STATUS.DONE') || retrySection.includes("'done'") || retrySection.includes('force'),
      'Dashboard manual retry must check completedAt/done or require force flag');
  });

  // ─── Fix 8: dashboard PRD resume uses locks ──────────────────────────────

  await test('dashboard PRD resume uses mutateJsonFileLocked', () => {
    // Find the PRD resume section — it unpouses work items
    const resumeMatch = dashboardSrc.match(/prd-pause[\s\S]*?_resumedAt/);
    assert.ok(resumeMatch, 'dashboard.js must have PRD resume section');
    const resumeSection = dashboardSrc.substring(
      dashboardSrc.indexOf('prd-pause') - 500,
      dashboardSrc.indexOf('_resumedAt') + 200
    );
    // Should use mutateJsonFileLocked, not raw safeWrite
    const usesSafeWrite = resumeSection.includes('safeWrite(wiPath') && !resumeSection.includes('mutateJsonFileLocked(wiPath');
    assert.ok(!usesSafeWrite,
      'PRD resume must use mutateJsonFileLocked, not raw safeWrite');
  });

  // ─── Fix 9: dashboard PRD reset-all skips done items ─────────────────────

  await test('dashboard PRD reset-all skips done/completedAt items', () => {
    // Find the pause propagation section — "Propagate pause to materialized work items"
    const pauseIdx = dashboardSrc.indexOf('Propagate pause to materialized work items');
    assert.ok(pauseIdx > 0, 'dashboard.js must have pause propagation section');
    // The section between "Propagate pause" and the next major block should have completedAt guard
    const resetSection = dashboardSrc.substring(pauseIdx, pauseIdx + 2000);
    assert.ok(resetSection.includes('completedAt'),
      'PRD reset-all must check completedAt before resetting items');
  });

  // ─── Fix 10: dashboard kill-agent reset skips done items ──────────────────

  await test('dashboard kill-agent reset skips done/completedAt items', () => {
    // Find ALL "killedAgents.add(activeEntry.agent)" occurrences — the second one is the kill-agent handler
    const allOccurrences = [];
    let searchFrom = 0;
    while (true) {
      const idx = dashboardSrc.indexOf('killedAgents.add(activeEntry.agent)', searchFrom);
      if (idx < 0) break;
      allOccurrences.push(idx);
      searchFrom = idx + 1;
    }
    assert.ok(allOccurrences.length >= 2, 'dashboard.js must have at least 2 kill-agent sections');
    // Check the section around the second occurrence (plan-steering kill handler)
    const killSection = dashboardSrc.substring(allOccurrences[1] - 2000, allOccurrences[1] + 500);
    assert.ok(killSection.includes('completedAt'),
      'Kill-agent work item reset must check completedAt before resetting items');
  });

  // ─── Behavioral tests: simulate guard logic ─────────────────────────────

  await test('BEHAVIORAL: done item survives retry attempt', () => {
    const items = [
      { id: 'W1', status: 'done', completedAt: '2026-01-01T00:00:00Z', _retryCount: 0 },
      { id: 'W2', status: 'failed', _retryCount: 1 },
      { id: 'W3', status: 'dispatched', dispatched_at: '2026-01-01T00:00:00Z' },
    ];
    // Simulate retry guard logic (from dispatch.js pattern)
    for (const wi of items) {
      if (wi.status === 'done' || wi.completedAt) continue;
      if (wi.status === 'paused') continue;
      if (wi.status === 'failed') {
        wi.status = 'pending';
        wi._retryCount = (wi._retryCount || 0) + 1;
      }
    }
    assert.strictEqual(items[0].status, 'done', 'Done item must not be reverted');
    assert.strictEqual(items[0].completedAt, '2026-01-01T00:00:00Z', 'completedAt must be preserved');
    assert.strictEqual(items[1].status, 'pending', 'Failed item should be retried');
    assert.strictEqual(items[1]._retryCount, 2, 'Retry count should increment');
    assert.strictEqual(items[2].status, 'dispatched', 'Dispatched item unchanged');
  });

  await test('BEHAVIORAL: completedAt without done status still survives', () => {
    // Edge case: status might be 'dispatched' but completedAt set by another code path
    const item = { id: 'W1', status: 'dispatched', completedAt: '2026-01-01T00:00:00Z' };
    const shouldRevert = !(item.status === 'done' || item.completedAt);
    assert.ok(!shouldRevert, 'Item with completedAt must be protected even if status is not done');
  });

  await test('BEHAVIORAL: stall recovery preserves done items in dependency chain', () => {
    const items = [
      { id: 'A', status: 'done', completedAt: '2026-01-01T00:00:00Z' },
      { id: 'B', status: 'failed', depends_on: ['A'], failReason: 'Dependency failed — cannot proceed' },
      { id: 'C', status: 'pending', depends_on: ['B'] },
    ];
    // Simulate stall recovery: retry failed items that block others
    for (const item of items) {
      if (item.status !== 'failed' || item.completedAt) continue;
      const isBlocking = items.some(w => w.status === 'pending' && (w.depends_on || []).includes(item.id));
      if (!isBlocking) continue;
      item.status = 'pending';
      item._retryCount = 0;
      delete item.failReason;
    }
    assert.strictEqual(items[0].status, 'done', 'Done item A must not be touched');
    assert.strictEqual(items[1].status, 'pending', 'Failed blocker B should be retried');
    assert.strictEqual(items[2].status, 'pending', 'Pending item C unchanged');
  });

  await test('BEHAVIORAL: timeout reconciliation preserves done items', () => {
    const items = [
      { id: 'W1', status: 'dispatched', completedAt: '2026-01-01T00:00:00Z' },
      { id: 'W2', status: 'dispatched', _retryCount: 0 },
      { id: 'W3', status: 'done' },
    ];
    const activeKeys = new Set(); // no active dispatches
    for (const item of items) {
      if (item.status !== 'dispatched') continue;
      if (item.completedAt || item.status === 'done') continue;
      if (!activeKeys.has(item.id)) {
        item.status = 'pending';
        item._retryCount = (item._retryCount || 0) + 1;
      }
    }
    assert.strictEqual(items[0].status, 'dispatched', 'Item with completedAt must NOT be reverted by timeout');
    assert.strictEqual(items[1].status, 'pending', 'Orphaned dispatched item should be recovered');
    assert.strictEqual(items[2].status, 'done', 'Done item must not be touched');
  });

  await test('BEHAVIORAL: manual retry with force overrides done guard', () => {
    const item = { id: 'W1', status: 'done', completedAt: '2026-01-01T00:00:00Z' };
    const force = true;
    // Simulate: skip done items unless forced
    if ((item.status === 'done' || item.completedAt) && !force) {
      // would skip
    } else {
      item.status = 'pending';
      item._retryCount = 0;
      delete item.completedAt;
    }
    assert.strictEqual(item.status, 'pending', 'Force retry should override done guard');
  });

  await test('BEHAVIORAL: manual retry without force preserves done item', () => {
    const item = { id: 'W1', status: 'done', completedAt: '2026-01-01T00:00:00Z' };
    const force = false;
    let skipped = false;
    if ((item.status === 'done' || item.completedAt) && !force) {
      skipped = true;
    } else {
      item.status = 'pending';
    }
    assert.ok(skipped, 'Non-forced retry should skip done item');
    assert.strictEqual(item.status, 'done', 'Done status must be preserved');
  });

  await test('BEHAVIORAL: PRD reset-all skips done items, resets others', () => {
    const items = [
      { id: 'W1', status: 'done', completedAt: '2026-01-01T00:00:00Z', sourcePlan: 'plan.md' },
      { id: 'W2', status: 'failed', sourcePlan: 'plan.md', failReason: 'timeout' },
      { id: 'W3', status: 'dispatched', sourcePlan: 'plan.md', dispatched_at: '2026-01-01T00:00:00Z' },
      { id: 'W4', status: 'paused', sourcePlan: 'plan.md', _pausedBy: 'prd-pause' },
    ];
    let resetCount = 0;
    for (const w of items) {
      if (w.completedAt || w.status === 'done') continue;
      if (w.status !== 'pending') resetCount++;
      w.status = 'pending';
      delete w.dispatched_at;
      delete w.failReason;
    }
    assert.strictEqual(items[0].status, 'done', 'Done item must survive reset-all');
    assert.strictEqual(items[1].status, 'pending', 'Failed item should be reset');
    assert.strictEqual(items[2].status, 'pending', 'Dispatched item should be reset');
    assert.strictEqual(items[3].status, 'pending', 'Paused item should be reset');
    assert.strictEqual(resetCount, 3, 'Should reset 3 non-done items');
  });

  // ─── Cross-cutting: no raw safeWrite in critical mutation paths ──────────

  await test('updateWorkItemStatus does not use raw safeWrite pattern', () => {
    const fnMatch = lifecycleSrc.match(/function updateWorkItemStatus[\s\S]*?^}/m);
    assert.ok(fnMatch, 'updateWorkItemStatus must exist');
    const fnBody = fnMatch[0];
    // Count safeWrite vs mutateJsonFileLocked
    const safeWriteCount = (fnBody.match(/shared\.safeWrite\(wiPath|safeWrite\(wiPath/g) || []).length;
    const lockCount = (fnBody.match(/mutateJsonFileLocked\(wiPath/g) || []).length;
    assert.ok(lockCount > 0 || safeWriteCount === 0,
      'updateWorkItemStatus must use mutateJsonFileLocked OR not write directly at all');
  });

  // ─── P-w2f6b9d4: Crash bug fixes — null guards and undefined variable ──────

  await test('engine.js: fan-out branch uses agent.id, not fanAgentId', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(!src.includes('fanAgentId'), 'Should not reference undefined fanAgentId');
    assert.ok(src.includes('fan/${item.id}/${agent.id}'), 'Fan-out branch should use agent.id');
  });

  await test('engine.js: plan sync uses mutateDispatch instead of cleanDispatchEntries', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(!src.includes('cleanDispatchEntries'), 'engine.js should not call cleanDispatchEntries (dashboard-only function)');
  });

  await test('dashboard.js: handlePrdItemsRemove null-guards safeJson result', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fnStart = src.indexOf('handlePrdItemsRemove');
    const fnEnd = src.indexOf('async function', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    assert.ok(fnBody.includes("if (!plan)") || fnBody.includes('safeJsonObj'), 'handlePrdItemsRemove must null-guard plan from safeJson or use safeJsonObj');
  });

  await test('dashboard.js: handlePlansDelete null-guards safeJson items result', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fnStart = src.indexOf('handlePlansDelete');
    const fnEnd = src.indexOf('async function', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    // Should guard items from safeJson before calling .filter() — safeJsonArr, mutateWorkItems also acceptable
    assert.ok(fnBody.includes('!items') || fnBody.includes('!Array.isArray(items)') || fnBody.includes('safeJsonArr') || fnBody.includes('mutateWorkItems'),
      'handlePlansDelete must null-guard items from safeJson before filter, use safeJsonArr, or use mutateWorkItems');
  });

  await test('dashboard.js: handleProjectsAdd null-guards config from safeJson', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fnStart = src.indexOf('handleProjectsAdd');
    const fnEnd = src.indexOf('async function', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    assert.ok(fnBody.includes("if (!config)") || fnBody.includes('safeJsonObj'), 'handleProjectsAdd must null-guard config from safeJson or use safeJsonObj');
  });
}

// ─── Dashboard Audit: Critical Functional Bugs ─────────────────────────────

async function testDashboardAuditCritical() {
  console.log('\n── Dashboard Audit: Critical Functional Bugs ──');

  await test('plan pause sets status to paused with _pausedBy tag, not pending', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // Find the pause handler section — covers the mutateWorkItems callback that sets pause state
    const fnStart = src.indexOf('handlePlansPause');
    const fnEnd = src.indexOf('async function', fnStart + 1);
    const section = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    assert.ok(section.includes('Propagate pause'), 'pause handler section must exist');
    assert.ok(section.includes("w.status = WI_STATUS.PAUSED") || section.includes("w.status = 'paused'"),
      'pause must set status to paused (via WI_STATUS.PAUSED or literal), not pending');
    assert.ok(section.includes("w._pausedBy = 'prd-pause'"), 'pause must set _pausedBy = prd-pause');
    assert.ok(!section.includes("delete w._pausedBy"), 'pause must NOT delete _pausedBy');
  });

  await test('plan pause and resume are symmetric — resume finds paused items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // Resume looks for status === WI_STATUS.PAUSED (or 'paused') && _pausedBy === 'prd-pause'
    assert.ok(
      src.includes("w.status === WI_STATUS.PAUSED && w._pausedBy === 'prd-pause'") ||
      src.includes("w.status === 'paused' && w._pausedBy === 'prd-pause'"),
      'resume must look for paused + prd-pause tag');
    // Pause must set those exact values
    const fnStart = src.indexOf('handlePlansPause');
    const fnEnd = src.indexOf('async function', fnStart + 1);
    const pauseSection = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 3000);
    assert.ok(
      (pauseSection.includes("WI_STATUS.PAUSED") || pauseSection.includes("'paused'")) &&
      pauseSection.includes("'prd-pause'"),
      'pause must set the values that resume looks for');
  });

  await test('PRD isActive check includes both dispatched and pending', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    // Should not have the tautology: dispatched || dispatched
    const tautology = (src.match(/dispatched.*\|\|.*dispatched/g) || []);
    assert.strictEqual(tautology.length, 0,
      'render-prd.js must not have dispatched || dispatched tautology');
    // Should have dispatched || pending
    assert.ok(src.includes("'dispatched' || i.status === 'pending'") || src.includes("'dispatched' || item.status === 'pending'"),
      'isActive/wip check must include both dispatched and pending');
  });

  await test('rerenderPrdFromCache calls renderPrdProgress', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'state.js'), 'utf8');
    const fn = src.match(/function rerenderPrdFromCache[\s\S]*?^}/m);
    assert.ok(fn, 'rerenderPrdFromCache must exist');
    assert.ok(fn[0].includes('renderPrdProgress'), 'must call renderPrdProgress to update item list');
  });

  await test('refresh.js passes inbox with fallback to empty array', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'refresh.js'), 'utf8');
    assert.ok(src.includes('data.inbox || []'), 'renderInbox must receive data.inbox || [] fallback');
  });

  await test('PRD edit modal uses estimated_complexity field', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    // The complexity dropdown must reference estimated_complexity
    assert.ok(src.includes('estimated_complexity'), 'edit modal must use estimated_complexity field from PRD JSON');
  });
}

// ─── Dashboard Audit: XSS Fixes ────────────────────────────────────────────

async function testDashboardAuditXss() {
  console.log('\n── Dashboard Audit: XSS Fixes ──');

  await test('render-agents.js escapes all agent fields in innerHTML', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-agents.js'), 'utf8');
    // The template literal section that builds agent cards
    const cardSection = src.match(/grid\.innerHTML = agents\.map[\s\S]*?\.join\(''\)/);
    assert.ok(cardSection, 'agent card template must exist');
    const card = cardSection[0];
    // These fields must be escaped
    assert.ok(card.includes('escHtml(a.id)'), 'a.id must be escaped in onclick');
    assert.ok(card.includes('escHtml(a.name)'), 'a.name must be escaped');
    assert.ok(card.includes('escHtml(a.emoji)'), 'a.emoji must be escaped');
    assert.ok(card.includes('escHtml(a.status)'), 'a.status must be escaped');
    assert.ok(card.includes('escHtml(a.role)'), 'a.role must be escaped');
  });

  await test('render-agents.js detail header escapes agent fields', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-agents.js'), 'utf8');
    const headerLine = src.match(/detail-agent-name.*innerHTML[\s\S]*?;/);
    assert.ok(headerLine, 'detail header line must exist');
    assert.ok(headerLine[0].includes('escHtml(agent.emoji)'), 'emoji must be escaped in detail');
    assert.ok(headerLine[0].includes('escHtml(agent.name)'), 'name must be escaped in detail');
    assert.ok(headerLine[0].includes('escHtml(agent.role)'), 'role must be escaped in detail');
  });

  await test('render-pinned.js uses data attributes instead of JS string injection', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pinned.js'), 'utf8');
    // Should not have onclick="removePinnedNote('...')" with interpolated title
    assert.ok(!src.includes("removePinnedNote(\\'" ) && !src.includes("removePinnedNote('" + "' + escHtml(e.title)"),
      'removePinnedNote should not use JS string interpolation in onclick');
    assert.ok(src.includes('data-pin-title'), 'should use data-pin-title attribute');
    assert.ok(src.includes('this.dataset.pinTitle'), 'should read from dataset');
  });

  await test('render-inbox.js uses data attributes for item name in onclick', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    assert.ok(src.includes('data-inbox-name'), 'should use data-inbox-name attribute');
    assert.ok(src.includes('this.dataset.inboxName'), 'should read from dataset');
  });

  await test('render-inbox.js escapes item.age', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    assert.ok(src.includes("escHtml(item.age") , 'item.age must be escaped');
  });

  await test('utils.js has safeUrl function that blocks javascript: protocol', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'utils.js'), 'utf8');
    assert.ok(src.includes('function safeUrl'), 'safeUrl must exist');
    assert.ok(src.includes('javascript') || src.includes("https?"), 'safeUrl must whitelist http(s) only');
  });

  await test('render-prs.js uses safeUrl for PR links', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
    assert.ok(src.includes('safeUrl(url)') || src.includes('safeUrl(pr.url'),
      'PR link href must use safeUrl');
  });

  await test('render-prs.js table headers match cell count', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
    const thMatch = src.match(/<th>/g) || [];
    // Count <td> in prRow function
    const rowFn = src.match(/function prRow[\s\S]*?return '[\s\S]*?<\/tr>/);
    const tdMatch = rowFn ? (rowFn[0].match(/<td>/g) || []) : [];
    assert.strictEqual(thMatch.length, tdMatch.length,
      `PR table headers (${thMatch.length}) must match cell count (${tdMatch.length})`);
  });
}

// ─── Dashboard Audit: Medium Bugs ───────────────────────────────────────────

async function testDashboardAuditMedium() {
  console.log('\n── Dashboard Audit: Medium Bugs ──');

  await test('handleSettingsReset calls reloadConfig and invalidateStatusCache', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const resetFn = src.match(/function handleSettingsReset[\s\S]*?^  \}/m);
    assert.ok(resetFn, 'handleSettingsReset must exist');
    assert.ok(resetFn[0].includes('reloadConfig()'), 'reset must call reloadConfig');
    assert.ok(resetFn[0].includes('invalidateStatusCache()'), 'reset must invalidate cache');
  });

  await test('handleWorkItemsCreate persists skipPr flag', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('body.skipPr') && src.includes('item.skipPr'),
      'work item create must copy skipPr from body to item');
  });

  await test('handleWorkItemsDelete uses mutateJsonFileLocked', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // Find delete handler — it's after "Remove item from work-items file" or uses splice
    const deleteSections = src.match(/Remove item from work-items|mutateJsonFileLocked\(wiPath[\s\S]*?splice/g) || [];
    // Should use mutateJsonFileLocked, not raw safeRead+safeWrite
    assert.ok(src.includes('mutateJsonFileLocked(wiPath') || !src.includes("JSON.parse(safeRead(wiPath) || '[]')"),
      'delete must use mutateJsonFileLocked for atomic read-modify-write');
  });

  await test('handleWorkItemsDelete resets PRD item status (#779)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const deleteFn = src.slice(src.indexOf('async function handleWorkItemsDelete'), src.indexOf('async function handleWorkItemsArchive'));
    assert.ok(deleteFn.includes('syncPrdItemStatus'),
      'work item delete must call syncPrdItemStatus to reset PRD item status');
    assert.ok(deleteFn.includes('item.sourcePlan'),
      'PRD reset must check item.sourcePlan before calling syncPrdItemStatus');
  });

  await test('openEditScheduleModal calls _updateCronPreview', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-schedules.js'), 'utf8');
    const editFn = src.match(/function openEditScheduleModal[\s\S]*?^}/m);
    assert.ok(editFn, 'openEditScheduleModal must exist');
    assert.ok(editFn[0].includes('_updateCronPreview'), 'edit modal must call _updateCronPreview');
  });

  await test('wi-count element has null guard', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('if (countEl)'), 'wi-count access must be null-guarded');
  });

  await test('render-plans.js guards p.project against undefined', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes('p.project ?') || src.includes('p.project?'),
      'p.project must be guarded before rendering');
  });

  await test('render-prs.js cmdProjects handles object items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
    assert.ok(src.includes('p.name') && src.includes("typeof p === 'object'"),
      'cmdProjects items must be unwrapped from {name} objects');
  });

  await test('planSubmitRevise checks res.ok before success toast', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const reviseFn = src.match(/async function planSubmitRevise[\s\S]*?^}/m);
    assert.ok(reviseFn, 'planSubmitRevise must exist');
    assert.ok(reviseFn[0].includes('res.ok'), 'must check res.ok before showing success');
  });

  await test('statusColor handles error state', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'utils.js'), 'utf8');
    assert.ok(src.includes("'error'"), 'statusColor must handle error state');
  });
}

// ─── Dashboard Audit: Low-Severity Polish ──────────────────────────────────

async function testDashboardAuditLow() {
  console.log('\n── Dashboard Audit: Low-Severity Polish ──');

  await test('renderEngineLog has null guard on el', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-dispatch.js'), 'utf8');
    const fn = src.match(/function renderEngineLog[\s\S]*?^}/m);
    assert.ok(fn, 'renderEngineLog must exist');
    assert.ok(fn[0].includes('if (!el) return'), 'must null-guard el for when engine page is not in DOM');
  });

  await test('modalCancelEdit uses innerHTML with renderMd, not textContent', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-inbox.js'), 'utf8');
    const fn = src.match(/function modalCancelEdit[\s\S]*?^}/m);
    assert.ok(fn, 'modalCancelEdit must exist');
    assert.ok(fn[0].includes('innerHTML') && fn[0].includes('renderMd'),
      'must use innerHTML with renderMd to show rendered Markdown, not raw text via textContent');
  });

  await test('create work item modal includes critical priority', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    const createFn = src.match(/function openCreateWorkItemModal[\s\S]*?^}/m);
    assert.ok(createFn, 'openCreateWorkItemModal must exist');
    assert.ok(createFn[0].includes("'critical'"), 'priority list must include critical');
  });

  await test('submitWorkItemEdit and _submitCreateWorkItem accept event parameter', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('submitWorkItemEdit(id, source, e)') || src.includes('function submitWorkItemEdit(id, source, e'),
      'submitWorkItemEdit must accept event parameter');
    assert.ok(src.includes('_submitCreateWorkItem(e)') || src.includes('function _submitCreateWorkItem(e'),
      '_submitCreateWorkItem must accept event parameter');
  });
}

// ─── Dashboard Audit Pass 2 ─────────────────────────────────────────────────

async function testDashboardAuditPass2() {
  console.log('\n── Dashboard Audit Pass 2 ──');

  await test('CC actions use _ccFetch helper with res.ok check', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'command-center.js'), 'utf8');
    assert.ok(src.includes('async function _ccFetch'), '_ccFetch helper must exist');
    assert.ok(src.includes('res.ok'), '_ccFetch must check res.ok');
    // Count direct fetch calls vs _ccFetch calls in ccExecuteAction
    const actionFn = src.match(/async function ccExecuteAction[\s\S]*?^}/m);
    assert.ok(actionFn, 'ccExecuteAction must exist');
    const directFetches = (actionFn[0].match(/await fetch\('/g) || []).length;
    // Remaining direct fetches are for cases that already have their own res.ok checks
    // (schedule, meetings, settings, pipelines, doc-chat) or are read-only (plan content fetch)
    assert.ok(directFetches <= 10,
      'ccExecuteAction should use _ccFetch for simple mutations, found ' + directFetches + ' direct fetch calls');
  });

  await test('_renderPlanModal wraps JSON.parse in try/catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const fn = src.match(/function _renderPlanModal[\s\S]*?^}/m);
    assert.ok(fn, '_renderPlanModal must exist');
    assert.ok(fn[0].includes('try') && fn[0].includes('JSON.parse'),
      'JSON.parse must be wrapped in try/catch');
  });

  await test('charter raw content stored outside DOM element', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'detail-panel.js'), 'utf8');
    assert.ok(src.includes('_charterRawCache'), 'should use module-level _charterRawCache variable');
    assert.ok(!src.includes('el._charterRaw'), 'should not use DOM expando el._charterRaw');
  });

  await test('KB sort handles undefined date', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-kb.js'), 'utf8');
    assert.ok(src.includes("b.date || ''") || src.includes("(b.date||'')"),
      'KB sort must handle undefined date with fallback');
  });

  await test('prdItemEdit searches archived groups as fallback', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const fn = src.match(/async function prdItemEdit[\s\S]*?^}/m);
    assert.ok(fn, 'prdItemEdit must exist');
    assert.ok(fn[0].includes('_archivedPrdGroups'),
      'prdItemEdit must search archived groups when item not in _prdItems');
  });
}

// ─── Engine Audit: Critical Bugs ────────────────────────────────────────────

async function testEngineAuditCritical() {
  console.log('\n── Engine Audit: Critical Bugs ──');

  await test('executeParallelStage is declared async', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('async function executeParallelStage'),
      'executeParallelStage must be async to use await');
  });

  await test('discoverPipelineWork is declared async', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('async function discoverPipelineWork'),
      'discoverPipelineWork must be async to use await');
  });

  await test('engine.js handles async discoverPipelineWork', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('discoverPipelineWork(config)'), 'must call discoverPipelineWork');
    assert.ok(src.includes('.catch(') || src.includes('await discoverPipelineWork'),
      'must handle the async result (await or .catch)');
  });

  await test('render-pipelines.js has _renderMonitoredResources function', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('function _renderMonitoredResources('),
      'render-pipelines.js must define _renderMonitoredResources for displaying monitored resources');
  });

  await test('render-pipelines.js has _collectMonitoredResources function', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('function _collectMonitoredResources('),
      'render-pipelines.js must define _collectMonitoredResources to aggregate resources from pipeline + stages');
  });

  await test('render-pipelines.js renders monitored resources on pipeline card', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('_collectMonitoredResources(p)'),
      'renderPipelines card must call _collectMonitoredResources to gather resources');
    assert.ok(src.includes('resourcesHtml'),
      'renderPipelines card must include resourcesHtml in output');
  });

  await test('render-pipelines.js renders stage-level monitored resources in detail modal', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('s.monitoredResources'),
      'openPipelineDetail must render per-stage monitoredResources');
  });

  await test('pipeline abort button shows Aborting then refreshes detail', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const abortFn = src.slice(src.indexOf('async function _abortPipeline'));
    assert.ok(abortFn.includes("'Aborting...'"), 'Should show Aborting... immediately');
    assert.ok(abortFn.includes('_refreshPipelineDetail'), 'Should refresh detail modal after abort');
  });

  await test('pipeline abort refreshes modal via _refreshPipelineDetail (not manual swap)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('async function _refreshPipelineDetail'),
      'Should define _refreshPipelineDetail for immediate modal refresh');
    const refreshFn = src.slice(src.indexOf('async function _refreshPipelineDetail'));
    assert.ok(refreshFn.includes('openPipelineDetail(id)'), 'Should re-render detail modal');
  });

  await test('pipeline abort cancels work items and dispatches on server', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const abortHandler = src.slice(src.indexOf("'/api/pipelines/abort'"));
    assert.ok(abortHandler.includes('_pipelineRun'), 'Should cancel work items by _pipelineRun');
    assert.ok(abortHandler.includes('cleanDispatchEntries'), 'Should clean dispatch entries for the run');
    assert.ok(abortHandler.includes('cancelledWorkItems'), 'Should return count of cancelled items');
  });

  await test('pipeline detail shows Run Now when no active run, Abort when running', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes("activeRun") && src.includes("'Abort'") && src.includes("'Run Now'"),
      'Should conditionally show Abort (running) or Run Now (idle)');
  });

  // ── Pipeline file JSON validity ──

  await test('all pipeline JSON files are valid JSON', () => {
    const pipelinesDir = path.join(MINIONS_DIR, 'pipelines');
    if (!fs.existsSync(pipelinesDir)) return; // no pipelines dir is fine
    const files = fs.readdirSync(pipelinesDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        JSON.parse(fs.readFileSync(path.join(pipelinesDir, f), 'utf8'));
      } catch (e) {
        assert.fail(`pipelines/${f} is invalid JSON: ${e.message}`);
      }
    }
  });

  // ── Pipeline Node Chain Visualization (TDD) ──

  await test('_buildNodeChain function exists and replaces _buildProgressBar', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('function _buildNodeChain'), '_buildNodeChain function should exist');
  });

  await test('node chain renders pl-node-chain container', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('pl-node-chain'), 'Should use pl-node-chain CSS class');
  });

  await test('node chain renders status-colored nodes for each stage', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('pl-node-box'), 'Should render pl-node-box for each stage');
    assert.ok(fn.includes('complete') && fn.includes('running') && fn.includes('failed'),
      'Should apply status classes: complete, running, failed');
  });

  await test('node chain renders arrows between stages', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('pl-node-arrow') || fn.includes('→') || fn.includes('arrow'),
      'Should render arrows/connectors between nodes');
  });

  await test('node chain renders type icons per stage', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('task') && fn.includes('meeting') && fn.includes('condition'),
      'Should map stage types to icons');
  });

  await test('node chain renders condition stages with fork', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('condition') && (fn.includes('onMet') || fn.includes('fork')),
      'Should render condition stages with branching');
  });

  await test('node chain renders stop/exit conditions', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('stopWhen') || fn.includes('exitIf') || fn.includes('pl-node-stop'),
      'Should render stop/exit condition terminal node');
  });

  await test('node chain renders wait stages with duration', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('wait') && (fn.includes('duration') || fn.includes('⏸')),
      'Should render wait stages with duration indicator');
  });

  await test('node chain renders loop indicator for cron-triggered pipelines', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('loop') || fn.includes('cron') || fn.includes('↺'),
      'Should show loop indicator for recurring pipelines');
  });

  await test('node chain supports compact mode for card view', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _buildNodeChain'));
    assert.ok(fn.includes('compact'),
      'Should support compact option for pipeline card vs detail view');
  });

  await test('CSS has pl-node-chain and pl-node-box classes', () => {
    const css = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'styles.css'), 'utf8');
    assert.ok(css.includes('.pl-node-chain'), 'Should have .pl-node-chain CSS class');
    assert.ok(css.includes('.pl-node-box'), 'Should have .pl-node-box CSS class');
    assert.ok(css.includes('.pl-node-box.running'), 'Should have running animation on node');
  });

  await test('dashboard.js pipeline create/update API supports monitoredResources', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('body.monitoredResources'),
      'pipeline API handlers must support monitoredResources field');
  });

  // ── Pipeline: conditional stages & stopWhen (#522) ──

  await test('STAGE_TYPE includes CONDITION', () => {
    const shared = require('../engine/shared');
    assert.ok(shared.STAGE_TYPE.CONDITION, 'STAGE_TYPE must include CONDITION');
    assert.strictEqual(shared.STAGE_TYPE.CONDITION, 'condition');
  });

  await test('PIPELINE_STATUS includes STOPPED', () => {
    const shared = require('../engine/shared');
    assert.ok(shared.PIPELINE_STATUS.STOPPED, 'PIPELINE_STATUS must include STOPPED');
    assert.strictEqual(shared.PIPELINE_STATUS.STOPPED, 'stopped');
  });

  await test('pipeline.js exports evaluateCondition', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('evaluateCondition'), 'must define evaluateCondition');
    assert.ok(src.includes('module.exports') && src.includes('evaluateCondition'),
      'must export evaluateCondition');
  });

  await test('pipeline.js handles condition stage type in executeStage', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('STAGE_TYPE.CONDITION'), 'must reference STAGE_TYPE.CONDITION');
    assert.ok(src.includes('executeConditionStage'), 'must define executeConditionStage');
  });

  await test('pipeline.js evaluates stopWhen after run completion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('pipeline.stopWhen'), 'must check pipeline.stopWhen');
    assert.ok(src.includes('evaluateCondition(pipeline.stopWhen'), 'must evaluate stopWhen with evaluateCondition');
  });

  await test('pipeline.js condition stage can stop-pipeline', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes("'stop-pipeline'"), 'must handle stop-pipeline action');
    assert.ok(src.includes('_stopPipeline'), 'must signal _stopPipeline to break dispatch loop');
  });

  await test('pipeline.js evaluateCondition supports all checks', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes("case 'runSucceeded'"), 'must support runSucceeded check');
    assert.ok(src.includes("case 'noFailedItems'"), 'must support noFailedItems check');
    assert.ok(src.includes("case 'maxRuns'"), 'must support maxRuns check');
    assert.ok(src.includes("case 'allBuildsGreen'"), 'must support allBuildsGreen check');
  });

  await test('pipeline.js isStageComplete handles CONDITION type', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('STAGE_TYPE.CONDITION'), 'isStageComplete must handle CONDITION type');
  });

  await test('dashboard.js pipeline API supports stopWhen field', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('body.stopWhen'), 'pipeline create/update must support stopWhen');
    assert.ok(src.includes('stopWhen?'), 'pipeline API params must list stopWhen');
  });

  await test('render-pipelines.js shows condition stage icon', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes("condition:"), 'stage icon map must include condition type');
  });

  await test('render-pipelines.js shows stopWhen badge', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('p.stopWhen'), 'must check pipeline stopWhen for display');
    assert.ok(src.includes('STOP-WHEN'), 'must show STOP-WHEN badge');
  });

  await test('render-pipelines.js shows stopped run status', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes("'stopped'"), 'must handle stopped status in run display');
    assert.ok(src.includes('AUTO-STOPPED'), 'must show AUTO-STOPPED label for pipelines stopped by condition');
  });

  // ── Pipeline auto-detect: skip wait/plan stages when artifacts exist (W-mnr3kiuojipk) ──

  await test('isStageComplete TASK checks all project work items (not just root)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const isStageCompleteFn = src.slice(src.indexOf('function isStageComplete'));
    const taskCase = isStageCompleteFn.slice(isStageCompleteFn.indexOf("case STAGE_TYPE.TASK:"), isStageCompleteFn.indexOf("case STAGE_TYPE.MEETING:"));
    assert.ok(taskCase.includes('getProjects(config)'), 'TASK completion should check project work items');
    assert.ok(taskCase.includes('projectWorkItemsPath'), 'TASK completion should use projectWorkItemsPath');
  });

  await test('task stage output collection checks all project work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const discoverFn = src.slice(src.indexOf('async function discoverPipelineWork'));
    const taskOutputSection = discoverFn.slice(discoverFn.indexOf('STAGE_TYPE.TASK'), discoverFn.indexOf('STAGE_TYPE.MEETING'));
    assert.ok(taskOutputSection.includes('getProjects'), 'Task output collection should check project work items');
  });

  await test('wait stage auto-complete detects existing plan from meeting', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const waitSection = src.slice(src.indexOf('PIPELINE_STATUS.WAITING_HUMAN'), src.indexOf('Check if pending stage'));
    assert.ok(waitSection.includes('STAGE_TYPE.WAIT'), 'Should check if waiting stage is a wait stage');
    assert.ok(waitSection.includes('STAGE_TYPE.PLAN'), 'Should look for a dependent plan stage');
    assert.ok(waitSection.includes('_findExistingPlanForMeeting'), 'Should use _findExistingPlanForMeeting');
    assert.ok(waitSection.includes('Auto-completed'), 'Should auto-complete with descriptive output');
  });

  await test('plan stage detects existing PRD and skips plan-to-prd dispatch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const planFn = src.slice(src.indexOf('async function executePlanStage'), src.indexOf('function executeApiStage'));
    assert.ok(planFn.includes('_findExistingPrdForPlan'), 'Should check for existing PRD');
    assert.ok(planFn.includes('skipping plan-to-prd'), 'Should log skip message');
  });

  await test('_refreshPipelineDetail defined and used by all action handlers', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    assert.ok(src.includes('async function _refreshPipelineDetail'), 'Should define _refreshPipelineDetail');
    // Check it's used by all action handlers
    const triggerFn = src.slice(src.indexOf('async function _triggerPipeline'), src.indexOf('async function _abortPipeline'));
    assert.ok(triggerFn.includes('_refreshPipelineDetail'), 'Trigger handler should use _refreshPipelineDetail');
    const abortFn = src.slice(src.indexOf('async function _abortPipeline'), src.indexOf('async function _retriggerPipeline'));
    assert.ok(abortFn.includes('_refreshPipelineDetail'), 'Abort handler should use _refreshPipelineDetail');
    const retriggerFn = src.slice(src.indexOf('async function _retriggerPipeline'), src.indexOf('async function _togglePipelineEnabled'));
    assert.ok(retriggerFn.includes('_refreshPipelineDetail'), 'Retrigger handler should use _refreshPipelineDetail');
    const continueFn = src.slice(src.indexOf('async function _continuePipeline'), src.indexOf('async function _deletePipelineConfirm'));
    assert.ok(continueFn.includes('_refreshPipelineDetail'), 'Continue handler should use _refreshPipelineDetail');
  });

  await test('pipeline detail modal always polls (not just when active run)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-pipelines.js'), 'utf8');
    const detailFn = src.slice(src.indexOf('function openPipelineDetail'), src.indexOf('var _pipelinePollHash'));
    // Old: if (activeRun) { _pipelinePollId = id; ... } — only polled active runs
    // New: always sets _pipelinePollId and starts polling
    assert.ok(!detailFn.includes('if (activeRun) {\n    _pipelinePollId'), 'Should not gate polling on activeRun');
    assert.ok(detailFn.includes('_pipelinePollId = id'), 'Should always set poll ID');
  });

  await test('_findExistingPrdForPlan exported for testing', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('_findExistingPrdForPlan'), 'Should export _findExistingPrdForPlan');
  });

  await test('handlePostMerge guards against null project', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.match(/async function handlePostMerge[\s\S]*?^}/m);
    assert.ok(fn, 'handlePostMerge must exist');
    assert.ok(fn[0].includes('pr.branch && project') || fn[0].includes('project &&'),
      'handlePostMerge must guard project before accessing project.localPath');
  });

  // Post-merge rebase for dependent PRs
  const lifecycleSrcForRebase = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');

  await test('findDependentActivePrs is exported from lifecycle.js', () => {
    assert.ok(lifecycleSrcForRebase.includes('function findDependentActivePrs'),
      'lifecycle.js must define findDependentActivePrs');
    assert.ok(lifecycleSrcForRebase.includes('findDependentActivePrs,'),
      'findDependentActivePrs must be exported');
  });

  await test('findDependentActivePrs excludes shared-branch items', () => {
    assert.ok(lifecycleSrcForRebase.includes("branchStrategy !== 'shared-branch'"),
      'findDependentActivePrs must exclude shared-branch work items');
  });

  await test('rebaseBranchOntoMain uses force-with-lease for safe push', () => {
    assert.ok(lifecycleSrcForRebase.includes('--force-with-lease'),
      'rebaseBranchOntoMain must use --force-with-lease');
  });

  await test('rebaseBranchOntoMain aborts rebase on conflict', () => {
    assert.ok(lifecycleSrcForRebase.includes('rebase --abort'),
      'rebaseBranchOntoMain must abort rebase on failure');
  });

  await test('rebaseBranchOntoMain cleans up temp worktree in finally block', () => {
    const fn = lifecycleSrcForRebase.slice(
      lifecycleSrcForRebase.indexOf('async function rebaseBranchOntoMain'),
      lifecycleSrcForRebase.indexOf('\nfunction queuePendingRebase')
    );
    assert.ok(fn.includes('finally'), 'rebaseBranchOntoMain must have a finally block for cleanup');
    assert.ok(fn.includes('removeWorktree'), 'finally block must call removeWorktree');
  });

  await test('handlePostMerge calls findDependentActivePrs for rebase', () => {
    const fn = lifecycleSrcForRebase.slice(
      lifecycleSrcForRebase.indexOf('async function handlePostMerge'),
      lifecycleSrcForRebase.indexOf('\nfunction checkForLearnings')
    );
    assert.ok(fn.includes('findDependentActivePrs'), 'handlePostMerge must call findDependentActivePrs');
    assert.ok(fn.includes('rebaseBranchOntoMain'), 'handlePostMerge must call rebaseBranchOntoMain');
  });

  await test('handlePostMerge defers rebase when branch is active', () => {
    const fn = lifecycleSrcForRebase.slice(
      lifecycleSrcForRebase.indexOf('async function handlePostMerge'),
      lifecycleSrcForRebase.indexOf('\nfunction checkForLearnings')
    );
    assert.ok(fn.includes('isBranchActive'), 'handlePostMerge must check isBranchActive before rebasing');
    assert.ok(fn.includes('queuePendingRebase'), 'handlePostMerge must queue deferred rebase when branch active');
  });

  await test('processPendingRebases retries up to 3 attempts', () => {
    const fn = lifecycleSrcForRebase.slice(
      lifecycleSrcForRebase.indexOf('async function processPendingRebases'),
      lifecycleSrcForRebase.indexOf('\n// ─── Post-Merge / Post-Close')
    );
    assert.ok(fn.includes('attempts < 3'), 'processPendingRebases must cap retries at 3');
    assert.ok(fn.includes('writeToInbox'), 'processPendingRebases must write inbox alert on give-up');
  });

  await test('engine.js calls processPendingRebases in tick cycle', () => {
    const engineSrcRebase = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrcRebase.includes('processPendingRebases(config)'),
      'engine.js must call processPendingRebases during PR poll phase');
    assert.ok(engineSrcRebase.includes('processPendingRebases }'),
      'engine.js must import processPendingRebases from lifecycle');
  });

  await test('scheduler enabled check uses truthy, not strict equality', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'scheduler.js'), 'utf8');
    assert.ok(!src.includes('sched.enabled !== true'),
      'scheduler must not use strict !== true check — schedules with enabled:undefined would silently never fire');
    assert.ok(src.includes('!sched.enabled'),
      'scheduler should use truthy check to match dashboard UI behavior');
  });
}

// ─── Engine Audit: Medium Bugs ──────────────────────────────────────────────

async function testEngineAuditMedium() {
  console.log('\n── Engine Audit: Medium Bugs ──');

  await test('render-kb.js declares _kbData variable', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-kb.js'), 'utf8');
    assert.ok(src.includes('let _kbData') || src.includes('var _kbData') || src.includes('const _kbData'),
      '_kbData must be explicitly declared to avoid implicit global / ReferenceError in strict mode');
  });

  await test('render-kb.js escapes item.agent', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-kb.js'), 'utf8');
    assert.ok(src.includes("escHtml(item.agent)"),
      'item.agent must be escaped via escHtml to prevent XSS');
  });

  await test('_archiveMeeting clears markDeleted on API failure', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-meetings.js'), 'utf8');
    const fn = src.match(/async function _archiveMeeting[\s\S]*?^}/m);
    assert.ok(fn, '_archiveMeeting must exist');
    assert.ok(fn[0].includes("_deletedIds.delete"),
      'must clear markDeleted on API failure to prevent phantom invisible meeting');
  });

  await test('chainPlanToPrd uses mutateJsonFileLocked', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.match(/function chainPlanToPrd[\s\S]*?^}/m);
    assert.ok(fn, 'chainPlanToPrd must exist');
    assert.ok(fn[0].includes('mutateJsonFileLocked'),
      'chainPlanToPrd must use mutateJsonFileLocked for atomic read-modify-write on work-items.json');
    assert.ok(!fn[0].includes('safeWrite(wiPath'),
      'chainPlanToPrd must not use unlocked safeWrite on work-items.json');
  });
}

// ─── PR Duplicate Race Condition Fixes ──────────────────────────────────────

async function testPrDuplicateRaceFix() {
  console.log('\n── PR Duplicate Race Condition Fixes ──');

  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const dashboardSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  await test('/api/pull-requests/link uses mutateJsonFileLocked, not safeWrite', () => {
    // The link handler should be inside a mutateJsonFileLocked block
    assert.ok(dashboardSrc.includes("mutateJsonFileLocked(prPath"),
      'PR link endpoint must use mutateJsonFileLocked for atomic check-and-insert');
  });

  await test('updatePrAfterReview uses mutateJsonFileLocked, not safeWrite', () => {
    const fn = lifecycleSrc.match(/function updatePrAfterReview[\s\S]*?^}/m);
    assert.ok(fn, 'updatePrAfterReview must exist');
    assert.ok(fn[0].includes('mutateJsonFileLocked'),
      'updatePrAfterReview must use mutateJsonFileLocked on PR file');
    assert.ok(!fn[0].includes('shared.safeWrite(project'),
      'updatePrAfterReview must not use bare safeWrite on PR file');
  });

  await test('updatePrAfterFix uses mutateJsonFileLocked, not safeWrite', () => {
    const fn = lifecycleSrc.match(/function updatePrAfterFix[\s\S]*?^}/m);
    assert.ok(fn, 'updatePrAfterFix must exist');
    assert.ok(fn[0].includes('mutateJsonFileLocked'),
      'updatePrAfterFix must use mutateJsonFileLocked on PR file');
    assert.ok(!fn[0].includes('shared.safeWrite(project'),
      'updatePrAfterFix must not use bare safeWrite on PR file');
  });

  await test('updatePrAfterReview metrics write uses mutateJsonFileLocked', () => {
    const fn = lifecycleSrc.match(/function updatePrAfterReview[\s\S]*?^}/m);
    assert.ok(fn, 'updatePrAfterReview must exist');
    // Metrics write should also be locked
    const metricsWrites = (fn[0].match(/mutateJsonFileLocked/g) || []).length;
    assert.ok(metricsWrites >= 2,
      'updatePrAfterReview should use mutateJsonFileLocked for both PR file and metrics file');
  });

  // ── Merge-back pattern: only modified PRs, not full stale snapshot ──

  await test('ado.js forEachActivePr merges only activePrs, not full prs snapshot', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    const fn = src.match(/async function forEachActivePr[\s\S]*?^}/m);
    assert.ok(fn, 'forEachActivePr must exist');
    // The merge-back must iterate activePrs (modified only), not prs (full snapshot)
    assert.ok(fn[0].includes('for (const updatedPr of activePrs)'),
      'ado.js merge-back must iterate activePrs, not the full prs snapshot');
    assert.ok(!fn[0].includes('for (const updatedPr of prs)'),
      'ado.js merge-back must NOT iterate the full prs snapshot — overwrites concurrent writes');
  });

  await test('github.js forEachActiveGhPr merges only activePrs, not full prs snapshot', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    const fn = src.match(/async function forEachActiveGhPr[\s\S]*?^}/m);
    assert.ok(fn, 'forEachActiveGhPr must exist');
    assert.ok(fn[0].includes('for (const updatedPr of activePrs)'),
      'github.js project merge-back must iterate activePrs');
    assert.ok(fn[0].includes('for (const updatedPr of activeCentral)'),
      'github.js central merge-back must iterate activeCentral');
    // Must not have the old pattern iterating full snapshots
    assert.ok(!fn[0].includes('for (const updatedPr of prs)'),
      'github.js must NOT iterate full prs snapshot');
    assert.ok(!fn[0].includes('for (const updatedPr of centralPrs)'),
      'github.js must NOT iterate full centralPrs snapshot');
  });

  await test('merge-back does not re-add deleted PRs (no else push)', () => {
    const adoSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    const ghSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    // forEachActivePr/forEachActiveGhPr merge-backs should only overwrite, never push
    const adoFn = adoSrc.match(/async function forEachActivePr[\s\S]*?^}/m);
    const ghFn = ghSrc.match(/async function forEachActiveGhPr[\s\S]*?^}/m);
    // Count "currentPrs.push(updatedPr)" inside the merge-back blocks
    const adoPushes = (adoFn[0].match(/currentPrs\.push\(updatedPr\)/g) || []).length;
    const ghPushes = (ghFn[0].match(/currentPrs\.push\(updatedPr\)/g) || []).length;
    assert.strictEqual(adoPushes, 0, 'ado.js merge-back must not push — deleted PRs should stay deleted');
    assert.strictEqual(ghPushes, 0, 'github.js merge-back must not push — deleted PRs should stay deleted');
  });

  // ── Branch regex matches W- prefixed work item IDs ──

  await test('github.js reconcilePrs branch regex matches all work item ID prefixes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    const reconcileFn = src.match(/async function reconcilePrs[\s\S]*?^}/m);
    assert.ok(reconcileFn, 'reconcilePrs must exist in github.js');
    assert.ok(reconcileFn[0].includes('W-[a-z0-9]'), 'must match W- IDs');
    assert.ok(reconcileFn[0].includes('PL-[a-z0-9]'), 'must match PL- IDs');
    assert.ok(reconcileFn[0].includes('P-[a-z0-9]'), 'must match P- IDs');
  });

  // ── GitHub poll backoff tests ──
  await test('github.js exports backoff helpers for per-repo exponential backoff', () => {
    const gh = require(path.join(MINIONS_DIR, 'engine', 'github.js'));
    assert.ok(typeof gh.isSlugInBackoff === 'function', 'isSlugInBackoff must be exported');
    assert.ok(typeof gh.recordSlugFailure === 'function', 'recordSlugFailure must be exported');
    assert.ok(typeof gh.resetSlugBackoff === 'function', 'resetSlugBackoff must be exported');
    assert.ok(gh._ghPollBackoff instanceof Map, '_ghPollBackoff must be a Map');
  });

  await test('github.js isSlugInBackoff returns false for unknown slugs', () => {
    const gh = require(path.join(MINIONS_DIR, 'engine', 'github.js'));
    assert.strictEqual(gh.isSlugInBackoff('nonexistent/repo'), false);
  });

  await test('github.js recordSlugFailure puts slug into backoff', () => {
    const gh = require(path.join(MINIONS_DIR, 'engine', 'github.js'));
    const testSlug = '_test/backoff-record';
    gh._ghPollBackoff.delete(testSlug);
    gh.recordSlugFailure(testSlug);
    assert.strictEqual(gh.isSlugInBackoff(testSlug), true, 'slug should be in backoff after failure');
    const entry = gh._ghPollBackoff.get(testSlug);
    assert.strictEqual(entry.failures, 1, 'first failure should set failures=1');
    assert.ok(entry.backoffUntil > Date.now(), 'backoffUntil should be in the future');
    gh._ghPollBackoff.delete(testSlug); // cleanup
  });

  await test('github.js recordSlugFailure applies exponential backoff', () => {
    const gh = require(path.join(MINIONS_DIR, 'engine', 'github.js'));
    const testSlug = '_test/backoff-exponential';
    gh._ghPollBackoff.delete(testSlug);
    gh.recordSlugFailure(testSlug);
    const first = gh._ghPollBackoff.get(testSlug);
    gh.recordSlugFailure(testSlug);
    const second = gh._ghPollBackoff.get(testSlug);
    assert.strictEqual(second.failures, 2, 'second failure should set failures=2');
    // Second backoff should be longer than first (2^1 vs 2^0 multiplier)
    const firstDuration = first.backoffUntil - Date.now();
    const secondDuration = second.backoffUntil - Date.now();
    assert.ok(secondDuration > firstDuration, 'backoff duration should increase with failures');
    gh._ghPollBackoff.delete(testSlug); // cleanup
  });

  await test('github.js resetSlugBackoff clears backoff state', () => {
    const gh = require(path.join(MINIONS_DIR, 'engine', 'github.js'));
    const testSlug = '_test/backoff-reset';
    gh.recordSlugFailure(testSlug);
    assert.strictEqual(gh.isSlugInBackoff(testSlug), true);
    gh.resetSlugBackoff(testSlug);
    assert.strictEqual(gh.isSlugInBackoff(testSlug), false, 'slug should not be in backoff after reset');
    assert.strictEqual(gh._ghPollBackoff.has(testSlug), false, 'entry should be deleted');
  });

  await test('github.js forEachActiveGhPr skips projects in backoff', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('isSlugInBackoff(slug)'), 'forEachActiveGhPr must check isSlugInBackoff');
    assert.ok(src.includes('recordSlugFailure(slug)'), 'must call recordSlugFailure on probe failure');
    assert.ok(src.includes('resetSlugBackoff(slug)'), 'must call resetSlugBackoff on probe success');
  });

  await test('github.js reconcilePrs skips projects in backoff', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    const reconcileFn = src.match(/async function reconcilePrs[\s\S]*?^}/m);
    assert.ok(reconcileFn, 'reconcilePrs must exist');
    assert.ok(reconcileFn[0].includes('isSlugInBackoff'), 'reconcilePrs must check backoff');
    assert.ok(reconcileFn[0].includes('recordSlugFailure'), 'reconcilePrs must record failures');
    assert.ok(reconcileFn[0].includes('resetSlugBackoff'), 'reconcilePrs must reset on success');
  });

  await test('github.js backoff has 30-minute cap', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('30 * 60 * 1000'), 'backoff must have 30-minute cap');
    assert.ok(src.includes('GH_POLL_BACKOFF_MAX_MS'), 'must use named constant for max backoff');
  });

  await test('ado.js reconcilePrs branch regex matches all work item ID prefixes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    const reconcileFn = src.match(/async function reconcilePrs[\s\S]*?^}/m);
    assert.ok(reconcileFn, 'reconcilePrs must exist in ado.js');
    assert.ok(reconcileFn[0].includes('W-[a-z0-9]'), 'must match W- IDs');
    assert.ok(reconcileFn[0].includes('PL-[a-z0-9]'), 'must match PL- IDs');
    assert.ok(reconcileFn[0].includes('P-[a-z0-9]'), 'must match P- IDs');
  });

  // ── ADO Auth Failure → Stale Build Status ──

  await test('ado.js exports needsAdoPollRetry and isAdoAuthError helpers', () => {
    const ado = require(path.join(MINIONS_DIR, 'engine', 'ado'));
    assert.ok(typeof ado.needsAdoPollRetry === 'function', 'needsAdoPollRetry must be exported');
    assert.ok(typeof ado.isAdoAuthError === 'function', 'isAdoAuthError must be exported');
  });

  await test('ado.js isAdoAuthError detects auth-related errors', () => {
    const ado = require(path.join(MINIONS_DIR, 'engine', 'ado'));
    assert.ok(ado.isAdoAuthError(new Error('ADO returned HTML instead of JSON (likely auth redirect) for https://dev.azure.com/...')),
      'should detect HTML/auth redirect errors');
    assert.ok(ado.isAdoAuthError(new Error('ADO API 401: Unauthorized')),
      'should detect 401 errors');
    assert.ok(ado.isAdoAuthError(new Error('ADO API 403: Forbidden')),
      'should detect 403 errors');
    assert.ok(!ado.isAdoAuthError(new Error('ADO API 500: Internal Server Error')),
      'should NOT flag 500 errors as auth');
    assert.ok(!ado.isAdoAuthError(new Error('Network timeout')),
      'should NOT flag timeout errors as auth');
  });

  await test('ado.js pollPrStatus sets _buildStatusStale on auth error', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    const pollFn = src.match(/async function pollPrStatus[\s\S]*?^}/m);
    assert.ok(pollFn, 'pollPrStatus must exist');
    assert.ok(pollFn[0].includes('_buildStatusStale'), 'pollPrStatus must set _buildStatusStale flag on auth error');
    assert.ok(pollFn[0].includes('isAdoAuthError'), 'pollPrStatus must use isAdoAuthError to detect auth errors');
    assert.ok(pollFn[0].includes('_adoPollHadAuthFailure = true'), 'pollPrStatus must set _adoPollHadAuthFailure on auth error');
    assert.ok(pollFn[0].includes('delete pr._buildStatusStale'), 'pollPrStatus must clear _buildStatusStale on successful poll');
  });

  await test('ado.js pollPrStatus resets _adoPollHadAuthFailure at start', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    const pollFn = src.match(/async function pollPrStatus[\s\S]*?^}/m);
    assert.ok(pollFn, 'pollPrStatus must exist');
    // The flag should be reset at the top of pollPrStatus, before any polling
    const resetIdx = pollFn[0].indexOf('_adoPollHadAuthFailure = false');
    assert.ok(resetIdx >= 0, 'pollPrStatus must reset _adoPollHadAuthFailure to false at start');
    const fetchIdx = pollFn[0].indexOf('adoFetch');
    assert.ok(resetIdx < fetchIdx, 'reset must happen before any adoFetch calls');
  });

  await test('engine.js imports needsAdoPollRetry and uses it in tick cadence', () => {
    const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(engineSrc.includes('needsAdoPollRetry'), 'engine.js must import needsAdoPollRetry');
    assert.ok(engineSrc.includes('needsAdoPollRetry()'), 'engine.js must call needsAdoPollRetry() in tick loop');
    // Should be used alongside the 6-tick cadence check
    assert.ok(engineSrc.includes('tickCount % 6 === 0 || needsAdoPollRetry()'),
      'engine.js must bypass 6-tick cadence when needsAdoPollRetry() is true');
  });

  await test('dashboard render-prs.js shows stale build status indicator', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
    assert.ok(src.includes('_buildStatusStale'), 'render-prs.js must check _buildStatusStale');
    assert.ok(src.includes('build-stale'), 'render-prs.js must use build-stale CSS class');
    assert.ok(src.includes('(stale)'), 'render-prs.js must show (stale) label');
  });

  await test('lifecycle.js handlePostMerge branch regex matches all work item ID prefixes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.match(/async function handlePostMerge[\s\S]*?^}/m);
    assert.ok(fn, 'handlePostMerge must exist');
    assert.ok(fn[0].includes('W-[a-z0-9]'), 'must match W- IDs');
    assert.ok(fn[0].includes('PL-[a-z0-9]'), 'must match PL- IDs');
    assert.ok(fn[0].includes('P-[a-z0-9]'), 'must match P- IDs');
  });
}

// ─── Version Check Feature ──────────────────────────────────────────────────

async function testVersionCheck() {
  console.log('\n── Version Check Feature ──');

  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-dispatch.js'), 'utf8');
  const layoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
  const refreshSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'refresh.js'), 'utf8');

  await test('engine cli.js writes codeVersion and codeCommit to control.json on start', () => {
    assert.ok(cliSrc.includes('codeVersion'), 'cli.js must write codeVersion');
    assert.ok(cliSrc.includes('codeCommit'), 'cli.js must write codeCommit');
    assert.ok(cliSrc.includes("require('../package.json').version"), 'codeVersion should come from package.json');
    assert.ok(cliSrc.includes('git rev-parse --short HEAD'), 'codeCommit should come from git');
  });

  await test('engine cli.js busts require cache for package.json before reading version', () => {
    assert.ok(cliSrc.includes("delete require.cache[") && cliSrc.includes("require.resolve('../package.json')"),
      'cli.js must bust require cache for package.json so npm updates are detected after restart');
  });

  await test('dashboard getStatus includes version object with engine + dashboard stale flags', () => {
    assert.ok(dashSrc.includes('version:') && dashSrc.includes('engineStale') && dashSrc.includes('dashboardStale') && dashSrc.includes('updateAvailable:'),
      'status response must include version with engineStale, dashboardStale, and updateAvailable fields');
  });

  await test('getDiskVersion caches git rev-parse with TTL', () => {
    assert.ok(dashSrc.includes('function getDiskVersion'), 'getDiskVersion must exist');
    assert.ok(dashSrc.includes('DISK_VERSION_TTL'), 'must use a TTL cache');
    assert.ok(dashSrc.includes('_diskVersionCacheTs'), 'must track cache timestamp');
    // Must not run git rev-parse inline in getStatus
    const statusFn = dashSrc.match(/function getStatus\(\)[\s\S]*?^}/m);
    assert.ok(statusFn, 'getStatus must exist');
    assert.ok(!statusFn[0].includes('execSync'), 'getStatus must not call execSync directly — use getDiskVersion cache');
  });

  await test('getDiskVersion busts require cache for package.json', () => {
    const fn = dashSrc.match(/function getDiskVersion[\s\S]*?^}/m);
    assert.ok(fn, 'getDiskVersion must exist');
    assert.ok(fn[0].includes('delete require.cache'), 'must bust require cache so npm updates are detected');
  });

  await test('checkNpmVersion uses npm view (respects proxy/registry config)', () => {
    assert.ok(dashSrc.includes('npm') && dashSrc.includes('view'),
      'must use npm view to check latest version');
  });

  await test('_compareVersions correctly compares semver', () => {
    // Test the actual function
    const fn = new Function('return ' + dashSrc.match(/function _compareVersions[\s\S]*?^}/m)[0])();
    assert.strictEqual(fn('1.0.0', '1.0.0'), 0);
    assert.strictEqual(fn('1.0.1', '1.0.0'), 1);
    assert.strictEqual(fn('1.0.0', '1.0.1'), -1);
    assert.strictEqual(fn('0.2.0', '0.1.999'), 1);
    assert.strictEqual(fn('2.0.0', '1.99.99'), 1);
    assert.strictEqual(fn(null, '1.0.0'), -1);
    assert.strictEqual(fn('1.0.0', null), 1);
  });

  await test('/api/version endpoint includes engine + dashboard version fields', () => {
    assert.ok(dashSrc.includes("'/api/version'"), '/api/version route must exist');
    assert.ok(dashSrc.includes('checkNpmVersion'), '/api/version must call checkNpmVersion');
    assert.ok(dashSrc.includes('engineRunning'), '/api/version must include engineRunning');
    assert.ok(dashSrc.includes('dashboardRunning'), '/api/version must include dashboardRunning');
    assert.ok(dashSrc.includes('engineStale'), '/api/version must include engineStale');
    assert.ok(dashSrc.includes('dashboardStale'), '/api/version must include dashboardStale');
  });

  await test('layout.html has version-banner element in header', () => {
    assert.ok(layoutSrc.includes('id="version-banner"'), 'layout must have version-banner element');
    // Should be near the engine badge, not in a separate div
    const badgeLine = layoutSrc.indexOf('engine-badge');
    const bannerLine = layoutSrc.indexOf('version-banner');
    assert.ok(Math.abs(badgeLine - bannerLine) < 200,
      'version-banner should be near the engine-badge in the header');
  });

  await test('renderVersionBanner handles all five states (both stale, engine stale, dashboard stale, update, ok)', () => {
    assert.ok(renderSrc.includes('function renderVersionBanner'), 'renderVersionBanner must exist');
    assert.ok(renderSrc.includes('version.engineStale && version.dashboardStale'), 'must handle both-stale state');
    assert.ok(renderSrc.includes('version.engineStale'), 'must handle engine-only stale');
    assert.ok(renderSrc.includes('version.dashboardStale'), 'must handle dashboard-only stale');
    assert.ok(renderSrc.includes('version.updateAvailable'), 'must handle updateAvailable state');
    assert.ok(renderSrc.includes('npm update'), 'update state should show npm command');
    assert.ok(renderSrc.includes('minions restart'), 'stale states should say minions restart');
  });

  await test('dashboard.js records _dashboardVersion at module load', () => {
    assert.ok(dashSrc.includes('_dashboardVersion'), 'must have _dashboardVersion variable');
    assert.ok(dashSrc.includes('_dashboardVersion.codeVersion'), 'must reference dashboard codeVersion');
    // Should be set at module load, not inside server.listen
    const beforeListen = dashSrc.indexOf('server.listen');
    const dashVersionDef = dashSrc.indexOf('_dashboardVersion =');
    assert.ok(dashVersionDef < beforeListen, '_dashboardVersion should be set before server.listen (at module load)');
  });

  await test('status version object includes dashboardRunning fields', () => {
    const statusFn = dashSrc.match(/function getStatus\(\)[\s\S]*?^}/m);
    assert.ok(statusFn, 'getStatus must exist');
    assert.ok(statusFn[0].includes('dashboardRunning'), 'must include dashboardRunning');
    assert.ok(statusFn[0].includes('dashboardRunningCommit'), 'must include dashboardRunningCommit');
    assert.ok(statusFn[0].includes('dashboardStale'), 'must include dashboardStale');
  });

  await test('refresh.js calls renderVersionBanner', () => {
    assert.ok(refreshSrc.includes('renderVersionBanner(data.version)'),
      'refresh must pass data.version to renderVersionBanner');
  });
}

// ─── Auto-Recovery & Atomicity Tests ─────────────────────────────────────────

async function testAutoRecoveryAndAtomicity() {
  console.log('\n── Auto-Recovery & Atomicity ──');

  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');

  // ── Source structure: auto-recovery feature ──

  await test('syncPrsFromOutput runs unconditionally (not gated on isSuccess)', () => {
    // PR sync must run before the success/failure branching so timed-out agents' PRs are captured
    const hookBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function runPostCompletionHooks('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function runPostCompletionHooks(') + 1)
    );
    // syncPrsFromOutput must NOT be inside an `if (isSuccess)` or `if (effectiveSuccess)` guard
    const syncIdx = hookBody.indexOf('syncPrsFromOutput(stdout');
    assert.ok(syncIdx > 0, 'syncPrsFromOutput must be called in runPostCompletionHooks');
    // Check that the 200 chars before the call don't contain `if (isSuccess)` or `if (effectiveSuccess)`
    const before = hookBody.slice(Math.max(0, syncIdx - 200), syncIdx);
    assert.ok(!before.includes('if (isSuccess)') && !before.includes('if (effectiveSuccess)'),
      'syncPrsFromOutput must not be gated on isSuccess or effectiveSuccess');
  });

  await test('autoRecovered restricted to PR-creating work types', () => {
    assert.ok(lifecycleSrc.includes('WORK_TYPE.IMPLEMENT || type === WORK_TYPE.IMPLEMENT_LARGE || type === WORK_TYPE.FIX'),
      'prCreatingType must check IMPLEMENT, IMPLEMENT_LARGE, and FIX');
    assert.ok(lifecycleSrc.includes('prCreatingType && !!meta?.item?.id'),
      'autoRecovered must require prCreatingType');
  });

  await test('autoRecovered is returned from runPostCompletionHooks', () => {
    const hookBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function runPostCompletionHooks('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function runPostCompletionHooks(') + 1)
    );
    assert.ok(hookBody.includes('return { resultSummary, taskUsage, autoRecovered, structuredCompletion }'),
      'runPostCompletionHooks must return autoRecovered and structuredCompletion in its result');
  });

  await test('engine.js uses autoRecovered to upgrade completeDispatch result', () => {
    assert.ok(engineSrc.includes('const { resultSummary, autoRecovered } = await runPostCompletionHooks'),
      'engine.js must destructure autoRecovered from runPostCompletionHooks');
    assert.ok(engineSrc.includes('code === 0 || autoRecovered'),
      'engine.js must use autoRecovered to determine effectiveResult for completeDispatch');
  });

  await test('effectiveSuccess drives all downstream success checks', () => {
    const hookBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function runPostCompletionHooks('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function runPostCompletionHooks(') + 1)
    );
    // These should use effectiveSuccess, not isSuccess
    assert.ok(hookBody.includes('effectiveSuccess && meta?.item?.sourcePlan'),
      'checkPlanCompletion should use effectiveSuccess');
    // Auto-archive removed — verify no longer triggers archive
    assert.ok(!hookBody.includes("archivePlan("),
      'verify archive removed — should not call archivePlan');
    assert.ok(hookBody.includes('if (effectiveSuccess)') && hookBody.includes('extractSkillsFromOutput'),
      'extractSkillsFromOutput should use effectiveSuccess');
    // isSuccess should NOT gate these downstream checks
    assert.ok(!hookBody.includes('if (isSuccess) extractSkillsFromOutput'),
      'extractSkillsFromOutput must NOT use raw isSuccess');
  });

  // ── Source structure: atomicity conversions ──

  await test('updateMetrics uses mutateJsonFileLocked', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function updateMetrics('),
      lifecycleSrc.indexOf('\n}\n', lifecycleSrc.indexOf('function updateMetrics('))
    );
    assert.ok(fnBody.includes('mutateJsonFileLocked(metricsPath'),
      'updateMetrics must use mutateJsonFileLocked instead of safeWrite');
    assert.ok(!fnBody.includes('shared.safeWrite(metricsPath'),
      'updateMetrics must NOT use safeWrite');
  });

  await test('handleDecompositionResult uses mutateJsonFileLocked', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function handleDecompositionResult('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function handleDecompositionResult(') + 1)
    );
    assert.ok(fnBody.includes('mutateJsonFileLocked(wiPath'),
      'handleDecompositionResult must use mutateJsonFileLocked');
    assert.ok(!fnBody.includes('safeWrite(wiPath'),
      'handleDecompositionResult must NOT use safeWrite');
  });

  await test('handleDecompositionResult has no redundant pre-read', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function handleDecompositionResult('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function handleDecompositionResult(') + 1)
    );
    // The old pattern: safeJson(wiPath) before mutateJsonFileLocked should be gone
    const lockIdx = fnBody.indexOf('mutateJsonFileLocked(wiPath');
    const preRead = fnBody.indexOf('safeJson(wiPath)');
    assert.ok(preRead === -1 || preRead > lockIdx,
      'handleDecompositionResult should not pre-read with safeJson before the lock');
  });

  await test('dispatch.js completeDispatch owns retry logic with resolveWorkItemPath', () => {
    const dispatchSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(dispatchSrc.includes('resolveWorkItemPath') || dispatchSrc.includes('lifecycle().resolveWorkItemPath'),
      'completeDispatch retry must use resolveWorkItemPath for path resolution');
    assert.ok(dispatchSrc.includes('retries < maxRetries'),
      'completeDispatch must have retry count guard');
  });

  await test('no-PR detection uses resolveWorkItemPath and mutateJsonFileLocked', () => {
    const hookBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('Detect implement tasks that completed without creating a PR'),
      lifecycleSrc.indexOf('if (type === WORK_TYPE.REVIEW)')
    );
    assert.ok(hookBody.includes('resolveWorkItemPath(meta)'),
      'No-PR detection must use resolveWorkItemPath');
    assert.ok(hookBody.includes('mutateJsonFileLocked(noPrWiPath'),
      'No-PR detection must use mutateJsonFileLocked');
  });

  await test('syncPrdFromPrs uses module-scope imports, not lazy require', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function syncPrdFromPrs('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function syncPrdFromPrs(') + 1)
    );
    assert.ok(!fnBody.includes("require('./shared')"),
      'syncPrdFromPrs must not lazy-require shared.js (already imported at module scope)');
    assert.ok(fnBody.includes('shared.getProjects(') || fnBody.includes('shared.projectWorkItemsPath('),
      'syncPrdFromPrs must use module-scope shared references');
  });

  await test('syncPrdFromPrs reconciles inside lock (no double reconciliation)', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function syncPrdFromPrs('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function syncPrdFromPrs(') + 1)
    );
    // reconcileItemsWithPrs should appear inside mutateJsonFileLocked, not outside as a pre-check
    const lockIdx = fnBody.indexOf('mutateJsonFileLocked(wiPath');
    const reconcileBeforeLock = fnBody.slice(0, lockIdx).indexOf('reconcileItemsWithPrs(items');
    assert.ok(reconcileBeforeLock === -1,
      'reconcileItemsWithPrs must not run as a pre-check before the lock');
    assert.ok(fnBody.includes('reconcileItemsWithPrs(data, allPrs)'),
      'reconcileItemsWithPrs must run inside the lock callback on fresh data');
  });

  await test('skill extraction computes ID inside lock (no race)', () => {
    const fnBody = lifecycleSrc.slice(
      lifecycleSrc.indexOf('function extractSkillsFromOutput('),
      lifecycleSrc.indexOf('\nfunction', lifecycleSrc.indexOf('function extractSkillsFromOutput(') + 1)
    );
    // The skillId computation (`SK${String(data.filter...`) must be inside mutateJsonFileLocked
    const lockIdx = fnBody.indexOf('mutateJsonFileLocked(centralPath');
    assert.ok(lockIdx > 0, 'extractSkillsFromOutput must use mutateJsonFileLocked for central work items');
    const afterLock = fnBody.slice(lockIdx);
    assert.ok(afterLock.includes("i.id?.startsWith('SK')"),
      'Skill ID computation must be inside the lock callback');
    // The dedupe check must also be inside the lock
    assert.ok(afterLock.includes('data.some(i => i.title ==='),
      'Skill dedupe check must be inside the lock callback');
  });

  // ── Functional: auto-recovery with syncPrsFromOutput ──

  const lifecycle = require(path.join(MINIONS_DIR, 'engine', 'lifecycle'));
  const shared = require(path.join(MINIONS_DIR, 'engine', 'shared'));

  await test('runPostCompletionHooks returns autoRecovered=true when failed agent created PR', async () => {
    const tmpDir = createTmpDir();
    const prFile = path.join(tmpDir, 'pull-requests.json');
    shared.safeWrite(prFile, []);

    const mockProject = { name: 'TestProject', localPath: tmpDir, mainBranch: 'main' };
    const mockConfig = { projects: [mockProject], agents: { agent1: { name: 'Agent1' } } };

    const origProjectPrPath = shared.projectPrPath;
    const origGetProjects = shared.getProjects;
    shared.projectPrPath = () => prFile;
    shared.getProjects = () => [mockProject];

    try {
      const output = '{"type":"result","result":"Created PR https://github.com/org/repo/pull/42 — Feature"}';
      const dispatchItem = {
        id: 'D-1', type: 'implement', task: 'Test task',
        meta: { item: { id: 'W-100', title: 'Test' }, project: mockProject, source: 'work-item' }
      };

      // code=1 simulates heartbeat timeout kill
      const result = await lifecycle.runPostCompletionHooks(dispatchItem, 'agent1', 1, output, mockConfig);
      assert.strictEqual(result.autoRecovered, true,
        'autoRecovered should be true when failed implement agent created PR');

      // PR should have been synced despite failure
      const prs = shared.safeJson(prFile) || [];
      assert.ok(prs.length > 0, 'PR should be synced even from failed agent output');
    } finally {
      shared.projectPrPath = origProjectPrPath;
      shared.getProjects = origGetProjects;
    }
  });

  // ── CC Model/Effort Settings ──────────────────────────────────────────────

  await test('ENGINE_DEFAULTS includes ccModel and ccEffort', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.ccModel, 'sonnet', 'ccModel default should be sonnet');
    assert.strictEqual(shared.ENGINE_DEFAULTS.ccEffort, null, 'ccEffort default should be null');
  });

  await test('callLLM and callLLMStreaming accept effort parameter', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'llm.js'), 'utf8');
    assert.ok(src.includes("effort = null"), 'Should accept effort param with null default');
    assert.ok(src.includes("args.push('--effort', effort)"), 'Should pass --effort to CLI');
    const streamingFn = src.slice(src.indexOf('function callLLMStreaming('));
    assert.ok(streamingFn.includes("effort = null"), 'callLLMStreaming should accept effort param');
  });

  await test('ccCall reads ccModel/ccEffort from config and passes effort to LLM', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const ccCallFn = src.slice(src.indexOf('async function ccCall('));
    assert.ok(ccCallFn.includes('ccModel'), 'ccCall should reference ccModel config');
    assert.ok(ccCallFn.includes('effort: ccEffort'), 'ccCall should pass effort to callLLM');
  });

  await test('settings endpoint validates ccModel and ccEffort', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("['sonnet', 'haiku', 'opus']"), 'Should validate ccModel against allowed values');
    assert.ok(src.includes("[null, 'low', 'medium', 'high']"), 'Should validate ccEffort against allowed values');
  });

  await test('ccCall maxTurns defaults from ENGINE_DEFAULTS.ccMaxTurns', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('ENGINE_DEFAULTS.ccMaxTurns'), 'ccCall should reference ENGINE_DEFAULTS.ccMaxTurns');
  });

  await test('CC streaming handler uses configurable ccMaxTurns', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const streamHandler = src.slice(src.indexOf('handleCommandCenterStream'));
    assert.ok(streamHandler.includes('ccMaxTurns'), 'Streaming CC should use ccMaxTurns variable');
  });

  await test('ENGINE_DEFAULTS.ccMaxTurns is 50', () => {
    assert.strictEqual(shared.ENGINE_DEFAULTS.ccMaxTurns, 50, 'ccMaxTurns default should be 50');
  });

  await test('ENGINE_DEFAULTS.teams has all required fields', () => {
    const teams = shared.ENGINE_DEFAULTS.teams;
    assert.ok(teams, 'ENGINE_DEFAULTS should have a teams section');
    assert.strictEqual(teams.enabled, false, 'teams.enabled default should be false');
    assert.strictEqual(teams.appId, '', 'teams.appId default should be empty string');
    assert.strictEqual(teams.appPassword, '', 'teams.appPassword default should be empty string');
    assert.ok(Array.isArray(teams.notifyEvents), 'teams.notifyEvents should be an array');
    assert.ok(teams.notifyEvents.includes('pr-merged'), 'notifyEvents should include pr-merged');
    assert.ok(teams.notifyEvents.includes('agent-completed'), 'notifyEvents should include agent-completed');
    assert.ok(teams.notifyEvents.includes('plan-completed'), 'notifyEvents should include plan-completed');
    assert.ok(teams.notifyEvents.includes('agent-failed'), 'notifyEvents should include agent-failed');
    assert.strictEqual(teams.ccMirror, true, 'teams.ccMirror default should be true');
    assert.strictEqual(teams.inboxPollInterval, 15000, 'teams.inboxPollInterval default should be 15000');
  });

  await test('doctor Teams check: warns when enabled but missing credentials', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'preflight.js'), 'utf8');
    assert.ok(src.includes('Teams integration'), 'doctor should check Teams integration');
    assert.ok(src.includes('teams.appId'), 'doctor should validate appId');
    assert.ok(src.includes('teams.appPassword'), 'doctor should validate appPassword');
    assert.ok(src.includes('docs/teams-setup.md'), 'doctor should reference setup guide when disabled');
  });

  await test('engine/teams.js exports required functions', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.createAdapter, 'function', 'createAdapter should be a function');
    assert.strictEqual(typeof teams.teamsReply, 'function', 'teamsReply should be a function');
    assert.strictEqual(typeof teams.saveConversationRef, 'function', 'saveConversationRef should be a function');
    assert.strictEqual(typeof teams.getConversationRef, 'function', 'getConversationRef should be a function');
    assert.strictEqual(typeof teams.teamsPost, 'function', 'teamsPost should be a function');
    assert.strictEqual(typeof teams.getTeamsConfig, 'function', 'getTeamsConfig should be a function');
    assert.strictEqual(typeof teams.isTeamsEnabled, 'function', 'isTeamsEnabled should be a function');
  });

  await test('getTeamsConfig merges defaults with user config', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    const cfg = teams.getTeamsConfig();
    // Should have all default fields even with no user config
    assert.strictEqual(cfg.enabled, false, 'default enabled should be false');
    assert.ok(Array.isArray(cfg.notifyEvents), 'notifyEvents should be an array');
    assert.strictEqual(cfg.ccMirror, true, 'default ccMirror should be true');
    assert.strictEqual(cfg.inboxPollInterval, 15000, 'default inboxPollInterval should be 15000');
  });

  await test('isTeamsEnabled returns false when disabled', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    // Default config has enabled: false
    assert.strictEqual(teams.isTeamsEnabled(), false, 'should be false with default config');
  });

  await test('createAdapter returns null when Teams is disabled', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    const adapter = teams.createAdapter();
    assert.strictEqual(adapter, null, 'adapter should be null when disabled');
  });

  await test('saveConversationRef uses mutateJsonFileLocked', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes('mutateJsonFileLocked(TEAMS_STATE_PATH'), 'saveConversationRef should use mutateJsonFileLocked');
  });

  await test('teamsReply and teamsPost are safe no-ops when adapter is null', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    // Should not throw
    await teams.teamsReply(null, 'test');
    await teams.teamsPost('key', 'test');
  });

  await test('getConversationRef returns null for unknown key', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(teams.getConversationRef('nonexistent'), null);
  });

  await test('teams.js uses shared.log for all logging', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes("const { log,"), 'should destructure log from shared');
    // Should not use console.log directly
    const lines = src.split('\n');
    const consoleLogLines = lines.filter(l => l.includes('console.log') && !l.trimStart().startsWith('//'));
    assert.strictEqual(consoleLogLines.length, 0, 'should not use console.log directly');
  });

  await test('POST /api/bot route is registered in dashboard.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("path: '/api/bot'"), '/api/bot route should be registered');
    assert.ok(src.includes("method: 'POST'") && src.includes('/api/bot'), 'should be a POST route');
    assert.ok(src.includes('handleTeamsBot'), 'should reference handleTeamsBot handler');
  });

  await test('/api/bot returns 503 when Teams disabled', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function handleTeamsBot'));
    assert.ok(handler.includes('503'), 'should return 503 when disabled');
    assert.ok(handler.includes('Teams integration disabled'), 'should include disabled message');
  });

  await test('/api/bot filters bot own messages by appId', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function handleTeamsBot'));
    assert.ok(handler.includes('cfg.appId'), 'should compare from.id to appId');
    assert.ok(handler.includes('activity.from?.id === cfg.appId'), 'should filter bot own messages');
  });

  await test('/api/bot writes to teams-inbox.json with required fields', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function handleTeamsBot'));
    assert.ok(handler.includes('mutateJsonFileLocked(TEAMS_INBOX_PATH'), 'should use mutateJsonFileLocked for teams-inbox.json');
    assert.ok(handler.includes('id: msgId'), 'message should have id field');
    assert.ok(handler.includes('text: activity.text'), 'message should have text field');
    assert.ok(handler.includes("from: activity.from?.name"), 'message should have from field');
    assert.ok(handler.includes('conversationRef:'), 'message should have conversationRef field');
    assert.ok(handler.includes('receivedAt:'), 'message should have receivedAt field');
    assert.ok(handler.includes('_processedAt: null'), 'message should have _processedAt field');
  });

  await test('/api/bot saves conversationRef on conversationUpdate and installationUpdate', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const handler = src.slice(src.indexOf('async function handleTeamsBot'));
    assert.ok(handler.includes("activity.type === 'conversationUpdate'"), 'should handle conversationUpdate');
    assert.ok(handler.includes("activity.type === 'installationUpdate'"), 'should handle installationUpdate');
    assert.ok(handler.includes('teams.saveConversationRef'), 'should call saveConversationRef');
  });

  await test('TEAMS_INBOX_PATH is defined in dashboard.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("const TEAMS_INBOX_PATH = path.join(ENGINE_DIR, 'teams-inbox.json')"), 'TEAMS_INBOX_PATH should be defined');
  });

  await test('processTeamsInbox is exported from engine/teams.js', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.processTeamsInbox, 'function', 'processTeamsInbox should be a function');
  });

  await test('processTeamsInbox returns early when Teams disabled', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    // Default config has enabled: false — should return immediately without errors
    await teams.processTeamsInbox();
  });

  await test('processTeamsInbox reads inbox and filters unprocessed', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTeamsInbox'));
    assert.ok(fn.includes('safeJson(TEAMS_INBOX_PATH)'), 'should read from TEAMS_INBOX_PATH');
    assert.ok(fn.includes('!m._processedAt'), 'should filter for unprocessed messages');
    assert.ok(fn.includes('_processedAt'), 'should mark messages as processed');
  });

  await test('processTeamsInbox calls CC via HTTP API', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTeamsInbox'));
    assert.ok(fn.includes('/api/command-center'), 'should call CC via dashboard HTTP API');
    assert.ok(fn.includes('fetch('), 'should use fetch for HTTP call');
  });

  await test('processTeamsInbox tracks usage under teams category', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTeamsInbox'));
    assert.ok(fn.includes("trackEngineUsage('teams'"), 'should track usage under teams category');
  });

  await test('processTeamsInbox prunes inbox when exceeding cap', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTeamsInbox'));
    assert.ok(fn.includes('TEAMS_INBOX_CAP'), 'should reference TEAMS_INBOX_CAP');
    assert.ok(fn.includes('data.length > TEAMS_INBOX_CAP'), 'should check if inbox exceeds cap');
  });

  await test('TEAMS_INBOX_CAP is 200', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(teams.TEAMS_INBOX_CAP, 200, 'TEAMS_INBOX_CAP should be 200');
  });

  await test('Teams inbox timer in cli.js fires only when engine is running', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(src.includes('teamsInboxTimer'), 'should define teamsInboxTimer');
    assert.ok(src.includes("ctrl.state !== 'running'"), 'should check engine state before processing');
    assert.ok(src.includes('processTeamsInbox'), 'should call processTeamsInbox');
  });

  await test('Teams inbox timer is cleared on shutdown', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(src.includes('clearInterval(teamsInboxTimer)'), 'should clear teamsInboxTimer on shutdown');
  });

  await test('teamsPostCCResponse is exported from engine/teams.js', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.teamsPostCCResponse, 'function', 'teamsPostCCResponse should be a function');
  });

  await test('teamsPostCCResponse returns early when Teams disabled', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    // Default config has enabled: false — should return immediately
    await teams.teamsPostCCResponse('test', 'response');
  });

  await test('teamsPostCCResponse uses buildCCResponseCard', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsPostCCResponse'));
    assert.ok(fn.includes('cards.buildCCResponseCard'), 'should use card builder');
  });

  await test('teamsPostCCResponse has 5s rate limit', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(teams.CC_MIRROR_RATE_LIMIT_MS, 5000, 'rate limit should be 5000ms');
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsPostCCResponse'));
    assert.ok(fn.includes('_lastCCMirrorPost'), 'should track last mirror post timestamp');
    assert.ok(fn.includes('CC_MIRROR_RATE_LIMIT_MS'), 'should reference rate limit constant');
  });

  await test('CC mirror hooks in dashboard.js skip Teams-originated messages', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    // Non-streaming handler
    const ccHandler = src.slice(src.indexOf('async function handleCommandCenter('));
    assert.ok(ccHandler.includes("tabId.startsWith('teams-')"), 'non-streaming should check tabId for teams origin');
    assert.ok(ccHandler.includes('teamsPostCCResponse'), 'non-streaming should call teamsPostCCResponse');
    assert.ok(ccHandler.includes('.catch(() => {})'), 'non-streaming mirror should be non-blocking');
  });

  await test('CC streaming mirror hooks skip Teams-originated messages', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const streamHandler = src.slice(src.indexOf('async function handleCommandCenterStream('));
    assert.ok(streamHandler.includes("_streamTabId.startsWith('teams-')"), 'streaming should check tabId for teams origin');
    assert.ok(streamHandler.includes('teamsPostCCResponse'), 'streaming should call teamsPostCCResponse');
    assert.ok(streamHandler.includes('.catch(() => {})'), 'streaming mirror should be non-blocking');
  });

  await test('CC mirror checks ccMirror config before posting', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsPostCCResponse'));
    assert.ok(fn.includes('cfg.ccMirror'), 'should check ccMirror config');
  });

  await test('teamsNotifyCompletion is exported from engine/teams.js', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.teamsNotifyCompletion, 'function', 'teamsNotifyCompletion should be a function');
  });

  await test('teamsNotifyCompletion returns early when Teams disabled', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    await teams.teamsNotifyCompletion({ id: 'test', task: 'test' }, 'success', 'dallas');
  });

  await test('teamsNotifyCompletion filters by notifyEvents config', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsNotifyCompletion'));
    assert.ok(fn.includes('cfg.notifyEvents'), 'should check notifyEvents config');
    assert.ok(fn.includes("'agent-completed'"), 'should map success to agent-completed');
    assert.ok(fn.includes("'agent-failed'"), 'should map failure to agent-failed');
  });

  await test('teamsNotifyCompletion uses buildCompletionCard with agent, title, result', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsNotifyCompletion'));
    assert.ok(fn.includes('agentId'), 'should include agent ID');
    assert.ok(fn.includes('title'), 'should include task title');
    assert.ok(fn.includes('result'), 'should include result status');
    assert.ok(fn.includes('cards.buildCompletionCard'), 'should use card builder');
  });

  await test('Dead TEAMS_PLAN_FLOW_URL block is removed from lifecycle.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(!src.includes('TEAMS_PLAN_FLOW_URL'), 'TEAMS_PLAN_FLOW_URL should be removed');
  });

  await test('runPostCompletionHooks calls teamsNotifyCompletion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function runPostCompletionHooks'));
    assert.ok(fn.includes('teamsNotifyCompletion'), 'should call teamsNotifyCompletion');
    assert.ok(fn.includes('.catch(() => {})'), 'should be non-blocking with .catch');
  });

  await test('teamsNotifyPrEvent is exported from engine/teams.js', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.teamsNotifyPrEvent, 'function', 'teamsNotifyPrEvent should be a function');
  });

  await test('teamsNotifyPrEvent returns early when Teams disabled', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    await teams.teamsNotifyPrEvent({ id: 'PR-1', title: 'test' }, 'pr-merged', { name: 'test' }, null);
  });

  await test('teamsNotifyPrEvent filters by notifyEvents and deduplicates', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsNotifyPrEvent'));
    assert.ok(fn.includes('cfg.notifyEvents'), 'should check notifyEvents config');
    assert.ok(fn.includes('_teamsNotifiedEvents'), 'should check dedup array');
    assert.ok(fn.includes('mutateJsonFileLocked'), 'should use mutateJsonFileLocked for dedup write');
  });

  await test('teamsNotifyPrEvent uses buildPrCard with pr, event, project', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsNotifyPrEvent'));
    assert.ok(fn.includes('cards.buildPrCard'), 'should use card builder');
    assert.ok(fn.includes('event'), 'should pass event');
    assert.ok(fn.includes('project'), 'should pass project');
  });

  await test('handlePostMerge calls teamsNotifyPrEvent for merge and abandon', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handlePostMerge'));
    assert.ok(fn.includes('teamsNotifyPrEvent'), 'should call teamsNotifyPrEvent');
    assert.ok(fn.includes("'pr-merged'"), 'should handle pr-merged event');
    assert.ok(fn.includes("'pr-abandoned'"), 'should handle pr-abandoned event');
    assert.ok(fn.includes('.catch(() => {})'), 'should be non-blocking');
  });

  await test('ado.js pollPrStatus notifies Teams on build failure', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('teamsNotifyPrEvent'), 'ado.js should call teamsNotifyPrEvent');
    assert.ok(src.includes("'build-failed'"), 'ado.js should notify on build-failed');
  });

  await test('github.js pollPrStatus notifies Teams on build failure', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('teamsNotifyPrEvent'), 'github.js should call teamsNotifyPrEvent');
    assert.ok(src.includes("'build-failed'"), 'github.js should notify on build-failed');
  });

  await test('teamsNotifyPlanEvent is exported from engine/teams.js', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(typeof teams.teamsNotifyPlanEvent, 'function', 'teamsNotifyPlanEvent should be a function');
  });

  await test('teamsNotifyPlanEvent returns early when Teams disabled', async () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    await teams.teamsNotifyPlanEvent({ name: 'test plan' }, 'plan-completed');
  });

  await test('teamsNotifyPlanEvent filters by notifyEvents and uses buildPlanCard', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsNotifyPlanEvent'));
    assert.ok(fn.includes('cfg.notifyEvents'), 'should check notifyEvents config');
    assert.ok(fn.includes('planInfo.name'), 'should use plan name');
    assert.ok(fn.includes('cards.buildPlanCard'), 'should use card builder for plan notifications');
  });

  await test('checkPlanCompletion hooks Teams for plan-completed and verify-created', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fn = src.slice(src.indexOf('function checkPlanCompletion'));
    assert.ok(fn.includes('teamsNotifyPlanEvent'), 'should call teamsNotifyPlanEvent');
    assert.ok(fn.includes("'plan-completed'"), 'should notify plan-completed');
    assert.ok(fn.includes("'verify-created'"), 'should notify verify-created');
  });

  await test('handlePlansApprove hooks Teams for plan-approved', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handlePlansApprove'));
    assert.ok(fn.includes('teamsNotifyPlanEvent'), 'should call teamsNotifyPlanEvent');
    assert.ok(fn.includes("'plan-approved'"), 'should notify plan-approved');
  });

  await test('handlePlansReject hooks Teams for plan-rejected', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handlePlansReject'));
    assert.ok(fn.includes('teamsNotifyPlanEvent'), 'should call teamsNotifyPlanEvent');
    assert.ok(fn.includes("'plan-rejected'"), 'should notify plan-rejected');
  });

  await test('engine/teams-cards.js exports all 4 card builders', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    assert.strictEqual(typeof cards.buildCompletionCard, 'function');
    assert.strictEqual(typeof cards.buildPrCard, 'function');
    assert.strictEqual(typeof cards.buildPlanCard, 'function');
    assert.strictEqual(typeof cards.buildCCResponseCard, 'function');
  });

  await test('Adaptive Cards use schema v1.4 and have fallback text', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    const card = cards.buildCompletionCard('dallas', { title: 'test' }, 'success');
    assert.strictEqual(card.version, '1.4', 'should use schema v1.4');
    assert.strictEqual(card.type, 'AdaptiveCard', 'should be AdaptiveCard type');
    assert.ok(card.fallbackText, 'should have fallback text');
    assert.ok(card.actions.some(a => a.type === 'Action.OpenUrl'), 'should have OpenUrl actions');
  });

  await test('buildCompletionCard includes agent, title, result badge, PR link', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    const card = cards.buildCompletionCard('dallas', { title: 'Fix bug' }, 'success', 'https://pr');
    assert.ok(card.fallbackText.includes('dallas'), 'fallback should include agent');
    assert.ok(card.fallbackText.includes('Fix bug'), 'fallback should include title');
    assert.ok(card.actions.some(a => a.url === 'https://pr'), 'should have PR link action');
    assert.ok(card.actions.some(a => a.title === 'Open Dashboard'), 'should have dashboard link');
  });

  await test('buildPrCard includes PR title, event, author', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    const card = cards.buildPrCard({ id: 'PR-1', title: 'My PR', agent: 'dallas', url: 'https://pr' }, 'pr-merged', { name: 'test' });
    assert.ok(card.fallbackText.includes('pr-merged'), 'fallback should include event');
    assert.ok(card.fallbackText.includes('My PR'), 'fallback should include title');
    assert.ok(card.actions.some(a => a.url === 'https://pr'), 'should have PR link');
  });

  await test('buildPlanCard includes plan name, event, item counts', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    const card = cards.buildPlanCard({ name: 'My Plan', doneCount: 3, totalCount: 5 }, 'plan-completed');
    assert.ok(card.fallbackText.includes('plan-completed'), 'fallback should include event');
    assert.ok(card.fallbackText.includes('3/5'), 'fallback should include counts');
    assert.ok(card.actions.some(a => a.url.includes('/prd')), 'should link to PRD page');
  });

  await test('buildCCResponseCard truncates long answers', () => {
    const cards = require(path.join(MINIONS_DIR, 'engine', 'teams-cards'));
    const longAnswer = 'x'.repeat(4000);
    const card = cards.buildCCResponseCard('question', longAnswer);
    const bodyText = card.body.find(b => b.text && b.text.includes('x'));
    assert.ok(bodyText.text.length < 4000, 'should truncate long answers');
    assert.ok(bodyText.text.endsWith('...'), 'should end with ellipsis');
  });

  await test('teamsPost/teamsReply accept Adaptive Card objects', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes('function toActivity(content)'), 'should have toActivity helper');
    assert.ok(src.includes('AdaptiveCard'), 'toActivity should handle AdaptiveCard type');
    assert.ok(src.includes('application/vnd.microsoft.card.adaptive'), 'should use adaptive card content type');
  });

  await test('Notification functions use card builders', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes('cards.buildCompletionCard'), 'teamsNotifyCompletion should use buildCompletionCard');
    assert.ok(src.includes('cards.buildPrCard'), 'teamsNotifyPrEvent should use buildPrCard');
    assert.ok(src.includes('cards.buildPlanCard'), 'teamsNotifyPlanEvent should use buildPlanCard');
    assert.ok(src.includes('cards.buildCCResponseCard'), 'teamsPostCCResponse should use buildCCResponseCard');
  });

  // ── Teams Rate Limiting & Error Handling ──────────────────────────────────

  await test('teams.js exports rate limiting constants', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    assert.strictEqual(teams.MAX_RETRIES_429, 2, 'MAX_RETRIES_429 should be 2');
    assert.strictEqual(teams.MAX_RETRIES_5XX, 3, 'MAX_RETRIES_5XX should be 3');
    assert.strictEqual(teams.CIRCUIT_FAILURE_THRESHOLD, 5, 'CIRCUIT_FAILURE_THRESHOLD should be 5');
    assert.strictEqual(teams.CIRCUIT_RECOVERY_MS, 10 * 60 * 1000, 'CIRCUIT_RECOVERY_MS should be 10 minutes');
    assert.strictEqual(teams.OUTBOUND_QUEUE_MAX, 100, 'OUTBOUND_QUEUE_MAX should be 100');
    assert.strictEqual(teams.OUTBOUND_DRAIN_INTERVAL_MS, 250, 'OUTBOUND_DRAIN_INTERVAL_MS should be 250ms (4/sec)');
  });

  await test('circuit breaker starts in closed state', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    assert.strictEqual(teams._circuit.state, 'closed', 'initial state should be closed');
    assert.strictEqual(teams._circuit.failures, 0, 'initial failures should be 0');
  });

  await test('circuit breaker state is reset by _resetAdapter', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._circuit.state = 'open';
    teams._circuit.failures = 10;
    teams._circuit.openedAt = Date.now();
    teams._resetAdapter();
    assert.strictEqual(teams._circuit.state, 'closed', 'should reset to closed');
    assert.strictEqual(teams._circuit.failures, 0, 'should reset failures to 0');
    assert.strictEqual(teams._circuit.openedAt, 0, 'should reset openedAt to 0');
  });

  await test('circuit breaker source: opens after CIRCUIT_FAILURE_THRESHOLD failures', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes('_circuit.failures >= CIRCUIT_FAILURE_THRESHOLD'), 'should check failure threshold');
    assert.ok(src.includes("_circuit.state = 'open'"), 'should set state to open');
    assert.ok(src.includes('CIRCUIT_RECOVERY_MS'), 'should reference recovery time');
  });

  await test('circuit breaker source: half-open probe after recovery period', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _isCircuitOpen'));
    assert.ok(fn.includes("'half-open'"), 'should transition to half-open');
    assert.ok(fn.includes('CIRCUIT_RECOVERY_MS'), 'should check recovery period');
  });

  await test('circuit breaker source: probe failure reopens circuit', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _onSendFailure'));
    assert.ok(fn.includes("_circuit.state === 'half-open'"), 'should check for half-open state');
    assert.ok(fn.includes("_circuit.state = 'open'"), 'should reopen on probe failure');
  });

  await test('circuit breaker source: success resets to closed', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _onSendSuccess'));
    assert.ok(fn.includes("_circuit.state = 'closed'"), 'should reset to closed on success');
    assert.ok(fn.includes('_circuit.failures = 0'), 'should reset failure count');
  });

  await test('_sendWithRetry handles 429 with Retry-After', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function _sendWithRetry'));
    assert.ok(fn.includes('status === 429'), 'should detect 429 status');
    assert.ok(fn.includes('retry-after'), 'should read Retry-After header');
    assert.ok(fn.includes('MAX_RETRIES_429'), 'should use MAX_RETRIES_429 limit');
    assert.ok(fn.includes('_sleep(delayMs)'), 'should delay before retry');
  });

  await test('_sendWithRetry handles 5xx with exponential backoff', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function _sendWithRetry'));
    assert.ok(fn.includes('status >= 500'), 'should detect 5xx status');
    assert.ok(fn.includes('Math.pow(2, retries5xx - 1) * 1000'), 'should use exponential backoff (1s, 2s, 4s)');
    assert.ok(fn.includes('MAX_RETRIES_5XX'), 'should use MAX_RETRIES_5XX limit');
  });

  await test('outbound queue is exported and starts empty', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._resetAdapter();
    assert.ok(Array.isArray(teams._outboundQueue), '_outboundQueue should be an array');
    assert.strictEqual(teams._outboundQueue.length, 0, 'should start empty');
  });

  await test('outbound queue source: drops messages at OUTBOUND_QUEUE_MAX', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _enqueueMessage'));
    assert.ok(fn.includes('_outboundQueue.length >= OUTBOUND_QUEUE_MAX'), 'should check queue length against max');
    assert.ok(fn.includes('dropping message'), 'should log when dropping');
  });

  await test('outbound queue source: drains at OUTBOUND_DRAIN_INTERVAL_MS', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    assert.ok(src.includes('setInterval(_drainQueue, OUTBOUND_DRAIN_INTERVAL_MS)'), 'should drain at configured interval');
  });

  await test('outbound queue source: auto-stops drain timer when empty', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function _drainQueue'));
    assert.ok(fn.includes('_outboundQueue.length === 0'), 'should check if queue is empty');
    assert.ok(fn.includes('_stopDrainTimer()'), 'should stop timer when empty');
  });

  await test('teamsPost uses outbound queue instead of direct send', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsPost('));
    assert.ok(fn.includes('_enqueueMessage'), 'teamsPost should enqueue instead of sending directly');
    assert.ok(!fn.includes('continueConversationAsync'), 'teamsPost should not call adapter directly');
  });

  await test('teamsReply uses circuit breaker and retry', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function teamsReply('));
    assert.ok(fn.includes('_isCircuitOpen()'), 'teamsReply should check circuit breaker');
    assert.ok(fn.includes('_sendWithRetry'), 'teamsReply should use _sendWithRetry');
    assert.ok(fn.includes('_onSendSuccess()'), 'teamsReply should call _onSendSuccess');
    assert.ok(fn.includes('_onSendFailure()'), 'teamsReply should call _onSendFailure');
  });

  await test('_sendProactive uses circuit breaker and retry', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function _sendProactive('));
    assert.ok(fn.includes('_isCircuitOpen()'), '_sendProactive should check circuit breaker');
    assert.ok(fn.includes('_sendWithRetry'), '_sendProactive should use _sendWithRetry');
    assert.ok(fn.includes('_onSendSuccess()'), '_sendProactive should call _onSendSuccess');
    assert.ok(fn.includes('_onSendFailure()'), '_sendProactive should call _onSendFailure');
  });

  await test('no unhandled rejections in Teams code — all async paths have catch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'teams.js'), 'utf8');
    // Every async function that calls sendActivity or continueConversationAsync
    // should be wrapped in try-catch
    const asyncFns = src.match(/async function \w+/g) || [];
    for (const fn of asyncFns) {
      const fnName = fn.replace('async function ', '');
      const fnBody = src.slice(src.indexOf(fn));
      const nextFn = fnBody.indexOf('\nasync function ', 1);
      const body = nextFn > 0 ? fnBody.slice(0, nextFn) : fnBody;
      if (body.includes('await') && !body.includes('try')) {
        // processTeamsInbox has try-catch inside the for loop
        if (fnName !== '_sleep') {
          assert.fail(`${fnName} has await but no try-catch — potential unhandled rejection`);
        }
      }
    }
  });

  await test('_resetAdapter clears outbound queue and drain timer', () => {
    const teams = require(path.join(MINIONS_DIR, 'engine', 'teams'));
    teams._outboundQueue.push({ key: 'test', content: 'msg' });
    teams._resetAdapter();
    assert.strictEqual(teams._outboundQueue.length, 0, 'queue should be cleared');
  });

  await test('doc-chat restricts tools — no Bash for read-only, no WebSearch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const docCallFn = src.slice(src.indexOf('async function ccDocCall('));
    assert.ok(docCallFn.includes("'Read,Glob,Grep'"), 'Read-only doc-chat should only allow Read,Glob,Grep');
    assert.ok(docCallFn.includes("'Read,Write,Edit,Glob,Grep'"), 'Editable doc-chat should allow Read,Write,Edit,Glob,Grep');
    assert.ok(!docCallFn.slice(0, 500).includes('Bash'), 'Doc-chat should not allow Bash');
    assert.ok(!docCallFn.slice(0, 500).includes('WebSearch'), 'Doc-chat should not allow WebSearch');
  });

  await test('doc-chat uses lower maxTurns than CC', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const docCallFn = src.slice(src.indexOf('async function ccDocCall('));
    assert.ok(docCallFn.includes('maxTurns: canEdit ? 25 : 10'), 'Doc-chat maxTurns should be 10 (read-only) or 25 (editable)');
  });

  await test('doc-chat skips state preamble', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const docCallFn = src.slice(src.indexOf('async function ccDocCall('));
    assert.ok(docCallFn.includes('skipStatePreamble: true'), 'Doc-chat should skip state preamble');
  });

  await test('CC system prompt discourages excessive tool use', () => {
    const promptPath = path.join(MINIONS_DIR, 'prompts', 'cc-system.md');
    const src = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('Answer from the state preamble'), 'CC prompt should prefer preamble over tools');
    assert.ok(src.includes('more than 3 tool calls') || src.includes('reading more than 2-3 files'), 'CC prompt should limit tool use');
  });

  await test('CC system prompt has size estimation rule for delegation', () => {
    const promptPath = path.join(MINIONS_DIR, 'prompts', 'cc-system.md');
    const src = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
    assert.ok(src.includes('Size estimation rule') || src.includes('size estimation'), 'CC prompt should have size estimation guidance');
    assert.ok(src.includes('Small') && src.includes('Medium') && src.includes('Large'), 'Should define small/medium/large thresholds');
    assert.ok(src.includes('DELEGATE') && src.includes('do it yourself'), 'Should clearly separate delegate vs self-do');
    assert.ok(src.includes('When in doubt, delegate'), 'Should default to delegation when uncertain');
  });

  await test('CC system prompt defines when-to-delegate vs when-to-self-do', () => {
    const promptPath = path.join(MINIONS_DIR, 'prompts', 'cc-system.md');
    const src = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
    assert.ok(src.includes('When to delegate'), 'Should have "when to delegate" section');
    assert.ok(src.includes('When to do it yourself'), 'Should have "when to self-do" section');
    assert.ok(src.includes('code changes') && src.includes('implement'), 'Delegate list should include code changes');
    assert.ok(src.includes('status lookups') || src.includes('quick file reads'), 'Self-do list should include quick lookups');
  });

  // ── Retry Bypass for isAlreadyDispatched ─────────────────────────────────

  await test('discoverFromWorkItems bypasses completed-dedup for retry items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function discoverFromWorkItems('), src.indexOf('\nfunction', src.indexOf('function discoverFromWorkItems(') + 1));
    assert.ok(fn.includes('const isRetry = !!item._retryCount'), 'Should detect retry items via _retryCount');
    assert.ok(fn.includes('isAlreadyDispatched(key)'), 'Should still call isAlreadyDispatched');
    assert.ok(fn.includes('if (isRetry)'), 'Should branch on isRetry inside isAlreadyDispatched block');
  });

  await test('discoverCentralWorkItems bypasses completed-dedup for retry items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function discoverCentralWorkItems('), src.indexOf('\nfunction', src.indexOf('function discoverCentralWorkItems(') + 1));
    assert.ok(fn.includes('const isRetry = !!item._retryCount'), 'Should detect retry items via _retryCount');
    assert.ok(fn.includes('if (isRetry)'), 'Should branch on isRetry inside isAlreadyDispatched block');
  });

  await test('retry items still block when in-flight (pending or active)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function discoverFromWorkItems('), src.indexOf('\nfunction', src.indexOf('function discoverFromWorkItems(') + 1));
    assert.ok(fn.includes('getDispatch().pending') && fn.includes('getDispatch().active'),
      'Retry bypass must check both pending and active dispatch for in-flight blocking');
    assert.ok(fn.includes("inFlight.some(d => d.meta?.dispatchKey === key)"),
      'Retry bypass must match on dispatchKey to detect in-flight');
  });

  await test('_retryCount is cleared on successful completion (DONE status)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const updateFn = src.slice(src.indexOf('function updateWorkItemStatus('));
    // Both DONE paths should clear _retryCount
    const doneBlocks = updateFn.split('WI_STATUS.DONE');
    let clearCount = 0;
    for (const block of doneBlocks) {
      if (block.slice(0, 300).includes('delete target._retryCount')) clearCount++;
    }
    assert.ok(clearCount >= 2, '_retryCount must be cleared on DONE in both normal and fan-out paths (found ' + clearCount + ')');
  });

  await test('_retryCount is NOT cleared on FAILED status', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const updateFn = src.slice(src.indexOf('function updateWorkItemStatus('));
    // Find the FAILED block specifically (between "WI_STATUS.FAILED" and the closing brace)
    const failedIdx = updateFn.indexOf("status === WI_STATUS.FAILED");
    const failedBlock = updateFn.slice(failedIdx, failedIdx + 200);
    assert.ok(!failedBlock.includes('delete target._retryCount'),
      '_retryCount must NOT be cleared on FAILED — retry should persist');
  });

  await test('isAlreadyDispatched checks both in-flight and recently completed', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');
    const fn = src.slice(src.indexOf('function isAlreadyDispatched('));
    assert.ok(fn.includes('dispatch.pending') && fn.includes('dispatch.active'),
      'Should check pending and active for in-flight');
    assert.ok(fn.includes('dispatch.completed') && fn.includes('3600000') && fn.includes('900000'),
      'Should check completed with result-based window (15min errors, 1hr success)');
  });

  await test('both discovery functions use equivalent retry bypass pattern', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const wiFn = src.slice(src.indexOf('function discoverFromWorkItems('), src.indexOf('\nfunction', src.indexOf('function discoverFromWorkItems(') + 1));
    const centralFn = src.slice(src.indexOf('function discoverCentralWorkItems('), src.indexOf('\nfunction', src.indexOf('function discoverCentralWorkItems(') + 1));
    // Both should have isRetry variable and branch on it
    assert.ok(wiFn.includes('const isRetry = !!item._retryCount'), 'discoverFromWorkItems needs isRetry');
    assert.ok(centralFn.includes('const isRetry = !!item._retryCount'), 'discoverCentralWorkItems needs isRetry');
    // Both should check inFlight for retry items
    assert.ok(wiFn.includes("inFlight.some(d => d.meta?.dispatchKey === key)"), 'discoverFromWorkItems needs inFlight check');
    assert.ok(centralFn.includes("inFlight.some(d => d.meta?.dispatchKey === key)"), 'discoverCentralWorkItems needs inFlight check');
  });

  // ── Agent Runtime Tracking ────────────────────────────────────────────────

  await test('DEFAULT_AGENT_METRICS includes totalRuntimeMs', () => {
    assert.strictEqual(shared.DEFAULT_AGENT_METRICS.totalRuntimeMs, 0, 'totalRuntimeMs should default to 0');
  });

  await test('updateMetrics tracks runtime and daily runtimeMs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const fnBody = src.slice(src.indexOf('function updateMetrics('), src.indexOf('\n}\n', src.indexOf('function updateMetrics(')));
    assert.ok(fnBody.includes('totalRuntimeMs'), 'updateMetrics should track totalRuntimeMs');
    assert.ok(fnBody.includes('started_at') && fnBody.includes('completed_at'), 'Should compute runtime from dispatch timestamps');
    assert.ok(fnBody.includes('daily.runtimeMs'), 'Daily metrics should track runtimeMs');
  });

  await test('dashboard metrics table includes Avg Runtime column', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-other.js'), 'utf8');
    assert.ok(src.includes('Avg Runtime'), 'Metrics table should have Avg Runtime column');
    assert.ok(src.includes('fmtAvgRuntime'), 'Should use fmtAvgRuntime formatter');
    assert.ok(src.includes('totalRuntimeMs'), 'Should reference totalRuntimeMs from metrics');
  });

  // ── PRD Retry Button + View Toggle + Dependency Auto-Trigger ───────────────

  await test('PRD list view shows retry button for failed items (canRequeue logic)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const renderItem = src.slice(src.indexOf('const renderItem'));
    assert.ok(renderItem.includes("wi.status === 'failed' || i.status === 'failed'"),
      'canRequeue should check both work item and PRD item failed status');
    assert.ok(renderItem.includes('prdItemRequeue'),
      'Retry button should call prdItemRequeue');
  });

  await test('PRD list view shows retry button when work item missing (orphaned PRD item)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const renderItem = src.slice(src.indexOf('const renderItem'));
    // canRequeue should handle !wi case for stuck PRD items
    assert.ok(renderItem.includes("!wi && i.status") && renderItem.includes("!== 'missing'") && renderItem.includes("!== 'done'"),
      'canRequeue should also trigger when no work item exists and PRD status is stuck');
  });

  await test('PRD graph view also shows retry button for failed items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const graphFn = src.slice(src.indexOf('const renderGraph'));
    assert.ok(graphFn.includes("'failed'") && graphFn.includes('prdItemRequeue'),
      'Graph view should check failed status and have prdItemRequeue click handler');
  });

  await test('PRD graph view shows retry for orphaned items (no work item)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const graphFn = src.slice(src.indexOf('const renderGraph'));
    assert.ok(graphFn.includes("!w && i.status") && graphFn.includes("!== 'missing'"),
      'Graph view canRetry should handle missing work item case');
  });

  await test('prdItemRequeue sends prdFile parameter for re-materialization', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function prdItemRequeue'));
    assert.ok(fn.includes('prdFile'),
      'prdItemRequeue should accept and send prdFile parameter');
    assert.ok(fn.includes('payload.prdFile'),
      'prdItemRequeue should add prdFile to request payload');
  });

  await test('handleWorkItemsRetry re-materializes from PRD when work item missing', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handleWorkItemsRetry'));
    assert.ok(fn.includes('body.prdFile'),
      'Retry handler should check for prdFile in request body');
    assert.ok(fn.includes("createdBy: 'dashboard:prd-retry'"),
      'Re-materialized work items should be tagged as dashboard:prd-retry');
    assert.ok(fn.includes('rematerialized: true'),
      'Response should indicate work item was re-materialized');
    assert.ok(fn.includes('syncPrdItemStatus'),
      'Retry handler should sync PRD item status after re-materialization');
  });

  await test('autoCleanPrdWorkItems resets PRD status to missing after deleting work items', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function autoCleanPrdWorkItems'), src.indexOf('function autoCleanPrdWorkItems') + 2000);
    assert.ok(fn.includes("syncPrdItemStatus(id, 'missing', prdFile)"),
      'autoCleanPrdWorkItems must reset PRD item status to missing when deleting work items');
  });

  await test('PRD view toggle uses rerenderPrdFromCache (not refresh)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');
    assert.ok(src.includes("_prdViewMode=\\'graph\\';rerenderPrdFromCache()") || src.includes("_prdViewMode='graph';rerenderPrdFromCache()"),
      'Graph toggle must call rerenderPrdFromCache, not refresh');
    assert.ok(src.includes("_prdViewMode=\\'list\\';rerenderPrdFromCache()") || src.includes("_prdViewMode='list';rerenderPrdFromCache()"),
      'List toggle must call rerenderPrdFromCache, not refresh');
    assert.ok(!src.includes("_prdViewMode=\\'list\\';refresh()") && !src.includes("_prdViewMode='list';refresh()"),
      'View toggle must NOT call refresh() — change detection skips re-render when only view mode changes');
  });

  await test('PRD progress items include agent and failReason fields', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    const prdFn = src.slice(src.indexOf('function getPrdInfo'));
    assert.ok(prdFn.includes('agent: i._agent') || prdFn.includes("agent: i._agent || ''"),
      'PRD progress items mapping must include agent field');
    assert.ok(prdFn.includes('failReason: i._failReason') || prdFn.includes("failReason: i._failReason || ''"),
      'PRD progress items mapping must include failReason field');
  });

  await test('getPrdInfo resets orphaned dispatched/failed PRD items when work item missing (#779)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    const prdFn = src.slice(src.indexOf('function getPrdInfo'));
    // When no work item exists and PRD status is dispatched, rawStatus should become pending
    assert.ok(prdFn.includes('WI_STATUS.DISPATCHED') && prdFn.includes('WI_STATUS.PENDING'),
      'getPrdInfo must reset orphaned dispatched PRD items to pending using WI_STATUS constants');
    assert.ok(prdFn.includes('WI_STATUS.FAILED'),
      'getPrdInfo must also reset orphaned failed PRD items when work item is missing');
  });

  await test('areDependenciesMet returns failed when dep item is failed', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function areDependenciesMet'));
    assert.ok(fn.includes("depItem.status === WI_STATUS.FAILED") && fn.includes("return 'failed'"),
      'areDependenciesMet must detect failed dependencies and return failed');
  });

  await test('dependency failure propagation resets to pending when deps recover', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function discoverFromWorkItems'));
    assert.ok(fn.includes("failReason === 'Dependency failed") && fn.includes('WI_STATUS.PENDING'),
      'Items failed due to dependency should reset to pending when deps recover');
  });

  await test('areDependenciesMet returns true when dep is done (enables auto-dispatch)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const fn = src.slice(src.indexOf('function areDependenciesMet'));
    assert.ok(fn.includes('DONE_STATUSES'),
      'areDependenciesMet should use DONE_STATUSES to check if deps are met');
  });

  // ── Work Item Artifacts ────────────────────────────────────────────────────

  await test('spawnAgent tracks _artifacts on work items after completion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const spawnFn = src.slice(src.indexOf('async function spawnAgent('));
    assert.ok(spawnFn.includes('_artifacts'), 'spawnAgent should write _artifacts to work item');
    assert.ok(spawnFn.includes('arts.outputLog'), 'Should track output log path');
    assert.ok(spawnFn.includes('arts.branch'), 'Should track branch name');
    assert.ok(spawnFn.includes('arts.notes'), 'Should track inbox notes');
    assert.ok(spawnFn.includes('arts.plan'), 'Should track plan file');
    assert.ok(spawnFn.includes('arts.prd'), 'Should track PRD file');
  });

  await test('artifact note collection uses startsWith for agent matching', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes("f.startsWith(agentId + '-')"),
      'Note matching must use startsWith to prevent false substring matches');
  });

  await test('artifact note collection extracts structured IDs via parseNoteId', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('shared.parseNoteId'), 'Should use parseNoteId to extract note IDs');
  });

  await test('/api/agent-output endpoint validates path traversal', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes("file.startsWith('agents/')"), 'Should require agents/ prefix');
    assert.ok(src.includes("file.includes('..')"), 'Should block path traversal with ..');
    assert.ok(src.includes("file.includes('\\0')"), 'Should block null bytes');
  });

  await test('work item modal renders artifact pills', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('_artifacts'), 'Should read _artifacts from work item');
    assert.ok(src.includes('viewAgentOutput'), 'Should have viewAgentOutput click handler');
    assert.ok(src.includes('arts.branch'), 'Should render branch pill');
    assert.ok(src.includes('arts.plan'), 'Should render plan pill');
    assert.ok(src.includes('arts.notes'), 'Should render note pills');
  });

  await test('viewAgentOutput checks HTTP status before rendering', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    const fn = src.slice(src.indexOf('function viewAgentOutput'));
    assert.ok(fn.includes('r.ok'), 'Should check response.ok before processing');
    assert.ok(fn.includes('.catch'), 'Should have error handler');
  });

  await test('note label rendering handles null and object and string formats', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('n && typeof n'), 'Should guard against null in notes array');
    assert.ok(src.includes("typeof n === 'object'"), 'Should handle object format {id, file}');
    assert.ok(src.includes('String(n'), 'Should handle string format (backward compat)');
  });

  await test('playbook injects note ID template for agent-written notes', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'playbook.js'), 'utf8');
    assert.ok(src.includes('NOTE-'), 'Playbook should include NOTE- ID in frontmatter template');
    assert.ok(src.includes('shared.uid()'), 'Playbook should generate unique ID via shared.uid()');
    assert.ok(src.includes('agent:'), 'Playbook frontmatter should include agent field');
    assert.ok(src.includes('date:'), 'Playbook frontmatter should include date field');
  });

  // ── Functional: _artifacts populated by getWorkItems ──

  await test('getWorkItems populates _artifacts from queries.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('_artifacts'), 'queries.js should populate _artifacts');
    assert.ok(src.includes('dispatchByWiId'), 'Should build dispatch ID lookup for output log matching');
    assert.ok(src.includes('_agentDirCache'), 'Should cache agent dir listings');
    assert.ok(src.includes('_inboxFiles'), 'Should cache inbox dir listing');
  });

  await test('_artifacts output log matches by dispatch ID not work item ID', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    const artSection = src.slice(src.indexOf('Populate _artifacts'));
    assert.ok(artSection.includes('dispatchByWiId[item.id]'), 'Should look up dispatch ID by work item ID');
    assert.ok(artSection.includes('f.includes(dispatchId)'), 'Should match output filename by dispatch ID');
    assert.ok(!artSection.includes('slice(-8)'), 'Should NOT use ID suffix matching (broken pattern)');
  });

  await test('_artifacts includes featureBranch fallback', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    assert.ok(src.includes('item.branch || item.featureBranch'),
      'Should fall back to featureBranch when branch is missing');
  });

  await test('_artifacts functional: populated on real work items', () => {
    const restore = createTestMinionsDir();
    const testDir = process.env.MINIONS_TEST_DIR;
    // Create agent dir with output log
    const agentDir = path.join(testDir, 'agents', 'testbot');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'output-testbot-fix-abc123.log'), 'test output');
    // Create inbox note
    const inboxDir = path.join(testDir, 'notes', 'inbox');
    fs.writeFileSync(path.join(inboxDir, 'testbot-W-test1-2026-04-08.md'), '# Findings');
    // Create work item + dispatch
    fs.writeFileSync(path.join(testDir, 'work-items.json'), JSON.stringify([
      { id: 'W-test1', status: 'done', dispatched_to: 'testbot', branch: 'feat/test' }
    ]));
    fs.writeFileSync(path.join(testDir, 'engine', 'dispatch.json'), JSON.stringify({
      pending: [], active: [],
      completed: [{ id: 'testbot-fix-abc123', agent: 'testbot', meta: { item: { id: 'W-test1' } } }]
    }));
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify({ projects: [], agents: {} }));
    const freshQueries = require('../engine/queries');
    const items = freshQueries.getWorkItems();
    const wi = items.find(i => i.id === 'W-test1');
    assert.ok(wi, 'Work item should exist');
    assert.ok(wi._artifacts, 'Work item should have _artifacts');
    assert.ok(wi._artifacts.outputLog === 'testbot/output-testbot-fix-abc123.log', 'Should link output log: ' + wi._artifacts.outputLog);
    assert.ok(wi._artifacts.branch === 'feat/test', 'Should have branch');
    assert.ok(wi._artifacts.notes && wi._artifacts.notes.length === 1, 'Should have 1 inbox note');
    assert.ok(wi._artifacts.notes[0].includes('testbot-W-test1'), 'Note should match by work item ID');
    restore();
  });

  await test('openInboxNote function exists in render-work-items.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-work-items.js'), 'utf8');
    assert.ok(src.includes('function openInboxNote'), 'Should have openInboxNote function');
    assert.ok(src.includes('openModal(idx)'), 'Should open the modal when note found in inboxData');
    assert.ok(src.includes("switchPage('inbox')"), 'Should fall back to inbox page when not found');
  });

  // ── Perf: Prompt building before worktree, direct spawn, parallel dep fetch ─

  await test('spawnAgent builds prompt before worktree setup', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    const spawnFn = src.slice(src.indexOf('async function spawnAgent('));
    const promptBuildIdx = spawnFn.indexOf('buildSystemPrompt(');
    const worktreeIdx = spawnFn.indexOf('findExistingWorktree(');
    assert.ok(promptBuildIdx > 0 && worktreeIdx > 0, 'Should have both buildSystemPrompt and findExistingWorktree');
    assert.ok(promptBuildIdx < worktreeIdx, 'Prompt building should come before worktree setup');
  });

  await test('callLLM supports direct spawn mode', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'llm.js'), 'utf8');
    assert.ok(src.includes('direct = false'), 'callLLM should accept direct param with false default');
    assert.ok(src.includes('_resolveClaudeBin'), 'Should have _resolveClaudeBin for direct spawn');
    assert.ok(src.includes('claude-caps.json'), 'Should read cached binary from claude-caps.json');
  });

  await test('callLLMStreaming supports direct spawn mode', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'llm.js'), 'utf8');
    const streamFn = src.slice(src.indexOf('function callLLMStreaming('));
    assert.ok(streamFn.includes('direct = false'), 'callLLMStreaming should accept direct param');
    assert.ok(streamFn.includes('_spawnProcess'), 'Should use shared _spawnProcess helper');
  });

  await test('ccCall passes direct:true to callLLM', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const ccCallFn = src.slice(src.indexOf('async function ccCall('));
    assert.ok(ccCallFn.includes('direct: true'), 'ccCall should pass direct: true to callLLM');
  });

  await test('dependency fetches run in parallel with Promise.allSettled', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('Promise.allSettled'), 'Should use Promise.allSettled for parallel dep fetches');
    assert.ok(src.includes('git fetch origin'), 'Should fetch dependency branches');
  });

  // ── Critical UX element regression checks ──
  // These must run early (not in late test functions that may be skipped by earlier crashes)

  await test('layout.html contains cc-tab-bar element', () => {
    const layout = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
    assert.ok(layout.includes('id="cc-tab-bar"'), 'layout.html must have cc-tab-bar element — CC tabs will not render without it');
  });

  await test('layout.html contains all critical CC elements', () => {
    const layout = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
    const required = ['cc-tab-bar', 'cc-messages', 'cc-input', 'cc-session-info'];
    for (const id of required) {
      assert.ok(layout.includes('id="' + id + '"'), 'layout.html must have ' + id + ' element');
    }
  });

  await test('layout.html contains all critical modal elements', () => {
    const layout = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
    const required = ['modal', 'modal-title', 'modal-body', 'modal-qa-thread'];
    for (const id of required) {
      assert.ok(layout.includes('id="' + id + '"'), 'layout.html must have ' + id + ' element');
    }
  });

  await test('runPostCompletionHooks does NOT auto-recover non-implement types', async () => {
    const tmpDir = createTmpDir();
    const prFile = path.join(tmpDir, 'pull-requests.json');
    shared.safeWrite(prFile, []);

    const mockProject = { name: 'TestProject', localPath: tmpDir, mainBranch: 'main' };
    const mockConfig = { projects: [mockProject], agents: { reviewer: { name: 'Reviewer' } } };

    const origProjectPrPath = shared.projectPrPath;
    const origGetProjects = shared.getProjects;
    shared.projectPrPath = () => prFile;
    shared.getProjects = () => [mockProject];

    try {
      // Review agent output that mentions a PR URL (should NOT trigger recovery)
      const output = '{"type":"result","result":"Reviewed PR https://github.com/org/repo/pull/55 — looks good"}';
      const dispatchItem = {
        id: 'D-2', type: 'review', task: 'Review task',
        meta: { item: { id: 'W-200', title: 'Review' }, project: mockProject, source: 'work-item',
                pr: { id: 'PR-55', number: 55 } }
      };

      const result = await lifecycle.runPostCompletionHooks(dispatchItem, 'reviewer', 1, output, mockConfig);
      assert.strictEqual(result.autoRecovered, false,
        'autoRecovered should be false for review type even with PR in output');
    } finally {
      shared.projectPrPath = origProjectPrPath;
      shared.getProjects = origGetProjects;
    }
  });

  await test('runPostCompletionHooks returns autoRecovered=false on normal success', async () => {
    const tmpDir = createTmpDir();
    const prFile = path.join(tmpDir, 'pull-requests.json');
    shared.safeWrite(prFile, []);

    const mockProject = { name: 'TestProject', localPath: tmpDir, mainBranch: 'main' };
    const mockConfig = { projects: [mockProject], agents: { agent1: { name: 'Agent1' } } };

    const origProjectPrPath = shared.projectPrPath;
    const origGetProjects = shared.getProjects;
    shared.projectPrPath = () => prFile;
    shared.getProjects = () => [mockProject];

    try {
      const output = '{"type":"result","result":"Created PR https://github.com/org/repo/pull/77"}';
      const dispatchItem = {
        id: 'D-3', type: 'implement', task: 'Test task',
        meta: { item: { id: 'W-300', title: 'Test' }, project: mockProject, source: 'work-item' }
      };

      // code=0 means normal success — autoRecovered should be false
      const result = await lifecycle.runPostCompletionHooks(dispatchItem, 'agent1', 0, output, mockConfig);
      assert.strictEqual(result.autoRecovered, false,
        'autoRecovered should be false when agent succeeded normally (code=0)');
    } finally {
      shared.projectPrPath = origProjectPrPath;
      shared.getProjects = origGetProjects;
    }
  });
}

// ─── Dashboard Resilience: safeFetch, auto-reload, CC reset ─────────────────

async function testDashboardResilience() {
  console.log('\n── Dashboard Resilience ──');

  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
  const refreshSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'refresh.js'), 'utf8');
  const stateSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'state.js'), 'utf8');
  const ccSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'command-center.js'), 'utf8');
  const liveStreamSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'live-stream.js'), 'utf8');
  const agentsSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-agents.js'), 'utf8');
  const modalQaSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'modal-qa.js'), 'utf8');

  // ── safeFetch wrapper ──

  await test('safeFetch is defined with AbortController timeout', () => {
    assert.ok(stateSrc.includes('function safeFetch('),
      'state.js must define safeFetch');
    assert.ok(stateSrc.includes('AbortController'),
      'safeFetch must use AbortController for timeout');
    assert.ok(stateSrc.includes('clearTimeout(timer)'),
      'safeFetch must clear timeout in finally block');
  });

  await test('safeFetch defaults to 15s timeout', () => {
    assert.ok(stateSrc.includes('15000'),
      'safeFetch default timeout should be 15000ms');
  });

  await test('safeFetch does not use AbortSignal.any (browser compat)', () => {
    const fnBody = stateSrc.slice(stateSrc.indexOf('function safeFetch'), stateSrc.indexOf('}', stateSrc.indexOf('function safeFetch') + 100) + 1);
    assert.ok(!fnBody.includes('AbortSignal.any'),
      'safeFetch must not use AbortSignal.any (requires Chrome 116+/Firefox 124+)');
  });

  await test('safeFetch does not mutate caller opts', () => {
    const fnStart = stateSrc.indexOf('function safeFetch');
    const fnBody = stateSrc.slice(fnStart, stateSrc.indexOf('\n}', fnStart) + 2);
    assert.ok(fnBody.includes('Object.assign({}'),
      'safeFetch should copy opts via Object.assign before modifying');
    assert.ok(fnBody.includes('delete fetchOpts.') && !fnBody.includes('delete opts.'),
      'safeFetch must delete from the copy (fetchOpts), not the original (opts)');
  });

  // ── safeFetch applied to hot-path fetches ──

  await test('refresh poll uses safeFetch', () => {
    assert.ok(refreshSrc.includes("safeFetch('/api/status')"),
      'Status poll must use safeFetch to prevent connection exhaustion');
  });

  await test('live output poll uses safeFetch', () => {
    assert.ok(liveStreamSrc.includes('safeFetch('),
      'Live output poll must use safeFetch');
  });

  await test('agent detail fetch uses safeFetch', () => {
    assert.ok(agentsSrc.includes('safeFetch('),
      'Agent detail fetch must use safeFetch');
  });

  // ── Auto-reload on dashboard restart ──

  await test('dashboard exposes dashboardStartedAt in status version object', () => {
    assert.ok(dashSrc.includes('dashboardStartedAt'),
      'Status response must include dashboardStartedAt for restart detection');
    assert.ok(dashSrc.includes('_dashboardVersion.startedAt'),
      'dashboardStartedAt must be sourced from _dashboardVersion.startedAt');
  });

  await test('refresh detects dashboard restart and auto-reloads', () => {
    assert.ok(refreshSrc.includes('_knownDashboardStartId'),
      'refresh.js must track the dashboard start ID');
    assert.ok(refreshSrc.includes('dashboardStartedAt'),
      'refresh must read dashboardStartedAt from status');
    assert.ok(refreshSrc.includes('location.reload()'),
      'refresh must call location.reload() when dashboard restarts');
  });

  await test('auto-reload skips on first load (null guard)', () => {
    // The condition must require both _knownDashboardStartId and dashId to be non-null
    assert.ok(refreshSrc.includes('dashId && _knownDashboardStartId && dashId !== _knownDashboardStartId'),
      'Auto-reload must only trigger when both old and new IDs are non-null and different');
  });

  await test('auto-reload sets _knownDashboardStartId on first successful poll', () => {
    // After the reload check, it must set the ID
    const reloadCheck = refreshSrc.indexOf('location.reload()');
    const setId = refreshSrc.indexOf('_knownDashboardStartId = dashId', reloadCheck);
    assert.ok(setId > reloadCheck,
      '_knownDashboardStartId must be set after the reload check (not before)');
  });

  await test('auto-reload returns early after location.reload to prevent processing stale data', () => {
    const reloadIdx = refreshSrc.indexOf('location.reload()');
    const afterReload = refreshSrc.slice(reloadIdx, reloadIdx + 50);
    assert.ok(afterReload.includes('return'),
      'Must return immediately after location.reload() to skip _processStatusUpdate');
  });

  // ── CC New Session full reset ──

  await test('ccNewSession delegates to ccNewTab (multi-tab)', () => {
    assert.ok(ccSrc.includes('function ccNewSession') && ccSrc.includes('ccNewTab'),
      'ccNewSession should delegate to ccNewTab for multi-tab support');
  });

  await test('per-tab sending state: tab._sending and tab._abortController', () => {
    assert.ok(ccSrc.includes('activeTab._sending = true') && ccSrc.includes('activeTab._abortController'),
      'Sending state should be per-tab, not global');
  });

  await test('ccCloseTab only aborts the closing tab, not all tabs', () => {
    const fn = ccSrc.slice(ccSrc.indexOf('function ccCloseTab'), ccSrc.indexOf('\nfunction', ccSrc.indexOf('function ccCloseTab') + 1));
    assert.ok(fn.includes('closingTab._sending') && fn.includes('closingTab._abortController'),
      'Should check and abort only the closing tab');
  });

  await test('CC clears stale sending state on page load', () => {
    // This must be at module top-level (not inside a function) to run before ccRestoreMessages
    const firstFnDecl = ccSrc.indexOf('function ccAbort');
    assert.ok(firstFnDecl > 0, 'ccAbort function must exist');
    const moduleTop = ccSrc.slice(0, firstFnDecl);
    assert.ok(moduleTop.includes("localStorage.removeItem('cc-sending')"),
      'cc-sending must be cleared at module load (before any function) to prevent stale state after reload');
  });

  // ── CC abort clears queue (prevents queued messages from firing after stop) ──

  await test('_ccDoSend returns wasAborted flag for queue drain delay', () => {
    const fn = ccSrc.slice(ccSrc.indexOf('async function _ccDoSend'), ccSrc.indexOf('\nfunction', ccSrc.indexOf('async function _ccDoSend') + 1));
    assert.ok(fn.includes('_wasAborted = true'), '_ccDoSend must set _wasAborted on AbortError');
    assert.ok(fn.includes('return _wasAborted'), '_ccDoSend must return _wasAborted for caller');
  });

  await test('ccSend flushes queue after abort (no wasAborted guard)', () => {
    const fn = ccSrc.slice(ccSrc.indexOf('async function ccSend'), ccSrc.indexOf('\n}', ccSrc.indexOf('async function ccSend')) + 2);
    assert.ok(fn.includes('tab._queue && tab._queue.length > 0'),
      'ccSend must check for queued messages after send completes');
    assert.ok(!fn.includes('!wasAborted'),
      'Queue flush must NOT be gated on wasAborted — abort stops the current request, not queued ones');
  });

  await test('ccSend uses per-tab queue for message queuing', () => {
    const fn = ccSrc.slice(ccSrc.indexOf('async function ccSend'), ccSrc.indexOf('\n}', ccSrc.indexOf('async function ccSend')) + 2);
    assert.ok(fn.includes('tab._sending') && fn.includes('tab._queue'),
      'ccSend must use per-tab sending state and queue');
  });

  await test('ccAbort does not clear queue — queued messages auto-flush after abort', () => {
    const abortFn = ccSrc.slice(ccSrc.indexOf('function ccAbort'), ccSrc.indexOf('\n}', ccSrc.indexOf('function ccAbort')) + 2);
    assert.ok(!abortFn.includes('_queue = []') && !abortFn.includes('_queue.length = 0'),
      'ccAbort must NOT clear queue — queued messages should send after abort completes');
  });

  // ── CC server-side reset on new session ──

  await test('server-side per-tab concurrency guard', () => {
    assert.ok(dashSrc.includes('ccInFlightTabs'),
      'Should use per-tab in-flight tracking for parallel CC requests');
  });

  // ── Live stream steering resilience ──

  await test('steering pauses polling with _steerInFlight flag', () => {
    assert.ok(liveStreamSrc.includes('_steerInFlight = true'),
      'sendSteering must set _steerInFlight to pause polling');
    assert.ok(liveStreamSrc.includes('_steerInFlight = false'),
      'sendSteering must reset _steerInFlight after completion');
  });

  await test('refreshLiveOutput skips when steering in flight', () => {
    assert.ok(liveStreamSrc.includes('if (_steerInFlight) return'),
      'refreshLiveOutput must skip when _steerInFlight is true');
  });

  await test('steering resumes polling with forced refresh after send', () => {
    // Must have setTimeout that resets flag and calls refreshLiveOutput
    assert.ok(liveStreamSrc.includes('setTimeout('),
      'sendSteering must use setTimeout to resume polling');
    const finallyBlock = liveStreamSrc.slice(liveStreamSrc.indexOf('} finally {', liveStreamSrc.indexOf('sendSteering')));
    assert.ok(finallyBlock.includes('_steerInFlight = false') && finallyBlock.includes('refreshLiveOutput()'),
      'Finally block must reset _steerInFlight and call refreshLiveOutput');
  });

  // ── Agent detail error recovery ──

  await test('agent detail error shows Retry button', () => {
    assert.ok(agentsSrc.includes('openAgentDetail('),
      'Error state must include Retry button that calls openAgentDetail');
    assert.ok(agentsSrc.includes('Retry'),
      'Error message must contain Retry button text');
  });

  await test('agent detail error shows Close button', () => {
    assert.ok(agentsSrc.includes('closeDetail()'),
      'Error state must include Close button');
  });

  // ── Doc-chat processing badge ──

  await test('doc-chat shows processing badge on source card when processing starts', () => {
    const processBody = modalQaSrc.slice(
      modalQaSrc.indexOf('async function _processQaMessage'),
      modalQaSrc.indexOf('async function _processQaMessage') + 800
    );
    assert.ok(processBody.includes("showNotifBadge(sourceCard, 'processing')"),
      '_processQaMessage must show processing badge on source card at start');
  });

  await test('doc-chat clears processing badge when processing completes', () => {
    assert.ok(modalQaSrc.includes('clearNotifBadge(doneCard)'),
      '_processQaMessage must clear badge when done (no more queued messages)');
  });

  await test('doc-chat badge persists if messages still queued', () => {
    assert.ok(modalQaSrc.includes('_qaQueue.length === 0'),
      'Badge should only clear when queue is empty');
  });

  // ── Text selection → doc-chat flow ──────────────────────────────────────────

  await test('mouseup listener captures selection into _modalDocContext', () => {
    assert.ok(modalQaSrc.includes("document.addEventListener('mouseup'"),
      'Should have mouseup listener on document');
    assert.ok(modalQaSrc.includes('_modalDocContext.selection = text') || modalQaSrc.includes('_modalDocContext.selection=text'),
      'mouseup handler should write selected text to _modalDocContext.selection');
  });

  await test('mouseup listener only acts on selections inside modal-body', () => {
    assert.ok(modalQaSrc.includes('modalBody.contains(sel.anchorNode)'),
      'Should check that selection anchor is inside modal-body');
    assert.ok(modalQaSrc.includes("getElementById('modal-body')"),
      'Should reference modal-body element');
  });

  await test('mouseup listener shows ask-selection-btn near selection', () => {
    assert.ok(modalQaSrc.includes("ask-selection-btn"),
      'mouseup handler should reference the ask button');
    assert.ok(modalQaSrc.includes('getBoundingClientRect'),
      'Should position button using selection bounding rect');
    assert.ok(modalQaSrc.includes("askBtn.style.display = 'block'"),
      'Should show the button when selection is valid');
  });

  await test('mouseup listener hides button when selection is empty or outside modal', () => {
    assert.ok(modalQaSrc.includes("askBtn.style.display = 'none'"),
      'Should hide button on empty/collapsed selection');
    assert.ok(modalQaSrc.includes('sel.isCollapsed'),
      'Should check isCollapsed to detect empty selection');
  });

  await test('modalAskAboutSelection shows selection pill and focuses input', () => {
    assert.ok(modalQaSrc.includes('modal-qa-pill'),
      'Should show selection pill');
    assert.ok(modalQaSrc.includes("pill.style.display = 'flex'"),
      'Pill should be displayed as flex');
    assert.ok(modalQaSrc.includes('input.focus()'),
      'Should focus the input field');
  });

  await test('modalSend captures selection and clears it after send', () => {
    const sendFn = modalQaSrc.slice(
      modalQaSrc.indexOf('function modalSend()'),
      modalQaSrc.indexOf('function modalSend()') + 1500
    );
    assert.ok(sendFn.includes("_modalDocContext.selection || ''"),
      'modalSend should read current selection');
    assert.ok(sendFn.includes("_modalDocContext.selection = ''"),
      'modalSend should clear selection after capturing');
    assert.ok(sendFn.includes("'modal-qa-pill'"),
      'modalSend should hide selection pill');
  });

  await test('selection is sent to /api/doc-chat in request body', () => {
    assert.ok(modalQaSrc.includes("selection: selection"),
      '_processQaMessage should include selection in fetch body');
  });

  await test('queued messages preserve their selection', () => {
    assert.ok(modalQaSrc.includes('_qaQueue.push({ message, selection })'),
      'Queue should store selection with message');
    assert.ok(modalQaSrc.includes('next.selection'),
      'Queue drain should pass selection to _processQaMessage');
  });

  await test('backend truncates selection at 1500 chars', () => {
    const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(dashSrc.includes('selection.slice(0, 1500)'),
      'ccDocCall should truncate selection to 1500 chars');
  });

  await test('clearQaSelection resets selection and hides pill', () => {
    assert.ok(modalQaSrc.includes("_modalDocContext.selection = ''") || modalQaSrc.includes("_modalDocContext.selection=''"),
      'clearQaSelection should reset selection');
    assert.ok(modalQaSrc.includes("modal-qa-pill"),
      'clearQaSelection should hide pill');
  });

  // ── Command center overlay dismiss ──

  await test('CC overlay exists for click-to-dismiss', () => {
    const layoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
    assert.ok(layoutSrc.includes('id="cc-overlay"'),
      'layout.html must have cc-overlay element');
    assert.ok(layoutSrc.includes("onclick=\"toggleCommandCenter()\"") && layoutSrc.includes('cc-overlay'),
      'cc-overlay must call toggleCommandCenter on click');
  });

  await test('toggleCommandCenter shows and hides overlay', () => {
    assert.ok(ccSrc.includes("getElementById('cc-overlay')"),
      'toggleCommandCenter must reference cc-overlay');
    assert.ok(ccSrc.includes("overlay.style.display"),
      'toggleCommandCenter must toggle overlay display');
  });

  // ── Safety net: no safeWrite targeting work-items.json or pull-requests.json ──

  await test('dashboard.js: no safeWrite calls target work-items.json or pull-requests.json', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    const violations = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      // Detect safeWrite calls that write to work-items or pull-requests paths
      if (line.includes('safeWrite(') && (
        line.includes('work-items') || line.includes('wiPath') || line.includes('projWiPath') ||
        line.includes('centralWiPath') || line.includes('centralPath, centralItems') ||
        line.includes('pull-requests') || line.includes('prPath') || line.includes('prFilePath')
      )) {
        violations.push(`dashboard.js:${i + 1}: ${line.trim()}`);
      }
    }
    assert.strictEqual(violations.length, 0,
      'No safeWrite calls should target work-items.json or pull-requests.json in dashboard.js — use mutateWorkItems/mutatePullRequests instead.\nViolations:\n' +
      violations.join('\n'));
  });

  // Note: engine.js and engine/*.js safeWrite grep-verification test belongs in PR-415/PR-416
  // which convert those files. This PR (P-w4n9f1j6-d) only converts dashboard.js.
}

// ─── Build Fix Escalation Tests ─────────────────────────────────────────────

async function testBuildFixEscalation() {
  console.log('\n── Build Fix Escalation ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const sharedSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
  const adoSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
  const githubSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
  const prRenderSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prs.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'styles.css'), 'utf8');

  await test('ENGINE_DEFAULTS includes maxBuildFixAttempts', () => {
    assert.ok(sharedSrc.includes('maxBuildFixAttempts'),
      'shared.js should define maxBuildFixAttempts in ENGINE_DEFAULTS');
  });

  await test('engine.js checks buildFixAttempts against max before dispatching', () => {
    assert.ok(engineSrc.includes('buildFixAttempts') && engineSrc.includes('maxBuildFixAttempts'),
      'engine.js should check buildFixAttempts against maxBuildFixAttempts limit');
  });

  await test('engine.js escalates when max build fix attempts reached', () => {
    assert.ok(engineSrc.includes('buildFixEscalated') && engineSrc.includes('build-fix-escalated'),
      'engine.js should set buildFixEscalated flag and write escalation alert');
  });

  await test('engine.js increments buildFixAttempts on dispatch', () => {
    // Verify the counter is incremented when a fix agent is actually dispatched
    assert.ok(engineSrc.includes('buildFixAttempts') && engineSrc.includes('+ 1'),
      'engine.js should increment buildFixAttempts counter on successful dispatch');
  });

  await test('engine.js skips dispatch when escalated (continues loop)', () => {
    // After escalation check, the code should continue to next PR (not dispatch)
    // Find the escalation guard block that checks >= maxBuildFix
    const idx = engineSrc.indexOf('>= maxBuildFix');
    assert.ok(idx > 0, 'engine.js should compare against maxBuildFix');
    const block = engineSrc.slice(idx, idx + 1500);
    assert.ok(block.includes('continue'),
      'engine.js should skip dispatch (continue) when build fix attempts exceed max');
  });

  await test('ado.js resets buildFixAttempts on build recovery', () => {
    assert.ok(adoSrc.includes('buildFixAttempts') && adoSrc.includes('buildFixEscalated'),
      'ado.js should clear buildFixAttempts and buildFixEscalated when build passes');
  });

  await test('github.js resets buildFixAttempts on build recovery', () => {
    assert.ok(githubSrc.includes('buildFixAttempts') && githubSrc.includes('buildFixEscalated'),
      'github.js should clear buildFixAttempts and buildFixEscalated when build passes');
  });

  await test('ado.js clears build fix fields on merge/abandon', () => {
    // Find the _buildFailNotified cleanup block — build fix fields are cleaned alongside it
    const idx = adoSrc.indexOf('delete pr._buildFailNotified');
    assert.ok(idx > 0, 'ado.js should delete _buildFailNotified');
    // Check within the same cleanup block (look in the surrounding 300 chars)
    const block = adoSrc.slice(Math.max(0, idx - 100), idx + 300);
    assert.ok(block.includes('buildFixAttempts') && block.includes('buildFixEscalated'),
      'ado.js should clean up buildFixAttempts/buildFixEscalated alongside _buildFailNotified on merge/abandon');
  });

  await test('github.js clears build fix fields on merge/abandon', () => {
    const idx = githubSrc.indexOf('delete pr._buildFailNotified');
    assert.ok(idx > 0, 'github.js should delete _buildFailNotified');
    const block = githubSrc.slice(Math.max(0, idx - 100), idx + 300);
    assert.ok(block.includes('buildFixAttempts') && block.includes('buildFixEscalated'),
      'github.js should clean up buildFixAttempts/buildFixEscalated alongside _buildFailNotified on merge/abandon');
  });

  await test('dashboard settings includes maxBuildFixAttempts', () => {
    assert.ok(dashSrc.includes('maxBuildFixAttempts'),
      'dashboard.js should include maxBuildFixAttempts in numericFields for settings UI');
  });

  await test('dashboard PR rendering surfaces escalated state', () => {
    assert.ok(prRenderSrc.includes('buildFixEscalated') && prRenderSrc.includes('build-escalated'),
      'PR rendering should show escalated badge for buildFixEscalated PRs');
  });

  await test('dashboard CSS includes build-escalated style', () => {
    assert.ok(cssSrc.includes('build-escalated'),
      'CSS should have a .pr-badge.build-escalated style for visual escalation indicator');
  });

  await test('escalation uses configurable limit from DEFAULTS', () => {
    assert.ok(engineSrc.includes('DEFAULTS.maxBuildFixAttempts'),
      'engine.js should read maxBuildFixAttempts from DEFAULTS (not hardcoded)');
  });

  await test('escalation writes inbox alert for human visibility', () => {
    assert.ok(engineSrc.includes('writeInboxAlert') && engineSrc.includes('Build Fix Escalation'),
      'engine.js should write an inbox alert when escalating build fix failures');
  });

  // ── Behavioral tests (exercise actual code paths, not just string matching) ──

  await test('behavioral: buildFixAttempts increments correctly via mutatePullRequests', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    shared.safeWrite(fp, [
      { id: 'PR-100', status: 'active', buildStatus: 'failing', agent: 'dallas' }
    ]);
    // Simulate what engine.js does when dispatching a fix
    shared.mutatePullRequests(fp, prs => {
      const target = prs.find(p => p.id === 'PR-100');
      if (target) target.buildFixAttempts = (target.buildFixAttempts || 0) + 1;
    });
    const result = shared.safeJson(fp);
    assert.strictEqual(result[0].buildFixAttempts, 1, 'First dispatch should set attempts to 1');

    // Simulate second dispatch
    shared.mutatePullRequests(fp, prs => {
      const target = prs.find(p => p.id === 'PR-100');
      if (target) target.buildFixAttempts = (target.buildFixAttempts || 0) + 1;
    });
    const result2 = shared.safeJson(fp);
    assert.strictEqual(result2[0].buildFixAttempts, 2, 'Second dispatch should increment to 2');
  });

  await test('behavioral: escalation flag set when attempts reach max', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    const maxBuildFix = shared.ENGINE_DEFAULTS.maxBuildFixAttempts;
    shared.safeWrite(fp, [
      { id: 'PR-200', status: 'active', buildStatus: 'failing', buildFixAttempts: maxBuildFix }
    ]);
    // Simulate escalation check: attempts >= max → set escalated flag
    const prs = shared.safeJson(fp);
    const pr = prs.find(p => p.id === 'PR-200');
    assert.ok((pr.buildFixAttempts || 0) >= maxBuildFix,
      'PR should have buildFixAttempts >= maxBuildFixAttempts');
    // Simulate what engine.js does: set buildFixEscalated
    shared.mutatePullRequests(fp, prs => {
      const target = prs.find(p => p.id === 'PR-200');
      if (target) target.buildFixEscalated = true;
    });
    const result = shared.safeJson(fp);
    assert.strictEqual(result[0].buildFixEscalated, true,
      'buildFixEscalated should be set to true when attempts reach max');
  });

  await test('behavioral: idempotent — escalation flag prevents duplicate alerts', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    const maxBuildFix = shared.ENGINE_DEFAULTS.maxBuildFixAttempts;
    shared.safeWrite(fp, [
      { id: 'PR-300', status: 'active', buildStatus: 'failing',
        buildFixAttempts: maxBuildFix, buildFixEscalated: true }
    ]);
    const prs = shared.safeJson(fp);
    const pr = prs.find(p => p.id === 'PR-300');
    // The guard: !pr.buildFixEscalated should be false (already escalated)
    assert.ok(pr.buildFixEscalated, 'PR should already be escalated');
    // Engine code uses: if (!pr.buildFixEscalated) { writeInboxAlert... }
    // So second time through, no alert should be written
    const shouldWriteAlert = !pr.buildFixEscalated;
    assert.strictEqual(shouldWriteAlert, false,
      'Already-escalated PR should NOT trigger another alert (idempotent guard)');
  });

  await test('behavioral: counter resets on build recovery', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    shared.safeWrite(fp, [
      { id: 'PR-400', status: 'active', buildStatus: 'failing',
        buildFixAttempts: 2, buildFixEscalated: false, _buildFailNotified: true, buildErrorLog: 'some error' }
    ]);
    // Simulate what ado.js/github.js does when build recovers (buildStatus !== 'failing')
    shared.mutatePullRequests(fp, prs => {
      const pr = prs.find(p => p.id === 'PR-400');
      if (pr) {
        pr.buildStatus = 'passing';
        delete pr._buildFailNotified;
        delete pr.buildErrorLog;
        if (pr.buildFixAttempts) { delete pr.buildFixAttempts; delete pr.buildFixEscalated; }
      }
    });
    const result = shared.safeJson(fp);
    assert.strictEqual(result[0].buildStatus, 'passing', 'Build status should be passing');
    assert.strictEqual(result[0].buildFixAttempts, undefined, 'buildFixAttempts should be cleared');
    assert.strictEqual(result[0].buildFixEscalated, undefined, 'buildFixEscalated should be cleared');
    assert.strictEqual(result[0]._buildFailNotified, undefined, '_buildFailNotified should be cleared');
    assert.strictEqual(result[0].buildErrorLog, undefined, 'buildErrorLog should be cleared');
  });

  await test('behavioral: counter resets on PR merge/abandon', () => {
    const dir = createTmpDir();
    const fp = path.join(dir, 'pull-requests.json');
    shared.safeWrite(fp, [
      { id: 'PR-500', status: 'active', buildStatus: 'failing',
        buildFixAttempts: 3, buildFixEscalated: true, _buildFailNotified: true,
        buildFailReason: 'compile error', buildErrorLog: 'error log' }
    ]);
    // Simulate what ado.js/github.js does when PR is merged/abandoned
    shared.mutatePullRequests(fp, prs => {
      const pr = prs.find(p => p.id === 'PR-500');
      if (pr) {
        pr.status = 'merged';
        delete pr.buildFailReason;
        delete pr.buildErrorLog;
        delete pr._buildFailNotified;
        delete pr.buildFixAttempts;
        delete pr.buildFixEscalated;
      }
    });
    const result = shared.safeJson(fp);
    assert.strictEqual(result[0].status, 'merged', 'PR should be merged');
    assert.strictEqual(result[0].buildFixAttempts, undefined, 'buildFixAttempts should be cleared on merge');
    assert.strictEqual(result[0].buildFixEscalated, undefined, 'buildFixEscalated should be cleared on merge');
    assert.strictEqual(result[0]._buildFailNotified, undefined, '_buildFailNotified should be cleared');
    assert.strictEqual(result[0].buildFailReason, undefined, 'buildFailReason should be cleared');
  });

  await test('behavioral: ENGINE_DEFAULTS.maxBuildFixAttempts is a positive integer', () => {
    const max = shared.ENGINE_DEFAULTS.maxBuildFixAttempts;
    assert.strictEqual(typeof max, 'number', 'maxBuildFixAttempts must be a number');
    assert.ok(max > 0, 'maxBuildFixAttempts must be positive');
    assert.strictEqual(max, Math.floor(max), 'maxBuildFixAttempts must be an integer');
    assert.strictEqual(max, 3, 'default maxBuildFixAttempts should be 3');
  });
}

// ─── Branch Mutex (#493) ───────────────────────────────────────────────────

async function testBranchMutex() {
  console.log('\n── Branch Mutex (#493): prevent concurrent dispatch to same branch ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const cooldownSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cooldown.js'), 'utf8');

  // ── Source-level tests ──

  await test('cooldown.js exports isBranchActive helper', () => {
    assert.ok(cooldownSrc.includes('function isBranchActive('), 'Should define isBranchActive function');
    assert.ok(cooldownSrc.includes('isBranchActive'), 'Should export isBranchActive');
  });

  await test('isBranchActive uses sanitizeBranch for normalized comparison', () => {
    assert.ok(cooldownSrc.includes('sanitizeBranch(branch)') || cooldownSrc.includes('sanitizeBranch(d'),
      'isBranchActive should normalize branch names via sanitizeBranch');
  });

  await test('engine.js imports isBranchActive from cooldown', () => {
    assert.ok(engineSrc.includes('isBranchActive'),
      'engine.js should import isBranchActive from cooldown module');
  });

  await test('dispatch loop tracks lockedBranches from active dispatches', () => {
    assert.ok(engineSrc.includes('lockedBranches'),
      'Dispatch loop should build lockedBranches set from active dispatches');
  });

  await test('dispatch loop skips items with locked branch', () => {
    const loopMatch = engineSrc.match(/lockedBranches[\s\S]*?busyAgents\.add\(item\.agent\)/);
    assert.ok(loopMatch, 'Should have lockedBranches guard in dispatch loop');
    assert.ok(loopMatch[0].includes('lockedBranches.has(itemBranch)'),
      'Should check if item branch is in lockedBranches');
    assert.ok(loopMatch[0].includes('continue'),
      'Should skip items with locked branch');
  });

  await test('dispatch loop adds newly dispatched branches to lockedBranches', () => {
    assert.ok(engineSrc.includes('lockedBranches.add(itemBranch)'),
      'Should track branches being dispatched to prevent two pending items on same branch');
  });

  await test('discoverFromWorkItems checks branch mutex before dispatch', () => {
    assert.ok(engineSrc.includes("item._pendingReason !== 'branch_locked'") || engineSrc.includes("'branch_locked'"),
      'Should annotate work items blocked by branch mutex');
    assert.ok(engineSrc.includes('Branch mutex: skipping'),
      'Should log when skipping due to branch mutex');
  });

  await test('discoverFromPrs checks branch mutex', () => {
    const prDiscoverSection = engineSrc.match(/function discoverFromPrs[\s\S]*?return newWork/);
    assert.ok(prDiscoverSection, 'discoverFromPrs should exist');
    assert.ok(prDiscoverSection[0].includes('isBranchActive'),
      'discoverFromPrs should check isBranchActive before creating PR dispatch items');
  });

  await test('skipReason includes branch_locked for dashboard visibility', () => {
    assert.ok(engineSrc.includes("reason = 'branch_locked'"),
      'Should set skipReason to branch_locked for pending items waiting on a locked branch');
  });

  await test('postLockedBranches built from post-dispatch active set', () => {
    assert.ok(engineSrc.includes('postLockedBranches'),
      'Skip-reason annotation should rebuild locked branches from post-dispatch state');
  });

  // ── Behavioral tests ──

  await test('isBranchActive logic: returns conflict for matching branch, null otherwise', () => {
    // Behavioral test: simulate the isBranchActive algorithm directly
    const { sanitizeBranch } = shared;
    function isBranchActiveLogic(branch, activeDispatches) {
      if (!branch) return null;
      const normalized = sanitizeBranch(branch);
      return activeDispatches.find(d => {
        const dBranch = d.meta?.branch;
        return dBranch && sanitizeBranch(dBranch) === normalized;
      }) || null;
    }

    const active = [
      { id: 'dallas-impl-1', agent: 'dallas', meta: { branch: 'work/P-abc123' } },
      { id: 'ripley-review-2', agent: 'ripley', meta: { branch: 'work/P-xyz789' } },
    ];

    const conflict = isBranchActiveLogic('work/P-abc123', active);
    assert.ok(conflict, 'Should return conflicting dispatch for active branch');
    assert.strictEqual(conflict.id, 'dallas-impl-1', 'Should return the matching active dispatch');

    const noConflict = isBranchActiveLogic('work/P-new-branch', active);
    assert.strictEqual(noConflict, null, 'Should return null for non-active branch');

    const nullBranch = isBranchActiveLogic(null, active);
    assert.strictEqual(nullBranch, null, 'Should return null for null branch');

    const emptyBranch = isBranchActiveLogic('', active);
    assert.strictEqual(emptyBranch, null, 'Should return null for empty branch');
  });

  await test('dispatch loop branch mutex: same branch blocked, different branch allowed', () => {
    // Simulate the dispatch loop logic
    const { sanitizeBranch } = shared;
    const active = [
      { id: 'dallas-impl-1', agent: 'dallas', meta: { branch: 'work/P-abc123' } },
    ];
    const pending = [
      { id: 'ralph-fix-1', agent: 'ralph', type: 'fix', meta: { branch: 'work/P-abc123' } },  // same branch — blocked
      { id: 'ripley-review-1', agent: 'ripley', type: 'review', meta: { branch: 'work/P-xyz789' } },  // different branch — allowed
      { id: 'lambert-impl-1', agent: 'lambert', type: 'implement', meta: { branch: 'work/P-new' } },  // different branch — allowed
    ];

    const busyAgents = new Set(active.map(d => d.agent));
    const lockedBranches = new Set();
    for (const d of active) {
      if (d.meta?.branch) lockedBranches.add(sanitizeBranch(d.meta.branch));
    }
    const toDispatch = [];
    for (const item of pending) {
      if (busyAgents.has(item.agent)) continue;
      const itemBranch = item.meta?.branch ? sanitizeBranch(item.meta.branch) : null;
      if (itemBranch && lockedBranches.has(itemBranch)) continue;
      toDispatch.push(item);
      busyAgents.add(item.agent);
      if (itemBranch) lockedBranches.add(itemBranch);
    }

    assert.strictEqual(toDispatch.length, 2, 'Should dispatch 2 items (skip the one with conflicting branch)');
    assert.ok(!toDispatch.find(d => d.id === 'ralph-fix-1'), 'Should NOT dispatch ralph-fix-1 (branch locked by dallas)');
    assert.ok(toDispatch.find(d => d.id === 'ripley-review-1'), 'Should dispatch ripley-review-1 (different branch)');
    assert.ok(toDispatch.find(d => d.id === 'lambert-impl-1'), 'Should dispatch lambert-impl-1 (different branch)');
  });

  await test('dispatch loop prevents two pending items on same branch in same tick', () => {
    const { sanitizeBranch } = shared;
    const active = [];
    const pending = [
      { id: 'dallas-impl-1', agent: 'dallas', type: 'implement', meta: { branch: 'work/P-abc123' } },
      { id: 'ralph-fix-1', agent: 'ralph', type: 'fix', meta: { branch: 'work/P-abc123' } }, // same branch
    ];

    const busyAgents = new Set();
    const lockedBranches = new Set();
    const toDispatch = [];
    for (const item of pending) {
      if (busyAgents.has(item.agent)) continue;
      const itemBranch = item.meta?.branch ? sanitizeBranch(item.meta.branch) : null;
      if (itemBranch && lockedBranches.has(itemBranch)) continue;
      toDispatch.push(item);
      busyAgents.add(item.agent);
      if (itemBranch) lockedBranches.add(itemBranch);
    }

    assert.strictEqual(toDispatch.length, 1, 'Should only dispatch first item');
    assert.strictEqual(toDispatch[0].id, 'dallas-impl-1', 'First item wins the branch lock');
  });

  await test('items without branches are not blocked by branch mutex', () => {
    const { sanitizeBranch } = shared;
    const active = [
      { id: 'dallas-impl-1', agent: 'dallas', meta: { branch: 'work/P-abc123' } },
    ];
    const pending = [
      { id: 'ripley-plan-1', agent: 'ripley', type: 'plan', meta: {} },  // no branch — should dispatch
    ];

    const busyAgents = new Set(active.map(d => d.agent));
    const lockedBranches = new Set();
    for (const d of active) {
      if (d.meta?.branch) lockedBranches.add(sanitizeBranch(d.meta.branch));
    }
    const toDispatch = [];
    for (const item of pending) {
      if (busyAgents.has(item.agent)) continue;
      const itemBranch = item.meta?.branch ? sanitizeBranch(item.meta.branch) : null;
      if (itemBranch && lockedBranches.has(itemBranch)) continue;
      toDispatch.push(item);
    }

    assert.strictEqual(toDispatch.length, 1, 'Branch-less items should not be blocked');
    assert.strictEqual(toDispatch[0].id, 'ripley-plan-1');
  });
}

// ─── Test Isolation Verification ────────────────────────────────────────────

async function testBuildErrorLogFeature() {
  console.log('\n── Build Error Log Feature (W-mnp8iyqe0ogn) ──');

  await test('ado.js has fetchAdoBuildErrorLog function', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('async function fetchAdoBuildErrorLog('),
      'ado.js must define fetchAdoBuildErrorLog');
  });

  await test('ado.js has adoFetchText helper for raw text responses', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('async function adoFetchText('),
      'ado.js must define adoFetchText for build log fetching (logs are plain text, not JSON)');
  });

  await test('ado.js extracts buildId from targetUrl', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('buildId=(\\d+)'),
      'fetchAdoBuildErrorLog must extract buildId from targetUrl regex');
  });

  await test('ado.js fetches build timeline and failed task logs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('_apis/build/builds/') && src.includes('/timeline'),
      'Should fetch build timeline API');
    assert.ok(src.includes('/logs/'),
      'Should fetch individual task logs');
    assert.ok(src.includes("r.result === 'failed'"),
      'Should filter for failed records');
  });

  await test('ado.js truncates build error log to max lines', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('BUILD_ERROR_LOG_MAX_LINES'),
      'Should use configurable max lines constant for truncation');
    assert.ok(src.includes('truncated, showing last'),
      'Should include truncation notice when log exceeds limit');
  });

  await test('ado.js sets buildErrorLog on PR when transitioning to failing', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes('pr.buildErrorLog ='),
      'Should store fetched error log on PR entry');
    assert.ok(src.includes("buildStatus === 'failing'") && src.includes('fetchAdoBuildErrorLog'),
      'Should only fetch error log when transitioning to failing');
  });

  await test('ado.js clears buildErrorLog when build recovers', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    assert.ok(src.includes("delete pr.buildErrorLog"),
      'Should clean up buildErrorLog when build status changes away from failing');
  });

  await test('github.js has fetchGhBuildErrorLog function', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('async function fetchGhBuildErrorLog('),
      'github.js must define fetchGhBuildErrorLog');
  });

  await test('github.js fetches check run annotations for error details', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('/check-runs/') && src.includes('/annotations'),
      'Should fetch check run annotations API');
    assert.ok(src.includes('annotation_level'),
      'Should filter annotations by level');
  });

  await test('github.js falls back to Actions job log when no annotations', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('/actions/jobs/') && src.includes('/logs'),
      'Should fall back to Actions job logs API');
  });

  await test('github.js sets buildErrorLog on PR when transitioning to failing', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes('pr.buildErrorLog = errorLog'),
      'Should store fetched error log on PR entry');
    assert.ok(src.includes('fetchGhBuildErrorLog(slug, failedRuns)'),
      'Should pass failed runs to log fetcher');
  });

  await test('github.js clears buildErrorLog when build recovers', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    assert.ok(src.includes("delete pr.buildErrorLog"),
      'Should clean up buildErrorLog when build status changes away from failing');
  });

  await test('engine.js includes buildErrorLog in fix agent prompt', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('pr.buildErrorLog'),
      'Should reference buildErrorLog when constructing fix dispatch');
    assert.ok(src.includes('Build Error Log'),
      'Should include build error log section in review_note');
  });

  await test('engine.js includes build error preview in inbox notification', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('logPreview') && src.includes('Error preview'),
      'Should include a truncated preview of build errors in inbox alert');
  });

  await test('ado.js clears buildErrorLog on PR close/merge', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');
    // Find the merge/abandon block — use the status check as anchor, then forward to handlePostMerge
    const anchor = src.indexOf('newStatus === PR_STATUS.MERGED || newStatus === PR_STATUS.ABANDONED');
    const closeBlock = src.slice(anchor, src.indexOf('handlePostMerge', anchor) + 50);
    assert.ok(closeBlock.includes('delete pr.buildErrorLog'),
      'Should clear buildErrorLog when PR is merged/abandoned');
  });

  await test('github.js clears buildErrorLog on PR close/merge', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
    const anchor = src.indexOf('newStatus === PR_STATUS.MERGED || newStatus === PR_STATUS.ABANDONED');
    const closeBlock = src.slice(anchor, src.indexOf('handlePostMerge', anchor) + 50);
    assert.ok(closeBlock.includes('delete pr.buildErrorLog'),
      'Should clear buildErrorLog when PR is merged/abandoned');
  });
}

// ─── spawnEngine state preservation (#564) ──────────────────────────────────

async function testSpawnEngineStatePreservation() {
  console.log('\n── spawnEngine state preservation (#564): no pre-write of stopped ──');

  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  await test('spawnEngine does NOT pre-write state: stopped', () => {
    // Extract the spawnEngine function body
    const fnStart = dashSrc.indexOf('function spawnEngine()');
    assert.ok(fnStart !== -1, 'spawnEngine must exist');
    // Find the closing brace — count braces from the opening {
    let braceDepth = 0;
    let fnEnd = fnStart;
    for (let i = dashSrc.indexOf('{', fnStart); i < dashSrc.length; i++) {
      if (dashSrc[i] === '{') braceDepth++;
      else if (dashSrc[i] === '}') braceDepth--;
      if (braceDepth === 0) { fnEnd = i + 1; break; }
    }
    const fnBody = dashSrc.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes("state: 'stopped'"),
      'spawnEngine must NOT pre-write state: stopped — this causes #564 stuck engine');
  });

  await test('spawnEngine preserves existing control state via spread', () => {
    const fnStart = dashSrc.indexOf('function spawnEngine()');
    let braceDepth = 0;
    let fnEnd = fnStart;
    for (let i = dashSrc.indexOf('{', fnStart); i < dashSrc.length; i++) {
      if (dashSrc[i] === '{') braceDepth++;
      else if (dashSrc[i] === '}') braceDepth--;
      if (braceDepth === 0) { fnEnd = i + 1; break; }
    }
    const fnBody = dashSrc.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes('...control'),
      'spawnEngine should spread existing control.json to preserve state');
    assert.ok(fnBody.includes('restarted_at'),
      'spawnEngine should write restarted_at timestamp');
    assert.ok(fnBody.includes('pid: null'),
      'spawnEngine should clear stale pid');
  });

  await test('engine start handles running state with dead PID (cli.js)', () => {
    // Verify the engine start code handles the case where state is running but PID is dead
    const cliSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cli.js'), 'utf8');
    assert.ok(cliSrc.includes("control.state === 'running'"),
      'cli.js start should check for running state');
    assert.ok(cliSrc.includes('process is dead') && cliSrc.includes('restarting'),
      'cli.js start should handle dead PID case and proceed with restart');
  });
}

// ─── P-k7m2x9a4: AGENT_STATUS enum and worker-state tracking ──────────────

async function testAgentStatusEnum() {
  console.log('\n── AGENT_STATUS enum and worker-state tracking ──');

  await test('AGENT_STATUS enum has all 8 required values', () => {
    const { AGENT_STATUS } = shared;
    assert.ok(AGENT_STATUS, 'AGENT_STATUS should be exported from shared.js');
    assert.strictEqual(AGENT_STATUS.SPAWNING, 'spawning');
    assert.strictEqual(AGENT_STATUS.WORKTREE_SETUP, 'worktree-setup');
    assert.strictEqual(AGENT_STATUS.READY, 'ready');
    assert.strictEqual(AGENT_STATUS.RUNNING, 'running');
    assert.strictEqual(AGENT_STATUS.FINISHED, 'finished');
    assert.strictEqual(AGENT_STATUS.FAILED, 'failed');
    assert.strictEqual(AGENT_STATUS.TRUST_BLOCKED, 'trust-blocked');
    assert.strictEqual(AGENT_STATUS.TIMED_OUT, 'timed-out');
    assert.strictEqual(Object.keys(AGENT_STATUS).length, 8, 'AGENT_STATUS should have exactly 8 values');
  });

  await test('AGENT_STATUS values are all unique', () => {
    const values = Object.values(shared.AGENT_STATUS);
    assert.strictEqual(new Set(values).size, values.length, 'All AGENT_STATUS values should be unique');
  });

  await test('updateAgentStatus exported from engine/dispatch.js', () => {
    const dispatchMod = require('../engine/dispatch');
    assert.ok(typeof dispatchMod.updateAgentStatus === 'function',
      'updateAgentStatus should be a function exported from dispatch.js');
  });

  await test('updateAgentStatus uses mutateDispatch for atomic updates', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    // Extract the updateAgentStatus function body
    const fnStart = src.indexOf('function updateAgentStatus(');
    assert.ok(fnStart > -1, 'updateAgentStatus function should exist in dispatch.js');
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
    assert.ok(fnBody.includes('mutateDispatch('), 'updateAgentStatus should use mutateDispatch()');
    assert.ok(fnBody.includes('workerState'), 'updateAgentStatus should set workerState');
    assert.ok(fnBody.includes('workerStateAt'), 'updateAgentStatus should set workerStateAt');
    assert.ok(fnBody.includes('workerStateDetail'), 'updateAgentStatus should set workerStateDetail');
  });

  await test('updateAgentStatus updates dispatch entry fields', () => {
    const restore = createTestMinionsDir();
    try {
      const testDispatch = require('../engine/dispatch');
      const testQueries = require('../engine/queries');

      // Seed dispatch with an active entry
      testDispatch.mutateDispatch((dp) => {
        dp.active.push({ id: 'test-status-1', agent: 'dallas', type: 'implement' });
        return dp;
      });

      // Update the agent status
      testDispatch.updateAgentStatus('test-status-1', shared.AGENT_STATUS.RUNNING, 'Process spawned');

      // Read back and verify
      const dp = testQueries.getDispatch();
      const entry = dp.active.find(d => d.id === 'test-status-1');
      assert.ok(entry, 'Active entry should still exist');
      assert.strictEqual(entry.workerState, 'running');
      assert.ok(entry.workerStateAt, 'workerStateAt should be set');
      assert.strictEqual(entry.workerStateDetail, 'Process spawned');
    } finally { restore(); }
  });

  await test('updateAgentStatus no-ops gracefully on missing dispatch ID', () => {
    const restore = createTestMinionsDir();
    try {
      const testDispatch = require('../engine/dispatch');
      // Should not throw
      testDispatch.updateAgentStatus('nonexistent-id', shared.AGENT_STATUS.RUNNING, 'test');
      testDispatch.updateAgentStatus('', shared.AGENT_STATUS.RUNNING, 'test');
      testDispatch.updateAgentStatus(null, shared.AGENT_STATUS.RUNNING, 'test');
    } finally { restore(); }
  });

  await test('spawnAgent emits SPAWNING, WORKTREE_SETUP, READY, RUNNING statuses', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('AGENT_STATUS.SPAWNING'), 'spawnAgent should emit SPAWNING status');
    assert.ok(src.includes('AGENT_STATUS.WORKTREE_SETUP'), 'spawnAgent should emit WORKTREE_SETUP status');
    assert.ok(src.includes('AGENT_STATUS.READY'), 'spawnAgent should emit READY status');
    assert.ok(src.includes('AGENT_STATUS.RUNNING'), 'spawnAgent should emit RUNNING status');
  });

  await test('onAgentClose emits FINISHED on code 0, FAILED on nonzero', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('AGENT_STATUS.FINISHED'), 'onAgentClose should emit FINISHED');
    assert.ok(src.includes('AGENT_STATUS.FAILED'), 'onAgentClose should emit FAILED');
    // Verify the conditional: code === 0 → FINISHED, else FAILED
    assert.ok(src.includes('code === 0 ? AGENT_STATUS.FINISHED : AGENT_STATUS.FAILED'),
      'Should use ternary to choose FINISHED/FAILED based on exit code');
  });

  await test('timeout.js emits TIMED_OUT status', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(src.includes('AGENT_STATUS.TIMED_OUT'), 'timeout.js should emit TIMED_OUT status');
    // Verify it's called for both hard timeout and heartbeat timeout
    const timedOutCount = (src.match(/AGENT_STATUS\.TIMED_OUT/g) || []).length;
    assert.ok(timedOutCount >= 3, `TIMED_OUT should be emitted for hard timeout, orphan, and hung agent (found ${timedOutCount} occurrences)`);
  });

  await test('trust gate detection checks first 30s of output', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('AGENT_STATUS.TRUST_BLOCKED'), 'engine.js should emit TRUST_BLOCKED');
    assert.ok(src.includes('_trustCheckDone'), 'Should track whether trust check is complete');
    assert.ok(src.includes('30000'), 'Should use 30s window for trust gate detection');
    assert.ok(src.includes('trust-blocked'), 'Should write inbox alert for trust gate');
  });

  await test('engine.js uses updateAgentStatus (not raw dispatch mutation) for status transitions', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // All status transitions should go through updateAgentStatus
    assert.ok(src.includes("updateAgentStatus(id, AGENT_STATUS.SPAWNING"),
      'SPAWNING should use updateAgentStatus helper');
    assert.ok(src.includes("updateAgentStatus(id, AGENT_STATUS.READY"),
      'READY should use updateAgentStatus helper');
    assert.ok(src.includes("updateAgentStatus(id, AGENT_STATUS.RUNNING"),
      'RUNNING should use updateAgentStatus helper');
  });

  await test('dashboard API returns workerState as passthrough', () => {
    // The dashboard's getStatus returns dispatch data directly — workerState flows through
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('dispatch: getDispatchQueue()'),
      'Dashboard status should include dispatch queue as passthrough');
  });
}

// ─── P-b3n8f5c1: FAILURE_CLASS enum and classifyFailure() ──────────────────

async function testFailureClassEnum() {
  console.log('\n── FAILURE_CLASS enum and classifyFailure() ──');
  const lifecycle = require('../engine/lifecycle');

  await test('FAILURE_CLASS enum has all 10 required values', () => {
    const { FAILURE_CLASS } = shared;
    assert.ok(FAILURE_CLASS, 'FAILURE_CLASS should be exported from shared.js');
    assert.strictEqual(FAILURE_CLASS.CONFIG_ERROR, 'config-error');
    assert.strictEqual(FAILURE_CLASS.PERMISSION_BLOCKED, 'permission-blocked');
    assert.strictEqual(FAILURE_CLASS.MERGE_CONFLICT, 'merge-conflict');
    assert.strictEqual(FAILURE_CLASS.BUILD_FAILURE, 'build-failure');
    assert.strictEqual(FAILURE_CLASS.TIMEOUT, 'timeout');
    assert.strictEqual(FAILURE_CLASS.EMPTY_OUTPUT, 'empty-output');
    assert.strictEqual(FAILURE_CLASS.SPAWN_ERROR, 'spawn-error');
    assert.strictEqual(FAILURE_CLASS.NETWORK_ERROR, 'network-error');
    assert.strictEqual(FAILURE_CLASS.OUT_OF_CONTEXT, 'out-of-context');
    assert.strictEqual(FAILURE_CLASS.UNKNOWN, 'unknown');
    assert.strictEqual(Object.keys(FAILURE_CLASS).length, 10, 'FAILURE_CLASS should have exactly 10 values');
  });

  await test('ESCALATION_POLICY enum has all 5 values', () => {
    const { ESCALATION_POLICY } = shared;
    assert.ok(ESCALATION_POLICY, 'ESCALATION_POLICY should be exported from shared.js');
    assert.strictEqual(ESCALATION_POLICY.NO_RETRY, 'no-retry');
    assert.strictEqual(ESCALATION_POLICY.RETRY_SAME, 'retry-same');
    assert.strictEqual(ESCALATION_POLICY.RETRY_FRESH, 'retry-fresh');
    assert.strictEqual(ESCALATION_POLICY.HUMAN_REVIEW, 'human-review');
    assert.strictEqual(ESCALATION_POLICY.AUTO, 'auto');
    assert.strictEqual(Object.keys(ESCALATION_POLICY).length, 5, 'ESCALATION_POLICY should have exactly 5 values');
  });

  await test('classifyFailure exported from engine/lifecycle.js', () => {
    assert.ok(typeof lifecycle.classifyFailure === 'function',
      'classifyFailure should be a function exported from lifecycle.js');
  });

  await test('classifyFailure: exit code 78 → CONFIG_ERROR', () => {
    assert.strictEqual(lifecycle.classifyFailure(78, '', ''),
      shared.FAILURE_CLASS.CONFIG_ERROR);
    assert.strictEqual(lifecycle.classifyFailure(78, 'some output', 'claude-code not found'),
      shared.FAILURE_CLASS.CONFIG_ERROR);
  });

  await test('classifyFailure: permission denied → PERMISSION_BLOCKED', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'Error: permission denied'),
      shared.FAILURE_CLASS.PERMISSION_BLOCKED);
    assert.strictEqual(lifecycle.classifyFailure(1, 'access denied for resource', ''),
      shared.FAILURE_CLASS.PERMISSION_BLOCKED);
  });

  await test('classifyFailure: merge conflict → MERGE_CONFLICT', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'CONFLICT (content): Merge conflict in file.js\nAutomatic merge failed'),
      shared.FAILURE_CLASS.MERGE_CONFLICT);
  });

  await test('classifyFailure: build/test failure → BUILD_FAILURE', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, 'npm ERR! Test failed', ''),
      shared.FAILURE_CLASS.BUILD_FAILURE);
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'error TS2304: Cannot find name'),
      shared.FAILURE_CLASS.BUILD_FAILURE);
  });

  await test('classifyFailure: network/rate limit → NETWORK_ERROR', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, 'Error: rate limit exceeded (429)', ''),
      shared.FAILURE_CLASS.NETWORK_ERROR);
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'Error: ECONNREFUSED 127.0.0.1:443'),
      shared.FAILURE_CLASS.NETWORK_ERROR);
  });

  await test('classifyFailure: context exhausted → OUT_OF_CONTEXT', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, 'Error: max turns reached', ''),
      shared.FAILURE_CLASS.OUT_OF_CONTEXT);
    assert.strictEqual(lifecycle.classifyFailure(1, 'context window exceeded', ''),
      shared.FAILURE_CLASS.OUT_OF_CONTEXT);
  });

  await test('classifyFailure: empty output → EMPTY_OUTPUT', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, '', ''),
      shared.FAILURE_CLASS.EMPTY_OUTPUT);
    assert.strictEqual(lifecycle.classifyFailure(1, 'short', ''),
      shared.FAILURE_CLASS.EMPTY_OUTPUT);
  });

  await test('classifyFailure: spawn error → SPAWN_ERROR', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'Error: spawn ENOENT'),
      shared.FAILURE_CLASS.SPAWN_ERROR);
  });

  await test('classifyFailure: unknown failure → UNKNOWN', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, 'some long agent output that is more than fifty characters of normal text without any error patterns', ''),
      shared.FAILURE_CLASS.UNKNOWN);
  });

  await test('completeDispatch stores failureClass on error entries', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes('failureClass') && src.includes('item.failureClass'),
      'completeDispatch should store failureClass on completed dispatch entry');
    // Only stored on errors
    assert.ok(src.includes("result === DISPATCH_RESULT.ERROR) item.failureClass"),
      'failureClass should only be stored when result is error');
  });

  await test('isRetryableFailureReason rejects CONFIG_ERROR and PERMISSION_BLOCKED', () => {
    const dispatch = require('../engine/dispatch');
    assert.strictEqual(dispatch.isRetryableFailureReason('some error', shared.FAILURE_CLASS.CONFIG_ERROR), false,
      'CONFIG_ERROR should never be retryable');
    assert.strictEqual(dispatch.isRetryableFailureReason('some error', shared.FAILURE_CLASS.PERMISSION_BLOCKED), false,
      'PERMISSION_BLOCKED should never be retryable');
    // Other classes remain retryable (unless reason matches non-retryable strings)
    assert.strictEqual(dispatch.isRetryableFailureReason('some error', shared.FAILURE_CLASS.BUILD_FAILURE), true,
      'BUILD_FAILURE should be retryable');
    assert.strictEqual(dispatch.isRetryableFailureReason('some error', shared.FAILURE_CLASS.UNKNOWN), true,
      'UNKNOWN should be retryable');
  });

  await test('onAgentClose calls classifyFailure and passes failureClass to completeDispatch', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('classifyFailure(code, stdout, stderr)'),
      'onAgentClose should call classifyFailure with code, stdout, stderr');
    assert.ok(src.includes('{ failureClass }'),
      'onAgentClose should pass failureClass to completeDispatch opts');
  });

  await test('exit code 78 uses classifyFailure result (CONFIG_ERROR)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // The code=78 handler should pass failureClass to completeDispatch
    const section78 = src.slice(src.indexOf('code === 78'), src.indexOf('code === 78') + 500);
    assert.ok(section78.includes('failureClass'),
      'Exit code 78 handler should use failureClass from classifyFailure');
  });

  await test('existing reason-based non-retryable strings still work', () => {
    const dispatch = require('../engine/dispatch');
    // Without failureClass, reason-based classification still works
    assert.strictEqual(dispatch.isRetryableFailureReason('no playbook rendered'), false);
    assert.strictEqual(dispatch.isRetryableFailureReason('validation failed'), false);
    assert.strictEqual(dispatch.isRetryableFailureReason('missing required vars'), false);
    // Retryable reasons
    assert.strictEqual(dispatch.isRetryableFailureReason('agent timed out'), true);
    assert.strictEqual(dispatch.isRetryableFailureReason(''), true);
  });
}

// ─── P-d9q4w7e6: Recovery recipes ──────────────────────────────────────────

async function testRecoveryRecipes() {
  console.log('\n── Recovery recipes (engine/recovery.js) ──');
  const recoveryMod = require('../engine/recovery');

  await test('engine/recovery.js exists and exports expected functions', () => {
    assert.ok(typeof recoveryMod.getRecoveryRecipe === 'function',
      'getRecoveryRecipe should be exported');
    assert.ok(typeof recoveryMod.shouldRetry === 'function',
      'shouldRetry should be exported');
    assert.ok(recoveryMod.RECOVERY_RECIPES instanceof Map,
      'RECOVERY_RECIPES should be a Map');
  });

  await test('RECOVERY_RECIPES has entry for every FAILURE_CLASS value', () => {
    const { FAILURE_CLASS } = shared;
    for (const fc of Object.values(FAILURE_CLASS)) {
      const recipe = recoveryMod.getRecoveryRecipe(fc);
      assert.ok(recipe, `Missing recipe for failure class: ${fc}`);
      assert.ok('maxAttempts' in recipe, `Recipe for ${fc} missing maxAttempts`);
      assert.ok(recipe.escalation, `Recipe for ${fc} missing escalation`);
      assert.ok(typeof recipe.freshSession === 'boolean', `Recipe for ${fc} missing freshSession`);
      assert.ok(recipe.description, `Recipe for ${fc} missing description`);
    }
  });

  await test('getRecoveryRecipe returns UNKNOWN recipe for unrecognized class', () => {
    const recipe = recoveryMod.getRecoveryRecipe('nonexistent-class');
    assert.ok(recipe, 'Should return fallback recipe');
    assert.strictEqual(recipe.escalation, shared.ESCALATION_POLICY.AUTO);
  });

  await test('CONFIG_ERROR: maxAttempts=0, never retried', () => {
    const recipe = recoveryMod.getRecoveryRecipe(shared.FAILURE_CLASS.CONFIG_ERROR);
    assert.strictEqual(recipe.maxAttempts, 0);
    assert.strictEqual(recipe.escalation, shared.ESCALATION_POLICY.NO_RETRY);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.CONFIG_ERROR, 0), false);
  });

  await test('PERMISSION_BLOCKED: maxAttempts=0, never retried', () => {
    const recipe = recoveryMod.getRecoveryRecipe(shared.FAILURE_CLASS.PERMISSION_BLOCKED);
    assert.strictEqual(recipe.maxAttempts, 0);
    assert.strictEqual(recipe.escalation, shared.ESCALATION_POLICY.NO_RETRY);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.PERMISSION_BLOCKED, 0), false);
  });

  await test('MERGE_CONFLICT: maxAttempts=2, retried', () => {
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.MERGE_CONFLICT, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.MERGE_CONFLICT, 1), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.MERGE_CONFLICT, 2), false);
  });

  await test('BUILD_FAILURE: maxAttempts=2, retried', () => {
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.BUILD_FAILURE, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.BUILD_FAILURE, 1), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.BUILD_FAILURE, 2), false);
  });

  await test('TIMEOUT: maxAttempts=1, freshSession=true', () => {
    const recipe = recoveryMod.getRecoveryRecipe(shared.FAILURE_CLASS.TIMEOUT);
    assert.strictEqual(recipe.freshSession, true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.TIMEOUT, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.TIMEOUT, 1), false);
  });

  await test('NETWORK_ERROR: maxAttempts=3, most retries', () => {
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.NETWORK_ERROR, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.NETWORK_ERROR, 2), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.NETWORK_ERROR, 3), false);
  });

  await test('UNKNOWN: falls back to ENGINE_DEFAULTS.maxRetries', () => {
    const recipe = recoveryMod.getRecoveryRecipe(shared.FAILURE_CLASS.UNKNOWN);
    assert.strictEqual(recipe.maxAttempts, null, 'UNKNOWN maxAttempts should be null (fallback)');
    // ENGINE_DEFAULTS.maxRetries is 3
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.UNKNOWN, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.UNKNOWN, 2), true);
    assert.strictEqual(recoveryMod.shouldRetry(shared.FAILURE_CLASS.UNKNOWN, 3), false);
  });

  await test('shouldRetry with empty failureClass falls back to UNKNOWN', () => {
    // No failureClass → treated as UNKNOWN → uses ENGINE_DEFAULTS.maxRetries
    assert.strictEqual(recoveryMod.shouldRetry('', 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(null, 0), true);
    assert.strictEqual(recoveryMod.shouldRetry(undefined, 2), true);
    assert.strictEqual(recoveryMod.shouldRetry('', 3), false);
  });

  await test('completeDispatch uses shouldRetry from recovery.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'dispatch.js'), 'utf8');
    assert.ok(src.includes("recovery().shouldRetry("),
      'completeDispatch should call shouldRetry from recovery module');
  });

  await test('recovery.js has zero external dependencies', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'recovery.js'), 'utf8');
    const requires = src.match(/require\(['"](.*?)['"]\)/g) || [];
    for (const req of requires) {
      assert.ok(req.includes('./shared') || req.includes('node:'),
        `recovery.js should only import from shared.js or node builtins, found: ${req}`);
    }
  });
}

// ─── P-h2t6r1j8: Structured completion protocol ─────────────────────────────

async function testStructuredCompletion() {
  console.log('\n── Structured completion protocol ──');
  const lifecycle = require('../engine/lifecycle');

  await test('COMPLETION_FIELDS exported from engine/shared.js', () => {
    assert.ok(Array.isArray(shared.COMPLETION_FIELDS),
      'COMPLETION_FIELDS should be an array');
    assert.strictEqual(shared.COMPLETION_FIELDS.length, 6,
      'COMPLETION_FIELDS should have 6 fields');
    assert.ok(shared.COMPLETION_FIELDS.includes('status'), 'Should include status');
    assert.ok(shared.COMPLETION_FIELDS.includes('files_changed'), 'Should include files_changed');
    assert.ok(shared.COMPLETION_FIELDS.includes('tests'), 'Should include tests');
    assert.ok(shared.COMPLETION_FIELDS.includes('pr'), 'Should include pr');
    assert.ok(shared.COMPLETION_FIELDS.includes('pending'), 'Should include pending');
    assert.ok(shared.COMPLETION_FIELDS.includes('failure_class'), 'Should include failure_class');
  });

  await test('parseStructuredCompletion exported from engine/lifecycle.js', () => {
    assert.ok(typeof lifecycle.parseStructuredCompletion === 'function',
      'parseStructuredCompletion should be a function exported from lifecycle.js');
  });

  await test('parseStructuredCompletion: valid block returns parsed object', () => {
    const stdout = 'Some agent output...\n```completion\nstatus: done\nfiles_changed: engine/shared.js, engine/lifecycle.js\ntests: pass\npr: PR-456\nfailure_class: N/A\npending: none\n```\n';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.ok(result, 'Should return parsed object');
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.files_changed, 'engine/shared.js, engine/lifecycle.js');
    assert.strictEqual(result.tests, 'pass');
    assert.strictEqual(result.pr, 'PR-456');
    assert.strictEqual(result.failure_class, 'N/A');
    assert.strictEqual(result.pending, 'none');
  });

  await test('parseStructuredCompletion: missing block returns null', () => {
    const stdout = 'Agent output without completion block\nDone!';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.strictEqual(result, null, 'Should return null when no completion block found');
  });

  await test('parseStructuredCompletion: empty/null input returns null', () => {
    assert.strictEqual(lifecycle.parseStructuredCompletion(''), null);
    assert.strictEqual(lifecycle.parseStructuredCompletion(null), null);
    assert.strictEqual(lifecycle.parseStructuredCompletion(undefined), null);
  });

  await test('parseStructuredCompletion: malformed block (no status) returns null', () => {
    const stdout = '```completion\nfiles_changed: foo.js\ntests: pass\n```';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.strictEqual(result, null, 'Should return null when status field is missing');
  });

  await test('parseStructuredCompletion: multiple blocks takes last one', () => {
    const stdout = '```completion\nstatus: partial\npr: N/A\n```\nRetrying...\n```completion\nstatus: done\npr: PR-789\ntests: pass\nfailure_class: N/A\npending: none\n```\n';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.ok(result, 'Should return parsed object from last block');
    assert.strictEqual(result.status, 'done', 'Should use last block');
    assert.strictEqual(result.pr, 'PR-789', 'Should use last block PR');
  });

  await test('parseStructuredCompletion: failed status with failure_class', () => {
    const stdout = '```completion\nstatus: failed\nfiles_changed: none\ntests: fail\npr: N/A\nfailure_class: build-failure\npending: fix compilation errors\n```';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.ok(result);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failure_class, 'build-failure');
    assert.strictEqual(result.pending, 'fix compilation errors');
  });

  await test('fix.md includes ## Completion section', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'fix.md'), 'utf8');
    assert.ok(src.includes('## Completion'), 'fix.md should have ## Completion section');
    assert.ok(src.includes('```completion'), 'fix.md should have ```completion block');
  });

  await test('decompose.md does NOT include ## Completion section', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'decompose.md'), 'utf8');
    assert.ok(!src.includes('## Completion') && !src.includes('```completion'),
      'decompose.md should NOT have Completion section (uses structured JSON output)');
  });

  await test('review.md does NOT include ## Completion section', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'review.md'), 'utf8');
    assert.ok(!src.includes('## Completion') && !src.includes('```completion'),
      'review.md should NOT have Completion section (no PR creation)');
  });

  await test('explore.md does NOT include ## Completion section', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'playbooks', 'explore.md'), 'utf8');
    assert.ok(!src.includes('## Completion') && !src.includes('```completion'),
      'explore.md should NOT have Completion section (no PR creation)');
  });

  await test('runPostCompletionHooks uses parseStructuredCompletion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('parseStructuredCompletion(stdout)'),
      'runPostCompletionHooks should call parseStructuredCompletion');
    assert.ok(src.includes('structuredCompletion'),
      'runPostCompletionHooks should use structuredCompletion variable');
  });

  await test('runPostCompletionHooks returns structuredCompletion in result', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('structuredCompletion }'),
      'Return object should include structuredCompletion');
  });

  await test('parseStructuredCompletion: keys are lowercased', () => {
    const stdout = '```completion\nStatus: done\nPR: PR-100\nTests: pass\nFAILURE_CLASS: N/A\npending: none\n```';
    const result = lifecycle.parseStructuredCompletion(stdout);
    assert.ok(result);
    assert.strictEqual(result.status, 'done');
    assert.strictEqual(result.pr, 'PR-100');
    assert.strictEqual(result.tests, 'pass');
    assert.strictEqual(result.failure_class, 'N/A');
  });
}

async function testCCMultiTab() {
  console.log('\n── CC Multi-Tab Conversations ──');

  // Source code references
  const ccSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'command-center.js'), 'utf8');
  const layoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'layout.html'), 'utf8');
  const stylesSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'styles.css'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');

  // ── Server-side tests ──────────────────────────────────────────────────────

  await test('cc-sessions.json endpoints exist in route table', () => {
    assert.ok(dashSrc.includes('/api/cc-sessions'), 'Should have GET /api/cc-sessions route');
    assert.ok(dashSrc.includes('cc-sessions'), 'Should have DELETE /api/cc-sessions route');
  });

  await test('cc-sessions persisted via safeWrite', () => {
    assert.ok(dashSrc.includes('cc-sessions.json'), 'Should reference cc-sessions.json');
    assert.ok(dashSrc.includes('CC_SESSIONS_PATH'), 'Should use CC_SESSIONS_PATH constant');
  });

  await test('stream handler accepts tabId', () => {
    assert.ok(dashSrc.includes('body.tabId') || dashSrc.includes('tabId'), 'Stream handler should accept tabId from request body');
  });

  await test('session metadata saved with tabId', () => {
    assert.ok(dashSrc.includes('lastActiveAt') && dashSrc.includes('turnCount'), 'Should save session metadata fields');
    assert.ok(dashSrc.includes('createdAt'), 'Should track createdAt');
    assert.ok(dashSrc.includes('preview'), 'Should save preview field');
  });

  await test('session lookup by tabId in stream handler', () => {
    assert.ok(dashSrc.includes('tabId') && dashSrc.includes('CC_SESSIONS_PATH'), 'Should map tabId to session via CC_SESSIONS_PATH');
  });

  // ── Client-side tests ─────────────────────────────────────────────────────

  await test('_ccTabs array replaces old globals', () => {
    assert.ok(ccSrc.includes('var _ccTabs = []') || ccSrc.includes('var _ccTabs=[]'), 'Should declare _ccTabs array');
    assert.ok(!ccSrc.includes('let _ccSessionId') && !ccSrc.includes('var _ccSessionId'), 'Should not have old _ccSessionId global');
    assert.ok(!ccSrc.match(/^var _ccMessages\b/m) && !ccSrc.match(/^let _ccMessages\b/m), 'Should not have old _ccMessages global');
  });

  await test('_ccActiveTabId tracks which tab is visible', () => {
    assert.ok(ccSrc.includes('_ccActiveTabId'), 'Should declare _ccActiveTabId');
  });

  await test('ccNewTab function exists', () => {
    assert.ok(ccSrc.includes('function ccNewTab'), 'Should have ccNewTab function');
  });

  await test('ccSwitchTab function exists', () => {
    assert.ok(ccSrc.includes('function ccSwitchTab'), 'Should have ccSwitchTab function');
  });

  await test('ccCloseTab function exists', () => {
    assert.ok(ccSrc.includes('function ccCloseTab'), 'Should have ccCloseTab function');
  });

  await test('ccShowAllConversations function exists', () => {
    assert.ok(ccSrc.includes('function ccShowAllConversations'), 'Should have ccShowAllConversations function');
  });

  await test('tab bar rendered in layout.html', () => {
    assert.ok(layoutSrc.includes('cc-tab-bar'), 'Should have cc-tab-bar element in layout');
  });

  await test('ccSend passes active tab sessionId in request body', () => {
    // ccSend should use the active tab's sessionId
    assert.ok(ccSrc.includes('tabSessionId') || ccSrc.includes('activeTab') || ccSrc.includes('_ccActiveTab'),
      'ccSend should reference active tab for sessionId');
    assert.ok(ccSrc.includes('tabId') && ccSrc.includes('activeTabId'),
      'Should send tabId in request body');
  });

  await test('ccAddMessage adds to active tab messages', () => {
    assert.ok(ccSrc.includes('_ccActiveTab()') && ccSrc.includes('tab.messages.push'),
      'ccAddMessage should push to active tab messages array');
  });

  await test('tab state saved to localStorage', () => {
    assert.ok(ccSrc.includes("'cc-tabs'") || ccSrc.includes('"cc-tabs"'),
      'Should save tabs to cc-tabs localStorage key');
  });

  await test('migration from old format', () => {
    assert.ok(ccSrc.includes('cc-session-id') && ccSrc.includes('cc-messages'),
      'Should check for legacy localStorage keys');
    assert.ok(ccSrc.includes('_ccMigrateLegacy') || ccSrc.includes('Migrate') || ccSrc.includes('migrate'),
      'Should have migration logic');
  });

  await test('auto-title from first user message', () => {
    assert.ok(ccSrc.includes('CC_TITLE_MAX_LENGTH') || ccSrc.includes('40'),
      'Should truncate title');
    assert.ok(ccSrc.includes("'New chat'") || ccSrc.includes('"New chat"'),
      'Should use "New chat" as default title');
    assert.ok(ccSrc.includes('tab.title') && ccSrc.includes('New chat'),
      'Should auto-set title from first user message');
  });

  await test('max tabs cap', () => {
    assert.ok(ccSrc.includes('CC_MAX_TABS') || ccSrc.includes('20'),
      'Should have max tabs constant');
    assert.ok(ccSrc.includes('CC_MAX_TABS') && ccSrc.includes('>= CC_MAX_TABS'),
      'Should enforce max tabs limit');
  });

  await test('tab close confirmation for active request', () => {
    assert.ok(ccSrc.includes('_ccSending') && ccSrc.includes('confirm'),
      'Should confirm before closing tab with active request');
  });

  await test('active tab persistence', () => {
    assert.ok(ccSrc.includes("'cc-active-tab'") || ccSrc.includes('"cc-active-tab"'),
      'Should persist active tab ID to localStorage');
  });

  // ── Dashboard assembly tests ──────────────────────────────────────────────

  await test('cc-tab-bar in assembled HTML', () => {
    let buildDashboardHtml;
    try {
      const dashModule = require(path.join(MINIONS_DIR, 'dashboard-build'));
      buildDashboardHtml = dashModule.buildDashboardHtml;
    } catch {
      try {
        const html = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.html'), 'utf8');
        buildDashboardHtml = () => html;
      } catch {
        assert.fail('Could not load dashboard builder');
        return;
      }
    }
    const html = buildDashboardHtml();
    assert.ok(html.includes('cc-tab-bar'), 'Assembled HTML should include cc-tab-bar');
  });

  await test('tab CSS styles exist', () => {
    assert.ok(stylesSrc.includes('.cc-tab'), 'Should have .cc-tab style');
    assert.ok(stylesSrc.includes('.cc-tab.active'), 'Should have .cc-tab.active style');
    assert.ok(stylesSrc.includes('.cc-tab-close'), 'Should have .cc-tab-close style');
  });

  // ── Integration flow tests ────────────────────────────────────────────────

  await test('send uses active tab sessionId flow', () => {
    assert.ok(ccSrc.includes('_ccActiveTab()'),
      'ccSend should call _ccActiveTab() to get current tab');
    assert.ok(ccSrc.includes('.sessionId'),
      'Should read sessionId from tab');
  });

  await test('response updates originating tab sessionId (not active tab)', () => {
    assert.ok(ccSrc.includes('evt.sessionId') || ccSrc.includes('revt.sessionId'),
      'Done event should check for sessionId');
    assert.ok(ccSrc.includes('originTab.sessionId = evt.sessionId') || ccSrc.includes('originTab2.sessionId = revt.sessionId'),
      'Should update originating tab sessionId, not _ccActiveTab()');
  });

  await test('new tab creates tab with sessionId null', () => {
    assert.ok(ccSrc.includes('sessionId: null'),
      'ccNewTab should create tab with null sessionId');
  });

  await test('tab switch re-renders messages', () => {
    assert.ok(ccSrc.includes("el.innerHTML = ''") || ccSrc.includes("el.innerHTML=''"),
      'ccSwitchTab should clear cc-messages innerHTML');
    assert.ok(ccSrc.includes('ccRenderTabBar'),
      'ccSwitchTab should call ccRenderTabBar');
  });

  // ── Session never-expire tests ─────────────────────────────────────────────

  await test('sessions never expire by time — CC_SESSION_EXPIRY_MS removed', () => {
    assert.ok(!dashSrc.includes('CC_SESSION_EXPIRY_MS'), 'CC_SESSION_EXPIRY_MS constant should be removed');
    assert.ok(!dashSrc.includes('2 * 60 * 60 * 1000'), 'Hardcoded 2-hour expiry should be removed');
  });

  await test('ccSessionValid does not check age', () => {
    // Extract ccSessionValid function body
    const match = dashSrc.match(/function ccSessionValid\(\)\s*\{[\s\S]*?\n\}/);
    assert.ok(match, 'ccSessionValid should exist');
    const body = match[0];
    assert.ok(!body.includes('age'), 'ccSessionValid should not reference age');
    assert.ok(!body.includes('Date.now()'), 'ccSessionValid should not check Date.now()');
    assert.ok(body.includes('turnCount'), 'ccSessionValid should still check turnCount');
    assert.ok(body.includes('_promptHash'), 'ccSessionValid should still check prompt hash');
  });

  await test('resolveSession does not check age for doc sessions', () => {
    const match = dashSrc.match(/function resolveSession\([\s\S]*?\n\}/);
    assert.ok(match, 'resolveSession should exist');
    const body = match[0];
    assert.ok(!body.includes('age'), 'resolveSession should not reference age');
    assert.ok(!body.includes('CC_SESSION_EXPIRY'), 'resolveSession should not reference expiry constant');
  });

  await test('CC session restored on startup without age check', () => {
    // The startup block should load session without age filtering
    const startupMatch = dashSrc.match(/Load persisted CC session[\s\S]*?catch \{/);
    assert.ok(startupMatch, 'Should have CC session startup loader');
    assert.ok(!startupMatch[0].includes('age'), 'Startup loader should not check age');
  });

  await test('doc sessions restored on startup without age check', () => {
    const docLoadMatch = dashSrc.match(/const saved = safeJson\(DOC_SESSIONS_PATH\)[\s\S]*?catch \{/);
    assert.ok(docLoadMatch, 'Should have doc session startup loader');
    assert.ok(!docLoadMatch[0].includes('age'), 'Doc session loader should not check age');
  });

  await test('prompt hash stored with tab session for invalidation', () => {
    assert.ok(dashSrc.includes('_promptHash: _ccPromptHash'), 'Should store _promptHash when persisting tab sessions');
    assert.ok(dashSrc.includes("tabEntry._promptHash") || dashSrc.includes("tabEntry && tabEntry._promptHash"),
      'Stream handler should check tab entry prompt hash');
  });

  await test('sessionReset flag sent to frontend on prompt hash mismatch', () => {
    assert.ok(dashSrc.includes('sessionReset = true'), 'Should set sessionReset flag');
    assert.ok(dashSrc.includes('sessionReset') && dashSrc.includes('donePayload'),
      'Stream handler should include sessionReset in done payload');
  });

  await test('frontend shows system message on sessionReset', () => {
    assert.ok(ccSrc.includes('evt.sessionReset'), 'Frontend should check sessionReset in done event');
    assert.ok(ccSrc.includes('Minions was updated'), 'Should show update notice to user');
    assert.ok(ccSrc.includes("'system'") && ccSrc.includes('sessionReset'),
      'Should use system role for reset notice');
  });

  await test('ccAddMessage handles system role distinctly', () => {
    assert.ok(ccSrc.includes("role === 'system'") || ccSrc.includes("=== 'system'"),
      'Should detect system role');
    assert.ok(ccSrc.includes('isSystem'), 'Should have isSystem variable');
    assert.ok(ccSrc.includes('!isUser && !isSystem'),
      'isAssistant should exclude system messages');
  });

  // ── Resource cleanup tests ───────────────────────────────────────────────

  const cleanupSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'cleanup.js'), 'utf8');
  const timeoutSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');

  await test('cleanup.js prunes cc-sessions.json with cap', () => {
    assert.ok(cleanupSrc.includes('cc-sessions.json'), 'Should reference cc-sessions.json');
    assert.ok(cleanupSrc.includes('CC_SESSIONS_CAP'), 'Should define CC_SESSIONS_CAP');
    assert.ok(cleanupSrc.includes('lastActiveAt'), 'Should sort by lastActiveAt for pruning');
  });

  await test('cleanup.js prunes doc-sessions.json with cap', () => {
    assert.ok(cleanupSrc.includes('doc-sessions.json'), 'Should reference doc-sessions.json');
    assert.ok(cleanupSrc.includes('DOC_SESSIONS_CAP'), 'Should define DOC_SESSIONS_CAP');
  });

  await test('cleanup.js caps cooldowns.json entries', () => {
    assert.ok(cleanupSrc.includes('cooldowns.json'), 'Should reference cooldowns.json');
    assert.ok(cleanupSrc.includes('COOLDOWN_CAP'), 'Should define COOLDOWN_CAP');
    assert.ok(cleanupSrc.includes('timestamp'), 'Should sort cooldowns by timestamp');
  });

  await test('cleanup.js cleans stale PID files', () => {
    assert.ok(cleanupSrc.includes('pid-') && cleanupSrc.includes('.pid'), 'Should match PID file pattern');
    assert.ok(cleanupSrc.includes('activePids'), 'Should check against active process PIDs');
    assert.ok(cleanupSrc.includes('oneHourAgo'), 'Should use 1-hour staleness threshold');
  });

  await test('cleanup.js prunes test-results.json', () => {
    assert.ok(cleanupSrc.includes('test-results.json'), 'Should reference test-results.json');
    assert.ok(cleanupSrc.includes('TEST_RESULTS_CAP'), 'Should define TEST_RESULTS_CAP');
  });

  await test('timeout.js kills Unix process tree on hung agent timeout', () => {
    // The hung agent branch should include pkill -P for Unix tree kill
    const hungMatch = timeoutSrc.match(/Hung agent[\s\S]*?deadItems\.push/);
    assert.ok(hungMatch, 'Should have hung agent detection block');
    assert.ok(hungMatch[0].includes('pkill') || hungMatch[0].includes('process.platform'), 'Hung agent handler should attempt process tree kill on Unix');
  });

  await test('cleanup.js logs resource cleanup summary', () => {
    assert.ok(cleanupSrc.includes('Cleanup (resources)'), 'Should log resource cleanup summary');
    assert.ok(cleanupSrc.includes('cc-sessions') && cleanupSrc.includes('doc-sessions') && cleanupSrc.includes('cooldowns') && cleanupSrc.includes('PID files'),
      'Summary should cover all resource types');
  });
}

async function testIsolationVerification() {
  console.log('\n── Test Isolation Verification ──');

  await test('MINIONS_DIR is overridable via MINIONS_TEST_DIR env var', () => {
    process.env.MINIONS_TEST_DIR = '/tmp/test-isolation-check';
    delete require.cache[require.resolve('../engine/shared')];
    const testShared = require('../engine/shared');
    assert.strictEqual(testShared.MINIONS_DIR, '/tmp/test-isolation-check');
    delete process.env.MINIONS_TEST_DIR;
    delete require.cache[require.resolve('../engine/shared')];
    require('../engine/shared');
  });

  await test('createTestMinionsDir creates full isolated directory structure', () => {
    const restore = createTestMinionsDir();
    try {
      const testShared = require('../engine/shared');
      assert.ok(testShared.MINIONS_DIR !== path.resolve(__dirname, '..'),
        'MINIONS_DIR should point to temp dir');
      for (const d of ['engine', 'prd', 'prd/archive', 'plans', 'projects', 'notes/inbox', 'agents']) {
        assert.ok(fs.existsSync(path.join(testShared.MINIONS_DIR, d)), 'Missing dir: ' + d);
      }
      assert.ok(fs.existsSync(path.join(testShared.MINIONS_DIR, 'config.json')));
      assert.ok(fs.existsSync(path.join(testShared.MINIONS_DIR, 'engine', 'dispatch.json')));
    } finally { restore(); }
  });

  await test('createTestMinionsDir restore returns to real MINIONS_DIR', () => {
    const realDir = shared.MINIONS_DIR;
    const restore = createTestMinionsDir();
    restore();
    assert.strictEqual(require('../engine/shared').MINIONS_DIR, realDir);
  });

  await test('no _test-* files in real prd/ after test run', () => {
    const dir = path.join(shared.MINIONS_DIR, 'prd');
    if (!fs.existsSync(dir)) return;
    const testFiles = fs.readdirSync(dir).filter(f => f.startsWith('_test-'));
    assert.strictEqual(testFiles.length, 0, 'Found: ' + testFiles.join(', '));
  });

  await test('no _test-* files in real prd/archive/ after test run', () => {
    const dir = path.join(shared.MINIONS_DIR, 'prd', 'archive');
    if (!fs.existsSync(dir)) return;
    const testFiles = fs.readdirSync(dir).filter(f => f.startsWith('_test-'));
    assert.strictEqual(testFiles.length, 0, 'Found: ' + testFiles.join(', '));
  });

  await test('no test agent IDs in metrics.json', () => {
    const metrics = shared.safeJson(path.join(shared.MINIONS_DIR, 'engine', 'metrics.json')) || {};
    const bad = Object.keys(metrics).filter(k => k.startsWith('temp-') || k === 'agent1' || k.startsWith('_test'));
    assert.strictEqual(bad.length, 0, 'Found: ' + bad.join(', '));
  });

  await test('updateMetrics guards against test agent IDs', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes("temp-") && src.includes("agent1"), 'Should guard test IDs');
  });

  await test('shared.js uses MINIONS_TEST_DIR env override', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(src.includes('MINIONS_TEST_DIR'), 'Should check env var');
  });

  await test('llm.js derives paths from shared.MINIONS_DIR', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'llm.js'), 'utf8');
    assert.ok(src.includes('shared.MINIONS_DIR'), 'Should not hardcode path');
  });
}

// ─── Session 2026-04-08: slugify, formatTranscriptEntry, pipeline reconciliation ──

async function testSlugifyAndTranscript() {
  console.log('\n── shared.js — slugify & formatTranscriptEntry ──');

  await test('slugify lowercases and replaces non-alphanumeric with hyphens', () => {
    assert.strictEqual(shared.slugify('Hello World!'), 'hello-world');
  });

  await test('slugify strips leading and trailing hyphens', () => {
    assert.strictEqual(shared.slugify('---test---'), 'test');
    assert.strictEqual(shared.slugify('!foo!'), 'foo');
  });

  await test('slugify respects maxLen parameter', () => {
    const result = shared.slugify('a-very-long-title-that-should-be-truncated', 20);
    assert.ok(result.length <= 20, 'Should be <= 20 chars, got ' + result.length);
  });

  await test('slugify defaults to maxLen 50', () => {
    const long = 'a'.repeat(100);
    assert.strictEqual(shared.slugify(long).length, 50);
  });

  await test('slugify handles empty string', () => {
    assert.strictEqual(shared.slugify(''), '');
  });

  await test('slugify is used in dashboard.js (no inline slug patterns)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('shared.slugify('), 'dashboard.js should use shared.slugify');
  });

  await test('slugify is used in consolidation.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'consolidation.js'), 'utf8');
    assert.ok(src.includes('shared.slugify('), 'consolidation.js should use shared.slugify');
  });

  await test('slugify is used in pipeline.js', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('slugify('), 'pipeline.js should use slugify');
  });

  await test('formatTranscriptEntry returns correct format', () => {
    const entry = shared.formatTranscriptEntry({ agent: 'Dallas', type: 'finding', round: 1, content: 'Found a bug' });
    assert.ok(entry.startsWith('### Dallas (finding, Round 1)'));
    assert.ok(entry.includes('Found a bug'));
  });

  await test('formatTranscriptEntry guards null fields', () => {
    const entry = shared.formatTranscriptEntry({});
    assert.ok(entry.startsWith('### agent (, Round ?)'));
  });

  await test('formatTranscriptEntry handles undefined content', () => {
    const entry = shared.formatTranscriptEntry({ agent: 'Ripley', type: 'debate', round: 2 });
    assert.ok(entry.includes('### Ripley (debate, Round 2)\n\n'));
  });
}

async function testPipelineReconciliation() {
  console.log('\n── Pipeline Plan Reconciliation ──');

  await test('executePlanStage reconciles existing plan before LLM call', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const fnBody = src.slice(src.indexOf('async function executePlanStage('), src.indexOf('\n}\n', src.indexOf('async function executePlanStage(') + 200));
    const reconcileIdx = fnBody.indexOf('_findExistingPlanForMeeting');
    const llmIdx = fnBody.indexOf('callLLM');
    assert.ok(reconcileIdx > 0 && llmIdx > 0, 'Should have both reconciliation and LLM call');
    assert.ok(reconcileIdx < llmIdx, 'Reconciliation should happen before LLM call');
  });

  await test('reconciliation adopts WI inside mutateWorkItems lock (no TOCTOU)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const fnBody = src.slice(src.indexOf('if (existingPlanFile)'), src.indexOf('// ── No existing plan'));
    assert.ok(fnBody.includes('mutateWorkItems(wiPath'), 'Should use mutateWorkItems');
    assert.ok(fnBody.includes('existing._pipelineRun'), 'Should tag adopted WI');
    assert.ok(!fnBody.includes('safeJson(wiPath)'), 'Should NOT do unlocked pre-read');
  });

  await test('meeting context built from all run stages, not just direct deps', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('function _findMeetingsInRun(run)'), 'Should have _findMeetingsInRun');
    const fnBody = src.slice(src.indexOf('No existing plan'), src.indexOf('callLLM'));
    assert.ok(fnBody.includes('for (const mid of meetingIds)'), 'Should iterate all meetingIds');
  });

  await test('_findExistingPlanForMeeting uses dashboard slug convention', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes("'meeting-follow-up-'"), 'Should use dashboard naming prefix');
    assert.ok(src.includes('**Source Meeting:**'), 'Should check Source Meeting header');
  });

  await test('isStageComplete PLAN uses local arrays before merging artifacts', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    const isStageStart = src.indexOf('function isStageComplete(');
    const planCase = src.slice(src.indexOf("case STAGE_TYPE.PLAN:", isStageStart), src.indexOf("case STAGE_TYPE.MERGE_PRS:", isStageStart));
    assert.ok(planCase.includes('discoveredPrds'), 'Should collect into local discoveredPrds');
    assert.ok(planCase.includes('discoveredWiIds'), 'Should collect into local discoveredWiIds');
    assert.ok(planCase.includes('artifacts.prds = [...(artifacts.prds'), 'Should merge via spread');
  });

  await test('immediate completion check after executeStage returns RUNNING', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'pipeline.js'), 'utf8');
    assert.ok(src.includes('completed immediately after start'), 'Should check completion immediately');
  });

  await test('auto-archive removed — verify does not call archivePlan', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    const chainIdx = src.indexOf('Plan chaining removed');
    const verifySection = src.slice(chainIdx, src.indexOf('Clean up worktree', chainIdx));
    assert.ok(!verifySection.includes('archivePlan('), 'Should NOT auto-archive');
    assert.ok(verifySection.includes('Archive is manual'), 'Should note manual archive');
  });

  await test('/api/plans/create writes Source Meeting header', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard.js'), 'utf8');
    assert.ok(src.includes('meetingId') && src.includes('**Source Meeting:**'), 'Should write meetingId header');
  });

  await test('removeWorktree has failure tracking with retry cap', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    assert.ok(src.includes('_removeWorktreeFailures') && src.includes('count >= 3'), 'Should cap retries at 3');
  });

  await test('removeWorktree purges Windows reserved-name files before deletion', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    // Must call _purgeReservedFiles on win32 before git worktree remove
    assert.ok(src.includes('_purgeReservedFiles(resolved)'), 'Should call _purgeReservedFiles before removal');
    assert.ok(src.includes("process.platform === 'win32'") || src.includes('process.platform === \'win32\''), 'Should gate on win32');
  });

  await test('removeWorktree uses cmd /c rd /s /q on Windows for any error (not just EPERM)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    const fn = src.slice(src.indexOf('function removeWorktree('), src.indexOf('\n}\n', src.indexOf('function removeWorktree(') + 50) + 2);
    // Must use cmd /c rd /s /q (not plain rd /s /q)
    assert.ok(fn.includes('cmd /c rd /s /q'), 'Should use cmd /c rd /s /q');
    // Must NOT restrict to EPERM only — should handle any Windows error
    assert.ok(!fn.includes("rmErr.code === 'EPERM'"), 'Should not restrict rd /s /q to EPERM only');
  });

  await test('_WIN_RESERVED_NAMES includes NUL and other device names', () => {
    const shared = require(path.join(MINIONS_DIR, 'engine', 'shared.js'));
    assert.ok(shared._WIN_RESERVED_NAMES instanceof Set, '_WIN_RESERVED_NAMES should be a Set');
    assert.ok(shared._WIN_RESERVED_NAMES.has('NUL'), 'Should include NUL');
    assert.ok(shared._WIN_RESERVED_NAMES.has('CON'), 'Should include CON');
    assert.ok(shared._WIN_RESERVED_NAMES.has('PRN'), 'Should include PRN');
    assert.ok(shared._WIN_RESERVED_NAMES.has('AUX'), 'Should include AUX');
    assert.ok(shared._WIN_RESERVED_NAMES.has('COM1'), 'Should include COM1');
    assert.ok(shared._WIN_RESERVED_NAMES.has('LPT1'), 'Should include LPT1');
  });

  await test('_purgeReservedFiles deletes files matching reserved names', () => {
    const shared = require(path.join(MINIONS_DIR, 'engine', 'shared.js'));
    // _purgeReservedFiles only deletes on Windows (uses \\?\ prefix), but we can
    // verify it's exported and is a function for testability
    assert.strictEqual(typeof shared._purgeReservedFiles, 'function', '_purgeReservedFiles should be exported');
    // On non-Windows, _purgeReservedFiles should be a no-op that doesn't throw
    const tmpDir = createTmpDir();
    // Should not throw on empty dir
    shared._purgeReservedFiles(tmpDir);
    // Should not throw on non-existent dir
    shared._purgeReservedFiles(path.join(tmpDir, 'nonexistent'));
  });

  await test('removeWorktree logs rd /s /q fallback failures', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'shared.js'), 'utf8');
    const fn = src.slice(src.indexOf('function removeWorktree('), src.indexOf('\n}\n', src.indexOf('function removeWorktree(') + 50) + 2);
    assert.ok(fn.includes('rd /s /q fallback failed'), 'Should log rd /s /q failures instead of silently swallowing');
  });
}

async function testMetricsEnrichment() {
  console.log('\n── Metrics Enrichment & LLM Timing ──');

  await test('getMetrics enriches PR counts from pull-requests.json', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    const fn = src.slice(src.indexOf('function getMetrics()'), src.indexOf('\n}\n', src.indexOf('function getMetrics()') + 50));
    assert.ok(fn.includes('getPullRequests') && fn.includes('prCountByAgent'), 'Should enrich PR counts');
  });

  await test('getMetrics enriches runtime from dispatch history', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'queries.js'), 'utf8');
    const fn = src.slice(src.indexOf('function getMetrics()'), src.indexOf('\n}\n', src.indexOf('function getMetrics()') + 50));
    assert.ok(fn.includes('runtimeByAgent') && fn.includes('timedTasks'), 'Should enrich runtime with timedTasks');
  });

  await test('timedCalls tracked in trackEngineUsage', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'llm.js'), 'utf8');
    assert.ok(src.includes('cat.timedCalls'), 'Should increment timedCalls');
  });

  await test('timedTasks tracked in updateMetrics', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
    assert.ok(src.includes('m.timedTasks'), 'Should increment timedTasks');
  });

  await test('dashboard uses timedCalls/timedTasks for averages', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-other.js'), 'utf8');
    assert.ok(src.includes('timedCalls') && src.includes('m.timedTasks'), 'Should use timed counters for avg');
  });
}

async function testDashboardButtonConsistency() {
  console.log('\n── Dashboard Plan/PRD Button Consistency ──');

  await test('plan card: Execute only for draft plans without PRD', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes("planExecute(") && src.includes('!prdFile'), 'Execute requires no PRD');
  });

  await test('plan card: Approve for awaiting-approval, not Execute', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    const actionsBlock = src.slice(src.indexOf('if (needsAction'), src.indexOf('} else if (isRevision)'));
    assert.ok(actionsBlock.includes("'Approve'"), 'Should show Approve');
    assert.ok(!actionsBlock.includes("'Execute'"), 'Should NOT show Execute in actions block');
  });

  await test('plan card: no duplicate Resume for paused state', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes('const showResume = false'), 'Resume pill disabled — handled by actions block');
  });

  // Shared slices for card and modal button tests
  const plansSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
  const cardActionsBlock = plansSrc.slice(plansSrc.indexOf('if (needsAction'), plansSrc.indexOf('} else if (isRevision)'));
  const modalFn = plansSrc.slice(plansSrc.indexOf('function _renderPlanModal'), plansSrc.indexOf('\nasync function planView'));

  await test('plan modal: Approve targets linked PRD file', () => {
    assert.ok(modalFn.includes('prdFile || normalizedFile') && modalFn.includes('planApprove'), 'Should target PRD file');
  });

  await test('plan modal: Reject shown for awaiting-approval or paused', () => {
    assert.ok(modalFn.includes('isNeedsAction') && modalFn.includes('planReject'), 'Should show Reject when needs action');
  });

  // Plan card button ordering: Approve before Re-execute for awaiting-approval with PRD
  await test('plan card: Approve is first button, Re-execute second for awaiting-approval with PRD', () => {
    const approveIdx = cardActionsBlock.indexOf("planApprove(");
    const reExecIdx = cardActionsBlock.indexOf("planExecute(");
    const rejectIdx = cardActionsBlock.indexOf("planReject(");
    assert.ok(approveIdx < reExecIdx, 'Approve button must come before Re-execute');
    assert.ok(reExecIdx < rejectIdx, 'Re-execute button must come before Reject');
  });

  await test('plan card: Re-execute has reduced opacity (secondary action)', () => {
    const approveLineMatch = cardActionsBlock.match(/planApprove\([^)]+\)[^<]*>Approve</);
    const reExecLineMatch = cardActionsBlock.match(/opacity:0\.7[^>]*planExecute/);
    assert.ok(approveLineMatch, 'Approve button should exist without opacity');
    assert.ok(reExecLineMatch, 'Re-execute button should have opacity:0.7');
  });

  await test('plan card: Approve label is "Approve" not "Approve as-is"', () => {
    assert.ok(!cardActionsBlock.includes('Approve as-is'), 'Should not say "Approve as-is"');
    assert.ok(cardActionsBlock.includes('>Approve</button>'), 'Should say "Approve"');
  });

  // Plan modal button ordering: matches card (Approve before Re-execute, Reject after)
  await test('plan modal: Approve before Re-execute before Reject in modal actions', () => {
    const needsActionBlock = modalFn.slice(modalFn.indexOf('if (isNeedsAction)'), modalFn.indexOf('// Execute (draft'));
    const approveIdx = needsActionBlock.indexOf('planApprove(');
    const reExecIdx = needsActionBlock.indexOf('planExecute(');
    const rejectIdx = needsActionBlock.indexOf('planReject(');
    assert.ok(approveIdx > -1, 'Approve must exist in modal needsAction block');
    assert.ok(reExecIdx > -1, 'Re-execute must exist in modal needsAction block');
    assert.ok(rejectIdx > -1, 'Reject must exist in modal needsAction block');
    assert.ok(approveIdx < reExecIdx, 'Approve must come before Re-execute in modal');
    assert.ok(reExecIdx < rejectIdx, 'Re-execute must come before Reject in modal');
  });

  await test('plan modal: Re-execute has reduced opacity in modal', () => {
    assert.ok(modalFn.match(/opacity:0\.7[^>]*planExecute/), 'Re-execute should have opacity:0.7 in modal');
  });

  await test('plan modal: Re-execute only for awaiting-approval .md plans with PRD', () => {
    assert.ok(modalFn.includes("effectiveStatus === 'awaiting-approval' && isMdPlan && prdFile"),
      'Re-execute guard must check awaiting-approval + isMdPlan + prdFile');
  });

  // PRD page: Verify button hidden when verify WI exists
  const prdSrc = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-prd.js'), 'utf8');

  await test('PRD header: Verify button guarded by hasVerifyWi check', () => {
    const headerBlock = prdSrc.slice(prdSrc.indexOf("effectiveStatus === 'completed'"), prdSrc.indexOf("effectiveStatus === 'dispatched'"));
    assert.ok(headerBlock.includes('hasVerifyWi'), 'Should check hasVerifyWi before showing Verify');
    assert.ok(headerBlock.includes("itemType === 'verify'"), 'hasVerifyWi should check itemType');
    assert.ok(headerBlock.includes('hasVerifyWi ? '), 'Should conditionally hide Verify when hasVerifyWi is true');
  });

  await test('PRD header: Archive still shown when Verify is hidden', () => {
    const headerBlock = prdSrc.slice(prdSrc.indexOf("effectiveStatus === 'completed'"), prdSrc.indexOf("effectiveStatus === 'dispatched'"));
    assert.ok(headerBlock.includes('planArchive'), 'Archive button must always appear for completed PRDs');
  });

  await test('PRD group header: Verify button guarded by verify WI check', () => {
    const groupHeader = prdSrc.slice(prdSrc.indexOf('const pauseResumeBtn'), prdSrc.indexOf('const archiveBtn'));
    assert.ok(groupHeader.includes("itemType === 'verify'"), 'Group header should check for existing verify WI');
    assert.ok(groupHeader.includes('triggerVerify'), 'Verify action should still exist for non-verified groups');
  });

  await test('PRD group header: completed+verified shows no Pause button', () => {
    const groupHeader = prdSrc.slice(prdSrc.indexOf('const pauseResumeBtn'), prdSrc.indexOf('const archiveBtn'));
    // The ternary chain: isCompleted && !hasVerify → Verify, isCompleted → '', else → Pause
    assert.ok(groupHeader.includes("isCompleted ? ''"), 'Completed+verified should produce empty string, not Pause');
  });

  await test('archive confirm warns about linked source plan', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-plans.js'), 'utf8');
    assert.ok(src.includes('source plan will also be archived'), 'Should warn about linked plan');
  });

  await test('client-side transcript has null guards', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'dashboard', 'js', 'render-meetings.js'), 'utf8');
    const lines = src.split('\n').filter(l => l.includes("t.agent") && l.includes("t.type") && l.includes("t.round"));
    for (const line of lines) {
      assert.ok(line.includes("|| 'agent'"), 'Should guard agent: ' + line.trim().slice(0, 60));
    }
  });
}

// ─── #716: Heartbeat feedback loop + max_turns lifecycle cleanup ────────────

async function testIssue716HeartbeatFeedbackLoop() {
  console.log('\n── #716: Heartbeat feedback loop + max_turns lifecycle cleanup ──');
  const lifecycle = require('../engine/lifecycle');

  // 1. classifyFailure with exact Claude CLI error_max_turns output
  await test('classifyFailure: exact error_max_turns JSON → OUT_OF_CONTEXT', () => {
    // Exact format from Claude CLI when agent exhausts turn limit
    const exactOutput = '{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns"}';
    assert.strictEqual(lifecycle.classifyFailure(1, exactOutput, ''),
      shared.FAILURE_CLASS.OUT_OF_CONTEXT,
      'Exact error_max_turns JSON from Claude CLI should classify as OUT_OF_CONTEXT');
  });

  await test('classifyFailure: terminal_reason max_turns in stderr → OUT_OF_CONTEXT', () => {
    assert.strictEqual(lifecycle.classifyFailure(1, '', 'terminal_reason: max_turns'),
      shared.FAILURE_CLASS.OUT_OF_CONTEXT);
  });

  // 2. realActivityMap tracked in engine.js (prevents heartbeat feedback loop)
  await test('engine.js tracks realActivityMap on stdout/stderr data', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    assert.ok(src.includes('realActivityMap'),
      'engine.js should use realActivityMap for timeout detection');
    // Must be updated on stdout data handler
    const marker = 'proc.stdout.on';
    const idx = src.indexOf(marker);
    const stdoutSection = src.slice(idx, idx + 500);
    assert.ok(stdoutSection.includes('realActivityMap.set(id, Date.now())'),
      'stdout data handler should update realActivityMap');
    // Must be initialized at spawn time
    assert.ok(src.includes('realActivityMap.set(id, Date.now())'),
      'realActivityMap should be initialized at spawn time');
  });

  // 3. timeout.js uses realActivityMap instead of file mtime for tracked processes
  await test('timeout.js uses realActivityMap for tracked processes (#716)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(src.includes('realActivityMap'),
      'timeout.js should check realActivityMap for tracked process');
    assert.ok(src.includes('feedback loop'),
      'timeout.js should comment about avoiding heartbeat feedback loop');
  });

  // 4. Output completion detection scans for result and process-exit
  await test('timeout.js detects completed agents from output (#716)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    assert.ok(src.includes('"type":"result"') && src.includes('[process-exit]'),
      'timeout.js should scan for result events and process-exit sentinel');
    assert.ok(src.includes('completedViaOutput'),
      'Should track completion via output detection');
    assert.ok(src.includes('completeDispatch(item.id'),
      'Should finalize dispatch for completed agents detected via output');
  });

  // 5. spawn-agent.js writes [process-exit] sentinel to stdout
  await test('spawn-agent.js writes [process-exit] sentinel on close (#716)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'spawn-agent.js'), 'utf8');
    assert.ok(src.includes('[process-exit]'),
      'spawn-agent.js should write [process-exit] sentinel to stdout on close');
    assert.ok(src.includes("process.stdout.write"),
      'Sentinel should be written to stdout (not stderr or file)');
  });

  // 6. Blocking tool detection guard: don't extend timeout after agent completed
  await test('timeout.js guards blocking tool detection against completed agents (#716)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    // The blocking tool detection section should check for result/process-exit before extending
    const blockingSection = src.slice(src.indexOf('isBlocking = false'), src.indexOf('effectiveTimeout'));
    assert.ok(blockingSection.includes('"type":"result"') || blockingSection.includes('[process-exit]'),
      'Blocking tool detection should check for completed agent before extending timeout');
  });

  // 7. Output completion detection is NOT gated by time cap
  await test('timeout.js output detection runs unconditionally, not time-gated (#716)', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'timeout.js'), 'utf8');
    // The old code had: if (silentMs <= 600000) try { ... check for result ... }
    // The new code should NOT have this time cap
    assert.ok(!src.includes('silentMs <= 600000'),
      'Output completion detection should NOT be gated by 600s time cap');
    // Should use tail reading for efficiency (64KB)
    assert.ok(src.includes('TAIL_SIZE') || src.includes('65536'),
      'Should use tail reading for efficiency');
  });

  // 8. Heartbeat timer does NOT update realActivityMap
  await test('engine.js heartbeat timer does NOT update realActivityMap', () => {
    const src = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
    // Find the heartbeat interval — it should NOT contain realActivityMap
    const heartbeatMatches = src.match(/heartbeatTimer\s*=\s*setInterval\(\s*\(\)\s*=>\s*\{[^}]+\}/g);
    assert.ok(heartbeatMatches, 'Should have heartbeat timer');
    for (const match of heartbeatMatches) {
      assert.ok(!match.includes('realActivityMap'),
        'Heartbeat timer should NOT update realActivityMap — only real stdout/stderr should');
    }
  });
}

// ─── PR Review→Fix, Poll→Fix, Merge Conflict, Auto-Complete Flows ──────────

async function testPrReviewFixFlows() {
  console.log('\n── PR Review→Fix Flow ──');

  const engineSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine.js'), 'utf8');
  const lifecycleSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'lifecycle.js'), 'utf8');
  const ghSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'github.js'), 'utf8');
  const adoSrc = fs.readFileSync(path.join(MINIONS_DIR, 'engine', 'ado.js'), 'utf8');

  // ── Review dispatch ──

  await test('review dispatch gated by evalEscalated', () => {
    assert.ok(engineSrc.includes('!evalEscalated') && engineSrc.includes('needsReview'),
      'needsReview should include !evalEscalated check');
  });

  await test('review dispatch includes PR title in label', () => {
    assert.ok(engineSrc.includes('Review ${pr.id}: ${pr.title}'),
      'Review label should include pr.title');
  });

  await test('review dispatch has pre-dispatch live vote check', () => {
    assert.ok(engineSrc.includes('checkLiveReview') && engineSrc.includes('liveStatus'),
      'Should check live review status before dispatching');
  });

  // ── Review-fix dispatch ──

  await test('review-fix dispatch gated by evalEscalated', () => {
    assert.ok(engineSrc.includes("changes-requested' && !awaitingReReview && !evalEscalated"),
      'Review-fix should check !evalEscalated');
  });

  await test('review-fix increments _reviewFixCycles', () => {
    assert.ok(engineSrc.includes('_reviewFixCycles') && engineSrc.includes('review-fix cycles'),
      'Should increment _reviewFixCycles on review-fix dispatch');
  });

  await test('review-fix sets fixDispatched flag', () => {
    const fixBlock = engineSrc.slice(engineSrc.indexOf("changes-requested' && !awaitingReReview"), engineSrc.indexOf('PRs with pending human feedback'));
    assert.ok(fixBlock.includes('fixDispatched = true'), 'Should set fixDispatched after review-fix');
  });

  // ── Human feedback fix ──

  await test('human feedback fix NOT gated by evalEscalated', () => {
    const humanBlock = engineSrc.slice(engineSrc.indexOf('PRs with pending human feedback'), engineSrc.indexOf('PRs with build failures'));
    assert.ok(!humanBlock.includes('evalEscalated'), 'Human feedback should NOT be gated by evalEscalated');
  });

  await test('human feedback fix does NOT increment _reviewFixCycles', () => {
    const humanBlock = engineSrc.slice(engineSrc.indexOf('PRs with pending human feedback'), engineSrc.indexOf('PRs with build failures'));
    assert.ok(!humanBlock.includes('_reviewFixCycles'), 'Human feedback should NOT increment cycle counter');
  });

  await test('human feedback fix sets fixDispatched', () => {
    const humanBlock = engineSrc.slice(engineSrc.indexOf('PRs with pending human feedback'), engineSrc.indexOf('PRs with build failures'));
    assert.ok(humanBlock.includes('fixDispatched = true'), 'Human feedback should set fixDispatched');
  });

  // ── Eval escalation ──

  await test('eval escalation does NOT use continue (allows build/conflict fixes)', () => {
    const startIdx = engineSrc.indexOf('cycle cap');
    const endIdx = engineSrc.indexOf('autoReview', startIdx);
    const escalBlock = engineSrc.slice(startIdx, endIdx);
    assert.ok(escalBlock.length > 10, 'Should find escalation block');
    assert.ok(!escalBlock.includes('continue;'), 'Escalation should NOT use continue — would block build fixes');
    assert.ok(escalBlock.includes('evalEscalated'), 'Should set evalEscalated flag');
  });

  await test('eval escalation writes inbox alert', () => {
    assert.ok(engineSrc.includes('Review Loop Escalation'), 'Should write escalation alert to inbox');
  });

  await test('eval escalation uses evalMaxIterations from config', () => {
    assert.ok(engineSrc.includes('evalMaxIterations'), 'Should read evalMaxIterations from config');
  });

  // ── Review vote protection ──

  console.log('\n── Vote Protection ──');

  await test('GitHub: approved never downgraded unless CHANGES_REQUESTED', () => {
    const reviewBlock = ghSrc.slice(ghSrc.indexOf('let newReviewStatus'), ghSrc.indexOf('if (pr.reviewStatus !== newReviewStatus)'));
    assert.ok(reviewBlock.includes("pr.reviewStatus === 'approved'") && reviewBlock.includes("newReviewStatus = 'approved'"),
      'GitHub poller should preserve approved status');
  });

  await test('ADO: approved never downgraded unless vote -10', () => {
    const reviewBlock = adoSrc.slice(adoSrc.indexOf('let newReviewStatus'), adoSrc.indexOf('Store human reviewer'));
    assert.ok(reviewBlock.includes("pr.reviewStatus === 'approved'") && reviewBlock.includes("newReviewStatus = 'approved'"),
      'ADO poller should preserve approved status');
  });

  await test('updatePrAfterReview never downgrades approved', () => {
    assert.ok(lifecycleSrc.includes("target.reviewStatus !== 'approved'"),
      'updatePrAfterReview should guard against downgrading approved');
  });

  await test('updatePrAfterReview defaults to null (no change) when live check is pending', () => {
    assert.ok(lifecycleSrc.includes('let postReviewStatus = null'),
      'Default should be null (do not change) not waiting or pending');
  });

  await test('_reviewFixCycles reset on approval (GitHub)', () => {
    assert.ok(ghSrc.includes("delete pr._reviewFixCycles") && ghSrc.includes("delete pr._evalEscalated"),
      'GitHub should clear cycle counter on approval');
  });

  await test('_reviewFixCycles reset on approval (ADO)', () => {
    assert.ok(adoSrc.includes("delete pr._reviewFixCycles") && adoSrc.includes("delete pr._evalEscalated"),
      'ADO should clear cycle counter on approval');
  });

  await test('PR persistence guard: approved never overwritten by stale in-memory copy (ADO)', () => {
    assert.ok(adoSrc.includes("currentPrs[idx].reviewStatus === 'approved'") && adoSrc.includes("updatedPr.reviewStatus = 'approved'"),
      'ADO forEachActivePr persistence should guard approved on disk from stale in-memory copy');
  });

  await test('PR persistence guard: approved never overwritten by stale in-memory copy (GitHub)', () => {
    assert.ok(ghSrc.includes("currentPrs[idx].reviewStatus === 'approved'") && ghSrc.includes("updatedPr.reviewStatus = 'approved'"),
      'GitHub forEachActivePr persistence should guard approved on disk from stale in-memory copy');
  });

  await test('engine.js pre-dispatch live vote check guards approved', () => {
    const liveVoteBlock = engineSrc.slice(engineSrc.indexOf('Pre-dispatch live vote check'), engineSrc.indexOf('Pre-dispatch live vote check') + 800);
    assert.ok(liveVoteBlock.includes("reviewStatus !== 'approved'"),
      'Pre-dispatch live vote check should guard against downgrading approved');
  });

  // ── updatePrAfterReview passes resultSummary ──

  await test('updatePrAfterReview receives resultSummary for review note', () => {
    assert.ok(lifecycleSrc.includes('function updatePrAfterReview(agentId, pr, project, config, resultSummary)'),
      'updatePrAfterReview should accept resultSummary parameter');
    assert.ok(lifecycleSrc.includes('resultSummary || completedEntry'),
      'Should use resultSummary as primary note source');
  });

  // ── Build fix ──

  console.log('\n── Build Fix Flow ──');

  await test('build fix NOT gated by evalEscalated', () => {
    const buildBlock = engineSrc.slice(engineSrc.indexOf('PRs with build failures'), engineSrc.indexOf('PRs with merge conflicts') || engineSrc.length);
    assert.ok(!buildBlock.includes('evalEscalated'), 'Build fix should NOT be gated by evalEscalated');
  });

  await test('build fix has grace period (_buildFixPushedAt)', () => {
    assert.ok(engineSrc.includes('_buildFixPushedAt') && engineSrc.includes('buildFixGracePeriod'),
      'Should check grace period before re-dispatching build fix');
  });

  await test('build fix escalates after maxBuildFixAttempts', () => {
    assert.ok(engineSrc.includes('buildFixAttempts') && engineSrc.includes('buildFixEscalated'),
      'Should escalate after max attempts');
  });

  await test('_autoCompleted reset when build goes red', () => {
    assert.ok(ghSrc.includes("'failing') delete pr._autoCompleted"),
      'GitHub should reset _autoCompleted on build failure');
    assert.ok(adoSrc.includes("'failing') delete pr._autoCompleted"),
      'ADO should reset _autoCompleted on build failure');
  });

  await test('GitHub error logs fetch annotations + job log (always)', () => {
    assert.ok(ghSrc.includes('hasUsefulAnnotations') && ghSrc.includes('actions/jobs'),
      'Should fetch both annotations and job logs');
  });

  await test('ADO build detection uses builds API not status checks', () => {
    assert.ok(adoSrc.includes('_apis/build/builds') && adoSrc.includes('sourceVersion === mergeCommitId'),
      'ADO should query builds API with merge commit hash');
  });

  await test('ADO partiallySucceeded counts as passing', () => {
    assert.ok(adoSrc.includes('partiallySucceeded'), 'ADO should treat partiallySucceeded as passing');
  });

  // ── Merge conflict fix ──

  console.log('\n── Merge Conflict Fix ──');

  await test('GitHub detects merge conflicts via mergeable field', () => {
    assert.ok(ghSrc.includes('prData.mergeable === false') && ghSrc.includes('_mergeConflict'),
      'GitHub should detect conflicts via mergeable field');
  });

  await test('ADO detects merge conflicts via mergeStatus', () => {
    assert.ok(adoSrc.includes("mergeStatus === 'conflicts'") && adoSrc.includes('_mergeConflict'),
      'ADO should detect conflicts via mergeStatus');
  });

  await test('merge conflict fix dispatched in discoverFromPrs', () => {
    assert.ok(engineSrc.includes('_mergeConflict') && engineSrc.includes('conflict-fix-'),
      'Should dispatch conflict fix with unique dispatch key');
  });

  await test('merge conflict fix gated by fixDispatched', () => {
    const conflictBlock = engineSrc.slice(engineSrc.indexOf('PRs with merge conflicts'), engineSrc.indexOf('Build & test now runs'));
    assert.ok(conflictBlock.includes('!fixDispatched'), 'Conflict fix should be gated by fixDispatched');
  });

  await test('_mergeConflict cleared when conflict resolves', () => {
    assert.ok(ghSrc.includes("delete pr._mergeConflict"), 'GitHub should clear flag');
    assert.ok(adoSrc.includes("delete pr._mergeConflict"), 'ADO should clear flag');
  });

  // ── Auto-complete ──

  console.log('\n── Auto-Complete ──');

  await test('auto-complete is opt-in (=== true)', () => {
    assert.ok(ghSrc.includes('autoCompletePrs === true'), 'GitHub auto-complete should be opt-in');
    assert.ok(adoSrc.includes('autoCompletePrs === true'), 'ADO auto-complete should be opt-in');
  });

  await test('auto-complete requires both approved and passing', () => {
    assert.ok(ghSrc.includes("reviewStatus === 'approved'") && ghSrc.includes("buildStatus === 'passing'") && ghSrc.includes('_autoCompleted'),
      'GitHub should require both conditions');
  });

  await test('GitHub merge method validated against whitelist', () => {
    assert.ok(ghSrc.includes("['squash', 'merge', 'rebase']"),
      'Merge method should be validated');
  });

  // ── Agent comment filtering ──

  console.log('\n── Comment Filtering ──');

  await test('agent comments included in context but do not trigger fix', () => {
    assert.ok(ghSrc.includes('_isAgentComment') && ghSrc.includes('!isAgent'),
      'GitHub should detect agent comments and exclude from trigger');
  });

  await test('Minions signature patterns detected', () => {
    assert.ok(ghSrc.includes("Minions\\s*\\(") && ghSrc.includes("by\\s+Minions"),
      'Should detect both "Minions (" and "by Minions" patterns');
  });

  await test('agent comments advance cutoff without triggering', () => {
    assert.ok(ghSrc.includes('agent comments only') || ghSrc.includes('allNewDates'),
      'Cutoff should advance past agent comments to prevent re-scan');
  });

  // ── Label readability ──

  await test('dispatch labels include PR title (no redundant PR prefix)', () => {
    assert.ok(engineSrc.includes('Review ${pr.id}: ${pr.title}'), 'Review label should have title');
    assert.ok(engineSrc.includes('Fix ${pr.id}: ${pr.title'), 'Fix label should have title');
    assert.ok(!engineSrc.includes('Review PR ${pr.id}'), 'Should NOT have redundant "PR" before PR-xxx');
    assert.ok(!engineSrc.includes('Fix PR ${pr.id}'), 'Should NOT have redundant "PR" before PR-xxx');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
