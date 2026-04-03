# Auto-Discovery & Execution Pipeline

How the minions engine finds work and dispatches agents automatically.

## The Tick Loop

The engine runs a tick every 60 seconds (configurable via `config.json` → `engine.tickInterval`). Each tick:

```
tick()
  1. checkTimeouts()            Kill stale/hung agents (>heartbeatTimeout)
  2. consolidateInbox()         Merge learnings into notes.md (Haiku-powered)
  2.5 runCleanup()              Periodic cleanup (every 10 ticks ≈ 10min)
  2.6 pollPrStatus()            Poll ADO for build, review, merge status (every 6 ticks ≈ 6min)
  2.7 pollPrHumanComments()     Poll PR threads for human @minions comments (every 12 ticks ≈ 12min)
  3. discoverWork()             Scan ALL linked projects for new tasks
  4. updateSnapshot()           Write identity/now.md
  5. dispatch                   Spawn agents for pending items (up to maxConcurrent)
```

## Work Discovery

`discoverWork()` iterates every project in `config.projects[]` and runs four core discovery sources: pull requests, per-project work items, central work items, and pipeline/scheduled tasks. Results are prioritized: fixes > reviews > implements > work-items.

Before scanning, the engine materializes plans and specs into project work items (side-effect writes to `work-items.json`), so they're picked up by the work items source below.

### Source 1: Pull Requests (`discoverFromPrs`)

**Reads:** `~/.minions/projects/<project>/pull-requests.json`

| PR State | Action | Dispatch Type |
|----------|--------|---------------|
| Minions review pending/waiting | Queue a code review | `review` |
| Minions review `changes-requested` | Route back to author for fixes | `fix` |
| `buildStatus: "failing"` | Route to any agent for build fix | `fix` |
Skips PRs where `status !== "active"`.

### Source 2: PRD Gap Analysis (via `materializePlansAsWorkItems`)

PRD items flow through `materializePlansAsWorkItems()`, which scans `~/.minions/prd/*.json` for PRD files with `missing`/`planned` items and creates work items in the target project's queue.

**Reads:** `<project>/docs/prd-gaps.json` (or custom path from `workSources.prd.path`)

| Item State | Action | Dispatch Type |
|------------|--------|---------------|
| `status: "missing"` or `"planned"` | Queue implementation | `implement` |
| `estimated_complexity: "large"` | Routes to `implement:large` (prefers Rebecca) | `implement:large` |

### Source 3: Per-Project Work Items (`discoverFromWorkItems`)

**Reads:** `~/.minions/projects/<project>/work-items.json`

| Item State | Action | Dispatch Type |
|------------|--------|---------------|
| `status: "queued"` or `"pending"` | Queue based on item's `type` field | Item's `type` (default: `implement`) |

After dispatching, the engine writes `status: "dispatched"` back to the item. The agent is scoped to the specific project directory.

### Source 4: Central Work Items (`discoverCentralWorkItems`)

**Reads:** `~/.minions/work-items.json` (central, project-agnostic)

These are tasks where the agent decides which project to work in. The engine builds a prompt that includes a list of all linked projects with their paths and repo config. The agent then navigates to the appropriate project directory based on the task.

| Item State | Action | Dispatch Type |
|------------|--------|---------------|
| `status: "queued"` or `"pending"` | Queue based on item's `type` field | Item's `type` (default: `implement`) |

**How it differs from per-project work items:**
- No `cwd` is set — agent starts in the minions directory and navigates itself
- The prompt includes all project paths and **descriptions** so the agent can choose
- No branch/worktree is pre-created — agent handles this
- Useful for cross-project tasks, exploratory work, or when you don't know which repo is relevant

**Project descriptions drive routing.** Each project in `config.json` has a `description` field. The engine injects these into the central work item prompt:

```
### MyProject
- **Path:** C:/Users/you/MyProject
- **Repo:** org/project/MyProject
- **What it is:** Description from config.json...
```

Better descriptions → better agent routing. Describe what each repo contains, what kind of work happens there, and what technologies it uses.

**Cross-repo tasks.** Central work items can span multiple repositories. The agent's prompt instructs it to:
1. Determine all repos affected by the task
2. Work on each sequentially (worktree → commit → push → PR per repo)
3. Note cross-repo dependencies in PR descriptions (e.g., "Requires MyProject PR #456")
4. Use the correct repo config (org, project, repoId) for each repo
5. Document which repos were touched in the learnings file

