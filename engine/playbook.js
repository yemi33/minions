/**
 * engine/playbook.js — Playbook rendering, system prompt building, agent context,
 * task context resolution, and repo-host helpers.
 * Extracted from engine.js.
 */

const fs = require('fs');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, safeRead, getProjects, log, dateStamp, WI_STATUS, WORK_TYPE, PR_STATUS, DISPATCH_RESULT } = shared;
const { getConfig, getDispatch, getNotes, getAgentCharter, getPrs, AGENTS_DIR } = queries;

const MINIONS_DIR = path.resolve(__dirname, '..');
const PLAYBOOKS_DIR = path.join(MINIONS_DIR, 'playbooks');

// Import tempAgents from routing module
const { tempAgents } = require('./routing');

// ─── Repo Host Helpers ──────────────────────────────────────────────────────

function getRepoHost(project) {
  return project?.repoHost || 'ado';
}

function getPrCreateInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    const mainBranch = project?.mainBranch || 'main';
    return `Use \`gh pr create\` to create a pull request:\n` +
      `- \`gh pr create --base ${mainBranch} --head <your-branch> --title "PR title" --body "PR description" --repo ${org}/${repo}\`\n` +
      `- Always set --base to \`${mainBranch}\` (the main branch)\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- Use --head to specify your feature branch name\n` +
      `- Include a meaningful --title and --body describing the changes`;
  }
  // Default: Azure DevOps
  return `Use \`mcp__azure-ado__repo_create_pull_request\`:\n- repositoryId: \`${repoId}\``;
}

function getPrCommentInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    return `Use \`gh pr comment\` to post a comment on the PR:\n` +
      `- \`gh pr comment <number> --body "Your comment text" --repo ${org}/${repo}\`\n` +
      `- Replace <number> with the PR number\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- Use --body to provide the comment text (supports Markdown)`;
  }
  return `Use \`mcp__azure-ado__repo_create_pull_request_thread\`:\n- repositoryId: \`${repoId}\``;
}

function getPrFetchInstructions(project) {
  const host = getRepoHost(project);
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    const mainBranch = project?.mainBranch || 'main';
    return `Use \`gh pr view\` to fetch PR status:\n` +
      `- \`gh pr view <number> --json number,title,state,mergeable,reviewDecision,headRefName,baseRefName,statusCheckRollup --repo ${org}/${repo}\`\n` +
      `- This returns JSON with PR state, mergeability, review decision, and check statuses\n` +
      `- To fetch the PR branch locally:\n` +
      `  1. \`git fetch origin <branch-name>\`\n` +
      `  2. \`git checkout <branch-name>\`\n` +
      `- Or use \`gh pr checkout <number> --repo ${org}/${repo}\` to fetch and checkout in one step\n` +
      `- The base branch is \`${mainBranch}\``;
  }
  return `Use \`mcp__azure-ado__repo_get_pull_request_by_id\` to fetch PR status.`;
}

function getPrVoteInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    return `Use \`gh pr review\` to submit a review on the PR:\n` +
      `- Approve: \`gh pr review <number> --approve --body "Approval comment" --repo ${org}/${repo}\`\n` +
      `- Request changes: \`gh pr review <number> --request-changes --body "What needs to change" --repo ${org}/${repo}\`\n` +
      `- Comment only: \`gh pr review <number> --comment --body "Review comment" --repo ${org}/${repo}\`\n` +
      `- Replace <number> with the PR number\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- Use --body to provide a review summary (supports Markdown)`;
  }
  return `Use \`mcp__azure-ado__repo_update_pull_request_reviewers\`:\n- repositoryId: \`${repoId}\`\n- Set your reviewer vote on the PR (10=approve, 5=approve-with-suggestions, -10=reject)`;
}

function getRepoHostLabel(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'GitHub';
  return 'Azure DevOps';
}

function getRepoHostToolRule(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'Use GitHub MCP tools or `gh` CLI for PR operations';
  return 'Use Azure DevOps MCP tools (mcp__azure-ado__*) for PR operations — NEVER use gh CLI';
}

// ─── Task Context Resolution ────────────────────────────────────────────────
// Resolves implicit references in task descriptions (e.g., "ripley's plan",
// "dallas's PR") to actual artifacts and injects their content.

