---
source: ralph-2026-03-16.md
agent: ralph
category: conventions
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (BT-4970170 Build & Test)

## Findings

### PR-4970170 is in office-bohemia, not OfficeAgent
- PR-4970170 (`feat/PL-W004-cowork-scaffold`) targets `master` in the **office-bohemia** repo (project OC, repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`), not OfficeAgent (project ISS).
- The task dispatch incorrectly identified it as an OfficeAgent PR. Always verify repo via `az repos pr show --id <prId>` before assuming the project. (source: `az repos pr show --id 4970170` output showing `repoName: office-bohemia`)

### office-bohemia worktree builds require dependency transpile first
- `yarn workspace @bebopjs/bebop test` fails with `Cannot find module '@fluidx/office-bohemia-build-tools/lib/jest/jest-config.js'` until the build-tools package is transpiled.
- Fix: `yarn lage transpile --to @fluidx/office-bohemia-build-tools --only --verbose` (~0.5s cached). (source: `packages/office-bohemia-build-tools/` → `node_modules/@fluidx/office-bohemia-build-tools/lib/`)
- Even after this, 7 of 15 tests fail due to other unbuilt dependencies (`@bebopjs/bebop-ux`, `@bebopjs/bebop-sydney-client`, etc.)

### office-bohemia test baseline (from worktree without full build)
- 8 PASS, 7 FAIL out of 15 test suites when running from a worktree without full dependency build.
- All failures are module resolution (`Cannot find module`) — pre-existing, not regressions.
- Passing tests: `withOptimisticUpdate`, `PerformanceTelemetryReporter`, `adaptive/mode`, `environment`, `metricValidation`, `telemetry.functions`, `mergeCommaSeparated`, `intentDetector`.

### Bebop typecheck baseline is exactly 211 errors
- Confirmed again: `yarn workspace @bebopjs/bebop build` produces exactly 211 TS2307 errors in typecheck step, all pre-existing. (source: `apps/bebop/` typecheck output)
- Transpile step passes cleanly (cached/skipped).

### Existing worktree reuse pattern
- The worktree at `C:/Users/yemishin/worktrees/feat-PL-W004-cowork` was already set up on the correct branch with the PR commit. No need to create a new `bt-4970170` worktree — reuse existing worktrees when they already track the correct branch. (source: `git worktree list` output)

### Cross-repo PR detection
- When an OfficeAgent worktree exists with the same branch name but zero commits, and the PR is active on ADO, check if the PR belongs to a different repo (office-bohemia). The `.squad/pull-requests.json` should include `repo` and `project` fields to disambiguate. (source: PR-4970170 appearing under office-bohemia while branch existed in OfficeAgent worktree)
