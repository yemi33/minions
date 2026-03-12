# Squad — Central AI Development Team

A multi-project AI dev team that runs from `~/.squad/`. Five autonomous agents share a single engine, dashboard, knowledge base, and MCP toolchain — working across any number of linked repos with self-improving workflows.

## What It Does

- **Auto-discovers work** from PRD gaps, pull requests, and work queues across all linked projects
- **Dispatches AI agents** (Claude CLI) with full project context, git worktrees, and MCP server access
- **Routes intelligently** — fixes first, then reviews, then implementation, matched to agent strengths
- **Learns from itself** — agents write findings, engine consolidates into institutional knowledge
- **Tracks quality** — approval rates, error rates, and task metrics per agent
- **Shares workflows** — agents create reusable runbooks that all other agents can follow
- **Supports cross-repo tasks** — a single work item can span multiple repositories

## Quick Start

```powershell
# 1. Initialize the squad (one-time)
node $env:USERPROFILE\.squad\squad.js init

# 2. Link your projects (interactive — prompts for description, ADO config)
node $env:USERPROFILE\.squad\squad.js add C:\path\to\repo1
node $env:USERPROFILE\.squad\squad.js add C:\path\to\repo2

# 3. Run
node $env:USERPROFILE\.squad\engine.js           # Start engine
node $env:USERPROFILE\.squad\dashboard.js         # Dashboard at localhost:7331
node $env:USERPROFILE\.squad\engine.js status     # Check state
```

## CLI Reference

### `squad.js` — Project management

| Command | Description |
|---------|-------------|
| `node squad.js init` | Initialize squad with default agents and config (no projects) |
| `node squad.js add <dir>` | Link a project (prompts for description, ADO config) |
| `node squad.js remove <dir>` | Unlink a project |
| `node squad.js list` | List all linked projects with descriptions |

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
                    │  playbooks/       ← templates  │
                    │  runbooks/        ← workflows  │
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
     └──────────────┘ └──────────────┘ └──────────────┘
```

## Dashboard

The web dashboard at `http://localhost:7331` provides:

- **Projects bar** — all linked projects with descriptions (hover for full text)
- **Command Center** — add work items (per-project or auto-route), decisions, and PRD items
- **Squad Members** — agent cards with status, click for charter/history/output detail
- **Work Items** — all items from central + per-project queues with status, source, assigned agent
- **PRD** — gap analysis stats + progress bar with item-level breakdown
- **Pull Requests** — paginated PR tracker with review/build/merge status
- **Runbooks** — agent-created reusable workflows, click to view full content
- **Decisions Inbox + Active Decisions** — learnings and team rules
- **Agent Metrics** — tasks completed, errors, PRs created/approved/rejected, approval rates
- **Dispatch Queue + Engine Log** — active/pending work and audit trail

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

**Per-project** — scoped to one repo. Select a project in the Command Center dropdown.

**Central (auto-route)** — agent gets all project descriptions and decides where to work. Use "Auto (agent decides)" in the dropdown, or `node engine.js work "title"`.

Central work items can span multiple repos — the agent works on each sequentially, creating separate PRs per repo with cross-repo dependency notes.

## Auto-Discovery Pipeline

The engine discovers work from 5 sources, in priority order:

| Priority | Source | Dispatch Type |
|----------|--------|---------------|
| 1 | PRs with changes-requested | `fix` |
| 2 | PRs pending review | `review` |
| 3 | PRD items (missing/planned) | `implement` |
| 4 | Per-project work items | item's `type` |
| 5 | Central work items | item's `type` |

Each item passes through dedup (dispatch key per project), cooldown, and agent availability gates before being queued. See `docs/auto-discovery.md` for the full pipeline.

## Agent Execution

When dispatched, each agent gets:

- **System prompt** — identity, charter, history, project context, critical rules, runbook index, team decisions
- **Task prompt** — rendered playbook with `{{variables}}` filled from config
- **Working directory** — git worktree in the target project (or project root for read-only tasks)
- **MCP servers** — all servers from `~/.claude.json` (azure-ado, azure-kusto, etc.) via `--mcp-config`
- **Full tool access** — Edit, Write, Read, Bash, Glob, Grep, Agent, WebFetch, WebSearch, plus all MCP tools

