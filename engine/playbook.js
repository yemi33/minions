/**
 * engine/playbook.js — Playbook rendering, system prompt building, agent context,
 * task context resolution, and repo-host helpers.
 * Extracted from engine.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const shared = require('./shared');
const queries = require('./queries');

const { safeJson, safeRead, getProjects, log, ts, dateStamp, truncateTextBytes, ENGINE_DEFAULTS, WI_STATUS, WORK_TYPE, PR_STATUS, DISPATCH_RESULT } = shared;
const { getConfig, getDispatch, getNotes, getAgentCharter, getPrs, getKnowledgeBaseIndex, AGENTS_DIR } = queries;

const MINIONS_DIR = shared.MINIONS_DIR;
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
    const mainBranch = project?.localPath ? shared.resolveMainBranch(project.localPath, project.mainBranch) : (project?.mainBranch || 'main');
    return `Use \`gh pr create\` to create a pull request:\n` +
      `- Write the PR description to a temporary Markdown file, then run: \`gh pr create --base ${mainBranch} --head <your-branch> --title "PR title" --body-file <body-file.md> --repo ${org}/${repo}\`\n` +
      `- Always set --base to \`${mainBranch}\` (the main branch)\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- Use --head to specify your feature branch name\n` +
      `- Include a meaningful --title and body file describing the changes`;
  }
  // Default: Azure DevOps — prefer `az` CLI first, ADO MCP only as fallback
  const adoOrg = project?.adoOrg || '';
  const adoProject = project?.adoProject || '';
  const repoName = project?.repoName || '';
  const mainBranch = project?.localPath ? shared.resolveMainBranch(project.localPath, project.mainBranch) : (project?.mainBranch || 'main');
  return `For Azure DevOps, use the \`az\` CLI first to create a pull request:\n` +
    `- Run \`az devops configure --defaults organization=https://dev.azure.com/${adoOrg} project="${adoProject}"\` once per session if defaults are not yet set\n` +
    `- Then: \`az repos pr create --repository "${repoName}" --source-branch <your-branch> --target-branch ${mainBranch} --title "PR title" --description @<body-file.md>\`\n` +
    `- Use \`@<file>\` syntax for \`--description\` so Markdown, quotes, and newlines pass safely\n` +
    `- Always set --target-branch to \`${mainBranch}\` (the main branch)\n\n` +
    `If \`az\` is unavailable or insufficient for this operation, fall back to \`mcp__azure-ado__repo_create_pull_request\` with repositoryId \`${repoId}\`. Do not use \`gh\` for Azure DevOps repositories.`;
}

function getPrCommentInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    return `Use \`gh pr comment\` to post a comment on the PR:\n` +
      `- Write the Markdown comment to a temporary file, then run: \`gh pr comment <number> --body-file <body-file.md> --repo ${org}/${repo}\`\n` +
      `- Replace <number> with the PR number\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- Use --body-file so Markdown, quotes, and newlines are passed safely`;
  }
  // Azure DevOps — prefer `az` CLI first, ADO MCP only as fallback
  const repoName = project?.repoName || '';
  return `For Azure DevOps, use the \`az\` CLI first to post a comment on the PR:\n` +
    `- Write the Markdown comment to a temporary file, then run: \`az repos pr comment create --pull-request-id <number> --content @<body-file.md>\` (substitute your project's repo \`${repoName}\` if not using \`az devops configure\` defaults)\n` +
    `- Use \`@<file>\` syntax for \`--content\` so Markdown, quotes, and newlines pass safely\n\n` +
    `If \`az repos pr comment\` is unavailable or insufficient (e.g. older az-devops extension, thread/status semantics needed), fall back to \`mcp__azure-ado__repo_create_pull_request_thread\` with repositoryId \`${repoId}\`. Do not use \`gh\` for Azure DevOps repositories.`;
}

function getPrFetchInstructions(project) {
  const host = getRepoHost(project);
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    const mainBranch = project?.localPath ? shared.resolveMainBranch(project.localPath, project.mainBranch) : (project?.mainBranch || 'main');
    return `Use \`gh pr view\` to fetch PR status:\n` +
      `- \`gh pr view <number> --json number,title,state,mergeable,reviewDecision,headRefName,baseRefName,statusCheckRollup --repo ${org}/${repo}\`\n` +
      `- This returns JSON with PR state, mergeability, review decision, and check statuses\n` +
      `- To fetch the PR branch locally:\n` +
      `  1. \`git fetch origin <branch-name>\`\n` +
      `  2. \`git checkout <branch-name>\`\n` +
      `- Or use \`gh pr checkout <number> --repo ${org}/${repo}\` to fetch and checkout in one step\n` +
      `- The base branch is \`${mainBranch}\``;
  }
  // Azure DevOps — prefer `az` CLI first, ADO MCP only as fallback
  const mainBranch = project?.localPath ? shared.resolveMainBranch(project.localPath, project.mainBranch) : (project?.mainBranch || 'main');
  return `For Azure DevOps, use the \`az\` CLI first to fetch PR status:\n` +
    `- \`az repos pr show --id <number>\` returns PR state, mergeStatus, source/target branches, vote summary, and policy/build evaluations\n` +
    `- For the local branch: \`git fetch origin <branch-name>\` then inspect via \`git show\`/\`git diff\` (do NOT checkout in your main working tree)\n` +
    `- The base branch is \`${mainBranch}\`\n\n` +
    `If \`az\` is unavailable or insufficient, fall back to \`mcp__azure-ado__repo_get_pull_request_by_id\`. Do not use \`gh\` for Azure DevOps repositories.`;
}

function getPrVoteInstructions(project) {
  const host = getRepoHost(project);
  const repoId = project?.repositoryId || '';
  if (host === 'github') {
    const org = project?.adoOrg || '';
    const repo = project?.repoName || '';
    return `**IMPORTANT: GitHub blocks self-approval** — all agents share the same credentials, so \`--approve\` and \`--request-changes\` will fail with "can't approve your own PR." Use \`--comment\` instead.\n\n` +
      `Submit your review verdict using \`gh pr review\` with \`--comment\`:\n` +
      `- Write a Markdown review body file whose first line is \`VERDICT: APPROVE\`, then run: \`gh pr review <number> --comment --body-file <body-file.md> --repo ${org}/${repo}\`\n` +
      `- For requested changes, use \`VERDICT: REQUEST_CHANGES\` as the first line in that same --body-file flow\n` +
      `- Replace <number> with the PR number\n` +
      `- Always set --repo to \`${org}/${repo}\` to target the correct repository\n` +
      `- **Your comment body MUST start with \`VERDICT: APPROVE\` or \`VERDICT: REQUEST_CHANGES\`** on its own line — the engine parses this to record your vote\n` +
      `- Do NOT use \`--approve\` or \`--request-changes\` flags — they will fail`;
  }
  // Azure DevOps — prefer `az` CLI first, ADO MCP only as fallback
  return `For Azure DevOps, use the \`az\` CLI first to set your reviewer vote:\n` +
    `- \`az repos pr set-vote --id <number> --vote {approve | approve-with-suggestions | reject | reset | wait-for-author}\`\n` +
    `- Pair the vote with \`az repos pr comment create --pull-request-id <number> --content @<verdict.md>\` so the verdict body is recorded as a thread comment\n\n` +
    `If \`az\` is unavailable or insufficient, fall back to \`mcp__azure-ado__repo_update_pull_request_reviewers\` with repositoryId \`${repoId}\` (vote integers: 10=approve, 5=approve-with-suggestions, 0=no-vote, -5=wait-for-author, -10=reject). Do not use \`gh\` for Azure DevOps repositories.`;
}

function getRepoHostLabel(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'GitHub';
  return 'Azure DevOps';
}

function getRepoHostToolRule(project) {
  const host = getRepoHost(project);
  if (host === 'github') return 'Use GitHub MCP tools or `gh` CLI for PR operations';
  return 'For Azure DevOps, use the `az` CLI first for PR operations (e.g. `az repos pr create`, `az repos pr show`, `az repos pr comment`, `az repos pr set-vote`); use ADO MCP tools (`mcp__azure-ado__*`) only as a fallback when `az` is unavailable or insufficient. Do not use `gh` for Azure DevOps repositories.';
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

  function truncateReferencedContext(content, maxBytes, label) {
    return truncateTextBytes(content, maxBytes, `\n\n_...${label} truncated — read the full file if needed._`);
  }


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
        const workItems = queries.getWorkItems();
        const agentPlanItems = workItems.filter(w =>
          w.type === WORK_TYPE.PLAN && w.dispatched_to === agent.id && w.status === WI_STATUS.DONE && w._planFileName
        ).sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));

        if (agentPlanItems.length > 0) {
          const planFile = agentPlanItems[0]._planFileName;
          const planPath = path.join(MINIONS_DIR, 'plans', planFile);
          try {
            const content = safeRead(planPath);
            resolved.additionalContext += `\n\n## Referenced Plan: ${planFile} (created by ${agent.name})\n\n${truncateReferencedContext(content, ENGINE_DEFAULTS.maxReferencedPlanBytes, 'referenced plan')}`;
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
              resolved.additionalContext += `\n\n## Referenced Plan: ${match}\n\n${truncateReferencedContext(content, ENGINE_DEFAULTS.maxReferencedPlanBytes, 'referenced plan')}`;
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
          resolved.additionalContext += `\n\n## Referenced Notes by ${agent.name}: ${files[0]}\n\n${truncateReferencedContext(content, ENGINE_DEFAULTS.maxReferencedNotesBytes, 'referenced notes')}`;
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
        resolved.additionalContext += `\n\n## Referenced Plan (latest): ${plans[0]}\n\n${truncateReferencedContext(content, ENGINE_DEFAULTS.maxReferencedPlanBytes, 'referenced plan')}`;
        resolved.referencedFiles.push(planPath);
        log('info', `Context resolution: using latest plan "${plans[0]}" for work item ${item.id}`);
      }
    } catch (e) { log('warn', 'resolve latest plan context: ' + e.message); }
  }

  if (resolved.additionalContext) {
    resolved.additionalContext = truncateTextBytes(
      resolved.additionalContext,
      ENGINE_DEFAULTS.maxResolvedTaskContextBytes,
      '\n\n_...additional referenced context truncated — read the referenced files if needed._'
    );
  }
  return resolved;
}

// ─── Required Template Variables ────────────────────────────────────────────
// Defines which caller-provided variables are mandatory per playbook type.
// Base vars (from buildBaseVars) and project vars (injected by renderPlaybook)
// are always present and excluded. Variables in conditional blocks ({{#key}})
// are optional by design. Only variables that make the playbook non-functional
// when absent are listed here.

// ─── Optional Template Variables ────────────────────────────────────────────
// Variables that legitimately resolve to empty string for ad-hoc work items.
// These are silently filtered out of the empty-string warning to avoid
// masking real warnings. Add new optional vars here when they are contextual
// (plan-linked, checkpoint-dependent, etc.) and not required for the playbook
// to function.

const PLAYBOOK_OPTIONAL_VARS = new Set([
  'source_plan',          // only set when work item is linked to a plan
  'plan_slug',            // derived from source_plan
  'additional_context',   // only set when item has a prompt
  'references',           // only set when item.references has entries
  'acceptance_criteria',  // only set when item.acceptanceCriteria has entries
  'checkpoint_context',   // only set when resuming from a prior timeout
]);

const PLAYBOOK_REQUIRED_VARS = {
  'implement':            ['item_id', 'item_name', 'branch_name', 'project_path'],
  'implement-shared':     ['item_id', 'item_name', 'branch_name', 'worktree_path'],
  'fix':                  ['pr_id', 'pr_branch'],
  'review':               ['pr_id', 'pr_branch'],
  'build-and-test':       ['pr_id', 'pr_branch', 'project_path'],
  'explore':              ['task_description'],
  'ask':                  ['question'],
  'plan':                 ['task_description', 'project_path'],
  'plan-to-prd':          ['plan_content', 'plan_file', 'prd_filename', 'project_path'],
  'decompose':            ['item_id', 'item_description', 'project_path'],
  'verify':               ['task_description'],
  'test':                 ['item_name'],
  'docs':                 ['item_id', 'item_name'],
  'work-item':            ['item_id', 'item_name'],
  'meeting-investigate':  ['meeting_title', 'agenda'],
  'meeting-debate':       ['meeting_title', 'agenda'],
  'meeting-conclude':     ['meeting_title', 'agenda'],
};

/**
 * Validate that all required template variables for a playbook type are present
 * and non-empty in the provided vars object.
 * @param {string} playbookName - The playbook type name
 * @param {object} vars - The template variables object
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validatePlaybookVars(playbookName, vars) {
  const required = PLAYBOOK_REQUIRED_VARS[playbookName];
  if (!required) return { valid: true, missing: [] };

  const missing = required.filter(key => {
    const val = vars[key];
    return val === undefined || val === null || String(val).trim() === '';
  });

  return { valid: missing.length === 0, missing };
}

// ─── Playbook Path Resolution ───────────────────────────────────────────────

/**
 * Resolve playbook file path, checking project-local override first.
 * If projects/<projectName>/playbooks/<playbookType>.md exists, use it.
 * Otherwise fall back to the global playbooks/<playbookType>.md.
 * @param {string|null|undefined} projectName — project name (directory under projects/)
 * @param {string} playbookType — playbook type name (e.g. 'implement', 'review')
 * @returns {string} absolute path to the playbook file
 */
