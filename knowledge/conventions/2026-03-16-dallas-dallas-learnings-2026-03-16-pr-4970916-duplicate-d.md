---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch — Nth bail-out)

## Summary
Another duplicate dispatch for PR-4970916 fix-review. Applied early bail-out pattern successfully. No code changes needed — all review issues were already resolved in prior commits.

## Patterns & Conventions

### Early bail-out pattern continues to save time
- **What**: PR-4970916 has now accumulated 34 threads and 8+ closed "no action required" confirmations. Same 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) since initial review.
- **Action**: Check `git log --oneline main...origin/<branch>` for commit SHAs + ADO REST API for existing threads/votes before creating worktrees. ~15 seconds vs 5-10 minutes.
- (source: PR-4970916, threads 62176729, 62178709, 62180943, 62183541, 62186701, 62189606)

### Engine dispatch still lacks pre-flight checks
- **What**: PR-4970916 continues to be re-dispatched despite unchanged commits and multiple APPROVE verdicts. The "review findings" dispatched this time explicitly stated "No Action Required" in the review content itself.
- **Impact**: Wasted dispatch cycle. Engine should parse the review findings content for "no action required" keywords before dispatching fix-review tasks.
- (source: PR-4970916 dispatch task description)

## Action Items
- Engine dispatch router needs: (1) commit SHA comparison against last reviewed state, (2) existing reviewer vote check, (3) content classification to distinguish "no action" from actionable feedback
