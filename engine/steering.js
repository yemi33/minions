/**
 * engine/steering.js — Durable agent-scoped steering inbox helpers.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');

const AGENTS_DIR = path.join(shared.MINIONS_DIR, 'agents');

function agentInboxDir(agentId) {
  return path.join(AGENTS_DIR, agentId, 'inbox');
}

function _createdAtFromPath(filePath, stat) {
  const base = path.basename(filePath);
  const m = base.match(/^steering-(\d+)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return stat?.mtimeMs || Date.now();
}

function _stripFrontmatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  return end >= 0 ? text.slice(end + 5) : text;
}

function _frontmatterValue(raw, key) {
  const text = String(raw || '');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const fm = text.slice(4, end).split(/\r?\n/);
  const prefix = key + ':';
  for (const line of fm) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function _messageFromRaw(raw) {
  let body = _stripFrontmatter(raw).trim();
  const forwarded = body.match(/Original steering from human:\s*([\s\S]*)$/i);
  if (forwarded) body = forwarded[1].trim();
  return body;
}

function _readEntry(filePath, legacy = false) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const raw = shared.safeRead(filePath);
  const fmCreatedAtMs = Number(_frontmatterValue(raw, 'createdAtMs'));
  const createdAtMs = Number.isFinite(fmCreatedAtMs) && fmCreatedAtMs > 0
    ? fmCreatedAtMs
    : _createdAtFromPath(filePath, stat);
  return {
    path: filePath,
    file: path.basename(filePath),
    createdAtMs,
    createdAt: new Date(createdAtMs).toISOString(),
    raw,
    message: _messageFromRaw(raw),
    legacy,
  };
}

function _uniqueSteeringPath(inboxDir, createdAtMs) {
  let filePath = path.join(inboxDir, `steering-${createdAtMs}.md`);
  for (let i = 1; fs.existsSync(filePath); i++) {
    filePath = path.join(inboxDir, `steering-${createdAtMs}-${i}.md`);
  }
  return filePath;
}

function writeSteeringMessage(agentId, message, opts = {}) {
  const createdAtMs = Number(opts.createdAtMs) || Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const inboxDir = agentInboxDir(agentId);
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = _uniqueSteeringPath(inboxDir, createdAtMs);
  const body = [
    '---',
    `createdAt: ${createdAt}`,
    `createdAtMs: ${createdAtMs}`,
    `source: ${opts.source || 'human'}`,
    '---',
    '',
    String(message || '').trim(),
    '',
  ].join('\n');
  shared.safeWrite(filePath, body);
  return _readEntry(filePath);
}

function listUnreadSteeringMessages(agentId, opts = {}) {
  const includeLegacy = opts.includeLegacy !== false;
  const entries = [];
  const inboxDir = agentInboxDir(agentId);
  for (const file of shared.safeReadDir(inboxDir)) {
    if (!/^steering-.*\.md$/i.test(file)) continue;
    const entry = _readEntry(path.join(inboxDir, file), false);
    if (entry) entries.push(entry);
  }

  if (includeLegacy) {
    const legacyPath = path.join(AGENTS_DIR, agentId, 'steer.md');
    const legacy = _readEntry(legacyPath, true);
    if (legacy) entries.push(legacy);
  }

  entries.sort((a, b) => (a.createdAtMs - b.createdAtMs) || a.file.localeCompare(b.file));
  return entries;
}

function buildPendingSteeringPrompt(agentId) {
  const entries = listUnreadSteeringMessages(agentId).filter(entry => entry.message.trim());
  if (entries.length === 0) return { entries, prompt: '' };

  const sections = [
    '## Pending instructions from prior session',
    '',
    'These human steering messages were not confirmed processed before the previous session ended. Address them before continuing with the task.',
  ];
  entries.forEach((entry, idx) => {
    sections.push('', `### Message ${idx + 1} — ${entry.createdAt}`, '', entry.message.trim());
  });
  return { entries, prompt: sections.join('\n') };
}

function _eventTimestampMs(obj, observedAtMs) {
  const value = obj?.timestamp || obj?.createdAt || obj?.created_at || obj?.time || obj?.data?.timestamp;
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return Number(observedAtMs) || Date.now();
}

function _isProcessEvidenceEvent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const type = String(obj.type || '');
  if (type === 'assistant' || type === 'tool_use') return true;
  if (type.startsWith('assistant.') || type.startsWith('tool.')) return true;
  if (Array.isArray(obj.message?.content)) {
    return obj.message.content.some(block => block?.type === 'text' || block?.type === 'tool_use');
  }
  return false;
}

function _processEvidenceTimes(rawOutput, observedAtMs) {
  const times = [];
  for (const line of String(rawOutput || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (_isProcessEvidenceEvent(obj)) times.push(_eventTimestampMs(obj, observedAtMs));
    } catch { /* ignore non-JSON output */ }
  }
  return times;
}

function ackProcessedSteeringMessages(agentId, pendingEntries, rawOutput, opts = {}) {
  const entries = Array.isArray(pendingEntries) ? pendingEntries : [];
  if (entries.length === 0) return [];
  const times = _processEvidenceTimes(rawOutput, opts.observedAtMs);
  if (times.length === 0) return [];

  const acked = [];
  for (const entry of entries) {
    if (!entry?.path) continue;
    if (!times.some(t => t > entry.createdAtMs)) continue;
    shared.safeUnlink(entry.path);
    acked.push(entry);
  }
  return acked;
}

module.exports = {
  agentInboxDir,
  writeSteeringMessage,
  listUnreadSteeringMessages,
  buildPendingSteeringPrompt,
  ackProcessedSteeringMessages,
};