function resolveTaskContext(item, config) {
  const title = (item.title || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const text = title + ' ' + desc;
  const agentNames = Object.entries(config.agents || {}).map(([id, a]) => ({
    id,
    name: (a.name || id).toLowerCase(),
  }));
  const resolved = { additionalContext: '', referencedFiles: [] };


  // Match agent references: "ripley's plan", "dallas's pr", "lambert's output", etc.
  for (const agent of agentNames) {
    const patterns = [
      new RegExp(`${agent.name}(?:'s|s)?\\s+plan`, 'i'),
      new RegExp(`${agent.id}(?:'s|s)?\\s+plan`, 'i'),
      new RegExp(`plan\\s+(?:created|made|written|generated)\\s+by\\s+${agent.name}`, 'i'),
      new RegExp(`plan\\s+(?:created|made|written|generated)\\s+by\\s+${agent.id}`, 'i'),
    ];
    const matchesPlan = patterns.some(p => p.test(text));
    if (matchesPlan) {
      // Find plans created by this agent (check work items for plan tasks dispatched to this agent)
      try {
        const plans = fs.readdirSync(path.join(MINIONS_DIR, 'plans')).filter(f => f.endsWith('.md') || f.endsWith('.json'));
        // Check work-items to find which plan file this agent created
        const workItems = safeJson(path.join(MINIONS_DIR, 'work-items.json')) || [];
        const agentPlanItems = workItems.filter(w =>
          w.type === WORK_TYPE.PLAN && w.dispatched_to === agent.id && w.status === WI_STATUS.DONE && w._planFileName
        ).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

        if (agentPlanItems.length > 0) {
          const planFile = agentPlanItems[0]._planFileName;
          const planPath = path.join(MINIONS_DIR, 'plans', planFile);
          try {
            const content = safeRead(planPath);
            resolved.additionalContext += `\n\n## Referenced Plan: ${planFile} (created by ${agent.name})\n\n${content}`;
            resolved.referencedFiles.push(planPath);
            log('info', `Context resolution: found plan "${planFile}" by ${agent.name} for work item ${item.id}`);
          } catch (e) { log('warn', 'resolve plan context: ' + e.message); }
        } else if (plans.length > 0) {
          // Fallback: try to find a plan file with the agent's name or ID in it
          const match = plans.find(f => f.toLowerCase().includes(agent.id) || f.toLowerCase().includes(agent.name));
          if (match) {
            const planPath = path.join(MINIONS_DIR, 'plans', match);
            try {
              const content = safeRead(planPath);
              resolved.additionalContext += `\n\n## Referenced Plan: ${match}\n\n${content}`;
              resolved.referencedFiles.push(planPath);
              log('info', `Context resolution: found plan "${match}" (name match) for work item ${item.id}`);
            } catch (e) { log('warn', 'resolve plan fallback context: ' + e.message); }
          }
        }
      } catch (e) { log('warn', 'resolve agent plan context: ' + e.message); }
    }

    // Match agent output/notes references
    const outputPatterns = [
      new RegExp(`${agent.name}(?:'s|s)?\\s+(?:output|findings|notes|results)`, 'i'),
      new RegExp(`(?:output|findings|notes|results)\\s+(?:from|by)\\s+${agent.name}`, 'i'),
    ];
    if (outputPatterns.some(p => p.test(text))) {
      // Find the agent's latest inbox notes
      try {
        const inboxDir = path.join(MINIONS_DIR, 'notes', 'inbox');
        const files = fs.readdirSync(inboxDir)
          .filter(f => f.startsWith(agent.id + '-'))
          .sort().reverse();
        if (files.length > 0) {
          const content = safeRead(path.join(inboxDir, files[0]));
          resolved.additionalContext += `\n\n## Referenced Notes by ${agent.name}: ${files[0]}\n\n${content.slice(0, 5000)}`;
          resolved.referencedFiles.push(path.join(inboxDir, files[0]));
          log('info', `Context resolution: found notes "${files[0]}" by ${agent.name} for work item ${item.id}`);
        }
      } catch (e) { log('warn', 'resolve plan context outer: ' + e.message); }
    }
  }

  // If no specific reference was resolved but the text mentions "the plan" or "latest plan",
  // find the most recent plan
  if (!resolved.additionalContext && /\b(the|latest|last|recent)\s+plan\b/i.test(text)) {
  
    try {
      const plans = fs.readdirSync(path.join(MINIONS_DIR, 'plans'))
        .filter(f => f.endsWith('.md') || f.endsWith('.json'))
        .sort().reverse();
      if (plans.length > 0) {
        const planPath = path.join(MINIONS_DIR, 'plans', plans[0]);
        const content = safeRead(planPath);
        resolved.additionalContext += `\n\n## Referenced Plan (latest): ${plans[0]}\n\n${content}`;
        resolved.referencedFiles.push(planPath);
        log('info', `Context resolution: using latest plan "${plans[0]}" for work item ${item.id}`);
      }
    } catch (e) { log('warn', 'resolve latest plan context: ' + e.message); }
  }

  return resolved;
}

// ─── Playbook Renderer ──────────────────────────────────────────────────────

function renderPlaybook(type, vars) {
  const pbPath = path.join(PLAYBOOKS_DIR, `${type}.md`);
  let content;
  try { content = fs.readFileSync(pbPath, 'utf8'); } catch {
    log('warn', `Playbook not found: ${type}`);
    return null;
  }

  // Inject pinned context (always visible to agents) — capped at 4KB
  let pinnedContent = '';
  try { pinnedContent = fs.readFileSync(path.join(MINIONS_DIR, 'pinned.md'), 'utf8'); } catch { /* optional */ }
  if (pinnedContent) {
    if (pinnedContent.length > 4096) pinnedContent = pinnedContent.slice(0, 4096) + '\n\n_...pinned.md truncated (read full file if needed)_';
    content += '\n\n---\n\n## Pinned Context (CRITICAL — READ FIRST)\n\n' + pinnedContent;
  }

  // Inject team notes (single injection point — not in buildAgentContext) — capped at 8KB
  let notes = getNotes();
  if (notes) {
    if (notes.length > 8192) {
      const sections = notes.split(/(?=^### )/m);
      const recent = sections.slice(-10).join('');
      notes = recent.length > 8192 ? recent.slice(0, 8192) + '\n\n_...notes truncated_' : recent;
      notes += '\n\n_' + Math.max(0, sections.length - 10) + ' older entries in `notes.md` — Read if needed._';
    }
    content += '\n\n---\n\n## Team Notes (MUST READ)\n\n' + notes;
  }

  // Inject KB guardrail
  content += `\n\n---\n\n## Knowledge Base Rules\n\n`;
  content += `**Never delete, move, or overwrite files in \`knowledge/\`.** The sweep (consolidation engine) is the only process that writes to \`knowledge/\`. If you think a KB file is wrong, note it in your learnings file — do not touch \`knowledge/\` directly.\n`;

  // Inject learnings requirement
  content += `\n\n---\n\n## REQUIRED: Write Learnings\n\n`;
  content += `After completing your task, you MUST write a findings/learnings file to:\n`;
  content += `\`${MINIONS_DIR}/notes/inbox/${vars.agent_id || 'agent'}-${dateStamp()}.md\`\n\n`;
  content += `Include:\n`;
  content += `- What you learned about the codebase\n`;
  content += `- Patterns you discovered or established\n`;
  content += `- Gotchas or warnings for future agents\n`;
  content += `- Conventions to follow\n`;
  content += `- **SOURCE REFERENCES for every finding** — file paths with line numbers, PR URLs, API endpoints, config keys. Format: \`(source: path/to/file.ts:42)\` or \`(source: PR-12345)\`. Without references, findings cannot be verified.\n\n`;
  content += `### Skill Extraction (IMPORTANT)\n\n`;
  content += `If during this task you discovered a **repeatable workflow** — a multi-step procedure, workaround, build process, or pattern that other agents should follow in similar situations — output it as a fenced skill block. The engine will automatically extract it.\n\n`;
  content += `Format your skill as a fenced code block with the \`skill\` language tag:\n\n`;
  content += '````\n```skill\n';
  content += `---\nname: short-descriptive-name\ndescription: One-line description of what this skill does\nallowed-tools: Bash, Read, Edit\ntrigger: when should an agent use this\nscope: minions\nproject: any\n---\n\n# Skill Title\n\n## Steps\n1. ...\n2. ...\n\n## Notes\n...\n`;
  content += '```\n````\n\n';
  content += `- Set \`scope: minions\` for cross-project skills (engine writes to ~/.claude/skills/ automatically)\n`;
  content += `- Set \`scope: project\` + \`project: <name>\` for repo-specific skills (engine queues a PR to <project>/.claude/skills/)\n`;
  content += `- Only output a skill block if you genuinely discovered something reusable — don't force it\n`;

  // Inject project-level variables from config
  const config = getConfig();
  const projects = getProjects(config);
  // Find the specific project being dispatched (match by repo_id or repo_name from vars)
  const dispatchProject = (vars.repo_id && projects.find(p => p.repositoryId === vars.repo_id))
    || (vars.repo_name && projects.find(p => p.repoName === vars.repo_name))
    || projects[0] || {};
  const projectVars = {
    project_name: dispatchProject.name || 'Unknown Project',
    ado_org: dispatchProject.adoOrg || 'Unknown',
    ado_project: dispatchProject.adoProject || 'Unknown',
    repo_name: dispatchProject.repoName || 'Unknown',
    pr_create_instructions: getPrCreateInstructions(dispatchProject),
    pr_comment_instructions: getPrCommentInstructions(dispatchProject),
    pr_fetch_instructions: getPrFetchInstructions(dispatchProject),
    pr_vote_instructions: getPrVoteInstructions(dispatchProject),
    repo_host_label: getRepoHostLabel(dispatchProject),
  };
  const allVars = { ...projectVars, ...vars };

  // Substitute variables
  for (const [key, val] of Object.entries(allVars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(val));
  }

  // Warn when a substituted value itself contains {{...}} patterns (potential self-reference)
  const selfRefVars = Object.entries(allVars)
    .filter(([, val]) => /\{\{\w+\}\}/.test(String(val)))
    .map(([key]) => key);
  if (selfRefVars.length > 0) {
    log('warn', `Playbook "${type}": substituted values contain unresolved {{...}} patterns (potential self-reference): ${selfRefVars.join(', ')}`);
  }

  // Warn when a substituted value itself contains {{...}} patterns (potential self-reference)
  const selfRefVars = Object.entries(allVars)
    .filter(([, val]) => /\{\{\w+\}\}/.test(String(val)))
    .map(([key]) => key);
  if (selfRefVars.length > 0) {
    log('warn', `Playbook "${type}": substituted values contain unresolved {{...}} patterns (potential self-reference): ${selfRefVars.join(', ')}`);
  }

  // Warn on variables that resolved to empty string
  const emptyVars = Object.entries(allVars)
    .filter(([, val]) => String(val) === '')
    .map(([key]) => key);
  if (emptyVars.length > 0) {
    log('warn', `Playbook "${type}": template variables resolved to empty string: ${emptyVars.join(', ')}`);
  }

  // Warn on any remaining unresolved {{variable}} placeholders
  const unresolved = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(m => m.slice(2, -2)))];
  if (unresolved.length > 0) {
    log('warn', `Playbook "${type}": unresolved template variables: ${unresolved.join(', ')}`);
  }

  return content;
}

// ─── System Prompt Builder ──────────────────────────────────────────────────

// Lean system prompt: agent identity + rules only (~2-4KB, never grows)
function buildSystemPrompt(agentId, config, project) {
  const agent = config.agents[agentId] || tempAgents.get(agentId) || { name: agentId, role: 'Temporary Agent', skills: [] };
  const charter = getAgentCharter(agentId); // returns '' for temp agents (no charter file)
  project = project || getProjects(config)[0] || {};

  let prompt = '';

  // Agent identity
  prompt += `# You are ${agent.name} (${agent.role})\n\n`;
  prompt += `Agent ID: ${agentId}\n`;
  prompt += `Skills: ${(agent.skills || []).join(', ')}\n\n`;

  // Charter (detailed instructions — typically 1-2KB)
  if (charter) {
    prompt += `## Your Charter\n\n${charter}\n\n`;
  }

  // Project context (fixed size)
  prompt += `## Project: ${project.name || 'Unknown Project'}\n\n`;
  prompt += `- Repo: ${project.repoName || 'Unknown'} (${project.adoOrg || 'Unknown'}/${project.adoProject || 'Unknown'})\n`;
  prompt += `- Repo ID: ${project.repositoryId || ''}\n`;
  prompt += `- Repo host: ${getRepoHostLabel(project)}\n`;
  prompt += `- Main branch: ${project.mainBranch || 'main'}\n\n`;

  // Critical rules (fixed size)
  prompt += `## Critical Rules\n\n`;
  prompt += `1. Use git worktrees — NEVER checkout on main working tree\n`;
  prompt += `2. ${getRepoHostToolRule(project)}\n`;
  prompt += `3. Follow the project conventions in CLAUDE.md if present\n`;
  prompt += `4. Write learnings to: ${MINIONS_DIR}/notes/inbox/${agentId}-${dateStamp()}.md\n`;
  prompt += `5. Agent status is managed by the engine via dispatch.json — agents do not need to track their own status\n`;
  prompt += `6. If you discover a repeatable workflow, output it as a \\\`\\\`\\\`skill fenced block — the engine auto-extracts it to ~/.claude/skills/\n\n`;

  return prompt;
}

// Bulk context: history, notes, conventions, skills — prepended to user/task prompt.
// This is the content that grows over time and would bloat the system prompt.
function buildAgentContext(agentId, config, project) {
  project = project || getProjects(config)[0] || {};
  let context = '';


  // Agent history — last 5 tasks only (keeps it relevant, avoids 37KB dumps)
  const history = safeRead(path.join(AGENTS_DIR, agentId, 'history.md'));
  if (history && history.trim() !== '# Agent History') {
    const entries = history.split(/(?=^### )/m);
    const header = entries[0].startsWith('#') && !entries[0].startsWith('### ') ? entries.shift() : '';
    const recent = entries.slice(-5);
    const trimmed = (header ? header + '\n' : '') + recent.join('');
    context += `## Your Recent History (last 5 tasks)\n\n${trimmed}\n\n`;
  }

  // Project conventions (from CLAUDE.md) — always relevant for code quality
  if (project.localPath) {
    const claudeMd = safeRead(path.join(project.localPath, 'CLAUDE.md'));
    if (claudeMd && claudeMd.trim()) {
      const truncated = claudeMd.length > 8192 ? claudeMd.slice(0, 8192) + '\n\n...(truncated)' : claudeMd;
      context += `## Project Conventions (from CLAUDE.md)\n\n${truncated}\n\n`;
    }
  }

  // KB and skills: NOT injected — agents can Glob/Read when needed
  // This saves ~27KB per dispatch. Reference note so agents know they exist:
  context += `## Reference Files\n\nKnowledge base entries are in \`knowledge/{category}/*.md\`. Skills are in \`skills/*.md\` and \`.claude/skills/\`. Use Glob/Read to browse when relevant.\n\n`;

  // Minions awareness: what's in flight, who's doing what
  const dispatch = getDispatch();
  const activeItems = (dispatch.active || []).map(d =>
    `- **${d.agent}**: ${d.type} — ${(d.task || '').slice(0, 100)}${d.agent === agentId ? ' ← (you)' : ''}`
  );
  if (activeItems.length > 0) {
    context += `## Active Agents\n\n${activeItems.join('\n')}\n\n`;
  }

  // Recent completions (last 5, not 10)
  const recentCompleted = (dispatch.completed || []).slice(-5).reverse().map(d =>
    `- **${d.agent}** ${d.result === DISPATCH_RESULT.SUCCESS ? 'completed' : 'failed'}: ${(d.task || '').slice(0, 80)}${d.resultSummary ? ' — ' + d.resultSummary.slice(0, 100) : ''}`
  );
  if (recentCompleted.length > 0) {
    context += `## Recently Completed\n\n${recentCompleted.join('\n')}\n\n`;
  }

  // Active + linked PRs across projects — coordination awareness
  const projects = getProjects(config);
  const allPrs = [];
  for (const p of projects) {
    const prs = getPrs(p).filter(pr => pr.status === PR_STATUS.ACTIVE);
    for (const pr of prs) allPrs.push({ ...pr, _project: p.name });
  }
  // Also check central pull-requests.json
  try {
    const centralPrs = safeJson(path.join(MINIONS_DIR, 'pull-requests.json')) || [];
    for (const pr of centralPrs.filter(pr => pr.status === PR_STATUS.ACTIVE)) {
      if (!allPrs.some(p => p.id === pr.id)) allPrs.push({ ...pr, _project: 'central' });
    }
  } catch (e) { log('warn', 'read central pull-requests: ' + e.message); }
  if (allPrs.length > 0) {
    const prLines = allPrs.map(pr =>
      `- **${pr.id}** (${pr._project}): ${(pr.title || '').slice(0, 80)} [${(pr.reviewStatus || 'pending')}${pr.buildStatus === 'failing' ? ', BUILD FAILING' : ''}]${pr.branch ? ' branch: `' + pr.branch + '`' : ''}${pr._context ? ' — ' + pr._context.slice(0, 100) : ''}`
    );
    context += `## Active Pull Requests\n\n${prLines.join('\n')}\n\n`;
  }

  // Pending work items
  const pendingItems = (dispatch.pending || []).slice(0, 10).map(d =>
    `- ${d.type}: ${(d.task || '').slice(0, 80)}`
  );
  if (pendingItems.length > 0) {
    context += `## Pending Work Queue (${(dispatch.pending || []).length} items)\n\n${pendingItems.join('\n')}${(dispatch.pending || []).length > 10 ? '\n- ... and ' + ((dispatch.pending || []).length - 10) + ' more' : ''}\n\n`;
  }

  // Team notes injected via renderPlaybook (single injection point, with truncation)
  // Not duplicated here to avoid double-injection and token waste

  return context;
}

// ─── Work Discovery Helpers ──────────────────────────────────────────────────

function buildBaseVars(agentId, config, project) {
  return {
    agent_id: agentId,
    agent_name: config.agents[agentId]?.name || agentId,
    agent_role: config.agents[agentId]?.role || 'Agent',
    team_root: MINIONS_DIR,
    repo_id: project?.repositoryId || '',
    project_name: project?.name || 'Unknown Project',
    ado_org: project?.adoOrg || 'Unknown',
    ado_project: project?.adoProject || 'Unknown',
    repo_name: project?.repoName || 'Unknown',
    main_branch: project?.mainBranch || 'main',
    date: dateStamp(),
  };
}

function selectPlaybook(workType, item) {
  if (item?.branchStrategy === 'shared-branch' && (workType === WORK_TYPE.IMPLEMENT || workType === WORK_TYPE.IMPLEMENT_LARGE)) {
    return 'implement-shared';
  }
  if (workType === WORK_TYPE.REVIEW && !item?._pr && !item?.pr_id) {
    return 'work-item';
  }
  const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask', 'verify', 'decompose', 'meeting-investigate', 'meeting-debate', 'meeting-conclude'];
  return typeSpecificPlaybooks.includes(workType) ? workType : 'work-item';
}

function buildPrDispatch(agentId, config, project, pr, type, extraVars, taskLabel, meta) {
  const vars = { ...buildBaseVars(agentId, config, project), ...extraVars };
  const playbookName = type === 'test' ? 'build-and-test' : (type === 'review' ? 'review' : 'fix');
  const prompt = renderPlaybook(playbookName, vars);
  if (!prompt) return null;
  return {
    type,
    agent: agentId,
    agentName: config.agents[agentId]?.name,
    agentRole: config.agents[agentId]?.role,
    task: `[${project?.name || 'project'}] ${taskLabel}`,
    prompt,
    meta,
  };
}

module.exports = {
  renderPlaybook,
  buildSystemPrompt,
  buildAgentContext,
  selectPlaybook,
  buildBaseVars,
  buildPrDispatch,
  resolveTaskContext,
  // Repo host helpers (used by engine.js for buildProjectContext)
  getRepoHost,
  getRepoHostLabel,
  getRepoHostToolRule,
  getPrCreateInstructions,
  getPrCommentInstructions,
  getPrFetchInstructions,
  getPrVoteInstructions,
};
