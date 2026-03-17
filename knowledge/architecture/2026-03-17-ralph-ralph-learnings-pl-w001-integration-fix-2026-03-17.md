---
source: ralph-PL-W001-2026-03-17.md
agent: ralph
category: architecture
date: 2026-03-17
---

# Ralph Learnings — PL-W001 Integration Fix (2026-03-17)

## Task
Fix 17 TypeScript errors and 5 protocol type mismatches in office-bohemia e2e/cowork-w025 branch (PR-4976177).

## Result
All 17 TS errors resolved, 5 protocol types aligned, feature gate unified. `yarn lage transpile typecheck --to @bebopjs/bebop` passes with 114 targets, 0 failures.

## Key Findings

### Architecture — Two Separate Transport Layers
- **WebSocket transport** (`server/websocketTransport.ts`) handles OfficeAgent endpoint communication — connection lifecycle, reconnect, message routing (source: `apps/bebop/src/features/cowork/server/websocketTransport.ts`, created in this PR)
- **Annotation transport** (`server/augloopTransport.ts`) handles AugLoop annotation lifecycle — activation, retry, fallback (source: `apps/bebop/src/features/cowork/server/augloopTransport.ts:71-332`)
- The original cross-PR merge confused these: `streamingBridge.ts` imported `AugloopTransport` from annotation module expecting a WebSocket client class (source: `streamingBridge.ts:22-23`)

### Protocol Type Drift Pattern
- OfficeAgent wire format uses `settings: { agentId, prompt }` (nested), Bebop originally used flat `{ agentId, prompt }` (source: `types/messageProtocol.ts:63-73`)
- OfficeAgent uses `containerInstanceId`, Bebop used `sessionId` (source: `types/messageProtocol.ts:69-73`)
- OfficeAgent uses `path` for file identity, Bebop used `fileId` (source: `types/messageProtocol.ts:95-102`)
- OfficeAgent uses `errorMsg`, Bebop used `message` (source: `types/messageProtocol.ts:220-224`)
- OfficeAgent CoT events use `stepLabel` and ISO8601 `timestamp` string, Bebop used `label` and numeric timestamp (source: `types/messageProtocol.ts:130-151`)
- **The adapter layer (`server/messageAdapter.ts`) maps wire format names to UI-layer names** — this is the correct pattern: mirror the wire format exactly in messageProtocol.ts, then transform in the adapter

### Duplicate Type Files Pattern
- `types.ts` (root) and `types/coworkTypes.ts` define overlapping but different `CoworkSession` and `ProgressionStep` types (source: `types.ts:18-49` vs `types/coworkTypes.ts:15-46`)
- `coworkAtoms.ts` imports from `../types` (root), while hooks/adapter import from `../types/coworkTypes`
- This caused subtle mismatches — `CoworkSession` in `types.ts` has `status: SessionStatus` but `types/coworkTypes.ts` version originally lacked it
- **Rule**: When merging PRs that add types, check for duplicate type definitions with similar names

### Feature Gate Unification
- Route file (`_mainLayout.cowork.tsx`) used `EnableBebopCowork` query param (source: `_mainLayout.cowork.tsx:23-36`)
- `featureGates.ts` used `bebop.cowork.enabled` via `getFluidExperiencesSetting` (source: `featureGates.ts:9`)
- Unified by making route delegate to `isCoworkEnabled()` from featureGates.ts — uses `getFluidExperiencesSetting` which already handles query params, localStorage, sessionStorage (source: `_mainLayout.cowork.tsx:18-22` after fix)

### TS 5.9 Override Modifier
- `noImplicitOverride: true` in root tsconfig (source: `tsconfig.json:16`)
- `static getDerivedStateFromError` does NOT need `override` — it's a static method, not an instance method override (source: `CoworkErrorBoundary.tsx:28`)
- `componentDidCatch` and `render` DO need `override` when extending `Component` (source: `CoworkErrorBoundary.tsx:32,45`)

### Build System
- `yarn lage transpile typecheck --to @bebopjs/bebop` is the correct build command for office-bohemia (source: CLAUDE.md)
- Lage caches aggressively — 112 of 114 targets skipped on second run
- Worktree needs `yarn install` before first build (~35s)

## Bugs & Gotchas
- **Windows `/dev/stdin` not available**: Use `$TEMP/filename.json` pattern for curl I/O on Windows (source: ADO REST API calls in this session)
- **ADO REST API error `TF401179`**: "An active pull request for the source and target branch already exists" — check existing PRs before creating new ones (source: curl response creating PR-4976177)
- **`noUnusedLocals` catches `_`-prefixed vars**: Unlike TypeScript default, office-bohemia's strict config treats `_toolMatch` as unused local. Must actually remove the declaration, not just prefix (source: `tsconfig.json:17`, `CoworkChatPanel.tsx:192`)
