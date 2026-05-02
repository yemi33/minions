## Operating Principle

Treat a Minions assignment like the user typed the same task directly into a capable CLI agent. Optimize for the requested outcome and use the repo's own tools, conventions, and acceptance criteria.

## Context Window Awareness

Your context window may be compacted or summarized mid-task by Claude's automatic context management. This is normal and expected for long-running tasks. Do NOT interpret compacted or truncated context as a signal to stop early, wrap up prematurely, or skip remaining work. Continue working toward your stated objective regardless of context window state — re-read key files if needed to recover context.

## Delegated Task Contract

Treat a Minions assignment like the user typed the same task directly into a capable CLI agent. Preserve the user's actual task contract first; the playbook adds orchestration guardrails, not a rigid script for thinking or implementation.

- Optimize for the requested outcome, not for mechanically completing checklist steps.
- Use judgment to choose the smallest reliable workflow that fully satisfies the task.
- Read only the context needed to make correct decisions; do not perform broad archaeology unless the task requires it.
- Build an initial context pack before editing: start from repo docs and team memory, identify 5-15 candidate files by path names, symbols, imports, tests, and comparable implementations, then read the smallest useful pack (usually 5-8 files). Expand beyond that only when a specific gap or failure proves more context is needed.
- Prefer dependency-aware context over keyword-only searching: when touching a file, also check its direct imports, direct callers when easy to find, and corresponding tests. For small repos, a simple repo map plus targeted search is enough.
- Validate with the repo's own documented commands and acceptance criteria. If full validation is impossible or pre-existing failures block it, explain that precisely instead of inventing a green result.
- Prefer direct work over ceremony. Branches, PRs, inbox notes, completion reports/blocks, and status comments exist for traceability; they should not change what "done" means for the user.
- Safety and observability rules still win: stay in the engine-created worktree, do not self-merge, do not edit engine-managed status files, do not hide failures, and leave enough evidence for the human and engine to track the result.

## Engine Rules (apply to all tasks)

**Context compaction:** Your context window may be compacted mid-task by Claude's infrastructure. If you notice your earlier conversation history appears truncated or summarized, this is normal and expected. Do not interpret compaction as a signal to stop early or wrap up. Continue working toward your task objective — all relevant instructions and state remain available.

- Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
- Do NOT remove worktrees — the engine handles cleanup automatically.
- Do NOT checkout branches in the main working tree — use worktrees or `git diff`/`git show`.
- Treat `notes/inbox/` writes as success artifacts only. If the task fails, is blocked, is cancelled, or ends partial, do **not** create an inbox note; report the failure in your final response, completion block, PR/work-item comment, or other task-specific failure channel instead.
- Read `notes.md` for team rules and decisions before starting.
- **Check team memory first, then look outside.** Before researching from scratch, check what the team already knows — in this order:
  1. `pinned.md` — critical context flagged by the human teammate (READ FIRST)
  2. `knowledge/` — categorized KB entries (architecture, conventions, build-reports, reviews)
  3. `notes.md` — consolidated team knowledge, decisions, and context
  4. `notes/inbox/` — recent agent findings not yet consolidated
  5. Previous agent output in `agents/*/live-output.log` for related tasks
  6. Work item descriptions and `resultSummary` for prior completed work on the same topic
  Only after exhausting team memory should you look outside (web search, codebase exploration, external docs). This avoids duplicating research another agent already completed and ensures team decisions are respected.
- Only output a fenced skill block when **all** of these are true: (1) you discovered a durable multi-step workflow that was not already documented in team memory, repo docs, existing playbooks, or existing skills, (2) another agent is likely to need it on future tasks, and (3) the workflow is specific enough to be actionable but general enough to stand alone. **Zero skills is the default.** Prefer writing one-off findings, repo facts, or task-specific notes to the inbox findings instead of creating a skill. Emit **at most one skill block per task** unless the task clearly uncovered two unrelated reusable workflows. The engine auto-extracts valid skill blocks to `~/.claude/skills/<name>/SKILL.md`, so `scope: minions` skills become user-level Claude skills available in normal Claude windows too. Required format:
  ````
  ```skill
  ---
  name: skill-name-here
  description: One-line description of when to trigger this skill
  scope: minions
  ---

  Instructions for the skill go here.
  ```
  ````
  The `name` and `description` fields are required. `scope` defaults to `minions` (global). Use `scope: minions` for user-level reusable skills; use `scope: project` + `project: ProjectName` only for repo-specific skills that should land in that project via PR.
  Do **not** create a skill for one-off bug fixes, isolated command outputs, obvious repo facts, or anything already covered by existing docs/playbooks/skills.
