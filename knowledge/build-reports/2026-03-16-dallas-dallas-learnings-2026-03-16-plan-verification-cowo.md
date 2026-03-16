---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (Plan Verification: Cowork UX)

## Task
Verification of completed plan `officeagent-2026-03-15.json` — Claude Cowork UX in Bebop with OfficeAgent capabilities, AugLoop integration.

## Findings

### Cross-PR Merge Integration Failures
When merging 8 independent office-bohemia PRs into a single worktree, 19 TypeScript errors emerged in 6 cowork files. These are interface mismatches caused by PRs developed in isolation against different versions of shared files.
(source: `apps/bebop/src/features/cowork/hooks/useCoworkStream.ts`, `apps/bebop/src/features/cowork/server/streamingBridge.ts`, `apps/bebop/src/features/cowork/server/transportRegistry.ts`)

Key conflicts:
- `streamingBridge.ts` imports `TransportConfig`, `TransportState`, `AugloopTransport` from `augloopTransport.ts` — these were renamed/restructured by the augloop-annotations PR (source: PR-4970697)
- `useCoworkStream.ts` references `upsertProgressionStepAtom`, `activeQuestionAtom`, `coworkErrorAtom`, `appendArtifactAtom`, `resetCoworkStateAtom` — these were renamed in the scaffold PR to `progressionStepsAtom`, `artifactsAtom`, `resetCoworkSessionAtom` (source: PR-4970170 vs PR-4970552)
- `CoworkErrorBoundary.tsx` needs `override` modifier on class methods — TS 5.9 strictness in office-bohemia's tsconfig (source: `apps/bebop/src/features/cowork/components/CoworkErrorBoundary/CoworkErrorBoundary.tsx:32`)

### OfficeAgent Packages Build Independently
- `@officeagent/message-protocol`: Clean build (4.19s), 113 tests pass, lint clean (source: `modules/message-protocol/`)
- `@officeagent/augloop-transport`: Clean build (6s), 11 tests pass from dist, 2 lint errors (unused vars) (source: `modules/augloop-transport/`)
- `@officeagent-tools/cowork-demo`: 49 tests pass across 4 suites (source: `.devtools/cowork-demo/`)

### Pre-existing Build Breaks on OfficeAgent Main
- `@officeagent/core` fails to build: 4 TS errors in `tests/websocket/websocket-manager.test.ts` where `readyState` is assigned to a read-only property. Fix exists on `user/jakubk/excel-agent-cli` branch (commit `dbb84d949`) but hasn't merged to main. (source: `modules/core/tests/websocket/websocket-manager.test.ts:137,342,837,886`)
- `@officeagent/api` fails due to cascading dependency on core + missing agent module builds + @types/ws version conflict between root and api node_modules (source: `modules/api/src/app.ts:155`)

### office-bohemia Lage Pipeline
- Lage tasks use `transpile`/`typecheck`, NOT `build` — `yarn lage build --to @bebopjs/bebop` returns "no targets found" (source: `lage.config.js` — pipeline has no `build` key)
- Correct command: `yarn lage transpile typecheck --to @bebopjs/bebop` (took 3m 24s for full dep chain)
- The `just-scripts global:build` wrapper in Bebop's `package.json` runs `svgr preTranspile transpile postTranspile typecheck` via lage with `--only` flag (source: `apps/bebop/package.json:6`)

### Vite Dev Server Works Despite Type Errors
- Vite 7 with esbuild handles TypeScript on-the-fly without type-checking, so the dev server starts even with 19 TS errors
- Dev server fell through to port 3002 (3000/3001 in use)
- `yarn dev:no-auth` starts Vite without the auth-proxy; `yarn dev` requires auth-proxy for authenticated requests (source: `apps/bebop/package.json:9-10`)

### Jest + import.meta Incompatibility in office-bohemia
- `featureGates.test.ts` uses `import.meta.env` which fails in Jest CJS environment. office-bohemia's Jest runs in CommonJS mode. Tests using Vite-specific APIs need Vitest or a transform that handles `import.meta`. (source: `apps/bebop/src/features/cowork/featureGates.test.ts:34`)

