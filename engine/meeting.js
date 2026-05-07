/**
 * engine/meeting.js — Team meeting orchestration.
 * Manages multi-round meetings: investigate → debate → conclude.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeJson, uid, log, ts, ENGINE_DEFAULTS, WORK_TYPE, DISPATCH_RESULT } = shared;
const queries = require('./queries');
const { getDispatch, getConfig } = queries;
const { renderPlaybook } = require('./playbook');

/** Patterns that indicate an agent returned no meaningful output */
const EMPTY_OUTPUT_PATTERNS = ['(no output)', '(no findings)', '(no response)'];

// No lazy require needed — log comes from shared.js, no engine-specific APIs used

// Derive from shared.MINIONS_DIR so createTestMinionsDir()/MINIONS_TEST_DIR
// tests can redirect the meetings directory without patching module internals.
const MEETINGS_DIR = path.join(shared.MINIONS_DIR, 'meetings');
const MEETING_NOTE_ARTIFACT_ROOT = path.join(shared.MINIONS_DIR, 'notes', 'inbox');
const TERMINAL_MEETING_STATUSES = new Set(['completed', 'archived']);
const ROUND_STATUS_BY_NAME = {
  investigate: 'investigating',
  debate: 'debating',
  conclude: 'concluding',
};
const ROUND_NUMBER_BY_NAME = { investigate: 1, debate: 2, conclude: 3 };
const ACTIVE_MEETING_STATUSES = new Set(Object.values(ROUND_STATUS_BY_NAME));

function isTerminalMeetingStatus(status) {
  return TERMINAL_MEETING_STATUSES.has(String(status || '').toLowerCase());
}

// Process-scoped dedup so a stuck meeting (missing agenda) logs the warning
// once per id rather than every tick (~1/min). Module-scoped lifetime is
// intentional: a fresh process should re-warn at startup so the operator sees
// the issue, but the same engine run shouldn't spam.
const _warnedMissingAgendaIds = new Set();
function _warnOnceMissingAgenda(meetingId) {
  if (!meetingId || _warnedMissingAgendaIds.has(meetingId)) return;
  _warnedMissingAgendaIds.add(meetingId);
  log('warn', `Meeting ${meetingId}: skipping discovery — agenda is missing or empty (will not be re-logged this process)`);
}
function _resetMissingAgendaWarnings() { _warnedMissingAgendaIds.clear(); }

function expectedMeetingStatusForRound(roundName) {
  return ROUND_STATUS_BY_NAME[String(roundName || '').toLowerCase()] || null;
}

function roundKeyFor(roundName, round) {
  const numeric = Number(round);
  if (Number.isFinite(numeric) && numeric > 0) return String(numeric);
  return String(ROUND_NUMBER_BY_NAME[String(roundName || '').toLowerCase()] || 1);
}

function getRoundFailures(meeting, roundName, round, create = false) {
  if (!meeting.roundFailures || typeof meeting.roundFailures !== 'object') {
    if (!create) return {};
    meeting.roundFailures = {};
  }
  const key = roundKeyFor(roundName, round);
  if (!meeting.roundFailures[key] || typeof meeting.roundFailures[key] !== 'object') {
    if (!create) return {};
    meeting.roundFailures[key] = {};
  }
  return meeting.roundFailures[key];
}

function hasRoundFailure(meeting, roundName, agentId, round = meeting.round) {
  return Boolean(getRoundFailures(meeting, roundName, round, false)[agentId]);
}

function hasRoundSuccess(meeting, roundName, agentId) {
  if (roundName === 'investigate') return Boolean(meeting.findings?.[agentId]);
  if (roundName === 'debate') return Boolean(meeting.debate?.[agentId]);
  return Boolean(meeting.conclusion && meeting.conclusion.agent === agentId);
}

function hasRoundTerminalOutcome(meeting, roundName, agentId, round = meeting.round) {
  return hasRoundSuccess(meeting, roundName, agentId) || hasRoundFailure(meeting, roundName, agentId, round);
}

function allParticipantsFinishedRound(meeting, roundName, round = meeting.round) {
  const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
  return participants.length > 0 && participants.every(agentId =>
    hasRoundTerminalOutcome(meeting, roundName, agentId, round)
  );
}

function formatRoundFailuresForConclusion(meeting, roundName, round = meeting.round) {
  const failures = getRoundFailures(meeting, roundName, round, false);
  return Object.entries(failures)
    .map(([agent, failure]) => `- **${agent}**: ${failure.reason || 'Agent failed before producing a meeting contribution.'}`)
    .join('\n') || '- No structured failure details were captured.';
}

function buildFailedMeetingConclusion(meeting, agents, reason) {
  const base = buildTimedOutMeetingConclusion(meeting, agents)
    .replace('*Auto-generated — conclusion round timed out.*', '*Auto-generated — conclusion round failed.*');
  return `${base}\n\n## Conclusion Failure\n${reason || formatRoundFailuresForConclusion(meeting, 'conclude', meeting.round)}`;
}

