# CLAUDE.md

Guidance for Claude Code working in this repository.

## What is Minions

Multi-agent orchestration engine that dispatches Claude Code (or Copilot) instances as autonomous agents to implement features, review PRs, fix bugs, and manage plans across multiple repositories. Two Node.js processes: an **engine** (tick-based orchestrator) and a **dashboard** (web UI on port 7331). Zero deps beyond Node built-ins. No build step.

## Commands

```bash
minions restart   # Engine + dashboard
minions start     # Engine only
minions dash      # Open dashboard
npm test          # Unit (test/unit.test.js)
npm run test:all  # Unit + integration (needs dashboard)
npm run test:e2e  # Playwright
```

## Architecture

### Tick Cycle (engine.js, 60s)

```
checkTimeouts + checkSteering + checkIdleThreshold → meetingTimeouts →
consolidateInbox → cleanup (10t) → checkWatches (3t) →
pollPrStatus (prPollStatusEvery, default 12t) →
pollPrHumanComments (prPollCommentsEvery, default 12t) →
discoverWork → updateSnapshot → dispatch (≤ maxConcurrent)
```

Each phase wrapped in try-catch; one failure doesn't abort the tick. Per-item try-catch in discovery loops. Tick itself is guarded by `TICK_TIMEOUT_MS`: if a previous tick is still running past that, the lock force-releases.

### Agent Spawn

```
engine.js spawnAgent()
  → build prompt (parallel with worktree setup)
  → git worktree add (skipped for read-only)
  → resolveRuntime(resolveAgentCli(agent, engine))
  → node engine/spawn-agent.js <prompt> <sysprompt> --runtime <name>
    → adapter.resolveBinary() → { bin, native, leadingArgs }
    → spawn(bin, [...leadingArgs, ...adapter.buildArgs(opts)])
```

CC/doc-chat use `direct: true` — bypasses spawn-agent.js, spawns the runtime CLI directly via the adapter's cached binary path.

Dependency branches fetched in parallel via `Promise.allSettled`, merged sequentially. Agents are independent processes — engine death doesn't kill them; on restart they re-attach via PID files and live-output.log mtimes (20-min grace period).

### Key Modules

| Module | Role |
|--------|------|
| `engine.js` | Orchestrator: spawn, dispatch queue, dependency resolution |
| `dashboard.js` | HTTP server: web UI, REST API, doc-chat, command center |
| `engine/shared.js` | Utilities, file locking, **status/type constants** |
| `engine/queries.js` | Read-only state aggregation |
| `engine/lifecycle.js` | Post-completion: output parsing, PR sync, plan completion, verify, skill extraction |
| `engine/dispatch.js` | Dispatch queue: add, complete, retry, failure alerts |
| `engine/consolidation.js` | Haiku-powered inbox → notes.md merging, KB classification |
| `engine/ado.js`, `engine/github.js` | PR / comment polling (parallel implementations) |
| `engine/cli.js` | CLI handlers; orphan re-attach after engine restart |
| `engine/preflight.js` | Prerequisite checks; powers `minions doctor` |
| `engine/scheduler.js` | Cron-style scheduled tasks |
| `engine/pipeline.js` | Multi-stage pipeline execution |
| `engine/meeting.js` | Investigate → debate → conclude rounds |
| `engine/cooldown.js`, `engine/timeout.js` | Backoff and timeout/steering |
| `engine/llm.js` | Claude CLI wrapper (direct for CC/doc-chat, indirect via spawn-agent for agents) |
| `engine/watches.js` | Persistent watch jobs |
| `engine/cleanup.js` | Worktree, temp file, zombie process cleanup (10t) |
| `engine/routing.js`, `engine/playbook.js` | Routing table + playbook loading with project-local overrides |
| `engine/projects.js` | `removeProject()`: shared by `minions remove` CLI and `POST /api/projects/remove` |

Support scripts (rarely edited): `engine/spawn-agent.js`, `engine/ado-mcp-wrapper.js`, `engine/ado-status.js`, `engine/check-status.js`, `engine/teams.js`.

### State Files (runtime, gitignored)

- `engine/dispatch.json` — pending/active/completed queue
- `engine/control.json` — engine running/paused/stopped
- `engine/log.json` — audit trail (2500 max, rotated to 2000)
- `engine/metrics.json` — per-agent token usage, quality, runtime; `_engine` for CC/doc-chat/consolidation/agent-dispatch
- `engine/pipeline-runs.json`, `engine/schedule-runs.json`, `engine/watches.json`
- `engine/<runtime>-caps.json`, `engine/<runtime>-models.json` — adapter caches
- `projects/<name>/work-items.json`, `pull-requests.json`
- `plans/*.md`, `prd/*.json`, `prd/guides/*.md`

## Concurrency

