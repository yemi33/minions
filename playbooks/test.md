# Test / Build / Run: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | ID: {{item_id}} | Priority: {{item_priority}}

## Context

ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}
Team root: {{team_root}}

{{scope_section}}

## Task Description

{{item_description}}

{{additional_context}}

## Instructions

This is a **test/build/run task**. Your goal is to build, run, test, or verify something — NOT to create new features or PRs.

1. **Navigate** to the correct project directory
2. **If the task references a branch or PR**, check it out in a worktree:
   ```bash
   cd {{project_path}}
   git worktree add ../worktrees/test-{{item_id}} <branch-name>
   cd ../worktrees/test-{{item_id}}
   ```
3. **Build** the project — follow the repo's build instructions (check CLAUDE.md, package.json, README)
4. **Run** if the task asks for it (e.g., `yarn start`, `yarn dev`, docker-compose, etc.)
5. **Test** if the task asks for it (e.g., `yarn test`, `pytest`, etc.)
6. **Report results** — what worked, what failed, build output, test results, localhost URL if running

## Rules

- **Do NOT create pull requests** — this is a test/verification task only
- **Do NOT push commits** unless the task explicitly asks you to fix something
- **Do NOT modify code** unless the task explicitly asks for a fix
- Use PowerShell for yarn/oagent/gulp commands if applicable
- If a build or test fails, report the error clearly — don't try to fix it unless asked
- If running a local server, report the URL (e.g., http://localhost:3000)

## After Completion

Write your findings to: `{{team_root}}/decisions/inbox/{{agent_id}}-{{item_id}}-{{date}}.md`

Include:
- Build status (pass/fail)
- Test results if applicable
- Any errors or warnings
- Localhost URL if running a server
- Screenshots or output snippets if relevant

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Cleanup

If you created a worktree, clean it up when done:
```bash
cd {{project_path}}
git worktree remove ../worktrees/test-{{item_id}} --force
```
