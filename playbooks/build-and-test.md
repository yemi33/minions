# Build & Test: PR {{pr_id}}

> Agent: {{agent_name}} ({{agent_role}}) | Project: {{project_name}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}
Project path: {{project_path}}

## Your Task

A new PR has been created: **{{pr_id}}** — "{{pr_title}}"
Branch: `{{pr_branch}}` | Author: {{pr_author}}

Your job is to **check out the branch, build it, run tests, and if it's a webapp, start a local dev server** so the human reviewer can see it running.

## Instructions

### 1. Set up a worktree for the PR branch

You are already in the correct working directory on branch `{{pr_branch}}`. Do NOT create additional worktrees.

### 2. Install dependencies

Look at the project's build system (package.json, CLAUDE.md, README, Makefile, etc.) and install:
```bash
# Examples — use whatever the project needs:
yarn install   # or npm install
pip install -r requirements.txt
dotnet restore
```

### 3. Build the project

Run the project's build command:
```bash
# Examples:
yarn build   # or npm run build
dotnet build
cargo build
```

If the build **fails**, report the errors clearly and stop. Do NOT attempt to fix the code.

> ⚠️ **Cold builds are silent for minutes** (Gradle daemon spin-up, dotnet restore, fresh `npm install`). Run them via `Bash(run_in_background: true)` then `Monitor` to stream stdout, OR pass an explicit `timeout` on the Bash call (max 600000 ms). Without one of these, the heartbeat monitor will kill the agent at ~5 min of silence. See **Long-Running Build / Test Commands** below.

### 4. Run tests

```bash
# Examples:
yarn test   # or npm test
pytest
dotnet test
```

Report test results: how many passed, failed, skipped.

### 5. Start a local dev server (if applicable)

Determine if this project is a **webapp** (has a dev server, serves HTTP, has a UI):
- Check package.json for `dev`, `start`, `serve` scripts
- Check for frameworks: Next.js, React, Angular, Vue, Express, Flask, ASP.NET
- Check CLAUDE.md for run instructions

If it IS a webapp:
1. Start the dev server
2. Wait for it to be ready (watch for "ready on", "listening on", "compiled" messages)
3. Note the localhost URL and port
4. **Keep the server running** — do NOT kill it

If it is NOT a webapp (library, CLI tool, backend service without UI), skip this step.

## Output Format

Write your findings to: `{{team_root}}/notes/inbox/{{agent_id}}-bt-{{pr_number}}-{{date}}.md`

Structure your report exactly like this:

```markdown
## Build & Test Report: {{pr_id}}

**Branch:** {{pr_branch}}
**Author:** {{pr_author}}
**Project:** {{project_name}}

### Build
- Status: PASS / FAIL
- Notes: (any warnings or issues)

### Tests
- Status: PASS / FAIL / SKIPPED
- Results: X passed, Y failed, Z skipped
- Failed tests: (list if any)

### Local Server
- Status: RUNNING / NOT_APPLICABLE / FAILED
- URL: http://localhost:XXXX (if running)
- Run Command: `cd <absolute-path> && <command>`

### Summary
(1-2 sentence overall assessment — is this PR safe to review?)
```

## Auto-file Work Items on Failure

If the build or tests fail, create a work item so another agent can fix it. Write a JSON entry to the project's work queue:

```bash
# Read existing items, append new one, write back
node -e "
const fs = require('fs');
const p = '{{project_path}}/.minions/work-items.json';
const items = JSON.parse(fs.readFileSync(p, 'utf8') || '[]');
const id = 'W' + String(items.reduce((m,i) => Math.max(m, parseInt((i.id||'').match(/(\d+)$/)?.[1]||0)), 0) + 1).padStart(3, '0');
items.push({
  id,
  title: 'Fix build/test failure on PR {{pr_id}}: <SHORT DESCRIPTION OF FAILURE>',
  type: 'fix',
  priority: 'high',
  description: '<PASTE THE BUILD/TEST ERROR OUTPUT HERE — keep it under 2000 chars>',
  status: 'pending',
  created: new Date().toISOString(),
  createdBy: '{{agent_id}}',
  pr: '{{pr_id}}',
  branch: '{{pr_branch}}'
});
fs.writeFileSync(p, JSON.stringify(items, null, 2));
console.log('Filed work item:', id);
"
```

Replace `<SHORT DESCRIPTION OF FAILURE>` and `<PASTE THE BUILD/TEST ERROR OUTPUT HERE>` with the actual error details. The engine will pick this up on the next tick and dispatch a fix agent.

## Rules

- **Do NOT create pull requests** — this is a build/test task only
- **Do NOT push commits** or modify code
- **Do NOT attempt to fix build/test failures** — report them and file a work item
- If starting a dev server, output the **exact run command with absolute paths** so the user can restart it:
  ```
  ## Run Command
  cd <absolute-path-to-worktree> && <exact start command>
  ```
- Use the worktree path, NOT the main project path, for all commands
- The worktree will persist after your process ends so the user can inspect it

## Do not clean up the worktree

Leave the worktree in place at `{{project_path}}/../worktrees/bt-{{pr_number}}` — the user needs it to review the running app. The engine will clean it up automatically after the PR is merged or closed.


## When to Stop

Your task is complete once you have: (1) built the project, (2) run tests, (3) started the app if applicable, and (4) written your findings to the inbox file. Stop after writing findings.
