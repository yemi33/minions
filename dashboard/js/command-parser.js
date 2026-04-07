// command-parser.js — Command parsing functions extracted from dashboard.html

let cmdAgents = []; // [{id, name, emoji, role}]
let cmdProjects = []; // [{name, description}]
let cmdMentionIdx = -1; // active mention autocomplete index

function cmdUpdateAgentList(agents) {
  cmdAgents = (agents || []).map(a => ({ id: a.id, name: a.name, emoji: a.emoji, role: a.role }));
}
function cmdUpdateProjectList(projects) {
  cmdProjects = (projects || []).map(p => ({ name: p.name, description: p.description || '' }));
}

function showToast(id, msg, ok, durationMs) {
  const el = document.getElementById(id);
  el.className = 'cmd-toast ' + (ok ? 'success' : 'error');
  if (msg.includes('<a ') || msg.includes('<strong>')) {
    el.innerHTML = msg;
  } else {
    el.textContent = msg;
  }
  setTimeout(() => { el.className = 'cmd-toast'; }, durationMs || (msg.includes('<a ') ? 15000 : 4000));
}

function detectWorkItemType(text) {
  const t = text.toLowerCase();
  const patterns = [
    { type: 'ask',      words: ['explain', 'why does', 'why is', 'what does', 'how do i', 'how do you', 'what\'s the', 'tell me', 'can you explain', 'walk me through'] },
    { type: 'explore',  words: ['explore', 'investigate', 'understand', 'analyze', 'audit', 'document', 'architecture', 'how does', 'what is', 'look into', 'research', 'survey', 'map out', 'codebase', 'make a note of', 'find out'] },
    { type: 'fix',      words: ['fix', 'bug', 'broken', 'crash', 'error', 'issue', 'patch', 'repair', 'resolve', 'regression', 'failing', 'doesn\'t work', 'not working'] },
    { type: 'review',   words: ['code review', 'check pr', 'look at pr', 'audit code', 'inspect', 'review pr', 'review pull request'] },
    { type: 'explore',  words: ['review the plan', 'review plan', 'review the design', 'review design', 'review the doc', 'look at the plan', 'check the plan', 'read the plan', 'review it', 'review this'] },
    { type: 'review',   words: ['review'] },
    { type: 'test',     words: ['test', 'write tests', 'add tests', 'unit test', 'e2e test', 'coverage', 'testing', 'build', 'run locally', 'localhost', 'start the', 'spin up', 'verify', 'check if it works'] },
  ];
  for (const { type, words } of patterns) {
    if (words.some(w => t.includes(w))) return type;
  }
  return 'implement';
}

// Parse the unified input into structured intent
function cmdParseInput(raw) {
  let text = raw.trim();
  const result = {
    intent: 'work-item', // 'work-item' | 'note' | 'plan'
    agents: [],           // assigned agent IDs
    fanout: false,
    priority: 'medium',
    project: '',          // primary project (for work items, plans)
    projects: [],          // multi-project list (for PRD items)
    title: '',
    description: '',
    type: '',             // work item type (auto-detected)
  };

  // Detect /stop, /cancel, /kill
  if (/^\/(?:stop|cancel|kill)\b/i.test(text) || /^(stop|cancel|kill|abort|halt)\s+/i.test(text)) {
    result.intent = 'cancel';
    text = text.replace(/^\/(?:stop|cancel|kill)\s*/i, '').replace(/^(stop|cancel|kill|abort|halt)\s+/i, '').trim();
    // Try to resolve agent name from remaining text
    var cancelAgent = cmdAgents.find(function(a) { return text.toLowerCase().includes(a.id) || text.toLowerCase().includes(a.name.toLowerCase()); });
    if (cancelAgent) result.agents = [cancelAgent.id];
    result.cancelTask = text;
    result.title = 'Cancel: ' + text;
    return result;
  }

  // Detect /decide, /note, or natural "remember" keyword
  const rememberPattern = /^(remember|remember that|don't forget|note that|keep in mind)\b/i;
  if (/^\/decide\b/i.test(text) || /^\/note\b/i.test(text) || rememberPattern.test(text)) {
    result.intent = 'note';
    text = text.replace(/^\/decide\s*/i, '').replace(/^\/note\s*/i, '').replace(rememberPattern, '').trim();
  } else if (/^\/plan\b/i.test(text) || /^(make a plan|plan out|plan for|plan how|create a plan|design a plan|come up with a plan|draft a plan|write a plan)\b/i.test(text)) {
    result.intent = 'plan';
    text = text.replace(/^\/plan\s*/i, '').replace(/^(make a plan for|plan out how|plan for how|plan how|create a plan for|design a plan for|come up with a plan for|draft a plan for|write a plan for|make a plan|plan out|create a plan|design a plan|come up with a plan|draft a plan|write a plan)\s*/i, '').trim();
    // Extract branch strategy flag
    if (/--parallel\b/i.test(text)) {
      result.branchStrategy = 'parallel';
      text = text.replace(/--parallel\b/i, '').trim();
    } else if (/--stack\b/i.test(text)) {
      result.branchStrategy = 'shared-branch';
      text = text.replace(/--stack\b/i, '').trim();
    } else {
      result.branchStrategy = 'parallel'; // default — items without depends_on get independent branches
    }
  }

  // Extract @mentions
  const mentionRe = /@(\w+)/g;
  let m;
  while ((m = mentionRe.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (name === 'everyone' || name === 'all') {
      result.fanout = true;
    } else {
      const agent = cmdAgents.find(a => a.id === name || a.name.toLowerCase() === name);
      if (agent && !result.agents.includes(agent.id)) result.agents.push(agent.id);
    }
  }
  // Remove @mentions from text
  text = text.replace(/@\w+/g, '').trim();

  // Extract !priority
  if (/!high\b/i.test(text)) { result.priority = 'high'; text = text.replace(/!high\b/i, '').trim(); }
  else if (/!low\b/i.test(text)) { result.priority = 'low'; text = text.replace(/!low\b/i, '').trim(); }
  else if (/!urgent\b/i.test(text)) { result.priority = 'high'; text = text.replace(/!urgent\b/i, '').trim(); }

  // Extract #project(s)
  const projRe = /#(\S+)/g;
  while ((m = projRe.exec(text)) !== null) {
    const pname = m[1];
    const proj = cmdProjects.find(p => p.name.toLowerCase() === pname.toLowerCase());
    if (proj) {
      result.project = proj.name; // last match for backward compat (work items, plans)
      if (!result.projects.includes(proj.name)) result.projects.push(proj.name);
    }
  }
  text = text.replace(/#\S+/g, '').trim();

  // Clean up extra whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Split first line as title, rest as description
  const lines = text.split('\n');
  result.title = lines[0] || '';
  result.description = lines.slice(1).join('\n').trim();

  // Auto-detect work type
  result.type = detectWorkItemType(result.title + ' ' + result.description);

  return result;
}

window.MinionsCmdParser = { cmdUpdateAgentList, cmdUpdateProjectList, showToast, detectWorkItemType, cmdParseInput };
