# Playbook: Fix Review Issues

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.squad/config.json` under `project.repositoryId`.
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}

## Your Task

Fix issues found by {{reviewer}} on **{{pr_id}}**: {{pr_title}}
Branch: `{{pr_branch}}`

## Review Findings to Address

{{review_note}}

## How to Fix

1. Create or enter the worktree (this checks out the existing PR branch, not creating a new one):
   ```bash
   cd {{team_root}}
   git fetch origin {{pr_branch}}
   git worktree add ../worktrees/{{pr_branch}} {{pr_branch}} 2>/dev/null || true
   cd ../worktrees/{{pr_branch}}
   git pull origin {{pr_branch}}
   ```

2. Fix each issue listed above

3. Commit and push:
   ```bash
   git add <specific files>
   git commit -m "fix: address review feedback on {{pr_id}}"
   git push
   ```

4. Clean up:
   ```bash
   cd {{team_root}}
   git worktree remove ../worktrees/{{pr_branch}} --force
   ```

## Handling Merge Conflicts
If you encounter merge conflicts (e.g., during `git pull` or when the PR shows conflicts):
1. Resolve conflicts in the worktree, preferring the PR branch changes. Commit the resolution.

## Post Response on ADO PR

Use `mcp__azure-ado__repo_create_pull_request_thread`:
- repositoryId: `{{repo_id}}`
- pullRequestId: `{{pr_number}}`
- content: Explain what was fixed, reference each review finding
- Sign: `Fixed by Squad ({{agent_name}} — {{agent_role}})`

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
