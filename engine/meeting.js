/**
 * engine/meeting.js — Team meeting orchestration.
 * Manages multi-round meetings: investigate → debate → conclude.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const { safeJson, safeWrite, safeRead, uid, log, ENGINE_DEFAULTS } = shared;
const queries = require('./queries');
const { getDispatch, getConfig } = queries;
const { renderPlaybook } = require('./playbook');

/** Patterns that indicate an agent returned no meaningful output */
const EMPTY_OUTPUT_PATTERNS = ['(no output)', '(no findings)', '(no response)'];

// No lazy require needed — log comes from shared.js, no engine-specific APIs used

const MEETINGS_DIR = path.join(__dirname, '..', 'meetings');

function getMeetings() {
  if (!fs.existsSync(MEETINGS_DIR)) return [];
  return fs.readdirSync(MEETINGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => safeJson(path.join(MEETINGS_DIR, f)))
    .filter(Boolean);
}

function getMeeting(id) {
  const filePath = path.join(MEETINGS_DIR, id + '.json');
  return safeJson(filePath);
}

function saveMeeting(meeting) {
  if (!fs.existsSync(MEETINGS_DIR)) fs.mkdirSync(MEETINGS_DIR, { recursive: true });
  safeWrite(path.join(MEETINGS_DIR, meeting.id + '.json'), meeting);
}

function createMeeting({ title, agenda, participants }) {
  const id = 'MTG-' + uid().slice(0, 8);
  const meeting = {
    id, title, agenda,
    status: 'investigating',
    round: 1,
    participants: participants || [],
    createdBy: 'human',
    createdAt: new Date().toISOString(),
    roundStartedAt: new Date().toISOString(),
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
      // Only one agent concludes (first participant)
      const concluder = meeting.participants[0];
      if (!concluder) continue;
      const key = `meeting-${meeting.id}-r${round}-${concluder}`;
      if (activeKeys.has(key)) continue;

      const humanNotes = (meeting.humanNotes || []).map(n => '- ' + n).join('\n');
      const allFindings = Object.entries(meeting.findings || {}).map(([agent, f]) =>
        `### ${agents[agent]?.name || agent}\n\n${f.content || '(no findings)'}`
      ).join('\n\n---\n\n');
      const allDebate = Object.entries(meeting.debate || {}).map(([agent, d]) =>
        `### ${agents[agent]?.name || agent}\n\n${d.content || '(no response)'}`
      ).join('\n\n---\n\n');

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
        type: 'meeting',
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

      const humanNotes = (meeting.humanNotes || []).map(n => '- ' + n).join('\n');
      const vars = {
        agent_name: agents[agentId]?.name || agentId,
        agent_role: agents[agentId]?.role || 'Agent',
        agent_id: agentId,
        meeting_title: meeting.title,
        agenda: meeting.agenda,
        human_notes: humanNotes,
      };

      if (roundName === 'debating') {
        vars.all_findings = Object.entries(meeting.findings || {}).map(([agent, f]) =>
          `### ${agents[agent]?.name || agent}\n\n${f.content || '(no findings)'}`
        ).join('\n\n---\n\n');
      }

      const playbookName = roundName === 'investigating' ? 'meeting-investigate' : 'meeting-debate';
      const prompt = renderPlaybook(playbookName, vars);
      if (!prompt) continue;

      work.push({
        type: 'meeting',
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
function collectMeetingFindings(meetingId, agentId, roundName, output) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return;

  const { text } = shared.parseStreamJsonOutput(output, { maxTextLength: 50000 });
  const rawContent = (text || '').trim();

  // Validate output — reject empty or placeholder responses
  if (!rawContent || EMPTY_OUTPUT_PATTERNS.includes(rawContent)) {
    log('warn', `Meeting ${meetingId}: agent ${agentId} returned empty output for ${roundName} — rejecting`);
    // Don't record it — agent will be re-dispatched on next tick
    saveMeeting(meeting);
    return;
  }
  const content = rawContent;

  if (roundName === 'investigate') {
    meeting.findings[agentId] = { content, submittedAt: new Date().toISOString() };
    meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'finding', content, at: new Date().toISOString() });
  } else if (roundName === 'debate') {
    meeting.debate[agentId] = { content, submittedAt: new Date().toISOString() };
    meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'debate', content, at: new Date().toISOString() });
  } else if (roundName === 'conclude') {
    meeting.conclusion = { content, agent: agentId, submittedAt: new Date().toISOString() };
    meeting.transcript.push({ round: meeting.round, agent: agentId, type: 'conclusion', content, at: new Date().toISOString() });
    meeting.status = 'completed';
    meeting.completedAt = new Date().toISOString();

    // Write transcript to inbox so agents learn from it (slug-based dedup)
    const config = queries.getConfig();
    const agents = config.agents || {};
    const transcript = meeting.transcript.map(t =>
      `### ${agents[t.agent]?.name || t.agent} (${t.type}, Round ${t.round})\n\n${t.content}`
    ).join('\n\n---\n\n');
    shared.writeToInbox('meeting', meetingId, `# Meeting Transcript: ${meeting.title}\n\n${transcript}`);

    log('info', `Meeting ${meetingId} completed — transcript written to inbox`);
    saveMeeting(meeting);
    return;
  }

  // Check if all participants have submitted for this round
  const allSubmitted = meeting.participants.every(p => {
    if (meeting.status === 'investigating') return !!meeting.findings[p];
    if (meeting.status === 'debating') return !!meeting.debate[p];
    return true;
  });

  if (allSubmitted) {
    // Advance to next round
    if (meeting.status === 'investigating') {
      meeting.status = 'debating';
      meeting.round = 2;
      meeting.roundStartedAt = new Date().toISOString();
      log('info', `Meeting ${meetingId}: all findings in — advancing to debate`);
    } else if (meeting.status === 'debating') {
      meeting.status = 'concluding';
      meeting.round = 3;
      meeting.roundStartedAt = new Date().toISOString();
      log('info', `Meeting ${meetingId}: all debate responses in — advancing to conclusion`);
    }
  }

  saveMeeting(meeting);
}

