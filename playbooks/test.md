# Test / Build / Run: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | ID: {{item_id}} | Priority: {{item_priority}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}

{{scope_section}}

## Task Description

{{item_description}}

{{additional_context}}

## Instructions

This is a **test/build/run task**. Your goal is to build, run, test, or verify something — NOT to create new features or PRs.

1. **Navigate** to the correct project directory
2. You are already in the correct working directory. If you need a specific branch, use `git checkout` — do NOT create additional worktrees.
3. **Build** the project — follow the repo's build instructions (check CLAUDE.md, package.json, README)
4. **Run** if the task asks for it (e.g., `yarn start`, `yarn dev`, docker-compose, etc.)
5. **Test** if the task asks for it (e.g., `yarn test`, `pytest`, etc.)
6. **Report results** — what worked, what failed, build output, test results, localhost URL if running

## Working Style

Use subagents only for genuinely parallel, independent tasks. For building, testing, and reporting results, work directly — do not spawn subagents.

## Rules

- **Do NOT create pull requests** — this is a test/verification task only
- **Do NOT push commits** unless the task explicitly asks you to fix something
- **Do NOT modify code** unless the task explicitly asks for a fix
- Use PowerShell for build commands on Windows if applicable
- If a build or test fails, report the error clearly — don't try to fix it unless asked
- If running a local server, report the URL (e.g., http://localhost:3000)

## Run Command

When the build succeeds and the task involves running a server or app, output a ready-to-paste run command using **absolute paths** so the user can launch it from any terminal. Format it exactly like this:

```
## Run Command
cd <absolute-path-to-project-or-worktree> && <exact command to start the server>
```

Example: `cd C:/Users/you/my-project && yarn dev`

The agent process terminates after completion, so any dev server you start will die with it. The user needs this command to run it themselves.

## After Completion

Write your findings to: `{{team_root}}/notes/inbox/{{agent_id}}-{{item_id}}-{{date}}.md`

Include:
- Build status (pass/fail)
- Test results if applicable
- Any errors or warnings
- The run command (absolute paths, copy-pasteable from any terminal)
- Localhost URL if applicable


## When to Stop

Your task is complete once you have run the tests, written findings to the inbox file, and (if applicable) created a PR with new tests. Stop after writing findings.

Do NOT remove worktrees — the engine handles cleanup automatically.
