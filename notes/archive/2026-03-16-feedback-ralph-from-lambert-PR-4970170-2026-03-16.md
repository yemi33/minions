# Review Feedback for Ralph

**PR:** PR-4970170 — feat(cowork): add cowork feature module scaffold with three-panel layout
**Reviewer:** Lambert
**Date:** 2026-03-16

## What the reviewer found

# Lambert Learnings — 2026-03-16

## PR-4970170: feat(cowork): add cowork feature module scaffold with three-panel layout

### Patterns Discovered

1. **Bebop feature directory convention confirmed**: New features follow the `features/<name>/` structure with subdirectories: `atoms/`, `components/`, `hooks/`, `serverFunctions/`, and a root `types.ts`. The `conversations/` feature is the reference pattern. (source: `apps/bebop/src/features/conversations/` directory listing, `apps/bebop/src/features/cowork/` in PR-4970170)

2. **TanStack Start server function pattern**: Server functions use `createServerFn({ method: 'POST' }).inputValidator(zodSchema).handler(async ({ data }) => ...)` from `@tanstack/react-start`. Zod schemas define input validation. (source: `apps/bebop/src/features/cowork/serverFunctions/coworkSession.ts` in PR-4970170)

3. **Bebop route registration**: Routes at `apps/bebop/src/routes/_mainLayout.<name>.tsx` are auto-discovered by TanStack Router's code generator (`tsr generate`). The `routeTree.gen.ts` file should NOT be manually edited — it's regenerated. Manual edits in PR-4970170 will be overwritten. (source: `apps/bebop/src/routeTree.gen.ts` diff in PR-4970170)

4. **Feature gate placement convention**: Feature gates belong in `beforeLoad` (throws `redirect()`), NOT in the component body (renders `<Navigate />`). The `beforeLoad` approach prevents the loader from running when the feature is disabled. PR-4970130 established this pattern with `guardCoworkRoute()`. (source: PR-4970130 review by Ripley, `apps/bebop/src/routes/_mainLayout.cowork.tsx:56-64` in PR-4970170)

5. **Feature gate key naming conflict**: PR-4970170 uses `EnableBebopCowork` as query param/localStorage key, while PR-4970130 uses `bebop.cowork.enabled` via `getFluidExperiencesSetting()`. These must be reconciled before both PRs merge to avoid two competing gate implementations. (source: `_mainLayout.cowork.tsx:15-41` in PR-4970170, PR-4970130 review findings)

6. **Cross-repo PR review via Azure CLI REST API**: When `mcp__azure-ado__*` tools are unavailable, use `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798` for auth token, then Node.js `https.request()` to ADO REST API. Thread comments: `POST /DefaultCollection/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`. Reviewer votes: `PUT .../reviewers/{reviewerId}?api-version=7.1` with body `{"vote": 5}`. (source: direct API calls during this review)

7. **office-bohemia repo details confirmed**: Repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`, project `OC`, org `office.visualstudio.com/DefaultCollection`, main branch `master`. The local clone lives at `C:/Users/yemishin/office-bohemia`. (source: `az repos pr show --id 4970170`)

### Gotchas

- **React Compiler dependency assumption**: PR-4970170's `CoworkLayout.tsx` uses `[connect, disconnect]` in `useEffect` deps without `useCallback`, relying on React Compiler for memoization. If React Compiler is not active for this file, this creates an infinite re-render loop. Always verify React Compiler coverage when omitting `useCallback`. (source: `apps/bebop/src/features/cowork/components/CoworkLayout/CoworkLayout.tsx:27-31`)

- **Bash escaping in Node.js heredocs**: Template literals with backtick-escaped content (`\``) cause bash interpretation issues when the string contains shell metacharacters like `()`, `$`, backticks. Use file-based approach or base64 encoding for complex review content instead of inline template literals. (source: review posting attempt during this session)

- **`git diff master...FETCH_HEAD` includes all master changes**: When diffing a PR branch in office-bohemia, the three-dot diff includes all changes between master and FETCH_HEAD. Filter with `-- "path/to/feature/"` to isolate PR-specific changes. (source: initial diff stat showing 90.6KB output)


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
