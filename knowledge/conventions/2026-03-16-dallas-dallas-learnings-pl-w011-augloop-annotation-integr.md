---
source: dallas-PL-W011-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — PL-W011 (AugLoop Annotation Integration)

## Task
Implemented AugLoop annotation integration for cowork agent operations in office-bohemia Bebop app. PR-4970697.

## What Was Built
- `augloopTransport.ts` (366 lines): `AugLoopAnnotationTransport` class with minimal `IAugLoopAnnotationProvider` interface, retry logic (configurable maxRetries/retryDelayMs), and fallback-to-direct-display path
- `progressionAtoms.ts` (263 lines): 10 Jotai atoms with dispatch/reducer pattern for annotation lifecycle (7 action types), derived atoms for UI consumption
- `annotationTypes.ts` (111 lines): String union types, `AnnotationRecord`, `AnnotationResultData`, transport config with defaults

## Patterns Discovered/Followed

### AugLoop Provider Interface Pattern
Used a minimal interface (`IAugLoopAnnotationProvider`) with just `activateAnnotations()` and `releaseAnnotation()` rather than importing concrete types from `@fluidx/augloop`. This avoids tight coupling to augloop package internals while still being compatible.
(source: apps/bebop/src/features/cowork/server/augloopTransport.ts:38-56)

### Jotai Dispatch/Reducer Pattern in Bebop
Bebop uses `atom(getFunc, setFunc)` write-atoms to implement Redux-like dispatch. The `annotationDispatchAtom` takes `ProgressionAction` discriminated union actions and runs them through `handleAction()` reducer. This matches the chatModeAtoms.ts pattern.
(source: apps/bebop/src/features/cowork/atoms/progressionAtoms.ts:154-161)

### Annotation Lifecycle State Machine
Annotations follow: `pending → active → completed/failed` with `retrying` as a transient state. The `handleActivationFailure()` method handles the retry→fallback decision tree.
(source: apps/bebop/src/features/cowork/server/augloopTransport.ts:244-293)

## Gotchas

### office-bohemia TypeScript Compilation Has Pre-existing Errors
Running `tsc --noEmit --project apps/bebop/tsconfig.json` produces hundreds of errors from `packages/1p-loop-types/` (TS1294 erasableSyntaxOnly) and `packages/bebop-i18n/` (type mismatches). These are pre-existing — filter by `cowork` to check your own files.
(source: packages/1p-loop-types/src/*, packages/bebop-i18n/src/createTranslationFunctions.ts)

### office-bohemia Worktree node_modules
The worktree at `C:/Users/yemishin/worktrees/feat-PL-W011-augloop` already had `node_modules` from a prior `yarn install`. No PnP (.pnp.cjs) — uses traditional node_modules with Yarn 4.12.
(source: C:/Users/yemishin/worktrees/feat-PL-W011-augloop/node_modules/)

### ADO MCP Tools Unavailable
`mcp__azure-ado__*` tools were not available. Used `az repos pr create` via Azure CLI as fallback. Also used direct REST API `POST .../pullRequests/{id}/threads` for PR comments.
(source: PR-4970697)

### Task Scope Mismatch
Task was filed under "Project — OfficeAgent" with OfficeAgent repo ID, but the actual code lives in office-bohemia (Bebop app). The correct repo ID for office-bohemia is `74031860-e0cd-45a1-913f-10bbf3f82555`, and PRs target `master` not `main`.
(source: PR-4970697, office-bohemia repo)

## Conventions
- String union types over enums in Bebop (Vite/esbuild tree-shaking)
- Readonly fields on all interface properties
- No barrel files (concrete import paths only)
- Feature files under `apps/bebop/src/features/cowork/` with `atoms/`, `server/`, `types/` subdirectories