function resolvePlaybookPath(projectName, playbookType) {
  if (projectName) {
    const localPath = path.join(MINIONS_DIR, 'projects', projectName, 'playbooks', `${playbookType}.md`);
    try {
      fs.accessSync(localPath, fs.constants.R_OK);
      log('info', `Using project-local playbook: projects/${projectName}/playbooks/${playbookType}.md`);
      return localPath;
    } catch { /* no local override — fall through to global */ }
  }
  return path.join(PLAYBOOKS_DIR, `${playbookType}.md`);
}


// ─── Playbook Renderer ──────────────────────────────────────────────────────

function renderPlaybook(type, vars) {
  const projectName = vars.project_name || null;
  const pbPath = resolvePlaybookPath(projectName, type);
  let content;
  try { content = fs.readFileSync(pbPath, 'utf8'); } catch {
    log('warn', `Playbook not found: ${type}`);
    return null;
  }

  // Inject shared rules (apply to all playbooks)
  try {
    const sharedRules = fs.readFileSync(path.join(PLAYBOOKS_DIR, 'shared-rules.md'), 'utf8');
    if (sharedRules) content += '\n\n' + sharedRules;
  } catch { /* optional — shared rules file may not exist */ }

  const inertAppendices = [];

  // Inject pinned context (always visible to agents) — capped at 4KB
  let pinnedContent = '';
  try { pinnedContent = fs.readFileSync(path.join(MINIONS_DIR, 'pinned.md'), 'utf8'); } catch { /* optional */ }
  if (pinnedContent) {
    if (pinnedContent.length > 4096) pinnedContent = pinnedContent.slice(0, 4096) + '\n\n_...pinned.md truncated (read full file if needed)_';
    inertAppendices.push('\n\n---\n\n## Pinned Context (CRITICAL — READ FIRST)\n\n' + pinnedContent);
  }

  // Inject team notes (single injection point — not in buildAgentContext) — capped via ENGINE_DEFAULTS
  let notes = getNotes();
  if (notes) {
    if (Buffer.byteLength(notes, 'utf8') > ENGINE_DEFAULTS.maxNotesPromptBytes) {
      const sections = notes.split(/(?=^### )/m);
      const recent = sections.slice(-10).join('') || notes;
      const olderCount = Math.max(0, sections.length - 10);
      const footer = olderCount > 0 ? `\n\n_${olderCount} older entries in \`notes.md\` — Read if needed._` : '';
      const budget = Math.max(0, ENGINE_DEFAULTS.maxNotesPromptBytes - Buffer.byteLength(footer, 'utf8'));
      notes = truncateTextBytes(recent, budget, '\n\n_...notes truncated_') + footer;
    }
    inertAppendices.push('\n\n---\n\n## Team Notes (MUST READ)\n\n' + notes);
  }

  // Inject KB guardrail
  content += `\n\n---\n\n## Knowledge Base Rules\n\n`;
  content += `**Never delete, move, or overwrite files in \`knowledge/\`.** The sweep (consolidation engine) is the only process that writes to \`knowledge/\`. If you think a KB file is wrong, note it in your learnings file — do not touch \`knowledge/\` directly.\n`;

  // Inject learnings requirement
  const timeStamp = ts().slice(11, 16).replace(':', '');
  const inboxSlug = [vars.agent_id || 'agent', vars.task_id || '', dateStamp(), timeStamp].filter(Boolean).join('-');
  content += `\n\n---\n\n## REQUIRED: Write Learnings\n\n`;
  const noteId = `NOTE-${shared.uid()}`;
  content += `After completing your task, write **one** findings file to:\n`;
  content += `\`${MINIONS_DIR}/notes/inbox/${inboxSlug}.md\`\n\n`;
  content += `Start the file with this YAML frontmatter (required for tracking):\n`;
  content += `\`\`\`\n---\nid: ${noteId}\nagent: ${vars.agent_id || 'agent'}\ndate: ${dateStamp()}\n---\n\`\`\`\n\n`;
  content += `**IMPORTANT: Write exactly ONE inbox file per task.** If the playbook above already specifies an inbox path, use THAT path instead and include your learnings in the same document. Do NOT create a second file — duplicates clog consolidation.\n\n`;
  content += `Include in your findings file:\n`;
  content += `- What you learned about the codebase\n`;
  content += `- Patterns you discovered or established\n`;
  content += `- Gotchas or warnings for future agents\n`;
  content += `- Conventions to follow\n`;
  content += `- **SOURCE REFERENCES for every finding** — file paths with line numbers, PR URLs, API endpoints, config keys. Format: \`(source: path/to/file.ts:42)\` or \`(source: PR-12345)\`. Without references, findings cannot be verified.\n\n`;
  content += `### Skill Extraction (IMPORTANT)\n\n`;
  content += `If during this task you discovered a **repeatable workflow** — a multi-step procedure, workaround, build process, or pattern that other agents should follow in similar situations — only output it as a fenced skill block when **all** of these are true: (1) you had to discover it during this task, (2) it is not already captured in team memory, repo docs, existing playbooks, or existing skills, and (3) another agent is likely to reuse it on future tasks. **Zero skills is the default.** Prefer the inbox findings for one-off notes, repo facts, and task-specific observations.\n\n`;
  content += `Format your skill as a fenced code block with the \`skill\` language tag:\n\n`;
  content += '````\n```skill\n';
  content += `---\nname: short-descriptive-name\ndescription: One-line description of what this skill does\nallowed-tools: Bash, Read, Edit\ntrigger: when should an agent use this\nscope: minions\nproject: any\n---\n\n# Skill Title\n\n## Steps\n1. ...\n2. ...\n\n## Notes\n...\n`;
  content += '```\n````\n\n';
  content += `- Set \`scope: minions\` for cross-project or Minions-wide skills; the engine writes them to the selected runtime's native personal skills directory\n`;
  content += `- Set \`scope: project\` + \`project: <name>\` only for repo-specific skills; the engine queues a PR to the selected runtime's native project skills directory\n`;
  content += `- Emit at most one skill block per task unless you uncovered two clearly distinct reusable workflows\n`;
  content += `- Do NOT create a skill for one-off bug fixes, isolated command output, obvious repo facts, or anything already covered by existing docs/playbooks/skills\n`;

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

  // Validate required template variables before substitution
  const validation = validatePlaybookVars(type, allVars);
  if (!validation.valid) {
    log('error', `Playbook "${type}": missing required template variables: ${validation.missing.join(', ')} — skipping render`);
    return null;
  }

  // Capture which vars are actually referenced in the template before substitution
  const referencedVars = new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(m => m.slice(2, -2)));

  // Process conditional blocks: {{#key}}...{{/key}} — include block only if key is truthy
  content = content.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, block) => {
    const val = allVars[key];
    return (val && String(val).trim()) ? block : '';
  });

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

  // Warn on variables that resolved to empty string — only for vars actually used in the template
  const emptyVars = Object.entries(allVars)
    .filter(([key, val]) => String(val) === '' && referencedVars.has(key) && !PLAYBOOK_OPTIONAL_VARS.has(key))
    .map(([key]) => key);
  if (emptyVars.length > 0) {
    log('warn', `Playbook "${type}": template variables resolved to empty string: ${emptyVars.join(', ')}`);
  }

  // Warn on any remaining unresolved {{variable}} placeholders
  const unresolved = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(m => m.slice(2, -2)))];
  if (unresolved.length > 0) {
    log('warn', `Playbook "${type}": unresolved template variables: ${unresolved.join(', ')}`);
  }

  if (inertAppendices.length > 0) {
    content += inertAppendices.join('');
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
  prompt += `4. Write learnings to the path specified in the task prompt (format: \`notes/inbox/{agent}-{work-item-id}-{date}-{time}.md\`)\n`;
  prompt += `5. Agent status is managed by the engine via dispatch.json — agents do not need to track their own status\n`;
  prompt += `6. If you discover a repeatable workflow, output it as a \\\`\\\`\\\`skill fenced block — minions-scoped skills are auto-extracted to the selected runtime's native personal skills directory\n\n`;

  return prompt;
}

