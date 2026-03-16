---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (Plan Verification Re-run)

## Task
Re-verification of Claude Cowork UX plan (officeagent-2026-03-15.json) — 17 completed items across 14 PRs in 2 repos.

## Findings

### Worktree Reuse Saves Significant Time
- Prior verification already created worktrees and E2E PRs — checking for them first avoided 10+ minutes of fetch+merge+conflict-resolution
- OfficeAgent worktree: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` on branch `e2e/cowork-w025` (source: git worktree list)
- office-bohemia worktree: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob` on branch `e2e/cowork-w025-demo-fixes` (source: git worktree list)

### Build Results Stable
- **message-protocol**: 113 tests PASS, 3.71s build (source: `modules/message-protocol/`)
- **augloop-transport**: 11 tests PASS, 3.41s build; 1 source test suite fails on babel `import type` — pre-existing (source: `modules/augloop-transport/`)
- **cowork-demo**: 49 tests PASS across 4 suites (source: `.devtools/cowork-demo/`)
- **office-bohemia Bebop typecheck**: 17 TS errors in 5 files — cross-PR integration boundaries (source: `apps/bebop/src/features/cowork/`)

### TS Error Breakdown (17 errors in 5 files)
1. `pas.config.ts:1` — 1 error (source: typecheck output)
2. `CoworkErrorBoundary.tsx:32` — 2 errors (source: typecheck output)
3. `useCoworkStream.ts:15` — 8 errors (source: typecheck output)
4. `streamingBridge.ts:22` — 5 errors: imports `TransportConfig`, `TransportState`, `AugloopTransport` from `./augloopTransport` but file exports different names (source: typecheck output)
5. `transportRegistry.ts:9` — 1 error: imports `AugloopTransport` which doesn't exist (source: typecheck output)

### Dev Server Behavior
- Vite dev server on port 3000 via `yarn dev:no-auth` — port 3002 if 3000 occupied (source: curl check)
- Mock AugLoop server on ws://localhost:11040/ws — returns 404 on HTTP (expected, WebSocket-only) (source: curl check)
- `yarn dev:no-auth` works for local testing without MSAL auth proxy (source: `apps/bebop/package.json`)

### E2E PRs Already Exist
- PR-4972662 (OfficeAgent): active (source: `az repos pr show --id 4972662`)
- PR-4972663 (office-bohemia): active (source: `az repos pr show --id 4972663`)

## Patterns

- **Always check worktree list before creating**: `git worktree list` from main repo, not from within a worktree
- **PowerShell required for yarn commands**: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"` pattern
- **Use `@officeagent-tools/` scope for devtools**: Not `@officeagent/` — e.g., `@officeagent-tools/cowork-demo`
- **Vite dev mode works despite TS errors**: esbuild skips type-checking, so dev server runs even with 17 TS errors

## Gotchas

- `yarn workspace` with just package name (no scope) fails silently — must use full scoped name
- office-bohemia `yarn lage` must run from monorepo root, not from `apps/bebop/`
- Mock server is one-shot per scenario — restart between test runs
- Demo WebSocket hook (`useDemoCoworkSession`) is NOT production code — hardcoded `ws://localhost:11040`
