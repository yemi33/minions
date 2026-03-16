---
source: ripley-2026-03-15-pr-4970130-review.md
agent: ripley
category: reviews
date: 2026-03-16
---

# Ripley Learnings — 2026-03-15 (PR-4970130 Review)

## Task
Reviewed PR-4970130: `feat(cowork): add feature gate for cowork feature (P005)` in office-bohemia repo.

## Key Findings

### PR is in office-bohemia, not OfficeAgent
- PR-4970130 targets the **office-bohemia** repo (ID `74031860-e0cd-45a1-913f-10bbf3f82555`), project **OC**, branch `feat/PL-W005-cowork-feature-gate` → `master`. (source: PR-4970130 metadata)
- The local worktree `C:/Users/yemishin/worktrees/work/PL-W005` (branch `work/PL-W005`) has **zero commits** and no changes — it's a phantom worktree. The actual PR was pushed from a different location. (source: `git log main..HEAD` in worktree)

### Feature Gate Pattern Confirmed
- `getFluidExperiencesSetting()` from `@fluidx/utilities` (at `packages/utilities/` in office-bohemia) is the correct pattern for Bebop feature gates. (source: `apps/bebop/src/features/cowork/featureGates.ts`)
- Resolution order: ECS → query param → localStorage → sessionStorage → default. (source: `@fluidx/utilities` implementation)
- Setting key convention: `<app>.<feature>.<property>` → `bebop.cowork.enabled`. (source: `featureGates.ts:10`)

### Package Dependencies Added
- `@fluidx/loop-types: "*"` — provides `SettingsProvider` type interface. (source: `apps/bebop/package.json` diff)
- `@fluidx/utilities: "*"` — provides `getFluidExperiencesSetting()`. (source: `apps/bebop/package.json` diff)
- Both are workspace packages within office-bohemia monorepo — `*` version is correct.

### Route Guard Pattern
- TanStack Router `beforeLoad` with `redirect({ to: '/' })` is the correct pattern for feature-gated routes. (source: `apps/bebop/src/features/cowork/coworkRouteGuard.ts`)
- At route level, no `SettingsProvider` is available (no React context) — so `isCoworkEnabled(undefined)` is the correct call, relying only on query param/localStorage/sessionStorage/env var overrides. (source: `coworkRouteGuard.ts:22-24`)

### Jotai Atom with Vite Dev Override
- `coworkEnabledAtom` is a read-only derived atom using `atom<boolean>(() => ...)` pattern. (source: `featureGates.ts:46-54`)
- Checks `import.meta.env.VITE_COWORK_ENABLED === 'true'` first (Vite-specific), then falls through to `isCoworkEnabled(undefined)`. (source: `featureGates.ts:48-49`)
- Three dev override paths: `VITE_COWORK_ENABLED=true` in `.env.local`, `?bebop.cowork.enabled=on` query param, `localStorage.setItem('bebop.cowork.enabled', 'true')`.

### Test Coverage Gap
- `featureGates.test.ts` covers `isCoworkEnabled()` with 4 test cases but does NOT test `guardCoworkRoute()` or `coworkEnabledAtom`. (source: `featureGates.test.ts`)

## Patterns Established
- **Cross-repo PR review via REST API**: When `mcp__azure-ado__*` tools are unavailable, use ADO REST API with `az account get-access-token` for auth. Thread comments: `POST .../pullRequests/{id}/threads?api-version=7.1`. Reviewer votes: `PUT .../pullRequests/{id}/reviewers/{reviewerId}?api-version=7.1`. (source: this review session)
- **Phantom worktree detection**: Always check `git log main..HEAD` in worktrees before assuming they contain the PR code — local worktree branch names may not match the remote PR branch.

## Verdict
APPROVE with suggestions (vote: 5). Clean implementation following established patterns. Minor gaps in test coverage for route guard and Jotai atom.
