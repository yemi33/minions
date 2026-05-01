# Copilot instructions for Minions

Minions is a zero-dependency Node.js orchestration engine for autonomous coding agents. It runs as an engine daemon (`engine.js`, tick-based) plus a dashboard/API server (`dashboard.js`, port 7331), and it persists runtime state as JSON files under `engine/`, `projects/<name>/`, `plans/`, and `prd/`.

## Build, test, and lint commands

- Install dependencies: `npm install`
- Unit tests: `npm test` or `node test/unit.test.js`
- Unit-test focus: the custom runner has no CLI filter; for a focused check, run the suite and filter output, e.g. `node test/unit.test.js | Select-String "dispatch command|FAIL"` on PowerShell.
- Integration tests: `npm run test:integration`
- E2E tests: `npm run test:e2e`
- Single Playwright test file: `npx playwright test test/playwright/<file>.spec.js`
- Single Playwright test by title: `npx playwright test -g "test title"`
- Playwright setup: `npm run test:setup`
- Syntax check touched JavaScript: `node --check <file.js>`
- There is no build or lint script in `package.json`; the dashboard is served directly from Node/HTML/JS files.

## High-level architecture

- `engine.js` is the main orchestrator. Each tick runs timeout/steering checks, inbox consolidation, cleanup, PR status/comment polling, work discovery, snapshot updates, and agent dispatch. Keep dispatch-affecting changes consistent across `engine.js`, `engine/dispatch.js`, `engine/timeout.js`, and `engine/lifecycle.js`.
- `dashboard.js` is the HTTP server and API surface. Frontend modules live in `dashboard/js/`, and `dashboard-build.js` assembles the dashboard HTML.
- `engine/shared.js` contains state constants, defaults, file locking, safe file I/O, process helpers, path helpers, and runtime-independent utilities. Prefer shared constants such as `WI_STATUS`, `WORK_TYPE`, `PR_STATUS`, `DISPATCH_RESULT`, and `ENGINE_DEFAULTS`.
- `engine/queries.js` is the read-side aggregation layer used by both the engine and dashboard. Add common read/aggregation behavior there instead of duplicating scans in callers.
- `engine/dispatch.js` owns queue mutation, deduplication, completion, retries, failure reports, and dispatch prompt sidecars.
- `engine/lifecycle.js` owns post-completion work: parsing agent output, syncing PRs from output, updating PR/work-item status, plan completion, verification flow, and skill extraction.
- `engine/ado.js` and `engine/github.js` are parallel PR integrations for status polling, comment polling, reconciliation, and build log collection. Keep schema behavior aligned for shared `pull-requests.json` fields.
- Runtime CLI behavior goes through `engine/runtimes/`. Engine code must resolve adapters via `resolveRuntime()` and branch on `runtime.capabilities.*`, not on runtime names.
- Playbooks in `playbooks/` define agent prompts. `engine/playbook.js` renders playbooks, injects project context, and contains host-specific PR command guidance.
- Work routing is data-driven by `routing.md`; preserve its table format because the engine parses it.

## Key conventions

- Use locked read-modify-write helpers for shared JSON state. Use `mutateDispatch()` for `engine/dispatch.json`, `mutateWorkItems()` for work-item files, `mutatePullRequests()` for PR files, or `mutateJsonFileLocked()` for other shared JSON. Do not use `safeWrite()` for concurrent state updates.
- Keep lock callbacks synchronous and fast. Do not run network calls, git commands, process kills, or `await` while holding a file lock. If multiple locks are unavoidable, acquire them in stable filename order and release before expensive work.
- Treat runtime state files as live shared state. The engine, dashboard, CLI commands, and agents may update them concurrently; check `git status` before editing and do not revert unrelated live/user/agent changes.
- Agent processes are independent of the engine daemon. The daemon tracks live processes in memory and re-attaches on restart using PID files and `live-output.log`; avoid running dispatch/tick logic from a separate process that lacks the daemon's `activeProcesses` map.
- `minions dispatch`/`node engine.js dispatch` should wake the running daemon through `control.json._wakeupAt`; do not call `tick()` from ad-hoc scripts to force dispatch while active agents exist.
- The PR review/fix loop has distinct gates: `evalMaxIterations` gates only minion review/re-review/review-feedback automation. Human-feedback fixes, build-failure fixes, and merge-conflict fixes have separate gates and must continue after minion review escalation.
- Build-failure state is intentionally conservative. Cached failing statuses may be marked stale (`_buildStatusStale`); do not dispatch build fixes from stale cached failures unless a live check confirms the failure.
- Human PR comments do not require an `@minions` mention. Pollers filter bots/CI/minions comments, coalesce human feedback, and must persist comment cutoffs even when only agent/minions comments were new.
- GitHub PR reviews cannot self-approve with shared credentials. Review agents should submit comments whose body starts with `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`; the engine parses those verdicts.
- For Azure DevOps PR operations, prefer `az` CLI commands first and use ADO MCP tools only as fallback. Do not use `gh` for ADO repositories.
- Prefer `ENGINE_DEFAULTS` for retry/timeout/limit values and write only canonical statuses such as `WI_STATUS.DONE`; legacy aliases are read-compatible only.
- Tests often assert source-level invariants with string checks. When changing architecture-sensitive logic, add or update regression tests near related sections in `test/unit.test.js`.
