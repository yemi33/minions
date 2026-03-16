---
source: rebecca-PL-W008-2026-03-16.md
agent: rebecca
category: build-reports
date: 2026-03-16
---

# Rebecca Learnings — PL-W008 (Cowork Loop Component Wrapper)

## Task
Implement `@fluidx/cowork-component` package in office-bohemia as a registerable Loop Component loadable by 1JS hosts via Loop Loader SDK.

## PR
- PR-4970841: https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4970841
- Branch: `user/yemishin/cowork-loop-component`
- Target: `master` (office-bohemia)

## Patterns Discovered

### office-bohemia requires `tsconfig.typecheck.json` for every package
The lage build pipeline runs a separate `typecheck` task that expects `tsconfig.typecheck.json` in every package root. Without it, the typecheck task fails with `No tsconfig.typecheck.json found`. The file extends the package's `tsconfig.json` with `composite: false`, `emitDeclarationOnly: true`, `declaration: true`, `customConditions: null`.
(source: packages/youtube/tsconfig.typecheck.json, packages/adaptive-card/tsconfig.typecheck.json)

### `--isolatedDeclarations` requires explicit type annotations on exported constants
The root tsconfig enables `isolatedDeclarations: true` (source: tsconfig.json at repo root). Any exported `const` that references imported constants (e.g., `registrationId: COWORK_REGISTRATION_ID`) must have an explicit type annotation — TypeScript cannot infer the type across module boundaries in this mode. Solution: define an interface for the object shape and annotate the const.
(source: packages/cowork-component/src/manifest-entry.ts, root tsconfig.json `isolatedDeclarations: true`)

### Non-Fluid Loop Components use `SharedLoopComponentFactory` pattern
Packages like `youtube`, `adaptive-card`, `loop-starter-component`, `video-playback`, `wxp-embed` all follow the same pattern: `NpmCodeLoader` (implements `ILoopCodeDetailsLoader`) + `SharedLoopComponentFactory` from `@fluidx/loop-sdk` + component class implementing `ProvideHTMLViewable`.
(source: packages/youtube/src/NpmCodeLoader.ts, packages/adaptive-card/src/AdaptiveCardComponent.ts)

### Unused parameters must use underscore prefix
The root tsconfig sets `noUnusedParameters: true` and `noUnusedLocals: true`. Intentionally unused parameters (e.g., interface contract parameters not yet implemented) must be prefixed with `_` (e.g., `_options`, `_viewData`).
(source: root tsconfig.json `noUnusedParameters: true`)

### `erasableSyntaxOnly: false` override is standard for packages with enums/decorators
The root tsconfig sets `erasableSyntaxOnly: true` but Loop Component packages override it to `false` in their local tsconfig to allow TypeScript enums and other non-erasable syntax.
(source: packages/youtube/tsconfig.json, packages/cowork-component/tsconfig.json)

### office-bohemia `IFluidDependencySynthesizer` for non-Fluid components
Non-Fluid components can implement a lightweight custom container that conforms to the subset of `IFluidDependencySynthesizer` needed (resolve + has methods). The parent container delegation pattern allows inheriting host dependencies while overriding session-specific ones.
(source: packages/cowork-component/src/dependencies.ts, packages/wxp-embed/src/testUtilities/TestHelpers.ts)

## Build Results
- typecheck: PASS (6.62s)
- transpile: PASS (0.46s)
- Total: 7.37s (13 tasks, 2 executed, 11 skipped from cache)

## Gotchas

### Task scope mismatch
PL-W008 was scoped as "Project — OfficeAgent" with OfficeAgent repository ID (`61458d25-9f75-41c3-be29-e63727145257`), but the actual implementation goes to office-bohemia (repo `74031860-e0cd-45a1-913f-10bbf3f82555`, project OC, target branch `master`). The task description itself correctly states "office-bohemia" but the routing metadata was wrong.
(source: task dispatch metadata vs. task description)

### Existing worktree from prior attempt
The worktree `C:/Users/yemishin/worktrees/feat-PL-W008-loop-component/` already existed with the branch `user/yemishin/cowork-loop-component` and scaffolded files (uncommitted). Rather than starting fresh, I fixed TypeScript errors in the existing code and committed.

### `as const` objects with imported values fail `isolatedDeclarations`
Using `as const` on an object literal that contains imported constant references triggers TS9013 in `isolatedDeclarations` mode. The fix is to define an explicit interface type and annotate the variable rather than relying on `as const` inference.
(source: packages/cowork-component/src/manifest-entry.ts TS9013 error)

## Files Created
- `packages/cowork-component/package.json` — Package definition, @fluidx scope, private
- `packages/cowork-component/tsconfig.json` — Extends root, erasableSyntaxOnly: false
- `packages/cowork-component/tsconfig.typecheck.json` — Typecheck config for lage pipeline
- `packages/cowork-component/jest.config.js` — Jest config using office-bohemia-build-tools
- `packages/cowork-component/just.config.cjs` — Just preset for build/lint/test tasks
- `packages/cowork-component/src/CoworkComponent.tsx` — HTMLViewable provider (7 source files total)
- `packages/cowork-component/src/CoworkComponentFactory.ts`
- `packages/cowork-component/src/CoworkComponentView.tsx`
- `packages/cowork-component/src/CoworkAgentApp.tsx`
- `packages/cowork-component/src/dependencies.ts`
- `packages/cowork-component/src/manifest-entry.ts`
- `packages/cowork-component/src/NpmCodeLoader.ts`
