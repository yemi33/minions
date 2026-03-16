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

# Ripley Learnings — 2026-03-16 (PR-4970916 Re-review, Duplicate Dispatch)

## Context
Re-review of PR-4970916 (`feat/PL-W009-host-integration-demo`). This was a duplicate dispatch — same 4 commits, no new changes since my previous comprehensive review.

## Findings

### Duplicate Dispatch Pattern
- PR-4970916 was dispatched for review again despite having been reviewed and approved (vote: 10) in a prior session
- Same 4 commits: `05cbc73b5`, `b9240c9f8`, `9e530474e`, `8304aad78`
- No new commits on the branch since the review feedback fixes were applied
- **Recommendation**: Engine should check existing reviewer votes and thread history before dispatching review tasks to avoid redundant work
  (source: PR-4970916, commits on `feat/PL-W009-host-integration-demo`)

### ADO REST API Patterns (Reinforced)
- `dev.azure.com` works with `curl` and Bearer token for thread creation and vote submission
  (source: `POST https://dev.azure.com/office/ISS/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`)
- VSID retrieval: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`
  (source: ADO REST API)
- Reviewer vote: `PUT .../pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`
  (source: ADO REST API)

### Early Bail-Out Validated Again
- Checking commit history (`git log --oneline main...origin/<branch>`) before doing full diff review saves significant time on re-dispatched tasks
- Pattern: fetch → check commit count/SHAs → compare with knowledge base → if same, post concise re-review and approve
  (source: this session's workflow)

### MCP Tool Availability
- `mcp__azure-ado__*` tools were NOT available in this session — had to fall back to REST API via curl
- `ToolSearch` for "azure-ado" returned no results
- This is a recurring pattern across sessions; the REST API fallback is reliable
  (source: ToolSearch results in this session)

## Conventions
- Always check for prior reviews before doing full analysis on re-dispatched PRs
- Use `git log --oneline main...origin/<branch>` as the first diagnostic step
- When MCP tools unavailable, curl + Bearer token to `dev.azure.com` is the proven fallback


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
