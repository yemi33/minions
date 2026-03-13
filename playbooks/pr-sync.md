# PR Status Sync

> Agent: {{agent_name}} ({{agent_role}}) | Automated sync task

## Context

Team root: {{team_root}}

## Task

Check the live status of all active PRs across all projects and update the local tracker files. This is an automated housekeeping task — no code changes, no PRs, no worktrees.

## Projects and Their PRs

{{pr_sync_context}}

## Steps

For each project with active PRs:

1. **Fetch PR status from repo host:**
   {{pr_fetch_instructions}}
   - Pass the project's `repositoryId` and the PR's numeric ID (extract from `PR-NNNNN` format)
2. **Compare with local tracker** and update these fields:
   - `status`: map repo host status (1=active, 2=abandoned, 3=completed/merged)
     - If status is 3 (completed), also set `status: "merged"`
   - `reviewStatus`: ADO/GitHub human reviewer state — check `reviewers[].vote` (10=approved, 5=approved-with-suggestions, -5=waiting, -10=rejected, 0=no-vote)
     - Any vote >= 5 → `"approved"`
     - Any vote == -10 → `"changes-requested"`
     - Any vote == -5 → `"waiting"`
     - All votes 0 and at least one reviewer → `"pending"`
   - **Do NOT modify `squadReview`** — this field tracks squad agent reviews and is managed by the engine
   - `buildStatus`: check `mergeStatus` field from repo host response:
     - `mergeStatus: 3` (succeeded) → `"passing"`
     - `mergeStatus: 2` (conflicts) → `"conflicts"`
     - Also check PR statuses endpoint if available for CI build status
   - **Build failure detection**: if you can determine the build/CI failed (from PR statuses, merge conflicts, or policy evaluations), set `buildStatus: "failing"` and add `buildFailReason` with a brief explanation
3. **Write updated tracker** back to the project's `pull-requests.json`

## Output Format

Report a summary of changes:
```
## PR Sync Results
- ProjectA: 2 PRs checked, 1 updated (PR-123: pending → merged)
- ProjectB: 0 active PRs
- ProjectC: 1 PR checked, no changes
```

## Rules

- Do NOT create any PRs, branches, or commits
- Do NOT modify any code
- Only update `.squad/pull-requests.json` files
- If repo host API returns null/error for a PR, skip it (don't mark as failed)
- Use the exact repositoryId from the project config for each API call
