---
source: feedback-ralph-from-ripley-PR-4970552-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Ralph

**PR:** PR-4970552 — feat(cowork): add comprehensive error handling and connection resilience
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970552 Review)

## Task
Review PR-4970552: feat(cowork): add comprehensive error handling and connection resilience
Branch: `user/yemishin/cowork-error-handling`

## Findings

### Phantom PR Detected — PR-4970552 Does Not Exist
- **PR-4970552 does not exist on ADO.** REST API returns `TF401180: The requested pull request was not found.` (source: `GET /ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970552?api-version=7.1`)
- The branch `user/yemishin/cowork-error-handling` exists locally and as a worktree at `C:/Users/yemishin/worktrees/user/yemishin/cowork-error-handling`
- **Branch has zero changes**: `git rev-parse` shows the branch HEAD (`e82af2e01`) is identical to `main` HEAD. No commits, no staged changes, no modified files.
- The branch was **never pushed to remote** — `git branch -r` shows no `origin/user/yemishin/cowork-error-handling`.
- This is the same phantom PR pattern documented in `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md` — a PR ID was assigned before work was actually done on the branch.

### Verdict
**CANNOT REVIEW** — No code exists to review. The branch contains zero changes relative to `main`. The PR was never created on ADO.

## Patterns & Conventions

### Phantom PR Detection Checklist (source: this review + PR-4970115 prior art)
1. `git fetch origin` — check if branch exists on remote
2. `git log main..<branch>` — check for commits diverging from main
3. ADO REST API `GET /pullRequests/{id}` — check if PR exists
4. If all three are empty/missing → phantom PR, no review possible

### ADO REST API Gotcha — Windows /dev/stdin
- On Windows, `node -e` cannot read from `/dev/stdin` (maps to `C:\dev\stdin` which doesn't exist). Use temp files with `$TEMP` env var or pipe through `node -e` with `process.stdin` instead. (source: this review session)

## Action Items
- **Engine should verify PR existence on ADO before dispatching review tasks.** This is the second phantom PR (after PR-4970115). Suggested pre-check: `GET /pullRequests/{id}` should return HTTP 200, not 404/TF401180.
- **Engine should verify branch has diverged from main before dispatching review tasks.** `git log main..<branch> --oneline | wc -l` should be > 0.
- The actual error handling work for the cowork feature has not been started. When it is, ensure the branch is pushed and a real PR is created before dispatching review.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
