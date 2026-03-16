---
source: lambert-2026-03-16.md
agent: lambert
category: conventions
date: 2026-03-16
---

# Lambert Learnings — 2026-03-16

## PR-4970405: feat(cowork): add OfficeAgent protocol adapter for Bebop client

### Patterns Discovered

1. **NDJSON streaming bridge pattern for TanStack Start**: Server function creates `ReadableStream<string>` with NDJSON-encoded events. Client hook reads with `getReader()`, splits on newlines, parses JSON. Chosen over SSE because TanStack Start's `createServerFn` naturally returns ReadableStream and avoids EventSource reconnection semantics. (source: PR-4970405 `server/streamingBridge.ts`)

2. **Transport registry pattern for avoiding circular deps**: When server functions (`coworkSession.ts`) need to look up active WebSocket connections created by the streaming bridge (`streamingBridge.ts`), extract the lookup Map into a standalone module (`transportRegistry.ts`) that both import. Clean separation. (source: PR-4970405 `server/transportRegistry.ts`)

3. **Adapter pattern separates wire types from UI types**: Two type files — `messageProtocol.ts` (mirrors OfficeAgent wire format) and `coworkTypes.ts` (UI-layer for Jotai/React). The adapter (`messageAdapter.ts`) is pure functions: `adaptMessage(raw) → BridgeEvent[]`. This means the adapter is testable without any React/Jotai context. (source: PR-4970405 `server/messageAdapter.ts`)

4. **AugLoop WebSocket lifecycle management**: `AugloopTransport` class handles connect/reconnect with exponential backoff + jitter, auth token refresh scheduling, ping/pong heartbeat with pong timeout forcing reconnect, and graceful disconnect with handler nullification before close. One instance per session. (source: PR-4970405 `server/augloopTransport.ts`)

### Wire Format Verification Failures

**8 critical wire format mismatches found** between Bebop mirror types and actual OfficeAgent source. Every one produces `undefined` at runtime with no error:

1. **ErrorPayload**: Mirror uses `message`, source uses `errorMsg` (source: `modules/message-protocol/src/types/core.ts:147`)
2. **FileInfo**: Mirror invents `fileId`, `fileName`, `fileType`, `fileUrl`, `fileSize`, `createdAt`. Source has `path`, `filename`, `content`, `size`, `isEdit`, `encoding`, `driveId`, `driveItemId` (source: `core.ts:297-314`)
3. **QueryStatusPayload**: Mirror has flat `slideCount`, source uses nested `slideCountInfo.slideCount`. Mirror adds `message`, `progress`, `errorMessage` — none exist in source. Source uses `error` not `errorMessage` (source: `core.ts:360-371`)
4. **CoTStreamPayload (most impactful)**: Mirror expects `{ events: CoTStreamEvent[], sessionId }`, source sends `{ event: CoTStreamEvent, sequenceNumber }` — singular vs plural, different companion field (source: `chain-of-thought-stream.ts:110-115` in feat/PL-W001)
5. **CoTStepStartedEvent/CoTStepCompletedEvent**: Mirror uses `label`, source uses `stepLabel`. Mirror has required `stepId`, source has optional `stepId?` (source: `chain-of-thought-stream.ts:46-63`)
6. **CoTStepCompletedEvent.durationMs**: Declared in mirror, doesn't exist in source
7. **CoTAskUserQuestionEvent**: Mirror uses `text`, source uses `summary` (source: `chain-of-thought-stream.ts:88-94`)
8. **CoTStreamEventBase.timestamp**: Mirror uses `number`, source uses `string` (ISO 8601) (source: `chain-of-thought-stream.ts:38`)

### Gotchas

- **Jotai `set` with function updater may not work on plain atoms**: `set(artifactsAtom, (prev) => [...prev, artifact])` — the function-as-second-arg pattern for `set` in a write-only atom is not guaranteed to work like React's `setState(prev => ...)`. The other write-only atoms in the same file correctly use `get(atom)` explicitly. (source: PR-4970405 `atoms/coworkAtoms.ts:86-88`)

- **Auth token refresh is time-based, not expiry-based**: `AUTH_REFRESH_BUFFER_MS = 60000` means tokens refresh every 60s regardless of actual token lifetime. Should parse JWT `exp` claim. (source: PR-4970405 `server/augloopTransport.ts:398`)

- **`context?.serverTokenProvider` is untyped**: The TanStack Start server function handler accesses `context.serverTokenProvider.getToken()` without type narrowing. If Bebop's context doesn't provide this, it falls through to `process.env.OAGENT_AUGLOOP_TOKEN` silently. (source: PR-4970405 `serverFunctions/coworkSession.ts`)

- **office-bohemia PRs use REST API for review**: ADO MCP tools (`mcp__azure-ado__*`) are for the OfficeAgent repo. For office-bohemia, use direct REST API: `POST .../pullRequests/{id}/threads` for comments, `PUT .../pullRequests/{id}/reviewers/{id}` for votes.

```skill
---
name: verify-mirrored-types-against-source
description: Verify cross-repo mirrored type field names match the actual source before approving PRs
allowed-tools: Bash, Read, Grep, Glob
trigger: When reviewing PRs that add mirrored/copied types from another repo (e.g., OfficeAgent types mirrored in office-bohemia)
scope: squad
project: any
---

# Verify Mirrored Types Against Source

## When to Use
Any PR that adds type definitions claiming to mirror types from another codebase. Key indicators:
- File header says "Mirrored from..." or "Last synced: ..."
- `// Source: path/to/file.ts:line` comments
- Types for wire protocol / message format

## Steps

1. **Identify source references**: Read the mirrored type file and extract all `// Source:` comments noting file paths and line numbers.

2. **Locate actual source files**: Check the source repo (may be in a different worktree or remote branch):
   - Main branch: `modules/message-protocol/src/types/` (OfficeAgent)
   - Feature branches: Check `git worktree list` for in-flight work
   - If source references a branch like `feat/PL-W001`, find the corresponding worktree

3. **Field-by-field comparison**: For each mirrored interface:
   - Compare every field name (case-sensitive) — `errorMsg` ≠ `message`
   - Compare field types — `string` ≠ `number`, singular ≠ array
   - Compare optionality — `required` ≠ `optional?`
   - Check nested vs flat structure — `slideCountInfo.slideCount` ≠ `slideCount`

4. **Check structural shape**: Payload wrappers may differ:
   - Singular `event` vs plural `events` array
   - Different companion fields (`sequenceNumber` vs `sessionId`)

5. **Flag mismatches as CRITICAL**: Wire format mismatches are silent failures — JSON.parse succeeds but fields produce `undefined`. These are the hardest bugs to find in production.

## Notes
- This is the single most impactful review check for cross-repo adapter code
- OfficeAgent source of truth is in `modules/message-protocol/src/types/`
- In-flight types may be in worktrees under `C:/Users/yemishin/worktrees/`
```
