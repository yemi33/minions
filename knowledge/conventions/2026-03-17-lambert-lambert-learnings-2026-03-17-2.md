---
source: lambert-2026-03-17.md
agent: lambert
category: conventions
date: 2026-03-17
---

# Lambert Learnings — 2026-03-17

## PR-4976726: feat(PL-W015): add cowork telemetry and performance tracking

### Review Verdict
APPROVE WITH SUGGESTIONS (vote 5). 3 new files, 943 insertions. Comprehensive test coverage (493 lines, 18 test cases).

### Patterns Discovered

1. **Bebop telemetry hook composition pattern**: `useCoworkTelemetry` composes 5 existing utilities — `logToPageTimingsAndTelemetry()` for dual PAS/telemetry logging, `useLogger()` for typed event logging, `useFireOnce()` for fire-once semantics, `scheduleIdleTask()` for idle deferral, `isClientSide` for SSR guards. All new telemetry hooks should compose from these same primitives. (source: `apps/bebop/src/features/cowork/hooks/useCoworkTelemetry.ts:1-35`)

2. **Performance timing uses `useRef` for per-instance mutable state**: `TimingState` interface tracks session start, first step, request start, federation load with boolean guards (`hasLoggedFirstStep`, `hasLoggedFederationLoad`). The `useRef` pattern avoids re-renders when timing values change. (source: `apps/bebop/src/features/cowork/hooks/useCoworkTelemetry.ts:48-66`)

3. **Dual timestamp strategy**: `performance.now()` for duration measurements (monotonic, sub-millisecond), `Date.now()` for wall-clock event timestamps in telemetry properties. Correct split — performance.now is not wall-clock, Date.now is. (source: `useCoworkTelemetry.ts:101-106` for performance.now, `useCoworkTelemetry.ts:229` for Date.now in interaction events)

4. **All perf events use `CopilotResultsRender` event type**: Pipeline compatibility requires reusing existing event type rather than creating new ones. Web Vitals uses `CopilotWebVitals` event type. (source: `useCoworkTelemetry.ts:39-42`, `useCoworkTelemetry.ts:340`)

### Findings (Non-blocking)

1. **Duplicate constants**: `PERF_EVENT_TYPE` and `INTERACTION_EVENT_TYPE` both set to `'CopilotResultsRender'`. Should consolidate to single constant. (source: `apps/bebop/src/features/cowork/hooks/useCoworkTelemetry.ts:39-42`)

2. **4 unused type definitions**: `CoworkPerformanceMetrics`, `CoworkInteractionEvent`, `CoworkSessionTelemetry`, `CoworkWebVitalsMetrics` defined but never imported by the hook. Only `CoworkTelemetryDimensions`, `CoworkInteractionType`, `CoworkSessionEvent` are consumed. (source: `apps/bebop/src/features/cowork/types/telemetryTypes.ts:31-61,70-76,90-100`)

3. **Web Vitals type/impl mismatch**: `CoworkWebVitalsMetrics` declares `lcp`, `cls`, `inp`, `fcp`, `ttfb` but `useCoworkWebVitals` measures `domContentLoaded`, `loadEvent`, `ttfb` from PerformanceNavigationTiming. Type overpromises. (source: `telemetryTypes.ts:70-76` vs `useCoworkTelemetry.ts:311-348`)

4. **Function identity instability**: All 9 returned functions are recreated every render (plain closures, not wrapped in `useCallback`). If consumers use them in `useEffect` dependency arrays, this causes unnecessary re-renders. (source: `useCoworkTelemetry.ts:272-283`)

### Gotchas

- **MCP ADO tools still unavailable**: `mcp__azure-ado__*` tools not discoverable via ToolSearch. REST API via curl + GCM Bearer token is the only working path. (source: ToolSearch returned "No matching deferred tools found")
- **ADO vote PUT may time out**: Known issue when PRs have many threads. Thread POST (status:4) works reliably. (source: prior sessions, confirmed in this session)
