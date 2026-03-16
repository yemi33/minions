# Squad — Central AI Development Team

A multi-project AI dev team that runs from `~/.squad/`. Five autonomous agents share a single engine, dashboard, knowledge base, and MCP toolchain — working across any number of linked repos with self-improving workflows.

Inspired by and initially scaffolded from [Brady Gaster's Squad](https://bradygaster.github.io/squad/).

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Claude Code CLI** — install with `npm install -g @anthropic-ai/claude-code`
- **Anthropic API key** or Claude Max subscription (agents spawn Claude Code sessions)
- **Git** — agents create worktrees for all code changes

## Installation

```bash
# Install globally from npm
npm install -g @yemi33/squad

# Bootstrap ~/.squad/ with default config and agents
squad init

# Link your first project (interactive — auto-detects from git remote)
squad add ~/my-project
```

Or try without installing:

```bash
npx @yemi33/squad init
```

No dependencies — Squad uses only Node.js built-in modules.

**Alternative: clone directly**
```bash
git clone https://github.com/yemi33/squad.git ~/.squad
node ~/.squad/squad.js init
```

## Upgrading

```bash
npm update -g @yemi33/squad
squad init --force
```

This updates the engine, dashboard, and playbook files in `~/.squad/` while preserving your `config.json`, agent history, notes, and other runtime state. Only `.js` and `.html` files are overwritten; your customized `.md` files (charters, playbooks, routing) are kept.

## Quick Start

```bash
# 1. Init + scan — finds all git repos on your machine, multi-select to add
squad init
#    → creates config, agents, engine defaults
#    → scans ~ for git repos (auto-detects host, org, branch)
#    → shows numbered list, pick with "1,3,5-7" or "all"

# 2. Start the engine (runs in foreground, ticks every 60s)
squad start

# 3. Open the dashboard (separate terminal)
squad dash
# → http://localhost:7331
```

You can also add/scan repos later:
```bash
squad scan              # Re-scan and add more repos
squad scan ~/code 4     # Scan specific dir, depth 4
squad add ~/repo        # Add a single repo interactively
```

## Setup via Claude Code

If you use Claude Code as your daily driver, you can set up Squad by prompting Claude directly:

**First-time setup:**
```
Install squad with `npm install -g @yemi33/squad`, run `squad init`,
then link my project at ~/my-project with `squad add ~/my-project` —
answer the interactive prompts using what you can auto-detect from the repo.
```

**Give the squad work:**
```
Add a work item to my squad: "Explore the codebase and document the architecture"
— run `squad work "Explore the codebase and document the architecture"`
```

**Check status:**
```
Run `squad status` and tell me what my squad is doing
```

### What happens on first run

1. The engine starts ticking every 60 seconds
2. It scans each linked project for work: PRs needing review, plan items, queued work items
3. If it finds work and an agent is idle, it spawns a Claude Code session with the right playbook
4. You can watch progress on the dashboard or via `squad status`

To give the squad its first task, open the dashboard Command Center and add a work item, or use the CLI:
```bash
squad work "Explore the codebase and document the architecture"
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `squad init` | Bootstrap `~/.squad/` then auto-scan for repos to add |
| `squad scan [dir] [depth]` | Scan for git repos and multi-select to add (default: ~, depth 3) |
| `squad add <dir>` | Link a single project (auto-detects settings from git, prompts to confirm) |
| `squad remove <dir>` | Unlink a project |
| `squad list` | List all linked projects with descriptions |
| `squad start` | Start engine daemon (ticks every 60s, auto-syncs MCP servers) |
| `squad stop` | Stop the engine |
| `squad status` | Show agents, projects, dispatch queue, quality metrics |
| `squad pause` / `resume` | Pause/resume dispatching |
| `squad dispatch` | Force a dispatch cycle |
| `squad discover` | Dry-run work discovery |
| `squad work <title> [opts]` | Add to central work queue |
| `squad spawn <agent> <prompt>` | Manually spawn an agent |
| `squad plan <file\|text> [proj]` | Run a plan |
| `squad cleanup` | Run cleanup manually (temp files, worktrees, zombies) |
| `squad dash` | Start web dashboard (default port 7331) |

You can also run scripts directly: `node ~/.squad/engine.js start`, `node ~/.squad/dashboard.js`, etc.

## Architecture

```
                    ┌───────────────────────────────┐
                    │      ~/.squad/ (central)       │
                    │                               │
                    │  engine.js        ← tick 60s  │
                    │  dashboard.js     ← :7331     │
                    │  config.json      ← projects  │
                    │  agents/          ← 5 agents  │
                    │  playbooks/       ← templates │
                    │  plans/           ← approved plans│
                    │  knowledge/       ← KB store  │
                    │  skills/          ← workflows │
                    │  notes/       ← knowledge  │
                    └──────┬────────────────────────┘
                           │ discovers work + dispatches agents
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │  Project A   │ │  Project B   │ │  Project C   │
     │  .squad/     │ │  .squad/     │ │  .squad/     │
     │   work-items │ │   work-items │ │   work-items │
     │   pull-reqs  │ │   pull-reqs  │ │   pull-reqs  │
     │  .claude/    │ │  .claude/    │ │  .claude/    │
     │   skills/    │ │   skills/    │ │   skills/    │
     └──────────────┘ └──────────────┘ └──────────────┘
```

## What It Does

- **Auto-discovers work** from plans (`plans/*.json`), pull requests, and work queues across all linked projects
- **Plan pipeline** — `/plan` spawns a plan agent, chains to plan-to-prd, produces `plans/{project}-{date}.json` with `status: "awaiting-approval"`. Supports shared-branch and parallel strategies.
- **Human approval gate** — plans require approval before materializing as work items. Dashboard provides Approve / Discuss & Revise / Reject. Discussion launches an interactive Claude Code session.
- **Dispatches AI agents** (Claude CLI) with full project context, git worktrees, and MCP server access
- **Routes intelligently** — fixes first, then reviews, then implementation, matched to agent strengths
- **LLM-powered consolidation** — Haiku summarizes notes (threshold: 3 files). Regex fallback. Source references required.
- **Knowledge base** — `knowledge/` with categories: architecture, conventions, project-notes, build-reports, reviews. Full notes preserved. Dashboard browsable with inline Q&A.
- **Token tracking** — per-agent and per-day usage. Dashboard Token Usage panel.
- **Engine watchdog** — dashboard auto-restarts dead engine.
- **Agent re-attachment** — on restart, finds surviving agent processes via PID files.
- **Learns from itself** — agents write findings, engine consolidates into institutional knowledge
- **Tracks quality** — approval rates, error rates, and task metrics per agent
- **Shares workflows** — agents create reusable skills (Claude Code-compatible) that all other agents can follow
- **Supports cross-repo tasks** — a single work item can span multiple repositories
- **Fan-out dispatch** — broad tasks can be split across all idle agents in parallel, each assigned a project
- **Auto-syncs PRs** — engine scans agent output for PR URLs and updates project trackers automatically
- **Auto-extracts skills** — agents write ` ```skill ` blocks in output; engine auto-extracts them
- **Heartbeat monitoring** — detects dead/hung agents via output file activity, not just timeouts
- **Auto-cleanup** — stale temp files, orphaned worktrees, zombie processes cleaned every 10 minutes

## Dashboard

The web dashboard at `http://localhost:7331` provides:

- **Projects bar** — all linked projects with descriptions (hover for full text)
- **Command Center** — add work items, notes, plans (multi-project via `#project` tags). "make a plan for..." auto-detection, "remember" keyword, `--parallel`/`--shared` flags, arrow key history, Past Commands modal.
- **Squad Members** — agent cards with status and result summary, click for charter/history/output detail panel
  - **Live Output tab** — real-time streaming output for working agents (auto-refreshes every 3s)
- **Work Items** — paginated table with status, source, type, priority, assigned agent, linked PRs, fan-out badges, and retry button for failed items
- **Plans** — plan approval UI with Approve / Discuss & Revise / Reject
- **Knowledge Base** — browsable by category with inline Q&A (Haiku-powered)
- **Token Usage** — per-agent and per-day token tracking
- **Pull Requests** — paginated PR tracker sorted by date, with review/build/merge status
- **Skills** — agent-created reusable workflows (squad-wide + project-specific), click to view full content
- **Notes Inbox + Team Notes** — learnings and team rules, editable from dashboard modal
- **Dispatch Queue + Engine Log** — active/pending work and audit trail
- **Agent Metrics** — tasks completed, errors, PRs created/approved/rejected, approval rates
- **Document modals** — inline Q&A with Haiku on any document modal

## Project Config

When you run `squad add <dir>`, it prompts for project details and saves them to `config.json`. Each project entry looks like:

```json
{
  "name": "MyProject",
  "description": "What this repo is for — agents read this to decide where to work",
  "localPath": "C:/Users/you/MyProject",
  "repoHost": "github",
  "repositoryId": "",
  "adoOrg": "your-github-org",
  "adoProject": "",
  "repoName": "MyProject",
  "mainBranch": "main",
  "workSources": {
    "pullRequests": { "enabled": true, "path": ".squad/pull-requests.json" },
    "workItems":    { "enabled": true, "path": ".squad/work-items.json" }
  }
}
```

**Key fields:**
- `description` — critical for auto-routing. Agents read this to decide which repo to work in.
- `repoHost` — `"ado"` (Azure DevOps) or `"github"`. Controls which MCP tools agents use for PR creation, review comments, and status checks. Defaults to `"ado"`.
- `repositoryId` — required for ADO (the repo GUID), optional for GitHub.
- `adoOrg` — ADO organization or GitHub org/user.
- `adoProject` — ADO project name (leave blank for GitHub).
- `workSources` — toggle which work sources the engine scans for each project.

The init script also creates `<project>/.squad/` with empty `work-items.json` and `pull-requests.json`.

### Auto-Discovery

When you run `squad add`, the tool automatically detects what it can from the repo:

| What | How |
|------|-----|
| Main branch | `git symbolic-ref` |
| Repo host | Git remote URL (github.com → `github`, visualstudio.com/dev.azure.com → `ado`) |
| Org / project / repo | Parsed from git remote URL |
| Description | First non-heading line from `CLAUDE.md` or `README.md` |
| Project name | `name` field from `package.json` |

All detected values are shown as defaults in the interactive prompts — just press Enter to accept or type to override.

### Project Conventions (CLAUDE.md)

When dispatching agents, the engine reads each project's `CLAUDE.md` and injects it into the agent's system prompt as "Project Conventions". This means agents automatically follow repo-specific rules (logging, build commands, coding style, etc.) without needing to discover them each time. Each project can have different conventions.

## MCP Server Integration

Agents need MCP tools to interact with your repo host (create PRs, post review comments, etc.). Agents inherit MCP servers directly from `~/.claude.json` as Claude Code processes — add servers there and they're immediately available to all agents on next spawn.

**Example:** If you use Azure DevOps, configure the `azure-ado` MCP server in your Claude Code settings. If you use GitHub, configure the `github` MCP server. Agents will discover and use whichever tools are available.

Manually refresh with `squad mcp-sync`.

### Azure DevOps Users

For the best experience with ADO repos, install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) and use the [Azure DevOps MCP server](https://github.com/microsoft/azure-devops-mcp). This gives agents full access to PRs, work items, repos, and pipelines via MCP tools — no `gh` CLI needed.

```bash
# Install Azure CLI
winget install Microsoft.AzureCLI   # Windows
brew install azure-cli               # macOS
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash  # Linux

# Login and set defaults
az login
az devops configure --defaults organization=https://dev.azure.com/YOUR_ORG project=YOUR_PROJECT
```

Then add the ADO MCP server to your Claude Code settings (`~/.claude.json`). The engine will auto-sync it to all agents on next start.

## Work Items

All work items use the shared `playbooks/work-item.md` template, which provides consistent branch naming, worktree workflow, PR creation steps, and status tracking.

**Per-project** — scoped to one repo. Select a project in the Command Center dropdown.

**Central (auto-route)** — agent gets all project descriptions and decides where to work. Use "Auto (agent decides)" in the dropdown, or `squad work "title"`. Can span multiple repos.

### Fan-Out (Parallel Multi-Agent)

Set Scope to "Fan-out (all agents)" in the Command Center, or add `"scope": "fan-out"` to the work item JSON.

The engine dispatches the task to **all idle agents simultaneously**, assigning each a project (round-robin). Each agent focuses on their assigned project and writes findings to the inbox.

```
"Explore all codebases and write architecture doc"  scope: fan-out
       │
       ├─→ Ripley   → Project A
       ├─→ Lambert  → Project B
       ├─→ Rebecca  → Project C
       └─→ Ralph    → Project A (round-robin wraps)
```

### Failed Work Items

When an agent fails (timeout, crash, error), the engine marks the work item as `failed` with a reason. The dashboard shows a **Retry** button that resets it to `pending` for re-dispatch.

## Auto-Discovery Pipeline

The engine discovers work from 5 sources, in priority order:

| Priority | Source | Dispatch Type |
|----------|--------|---------------|
| 1 | PRs with changes-requested | `fix` |
| 2 | PRs pending review | `review` |
| 3 | Plan items (`plans/*.json`, approved) | `implement` |
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

- **System prompt** — lean (~2-4KB) identity + rules only
- **Task prompt** — rendered playbook with `{{variables}}` filled from config, plus bulk context (charter, history, project context, skill index, team notes)
- **Working directory** — project root (agent creates worktrees as needed)
- **MCP servers** — inherited from `~/.claude.json` (no extra config needed)
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
8. Learnings checked in `notes/inbox/`
9. Skills auto-extracted from ` ```skill ` blocks in output
10. Temp files cleaned up

## Team

| Agent | Role | Best for |
|-------|------|----------|
| Ripley | Lead / Explorer | Code review, architecture, exploration |
| Dallas | Engineer | Features, tests, UI |
| Lambert | Analyst | PRD generation, docs |
| Rebecca | Architect | Complex systems, CI/infra |
| Ralph | Engineer | Features, bug fixes |

Routing rules in `routing.md`. Charters in `agents/{name}/charter.md`. Both are editable — customize agents and routing to fit your team's needs.

## Playbooks

| Playbook | Purpose |
|----------|---------|
| `work-item.md` | Shared template for all work items (central + per-project) |
| `implement.md` | Build a PRD item in a git worktree, create PR |
| `review.md` | Review a PR, post findings to repo host |
| `fix.md` | Fix review feedback on existing PR branch |
| `explore.md` | Read-only codebase exploration |
| `test.md` | Run tests and report results |
| `build-and-test.md` | Build project and run test suite |
| `plan-to-prd.md` | Convert a plan into PRD gap items |
| `plan.md` | Generate a plan from user request |
| `implement-shared.md` | Implement on a shared branch (multiple agents) |
| `ask.md` | Answer a question about the codebase |

All playbooks use `{{template_variables}}` filled from project config. The `work-item.md` playbook uses `{{scope_section}}` to inject project-specific or multi-project context. Playbooks are fully customizable — edit them to match your workflow.

## Health Monitoring

### Heartbeat Check (every tick)

Uses `live-output.log` file modification time as a heartbeat:
- **Process alive + recent output** → healthy, keep running
- **Process alive + in blocking tool call** → extended timeout (matches tool's timeout + grace period)
- **Process alive + silent >5min** → hung, kill and mark failed
- **No process + silent >5min** → orphaned (engine restarted), mark failed

Agents can run for hours as long as they're producing output. The `heartbeatTimeout` (default 5min) only triggers on silence. When an agent is in a blocking tool call (e.g., `TaskOutput` with `block:true`, `Bash` with long timeout), the engine detects this from the live output and extends the timeout automatically.

### Automated Cleanup (every 10 ticks)

| What | Condition |
|------|-----------|
| Temp prompt/sysprompt files | >1 hour old |
| `live-output.log` for idle agents | >1 hour old |
| Git worktrees for merged/abandoned PRs | PR status is `merged`/`abandoned`/`completed` |
| Orphaned worktrees | >24 hours old, no active dispatch references them |
| Zombie processes | In memory but no matching dispatch |

Manual cleanup: `squad cleanup`

## Self-Improvement Loop

Six mechanisms that make the squad get better over time:

### 1. Learnings Inbox → notes.md
Agents write findings to `notes/inbox/`. Engine consolidates at 3+ files using Haiku LLM summarization (regex fallback) into `notes.md` — categorized with source references. Auto-prunes at 50KB. Injected into every future playbook.

### 6. Knowledge Base
`knowledge/` stores full notes by category: architecture, conventions, project-notes, build-reports, reviews. Browsable in dashboard with inline Q&A (Haiku-powered).

### 2. Per-Agent History
`agents/{name}/history.md` tracks last 20 tasks with timestamps, results, projects, and branches. Injected into the agent's system prompt so it remembers past work.

### 3. Review Feedback Loop
When a reviewer flags issues, the engine creates `feedback-<author>-from-<reviewer>.md` in the inbox. The PR author sees the feedback in their next task.

### 4. Quality Metrics
`engine/metrics.json` tracks per agent: tasks completed, errors, PRs created/approved/rejected, reviews done. Visible in CLI (`status`) and dashboard with color-coded approval rates.

### 5. Skills
Agents save repeatable workflows to `skills/<name>.md` with Claude Code-compatible frontmatter. Engine builds an index injected into all prompts. Skills can also be stored per-project at `<project>/.claude/skills/<name>/SKILL.md` (requires a PR). Visible in the dashboard Skills section.

See `docs/self-improvement.md` for the full breakdown.

## Configuration Reference

Engine behavior is controlled via `config.json`. Key settings:

```json
{
  "engine": {
    "tickInterval": 60000,
    "maxConcurrent": 5,
    "agentTimeout": 600000,
    "staleThreshold": 1800000,
    "maxTurns": 100,
    "inboxConsolidateThreshold": 3
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `tickInterval` | 60000 (1min) | Milliseconds between engine ticks |
| `maxConcurrent` | 5 | Max agents running simultaneously |
| `agentTimeout` | 600000 (10min) | Kill agents silent longer than this |
| `staleThreshold` | 1800000 (30min) | Kill stale dispatch entries |
| `maxTurns` | 100 | Max Claude CLI turns per agent session |
| `inboxConsolidateThreshold` | 3 | Inbox files needed before consolidation |

## Node.js Upgrade Caution

The engine and all spawned agents use the Node binary that started the engine (`process.execPath`). After upgrading Node, restart the engine:

```bash
squad stop
squad start
```

## Portability

**Portable (works on any machine):** Engine, dashboard, playbooks, charters, routing, notes, skills, docs, work items.

**Machine-specific (reconfigure per machine):**
- `config.json` — contains absolute paths to project directories. Re-link via `squad add <dir>`.

To move to a new machine: `npm install -g @yemi33/squad && squad init --force`, then re-run `squad add` for each project.

## File Layout

```
~/.squad/
  bin/
    squad.js             <- Unified CLI entry point (npm package)
  squad.js               <- Project management: init, add, remove, list
  engine.js              <- Engine daemon
  engine/
    spawn-agent.js       <- Agent spawn wrapper (resolves claude cli.js)
    ado-mcp-wrapper.js   <- ADO MCP authentication wrapper
    control.json         <- running/paused/stopped (runtime)
    dispatch.json        <- pending/active/completed queue (runtime)
    log.json             <- Audit trail, capped at 500 (runtime)
    metrics.json         <- Per-agent quality metrics (runtime)
  dashboard.js           <- Web dashboard server
  dashboard.html         <- Dashboard UI (single-file)
  config.json            <- projects[], agents, engine, claude settings
  config.template.json   <- Template for new installs
  plans/                 <- Approved plans (plans/{project}-{date}.json)
  knowledge/             <- KB: architecture, conventions, project-notes, build-reports, reviews
  package.json           <- npm package definition
  routing.md             <- Dispatch rules table (editable)
  team.md                <- Team roster
  notes.md               <- Team rules + consolidated learnings (runtime)
  work-items.json        <- Central work queue (runtime)
  playbooks/
    work-item.md         <- Shared work item template
    implement.md         <- Build a PRD item
    review.md            <- Review a PR
    fix.md               <- Fix review feedback
    explore.md           <- Codebase exploration
    test.md              <- Run tests
    build-and-test.md    <- Build project and run test suite
    plan-to-prd.md       <- Convert plan to PRD gap items
    plan.md              <- Generate a plan from user request
    implement-shared.md  <- Implement on a shared branch
    ask.md               <- Answer a question about the codebase
  skills/
    README.md            <- Skill format guide
    <name>.md            <- Agent-created reusable workflows
  agents/
    {name}/
      charter.md         <- Agent identity and boundaries (editable)
      status.json        <- Current state (runtime)
      history.md         <- Task history, last 20 (runtime)
      live-output.log    <- Streaming output while working (runtime)
      output.log         <- Final output after completion (runtime)
  identity/
    now.md               <- Engine-generated state snapshot
  notes/
    inbox/               <- Agent findings drop-box
    archive/             <- Processed inbox files
  docs/
    auto-discovery.md    <- Auto-discovery pipeline docs
    self-improvement.md  <- Self-improvement loop docs

Each linked project keeps locally:
  <project>/.squad/
    work-items.json      <- Per-project work queue
    pull-requests.json   <- PR tracker
  <project>/.claude/
    skills/              <- Project-specific skills (requires PR)
```
