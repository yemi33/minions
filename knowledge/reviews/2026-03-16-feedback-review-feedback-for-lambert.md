---
source: feedback-lambert-from-rebecca-PR-4970163-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Lambert

**PR:** PR-4970163 — feat(PL-W003): add @officeagent/augloop-transport module
**Reviewer:** Rebecca
**Date:** 2026-03-16

## What the reviewer found

# Rebecca Learnings — 2026-03-16 (PR-4970163 Review)

## Task
Architectural review of PR-4970163: `feat(PL-W003): add @officeagent/augloop-transport module`

## Findings

### Architecture Notes

- **AugLoop transport module structure**: New `modules/augloop-transport/` package with 4 source files: `augloop-transport.ts` (508 lines, main class), `message-adapter.ts` (129 lines, bidirectional message conversion), `types.ts` (124 lines, config/state types), `index.ts` (32 lines, exports). Plus handler at `modules/api/src/websocket/handlers/augloop-transport-handler.ts` (178 lines). (source: PR-4970163, `modules/augloop-transport/src/`)

- **AugLoop connection state machine**: `Disconnected → Connecting → Connected → Reconnecting → Disposed` with exponential backoff reconnection (base 1s, max 30s, jitter, max 10 attempts). (source: `modules/augloop-transport/src/types.ts:47-57`, `modules/augloop-transport/src/augloop-transport.ts:295-330`)

- **AugLoop endpoint map**: Dev/Local → `localhost:11040`, Test/Int → `*.augloop.svc.cloud.dev.microsoft`, Dogfood/MSIT → `*.augloop.svc.cloud.microsoft`, Prod → `augloop.svc.cloud.microsoft`, UsGov → `augloop.gov.online.office365.us`, Gallatin → `augloop.microsoftonline.cn`. (source: `modules/augloop-transport/src/types.ts:20-35`)

- **AugLoop message routing pattern**: Messages converted to `AddOperation` with `parentPath: ['session', 'doc']`, correlation via operation item ID. Inbound annotations routed to pending request map by `correlationId` from `op.parentPath[2]`. (source: `modules/augloop-transport/src/message-adapter.ts:39-55`, `modules/augloop-transport/src/augloop-transport.ts:260-290`)

- **Handler uses HTTP REST not WebSocket**: AugLoop transport handler exposes `POST /augloop/connect`, `POST /augloop/disconnect`, `POST /augloop/send`, `GET /augloop/status` on the internal Express app. Registered via `routes-internal.ts`. (source: `modules/api/src/websocket/handlers/augloop-transport-handler.ts`, `modules/api/src/routes-internal.ts:63`)

- **Logging tag range for AugLoop**: `0x1e100001`–`0x1e100007` for transport, `0x1e100010` for route log, `0x1e100020` for handler. (source: `modules/augloop-transport/src/augloop-transport.ts:42-48`, `modules/api/src/routes-internal.ts:82`)

### PR Review Findings

- **SUPPORTED_MESSAGE_TYPES gap**: Set includes `SessionInit`, `SessionInitResponse`, `QueryStatus`, `LLMRequest`, `LLMResponse`, `WorkspaceChainOfThought`, `PptAgentCot`, `Error` — but missing new cowork types (`ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer` from PR-4970128). (source: `modules/augloop-transport/src/message-adapter.ts:22-30`)

- **scheduleReconnect() public API leak**: Reconnect is triggered externally by the handler's `onConnectionStateChange` listener, not internally. Creates coupling where transport won't auto-reconnect unless handler wires it up. (source: `modules/augloop-transport/src/augloop-transport.ts:295`, `modules/api/src/websocket/handlers/augloop-transport-handler.ts:103-108`)

- **Auth token provider is placeholder**: `createDefaultAuthTokenProvider()` reads static `OAGENT_AUGLOOP_TOKEN` env var. Production needs managed identity / token refresh. (source: `modules/api/src/websocket/handlers/augloop-transport-handler.ts:41-45`)

- **No unit tests for AugLoopTransport class**: Only `message-adapter.test.ts` exists (136 lines, covers adapter functions). Core transport class (508 lines) untested. (source: `modules/augloop-transport/tests/`)

### Patterns & Conventions

- **OfficeAgent module creation pattern**: New workspace packages follow: `package.json` (with `@officeagent/` scope, version `1.1.1130`), `tsconfig.json` (extends `../../tsconfig.json`), `gulpfile.mjs` (re-exports `../../gulp-tasks/default-tasks.mjs`), `src/index.ts` (explicit exports). (source: `modules/augloop-transport/package.json`, `modules/augloop-transport/tsconfig.json`, `modules/augloop-transport/gulpfile.mjs`)

- **Handler registration pattern**: Import in `routes-internal.ts`, call `register*Handler(internalApp, ...)` in the setup function, add log line with unique hex tag. Also export from `modules/api/src/websocket/index.ts` barrel (though barrel may be unused if direct import is used). (source: `modules/api/src/routes-internal.ts:20,63,82`)

### Bugs & Gotchas

- **ADO MCP tools still unavailable**: Had to fall back to Azure CLI + REST API for posting PR thread comments and reviewer votes. Pattern: `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`, then `POST .../_apis/git/repositories/{repoId}/pullRequests/{prId}/threads` and `PUT .../reviewers/{userId}`. (source: PR-4970163 review workflow)

## Verdict
**APPROVE with suggestions** (vote: 5). Well-structured module, non-blocking concerns filed.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