function advanceMeetingIfRoundComplete(meeting, roundName, meetingId, config = null) {
  if (roundName === 'investigate') {
    if (!allParticipantsFinishedRound(meeting, roundName, meeting.round)) return false;
    meeting.status = 'debating';
    meeting.round = 2;
    meeting.roundStartedAt = ts();
    log('info', `Meeting ${meetingId}: all findings finished — advancing to debate`);
    return true;
  }
  if (roundName === 'debate') {
    if (!allParticipantsFinishedRound(meeting, roundName, meeting.round)) return false;
    meeting.status = 'concluding';
    meeting.round = 3;
    meeting.roundStartedAt = ts();
    log('info', `Meeting ${meetingId}: all debate responses finished — advancing to conclusion`);
    return true;
  }
  if (roundName === 'conclude' && !meeting.conclusion) {
    const agents = (config || queries.getConfig()).agents || {};
    const autoConclusion = buildFailedMeetingConclusion(meeting, agents);
    meeting.conclusion = { content: autoConclusion, agent: 'system', submittedAt: ts() };
    meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'conclusion', content: autoConclusion, at: ts() });
    meeting.status = 'completed';
    meeting.completedAt = ts();
    writeMeetingTranscriptToInbox(meeting, meetingId, agents);
    log('warn', `Meeting ${meetingId}: conclusion failed — auto-generated fallback conclusion`);
    return true;
  }
  return false;
}

function isEmptyMeetingContent(text) {
  const value = String(text || '').trim();
  return !value || EMPTY_OUTPUT_PATTERNS.includes(value);
}

function isSuccessfulStructuredCompletion(completion) {
  const status = String(completion?.status || completion?.outcome || '').trim().toLowerCase();
  return ['success', 'succeeded', 'complete', 'completed', 'done', 'ok', 'passed'].includes(status);
}

function getStructuredNoteArtifacts(structuredCompletion) {
  const artifacts = structuredCompletion?.artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter(artifact =>
    artifact &&
    typeof artifact === 'object' &&
    String(artifact.type || '').toLowerCase() === 'note' &&
    typeof artifact.path === 'string' &&
    artifact.path.trim()
  );
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveMeetingNoteArtifactPath(artifactPath) {
  const raw = String(artifactPath || '').trim();
  if (!raw || raw.includes('\0')) return null;
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(shared.MINIONS_DIR, raw));
  const root = path.resolve(MEETING_NOTE_ARTIFACT_ROOT);
  if (!isPathInside(root, resolved)) return null;
  if (path.extname(resolved).toLowerCase() !== '.md') return null;
  return resolved;
}

function readMeetingNoteArtifact(artifactPath) {
  const resolved = resolveMeetingNoteArtifactPath(artifactPath);
  if (!resolved) {
    log('warn', `Ignoring unsafe meeting note artifact path: ${artifactPath || '(empty)'}`);
    return '';
  }
  try {
    const realRoot = fs.realpathSync(MEETING_NOTE_ARTIFACT_ROOT);
    const realPath = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, realPath)) {
      log('warn', `Ignoring meeting note artifact outside notes/inbox: ${artifactPath}`);
      return '';
    }
    const content = fs.readFileSync(realPath, 'utf8');
    return isEmptyMeetingContent(content) ? '' : content;
  } catch (err) {
    log('warn', `Meeting note artifact unreadable (${artifactPath}): ${err.message}`);
    return '';
  }
}

function resolveStructuredMeetingContent(structuredCompletion) {
  if (!isSuccessfulStructuredCompletion(structuredCompletion)) return '';
  const noteArtifacts = getStructuredNoteArtifacts(structuredCompletion);
  if (noteArtifacts.length === 0) return '';

  for (const artifact of noteArtifacts) {
    const content = readMeetingNoteArtifact(artifact.path);
    if (content) return content;
  }

  const summary = String(structuredCompletion.summary || '').trim();
  return isEmptyMeetingContent(summary) ? '' : summary;
}

function resolveMeetingContributionContent(output, structuredCompletion) {
  const { text } = shared.parseStreamJsonOutput(output, { maxTextLength: 50000 });
  const rawContent = (text || '').trim();
  if (!isEmptyMeetingContent(rawContent)) return rawContent;
  return resolveStructuredMeetingContent(structuredCompletion);
}

function truncateMeetingContext(text, maxBytes, label) {
  return shared.truncateTextBytes(text, maxBytes, `\n\n_...${label} truncated — review the meeting transcript if needed._`);
}

function formatMeetingContributions(entries, agents, emptyText, label, maxBytes) {
  const pairs = Object.entries(typeof entries === 'object' && entries ? entries : {});
  if (pairs.length === 0) return emptyText;
  const perEntryBytes = Math.max(1024, Math.floor(maxBytes / Math.max(1, pairs.length)));
  const combined = pairs.map(([agent, value]) =>
    `### ${agents[agent]?.name || agent}\n\n${truncateMeetingContext(value?.content || emptyText, perEntryBytes, `${label} entry`)}`
  ).join('\n\n---\n\n');
  return truncateMeetingContext(combined, maxBytes, label);
}

