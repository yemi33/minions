---
source: ralph-2026-03-16.md
agent: ralph
category: build-reports
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch — Fix Review)

## Summary

Dispatched to fix "review findings" on PR-4970916 that were actually Rebecca's implementation notes (design decisions, test coverage summary, open questions) — not actionable code review issues.

Applied the early bail-out pattern: checked PR thread history, confirmed all issues resolved with identical 4 commits since first review, posted closed-status confirmation thread.

## Findings

### 1. Engine dispatch continues to misclassify implementation notes as review issues
The dispatched "findings" were:
- Design decision explanations (placement in `.devtools/cowork-demo/`, mock AugLoop on port 11040, fixture-driven scenarios)
- Test coverage summary (49 tests across 4 suites)
- Open architectural questions (Bebop-side demo route, library vs CLI usage)

None of these are code defects requiring fixes. (source: PR-4970916 thread 62165871)

### 2. PR-4970916 has received 9+ duplicate dispatches
Thread history shows 8+ closed "no action needed" confirmations from prior agents, plus multiple APPROVE verdicts (vote 10). The 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) have been unchanged throughout. (source: PR-4970916 threads on dev.azure.com)

### 3. Early bail-out saves ~5-10 minutes per dispatch
Checking PR thread history via ADO REST API (~15 seconds) vs full worktree setup + yarn install + build + test + lint cycle (5-10 minutes). This pattern has been validated 9+ times on this PR alone. (source: `GET /pullRequests/4970916/threads?api-version=7.1`)

## Conventions Reinforced

- **Always check PR thread history before starting fix work** — look for existing APPROVE verdicts, closed confirmation threads, and unchanged commit SHAs
- **Post closed-status thread (status: 4)** when confirming no action needed on duplicate dispatches
- **Use dev.azure.com hostname** for ADO REST API, not office.visualstudio.com
- **Write JSON to temp file** for ADO curl requests on Windows (`$TEMP/file.json` + `-d @"$TEMP/file.json"`)

---

## PR-4970128 Fix Review — Early Bail-Out (Same Session)

### Summary
Dispatched to fix "review findings" on PR-4970128 that were Dallas's implementation notes (`Build: PASS | Tests: 110 passed | Downstream core: PASS`) — not actionable code review feedback.

### Findings

1. **PR-4970128 has 40+ threads with 16+ APPROVE verdicts**: All review feedback addressed across 3 commits, 3 successful E2E pipeline runs. Multiple prior bail-out confirmations already posted. (source: PR-4970128 thread history, thread IDs 62155343-62188936)

2. **Git fetch fails from worktree context**: `git fetch origin feat/PL-W015-cot-askuser-types` failed from an existing worktree directory. The branch exists per ADO API (`sourceRefName: refs/heads/feat/PL-W015-cot-askuser-types`). Always fetch from the main working tree, not from within another worktree. (source: git fetch error from `/c/Users/yemishin/worktrees/feat/PL-W015-cot-askuser-types`)
