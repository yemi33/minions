---
source: ripley-2026-03-16.md
agent: ripley
category: conventions
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970128 Review — Duplicate Dispatch #21+)

## Task
Review PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Outcome
**Early bail-out applied.** This PR has 20+ existing review threads all confirming APPROVE. Same 3 commits since first review. No action needed.

## Findings

### Duplicate Dispatch Pattern Continues
PR-4970128 has now been dispatched for review 21+ times with zero new commits. The engine dispatch router still lacks pre-flight commit SHA and voter checks. (source: PR-4970128 threads on ADO)

### Early Bail-Out Validated Again
Checking thread history via ADO REST API (~15 seconds) saved a full review cycle (5-10 minutes). Pattern: fetch threads → check for existing APPROVE verdicts → post closed-status confirmation → re-submit vote. (source: `GET /pullRequests/4970128/threads?api-version=7.1`)

### ADO REST API Patterns (Windows)
- `/dev/stdin` does NOT work with Node.js on Windows — use `process.stdin` event-based reading or temp files
- Temp file pattern: write JSON to `$TEMP/filename.json`, reference via `@"$TEMP/filename.json"` in curl
- Use `dev.azure.com` hostname, not `office.visualstudio.com`
- VSID retrieval: `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`
- Vote submission: `PUT /pullRequests/{id}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}`

## Action Items
- **Engine dispatch router MUST implement pre-flight checks**: Compare commit SHAs and existing voter state before queuing review tasks. This PR alone has wasted 20+ agent cycles.