function stripMeetingSummaryMarkdown(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*(?:[#>*-]+|\d+[.)])\s*/gm, '');
}

function cleanMeetingSummaryText(text) {
  return stripMeetingSummaryMarkdown(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function splitMeetingSummaryFragments(text) {
  return stripMeetingSummaryMarkdown(text)
    .split(/\n+|[.!?]+\s*|;\s*/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function truncateMeetingSummary(text, maxLen) {
  const value = String(text || '');
  if (!value) return '';
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '';
  if (value.length < maxLen) return value;
  return value.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function formatMeetingSummaryBullets(entries, agents, emptyText, maxLen) {
  const pairs = Object.entries(typeof entries === 'object' && entries ? entries : {});
  if (pairs.length === 0) return [`- ${emptyText}`];
  return pairs.map(([agent, value]) => {
    const fragments = splitMeetingSummaryFragments(value?.content || '');
    const summary = truncateMeetingSummary(fragments[0] || cleanMeetingSummaryText(value?.content || '') || emptyText, maxLen);
    return `- **${agents[agent]?.name || agent}**: ${summary}`;
  });
}

function scoreMeetingTakeaway(fragment) {
  const value = String(fragment || '');
  const lower = value.toLowerCase();
  let score = 0;
  if (/(should|must|need to|needs to|recommend|recommended|action|next step|follow up|fix|mitigat|investigat|verify|test|block)/.test(lower)) score += 4;
  if (/(agree|aligned|consensus|support|prefer)/.test(lower)) score += 3;
  if (/(disagree|however|but|risk|risky|concern|trade-off|question|uncertain|worry)/.test(lower)) score += 3;
  if (value.length >= 40 && value.length <= 180) score += 2;
  if (value.length > 220) score -= 1;
  return score;
}

function collectMeetingTakeaways(entries, agents, maxItems) {
  const seen = new Set();
  const candidates = [];
  for (const [agent, value] of Object.entries(typeof entries === 'object' && entries ? entries : {})) {
    for (const fragment of splitMeetingSummaryFragments(value?.content || '')) {
      if (fragment.length < 20) continue;
      const normalized = fragment.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push({
        text: `- **${agents[agent]?.name || agent}**: ${truncateMeetingSummary(fragment, 180)}`,
        score: scoreMeetingTakeaway(fragment),
      });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)
    .slice(0, maxItems)
    .map(item => item.text);
}

function collectMeetingNextSteps(meeting) {
  const actionPattern = /\b(should|must|need to|needs to|recommend|recommended|follow up|fix|mitigate|investigate|verify|test|document|ship|patch|review)\b/i;
  const seen = new Set();
  const steps = [];
  for (const entries of [meeting.debate, meeting.findings]) {
    for (const value of Object.values(typeof entries === 'object' && entries ? entries : {})) {
      for (const fragment of splitMeetingSummaryFragments(value?.content || '')) {
        if (!actionPattern.test(fragment)) continue;
        const normalized = fragment.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        steps.push(`- ${truncateMeetingSummary(fragment, 180)}`);
        if (steps.length >= 3) return steps;
      }
    }
  }
  return steps.length
    ? steps
    : ['- Review the findings and debate, then add a human-written conclusion if more nuance is needed.'];
}

function buildTimedOutMeetingConclusion(meeting, agents) {
  const findingsCount = Object.keys(meeting.findings || {}).length;
  const debateCount = Object.keys(meeting.debate || {}).length;
  const findingsHighlights = formatMeetingSummaryBullets(meeting.findings, agents, '(none)', 180);
  const debateTakeaways = collectMeetingTakeaways(meeting.debate, agents, 4);
  const fallbackDebate = formatMeetingSummaryBullets(meeting.debate, agents, '(none)', 180);
  const nextSteps = collectMeetingNextSteps(meeting);
  return `*Auto-generated — conclusion round timed out.*\n\nThis summary is based on ${findingsCount} finding${findingsCount === 1 ? '' : 's'} and ${debateCount} debate response${debateCount === 1 ? '' : 's'}.\n\n## Findings Highlights\n${findingsHighlights.join('\n')}\n\n## Debate Takeaways\n${(debateTakeaways.length ? debateTakeaways : fallbackDebate).join('\n')}\n\n## Recommended Next Steps\n${nextSteps.join('\n')}`;
}

function writeMeetingTranscriptToInbox(meeting, meetingId, agents) {
  try {
    const transcript = meeting.transcript.map(t =>
      `### ${agents[t.agent]?.name || t.agent} (${t.type}, Round ${t.round})\n\n${t.content}`
    ).join('\n\n---\n\n');
    shared.writeToInbox('meeting', meetingId, `# Meeting Transcript: ${meeting.title}\n\n${transcript}`);
  } catch (e) { log('warn', `Meeting ${meetingId} inbox write: ${e.message}`); }
}

function getMeetings() {
  if (!fs.existsSync(MEETINGS_DIR)) return [];
  return fs.readdirSync(MEETINGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => safeJson(path.join(MEETINGS_DIR, f)))
    .filter(Boolean);
}

function getMeeting(id) {
  const filePath = path.join(MEETINGS_DIR, id + '.json');
  const m = safeJson(filePath);
  if (m) {
    if (!m.findings) m.findings = {};
    if (!m.debate) m.debate = {};
    if (!m.humanNotes) m.humanNotes = [];
    if (!m.participants) m.participants = [];
    if (!m.transcript) m.transcript = [];
    if (!m.roundFailures || typeof m.roundFailures !== 'object') m.roundFailures = {};
  }
  return m;
}

/**
 * Read-modify-write helper for meetings/<id>.json under a file lock.
 *
 * Mirrors the mutateDispatch / mutateWorkItems / mutatePullRequests pattern.
 * Use this for ANY change to a meeting's persisted state — bare safeWrite
 * losses concurrent agent findings (every meeting round writes from a
 * separate agent process).
 *
 * `fn` receives the parsed meeting object (with default fields populated like
 * getMeeting), or `null` when the file is absent. Return the mutated meeting
 * to persist it; return `null`/`undefined` to skip the write (the underlying
 * mutateJsonFileLocked handles the no-op via skipWriteIfUnchanged).
 *
 * CRITICAL: keep `fn` fast. Never spawn agents, kill processes, run git
 * commands, or `await` inside the callback — the lock is held for the
 * duration of the synchronous call. Do that work BEFORE or AFTER mutateMeeting.
 */
function mutateMeeting(id, fn) {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });
  const filePath = path.join(MEETINGS_DIR, id + '.json');
  let userResult;
  shared.mutateJsonFileLocked(filePath, (data) => {
    const isMeeting = data && typeof data === 'object' && !Array.isArray(data) && data.id;
    const meeting = isMeeting ? data : null;
    if (meeting) {
      // Match getMeeting()'s default-field normalization.
      if (!meeting.findings) meeting.findings = {};
      if (!meeting.debate) meeting.debate = {};
      if (!meeting.humanNotes) meeting.humanNotes = [];
      if (!meeting.participants) meeting.participants = [];
      if (!meeting.transcript) meeting.transcript = [];
      if (!meeting.roundFailures || typeof meeting.roundFailures !== 'object') meeting.roundFailures = {};
    }
    userResult = fn(meeting);
    if (userResult === undefined || userResult === null) {
      // Skip-write: return original data so JSON.stringify equality holds
      // and mutateJsonFileLocked's skipWriteIfUnchanged guard takes effect.
      return data;
    }
    return userResult;
  }, { defaultValue: {}, skipWriteIfUnchanged: true });
  return userResult === undefined ? null : userResult;
}

/**
 * Persist a meeting object as-is. Thin wrapper over mutateMeeting so every
 * write goes through the file lock — covers the create-new-file path
 * (createMeeting) and any tests that pre-seed meeting state.
 */
function saveMeeting(meeting) {
  return mutateMeeting(meeting.id, () => meeting);
}

function createMeeting({ title, agenda, participants }) {
  const id = 'MTG-' + uid();
  const meeting = {
    id, title, agenda,
    status: 'investigating',
    round: 1,
    participants: participants || [],
    createdBy: 'human',
    createdAt: ts(),
    roundStartedAt: ts(),
    findings: {},
    debate: {},
    conclusion: null,
    humanNotes: [],
    roundFailures: {},
    transcript: [],
  };
  saveMeeting(meeting);
  return meeting;
}

/**
 * Discover meeting work items for the current round.
 * Called from discoverWork() in engine.js tick cycle.
 */
function discoverMeetingWork(config) {
  const meetings = getMeetings();
  const work = [];
  const dispatch = getDispatch();
  const activeKeys = new Set(
    [...(dispatch.pending || []), ...(dispatch.active || [])]
      .map(d => d.meta?.dispatchKey)
      .filter(Boolean)
  );

  for (const meeting of meetings) {
    if (isTerminalMeetingStatus(meeting.status)) continue;

    const round = meeting.round || 1;
    const roundName = meeting.status; // investigating, debating, concluding
    if (!ACTIVE_MEETING_STATUSES.has(roundName)) continue;
    const agents = config.agents || {};

    // Pre-flight validation: meetings missing required template vars (agenda)
    // would otherwise fail playbook rendering on every tick (~1/min), spamming
    // log.json with the same "missing required template variables: agenda"
    // error. Skip them silently here; emit one structured warning per meeting
    // ID per process so the operator still has signal without the spam.
    if (!meeting.agenda || !String(meeting.agenda).trim()) {
      _warnOnceMissingAgenda(meeting.id);
      continue;
    }

    if (roundName === 'concluding') {
      // Only one agent should conclude — skip if already concluded or any conclude dispatch is active
      if (meeting.conclusion) continue;
      const concludePrefix = `meeting-${meeting.id}-r${round}-`;
      if ([...activeKeys].some(k => k.startsWith(concludePrefix))) continue;

      // Pick the first non-busy participant as concluder (fallback to any participant)
      const busyAgents = new Set(
        (dispatch.active || []).map(d => d.agent).filter(Boolean)
      );
      const concluder = meeting.participants.find(p => !busyAgents.has(p))
        || meeting.participants[0];
      if (!concluder) continue;
      const key = `${concludePrefix}${concluder}`;
      if (activeKeys.has(key)) continue;

      const humanNotes = truncateMeetingContext(
        (Array.isArray(meeting.humanNotes) ? meeting.humanNotes : []).map(n => '- ' + n).join('\n'),
        ENGINE_DEFAULTS.maxMeetingHumanNotesBytes,
        'human meeting notes'
      );
      const allFindings = formatMeetingContributions(
        meeting.findings,
        agents,
        '(no findings)',
        'meeting findings',
        ENGINE_DEFAULTS.maxMeetingPromptBytes
      );
      const allDebate = formatMeetingContributions(
        meeting.debate,
        agents,
        '(no response)',
        'meeting debate',
        ENGINE_DEFAULTS.maxMeetingPromptBytes
      );

      const vars = {
        agent_name: agents[concluder]?.name || concluder,
        agent_role: agents[concluder]?.role || 'Agent',
        agent_id: concluder,
        meeting_title: meeting.title,
        agenda: meeting.agenda,
        all_findings: allFindings,
        all_debate: allDebate,
        human_notes: humanNotes,
      };

      const prompt = renderPlaybook('meeting-conclude', vars);
      if (!prompt) continue;

      work.push({
        type: WORK_TYPE.MEETING,
        agent: concluder,
        agentName: agents[concluder]?.name || concluder,
        agentRole: agents[concluder]?.role || 'Agent',
        task: `Meeting: ${meeting.title} (Conclude)`,
        prompt,
        meta: {
          dispatchKey: key,
          source: 'meeting',
          meetingId: meeting.id,
          round,
          roundName: 'conclude',
        }
      });
      continue;
    }

    // For investigate and debate rounds, dispatch all participants
    for (const agentId of meeting.participants) {
      // Skip if already submitted for this round
      if (roundName === 'investigating' && meeting.findings?.[agentId]) continue;
      if (roundName === 'debating' && meeting.debate?.[agentId]) continue;
      const dispatchRoundName = roundName === 'investigating' ? 'investigate' : 'debate';
      if (hasRoundFailure(meeting, dispatchRoundName, agentId, round)) continue;

      const key = `meeting-${meeting.id}-r${round}-${agentId}`;
      if (activeKeys.has(key)) continue;

      const humanNotes = truncateMeetingContext(
        (meeting.humanNotes || []).map(n => '- ' + n).join('\n'),
        ENGINE_DEFAULTS.maxMeetingHumanNotesBytes,
        'human meeting notes'
      );
      const vars = {
        agent_name: agents[agentId]?.name || agentId,
        agent_role: agents[agentId]?.role || 'Agent',
        agent_id: agentId,
        meeting_title: meeting.title,
        agenda: meeting.agenda,
        human_notes: humanNotes,
      };

      if (roundName === 'debating') {
        vars.all_findings = formatMeetingContributions(
          meeting.findings,
          agents,
          '(no findings)',
          'meeting findings',
          ENGINE_DEFAULTS.maxMeetingPromptBytes
        );
      }

      const playbookName = roundName === 'investigating' ? 'meeting-investigate' : 'meeting-debate';
      const prompt = renderPlaybook(playbookName, vars);
      if (!prompt) continue;

      work.push({
        type: WORK_TYPE.MEETING,
        agent: agentId,
        agentName: agents[agentId]?.name || agentId,
        agentRole: agents[agentId]?.role || 'Agent',
        task: `Meeting: ${meeting.title} (Round ${round} — ${roundName})`,
        prompt,
        meta: {
          dispatchKey: key,
          source: 'meeting',
          meetingId: meeting.id,
          round,
          roundName: dispatchRoundName,
        }
      });
    }
  }
  return work;
}

/**
 * Collect findings from a completed meeting agent.
 * Called from runPostCompletionHooks when type === 'meeting'.
 */
function collectMeetingFindings(meetingId, agentId, roundName, output, structuredCompletion = null, expectedRound = null, completionInfo = {}) {
  // Resolve content OUTSIDE the lock — file reads (note artifacts) and stream
  // parsing are slow and lock callbacks must stay fast.
  const content = resolveMeetingContributionContent(output, structuredCompletion);
  const completionSucceeded = completionInfo?.success !== false;

  let concludedMeeting = null;
  let configForInbox = null;

  mutateMeeting(meetingId, (meeting) => {
    if (!meeting) return null; // file missing — nothing to do
    if (isTerminalMeetingStatus(meeting.status)) {
      log('info', `Ignoring late findings from ${agentId} for completed meeting ${meetingId}`);
      return null;
    }

    const expectedStatus = expectedMeetingStatusForRound(roundName);
    if (!expectedStatus) {
      log('warn', `Meeting ${meetingId}: ignoring ${agentId} output for unknown round "${roundName || '(empty)'}"`);
      return null;
    }
    if (meeting.status !== expectedStatus) {
      log('info', `Ignoring stale ${roundName} output from ${agentId} for meeting ${meetingId} currently ${meeting.status}`);
      return null;
    }
    if (expectedRound !== null && expectedRound !== undefined && Number(meeting.round || 1) !== Number(expectedRound)) {
      log('info', `Ignoring stale round ${expectedRound} output from ${agentId} for meeting ${meetingId} currently on round ${meeting.round || 1}`);
      return null;
    }
    if (hasRoundTerminalOutcome(meeting, roundName, agentId, meeting.round)) {
      log('info', `Ignoring duplicate ${roundName} output from ${agentId} for meeting ${meetingId}`);
      return null;
    }

    if (!completionSucceeded || isEmptyMeetingContent(content)) {
      const failures = getRoundFailures(meeting, roundName, meeting.round, true);
      const reason = !completionSucceeded
        ? (completionInfo?.reason || completionInfo?.completionStatus || 'Agent failed before completing the meeting round')
        : 'Agent produced empty meeting output';
      failures[agentId] = {
        reason,
        content: content || completionInfo?.summary || '',
        submittedAt: ts(),
      };
      meeting.transcript.push({
        round: meeting.round,
        agent: agentId,
        type: 'failure',
        content: reason,
        at: ts(),
      });
      log('warn', `Meeting ${meetingId}: agent ${agentId} failed ${roundName} — ${reason}`);
      advanceMeetingIfRoundComplete(meeting, roundName, meetingId);
      return meeting;
    }

    if (roundName === 'investigate') {
      meeting.findings[agentId] = { content, submittedAt: ts() };
      meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'finding', content, at: ts() });
    } else if (roundName === 'debate') {
      meeting.debate[agentId] = { content, submittedAt: ts() };
      meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'debate', content, at: ts() });
    } else if (roundName === 'conclude') {
      meeting.conclusion = { content, agent: agentId, submittedAt: ts() };
      meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'conclusion', content, at: ts() });
      meeting.status = 'completed';
      meeting.completedAt = ts();
      // Defer inbox write until AFTER the lock releases — writeToInbox hits
      // the filesystem (slug dedup, write) and must not block other writers.
      concludedMeeting = meeting;
      try { configForInbox = queries.getConfig(); } catch { configForInbox = { agents: {} }; }
      return meeting;
    }

    advanceMeetingIfRoundComplete(meeting, roundName, meetingId);
    return meeting;
  });

  if (concludedMeeting) {
    try {
      writeMeetingTranscriptToInbox(concludedMeeting, meetingId, (configForInbox && configForInbox.agents) || {});
    } catch (e) { log('warn', `Meeting ${meetingId} inbox write: ${e.message}`); }
    log('info', `Meeting ${meetingId} completed — transcript written to inbox`);
  }
}

