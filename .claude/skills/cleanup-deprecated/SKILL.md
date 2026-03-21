---
name: cleanup-deprecated
description: Remove deprecated code older than 3 days from the codebase using docs/deprecated.json as the tracker
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
trigger: when asked to clean up deprecated code, or proactively when deprecated items are older than 3 days
scope: squad
---

# Cleanup Deprecated Code

Remove deprecated backward-compat shims, dead code, and legacy aliases that have aged past their grace period.

## Steps

1. Read the deprecation tracker:
   ```bash
   cat docs/deprecated.json
   ```

2. For each entry, check if it's older than 3 days:
   - Parse the `deprecated` date field
   - Compare to today's date
   - Skip entries newer than 3 days (they need time for any old data to flush)

3. For each eligible entry, follow its `cleanup` instructions:
   - Read each file listed in `locations`
   - Remove the deprecated code (status aliases, dead functions, disabled endpoints, stale comments)
   - When removing a status alias (like `in-pr`, `implemented`, `complete`), search the entire codebase for any remaining references and remove them too
   - Do NOT remove backward-compat shims from test fixtures (seed-demo-data.js) — those should match whatever the current valid statuses are

4. After cleanup, run the test suite:
   ```bash
   cd <squad-dir> && npm test
   ```
   Fix any test failures caused by the removal.

5. Remove the cleaned-up entries from `docs/deprecated.json`.

6. Report what was cleaned up and what remains.

## Rules

- Never remove code that is still reachable or called
- When removing a status alias, grep the full codebase first to find ALL references
- If a status alias appears in a condition like `status === 'done' || status === 'in-pr'`, simplify to just `status === 'done'`
- If a status alias appears in a Set like `new Set(['done', 'in-pr', 'implemented'])`, remove the alias from the Set
- CSS classes for removed statuses can be deleted entirely
- Dead functions should be deleted along with any tests that specifically test they are dead
- After all removals, run tests. If tests fail, fix them (likely by updating assertions)