Agents are spawned as `claude -p <prompt> --system-prompt <sysprompt> --mcp-config <mcp>` processes with max 100 turns.

## MCP & Tool Access

On engine start, MCP servers are auto-synced from `~/.claude.json` to `mcp-servers.json`. Agents inherit all MCP servers configured in the user's Claude Code instance. Manually refresh with `node engine.js mcp-sync`.

Currently synced servers are visible in `mcp-servers.json` (gitignored, machine-specific).

## Self-Improvement Loop

Five mechanisms that make the squad get better over time:

### 1. Learnings Inbox → decisions.md
Agents write findings to `decisions/inbox/`. Engine consolidates at 5+ files into `decisions.md` — categorized (reviews, feedback, learnings, other) with one-line summaries. Auto-prunes at 50KB. Injected into every future playbook.

### 2. Per-Agent History
`agents/{name}/history.md` tracks last 20 tasks with timestamps, results, projects, and branches. Injected into the agent's system prompt so it remembers past work.

### 3. Review Feedback Loop
When a reviewer flags issues, the engine creates `feedback-<author>-from-<reviewer>.md` in the inbox. The PR author sees the feedback in their next task, learning from specific review findings.

### 4. Quality Metrics
`engine/metrics.json` tracks per agent: tasks completed, errors, PRs created/approved/rejected, reviews done. Visible in CLI (`status`) and dashboard with color-coded approval rates.

### 5. Runbooks
Agents save repeatable multi-step procedures to `runbooks/<name>.md` with frontmatter (name, trigger, project, author). Engine builds an index injected into all prompts. Future agents match triggers to their task and follow the steps. Visible in dashboard alongside decisions.

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
| `implement.md` | Build a PRD item in a git worktree, create PR |
| `review.md` | Review a PR, post findings to ADO |
| `fix.md` | Fix review feedback on existing PR branch |
| `analyze.md` | Generate PRD gap analysis in a worktree |
| `explore.md` | Read-only codebase exploration |

All playbooks use `{{template_variables}}` filled from project config — no hardcoded project names.

## Portability

**Portable (works on any machine):** Engine, dashboard, playbooks, charters, routing, decisions, runbooks, docs, work items.

**Machine-specific (reconfigure per machine):**
- `config.json` — contains absolute paths to project directories. Re-link via `node squad.js add <dir>`.
- `mcp-servers.json` — auto-synced from `~/.claude.json` on engine start.

To move to a new machine: copy `~/.squad/`, delete `engine/control.json`, re-run `node squad.js add` for each project.

## File Layout

```
~/.squad/
  squad.js               <- CLI: init, add, remove, list projects
  engine.js              <- Engine daemon
  dashboard.js           <- Web dashboard server
  dashboard.html         <- Dashboard UI
  config.json            <- projects[], agents, engine, claude settings
  config.template.json   <- Template for reference
  mcp-servers.json       <- MCP servers (auto-synced, gitignored)
  routing.md             <- Dispatch rules table
  decisions.md           <- Team rules + consolidated learnings
  work-items.json        <- Central work queue (agent decides which project)
  TODO.md                <- Future improvements roadmap
  engine/
    control.json         <- running/paused/stopped
    dispatch.json        <- pending/active/completed queue
    log.json             <- Audit trail (capped at 500)
    metrics.json         <- Per-agent quality metrics
  playbooks/
    implement.md         <- Build a PRD item
    review.md            <- Review a PR
    fix.md               <- Fix review feedback
    analyze.md           <- Generate new PRD
    explore.md           <- Codebase exploration
  agents/
    {name}/
      charter.md         <- Agent identity and boundaries
      status.json        <- Current state (runtime)
      history.md         <- Task history (last 20, runtime)
  runbooks/
    README.md            <- Runbook format guide
    <name>.md            <- Agent-created reusable workflows
  identity/
    now.md               <- Engine-generated state snapshot
  decisions/
    inbox/               <- Agent findings drop-box
    archive/             <- Processed inbox files
  docs/
    auto-discovery.md    <- Auto-discovery pipeline docs
    self-improvement.md  <- Self-improvement loop docs

Each linked project keeps locally:
  <project>/.squad/
    work-items.json      <- Per-project work queue
    pull-requests.json   <- PR tracker
  <project>/docs/
    prd-gaps.json        <- PRD gap analysis
```
