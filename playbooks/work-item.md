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
5. **Build and verify** — ensure the build passes. If it fails, fix and retry (up to 3 times)
6. **Commit and push**:
   ```bash
   git add <specific files>
   git commit -m "feat({{item_id}}): <description>"
   git push -u origin {{branch_name}}
   ```
7. **Create a PR:**
   {{pr_create_instructions}}
   - sourceRefName: `refs/heads/feat/{{item_id}}-<short-desc>`
   - targetRefName: `refs/heads/{{main_branch}}`
   - title: `feat({{item_id}}): <description>`
8. **Post implementation notes** as a PR thread comment:
   {{pr_comment_instructions}}
9. **Add PR to tracker** — append to `{{team_root}}/projects/{{project_name}}/pull-requests.json`:
   ```json
   { "id": "PR-<number>", "title": "...", "agent": "{{agent_name}}", "branch": "...", "reviewStatus": "pending", "status": "active", "created": "<date>", "url": "<pr-url>", "prdItems": ["{{item_id}}"] }
   ```
10. Do NOT remove the worktree — the engine handles cleanup automatically.

## After Completion

Write your findings to: `{{team_root}}/notes/inbox/{{agent_id}}-{{item_id}}-{{date}}.md`


## Rules
- Do not checkout branches in the main working tree — use worktrees
- Use the repo host's MCP tools for PR creation — check available MCP tools before starting
- Use PowerShell for build commands on Windows if applicable
- If you discover a repeatable workflow, output it as a ```skill block (the engine auto-extracts it to ~/.claude/skills/)

## Handling Merge Conflicts
If you encounter merge conflicts during push or PR creation:
1. Resolve conflicts in the worktree, preferring your changes
2. Commit the resolution
3. Push again
