# Review Feedback for Dallas

**PR:** PR-4970128 — feat(PL-W015): add CoT streaming and ask-user-question protocol types
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970128 Re-review)

## Task
Re-review of PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Findings

### PR-4970128 Review Feedback Was Fully Addressed
All three prior review items from earlier 2026-03-16 review were fixed across two follow-up commits:
- `stepId` made required on `CoTStepStartedEvent` (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:63`)
- `CoTTextEvent` with `kind: 'text'` added (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:95-103`)
- Compile-time shape tests added for all discriminated union members (source: `modules/message-protocol/tests/message-type.test.ts:428-591`)

### PR Already Merged (mergeStatus: succeeded)
PR-4970128 has `mergeStatus: succeeded` but `status: active`. This confirms the engine dispatch bug where `status` field doesn't reflect merge state — must check `mergeStatus` field. (source: PR-4970128 via `az repos pr show`)

### CoTStreamEventKind Alignment with PptAgentCotContentType Verified
The three shared values (`'thinking'`, `'text'`, `'tool_use'`) between `CoTStreamEventKind` and `PptAgentCotContentType` are intentional and documented in JSDoc. `CoTStreamEventKind` extends with `'step_started'`, `'step_completed'`, `'ask_user_question'`. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:30-35` vs `modules/message-protocol/src/types/agents/ppt-agent/messages.ts` PptAgentCotContentType)

### Ask-User Protocol Uses ResponseMessage Correctly
`AskUserQuestionMessage` = `Message<AskUserQuestionPayload>` (server→client), `UserAnswerMessage` = `ResponseMessage<UserAnswerPayload>` (client→server with requestId). This correctly models the bidirectional flow using the existing `ResponseMessage` pattern from `core.ts:39`. (source: `modules/message-protocol/src/types/ask-user-question.ts:59-62`)

### ADO REST API Fallback Pattern Confirmed Working
When `mcp__azure-ado__*` tools are unavailable:
- Thread creation: POST to `{org}/DefaultCollection/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`
- Reviewer vote: PUT to `.../pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`
- VSID retrieval: GET `/_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`
- Token: `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
(source: verified working on PR-4970128, Thread ID 62173423)

## Conventions
- **MessageType enum extension**: Always append at end, use `snake_case` string values, group with `//` section comments (source: `modules/message-protocol/src/types/message-type.ts:165-170`)
- **New type file exports**: Use section headers with `// ====...====` in `index.ts` (source: `modules/message-protocol/src/index.ts:118-127`)
- **Test pattern for protocol types**: Enum value assertions + compile-time shape verification for discriminated unions (source: `modules/message-protocol/tests/message-type.test.ts:292-591`)


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
