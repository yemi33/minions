# Squad — Future Improvements

## Durable Artifacts
- [ ] **Per-dispatch artifact archive** — `artifacts/<agent>/<dispatch-id>/` preserving full output.log, live-output.log, inbox findings, and any generated files. Never overwritten, indexed by dispatch ID.
- [ ] **Artifact query for agents** — inject recent artifact summaries into agent prompts so they can reference past investigations without re-doing the work
- [ ] **Artifact browser in dashboard** — browse past dispatch artifacts, view full reasoning chains, search across agent outputs
- [ ] **Output.log append, not overwrite** — keep all dispatch outputs, not just the last one. Rotate by dispatch ID.

## Agent Communication
- [ ] **Agent message board** — agents can post tagged messages to specific agents or all agents. Messages have sender, recipient (or "all"), subject, and expiry. Injected into recipient's next prompt.
- [ ] **Handoff protocol** — agent can mark a task as "blocked on X" or "ready for Y", engine picks up dependencies and sequences dispatch accordingly
- [ ] **Shared scratchpad** — in-progress workspace where agents working on related tasks can leave notes for each other without waiting for inbox consolidation

## Proactive / Idle Agent Work
- [ ] **Idle task system** — when all work sources are empty, engine assigns low-priority background tasks based on agent role:
  - Ripley: explore repos that haven't been explored recently, audit architecture docs
  - Lambert: check if PRD is stale, review docs coverage, scan for undocumented features
  - Dallas/Ralph: run test suites, check for flaky tests, lint passes
  - Rebecca: audit CI pipelines, check dependency versions, review infra health
- [ ] **Proactive work discovery** — agents can propose work items themselves (e.g., "I noticed this module has no tests") by writing to a `proposals/` inbox, engine reviews and promotes to work queue
- [ ] **Scheduled tasks** — cron-style recurring work (e.g., "every Monday Lambert regenerates the PRD", "every day Ripley explores recent commits")
- [ ] **Idle threshold alert** — if all agents are idle for >N minutes, notify via Teams/dashboard

## Ephemeral / Temp Agents
- [ ] **Temp agent support** — spawn short-lived agents for housekeeping tasks (pr-sync, skill extraction, PRD refresh) without consuming a permanent squad slot. Temp agents get a minimal system prompt, low maxTurns, and are auto-cleaned after completion. This avoids tying up named agents (Ripley, Dallas, etc.) for lightweight ops work.
- [ ] **Dedicated ops agent** — alternatively, add a permanent 6th "ops" agent with a charter scoped to housekeeping: PR syncing, cleanup, status checks, metric collection. Never assigned feature work.

## Routing Improvements
- [ ] **Adaptive routing** — use quality metrics (approval rate, error rate) to adjust routing preferences. Deprioritize underperforming agents for implementation, promote high-performers.
- [ ] **Auto-escalation** — if an agent errors 3 times in a row, pause their dispatch and alert via dashboard/Teams

## PRD Lifecycle
- [ ] **Auto-trigger new PRD analysis** — when all PRD items are complete/pr-created, automatically dispatch Lambert to generate the next version
- [ ] **PRD diffing** — show what changed between PRD versions in the dashboard

## Dashboard
- [ ] **Live agent output streaming** — show real-time stdout/stderr while agents are working, not just after completion
- [ ] **Skill editor** — create/edit skills directly in the dashboard UI
- [ ] **Work item status updates** — show dispatched agent progress, link to PRs created

## Engine Resilience
- [ ] **Persistent cooldowns** — save cooldown state to disk so engine restarts don't re-dispatch everything
- [ ] **Health check endpoint** — `/api/health` returning engine state, project reachability, agent statuses for monitoring
- [ ] **Graceful shutdown** — on SIGTERM, wait for active agents to finish (with timeout) before exiting

## Cross-Platform
- [ ] **macOS/Linux browser launch** — replace Windows `start` command with `open` (macOS) / `xdg-open` (Linux)
- [ ] **Shell-agnostic playbooks** — remove PowerShell-specific instructions when running on non-Windows
