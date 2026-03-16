---
source: ripley-2026-03-16.md
agent: ripley
category: conventions
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970128 Review)

## PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

### Review Outcome
- **Verdict**: APPROVE (with minor suggestions)
- **Vote**: 5 (approved with suggestions)
- **Branch**: `feat/PL-W015-cot-askuser-types`
- **Files**: 5 changed, +227 lines, 2 commits

### Pattern Compliance Verified

1. **Message type hierarchy correct**: `AskUserQuestionMessage` extends `Message<T>` (agent-initiated), `UserAnswerMessage` extends `ResponseMessage<T>` (client response with `requestId`), `ChainOfThoughtUpdateMessage` extends `Message<T>` (agent-initiated). (source: `modules/message-protocol/src/types/ask-user-question.ts:59-62`, `modules/message-protocol/src/types/chain-of-thought-stream.ts:131`)

2. **Enum additions at end**: Three new `MessageType` values (`ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer`) appended after `PptAgentCot` without reordering existing values. (source: `modules/message-protocol/src/types/message-type.ts:164-170`)

3. **Discriminated union with `kind` field**: `CoTStreamEvent` union of 6 event types discriminated on `kind`. All events extend `CoTStreamEventBase`. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:108-114`)

4. **CoTStreamEventKind has 6 values**: `step_started`, `step_completed`, `tool_use`, `thinking`, `text`, `ask_user_question`. The `text` kind was added in review-feedback commit to align with `PptAgentCotContentType`. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:25-31`)

5. **Bridge pattern**: `CoTAskUserQuestionEvent.questionId` references `AskUserQuestionMessage` to link CoT stream and ask-user subsystems. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:101`)

6. **Barrel exports follow section-header pattern**: New `export *` entries in `index.ts` use the same `// ============================================================================` comment blocks as all existing sections. (source: `modules/message-protocol/src/index.ts:118-127`)

### Gotchas for Future Agents

- **`stepId` is optional on both start and complete events**: Correlation between `step_started` and `step_completed` is best-effort. Downstream handlers must not assume paired events. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:54,65`)

- **No runtime type guards in this PR**: Pure TypeScript types only. The WebSocket handler (PL-W001) will need to build runtime validation. (source: all new type files)

- **`ChainOfThoughtContentNotifier` signature mismatch**: The existing notifier in `@officeagent/chain-of-thought` has simple `(content, filePath, basePath)` signature — incompatible with the new structured `ChainOfThoughtUpdatePayload`. An adapter will be needed when the streaming handler is implemented. (source: `modules/chain-of-thought/src/content-handler.ts`)

- **ADO MCP tools unavailable**: `mcp__azure-ado__*` tools were not available during this session. Used Azure CLI REST API fallback: `POST .../_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` for comments, `PUT .../reviewers/{reviewerId}?api-version=7.1` for votes. Token obtained via `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`.

### Conventions Confirmed

- **"No barrel files" rule applies to Bebop only**: `@officeagent/message-protocol`'s `index.ts` uses `export *` throughout — this is the correct pattern for shared library packages.
- **Test pattern**: `describe` block per feature group, `expect(MessageType.X).toBe('x')` assertions. (source: `modules/message-protocol/tests/message-type.test.ts:280-298`)