function addMeetingNote(meetingId, note) {
  return mutateMeeting(meetingId, (meeting) => {
    if (!meeting) return null;
    meeting.humanNotes.push(note);
    meeting.transcript.push({ round: meeting.round, agent: 'human', type: 'note', content: note, at: ts() });
    return meeting;
  });
}

function _killMeetingDispatches(meetingId) {
  try {
    const DISPATCH_PATH = path.join(shared.MINIONS_DIR, 'engine', 'dispatch.json');
    const tmpDir = path.join(shared.MINIONS_DIR, 'engine', 'tmp');
    const entriesToStop = [];
    const filesToDelete = [];
    shared.mutateJsonFileLocked(DISPATCH_PATH, (dp) => {
      dp.pending = Array.isArray(dp.pending) ? dp.pending : [];
      dp.active = Array.isArray(dp.active) ? dp.active : [];
      dp.completed = Array.isArray(dp.completed) ? dp.completed : [];

      for (const queue of ['pending', 'active']) {
        const kept = [];
        for (const d of dp[queue]) {
          if (d.meta?.meetingId !== meetingId) {
            kept.push(d);
            continue;
          }
          entriesToStop.push(d);
          filesToDelete.push(path.join(tmpDir, `pid-${d.id}.pid`));
          filesToDelete.push(path.join(tmpDir, `prompt-${d.id}.md`));
          filesToDelete.push(path.join(tmpDir, `sysprompt-${d.id}.md`));
          filesToDelete.push(path.join(tmpDir, `sysprompt-${d.id}.md.tmp`));
        }
        dp[queue] = kept;
      }

      for (const d of entriesToStop) {
        dp.completed.push({ ...d, result: DISPATCH_RESULT.ERROR, reason: 'Meeting ended/advanced by human', completed_at: ts() });
      }
      if (dp.completed.length > 100) dp.completed = dp.completed.slice(-100);
      return dp;
    }, { defaultValue: { pending: [], active: [], completed: [] } });

    const pidsToKill = [];
    for (const d of entriesToStop) {
      try {
        const pidFile = path.join(tmpDir, `pid-${d.id}.pid`);
        const pid = shared.validatePid(fs.readFileSync(pidFile, 'utf8').trim());
        pidsToKill.push(pid);
      } catch { /* pending entries and already-finished agents may not have PID files */ }
    }
    for (const pid of pidsToKill) {
      try { shared.killGracefully({ pid }); } catch { /* process may already be dead */ }
    }
    for (const fp of filesToDelete) {
      try { fs.unlinkSync(fp); } catch { /* sidecar may not exist */ }
    }

    if (entriesToStop.length > 0) log('info', `Killed ${entriesToStop.length} meeting dispatch(es) for ${meetingId}`);
    return entriesToStop.length;
  } catch (e) { log('warn', 'kill meeting dispatches: ' + e.message); return 0; }
}

