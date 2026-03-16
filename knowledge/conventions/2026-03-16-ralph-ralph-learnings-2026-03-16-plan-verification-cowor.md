---
source: ralph-2026-03-16.md
agent: ralph
category: conventions
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (Plan Verification: Cowork UX)

## Task
Verification of completed plan `officeagent-2026-03-15.json` — Claude Cowork UX in Bebop with OfficeAgent capabilities, AugLoop integration.

## Findings

### Worktrees Were Already Set Up by Prior Verification
Dallas's prior verification run created both worktrees with all PR branches merged. The OfficeAgent worktree is on `e2e/cowork-w025` branch and the office-bohemia worktree has the `e2e/cowork-w025` branch available locally. E2E PRs PR-4972662 and PR-4972663 were already created and pushed. (source: `git log --oneline` in both worktrees)

### OfficeAgent Build Results Confirmed
- `@officeagent/message-protocol`: PASS — 3.59s build, 113 tests pass (source: `modules/message-protocol/`)
- `@officeagent/augloop-transport`: PASS — 3.68s build, 11 tests pass from dist, 1 source suite fails from babel `import type` issue (source: `modules/augloop-transport/tests/message-adapter.test.ts:6`)
- `@officeagent/core`: FAIL — 4 TS errors in `tests/websocket/websocket-manager.test.ts` at lines 137, 342, 837, 886 (pre-existing on main) (source: `modules/core/tests/websocket/websocket-manager.test.ts`)
- `@officeagent-tools/cowork-demo`: PASS — 49 tests across 4 suites (source: `.devtools/cowork-demo/`)

### office-bohemia 19 TS Errors Confirmed
The 19 TypeScript errors in 6 cowork files match Dallas's prior findings exactly. These are cross-PR integration boundary mismatches from merging 8 independent PRs:
- `streamingBridge.ts` (5 errors): imports `TransportConfig`, `TransportState` from augloopTransport.ts which no longer exports those names (source: `apps/bebop/src/features/cowork/server/streamingBridge.ts:22-23`)
- `useCoworkStream.ts` (8 errors): references renamed atoms (source: `apps/bebop/src/features/cowork/hooks/useCoworkStream.ts:15`)
- `CoworkLayout.tsx` (2 errors), `CoworkErrorBoundary.tsx` (2 errors), `CoworkChatPanel.tsx` (1 error), `transportRegistry.ts` (1 error)

### Vite Dev Server Runs Despite Type Errors
Confirmed that Vite 7 with esbuild starts and serves at http://localhost:3002/bebop/ despite 19 TS errors. esbuild does not type-check. The cowork route at `/bebop/cowork` returns a TanStack Start SSR response. (source: `apps/bebop/package.json` `dev:no-auth` script)

### Dev Server Port Allocation
Ports 3000 and 3001 were in use (likely from prior dev server instances), so Vite fell through to port 3002. (source: Vite startup output)

## Conventions

- **Restart dev server command**: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop" && powershell.exe -Command "yarn dev:no-auth"` (source: `apps/bebop/package.json`)
- **Reuse existing worktrees**: Before creating new worktrees for verification, check if prior verification created them — saves significant setup time (source: worktree state check)
- **E2E PRs already exist**: PR-4972662 (OfficeAgent) and PR-4972663 (office-bohemia) — don't recreate (source: `az repos pr show`)

## Gotchas

- **Dev server may stop between checks**: The Vite process can terminate if the parent shell exits; use `run_in_background` and verify with `curl` before documenting URLs
- **Windows /dev/stdin doesn't work for Node.js piping**: Use temp files (`$TEMP/file.json`) for `az` CLI JSON output → `node -e` processing (source: curl/az CLI interactions)
- **TanStack Start SSR returns `isNotFound` for unauthenticated requests**: The cowork route renders client-side; curl will show `{"isNotFound":true}` but browser will render the UI after client-side hydration