All shared-JSON writes use `mutateJsonFileLocked()` or wrappers (`mutateDispatch`, `mutateWorkItems`, `mutatePullRequests`). **Never `safeWrite()` for read-modify-write** on dispatch.json, work-items.json, pull-requests.json, metrics.json, cooldowns.json, PRD JSON.

Rules:
- Lock multiple files in **alphabetical order by filename** to prevent deadlocks.
- **Never hold two locks across an `await` boundary** — acquire, write, release, then acquire the next.
- Keep callbacks fast — process kills, network calls, git ops happen *outside* the lock.

## Constants — No Magic Strings or Numbers

Defined in `engine/shared.js`. Never compare against raw status strings.

```js
WI_STATUS = { PENDING, DISPATCHED, DONE, FAILED, PAUSED, QUEUED, DECOMPOSED, CANCELLED }
DONE_STATUSES = Set([WI_STATUS.DONE, 'in-pr', 'implemented', 'complete'])  // legacy aliases on read only
WORK_TYPE = { IMPLEMENT, IMPLEMENT_LARGE, FIX, REVIEW, VERIFY, PLAN, PLAN_TO_PRD, DECOMPOSE, MEETING, EXPLORE, ASK, TEST, DOCS }
PLAN_STATUS = { ACTIVE, AWAITING_APPROVAL, APPROVED, PAUSED, REJECTED, COMPLETED, REVISION_REQUESTED }
PRD_ITEM_STATUS = { MISSING, UPDATED, DONE };  PRD_MATERIALIZABLE = Set([MISSING, UPDATED])
PR_STATUS = { ACTIVE, MERGED, ABANDONED, CLOSED, LINKED };  PR_POLLABLE_STATUSES = Set([ACTIVE, LINKED])
DISPATCH_RESULT = { SUCCESS, ERROR, TIMEOUT }
WATCH_STATUS = { ACTIVE, PAUSED, TRIGGERED, EXPIRED }
WATCH_CONDITION = { MERGED, BUILD_FAIL, BUILD_PASS, COMPLETED, FAILED, STATUS_CHANGE, ANY, NEW_COMMENTS, VOTE_CHANGE }
WATCH_ABSOLUTE_CONDITIONS = Set([MERGED, BUILD_FAIL, BUILD_PASS, COMPLETED, FAILED])  // fire-once
```

Retry limits / timeouts live in `ENGINE_DEFAULTS` — never hardcode (`if (retries < ENGINE_DEFAULTS.maxRetries)`, not `< 3`).

**Write only `WI_STATUS.DONE`** — never the legacy aliases. `updateWorkItemStatus()` validates against `WI_STATUS`.

## Work Item Lifecycle

```
pending → dispatched → done | failed
                    → decomposed (large items)
pending → cancelled (PRD item removed)
failed → pending (auto-retry up to ENGINE_DEFAULTS.maxRetries)
```

## Plan → PRD → Work Items → Verify

1. Plan markdown in `plans/` → status `awaiting-approval`
2. Approve → `plan-to-prd` agent writes structured PRD JSON with acceptance criteria
3. Materializer creates work items with `depends_on`
4. Engine spawns agents; merges dependency branches into worktrees first
5. All items done → verify task auto-created → builds, tests, writes `prd/guides/verify-{slug}.md`, opens E2E PR
6. **Manual archive** → when humans are satisfied, dashboard `POST /api/plans/archive` moves PRD/plan to archive

Use `queuePlanToPrd()` for atomic dedup-inside-lock dispatch (all plan-to-prd paths). `buildWiDescription(item, planFile)` for consistent WI descriptions.

**Plan Resume (diff-aware):** edits to a completed plan's `.md` flag PRD as `planStale`. Dashboard offers Regenerate (dispatches diff-aware plan-to-prd with `mode: diff-aware-update` marker), Resume as-is (clears stale flag), or per-item Reopen. Materializer treats `missing`/`updated` PRD items as re-opens of done WIs (sets to pending with `_reopened`); cross-project re-opens deferred outside the lock.

Only one verify WI per PRD at a time — if active, skip; if done/failed and PRD recompletes, re-open the existing one.

### Manual Archive Lifecycle

Archive is a dashboard/user action, not a verify completion side effect. Completed PRDs remain in `prd/` with `status: "completed"` and `_completionNotified` until a human archives them through `POST /api/plans/archive`. The archive handler moves the PRD to `prd/archive/`, marks it `status: "archived"` with `archivedAt`, moves `source_plan` markdown into `plans/archive/` when present, cancels only pending/queued linked work items, and leaves completed work-item history intact.

## Dependency-Aware Dispatch

Items declare `depends_on: ["P-001", ...]`. Before spawning, the engine resolves each ID → WI → linked PR → branch, fetches and merges into the worktree, and skips if any dep isn't `done`.

