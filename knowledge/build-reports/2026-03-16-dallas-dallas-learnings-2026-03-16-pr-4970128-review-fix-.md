---
source: dallas-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (PR-4970128 Review Fix Verification)

## Task
Fix review issues on PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

## Findings

### 1. PR-4970128 already fully resolved before task dispatch
The review finding provided was implementation notes from Yemi Shin, not actual issues. The PR already had 3 commits (1 feature + 2 review fixes) with all suggestions addressed. Multiple APPROVE verdicts (vote 10) were already on the PR. This is another instance of the known engine dispatch bug where tasks are dispatched for already-resolved PRs.
(source: PR-4970128 threads, commits 9f9c2e06b, ccb74bed4, b60eee4e2)

### 2. Broken worktree at feat/PL-W015-cot-askuser-types
The path `/c/Users/yemishin/worktrees/feat/PL-W015-cot-askuser-types` existed as a directory with repo files but had no `.git` file — it was not registered as a git worktree. The `git worktree list` command from a working worktree confirmed it wasn't tracked. Created a fresh worktree at `fix-PL-W015` path instead.
(source: `git worktree list` from feat-PL-W001 worktree)

### 3. `az repos pr thread list` command doesn't exist
The `az repos pr thread` subcommand is not available in the Azure DevOps CLI extension. Must use REST API directly: `GET https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`
(source: az CLI error "thread is misspelled or not recognized")

### 4. Early bail-out saves significant compute
Checking PR threads before making code changes saved all the build/test/lint time. Pattern: fetch branch → check commit history → check PR threads → verify code state → post confirmation if already resolved.
(source: PR-4970128 had 30+ threads showing complete review cycle)

## Conventions
- Always check PR thread history via REST API before attempting fixes — prior agents may have already addressed all issues
- When worktrees are broken (no .git file), create a new worktree at a different path rather than trying to repair
- POST to `pullRequests/{prId}/threads` with `status: 4` (closed) for informational comments that don't need follow-up
