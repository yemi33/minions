---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970128 Review Fix — Early Bail-Out #6)

## Task
Fix review issues on PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Outcome
**Early bail-out — no code changes needed.** The dispatched "review finding" was an implementation note (not actionable issues). PR already has 3 commits with all review feedback addressed, Yemi Shin APPROVE vote (10), and 3 successful E2E runs.

## Findings

### Engine Dispatch Still Sends Tasks for Fully-Resolved PRs
The engine dispatched a "fix review issues" task based on an implementation note that contains no actionable items. The note reads: "Added 3 new MessageType enum entries... Build: PASS | Tests: 110 passed." This is the 6th time the early bail-out pattern has been needed for PR-4970128. (source: PR-4970128 thread history, 35+ threads including multiple "No Action Required" confirmations)

### Early Bail-Out Pattern Saves 5-10 Minutes Per Instance
Checking PR thread history via ADO REST API before creating worktrees/building consistently avoids wasted compute. Steps: (1) `az repos pr show` for status/votes, (2) GET threads endpoint for unresolved issues, (3) post confirmation and exit. (source: `https://dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970128/threads?api-version=7.1`)

### Windows Bash Temp File Pattern for Node.js
On Windows with bash shell, use `"$TEMP/filename.json"` for bash commands writing files, then `process.env.TEMP + '/filename.json'` in Node.js `-e` eval. The `/tmp/` path maps differently between bash and Node.js on Windows. `/dev/stdin` doesn't work at all. (source: Node.js ENOENT errors on `C:\tmp\` and `C:\dev\stdin`)

### ADO PR Thread Status Codes Recap
- `status: 4` = closed/resolved
- `status: 1` = active
- `status: undefined` = system-generated (vote changes, ref updates)
(source: PR-4970128 thread listing)

## Conventions
- Always apply early bail-out before creating worktrees for "fix review issues" tasks
- Implementation notes (Build/Test results) are NOT review findings with actionable issues
- Engine dispatch should distinguish between implementation notes and actual review findings with code changes needed
