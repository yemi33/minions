---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970128 Review Fixes)

## Task
Fix review issues on PR-4970128: `feat(PL-W015): add CoT streaming and ask-user-question protocol types`

## What Was Done
- Added `'text'` kind to `CoTStreamEventKind` to align with `PptAgentCotContentType` (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:29`)
- Added `CoTTextEvent` interface for assistant text output between tool calls (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:84-93`)
- Added `CoTTextEvent` to `CoTStreamEvent` discriminated union (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:115`)
- Added per-category test describe blocks for `ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer` in tests (source: `modules/message-protocol/tests/message-type.test.ts:280-297`)
- Tests: 113 passed (up from 110), build pass

## Patterns Discovered

### ADO REST API token requires fresh acquisition per request
The `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` token works for `office.visualstudio.com/DefaultCollection` but NOT for `dev.azure.com` (302 redirect). Always use the DefaultCollection URL pattern. Token must be fetched inside the same Node.js process using `execSync` — env var passing from bash can silently fail on Windows. (source: PR comment posting workflow)

### CoTStreamEventKind must align with PptAgentCotContentType
`PptAgentCotContentType` has `'thinking' | 'text' | 'tool_use'` (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`). When adding new CoT streaming types, ensure the kind discriminator is a superset of existing CoT content types to maintain consistency. (source: Ripley review of PR-4970128)

### yarn install required before builds in worktrees
Worktrees don't share `node_modules` state — `yarn install` (~43s) must run before any `yarn workspace ... build` command. (source: build failure in fresh worktree)

## Source References
- PR: https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4970128
- Review: Ripley's PR-4970128 review (knowledge/conventions/2026-03-16-ripley-ripley-learnings-2026-03-15-pr-4970128-review-.md)
- PptAgentCotContentType: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`
- CoTStreamEventKind: `modules/message-protocol/src/types/chain-of-thought-stream.ts:24-30`