function advanceMeetingRound(meetingId) {
  // Pre-check (read-only) so we don't kill dispatches for a meeting that's
  // already terminal. The authoritative status check still runs INSIDE the
  // lock below.
  const existing = getMeeting(meetingId);
  if (!existing || existing.status === 'completed' || existing.status === 'archived') return null;

  // CRITICAL: kill BEFORE acquiring the meeting lock. _killMeetingDispatches
  // takes the dispatch.json lock and shells out to kill processes — never
  // run that under the meeting lock (per CLAUDE.md, lock callbacks must
  // stay fast and never spawn / kill / await).
  _killMeetingDispatches(meetingId);

  return mutateMeeting(meetingId, (meeting) => {
    if (!meeting || meeting.status === 'completed' || meeting.status === 'archived') return null;
    if (meeting.status === 'investigating') { meeting.status = 'debating'; meeting.round = 2; }
    else if (meeting.status === 'debating') { meeting.status = 'concluding'; meeting.round = 3; }
    else if (meeting.status === 'concluding') { meeting.status = 'completed'; meeting.completedAt = ts(); }
    else return meeting; // unknown active status — no state change, but report current
    meeting.roundStartedAt = ts();
    return meeting;
  });
}

function endMeeting(meetingId) {
  // See advanceMeetingRound — kill happens BEFORE the meeting lock so dispatch
  // teardown / process kills never run inside our lock callback.
  const existing = getMeeting(meetingId);
  if (!existing) return null;
  _killMeetingDispatches(meetingId);

  return mutateMeeting(meetingId, (meeting) => {
    if (!meeting) return null;
    meeting.status = 'completed';
    meeting.completedAt = ts();
    return meeting;
  });
}

