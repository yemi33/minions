/**
 * engine/meeting.js — Team meeting orchestration.
 * Manages multi-round meetings: investigate → debate → conclude.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeJson, safeWrite, safeRead, uid, log, ts, ENGINE_DEFAULTS, WORK_TYPE, DISPATCH_RESULT } = shared;
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
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
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

function cleanMeetingSummaryText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[#>*-]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitMeetingSummaryFragments(text) {
  return cleanMeetingSummaryText(text)
    .split(/\n+|(?:[.!?])\s+|;\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function truncateMeetingSummary(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
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
  const lower = fragment.toLowerCase();
  let score = 0;
  if (/(should|must|need to|needs to|recommend|recommended|action|next step|follow up|fix|mitigat|investigat|verify|test|block)/.test(lower)) score += 4;
  if (/(agree|aligned|consensus|support|prefer)/.test(lower)) score += 3;
  if (/(disagree|however|but|risk|risky|concern|trade-off|question|uncertain|worry)/.test(lower)) score += 3;
  if (fragment.length >= 40 && fragment.length <= 180) score += 2;
  if (fragment.length > 220) score -= 1;
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
  return ['- Review the findings and debate, then add a human-written conclusion if more nuance is needed.'];
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
  }
  return m;
}

function saveMeeting(meeting) {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });
  safeWrite(path.join(MEETINGS_DIR, meeting.id + '.json'), meeting);
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
    if (meeting.status === 'completed') continue;

    const round = meeting.round || 1;
    const roundName = meeting.status; // investigating, debating, concluding
    const agents = config.agents || {};

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
          roundName: roundName === 'investigating' ? 'investigate' : 'debate',
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
function collectMeetingFindings(meetingId, agentId, roundName, output, structuredCompletion = null) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;
  if (meeting.status === 'completed' || meeting.status === 'archived') {
    log('info', `Ignoring late findings from ${agentId} for completed meeting ${meetingId}`);
    return;
  }

  const content = resolveMeetingContributionContent(output, structuredCompletion);

  // Validate output — reject empty or placeholder responses
  if (isEmptyMeetingContent(content)) {
    log('warn', `Meeting ${meetingId}: agent ${agentId} returned empty output for ${roundName} — rejecting`);
    // Don't record it — agent will be re-dispatched on next tick
    saveMeeting(meeting);
    return;
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

    // Write transcript to inbox so agents learn from it (slug-based dedup)
    try {
      const config = queries.getConfig();
      const agents = config.agents || {};
      const transcript = meeting.transcript.map(t =>
        `### ${agents[t.agent]?.name || t.agent} (${t.type}, Round ${t.round})\n\n${t.content}`
      ).join('\n\n---\n\n');
      shared.writeToInbox('meeting', meetingId, `# Meeting Transcript: ${meeting.title}\n\n${transcript}`);
    } catch (e) { log('warn', `Meeting ${meetingId} inbox write: ${e.message}`); }

    log('info', `Meeting ${meetingId} completed — transcript written to inbox`);
    saveMeeting(meeting);
    return;
  }

  // Check if all participants have submitted for this round
  const participantCount = meeting.participants.length;
  const allSubmitted =
    (meeting.status === 'investigating' && Object.keys(meeting.findings || {}).length >= participantCount) ||
    (meeting.status === 'debating' && Object.keys(meeting.debate || {}).length >= participantCount);

  if (allSubmitted) {
    // Advance to next round
    if (meeting.status === 'investigating') {
      meeting.status = 'debating';
      meeting.round = 2;
      meeting.roundStartedAt = ts();
      log('info', `Meeting ${meetingId}: all findings in — advancing to debate`);
    } else if (meeting.status === 'debating') {
      meeting.status = 'concluding';
      meeting.round = 3;
      meeting.roundStartedAt = ts();
      log('info', `Meeting ${meetingId}: all debate responses in — advancing to conclusion`);
    }
  }

  saveMeeting(meeting);
}

function addMeetingNote(meetingId, note) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return null;
  meeting.humanNotes.push(note);
  meeting.transcript.push({ round: meeting.round, agent: 'human', type: 'note', content: note, at: ts() });
  saveMeeting(meeting);
  return meeting;
}

function _killMeetingDispatches(meetingId) {
  try {
    const DISPATCH_PATH = path.join(shared.MINIONS_DIR, 'engine', 'dispatch.json');
    const dispatch = safeJson(DISPATCH_PATH) || {};
    const toKill = (dispatch.active || []).filter(d => d.meta?.meetingId === meetingId);
    if (toKill.length === 0) return 0;
    // Remove from active and move to completed
    shared.mutateJsonFileLocked(DISPATCH_PATH, (dp) => {
      dp.active = (dp.active || []).filter(d => d.meta?.meetingId !== meetingId);
      dp.completed = dp.completed || [];
      for (const d of toKill) {
        dp.completed.push({ ...d, result: DISPATCH_RESULT.ERROR, reason: 'Meeting ended/advanced by human', completed_at: ts() });
      }
      if (dp.completed.length > 100) dp.completed = dp.completed.slice(-100);
      return dp;
    }, { defaultValue: { pending: [], active: [], completed: [] } });
    log('info', `Killed ${toKill.length} active meeting dispatch(es) for ${meetingId}`);
    return toKill.length;
  } catch (e) { log('warn', 'kill meeting dispatches: ' + e.message); return 0; }
}

function advanceMeetingRound(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting || meeting.status === 'completed' || meeting.status === 'archived') return null;
  _killMeetingDispatches(meetingId);
  if (meeting.status === 'investigating') { meeting.status = 'debating'; meeting.round = 2; }
  else if (meeting.status === 'debating') { meeting.status = 'concluding'; meeting.round = 3; }
  else if (meeting.status === 'concluding') { meeting.status = 'completed'; meeting.completedAt = ts(); }
  else return meeting; // no change
  meeting.roundStartedAt = ts();
  saveMeeting(meeting);
  return meeting;
}

function endMeeting(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return null;
  _killMeetingDispatches(meetingId);
  meeting.status = 'completed';
  meeting.completedAt = ts();
  saveMeeting(meeting);
  return meeting;
}

function archiveMeeting(id) {
  const meeting = getMeeting(id);
  if (!meeting) return null;
  meeting.status = 'archived';
  meeting.archivedAt = ts();
  saveMeeting(meeting);
  return meeting;
}

function unarchiveMeeting(id) {
  const meeting = getMeeting(id);
  if (!meeting || meeting.status !== 'archived') return null;
  meeting.status = 'completed';
  delete meeting.archivedAt;
  saveMeeting(meeting);
  return meeting;
}

function deleteMeeting(id) {
  _killMeetingDispatches(id);
  const filePath = path.join(MEETINGS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Check for meeting rounds that have exceeded the timeout.
 * Auto-advances to the next round with whatever responses were received.
 * Called from engine.js tick cycle.
 */
