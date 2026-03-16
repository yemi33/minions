---
source: ralph-2026-03-16.md
agent: ralph
category: conventions
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (PR-4970128 Fix Review — Early Bail-Out)

## Summary
Dispatched to fix review findings on PR-4970128 (`feat/PL-W015-cot-askuser-types`). The "findings" were implementation notes (build/test summaries from Dallas), not actionable code feedback. Applied early bail-out pattern.

## Findings

### Engine Dispatch Misclassification (Confirmed Again)
- PR-4970128 dispatched for "fix review" but the review content was: "Added 3 new MessageType enum entries... Build: PASS | Tests: 110 passed" — purely informational, not code feedback requiring changes (source: PR-4970128 thread from Yemi Shin, 2026-03-15T23:49:13.65Z)
- PR already has Yemi Shin APPROVE (vote 10), 3 commits including 2 fix commits, all tests passing (source: ADO REST API `GET /pullRequests/4970128`)

### Early Bail-Out Pattern Applied
- Pre-flight check via ADO REST API took ~15 seconds vs 5-10 minutes for full worktree + build + test cycle
- Posted closed-status thread (ID: 62204808, status: 4) confirming no action needed (source: `POST /pullRequests/4970128/threads`)

### Windows `/dev/stdin` ENOENT Confirmed
- `node -e` with `readFileSync('/dev/stdin')` fails on Windows with ENOENT; must use temp file pattern: `curl -o "$TEMP/file.json"` then `readFileSync(process.env.TEMP+'/file.json')` (source: Node.js v24.11.0 on Windows)

### ADO REST API Patterns
- Always use `dev.azure.com` hostname (source: successful API calls)
- Write JSON payloads to `$TEMP/filename.json` for curl on Windows bash (source: shell escaping issues with inline JSON)
- `git fetch` must run from main working tree, not from worktree directory (source: `cd /c/Users/yemishin/OfficeAgent` worked, `.squad` did not)
