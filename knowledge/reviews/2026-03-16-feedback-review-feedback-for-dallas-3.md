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

# Ripley Learnings — 2026-03-16 (PR-4970128 Review)

## Task
Reviewed PR-4970128: `feat(PL-W015): add CoT streaming and ask-user-question protocol types` on branch `feat/PL-W015-cot-askuser-types`.

## Verdict
**APPROVE** (vote: 10). Clean, well-designed types-only PR.

## Findings

### Architecture Patterns Verified

1. **Three-tier CoT type system now complete**: OfficeAgent has three levels of chain-of-thought types:
   - `WorkspaceChainOfThoughtPayload` — batch, simple content string (source: `modules/message-protocol/src/types/agents/workspace-agent/types.ts:303`)
   - `PptAgentCotPayload` — typed with `contentType`/`turnNumber`/`toolName` (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:286`)
   - `ChainOfThoughtUpdatePayload` — incremental streaming with discriminated event union + sequenceNumber (source: PR-4970128, `modules/message-protocol/src/types/chain-of-thought-stream.ts`)

2. **CoTStreamEventKind extends PptAgentCotContentType**: The existing `PptAgentCotContentType = 'thinking' | 'text' | 'tool_use'` (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`) is now complemented by `CoTStreamEventKind` which adds `'step_started'`, `'step_completed'`, `'ask_user_question'`. The three shared values maintain consistent naming.

3. **Ask-user protocol uses ResponseMessage correctly**: `UserAnswerMessage` uses `ResponseMessage<UserAnswerPayload>` (adds `requestId` field) while `AskUserQuestionMessage` uses plain `Message<AskUserQuestionPayload>`. This correctly models the direction: agent asks (Message), client answers (ResponseMessage referencing the request).

4. **ChainOfThoughtContentNotifier needs future adaptation**: The existing notifier interface (source: `modules/chain-of-thought/src/content-handler.ts:4-6`) takes raw `(content: string, filePath: string, basePath: string)`. A future PR will need to adapt it to emit structured `CoTStreamEvent` objects for the WebSocket streaming handler.

### Conventions Confirmed

- **MessageType enum**: New values append to end, use `snake_case` string values, grouped with section comments (source: `modules/message-protocol/src/types/message-type.ts:165-171`)
- **Index.ts export pattern**: Section headers with `// ============================================================================` followed by `export * from './types/<filename>'` (source: `modules/message-protocol/src/index.ts:117-127`)
- **Test pattern**: Each message type group gets its own `describe` block with `expect(MessageType.X).toBe('x')` assertions (source: `modules/message-protocol/tests/message-type.test.ts`)

### Minor Observations

- `stepId` is optional on both `CoTStepStartedEvent` and `CoTStepCompletedEvent`. If omitted on start, correlation with completed is impossible. Suggested either making required or documenting fire-and-forget convention.
- No compile-time type shape tests — only enum string value tests. Low risk for interfaces but worth adding for complex discriminated unions.

## ADO API Notes

- Review comment posted via `POST /pullRequests/4970128/threads` — thread ID 62170692
- Vote set via `PUT /pullRequests/4970128/reviewers/{vsid}` with `{"vote": 10}`
- VSID retrieved from `/_apis/connectionData?api-version=6.0-preview`


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
