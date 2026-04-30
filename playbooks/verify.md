# Plan Verification: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | Team root: {{team_root}}

## Context

Project: {{project_name}}
Repo: {{repo_name}} | Org: {{ado_org}} | ADO Project: {{ado_project}}

## Plan Details

{{task_description}}

## Mission

Verify the completed plan as a whole: build and test the relevant project worktrees, identify how to run the user-facing app if there is one, create or update aggregate E2E PRs when needed, and write a transparent testing guide.

## Long-Running Commands

Builds, dependency installs, tests, and app startup can be silent for several minutes. Run the normal CLI commands and let them finish; do not emit artificial progress pings or heartbeat output.

## Approach

Use the setup information in the plan details to create or enter the aggregate worktrees and merge the relevant PR branches. Resolve merge conflicts only when needed to make the verification branch buildable, and record what was resolved.

For each relevant worktree, follow the repo's own instructions (`CLAUDE.md`, README, package files, Makefiles, project scripts), install/restore dependencies as needed, build, and run tests where they exist. If a project fails, report the error and continue verifying the rest; do not turn this into an implementation/fix task.

If there is a user-facing app, identify the normal command and URL. If the app needs to keep running after the agent exits, start it detached in the worktree, save the PID, verify the URL responds, and include restart/stop commands with absolute paths.

## Testing Guide

Be transparent: clearly state what passed, what failed, what was not run, and why.

Always create the permanent guide linked from the dashboard:

`{{team_root}}/prd/guides/verify-{{plan_slug}}.md`

Create the inbox copy only after a successful verification run:

`{{team_root}}/notes/inbox/verify-{{plan_slug}}.md`

A successful verification run means every required project build/test passed or was legitimately not applicable, each runnable app was started and smoke-checked when required, and the required E2E PRs were created or updated. If verification is failed, blocked, or partial, do not create the inbox copy; record the details in the permanent guide and final response instead.

Use the template at `{{team_root}}/playbooks/templates/verify-guide.md` and clearly separate what was verified from what still needs human review.

## E2E PRs

For each project with aggregate verification changes, create or update one draft/review PR that combines the plan branches into a single reviewable diff. Reuse an existing `e2e/{{plan_slug}}` branch/PR when present. Include the plan summary, merged PRs, testing guide, and build/test status. Do not auto-complete or merge these PRs.

Track each E2E PR in the project's `.minions/pull-requests.json` if it is not already tracked.

## Constraints

- Do not assume any specific platform, language, framework, shell, build system, mobile app, web app, Android, or iOS target.
- Read project docs first; use `CLAUDE.md`, `README.md`, and nearby project configuration as the source of truth.
- Base manual testing steps on the plan acceptance criteria.
- If a project does not build, still document what should be testable once fixed.
- Do not fix product code except for merge-conflict resolutions needed to create the verification branch.
- Leave verification worktrees in place for user inspection.
- Use absolute paths in commands the user may copy.

## When to Stop

Your task is complete once dependency branches are merged, build/test verification has run, the permanent guide is written, the inbox copy is written only if verification succeeded, and E2E PR URLs are included in your final response.

Your final message MUST include each E2E PR URL and the testing guide path, for example: `E2E PR created: <url>` and `Testing guide: {{team_root}}/prd/guides/verify-{{plan_slug}}.md`.
