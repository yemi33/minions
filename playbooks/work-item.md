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

## Delivery Contract

Treat this like the user typed the task directly into a CLI agent:

- Work in the correct project directory: `{{project_path}}`.
- You are already in a worktree on branch `{{branch_name}}`. Do NOT create additional worktrees.
- Understand the requested outcome, inspect the relevant source/tests/docs, and make the complete change needed.
- Follow existing repo conventions and avoid unrelated cleanups.
- Validate with the repo's documented build/test/check commands. Fix regressions you introduced; if failures are pre-existing or outside the task, document the evidence.
- Do NOT publish code with a broken build or failing tests that you introduced.
- Long builds and tests may be quiet for several minutes. Let normal CLI commands run without artificial heartbeat output.

After the change is ready for review, commit only relevant files, push `{{branch_name}}`, create the PR, and post implementation notes with the validation result:

```bash
git add <specific files>
git commit -m "feat({{item_id}}): <description>"
git push -u origin {{branch_name}}
```

{{pr_create_instructions}}
- sourceRefName: `refs/heads/feat/{{item_id}}-<short-desc>`
- targetRefName: `refs/heads/{{main_branch}}`
- title: `feat({{item_id}}): <description>`

{{pr_comment_instructions}}

Do NOT remove the worktree — the engine handles cleanup automatically.

## After Successful Completion

Write your findings to `{{team_root}}/notes/inbox/{{agent_id}}-{{item_id}}-{{date}}.md` only after the work item succeeds: build/tests pass, the branch is pushed, and the PR is created.

If you stop because the task failed, is blocked, or is only partially complete, do **not** write an inbox note. Put the failure details in your final response and in any required PR/work-item comment instead.

## Handling Merge Conflicts
If you encounter merge conflicts during push or PR creation:
1. Resolve conflicts in the worktree, preferring your changes
2. Commit the resolution
3. Push again

## When to Stop

Your task is complete when the requested work item is delivered, the validation story is truthful and sufficient for review, the branch is pushed, and the PR exists. Do NOT continue into unrelated improvements.

Do NOT run `gh pr merge` or any other merge command on your own PR. The engine reviews and merges PRs through a separate review cycle. Self-merging is prohibited.
