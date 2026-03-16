# Plan Verification: {{item_title}}

> Agent: {{agent_name}} ({{agent_role}}) | Team root: {{team_root}}

## Context

Project: {{project_name}}
Repo: {{repo_name}} | Org: {{ado_org}} | ADO Project: {{ado_project}}

## What to Verify

{{task_description}}

## Your Task

All plan items are complete. Your job is to:
1. **Build all affected projects** and verify they compile
2. **Run tests** across all projects
3. **Start the webapp** on localhost if applicable (and keep it running)
4. **Write a manual testing guide** covering every completed feature

## Step 1: Check Out All Branches

Use the checkout commands from the description above. If branches aren't specified, look at the pull requests listed and fetch their branches:

```bash
cd {{project_path}}
git fetch origin
```

For each PR branch, create a worktree:
```bash
git worktree add ../worktrees/verify-<branch> origin/<branch> 2>/dev/null || (cd ../worktrees/verify-<branch> && git pull)
```

## Step 2: Build Each Affected Project

For each project with changes:
1. Read its CLAUDE.md / package.json / README for build instructions
2. Install dependencies
3. Run the build
4. Record PASS or FAIL with error details

If a build fails, **do NOT fix it** — report the error and continue.

## Step 3: Run Tests

For each project that built successfully:
1. Run the test suite
2. Record passed/failed/skipped counts

## Step 4: Start the Webapp

Determine which project serves a UI (look for `dev`/`start`/`serve` scripts, web frameworks):
1. Start the dev server in the worktree (NOT the main working tree)
2. Wait for it to be ready
3. Note the localhost URL and port
4. **Keep it running** — do NOT kill the process
5. Output the exact restart command with absolute paths

## Step 5: Write the Manual Testing Guide

Create: `{{team_root}}/notes/inbox/verify-{{date}}.md`

Structure:

```markdown
# Manual Testing Guide

**Date:** {{date}}
**Local Server:** http://localhost:XXXX (or N/A)
**Restart Command:** `cd <path> && <command>`

## Build Status

| Project | Build | Tests | Notes |
|---------|-------|-------|-------|
| name | PASS/FAIL | X pass, Y fail | notes |

## What to Test

For each completed feature:

### <Feature Name> (Plan Item ID)
**What changed:** brief description
**How to test:**
1. Step-by-step instructions with specific URLs/buttons/inputs
2. What you should see at each step

**Expected behavior:**
- (from acceptance criteria)

## Integration Points

Cross-project interactions to verify:
- e.g., "Component A sends data → Component B receives and displays it"

## Known Issues
- Build warnings, test failures, unimplemented items

## Quick Smoke Test
A 5-step checklist for core functionality:
1. ...
2. ...
3. ...
4. ...
5. ...
```

## Rules

- Base testing steps on the **acceptance criteria** from each plan item
- Include **concrete steps** (URLs, buttons, inputs), not vague instructions
- If a project doesn't build, document what SHOULD be testable once fixed
- Do NOT create PRs or push commits
- Do NOT fix code
- Leave all worktrees in place
- The local server MUST keep running after your process exits

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