## Project Removal

`removeProject(target, options)` in `engine/projects.js` is the canonical teardown — used by both `minions remove <dir-or-name>` (CLI) and `POST /api/projects/remove` (Settings UI). Steps: cancel pending WIs → drain dispatch (kill active agents, clean pid/prompt sidecars in `engine/tmp/`) → remove worktrees → disable matching schedules → surface pipeline refs as warnings → remove from `config.json` → archive `projects/<name>/` to `projects/.archived/<name>-YYYYMMDD/` (override with `dataMode: 'keep' | 'purge'`). `target` matches by name OR resolved `localPath`.

**Never edit `config.json` directly to remove a project** — orphaned `projects/<name>/` data dirs surface as ghost PRs and stale WIs.

## Config (config.json)

```jsonc
{
  "projects": [{
    "name": "MyProject", "localPath": "/path/to/repo",
    "repoHost": "ado", "repositoryId": "GUID",
    "adoOrg": "org", "adoProject": "project", "mainBranch": "main",
    "workSources": {
      "pullRequests": { "enabled": true, "cooldownMinutes": 30 },
      "workItems": { "enabled": true, "cooldownMinutes": 0 }
    }
  }],
  "agents": {
    "dallas": {
      "name": "Dallas", "role": "Engineer", "skills": [],
      "cli": "copilot",       // optional, overrides engine.defaultCli
      "model": "gpt-5.4",     // optional, overrides engine.defaultModel
      "maxBudgetUsd": 5,      // optional; 0 is a valid cap
      "bareMode": false       // optional, overrides engine.claudeBareMode
    }
  },
  "engine": {
    "tickInterval": 60000, "maxConcurrent": 5, "maxRetries": 3,
    "agentTimeout": 18000000, "heartbeatTimeout": 300000, "shutdownTimeout": 300000,
    "allowTempAgents": false, "autoDecompose": true,
    "autoFixBuilds": true, "autoFixConflicts": true, "evalLoop": true,
    "adoPollEnabled": true, "ghPollEnabled": true,
    "defaultCli": "claude", "defaultModel": null,
    "ccCli": null, "ccModel": null, "ccEffort": null,
    "claudeBareMode": false, "claudeFallbackModel": null,
    "copilotDisableBuiltinMcps": true, "copilotSuppressAgentsMd": true,
    "copilotStreamMode": "on", "copilotReasoningSummaries": false,
    "maxBudgetUsd": null, "disableModelDiscovery": false
  },
  "schedules": [{ "id": "nightly-tests", "cron": "0 2 *", "type": "test", "title": "Nightly", "project": "MyProject", "enabled": true }]
}
```

Key flags:
- `autoFixBuilds` / `autoFixConflicts` — gate auto-fix dispatch
- `evalLoop` — review→fix cycle (auto-review after implementation, re-review after fix). When false, no automatic review or fix-cycle dispatch.
- `adoPollEnabled` / `ghPollEnabled` — gate all PR polling. Review auto-dispatch needs both `evalLoop` AND the relevant poll flag.
- `workSources` — per-project source toggles + cooldowns.

## Routing

`routing.md` maps work types to agents (`implement → dallas`, `review → ripley`, `fix → _author_`, etc.). Read on each tick.

## Playbooks

Templates in `playbooks/` with `{{template_variables}}` filled at dispatch time: `work-item.md` (fallback), `shared-rules.md` (auto-injected), `implement.md`, `implement-shared.md`, `review.md`, `fix.md`, `explore.md`, `ask.md`, `test.md`, `build-and-test.md`, `plan.md`, `plan-to-prd.md`, `verify.md`, `decompose.md`, `meeting-{investigate,debate,conclude}.md`. Snippets in `playbooks/templates/`.

**Platform-agnostic** — never hardcode build commands, languages, frameworks. Agents read project docs (CLAUDE.md, README, package.json, Makefile) to figure out build/test/run.

**Project-local overrides:** `projects/<name>/playbooks/<type>.md` wins over the global default. `resolvePlaybookPath(projectName, type)` does the lookup. Project-local playbooks are user data and gitignored.

## Skills

`.claude/skills/<name>/SKILL.md` with YAML frontmatter. `scope: minions` → installed to `~/.claude/skills/`; `scope: project` → PR'd into `<project>/.claude/skills/`. Agents auto-extract from output via ` ```skill ` fenced blocks.

## PR Review Protection

`reviewStatus: 'approved'` is **permanent terminal** — never downgrade. Guards exist in: ADO/GitHub pollers (first check, before vote computation), PR persistence (preserve `approved` from disk on merge-back), pre-dispatch live vote check, `updatePrAfterReview` / `updatePrAfterFix`.