function addMeetingNote(meetingId, note) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return null;
  meeting.humanNotes.push(note);
  meeting.transcript.push({ round: meeting.round, agent: 'human', type: 'note', content: note, at: new Date().toISOString() });
  saveMeeting(meeting);
  return meeting;
}

function advanceMeetingRound(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting || meeting.status === 'completed') return null;
  if (meeting.status === 'investigating') { meeting.status = 'debating'; meeting.round = 2; }
  else if (meeting.status === 'debating') { meeting.status = 'concluding'; meeting.round = 3; }
  meeting.roundStartedAt = new Date().toISOString();
  saveMeeting(meeting);
  return meeting;
}

function endMeeting(meetingId) {
  const meeting = getMeeting(meetingId);
  if (!meeting) return null;
  meeting.status = 'completed';
  meeting.completedAt = new Date().toISOString();
  saveMeeting(meeting);
  return meeting;
}

function archiveMeeting(id) {
  const meeting = getMeeting(id);
  if (!meeting) return null;
  meeting.status = 'archived';
  meeting.archivedAt = new Date().toISOString();
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
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round 1 timed out — ${respondedCount}/${totalCount} findings received`, at: new Date().toISOString() });
      meeting.status = 'debating';
      meeting.round = 2;
      meeting.roundStartedAt = new Date().toISOString();
      saveMeeting(meeting);
    } else if (meeting.status === 'debating') {
      log('warn', `Meeting ${meeting.id}: round 2 timed out after ${Math.round(elapsed / 60000)}min — ${respondedCount}/${totalCount} responded, advancing to conclusion`);
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: `Round 2 timed out — ${respondedCount}/${totalCount} debate responses received`, at: new Date().toISOString() });
      meeting.status = 'concluding';
      meeting.round = 3;
      meeting.roundStartedAt = new Date().toISOString();
      saveMeeting(meeting);
    } else if (meeting.status === 'concluding') {
      log('warn', `Meeting ${meeting.id}: conclusion round timed out after ${Math.round(elapsed / 60000)}min — ending meeting without conclusion`);
      meeting.transcript.push({ round: meeting.round, agent: 'system', type: 'timeout', content: 'Conclusion round timed out — meeting ended without conclusion', at: new Date().toISOString() });
      meeting.status = 'completed';
      meeting.completedAt = new Date().toISOString();
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
