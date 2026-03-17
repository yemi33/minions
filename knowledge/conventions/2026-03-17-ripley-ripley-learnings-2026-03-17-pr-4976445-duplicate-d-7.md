---
source: ripley-2026-03-17.md
agent: ripley
category: conventions
date: 2026-03-17
---

# Ripley Learnings — 2026-03-17 — PR-4976445 Duplicate Dispatch

## PR Review: PR-4976445 (Duplicate Dispatch — No Action Required)

- **PR**: feat(PL-W001): consolidate cowork types for E2E branch integration
- **Branch**: `feat/PL-W001-e2e-consolidation-fix`
- **Latest commit**: `cdf36677dab0` (unchanged from prior review)
- **Existing threads**: 28 (9+ with APPROVE verdicts from multiple agents)
- **Vote**: 5 (approve with suggestions) — submitted successfully this time (source: ADO REST API PUT returned 200)
- **Thread posted**: HTTP 200 — closed-status no-action-required thread (source: ADO REST API POST to `dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976445/threads`)

## Patterns & Conventions

- **Early bail-out pattern continues to save time**: Pre-flight check (git fetch + commit SHA comparison + ADO threads API) completed in ~15 seconds vs 5-10 minutes for full review cycle. This is the Nth+10 dispatch for this PR with zero code changes. (source: PR-4976445 thread count = 28, all with same tip commit `cdf36677dab0`)

- **ADO vote PUT succeeds with 15s timeout at 28 threads**: Previously timed out on PRs with 40+ threads. With 28 threads, the PUT to `/reviewers/{vsid}` returned 200 within 15 seconds. Threshold for ADO timeout appears to be >40 threads. (source: curl PUT to `dev.azure.com/office/OC/_apis/git/repositories/.../pullRequests/4976445/reviewers/1c41d604-e345-64a9-a731-c823f28f9ca8`)

## Bugs & Gotchas

- **Engine dispatch deduplication still not implemented**: PR-4976445 has been dispatched 10+ times with identical commit `cdf36677dab0` and existing APPROVE votes from Yemi Shin (vote 10) plus multiple agent reviews. The engine's consolidation pipeline continues to re-queue reviews for unchanged PRs. (source: 28 threads on PR-4976445, most are bail-out notes)

- **Thread accumulation worsens ADO performance**: Each bail-out adds a thread. At 28 threads the vote API still works; at 40+ threads (seen on PR-4976897) it times out. Current trajectory will push this PR past the threshold. Consider skipping thread posting when count > 25. (source: observed across PR-4976445 at 28 threads vs PR-4976897 at 52+ threads)

## Action Items

- **Engine pre-flight check implementation remains critical**: Three checks needed before dispatching: (1) commit SHA comparison, (2) existing reviewer vote check, (3) thread count threshold. This would prevent all 10+ redundant dispatches on this PR alone. (source: PR-4976445 dispatch history)
