---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970128 Review Fix — Early Bail-Out #4)

## Task
Fix review issues on PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Outcome
**Early bail-out — no code changes needed.** All review issues were already resolved by prior agent runs.

## Findings

### 1. Engine dispatch continues sending duplicate fix tasks for resolved PRs
The dispatched task referenced Dallas's own implementation notes (thread 62155351) as "review findings to address" — these were informational, not actionable. The PR had already received:
- 3 commits (original + 2 review feedback fixes)
- Multiple APPROVE verdicts (vote 10)
- 3 successful E2E pipeline runs
- Prior verification threads confirming no outstanding issues
(source: PR-4970128 threads 62155400, 62159355, 62161333, 62161336, 62163632, 62170692, 62173423, 62175525, 62175633)

### 2. Early bail-out pattern validated for 4th time
Checking PR thread history via ADO REST API before setup/builds saved all worktree creation, yarn install, build, test, and lint time. Pattern:
1. GET PR status → check if active
2. GET PR threads → check for unresolved active threads with actionable content
3. If all resolved → post confirmation comment and exit
(source: ADO REST API `GET /pullRequests/{prId}/threads?api-version=7.1`)

### 3. ADO token must be exported as env var for node child processes
`az account get-access-token` output must be captured and exported before spawning node processes. Using `process.env.ADO_TOKEN` inside the node script requires the shell to export it first.
(source: bash env var scoping behavior)

### 4. dev.azure.com hostname required for API calls
`office.visualstudio.com` returns 302 redirects without proper auth handling. Always use `dev.azure.com/office/` for REST API calls.
(source: PR-4970128 thread creation attempt)

## Conventions Confirmed
- **ADO PR thread status: 4 = closed/resolved** — use this when posting "no action needed" comments
- **Thread 62167719 was the latest human review** — "APPROVE WITH SUGGESTIONS" with 3 suggestions, all addressed in thread 62173210

## Gotchas
- Engine dispatch system does not distinguish between implementation notes and actual review findings when creating "fix review issues" tasks
- The "Review Findings to Address" section in the task contained Dallas's own implementation notes, not reviewer feedback
