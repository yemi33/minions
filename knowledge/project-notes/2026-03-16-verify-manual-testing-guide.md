---
source: verify-2026-03-16.md
agent: verify
category: project-notes
date: 2026-03-16
---

# Manual Testing Guide

**Date:** 2026-03-16
**Plan:** officeagent-2026-03-15.json (W025 — Claude Cowork UX in Bebop with OfficeAgent capabilities)
**Local Server:** http://localhost:3000/bebop/ (Vite dev server, no auth proxy)
**Restart Command:** `cd "C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15/apps/bebop" && powershell.exe -Command "yarn dev:no-auth"`

## Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| OfficeAgent (message-protocol) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | 113 pass, 0 fail | Clean build in 6.49s |
| OfficeAgent (chain-of-thought) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | N/A | Clean build in 6.07s |
| OfficeAgent (augloop-transport) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | N/A | Clean build in 4.93s |
| OfficeAgent (cowork-demo) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | 49 pass, 0 fail | All 4 test suites pass (27.8s) |
| OfficeAgent (core) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | FAIL | N/A | Pre-existing test TS errors (readyState readonly) — NOT from PRs |
| office-bohemia (cowork-component) | C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15 | PASS | N/A | Transpile + typecheck clean (13.6s) |
| office-bohemia (bebop app) | C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15 | FAIL | N/A | 20 TS errors in cowork feature — cross-PR integration issues |
| office-bohemia (Vite dev) | C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15 | RUNNING | N/A | Vite serves on :3000 despite dep-scan warning (pre-existing @fluidx/odsp-vroom-api issue) |

## Critical Finding: Cross-PR Integration Failures

When all 7 office-bohemia PR branches are merged together, **20 TypeScript compilation errors** appear. Each PR builds independently but they don't compose cleanly. Key issues:

