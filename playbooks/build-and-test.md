# Build & Test: PR {{pr_id}}

> Agent: {{agent_name}} ({{agent_role}}) | Project: {{project_name}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}
Project path: {{project_path}}

## Mission

A new PR has been created: **{{pr_id}}** - "{{pr_title}}"
Branch: `{{pr_branch}}` | Author: {{pr_author}}

Run the project's normal build/test verification for this PR and report whether it is ready for human review. If it is a runnable app, identify the local URL and the exact command needed to run it.

## Long-Running Commands

Builds, dependency installs, tests, and dev servers can be quiet for a long time. Let normal CLI commands run naturally; do not add artificial heartbeat output or split commands just to show progress.

## Approach

Work from the current checkout prepared by the engine. Read the repo's own instructions first (`CLAUDE.md`, README, package files, Makefiles, project scripts) and adapt to the build system you find.

If build or tests fail, report the relevant errors clearly and stop. Do not fix code, push commits, or create PRs from this task.

If a server/app should be run for review, include the URL and a copy-pasteable run command with absolute paths. If the server must survive after the agent exits, start it detached and record the PID, restart command, and stop command; otherwise just provide the command for the user.

## Findings

Write findings to `{{team_root}}/notes/inbox/{{agent_id}}-bt-{{pr_number}}-{{date}}.md` only after successful verification.

Include:
- Branch, author, and project
- Build status and important warnings/errors
- Test status and failed test names if any
- Local server status, URL, run command, PID, restart command, and stop command if applicable
- A short summary of whether the PR is ready to review

## Constraints

- Do not create pull requests or push commits.
- Do not modify code unless the task explicitly changes into a fix task.
- Use the current checkout/worktree prepared by the engine.
- Do not remove worktrees; the engine handles cleanup automatically.
