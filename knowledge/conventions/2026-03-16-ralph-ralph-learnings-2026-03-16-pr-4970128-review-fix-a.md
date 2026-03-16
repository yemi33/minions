---
source: ralph-2026-03-16.md
agent: ralph
category: conventions
date: 2026-03-16
---

# Ralph Learnings — 2026-03-16 (PR-4970128 Review Fix Attempt)

## Task
Fix review issues on PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Findings

### PR Already Merged — No Outstanding Issues
- PR-4970128 was already merged (mergeStatus: succeeded, merge commit `9d6a1232d649`) before this fix task was dispatched (source: `az repos pr show --id 4970128`)
- Dallas had already applied review fixes in a second commit (`ccb74bed4f36`): added `text` kind to CoTStreamEventKind, added per-category test blocks (tests: 110 → 113) (source: PR thread 62157784)
- Yemi Shin approved with vote: 10 (source: PR reviewer data)
- Multiple APPROVE verdicts from automated reviews (source: PR threads 62155400, 62159355, 62161333, 62161336)

### ADO MCP Tools Unavailable
- `mcp__azure-ado__*` tools were not available in this session; had to fall back to `az devops invoke` for thread listing and comment posting (source: ToolSearch returned no matches)
- `az repos pr show` works with `--org https://office.visualstudio.com/DefaultCollection` but `az repos pr list --id` is not a valid argument (source: runtime error)
- Thread creation via `az devops invoke --in-file` requires writing JSON to a temp file on Windows; stdin heredoc piping doesn't work reliably (source: failed with `--in-file -`, succeeded with temp file path)

### PR Comment Posting Pattern (without MCP)
- Endpoint: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=ISS repositoryId=<id> pullRequestId=<id> --http-method POST --api-version 7.1 --in-file <path>`
- Body format: `{comments:[{parentCommentId:0,content:"...",commentType:1}],status:4}` where status 4 = closed (source: ADO REST API docs)
- Must use `2>nul` on Windows to suppress the "does not support Azure DevOps Server" warning (source: runtime stderr)

### Engine Dispatch Timing Gap
- The review fix task was dispatched after the PR was already merged and all review feedback addressed
- Recommendation: Engine should check `mergeStatus` field (not just `status`) before dispatching fix tasks — `status: active` can coexist with `mergeStatus: succeeded` on completed PRs (source: PR-4970128 had status=active but mergeStatus=succeeded)

## Conventions Confirmed
- PR thread comment creation works via `az devops invoke` when MCP tools are unavailable (source: thread 62162340 created successfully)
- `node -e` is the reliable scripting fallback on Windows for JSON processing (source: used throughout this session)
