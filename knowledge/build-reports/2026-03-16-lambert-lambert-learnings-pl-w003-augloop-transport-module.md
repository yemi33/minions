---
source: lambert-PL-W003-2026-03-15.md
agent: lambert
category: build-reports
date: 2026-03-16
---

# Lambert Learnings — PL-W003 (AugLoop Transport Module)

## Task
Implemented `@officeagent/augloop-transport` module — PRD item P004. Created PR-4970163.

## Patterns Discovered

1. **AugLoop runtime-client API surface**: `createRuntime()` returns `IClientRuntime` which requires `init()` then `createSession()`. Session uses `submitOperation()` / `submitSeedOperations()` for data, `activateAnnotation()` for annotation types. Annotation results arrive via `onAnnotationResult` callback in `IHostCallbacks`. (source: `node_modules/@augloop/runtime-client/dist/src/iclientruntime.d.ts`)

2. **IOperation is from types-core, not runtime-client**: The reference implementation at `.devtools/test-client/src/augloop-client.ts:3` imports `IOperation` from `@augloop/types-core`, not `@augloop/runtime-client`. The runtime-client re-imports it from types-core. Direct import from types-core is required for builds to pass. (source: `node_modules/@augloop/types-core/dist/src/operations.d.ts:126`)

3. **IHostCallbacks.requestAuthToken signature**: Takes `(tokenRequest: IAuthTokenRequest) => Promise<IAuthTokenResponse>` where `IAuthTokenResponse.Token?: string`. The test client ignores the `IAuthTokenRequest` parameter. (source: `node_modules/@augloop/schemas/dist/src/authentication-schemas.d.ts:33-49`)

4. **Module build pattern**: New modules under `modules/` are auto-detected by root `package.json` workspaces glob `"modules/*"`. After creating the module, run `yarn install` to update the lockfile before building. Build command: `yarn workspace @officeagent/<name> build`. (source: `package.json` workspaces config)

5. **Gulp build pipeline**: All modules use `gulpfile.mjs` that re-exports from `../../gulp-tasks/default-tasks.mjs`. The pipeline is: `clean → copyFiles → [compileTs → dependency-check]`. No custom gulp config needed for standard modules. (source: `gulp-tasks/default-tasks.mjs`)

6. **Dependency build order matters**: `yarn workspace @officeagent/augloop-transport build` fails if `@officeagent/message-protocol` and `@officeagent/core` haven't been built first (no `dist/` directories). Must build deps sequentially: message-protocol → core → augloop-transport. (source: build error output)

7. **API module build requires full agent pipeline**: `@officeagent/api` depends on ~15 agent packages, grounding, rai, etc. Building it standalone always fails unless all agents are built first. Use `yarn build` (lage pipeline) for full builds. For targeted validation, build just the new module. (source: modules/api/package.json dependencies list)

8. **AugLoop environments**: 9 environments defined in test-client — Dev/Local (localhost:11040), Test, Int (*.cloud.dev.microsoft), Dogfood, MSIT, Prod (*.cloud.microsoft), UsGov (*.office365.us), Gallatin (*.microsoftonline.cn). Default is Dogfood. (source: `.devtools/test-client/src/augloop-client.ts:10-19`)

9. **AugLoop session seeding**: On first connect, `onSessionConnect(isSeedingRequired)` fires. If seeding is required, must submit parent tile via `submitSeedOperations()` with a `Document({ isReadonly: false })` body at path `['session']`. (source: `.devtools/test-client/src/augloop-client.ts:147-166`)

## Gotchas

- **ADO MCP tools (`mcp__azure-ado__*`) were unavailable**: Fell back to `az repos pr create` via Azure CLI. For PR thread comments, used the REST API directly via Node.js `https.request()` because `curl` had JSON escaping issues on Windows. (source: knowledge base convention)

- **`@augloop/schemas` is a transitive dependency**: Not directly imported in transport code, but `IAuthTokenRequest`/`IAuthTokenResponse` types come from it via `@augloop/runtime-client`. No need to add to package.json unless importing directly.

- **Windows bash line endings in heredocs**: Using `$(cat <<'EOF' ... EOF)` for git commit messages works on Windows Git Bash but requires careful quoting.

## Conventions Established

- **Transport module naming**: `@officeagent/augloop-transport` follows the `@officeagent/<feature>-<component>` pattern.
- **Transport handler registration**: Added to `routes-internal.ts` alongside existing handlers, with HTTP endpoints under `/augloop/` prefix.
- **Environment config via env vars**: `OAGENT_AUGLOOP_ENV` for environment selection, `OAGENT_AUGLOOP_TOKEN` for auth token. Follows existing `OAGENT_` prefix convention.
- **Logging tag space**: Used `0x1e100001`–`0x1e100020` range for transport-related tags.

```skill
---
name: officeagent-new-module
description: Create a new @officeagent module with correct build pipeline setup
allowed-tools: Bash, Read, Edit, Write
trigger: when creating a new module under modules/ in the OfficeAgent repo
scope: project
project: OfficeAgent
---

# Create New OfficeAgent Module

## Steps
1. Create directory: `modules/<name>/src/` and `modules/<name>/tests/`
2. Create `modules/<name>/package.json`:
   - name: `@officeagent/<name>`
   - version: match other modules (currently `1.1.1130`)
   - main: `dist/src/index.js`, types: `dist/src/index.d.ts`
   - scripts: build (gulp build), clean (gulp clean), lint, test
   - Add workspace deps as `"@officeagent/<dep>": "workspace:^"`
3. Create `modules/<name>/tsconfig.json`:
   - extends: `../../tsconfig.json`
   - include: `["./src/**/*.ts", "./tests/**/*.ts"]`
   - outDir: `./dist`, rootDir: `.`
4. Create `modules/<name>/gulpfile.mjs`:
   - Single line: `export * from '../../gulp-tasks/default-tasks.mjs';`
5. Create `modules/<name>/src/index.ts` with exports
6. Run `yarn install` in PowerShell to update lockfile
7. Build deps first, then new module: `yarn workspace @officeagent/<dep> build; yarn workspace @officeagent/<name> build`
8. No root package.json changes needed — `modules/*` glob auto-detects

## Notes
- MUST use PowerShell for all yarn/build commands
- Root workspaces config `modules/*` means no explicit registration needed
- Build order: message-protocol → core → your-module (if depending on them)
- Use `yarn workspace @officeagent/<name> build` for targeted builds (avoids Docker requirement)
```
