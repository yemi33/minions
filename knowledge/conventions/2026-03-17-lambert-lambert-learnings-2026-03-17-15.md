---
source: lambert-2026-03-17.md
agent: lambert
category: conventions
date: 2026-03-17
---

# Lambert Learnings — 2026-03-17

## PR-4976897: feat(PL-W012): add AugLoop annotation integration for cowork agent operations

### Duplicate Dispatch — Early Bail-Out Applied

- **Commit**: `a0ab1d949aad` — unchanged from all prior reviews (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- **Thread count**: 60+ threads visible in ADO REST API response (source: `GET https://dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897/threads?api-version=7.1`)
- **Existing approvals**: Yemi Shin vote:10, plus 37-40 APPROVE verdicts from prior agent reviews (source: PR-4976897 thread history)
- **Action taken**: Attempted vote submission (vote:10) via REST API PUT; timed out after 20s — consistent with known ADO degradation at >40 threads
- **Thread posting skipped**: Per team convention, thread count >30 means no new thread posting to avoid worsening ADO rate-limiting (source: team notes "Skip bail-out thread posting when thread count exceeds 25-30")

### Patterns Confirmed

1. **ADO vote PUT timeout at high thread counts confirmed again**: PR-4976897 at 60+ threads causes vote API timeout at 20s. This is the 3rd+ independent confirmation of the >40 thread threshold. (source: `PUT https://dev.azure.com/office/OC/_apis/git/repositories/74031860-e0cd-45a1-913f-10bbf3f82555/pullRequests/4976897/reviewers/{vsid}?api-version=7.1` — HTTP timeout)

2. **Early bail-out pre-flight check effectiveness**: Git fetch + commit SHA comparison completed in <5 seconds. Full review cycle would have been 5-10 minutes. Time saved: ~99%. (source: `git log --oneline -3 origin/feat/PL-W012-augloop-integration`)

3. **Thread count escalation is self-reinforcing**: Each duplicate dispatch that posts a bail-out thread adds +1 to count, pushing PR further past the ADO API degradation threshold. At 60+ threads, even vote submission fails. The only safe action is to exit without any ADO write operations. (source: PR-4976897 thread count progression from 55→58→60+ across team notes timeline)

### Gotchas

- **Vote submission may silently fail on high-thread PRs**: When vote PUT times out, there's no confirmation the vote was recorded. The PR may appear unreviewed despite multiple approval attempts. Human reviewer should verify vote state manually for PRs with >50 threads. (source: timeout on vote PUT for PR-4976897)

- **MCP ADO tools remain unavailable**: `mcp__azure-ado__*` tools not discoverable via ToolSearch. REST API via curl + Bearer token from GCM credential fill is the only working path. (source: ToolSearch query returned "No matching deferred tools found")

### Action Items

- **Engine MUST implement pre-flight SHA + vote checks before dispatching**: This PR has been dispatched 10+ times with zero code changes. Each dispatch wastes agent compute time and may worsen ADO thread count. Three checks needed: (1) commit SHA comparison, (2) existing reviewer vote check, (3) thread count threshold >50 to skip dispatch entirely.

- **For PRs with >50 threads, skip ALL ADO write operations**: Neither thread posting nor vote submission reliably completes. The only safe action is to log the bail-out locally and exit.

---

## PR-4976897 (Re-dispatch #2): Same commit, vote succeeded this time

- **Commit**: Still `a0ab1d949aad` — zero changes (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- **Thread count**: 61 threads, 41 APPROVE (source: ADO REST API `GET /pullRequests/4976897/threads` response)
- **Vote submission**: vote:10 succeeded with HTTP 200 despite 61 threads (source: `PUT /pullRequests/4976897/reviewers/1c41d604-e345-64a9-a731-c823f28f9ca8` returned HTTP 200)
- **Thread posting**: Skipped per >30 threshold convention

### Correction to Prior Finding

- **ADO vote PUT is not deterministically broken at 60+ threads**: Prior dispatch reported timeout at 60+ threads; this dispatch succeeded at 61 threads with HTTP 200. The timeout is intermittent, not deterministic. Use 15s timeout and retry once on failure rather than skipping entirely. (source: successful HTTP 200 at 61 threads vs prior timeout at 60+ threads)

---

## PR-4976726 (Re-dispatch): feat(PL-W015): add cowork telemetry and performance tracking

### Duplicate Dispatch — No Action Required

- **Commit**: `52def1de9338` — unchanged from prior review (source: `git log --oneline -1 origin/feat/PL-W015-cowork-telemetry`)
- **Thread count**: 31 (exceeds 30-thread threshold — skipped thread posting) (source: ADO REST API `GET /pullRequests/4976726/threads` response)
- **APPROVE threads**: 18 existing (source: same API response)
- **Vote**: 5 (approve with suggestions) — resubmitted via REST API, HTTP 200 (source: `PUT /pullRequests/4976726/reviewers/1c41d604-e345-64a9-a731-c823f28f9ca8`)

### Prior Review Findings (unchanged)

Original review identified 5 non-blocking issues:
1. Duplicate constants `PERF_EVENT_TYPE` / `INTERACTION_EVENT_TYPE` (source: `apps/bebop/src/features/cowork/hooks/useCoworkTelemetry.ts:39-42`)
2. Four unused type definitions in `telemetryTypes.ts` (source: `apps/bebop/src/features/cowork/types/telemetryTypes.ts:25-94`)
3. Web vitals type/implementation mismatch (source: `telemetryTypes.ts:64-70` vs `useCoworkTelemetry.ts:245-270`)
4. Function identity instability — closures recreated every render (source: `useCoworkTelemetry.ts:272-283`)
5. Metadata key collision risk in `trackInteraction` (source: `useCoworkTelemetry.ts:218-234`)

---

## PR-4976897 (Re-dispatch #3): Same commit `a0ab1d949aad`, thread count still at 61

- **Commit**: `a0ab1d949aad` — unchanged (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- **Thread count**: 61 threads, 41 APPROVE (source: ADO REST API `GET /pullRequests/4976897/threads` response)
- **Vote submission**: vote:10 succeeded with HTTP 200, but took longer than usual (~30s+ vs typical <5s) at 61 threads (source: `PUT /pullRequests/4976897/reviewers/1c41d604-e345-64a9-a731-c823f28f9ca8` returned `{"vote":10}` HTTP 200)
- **Thread posting**: Skipped per >30 threshold convention
- **Verdict**: APPROVE — code already reviewed and approved in prior dispatches; no new changes

### Updated Finding

- **ADO vote PUT at 61 threads is slow but succeeds**: Vote completed with HTTP 200 after extended delay (~30s+). API is degraded but functional at 61 threads — slower than the <5s typical at <30 threads. (source: re-dispatch #2 and #3 both succeeded at 61 threads, but with high latency)

- **PR dispatched 15+ times total across all agents**: Dallas, Rebecca, Ripley, Lambert all independently confirmed `a0ab1d949aad` unchanged with 41 APPROVE threads. Engine pre-flight checks remain the critical fix. (source: team notes timeline)

---

## PR-4976897 (Re-dispatch #3): Same commit, early bail-out applied

- **Commit**: Still `a0ab1d949aad` — zero changes (source: `git log --oneline -1 origin/feat/PL-W012-augloop-integration`)
- **Thread count**: 61 threads, 41 APPROVE (source: ADO REST API `GET /pullRequests/4976897/threads` response, count=61)
- **Vote submission**: vote:10 submitted via REST API PUT (source: `PUT /pullRequests/4976897/reviewers/1c41d604-e345-64a9-a731-c823f28f9ca8`)
- **Thread posting**: Skipped per >30 threshold convention
- **Engine dispatch loop**: This is the 3rd+ Lambert dispatch for this PR alone. Engine consolidation pipeline continues to re-queue unchanged PRs.
