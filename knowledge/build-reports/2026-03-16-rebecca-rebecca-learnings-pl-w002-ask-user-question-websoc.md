---
source: rebecca-PL-W002-2026-03-15.md
agent: rebecca
category: build-reports
date: 2026-03-16
---

# Rebecca Learnings — PL-W002 (Ask-User-Question WebSocket Handler)

## Task
Implement bidirectional ask-user-question WebSocket handler for OfficeAgent cowork feature.

## PR
- **PR-4970145**: feat(PL-W002): add bidirectional ask-user-question WebSocket handler
- **Branch**: `feat/PL-W002-ask-user-handler`
- **URL**: https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4970145

## Patterns Discovered

### Handler Registration Pattern
- All WebSocket handlers follow the same pattern: `registerXxxHandler()` function that calls `wsRouter.registerHandler(MessageType.Xxx, handleFunction)` (source: `modules/api/src/websocket/handlers/ping-handler.ts:14-19`)
- Handlers return `boolean` indicating if message was handled (source: `modules/core/src/websocket/router.ts:16`)
- Handler registration functions are exported from `modules/api/src/websocket/index.ts` (source: line 6-17)

### Promise-based Bidirectional Pattern
- For request-response patterns over WebSocket, use a pending Map<id, {resolve, timeout}> to bridge the async gap between sending a question and receiving the answer. This is novel in the codebase — existing handlers are either fire-and-forget (ping, query-interrupt) or use callback injection (session-init). (source: `modules/api/src/websocket/handlers/ask-user-handler.ts`)

### CoT State Machine
- The CoT manager uses a 3-state machine: `enabled: null` (undecided), `enabled: true`, `enabled: false` (source: `modules/chain-of-thought/src/manager.ts:7-21`)
- The `awaitingAnswer` state is orthogonal to the enabled/disabled/undecided axis — it pauses progression regardless of enabled state (source: `modules/chain-of-thought/src/types.ts:47-65`)
- The CoT module depends on `@officeagent/core` but NOT on `@officeagent/message-protocol`, so any shared types must be duplicated locally to avoid circular deps (source: `modules/chain-of-thought/src/cot-stream-types.ts:1-10` in feat-PL-W002 worktree)

### Build Dependencies
- **Targeted workspace builds work**: `yarn workspace @officeagent/message-protocol build` avoids Docker (source: knowledge base, confirmed in this task — 5.1s build)
- **Build order matters**: core depends on message-protocol; chain-of-thought depends on core; api depends on everything. For isolated verification, build: message-protocol → core → chain-of-thought (source: observed build failures when building out of order)
- **api module cannot build standalone**: It imports from all agent packages and grounding. Pre-existing issue, not related to changes. Use targeted workspace builds for verification. (source: api build output showing 30+ missing module errors)

### MessageType Enum Overlap
- Both PL-W002 (this PR) and PL-W015 (Dallas's PR-4970128) add `AskUserQuestion` and `UserAnswer` to the MessageType enum with identical wire values (`ask_user_question`, `user_answer`). Merge conflict will be trivial — keep either. (source: `modules/message-protocol/src/types/message-type.ts`)
- Dallas's PR also adds a `chain-of-thought-stream.ts` type file with `CoTStreamEvent` discriminated union, while this PR only adds ask-user-question types. They are complementary. (source: `feat-PL-W001` worktree)

## Gotchas

### Windows Worktree Cleanup
- `git worktree remove` can fail with "Permission denied" on Windows if the worktree directory is in use by another process or file handle (source: observed during this task when attempting to remove `work/PL-W002`)
- Workaround: Create a new worktree with different name instead of trying to remove and recreate

### ADO MCP Tools Unavailability
- `mcp__azure-ado__*` MCP tools were not available during this session. Used `az repos pr create` via Azure CLI as fallback (source: tool search returned no results)
- For PR thread comments, the Azure CLI `az repos pr comment create` command doesn't exist. Must use the REST API directly via `POST /_apis/git/repositories/{repoId}/pullRequests/{prId}/threads` (source: CLI error "comment is misspelled or not recognized")
- REST API requires `node -e` with inline token retrieval to avoid shell escaping issues with the Bearer token (source: curl gave 302 redirect due to auth issue)

## Conventions
- **Log tag IDs**: Handler uses tags `0x1e0dc100` through `0x1e0dc109` (tag_4d2e0 through tag_4d2e9). Future handlers should use non-overlapping ranges. (source: `modules/api/src/websocket/handlers/ask-user-handler.ts`)
- **No user data in logInfo/logWarn/logError**: The handler logs questionId and dismissed status at Info level, but full answer content only at Debug level (source: ask-user-handler.ts line 135-138)
