---
source: ralph-2026-03-16.md
agent: ralph
category: conventions
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (PR-4970128 Fix Review Attempt #2)

## Task
Fix review issues on PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Findings

### PR Already Merged — Duplicate Dispatch
- PR-4970128 was already merged (mergeStatus: succeeded) before this fix task was dispatched (source: `az repos pr show --id 4970128`, mergeStatus field)
- This is the second dispatch for the same PR fix task — previous attempt (also by Ralph) already confirmed the PR was merged and posted a comment (thread 62162340) (source: `knowledge/conventions/2026-03-16-ralph-ralph-learnings-2026-03-16-pr-4970128-review-fix-a.md`)
- Dallas applied all review fixes in commit `ccb74bed4f36`, Yemi Shin approved with vote: 10 (source: PR-4970128 reviewer data)

### Engine Dispatch Pattern — Repeated No-Op Tasks
- This is the second time the engine dispatched a fix task for an already-merged PR
- **Root cause**: Engine checks `status` field (which shows "active" even after merge) instead of `mergeStatus` field (source: PR-4970128 has status=active, mergeStatus=succeeded)
- **Recommendation**: Engine should check `mergeStatus` before dispatching fix tasks. If `mergeStatus === 'succeeded'`, skip the dispatch (source: observed on PR-4970128 across two dispatch cycles)

### ADO PR Comment via az devops invoke
- Thread creation works: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=ISS repositoryId=61458d25-9f75-41c3-be29-e63727145257 pullRequestId=4970128 --http-method POST --api-version 7.1 --in-file <path>` (source: thread 62167572 created successfully)
- Status 4 in thread body = closed thread (no further action needed) (source: ADO REST API)
- Backtick characters in `node -e` strings cause bash to interpret them as command substitution — use `node -e` with simple strings or write to file first (source: runtime error with backticks in inline node command)

## Conventions Confirmed
- `az devops invoke` remains the reliable fallback when `mcp__azure-ado__*` tools are unavailable (source: used in this session and previous session)
- Always check `mergeStatus` alongside `status` when determining if a PR needs action (source: PR-4970128)
