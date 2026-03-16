---
source: lambert-2026-03-16.md
agent: lambert
category: build-reports
date: 2026-03-16
---

# Lambert Learnings — 2026-03-16

## Build & Test: PR-4970334 (office-bohemia, not OfficeAgent)

### Patterns Discovered

1. **PR-4970334 is cross-repo**: The PR was filed against office-bohemia repo (ID `74031860-e0cd-45a1-913f-10bbf3f82555`, target `master`), not OfficeAgent. The OfficeAgent worktree at `user/yemishin/cowork-artifact-preview` has zero commits ahead of main. The actual code lives in the office-bohemia worktree at `C:\Users\yemishin\worktrees\feat-PL-W007-artifacts`. (source: `az repos pr show --id 4970334`, `git worktree list` in both repos)

2. **office-bohemia targeted builds**: Use `yarn lage typecheck --to @bebopjs/bebop` for scoped builds. The package name is `@bebopjs/bebop` (not `@fluidx/bebop`). Full build runs 106 lage tasks (typecheck + transpile) in ~8.5 minutes. (source: `apps/bebop/package.json:2`)

3. **office-bohemia lint via lage**: `yarn lage lint --to @bebopjs/bebop` runs the full lint pipeline including typecheck, then ESLint. The lint task depends on typecheck completing first. (source: lage task graph output)

4. **Bebop CSS lint rules are strict**: `css/use-baseline` rejects non-baseline CSS properties (`resize`, `word-break: break-word`); `css/font-family-fallbacks` requires fallback fonts + generic family. These trip up agent-generated CSS frequently. (source: lint output for `ArtifactPanel.module.css:34,114` and `CoworkChatPanel.module.css:88,96`)

5. **no-plusplus enforced in Bebop**: ESLint `no-plusplus` rule is active — use `+= 1` instead of `++`. (source: lint output for `coworkAtoms.ts:41,44,47`)

6. **Branch stacking confirmed**: The `user/yemishin/cowork-artifact-preview` branch in office-bohemia contains 2 commits ahead of master: scaffold (`a2947105b7a6`) and artifact preview (`cb43f827749d`). Both commits' lint errors are reported together. (source: `git log --oneline master..HEAD` in worktree)

### Gotchas

- **Cross-repo PR detection**: When dispatching build tasks, always check which repo the PR belongs to. PR-4970334's `artifactId` contains repo ID `74031860-e0cd-45a1-913f-10bbf3f82555` (office-bohemia), not OfficeAgent. The OfficeAgent worktree for the same branch name is a red herring. (source: `az repos pr show --id 4970334`)

- **office-bohemia worktree naming**: Worktrees for office-bohemia PRs are under `C:\Users\yemishin\worktrees\feat-PL-W007-artifacts`, not under the OfficeAgent worktree path. Check `git worktree list` from the office-bohemia root (`C:\Users\yemishin\office-bohemia`). (source: `git worktree list` output)

- **FormEvent is deprecated in React**: `import/no-deprecated` flags `FormEvent` — use `ChangeEvent`, `InputEvent`, `SubmitEvent`, or `SyntheticEvent` instead. This is a pre-existing issue in `CoworkChatPanel.tsx`. (source: lint output lines 6, 18)

```skill
---
name: office-bohemia-build-test
description: Build and test office-bohemia PRs targeting the Bebop app
allowed-tools: Bash, Read, Glob, Grep
trigger: when building or testing a PR in the office-bohemia repo for Bebop features
scope: squad
project: any
---

# Build & Test office-bohemia Bebop PRs

## Prerequisites
- Identify the correct worktree. office-bohemia worktrees are created from `C:\Users\yemishin\office-bohemia` (main branch: `master`).
- The Bebop app package is `@bebopjs/bebop`.

## Steps

1. **Find the worktree**: `cd /c/Users/yemishin/office-bohemia && git worktree list` — look for the branch matching the PR.

2. **Build (typecheck + transpile)**:
   ```bash
   cd <worktree-path> && yarn lage typecheck --to @bebopjs/bebop --no-cache
   ```
   Expect ~106 tasks, ~8-9 minutes.

3. **Run tests**:
   ```bash
   cd <worktree-path> && yarn lage test --to @bebopjs/bebop --no-cache
   ```
   Or for detailed output: `yarn workspace @bebopjs/bebop test`

4. **Run lint**:
   ```bash
   cd <worktree-path> && yarn lage lint --to @bebopjs/bebop --no-cache
   ```
   Lint depends on typecheck internally, so it runs the full pipeline.

## Common Lint Rules
- `no-plusplus`: Use `+= 1` instead of `++`
- `css/use-baseline`: Avoid non-baseline CSS properties
- `css/font-family-fallbacks`: Always include fallback + generic font family
- `import/no-deprecated`: Don't import deprecated React types (e.g., FormEvent)
- `import/no-duplicates`: Merge duplicate imports from same module
- No barrel files (`index.ts` re-exports)

## Notes
- office-bohemia uses Yarn 4.12 + lage (NOT the same as OfficeAgent's Yarn 4.10.3)
- Main branch is `master`, not `main`
- Bebop dev server requires auth proxy + Azure AD config; not practical for headless build-test
```

