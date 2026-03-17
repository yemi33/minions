---
source: ralph-2026-03-17.md
agent: ralph
category: build-reports
date: 2026-03-17
---

# Ralph Learnings — 2026-03-17

## Task: Review PR-4976897 (feat/PL-W012-augloop-integration)

### Summary

**Duplicate dispatch detected — early bail-out applied.**

PR-4976897 (`feat/PL-W012-augloop-integration`) dispatched for review again with identical commit `a0ab1d949aad`. This is the Nth+8 dispatch with zero code changes since the original review.

### Pre-flight Check Results

- **Commit SHA**: `a0ab1d949aad` — unchanged from all prior reviews (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- **Thread count**: 58 threads, 40 containing APPROVE verdicts (source: ADO REST API `GET dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897/threads?api-version=7.1`)
- **Existing vote**: vote:10 (approved) already submitted in prior session
- **Thread posting skipped**: Thread count (58) well past 30-thread threshold — skipped to avoid worsening ADO timeouts per team convention

### Patterns & Conventions

- **Early bail-out pattern saves 5-10 minutes per duplicate dispatch**: Pre-flight check (git fetch + commit SHA comparison + ADO threads API) completed in ~15 seconds vs full review cycle (worktree creation + build + test + lint). (source: PR-4976897 dispatch history, team notes)

- **Skip thread posting when count exceeds 30**: Per team convention, posting additional closed-status threads on PRs with >30 threads worsens ADO rate-limiting and causes PUT/POST timeouts. (source: team notes "Early bail-out pattern creates negative feedback loop")

- **ADO vote PUT times out when thread count exceeds 40**: Consistent with prior sessions — PUT to `/pullRequests/{prId}/reviewers/{vsid}` hangs beyond 15s when PR has 58 threads. Thread POST may also time out at these levels. (source: curl timeout on `dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897/reviewers/{vsid}?api-version=7.1`)

- **GCM credential retrieval remains reliable**: `printf "protocol=https\nhost=office.visualstudio.com\n" | git credential fill` returns valid Bearer token on first attempt. (source: this session)

### Bugs & Gotchas

- **Engine dispatch loop persists at Nth+8**: PR-4976897 continues to be re-dispatched with zero code changes and 40+ APPROVE threads. Engine consolidation pipeline still misclassifies agent bail-out comments as actionable feedback. (source: PR-4976897 thread history)

### Action Items

- **Engine must implement dispatch deduplication**: (1) Compare commit SHAs against last reviewed state, (2) Check existing APPROVE votes, (3) Thread count threshold to skip dispatch entirely if >50 threads. This single PR has wasted 8+ agent review cycles.

---

## Session 2: Another Duplicate Dispatch (same day)

**Duplicate dispatch detected again — early bail-out applied.**

- Commit `a0ab1d949aad` still unchanged
- ADO API now fully timing out on this PR (even GET on PR details endpoint), confirming thread accumulation rate-limiting has worsened (source: curl timeout to `dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897?api-version=7.1`)
- MCP ADO tools still unavailable (source: ToolSearch returned empty)
- No thread posted, no vote resubmitted — both would time out and worsen the problem
- **This is now dispatch #9+ for an unchanged PR with 58+ threads and 40+ APPROVE verdicts**

---

## Session 3: Yet Another Duplicate Dispatch (same day)

**Duplicate dispatch detected again — early bail-out applied.**

- Commit `a0ab1d949aad` still unchanged (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- ADO API fully timing out on ALL endpoints — threads GET, connectionData GET, reviewers PUT all hang >15s (source: curl timeouts to `dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897/*`)
- MCP ADO tools still unavailable (source: ToolSearch returned "No matching deferred tools found")
- No thread posted, no vote resubmitted — API completely unresponsive for this PR
- Vote (5, approve-with-suggestions) already submitted in original review session
- **This is now dispatch #10+ for an unchanged PR. Engine dispatch deduplication remains the #1 priority fix.**
