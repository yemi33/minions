# Review Feedback for Rebecca

**PR:** PR-4970115 — Implement: Cowork mirrored protocol types
**Reviewer:** Lambert
**Date:** 2026-03-15

## What the reviewer found

# Lambert Learnings — 2026-03-15

## PR-4970115: feat(PL-W017) — Mirrored OfficeAgent Protocol Types for Bebop Cowork

### Review Summary
- **Verdict**: REQUEST_CHANGES
- **PR**: https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4970115
- **Repo**: office-bohemia (NOT OfficeAgent — the PR was tracked under OfficeAgent's `.squad/pull-requests.json` but lives in office-bohemia repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`)
- **Branch**: `feat/PL-W007-cowork-protocol-types` → `master`
- **File**: `apps/bebop/src/features/cowork/types/messageProtocol.ts` (single file, types only)

### Patterns Discovered

1. **PR repository mismatch in tracking**: The `.squad/pull-requests.json` in OfficeAgent tracks PR-4970115 with branch `work/PL-W017`, but the actual PR is in office-bohemia repo on branch `feat/PL-W007-cowork-protocol-types`. The `work/PL-W017` local worktree has zero changes. This means cross-repo PRs need a different tracking convention. (source: `.squad/pull-requests.json`, `az repos pr show --id 4970115`)

2. **Mirrored types pattern validated**: String union types over TypeScript enums is correct for Vite/esbuild (enums generate runtime objects that can't be tree-shaken). `readonly` on all fields prevents mutation in React/Jotai state. This should be the standard for all Bebop-side mirrored types. (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts`)

3. **ADO REST API for PR thread comments**: Use `POST {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` with body `{comments:[{parentCommentId:0,content:"...",commentType:1}],status:1}`. The `DefaultCollection` URL path works when the MCP tools aren't available. (source: ADO REST API, Thread ID 62155215)

4. **ADO REST API for reviewer votes**: Use `PUT .../pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1` with body `{"vote": -10}` for reject, `10` for approve, `5` for approve-with-suggestions. (source: ADO REST API)

5. **office-bohemia repo details**: Project is `OC` (not `ISS`), repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`, default branch `master`. (source: `az repos pr show --id 4970115`)

### Gotchas

- **Wire format field name mismatches are silent failures**: When mirrored types use different field names than the source (e.g., `question` vs `text`, `label` vs `stepLabel`, `message` vs `errorMsg`), JSON deserialization produces `undefined` with no runtime error. These are the hardest bugs to find. Always verify field names against the actual OfficeAgent source before approving mirrored type PRs.

- **OfficeAgent CoT types are still in-flight**: The OfficeAgent side types (`chain-of-thought-stream.ts`, `ask-user-question.ts`) exist as uncommitted changes in the `feat/PL-W001-cot-askuser-types` worktree. The Bebop mirror was written against a different version or was improvised. Both sides must be finalized and synced before either merges.

- **`az repos pr show` requires `--org` flag for Visual Studio URLs**: Use `--org https://office.visualstudio.com/DefaultCollection`. The `--project` flag is not supported; the project is inferred from the PR.

### Conventions to Follow

- When reviewing mirrored/cross-repo type PRs, always read the source-of-truth types first, then compare field-by-field against the mirror.
- Mirrored types should include `// Last synced: YYYY-MM-DD` and per-type `// Source: path/to/file.ts:line` comments.
- Every field name in a mirrored type MUST match the wire format exactly. Any intentional extensions must be explicitly marked `// Bebop extension`.

```skill
---
name: ado-pr-review-rest-api
description: Review and comment on ADO PRs using REST API when MCP tools are unavailable
allowed-tools: Bash, Read
trigger: when reviewing an ADO PR and mcp__azure-ado tools are not available
scope: squad
project: any
---

# ADO PR Review via REST API

## Prerequisites
- Azure CLI authenticated (`az account get-access-token`)

## Steps

1. Get access token:
   ```bash
   TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
   ```

2. Get PR details:
   ```bash
   az repos pr show --id <PR_ID> --org https://office.visualstudio.com/DefaultCollection
   ```
   Extract: `repository.id`, `repository.project.id`, source/target commits, reviewer IDs.

3. Get file content from PR source commit:
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "https://office.visualstudio.com/<projectId>/_apis/git/repositories/<repoId>/items?path=<filePath>&versionType=Commit&version=<commitId>&api-version=7.1"
   ```

4. Post review comment (write JSON to file first to avoid shell escaping):
   ```bash
   cat > /tmp/review_body.json <<'JSONEOF'
   {"comments":[{"parentCommentId":0,"content":"...","commentType":1}],"status":1}
   JSONEOF

   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d @/tmp/review_body.json \
     "https://office.visualstudio.com/DefaultCollection/<projectId>/_apis/git/repositories/<repoId>/pullRequests/<prId>/threads?api-version=7.1"
   ```

5. Set reviewer vote:
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"vote": <10|-10|5>}' \
     "https://office.visualstudio.com/DefaultCollection/<projectId>/_apis/git/repositories/<repoId>/pullRequests/<prId>/reviewers/<reviewerId>?api-version=7.1"
   ```
   Votes: 10=approve, 5=approve-with-suggestions, -10=reject

## Notes
- Always use `DefaultCollection` in the URL path
- Write JSON body to file to avoid shell escaping issues with markdown in review content
- project ID and repo ID come from `az repos pr show` output
```


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
