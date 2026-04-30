# Engine Restart & Agent Survival

## The Problem

When the engine restarts, it loses its in-memory process handles (`activeProcesses` Map). Claude CLI agents spawned before the restart may still be running as OS processes, but the engine can't monitor their process state, detect exit codes, or manage their lifecycle. Stale-orphan detection keeps these dispatch records from staying active forever after the restart grace period expires.

## What's Persisted vs Lost

| State | Storage | Survives Restart |
|-------|---------|-----------------|
| Dispatch queue (pending/active/completed) | `engine/dispatch.json` | Yes |
| Agent status (working/idle/error) | Derived from `engine/dispatch.json` | Yes |
| Agent live output | `agents/*/live-output.log` | Yes (mtime used for orphan cleanup) |
| Process handles (`ChildProcess`) | In-memory Map | **No** |
| Cooldown timestamps | In-memory Map | **No** (repopulated from `engine/cooldowns.json`) |

## Protection Mechanisms

### 1. Grace Period on Startup (20 min default)

When the engine starts and finds active dispatches from a previous session, it sets `engineRestartGraceUntil` to `now + 20 minutes`. During this window, orphan detection is completely suppressed — agents won't be killed even if the engine has no process handle for them.

Configurable via `config.json`:
```json
{
  "engine": {
    "restartGracePeriod": 1200000
  }
}
```

### 2. Process-Based Liveness

After the grace period expires, a dispatch with a tracked live process keeps running until the process exits or exceeds `engine.agentTimeout`. Quiet stdout/stderr alone is not a hang signal; long builds, dependency installs, and tests can legitimately be silent.

If there is no live tracked process, the engine uses `live-output.log` mtime as indirect evidence. Once the log is stale for `engine.heartbeatTimeout`, the dispatch is treated as an orphan and marked failed.

### 3. Stop Warning

`engine.js stop` checks for active dispatches and warns:
```
WARNING: 2 agent(s) are still working:
  - Dallas: [office-bohemia] Build & test PR PR-4959092
  - Rebecca: [office-bohemia] Review PR PR-4964594

These agents will continue running but the engine won't monitor them.
On next start, they'll get a 20-min grace period before being marked as orphans.
To kill them now, run: node engine.js kill
```

### 4. Exponential Backoff on Failures

If an agent is killed as an orphan and the work item retries, cooldowns use exponential backoff (2^failures, max 8x) to prevent spam-retrying broken tasks.

## Safe Restart Pattern

```bash
node engine.js stop       # Check the warning — are agents working?
# If yes, decide: wait for them to finish, or accept the grace period
# Make your code changes
node engine.js start      # Grace period kicks in for surviving agents
```

## What the Engine Cannot Do

- **Reattach to processes** — Node.js `child_process` doesn't support adopting external PIDs. Once the process handle is lost, the engine can only observe the agent indirectly via file output.
- **Guarantee completion** — An agent that finishes during a restart will have its output saved to `live-output.log`, but the engine won't run post-completion hooks (PR sync, metrics update, learnings check). These are picked up on the next tick via output file scanning.
- **Resume mid-task** — If an agent is killed (by orphan detection or timeout), the work item is marked failed. It can be retried but starts from scratch.

## Timeline of a Restart

```
T+0s     engine.js stop (warns about active agents)
         Engine process exits. Agents keep running as OS processes.

T+30s    Code changes made. engine.js start.
         Engine reads dispatch.json — finds 2 active items.
         Sets grace period: 20 min from now.
         Logs: "2 active dispatch(es) from previous session"

T+0-20m  Ticks run. Orphan detection skipped (grace period).
         If an agent finishes, output is written to live-output.log.
         Engine detects completed output on next tick via file scan.

T+20m    Grace period expires.
          Stale-orphan detection resumes.
          Dispatch with live tracked process → keep running.
          Dispatch with no live process and stale output → orphaned.
```
