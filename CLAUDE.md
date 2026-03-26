# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Minions

Minions is a multi-agent orchestration engine that dispatches Claude Code instances as autonomous agents to implement features, review PRs, fix bugs, and manage plans across multiple repositories. It runs as two Node.js processes: an **engine** (tick-based orchestrator) and a **dashboard** (web UI on port 7331).

## Commands

```bash
# Start
node engine.js          # Start the engine (ticks every 60s)
node dashboard.js       # Start dashboard on :7331

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
| `dashboard.html` | Single-file SPA: plans, PRDs, agents, PRs, knowledge base |
| `engine/shared.js` | Utilities: `safeRead`, `safeWrite`, `safeJson`, file locking, process spawning |
| `engine/queries.js` | Read-only state aggregation: config, dispatch, agents, work items, PRs, PRD info |
| `engine/lifecycle.js` | Post-completion: output parsing, PR sync, plan completion, skill extraction |
| `engine/consolidation.js` | Haiku-powered inbox → notes.md merging, KB classification |
| `engine/ado.js` | Azure DevOps: token cache, PR polling, comment polling, reconciliation |
| `engine/cli.js` | CLI handlers: start, stop, status, spawn, add project |
| `engine/github.js` | GitHub: PR polling, comment polling, reconciliation (parallel to ado.js) |
| `engine/preflight.js` | Prerequisite checks: Node, Git, Claude CLI, API key. Powers `minions doctor` |
| `engine/scheduler.js` | Cron-style scheduled task discovery from `config.schedules` |

### State Files (all runtime, gitignored)

- `engine/dispatch.json` — pending/active/completed queue
- `engine/control.json` — engine state (running/paused/stopped)
- `engine/log.json` — audit trail (500 entries max)
- `engine/metrics.json` — per-agent token usage and quality metrics
- `projects/<name>/work-items.json` — per-project work items
- `projects/<name>/pull-requests.json` — per-project PR tracker
- `plans/*.md` — plan drafts
- `prd/*.json` — PRD files with structured items

### Concurrency-Safe Writes

All writes to shared JSON files use `mutateJsonFileLocked()` or `mutateDispatch()` which acquire file locks. Never write dispatch.json or work-items.json directly — always use the mutation helpers from `shared.js`.

## Work Item Lifecycle

```
pending → dispatched → done | failed
```

Status values: `pending`, `dispatched`, `done`, `failed`, `paused`. Legacy aliases `in-pr`, `implemented`, `complete` are accepted as equivalent to `done` for backward compatibility (see `docs/deprecated.json`).

## Plan → PRD → Work Items Pipeline

1. User creates plan (`.md` in `plans/`) → status `awaiting-approval`
2. Dashboard shows approve/reject/revise buttons
3. On approve → `plan-to-prd` agent converts to PRD JSON with structured items + acceptance criteria
4. PRD items materialized as work items with dependency tracking (`depends_on`)
5. Engine spawns agents per item, merging dependency branches into worktrees before start
6. When all items done → verify task auto-created → builds + tests + manual testing guide

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
    "agentTimeout": 18000000,
    "heartbeatTimeout": 300000,
    "shutdownTimeout": 300000,
    "allowTempAgents": false,
    "autoDecompose": true
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

Templates in `playbooks/` (`implement.md`, `review.md`, `fix.md`, `plan.md`, `plan-to-prd.md`, `verify.md`, `decompose.md`, etc.) with `{{template_variables}}` filled at dispatch time. These define what agents actually do.

## Skills

Markdown files with YAML frontmatter in `.claude/skills/<name>/SKILL.md`. Agents can auto-extract skills from their output using ` ```skill ` fenced blocks — the engine picks these up and writes them to the skills directory.

## ADO Integration

Token via `azureauth ado token --mode iwa --mode broker`. Cached 30 min, 10-min backoff on failure. PR status polled every ~3 min, human comments every ~6 min. PR → PRD item linking tracked in `pr-links.json`.

## Dashboard API

Key endpoints: `GET /api/status`, `GET /api/plans`, `POST /api/command`, `POST /api/doc-chat`, `POST /api/plans/approve`, `POST /api/plans/execute`, `POST /api/work-items/update`, `GET /api/agent/:id/live-stream` (SSE). The dashboard serves `dashboard.html` as a single-file SPA with all JS/CSS inline.

## Graceful Shutdown

SIGTERM/SIGINT → engine enters `stopping` state, waits up to `shutdownTimeout` for active agents, then exits. Agents continue independently and re-attach on next start.

## Task Decomposition

`implement:large` items are auto-routed to a `decompose` agent (controlled by `engine.autoDecompose`). The agent breaks the item into 2-5 sub-tasks output as JSON. The engine creates child work items with `parent_id` and `depends_on` chains. Parent status becomes `decomposed`.

## Temporary Agents

When `engine.allowTempAgents: true` and all permanent agents are busy, the engine spawns ephemeral `temp-{uid}` agents. They use a minimal system prompt, count toward `maxConcurrent`, and are auto-cleaned up after completion.

## Scheduled Tasks

`config.schedules[]` defines cron-style recurring work. Format: `{ id, cron, type, title, project?, agent?, enabled }`. Cron is 3-field: `minute hour dayOfWeek`. Last-run times tracked in `engine/schedule-runs.json`.

## Pending Dispatch Explanation

Work items show `_pendingReason` (dependency_unmet, cooldown, no_agent, already_dispatched). Dispatch pending items show `skipReason` (max_concurrency, agent_busy). Both visible in dashboard.

## Build Failure Notifications

When a PR's build fails, the engine writes an inbox alert to the author agent with the failure reason. Deduplicated via `_buildFailNotified` flag, cleared when build status recovers.

## Testing

- **Unit tests** (`test/unit.test.js`): Custom async runner, 320+ tests, no external deps. Uses `createTmpDir()` for isolation.
- **Integration tests** (`test/minions-tests.js`): HTTP client hitting dashboard API. Requires dashboard running.
- **E2E tests** (`test/playwright/dashboard.spec.js`): Playwright browser tests against live dashboard.

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

