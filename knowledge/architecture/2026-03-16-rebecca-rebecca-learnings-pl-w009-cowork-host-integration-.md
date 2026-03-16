---
source: rebecca-PL-W009-2026-03-16.md
agent: rebecca
category: architecture
date: 2026-03-16
---

# Rebecca Learnings — PL-W009 (Cowork Host Integration Demo)

## Task
Implement test fixtures and demo infrastructure for validating the cowork Loop Component in multiple host scenarios.

## PR
- **PR-4970916**: feat(PL-W009): add cowork host integration demo and test fixtures
- **Branch**: `feat/PL-W009-host-integration-demo`
- **Target**: `main` (OfficeAgent)
- **Build**: PASS | **Tests**: 49/49 PASS

## Findings

### Patterns Established

1. **Mock AugLoop server pattern**: Created reusable `createMockAugLoopServer()` factory returning a handle with `{ server, wss, clients, port, close() }`. Scenario-driven: pass a scenario name and speed multiplier. Can be imported as a library for programmatic e2e testing. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts`)

2. **Fixture-driven test data**: All canned events are `readonly` typed constants with `delay_ms` hints for timing. Each fixture module exports both raw data and message builder functions (e.g., `buildCotMessage()`, `buildProgressionMessage()`). This decouples data from transport. (source: `.devtools/cowork-demo/src/fixtures/`)

3. **Host environment simulation pattern**: `createHostEnvironment(hostType, overrides?)` returns a handle with resize/lifecycle event simulation, callback registration, and cleanup. Useful for testing component behavior under different host constraints without needing real hosts. (source: `.devtools/cowork-demo/src/mock-transport/host-environment.ts`)

4. **Jest config for devtools packages**: Use inline tsconfig in `jest.config.js` transform options to include `types: ['node', 'jest']` — otherwise ts-jest uses the package's tsconfig which excludes test directories. (source: `.devtools/cowork-demo/jest.config.js`)

### Build & Test

- **Yarn workspace auto-discovery works**: `.devtools/*` glob in root `package.json` workspaces automatically picks up new packages. No manual registration needed. (source: `package.json:5-9`)

- **Must build message-protocol before building dependent devtools packages**: `@officeagent/message-protocol` resolves from `dist/src/index.js` (not source). Run `yarn workspace @officeagent/message-protocol build` first. (source: `modules/message-protocol/package.json:7`)

- **Yarn dedupe required before push**: Pre-push hook runs `yarn dedupe --check`. After adding new dependencies, run `yarn dedupe` before pushing. (source: `.husky/pre-push`)

- **Random ports for WebSocket tests**: Use `20000 + Math.floor(Math.random() * 20000)` to avoid port conflicts in parallel test runs. (source: `.devtools/cowork-demo/tests/mock-augloop-server.test.ts:17`)

### Architecture Notes

- **Existing CoT payload shapes**: `PptAgentCotPayload` (typed with `contentType`, `turnNumber`, `toolName`) and `WorkspaceChainOfThoughtPayload` (simple `content` string). Mock fixtures align with `PptAgentCotPayload` for richer testing. (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:286`, `modules/message-protocol/src/types/agents/workspace-agent/types.ts:303`)

- **QueryStatus used as envelope for progression/ask-user/artifacts**: All three event types use `MessageType.QueryStatus` with a `payload.type` discriminant field (`progression`, `ask_user_question`, `artifact_ready`). This follows the existing QueryStatus nested discriminated pattern. (source: `modules/message-protocol/src/types/core.ts`)

### Gotchas

- **`Date.now() >= issuedAt + 0` vs `>`**: When testing token expiry with `tokenLifetimeMs: 0`, `Date.now() > issuedAt + 0` can be false if both are evaluated in the same millisecond. Use `>=` for zero-lifetime edge cases.

- **WebSocket close event propagation**: When a client calls `ws.close()`, the server-side `close` handler fires asynchronously. Tests checking `server.clients.size === 0` need a small `setTimeout(resolve, 100)` to wait for the server-side cleanup.

- **Task scope mismatch**: Task description mentioned `apps/bebop/src/routes/demos/cowork-embed.tsx` (office-bohemia path) but was dispatched to OfficeAgent. Created the server-side test infrastructure in OfficeAgent's `.devtools/`. The Bebop-side demo route needs a separate task targeting office-bohemia.

- **`az repos pr comment create` doesn't exist**: Use REST API directly: `POST /_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`.
