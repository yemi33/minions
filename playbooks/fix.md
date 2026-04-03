# Playbook: Fix Review Issues

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.minions/config.json` under `project.repositoryId`.
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}

## Your Task

Fix issues found by {{reviewer}} on **{{pr_id}}**: {{pr_title}}
Branch: `{{pr_branch}}`

{{checkpoint_context}}

## Review Findings to Address

{{review_note}}

## How to Fix

1. You are already in the correct worktree on branch `{{pr_branch}}`. Do NOT create additional worktrees.

2. Fix each issue listed above

3. Commit and push:
   ```bash
   git add <specific files>
   git commit -m "fix: address review feedback on {{pr_id}}"
   git push
   ```

Do NOT remove the worktree — the engine handles cleanup automatically.

## Handling Merge Conflicts
If you encounter merge conflicts (e.g., during `git pull` or when the PR shows conflicts):
1. Resolve conflicts in the worktree, preferring the PR branch changes. Commit the resolution.

## Post Response on PR

{{pr_comment_instructions}}
- pullRequestId: `{{pr_number}}`
- content: Explain what was fixed, reference each review finding
- Sign: `Fixed by Minions ({{agent_name}} — {{agent_role}})`

## Test Validation (MANDATORY before pushing)

Before pushing your fix, run the project's test suite:

1. Find the test command (check `package.json` scripts, CLAUDE.md, or README — usually `npm test`)
2. Run the full test suite
3. If any tests fail due to your changes, fix them before pushing
4. Do NOT push code that breaks existing tests

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