This means a single work item like "Add telemetry to the document creation pipeline" can result in PRs across multiple repos if the agent determines the change touches shared modules in one repo and the frontend in another.

**Adding central work items:**
- Dashboard Command Center → type your intent (no `#project` = central queue)
- CLI: `node engine.js work "task title"` (defaults to central queue)
- Direct edit: `~/.minions/work-items.json`

### Materialization: Specs and Plans → Work Items

Before the 3 core sources run, the engine materializes indirect sources into work items:

**Specs** (`materializeSpecsAsWorkItems`): When a PR merges that added/modified `.md` files under `docs/` (configurable via `workSources.specs.filePatterns`), the engine reads each doc and checks for `type: spec` in its frontmatter. Only docs with this marker are treated as actionable specs — regular documentation is ignored. For matching docs, it extracts title/summary/priority and creates implementation work items with `createdBy: 'engine:spec-discovery'`. State tracked in `.minions/spec-tracker.json` to avoid re-processing merged PRs.

Example spec frontmatter:
```markdown
---
type: spec
title: Add user authentication
priority: high
---
# Add user authentication
...
```

**Plans** (`materializePlansAsWorkItems`): Scans `~/.minions/prd/*.json` for PRD files with `missing`/`planned` items. Creates work items in the target project's queue with `createdBy: 'engine:plan-discovery'`. Work item ID = PRD item ID (e.g. `P-43e5ac28`). Deduped by `id`.

Both write to `work-items.json` and are picked up by Source 3 on the same or next tick.

## ADO PR Status Polling (`pollPrStatus`)

**Runs:** Every 6 ticks (≈ 6 minutes), independently of work discovery. Replaces the retired agent-based `pr-sync`.

The engine directly polls the Azure DevOps REST API for **all** PR metadata: build/CI status, human review votes, and completion state. Two API calls per PR — no agent dispatch needed.

**Per PR:**
1. `GET pullrequests/{id}` → `status` (active/completed/abandoned), `mergeStatus`, `reviewers[].vote`
2. `GET pullrequests/{id}/statuses` → CI pipeline results

**Fields updated in `pull-requests.json`:**

| Field | Source | Values |
|-------|--------|--------|
| `status` | PR details | `active` / `merged` / `abandoned` |
| `reviewStatus` | `reviewers[].vote` | `approved` (vote ≥ 5) / `changes-requested` (-10) / `waiting` (-5) / `pending` (0) |
| `buildStatus` | PR statuses (codecoverage/deploy/build/ci contexts) | `passing` / `failing` / `running` / `none` |
| `buildFailReason` | Failed status description | Set on failure, cleared otherwise |

**Auth:** Bearer token via `azureauth ado token --output token` (cached 30 minutes).

This feeds `discoverFromPrs` — when `buildStatus` flips to `"failing"`, the next discovery tick dispatches a fix agent. When `status` becomes `"merged"`, the PR drops out of active polling.

## Discovery Gates

Every discovered item passes through three gates before being queued:

```
Item found
  │
  ├─ isAlreadyDispatched(key)?  → skip if already in pending or active queue
  │    Key format: <source>-<projectName>-<itemId>
  │    e.g., "prd-MyProject-M001", "review-MyRepo-PR-123"
  │
  ├─ isOnCooldown(key)?         → skip if dispatched within cooldown window
  │    Default: 30min for PRD/PRs, 0 for work-items
  │    Cooldowns are in-memory (reset on engine restart)
  │
  └─ resolveAgent(workType)?    → skip if no idle agent available
       Checks routing.md: preferred → fallback → any idle agent
```

## Agent Routing

`resolveAgent()` parses `routing.md` to pick the right agent:

```
routing.md table:
  implement       → dallas  (fallback: ralph)
  implement:large → rebecca (fallback: dallas)
  review          → ripley  (fallback: lambert)
  fix             → _author_ (fallback: dallas)   ← routes to PR author
  analyze         → lambert (fallback: rebecca)
  explore         → ripley  (fallback: rebecca)
  test            → dallas  (fallback: ralph)
```

