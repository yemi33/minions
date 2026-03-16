---
source: verify-2026-03-16.md
agent: verify
category: build-reports
date: 2026-03-16
---

# Manual Testing Guide

**Date:** 2026-03-16
**Plan:** officeagent-2026-03-15.json — Claude Cowork UX in Bebop with OfficeAgent capabilities
**Local Server:** http://localhost:3002/bebop/ (Bebop Vite dev server)
**Restart Command:** `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop" && powershell.exe -NoProfile -Command "npx vite dev"`

## Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| OfficeAgent (message-protocol) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | 113 pass, 0 fail | Clean build + all tests pass |
| OfficeAgent (augloop-transport) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | 11 pass, 0 fail (1 suite babel config issue) | Compiled dist tests pass; source test has babel `import type` parse error |
| OfficeAgent (cowork-demo) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | PASS | 49 pass, 0 fail | 4 test suites all pass (fixtures, mock-augloop-server, host-environment, mock-token-provider) |
| OfficeAgent (core) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | FAIL | N/A | 4 TS errors in `tests/websocket/websocket-manager.test.ts` — `readyState` read-only property. Pre-existing on main. |
| OfficeAgent (api) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 | FAIL | N/A | Missing module declarations (agents not built) + @types/ws version conflict. Expected — requires full Docker build. |
| office-bohemia (Bebop typecheck) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob | FAIL | 0 pass, 1 fail (featureGates.test.ts — import.meta in CJS) | 19 TS errors in 6 cowork files — cross-PR interface mismatches from merging 8 independent branches |
| office-bohemia (Vite dev server) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob | PASS | N/A | Vite dev mode works (esbuild skips type-checking). Serves on http://localhost:3002/bebop/ |
| office-bohemia (cowork-component) | C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob | N/A | 0 tests found | No test files created for this package yet |

## What to Test

### Cowork Route + Feature Gate (P005, P006)
**What changed:** New `/cowork` route in Bebop with feature gate controlled by query param, localStorage, or env var.
**How to test:**
1. Navigate to http://localhost:3002/bebop/cowork (without feature gate)
2. You should be **redirected to `/`** (feature gate blocks access)
3. Navigate to http://localhost:3002/bebop/cowork?EnableBebopCowork=on
4. You should see the **CoworkLayout** (three-panel layout: chat, progression, artifacts)
5. Open browser console, run: `localStorage.setItem('EnableBebopCowork', 'true')`
6. Navigate to http://localhost:3002/bebop/cowork (no query param)
7. You should now see the CoworkLayout (gate reads localStorage)
8. To disable: `localStorage.setItem('EnableBebopCowork', 'false')`

**Expected behavior:**
- Feature gate respects priority: query param > localStorage > env var
- Unauthorized access redirects to home

### Cowork Layout Scaffold (P006)
**What changed:** Three-panel layout with chat panel, progression panel, and artifact panel.
**How to test:**
1. Navigate to http://localhost:3002/bebop/cowork?EnableBebopCowork=on
2. Verify three panels are visible: chat (left), progression (center), artifacts (right)
3. The layout should be responsive

**Expected behavior:**
- Three distinct panels with proper CSS styling
- Chat panel has input area
- Progression panel shows chain-of-thought steps
- Artifact panel shows document previews

### Artifact Preview Panel (P010)
**What changed:** Tabbed display with sandboxed iframes for document previews and download buttons.
**How to test:**
1. With cowork page open, check the right panel for artifact display area
2. If artifacts are generated, tabs should allow switching between documents
3. Download button should be present for each artifact

**Expected behavior:**
- Tabbed interface for multiple artifacts
- Sandboxed iframe for document preview
- Download button per artifact

### Connection Status Banner (P016 — Error Handling)
**What changed:** Connection resilience with reconnect logic and error boundary.
**How to test:**
1. Open cowork page, check for connection status banner
2. If WebSocket disconnects, banner should show reconnection state
3. Error boundary should catch and display errors gracefully

**Expected behavior:**
- ConnectionStatusBanner shows connection state
- CoworkErrorBoundary catches render errors
- Reconnection attempts with backoff

### Protocol Types (P001, P007)
**What changed:** New MessageType enum values (ChainOfThoughtUpdate, AskUserQuestion, UserAnswer) in OfficeAgent; mirrored types in Bebop.
**How to test:**
1. In OfficeAgent worktree: `cd C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 && powershell.exe -Command "yarn workspace @officeagent/message-protocol test"`
2. Verify 113 tests pass including new type shape tests

**Expected behavior:**
- All message protocol tests pass
- Type shape tests validate field names match wire format

### Cowork Demo / Host Integration (P012)
**What changed:** Mock AugLoop server, canned fixtures (CoT events, progression steps), host environment simulation.
**How to test:**
1. In OfficeAgent worktree: `cd C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 && powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo test"`
2. Verify 49 tests pass (mock-augloop-server, fixtures, host-environment, mock-token-provider)
3. Run demo server: `cd C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo && npx ts-node src/demo-server.ts`

