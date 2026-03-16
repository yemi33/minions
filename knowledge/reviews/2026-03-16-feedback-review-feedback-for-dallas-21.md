---
source: feedback-dallas-from-lambert-PR-4970128-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Dallas

**PR:** PR-4970128 — feat(PL-W015): add CoT streaming and ask-user-question protocol types
**Reviewer:** Lambert
**Date:** 2026-03-16

## What the reviewer found

# Lambert Learnings — 2026-03-16

## PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

### Review Verdict: ✅ APPROVE (vote 10 submitted)

### Patterns Discovered

1. **CoT stream event discriminated union pattern**: `CoTStreamEvent` uses `kind` field as discriminant across 6 event types (`step_started`, `step_completed`, `tool_use`, `thinking`, `text`, `ask_user_question`). This enables exhaustive `switch` patterns without type assertions. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:109-116`)

2. **Directionality modeled via Message vs ResponseMessage**: Server→client messages use `Message<T>` (e.g., `AskUserQuestionMessage`), client→server uses `ResponseMessage<T>` (e.g., `UserAnswerMessage`). This follows the existing protocol convention established in `modules/message-protocol/src/types/core.ts`. (source: `modules/message-protocol/src/types/ask-user-question.ts:59-62`)

3. **Compile-time shape tests as drift protection**: 164 lines of tests create typed object literals with explicit type annotations — if any field is renamed in the interface, the test fails at compile time. This is the strongest defense against silent wire-format drift in cross-repo mirrored types. (source: `modules/message-protocol/tests/message-type.test.ts:428-591`)

4. **Intentional alignment with PptAgentCotContentType**: The `text` and `thinking` event kinds in `CoTStreamEventKind` intentionally mirror `PptAgentCotContentType` values from `agents/ppt-agent/messages.ts`. File header documents this explicitly as "overlap by design" for future unification. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:14-16`)

5. **Three-tier CoT type hierarchy confirmed**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming). This PR adds the third tier. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:1-10`, existing types in message-type.ts)

### Gotchas

- **stepId optionality asymmetry**: `stepId` is required on `CoTStepStartedEvent` but optional on `CoTStepCompletedEvent`. Handler implementations (PL-W001) must handle missing `stepId` on completion events. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:58,67`)

- **sequenceNumber scope**: Documented as session-scoped but the handler implementation (not in this PR) needs per-session counters. A module-level counter would interleave across concurrent sessions. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:130`)

- **This PR has been dispatched 20+ times**: Engine consolidation misclassifies agent bail-out notes as actionable review findings. Early bail-out pattern (check commits + existing votes via ADO REST API, ~15s) prevents wasted 5-10 min review cycles. (source: PR-4970128 thread history)

### ADO REST API Reference (Windows)

- Write JSON to `$TEMP/file.json`, use `curl -d @"$TEMP/file.json"` — inline JSON fails on Windows bash
- Always use `dev.azure.com` hostname, not `office.visualstudio.com`
- Thread closure: POST with `{"status": 4}`
- Vote submission: PUT `/pullRequests/{id}/reviewers/{vsid}` with `{"vote": 10}`
- VSID lookup: GET `/_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
