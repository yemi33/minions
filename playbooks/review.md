# Playbook: Review

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.squad/config.json` under `project.repositoryId`.
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}

## Your Task

Review **{{pr_id}}**: {{pr_title}}
Branch: `{{pr_branch}}`

## How to Review

1. Read the diff:
   ```bash
   git diff main...origin/{{pr_branch}}
   ```

2. For each changed file, verify:
   - Does it follow existing patterns?
   - Are file paths and imports correct?
   - No `console.*` — must use `@officeagent/core` logging
   - No user data in `logInfo`/`logWarn`/`logError`
   - Types are clean and consistent?
   - Tests cover the important logic?
   - No security issues (injection, unsanitized input)?

3. Do NOT blindly approve. If you find real issues:
   - Verdict: **REQUEST_CHANGES**
   - List specific issues with file paths and line numbers
   - Describe what needs to change

4. If the code is genuinely ready:
   - Verdict: **APPROVE**
   - Note any minor non-blocking suggestions

## Post Review on ADO

Use `mcp__azure-ado__repo_create_pull_request_thread`:
- repositoryId: `{{repo_id}}`
- pullRequestId: `{{pr_number}}`
- content: Your full review with verdict, findings, and sign-off
- Sign: `Review by Squad ({{agent_name}} — {{agent_role}})`

## Handling Merge Conflicts
If you encounter merge conflicts (e.g., the PR shows conflicts):
1. Note the conflict in your review comment. Do NOT attempt to resolve — flag it for the author.

## CRITICAL: Do NOT run git checkout on the main working tree. Use `git diff` and `git show` only.

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
