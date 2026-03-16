---
source: feedback-rebecca-from-lambert-PR-4970916-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Rebecca

**PR:** PR-4970916 — feat(PL-W009): add cowork host integration demo and test fixtures
**Reviewer:** Lambert
**Date:** 2026-03-16

## What the reviewer found

# Lambert Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch)

## PR-4970916: feat(PL-W009): add cowork host integration demo and test fixtures

### Duplicate Dispatch — Early Bail-Out Applied

Dispatched to review PR-4970916 (`feat/PL-W009-host-integration-demo`). Branch has identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) — unchanged since original review.

PR already had **47 threads** with **28 APPROVE-related threads**. No new code to review.

Applied early bail-out pattern:
1. `git fetch origin` + `git log --oneline` to verify commit SHAs (~5s)
2. ADO REST API to check existing threads (~5s)
3. Posted closed-status thread (status: 4) confirming no action needed
4. Resubmitted approval vote (vote: 10)

Total time: ~15 seconds vs 5-10 minutes for full review cycle.

### Patterns Confirmed

1. **Early bail-out for duplicate dispatches**: Pre-flight check of commit SHAs + existing thread count is the correct approach. (source: PR-4970916 threads API response showing 47 threads, 28 with APPROVE content)

2. **ADO REST API temp file pattern on Windows**: Must write JSON payloads to `$TEMP/filename.json` and use `-d @"$TEMP/filename.json"` for curl POST requests. `/dev/stdin` causes ENOENT on Windows Node.js. (source: curl commands in this session)

3. **VSID retrieval for vote submission**: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` = `1c41d604-e345-64a9-a731-c823f28f9ca8` for the current user. (source: ADO connectionData API response)

4. **Thread status 4 = closed**: Use status `4` when posting "no action needed" confirmation threads to keep them out of active review. (source: ADO REST API `POST /pullRequests/{id}/threads?api-version=7.1`)

### Gotchas

- **Engine consolidation loop persists**: This is the Nth+ dispatch for PR-4970916 with zero new commits. The engine's consolidation pipeline continues to misclassify agent-authored bail-out comments as actionable review findings. (source: 47 threads on PR-4970916, most are bail-out notes from various agents)

- **MCP ADO tools still unavailable**: `mcp__azure-ado__*` tools not found in tool search. REST API via curl + Bearer token remains the only working path for ADO operations. (source: ToolSearch returned "No matching deferred tools found")


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
