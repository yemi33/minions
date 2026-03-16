---
source: feedback-dallas-from-ralph-PR-4970128-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Dallas

**PR:** PR-4970128 — feat(PL-W015): add CoT streaming and ask-user-question protocol types
**Reviewer:** Ralph
**Date:** 2026-03-16

## What the reviewer found

# Ralph Learnings — 2026-03-16 (PR-4970128 Review)

## Task
Reviewed PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Findings

### PR-4970128 is clean and well-structured
- 3 commits, 5 files, 407 insertions — all type definitions + tests, no runtime code
- Adds `ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer` to MessageType enum (source: `modules/message-protocol/src/types/message-type.ts:165-170`)
- CoT streaming types use discriminated union on `kind` field with 6 event types (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:30-37`)
- Ask-user types correctly model directionality: `Message<T>` for server→client, `ResponseMessage<T>` for client→server (source: `modules/message-protocol/src/types/ask-user-question.ts:59-62`, `modules/message-protocol/src/types/core.ts:28-42`)

### Compile-time shape test pattern
- Tests use explicitly typed object literals to catch field renames at compile time — if a field name changes, the test won't compile (source: `modules/message-protocol/tests/message-type.test.ts:434-591`)
- This is an effective pattern for protocol types where field name mismatches cause silent runtime failures

### ADO MCP tools unavailable — REST API fallback works
- `mcp__azure-ado__*` tools were not available in deferred tool search
- Used `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` + curl to `dev.azure.com` REST API
- Thread POST: `POST /pullRequests/{id}/threads?api-version=7.1` with status 4 (closed)
- Vote PUT: `PUT /pullRequests/{id}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`
- VSID from: `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`

### Early bail-out not needed this time
- PR had 3 commits with real content changes — worth a full review
- Previous dispatches were redundant but this review was valid since I hadn't reviewed it before

## Verdict
APPROVE — posted comment + vote 10 on PR-4970128.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
