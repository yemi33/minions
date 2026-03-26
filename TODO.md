# Minions — Future Improvements

Ordered by difficulty: quick wins first, larger efforts later.

---

## Quick Wins (< 1 hour each)

- [x] **Output.log append, not overwrite** — per-dispatch archive at `output-{id}.log` + latest copy at `output.log`
- [x] **Persistent cooldowns** — saved to `engine/cooldowns.json`, loaded at startup, 24hr auto-prune
- [x] **Worktree cleanup on merge/close** — `handlePostMerge` removes worktrees when PR merges or is abandoned
- [x] **Discovery skip logging** — PRD and work item discovery log skip counts by reason at debug level
- [x] **Idle threshold alert** — warns when all agents idle >15min (configurable via `engine.idleAlertMinutes`)
- [x] **Config validation at startup** — checks agents, project paths, playbooks, routing.md. Fatal errors exit(1).
- [x] **macOS/Linux browser launch** — already platform-aware (was done previously)
- [x] **Health check endpoint** — `GET /api/health` returning engine state, agents, project reachability, uptime
- [x] **Fan-out per-agent timeout** — fan-out items carry `meta.deadline`, configurable via `engine.fanOutTimeout`

## Small Effort (1–3 hours each)

- [x] **Auto-retry with backoff** — when an agent errors, auto-retry with exponential backoff (up to 8x, cap at 3 attempts). Implemented in completeDispatch + cooldown system.
- [ ] **Auto-escalation** — if an agent errors 3 times in a row, pause their dispatch and alert via dashboard/Teams
- [x] **Post-merge hooks** — `handlePostMerge`: worktree cleanup, PRD status → implemented, prsMerged metric, Teams notification
- [x] **Pending dispatch explanation** — `_pendingReason` on work items + `skipReason` on dispatch items. Dashboard shows why items are stuck.
- [x] **Work item editing** — `POST /api/work-items/update` endpoint + edit button on dashboard work item cards. Supports pending/failed items.
- [ ] **Bulk operations** — retry/delete/reassign multiple work items at once
- [ ] **Per-dispatch artifact archive** — `artifacts/<agent>/<dispatch-id>/` preserving output.log, live-output.log, inbox findings. Never overwritten, indexed by dispatch ID.
- [x] **Graceful shutdown** — SIGTERM/SIGINT handlers wait for active agents with configurable `shutdownTimeout` (default 5min). Engine enters `stopping` state.
- [ ] **Shell-agnostic playbooks** — remove PowerShell-specific instructions when running on non-Windows
- [x] **Build failure notification to author** — `writeInboxAlert` notifies author agent with PR ID, branch, and build fail reason. `_buildFailNotified` flag prevents duplicates.
- [ ] **Work item status updates** — show dispatched agent progress in dashboard, link to PRs created

## Medium Effort (3–8 hours each)

- [x] **GitHub PR status polling** — `engine/github.js` equivalent of `engine/ado.js`: poll GitHub Actions check runs and PR review status via GitHub REST API. Auto-detect `repoHost: 'github'` in project config. Enables build failure auto-fix and review dispatch for GitHub repos.
- [x] **GitHub PR creation support** — Enriched `getPrCreateInstructions`, `getPrCommentInstructions`, `getPrFetchInstructions`, `getPrVoteInstructions` with detailed `gh` CLI instructions including `--repo owner/repo`.

- [ ] **Dispatch lifecycle timeline** — for each work item, show: created → queued → dispatched (agent, time) → completed/failed (duration, result). Requires tracking events per item.
- [ ] **Adaptive routing** — use quality metrics (approval rate, error rate) to adjust routing preferences. Deprioritize underperforming agents, promote high-performers.
- [x] **Cascading dependency awareness** — if work item A blocks B, and A fails, mark B as `failed` with cascade alert. `depends_on` honored in areDependenciesMet + discoverFromWorkItems.
- [ ] **Error pattern detection** — aggregate failed dispatches by type/project. If 3+ failures share the same error, surface an alert instead of dispatching more agents into the same wall.
- [ ] **Shared scratchpad** — in-progress workspace where agents working on related tasks can leave notes for each other without waiting for inbox consolidation
- [ ] **Proactive work discovery** — agents can propose work items by writing to `proposals/` inbox, engine reviews and promotes to work queue
- [x] **Scheduled tasks** — `engine/scheduler.js` with 3-field cron parser (`minute hour dayOfWeek`), `config.schedules[]` support, `schedule-runs.json` tracking. Zero dependencies.
- [ ] **Work item → PR → review chain view** — trace a work item through its full lifecycle in the dashboard UI
- [ ] **Auto-trigger new PRD analysis** — when all PRD items are complete/done, automatically dispatch Lambert to generate the next version
- [ ] **Artifact query for agents** — inject recent artifact summaries into agent prompts so they can reference past investigations

## Large Effort (1–2 days each)

- [ ] **Agent message board** — agents can post tagged messages to specific agents or all agents. Injected into recipient's next prompt. Requires message format, routing, expiry, and prompt injection.
- [ ] **Handoff protocol** — agent can mark a task as "blocked on X" or "ready for Y", engine picks up dependencies and sequences dispatch accordingly
- [ ] **Idle task system** — when all work sources are empty, engine assigns background tasks by agent role (Ripley: explore, Lambert: audit docs, Dallas: run tests, Rebecca: check infra)
- [x] **Live agent output streaming** — SSE endpoint `GET /api/agent/:id/live-stream` with `fs.watchFile` at 500ms. Dashboard uses `EventSource` with polling fallback.
- [x] **Task decomposition** — `implement:large` items auto-routed to `decompose` playbook. Agent outputs JSON sub-items, engine creates child work items with `parent_id` and dependency chains.
- [ ] **Artifact browser in dashboard** — browse past dispatch artifacts, view reasoning chains, search across agent outputs
- [x] **Temp agent support** — `engine.allowTempAgents` opt-in. `resolveAgent` spawns `temp-{uid}` when all permanent agents busy. Auto-cleanup of temp agent directories on completion.
- [ ] **Skill editor** — create/edit skills directly in the dashboard UI
- [ ] **PRD diffing** — show what changed between PRD versions in the dashboard

## Ambitious (multi-day)

- [ ] **Dedicated ops agent** — permanent 6th agent scoped to housekeeping: cleanup, status checks, metric collection. Never assigned feature work.

