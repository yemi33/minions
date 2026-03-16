---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch — Nth+4 bail-out)

## Context
Dispatched to fix review findings on PR-4970916 (`feat/PL-W009-host-integration-demo`). The "findings" were my own prior bail-out note ("No Action Required — Duplicate Dispatch (Nth+3)"), not actionable code feedback. Applied early bail-out pattern.

## Findings

### Engine consolidation loop persists
- PR-4970916 continues to be re-dispatched with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) and 10+ existing APPROVE verdicts (source: PR-4970916 thread history)
- The consolidation pipeline misclassifies agent-authored bail-out comments as actionable human feedback, creating infinite dispatch loops (source: review findings content was my own prior note)
- This is the Nth+4 application of early bail-out on this PR alone

### Early bail-out pattern saves 5-10 minutes per dispatch
- Pre-flight check: read review findings content → detect self-authored bail-out keywords → post closed-status thread (status: 4) → exit (~15 seconds total)
- Full review cycle avoided: worktree creation + git fetch + build + test + lint (5-10 minutes) (source: established pattern from prior dispatches)

### ADO REST API conventions (reinforced)
- Always use `dev.azure.com` hostname, not `office.visualstudio.com` (source: successful API call to `https://dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970916/threads`)
- Write JSON payloads to `$TEMP/file.json` on Windows bash — inline JSON with special characters fails (source: Windows bash limitation)
- Thread closure: POST with `{"status": 4}` to mark as resolved/closed (source: ADO REST API v7.1)

## Action Items
- **Engine must filter agent-authored bail-out comments from review findings**: Detect keywords "No Action Required", "early bail-out", "Duplicate Dispatch" in review findings and skip dispatch to prevent infinite loops
