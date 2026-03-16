---
source: verify-2026-03-16.md
agent: verify
category: build-reports
date: 2026-03-16
---

# Manual Testing Guide

**Date:** 2026-03-16
**Plan:** officeagent-2026-03-15.json — Claude Cowork UX in Bebop with OfficeAgent capabilities, AugLoop integration, and 1JS packaging
**Local Server:** http://localhost:3002/bebop/ (Vite dev, no-auth mode)
**Restart Command:** `cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop" && powershell.exe -Command "yarn dev:no-auth"`

## Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| OfficeAgent (message-protocol) | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` | PASS (3.59s) | 113 pass, 0 fail | Clean build and test |
| OfficeAgent (augloop-transport) | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` | PASS (3.68s) | 11 pass, 1 suite fail | Babel `import type` parse error in source tests (pre-existing) |
| OfficeAgent (core) | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` | FAIL | N/A | 4 TS errors: readyState read-only property in websocket-manager.test.ts (pre-existing on main) |
| OfficeAgent (cowork-demo) | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15` | PASS | 49 pass, 0 fail | 4 test suites: fixtures, mock-augloop, host-env, mock-token |
| office-bohemia (Bebop) | `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob` | FAIL (typecheck) | N/A | 19 TS errors in 6 cowork files from cross-PR integration mismatches. Transpile PASS. Vite dev works. |

## E2E Pull Requests

- **OfficeAgent:** [PR-4972662](https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4972662) — `e2e/cowork-w025` → `main` (7 PRs merged)
- **office-bohemia:** [PR-4972663](https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663) — `e2e/cowork-w025` → `master` (8 PRs merged)

## What to Test

### P001: CoT + Ask-User Message Protocol Types (OfficeAgent)
**What changed:** Added `ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer` to MessageType enum; new payload interfaces `ChainOfThoughtUpdatePayload`, `AskUserQuestionPayload`, `UserAnswerPayload`.
**How to test:**
1. Open `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/modules/message-protocol/src/message-type.ts`
2. Verify new enum values exist: `ChainOfThoughtUpdate`, `AskUserQuestion`, `UserAnswer`
3. Check payload types in `src/cowork-types.ts` for proper structure
4. Run: `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15' && yarn workspace @officeagent/message-protocol test"`

**Expected behavior:**
- 113 tests pass
- New MessageType values compile without breaking existing values

### P002: CoT WebSocket Streaming Handler (OfficeAgent)
**What changed:** New WebSocket handler for streaming chain-of-thought updates from agent to client in real-time.
**How to test:**
1. Check handler exists in `modules/api/src/websocket/handlers/` for CoT streaming
2. Verify it follows the existing 14-handler pattern
3. Build: `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15' && yarn workspace @officeagent/message-protocol build"`

**Expected behavior:**
- Handler registered in WebSocket router
- Accepts `ChainOfThoughtUpdate` message type

### P003: Ask-User-Question WebSocket Handler (OfficeAgent)
**What changed:** Bidirectional WebSocket handler: server sends `AskUserQuestion`, client responds with `UserAnswer`.
**How to test:**
1. Check handler in `modules/api/src/websocket/handlers/`
2. Verify request/response pairing via `requestId`
3. Tests in cowork-demo cover this flow

**Expected behavior:**
- Server→Client: `AskUserQuestionMessage` with question text, options, timeout
- Client→Server: `UserAnswerMessage` with selected answer and requestId

### P004: AugLoop Transport Adapter (OfficeAgent)
**What changed:** New `@officeagent/augloop-transport` module bridging OfficeAgent to AugLoop messaging.
**How to test:**
1. Run: `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15' && yarn workspace @officeagent/augloop-transport test"`
2. Check `modules/augloop-transport/src/` for transport adapter, message converter, connection manager

**Expected behavior:**
- 11 tests pass (from dist)
- Module builds cleanly

### P005: Bebop Cowork Feature Gate (office-bohemia)
**What changed:** Feature gate at `apps/bebop/src/features/cowork/featureGates.ts` with three-level precedence: query param > localStorage > env var.
**How to test:**
1. Navigate to http://localhost:3002/bebop/cowork — should show access denied or redirect without gate
2. Navigate to http://localhost:3002/bebop/cowork?cowork_enabled=true — should show cowork UI
3. Check `featureGates.ts` source for `isCoworkEnabled()` function

**Expected behavior:**
- Gate blocks access by default
- `?cowork_enabled=true` query param enables access
- `localStorage.setItem('cowork_enabled', 'true')` persists access

### P006: Cowork Feature Module Scaffold (office-bohemia)
**What changed:** Three-panel layout: chat panel (left), progression panel (center), artifact panel (right).
**How to test:**
1. Navigate to http://localhost:3002/bebop/cowork?cowork_enabled=true
2. Inspect the page for three-panel layout
3. Check `CoworkLayout.tsx` for panel structure

**Expected behavior:**
- Three-panel responsive layout renders
- Each panel has proper CSS module styling
- Route exists at `_mainLayout.cowork.tsx`

