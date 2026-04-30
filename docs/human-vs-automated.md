# Human vs. Automated — What Requires You, What Doesn't

## Quick Reference

| Feature | Who starts it | Who runs it | Who decides | Who recovers |
|---------|--------------|-------------|-------------|-------------|
| Work items | You (dashboard) | Engine + agent | — | You (retry) |
| Plans | You (dashboard) | Agent writes plan | You (approve/reject) | You (revise) |
| PRD items | You (dashboard) | Engine dispatches | — | You (retry) |
| PR creation | Agent (auto) | Agent | — | — |
| PR review | Engine (auto-dispatch) | Agent reviewer | Human (vote to merge) | Human (comments → auto-fix) |
| Build failures | Engine (auto-detect) | Agent (auto-fix) | — | — |
| Notes | You (`/note`) or agent (findings) | Engine (consolidate) | You (promote to KB) | — |
| Cleanup | Engine (every 10 min) | Engine | — | — |
| Metrics | Engine (auto-collect) | Engine | You (view) | — |
| Error recovery | Engine (detect) | — | You (retry/delete) | You |
| Project linking | You (`minions add/scan`) | — | — | — |
| MCP servers | You (`~/.claude.json`) | Inherited by agents | — | — |

## The Two Human Gates

Minions is designed around **two approval gates** where humans make decisions. Everything else is automated.

### Gate 1: Plan Approval

When you submit a `/plan`, an agent creates a structured plan file. The plan sits in `awaiting-approval` status until you:
- **Approve** → engine auto-dispatches all plan items
- **Reject** → plan is archived
- **Revise** → feedback sent back to agent, plan is reworked

This is the only point where you decide *what* gets built.

### Gate 2: PR Review

When agents create PRs, they need human review votes before merging. You can:
- **Approve** → PR is merge-ready
- **Comment** → engine detects `@minions` mentions, auto-dispatches a fix task
- **Request changes** → same as comment, triggers auto-fix

This is the only point where you decide if the *quality* is good enough.

## Fully Automated (Zero Human Involvement)

These run continuously without you:

- **Work discovery** — engine scans all project queues every tick (~60s)
- **Agent dispatch** — engine picks the right agent, builds the prompt, spawns Claude
- **Worktree management** — create on dispatch, pull on shared-branch, clean after merge
- **PR status polling** — checks ADO + GitHub for build status, review votes, merge state every ~12 min
- **Build failure detection** — auto-files fix tasks when CI fails
- **Inbox consolidation** — LLM-powered dedup and categorization when inbox hits threshold
- **Knowledge base classification** — auto-assigns category to consolidated notes
- **Process-based liveness** — tracks running agent processes and enforces the hard runtime limit
- **Stale-orphan detection** — cleans up dispatches after process tracking is lost
- **Metrics collection** — tracks tasks, errors, PRs, approvals per agent
- **Dispatch priority** — fixes first, then reviews, then implementations
- **Cooldown & backoff** — prevents re-dispatching recently failed items
- **Zombie cleanup** — temp files, orphaned worktrees, stale processes every 10 min
- **Post-merge hooks** — worktree cleanup, PRD status update, metrics update

## Human-Triggered, Then Autonomous

You kick these off, then they run without you:

- **Work items** — type in dashboard, engine dispatches, agent executes, PR created
- **PRD items** — `/prd` in dashboard, engine discovers and dispatches implement tasks
- **Fan-out** — one task dispatched to all idle agents in parallel
- **Retry** — click retry on failed item, engine re-dispatches fresh
- **Notes** — `/note` in dashboard, flows through inbox → consolidation → team knowledge
- **KB promotion** — click "Add to Knowledge Base", pick category, done
- **Project linking** — `minions scan` or `minions add`, engine discovers work on next tick

## Human-in-the-Loop

These pause and wait for your input:

- **Plan approval** — agent writes plan, waits for approve/reject/revise
- **Plan discussion** — interactive Claude session where you refine the plan
- **PR merge** — agents can't merge their own PRs, humans must vote
- **PR feedback cycle** — human comments → auto-fix → human re-reviews (loop until approved)

## Manual Only

These are entirely on you:

- **Project setup** — `minions init`, `minions scan`, `minions add`
- **Agent customization** — edit `agents/*/charter.md`, `routing.md`
- **Config changes** — edit `config.json` (engine settings, projects)
- **MCP server setup** — add servers to `~/.claude.json`
- **Dashboard access** — open browser to `http://localhost:7331`
- **Engine start/stop** — `node engine.js start/stop`

## What Happens When You Walk Away

If you start the engine and dashboard, then leave:

1. Engine ticks every 60 seconds
2. Discovers pending work items, PRD gaps, PR reviews needed
3. Dispatches agents (up to max concurrent)
4. Agents create worktrees, write code, create PRs
5. Engine monitors for process exit, hard timeouts, stale orphans, and build failures
6. Successful work → PRs appear in your ADO/GitHub queue
7. Failed work → marked failed, waiting for your retry
8. Notes consolidated into team knowledge automatically
9. Worktrees cleaned up after PRs merge

**What blocks:** Plans waiting for approval. PRs waiting for your review vote. Failed tasks waiting for retry. Everything else keeps moving.
