---
source: ripley-2026-03-17.md
agent: ripley
category: architecture
date: 2026-03-17
---

# Ripley Learnings — 2026-03-17

## PR-4976897 Review: feat(PL-W012) AugLoop annotation integration

### PR Review Findings

- **PR-4976897 APPROVED**: 5 new files (1,399 lines) adding AugLoop annotation transport for cowork agent operations. Clean architecture, comprehensive tests, good type safety. (source: PR-4976897, commit `a0ab1d949aad`)

- **AugLoop integration uses minimal interface pattern**: `IAugLoopAnnotationProvider` with only `activateAnnotations()` and `releaseAnnotation()` avoids tight coupling to `@fluidx/augloop` internals. Callback-based constructor bridges class to Jotai atoms. (source: `apps/bebop/src/features/cowork/server/augloopTransport.ts:49-57`)

- **State + dispatch pattern for Jotai annotation tracking**: `annotationDispatchAtom` wraps `reduceAction()` with 7 action types matching the annotation lifecycle (registered → activated → result/failed/retrying/fallback → reset). Derived atoms for merged steps, active/completed/failed counts. (source: `apps/bebop/src/features/cowork/atoms/progressionAtoms.ts:135-143`)

- **Retry logic is fixed-delay, not exponential**: Commit message claims "exponential backoff" but implementation uses fixed `retryDelayMs` for all retries. Worth noting for future reference. (source: `apps/bebop/src/features/cowork/server/augloopTransport.ts:283`)

- **`server/` folder may be misnamed**: Per Bebop CONTRIBUTING.md, `server/` is for server-only internals. The AugLoop transport is client-side code (browser-only AugLoop runtime). Should potentially be `client/` instead. (source: `apps/bebop/CONTRIBUTING.md` — "features/server is server-only")

- **Module-level counter in augloopTransport.ts**: `annotationCounter` at module scope could persist across SSR requests. Not a real issue since AugLoop is browser-only, but worth documenting. (source: `apps/bebop/src/features/cowork/server/augloopTransport.ts:81`)

- **`latestResults` array grows unboundedly**: The `annotation_result` reducer handler appends to `latestResults` without cap. For long sessions this could accumulate. (source: `apps/bebop/src/features/cowork/atoms/progressionAtoms.ts:117`)

### Patterns & Conventions

- **GCM credential retrieval working**: `printf "protocol=https\nhost=office.visualstudio.com\n" | git credential fill` returns valid ADO Bearer token when `az account get-access-token` times out. (source: confirmed in this session)

- **az CLI hangs on Windows DevBox**: `az account get-access-token` timed out after 10+ seconds multiple times. GCM fallback is reliable alternative.

### Bugs & Gotchas

- **az CLI token retrieval intermittently hangs**: Multiple `az account get-access-token` calls timed out at 10-15s. Use GCM credential fill as primary method on this DevBox.
