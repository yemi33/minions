# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Squad — Project Instructions

## Repository Remotes

- **origin** (`yemishin_microsoft/squad`) — The org repo. This is the personal "save all progress" repo containing full session history, decisions, notes, and work items. Push everything here.
- **personal** (`yemi33/squad`) — The distribution repo for others. Must contain only the barebones engine needed to get started and customize. All session-specific data is stripped during sync (see `/sync-to-personal` skill).

When syncing to personal, the following are stripped: agent history, decisions (archive + inbox + summary), work items, and notes. What remains is the engine, dashboard, playbooks, agent charters, skills, docs, and config template — everything a first-time user needs to clone and run.

## Build & Run

```bash
node engine.js start    # Start engine (ticks every 60s)
node dashboard.js       # Dashboard at http://localhost:7331
node engine.js stop     # Stop engine
node engine.js status   # Show current state
```

No dependencies — uses only Node.js built-ins.

## Key Files

- `engine.js` — Engine daemon (dispatch, discovery, agent spawn, cleanup)
- `dashboard.js` + `dashboard.html` — Web dashboard (single-file HTML served by Node)
- `squad.js` — CLI for init/add/remove projects
- `config.json` — Machine-specific project config (not distributed; use `config.template.json`)
- `playbooks/*.md` — Task templates with `{{variables}}`
- `agents/*/charter.md` — Agent role definitions
- `routing.md` — Dispatch routing rules
- `plans/` — Approved plans (`plans/{project}-{date}.json`), materialized as work items by engine
- `knowledge/` — Knowledge base (categories: architecture, conventions, project-notes, build-reports, reviews)

## Engine Module Structure

`engine.js` is the core orchestrator (~2,450 lines). It imports from these modules in `engine/`:

| Module | Purpose |
|--------|---------|
| `cli.js` | All CLI commands (start, stop, status, plan, discover, spawn, queue, etc.) |
| `lifecycle.js` | Post-completion hooks, plan→PRD chaining, PR sync, metrics, post-merge cleanup |
| `consolidation.js` | Haiku-powered inbox consolidation, regex fallback, knowledge base classification |
| `ado.js` | ADO token management (`azureauth`), PR status polling, human `@squad` comment polling |
| `llm.js` | Shared Haiku call wrapper used by both engine and dashboard (triage, doc-chat, steer, ask-about) |
| `shared.js` | IO helpers (`safeRead`/`safeWrite` with Windows EPERM retry), path resolvers, config loading |
| `spawn-agent.js` | Spawns `claude` CLI with prompt files piped via stdin |

Circular dependencies between modules are handled with lazy `require()` inside functions.

## Core Loop

`tick()` runs every ~30s: check agent timeouts → consolidate inbox → periodic cleanup → poll ADO PR status → poll PR human comments → discover work from all sources → update snapshot → dispatch pending items (priority: fix > review > plan > implement).

## How Work Flows

1. **Discovery** scans three sources: `pull-requests.json` (reviews, fixes, build failures, human `@squad` feedback), per-project `work-items.json`, and central `work-items.json`
2. **Routing** — `routing.md` is a markdown table mapping work types to preferred/fallback agents
3. **Playbooks** — `playbooks/*.md` are templates rendered with `{{variables}}` (agent context, project info, `notes.md` content)
4. **Dispatch** — Items queue in `engine/dispatch.json`, sorted by priority, dispatched up to `maxConcurrent` slots
5. **Spawn** — Creates a git worktree, builds system prompt from agent charter, spawns `claude` CLI
6. **Completion** — Post-hooks: sync PRs from output, update work items, check plan completion, update history/metrics
7. **Consolidation** — Agent findings in `notes/inbox/` are consolidated by Haiku into `notes.md`, which is injected into every future agent prompt

## Key State Files

- `engine/control.json` — Engine state (running/paused/stopped), PID, heartbeat
- `engine/dispatch.json` — Pending, active, completed dispatch items
- `engine/metrics.json` — Per-agent token/cost tracking, `_engine` for Haiku overhead, `_daily` aggregates

## Important Conventions

- All file I/O must use `safeRead`/`safeWrite` from `engine/shared.js` (Windows EPERM retry)
- Dashboard caches HTML at startup — restart requires killing PID on port 7331 with `taskkill //PID <pid> //F`
- ADO API calls go through `adoFetch()` in `engine/ado.js` (auto-refreshes tokens)
- `engine.js` exports internals via `module.exports`; CLI entrypoint guarded with `require.main === module`
- Multi-project config: `config.json` has a `projects` array, each with `localPath`, `repositoryId`, `adoOrg`, `adoProject`, `workSources`