ADO vote re-approval: when ADO resets votes because master moved but `_adoSourceCommit` didn't change, the engine re-applies its approval vote.

ADO comment poller: only `active` (1) and `pending` (6) threads — skips resolved/closed/fixed/wontFix. Per-agent metrics via `trackReviewMetric()` (configured agents only).

Context-only PRs (`_contextOnly: true`): polled for status/votes/builds, never dispatched. Set via dashboard "Link PR" with `autoObserve: false`. `PR_POLLABLE_STATUSES` covers both `ACTIVE` and `LINKED`.

## ADO Integration

Token via shared `engine/ado-token.js`: prefer `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`, then fall back to `azureauth ado token --mode iwa --mode broker --output token --timeout 1`. Cached 30 min, 10-min backoff on failure. **All `azureauth` calls MUST include `--timeout 1`** — without it the command can hang on interactive broker UI that never appears in headless agent sessions.

For agent-driven ADO actions outside the engine pollers, use `az` CLI first; ADO MCP tools (`mcp__azure-ado__*`) only as fallback. **Never use `gh` for ADO repos.**

## Runtime Adapters

CLI runtime is pluggable. Each adapter lives at `engine/runtimes/<name>.js`, registered in `engine/runtimes/index.js`. Bundled: `claude`, `copilot`. Engine code **never** branches on `runtime.name === ...` — only on capability flags (test enforced).

### Adapter Contract

| Field | Role |
|-------|------|
| `name` | Registry key (matches filename) |
| `capabilities` | Feature flags (table below) |
| `resolveBinary({env, config})` | → `{ bin, native, leadingArgs }` or null |
| `capsFile`, `modelsCache` | Cache paths |
| `installHint` | Surfaced when `resolveBinary` returns null |
| `listModels()` | → `{id, name, provider}[]` or null |
| `spawnScript` | Always `engine/spawn-agent.js` today |
| `buildArgs(opts)` | CLI args (no binary) |
| `buildPrompt(prompt, sysprompt, opts)` | Final prompt; sysprompt delivery varies by runtime |
| `resolveModel(input)` | Shorthand expansion |
| `parseOutput(raw, {maxTextLength})` | → `{ text, usage, sessionId, model }` |
| `parseStreamChunk(line)` | Single JSONL line |
| `parseError(rawOutput)` | → `{ message, code, retriable }`. Codes: `auth-failure`, `context-limit`, `budget-exceeded`, `crash`, null |
| `getUserAssetDirs({homeDir})` | Optional. Runtime-native global asset roots passed to spawn as `--add-dir` so worktrees still see them (e.g. Claude → `[~/.claude]`; Copilot → `[~/.copilot, ~/.agents]`) |
| `getSkillRoots({homeDir, project?})` | Optional. → `[{dir, scope, projectName?}]`. Where `collectSkillFiles` looks for native + project skill markdown for this runtime |
| `getSkillWriteTargets({homeDir, project?})` | Optional. → `{personal, project}`. Where `extractSkillsFromOutput` writes auto-extracted skills (personal scope → user dir; project scope → repo subdir like `.claude/skills` for Claude, `.github/skills` for Copilot) |

### Capability Flags

| Flag | Claude | Copilot | Gates |
|------|--------|---------|-------|
| `streaming` | ✓ | ✓ | JSONL events on stdout |
| `sessionResume` | ✓ | ✓ | `--resume <id>` |
| `midRunSessionId` | ✓ | ✗ | Resumable session ID emitted before terminal `result`; when false, steering waits for a checkpoint |
| `systemPromptFile` | ✓ | ✗ | sysprompt via `--system-prompt-file` (else inlined) |
| `effortLevels` | ✓ | ✓ | `--effort low\|medium\|high\|xhigh` |
| `costTracking` | ✓ | ✗ | USD + tokens in result event (Copilot only emits `premiumRequests`) |
| `modelShorthands` | ✓ | ✗ | Bare `sonnet`/`opus`/`haiku` accepted |
| `modelDiscovery` | ✗ | ✓ | `listModels()` returns a real catalog |
| `promptViaArg` | ✗ | ✗ | If true, `--prompt <text>` instead of stdin |
| `budgetCap` | ✓ | ✗ | `--max-budget-usd <n>` |
| `bareMode` | ✓ | ✗ | `--bare` (suppresses CLAUDE.md auto-discovery) |
| `fallbackModel` | ✓ | ✗ | `--fallback-model <id>` on rate-limit |
| `sessionPersistenceControl` | ✓ | ✗ | Engine writes `session.json` (Copilot manages it itself) |

### Resolution Helpers

Engine **never** reads `agent.cli` / `engine.defaultCli` / etc. directly. Six helpers in `engine/shared.js` are the single source of truth:

