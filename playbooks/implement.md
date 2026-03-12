# Playbook: Implement

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.squad/config.json` under `project.repositoryId`.
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}

## Branch Naming Convention
Branch format: `feat/{{item_id}}-<short-description>`
Examples: `feat/M001-hr-agent`, `feat/M013-multimodal-input`
Keep branch names lowercase, use hyphens, max 60 chars.

## Your Task

Implement PRD item **{{item_id}}: {{item_name}}**
- Priority: {{item_priority}}
- Complexity: {{item_complexity}}

## Instructions

1. Read relevant source code and reference implementations before writing anything
2. Follow existing patterns exactly — check `agents/create-agent/` or the closest comparable agent
3. Use `@officeagent/core` logging — NEVER `console.*`
4. NO user data in `logInfo`/`logWarn`/`logError`

## Git Workflow (WORKTREE — CRITICAL)

```bash
cd {{team_root}}
git worktree add ../worktrees/{{branch_name}} -b {{branch_name}} main
cd ../worktrees/{{branch_name}}
```

Do ALL work in the worktree. When done:

```bash
git add <specific files>
git commit -m "{{commit_message}}"
git push -u origin {{branch_name}}
```

Then return and clean up:
```bash
cd {{team_root}}
git worktree remove ../worktrees/{{branch_name}} --force
```

## Create PR on ADO

Use `mcp__azure-ado__repo_create_pull_request`:
- repositoryId: `{{repo_id}}`
- sourceRefName: `refs/heads/{{branch_name}}`
- targetRefName: `refs/heads/main`
- title: `{{commit_message}}`
- labels: `["squad:{{agent_id}}"]`

Include in the PR description:
- What was built and why
- Files changed
- How to build and test: `yarn build` (PowerShell), `yarn start`, browser URL if applicable
- Test plan

## Post self-review on ADO PR

Use `mcp__azure-ado__repo_create_pull_request_thread`:
- repositoryId: `{{repo_id}}`
- pullRequestId: `<from PR creation>`
- Re-read your own diff critically before posting
- Sign: `Built by Squad ({{agent_name}} — {{agent_role}})`

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Build and Demo Rule

After implementation, you MUST:
1. Build: `yarn build` (PowerShell only)
2. Start: `yarn start` or `yarn start:compose`
3. Include the browser URL and run instructions in the PR description

After building, verify the build succeeded. If the build fails:
1. Read the error output carefully
2. Fix the issue
3. Re-run the build
4. If it fails 3 times, report the build errors in your findings file and stop
