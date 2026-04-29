# Playbook: Fix Review Issues

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.minions/config.json` under `project.repositoryId`.
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}

## Your Task

Fix issues found by {{reviewer}} on **{{pr_id}}**: {{pr_title}}
Branch: `{{pr_branch}}`

{{checkpoint_context}}

## Review Findings to Address

{{review_note}}

## Health Check

Before starting work, run `git status` and verify the worktree is clean and on the expected branch (`{{pr_branch}}`). If the worktree is dirty or on the wrong branch, report the issue and stop.

## Working Style

Use subagents only for genuinely parallel, independent tasks. For sequential work, single-file edits, searches, and file reads, work directly — do not spawn subagents.

## How to Fix

1. You are already in the correct worktree on branch `{{pr_branch}}`. Do NOT create additional worktrees.

2. For each issue listed above, use your judgment:
   - **Fix it** if the feedback is valid and improves the code
   - **Explain your rationale** if you believe the current approach is correct — reply on the review thread explaining why, with specific reasoning (e.g., performance, consistency with codebase patterns, intentional design choice). Do NOT silently ignore feedback — always respond.

3. Handle merge conflicts if any:
   - If `git pull` or the PR shows conflicts, resolve them in the worktree
   - Prefer the PR branch changes, commit the resolution

## Build & Test (MANDATORY before pushing)

Before pushing, verify the fix doesn't break anything:

1. **Build** the project using its build system (check CLAUDE.md, README, package.json, Makefile). If the build fails, fix it before proceeding.
2. **Run the full test suite** using whatever command the project specifies (check CLAUDE.md, agent.md, README, or package.json scripts).
3. If any tests fail due to your changes, fix them before pushing.
4. If the build fails 3 times, report the errors in your PR comment and stop.
5. Do NOT push code that breaks existing tests or the build.

> ⚠️ **Long builds (Gradle, MSBuild, dotnet, fresh `npm install`)**: any command that may stay silent for more than ~4 minutes will be killed by the heartbeat monitor. Run it via `Bash(run_in_background: true)` then `Monitor` to stream stdout, OR pass an explicit `timeout` (max 600000 ms). See **Long-Running Build / Test Commands** below for the full pattern.

## Push & Comment on PR

Only after build and tests pass:

```bash
git add <specific files>
git commit -m "fix: address review feedback on {{pr_id}}"
git push
```

Do NOT remove the worktree — the engine handles cleanup automatically.

{{pr_comment_instructions}}
- pullRequestId: `{{pr_number}}`
- content: Explain what was fixed, reference each review finding, include build/test status
- Sign: `Fixed by Minions ({{agent_name}} — {{agent_role}})`

## Resolve Review Comments

After pushing, respond to each review comment/thread:
- **If you fixed it**: Reply confirming the fix, then resolve the thread
- **If you chose not to fix it**: Reply with your rationale explaining why the current approach is preferred — leave the thread open for the reviewer to decide
- **GitHub**: Reply to each review comment, resolve conversations you've fixed
- **ADO**: Use `az` CLI first to reply to each thread and update status when supported; use ADO MCP only as a fallback when `az` is unavailable or insufficient. Set status to `fixed` or `closed` for fixes; leave `active` for rationale replies

## When to Stop

Your task is complete once you have: (1) confirmed build and tests pass, (2) pushed the fix, (3) commented on the PR, and (4) resolved addressed review threads. Do NOT continue exploring unrelated code or making additional improvements. Stop immediately.

**NEVER run `gh pr merge` or any merge command on this PR.** The engine handles merging after review approval. Self-merging bypasses the review cycle and is prohibited.

## Completion

After finishing, output a structured completion block so the engine can parse your results:

```completion
status: done | partial | failed
files_changed: <comma-separated list of key files changed>
tests: pass | fail | skipped | N/A
pr: PR-<number> or N/A
failure_class: N/A
pending: <any remaining work, or none>
```

Replace the values with your actual results. This block MUST appear in your final output.