### augloop-transport Babel Config Gap
- Source `.ts` tests fail with babel SyntaxError on `import type { ... }` syntax (line 6). The compiled `dist/tests/*.test.js` files run fine (11 tests pass). The babel config lacks `@babel/plugin-syntax-import-assertions` or needs `@babel/preset-typescript` with `onlyRemoveTypeImports: true`. (source: `modules/augloop-transport/tests/message-adapter.test.ts:6`)

### Worktree Setup Patterns
- OfficeAgent branches `work/PL-W017` and `user/yemishin/cowork-shared-tree` are local-only stale branches pointing to old main commits — no actual cowork changes. They were never pushed to remote. (source: `git log --oneline work/PL-W017 -5` shows v1.1.1130 as HEAD)
- office-bohemia worktree needed 4 merge conflict resolutions across `coworkAtoms.ts`, `coworkSession.ts`, `CoworkLayout.tsx`, `augloopTransport.ts`, `types.ts`, `just.config.cjs`, `package.json`, `tsconfig.json`, and `yarn.lock`

## Conventions

- **office-bohemia main branch is `master`** not `main` (source: `git branch -a | grep master` in office-bohemia repo)
- **Use `yarn lage transpile typecheck --to <package>`** for targeted builds in office-bohemia, NOT `yarn build` (source: `lage.config.js`)
- **Use `yarn workspace @officeagent/<pkg> build`** for individual OfficeAgent packages to avoid Docker requirement (source: project CLAUDE.md)
- **Vite dev mode at `yarn dev:no-auth`** for local testing without auth-proxy (source: `apps/bebop/package.json`)

## Gotchas

- Merging 8+ independent PRs will produce type errors at integration boundaries — plan for an integration fix PR
- `@types/ws` version conflicts between root and package `node_modules` cause cascading build failures in `@officeagent/api`
- `import.meta` usage in tests requires Vitest or ESM-compatible Jest transform
- OfficeAgent `work/PL-W017` branch in task setup commands doesn't exist on remote — phantom branch reference

```skill
---
name: officeagent-verify-plan-worktree
description: Set up multi-PR verification worktrees for OfficeAgent + office-bohemia cross-repo plans
allowed-tools: Bash, Read
trigger: when verifying a plan with multiple PRs across OfficeAgent and office-bohemia repos
scope: squad
project: any
---

# Multi-PR Plan Verification Worktree Setup

## Steps

### 1. Create OfficeAgent Worktree
```bash
cd "C:/Users/yemishin/OfficeAgent"
git fetch origin <branch1> <branch2> ... main
git worktree add "C:/Users/yemishin/worktrees/verify-<plan-name>" --detach origin/main
cd "C:/Users/yemishin/worktrees/verify-<plan-name>"
# Merge each PR branch; resolve conflicts with --theirs
git merge origin/<branch> --no-edit
```

### 2. Create office-bohemia Worktree
```bash
cd "C:/Users/yemishin/office-bohemia"
git fetch origin <branch1> <branch2> ... master
git worktree add "C:/Users/yemishin/worktrees/verify-<plan-name>-ob" --detach origin/master
cd "C:/Users/yemishin/worktrees/verify-<plan-name>-ob"
# Merge each PR branch; resolve conflicts with --theirs
git merge origin/<branch> --no-edit
```

### 3. Resolve Merge Conflicts
For each conflict: `git checkout --theirs <file> && git add <file>`
Then commit: `git commit -m "Resolve merge: prefer <PR> changes"`

### 4. Build OfficeAgent (individual packages)
```powershell
yarn install --immutable
yarn workspace @officeagent/message-protocol build
yarn workspace @officeagent/augloop-transport build
# Note: full `yarn build` requires Docker Desktop
```

### 5. Build office-bohemia (Bebop)
```powershell
yarn install
yarn lage transpile typecheck --to @bebopjs/bebop --concurrency 8
# Note: use lage tasks (transpile/typecheck), NOT `build`
```

### 6. Start Dev Server
```powershell
cd apps/bebop
npx vite dev  # or: yarn dev:no-auth
```

## Notes
- Expect cross-PR type errors when merging 5+ independent branches
- Vite dev mode works despite type errors (esbuild skips type-checking)
- Some local-only branches may not exist on remote — skip them
- office-bohemia uses `master` branch, OfficeAgent uses `main`
```
