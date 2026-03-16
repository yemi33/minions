---
source: ripley-2026-03-16.md
agent: ripley
category: architecture
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970552 Review)

## Task
Review PR-4970552: feat(cowork): add comprehensive error handling and connection resilience
Branch: `user/yemishin/cowork-error-handling`

## Findings

### Phantom PR Detected — PR-4970552 Does Not Exist
- **PR-4970552 does not exist on ADO.** REST API returns `TF401180: The requested pull request was not found.` (source: `GET /ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970552?api-version=7.1`)
- The branch `user/yemishin/cowork-error-handling` exists locally and as a worktree at `C:/Users/yemishin/worktrees/user/yemishin/cowork-error-handling`
- **Branch has zero changes**: `git rev-parse` shows the branch HEAD (`e82af2e01`) is identical to `main` HEAD. No commits, no staged changes, no modified files.
- The branch was **never pushed to remote** — `git branch -r` shows no `origin/user/yemishin/cowork-error-handling`.
- This is the same phantom PR pattern documented in `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md` — a PR ID was assigned before work was actually done on the branch.

### Verdict
**CANNOT REVIEW** — No code exists to review. The branch contains zero changes relative to `main`. The PR was never created on ADO.

## Patterns & Conventions

### Phantom PR Detection Checklist (source: this review + PR-4970115 prior art)
1. `git fetch origin` — check if branch exists on remote
2. `git log main..<branch>` — check for commits diverging from main
3. ADO REST API `GET /pullRequests/{id}` — check if PR exists
4. If all three are empty/missing → phantom PR, no review possible

### ADO REST API Gotcha — Windows /dev/stdin
- On Windows, `node -e` cannot read from `/dev/stdin` (maps to `C:\dev\stdin` which doesn't exist). Use temp files with `$TEMP` env var or pipe through `node -e` with `process.stdin` instead. (source: this review session)

## Action Items
- **Engine should verify PR existence on ADO before dispatching review tasks.** This is the second phantom PR (after PR-4970115). Suggested pre-check: `GET /pullRequests/{id}` should return HTTP 200, not 404/TF401180.
- **Engine should verify branch has diverged from main before dispatching review tasks.** `git log main..<branch> --oneline | wc -l` should be > 0.
- The actual error handling work for the cowork feature has not been started. When it is, ensure the branch is pushed and a real PR is created before dispatching review.

---

# Ripley Learnings — 2026-03-16 (PR-4970128 Re-review)

## Task
Re-reviewed PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types (after fix commit ccb74bed4)

## Verdict: APPROVE (vote: 10)

## Findings

### Pattern Compliance
- New protocol types follow established patterns exactly: import from `./core`, use `Message<T>` / `ResponseMessage<T>`, type aliases at bottom of file (source: `modules/message-protocol/src/types/ask-user-question.ts:10,59-62`)
- `index.ts` barrel exports with section headers match existing structure (source: `modules/message-protocol/src/index.ts:119-127`)
- MessageType enum additions at end of enum block, no reordering (source: `modules/message-protocol/src/types/message-type.ts:166-172`)
- Test pattern matches existing: verify enum string values in dedicated `describe` blocks (source: `modules/message-protocol/tests/message-type.test.ts:280-296`)

### Architecture Observations
- **CoTStreamEventKind aligns with PptAgentCotContentType**: The 3 shared kinds (`thinking`, `text`, `tool_use`) match the existing `PptAgentCotContentType` union (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`). New kinds (`step_started`, `step_completed`, `ask_user_question`) extend for richer progression.
- **Discriminated union with `kind` field**: `CoTStreamEvent` uses `kind` as discriminant (source: `chain-of-thought-stream.ts:108-114`)
- **Bridge pattern CoT ↔ Ask-User**: `CoTAskUserQuestionEvent.questionId` references `AskUserQuestionMessage` (source: `chain-of-thought-stream.ts:99-106`)
- **`sequenceNumber` for ordering**: Monotonically increasing for WebSocket out-of-order protection (source: `chain-of-thought-stream.ts:123`)
- **`UserAnswerMessage` extends `ResponseMessage<T>`**: Correct — it's a reply. `AskUserQuestionMessage` extends `Message<T>` — agent-initiated. (source: `ask-user-question.ts:59-62`)

### Fix Commit (ccb74bed4) Assessment
- Adds `CoTTextEvent` with `kind: 'text'` aligning with `PptAgentCotContentType`
- Adds per-category test blocks for ChainOfThoughtUpdate, AskUserQuestion, UserAnswer
- Both correct additions addressing prior review feedback

### Gotchas for Downstream
- **`stepId` optionality**: Start/complete correlation is best-effort, not guaranteed (source: `chain-of-thought-stream.ts:55,67`)
- **`ChainOfThoughtContentNotifier` gap**: Existing notifier (`modules/chain-of-thought/src/content-handler.ts:4-5`) has simple `(content, filePath, basePath)` signature incompatible with structured `ChainOfThoughtUpdatePayload`
- **No runtime type guards**: Pure types only — downstream handlers must build their own guards
