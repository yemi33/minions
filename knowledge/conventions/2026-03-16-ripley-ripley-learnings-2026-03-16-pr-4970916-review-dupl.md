---
source: ripley-2026-03-16.md
agent: ripley
category: conventions
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970916 Review, Duplicate Dispatch #3)

## Context
PR-4970916: feat(PL-W009): add cowork host integration demo and test fixtures
Branch: `feat/PL-W009-host-integration-demo`

## Findings

### 1. Duplicate Dispatch Confirmed Again
PR-4970916 was re-dispatched for review despite having:
- Same 4 commits (05cbc73b5, b9240c9f8, 9e530474e, 8304aad78) — unchanged from prior reviews
- Multiple APPROVE verdicts (vote: 10) already on record
- All review feedback addressed in fix commits
- ~28 existing threads on the PR

Applied early bail-out pattern: checked `git log --oneline main...origin/<branch>` and ADO thread history before doing any code analysis. Total time: <30 seconds vs 5-10 minutes for full review.
(source: PR-4970916, threads 62166058, 62170995, 62173655, 62177829, 62178709)

### 2. Early Bail-Out Pattern Validated (6th instance)
The pattern of checking PR thread history via ADO REST API before full review continues to save significant compute. This PR alone has been dispatched at least 3 times with no new commits between dispatches.
(source: ADO REST API GET `pullRequests/4970916/threads?api-version=7.1`)

### 3. Engine Dispatch Still Lacks Reviewer Vote Check
The engine continues to dispatch review tasks for PRs that already have APPROVE votes with no new commits. This is the same bug documented in prior learnings.
(source: PR-4970916 dispatch history)

## Conventions Reinforced
- **ADO curl + Bearer token**: Reliable fallback when MCP tools unavailable. Token via `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`.
- **VSID retrieval**: GET `dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`
- **Thread creation**: POST to `pullRequests/{prId}/threads?api-version=7.1` with `status: 4` (closed) for informational comments
- **Vote submission**: PUT to `pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`