Resolution order:
1. Check if **preferred** agent is idle → use it
2. Check if **fallback** agent is idle → use it
3. Check **any** agent that's idle → use it
4. If all busy → return null, item stays undiscovered until next tick

## Dispatch Queue

Discovered items land in `engine/dispatch.json`:

```json
{
  "pending": [ ... ],    // Waiting to be spawned
  "active": [ ... ],     // Currently running
  "completed": [ ... ]   // Finished (last 100 kept)
}
```

Each tick, the engine checks available slots:

```
slotsAvailable = maxConcurrent (5) - activeCount
```

It takes up to `slotsAvailable` items from pending and spawns them. Items are processed in discovery-priority order (fixes first, then reviews, then implements, then work-items).

## Execution: spawnAgent()

When an item is dispatched:

### 1. Resolve Project Context
```
meta.project.localPath → rootDir (the repo on disk)
```

### 2. Create Git Worktree (if task has a branch)
```
git worktree add <rootDir>/../worktrees/<branch> -b <branch> <mainBranch>
```
- Branch names are sanitized (alphanumeric, dots, hyphens, slashes only, max 200 chars)
- If worktree fails for implement/fix → item marked as error, moved to completed
- If worktree fails for review/analyze → falls back to rootDir (read-only tasks)

### 3. Render Playbook
```
playbooks/<type>.md  →  substitute {{variables}}  →  append notes.md  →  append learnings requirement
```

Variables injected from config and item metadata:
- `{{project_name}}`, `{{ado_org}}`, `{{ado_project}}`, `{{repo_name}}` — from project config
- `{{agent_name}}`, `{{agent_id}}`, `{{agent_role}}` — from agent roster
- `{{item_id}}`, `{{item_name}}`, `{{branch_name}}`, `{{repo_id}}` — from work item
- `{{team_root}}` — path to central `.minions/` directory

### 4. Build System Prompt
Combines:
- Agent identity (name, role, skills)
- Agent charter (`agents/<name>/charter.md`)
- Project context (repo name, repo host config, main branch)
- Critical rules (worktrees, MCP tools, PowerShell, learnings)
- Full `notes.md` content

### 5. Spawn Claude CLI
```bash
claude -p <prompt-file> --system-prompt <sysprompt-file> \
  --output-format json --max-turns 100 --verbose \
  --allowedTools Edit,Write,Read,Bash,Glob,Grep,Agent,WebFetch,WebSearch
```

- Process runs in the worktree directory (or rootDir for reviews)
- stdout/stderr captured (capped at 1MB each)
- CLAUDECODE env vars stripped to allow nested sessions

### 6. Track State
- Agent status derived from dispatch queue (`engine/dispatch.json`)
- Dispatch item → moved from `pending` to `active` in `dispatch.json`
- Process tracked in `activeProcesses` Map for timeout monitoring

## Post-Completion

When the claude process exits:

```
proc.on('close')
  │
  ├─ Save output to agents/<name>/output.log
  │
  ├─ Dispatch completion determines visible agent status ("done"/"error")
  │
  ├─ Move dispatch item: active → completed
  │
  ├─ Sync PRs from output (scan for PR URLs → pull-requests.json)
  │
  ├─ Post-completion hooks:
  │    review     → update PR minionsReview in pull-requests.json, vote on ADO
  │    fix        → set PR minionsReview back to "waiting"
  │    build-test → (agent auto-files fix work items on failure)
  │
  ├─ Check for learnings in notes/inbox/
  │    (warns if agent didn't write findings)
  │
  ├─ Update agent history and metrics
  │
  └─ Clean up temp prompt files from engine/
```

## Command Center (Dashboard Input)

The dashboard exposes a unified input box at `http://localhost:7331` that parses natural-language intent into structured work items, decisions, or PRD items.

**Syntax:**
| Token | Effect |
|-------|--------|
| `@agent` | Assigns to a specific agent (sets `item.agent`) |
| `@everyone` | Fan-out to all agents (sets `scope: 'fan-out'`) |
| `!high` / `!low` | Sets priority (default: medium) |
| `/decide` | Creates a decision (appended to `notes.md`) |
| `/prd` | Creates a PRD item (appended to `prd-gaps.json`) |
| `#project` | Targets a specific project queue |

