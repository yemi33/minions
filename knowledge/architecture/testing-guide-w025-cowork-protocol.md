---
title: Testing Guide — W025 Cowork Protocol & Integration
category: architecture
date: 2026-03-17
plan: plan-w025-2026-03-15.md
prd: officeagent PRD (W025 → W032)
---

# Testing Guide — Cowork Protocol & OfficeAgent Integration

**Plan:** W025 — Claude Cowork UX in Bebop with OfficeAgent + AugLoop
**Date:** 2026-03-17

---

## 1. Known Protocol Mismatches (Must Fix Before Production)

Ripley flagged 5 type divergences between Bebop (`office-bohemia`) and OfficeAgent that will surface when real messages flow through AugLoop vs. mock fixtures:

| # | Type | Bebop Version | OfficeAgent Version | Risk |
|---|------|--------------|---------------------|------|
| 1 | **SessionInitPayload** | Simplified — omits container-internal fields | Includes `OfficePySettings`, `McpServers`, `groundingSourceToggles` | Bebop sends incomplete init → agent init may fail |
| 2 | **FileInfo** | Metadata only (name, path, type) | Includes `content` and `Buffer` fields | Mismatch on artifact handling |
| 3 | **ErrorPayload** | Uses `message` field | Uses `errorMsg` field | Errors silently dropped or misread |
| 4 | **CoTStreamEvent** | Simplified discriminated union | Different discriminated union structure | Progression UI shows wrong/missing steps |
| 5 | **QueryStatus** | Flat pattern | Nested pattern differences | Status updates lost or misinterpreted |

**Impact:** All 5 mismatches are currently masked by mock fixtures in tests. Real AugLoop traffic will expose them as runtime failures — silent data loss, missing UI updates, or hard crashes.

### Verification Steps

1. **Type alignment audit**: Diff `apps/bebop/src/features/cowork/types.ts` against `modules/message-protocol/src/types/` in OfficeAgent
2. **Wire-format test**: Send real OfficeAgent messages through the Bebop `messageAdapter.ts` and verify no `as unknown as` casts silently drop fields
3. **Round-trip test**: `SessionInit` from Bebop → AugLoop → OfficeAgent → response → Bebop. Verify all fields survive.

---

## 2. Other Testing Priorities from Ripley's Review (PR-4972663)

### Type Safety Issues (23+ `as` assertions)
- `useCoworkStream.ts` (8 casts)
- `useDemoCoworkSession.ts` (6 casts)
- `messageAdapter.ts` (9 casts)
- `augloopTransport.ts` (2 casts)
- **Test**: Replace each `as` with a type guard; run tsc strict mode; verify no runtime `undefined` access

### Feature Gate Disconnect
- ECS: `bebop.cowork.enabled` via `getFluidExperiencesSetting()`
- Local: `EnableBebopCowork` query param/localStorage
- `coworkRouteGuard.ts` calls ECS path; `_mainLayout.cowork.tsx` calls local function
- **Test**: Verify both gates block/allow consistently. Toggle ECS off → route should be blocked even if localStorage is set.

### Hardcoded Demo WebSocket
- `ws://localhost:11040/ws` in `useDemoCoworkSession.ts` imported by production `CoworkChatPanel`
- **Test**: Verify demo hook is not called in production builds. Should be behind `process.env.NODE_ENV === 'development'` or lazy import.

### Test Coverage Gap
- 26+ files, ~3,500 lines of new code, only 1 test file (`featureGates.test.ts`)
- **Priority test files needed**:
  - `messageAdapter.test.ts` — protocol translation correctness
  - `useCoworkStream.test.ts` — WebSocket lifecycle
  - `progressionAtoms.test.ts` — state transitions
  - `augloopTransport.test.ts` — connection/reconnect/auth

---

## 3. Integration Test Scenarios

### E2E Happy Path
1. Open `/cowork` route in Bebop
2. Feature gate allows access
3. WebSocket connects to AugLoop
4. Send user message → `SessionInit` → `AgentRequest`
5. Receive `CoTStreamEvent` → progression UI updates
6. Receive `AskUserQuestion` → user answers → agent resumes
7. Receive `ArtifactGenerated` → artifact preview renders
8. Receive completion → final response shown

### Error Scenarios
| Scenario | Expected Behavior |
|----------|-------------------|
| AugLoop unreachable | Friendly error with retry button |
| WebSocket disconnect mid-session | Auto-reconnect with state recovery |
| Agent timeout (>5 min) | User notification with cancel option |
| Auth token expired | Transparent refresh, no user disruption |
| Invalid message format | Error logged, UI shows generic error, no crash |
| Draft PR (no votes) | Vote skipped, comment posted |

