---
source: rebecca-2026-03-16.md
agent: rebecca
category: build-reports
date: 2026-03-16
---

# Rebecca Learnings — 2026-03-16

## PL-W008: Loop Component Wrapper Package

See detailed findings in `rebecca-PL-W008-2026-03-16.md`.

### Key Findings

1. **office-bohemia requires `tsconfig.typecheck.json`** for every package — lage pipeline runs separate typecheck task expecting this file (source: packages/youtube/tsconfig.typecheck.json pattern)

2. **`isolatedDeclarations: true` in root tsconfig** requires explicit type annotations on all exported constants that reference imported values — cannot rely on `as const` inference (source: root tsconfig.json)

3. **Non-Fluid Loop Component pattern is well-established**: `NpmCodeLoader` + `SharedLoopComponentFactory` + `ProvideHTMLViewable` — at least 5 packages follow this exact pattern (source: packages/youtube/, packages/adaptive-card/, packages/loop-starter-component/, packages/video-playback/, packages/wxp-embed/)

4. **Task scope metadata was incorrect**: PL-W008 routed to OfficeAgent repo but the actual work belongs in office-bohemia — always verify target repo from task description, not just metadata

```skill
---
name: office-bohemia-new-package
description: Create a new package in the office-bohemia monorepo with correct build configuration
allowed-tools: Bash, Read, Edit, Write
trigger: when creating a new package in office-bohemia or Loop monorepo
scope: squad
project: any
---

# Create New Package in office-bohemia

## Prerequisites
- office-bohemia worktree exists
- Package name follows `@fluidx/<name>` scope convention

## Steps

1. Create package directory under `packages/<name>/`

2. Create `package.json` with:
   - `"name": "@fluidx/<name>"`
   - `"private": true` (for internal packages)
   - `"sideEffects": false`
   - Granular `"exports"` with `types`, `source`, `default` for each entry point
   - Dependencies on `@fluidx/loop-sdk`, `@fluidx/loop-types` as needed
   - devDependencies on `@fluidx/eslint-plugin-ffx-rules`, `@fluidx/office-bohemia-build-tools`
   - Scripts: clean, build, bundle, start, lint, test (all using `just-scripts`)

3. Create `tsconfig.json`:
   ```json
   {
     "extends": "../../tsconfig.json",
     "compilerOptions": {
       "outDir": "lib/",
       "composite": true,
       "rootDir": "src",
       "erasableSyntaxOnly": false
     },
     "include": ["src"]
   }
   ```

4. **CRITICAL**: Create `tsconfig.typecheck.json` (build FAILS without this):
   ```json
   {
     "extends": "./tsconfig.json",
     "compilerOptions": {
       "composite": false,
       "emitDeclarationOnly": true,
       "declaration": true,
       "customConditions": null
     }
   }
   ```

5. Create `just.config.cjs`:
   ```js
   const { preset, just } = require('@fluidx/office-bohemia-build-tools/just-preset');
   const { task, series } = just;
   preset();
   task('test', series('jest'));
   task('lint', 'linter');
   ```

6. Create `jest.config.js`:
   ```js
   let { createConfig } = require('@fluidx/office-bohemia-build-tools/lib/jest/jest-config');
   module.exports = createConfig('test');
   ```

7. Run `yarn` to update lockfile, then `yarn build --to <name>` to verify

## Notes
- Root tsconfig has `isolatedDeclarations: true` — all exported consts with imported values need explicit type annotations
- Root tsconfig has `noUnusedParameters: true` — prefix unused params with `_`
- No barrel files (`index.ts` re-exports) in Bebop packages
- Root workspace config `packages/*` auto-discovers new packages
```
