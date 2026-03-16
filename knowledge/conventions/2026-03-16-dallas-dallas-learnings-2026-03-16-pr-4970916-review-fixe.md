---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970916 Review Fixes)

## Task
Fix remaining review issues on PR-4970916 (cowork host integration demo).

## What Was Done
- Added runtime validation for `--scenario` CLI arg in demo-server.ts (replaced unsafe `as ScenarioName` cast)
- Moved UUID generation from module load time to per-call in mock-token-provider.ts

## Patterns Discovered

### Runtime validation for string union CLI args
When parsing CLI arguments that map to TypeScript string union types, always validate at runtime instead of using `as` casts. Pattern: define a `VALID_VALUES` array and `isValid()` type guard, then exit with helpful error message on invalid input.
(source: `.devtools/cowork-demo/src/demo-server.ts:25-37`)

### Avoid side effects in module-level DEFAULT_OPTIONS
Don't call functions like `uuidv4()` in module-level constant definitions — they execute at import time, causing non-deterministic behavior across test files. Instead, generate dynamic defaults inside the factory function.
(source: `.devtools/cowork-demo/src/mock-transport/mock-token-provider.ts:32-37`)

## Conventions to Follow

- `.devtools/` packages use `@officeagent-tools/` scope and allow `console.*` logging (source: `.devtools/cowork-demo/package.json`)
- Mock AugLoop server targets port 11040 matching AugLoop dev endpoint convention (source: `.devtools/test-client/src/augloop-client.ts`)
- ADO REST API fallback for PR comments: POST to `{org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` with `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` (source: PR-4970916 comment posting)

## Gotchas

- Previous review fix commit (`9e530474e`) already addressed the 3 major items (duplicate createMockTokenProvider, timer leak, QueryStatus workaround TODO). Always check existing commits before duplicating fixes.
- `yarn install` must complete in worktree before running tests — missing `node_modules/.yarn-state.yml` causes immediate failure (source: previous learnings from PR-4970916 build)
- `@officeagent/message-protocol` must be pre-built before cowork-demo tests can run (test imports fail with TS2307 otherwise)

---

# Dallas Learnings — 2026-03-16 (PR-4970128 Review Fixes, Round 2)

## Task
Fix 3 review suggestions on PR-4970128 (feat(PL-W015): add CoT streaming and ask-user-question protocol types).

## What Was Done
1. Made `stepId` required on `CoTStepStartedEvent` for reliable step correlation (was optional on both start/completed events)
2. Added PptAgentCotContentType relationship comment in module header
3. Added 12 compile-time type shape tests for all CoT and ask-user payload interfaces (tests: 113 → 125)

## Patterns Discovered

### Compile-time type shape tests pattern
Import interfaces into test files and construct objects with explicit type annotations. If a field is renamed or removed, the test won't compile. Combine with runtime `expect()` for full coverage.
(source: modules/message-protocol/tests/message-type.test.ts:430-540)

### stepId correlation convention
`CoTStepStartedEvent.stepId` is required; `CoTStepCompletedEvent.stepId` remains optional for fire-and-forget scenarios where completion doesn't need tracking.
(source: modules/message-protocol/src/types/chain-of-thought-stream.ts:48-65)

## Gotchas

### ADO mergeStatus vs status
ADO `mergeStatus: "succeeded"` means the merge CHECK passed (can be merged cleanly), NOT that the PR was merged. `status: "active"` is the lifecycle state. Don't confuse these when checking PR state.
(source: PR-4970128 ADO API response)