Work type is auto-detected from keywords (fix, explore, test, review → implement as fallback). The `@agent` assignment flows through to the engine: `item.agent || resolveAgent(workType, config)`.

## Data Flow Diagram

```
                     Dashboard Command Center
                     (unified intent input)
                              │
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
             work-items   decisions   prd-gaps
             .json        .md         .json

Per-project sources:              Central engine:              Agents:

work-items.json ──┐
prd-gaps.json ────┤
pull-requests.json┤  discoverWork()   dispatch.json
docs/**/*.md (specs)┤  (each tick)      ┌──────────┐
                  │       │           │ pending   │
~/.minions/         │       │           │ active    │
  work-items.json ┤       │           │ completed │
  plans/*.md ─────┘       ▼           └─────┬────┘
                     addToDispatch()─────────┘
                                            │
ADO REST API ─── pollPrBuildStatus() ──► pull-requests.json
(every 6min)      (buildStatus field)       │
                                       spawnAgent()
                                            │
                               ┌────────────┼────────────┐
                               ▼            ▼            ▼
                          worktree     claude CLI    dispatch.json
                          (in project   (max 100      (active/completed)
                           repo dir)     turns)
                                            │
                                        on exit:
                                            │
                        ┌───────────┬───────┼───────┬──────────┐
                        ▼           ▼       ▼       ▼          ▼
                   output.log  notes/  PRs    work-items  localhost
                   (per agent) inbox/*.md  .json  .json       (if webapp,
                                    │             (auto-filed  from build
                          consolidateInbox()       on failure)  & test)
                          (at 5+ files)
                                    │
                                    ▼
                              notes.md
                              (injected into
                               all future
                               playbooks)
```

## Timeout & Stale Detection

Two layers of protection:

**Agent timeout** (`engine.agentTimeout`, default 5 hours / 18,000,000ms):
- Checks `activeProcesses` Map for elapsed time
- Sends SIGTERM, then SIGKILL after 5s

**Stale detection** (`engine.heartbeatTimeout`, default 5 min / 300,000ms):
- Scans `dispatch.active` for items where `started_at` exceeds threshold
- Catches cases where the process exited but dispatch wasn't cleaned up
- Kills process if still tracked, marks dispatch as error, resets agent to idle

## Cooldown Behavior

| Source | Default Cooldown | Behavior |
|--------|-----------------|----------|
| PRD items | 30 minutes | After dispatching M001, won't re-discover it for 30min |
| Pull requests | 30 minutes | After dispatching a review, won't re-queue for 30min |
| Work items | 0 (immediate) | No cooldown, but item status changes to "dispatched" |

Cooldowns are persisted to `engine/cooldowns.json` and reloaded on engine startup. Entries older than 24 hours are pruned. `isAlreadyDispatched()` still provides an additional guard by checking pending/active and recently completed dispatches in `dispatch.json`.

## Configuration Reference

All discovery behavior is controlled via `config.json`:

```json
{
  "engine": {
    "tickInterval": 60000,       // ms between ticks
    "maxConcurrent": 5,          // max agents running at once
    "agentTimeout": 18000000,     // 5 hours — kill hung processes
    "heartbeatTimeout": 300000,  // 5min — kill stale/silent agents
    "maxTurns": 100,             // max claude CLI turns per agent
    "worktreeCreateTimeout": 300000, // timeout for git worktree add on large repos
    "worktreeCreateRetries": 1   // retry count for transient add failures
  },
  "projects": [
    {
      "name": "MyProject",
      "localPath": "C:/Users/you/MyProject",
      "workSources": {
        "prd": {
          "enabled": true,
          "path": "docs/prd-gaps.json",
          "itemFilter": { "status": ["missing", "planned"] },
          "cooldownMinutes": 30
        },
        "pullRequests": {
          "enabled": true,
          "path": "projects/<name>/pull-requests.json",
          "cooldownMinutes": 30
        },
        "workItems": {
          "enabled": true,
          "path": "projects/<name>/work-items.json",
          "cooldownMinutes": 0
        }
      }
    }
  ]
}
```

To disable a work source for a project, set `"enabled": false`. To change where the engine looks for PRD or PR files, change the `path` field (resolved relative to `localPath`).