### P007: Cowork Mirrored Protocol Types (office-bohemia)
**What changed:** TypeScript types in `features/cowork/types/messageProtocol.ts` mirroring OfficeAgent wire format.
**How to test:**
1. Open `apps/bebop/src/features/cowork/types/messageProtocol.ts`
2. Verify `MessageSchema`, `Message<T>`, `ResponseMessage<T>` match OfficeAgent types
3. Check `// Last synced:` header and `// Source:` annotations

**Expected behavior:**
- String union types (not enums) for tree-shaking
- All fields `readonly` for immutability
- Discriminated unions use `kind` field

### P009: OfficeAgent Protocol Adapter (office-bohemia)
**What changed:** Adapter layer in `features/cowork/server/messageAdapter.ts` bridging OfficeAgent messages to Bebop state model.
**How to test:**
1. Check `messageAdapter.ts` for message transformation logic
2. Verify it converts OfficeAgent wire format to Jotai-compatible state updates

### P010: Artifact Preview Panel (office-bohemia)
**What changed:** Tabbed artifact display with sandboxed iframes and download buttons.
**How to test:**
1. Navigate to http://localhost:3002/bebop/cowork?cowork_enabled=true
2. Look for artifact panel on the right side
3. Check `ArtifactPanel.tsx`, `DocumentPreview.tsx`, `DownloadButton.tsx`

**Expected behavior:**
- Tabbed UI for multiple artifacts
- Sandboxed iframe for document preview
- Download button for each artifact

### P012: Host Integration Demo (OfficeAgent)
**What changed:** Demo/test fixtures in `.devtools/cowork-demo/` with mock AugLoop server, host environment, and token provider.
**How to test:**
1. Run: `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo' && yarn test"`

**Expected behavior:**
- 49 tests pass across 4 suites
- Mock AugLoop server simulates message flow
- Host environment validates iframe constraints

### P013: SharedTree DDS Collaborative State (office-bohemia)
**What changed:** SharedTree schema and adapter for real-time collaborative cowork sessions.
**How to test:**
1. Check `apps/bebop/src/features/cowork/types/coworkTypes.ts` for SharedTree schema definition
2. Verify schema includes session state, progression steps, artifacts, user questions

### P016: Error Handling and Resilience (office-bohemia)
**What changed:** `CoworkErrorBoundary.tsx`, `ConnectionStatusBanner.tsx`, `useConnectionResilience.ts`, connection atoms.
**How to test:**
1. Check error boundary wraps cowork layout
2. Verify connection status banner shows reconnection state
3. Check `connectionAtoms.ts` for connection state management

## Integration Points

Cross-project interactions to verify:
- **OfficeAgent message-protocol ↔ Bebop mirrored types**: Field names, payload shapes, and enum values must match exactly between `modules/message-protocol/src/` and `apps/bebop/src/features/cowork/types/messageProtocol.ts`
- **CoT streaming flow**: OfficeAgent WebSocket handler → Bebop `useCoworkStream` hook → progression atoms → ProgressionCard UI
- **Ask-user-question flow**: OfficeAgent sends question via WebSocket → Bebop renders question in chat panel → User answers → Response sent back via `UserAnswer` message
- **AugLoop transport**: Bebop augloopTransport.ts → OfficeAgent augloop-transport module → AugLoop service
- **Feature gate → Route guard**: `featureGates.ts` → `coworkRouteGuard.ts` → `_mainLayout.cowork.tsx`

## Known Issues

1. **19 TypeScript errors in office-bohemia** — Cross-PR integration mismatches in 6 cowork files:
   - `streamingBridge.ts`: imports `TransportConfig`/`TransportState`/`AugloopTransport` that don't exist in current `augloopTransport.ts` exports
   - `useCoworkStream.ts`: references renamed atoms (`upsertProgressionStepAtom` → `progressionStepsAtom`, etc.)
   - `CoworkErrorBoundary.tsx`: needs `override` modifier (TS 5.9)
   - `CoworkLayout.tsx`: 2 errors
   - `CoworkChatPanel.tsx`: 1 error
   - `transportRegistry.ts`: 1 error
2. **OfficeAgent core module build fails** — Pre-existing `readyState` read-only property errors in websocket-manager.test.ts (fix on unmerged branch `user/jakubk/excel-agent-cli`)
3. **augloop-transport source tests fail** — Babel config doesn't handle `import type` syntax; compiled dist tests pass
4. **featureGates.test.ts incompatible with Jest** — Uses `import.meta.env` (Vite API) which CJS Jest can't parse; needs Vitest
5. **Vite dev server requires no-auth mode** — `yarn dev` needs auth-proxy; use `yarn dev:no-auth` for local testing

## Quick Smoke Test

1. Open http://localhost:3002/bebop/ — verify Bebop app loads (may show auth error, which is expected in no-auth mode)
2. Open http://localhost:3002/bebop/cowork?cowork_enabled=true — verify cowork route renders (three-panel layout)
3. Run `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15' && yarn workspace @officeagent/message-protocol test"` — verify 113 tests pass
4. Run `powershell.exe -Command "cd 'C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo' && yarn test"` — verify 49 tests pass
5. Check `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop/src/features/cowork/` — verify all component files exist (30+ files across atoms, components, hooks, server, types)