// Bulk context: history, notes, conventions, skills — prepended to user/task prompt.
// This is the content that grows over time and would bloat the system prompt.
function buildAgentContext(agentId, config, project) {
  project = project || getProjects(config)[0] || {};
  let context = '';

  function appendContextFile(heading, filePath, maxBytes, extra = '') {
    if (!filePath) return;
    const content = safeRead(filePath);
    if (!content || !content.trim()) return;
    const truncated = Buffer.byteLength(content, 'utf8') > maxBytes
      ? truncateTextBytes(content, maxBytes, '\n\n_...truncated; read the full file if needed_')
      : content;
    context += `## ${heading}\n\n`;
    if (extra) context += `${extra}\n\n`;
    context += `${truncated}\n\n`;
  }

  function appendIndex(heading, body, maxBytes) {
    if (!body || !String(body).trim()) return;
    const truncated = Buffer.byteLength(body, 'utf8') > maxBytes
      ? truncateTextBytes(body, maxBytes, '\n\n_...index truncated; use Glob/Read for the full list_')
      : body;
    context += `## ${heading}\n\n${truncated.replace(/^## .+\n\n/, '')}\n`;
  }


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
    appendContextFile('Project Conventions (from CLAUDE.md)', path.join(project.localPath, 'CLAUDE.md'), 8192);
    appendContextFile('Project Agent Instructions (from AGENTS.md)', path.join(project.localPath, 'AGENTS.md'), 8192,
      'These instructions are explicitly injected because some runtimes suppress automatic AGENTS.md loading. Follow them unless they conflict with the Minions task contract or playbook.');
    appendContextFile('Project Copilot Instructions (from .github/copilot-instructions.md)', path.join(project.localPath, '.github', 'copilot-instructions.md'), 8192,
      'Follow these repository instructions unless they conflict with the Minions task contract or playbook.');
  }

  appendContextFile('User Claude Instructions (from ~/.claude/CLAUDE.md)', path.join(os.homedir(), '.claude', 'CLAUDE.md'), 8192,
    'These are the user-level Claude Code instructions available in regular Claude usage. Follow them unless they conflict with the Minions task contract or playbook.');

  appendIndex('Knowledge Base Reference', getKnowledgeBaseIndex(), 8192);

  context += `## Reference Files\n\nKnowledge base entries are in \`knowledge/{category}/*.md\`, and project-local playbooks live in \`projects/<project>/playbooks/\`. Runtime-native skills and commands are left to the selected CLI runtime; Minions does not inject their contents into the task prompt.\n\n`;

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
      `- **${pr.id}** (${pr._project}): ${(pr.title || '').slice(0, 80)} [${(pr.reviewStatus || 'pending')}${pr.buildStatus === 'failing' ? ', BUILD FAILING' : ''}]${pr.branch ? ' branch: `' + pr.branch + '`' : ''}${formatPrContextSuffix(pr)}`
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