**Expected behavior:**
- All 49 demo tests pass
- Demo server starts and serves mock WebSocket responses
- Canned fixtures have monotonically increasing delay_ms values

### AugLoop Transport (P004)
**What changed:** New `@officeagent/augloop-transport` module for AugLoop ↔ OfficeAgent message bridging.
**How to test:**
1. `cd C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15 && powershell.exe -Command "yarn workspace @officeagent/augloop-transport test"`
2. Verify 11 tests pass (message adapter tests)

**Expected behavior:**
- Message-to-operation and annotation-to-message adapters work correctly

### CoT WebSocket Streaming (P002) & Ask-User Handler (P003)
**What changed:** WebSocket handlers for chain-of-thought streaming and bidirectional ask-user-question flow.
**How to test:**
- These handlers are in `modules/api` which fails to build due to pre-existing @types/ws conflicts
- Once core module builds, verify handlers register properly in WebSocket router
- Source code review: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/modules/api/src/websocket/handlers/`

### SharedTree DDS Schema (P013)
**What changed:** Collaborative state schema in cowork-component package using Fluid SharedTree.
**How to test:**
1. Check schema definition: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/packages/cowork-component/src/sharedTree/coworkSchema.ts`
2. Check tree adapter: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/packages/cowork-component/src/sharedTree/coworkTreeAdapter.ts`
3. No tests exist yet for this package

### Loop Component Wrapper (P011)
**What changed:** New `@fluidx/cowork-component` package with CoworkComponent, CoworkComponentFactory, NpmCodeLoader, and manifest entry.
**How to test:**
1. Review files in: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/packages/cowork-component/`
2. No tests exist yet — manual code review only

## Integration Points

Cross-project interactions to verify:
- **Bebop ↔ OfficeAgent protocol alignment**: Mirrored types in `apps/bebop/src/features/cowork/types/messageProtocol.ts` should match `modules/message-protocol/src/types/` in OfficeAgent
- **AugLoop transport**: `augloopTransport.ts` in Bebop should match the message format from `@officeagent/augloop-transport`
- **CoT streaming**: OfficeAgent WebSocket handler emits `ChainOfThoughtUpdate` messages → Bebop progression panel renders steps
- **Ask-user flow**: OfficeAgent sends `AskUserQuestion` → Bebop shows question banner → User answers → Bebop sends `UserAnswer` back
- **SharedTree ↔ Cowork state**: `cowork-component` SharedTree schema should align with Bebop's Jotai atoms for collaborative state sync

## Known Issues

1. **OfficeAgent `@officeagent/core` build fails** — 4 TS errors in `tests/websocket/websocket-manager.test.ts` (`readyState` read-only). Pre-existing on main; fix exists on `user/jakubk/excel-agent-cli` branch but not merged.
2. **OfficeAgent `@officeagent/api` build fails** — Missing agent module declarations and @types/ws version conflict. Requires full Docker build (`yarn build`).
3. **Bebop typecheck fails with 19 errors in cowork files** — Cross-PR interface mismatches from merging 8 independent branches. Key conflicts:
   - `streamingBridge.ts` imports `TransportConfig`, `TransportState`, `AugloopTransport` which were renamed/removed in augloop-annotations PR
   - `useCoworkStream.ts` references atoms (`upsertProgressionStepAtom`, `activeQuestionAtom`, etc.) that were renamed in scaffold PR
   - `CoworkLayout.tsx` has function signature mismatches with hook return types
   - `CoworkErrorBoundary.tsx` missing `override` modifier (TS 5.9 strictness)
4. **augloop-transport test babel issue** — Source `.ts` test can't parse `import type` syntax; compiled `.js` test passes fine. Needs babel config update for TS 5.x type imports.
5. **featureGates.test.ts fails** — Uses `import.meta.env` which doesn't work in Jest CJS environment. Needs Vitest or @swc/jest with ESM support.
6. **cowork-component has no tests** — Package has jest.config.js but no test files created.
7. **OfficeAgent lint errors** — 2 unused vars in `augloop-transport`, 2 unused imports in `cowork-demo` (6 total across both).
8. **Vite dev server uses port 3002** — Ports 3000 and 3001 were already in use.

## Quick Smoke Test

1. Open http://localhost:3002/bebop/ — Verify Bebop homepage loads
2. Open http://localhost:3002/bebop/cowork — Verify redirect to home (feature gate blocks)
3. Open http://localhost:3002/bebop/cowork?EnableBebopCowork=on — Verify cowork layout renders
4. Run: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15" && powershell.exe -Command "yarn workspace @officeagent/message-protocol test"` — Verify 113 tests pass
5. Run: `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15" && powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo test"` — Verify 49 tests pass
