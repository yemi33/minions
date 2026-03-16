# Plan Verification: {{item_title}}

> Agent: {{agent_name}} ({{agent_role}}) | Team root: {{team_root}}

## Context

Project: {{project_name}}
Repo: {{repo_name}} | Org: {{ado_org}} | ADO Project: {{ado_project}}

## Plan Details

{{task_description}}

## Your Task

All plan items are complete. Your job is to:
1. **Set up one worktree per project** with all PR branches merged in
2. **Build and test** from each worktree
3. **Start the webapp** on localhost (keep it running)
4. **Write a manual testing guide**

## Step 1: Set Up Worktrees

The description above contains setup commands that create **one worktree per project** and merge all PR branches into it. Run them.

If any merge conflicts occur:
- Resolve them, preferring the PR branch changes
- Commit the resolution in the worktree

After setup, all changes for a project are in a single directory — no switching between branches.

## Step 2: Build Each Project

For each project worktree listed above:
1. `cd` into the worktree path
2. Read its CLAUDE.md / package.json / README for build instructions
3. Install dependencies (`yarn install`, `npm install`, etc.)
4. Run the build (`yarn build`, `npm run build`, etc.)
5. Record: PASS or FAIL with error output

If a build fails, **do NOT fix it** — report the error and continue with other projects.

## Step 3: Run Tests

For each project that built successfully:
1. Run the test suite from the worktree
2. Record passed/failed/skipped counts

## Step 4: Start the Webapp

Determine which project is the **user-facing webapp** (has a dev server, UI):
- Check for `dev`, `start`, `serve` scripts in package.json
- Look for web frameworks (React, Next.js, TanStack, Vite, etc.)

If found:
1. Start the dev server **from the worktree** (not the main working tree)
2. Wait for it to be ready (watch for "ready on", "listening on", "compiled")
3. Note the localhost URL and port
4. **Keep it running** — do NOT kill the process
5. Output the exact restart command with **absolute worktree paths**

## Step 5: Write the Manual Testing Guide

Create the testing guide in TWO locations:
1. **Permanent location** (linked from dashboard): `{{team_root}}/prd/verify-{{date}}.md`
2. **Inbox copy** (for team consolidation): `{{team_root}}/notes/inbox/verify-{{date}}.md`

Structure:

```markdown
# Manual Testing Guide

**Date:** {{date}}
**Plan:** <plan file>
**Local Server:** http://localhost:XXXX (or N/A)
**Restart Command:** `cd <absolute-worktree-path> && <command>`

## Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| name | path | PASS/FAIL | X pass, Y fail | notes |

## What to Test

### <Feature Name> (Plan Item ID)
**What changed:** brief description
**How to test:**
1. Navigate to http://localhost:XXXX/path
2. Click on / interact with ...
3. You should see ...

**Expected behavior:**
- (from acceptance criteria)
- (from acceptance criteria)

### <Next Feature> ...

## Integration Points

Cross-project interactions to verify:
- e.g., "Bebop sends message via AugLoop → OfficeAgent receives and responds"
- e.g., "Progression UI updates in real-time as WebSocket messages arrive"

## Known Issues
- Build warnings, test failures, merge conflicts, unimplemented items

## Quick Smoke Test
A minimal 5-step checklist to verify the core functionality:
1. Open http://localhost:XXXX
2. ...
3. ...
4. ...
5. ...
```

## Step 6: Create E2E Pull Requests

For each project that has changes, create a single **aggregate PR** that combines all the plan's branches into one. This gives the human reviewer a single diff showing the full picture of everything built.

For each project worktree:

1. You're already in the worktree with all branches merged. Push this combined branch:
   ```bash
   cd <worktree-path>
   git checkout -b e2e/<plan-slug>
   git push origin e2e/<plan-slug>
   ```

2. Create a PR targeting the project's main branch using `mcp__azure-ado__repo_create_pull_request` (or `gh pr create` for GitHub):
   - **Title:** `[E2E] <plan summary>`
   - **Description:** Include:
     - The plan summary
     - List of all individual PRs that are merged into this branch
     - The testing guide (copy from Step 5)
     - Build/test status from Step 2-3
   - **Target branch:** the project's main branch (e.g., `main` or `master`)
   - **Do NOT auto-complete** — this is for review only
   - **Mark as draft** if the option is available

3. Add the E2E PR to the project's `.squad/pull-requests.json`:
   ```bash
   node -e "
   const fs = require('fs');
   const p = '<project-path>/.squad/pull-requests.json';
   const prs = JSON.parse(fs.readFileSync(p, 'utf8'));
   prs.push({
     id: 'PR-<number>',
     title: '[E2E] <plan summary>',
     agent: '{{agent_name}}',
     branch: 'e2e/<plan-slug>',
     reviewStatus: 'pending',
     status: 'active',
     created: new Date().toISOString().slice(0,10),
     url: '<pr-url>',
     prdItems: []
   });
   fs.writeFileSync(p, JSON.stringify(prs, null, 2));
   "
   ```

4. Note the E2E PR URLs in the testing guide.

## Rules

- Base testing steps on the **acceptance criteria** from each plan item
- Include **concrete steps** — URLs, buttons to click, inputs to type, expected visual results
- If a project doesn't build, still document what SHOULD be testable once fixed
- Do NOT fix code — only report issues
- Leave all worktrees in place for the user to inspect
- The local server MUST keep running after your process exits
- Use absolute paths everywhere so the user can copy-paste commands
- E2E PRs are for review only — do NOT auto-complete or merge them

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
