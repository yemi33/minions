# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Minions

Minions is a multi-agent orchestration engine that dispatches Claude Code instances as autonomous agents to implement features, review PRs, fix bugs, and manage plans across multiple repositories. It runs as two Node.js processes: an **engine** (tick-based orchestrator) and a **dashboard** (web UI on port 7331).

## Commands

```bash
# Start
minions restart         # Start engine + dashboard
minions start           # Start the engine only
minions dash            # Open dashboard (starts if not running)

# Tests
npm test                # Unit tests (node test/unit.test.js)
npm run test:all        # Unit + integration (integration needs dashboard running)
npm run test:e2e        # Playwright E2E tests
```

Zero dependencies beyond Node.js built-ins. No build step.

## Architecture

### Dispatch Flow (engine.js tick cycle, every 60s)

```
checkTimeouts → consolidateInbox → cleanup (every 10 ticks) →
pollPrStatus (every prPollStatusEvery ticks, default 12) →
pollPrHumanComments (every prPollCommentsEvery ticks, default 12) →
discoverWork → updateSnapshot → dispatch agents (up to maxConcurrent)
```

Each phase is independently wrapped in try-catch — a failure in one phase does not abort the tick. Per-item try-catch in discovery loops ensures one bad work item doesn't block all dispatch.

### Agent Spawn Chain

```
engine.js spawnAgent()
  → builds prompt BEFORE worktree setup (parallel — prompt doesn't depend on worktree path)
  → git worktree add (20-60s for write tasks, skipped for read-only)
  → resolves runtime via registry: resolveRuntime(resolveAgentCli(agent, engine))
  → node engine/spawn-agent.js <prompt> <sysprompt> --runtime <name> [opts...]
    → adapter.resolveBinary() returns { bin, native, leadingArgs }
    → spawn(bin, [...leadingArgs, ...adapter.buildArgs(opts)])
    → prompt delivered using the runtime adapter's delivery mode
```

The CLI runtime is fully pluggable — see **Runtime Adapters** below for the
adapter contract, the registry, and the resolution helpers. Engine code
NEVER branches on `runtime.name === ...`; capability flags are the only
conditional gate.

**CC/doc-chat use a direct spawn path** (`direct: true` in `callLLM`/`callLLMStreaming`) that bypasses `spawn-agent.js` entirely — spawns the runtime CLI directly using the cached binary path resolved through the same adapter contract. Fewer file syscalls, no extra Node process.

**Dependency branches are fetched in parallel** via `Promise.allSettled`, then merged sequentially into the worktree.

Agents are **independent processes**. If the engine dies, agents keep running. On restart, the engine re-attaches via PID files and live-output.log mtimes, with a 20-minute grace period before orphan detection.

### Key Modules

