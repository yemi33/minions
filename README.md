# Minions — Autonomous AI Development Team

A multi-project AI dev team that runs from `~/.minions/`. Five autonomous agents share a single engine, dashboard, knowledge base, and MCP toolchain — working across any number of linked repos with self-improving workflows.

Zero dependencies — uses only Node.js built-in modules.

Inspired by and initially scaffolded from [Brady Gaster's Minions](https://bradygaster.github.io/minions/).

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **Claude Code CLI** — install with `npm install -g @anthropic-ai/claude-code`
- **Anthropic API key** or Claude Max subscription (agents spawn Claude Code sessions)
- **Git** — agents create worktrees for all code changes

## Installation

```bash
# Install globally from npm
npm install -g @yemi33/minions

# Bootstrap ~/.minions/ with default config and agents
minions init

# Link your first project (interactive — auto-detects from git remote)
minions add ~/my-project
```

Or try without installing:

```bash
npx @yemi33/minions init
```

No dependencies — Minions uses only Node.js built-in modules.

**Alternative: clone directly**
```bash
git clone https://github.com/yemi33/minions.git ~/.minions
node ~/.minions/minions.js init
```

## Upgrading

```bash
minions update
```

One command — pulls the latest npm package and applies the update automatically. Equivalent to `npm update -g @yemi33/minions && minions init --force`.

**What gets updated:** Engine code (`.js`, `.html`), new playbooks, new agent charters, new docs, `CHANGELOG.md`.

**What's preserved:** Your `config.json`, agent history, notes, knowledge base, routing, skills, and any `.md` files you've customized (charters, playbooks). New files are added automatically without touching existing ones.

### Migrating from legacy installs

If you previously used an older install layout, run:

```bash
minions init --force
```

`minions` will auto-detect legacy runtime locations and markers, migrate state into `~/.minions`, normalize runtime marker names, and record the action in `~/.minions/migration.log`.

## Quick Start

```bash
# 1. Init + scan — finds all git repos on your machine, multi-select to add
minions init
#    → creates config, agents, engine defaults
#    → scans ~ for git repos (auto-detects host, org, branch)
#    → shows numbered list, pick with "1,3,5-7" or "all"

# 2. Start the engine (runs in foreground, ticks every 60s)
minions start

# 3. Open the dashboard (separate terminal)
minions dash
# → http://localhost:7331
```

You can also add/scan repos later:
```bash
minions scan              # Re-scan and add more repos
minions scan ~/code 4     # Scan specific dir, depth 4
minions add ~/repo        # Add a single repo interactively
```

## Setup via Claude Code

If you use Claude Code as your daily driver, you can set up Minions by prompting Claude directly:

**First-time setup:**
```
Install minions with `npm install -g @yemi33/minions`, run `minions init`,
then link my project at ~/my-project with `minions add ~/my-project` —
answer the interactive prompts using what you can auto-detect from the repo.
```

**Give the minions work:**
```
Add a work item to my minions: "Explore the codebase and document the architecture"
— run `minions work "Explore the codebase and document the architecture"`
```

**Check status:**
```
Run `minions status` and tell me what my minions is doing
```

### What happens on first run

1. The engine starts ticking every 60 seconds
2. It scans each linked project for work: PRs needing review, plan items, queued work items
3. If it finds work and an agent is idle, it spawns a Claude Code session with the right playbook
4. You can watch progress on the dashboard or via `minions status`

To give the minions its first task, open the dashboard Command Center and add a work item, or use the CLI:
```bash
minions work "Explore the codebase and document the architecture"
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `minions init` | Bootstrap `~/.minions/` with default agents and config |
| `minions update` | Update to latest version (npm update + apply) |
| `minions version` | Show installed vs package version |
| `minions scan [dir] [depth]` | Scan for git repos and multi-select to add (default: ~, depth 3) |
| `minions add <dir>` | Link a single project (auto-detects settings from git, prompts to confirm) |
| `minions remove <dir-or-name> [--keep-data \| --purge --force]` | Unlink a project: cancels pending work items, drains dispatch + kills active agents, cleans worktrees, disables linked schedules, archives `projects/<name>/` to `projects/.archived/<name>-YYYYMMDD/`. Use `--keep-data` to leave the data dir in place, or `--purge --force` to delete it. |
| `minions list` | List all linked projects with descriptions |
| `minions start` | Start engine daemon (ticks every 60s, auto-syncs MCP servers) |
| `minions stop` | Stop the engine |
| `minions status` | Show agents, projects, dispatch queue, quality metrics |
| `minions pause` / `resume` | Pause/resume dispatching |
| `minions dispatch` | Force a dispatch cycle |
| `minions discover` | Dry-run work discovery |
| `minions work <title> [opts]` | Add to central work queue |
| `minions spawn <agent> <prompt>` | Manually spawn an agent |
| `minions plan <file\|text> [proj]` | Run a plan |
| `minions cleanup` | Run cleanup manually (temp files, worktrees, zombies) |
| `minions dash` | Open dashboard (starts if not already running, port 7331) |

You can also run scripts directly: `node ~/.minions/engine.js start`, `node ~/.minions/dashboard.js`, etc.

## Architecture

```
                 ┌──────────────────────────────────────┐
                 │         ~/.minions/ (central)         │
                 │                                      │
                 │  engine.js            ← tick 60s     │
                 │  dashboard.js         ← :7331        │
                 │  config.json          ← projects,    │
                 │                         agents,      │
                 │                         schedules    │
                 │  routing.md           ← dispatch map │
                 │  pinned.md            ← global ctx   │
                 │  work-items.json      ← central queue│
                 │  pull-requests.json   ← central PRs  │
                 │                                      │
                 │  engine/                             │
                 │    dispatch.json      ← pending/     │
                 │                         active/      │
                 │                         completed    │
                 │    control.json       ← state/pid    │
                 │    metrics.json       ← token usage  │
                 │    cooldowns.json     ← backoff      │
                 │    schedule-runs.json ← cron state   │
                 │    pipeline-runs.json ← run history  │
                 │                                      │
                 │  agents/              ← 5 agents     │
                 │    {id}/charter.md    ← role def     │
                 │    {id}/output.log    ← last output  │
                 │    {id}/live-output   ← streaming    │
                 │                                      │
                 │  playbooks/           ← templates    │
                 │  plans/               ← .md drafts   │
                 │  prd/                 ← .json PRDs   │
                 │  pipelines/           ← workflows    │
                 │  meetings/            ← discussions  │
                 │  knowledge/           ← KB store     │
                 │  skills/              ← workflows    │
                 │  notes/               ← inbox +      │
                 │                         notes.md     │
                 └──────────┬───────────────────────────┘
                            │ discovers work + dispatches
              ┌─────────────┼─────────────────┐
              ▼             ▼                  ▼
     ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
     │  Project A    │ │  Project B    │ │  Project C    │
     │  projects/A/  │ │  projects/B/  │ │  projects/C/  │
     │   work-items  │ │   work-items  │ │   work-items  │
     │   pull-reqs   │ │   pull-reqs   │ │   pull-reqs   │
     │  (repo)/      │ │  (repo)/      │ │  (repo)/      │
     │   .claude/    │ │   .claude/    │ │   .claude/    │
     │    skills/    │ │    skills/    │ │    skills/    │
     └───────────────┘ └───────────────┘ └───────────────┘
```

## What It Does

- **Auto-discovers work** from plans (`plans/*.json`), pull requests, and work queues across all linked projects
- **Plan pipeline** — `/plan` spawns a plan agent, chains to plan-to-prd, produces `plans/{project}-{date}.json` with `status: "awaiting-approval"`. Supports shared-branch and parallel strategies.
- **Human approval gate** — plans require approval before materializing as work items. Dashboard provides Approve / Discuss & Revise / Reject. Discussion launches an interactive Claude Code session.
- **Dispatches AI agents** (Claude CLI) with full project context, git worktrees, and MCP server access
- **Routes intelligently** — fixes first, then reviews, then implementation, matched to agent strengths
- **LLM-powered consolidation** — Claude Haiku summarizes notes (threshold: 5 files). Regex fallback. Source references required.
- **Knowledge base** — `knowledge/` with categories: architecture, conventions, project-notes, build-reports, reviews. Full notes preserved. Dashboard browsable with inline Q&A.
- **Token tracking** — per-agent and per-day usage with runtime tracking. Dashboard Token Usage panel + LLM Call Performance tile (avg runtime by call type: agent-dispatch, command-center, doc-chat, consolidation).
- **Engine watchdog** — dashboard auto-restarts dead engine.
- **Agent re-attachment** — on restart, finds surviving agent processes via PID files.
- **Learns from itself** — agents write findings, engine consolidates into institutional knowledge
- **Tracks quality** — approval rates, error rates, and task metrics per agent
- **Shares workflows** — agents create reusable skills (Claude Code-compatible) that all other agents can follow
- **Supports cross-repo tasks** — a single work item can span multiple repositories
- **Fan-out dispatch** — broad tasks can be split across all idle agents in parallel, each assigned a project
- **Auto-syncs PRs** — engine scans agent output for PR URLs and updates project trackers automatically. PR reconciliation sweep catches any missed PRs from ADO.
- **Human feedback on PRs** — comment on any ADO PR to trigger agent fix tasks. `@minions` keyword required when multiple humans are commenting; optional when you're the only reviewer.
- **Dependency-aware spawning** — when a work item depends on others, the engine merges dependency PR branches into the worktree before the agent starts
- **Plan verification** — when all PRD items complete, engine auto-dispatches a verify task that builds all repos, starts the webapp, and writes a manual testing guide
- **PRD modification** — edit plans via doc-chat in the modal, then "Generate PRD" to regenerate. Dashboard supports regenerating, retrying failed items, and syncing edits to pending work items.
- **Auto-extracts skills** — agents write ` ```skill ` blocks in output; engine auto-extracts them
- **Team meetings** — multi-agent meetings with investigate → debate → conclude rounds. Agents research a topic, debate approaches, and produce a conclusion with action items.
- **Pipelines** — multi-stage workflows chaining tasks, meetings, plans, and more. Cron triggers or manual. Artifacts flow between stages.
- **Eval loop** — after implementation, auto-dispatches review → fix cycles (configurable iterations and cost ceiling per work item)
- **Pinned notes** — critical context pinned to all agent prompts via `pinned.md`
- **Process-based liveness** — live agents may be quiet; output staleness is only used for orphan cleanup after process tracking is lost
- **Auto-cleanup** — stale temp files, orphaned worktrees, zombie processes cleaned every 10 minutes

## Dashboard

The web dashboard at `http://localhost:7331` provides:

- **Projects bar** — all linked projects with descriptions (hover for full text)
- **Command Center** — add work items, notes, plans (multi-project via `#project` tags). "make a plan for..." auto-detection, "remember" keyword, `--parallel`/`--shared` flags, arrow key history, Past Commands modal. Session state persists across refreshes. File bugs as GitHub issues ("file this as a bug").
- **Minions Members** — agent cards with status and result summary, click for charter/history/output detail panel
  - **Live Output tab** — real-time streaming output for working agents (auto-refreshes every 3s)
- **Work Items** — paginated table (20/page) with status, source, type, priority, assigned agent, linked PRs, fan-out badges, retry/delete/archive with optimistic updates
- **Plans & PRD** — plan approval UI with Approve / Discuss & Revise / Reject / Pause / Archive. Paginated (10/page). Click to open in doc-chat modal for natural language editing. PRD dependency graph view with per-item retry, edit, and remove.
- **Meetings** — create multi-agent meetings, view live progress per round, advance/end/archive. Paginated (10/page). Create plan from meeting conclusion.
- **Pipelines** — multi-stage pipeline builder. Create, trigger, continue past wait stages, view run history with artifact links. Paginated (10/page).
- **Pull Requests** — paginated PR tracker (25/page) sorted by date, with review/build/merge status. Link external PRs manually.
- **Notes & KB** — inbox (paginated, 15/page), team notes (editable), knowledge base by category (paginated, 30/page) with inline Q&A. Pin-to-top for quick reference (UI-only, localStorage). Pinned tab in KB. Protected from sweep dedup.
- **Schedules** — create/edit/delete scheduled tasks with visual cron builder and natural language parsing. Paginated (15/page).
- **Skills & MCP** — agent-created reusable workflows (minions-wide + project-specific), click to view full content. MCP server listing.
- **Engine** — dispatch queue (completed paginated, 20/page), engine log (paginated, 50/page), LLM call performance (avg runtime by call type), agent metrics (with avg runtime), token usage, worktree count.
- **Settings** — engine config, CC model/effort level, per-type max-turns, eval loop, agent management, routing editor.
- **Document modals** — inline Q&A on any document modal. Auto-polls for live updates with scroll preservation. Back button for navigation between linked modals. Pin button for inbox/KB docs.
- **Work item artifacts** — output logs, inbox notes (or KB entries after consolidation), branch, source plan, PR links shown as clickable pills in work item detail modal.
- **Pipeline visualization** — horizontal node chain showing stages with type icons, status colors (pulse animation on running), arrows, condition forks, wait durations, loop indicators, and stop conditions. Compact mode on cards, full mode in detail modal.

## Project Config

When you run `minions add <dir>`, it prompts for project details and saves them to `config.json`. Each project entry looks like:

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
    "pullRequests": { "enabled": true, "path": ".minions/pull-requests.json" },
    "workItems":    { "enabled": true, "path": ".minions/work-items.json" }
  }
}
```

**Key fields:**
- `description` — critical for auto-routing. Agents read this to decide which repo to work in.
- `repoHost` — `"ado"` (Azure DevOps) or `"github"`. Controls which repo-host tooling agents use for PR creation, review comments, and status checks. Defaults to `"ado"`.
- `repositoryId` — required for ADO (the repo GUID), optional for GitHub.
- `adoOrg` — ADO organization or GitHub org/user.
- `adoProject` — ADO project name (leave blank for GitHub).
- `workSources` — toggle which work sources the engine scans for each project.

Per-project runtime state is stored centrally at `~/.minions/projects/<project-name>/work-items.json` and `~/.minions/projects/<project-name>/pull-requests.json`.

### Auto-Discovery

When you run `minions add`, the tool automatically detects what it can from the repo:

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

## Repo Host Tooling

Agents need repo-host tooling to create PRs, post review comments, check status, and handle review feedback. GitHub repos use `gh`. Azure DevOps repos should use the `az` CLI first and keep the Azure DevOps MCP server available only as a fallback when `az` is unavailable or does not support the required operation.

Agents inherit MCP servers directly from `~/.claude.json` as Claude Code processes — add fallback servers there and they're immediately available to all agents on next spawn.

Manually refresh with `minions mcp-sync`.

### GitHub Users

For GitHub repos, install and authenticate the [GitHub CLI](https://cli.github.com/). Agents should use `gh` for GitHub PR creation, PR lookup, comments, reviews, issues, and workflow checks. If GitHub or Copilot auth fails, refresh GitHub credentials with `gh auth status` and `gh auth login`, or provide `GH_TOKEN`/`COPILOT_GITHUB_TOKEN` from the environment. Azure DevOps authentication and tooling paths do not apply to GitHub repo work.

### Azure DevOps Users

For the best experience with ADO repos, install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) with the Azure DevOps extension. Agents should use the `az` CLI first for Azure DevOps operations such as PR creation, PR lookup, comments, reviewers, work items, and pipelines. Use the Azure DevOps MCP fallback only when `az` is unavailable in the environment or insufficient for a specific action.

```bash
# Install Azure CLI
winget install Microsoft.AzureCLI   # Windows
brew install azure-cli               # macOS
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash  # Linux

# Install/enable the Azure DevOps extension, then login and set defaults
az extension add --name azure-devops
az login
az devops configure --defaults organization=https://dev.azure.com/YOUR_ORG project=YOUR_PROJECT
```

Optionally add the [Azure DevOps MCP server](https://github.com/microsoft/azure-devops-mcp) to your Claude Code settings (`~/.claude.json`) as a fallback. The engine will auto-sync it to all agents on next start.

## Work Items

All work items use the shared `playbooks/work-item.md` template, which provides consistent branch naming, worktree workflow, PR creation steps, and status tracking.

**Per-project** — scoped to one repo. Select a project in the Command Center dropdown.

**Central (auto-route)** — agent gets all project descriptions and decides where to work. Use "Auto (agent decides)" in the dropdown, or `minions work "title"`. Can span multiple repos.

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

The engine discovers work from 4 sources, in priority order:

| Priority | Source | Dispatch Type |
|----------|--------|---------------|
| 1 | Pull requests (changes-requested, human feedback, build failures, pending review) | `fix`, `review`, `test` |
| 2 | Plan items (`plans/*.json`, approved) | `implement` |
| 3 | Per-project work items | item's `type` |
| 4 | Central work items (project-agnostic tasks) | item's `type` |

Each item passes through: dedup (checks pending, active, AND recently completed), cooldown, and agent availability gates. See `docs/auto-discovery.md` for the full pipeline.

## Agent Execution

### Spawn Chain

**Agent dispatch** (engine agents):
```
engine.js spawnAgent()
  → builds prompt BEFORE worktree (parallel — no dependency on worktree path)
  → git worktree add (write tasks only, 20-60s)
  → spawn node spawn-agent.js <prompt.md> <sysprompt.md> <args...>
    → resolves claude binary path (cached in claude-caps.json)
    → spawn node cli.js -p --system-prompt-file <file> <args...>
      → prompt piped via stdin
```

**CC/doc-chat** (direct spawn — bypasses spawn-agent.js):
```
dashboard.js ccCall()
  → llm.js callLLM({ direct: true })
    → reads cached binary from claude-caps.json
    → writes system prompt to temp file
    → spawns claude CLI directly (1 process, 3 syscalls)
      → prompt piped via stdin
```

No bash or shell involved — Node spawns Node directly. Dependency branches are fetched in parallel via `Promise.allSettled`.

### What Each Agent Gets

- **System prompt** — lean (~2-4KB) identity + rules only
- **Task prompt** — rendered playbook with `{{variables}}` filled from config, plus bulk context (charter, history, project context, active PR/dispatch context, team notes). Skills/KB are referenced by path and loaded on-demand.
- **Working directory** — project root (agent creates worktrees as needed)
- **MCP servers** — inherited from `~/.claude.json` (no extra config needed)
- **Full tool access** — all built-in tools plus all MCP tools
- **Permission mode** — `bypassPermissions` (no interactive prompts)
- **Output format** — `stream-json` (real-time streaming for live dashboard + completion recovery)

### Post-Completion

When an agent finishes:
1. Output saved to `agents/<name>/output.log`
2. Agent status derived from `engine/dispatch.json` (done/error/working)
3. Work item status updated (done/failed, with auto-retry up to 3x)
4. PRs auto-synced from output → correct project's `pull-requests.json` (per-URL matching)
5. "No PR" detection — implement/fix tasks that complete without creating a PR get flagged (`noPr: true`)
6. Plan completion check — if all PRD items done, creates verification task + archives plan
7. Agent history updated (last 20 tasks)
8. Quality metrics updated (tokens, cost, approval rates)
9. Review feedback created for PR authors (if review task)
10. Learnings checked in `notes/inbox/`
11. Skills auto-extracted from ` ```skill ` blocks in output
12. Temp files cleaned up

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
| `verify.md` | Plan completion: build all repos, start webapp, write testing guide |
| `decompose.md` | Break large work items into 2-5 sub-tasks |
| `meeting-investigate.md` | Meeting round 1: research the topic |
| `meeting-debate.md` | Meeting round 2: debate approaches |
| `meeting-conclude.md` | Meeting round 3: synthesize conclusion |

All playbooks use `{{template_variables}}` filled from project config. Conditional blocks `{{#key}}...{{/key}}` are included only when the variable is truthy. Common rules from `playbooks/shared-rules.md` are auto-injected into every playbook.

Every playbook has an explicit "When to Stop" section telling agents exactly what constitutes completion. Code-pushing playbooks enforce **build → test → repo checks → push** ordering. Per-type max-turns prevent runaway tool loops (explore=30, ask=20, implement=75, verify=100).

Playbooks are fully customizable — edit the shared templates in `playbooks/` to change the repo-wide defaults. You can also create machine-local overrides in `projects/<name>/playbooks/<type>.md`; Minions will prefer those for that project, but they are treated as user data and remain gitignored. System prompts for CC and plan advisor live in `prompts/` with `{{variable}}` substitution.

## Health Monitoring

### Liveness Check (every tick)

Agent liveness mirrors a normal CLI process:
- **Tracked process alive** → keep running, even if stdout/stderr are quiet
- **Tracked process exceeds `agentTimeout`** → stop and mark timed out
- **Tracked process exits** → handle normal completion/failure
- **No tracked process + stale output** → treat as an orphan from engine restart/process loss and mark failed

Builds, dependency installs, tests, and other CLI commands can legitimately produce no output for long periods. The engine does not infer "hung" from stdout/stderr silence while it still has a live process handle. `heartbeatTimeout` is only the stale-orphan grace window used when the engine has lost process tracking.

### Automated Cleanup (every 10 ticks)

| What | Condition |
|------|-----------|
| Temp prompt/sysprompt files | >1 hour old |
| `live-output.log` for idle agents | >1 hour old |
| Git worktrees for merged/abandoned PRs | PR status is `merged`/`abandoned`/`completed` |
| Orphaned worktrees | >24 hours old, no active dispatch references them |
| Zombie processes | In memory but no matching dispatch |

Manual cleanup: `minions cleanup`

## Self-Improvement Loop

Six mechanisms that make the minions get better over time:

### 1. Learnings Inbox → notes.md
Agents write findings to `notes/inbox/`. Engine consolidates at 5+ files using Haiku LLM summarization (regex fallback) into `notes.md` — categorized with source references. Auto-prunes at 50KB. Injected into every future playbook.

### 6. Knowledge Base
`knowledge/` stores full notes by category: architecture, conventions, project-notes, build-reports, reviews. Browsable in dashboard with inline Q&A (Haiku-powered).

### 2. Per-Agent History
`agents/{name}/history.md` tracks last 20 tasks with timestamps, results, projects, and branches. Injected into the agent's system prompt so it remembers past work.

### 3. Review Feedback Loop
When a reviewer flags issues, the engine creates `feedback-<author>-from-<reviewer>.md` in the inbox. The PR author sees the feedback in their next task.

### 4. Quality Metrics
`engine/metrics.json` tracks per agent: tasks completed, errors, PRs created/approved/rejected, reviews done. Visible in CLI (`status`) and dashboard with color-coded approval rates.

### 5. Skills
Agents save Minions-wide repeatable workflows as user-level Claude skills in `~/.claude/skills/<name>/SKILL.md`, so they are usable both inside Minions and in normal Claude windows. Repo-specific skills can also be stored per-project at `<project>/.claude/skills/<name>/SKILL.md` (requires a PR). Visible in the dashboard Skills section.

See `docs/self-improvement.md` for the full breakdown.

## Configuration Reference

Engine behavior is controlled via `config.json`. Key settings:

```json
{
  "engine": {
    "tickInterval": 60000,
    "maxConcurrent": 5,
    "agentTimeout": 18000000,
    "heartbeatTimeout": 300000,
    "maxTurns": 100,
    "inboxConsolidateThreshold": 5,
    "worktreeCreateTimeout": 300000,
    "worktreeCreateRetries": 1
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `tickInterval` | 60000 (1min) | Milliseconds between engine ticks |
| `maxConcurrent` | 5 | Max agents running simultaneously |
| `agentTimeout` | 18000000 (5h) | Max total agent runtime |
| `heartbeatTimeout` | 300000 (5min) | Stale-orphan grace after process tracking is lost |
| `maxTurns` | 100 | Max Claude CLI turns per agent session |
| `inboxConsolidateThreshold` | 5 | Inbox files needed before consolidation |
| `worktreeCreateTimeout` | 300000 (5min) | Timeout for each `git worktree add` attempt |
| `worktreeCreateRetries` | 1 | Retry count for transient `git worktree add` failures (0-3) |
| `worktreeRoot` | `../worktrees` | Where git worktrees are created |
| `idleAlertMinutes` | 15 | Alert after no dispatch for this many minutes |
| `restartGracePeriod` | 1200000 (20min) | Grace period for agent re-attachment after engine restart |
| `shutdownTimeout` | 300000 (5min) | Max wait for active agents during graceful shutdown (SIGTERM/SIGINT) |
| `allowTempAgents` | false | Spawn ephemeral agents when all permanent agents are busy |
| `autoDecompose` | true | Auto-decompose `implement:large` items into sub-tasks before dispatch |
| `autoApprovePlans` | false | Auto-approve PRDs without waiting for human approval |
| `evalLoop` | true | Auto-dispatch review → fix cycles after implementation completes |
| `evalMaxIterations` | 3 | Max minion review → fix cycles before pausing minion review automation; human feedback, build fixes, and conflict fixes continue |
| `evalMaxCost` | null | USD ceiling per work item across all eval iterations (null = no limit) |
| `meetingRoundTimeout` | 600000 (10min) | Timeout per meeting round before auto-advance |
| `ccModel` | `sonnet` | Model for Command Center and doc-chat (sonnet/haiku/opus) |
| `ccEffort` | null | Effort level for CC/doc-chat (null/low/medium/high) |
| `agentEffort` | null | Override effort level for all agent dispatches |
| `maxTurnsByType` | `{}` | Per-type max-turns override (e.g., `{"explore": 40, "fix": 100}`) |
| `maxBuildFixAttempts` | 3 | Max auto-fix dispatches per PR before escalating |

Per-type max-turns defaults (when `maxTurnsByType` not set): explore=30, ask=20, review=30, plan=30, decompose=15, plan-to-prd=20, implement=75, fix=75, test=50, verify=100. Configurable from the Settings page.

### Scheduled Tasks

Add recurring work via `config.schedules`:

```json
{
  "schedules": [
    {
      "id": "nightly-tests",
      "cron": "0 2 *",
      "type": "test",
      "title": "Nightly test suite",
      "project": "MyProject",
      "agent": "dallas",
      "enabled": true
    }
  ]
}
```

Cron format is simplified 3-field: `minute hour dayOfWeek` (0=Sun..6=Sat). Supports `*`, `*/N`, and specific values. Examples:
- `0 2 *` — 2am daily
- `0 9 1` — 9am every Monday
- `*/30 * *` — every 30 minutes
- `0 9 1,3,5` — 9am Mon/Wed/Fri

### Graceful Shutdown

The engine handles `SIGTERM` and `SIGINT` (Ctrl+C) gracefully:
1. Stops accepting new work (enters `stopping` state)
2. Waits for active agents to finish (up to `shutdownTimeout`, default 5 minutes)
3. Exits cleanly

Active agents continue running as independent processes and will be re-attached on next engine start.

### Task Decomposition

Work items with `complexity: "large"` or `estimated_complexity: "large"` are auto-decomposed before dispatch (controlled by `engine.autoDecompose`, default `true`). The engine dispatches a `decompose` agent that breaks the item into 2-5 smaller sub-tasks, each becoming an independent work item with dependency tracking.

### Temporary Agents

Set `engine.allowTempAgents: true` to let the engine spawn ephemeral agents when all 5 permanent agents are busy. Temp agents:
- Get a `temp-{id}` identifier
- Use a minimal system prompt (no charter)
- Are auto-cleaned up after task completion
- Count toward `maxConcurrent` slots

### Live Output Streaming

The dashboard polls agent output every 3 seconds via `GET /api/agent/:id/live`. An SSE endpoint (`/api/agent/:id/live-stream`) is also available but polling is preferred to avoid HTTP/1.1 connection exhaustion.

## Node.js Upgrade Caution

The engine and all spawned agents use the Node binary that started the engine (`process.execPath`). After upgrading Node, restart the engine:

```bash
minions stop
minions start
```

## Portability

**Portable (works on any machine):** Engine code, dashboard, playbooks, charters, docs, `config.template.json`.

**Machine-specific (reconfigure per machine):**
- `config.json` — contains absolute paths to project directories. Re-link via `minions add <dir>`.

**Generated at runtime:** routing, notes, knowledge, skills, plans, PRDs, work items, dispatch queue, metrics — all created by the engine as agents work.

To move to a new machine: `npm install -g @yemi33/minions && minions init --force`, then re-run `minions add` for each project.

## File Layout

```
~/.minions/
  bin/
    minions.js             <- Unified CLI entry point (npm package)
  minions.js               <- Project management: init, add, remove, list
  engine.js              <- Engine daemon + orchestrator
  engine/
    shared.js            <- Shared utilities: IO, process spawning, config helpers
    queries.js           <- Read-only state queries (used by engine + dashboard)
    cli.js               <- CLI command handlers (start, stop, status, plan, etc.)
    lifecycle.js          <- Post-completion hooks, plan chaining, PR sync, metrics
    consolidation.js     <- Haiku-powered inbox consolidation, knowledge base
    ado.js               <- ADO token management, PR polling, PR reconciliation
    llm.js               <- callLLM() with session resume, trackEngineUsage()
    spawn-agent.js       <- Agent spawn wrapper (resolves claude cli.js)
    preflight.js         <- Prerequisite checks (Node, Git, Claude CLI, API key)
    scheduler.js         <- Cron-style scheduled task discovery
    pipeline.js          <- Multi-stage pipeline orchestration
    meeting.js           <- Meeting creation, rounds, conclusion
    cleanup.js           <- Worktree + temp file cleanup
    timeout.js           <- Agent timeout and orphan detection
    cooldown.js          <- Dispatch cooldown with exponential backoff
    github.js            <- GitHub PR polling, comment polling, reconciliation
    routing.js           <- Agent routing and temp agent management
    dispatch.js          <- Dispatch queue mutations (add, complete, retry)
    ado-mcp-wrapper.js   <- ADO MCP authentication wrapper
    check-status.js      <- Quick status check without full engine load
    control.json         <- running/paused/stopped (runtime, generated)
    dispatch.json        <- pending/active/completed queue (runtime, generated)
    log.json             <- Audit trail, capped at 2500 (runtime, generated)
    metrics.json         <- Per-agent quality metrics (runtime, generated)
    cooldowns.json       <- Dispatch cooldown tracking (runtime, generated)
    schedule-runs.json   <- Last-run timestamps for scheduled tasks (runtime, generated)
    pipeline-runs.json   <- Pipeline run history per pipeline (runtime, generated)
  dashboard.js           <- Web dashboard server
  dashboard/
    layout.html          <- Page layout shell with sidebar navigation
    styles.css           <- Dashboard CSS (dark theme, responsive)
    pages/               <- HTML fragments per page (work, plans, engine, etc.)
    js/                  <- JS modules: render-*.js, utils, refresh, settings, command-center
  config.json            <- projects[], agents, engine, claude settings (generated by minions init)
  config.template.json   <- Template for new installs
  package.json           <- npm package definition
  plans/                 <- Approved plans: plans/{project}-{date}.json (generated)
  prd/                   <- PRD archives and verification guides (generated)
  pipelines/             <- Pipeline definitions (generated)
  meetings/              <- Meeting state files (generated)
  knowledge/             <- KB: architecture, conventions, project-notes, build-reports, reviews (generated)
  routing.md             <- Dispatch rules table (generated, editable)
  notes.md               <- Team rules + consolidated learnings (generated)
  work-items.json        <- Central work queue (generated)
  prompts/
    cc-system.md         <- Command Center system prompt (editable, {{minions_dir}} substitution)
    plan-advisor-system.md <- Plan review advisor prompt (editable, {{plan_path}} substitution)
  playbooks/
    shared-rules.md      <- Common rules injected into ALL playbooks automatically
    work-item.md         <- Generic fallback template
    implement.md         <- Build a PRD item (build → test → push → PR)
    implement-shared.md  <- Implement on a shared branch (no individual PR)
    review.md            <- Review a PR (comment + vote)
    fix.md               <- Fix review feedback (build → test → push)
    explore.md           <- Codebase exploration (write findings to inbox)
    ask.md               <- Answer a question (write answer to inbox)
    test.md              <- Run tests (write findings to inbox)
    build-and-test.md    <- Build project and run test suite
    plan-to-prd.md       <- Convert plan to structured PRD JSON
    plan.md              <- Generate a plan from user request
    verify.md            <- Plan verification: merge, build, test, testing guide, E2E PR
    decompose.md         <- Break large work items into 2-5 sub-tasks
    meeting-investigate.md <- Meeting round 1: research
    meeting-debate.md    <- Meeting round 2: debate
    meeting-conclude.md  <- Meeting round 3: conclude
    templates/
      verify-guide.md    <- Verification report template (lazy-loaded by verify agent)
  skills/                <- Agent-created reusable workflows (generated)
  agents/
    {name}/
      charter.md         <- Agent identity and boundaries (editable)
      history.md         <- Task history, last 20 (runtime, generated)
      live-output.log    <- Streaming output while working (runtime, generated)
      output.log         <- Final output after completion (runtime, generated)
  identity/
    now.md               <- Engine-generated state snapshot (runtime, generated)
  notes/
    inbox/               <- Agent findings drop-box (generated)
    archive/             <- Processed inbox files (generated)
  docs/
    auto-discovery.md    <- Auto-discovery pipeline docs
    self-improvement.md  <- Self-improvement loop docs
    plan-lifecycle.md    <- Full plan pipeline: plan → PRD → implement → verify
    command-center.md    <- Command Center usage and features
    engine-restart.md    <- Engine restart and recovery procedures

Each linked project keeps locally:
  <project>/.claude/
    skills/              <- Project-specific skills (requires PR)

Per-project engine state remains centralized:
  ~/.minions/projects/<project-name>/
    work-items.json      <- Per-project work queue
    pull-requests.json   <- PR tracker
```
