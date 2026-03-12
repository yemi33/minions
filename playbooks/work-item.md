# Work Item: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | ID: {{item_id}} | Priority: {{item_priority}} | Type: {{work_type}}

## Context

Repository ID: from `.squad/config.json` under `project.repositoryId`
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}
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
3. **Create a worktree** for your changes:
   ```bash
   cd {{project_path}}
   git worktree add ../worktrees/feat-{{item_id}} -b feat/{{item_id}}-<short-desc> {{main_branch}}
   cd ../worktrees/feat-{{item_id}}
   ```
4. **Implement** the changes
5. **Build and verify** — ensure the build passes. If it fails, fix and retry (up to 3 times)
6. **Commit and push**:
   ```bash
   git add -A
   git commit -m "feat({{item_id}}): <description>"
   git push -u origin feat/{{item_id}}-<short-desc>
   ```
7. **Create a PR** via `mcp__azure-ado__repo_create_pull_request`:
   - repositoryId: {{repo_id}}
   - sourceRefName: `refs/heads/feat/{{item_id}}-<short-desc>`
   - targetRefName: `refs/heads/{{main_branch}}`
   - title: `feat({{item_id}}): <description>`
8. **Post implementation notes** as a PR thread comment via `mcp__azure-ado__repo_create_pull_request_thread`
9. **Add PR to tracker** — append to `{{project_path}}/.squad/pull-requests.json`:
   ```json
   { "id": "PR-<number>", "title": "...", "agent": "{{agent_name}}", "branch": "...", "reviewStatus": "pending", "status": "active", "created": "<date>", "url": "<pr-url>", "prdItems": ["{{item_id}}"] }
   ```
10. **Clean up worktree**:
    ```bash
    cd {{project_path}}
    git worktree remove ../worktrees/feat-{{item_id}} --force
    ```

## After Completion

Write your findings to: `{{team_root}}/decisions/inbox/{{agent_id}}-{{item_id}}-{{date}}.md`

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Rules
- NEVER checkout branches in the main working tree — use worktrees
- Use Azure DevOps MCP tools (`mcp__azure-ado__*`) — NEVER use `gh` CLI
- Use PowerShell for yarn/oagent/gulp commands if applicable
- If you discover a repeatable workflow, save it as a runbook at `{{team_root}}/runbooks/<name>.md`

## Handling Merge Conflicts
If you encounter merge conflicts during push or PR creation:
1. Resolve conflicts in the worktree, preferring your changes
2. Commit the resolution
3. Push again