| Helper | Chain |
|--------|-------|
| `resolveAgentCli(agent, engine)` | `agent.cli` → `engine.defaultCli` → `'claude'` |
| `resolveCcCli(engine)` | `engine.ccCli` → `engine.defaultCli` → `'claude'` |
| `resolveAgentModel(agent, engine)` | `agent.model` → `engine.defaultModel` → undefined |
| `resolveCcModel(engine)` | `engine.ccModel` → `engine.defaultModel` → undefined |
| `resolveAgentMaxBudget(agent, engine)` | `agent.maxBudgetUsd` → `engine.maxBudgetUsd`. Honors literal `0` |
| `resolveAgentBareMode(agent, engine)` | `agent.bareMode` → `engine.claudeBareMode` → false. Strict null check so per-agent `false` overrides engine `true` |

**Independence (CRITICAL):** agent path and CC path don't fall through to each other. Setting `engine.ccCli: copilot` for CC alone must NOT switch agents to Copilot. Both fall through to `engine.defaultCli` (fleet-wide), but they don't see each other's overrides. Tests enforce this.

When `resolveAgentModel` returns undefined, the adapter omits `--model` from `buildArgs` and the CLI uses its own default.

### Runtime Configuration Reference

Model resolution is a three-tier chain: per-agent `agent.model` → `engine.defaultModel` → runtime CLI default. Runtime and model selection follow the same separation as the helpers above:

```json
{
  "engine": { "defaultCli": "copilot", "defaultModel": "gpt-5.4", "ccCli": "claude", "ccModel": "sonnet" },
  "agents": { "dallas": { "cli": "claude", "model": "haiku" } }
}
```

| Field | Default / role | Per-agent override |
|-------|----------------|--------------------|
| `engine.defaultCli` | fleet runtime fallback | `agent.cli` |
| `engine.defaultModel` | fleet model fallback | `agent.model` |
| `engine.ccCli` | Command Center runtime override | none |
| `engine.ccModel` | Command Center model override | none |
| `engine.claudeBareMode` | default false; emits `--bare` for Claude | `agent.bareMode` |
| `engine.claudeFallbackModel` | Claude rate-limit fallback model | none |
| `engine.copilotDisableBuiltinMcps` | default true; emits `--disable-builtin-mcps` | none |
| `engine.copilotSuppressAgentsMd` | default true; emits `--no-custom-instructions` | none |
| `engine.copilotStreamMode` | Copilot stream mode | none |
| `engine.copilotReasoningSummaries` | Copilot reasoning summary toggle | none |
| `engine.maxBudgetUsd` | fleet budget cap | `agent.maxBudgetUsd` |
| `engine.disableModelDiscovery` | fleet-wide model discovery opt-out | none |

Migration notes: `config.claude.* deprecation` moved runtime knobs into `engine.*`; compatibility shims stay tracked in `docs/deprecated.json`. Runtime permission bypass is adapter-owned (`--dangerously-skip-permissions` for Claude; `--autopilot --allow-all --no-ask-user` for Copilot), and legacy `config.claude.permissionMode` is ignored. `applyLegacyCcModelMigration` copies legacy `ccModel` to `defaultModel` in-memory when `defaultModel` is unset, but does not rewrite disk config.

Model discovery is per-runtime. Claude has no public model enumeration mechanism (`modelDiscovery: false`). Copilot uses `https://api.githubcopilot.com/models`. `engine.disableModelDiscovery` disables discovery globally.

Effort normalization is runtime-specific: Copilot maps `'max'` to `xhigh`; do not apply that mapping to Claude.

### Switching Fleet from CLI

```bash
minions start --cli copilot --model claude-sonnet-4.5
minions restart --cli claude --model ''     # '' DELETES defaultModel; never pin to literal empty string
minions config set-cli copilot --model gpt-5.4
```

### Risks

- **Copilot built-in MCPs (split-brain):** Copilot's `github-mcp-server` MCP can autonomously create PRs/labels/comments via the GitHub API, bypassing `pull-requests.json` tracking. `engine.copilotDisableBuiltinMcps: true` (default) strips it. Same risk class for any MCP that mutates state the engine tracks — default is always strip.
- **Copilot AGENTS.md auto-load:** without `--no-custom-instructions`, Copilot merges any in-tree `AGENTS.md` into its system prompt, fighting the playbook. `engine.copilotSuppressAgentsMd: true` (default) prevents this.
- **Claude bare mode:** `engine.claudeBareMode: true` adds `--bare`, suppressing CLAUDE.md auto-discovery — useful for runtime parity with Copilot, but agents lose context unless explicit context is provided through the system prompt. Preflight warns when paired with Claude as CC runtime AND no `ccSystemPrompt`.
- **Copilot binary path on Windows:** WinGet installs the standalone CLI shim at `%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe`; `resolveBinary()` should find this through PATH before falling back to `gh copilot`.

