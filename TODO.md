# Squad — Future Improvements

## Agent Communication
- [ ] **Agent message board** — agents can post tagged messages to specific agents or all agents. Messages have sender, recipient (or "all"), subject, and expiry. Injected into recipient's next prompt.
- [ ] **Handoff protocol** — agent can mark a task as "blocked on X" or "ready for Y", engine picks up dependencies and sequences dispatch accordingly
- [ ] **Shared scratchpad** — in-progress workspace where agents working on related tasks can leave notes for each other without waiting for inbox consolidation

## Routing Improvements
- [ ] **Adaptive routing** — use quality metrics (approval rate, error rate) to adjust routing preferences. Deprioritize underperforming agents for implementation, promote high-performers.
- [ ] **Auto-escalation** — if an agent errors 3 times in a row, pause their dispatch and alert via dashboard/Teams

## PRD Lifecycle
- [ ] **Auto-trigger new PRD analysis** — when all PRD items are complete/pr-created, automatically dispatch Lambert to generate the next version
- [ ] **PRD diffing** — show what changed between PRD versions in the dashboard

## Dashboard
- [ ] **Live agent output streaming** — show real-time stdout/stderr while agents are working, not just after completion
- [ ] **Runbook editor** — create/edit runbooks directly in the dashboard UI
- [ ] **Work item status updates** — show dispatched agent progress, link to PRs created

## Engine Resilience
- [ ] **Persistent cooldowns** — save cooldown state to disk so engine restarts don't re-dispatch everything
- [ ] **Health check endpoint** — `/api/health` returning engine state, project reachability, agent statuses for monitoring
- [ ] **Graceful shutdown** — on SIGTERM, wait for active agents to finish (with timeout) before exiting

## Cross-Platform
- [ ] **macOS/Linux browser launch** — replace Windows `start` command with `open` (macOS) / `xdg-open` (Linux)
- [ ] **Shell-agnostic playbooks** — remove PowerShell-specific instructions when running on non-Windows
