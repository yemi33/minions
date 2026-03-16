---
source: ralph-PL-W016-2026-03-15.md
agent: ralph
category: conventions
date: 2026-03-15
---

# Ralph Learnings — PL-W016 (Cowork Feature Gate)

## Date: 2026-03-15

## Task
Implement Bebop cowork feature gate (P005) in office-bohemia repo.

## What Was Delivered
- PR-4970130 targeting `master` in office-bohemia
- `apps/bebop/src/features/cowork/featureGates.ts` — `isCoworkEnabled()` + `coworkEnabledAtom`
- `apps/bebop/src/features/cowork/coworkRouteGuard.ts` — `guardCoworkRoute()`
- `apps/bebop/src/features/cowork/featureGates.test.ts` — unit tests

## Patterns Discovered

### Bebop Feature Gate Pattern
- Bebop had NO existing feature gate infrastructure prior to this PR (source: `apps/bebop/src/features/` — no FeatureGates.ts existed)
- Loop monorepo packages use `getFluidExperiencesSetting()` from `@fluidx/utilities` extensively (source: `packages/conversa/src/featuregates/FeatureGates.ts`, `packages/loop-app/src/utilities/featureFlags.ts`)
- `getFluidExperiencesSetting` resolution order: ECS → query param → localStorage → sessionStorage → default (source: `@fluidx/utilities` documentation pattern)
- `@fluidx/utilities` is a workspace package at `packages/utilities/` within office-bohemia (source: `yarn why @fluidx/utilities`)
- `@fluidx/loop-types` provides the `SettingsProvider` type (source: `packages/conversa/src/featuregates/FeatureGates.ts:1`)

### Bebop Env Var Patterns
- Vite env vars use `VITE_` prefix and accessed via `import.meta.env.VITE_*` (source: Vite convention)
- Server-side env vars use `process.env.*` (source: `apps/bebop/src/features/conversation/serverFunctions/chat.ts`)
- `import.meta.env.DEV` for development mode detection (source: `apps/bebop/src/core/server/inlineStyles.ts`)

### Pre-existing TS Errors in office-bohemia
- `packages/utilities/src/performance/interactivityPerfMeasurements.ts` has ~28 pre-existing TS errors (TS2687, TS2717)
- `packages/utilities/src/UserActivityTracker.ts` has TS1294 errors (erasableSyntaxOnly)
- These are NOT caused by our changes — they exist on master (source: `yarn workspace @bebopjs/bebop tsc --noEmit`)

### ADO MCP Tools Availability
- `mcp__azure-ado__*` tools were NOT available during this session
- Fallback: `az repos pr create` via Azure CLI works for PR creation (source: session experience)
- PR thread comments via REST API fail with 302 redirect — token from `az account get-access-token` doesn't authenticate to office.visualstudio.com REST endpoints directly (source: session experience)

## Gotchas
- office-bohemia repo ID: `74031860-e0cd-45a1-913f-10bbf3f82555`, ADO org: office, project: OC, main branch: `master` (source: `.squad/config.json`)
- OfficeAgent repo ID: `61458d25-9f75-41c3-be29-e63727145257`, ADO org: office, project: ISS, main branch: `main` (source: `.squad/config.json`)
- Cross-repo PRs (office-bohemia PRs tracked in OfficeAgent's pull-requests.json) need `repo` and `targetBranch` fields to distinguish
- The `feat/PL-W005-cowork-feature-gate` worktree already existed with partial work — always check `git worktree list` before creating new worktrees