### Adding a New Runtime

1. Create `engine/runtimes/<name>.js` implementing the adapter contract; set `installHint`.
2. Register in `engine/runtimes/index.js`.

The dashboard `/api/runtimes`, `--cli` flag, agent CLI dropdown, preflight check, and model discovery cache all light up automatically. Use capability flags — never special-case in engine code.

## Dashboard

Assembled from fragments at startup: `dashboard/styles.css`, `layout.html`, `dashboard/pages/*.html`, `dashboard/js/*.js` → one HTML string, served as a SPA. Sidebar pages defined in `dashboard.js` (search `const pages =`).

## Command Center & Doc-Chat

Both share `ccCall()` in dashboard.js → `llm.callLLM({ direct: true })` → spawn the runtime CLI directly via the adapter's cached binary. `trackEngineUsage()` records calls/tokens/cost/duration per category.

**CC** (`POST /api/command-center` or SSE `/stream`): primary user→agents interface. System prompt loaded from `prompts/cc-system.md` (~11KB) with `{{minions_dir}}` substituted; hashed into `_ccPromptHash` for session invalidation on prompt changes. State preamble (`buildCCStatePreamble()`, 10s TTL) injected into fresh sessions. Single global session in `engine/cc-session.json`, bounded by `ENGINE_DEFAULTS.ccMaxTurns` (50) and `ccSessionTtlMs` (7d).

**Doc-Chat** (`POST /api/doc-chat`): per-document inline Q&A and editing. Sessions keyed by `filePath || title`, persisted in `engine/doc-sessions.json` (backend) and localStorage `_qaSessions` Map (frontend). Backend re-reads file from disk on each call to get freshest content. When the LLM edits, it returns `---DOCUMENT---` followed by the full updated file. **`parseCCActions` runs only on the answer portion before `---DOCUMENT---`** — prevents docs containing literal `===ACTIONS===` from being mangled.

Configurable runtime/model/effort: `engine.ccCli` / `engine.ccModel` / `engine.ccEffort`.

## Dashboard API

Self-documented via `GET /api/routes`. Key endpoints: `GET /api/status`, `POST /api/work-items`, `POST /api/work-items/{update,feedback}`, `POST /api/knowledge`, `GET/POST /api/pinned`, `POST /api/engine/wakeup`, `GET /api/agent/:id/live-stream` (SSE), `POST /api/settings/reset`, `POST /api/issues/create` (file GitHub issues via `gh`).

## Human Contributions

Through the dashboard:
- **Quick Notes** ("+ Note") → inbox → consolidation → notes.md
- **KB Authoring** ("+ New") → direct entry into any category
- **Work Item References** → injected as `{{references}}`
- **Acceptance Criteria** → `{{acceptance_criteria}}`
- **Pinned Notes** → `pinned.md`, prepended to ALL agent prompts as "READ FIRST"
- **Feedback** (👍/👎 on completed work) → agent inbox for learning consolidation

## Cross-Platform

- **Process kill:** `shared.killGracefully()` / `shared.killImmediate()` (taskkill on Windows, SIGTERM/SIGKILL elsewhere). Never `proc.kill('SIGTERM')` directly. For PIDs: `shared.killByPidGracefully(pid)` / `killByPidImmediate(pid)`.
- **Home dir:** `os.homedir()` — never `process.env.HOME || process.env.USERPROFILE`.
- **Worktree paths:** normalize to forward slashes (`.replace(/\\/g, '/')`) before interpolating into shell commands.
- **Line endings:** `.gitattributes` enforces LF; PS scripts CRLF.

## Timeouts & Liveness

**Core invariant: a live tracked agent is never killed for being silent.** Long builds, dependency installs, multi-file edits, and reasoning passes routinely produce no stdout for many minutes. That's not a hang signal.

Only two things kill a live tracked process (`engine/timeout.js`):

1. **Hard wall-clock timeout** — `engine.agentTimeout` (default `18000000` = 5h, `engine/shared.js:725`). Measured from `startedAt`, not output silence. Configurable in dashboard Settings (`set-agentTimeout`, floor 60s, no upper bound) or directly in `config.json`. Per-fan-out items can set their own `meta.deadline` which supersedes the default; `engine.fanOutTimeout` is a fan-out-wide override that falls back to `agentTimeout`.
2. **Steering kill** — explicit human steering message in the agent's inbox triggers `killImmediate()` so the agent can be re-spawned with `--resume <session>` carrying the new message. 30s recovery retry if the kill didn't take.