function formatPrContextSuffix(pr) {
  if (!Object.prototype.hasOwnProperty.call(pr, '_context')) return '';
  const value = pr._context;
  if (value === undefined || value === '') return '';
  if (typeof value === 'string') return ` — ${value.slice(0, 100)}`;

  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const serialized = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
  const preview = serialized ? `: ${serialized.slice(0, 100)}` : '';
  return ` — [invalid _context: expected string, got ${type}${preview}]`;
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
  // implement:large uses the same playbook as implement (no separate playbook file)
  if (workType === WORK_TYPE.IMPLEMENT || workType === WORK_TYPE.IMPLEMENT_LARGE) {
    return 'implement';
  }
  const hasPrContext = !!(item?._pr || item?.pr_id || item?.targetPr || item?.sourcePr || item?.pr);
  if (workType === WORK_TYPE.REVIEW && !hasPrContext) {
    return 'work-item';
  }
  if (workType === WORK_TYPE.FIX && hasPrContext) {
    return 'fix';
  }
  const typeSpecificPlaybooks = ['explore', 'review', 'test', 'plan-to-prd', 'plan', 'ask', 'verify', 'decompose', 'docs', 'meeting-investigate', 'meeting-debate', 'meeting-conclude'];
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
  resolvePlaybookPath,
  renderPlaybook,
  validatePlaybookVars,
  PLAYBOOK_REQUIRED_VARS,
  PLAYBOOK_OPTIONAL_VARS,
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
