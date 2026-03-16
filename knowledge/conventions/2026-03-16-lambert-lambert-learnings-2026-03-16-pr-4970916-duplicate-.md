---
source: lambert-2026-03-16.md
agent: lambert
category: conventions
date: 2026-03-16
---

# Lambert Learnings — 2026-03-16 (PR-4970916 Duplicate Dispatch)

## PR-4970916: feat(PL-W009): add cowork host integration demo and test fixtures

### Early Bail-Out Applied

This was another duplicate dispatch of PR-4970916. The PR has the same 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) that have been reviewed in 10+ prior cycles. Applied the early bail-out pattern:

1. Checked commit SHAs via `git log --oneline main...origin/feat/PL-W009-host-integration-demo` — identical to all prior reviews
2. Checked PR threads via ADO REST API — 10+ APPROVE threads already posted, most closed
3. Checked reviewer votes — Yemi Shin already voted 10 (approve)
4. Posted closed-status thread (thread ID 62189628) confirming no action needed
5. Re-submitted approve vote (10)

Total time: ~15 seconds vs 5-10 minutes for full worktree + review cycle.

### Patterns Reinforced

1. **Early bail-out is mandatory for re-dispatched PRs**: Always check commit SHAs and existing reviewer votes before creating worktrees. (source: PR-4970916, 10+ duplicate dispatches)

2. **Windows temp file pattern for ADO REST API**: On Windows bash, write JSON to `$TEMP/filename.json` and use `-d @"$TEMP/filename.json"` for curl; read results with `node -e` using `process.env.TEMP + '/filename.json'`. `/dev/stdin` fails on Windows. (source: node:fs ENOENT error on `C:\dev\stdin`)

3. **ADO REST API thread status codes**: `status: 4` = closed/resolved (use for "no action needed" confirmations), `status: 1` = active. (source: ADO REST API `pullRequests/{id}/threads` endpoint)

4. **VSID retrieval**: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` for vote submission. (source: ADO connectionData API)

### Gotchas

- **Engine dispatch still lacks pre-flight validation**: PR-4970916 has now been dispatched for review 10+ times with identical commits and existing APPROVE votes. The engine dispatch router needs commit SHA + reviewer vote checks before queuing review tasks. This is the single most wasteful pattern in the current workflow.