function archiveMeeting(id) {
  return mutateMeeting(id, (meeting) => {
    if (!meeting) return null;
    meeting.status = 'archived';
    meeting.archivedAt = ts();
    return meeting;
  });
}

function unarchiveMeeting(id) {
  return mutateMeeting(id, (meeting) => {
    if (!meeting || meeting.status !== 'archived') return null;
    meeting.status = 'completed';
    delete meeting.archivedAt;
    return meeting;
  });
}

function deleteMeeting(id) {
  _killMeetingDispatches(id);
  const filePath = path.join(MEETINGS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  // mutateMeeting writes a .backup sidecar; safeJson auto-restores from it
  // when the primary is missing, so deletion must also drop the backup.
  try { fs.unlinkSync(filePath + '.backup'); } catch { /* sidecar may not exist */ }
  return true;
}

/**
 * Check for meeting rounds that have exceeded the timeout.
 * Timeout is observational: rounds advance only after every participant has
 * succeeded or failed, and conclusion waits for the conclusion agent outcome.
 * Called from engine.js tick cycle.
 */
function checkMeetingTimeouts(config) {
  const meetings = getMeetings();
  const timeout = (config.engine || {}).meetingRoundTimeout
    || ENGINE_DEFAULTS.meetingRoundTimeout;
  const hardTimeout = (config.engine || {}).meetingRoundHardTimeout
    || ENGINE_DEFAULTS.meetingRoundHardTimeout;

  for (const snapshot of meetings) {
    if (isTerminalMeetingStatus(snapshot.status)) continue;
    if (!ACTIVE_MEETING_STATUSES.has(snapshot.status)) continue;
    if (!snapshot.roundStartedAt) continue;

    const roundStartedMs = new Date(snapshot.roundStartedAt).getTime();
    if (!Number.isFinite(roundStartedMs)) continue;
    const elapsed = Date.now() - roundStartedMs;
    if (elapsed < timeout) continue;

    // Re-evaluate the timeout transition under the file lock to avoid lost
    // updates if an agent finalised mid-tick. Helpers (advanceMeetingIfRoundComplete
    // etc.) operate on the locked-and-rehydrated meeting object.
    mutateMeeting(snapshot.id, (meeting) => {
      if (!meeting) return null;
      if (isTerminalMeetingStatus(meeting.status)) return null;
      if (!ACTIVE_MEETING_STATUSES.has(meeting.status)) return null;
      // Use the latest roundStartedAt — the round may have advanced inside
      // a concurrent collectMeetingFindings call between snapshot and lock.
      const liveStartedMs = new Date(meeting.roundStartedAt || 0).getTime();
      if (!Number.isFinite(liveStartedMs)) return null;
      const liveElapsed = Date.now() - liveStartedMs;
      if (liveElapsed < timeout) return null;

      const respondedCount = meeting.status === 'investigating'
        ? Object.keys(meeting.findings || {}).length
        : meeting.status === 'debating'
          ? Object.keys(meeting.debate || {}).length
          : 0;
      const totalCount = meeting.participants.length;

      const roundName = meeting.status === 'investigating'
        ? 'investigate'
        : meeting.status === 'debating'
          ? 'debate'
          : 'conclude';

      if (roundName !== 'conclude') {
        if (allParticipantsFinishedRound(meeting, roundName, meeting.round)) {
          log('warn', `Meeting ${meeting.id}: round ${meeting.round} timed out after ${Math.round(liveElapsed / 60000)}min but all participants are terminal — advancing`);
          meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round ${meeting.round} timed out after all participants finished`, at: ts() });
          advanceMeetingIfRoundComplete(meeting, roundName, meeting.id, config);
          return meeting;
        } else if (liveElapsed >= hardTimeout) {
          const failures = getRoundFailures(meeting, roundName, meeting.round, true);
          const stalled = (meeting.participants || []).filter(p => !hasRoundTerminalOutcome(meeting, roundName, p, meeting.round));
          const reason = `Hard meeting timeout after ${Math.round(liveElapsed / 60000)}min — agent did not produce ${roundName} output`;
          for (const agentId of stalled) {
            failures[agentId] = { reason, content: '', submittedAt: ts() };
            meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'failure', content: reason, at: ts() });
          }
          log('warn', `Meeting ${meeting.id}: round ${meeting.round} hit hard timeout after ${Math.round(liveElapsed / 60000)}min — marking ${stalled.length}/${totalCount} non-responders as failed and advancing`);
          meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round ${meeting.round} hard timeout — ${stalled.length} non-responder(s) marked failed`, at: ts() });
          advanceMeetingIfRoundComplete(meeting, roundName, meeting.id, config);
          return meeting;
        } else {
          log('warn', `Meeting ${meeting.id}: round ${meeting.round} timed out after ${Math.round(liveElapsed / 60000)}min — waiting for all participants to finish (${respondedCount}/${totalCount} succeeded)`);
          return null; // observational only — no state change
        }
      } else if (meeting.status === 'concluding') {
        if (liveElapsed >= hardTimeout) {
          const reason = `Hard meeting timeout after ${Math.round(liveElapsed / 60000)}min — conclusion agent did not produce output`;
          const failures = getRoundFailures(meeting, 'conclude', meeting.round, true);
          const conclusionAgent = (meeting.participants || []).find(p => !hasRoundTerminalOutcome(meeting, 'conclude', p, meeting.round)) || meeting.participants?.[0] || 'system';
          failures[conclusionAgent] = { reason, content: '', submittedAt: ts() };
          meeting.transcript.push({ round: meeting.round, agent: conclusionAgent, type: 'failure', content: reason, at: ts() });
          log('warn', `Meeting ${meeting.id}: conclusion round hit hard timeout after ${Math.round(liveElapsed / 60000)}min — synthesising fallback conclusion`);
          advanceMeetingIfRoundComplete(meeting, 'conclude', meeting.id, config);
          return meeting;
        } else {
          log('warn', `Meeting ${meeting.id}: conclusion round timed out after ${Math.round(liveElapsed / 60000)}min — waiting for the conclusion agent to finish`);
          return null;
        }
      }
      return null;
    });
  }
}
module.exports = {
  MEETINGS_DIR, getMeetings, getMeeting, saveMeeting, mutateMeeting, createMeeting,
  discoverMeetingWork, collectMeetingFindings, checkMeetingTimeouts,
  addMeetingNote, advanceMeetingRound, endMeeting, archiveMeeting, unarchiveMeeting, deleteMeeting,
  EMPTY_OUTPUT_PATTERNS,
  // exported for testing — engine code MUST go through
  // getMeetings/discoverMeetingWork/collectMeetingFindings/checkMeetingTimeouts,
  // never these helpers directly.
  isPathInside,
  resolveMeetingNoteArtifactPath,
  cleanMeetingSummaryText,
  splitMeetingSummaryFragments,
  truncateMeetingSummary,
  formatMeetingSummaryBullets,
  scoreMeetingTakeaway,
  collectMeetingTakeaways,
  collectMeetingNextSteps,
  buildTimedOutMeetingConclusion,
  _resetMissingAgendaWarnings, // exported for testing only
};