Primary modules (the ones you'll touch most often):

| Module | Role |
|--------|------|
| `engine.js` | Orchestrator: spawn agents, manage dispatch queue, dependency resolution |
| `dashboard.js` | HTTP server: web UI, REST API, doc-chat, command center |
| `engine/shared.js` | Utilities, file locking, process spawning, **status/type constants** |
| `engine/queries.js` | Read-only state aggregation: config, dispatch, agents, work items, PRs, PRD info |
| `engine/lifecycle.js` | Post-completion: output parsing, PR sync, plan completion, verify workflow, skill extraction |
| `engine/dispatch.js` | Dispatch queue: add, complete, retry logic, failure alerts |
| `engine/consolidation.js` | Haiku-powered inbox → notes.md merging, KB classification |
| `engine/ado.js` | Azure DevOps: token cache, PR polling, comment polling, reconciliation |
| `engine/github.js` | GitHub: PR polling, comment polling, reconciliation (parallel to ado.js) |
| `engine/cli.js` | CLI handlers: start, stop, status, spawn, add project. Also owns orphan re-attach to surviving agents after engine restart (grace period, PID scan) |
| `engine/preflight.js` | Prerequisite checks: Node, Git, Claude CLI, API key. Powers `minions doctor` |
| `engine/scheduler.js` | Cron-style scheduled task discovery from `config.schedules` |
| `engine/pipeline.js` | Multi-stage pipeline execution (e.g. daily-arch-improvement) |
| `engine/meeting.js` | Team meetings: investigate → debate → conclude rounds |
| `engine/cooldown.js` | Exponential backoff for failed dispatches |
| `engine/timeout.js` | Timeout detection, steering, and idle threshold checks |
| `engine/llm.js` | Claude CLI invocation wrapper for consolidation/CC (direct spawn for CC/doc-chat, indirect via spawn-agent for engine agents) |
| `engine/watches.js` | Persistent watch jobs: monitor PRs/work items for conditions, fire inbox notifications when triggered |
| `engine/cleanup.js` | Worktree, temp file, and zombie process cleanup (every 10 ticks) |
| `engine/routing.js` | `routing.md` parsing, agent resolution, temp agent spawning |
| `engine/playbook.js` | Playbook loading, template variable substitution, project-local overrides |
| `engine/recovery.js` | Legacy recovery recipe metadata; dispatch retryability now prefers agent/runtime completion reports plus a global safety cap |
| `engine/projects.js` | Project lifecycle (`removeProject`): cancel WIs, drain dispatch, kill agents, clean worktrees, archive data dir. Shared by `minions remove` CLI and `POST /api/projects/remove` |

Support scripts (rarely edited directly):

| Module | Role |
|--------|------|
| `engine/spawn-agent.js` | Wrapper process that resolves the `claude` CLI path and invokes it with the correct flags |
| `engine/ado-mcp-wrapper.js` | Authentication shim for the ADO MCP server |
| `engine/ado-status.js` | CLI for querying PR status (cached or live); safe alternative to raw `curl` |
| `engine/check-status.js` | Fast status snapshot used by `minions status` |
| `engine/teams.js`, `engine/teams-cards.js` | Microsoft Teams notification integration |

### State Files (all runtime, gitignored)

- `engine/dispatch.json` — pending/active/completed queue
- `engine/control.json` — engine state (running/paused/stopped)
- `engine/log.json` — audit trail (2500 entries max, rotated to 2000)
- `engine/metrics.json` — per-agent token usage, quality metrics, runtime tracking, and LLM call performance (`_engine` for CC/doc-chat/consolidation/agent-dispatch, `_daily` for per-day aggregates)
- `engine/pipeline-runs.json` — pipeline execution state
- `engine/claude-caps.json` — cached claude CLI binary path and native flag (written by spawn-agent, read by llm.js for direct spawn)
- `engine/schedule-runs.json` — last-run times for cron schedules
- `engine/watches.json` — persistent watch job definitions and state
- `projects/<name>/work-items.json` — per-project work items
- `projects/<name>/pull-requests.json` — per-project PR tracker
- `plans/*.md` — plan drafts
- `prd/*.json` — PRD files with structured items
- `prd/guides/*.md` — verification testing guides

### Concurrency-Safe Writes

All writes to shared JSON files use `mutateJsonFileLocked()` or `mutateDispatch()` which acquire file locks. **Never use `safeWrite()` for files that may be read-modify-written concurrently** (dispatch.json, work-items.json, pull-requests.json, metrics.json). Always use `mutateJsonFileLocked()` for atomic read-modify-write.

### Concurrency & Lock Ordering

Building on the concurrency-safe writes above, follow these rules when working with file locks:

**Lock acquisition order:** When a single operation must acquire locks on multiple files, always lock in **alphabetical order by filename** (e.g., `dispatch.json` before `work-items.json`). This prevents deadlocks between concurrent agents/ticks.

**Which helpers own which locks:**

| Helper | Lock target |
|--------|-------------|
| `mutateDispatch()` | `engine/dispatch.json` (dedicated wrapper) |
| `mutateJsonFileLocked()` | Caller-specified file path (general-purpose) |

**Never hold two locks across an `await` boundary.** If you need data from two locked files, acquire the first lock, read/write, release it, then acquire the second. Holding a lock while awaiting an async operation (network call, process spawn, `setTimeout`) blocks all other consumers and risks deadlocks.

```js
// CORRECT — sequential short locks
await mutateJsonFileLocked(fileA, data => { /* fast read-modify-write */ });
await mutateJsonFileLocked(fileB, data => { /* fast read-modify-write */ });

// WRONG — nested locks risk deadlock; long-held lock blocks consumers
await mutateJsonFileLocked(fileA, async dataA => {
  await mutateJsonFileLocked(fileB, dataB => { ... }); // ← deadlock risk
  await someSlowOperation(); // ← blocks all fileA consumers
});
```

**Keep lock callbacks fast.** Expensive operations (process kills, network calls, git commands) must happen *outside* the lock callback. Pattern: lock → read + filter → release → execute expensive ops → lock again if needed to write results.

## Constants — No Magic Strings or Numbers

All status values, work types, and dispatch results are defined as constants in `engine/shared.js`. **Never use raw string literals for status comparisons or assignments.**

### Status Constants (`engine/shared.js`)

```js
// Work item statuses — use these for ALL status checks and assignments
const WI_STATUS = {
  PENDING, DISPATCHED, DONE, FAILED, PAUSED, QUEUED,
  NEEDS_REVIEW, DECOMPOSED, CANCELLED
};

// Done check — includes legacy aliases for backward-compatible reads
const DONE_STATUSES = new Set([WI_STATUS.DONE, 'in-pr', 'implemented', 'complete']);

// Work types
const WORK_TYPE = {
  IMPLEMENT, IMPLEMENT_LARGE, FIX, REVIEW, VERIFY, PLAN,
  PLAN_TO_PRD, DECOMPOSE, MEETING, EXPLORE, ASK, TEST, DOCS
};

// Plan statuses
const PLAN_STATUS = {
  ACTIVE, AWAITING_APPROVAL, APPROVED, PAUSED, REJECTED,
  COMPLETED, REVISION_REQUESTED
};

// PRD item statuses (for plan-to-prd flow)
const PRD_ITEM_STATUS = { MISSING, UPDATED, DONE };
const PRD_MATERIALIZABLE = new Set([MISSING, UPDATED]); // items the materializer acts on

// PR statuses
const PR_STATUS = { ACTIVE, MERGED, ABANDONED, CLOSED, LINKED };
const PR_POLLABLE_STATUSES = new Set([ACTIVE, LINKED]); // polled for status/build/comments

// Dispatch results
const DISPATCH_RESULT = { SUCCESS, ERROR, TIMEOUT };

// Watch constants (engine/watches.js)
const WATCH_STATUS = { ACTIVE, PAUSED, TRIGGERED, EXPIRED };
const WATCH_TARGET_TYPE = { PR: 'pr', WORK_ITEM: 'work-item' };
const WATCH_CONDITION = { MERGED, BUILD_FAIL, BUILD_PASS, COMPLETED, FAILED, STATUS_CHANGE, ANY, NEW_COMMENTS, VOTE_CHANGE };
// Absolute conditions auto-expire on first trigger when stopAfter=0
const WATCH_ABSOLUTE_CONDITIONS = new Set([MERGED, BUILD_FAIL, BUILD_PASS, COMPLETED, FAILED]);
```

### Usage Rules

```js
// CORRECT — use constants
if (item.status === WI_STATUS.PENDING) { ... }
item.status = WI_STATUS.DONE;
completeDispatch(id, DISPATCH_RESULT.ERROR, reason);
if (DONE_STATUSES.has(w.status)) { ... }

// WRONG — never use raw strings for status
if (item.status === 'pending') { ... }  // ← NO
item.status = 'done';                   // ← NO
```

### Configurable Limits

Retry limits and timeouts are in `ENGINE_DEFAULTS` — never hardcode numbers:

```js
// CORRECT
const maxRetries = ENGINE_DEFAULTS.maxRetries;  // default: 3
if (retries < maxRetries) { ... }

// WRONG
if (retries < 3) { ... }  // ← NO, use ENGINE_DEFAULTS.maxRetries
```

### Write-Side Rules for Done Status

**Only write `WI_STATUS.DONE`** — never write legacy aliases (`in-pr`, `implemented`, `complete`). The cleanup migration in `cleanup.js` converts old values on each run.

### Status Validation

`updateWorkItemStatus()` in lifecycle.js validates against `WI_STATUS` — invalid statuses are rejected with a warning log. `syncPrdItemStatus()` validates against `WI_STATUS` + `'missing'`.

## Work Item Lifecycle

```
pending → dispatched → done | failed | needs-human-review
                    → decomposed (for large items)
pending → cancelled (if PRD item removed)
failed → pending (auto-retry up to ENGINE_DEFAULTS.maxRetries)
```

Valid statuses: `pending`, `dispatched`, `done`, `failed`, `paused`, `queued`, `needs-human-review`, `decomposed`, `cancelled`. Legacy aliases `in-pr`, `implemented`, `complete` are accepted on read but never written.

## Plan → PRD → Work Items → Verify Pipeline

1. User creates plan (`.md` in `plans/`) → status `awaiting-approval`
2. Dashboard shows approve/reject/revise buttons
3. On approve → `plan-to-prd` agent converts to PRD JSON with structured items + acceptance criteria
4. PRD items materialized as work items with dependency tracking (`depends_on`)
5. Engine spawns agents per item, merging dependency branches into worktrees before start
6. When all items done → verify task auto-created → agent builds, tests, writes testing guide, creates E2E PR
7. **After verify completes** → plan archived to `prd/archive/` (not before — artifacts must exist first)

## Plan Resume (Diff-Aware PRD Updates)

When a completed/approved plan's source `.md` is edited, the engine flags the PRD as `planStale`. The dashboard shows a stale banner with three options:

- **Regenerate PRD**: Dispatches a diff-aware `plan-to-prd` agent (via `queuePlanToPrd()` in shared.js). Agent reads updated plan + existing PRD, compares, and writes updated PRD with: unchanged done items → `"done"`, modified items → `"updated"`, new items → `"missing"`, removed items → dropped. Triggered by `mode: diff-aware-update` marker in the work item description (playbook checks for this).
- **Resume as-is**: Clears `planStale`, approves the plan. No agent dispatched — materializer uses existing PRD items as-is.
- **Per-item "re-open" button**: Deterministic fallback. Sets individual done items to `"updated"` via `/api/prd-items/update`, also clears `planStale` via `/api/plans/approve`.

The materializer handles the PRD item statuses:
- `"missing"` → creates new work item, or re-opens existing done work item (resets to pending with `_reopened` flag)
- `"updated"` → re-opens existing done work item (resets to pending with `_reopened` flag, dispatches to existing branch)
- `"done"` → untouched

Both `PRD_ITEM_STATUS.UPDATED` and `PRD_ITEM_STATUS.MISSING` trigger re-open of done work items — a PRD reset to `missing` re-opens the existing done WI for re-implementation. Cross-project re-opens are deferred outside the lock to avoid nested lock violations.

Key helpers: `buildWiDescription(item, planFile)` for consistent WI description building, `queuePlanToPrd()` for atomic dedup-inside-lock dispatch (used by all plan-to-prd paths).

Only one verify WI per PRD at a time. If a verify is already pending/dispatched, skip. If done/failed and PRD re-completes, re-open the existing verify instead of creating a duplicate.

## Verify Workflow

- Verify WI created with `itemType: 'verify'`, `sourcePlan: <prd-file>`
- Archiving is **deferred** until verify completes (triggered in `runPostCompletionHooks` after `syncPrsFromOutput`)
- `archivePlan()` function in lifecycle.js handles: PRD → `prd/archive/`, source plan → `plans/archive/`, worktree cleanup
- Testing guide saved to `prd/guides/verify-{{plan_slug}}.md` (matched by `getVerifyGuides()` in dashboard.js)
- Verify playbook is platform-agnostic — agent reads project docs to figure out build/test/run steps

## Dependency-Aware Dispatch

Work items can declare `depends_on: ["P-001", "P-003"]`. Before spawning, the engine:
1. Resolves each dependency ID → work item → linked PR → branch
2. Fetches and merges dependency branches into the agent's worktree
3. Skips items whose dependencies haven't reached `done`

## Project Lifecycle: Remove

`removeProject(target, options)` in `engine/projects.js` is the canonical
project teardown — used by both `minions remove <dir-or-name>` (CLI) and
`POST /api/projects/remove` (Settings UI button). One implementation, identical
semantics regardless of entry point.

When a project is removed, in order:

1. Cancel pending/queued work items in `projects/<name>/work-items.json` and central `work-items.json` (sets `status: cancelled`, `_cancelledBy: 'project-removed'`). Done items pass through as history.
2. Drain dispatch (`pending` + `active` queues) for this project. Active agent processes are killed; pid files and prompt sidecars in `engine/tmp/` are unlinked. Reuses `cleanDispatchEntries` from `engine/dispatch.js` (same code path as plan delete).
3. Clean up worktrees under `<projectRoot>/<config.engine.worktreeRoot ?? '../worktrees'>/` via `shared.removeWorktree`.
4. Disable schedules whose `project` field matches this project. Schedules with `project: 'any'` or unset are left alone.
5. Surface pipelines that monitor this project (`monitoredResources` references) in the result's `pipelineRefs` — warn-only, not auto-modified, since user intent is unclear.
6. Remove the project entry from `config.json` and persist any schedule changes.
7. Move `projects/<name>/` to `projects/.archived/<name>-YYYYMMDD/` (auto-disambiguated with `-N` suffix on same-day collisions). Override with `dataMode: 'keep'` (leave in place) or `dataMode: 'purge'` (rm -rf).

`target` matches by project name OR resolved `localPath` — either works. The result summary surfaces counts for each cleanup step plus a `warnings[]` array for non-fatal issues. **Never use a vanilla `config.json` edit to remove a project** — the orphaned `projects/<name>/` data dir surfaces as ghost PRs and stale work items in the dashboard. Always go through `removeProject`.

## Config Structure (config.json)

```json
{
  "projects": [{
    "name": "MyProject",
    "localPath": "/path/to/repo",
    "repoHost": "ado",
    "repositoryId": "GUID",
    "adoOrg": "org", "adoProject": "project",
    "mainBranch": "main",
    "workSources": {
      "pullRequests": { "enabled": true, "cooldownMinutes": 30 },
      "workItems": { "enabled": true, "cooldownMinutes": 0 }
    }
  }],
  "agents": {
    "dallas": {
      "name": "Dallas", "role": "Engineer", "skills": [],
      "cli": "copilot",            // optional — overrides engine.defaultCli for this agent
      "model": "gpt-5.4",          // optional — overrides engine.defaultModel for this agent
      "maxBudgetUsd": 5,           // optional — overrides engine.maxBudgetUsd; 0 is a valid cap
      "bareMode": false            // optional — overrides engine.claudeBareMode
    }
  },
  "engine": {
    "tickInterval": 60000,
    "maxConcurrent": 5,
    "maxRetries": 3,
    "agentTimeout": 18000000,
    "heartbeatTimeout": 300000,
    "shutdownTimeout": 300000,
    "allowTempAgents": false,
    "autoDecompose": true,
    "autoFixBuilds": true,
    "autoFixConflicts": true,
    "evalLoop": true,
    "adoPollEnabled": true,
    "ghPollEnabled": true,
    "defaultCli": "claude",          // fleet runtime — must be a key registered in engine/runtimes/index.js
    "defaultModel": null,            // fleet model — null/undefined lets the runtime pick its own default
    "ccCli": null,                   // CC/doc-chat runtime override — null inherits defaultCli (independent of agent path)
    "ccModel": null,                 // CC/doc-chat model override — null inherits defaultModel
    "ccEffort": null,                // CC reasoning depth — null | 'low' | 'medium' | 'high'
    "claudeBareMode": false,         // Claude --bare (suppresses CLAUDE.md auto-discovery)
    "claudeFallbackModel": null,     // Claude --fallback-model on rate-limit / overload
    "copilotDisableBuiltinMcps": true,   // Copilot --disable-builtin-mcps (keep github-mcp-server out — see split-brain risk below)
    "copilotSuppressAgentsMd": true,     // Copilot --no-custom-instructions (stop AGENTS.md auto-load)
    "copilotStreamMode": "on",           // Copilot --stream on|off
    "copilotReasoningSummaries": false,  // Copilot --enable-reasoning-summaries (Anthropic-family models only)
    "maxBudgetUsd": null,            // fleet --max-budget-usd ceiling; 0 is a valid cap (read-only / dry-run)
    "disableModelDiscovery": false   // skip runtime.listModels() REST calls fleet-wide
  },
  "schedules": [{
    "id": "nightly-tests", "cron": "0 2 *", "type": "test",
    "title": "Nightly test suite", "project": "MyProject", "enabled": true
  }]
}
```

Key engine config flags:
- `autoFixBuilds` — gates build-failure auto-fix dispatch (when `false`, failing builds are notified but not auto-fixed)
- `autoFixConflicts` — gates merge-conflict auto-fix dispatch
- `evalLoop` — controls the review→fix cycle: auto-review dispatch after implementation, and re-review dispatch after fix. When `false`, no automatic review or fix-cycle dispatch occurs. The engine no longer enforces review-loop attempt caps; agents report retryability/escalation through completion reports.
- `adoPollEnabled` / `ghPollEnabled` — engine-level toggles that gate all ADO/GitHub PR status and comment polling; when `false`, `reviewStatus` is stale and review dispatch is also suppressed
- `workSources` (per-project) — per-project toggles for which discovery sources are active (`pullRequests.enabled`, `workItems.enabled`) and their cooldown windows

## Routing

`routing.md` maps work types to agents: `implement → dallas`, `review → ripley`, `fix → _author_`, `decompose → ripley`, etc. The engine reads this on each tick.

## Playbooks

Templates in `playbooks/` with `{{template_variables}}` filled at dispatch time. These define what agents actually do. Current set: `work-item.md` (shared fallback), `shared-rules.md` (auto-injected into every playbook), `implement.md`, `implement-shared.md`, `review.md`, `fix.md`, `explore.md`, `ask.md`, `test.md`, `build-and-test.md`, `plan.md`, `plan-to-prd.md`, `verify.md`, `decompose.md`, `meeting-investigate.md`, `meeting-debate.md`, `meeting-conclude.md`. Extra snippets live in `playbooks/templates/` (e.g. `verify-guide.md`).

Playbooks must be **platform-agnostic** — never hardcode build commands, languages, or frameworks. Agents should read project docs (CLAUDE.md, README, package.json, Makefile, etc.) to determine how to build/test/run.

### Project-Local Playbook Overrides

Projects can override global playbooks by placing files at `projects/<name>/playbooks/<playbook>.md`. At dispatch time, `resolvePlaybookPath(projectName, playbookType)` checks for a project-local override first and falls back to the global `playbooks/<playbook>.md`.

```
projects/
  office-bohemia/
    playbooks/
      implement.md    ← used instead of playbooks/implement.md for office-bohemia tasks
  minions/
    playbooks/
      review.md       ← used instead of playbooks/review.md for minions tasks
```

Project-local playbooks are user data and stay gitignored with the rest of `projects/`. The bundled shared templates in the top-level `playbooks/` directory are the tracked defaults that ship with the repo.

## Skills

Markdown files with YAML frontmatter in `.claude/skills/<name>/SKILL.md`. `scope: minions` skills are written to the user's `~/.claude/skills/` directory so they are available to Minions and normal Claude windows; `scope: project` skills are PR'd into `<project>/.claude/skills/`. Agents can auto-extract skills from their output using ` ```skill ` fenced blocks.

## PR Review Protection

`reviewStatus: 'approved'` is a **permanent terminal state** — no code path may ever downgrade it. Guards exist in:
- ADO/GitHub pollers: `if (pr.reviewStatus === 'approved') { newReviewStatus = 'approved'; }` — first check, before any vote computation
- PR persistence (merge-back): before replacing on-disk PR with in-memory copy, preserve `approved` from disk if stale in-memory copy lost it
- Pre-dispatch live vote check: `if (pr.reviewStatus !== 'approved') pr.reviewStatus = liveStatus`
- `updatePrAfterReview` / `updatePrAfterFix`: guard before any write

ADO vote re-approval: when ADO resets votes because target branch (master) moved but source branch is unchanged (`_adoSourceCommit` didn't change), the engine re-applies the approval vote via ADO API.

ADO comment poller: only processes `active` (1) and `pending` (6) threads — skips resolved/closed/fixed/wontFix threads. Per-agent review metrics tracked via `trackReviewMetric()` in shared.js (only for configured agents).

Context-only PRs: PRs with `_contextOnly: true` are polled (status, votes, builds) but never dispatched for review/fix. Set via dashboard "Link PR" with `autoObserve: false`. `PR_POLLABLE_STATUSES` includes both `ACTIVE` and `LINKED`.

## ADO Integration

Token via `azureauth ado token --mode iwa --mode broker --output token --timeout 1`. Cached 30 min, 10-min backoff on failure. **All `azureauth` calls MUST include `--timeout 1`** — without it, the command can hang indefinitely waiting for interactive broker UI that never appears in headless agent sessions, causing agent orphans. PR status and human comments are polled every `prPollStatusEvery` / `prPollCommentsEvery` ticks (default 12 each, ~12 min). PR → PRD item linking derived from `pull-requests.json` prdItems.

For agent-driven Azure DevOps actions outside the engine pollers, use the `az` CLI first. Use ADO MCP tools (`mcp__azure-ado__*`) only as a fallback when `az` is unavailable or insufficient for the operation. Never use `gh` for Azure DevOps repositories.

**evalLoop and polling interaction:** `evalLoop` gates the entire review→fix cycle. `adoPollEnabled` (or `ghPollEnabled` for GitHub projects) gates whether PR status is polled at all. Review auto-dispatch requires *both* to be true — `reviewEnabled = evalLoopEnabled && pollEnabled`. After a fix agent completes, the PR's `reviewStatus` is reset to `'waiting'` and `minionsReview.fixedAt` is set, which triggers a second-pass re-review on the next discovery tick (also gated by `evalLoop`). The `autoReview` flag was removed and consolidated into `evalLoop`.

## Dashboard

The dashboard is assembled from fragments in `dashboard/` at startup: `styles.css`, `layout.html`, page HTML fragments in `dashboard/pages/`, and JS modules in `dashboard/js/`. Assembled into one HTML string and served as a single-page app. Sidebar navigation uses the page list defined in `dashboard.js` — currently: `home`, `work`, `prs`, `plans`, `inbox`, `tools`, `schedule`, `watches`, `pipelines`, `meetings`, `engine` (search `dashboard.js` for `const pages =` if this drifts).

## Command Center & Doc-Chat

CC and doc-chat share the same LLM pipeline (`ccCall` in dashboard.js) but serve different purposes.

### Command Center (CC)

The CC panel is the user's primary interface for orchestrating agents. It sends messages via `POST /api/command-center` (non-streaming) or `GET /api/command-center/stream` (SSE streaming).

**Flow:**
```
User types message → ccCall() → buildPrompt() → llm.callLLM({ direct: true })
  → spawns claude CLI directly (no spawn-agent.js) → response parsed
  → parseCCActions() extracts ===ACTIONS=== → actions executed (dispatch, note, pin, etc.)
```

**System prompt:** `CC_STATIC_SYSTEM_PROMPT` — loaded from `prompts/cc-system.md` (~11KB) with `{{minions_dir}}` substituted in. Defines guardrails, filesystem map, delegation rules, action types, domain terminology. Hashed via `_ccPromptHash` for session invalidation on prompt changes.

**State preamble:** `buildCCStatePreamble()` — lightweight snapshot of agents, dispatch, PR/WI counts, project list, schedule/pipeline counts. Cached with 10s TTL. Skipped on session resume (session already has context).

**Sessions:** Single global CC session (`ccSession`), persisted to `engine/cc-session.json`. Bounded by `ENGINE_DEFAULTS.ccMaxTurns` (default 50 turns) and `ENGINE_DEFAULTS.ccSessionTtlMs` (default 2h — resumed sessions older than this are rotated to cap context growth). Resume via `--resume` flag. The session is also invalidated (forcing a fresh start) when the system prompt changes — detected by hashing `CC_STATIC_SYSTEM_PROMPT` into `_ccPromptHash` and comparing on each call. Per-tab sessions (streaming path) don't mutate the global `ccSession`.

**Model/effort:** Configurable via `config.engine.ccModel` (sonnet/haiku/opus) and `config.engine.ccEffort` (null/low/medium/high). Applied to all CC and doc-chat calls.

### Doc-Chat

Doc-chat provides inline Q&A and editing for documents opened in modal dialogs (plans, PRDs, KB entries, notes, meetings).

**Flow:**
```
User opens doc modal → showModalQa() → _initQaSession() loads thread from localStorage
User sends message → POST /api/doc-chat { message, document, title, filePath, model }
  → handleDocChat() re-reads file from disk (freshest content)
  → ccDocCall() adds document context, calls ccCall()
  → response: ---DOCUMENT--- delimiter splits answer from edited content
  → parseCCActions() runs on answer portion only (not document content)
  → if edited: safeWrite() saves to disk, frontend updates modal
```

**Sessions:** Per-document sessions keyed by `filePath || title`, stored in `docSessions` Map (backend, persisted to `engine/doc-sessions.json`) and `_qaSessions` Map (frontend, persisted to localStorage). Session loads when modal opens, saves after each response.

**Document editing:** When the LLM edits a document, it returns `---DOCUMENT---` followed by the complete updated file. The backend writes it to disk. The frontend updates the modal body.

**Important:** `parseCCActions` runs on the answer portion BEFORE `---DOCUMENT---`, not on the document content. This prevents documents containing literal `===ACTIONS===` from being mangled.

### Shared Infrastructure

Both CC and doc-chat use:
- `ccCall()` — retry logic (resume → fresh → retry after 2s), session management, preamble injection
- `llm.callLLM({ direct: true })` — bypasses spawn-agent.js, spawns the runtime CLI directly via the adapter's cached binary path
- `trackEngineUsage()` — records calls, tokens, cost, duration per category (`command-center`, `doc-chat`)
- Configurable runtime/model/effort via `engine.ccCli` / `engine.ccModel` / `engine.ccEffort` (resolved via `resolveCcCli` / `resolveCcModel` — see **Runtime Adapters** below)

## Runtime Adapters

The CLI runtime is pluggable. Each adapter lives in `engine/runtimes/<name>.js`,
is registered in `engine/runtimes/index.js`, and exposes a fixed contract that
the engine, dashboard, preflight, and doctor all consume through the same
five entry points: `resolveBinary`, `buildArgs`, `buildPrompt`, `parseOutput`,
`parseStreamChunk`. Adding a new runtime is a single-file change — `engine.js`
and `engine/spawn-agent.js` know nothing CLI-specific.

**Bundled adapters:** Claude (`engine/runtimes/claude.js`) and GitHub Copilot
(`engine/runtimes/copilot.js`).

### Adapter Contract

Every adapter exports the following fields. Required methods are *necessary*;
required fields are *configuration data the engine reads at dispatch / preflight
time*.

| Field | Kind | Role |
|-------|------|------|
| `name` | string | Registry key — must match the file name |
| `capabilities` | object | Feature flags consumed by engine code (table below) |
| `resolveBinary({ env, config })` | function → `{ bin, native, leadingArgs } \| null` | Locate the runtime CLI binary. `leadingArgs` is `[]` for standalone binaries, `['copilot']` for `gh copilot` extensions |
| `capsFile` | string (path) | Cached binary-resolution path (`engine/<name>-caps.json`) |
| `installHint` | string | Human-readable install instructions surfaced when `resolveBinary()` returns null |
| `listModels()` | async function → `{id,name,provider}[] \| null` | Returns null when the runtime has no enumeration mechanism (Claude) |
| `modelsCache` | string (path) | Per-runtime model catalog cache (`engine/<name>-models.json`) |
| `spawnScript` | string (path) | Wrapper script (always `engine/spawn-agent.js` today; reserved for future runtimes that need a different wrapper) |
| `buildArgs(opts)` | function → `string[]` | CLI args excluding the binary; receives the resolved opts bag |
| `buildPrompt(promptText, sysPromptText)` | function → string | Final prompt delivered. Claude returns the user prompt verbatim (sysprompt goes via `--system-prompt-file`); Copilot inlines `<system>...</system>` into the user prompt |
| `resolveModel(input)` | function → string \| undefined | Shorthand expansion / passthrough. Returns `undefined` for nullish input |
| `parseOutput(raw, { maxTextLength })` | function → `{ text, usage, sessionId, model }` | Full stream parse — used by `lifecycle.parseAgentOutput` |
| `parseStreamChunk(line)` | function → object \| null | Single-line streaming parse |
| `parseError(rawOutput)` | function → `{ message, code, retriable }` | Normalize CLI error patterns onto stable `code` values: `auth-failure`, `context-limit`, `budget-exceeded`, `crash`, or `null` |

### Capability Flags

Capability flags are the **only** legal conditional gate in engine code —
`runtime.name === 'claude'` (or any other name) branches are banned by the
test suite (see `test/unit.test.js` "engine.js source contains zero
`runtime.name ===` (or ==) branches"). Adding a new feature means adding a
capability flag, not a name check.

| Flag | Claude | Copilot | What it gates |
|------|--------|---------|---------------|
| `streaming` | true | true | JSONL events on stdout |
| `sessionResume` | true | true | `--resume <id>` resumes a prior session |
| `systemPromptFile` | true | false | sysprompt accepted via `--system-prompt-file` (vs inlined into the user prompt) |
| `effortLevels` | true | true | `--effort low\|medium\|high\|xhigh` is honored |
| `costTracking` | true | false | Result event includes USD + token usage (Copilot only emits `premiumRequests` count) |
| `modelShorthands` | true | false | Bare `sonnet` / `opus` / `haiku` are accepted (Copilot expects full model IDs like `claude-sonnet-4.5`) |
| `modelDiscovery` | false | true | `listModels()` returns a real catalog (Claude has no public model API) |
| `promptViaArg` | false | false | When `true`, the adapter injects `--prompt <text>` instead of piping via stdin |
| `budgetCap` | true | false | `--max-budget-usd <n>` is supported |
| `bareMode` | true | false | `--bare` (suppresses CLAUDE.md auto-discovery) is supported |
| `fallbackModel` | true | false | `--fallback-model <id>` on rate-limit / overload |
| `sessionPersistenceControl` | true | false | The engine writes `session.json` (Copilot manages session state in `~/.copilot/session-state/`) |

Source: `engine/runtimes/claude.js:357-389`, `engine/runtimes/copilot.js:509-534`.

### Six Resolution Helpers (in `engine/shared.js`)

The engine never reads `agent.cli` / `engine.defaultCli` / etc. directly. All
resolution flows through these six helpers — they are the single source of
truth for "which CLI runtime + model + budget + bare-mode applies to this
spawn?" (source: `engine/shared.js:797-948`).

| Helper | Priority chain |
|--------|----------------|
| `resolveAgentCli(agent, engine)` | `agent.cli` → `engine.defaultCli` → `'claude'` |
| `resolveCcCli(engine)` | `engine.ccCli` → `engine.defaultCli` → `'claude'` |
| `resolveAgentModel(agent, engine)` | `agent.model` → `engine.defaultModel` → `undefined` (let the runtime pick) |
| `resolveCcModel(engine)` | `engine.ccModel` → `engine.defaultModel` → `undefined` |
| `resolveAgentMaxBudget(agent, engine)` | `agent.maxBudgetUsd` → `engine.maxBudgetUsd` → `undefined`. Honors literal `0` |
| `resolveAgentBareMode(agent, engine)` | `agent.bareMode` → `engine.claudeBareMode` → `false`. Strict null check so per-agent `false` overrides engine `true` |

**Independence rule (CRITICAL):** the agent path (`resolveAgent*`) and the
CC path (`resolveCc*`) **do not fall through to each other**. A user setting
`engine.ccCli: copilot` for CC alone must NOT silently switch agents to
Copilot too. Both paths fall through to `engine.defaultCli` (the
fleet-wide knob), but they do not see each other's overrides. Tests
"resolveAgentCli: does NOT fall through to engine.ccCli" and "resolveCcCli:
does NOT inspect any agent settings" enforce this.

### Three-Tier Model Resolution

Every spawn resolves the model via the chain
**per-agent → `engine.defaultModel` → CLI default**. CC adds one extra
override slot (`engine.ccModel`) that takes precedence over `defaultModel`.
Worked example:

```jsonc
// config.json
{
  "engine": { "defaultCli": "copilot", "defaultModel": "claude-sonnet-4.5", "ccModel": "gpt-5.4" },
  "agents": {
    "dallas":  { "model": "gpt-5.4" },                           // pin per-agent
    "ripley":  { /* no model field */ },                         // inherits defaultModel
    "rebecca": { "cli": "claude", "model": "claude-opus-4-1" }   // overrides BOTH cli + model
  }
}
```

Resolution at dispatch time:
- `dallas` → Copilot (defaultCli) running `gpt-5.4` (per-agent)
- `ripley` → Copilot running `claude-sonnet-4.5` (defaultModel)
- `rebecca` → Claude (per-agent override) running `claude-opus-4-1` (per-agent)
- CC (Command Center) → Copilot (`ccCli` falls through to `defaultCli`) running `gpt-5.4` (`ccModel` override beats `defaultModel`)

When `resolveAgentModel` returns `undefined` (no model set anywhere), the
adapter omits `--model` from `buildArgs` and the underlying CLI uses
whatever model the user has globally configured.

### Fleet Config Fields

Every new field added by the runtime fleet refactor (P-3b8e5f1d), with its
default and per-agent override path. Documented defaults: see
`engine/shared.js:739-790` for the authoritative source.

| Field | Default | Per-agent override | Purpose |
|-------|---------|-------------------|---------|
| `engine.defaultCli` | `'claude'` | `agent.cli` | Fleet runtime — must be a key registered in `engine/runtimes/index.js` |
| `engine.defaultModel` | `undefined` | `agent.model` | Fleet model — `undefined` lets the runtime pick its own default |
| `engine.ccCli` | `undefined` | — (no fall-through) | CC runtime override; inherits `defaultCli` when unset |
| `engine.ccModel` | `undefined` | — (no fall-through) | CC model override; inherits `defaultModel` when unset |
| `engine.claudeBareMode` | `false` | `agent.bareMode` | Claude `--bare` (see "Claude Bare Mode" below) |
| `engine.claudeFallbackModel` | `undefined` | — | Claude `--fallback-model` on rate-limit / overload |
| `engine.copilotDisableBuiltinMcps` | `true` | — | Copilot `--disable-builtin-mcps` (see "Split-Brain Risk" below) |
| `engine.copilotSuppressAgentsMd` | `true` | — | Copilot `--no-custom-instructions` (suppress AGENTS.md) |
| `engine.copilotStreamMode` | `'on'` | — | Copilot `--stream <on\|off>` |
| `engine.copilotReasoningSummaries` | `false` | — | Copilot `--enable-reasoning-summaries` (Anthropic-family models only) |
| `engine.maxBudgetUsd` | `undefined` | `agent.maxBudgetUsd` | Fleet `--max-budget-usd` ceiling. Honors literal `0` (read-only / dry-run agents) |
| `engine.disableModelDiscovery` | `false` | — | Skip `runtime.listModels()` REST calls fleet-wide |

### Migration Paths

- **`config.claude.*` deprecation** — fields like `config.claude.binary`,
  `config.claude.outputFormat`, `config.claude.allowedTools`,
  `config.claude.permissionMode` are deprecated in favor of the runtime
  adapter system. `engine/preflight.js` surfaces a `deprecated-config-claude`
  warning when any such field is present (see `_deprecatedConfigClaudeFields`
  in `engine/shared.js:782`). The fields still work for backward compat;
  they will be removed when the deprecation tracker (`docs/deprecated.json`)
  cleanup window expires.
- **Legacy `ccModel`-only configs** — pre-P-3b8e5f1d installs set
  `engine.ccModel` as the de-facto fleet model. Engine startup runs
  `applyLegacyCcModelMigration(config)` which copies `ccModel` →
  `defaultModel` **in memory only** (no disk write) and logs a one-time
  deprecation notice ("ccModel is now a CC-specific override; set
  defaultModel to apply fleet-wide"). On-disk config is untouched so a
  user can audit the change before saving. Source:
  `engine/shared.js:957-987`.

### Switching the Fleet from the CLI

```bash
minions start --cli copilot --model claude-sonnet-4.5    # switch fleet to Copilot
minions restart --cli claude --model ''                  # switch back; --model '' clears the override
minions config set-cli copilot --model gpt-5.4           # write config without restarting the engine
```

`--model ''` (empty string) **deletes** `engine.defaultModel` from
`config.json` so the runtime falls back to its own default — DO NOT pin
it to an empty string, that emits `--model ""` and crashes the CLI.
Source: `engine/cli.js` (P-6b3f9c2e).

### Model Discovery

| Runtime | Mechanism |
|---------|-----------|
| Claude | `capabilities.modelDiscovery: false` — no public enumeration. Settings UI renders a free-text input. `listModels()` returns `null` |
| Copilot | `GET https://api.githubcopilot.com/models` with `Authorization: Bearer ${GH_TOKEN \|\| COPILOT_GITHUB_TOKEN}`. Cache lives at `engine/copilot-models.json` (1h TTL); refresh via `POST /api/runtimes/copilot/models/refresh` |
| Any | `engine.disableModelDiscovery: true` opts out fleet-wide; `getRuntimeModels()` short-circuits to `{ models: null }` without calling the adapter. Useful for air-gapped installs or when you don't want Minions making outbound HTTPS calls |

### Effort Level Normalization

| Input | Claude | Copilot |
|-------|--------|---------|
| `'low'` / `'medium'` / `'high'` | passes verbatim | passes verbatim |
| `'xhigh'` | passes verbatim | passes verbatim |
| `'max'` | passes verbatim (Claude accepts it) | mapped to `'xhigh'` (Claude-ism normalized to Copilot's vocab — see `engine/runtimes/copilot.js:_mapEffort`) |

The Copilot adapter logs a one-time warning when it sees a Claude family
shorthand (`sonnet` / `opus` / `haiku`) in `resolveModel` — Copilot expects
full model IDs like `claude-sonnet-4.5`, so silently passing the shorthand
through would let it fail at the CLI level with no explanation. Source:
`engine/runtimes/copilot.js:154-172`.

### Copilot `--disable-builtin-mcps` and the Split-Brain Risk

Copilot ships with a built-in `github-mcp-server` MCP that lets the agent
autonomously create PRs, labels, and comments via the GitHub API. Set
`engine.copilotDisableBuiltinMcps: true` (the default) to keep this MCP
out of the agent's tool list. The dashboard tooltip on the corresponding
toggle warns about the consequences when it's set to `false`:

> When OFF, Copilot agents can autonomously create PRs/labels/comments via
> the github-mcp-server, bypassing Minions' `pull-requests.json` tracking —
> Minions and Copilot end up with split views of the same PR. Keep ON
> unless you understand the risk.

Same risk class — different surface — applies to ANY MCP that mutates state
the engine also tracks (work items, files, PRs). The default is always
"strip the MCP" because Minions' tracking files (`pull-requests.json`,
`work-items.json`, `dispatch.json`) are the source of truth.

### Copilot `--no-custom-instructions` (AGENTS.md Suppression)

When `engine.copilotSuppressAgentsMd: true` (the default), spawn-agent
emits `--no-custom-instructions` to Copilot. Without this flag, Copilot
auto-loads any `AGENTS.md` file in the worktree and merges those
instructions into its system prompt — fighting whatever the Minions
playbook told the agent to do. The flag exists for the same reason Claude
has `--bare`: keep the runtime CLI from layering its own context on top
of the playbook system prompt. Source: `engine/runtimes/copilot.js`
(P-1d4a8e7c).

### Claude Bare Mode (`--bare`) — Requires Explicit Context

`engine.claudeBareMode: true` adds `--bare` to every Claude spawn, which
**suppresses CLAUDE.md auto-discovery in the agent's CWD**. This is
useful for runtimes-vs-runtimes parity (Copilot has no equivalent
auto-loaded context — bare-mode Claude is the closest equivalent), but
it has a hard limitation: agents lose the project conventions baked into
CLAUDE.md unless an explicit system prompt feeds those rules in. Pair
`claudeBareMode: true` with an explicit `engine.ccSystemPrompt` (CC) or
override the playbook to embed the conventions inline. Preflight emits a
`bare-mode-misconfig` warning when `claudeBareMode: true` is paired with
Claude as the CC runtime AND no `ccSystemPrompt` is configured. Source:
`engine/shared.js:1004-1064` (`runtimeConfigWarnings`).

### Windows WinGet Path for Copilot

WinGet installs Copilot's CLI shim at:

```
%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe
```

`engine/runtimes/copilot.js resolveBinary` probes PATH (which WinGet adds
the Links directory to), so installs via `winget install --id GitHub.cli &&
gh extension install github/gh-copilot` work without further configuration.
The standalone Copilot binary is the preferred path; the `gh copilot`
extension fallback returns `leadingArgs: ['copilot']` so spawn-agent
correctly invokes `gh copilot ...`. Source:
`engine/runtimes/copilot.js:113-150`, `docs/copilot-cli-schema.md`.

### Adding a New Runtime (Recipe)

1. Create `engine/runtimes/<name>.js`. Implement every field in the
   adapter contract above. Set `installHint` to a one-line install
   command that covers all platforms.
2. Register: `engine/runtimes/index.js` →
   `registry.set('<name>', require('./<name>'))`.
3. The dashboard `/api/runtimes` endpoint, the `--cli` flag, the per-agent
   CLI dropdown, the per-runtime preflight binary check, and the model
   discovery cache all light up automatically — no edits to engine.js,
   spawn-agent.js, dashboard.js, or preflight.js.
4. Capability flags drive the engine's behavior. If your runtime doesn't
   support `--max-budget-usd`, set `capabilities.budgetCap: false` and the
   helper that builds spawn flags will silently drop the opt. Don't
   special-case in engine code — let the registry + capability flags do
   the routing.

## Dashboard API

All endpoints self-documented via `GET /api/routes`. Key endpoints: `GET /api/status`, `POST /api/work-items`, `POST /api/work-items/update`, `POST /api/work-items/feedback`, `POST /api/knowledge`, `GET/POST /api/pinned`, `POST /api/engine/wakeup`, `GET /api/agent/:id/live-stream` (SSE), `POST /api/settings/reset`, `POST /api/issues/create` (file GitHub issues via `gh` CLI).

## Human Contributions

Humans contribute as teammates through the dashboard:
- **Quick Notes**: "+ Note" button writes to inbox, flows through consolidation to notes.md
- **KB Authoring**: "+ New" on Knowledge Base creates entries in any category directly
- **Work Item References**: Attach URLs/links/docs — injected into agent playbooks as `{{references}}`
- **Acceptance Criteria**: Structured checklist per item — injected as `{{acceptance_criteria}}`
- **Pinned Notes**: Critical context in `pinned.md` — prepended to ALL agent prompts with "READ FIRST"
- **Feedback**: thumbs up/down on completed work — written to agent inbox for learning consolidation

## Cross-Platform

The engine runs on Windows, macOS, and Linux. Key patterns:
- **Process kill**: use `shared.killGracefully()` / `shared.killImmediate()` (taskkill on Windows, SIGTERM/SIGKILL on Unix) — never call `proc.kill('SIGTERM')` directly
- **Home directory**: use `os.homedir()` — never `process.env.HOME || process.env.USERPROFILE`
- **Worktree paths**: normalize to forward slashes with `.replace(/\\/g, '/')` before interpolating into shell commands
- **Line endings**: `.gitattributes` enforces LF; PowerShell scripts use CRLF

## Graceful Shutdown

SIGTERM/SIGINT → engine enters `stopping` state, waits up to `shutdownTimeout` for active agents, then exits. Agents continue independently and re-attach on next start.

## Task Decomposition

`implement:large` items are auto-routed to a `decompose` agent (controlled by `engine.autoDecompose`). The agent breaks the item into 2-5 sub-tasks output as JSON. The engine creates child work items with `parent_id` and `depends_on` chains. Parent status becomes `decomposed`.

## Temporary Agents

When `engine.allowTempAgents: true` and all permanent agents are busy, the engine spawns ephemeral `temp-{uid}` agents. They use a minimal system prompt, count toward `maxConcurrent`, and are auto-cleaned up after completion.

## Scheduled Tasks

`config.schedules[]` defines cron-style recurring work. Format: `{ id, cron, type, title, project?, agent?, enabled }`. Cron is 3-field: `minute hour dayOfWeek`. Last-run times tracked in `engine/schedule-runs.json`.

## Pipelines

`pipelines/*.json` defines multi-stage pipelines with dependencies. Stages can be tasks, meetings, or plans. Pipeline runs tracked in `engine/pipeline-runs.json`. Trigger via cron or manual.

## Pending Dispatch Explanation

Work items show `_pendingReason` (dependency_unmet, cooldown, no_agent, already_dispatched, budget_exceeded). Dispatch pending items show `skipReason` (max_concurrency, agent_busy). Both visible in dashboard.

## Build Failure Notifications

When a PR's build fails, the engine writes an inbox alert to the author agent with the failure reason. Deduplicated via `_buildFailNotified` flag, cleared when build status recovers.

## Watches

Watches are persistent monitoring jobs that survive engine restarts. They poll PRs or work items on a schedule and fire inbox notifications when a condition is met (or on every poll while unmet, if configured).

State stored in `engine/watches.json` — mutated via `mutateJsonFileLocked` in `engine/watches.js`. Checked every 3 ticks (~3 minutes) from the engine tick cycle.

### Key Fields

| Field | Description |
|-------|-------------|
| `target` | PR number, PR ID, or work item ID to monitor |
| `targetType` | `'pr'` or `'work-item'` (`WATCH_TARGET_TYPE`) |
| `condition` | What to watch for (see below) |
| `interval` | Min milliseconds between checks (default: 300000 / 5 min) |
| `stopAfter` | `0` = run forever; `N` = expire after N triggers |
| `owner` | Agent or user who receives inbox notifications |
| `onNotMet` | `null` (silent until triggered) or `'notify'` (inbox alert each poll while condition is not yet met) |
| `status` | `active`, `paused`, `triggered`, `expired` |

### Conditions (`WATCH_CONDITION`)

- `merged`, `build-fail`, `build-pass`, `completed`, `failed` — **absolute conditions**: auto-expire on first trigger when `stopAfter=0` (fire-once semantics)
- `status-change`, `any`, `new-comments`, `vote-change` — **change-based conditions**: run forever when `stopAfter=0`; compare against `_lastState` captured on the previous check

`WATCH_ABSOLUTE_CONDITIONS` is the set of absolute conditions. Change-based conditions require a baseline state from the prior check — on first check the baseline is captured and no notification is fired.

### Lifecycle

CC Actions `create-watch` / `delete-watch` / `pause-watch` / `resume-watch` manage watches. The engine evaluates all `active` watches that are past their interval, fires notifications to the owner's inbox via `writeToInbox`, and marks absolute-condition watches `expired` after their first trigger (or when `stopAfter` is reached).

## Testing

- **Unit tests** (`test/unit.test.js`): Custom async runner, 2200+ tests, no external deps. Uses `createTmpDir()` for isolation.
- **Integration tests** (`test/minions-tests.js`): HTTP client hitting dashboard API. Requires dashboard running.
- **E2E tests** (`test/playwright/dashboard.spec.js`): Playwright browser tests against live dashboard.

### Test Runner Conventions

- All unit tests live in `test/unit.test.js` (~3550 `await test()` calls). Single Node process, sequential via top-level `main()`. No per-test timeout — a single hung test halts the suite.
- Module-level state persists across tests (`_adoTokenFailedUntil`, caches, etc.). Test isolation uses the `MINIONS_TEST_DIR` env override + `createTmpDir()`.
- `_setAdoTokenForTest(null)` short-circuits `azureauth` so tests don't spawn the auth subprocess (which has a 15s timeout).
- If tests stop printing `PASS` lines mid-run, the most likely cause is a pending Promise on a child process / lock / fetch. The runner exits silently with code 0 when the event loop goes idle (see Footgun #1 below).

## Known Footguns

These bug classes have appeared more than once. Each cost real debugging time. Don't reintroduce.

### 1. `child.unref()` in async exec — abandons the awaiting Promise

`unref()` removes the child from the event loop's reference count. With it on, **Node will exit while the child is still running**, abandoning any awaiting Promise. The CLI happens to run fine because the parent has other pending work; the test runner exits silently with code 0 the moment its event loop goes idle.

Symptom (the actual bug, fixed in `a40fbad2`): ~1100 unit tests silently skipped, no error, no summary banner — the runner exited at the first `execAsync('azureauth ...')` because azureauth was the only pending child and it was unref'd.

```js
// WRONG — abandons the awaiting promise the moment the parent goes idle
const child = exec(cmd, cb);
child.unref && child.unref();
```

The `timeout` opt on `exec`/`execAsync` already prevents indefinite hangs. Don't unref.

### 2. `safeJson(p) || []` masks parse errors — use `safeJsonArr(p)`

`safeJson` returns `null` for both "missing file" AND "corrupt JSON". The `|| []` fallback hides corruption. `safeJsonArr(p)` / `safeJsonObj(p)` return the typed default while logging on parse failure. Use them.

### 3. `safeWrite` on shared JSON — race condition

PRD JSON, `pull-requests.json`, `work-items.json`, `dispatch.json`, `metrics.json`, `cooldowns.json` are read-modify-written from multiple ticks/handlers. `safeWrite` doesn't lock. Must use `mutateJsonFileLocked()` (or wrappers like `mutateDispatch`, `mutateWorkItems`, `mutatePullRequests`). Tests already enforce this for the dispatch-class files; PRD writes still drift in occasionally.

### 4. `process.kill(pid, 'SIGTERM')` is Windows-broken

On Windows, `process.kill(pid, 'SIGTERM')` doesn't recurse into child processes. Use `shared.killByPidGracefully(pid)` / `killByPidImmediate(pid)` — they shell out to `taskkill /T` on Windows and emit `SIGTERM`/`SIGKILL` elsewhere. Same rule as the existing `shared.killGracefully(proc)` for process handles.

### 5. `syncPrsFromOutput` inbox fallback only fires on empty stdout

When stdout is non-empty, the function MUST NOT also scan `notes/inbox/` for PR URLs. Stale sibling inbox files (e.g., from a prior test run sharing `MINIONS_DIR`) leak phantom PR records into the current call's evidence map. Fixed in `c4c42472` — the inbox scan is gated on `!output || !String(output).trim()`. The inbox path remains the documented fallback for the "stdout was rotated/lost" case.

## CC Action Contract

CC's `===ACTIONS===` JSON block goes through `parseCCActions` → `executeCCActions` in `dashboard.js`. The contract is hardened against silent failure modes — don't soften it without thinking through the regression class.

### Required fields (server returns `{ error }` if missing)

| Action type | Required |
|-------------|----------|
| `dispatch` (and `fix`/`implement`/`explore`/`review`/`test`) | `title`. Plus `project` if multiple projects are configured. |
| `build-and-test` | `pr` (number, ID, or URL) |
| `note` | `title` and `content` (or `description`) |
| `knowledge` | `title`, `content`, `category` (one of: architecture, conventions, project-notes, build-reports, reviews) |
| `pin-to-pinned` | `title`, `content` |

### Strict project resolution

If `action.project` doesn't match any configured project name, the handler returns `{ error: 'Project "X" not found. Known: [...]' }` — **no silent fallback** to `PROJECTS[0]`. Multi-project configs require the field; single-project configs fall through transparently. Zero-project configs allow root-level work items so the orchestrator works standalone.

### Agent hint normalization

Both shapes are accepted: `agent: "lambert"` (string) and `agents: ["lambert"]` (array). Singular is promoted to plural inside the handler. Unknown agent names → error result. A single explicit agent hint hard-pins assignment via `item.preferred_agent` + `item.agents` and bypasses the routing table.

### Pre-flight routing check

After enqueueing a dispatch, the handler asks `routing.resolveAgent` whether any agent is currently available for the workType. If not, the result includes a `warning` field that the client renders inline ("Created W-xxx but no agent is currently available — item will sit pending").

### Delimiter parser tiers

`findCCActionsHeader(text)` returns `{ index, headerLength, parseable }` across three tiers:

1. **Strict (`parseable: true`)**: `===ACTIONS={0,3}` on its own line, well-formed.
2. **Loose (`parseable: false`)**: `===ACTIONS<anything>` — strips the prose but doesn't try to JSON-parse.
3. **Very-loose (`parseable: false`)**: `={2,}\s*ACTIONS\s*={0,}` (case-insensitive) — catches `====ACTIONS===`, `===actions===`, `===ACTIONS=====`.

When `parseable === false`, the client surfaces a banner: "Actions block emitted but JSON could not be parsed — no actions were executed." Silent action-drop is no longer a thing.

Streaming chunks also get a partial-delimiter strip so 1- to 12-character prefixes of `===ACTIONS===` (e.g., a chunk ending in `=` or `==ACT`) never reach the user. Both server and client run the strip; `_ccMergeStreamText` trusts `prev` as already-clean and only restrips `incoming`.

### What was removed: hallucination detector

There used to be a regex-based detector that fired warnings when CC's prose described an action ("dispatched", "queued") without a matching `===ACTIONS===` block. Removed in `01072475` — too many false positives because CC has direct tool access (`Bash`, `Write`, `Edit`, `WebFetch`) and can queue work via direct API calls without ever emitting an action block. Don't reintroduce without solving the false-positive problem first.

## Best Practices for Contributing

1. **No magic strings**: Use `WI_STATUS`, `WORK_TYPE`, `PLAN_STATUS`, `PR_STATUS`, `DISPATCH_RESULT` constants for all status/type comparisons and assignments. Import from `engine/shared.js`.

2. **No magic numbers**: Use `ENGINE_DEFAULTS` for timeouts, retry limits, and thresholds. Add new configurable values there.

3. **Atomic writes**: Use `mutateJsonFileLocked()` for any read-modify-write on shared JSON files. Never `safeJson()` + modify + `safeWrite()` — that's a race condition.

4. **Cross-platform**: Use `shared.killGracefully()`/`killImmediate()` for process termination. Use `os.homedir()`. Normalize paths with `.replace(/\\/g, '/')` in shell commands.

5. **Guard empty arrays**: Always check `projects.length > 0` before accessing `projects[0]`. Check `primaryProject` is truthy before using it.

6. **Per-item error handling**: Wrap each item in discovery/dispatch loops with try-catch so one bad item doesn't crash the tick.

7. **Validate inputs**: `updateWorkItemStatus()` rejects invalid statuses. `syncPrdItemStatus()` rejects invalid PRD statuses. Follow this pattern for new write functions.

8. **Platform-agnostic playbooks**: Never hardcode build commands, languages, or frameworks in playbooks. Agents must read project docs.

9. **Deferred archiving**: Plans are archived only after verify completes (not on plan completion). This ensures E2E PRs and testing guides exist before archiving.

10. **Test before pushing**: Run `npm test` — target 0 failures. Tests use source-code string matching, so when replacing strings with constants, update the corresponding test assertions.

11. **Optimistic UI updates**: All dashboard button actions show success toast BEFORE the API call, then show error toast on failure (overwrites the success). Use `showToast('cmd-toast', msg, true)` for success, `showToast('cmd-toast', msg, false)` for error. Never use `alert()` for post-API errors — use `showToast`. Keep `alert()` only for pre-API validation ("Title required").

12. **Use `insertAdjacentHTML` not `innerHTML +=`**: In dashboard JS, appending to thread/list elements must use `el.insertAdjacentHTML('beforeend', html)` to avoid DOM rebuild and event listener breakage.

13. **CC streaming: strip ===ACTIONS=== server-side**: The `onChunk` callback in the SSE streaming path strips `===ACTIONS===` before sending to the client. Don't add client-side stripping — the server handles it.

## After Every Code Change

Run `/simplify` after completing any code change. This ensures:
- New code reuses existing utilities (`shared.js`, `queries.js`) instead of duplicating
- Functions are generalized and composable, not one-off
- Redundant state, copy-paste patterns, and unnecessary abstractions are caught early
- Code stays consistent with the existing architecture patterns

Before writing new helper functions, search the codebase for existing ones that already do what you need. Common places to check: `engine/shared.js` (utilities, constants), `engine/queries.js` (read-only state), `engine/dispatch.js` (queue management).

## Deprecation Tracker

`docs/deprecated.json` tracks backward-compat shims with dates. Run `/cleanup-deprecated` to remove items older than 3 days.

**When deprecating code**, always add an entry to `docs/deprecated.json` with:
```json
{
  "id": "short-kebab-id",
  "summary": "what it is — one line",
  "deprecated": "YYYY-MM-DD",
  "reason": "why it was deprecated",
  "locations": ["file:line description of each backward-compat shim"],
  "cleanup": "what to do when removing (delete X, replace Y with Z, etc.)"
}
```
This ensures the cleanup skill can find and remove stale shims automatically after 3 days.
