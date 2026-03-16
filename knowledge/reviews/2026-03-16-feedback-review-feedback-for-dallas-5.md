---
source: feedback-dallas-from-ripley-PR-4970128-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Dallas

**PR:** PR-4970128 — feat(PL-W015): add CoT streaming and ask-user-question protocol types
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970128 Review, 3rd pass)

## Task
Review PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Verdict
**APPROVE** (vote: 10)

## What I Learned

### Pattern: CoT streaming type design follows three-tier architecture
The OfficeAgent message-protocol now has three distinct CoT type tiers:
1. `WorkspaceChainOfThoughtPayload` — batch/final-state (string content) (source: existing in message-type.ts)
2. `PptAgentCotPayload` — typed batch with contentType/turnNumber/toolName (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:286`)
3. `ChainOfThoughtUpdatePayload` — incremental streaming with discriminated event union (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:126`)

### Pattern: Discriminated union alignment between batch and streaming CoT
`CoTStreamEventKind` extends `PptAgentCotContentType` (`'thinking' | 'text' | 'tool_use'`) with 3 additional kinds (`'step_started' | 'step_completed' | 'ask_user_question'`). This alignment is intentional and documented in JSDoc (source: `chain-of-thought-stream.ts:14-16`). A future PR could extract a shared base type.

### Pattern: Ask-user protocol uses ResponseMessage for direction modeling
- `AskUserQuestionMessage = Message<AskUserQuestionPayload>` — server→client, plain Message
- `UserAnswerMessage = ResponseMessage<UserAnswerPayload>` — client→server, with `requestId` for correlation
This correctly uses the existing `ResponseMessage` pattern from core.ts:39 (source: `ask-user-question.ts:60-62`)

### Pattern: stepId required on start, optional on completed
`CoTStepStartedEvent.stepId` is required for reliable event correlation. `CoTStepCompletedEvent.stepId` is optional for fire-and-forget scenarios. This was a deliberate design decision from review feedback. (source: `chain-of-thought-stream.ts:63,71`)

### Pattern: Compile-time shape tests for protocol types
Tests create objects with explicit type annotations — if a field is renamed/removed in the interface, the test fails to compile. Combined with runtime `expect()` assertions for full coverage. Good pattern to follow for all new protocol types. (source: `tests/message-type.test.ts:440-591`)

### Convention: ADO MCP tools still unavailable
Used REST API fallback: POST to `dev.azure.com/office/ISS/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` for comments, PUT to `.../reviewers/{vsid}?api-version=7.1` for votes. VSID retrieved via `/_apis/connectionData?api-version=6.0-preview`.

### Gotcha: ChainOfThoughtContentNotifier needs future adaptation
The existing `ChainOfThoughtContentNotifier` interface in `@officeagent/chain-of-thought` takes raw `(content: string, filePath: string, basePath: string)`. A follow-up PR must adapt it to emit structured `CoTStreamEvent` objects for the WebSocket streaming handler. (source: `modules/chain-of-thought/src/content-handler.ts`)

## Conventions to Follow
- MessageType enum: always append new values at end, use `snake_case` string values, add section comments
- Index.ts exports: use `// ====...====` section headers
- New protocol types: include compile-time shape tests alongside enum value assertions
- CoT event kinds: align with `PptAgentCotContentType` values where semantics overlap


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
