# Blog: First Successful Agent Dispatch — The Spawn Debugging Saga

**Date:** 2026-03-12
**Author:** Minions Team + Claude Opus 4.6
**Result:** PR #4959092 created by Dallas on office-bohemia

## The Task

Simple ask: add a `/cowork` route to the bebop webapp, referencing an existing commit as a pattern. Created via the dashboard Command Center as a central work item (auto-route, agent decides which project).

## What Went Wrong (7 Failed Attempts)

### Attempt 1-2: Shell Metacharacter Explosion

The engine spawned agents via bash:
```bash
claude -p "$(cat 'prompt.md')" --system-prompt "$(cat 'sysprompt.md')" ...
```

The prompt contained parentheses, backticks, and special characters:
```
Each repo has its own ADO config (org, project, repoId) — use the correct one per repo
```

Bash interpreted `(org, project, repoId)` as a subshell command. **Silent failure** — no error logged, agent process died instantly.

### Attempt 3-4: Direct Spawn Without Shell

Switched to `spawn('claude', args)` — no bash wrapper. But on Windows, `claude` is a POSIX shell script (`#!/bin/sh`), not a binary. Node's `spawn` without `shell: true` couldn't execute it. **Process returned no PID**, error callback never fired.

### Attempt 5: Shell True With Content Args

Added `shell: true` to the spawn. But now the `--system-prompt` arg (3KB of text with special chars) got shell-interpreted again. Same metacharacter problem, different location.

### Attempt 6: Node Wrapper Script

Created `spawn-agent.js` — a Node wrapper that reads files and calls claude. Engine spawns `node spawn-agent.js <files> <args>`. Wrapper uses `shell: true` to find claude binary. **Same problem** — system prompt content as a CLI arg still gets shell-expanded.

### Attempt 7: The Actual Fix

Realized the claude shell wrapper at `/c/.tools/.npm-global/claude` just calls:
```sh
exec node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" "$@"
```

**Solution:** Resolve the actual `cli.js` entry point and spawn it directly via `process.execPath` (the current node binary). No shell involved at all:

```javascript
// spawn-agent.js
const proc = spawn(process.execPath, [claudeBin, ...cliArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env  // CLAUDECODE vars already stripped
});
proc.stdin.write(prompt);  // prompt via stdin — no shell interpretation
proc.stdin.end();
```

## Other Issues Discovered Along the Way

### Output Format: json vs stream-json

`--output-format json` produces **one JSON blob at exit**. No streaming output during execution. This broke live output in the dashboard and made restart recovery less observable.

Fix: switched to `--output-format stream-json` — streams events as they happen.

### Permission Mode

Agents would hang waiting for permission prompts (invisible in headless mode). Added `--permission-mode bypassPermissions`.

### CLAUDECODE Environment Variable

Claude Code sets `CLAUDECODE` env var to prevent nested sessions. Spawned agents inherit it and refuse to start. The engine strips it from `childEnv`, but the wrapper script was using `process.env` (which re-inherits from the parent). Fixed by stripping in both places.

### Process Liveness vs Stale-Orphan Detection

Original approach: kill agents after a fixed time threshold (staleThreshold). Problem: agents can legitimately run for hours on complex tasks.

New approach: rely on the tracked process while the engine has a live process handle, regardless of whether stdout/stderr are quiet. `live-output.log` mtime is only used after process tracking is lost, such as an engine restart, to clean up stale orphaned dispatches.

### Engine Restart Orphan Problem

When the engine restarts, the in-memory `activeProcesses` Map is lost. Active dispatch items stay in `dispatch.json` but the engine has no process handle. Old stale detection (6h threshold) was too slow to catch this. Stale-orphan detection uses recent `live-output.log` activity and catches abandoned dispatches after the restart grace window.

## The Successful Run

**Dispatch 1773292681199** — Dallas, central work item, auto-route:

1. Engine spawns `node spawn-agent.js prompt.md sysprompt.md --output-format stream-json --verbose --permission-mode bypassPermissions`
2. spawn-agent.js resolves `cli.js`, spawns `node cli.js -p --system-prompt <content> ...`
3. Prompt piped via stdin — no shell interpretation
4. MCP servers connect (azure-ado, azure-kusto, mobile, DevBox)
5. Dallas reads the reference commit, explores office-bohemia's route structure
6. Creates `apps/bebop/src/routes/_mainLayout.cowork.tsx`
7. Updates route tree
8. Creates git worktree, commits, pushes
9. Creates **PR #4959092** via `mcp__azure-ado__repo_create_pull_request`
10. Posts implementation notes as PR thread comment
11. Writes learnings to `decisions/inbox/dallas-2026-03-12.md`
12. Exits with code 0

**Time:** ~8 minutes from dispatch to PR created
**Output:** 70KB of stream-json events captured in `live-output.log`

## Architecture Lessons

1. **Never pass user content through shell expansion.** Use stdin or direct args via Node's `spawn` (without shell).
2. **On Windows, npm-installed CLI tools are shell wrappers.** Resolve the actual `.js` entry point and spawn via `node`.
3. **Streaming output format is essential** for live dashboards and restart recovery. One-shot JSON hides everything until exit.
4. **Environment variable inheritance is tricky** with nested spawns. Strip at every level.
5. **Process liveness beats output-silence heuristics** for agents that can run quiet CLI commands for long periods.

## The Spawn Chain (Final Working Version)

```
engine.js (tick loop)
  → spawn(process.execPath, ['spawn-agent.js', prompt.md, sysprompt.md, ...args])
    → spawn-agent.js reads files, resolves cli.js path
      → spawn(process.execPath, ['cli.js', '-p', '--system-prompt', content, ...args])
        → claude-code runs with prompt via stdin
          → agent works, streams JSON events to stdout
            → engine captures to live-output.log (dashboard + restart recovery)
            → dashboard polls /api/agent/:id/live (3s refresh)
```

No bash. No shell. No metacharacter interpretation. Just Node spawning Node.
