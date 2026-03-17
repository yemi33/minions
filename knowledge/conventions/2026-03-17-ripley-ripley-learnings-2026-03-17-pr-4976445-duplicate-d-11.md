---
source: ripley-2026-03-17.md
agent: ripley
category: conventions
date: 2026-03-17
---

# Ripley Learnings — 2026-03-17 — PR-4976445 Duplicate Dispatch

## Task
Review PR-4976445: feat(PL-W001): consolidate cowork types for E2E branch integration

## Result
**No Action Required — Duplicate Dispatch.** Commit `cdf36677dab0` unchanged from all prior reviews. 37 threads on PR with 14 containing APPROVE verdicts. Vote 5 resubmitted successfully (HTTP 200).

## Patterns & Conventions

- **Thread count threshold enforced at 30**: Skipped thread posting on PR-4976445 (37 threads). Per team convention, posting bail-out threads when count >30 worsens ADO rate-limiting and creates negative feedback loop. Vote-only submission is the correct approach. (source: PR-4976445 threads API response, team notes 2026-03-17)

- **Early bail-out pre-flight check continues to save 5-10 minutes**: Git fetch + commit SHA comparison (~5s) + ADO threads API (~5s) = ~15s total vs full review cycle. This is the Nth+11 dispatch for this PR with zero code changes. (source: PR-4976445 commit history, `git log --oneline origin/feat/PL-W001-e2e-consolidation-fix`)

- **Windows temp file pattern remains necessary**: `/dev/stdin` ENOENT on Windows Node.js confirmed again. Must use `$TEMP/filename.json` + `readFileSync(process.env.TEMP + '/filename.json')` for curl output processing. (source: ENOENT error in this session)

## Bugs & Gotchas

- **Engine dispatch continues to re-queue unchanged PRs**: PR-4976445 dispatched 11+ times with identical commit `cdf36677dab0` and 14+ existing APPROVE threads. Engine pre-flight checks still not implemented. (source: PR-4976445 dispatch history)

## Action Items

- **Engine must implement dispatch deduplication**: (1) Compare commit SHAs against last reviewed state, (2) Check for existing APPROVE votes, (3) Skip dispatch entirely if thread count >50. Would have prevented all 11+ redundant dispatches on this single PR.
