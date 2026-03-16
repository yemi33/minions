---
source: dallas-PL-W001-2026-03-15.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — PL-W001 (CoT WebSocket Streaming Handler)

## What Was Built
PR-4970168: CoT WebSocket streaming handler that wires `ChainOfThoughtContentNotifier` to push real-time CoT events over WebSocket using `chain_of_thought_update` message type.

## Patterns Discovered

### Dual-write pattern for file-handler.ts
- **Before**: `FileHandler.write()` was either/or — file-based OR content handler based on `useContentHandler` flight (source: `modules/chain-of-thought/src/file-handler.ts:30-44`)
- **After**: Always writes to file first, then additionally sends via content handler if flight enabled
- **Why**: Ensures file-based CoT never breaks regardless of WebSocket state

### Simple vs Class-based handler patterns
- **Simple** (function-based): `ping-handler.ts`, `rai-handler.ts` — export `registerXxxHandler()` function, standalone handler functions (source: `modules/api/src/websocket/handlers/ping-handler.ts`)
- **Class-based**: `session-init-handler.ts` — class with constructor injection, `register()` method, singleton pattern (source: `modules/api/src/websocket/handlers/session-init-handler.ts`)
- **Use simple** for primarily outgoing (server→client) handlers; **use class-based** for handlers with state or complex initialization

### Handler registration chain
1. Handler defined in `modules/api/src/websocket/handlers/<name>.ts`
2. Export function from `modules/api/src/websocket/index.ts`
3. Import and call in `modules/api/src/routes-internal.ts`
4. Handler calls `wsRouter.registerHandler(MessageType.X, handler)` to bind to the router (source: `modules/core/src/websocket/router.ts:34`)

### ChainOfThoughtContentNotifier was internal-only
- Before this PR, the interface was defined in `modules/chain-of-thought/src/content-handler.ts` but NOT exported from the package index
- Required adding `export type { ChainOfThoughtContentNotifier } from './content-handler'` to `modules/chain-of-thought/src/index.ts`
- Must use `export type` (not `export`) due to `isolatedModules` tsconfig setting

### Adding cross-module dependencies
- Adding `@officeagent/chain-of-thought` as dep of `@officeagent/api` required updating `modules/api/package.json` with `"@officeagent/chain-of-thought": "workspace:^"`
- Also required `yarn install` in worktree to update yarn.lock

## Build & Test Notes

### Targeted builds require Docker for full pipeline
- `yarn build --to @officeagent/api` builds all 34 transitive deps but also triggers Docker image build at the end (source: `gulp-tasks/docker.mjs`)
- Docker image build fails if Docker Desktop not running — but all TypeScript packages still compile successfully
- For CI-like validation without Docker: individual `yarn workspace @officeagent/<pkg> build` calls work but don't build transitive deps

### Test mock patterns
- When using `jest.clearAllMocks()` in `beforeEach`, mock return values set via `mockReturnValue()` are preserved BUT `jest.fn().mockReturnValue(x)` in factory function ARE cleared
- Must re-establish return values after `clearAllMocks`: `(mockFn as jest.Mock).mockReturnValue(value)`
- When mocking `@officeagent/core`, provide all used exports: `wsManager`, `wsRouter`, `logInfo`, `logDebug`, `logError`
- When handler imports from another package used only as type, add empty mock: `jest.mock('@officeagent/chain-of-thought', () => ({}))`

### routes-internal.test.ts mock maintenance
- Adding new handlers to `routes-internal.ts` requires updating the mock in `tests/routes-internal.test.ts` line ~23-34 (source: `modules/api/tests/routes-internal.test.ts:23`)
- Missing mock entries cause `TypeError: (0, websocket_1.registerXxx) is not a function`

## Gotchas

- **Worktree yarn.lock**: New worktrees need `yarn install` before any `yarn workspace` build commands work
- **logInfo tag values**: Each `logInfo` call needs a unique hex tag (e.g., `0x1e0dc030 /* tag_4d2bq */`). Used `0x1e0dc030` and `0x1e0dc031` for the new handler — check for collisions before merge
- **PR-4970128 overlap**: Dallas's earlier PR-4970128 (PL-W015) added the same MessageType enum values. This PR (PL-W001) includes them independently. One of these PRs should be merged first; the second will need a merge conflict resolution.
