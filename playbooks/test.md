# Test / Build / Run: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | ID: {{item_id}} | Priority: {{item_priority}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}

{{scope_section}}

## Task Description

{{item_description}}

{{additional_context}}

## Mission

Build, run, test, or verify the requested target. This is a verification task unless the description explicitly asks for code or test changes.

## Long-Running Commands

Builds, tests, dependency installs, and server startups can be silent for several minutes. Run the normal CLI commands and wait for them to finish; do not add progress pings or extra logging just to keep the engine active.

## Approach

Work from the current project checkout prepared by the engine. Follow the repo's own instructions (`CLAUDE.md`, README, package files, Makefiles, project scripts) and run the smallest sensible set of commands that proves the requested behavior.

If the task asks you to add or modify files, commit those focused changes, push the branch, and create a PR using the same conventions as implement tasks. For pure build/run/verify tasks, do not push or create a PR.

If a build or test fails, report the error clearly instead of fixing it unless the task explicitly asks for a fix.

If the task involves a local server or app, report the URL and a ready-to-paste run command with absolute paths:

```text
## Run Command
cd <absolute-path-to-project-or-worktree> && <exact command to start the server>
```

## Findings

Write findings to `{{team_root}}/notes/inbox/{{agent_id}}-{{item_id}}-{{date}}.md` only after successful completion.

Include build status, test results, errors or warnings, run command, localhost URL if applicable, and PR URL if file changes were made.

## Constraints

- Do not modify production code unless explicitly asked.
- Use PowerShell for build commands on Windows if applicable.
- Do not remove worktrees; the engine handles cleanup automatically.
