---
source: lambert-2026-03-16.md
agent: lambert
category: build-reports
date: 2026-03-16
---

# Lambert Learnings — 2026-03-16 (PR-4970841 Review)

## PR-4970841: feat(cowork): add Loop Component wrapper package for Cowork Agent

### Patterns Discovered

1. **Loop Component LoopRegistrationId naming convention**: All existing Loop Components use scoped package name format for registration IDs: `@fluidx/<name>` (e.g., `@fluidx/adaptive-card-loop`, `@fluidx/video-playback`, `@fluidx/loop-page-unfurl`) or `@ms/<name>` (e.g., `@ms/youtube`, `@ms/figma`, `@ms/google-docs`). Bare string IDs like `cowork-agent` break this convention. (source: packages/adaptive-card/src/NpmCodeLoader.ts:9, packages/youtube/src/NpmCodeLoader.ts:9, packages/video-playback/src/NpmCodeLoader.ts:9-10, packages/figma/src/NpmCodeLoader.ts:9)

2. **LoopRegistrationId export naming convention**: Every existing NpmCodeLoader.ts exports the registration ID as `LoopRegistrationId` (not custom names like `COWORK_REGISTRATION_ID`). This is the established convention that consumers rely on. (source: packages/adaptive-card/src/NpmCodeLoader.ts:9, packages/youtube/src/NpmCodeLoader.ts:9)

3. **NpmCodeLoader.test.ts is standard**: Every existing Loop Component package includes `NpmCodeLoader.test.ts` covering `canLoad` (positive and negative) and `load` (returns module with details). The adaptive-card package provides the canonical test structure. (source: packages/adaptive-card/src/NpmCodeLoader.test.ts)

4. **Loop Component package boilerplate**: The 6-file boilerplate (package.json, tsconfig.json, tsconfig.typecheck.json, just.config.cjs, jest.config.js, yarn.lock entry) in PR-4970841 correctly matches the established pattern for office-bohemia packages. (source: PR-4970841)

5. **Non-Fluid Loop Component pattern**: Non-Fluid components (adaptive-card, youtube, figma) use `SharedLoopComponentFactory<{}>` with classes implementing `ProvideHTMLViewable` + `ProvideComponentTelemetryMetadata`. The component returns a view via `getView()` which implements `ProvideHTMLView`. The CoworkComponent correctly follows this. (source: packages/adaptive-card/src/AdaptiveCardComponent.tsx)

6. **ADO REST API for PR operations (verified again)**:
   - Thread creation: `POST .../pullRequests/{prId}/threads?api-version=7.1` with `{comments:[{parentCommentId:0,content:"...",commentType:1}],status:1}` — returns thread with `id` and `status: "active"` (source: PR-4970841 review posting)
   - Reviewer vote: `PUT .../pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 5}` — returns reviewer object with vote value (source: PR-4970841 vote)
   - VSID retrieval: `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id` (source: connectionData API call)
   - Windows temp file pattern: Write JSON to `$TEMP/file.json` then read with Node.js since `/dev/stdin` doesn't work on Windows (source: all REST API calls above)

### Gotchas

- **`as const` vs literal type annotation**: CLAUDE.md bans `as` type assertions. `as const` is a grey area — it's technically a type narrowing, not a cast. Safer to use explicit literal type annotation: `const X: 'value' = 'value'` instead of `const X = 'value' as const`. (source: CLAUDE.md TypeScript guidelines)

- **`IFluidDependencySynthesizer` shape may not match custom containers**: PR-4970841's `CoworkDependencyContainer` casts the parent `IFluidDependencySynthesizer` to itself via `as unknown as CoworkDependencyContainer` to call `.resolve()` and `.has()`. The actual `IFluidDependencySynthesizer` interface may have different method signatures. This double-cast pattern is fragile and masks type mismatches at compile time. (source: packages/cowork-component/src/dependencies.ts:151,161)

- **`@fluidframework/synthesize` type-only import may resolve transitively**: PR-4970841 imports `IFluidDependencySynthesizer` from `@fluidframework/synthesize/legacy` but doesn't list it in package.json. It may resolve via `@fluidx/loop-types` or `@fluidx/loop-sdk` transitive dependencies. Watch for build failures. (source: packages/cowork-component/src/dependencies.ts:1, packages/cowork-component/package.json)

- **`az devops invoke` unavailable with Visual Studio org**: The `--area` parameter to `az devops invoke` doesn't work with `office.visualstudio.com` organizations. Must use raw `curl` with `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` instead. (source: az devops invoke error during this review)

### Conventions to Follow

- **Always use scoped LoopRegistrationId**: When creating new Loop Component packages, use `@fluidx/<component-name>` format for the registration ID, and export it as `LoopRegistrationId` (not custom names).
- **Always include NpmCodeLoader.test.ts**: New Loop Component packages must have tests for `canLoad` and `load` at minimum, following the adaptive-card test pattern.
- **Use Fluent UI tokens, not hardcoded colors**: Loop Components render in multiple hosts with different themes. Hardcoded hex colors won't adapt to dark mode or high contrast.
