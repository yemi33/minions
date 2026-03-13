# Squad — Central AI Development Team

A multi-project AI dev team that runs from `~/.squad/`. Five autonomous agents share a single engine, dashboard, knowledge base, and MCP toolchain — working across any number of linked repos with self-improving workflows.

Inspired by and initially scaffolded from [Brady Gaster's Squad](https://bradygaster.github.io/squad/).

## What It Does

- **Auto-discovers work** from PRD gaps, pull requests, and work queues across all linked projects
- **Dispatches AI agents** (Claude CLI) with full project context, git worktrees, and MCP server access
- **Routes intelligently** — fixes first, then reviews, then implementation, matched to agent strengths
- **Learns from itself** — agents write findings, engine consolidates into institutional knowledge
- **Tracks quality** — approval rates, error rates, and task metrics per agent
- **Shares workflows** — agents create reusable skills (Claude Code-compatible) that all other agents can follow
- **Supports cross-repo tasks** — a single work item can span multiple repositories
- **Fan-out dispatch** — broad tasks can be split across all idle agents in parallel, each assigned a project
- **Auto-syncs PRs** — engine scans agent output for PR URLs and updates project trackers automatically
- **Auto-extracts skills** — agents write ` ```skill ` blocks in output; engine auto-extracts them
- **Heartbeat monitoring** — detects dead/hung agents via output file activity, not just timeouts
- **Auto-cleanup** — stale temp files, orphaned worktrees, zombie processes cleaned every 10 minutes

## Quick Start

```powershell
# 1. Initialize the squad (one-time)
node $env:USERPROFILE\.squad\init.js

# 2. Link your projects (interactive — prompts for description, ADO config)
node $env:USERPROFILE\.squad\init.js C:\path\to\repo1
node $env:USERPROFILE\.squad\init.js C:\path\to\repo2

# 3. Run
node $env:USERPROFILE\.squad\engine.js           # Start engine
node $env:USERPROFILE\.squad\dashboard.js         # Dashboard at localhost:7331
node $env:USERPROFILE\.squad\engine.js status     # Check state
```

## CLI Reference

### `init.js` — Project management

| Command | Description |
|---------|-------------|
| `node init.js` | Initialize squad with default agents and config (no projects) |
| `node init.js <dir>` | Link a project (prompts for description, ADO config) |
| `node init.js <dir> --remove` | Unlink a project |
| `node init.js --list` | List all linked projects with descriptions |

### `engine.js` — Engine control

| Command | Description |
|---------|-------------|
| `node engine.js` | Start engine daemon (ticks every 60s, auto-syncs MCP servers) |
| `node engine.js status` | Show agents, projects, dispatch queue, quality metrics |
| `node engine.js pause / resume` | Pause/resume dispatching |
| `node engine.js stop` | Stop the engine |
| `node engine.js queue` | Show dispatch queue |
| `node engine.js sources` | Show work sources per project |
| `node engine.js discover` | Dry-run work discovery |
| `node engine.js dispatch` | Force a dispatch cycle |
| `node engine.js spawn <agent> <prompt>` | Manually spawn an agent |
| `node engine.js work <title> [opts-json]` | Add to central work queue |
| `node engine.js cleanup` | Run cleanup manually (temp files, worktrees, zombies) |
| `node engine.js mcp-sync` | Manually refresh MCP servers from ~/.claude.json |

### `dashboard.js` — Web dashboard

```powershell
node dashboard.js            # Default port 7331
PORT=8080 node dashboard.js  # Custom port
```

## Architecture

```
                    ┌───────────────────────────────┐
                    │      ~/.squad/ (central)       │
                    │                               │
                    │  engine.js        ← tick 60s  │
                    │  dashboard.js     ← :7331     │
                    │  config.json      ← projects  │
                    │  mcp-servers.json ← auto-sync │
                    │  agents/          ← 5 agents  │
                    │  playbooks/       ← templates │
                    │  skills/          ← workflows │
                    │  decisions/       ← knowledge  │
                    └──────┬────────────────────────┘
                           │ discovers work + dispatches agents
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │  Project A   │ │  Project B   │ │  Project C   │
     │  .squad/     │ │  .squad/     │ │  .squad/     │
     │   work-items │ │   work-items │ │   work-items │
     │   pull-reqs  │ │   pull-reqs  │ │   pull-reqs  │
     │  docs/       │ │  docs/       │ │  docs/       │
     │   prd-gaps   │ │   prd-gaps   │ │   prd-gaps   │
     │  .claude/    │ │  .claude/    │ │  .claude/    │
     │   skills/    │ │   skills/    │ │   skills/    │
     └──────────────┘ └──────────────┘ └──────────────┘
```

## Dashboard

The web dashboard at `http://localhost:7331` provides:

- **Projects bar** — all linked projects with descriptions (hover for full text)
- **Command Center** — add work items (per-project, auto-route, or fan-out), decisions, and PRD items
- **Squad Members** — agent cards with status, click for charter/history/output detail panel
  - **Live Output tab** — real-time streaming output for working agents (auto-refreshes every 3s)
- **Work Items** — paginated table with status, source, type, priority, assigned agent, linked PRs, fan-out badges, and retry button for failed items
- **PRD** — gap analysis stats + progress bar with item-level breakdown and linked PRs per item
- **Pull Requests** — paginated PR tracker sorted by date, with review/build/merge status
- **Skills** — agent-created reusable workflows (squad-wide + project-specific), click to view full content
- **Decisions Inbox + Active Decisions** — learnings and team rules
- **Dispatch Queue + Engine Log** — active/pending work and audit trail
- **Agent Metrics** — tasks completed, errors, PRs created/approved/rejected, approval rates

## Multi-Project Config

Each project in `config.json` has:

```json
{
  "name": "MyProject",
  "description": "What this repo is for — agents read this to decide where to work",
  "localPath": "C:/Users/you/MyProject",
  "repositoryId": "ado-guid",
  "adoOrg": "myorg",
  "adoProject": "myproject",
  "repoName": "MyProject",
  "mainBranch": "main",
  "workSources": { ... }
}
```

The `description` field is critical — it tells agents what each repo contains so they can auto-route central work items to the right project.

## Work Items

All work items use the shared `playbooks/work-item.md` template, which provides consistent branch naming, worktree workflow, PR creation steps, and status tracking.

**Per-project** — scoped to one repo. Select a project in the Command Center dropdown.

**Central (auto-route)** — agent gets all project descriptions and decides where to work. Use "Auto (agent decides)" in the dropdown, or `node engine.js work "title"`. Can span multiple repos.

### Fan-Out (Parallel Multi-Agent)

Set Scope to "Fan-out (all agents)" in the Command Center, or add `"scope": "fan-out"` to the work item JSON.

The engine dispatches the task to **all idle agents simultaneously**, assigning each a project (round-robin). Each agent focuses on their assigned project and writes findings to the inbox.

```
"Explore all codebases and write architecture doc"  scope: fan-out
       │
       ├─→ Ripley   → OfficeAgent
       ├─→ Lambert  → office-bohemia
       ├─→ Rebecca  → bebop-desktop
       └─→ Ralph    → OfficeAgent (round-robin wraps)
```

### Failed Work Items

When an agent fails (timeout, crash, error), the engine marks the work item as `failed` with a reason. The dashboard shows a **Retry** button that resets it to `pending` for re-dispatch.

## Auto-Discovery Pipeline

The engine discovers work from 5 sources, in priority order:

| Priority | Source | Dispatch Type |
|----------|--------|---------------|
| 1 | PRs with changes-requested | `fix` |
| 2 | PRs pending review | `review` |
| 3 | PRD items (missing/planned) | `implement` |
| 4 | Per-project work items | item's `type` |
| 5 | Central work items | item's `type` |

Each item passes through: dedup (checks pending, active, AND recently completed), cooldown, and agent availability gates. See `docs/auto-discovery.md` for the full pipeline.

## Agent Execution

### Spawn Chain

```
engine.js
  → spawn node spawn-agent.js <prompt.md> <sysprompt.md> <args...>
    → spawn-agent.js resolves claude-code cli.js path
      → spawn node cli.js -p --system-prompt <content> <args...>
        → prompt piped via stdin (avoids shell metacharacter issues)
```

No bash or shell involved — Node spawns Node directly. Prompts with special characters (parentheses, backticks, etc.) are safe.

### What Each Agent Gets

- **System prompt** — identity, charter, history, project context, critical rules, skill index, team decisions
- **Task prompt** — rendered playbook with `{{variables}}` filled from config
- **Working directory** — project root (agent creates worktrees as needed)
- **MCP servers** — all servers from `~/.claude.json` via `--mcp-config`
- **Full tool access** — all built-in tools plus all MCP tools
- **Permission mode** — `bypassPermissions` (no interactive prompts)
- **Output format** — `stream-json` (real-time streaming for live dashboard + heartbeat)

### Post-Completion

When an agent finishes:
1. Output saved to `agents/<name>/output.log`
2. Agent status updated (done/error)
3. Work item status updated (done/failed)
4. PRs auto-synced from output → project's `pull-requests.json`
5. Agent history updated (last 20 tasks)
6. Quality metrics updated
7. Review feedback created for PR authors (if review task)
8. Learnings checked in `decisions/inbox/`
9. Skills auto-extracted from ` ```skill ` blocks in output
10. Temp files cleaned up

## MCP & Tool Access

On engine start, MCP servers are auto-synced from `~/.claude.json` to `mcp-servers.json`. Agents inherit all MCP servers and skills configured in the user's Claude Code instance. Manually refresh with `node engine.js mcp-sync`.

## Node.js Upgrade Caution

The engine and all spawned agents use the Node binary that started the engine (`process.execPath`). This means:

- **After upgrading Node, restart the engine.** The running engine keeps using the old binary. Agents spawned after an upgrade may fail if the old binary was deleted.
- **All agents inherit the engine's Node version.** There is no per-agent Node resolution — `process.execPath` flows from engine → `spawn-agent.js` → `claude` CLI.
- **No bash intermediary.** Node spawns Node directly to avoid Windows/bash path translation issues. Do not reintroduce a bash wrapper in the spawn chain.

```powershell
# After upgrading Node:
node $env:USERPROFILE\.squad\engine.js stop
node $env:USERPROFILE\.squad\engine.js
```

## Health Monitoring

### Heartbeat Check (every tick)

Uses `live-output.log` file modification time as a heartbeat:
- **Process alive + recent output** → healthy, keep running
- **Process alive + silent >5min** → hung, kill and mark failed
- **No process + silent >5min** → orphaned (engine restarted), mark failed

Agents can run for hours as long as they're producing output. The `heartbeatTimeout` (default 5min) only triggers on silence.

### Automated Cleanup (every 10 ticks)

| What | Condition |
|------|-----------|
| Temp prompt/sysprompt files | >1 hour old |
| `live-output.log` for idle agents | >1 hour old |
| Git worktrees for merged/abandoned PRs | PR status is `merged`/`abandoned`/`completed` |
| Orphaned worktrees | >24 hours old, no active dispatch references them |
| Zombie processes | In memory but no matching dispatch |

Manual cleanup: `node engine.js cleanup`

## Self-Improvement Loop

Five mechanisms that make the squad get better over time:

### 1. Learnings Inbox → decisions.md
Agents write findings to `decisions/inbox/`. Engine consolidates at 5+ files into `decisions.md` — categorized (reviews, feedback, learnings, other) with one-line summaries. Auto-prunes at 50KB. Injected into every future playbook.

### 2. Per-Agent History
`agents/{name}/history.md` tracks last 20 tasks with timestamps, results, projects, and branches. Injected into the agent's system prompt so it remembers past work.

### 3. Review Feedback Loop
When a reviewer flags issues, the engine creates `feedback-<author>-from-<reviewer>.md` in the inbox. The PR author sees the feedback in their next task.

### 4. Quality Metrics
`engine/metrics.json` tracks per agent: tasks completed, errors, PRs created/approved/rejected, reviews done. Visible in CLI (`status`) and dashboard with color-coded approval rates.

### 5. Skills
Agents save repeatable workflows to `skills/<name>.md` with Claude Code-compatible frontmatter. Engine builds an index injected into all prompts. Skills can also be stored per-project at `<project>/.claude/skills/<name>/SKILL.md` (requires a PR). Visible in dashboard alongside decisions.

See `docs/self-improvement.md` for the full breakdown.

## Team

| Agent | Role | Best for |
|-------|------|----------|
| Ripley | Lead / Explorer | Code review, architecture, exploration |
| Dallas | Engineer | Features, tests, UI |
| Lambert | Analyst | PRD generation, docs |
| Rebecca | Architect | Complex systems, CI/infra |
| Ralph | Engineer | Features, bug fixes |

Routing rules in `routing.md`. Charters in `agents/{name}/charter.md`.

## Playbooks

| Playbook | Purpose |
|----------|---------|
| `work-item.md` | Shared template for all work items (central + per-project) |
| `implement.md` | Build a PRD item in a git worktree, create PR |
| `review.md` | Review a PR, post findings to ADO |
| `fix.md` | Fix review feedback on existing PR branch |
| `analyze.md` | Generate PRD gap analysis in a worktree |
| `explore.md` | Read-only codebase exploration |
| `test.md` | Run tests and report results |

All playbooks use `{{template_variables}}` filled from project config. The `work-item.md` playbook uses `{{scope_section}}` to inject project-specific or multi-project context.

## Portability

**Portable (works on any machine):** Engine, dashboard, playbooks, charters, routing, decisions, skills, docs, work items.

**Machine-specific (reconfigure per machine):**
- `config.json` — contains absolute paths to project directories. Re-link via `node init.js <dir>`.
- `mcp-servers.json` — auto-synced from `~/.claude.json` on engine start.

To move to a new machine: copy `~/.squad/`, delete `engine/control.json`, re-run `node init.js <dir>` for each project.

## File Layout

```
~/.squad/
  init.js                <- CLI: init, add, remove, list projects
  squad.js               <- Legacy CLI (same as init.js)
  engine.js              <- Engine daemon
  engine/
    spawn-agent.js       <- Agent spawn wrapper (resolves claude cli.js)
    control.json         <- running/paused/stopped
    dispatch.json        <- pending/active/completed queue
    log.json             <- Audit trail (capped at 500)
    metrics.json         <- Per-agent quality metrics
  dashboard.js           <- Web dashboard server
  dashboard.html         <- Dashboard UI
  config.json            <- projects[], agents, engine, claude settings
  config.template.json   <- Template for reference
  mcp-servers.json       <- MCP servers (auto-synced, gitignored)
  routing.md             <- Dispatch rules table
  team.md                <- Team roster and project context
  decisions.md           <- Team rules + consolidated learnings
  work-items.json        <- Central work queue (agent decides which project)
  TODO.md                <- Future improvements roadmap
  playbooks/
    work-item.md         <- Shared work item template
    implement.md         <- Build a PRD item
    review.md            <- Review a PR
    fix.md               <- Fix review feedback
    analyze.md           <- Generate new PRD
    explore.md           <- Codebase exploration
    test.md              <- Run tests
  skills/
    README.md            <- Skill format guide
    <name>.md            <- Agent-created reusable workflows
  agents/
    {name}/
      charter.md         <- Agent identity and boundaries
      status.json        <- Current state (runtime)
      history.md         <- Task history (last 20, runtime)
      live-output.log    <- Streaming output while working (runtime)
      output.log         <- Final output after completion (runtime)
  identity/
    now.md               <- Engine-generated state snapshot
  decisions/
    inbox/               <- Agent findings drop-box
    archive/             <- Processed inbox files
  docs/
    auto-discovery.md              <- Auto-discovery pipeline docs
    self-improvement.md            <- Self-improvement loop docs
    blog-first-successful-dispatch.md  <- Debugging saga blog post

Each linked project keeps locally:
  <project>/.squad/
    work-items.json      <- Per-project work queue
    pull-requests.json   <- PR tracker
  <project>/.claude/
    skills/              <- Project-specific skills (requires PR)
  <project>/docs/
    prd-gaps.json        <- PRD gap analysis
```
