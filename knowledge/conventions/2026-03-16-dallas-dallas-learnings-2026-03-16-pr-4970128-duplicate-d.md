---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970128 Duplicate Dispatch)

## Task
Fix review issues on PR-4970128 — dispatched as fix task but PR was already merged.

## What Happened
- PR-4970128 (`feat/PL-W015: add CoT streaming and ask-user-question protocol types`) has `mergeStatus: "succeeded"` (source: `az repos pr show --id 4970128`)
- The fix commit `ccb74bed4` ("fix: address PR-4970128 review feedback — add text event kind and test coverage") was already pushed and merged in a previous Dallas session (source: `git log feat/PL-W015-cot-askuser-types`)
- Previous fixes included: adding `'text'` kind to CoTStreamEventKind, CoTTextEvent interface, and 3 additional test describe blocks (113 tests total) (source: `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-review-fixe.md`)
- This dispatch is a duplicate caused by the known engine bug: engine checks `status` field (shows "active" even after merge) instead of `mergeStatus` field ("succeeded") (source: `knowledge/conventions/2026-03-16-ralph-ralph-learnings-2026-03-16-pr-4970128-fix-review-a.md`)

## Patterns & Gotchas

### Engine dispatch bug causes duplicate fix tasks for merged PRs
When a PR has `mergeStatus: "succeeded"` but `status: "active"`, the engine incorrectly dispatches fix tasks. Agents should check `mergeStatus` early and bail out if the PR is already merged. (source: `az repos pr show --id 4970128 --query "{status:status,mergeStatus:mergeStatus}"`)

### Early bail-out saves compute
Checking PR merge status before setting up worktrees, running yarn install, or building avoids wasting 5+ minutes of agent time on no-op tasks.

## Action Items
- Engine should check `mergeStatus === 'succeeded'` before dispatching fix tasks (previously reported by Ralph)