function checkMeetingTimeouts(config) {
  const meetings = getMeetings();
  const timeout = (config.engine || {}).meetingRoundTimeout
    || ENGINE_DEFAULTS.meetingRoundTimeout;

  for (const meeting of meetings) {
    if (meeting.status === 'completed') continue;
    if (!meeting.roundStartedAt) continue;

    const elapsed = Date.now() - new Date(meeting.roundStartedAt).getTime();
    if (elapsed < timeout) continue;

    const respondedCount = meeting.status === 'investigating'
      ? Object.keys(meeting.findings || {}).length
      : meeting.status === 'debating'
        ? Object.keys(meeting.debate || {}).length
        : 0;
    const totalCount = meeting.participants.length;

    if (meeting.status === 'investigating') {
      log('warn', `Meeting ${meeting.id}: round 1 timed out after ${Math.round(elapsed / 60000)}min — ${respondedCount}/${totalCount} responded, advancing to debate`);
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round 1 timed out — ${respondedCount}/${totalCount} findings received`, at: ts() });
      meeting.status = 'debating';
      meeting.round = 2;
      meeting.roundStartedAt = ts();
      saveMeeting(meeting);
    } else if (meeting.status === 'debating') {
      log('warn', `Meeting ${meeting.id}: round 2 timed out after ${Math.round(elapsed / 60000)}min — ${respondedCount}/${totalCount} responded, advancing to conclusion`);
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round 2 timed out — ${respondedCount}/${totalCount} debate responses received`, at: ts() });
      meeting.status = 'concluding';
      meeting.round = 3;
      meeting.roundStartedAt = ts();
      saveMeeting(meeting);
    } else if (meeting.status === 'concluding') {
      log('warn', `Meeting ${meeting.id}: conclusion round timed out after ${Math.round(elapsed / 60000)}min — auto-summarizing`);
      const autoConclusion = buildTimedOutMeetingConclusion(meeting, config.agents || {});
      meeting.conclusion = { content: autoConclusion, agent: 'system', submittedAt: ts() };
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'conclusion', content: autoConclusion, at: ts() });
      meeting.status = 'completed';
      meeting.completedAt = ts();

      // Write transcript to inbox (same as normal conclusion path)
      try {
        const agents = config.agents || {};
        const transcript = meeting.transcript.map(t =>
          `### ${agents[t.agent]?.name || t.agent} (${t.type}, Round ${t.round})\n\n${t.content}`
        ).join('\n\n---\n\n');
        shared.writeToInbox('meeting', meeting.id, `# Meeting Transcript: ${meeting.title}\n\n${transcript}`);
      } catch (e) { log('warn', `Meeting ${meeting.id} inbox write: ${e.message}`); }

      saveMeeting(meeting);
    }
  }
}
module.exports = {
  MEETINGS_DIR, getMeetings, getMeeting, saveMeeting, createMeeting,
  discoverMeetingWork, collectMeetingFindings, checkMeetingTimeouts,
  addMeetingNote, advanceMeetingRound, endMeeting, archiveMeeting, unarchiveMeeting, deleteMeeting,
  EMPTY_OUTPUT_PATTERNS,
};
