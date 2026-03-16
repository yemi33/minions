---
source: rebecca-PL-W006-2026-03-16.md
agent: rebecca
category: architecture
date: 2026-03-16
---

# Rebecca Learnings — PL-W006 (OfficeAgent Protocol Adapter)

## Task
Implement the client-side adapter in office-bohemia that translates OfficeAgent WebSocket messages into Bebop's Jotai state model.

## Outcome
- PR-4970405 created targeting `master` in office-bohemia
- 9 files, ~1800 lines of code
- Branch: `user/yemishin/cowork-protocol-adapter`

## Patterns Discovered

### Bebop Server Function Pattern (inputValidator)
- `createServerFn({ method: 'POST' }).inputValidator(zodSchema).handler(async ({ data, context }) => {...})`
- Two valid patterns: fluent with schema object (Pattern A) or custom validator function returning typed data (Pattern B)
- Server context provides `serverTokenProvider`, `perfTracker`, `auth` for server-side operations
- (source: apps/bebop/src/features/conversation/serverFunctions/chat.ts)

### NDJSON Streaming Pattern for TanStack Start
- Server functions can return `ReadableStream<string>` directly
- NDJSON (newline-delimited JSON) is simpler than SSE for TanStack Start since no EventSource API needed
- Client reads with `ReadableStream.getReader()` and splits on newlines
- (source: apps/bebop/src/features/cowork/server/streamingBridge.ts)

### Transport Registry Pattern (Breaking Circular Dependencies)
- When a server function needs to look up a resource created by another module, extract the registry to a third module
- Both serverFunctions/coworkSession.ts and server/streamingBridge.ts import from server/transportRegistry.ts
- Prevents circular: serverFunctions → streamingBridge → serverFunctions
- (source: apps/bebop/src/features/cowork/server/transportRegistry.ts)

### Orphaned Worktree Recovery
- Prior agent work in `feat-PL-W006-adapter` worktree was 100% complete (not 90% as Dallas assessed)
- All 3 "fixes" Dallas identified were already correct in the code: `.inputValidator()` was used (not `.validator()`), `registerTransport()` call existed in streamingBridge, JSDoc was fine
- Recovery was just: review code quality → `git add` → commit → push → PR
- (source: /c/Users/yemishin/worktrees/feat-PL-W006-adapter)

## Conventions Confirmed

### office-bohemia PR Creation via az CLI
- ADO MCP tools (`mcp__azure-ado__*`) are sometimes unavailable as deferred tools
- Fallback: `az repos pr create --repository office-bohemia --source-branch <branch> --target-branch master --org https://office.visualstudio.com/DefaultCollection --project OC`
- PR thread comments via REST API: `POST {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1`
- JSON body must use simple string content (no complex markdown with arrows/backticks that cause encoding issues in curl)
- Node.js `https.request` is more reliable than curl for posting complex content
- (source: PR-4970405 creation process)

### Cross-Repo PR Tracking
- office-bohemia PRs tracked in OfficeAgent's `.squad/pull-requests.json` with `"repo": "office-bohemia"` and `"targetBranch": "master"` fields
- Repo ID for office-bohemia: `74031860-e0cd-45a1-913f-10bbf3f82555`
- Project: `OC` (not `ISS` like OfficeAgent)
- (source: C:\Users\yemishin\OfficeAgent\.squad\pull-requests.json)

## Architecture Notes

### Adapter Layer Design
- Pure function adapter (messageAdapter.ts) maps Message<T> → BridgeEvent[] with zero side effects
- BridgeEvent is a discriminated union on `type` field covering: connection_status, session_init, query_status, cot_update, ask_user_question, error, done
- Transport layer (augloopTransport.ts) handles reconnection with exponential backoff + jitter, auth token refresh, ping/pong heartbeat
- Client hook (useCoworkStream.ts) dispatches events to individual Jotai atoms via switch on event type
- (source: apps/bebop/src/features/cowork/server/messageAdapter.ts, streamingBridge.ts, hooks/useCoworkStream.ts)

## Gotchas

- **curl JSON encoding on Windows**: Special characters (arrows, backticks) in JSON payloads get mangled by Windows shell escaping. Use Node.js `https.request` instead of curl for complex PR comments.
- **python3 unavailable on Windows**: Microsoft Store stub intercepts. Use `node -e` for scripting.
- **Task scope mismatch**: PL-W006 was dispatched as "Project — OfficeAgent" but actual code lives in office-bohemia repo. Always verify by checking `git remote -v` in the worktree.
