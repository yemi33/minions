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

# Ripley Learnings — 2026-03-16 (PR-4970128 Re-review, 5th dispatch)

## Context
PR-4970128 (`feat/PL-W015-cot-askuser-types`) re-dispatched for review a 5th time with identical 3 commits and no new changes.

## Findings

### 1. Duplicate dispatch continues on PR-4970128
PR-4970128 has been dispatched to me 5+ times with the same 3 commits (b60eee4e2, ccb74bed4, 9f9c2e06b). My prior APPROVE vote (10) was already on the PR. The engine does not check existing reviewer votes or commit SHAs before re-dispatching.
(source: PR-4970128, `git log main...origin/feat/PL-W015-cot-askuser-types`)

### 2. Early bail-out pattern saves significant compute
By checking `git log --oneline main...origin/<branch>` and `git diff --stat` first, I confirmed no new commits in ~5 seconds. This avoids the full review cycle (worktree creation, file reads, lint/build verification) that would otherwise take 5-10 minutes.
(source: established pattern from prior PR-4970128 and PR-4970916 reviews)

### 3. ADO REST API fallback remains reliable
When `mcp__azure-ado__*` tools are unavailable, the curl + Node.js https module pattern works consistently:
- Thread creation: `POST dev.azure.com/office/ISS/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` — returns `{id: number}` on 200
- VSID retrieval: `GET dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`
- Vote submission: `PUT dev.azure.com/office/ISS/_apis/git/repositories/{repoId}/pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`
(source: successful API calls in this session)

### 4. PR-4970128 architecture summary (confirmed stable)
The PR adds 3 new MessageType enum values and 2 type definition files to `@officeagent/message-protocol`:
- `ChainOfThoughtUpdatePayload` with `CoTStreamEventKind` discriminated union (6 event types)
- `AskUserQuestionPayload` / `UserAnswerPayload` with typed Message aliases
- Compile-time shape tests + runtime assertion tests
All review feedback from prior passes has been addressed in commits 2 and 3.
(source: `modules/message-protocol/src/types/chain-of-thought-stream.ts`, `modules/message-protocol/src/types/ask-user-question.ts`, `modules/message-protocol/tests/message-type.test.ts`)

## Action Items for Engine
- **Check existing reviewer votes before dispatching review tasks**: If a reviewer has already voted APPROVE (10) and no new commits exist since that vote, do not re-dispatch.
- **Compare commit SHAs**: Store the last-reviewed commit SHA per PR per reviewer; only re-dispatch if HEAD has advanced.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
