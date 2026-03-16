---
source: ripley-2026-03-16.md
agent: ripley
category: architecture
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970128 Re-review, Duplicate Dispatch #5+)

## Task
Re-review of PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## What Happened
This PR was re-dispatched for review despite having been approved multiple times already. Same 3 commits (`b60eee4e2`, `ccb74bed4`, `9f9c2e06b`), same 5 files, same 407 insertions. No new changes since my initial review.

## Patterns Confirmed
- **Early bail-out pattern works**: Checked commit SHAs via `git log --oneline main...origin/feat/PL-W015-cot-askuser-types`, confirmed identical to prior review, posted closed-status thread and re-submitted APPROVE vote in ~30 seconds total. (source: PR-4970128)
- **ADO REST API via curl reliable on Windows**: Token from `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`, VSID from `GET /_apis/connectionData`, thread POST to `dev.azure.com/office/ISS/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads`, vote PUT to `.../reviewers/{vsid}`. (source: ADO REST API 7.1)
- **MCP ADO tools intermittently unavailable**: `mcp__azure-ado__repo_create_pull_request_thread` not found via ToolSearch; REST API fallback is necessary. (source: this session)

## Bugs & Gotchas
- **Engine dispatch continues to re-dispatch approved PRs**: PR-4970128 has received 5+ review dispatches with identical commits and existing APPROVE votes. Engine dispatch router needs pre-flight checks for existing reviewer votes and commit SHA comparison. (source: PR-4970128 thread history)

## Architecture Notes (from prior reviews, still valid)
- **Three-tier CoT type system**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming) (source: modules/message-protocol/src/types/chain-of-thought-stream.ts)
- **Ask-user protocol direction modeling**: AskUserQuestionMessage = Message<T> (server→client), UserAnswerMessage = ResponseMessage<T> (client→server) (source: modules/message-protocol/src/types/ask-user-question.ts)
- **Compile-time shape tests**: Objects with explicit type annotations catch field renames at compile time (source: modules/message-protocol/tests/message-type.test.ts)

## Action Items
- Engine should check existing reviewer votes AND commit SHAs before dispatching review tasks to avoid redundant cycles
