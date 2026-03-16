# Review Feedback for Dallas

**PR:** PR-4972662 — [E2E] Claude Cowork UX — OfficeAgent (7 PRs merged)
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4972662 Review)

## Task
Reviewed PR-4972662: [E2E] Claude Cowork UX — OfficeAgent (7 PRs merged), branch `e2e/cowork-w025`.

## Findings

### PR Scope
- 552 files changed, 74K+ insertions — but ~400 files are from main branch merges (version bumps, font removals, eval datasets, prompt updates)
- Actual cowork content spans ~40 new/modified files across 5 areas:
  1. `modules/message-protocol/src/types/` — new `ask-user-question.ts`, `chain-of-thought-stream.ts`, 3 MessageType enum values (source: PR-4972662, branch e2e/cowork-w025)
  2. `modules/api/src/websocket/handlers/` — new `ask-user-handler.ts`, `cot-stream-handler.ts`, `augloop-transport-handler.ts`
  3. `modules/augloop-transport/` — entire new module (transport, message-adapter, types)
  4. `.devtools/cowork-demo/` — mock server, fixtures, host-environment, token-provider
  5. `modules/chain-of-thought/src/` — ask-user pause/resume lifecycle extensions

### Architecture Observations
- **CoTStreamEvent discriminated union uses `kind` field**: step_started, step_completed, tool_use, thinking — matches Bebop mirror pattern (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts`)
- **Ask-user handler uses module-level `pendingQuestions` Map**: Per-process state, won't survive container restarts, but appropriate for timeout-based design (source: `modules/api/src/websocket/handlers/ask-user-handler.ts`)
- **AugLoop transport has exponential backoff with jitter**: Clean reconnection strategy in `connect()` method (source: `modules/augloop-transport/src/augloop-transport.ts`)
- **Message adapter double-casts through `unknown`**: `message as unknown as ISchemaObject` bypasses type checking between OfficeAgent `Message` and AugLoop `ISchemaObject` (source: `modules/augloop-transport/src/message-adapter.ts`)

### Gotchas
- **PR is in DRAFT state**: Cannot submit reviewer votes on draft PRs via ADO REST API — returns `GitPullRequestDraftCannotVoteException`. Must wait for PR to be published. (source: ADO REST API `PUT /pullRequests/{id}/reviewers/{vsid}`)
- **`/dev/stdin` doesn't work on Windows Node.js**: Use `process.stdin.resume()` with event listeners instead of `readFileSync('/dev/stdin')` (source: Node.js v24.11.0 on Windows)
- **Module-level `sequenceNumber` in cot-stream-handler**: Shared across all sessions, will interleave if two cowork sessions are active simultaneously (source: `modules/api/src/websocket/handlers/cot-stream-handler.ts`)

### Test Coverage Gaps
- **No unit tests for `ask-user-handler.ts`**: Timeout behavior, session cancellation, cross-session rejection untested (source: `modules/api/tests/websocket/handlers/` — file missing)
- **No unit tests for `augloop-transport-handler.ts`**: HTTP endpoint validation untested (source: `modules/api/tests/` — file missing)
- **No unit tests for `AugLoopTransport` class**: Only message-adapter has tests (source: `modules/augloop-transport/tests/`)

### Conventions Confirmed
- Logging rules followed: no user data in logInfo/logWarn/logError, user content only in logDebug ✅
- No console.* in production code ✅
- WebSocket handlers follow established 14-handler pattern in modules/api ✅
- Types use JSDoc documentation ✅


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
