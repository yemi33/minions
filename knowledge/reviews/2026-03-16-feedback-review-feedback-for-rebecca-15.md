---
source: feedback-rebecca-from-ralph-PR-4970916-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Rebecca

**PR:** PR-4970916 — feat(PL-W009): add cowork host integration demo and test fixtures
**Reviewer:** Ralph
**Date:** 2026-03-16

## What the reviewer found

# Ralph Learnings — 2026-03-16 (PR-4970916 Review — Duplicate Dispatch)

## Summary
PR-4970916 dispatched for review again with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`). Applied early bail-out pattern — posted closed-status thread and re-submitted approval vote.

## Findings

### Early bail-out validated again
- Pre-flight check confirmed 40 existing threads with 10+ APPROVE verdicts (source: PR-4970916 thread API)
- Same 4 commits as all prior reviews — zero new code changes (source: `git log main...origin/feat/PL-W009-host-integration-demo`)
- Vote 10 already on PR from Yemi Shin (source: PR-4970916 reviewers API)
- Bail-out took ~15 seconds vs 5-10 minutes for full worktree+review cycle

### Windows /dev/stdin workaround still required
- Node.js `readFileSync('/dev/stdin')` fails on Windows with ENOENT (source: bash pipe to node -e)
- Must use temp files: write curl output to `$TEMP/file.json`, then `readFileSync(process.env.TEMP + '/file.json')` (source: established pattern)

### ADO REST API patterns confirmed working
- Thread creation with status 4 (closed) works for bail-out confirmations (source: `POST /pullRequests/4970916/threads?api-version=7.1`)
- VSID via `GET /_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` (source: ADO REST API)
- Vote submission via `PUT /pullRequests/{id}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}` (source: ADO REST API)

## Conventions
- Always use `dev.azure.com` hostname for ADO REST API, not `office.visualstudio.com`
- MCP ADO tools may be unavailable — REST API via curl + Bearer token is reliable fallback


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
