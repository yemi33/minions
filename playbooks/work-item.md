# Work Item: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | ID: {{item_id}} | Priority: {{item_priority}} | Type: {{work_type}}

## Context

Repository ID: from `.minions/config.json` under `project.repositoryId`
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}

{{scope_section}}

## Task Description

{{item_description}}

{{additional_context}}

## Branch Naming Convention
Branch format: `feat/{{item_id}}-<short-description>`
Keep branch names lowercase, use hyphens, max 60 chars.

## Steps

1. **Understand the task** — read the description carefully, explore relevant code
2. **Navigate** to the correct project directory: `{{project_path}}`
3. You are already in a worktree on branch `{{branch_name}}`. Do NOT create additional worktrees.
4. **Implement** the changes
5. **Build** — using the repo's build system (check CLAUDE.md, package.json, README, Makefile). If it fails, fix and retry (up to 3 times).
6. **Run the full test suite** — find the test command from project docs. Fix any regressions you introduced. Do NOT push with failing tests.
7. **Run any other checks** the repo defines (linting, type checking, formatting)
8. **Commit and push** (only after build and tests pass):
   ```bash
   git add <specific files>
   git commit -m "feat({{item_id}}): <description>"
   git push -u origin {{branch_name}}
   ```
9. **Create a PR:**
   {{pr_create_instructions}}
   - sourceRefName: `refs/heads/feat/{{item_id}}-<short-desc>`
   - targetRefName: `refs/heads/{{main_branch}}`
   - title: `feat({{item_id}}): <description>`
10. **Post implementation notes** as a PR thread comment:
    {{pr_comment_instructions}}

Do NOT remove the worktree — the engine handles cleanup automatically.

## After Completion

Write your findings to: `{{team_root}}/notes/inbox/{{agent_id}}-{{item_id}}-{{date}}.md`

## Handling Merge Conflicts
If you encounter merge conflicts during push or PR creation:
1. Resolve conflicts in the worktree, preferring your changes
2. Commit the resolution
3. Push again

## When to Stop

Your task is complete once you have: (1) confirmed build and tests pass, (2) pushed your branch, and (3) created the PR. Do NOT continue beyond the task description. Stop immediately.