## PR-4970128: feat(PL-W015) — CoT Streaming and Ask-User-Question Protocol Types Review

### Review Assessment

PR-4970128 adds protocol types to `@officeagent/message-protocol` for real-time chain-of-thought streaming and bidirectional ask-user-question flows. The human reviewer (Yemi Shin) posted implementation notes — no specific fix requests. Both commits (initial implementation + text event kind fix) were already pushed and the PR was approved. Thread ID 62160105 posted.

### Patterns Discovered

1. **ADO API auth requires az CLI Bearer token, not git credentials**: Direct API calls to `office.visualstudio.com` fail with 203 (login page) when using `git credential fill` Basic auth. The correct approach is `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` for a Bearer token. (source: empirical testing during PR thread posting)

2. **MessageType enum extension pattern**: New enum values added at the end of the enum, under section comments, using snake_case string values. No reordering of existing entries. Tests verify string value equality and enum integrity (no duplicates). (source: `modules/message-protocol/src/types/message-type.ts:166-171`, `modules/message-protocol/tests/message-type.test.ts:280-294`)

3. **Discriminated union pattern for streaming events**: `CoTStreamEvent` uses `kind` field as discriminant with 6 event types. `CoTStreamEventBase` provides shared fields (kind, timestamp, turnNumber). Each concrete event extends the base with kind-specific fields. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:25-119`)

4. **Message vs ResponseMessage for direction**: Agent-to-client messages use `Message<T>` (e.g., `AskUserQuestionMessage`). Client-to-agent responses use `ResponseMessage<T>` which includes `requestId` for correlation (e.g., `UserAnswerMessage`). (source: `modules/message-protocol/src/types/ask-user-question.ts:58-62`)

### Gotchas

- **stepId optionality on both step_started and step_completed**: Correlation between step start/complete events is best-effort. Downstream consumers must handle uncorrelated events. (source: `chain-of-thought-stream.ts:53,62`)

- **No runtime type guards in this PR**: Type definitions only — downstream WebSocket handlers (PL-W001) must implement guards. (source: PR-4970128 review)

- **ChainOfThoughtContentNotifier interface gap**: Existing notifier signature differs from `ChainOfThoughtUpdatePayload`. PL-W001 handler will need to bridge. (source: knowledge base, Ripley's review)

- **az repos pr set-vote works but thread posting requires REST API**: The `az repos pr set-vote --vote approve` command works for voting, but posting thread comments requires direct REST API with Bearer token. (source: empirical testing)

```skill
---
name: ado-pr-comment-bearer-token
description: Post comments on ADO PRs using az CLI Bearer token instead of git credentials
allowed-tools: Bash
trigger: when posting thread comments on Azure DevOps pull requests and git credential auth returns 203
scope: squad
project: any
---

# Post ADO PR Thread Comments via Bearer Token

## Problem
Direct API calls to `office.visualstudio.com` using `git credential fill` Basic auth return 203 (login page). The `az repos` CLI doesn't have a direct thread-posting command.

## Steps

1. **Get Bearer token**:
   ```bash
   az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv
   ```

2. **POST thread comment** (use node for JSON body construction):
   ```javascript
   const token = execSync('az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv',{encoding:'utf8'}).trim();
   const url = 'https://office.visualstudio.com/DefaultCollection/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1';
   fetch(url, {
     method: 'POST',
     headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
     body: JSON.stringify({
       comments: [{ parentCommentId: 0, content: '...', commentType: 1 }],
       status: 4  // 1=active, 4=closed
     })
   })
   ```

3. **Approve PR** (this works with az CLI directly):
   ```bash
   az repos pr set-vote --id {prId} --vote approve --org "https://office.visualstudio.com/DefaultCollection"
   ```

## Notes
- Bearer token resource ID `499b84ac-1321-427f-aa17-267ca6975798` is the Azure DevOps resource GUID
- `status: 4` closes the thread; `status: 1` leaves it active
- `commentType: 1` = text comment
```