**Stale-orphan detection** (`engine.heartbeatTimeout`, default 5min) is **not** a heartbeat timer for live processes — it's the grace window after the engine has lost the tracked process handle (engine restart, untracked spawn). Per-type overrides in `ENGINE_DEFAULTS.heartbeatTimeouts` give heavier work types up to 15min: `implement`, `implement:large`, `fix`, `test`, `verify` → 15min; `plan` → 10min.

Before declaring an orphan, four layered liveness checks run:
1. `isTrackedProcessAlive` — `proc.exitCode` + `process.kill(pid, 0)`.
2. 64KB tail scan for `[process-exit] code=N` sentinel (written synchronously by `spawn-agent.js`). If found, completion is recovered using the actual OS exit code — never on a `subtype:"success"` substring (footgun #1792).
3. `isOsPidAliveForDispatch` — reads `engine/tmp/pid-<safeId>.pid` and `process.kill(pid, 0)`. Even with no tracked handle, if the OS PID is alive, **skip orphan declaration**.
4. Full-log re-scan for the sentinel (in case it scrolled past the 64KB tail).

After an engine restart, all orphan checks are gated on `engineRestartGraceUntil` (`restartGracePeriod`, default 20min, `shared.js:747`) — agents have that long to be re-attached via PID files and live-output.log mtimes before the reaper considers them.

**Don't add output-silence timers for live tracked processes.** Reintroducing one breaks the invariant and surfaces as "agent killed mid-task" reports.

## Graceful Shutdown

SIGTERM/SIGINT → engine enters `stopping`, waits up to `shutdownTimeout`, exits. Agents continue independently and re-attach on next start.

## Decomposition, Temp Agents, Schedules, Pipelines, Watches

- **Decompose:** `implement:large` → `decompose` agent (when `engine.autoDecompose`) splits into 2–5 sub-tasks (JSON), creates child WIs with `parent_id` + `depends_on`. Parent → `decomposed`.
- **Temp agents:** when `engine.allowTempAgents` and all permanents busy, spawn ephemeral `temp-{uid}` with minimal sysprompt; cleaned up after completion.
- **Schedules:** `config.schedules[]` with 3-field cron (`min hour dow`); last-run in `schedule-runs.json`.
- **Pipelines:** `pipelines/*.json` multi-stage with deps (tasks/meetings/plans); state in `pipeline-runs.json`.
- **Watches:** persistent monitoring jobs in `engine/watches.json`, checked every 3 ticks. Fields: `target`, `targetType` (`pr|work-item`), `condition`, `interval` (default 5min), `stopAfter` (0=forever, N=expire after N), `owner`, `onNotMet` (`null`|`'notify'`), `status`. Absolute conditions (`merged`, `build-fail`, `build-pass`, `completed`, `failed`) auto-expire on first trigger when `stopAfter=0`. Change-based (`status-change`, `any`, `new-comments`, `vote-change`) compare against `_lastState`. Managed via CC actions `create-watch` / `delete-watch` / `pause-watch` / `resume-watch`.

## Pending Reasons

WIs show `_pendingReason` (`dependency_unmet`, `cooldown`, `no_agent`, `already_dispatched`, `budget_exceeded`). Active dispatch shows `skipReason` (`max_concurrency`, `agent_busy`).

## Build Failure Notifications

PR build failure → inbox alert to author agent with reason. Deduped via `_buildFailNotified`, cleared on recovery.

## Testing

Unit tests in `test/unit.test.js` (~3550 `await test()` calls; single Node process, sequential, no per-test timeout — a hung test halts the suite). Module-level state persists across tests; isolation via `MINIONS_TEST_DIR` + `createTmpDir()`. `_setAdoTokenForTest(null)` short-circuits `azureauth` so tests don't spawn the auth subprocess.

Integration: `test/minions-tests.js` (HTTP client, needs dashboard). E2E: `test/playwright/dashboard.spec.js`.

If tests stop printing `PASS` mid-run, suspect a pending Promise (child / lock / fetch). The runner exits silently with code 0 when the event loop goes idle — see Footgun #1.

## Known Footguns

These bug classes have appeared more than once. Don't reintroduce.

1. **`child.unref()` in async exec abandons the awaiting Promise.** Node exits while the child is running, dropping the await. Test runner exits silently with code 0. Fixed in `a40fbad2` after ~1100 unit tests were silently skipped. The `timeout` opt on `exec`/`execAsync` already handles indefinite hangs — don't unref.

2. **`safeJson(p) || []` masks parse errors.** `safeJson` returns null for both missing AND corrupt; the `|| []` fallback hides corruption. Use `safeJsonArr(p)` / `safeJsonObj(p)` — typed defaults that log on parse failure.

3. **`safeWrite` on shared JSON is a race.** PRD JSON, `pull-requests.json`, `work-items.json`, `dispatch.json`, `metrics.json`, `cooldowns.json` are read-modify-written from multiple ticks. Use `mutateJsonFileLocked()` (or wrappers).

4. **`process.kill(pid, 'SIGTERM')` is Windows-broken.** Doesn't recurse into child processes. Use `shared.killByPidGracefully(pid)` / `killByPidImmediate(pid)` (shells out to `taskkill /T` on Windows).

5. **`syncPrsFromOutput` inbox fallback only on empty stdout.** When stdout is non-empty, do NOT scan `notes/inbox/` — stale sibling inbox files leak phantom PR records. Gate on `!output || !String(output).trim()`. Fixed in `c4c42472`.

## CC Action Contract

CC's `===ACTIONS===` JSON block → `parseCCActions` → `executeCCActions`. Hardened against silent failure modes — don't soften.

**Required fields** (server returns `{ error }` if missing):

| Action | Required |
|--------|----------|
| `dispatch` (and `fix`/`implement`/`explore`/`review`/`test`) | `title`. Plus `project` if multiple configured. |
| `build-and-test` | `pr` (number, ID, or URL) |
| `note` | `title`, `content` (or `description`) |
| `knowledge` | `title`, `content`, `category` (architecture\|conventions\|project-notes\|build-reports\|reviews) |
| `pin-to-pinned` | `title`, `content` |

**Strict project resolution:** unknown `action.project` → `{ error: 'Project "X" not found. Known: [...]' }`. **No silent fallback** to `PROJECTS[0]`. Multi-project configs require it; single-project falls through; zero-project allows root-level WIs.

**Agent hint normalization:** both `agent: "lambert"` and `agents: ["lambert"]` accepted; singular promoted to plural. Unknown agent → error. Single explicit hint hard-pins via `preferred_agent` + `agents` and bypasses routing.

**Pre-flight routing check:** after enqueue, the handler checks `routing.resolveAgent` for the workType; if none available, result includes a `warning` rendered inline.

**Delimiter parser tiers** (in `findCCActionsHeader`):
1. Strict (parseable=true): `===ACTIONS={0,3}` on its own line.
2. Loose (parseable=false): `===ACTIONS<anything>` — strips prose but no JSON parse.
3. Very-loose (parseable=false, case-insensitive): `={2,}\s*ACTIONS\s*={0,}`.

When `parseable=false` the client surfaces a banner — silent action-drop is gone.

Streaming chunks get a partial-delimiter strip (1–12 char prefixes of `===ACTIONS===`). Server and client both run it; `_ccMergeStreamText` trusts `prev` clean and only restrips `incoming`.

**Removed (don't reintroduce without solving false positives):** the regex hallucination detector that warned when prose described an action without a matching `===ACTIONS===` block — too many false positives because CC has direct tool access (`Bash`, `Write`, `Edit`, `WebFetch`).

## Best Practices

1. Use status/type **constants** (`WI_STATUS`, `WORK_TYPE`, etc.) and `ENGINE_DEFAULTS` — never raw strings/numbers for status comparisons or limits.
2. **Atomic writes** — `mutateJsonFileLocked()` for any RMW on shared JSON. Never `safeJson() + safeWrite()`.
3. **Cross-platform** — `shared.killGracefully()`, `os.homedir()`, normalized paths.
4. **Guard empty arrays** — check `projects.length > 0` before `projects[0]`.
5. **Per-item try-catch** in discovery/dispatch loops.
6. **Validate inputs** in write functions (`updateWorkItemStatus`, `syncPrdItemStatus`).
7. **Platform-agnostic playbooks** — never hardcode build commands.
8. **Manual archiving** — verification does not archive; use dashboard `POST /api/plans/archive` when ready.
9. **Run `npm test`** — target 0 failures. Tests use source-string matching; update assertions when replacing strings with constants.
10. **Optimistic UI** — show success toast BEFORE the API call; error toast on failure overwrites it. `showToast(id, msg, true|false)`. Use `alert()` only for pre-API validation.
11. **Dashboard JS:** `el.insertAdjacentHTML('beforeend', html)` — never `innerHTML +=` (rebuilds DOM, breaks listeners).
12. **CC streaming:** server-side strips `===ACTIONS===` in the SSE `onChunk`. Don't add client-side stripping.

## After Every Code Change

Run `/simplify`. Ensures new code reuses `shared.js` / `queries.js` utilities, generalizes instead of duplicating, and stays consistent. Before adding a helper, search those modules for an existing one.

## Deprecation Tracker

`docs/deprecated.json` tracks backward-compat shims with dates. `/cleanup-deprecated` removes entries older than 3 days. When deprecating code, add:

```json
{ "id": "kebab-id", "summary": "…", "deprecated": "YYYY-MM-DD",
  "reason": "…", "locations": ["file:line …"], "cleanup": "delete X / replace Y with Z" }
```
