# Plan Verification: {{item_name}}

> Agent: {{agent_name}} ({{agent_role}}) | Team root: {{team_root}}

## Context

Project: {{project_name}}
Repo: {{repo_name}} | Org: {{ado_org}} | ADO Project: {{ado_project}}

## Plan Details

{{task_description}}

## Your Task

Verify that a set of related changes work correctly together. You must **figure out** how to build, test, and run this specific project — do not assume any particular language, framework, or tooling. Your job is to:

1. **Set up worktrees** with all PR branches merged
2. **Understand the project** — read its docs to learn how to build, test, and run it
3. **Build and test** from each worktree
4. **Start the application** if applicable (keep it running detached)
5. **Write a transparent verification report and testing guide**
6. **Create E2E pull requests**

## Step 1: Set Up Worktrees

The description above contains setup commands that create **one worktree per project** and merge all PR branches into it. Run them.

If any merge conflicts occur:
- Resolve them, preferring the PR branch changes
- Commit the resolution in the worktree

After setup, all changes for a project are in a single directory — no switching between branches.

## Step 2: Understand the Project

For each project worktree, **read its documentation** to understand:
- What language/framework it uses
- How to install dependencies
- How to build it
- How to run tests
- How to start it (if it has a runnable application)

Check these files: `CLAUDE.md`, `README.md`, `package.json`, `Makefile`, `Cargo.toml`, `pyproject.toml`, `build.gradle`, `CMakeLists.txt`, `docker-compose.yml`, `Podfile`, `build.gradle.kts`, `*.xcodeproj`, `*.xcworkspace`, or whatever build system the project uses.

**Do not assume any specific platform.** The project could be a web app, mobile app (Android/iOS/React Native/Flutter), backend service, CLI tool, library, monorepo, or anything else. Adapt your verification approach to what the project actually is.

## Step 3: Build and Test

For each project worktree:
1. `cd` into the worktree path
2. Install dependencies using whatever the project requires
3. Run the build using the project's build system
4. Run the test suite
5. Record: PASS or FAIL with error output, test counts (passed/failed/skipped)

If a build or test fails, **do NOT fix it** — report the exact error and continue with other projects.

## Step 4: Start the Application (if applicable)

Determine if the project has a **runnable application** (web server, API, desktop app, mobile emulator, etc.) by reading its documentation and build config. For mobile apps, check if an emulator/simulator can be launched or if building an APK/IPA is the appropriate verification step.

If found:
1. Start it **detached from your process** so it survives after you exit. Use the platform-appropriate method:
   ```bash
   cd <worktree-path>
   nohup <start-command> > app-server.log 2>&1 &
   echo $! > app-server.pid
   ```
   On Windows, use `spawn` with `detached: true` and `child.unref()`.

2. Wait a few seconds, then verify it's responding (e.g. `curl -s -o /dev/null -w "%{http_code}" http://localhost:<PORT>`)
3. Note the URL, port, and PID
4. Output the exact restart command with **absolute worktree paths**
5. Include the stop command (e.g. `kill <PID>` or `taskkill /PID <PID> /F` on Windows)

If the project has no runnable application, skip this step and note that in the guide.

## Step 5: Write the Verification Report and Testing Guide

Create the guide in TWO locations:
1. **Permanent location** (linked from dashboard): `{{team_root}}/prd/guides/verify-{{plan_slug}}.md`
2. **Inbox copy** (for team consolidation): `{{team_root}}/notes/inbox/verify-{{plan_slug}}.md`

**Be transparent.** The guide must clearly state what was built, what was tested, what passed, what failed, and what still needs human verification.

Structure:

```markdown
# Verification Report & Testing Guide

**Date:** {{date}}
**Plan:** {{source_plan}}
**Verified by:** {{agent_name}}

## What Was Built

For each completed plan item, summarize:
- **Item ID:** what it implements
- **Key changes:** files modified, features added, behaviors changed
- **PR:** link to the individual PR

## Verification Results

### Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| name | path | PASS/FAIL | X pass, Y fail, Z skip | error details if any |

### Automated Test Results
- Total: X passed, Y failed, Z skipped
- Notable failures: (list any, with error messages)
- Test coverage notes: (are the new features covered by tests?)

### What Was Verified
For each plan item, state what you actually checked:
- Did the build pass with this change included?
- Did existing tests pass?
- Were there new tests for the new functionality?
- Any runtime errors observed?

### What Could NOT Be Verified Automatically
List anything that requires human judgment:
- UI/UX changes that need visual inspection
- Behaviors that depend on external services
- Performance characteristics
- Edge cases not covered by tests

## Manual Testing Guide

**How to run:** (server URL, emulator command, APK path, or N/A)
**Restart Command:** `cd <absolute-worktree-path> && <command>` (if applicable)

### <Feature Name> (Plan Item ID)
**What changed:** brief description
**How to test:**
1. Step-by-step instructions
2. With concrete actions (URLs, buttons, inputs)
3. And expected outcomes

**Acceptance criteria check:**
- [ ] (from plan item acceptance criteria)
- [ ] (from plan item acceptance criteria)

### <Next Feature> ...

## Integration Points

Cross-project or cross-feature interactions to verify:
- e.g., "Service A calls Service B — verify the API contract"

## Known Issues
- Build warnings, test failures, merge conflicts, unimplemented items

## Quick Smoke Test
A minimal 5-step checklist to verify the core functionality:
1. ...
2. ...
3. ...
4. ...
5. ...
```

## Step 6: Create E2E Pull Requests

For each project that has changes, create a single **aggregate PR** that combines all the plan's branches into one. This gives the human reviewer a single diff showing the full picture.

For each project worktree:

1. Push the combined branch:
   ```bash
   cd <worktree-path>
   git checkout -b e2e/{{plan_slug}}
   git push origin e2e/{{plan_slug}}
   ```

2. Create a PR targeting the project's main branch using `mcp__azure-ado__repo_create_pull_request` (or `gh pr create` for GitHub):
   - **Title:** `[E2E] <plan summary>`
   - **Description:** Include:
     - The plan summary
     - List of all individual PRs merged into this branch
     - Build/test status from Step 3
     - Link to the testing guide
   - **Target branch:** the project's main branch (e.g., `main` or `master`)
   - **Do NOT auto-complete** — this is for review only
   - **Mark as draft** if the option is available

3. Add the E2E PR to the project's `.minions/pull-requests.json`:
   ```bash
   node -e "
   const fs = require('fs');
   const p = '<project-path>/.minions/pull-requests.json';
   const prs = JSON.parse(fs.readFileSync(p, 'utf8'));
   prs.push({
     id: 'PR-<number>',
     title: '[E2E] <plan summary>',
     agent: '{{agent_name}}',
     branch: 'e2e/{{plan_slug}}',
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

- **Read the project docs first** — never assume a build system, language, or framework
- Base testing steps on the **acceptance criteria** from each plan item
- Include **concrete steps** — URLs, buttons to click, inputs to type, expected results
- Be **transparent** — clearly separate what you verified vs what needs human review
- If a project doesn't build, still document what SHOULD be testable once fixed
- Do NOT fix code — only report issues
- Leave all worktrees in place for the user to inspect
- The application MUST be started **detached** so it keeps running after your process exits
- Use absolute paths everywhere so the user can copy-paste commands
- E2E PRs are for review only — do NOT auto-complete or merge them

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
