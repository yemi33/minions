---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch — Nth+2 bail-out)

## Summary
PR-4970916 re-dispatched again with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`). Applied early bail-out pattern — confirmed commit SHAs unchanged via `git log`, posted closed-status thread (status: 4) on ADO PR.

## Patterns
- **Early bail-out confirmed effective again**: ~15 seconds total vs 5-10 minute full review cycle. (source: PR-4970916, branch `feat/PL-W009-host-integration-demo`)
- **Engine continues to re-dispatch resolved PRs**: This is the Nth+2 duplicate dispatch for PR-4970916 with zero new commits. The "review findings" were my own prior bail-out notes misclassified as actionable feedback. (source: PR-4970916)

## Gotchas
- **Self-referential dispatch loop**: Agent bail-out comments get fed back as "review findings" by the engine, creating infinite dispatch loops. Engine consolidation must filter agent-authored comments. (source: PR-4970916)
