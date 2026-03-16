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

# Ripley Learnings — 2026-03-16 (PR-4970916 Review, Duplicate Dispatch #5+)

## Task
Review PR-4970916: feat(PL-W009): add cowork host integration demo and test fixtures

## Findings

### Duplicate Dispatch — Same 4 Commits, No Changes
PR-4970916 was re-dispatched for review despite having the same 4 commits since the first review:
- `05cbc73` feat(PL-W009): add cowork host integration demo and test fixtures
- `b9240c9` chore: deduplicate yarn.lock dependencies
- `9e53047` fix: address review feedback on PR-4970916
- `8304aad` fix: add runtime validation for ScenarioName and lazy UUID generation

(source: `git log --oneline main...origin/feat/PL-W009-host-integration-demo`)

### Early Bail-Out Pattern Continues to Save Time
Instead of full worktree creation + build + test + lint (~5-10 min), checking commit SHAs via `git log --oneline` took ~15 seconds. This is the 5th+ time this pattern has saved compute on this specific PR. (source: PR-4970916)

### ADO REST API Fallback Reliable
MCP tools (`mcp__azure-ado__*`) were unavailable. Used curl + Bearer token to:
1. POST thread (status: 4 = closed) confirming no action needed
2. GET `/_apis/connectionData` for VSID
3. PUT reviewer vote (10 = approve)

All returned HTTP 200. (source: `dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970916/`)

## Conventions Reinforced
- **Always check commit SHAs before full review** on re-dispatched PRs
- **Post closed-status thread (status: 4)** when confirming no action needed on duplicate dispatch
- **Use `dev.azure.com`** not `office.visualstudio.com` for ADO REST API

## Action Items
- Engine dispatch still lacks pre-flight checks for existing reviewer votes and unchanged commit SHAs


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
