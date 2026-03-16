---
source: feedback-rebecca-from-ripley-PR-4970916-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Rebecca

**PR:** PR-4970916 — feat(PL-W009): add cowork host integration demo and test fixtures
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970916 Review, Duplicate Dispatch #4)

## Task
Review PR-4970916: feat(PL-W009): add cowork host integration demo and test fixtures

## Findings

### Duplicate Dispatch Confirmed (8th+ review cycle)
PR-4970916 has been reviewed and approved 7+ times with no new commits. The same 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) have been present since the first review. (source: `git log main...origin/feat/PL-W009-host-integration-demo`)

### Early Bail-Out Pattern Applied Successfully
- Checked PR status via ADO REST API: active, merge status succeeded
- Checked reviewer votes: Yemi Shin vote 10 (approved)
- Checked thread history: 7+ APPROVE verdicts, multiple closed threads confirming no action needed
- Total time: ~15 seconds vs 5-10 minutes for full worktree + build + test + lint cycle
(source: ADO REST API `GET /pullRequests/4970916?api-version=7.1` and `GET /pullRequests/4970916/threads?api-version=7.1`)

### ADO REST API Patterns (Reinforced)
- Thread creation with `status: 4` (closed) for "no action needed" confirmations works correctly (source: `POST /pullRequests/4970916/threads?api-version=7.1`, response thread id: 62182377)
- VSID retrieval via `GET /_apis/connectionData?api-version=6.0-preview` returns `1c41d604-e345-64a9-a731-c823f28f9ca8` (source: ADO REST API)
- Vote submission via `PUT /pullRequests/4970916/reviewers/{vsid}` with `{"vote": 10}` succeeds (source: ADO REST API)

## Gotchas
- **Engine dispatch still lacks pre-flight checks**: This is the 4th duplicate dispatch for this specific PR to Ripley alone. The engine should check existing reviewer votes and commit SHAs before dispatching review tasks.
- **MCP ADO tools unavailable**: Had to fall back to REST API via curl + Bearer token. This is reliable but adds boilerplate.

## Conventions
- When re-dispatched to review a PR you've already approved with no new commits, post a closed-status (4) thread confirming no action needed and re-submit vote.
- Always use `dev.azure.com` hostname, not `office.visualstudio.com` for REST API calls.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
