---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970916 Review Fixes)

## Task
Fix review feedback on PR-4970916 (feat(PL-W009): add cowork host integration demo and test fixtures)

## Findings

### Patterns & Conventions
- **`.devtools/` packages use `@officeagent-tools/` scope**: cowork-demo follows pattern with jest + ts-jest, root-extending tsconfig. (source: `.devtools/cowork-demo/package.json`)
- **`console.*` allowed in `.devtools/` packages**: Unlike production modules, devtools logging rules are relaxed. (source: knowledge base — Ralph PR-4970916 review)
- **`az devops invoke` is reliable ADO PR comment fallback**: When `mcp__azure-ado__*` tools unavailable, use `az devops invoke --area git --resource pullRequestThreads` with temp file for JSON body. (source: PR-4970916 thread creation verified)

### Bugs Fixed
- **Duplicate `createMockTokenProvider` in mock-augloop-server.ts**: Simple 4-line version existed alongside full implementation in `mock-token-provider.ts`. No code imported the duplicate. Removed it. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts:107-120`)
- **Timer leak in `full_interactive` scenario**: The 30s timeout in `runFullInteractiveScenario` was pushed to `state.pendingTimers` but never cleared when `answerResolve` was called early. Fixed by wrapping resolve to clear timeout on early answer. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts:447-452`)
- **QueryStatus workaround for ask-user messages**: `buildAskUserMessage` and `buildUserAnswerMessage` wrap ask-user events in `MessageType.QueryStatus` because `AskUserQuestion`/`UserAnswer` types don't exist on main yet. Added TODO comments referencing PL-W001 dependency. (source: `.devtools/cowork-demo/src/fixtures/ask-user-events.ts:68,90`)

### Gotchas
- **Worktree needs `yarn install` before tests**: Running `yarn workspace ... test` fails with "Couldn't find the node_modules state file" if install hasn't been run in the worktree. (source: worktree at `feat/PL-W009-host-integration-demo`)
- **`@officeagent/message-protocol` must be built before cowork-demo tests**: Test suites importing message-protocol fail with TS2307 until `yarn workspace @officeagent/message-protocol build` is run. (source: test run failure, then success after build)
- **Windows temp file needed for `az devops invoke --in-file`**: `/dev/stdin` doesn't work on Windows; write JSON body to temp file first. (source: PR comment posting)
