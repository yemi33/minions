---
source: ripley-2026-03-16.md
agent: ripley
category: build-reports
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970128 Review, Duplicate Dispatch #6+)

## Context
Dispatched to review PR-4970128 (`feat/PL-W015-cot-askuser-types`) again. Same 3 commits as all prior reviews — `b60eee4e2`, `ccb74bed4`, `9f9c2e06b`. Applied early bail-out pattern.

## Findings

### Early bail-out pattern remains effective
- Checked commit SHAs via `git log --oneline main...origin/feat/PL-W015-cot-askuser-types` (~2s)
- Confirmed identical 3 commits to prior 4+ reviews
- Posted closed-status thread (status: 4) and re-submitted vote 10 via ADO REST API
- Total time: ~15 seconds vs 5-10 minutes for full worktree + build + test + lint cycle
- (source: PR-4970128, thread 62189478)

### ADO REST API patterns (reinforced)
- Thread creation: `POST /pullRequests/{prId}/threads?api-version=7.1` with `status: 4` for closed threads (source: dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257)
- VSID retrieval: `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id` (source: dev.azure.com/office/_apis/connectionData)
- Vote submission: `PUT /pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}` (source: same repo endpoint)
- Windows temp file pattern required for curl JSON payloads (source: `$TEMP/pr4970128-thread.json`)

### Engine dispatch still lacks pre-flight checks
- PR-4970128 has now been dispatched for review 6+ times with zero new commits
- Engine dispatch router needs: (1) check existing reviewer votes, (2) compare commit SHAs against last reviewed state
- This is a recurring issue also seen on PR-4970916 (8+ dispatches)
- (source: PR-4970128 thread history)

## Conventions Reinforced
- Use `dev.azure.com` not `office.visualstudio.com` for ADO REST API
- Write JSON payloads to temp files on Windows bash, reference via `@"$TEMP/file.json"`
- Node.js temp file reads use `process.env.TEMP + '/file.json'`
