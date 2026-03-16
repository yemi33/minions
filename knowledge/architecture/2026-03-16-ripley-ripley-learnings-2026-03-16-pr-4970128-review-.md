---
source: ripley-2026-03-16.md
agent: ripley
category: architecture
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970128 Review)

## Task
Reviewed PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Verdict: APPROVE

## Findings

### Pattern Compliance
- New protocol types follow established patterns exactly: import from `./core`, use `Message<T>` / `ResponseMessage<T>`, type aliases at bottom of file (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:14,298`)
- `index.ts` barrel exports with section headers match existing structure (source: `modules/message-protocol/src/index.ts:115-127`)
- MessageType enum additions at end of enum block, no reordering (source: `modules/message-protocol/src/types/message-type.ts:166-172`)

### Architecture Observations
- **CoTStreamEventKind aligns with PptAgentCotContentType**: The 3 shared kinds (`thinking`, `text`, `tool_use`) match the existing `PptAgentCotContentType` union at `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`. New kinds (`step_started`, `step_completed`, `ask_user_question`) extend the model for richer progression tracking.
- **Discriminated union with `kind` field**: `CoTStreamEvent` uses `kind` as discriminant — this is the same pattern recommended for Bebop mirrored types (string union over enum, exhaustive switch). (source: `chain-of-thought-stream.ts:108-114`)
- **Bridge pattern between CoT and Ask-User**: `CoTAskUserQuestionEvent.questionId` references the full `AskUserQuestionMessage`, allowing the CoT stream to show "waiting for user" while the UI is driven by the dedicated message type. Clean separation. (source: `chain-of-thought-stream.ts:99-106`)
- **`sequenceNumber` for ordering**: `ChainOfThoughtUpdatePayload` includes a monotonically increasing `sequenceNumber` for WebSocket out-of-order protection. Good design. (source: `chain-of-thought-stream.ts:123`)
- **`UserAnswerMessage` extends `ResponseMessage<T>`**: Correctly uses response pattern (includes `requestId`) since it's a reply to a question. `AskUserQuestionMessage` extends `Message<T>` since it's agent-initiated. (source: `ask-user-question.ts:59-62`)

### Gotchas
- **`stepId` optionality**: Both `CoTStepStartedEvent.stepId` and `CoTStepCompletedEvent.stepId` are optional. This means start/complete correlation is best-effort, not guaranteed. Downstream consumers must handle uncorrelated events. (source: `chain-of-thought-stream.ts:55,67`)
- **`ChainOfThoughtContentNotifier` gap**: The existing notifier in `modules/chain-of-thought/src/content-handler.ts:4-5` has a simple `(content, filePath, basePath)` signature that doesn't match the new structured `ChainOfThoughtUpdatePayload`. PL-W001 (WebSocket handler) will need to either extend this interface or create a new one. (source: `modules/chain-of-thought/src/content-handler.ts:4-5`)
- **No runtime type guards**: Pure type definitions with no runtime guards. Downstream WebSocket handlers will need to build their own `isCoTStreamEvent()`, `isAskUserQuestionMessage()` etc. for message routing.

### Conventions Confirmed
- OfficeAgent message-protocol test pattern: tests verify enum string values only, not type structures (compile-time verification is sufficient). (source: `modules/message-protocol/tests/message-type.test.ts`)
- New MessageType values use snake_case string values matching existing convention: `chain_of_thought_update`, `ask_user_question`, `user_answer`. (source: `modules/message-protocol/src/types/message-type.ts:167-172`)

### ADO API Pattern Used
- Posted review via ADO REST API: `POST /pullRequests/{id}/threads?api-version=7.1` with `status: 4` (closed/resolved)
- Set reviewer vote via: `PUT /pullRequests/{id}/reviewers/{reviewerId}?api-version=7.1` with `{ vote: 10 }`
- Token obtained via `git credential fill` for `office.visualstudio.com`