### Missing Atom Exports (useCoworkStream.ts)
- `upsertProgressionStepAtom` — referenced but not exported from `coworkAtoms.ts` (scaffold version doesn't have it)
- `activeQuestionAtom` — missing from scaffold version of atoms
- `coworkErrorAtom` — missing from scaffold version
- `appendArtifactAtom` — missing from scaffold version
- `resetCoworkStateAtom` — referenced but name is `resetCoworkSessionAtom`

### Missing Function Export (useCoworkStream.ts)
- `sendUserAnswer` — not exported from `coworkSession.ts` (scaffold version)

### Type Incompatibility (coworkAtoms.ts / useCoworkSession.ts / useCoworkStream.ts)
- `CoworkSession` type in `types.ts` has `status` field, but atoms initialize without it
- Function arguments don't match `CoworkSession` shape

### Module Export Mismatch (streamingBridge.ts / transportRegistry.ts)
- `AugloopTransport`, `TransportConfig`, `TransportState` — not exported from the augloop-annotations version of `augloopTransport.ts` (which replaced the protocol-adapter version)

### Missing Module (featureGates.ts)
- `@fluidx/utilities` — import fails, may need build of dependency package first

### React 19 Strictness (CoworkErrorBoundary.tsx)
- `componentDidCatch` and `render` need `override` modifier (TS4114)

**Root Cause:** The PRs were developed against different base states:
- `coworkAtoms.ts` exists in both P006 (scaffold) and P009 (protocol adapter) with different exports
- `augloopTransport.ts` exists in both P009 (protocol adapter) and P014 (annotations) with incompatible interfaces
- `useCoworkStream.ts` (P009) expects atoms/functions from the protocol adapter version but the scaffold version's atoms were merged instead

## What to Test

### P001: CoT + Ask-User Message Protocol Types (PR-4970128)
**What changed:** Added `ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer` to MessageType enum + full type definitions
**How to test:**
1. Build succeeds: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15" && powershell.exe -Command "yarn workspace @officeagent/message-protocol build"`
2. Tests pass: `powershell.exe -Command "yarn workspace @officeagent/message-protocol test"`
3. Verify types exist: Check `modules/message-protocol/src/types/chain-of-thought-stream.ts` and `ask-user-question.ts`

**Expected behavior:**
- MessageType enum includes `chain_of_thought_update`, `ask_user_question`, `user_answer`
- CoTStreamEvent has discriminated union with `step_started`, `step_completed`, `tool_use`, `thinking` kinds
- AskUserQuestionPayload has `questionId`, `text`, `options?`, `freeform?`, `timeoutMs?`
- All types exported from package index

**Status:** PASS — 113 tests pass, clean build

### P002: CoT WebSocket Streaming Handler (PR-4970168)
**What changed:** New handler at `modules/api/src/websocket/handlers/cot-stream-handler.ts`
**How to test:**
1. Verify file exists and follows handler pattern
2. Check handler registered in `modules/api/src/websocket/index.ts`
3. Check handler invoked in `modules/api/src/routes-internal.ts`

**Expected behavior:**
- `registerCoTStreamHandler()` function exists and registers under `chain_of_thought_update` type
- `sendCoTStreamEvent()` exports for other handlers to use
- Dual-write: file-based CoT still works alongside WebSocket streaming

**Status:** File exists, merged cleanly. Full build requires core module (blocked by pre-existing test issue).

### P003: Ask-User-Question WebSocket Handler (PR-4970145)
**What changed:** New handler at `modules/api/src/websocket/handlers/ask-user-handler.ts`
**How to test:**
1. Verify handler file exists with timeout, routing, and session management
2. Check exports: `askUserQuestion`, `cancelPendingQuestion`, `hasPendingQuestion`, `isTimeoutAnswer`

**Expected behavior:**
- Agent sends structured question, handler routes to client
- Client responds, handler routes answer to agent session
- Configurable timeout (default 60s) sends timeout signal
- Session cleanup on disconnect

**Status:** File exists, exports registered in index.ts.

### P004: AugLoop Transport Adapter (PR-4970163)
**What changed:** New module at `modules/augloop-transport/` with full lifecycle management
**How to test:**
1. Build: `powershell.exe -Command "yarn workspace @officeagent/augloop-transport build"` — **PASSES**
2. Check `modules/augloop-transport/src/augloop-transport.ts` for connect/disconnect/reconnect
3. Check `modules/augloop-transport/src/message-adapter.ts` for bidirectional translation

**Expected behavior:**
- AugLoop client handles connection lifecycle (connect, disconnect, reconnect, auth refresh)
- Message adapter translates between AugLoop operations and OfficeAgent Message<T>
- Exponential backoff on reconnect

**Status:** PASS — builds cleanly.

### P005: Bebop Cowork Feature Gate (PR-4970130)
**What changed:** `featureGates.ts` + `coworkRouteGuard.ts` + `featureGates.test.ts`
**How to test:**
1. Navigate to http://localhost:3000/bebop/cowork — should redirect to `/` (gate OFF by default)
2. Navigate to http://localhost:3000/bebop/cowork?EnableBebopCowork=on — should render cowork page
3. Open DevTools, run `localStorage.setItem('EnableBebopCowork', 'true')`, refresh — should persist

**Expected behavior:**
- Default: cowork is disabled, redirects to home
- Query param `?EnableBebopCowork=on` enables it
- localStorage `EnableBebopCowork=true` persists
- Env var `VITE_COWORK_ENABLED=true` enables on build

**Status:** TS error on `@fluidx/utilities` import. Route may work via Vite (esbuild ignores type errors), but feature gate function may fail at runtime.

### P006: Cowork Feature Module Scaffold (PR-4970170)
**What changed:** Full `features/cowork/` directory with components, atoms, hooks, types
**How to test:**
1. Navigate to http://localhost:3000/bebop/cowork?EnableBebopCowork=on
2. You should see three-panel layout: Chat (left) | Progression (center) | Artifacts (right)
3. Each panel has a header with title
4. Chat panel has an input area

**Expected behavior:**
- Three-panel layout renders with CSS grid
- CoworkLayout wrapped in CoworkErrorBoundary
- Connection status banner at top
- Panel visibility controlled by Jotai atoms

**Status:** Code present but has TS integration issues when merged with other PRs.

### P007: Cowork Mirrored Protocol Types (PR-4970115)
**What changed:** `apps/bebop/src/features/cowork/types/messageProtocol.ts` with OfficeAgent mirror types
**NOTE:** PR-4970115 branch `work/PL-W017` does NOT exist on remote. This is a phantom PR — the types likely live in the protocol-adapter PR (PR-4970405) which includes `messageProtocol.ts`.

**Status:** Phantom PR. Types exist via PR-4970405 merge.

### P008: Progression Card Components
**NOTE:** No dedicated progression component PR was found. The `progressionAtoms.ts` exists in the scaffold, and `ProgressionPanel` placeholder exists in `CoworkLayout.tsx`. A full ProgressionPanel component with step animations, tool-use display, and thinking steps was NOT implemented as a separate deliverable.

**Status:** Placeholder only — "Progression panel — chain-of-thought steps will appear here"

### P009: OfficeAgent Protocol Adapter (PR-4970405)
**What changed:** `messageAdapter.ts`, `augloopTransport.ts`, `streamingBridge.ts`, `transportRegistry.ts`, `coworkSession.ts`, `useCoworkStream.ts`
**How to test:**
1. Check `server/messageAdapter.ts` translates QueryStatus, CoT, ask-user, error messages
2. Check `server/augloopTransport.ts` manages connection lifecycle
3. Check `hooks/useCoworkStream.ts` bridges server events to Jotai atoms

**Known Issue:** Wire format field name mismatches flagged in review (FileInfo: fileId/fileName/fileType vs path/filename/size). This PR has the most integration issues when merged.

**Status:** TS errors when merged with scaffold + annotations branches.

### P010: Artifact Preview Panel (PR-4970334)
**What changed:** `ArtifactPanel.tsx`, `DocumentPreview.tsx`, `DownloadButton.tsx`, `artifactAtoms.ts`
**How to test:**
1. With cowork enabled, check right panel shows artifacts area
2. `ArtifactPanel` should render tabbed container
3. `DocumentPreview` uses sandboxed iframe (`sandbox` attribute)
4. `DownloadButton` triggers file download with MIME type

**Expected behavior:**
- Tabbed container for multiple artifacts
- HTML artifacts in sandboxed iframe (no scripts)
- Binary files (DOCX/PPTX/XLSX) show download link, not iframe

**Status:** Code present. Integration depends on other atoms.

### P011: Loop Component Wrapper (PR-4970841)
**What changed:** New `packages/cowork-component/` package
**How to test:**
1. Build: `cd "C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15" && powershell.exe -Command "yarn workspace @fluidx/cowork-component build"` — **PASSES**
2. Check `CoworkComponent.tsx` implements HTMLViewable provider
3. Check `CoworkComponentFactory.ts` has `registrationId: 'cowork-agent'`
4. Check `dependencies.ts` provides token provider, auth, telemetry

**Expected behavior:**
- Package builds and typechecks clean
- Component handles lifecycle (dispose, suspend, resume)
- Injected auth tokens flow through to transport layer

**Status:** PASS — transpile + typecheck succeed.

### P012: Host Integration Demo (PR-4970916)
**What changed:** `.devtools/cowork-demo/` with mock AugLoop server, demo HTML pages, test fixtures
**How to test:**
1. Tests: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15" && powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo test"` — **PASSES (49 tests)**
2. Start demo: `powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo start"` (if start script exists)
3. Open `demo.html` in browser — should show standalone demo
4. Open `embed.html` — should show iframe embed demo

**Expected behavior:**
- Mock AugLoop transport returns canned CoT events
- Component renders in standalone and iframe modes
- Auth flow works with mock token provider
- 49 tests pass across 4 test suites

**Status:** PASS — all tests green.

### P013: SharedTree DDS Collaborative State Schema (PR-4970959)
**What changed:** `packages/cowork-component/src/sharedTree/coworkSchema.ts` + `coworkTreeAdapter.ts`
**How to test:**
1. Check `coworkSchema.ts` uses `SchemaFactoryBeta` with `allowUnknownOptionalFields: true`
2. Check schema has: session, participants, messages, progressionSteps, artifacts, arbitraryProperties
3. Check `coworkTreeAdapter.ts` bridges SharedTree → Jotai atoms

**Expected behavior:**
- Schema versioned with namespace `com.microsoft.loopcomponent.cowork`
- All node types have `allowUnknownOptionalFields: true` for forward-compatibility
- Adapter subscribes to `Tree.on(node, 'treeChanged')` and emits readonly snapshots
- Graceful fallback to local-only Jotai atoms when SharedTree unavailable

**Status:** Builds as part of cowork-component package (PASS).

### P014: AugLoop Annotation Integration (PR-4970697)
**What changed:** Annotation types, annotation transport, merged progression atoms
**How to test:**
1. Check `types/annotationTypes.ts` defines annotation lifecycle (pending → active → completed/failed)
2. Check `ANNOTATION_TYPE_MAP` maps 5 operation types to `AugLoop_Cowork_` prefixed strings

**Known Issues from Review:**
- Redundant type casts
- Module-level mutable `annotationCounter` (SSR leak risk)
- Fragile Jotai atom typing
- Empty catch blocks

**Status:** Code present but augloopTransport.ts conflict with P009 creates integration issues.

### P016: Error Handling and Resilience (PR-4970552)
**What changed:** `CoworkErrorBoundary.tsx`, `ConnectionStatusBanner.tsx`, `connectionAtoms.ts`, `useConnectionResilience.ts`
**How to test:**
1. Check CoworkErrorBoundary catches and displays friendly error UI
2. Check ConnectionStatusBanner shows connection state
3. Check useConnectionResilience has exponential backoff, retry, cancel
4. Navigate to /cowork — should see connection status area at top

**Expected behavior:**
- Auto-reconnect with exponential backoff on disconnect
- Agent timeout (120s default) shows notification
- Token expiry handled transparently
- Error boundary catches unhandled exceptions

**Status:** Code present, renders in layout. TS error: `override` modifier needed on class methods.

### P017: OfficeAgent Cowork Flight Gate
**NOTE:** No dedicated PR was found for this item. The flight gate behavior should be implemented in the OfficeAgent agent registry system. Check if `cowork_enabled` flight key exists in any agent's `registry.ts`.

**Status:** Not found as a distinct deliverable. May be implicit via the handler registration pattern.

### P015: Cowork Telemetry Hooks
**NOTE:** No dedicated telemetry PR was found. No `useCoworkTelemetry.ts` file exists in the merged codebase.

**Status:** NOT IMPLEMENTED — no file or PR found.

## Integration Points

Cross-project interactions to verify:
1. **Bebop → OfficeAgent via AugLoop**: `augloopTransport.ts` (Bebop) → mock AugLoop server (port 11040) → `augloop-transport-handler.ts` (OfficeAgent) → OfficeAgent processing → response
2. **CoT streaming end-to-end**: OfficeAgent `cot-stream-handler.ts` sends `chain_of_thought_update` → WebSocket → Bebop `useCoworkStream.ts` → progression atoms → UI
3. **Ask-user-question round-trip**: OfficeAgent `ask-user-handler.ts` → WebSocket → Bebop question UI → user clicks → `user_answer` back → OfficeAgent routes to agent session
4. **SharedTree sync**: Multiple browsers on same cowork session → SharedTree DDS syncs messages/steps/artifacts → both see identical state

## Known Issues

1. **CRITICAL: 20 TS errors when all bohemia PRs merged** — cross-PR integration issues (missing exports, type shape mismatches, module interface conflicts)
2. **Phantom PR-4970115**: Branch `work/PL-W017` never pushed to remote; types exist via PR-4970405
3. **P015 (Telemetry) NOT IMPLEMENTED**: No file, no PR
4. **P017 (Flight Gate) unclear**: No dedicated deliverable found
5. **P008 (Progression Components) partial**: Only placeholder in layout; no dedicated step/tool-use/thinking components
6. **Pre-existing**: OfficeAgent core module has test TS errors (readyState readonly on WebSocket mock)
7. **Pre-existing**: Vite dep-scan fails on `@fluidx/odsp-vroom-api` — dev server still works
8. **Wire format mismatches** in P009: FileInfo and QueryStatusPayload field names don't match OfficeAgent source (flagged in review)
9. **`@fluidx/utilities` not resolvable** in bebop workspace — featureGates.ts import fails

## Quick Smoke Test

1. Open http://localhost:3000/bebop/ — should load Bebop home page
2. Open http://localhost:3000/bebop/cowork — should redirect to `/` (feature gate OFF)
3. Open http://localhost:3000/bebop/cowork?EnableBebopCowork=on — should show cowork page (may hit runtime errors from TS integration issues)
4. In OfficeAgent worktree: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15" && powershell.exe -Command "yarn workspace @officeagent/message-protocol test"` — expect 113 pass
5. In OfficeAgent worktree: `powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo test"` — expect 49 pass

## Worktree Locations

| Project | Path | Branch State |
|---------|------|-------------|
| OfficeAgent | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` | 5 PR branches merged on main (3 conflict resolutions) |
| office-bohemia | `C:/Users/yemishin/worktrees/verify-bohemia-2026-03-15` | 8 PR branches merged on master (4 conflict resolutions) |
