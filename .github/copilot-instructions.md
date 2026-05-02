# Copilot instructions for Minions

Minions is a Node.js orchestration engine for autonomous coding agents. It runs as an engine daemon (`engine.js`, tick-based) plus a dashboard/API server (`dashboard.js`, port 7331), and persists runtime state as JSON files under `engine/`, `projects/<name>/`, `plans/`, `prd/`, and related root-level trackers.

## Build, test, and lint commands

- Use Node.js 18+.
- Install dependencies: `npm install`
- Unit tests: `npm test` or `node test/unit.test.js`
- Unit + integration: `npm run test:all` (integration expects the dashboard/runtime state to be available)
- Integration tests only: `npm run test:integration`
- E2E tests: `npm run test:e2e`
- Unit-test focus: the custom runner has no CLI filter; for a focused check, run the suite and filter output, e.g. `node test/unit.test.js | Select-String "dispatch command|FAIL"` on PowerShell.
- Single Playwright file: `npx playwright test test/playwright/<file>.spec.js`
- Single Playwright test by title: `npx playwright test -g "test title"`
- Playwright setup: `npm run test:setup`
- Syntax check touched JavaScript: `node --check <file.js>`
- There is no build or lint script in `package.json`; the dashboard is served directly from Node/HTML/JS files.

## High-level architecture

- `engine.js` is the main orchestrator. Each tick runs timeout/steering checks, inbox consolidation, cleanup, PR status/comment polling, work discovery, snapshot updates, and agent dispatch. Keep dispatch-affecting changes consistent across `engine.js`, `engine/dispatch.js`, `engine/timeout.js`, and `engine/lifecycle.js`.
- `engine.js` spawns agents through runtime adapters: build prompt/worktree, resolve runtime via `resolveRuntime(resolveAgentCli(...))`, then run `engine/spawn-agent.js`. Command Center/doc-chat use `llm.callLLM({ direct: true })` and bypass the spawn wrapper.
- `dashboard.js` is the HTTP server and API surface. Frontend fragments live in `dashboard/pages/`, `dashboard/js/`, `dashboard/styles.css`, and `dashboard/layout.html`; `dashboard-build.js` assembles the SPA HTML.
- `engine/shared.js` contains state constants, defaults, file locking, safe file I/O, process helpers, path helpers, and runtime-independent utilities. Prefer shared constants such as `WI_STATUS`, `WORK_TYPE`, `PR_STATUS`, `DISPATCH_RESULT`, and `ENGINE_DEFAULTS`.
- `engine/queries.js` is the read-side aggregation layer used by both the engine and dashboard. Add common read/aggregation behavior there instead of duplicating scans in callers.
- `engine/dispatch.js` owns queue mutation, deduplication, completion, retries, failure reports, and dispatch prompt sidecars.
- `engine/lifecycle.js` owns post-completion work: parsing agent output, syncing PRs from output, updating PR/work-item status, plan completion, verification flow, and skill extraction.
- `engine/ado.js` and `engine/github.js` are parallel PR integrations for status polling, comment polling, and reconciliation. Keep schema behavior aligned for shared `pull-requests.json` fields; build-fix agents inspect live CI logs themselves.
- Runtime CLI behavior goes through `engine/runtimes/`. Engine code must resolve adapters via `resolveRuntime()` and prefer adapter methods for spawn flags, session persistence, permission gates, and failure classification.
- Playbooks in `playbooks/` define agent prompts. `engine/playbook.js` renders playbooks, injects project context, and contains host-specific PR command guidance.
- Work routing is data-driven by `routing.md`; preserve its table format because the engine parses it.
- Plan flow is plan markdown -> PRD JSON -> materialized work items -> verify work item. Verification completion does not archive plans; archive is a dashboard/user action.
- Project removal is centralized in `engine/projects.js` via `removeProject()`, shared by the CLI and dashboard. Do not remove projects by editing `config.json` directly.

## Key conventions

- Use locked read-modify-write helpers for shared JSON state. Use `mutateDispatch()` for `engine/dispatch.json`, `mutateWorkItems()` for work-item files, `mutatePullRequests()` for PR files, or `mutateJsonFileLocked()` for other shared JSON. Do not use `safeWrite()` for concurrent state updates.
- Keep lock callbacks synchronous and fast. Do not run network calls, git commands, process kills, or `await` while holding a file lock. If multiple locks are unavoidable, acquire them in stable filename order and release before expensive work.
- Treat runtime state files as live shared state. The engine, dashboard, CLI commands, and agents may update them concurrently; check `git status` before editing and do not revert unrelated live/user/agent changes.
- Agent processes are independent of the engine daemon. The daemon tracks live processes in memory and re-attaches on restart using PID files and `live-output.log`; avoid running dispatch/tick logic from a separate process that lacks the daemon's `activeProcesses` map.
- `minions dispatch`/`node engine.js dispatch` should wake the running daemon through `control.json._wakeupAt`; do not call `tick()` from ad-hoc scripts to force dispatch while active agents exist.
- The engine should coordinate PR review/fix/build/conflict dispatch but should not enforce semantic review-loop or build-fix attempt caps; agents/runtime completion reports own retryability and escalation recommendations.
- Build-failure state is intentionally conservative. Cached failing statuses may be marked stale (`_buildStatusStale`); do not dispatch build fixes from stale cached failures unless a live check confirms the failure.
- Human PR comments do not require an `@minions` mention. Pollers filter bots/CI/minions comments, coalesce human feedback, and must persist comment cutoffs even when only agent/minions comments were new.
- GitHub PR reviews cannot self-approve with shared credentials. Review agents should submit comments whose body starts with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES` and write a completion report with `verdict: "approved"` or `verdict: "changes-requested"`.
- For Azure DevOps PR operations, prefer `az` CLI commands first and use ADO MCP tools only as fallback. Do not use `gh` for ADO repositories.
- All `azureauth ado token` calls must include `--timeout 1` to avoid hanging headless sessions.
- Prefer `ENGINE_DEFAULTS` for retry/timeout/limit values and write only canonical statuses such as `WI_STATUS.DONE`; legacy aliases are read-compatible only.
- Do not branch on runtime names in engine code; use adapter capability flags and resolution helpers in `engine/shared.js`. Agent runtime/model resolution and Command Center runtime/model resolution are intentionally independent.
- Do not add output-silence timers for live tracked agents. `engine/timeout.js` kills only for wall-clock timeout or explicit steering; heartbeat timeouts are for orphaned/untracked processes after restart.
- Dashboard UI code should preserve event handlers: prefer DOM construction or `insertAdjacentHTML('beforeend', html)` over `innerHTML +=`. Use existing toast patterns for optimistic UI.
- Command Center action parsing is strict: unknown projects/agents should return errors, required fields should be validated, and doc-chat must parse actions only before the `---DOCUMENT---` separator.
- Playbooks should stay platform-agnostic; agents infer project-specific build/test commands from the target repo docs.
- Deprecated compatibility shims belong in `docs/deprecated.json` with a cleanup path.
- Tests often assert source-level invariants with string checks. When changing architecture-sensitive logic, add or update regression tests near related sections in `test/unit.test.js`.