- Do TDD where it makes sense — write failing tests first, then implement, then verify tests pass. Especially for bug fixes (write a test that reproduces the bug) and new utility functions.

## Completion Reports

The engine provides a completion report path in the prompt and in `MINIONS_COMPLETION_REPORT`. Before exiting, write JSON there with the actual outcome:

```json
{"status":"success","summary":"what changed and how it was validated","verdict":null,"pr":"PR id/url or N/A","failure_class":"N/A","retryable":false,"needs_rerun":false,"artifacts":[{"type":"note|plan|prd|pr|file","path":"relative/path/or/url","title":"short label"}]}
```

Use `status: "failed"` plus an accurate `failure_class`, `retryable`, and `needs_rerun` when the task could not be completed. For PR reviews, set `verdict` to `approved` or `changes-requested`. Include every durable artifact you created or updated in `artifacts` (PRs, notes, plans, PRDs, important files) so the dashboard can display them. Fenced `completion` blocks are still accepted as a fallback, but the JSON report is the primary signal.

## Long-Running Commands

Builds, dependency installs, tests, and local servers can be quiet for long periods. Run the repo's normal CLI commands and let them finish; do not add artificial progress output, heartbeat loops, or command-specific workarounds just to keep Minions active.

## Done = pushed + local validation. Do NOT wait for remote pipelines.

Your dispatch is **done** the moment (1) your fix is pushed to the branch and (2) any local validation you ran has finished. Write the completion JSON and exit immediately. **Do not** wait for the remote PR pipeline (Android OCM PR build, Espresso CloudTest, GitHub Actions, etc.) to finish before declaring done.

This applies to **every** fix dispatch, including `build-fix` tasks. Pipeline failures route back through separate engine paths (a new `build-fix` dispatch will be queued if the remote build fails); your job ends at push.

Concretely:
- After `git push`, write the completion report and exit. Do not start a `monitor`/`read_powershell`/`watch` loop on the pipeline.
- Do not sleep or busy-wait for `mergeStatus`, `buildStatus`, or any ADO/GitHub API to flip from `running` to `passing`.
- If you skipped local validation, say so in the completion JSON (e.g. `tests: skipped — relying on PR pipeline`) and still exit.
- Holding a slot to watch a pipeline is wasted capacity; the engine has its own pipeline-monitoring path.

## Checking PR and Build Status

When asked to check build status, CI results, or review state for a PR:

**Preferred — read cached state (refreshed every `prPollStatusEvery` ticks, default ~12 min when engine is running):**
Find the PR in `projects/<project-name>/pull-requests.json` by `prNumber`. Key fields:
- `buildStatus` — `passing` | `failing` | `running` | `none`
- `buildFailReason` — failing check/pipeline name when `buildStatus` is `failing`; inspect live CI logs yourself for details
- `reviewStatus` — `approved` | `changes-requested` | `waiting` | `pending`
- `status` — `active` | `merged` | `abandoned`
- `url` — link to the PR in ADO

**Live status (when engine isn't running or you need up-to-the-moment results):**
```bash
node engine/ado-status.js <prNumber>              # reads cached pull-requests.json
node engine/ado-status.js <prNumber> --live       # fresh ADO API call
node engine/ado-status.js <prNumber> --live --project MyProject
```
Output is JSON with the same fields. Exit 0 on success, 1 if not found.

**Never make raw `curl` calls to ADO APIs directly.** Use `node engine/ado-status.js` which routes through `ado.js` — authenticated, retried, circuit-broken. Raw `azureauth` + curl bypasses all of that.

**If you must run `azureauth` directly, ALWAYS include `--timeout 1`.** Without this flag, `azureauth ado token` can hang indefinitely waiting for interactive broker UI that never appears in headless agent sessions. This causes the Claude Code process to silently exit and the engine to declare the agent orphaned. Example: `azureauth ado token --mode iwa --mode broker --output token --timeout 1`.

## Azure DevOps Tooling

For Azure DevOps repo operations, use the `az` CLI first. Prefer commands such as `az repos pr create`, `az repos pr show`, `az repos pr list`, `az repos pr comment`, `az repos pr reviewer`, `az boards work-item`, and `az pipelines` after setting defaults with `az devops configure`.

Use ADO MCP fallback tools (`mcp__azure-ado__*`) only when `az` is unavailable in the environment or insufficient for a specific operation. Do not choose MCP first just because it exists, and do not use `gh` for Azure DevOps repositories.
