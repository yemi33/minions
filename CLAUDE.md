# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Minions

Minions is a multi-agent orchestration engine that dispatches Claude Code instances as autonomous agents to implement features, review PRs, fix bugs, and manage plans across multiple repositories. It runs as two Node.js processes: an **engine** (tick-based orchestrator) and a **dashboard** (web UI on port 7331).

## Commands

```bash
# Start
minions restart         # Start engine + dashboard
minions start           # Start the engine only
minions dash            # Start dashboard on :7331

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
pollPrStatus (every 6 ticks) → pollPrHumanComments (every 12 ticks) →
discoverWork → updateSnapshot → dispatch agents (up to maxConcurrent)
```

Each phase is independently wrapped in try-catch — a failure in one phase does not abort the tick. Per-item try-catch in discovery loops ensures one bad work item doesn't block all dispatch.

### Agent Spawn Chain

```
engine.js spawnAgent()
  → node engine/spawn-agent.js <prompt> <sysprompt> [args]
    → resolves claude CLI binary path
    → node <claude-cli> -p --system-prompt-file ... (prompt piped via stdin)
```

Agents are **independent processes**. If the engine dies, agents keep running. On restart, the engine re-attaches via PID files and live-output.log mtimes, with a 20-minute grace period before orphan detection.

### Key Modules

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
| `engine/cli.js` | CLI handlers: start, stop, status, spawn, add project |
| `engine/github.js` | GitHub: PR polling, comment polling, reconciliation (parallel to ado.js) |
| `engine/preflight.js` | Prerequisite checks: Node, Git, Claude CLI, API key. Powers `minions doctor` |
| `engine/scheduler.js` | Cron-style scheduled task discovery from `config.schedules` |
| `engine/pipeline.js` | Multi-stage pipeline execution (e.g. daily-arch-improvement) |
| `engine/meeting.js` | Team meetings: investigate → debate → conclude rounds |
| `engine/cooldown.js` | Exponential backoff for failed dispatches |
| `engine/llm.js` | Claude CLI invocation wrapper for consolidation/CC |

### State Files (all runtime, gitignored)

- `engine/dispatch.json` — pending/active/completed queue
- `engine/control.json` — engine state (running/paused/stopped)
- `engine/log.json` — audit trail (2500 entries max, rotated to 2000)
- `engine/metrics.json` — per-agent token usage and quality metrics
- `engine/pipeline-runs.json` — pipeline execution state
- `engine/schedule-runs.json` — last-run times for cron schedules
- `projects/<name>/work-items.json` — per-project work items
- `projects/<name>/pull-requests.json` — per-project PR tracker
- `plans/*.md` — plan drafts
- `prd/*.json` — PRD files with structured items
- `prd/guides/*.md` — verification testing guides

### Concurrency-Safe Writes

All writes to shared JSON files use `mutateJsonFileLocked()` or `mutateDispatch()` which acquire file locks. **Never use `safeWrite()` for files that may be read-modify-written concurrently** (dispatch.json, work-items.json, pull-requests.json, metrics.json). Always use `mutateJsonFileLocked()` for atomic read-modify-write.

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

// PR statuses
const PR_STATUS = { ACTIVE, MERGED, ABANDONED, CLOSED };

// Dispatch results
const DISPATCH_RESULT = { SUCCESS, ERROR, TIMEOUT };
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

## Config Structure (config.json)

```json
{
  "projects": [{
    "name": "MyProject",
    "localPath": "/path/to/repo",
    "repoHost": "ado",
    "repositoryId": "GUID",
    "adoOrg": "org", "adoProject": "project",
    "mainBranch": "main"
  }],
  "agents": {
    "dallas": { "name": "Dallas", "role": "Engineer", "skills": [] }
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
    "evalLoop": true,
    "evalMaxIterations": 3
  },
  "schedules": [{
    "id": "nightly-tests", "cron": "0 2 *", "type": "test",
    "title": "Nightly test suite", "project": "MyProject", "enabled": true
  }]
}
```

## Routing

`routing.md` maps work types to agents: `implement → dallas`, `review → ripley`, `fix → _author_`, `decompose → ripley`, etc. The engine reads this on each tick.

## Playbooks

Templates in `playbooks/` (`implement.md`, `review.md`, `fix.md`, `plan.md`, `plan-to-prd.md`, `verify.md`, `decompose.md`, `meeting-investigate.md`, `meeting-debate.md`, `meeting-conclude.md`, etc.) with `{{template_variables}}` filled at dispatch time. These define what agents actually do.

Playbooks must be **platform-agnostic** — never hardcode build commands, languages, or frameworks. Agents should read project docs (CLAUDE.md, README, package.json, Makefile, etc.) to determine how to build/test/run.

## Skills

Markdown files with YAML frontmatter in `.claude/skills/<name>/SKILL.md`. Agents can auto-extract skills from their output using ` ```skill ` fenced blocks — the engine picks these up and writes them to the skills directory.

## ADO Integration

Token via `azureauth ado token --mode iwa --mode broker`. Cached 30 min, 10-min backoff on failure. PR status polled every ~3 min, human comments every ~6 min. PR → PRD item linking derived from `pull-requests.json` prdItems.

## Dashboard

The dashboard is assembled from fragments in `dashboard/` at startup: `styles.css`, `layout.html`, page HTML fragments in `pages/`, and JS modules in `js/`. Assembled into one HTML string and served as a single-page app. Sidebar navigation with URL routing (`/work`, `/prd`, `/prs`, `/plans`, `/inbox`, `/schedule`, `/engine`).

## Dashboard API

All endpoints self-documented via `GET /api/routes`. Key endpoints: `GET /api/status`, `POST /api/work-items`, `POST /api/work-items/update`, `POST /api/work-items/feedback`, `POST /api/knowledge`, `GET/POST /api/pinned`, `POST /api/engine/wakeup`, `GET /api/agent/:id/live-stream` (SSE), `POST /api/settings/reset`.

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

## Testing

- **Unit tests** (`test/unit.test.js`): Custom async runner, 650+ tests, no external deps. Uses `createTmpDir()` for isolation.
- **Integration tests** (`test/minions-tests.js`): HTTP client hitting dashboard API. Requires dashboard running.
- **E2E tests** (`test/playwright/dashboard.spec.js`): Playwright browser tests against live dashboard.

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
