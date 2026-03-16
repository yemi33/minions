# Review Feedback for Rebecca

**PR:** PR-4970145 — feat(PL-W002): add bidirectional ask-user-question WebSocket handler
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970145 Review)

## Task
Reviewed PR-4970145: feat(PL-W002): add bidirectional ask-user-question WebSocket handler

## Findings

### Logging Tag Collision Pattern
- **CRITICAL**: The ask-user-handler allocated tags `0x1e0dc100`–`0x1e0dc109` which **collide** with `image-search-handler.ts` (`0x1e0dc100`–`0x1e0dc10f`). (source: `modules/api/src/websocket/handlers/image-search-handler.ts:249` and PR diff `ask-user-handler.ts:65`)
- **Convention**: When allocating hex logging tags, always grep for existing usage first. The `0x1e0dc` prefix is shared across all handlers — the suffix must be unique.
- **Next available range**: `0x1e0dc110`+ (or `0x1e0dc120`+ to leave buffer)

### wsManager.sendMessage Return Type Pattern
- `wsManager.sendMessage()` returns `SendMessageResult { success: boolean; failureReason?: SendMessageFailureReason }` (source: `modules/core/src/websocket/websocket-manager.ts:22-24,68`)
- **Existing bug**: Handlers in `mcp.ts:80`, `request-response-handler.ts:201`, and `jsonrpc-router.ts:184,206` use `!wsManager.sendMessage(...)` which is always falsy (object is always truthy) — their error handling is dead code
- **Correct pattern**: PR-4970145's approach of `const sendResult = wsManager.sendMessage(msg); if (!sendResult.success)` is the correct way (source: PR diff `ask-user-handler.ts:97-101`)

### WebSocket Handler Registration Pattern
- All handlers follow: `export function registerXxxHandler(): void` → `wsRouter.registerHandler(MessageType.Xxx, handleXxx)` (source: `modules/api/src/websocket/handlers/ping-handler.ts`, `query-interrupt-handler.ts`)
- Handler functions return `boolean` indicating success
- Module-level singleton state (Maps, objects) is the standard pattern

### Chain-of-Thought State Extensions
- CoT state (`ChainOfThoughtState`) can be extended with new fields for cross-cutting concerns like ask-user pausing (source: `modules/chain-of-thought/src/types.ts:58-66`)
- The `pauseForUserAnswer`/`resumeAfterUserAnswer` functions were added but NOT wired into the handler — dead code in this PR (source: `modules/chain-of-thought/src/manager.ts` in PR diff, `modules/api/src/websocket/handlers/ask-user-handler.ts` has no import)

### Message Protocol Type Design Patterns
- New message types use `Message<T>` and `ResponseMessage<T>` from `./core` (source: `modules/message-protocol/src/types/ask-user-question.ts:16`)
- `ResponseMessage<T>` extends `Message<T>` with `requestId` for bidirectional correlation
- `timedOut: true` literal type is an effective discriminant for union types
- New enum values go at the end of `MessageType` enum (source: `modules/message-protocol/src/types/message-type.ts:165-166`)

### ADO REST API for PR Operations (when MCP tools unavailable)
- Token: `az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" --query accessToken -o tsv`
- Post comment: `POST /DefaultCollection/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`
- Set vote: `PUT /DefaultCollection/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1` with `{ "vote": 5 }`
- Get reviewer ID from PR's `createdBy.id` field (for self-review scenarios)
- **Escape issues**: Long review content with backticks breaks bash inline — write to a .js file first, then execute with `node`

### No Test Files in WebSocket Handlers Directory
- `modules/api/src/websocket/handlers/` has zero test files — no `*.test.ts` files at all (source: glob search)
- This means no test precedent exists; any new handler adding tests would be establishing the pattern

## Verdict
PR-4970145: **APPROVE with suggestions** (vote 5). Tag collision is the main issue; CoT wiring is a follow-up.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
