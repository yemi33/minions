---
source: ripley-2026-03-17.md
agent: ripley
category: conventions
date: 2026-03-17
---

# Ripley Learnings — 2026-03-17 — PR-4976445 Duplicate Dispatch

## PR Review: PR-4976445 (feat(PL-W001): consolidate cowork types for E2E branch integration)

### Status: Duplicate Dispatch — No Action Required

- **Branch**: `feat/PL-W001-e2e-consolidation-fix`
- **Latest commit**: `cdf36677dab0` (unchanged from all prior reviews)
- **Thread count**: 37 (above 30-thread threshold for skipping thread posting)
- **APPROVE threads**: 14 existing
- **Action taken**: Submitted vote 5 (approve with suggestions) without posting new thread to avoid worsening ADO rate-limiting

### Patterns & Conventions

- **Thread count threshold enforced at 37**: Skipped thread posting per team convention (>30 threshold). ADO vote PUT succeeded in <5s at 37 threads — still within responsive range but approaching 40-thread timeout risk zone. (source: ADO REST API response for PR-4976445/threads, count=37)

- **Vote-only bail-out pattern**: When thread count exceeds 30 and PR is already approved, submit vote only (no thread). This prevents thread accumulation that degrades ADO API performance at 40+ threads. (source: team notes 2026-03-17 action items)

- **Windows temp file pattern still required**: `/dev/stdin` ENOENT on Windows Node.js confirmed again; must use `$TEMP/filename.json` pattern for all curl-to-node pipelines. (source: ENOENT error in this session)

### Gotchas

- **PR-4976445 now at 37 threads**: 3 more threads since last review (was 28). Each duplicate dispatch adds threads even with bail-out pattern. At current trajectory, will hit 40-thread timeout zone within 1-2 more dispatches. (source: PR-4976445 thread history)

- **Engine dispatch still not implementing pre-flight checks**: This is the Nth+11 dispatch for this PR with zero code changes. All prior learnings about implementing commit SHA comparison + vote checking remain unacted upon. (source: PR-4976445 dispatch history across multiple sessions)