### Cross-Repo Build Verification
1. Build OfficeAgent: `message-protocol` → `core` → `augloop-transport`
2. Build Bebop: `packages/cowork-component` → `apps/bebop`
3. Verify type exports from OfficeAgent match type imports in Bebop
4. Run `tsc --noEmit` in both repos — zero errors

---

## 4. How to Build AugLoop Locally

### Prerequisites
- Node.js 18+
- Yarn (workspace-aware)
- Access to `@augloop/runtime-client` npm package (internal feed)
- OfficeAgent repo cloned locally

### OfficeAgent AugLoop Transport Module

```bash
# Navigate to OfficeAgent repo
cd C:/Users/yemishin/OfficeAgent

# Build dependencies in order (must be sequential)
yarn workspace @officeagent/message-protocol build
yarn workspace @officeagent/core build
yarn workspace @officeagent/augloop-transport build
```

### AugLoop Test Client (for local E2E testing)

```bash
# The test client lives at .devtools/test-client/
cd .devtools/test-client

# Install deps
yarn install

# Run test client (connects to local OfficeAgent on port 6010)
# Default environment is Dogfood; for local dev use Dev
OAGENT_AUGLOOP_ENV=Dev yarn start
```

### AugLoop Environments

| Environment | Endpoint | Use Case |
|-------------|----------|----------|
| Dev/Local | `localhost:11040` | Local development |
| Test | `*.cloud.dev.microsoft` | CI/testing |
| Int | `*.cloud.dev.microsoft` | Integration |
| Dogfood | `*.cloud.microsoft` | Internal preview |
| MSIT | `*.cloud.microsoft` | Microsoft IT |
| Prod | `*.cloud.microsoft` | Production |

### Local E2E Flow

1. **Start OfficeAgent container locally:**
   ```bash
   cd C:/Users/yemishin/OfficeAgent
   # Use the oagent CLI or Docker
   yarn start  # Starts on port 6010
   ```

2. **Start AugLoop test client:**
   ```bash
   cd .devtools/test-client
   OAGENT_AUGLOOP_ENV=Dev yarn start
   ```

3. **Start Bebop dev server:**
   ```bash
   cd C:/Users/yemishin/office-bohemia
   yarn workspace @nickel/bebop dev
   # Open http://localhost:3000/cowork
   ```

4. **Verify WebSocket flow:**
   - Test client sends `SessionInit` with `agentId: "office-agent,grounding-agent"`
   - OfficeAgent initializes agents from registry
   - Send `POST /generateDocument` with test query
   - Observe CoT streaming events in test client output
   - Verify Bebop UI renders progression

### AugLoop Session Lifecycle

1. `createRuntime()` → `IClientRuntime`
2. `runtime.init()` → ready
3. `runtime.createSession()` → `onSessionConnect(isSeedingRequired)`
4. If seeding required: `submitSeedOperations()` with `Document({ isReadonly: false })` at path `['session']`
5. `submitOperation()` for data ops
6. `activateAnnotation()` for annotation types
7. Results arrive via `onAnnotationResult` callback in `IHostCallbacks`

### Auth for Local Dev

- Set `OAGENT_AUGLOOP_TOKEN` env var with a valid token
- Or use `IHostCallbacks.requestAuthToken` callback (test client ignores the `IAuthTokenRequest` parameter)
- Auth token type: `IAuthTokenResponse.Token?: string`

---

## 5. Mock vs. Real Message Comparison Checklist

Before merging to production, verify each message type with both mock and real payloads:

- [ ] `SessionInit` — mock sends simplified payload; verify real AugLoop `SessionInit` with all container fields
- [ ] `CoTStreamEvent` — mock uses hardcoded steps; verify real agent CoT events have correct discriminated union
- [ ] `QueryStatus` — mock uses flat status; verify real nested pattern from OfficeAgent
- [ ] `AskUserQuestion` — mock sends simple text; verify real structured question format
- [ ] `ArtifactGenerated` — mock sends filename only; verify real payload with `{filename, path, type, fileSize}`
- [ ] `ErrorPayload` — mock uses `message`; verify real OfficeAgent `errorMsg` field is handled
- [ ] `FileInfo` — mock sends metadata; verify real payload with `content`/`Buffer` fields handled gracefully
