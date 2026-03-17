---
title: PreRead: Cowork "Weave" Architecture
category: architecture
date: 2026-03-17
source: inbox/preread-cowork-weave-architecture-2026-03-17.md
---

# PreRead: Cowork "Weave" Architecture

**Date:** 2026-03-17
**Context:** Architectural gap analysis between Cowork Weave (1JS/MCS Aether) and OfficeAgent (ISS/Bebop). This is what we're building toward.

---

## Executive Summary

Cowork Weave uses a **server-stateful, async, fire-and-forget** architecture that enables task resumption, long-running background execution, and seamless reconnection. OfficeAgent uses a **server-stateless, synchronous, request-response** model where all state lives in container memory for the duration of a single HTTP request. Still working — mobile is a lot of work.

---

## 1. Conversation ID as Persistence Key

**Weave**
Stable composite key `{tenantId}:{userId}:{sessionId}`, server-generated, referenced in all `POST /v1/messages` calls. The server owns full execution state keyed by this ID.

**AugLoop/OfficeAgent**
`conversationId` exists and is passed in `POST /generateDocument` and `SessionInit`, but it is used only as a correlation ID for logging and routing — not as a key into durable state.

**Gap: CRITICAL**
OfficeAgent's `conversationId` is a movement-you-set-around-to-IDK-purpose. Nothing is persisted server-side keyed by it. If AugLoop drops the session, the ID is meaningless. The ID itself is structurally adequate — the problem is the absence of a persistence layer behind it.

Key files:
- `modules/api/src/app.ts` — receives `conversationId` in `/generateDocument`
- `modules/api/src/websocket/handlers/session-init-handler.ts` — receives it in `SessionInit`

---

## 2. Server-Side State Model

**Weave**

| Capability | How It Works |
|---|---|
| Async responses | `POST /v1/messages` returns 202 Accepted immediately. Server processes asynchronously, streams results via SSE. |
| SSE reconnection | If the client disconnects and reconnects to `/v1/subscribe`, the server replays current state. |
| Pending interactions | If the agent is waiting on `ask_user_question`, the SSE re-emits the pending question card on reconnect. |
| Scheduled prompts | `scheduledPromptsEnabled=true` in `x-container-config` confirms server can hold and schedule prompts. |

**AugLoop/OfficeAgent**

| Capability | Current State |
|---|---|
| Async responses | Not supported. `POST /generateDocument` is synchronous — blocks until the agent finishes and returns `{filePath, fileName, fileSize}`. |
| SSE reconnection | Partial. Session-init handler detects `isInitialized` and re-inits settings on WS reconnect (`session-init-handler.ts:86`), but there is no replay of task progress or pending state. |
| Pending interactions | Not supported. Request interceptors support clarification cards (`presentationConfig.json`), but these are one-shot on first turn only. No mechanism to re-emit pending questions after disconnect. |
| Scheduled prompts | Not supported. OfficeAgent processes requests synchronously in a single HTTP request/response cycle. |

**Gap: CRITICAL**
All agent state (orchestrator context, tool loop, workspace files) lives only in container memory. No Cosmos DB, no Redis, no blob checkpointing. If the container dies or the HTTP connection drops, everything is lost.

---

## 3. MRU Task History

**Weave**
`/v1/mru/subscribe` SSE endpoint streams task history. `RecentTaskList.js` renders the "Cowork > Tasks" breadcrumb. Users can see previously completed tasks, navigate to results, and resume paused/interrupted tasks.

**AugLoop/OfficeAgent**
No task history endpoint. No MRU concept. OfficeAgent is stateless between requests — each `POST /generateDocument` is independent.

**Gap: CRITICAL**
There is no way for a user to see past tasks or navigate back to them. AugLoop may have its own task tracking externally, but OfficeAgent contributes nothing to it and exposes no API for it.

---

## 4. Resumption Scenarios

| Scenario | Weave Behavior | AugLoop/OfficeAgent Behavior | Gap |
|---|---|---|---|
| Browser refresh mid-task | SSE reconnects, server replays progress + pending cards | WebSocket reconnects (`session-init-handler.ts:86`), settings re-init. But the `POST /generateDocument` HTTP response is already in-flight — if the client dropped it, there's no way to get it back. TaskUpdate WS notifications are fire-and-forget — not replayed. | GAP |
| Close and reopen | MRU shows task, user clicks to resume | No MRU. No persisted task state. The document may have been generated but the user has no way to find it. | CRITICAL |
| Agent waiting for user input | Pending question re-emitted via SSE | Clarification is synchronous within the HTTP request flow (interceptors block the response). If the connection drops during clarification, the request fails. | GAP |
| Network interruption | SSE auto-reconnects, server streams from current state | WebSocket reconnects, but task progress is not replayed. Heartbeats (15s in `grounding-agent.ts:181`) prevent AugLoop timeout during active connections but don't help with reconnect. | GAP |

Key files:
- `modules/core/src/websocket/websocket-manager.ts:239-241` — `ws.on('close')` calls `onSessionClosed()`
- `agents/grounding-agent/src/grounding-agent.ts:178-181` — heartbeat interval

---

## 5. Session Authentication

**Weave**
Three-header auth model:
```
x-ms-weave-auth: Bearer {JWT}              → User identity
x-connection-creation-token: Bearer {JWT}   → Per-connection auth (refreshable)
x-container-config: renderUi=true;...       → Container configuration
```
The `x-connection-creation-token` is a separate JWT for establishing SSE connections — short-lived and refreshable without disrupting the conversation.

**AugLoop/OfficeAgent**
Auth is handled entirely by AugLoop. OfficeAgent receives a WOPI token and session context via `SessionInit`. No independent auth layer.

**Gap: MINOR**
This is by design since AugLoop is the auth proxy. However, OfficeAgent has no ability to independently validate a reconnecting client, which would be needed if OfficeAgent ever exposed a direct SSE endpoint for Bebop.

---

## 6. Long-Running Tasks

**Weave**

| Capability | How It Works |
|---|---|
| Fire-and-forget messages | 202 Accepted + SSE results. Client never blocks. |
| SSE as heartbeat | `/v1/subscribe` stays open; server pushes thinking indicators, progress, text, cards, completion signals. |
| Background execution | User switches tabs → SSE stays alive, server keeps working. |
| Multi-minute autonomy | 7.5-minute session observed; 261s of autonomous work between user answers. |
| Lazy bundle loading | UI components loaded on-demand (e.g., `ask-user-question.js` loaded 90s in). |

**AugLoop/OfficeAgent**

| Capability | Current State | Status |
|---|---|---|
| Fire-and-forget messages | Synchronous HTTP — `POST /generateDocument` blocks for the full duration. 60-min timeout in `llm-proxy-handler.ts` accommodates this, but it's still blocking. | ARCHITECTURAL GAP |
| Progress streaming | `TaskUpdate` notifications stream via WebSocket (CoT, artifacts, ArtifactGenerated). Heartbeats every 15s in grounding-agent. | PARTIAL MATCH |
| Background execution | Works while WebSocket stays open. But if WS drops, `onSessionClosed()` fires and the container may be recycled. | GAP |
| Multi-minute autonomy | Supported — orchestrator runs with `maxTurns: 2000`, agents execute multi-phase workflows (research → doc gen → sanitization). | MATCH |
| Lazy bundle loading | N/A — OfficeAgent is backend-only. | N/A |

Key files:
- `modules/api/src/websocket/handlers/llm-proxy-handler.ts` — 60-min `REQUEST_TIMEOUT_MS`
- `modules/orchestrator/src/providers/ghcp-orchestrator.ts` — `maxTurns: 2000`

---

## 7. Stateless Client

**Weave**
The client carries zero conversation state — it is purely a renderer. Receives `conversationId` from the server, passes it back on every `POST /v1/messages`, renders whatever the SSE stream sends. If the client crashes, the server still holds the full task state. Any client with `conversationId` + auth can resume.

**AugLoop/OfficeAgent**
OfficeAgent is also stateless per-request, but the server is also effectively stateless — it holds state only in-memory for the duration of a single request. The gap is inverted: Weave's server is stateful so the client can be stateless. OfficeAgent's server is also stateless, so nobody holds durable state.

**Gap: CRITICAL**
The "resume" capability is impossible when neither client nor server persists state.

---

## What Already Works

| Capability | Evidence |
|---|---|
| Multi-minute autonomous execution | `maxTurns: 2000` in GHCP orchestrator |
| Real-time progress streaming | WebSocket `TaskUpdate` notifications (CoT, artifacts, ArtifactGenerated) |
| Heartbeats to prevent AugLoop timeout | 15s interval in `grounding-agent.ts:181` |
| WebSocket reconnect with settings re-init | `session-init-handler.ts:86` detects `isInitialized` and re-applies settings |
| ConversationId correlation | Exists and flows through `SessionInit` → `/generateDocument` → logging |
| SSE support for LLM streaming | `llm-proxy-handler.ts` writes `text/event-stream` chunks for `stream: true` requests |

---

## Remediation Roadmap

### P0 — Must Have

| Gap | What to Build | Scope |
|---|---|---|
| No async job model | Replace synchronous `POST /generateDocument` with 202 Accepted + `jobId`. Agent processes in background; results delivered via streaming channel. Requires new job queue (e.g., Azure Service Bus or in-memory with persistence). | AugLoop protocol + OfficeAgent `modules/api` |
| No durable state store | Persist task state (`conversationId`, progress, pending questions, output artifact references) to Cosmos DB or equivalent. Foundation for all resumption features. | New module or extension to `modules/core` |
| No task resumption | Build a `GET /v1/tasks/{conversationId}` endpoint (or equivalent AugLoop protocol extension) that returns current task state + pending interactions on reconnect. | AugLoop + OfficeAgent `modules/api` |

### P1 — Should Have

| Gap | What to Build | Scope |
|---|---|---|
| No MRU/task history | Either OfficeAgent or AugLoop needs a per-user task list API with status and output references. Could be a thin layer over the durable state store. | AugLoop or new OfficeAgent endpoint |
| No SSE subscribe endpoint | Add an SSE endpoint (or enhance WebSocket protocol) that supports reconnect with state replay — not just settings re-init. Alternative: define a WS message type for "replay pending state." | OfficeAgent `modules/api` |
| No pending-question persistence | If the agent needs clarification and the user disconnects, the question must survive in durable storage and be re-emitted on reconnect. | OfficeAgent agent layer + state store |

### P2 — Nice to Have

| Gap | What to Build | Scope |
|---|---|---|
| Background execution not guaranteed | Decouple container lifecycle from WebSocket session. Agent should complete even if AugLoop disconnects — results stored durably for later retrieval. | AugLoop container management |
| Output artifacts not persisted progressively | Upload generated docs to blob storage or ODSP during generation, not just at the end. Ensures output survives container recycling. | OfficeAgent agent layer |

---

## Pragmatic Middle Ground

Fastest path to partial parity without a full architectural rewrite:

1. **Async wrapper around `/generateDocument`** — Return 202 Accepted + `jobId` immediately. Spawn the existing synchronous agent logic in a background task. Store the result (file path, status, errors) in a lightweight state store when complete.
2. **Job status endpoint** — `GET /v1/jobs/{jobId}` returns `{status: "running" | "completed" | "failed", progress, outputFile}`. Bebop polls on reconnect.
3. **Progressive artifact upload** — At the end of doc generation (before the HTTP response), upload the output file to ODSP/blob and store the URL in the job record. Even if the container is recycled, the output is retrievable.

This avoids the hardest problem (orchestrator checkpoint/resume mid-execution) by letting the agent finish in the background and making the result durable and discoverable.

---

## Architecture Comparison Diagram

```
WEAVE MODEL                          OFFICEAGENT MODEL (Current)
─────────────                        ──────────────────────────

Client                               Client (Bebop)
  │                                    │
  │ POST /v1/messages                  │ (via AugLoop)
  │ ← 202 Accepted                    │
  │                                    │
  │ GET /v1/subscribe (SSE)            │ WebSocket ws://host:6010/ws
  │ ← progress, cards, text            │ ← TaskUpdate notifications
  │ ← ask_user_question                │
  │                                    │ POST /generateDocument
  │  [disconnect]                      │ ← BLOCKS until complete
  │                                    │ ← {filePath, fileName}
  │  [reconnect]                       │
  │ GET /v1/subscribe (SSE)            │  [disconnect = lost]
  │ ← replays current state            │
  │ ← re-emits pending question        │  [no replay possible]
  │                                    │
  ▼                                    ▼
Server (Aether Runtime)              Server (OfficeAgent Container)
  ┌─────────────────────┐              ┌─────────────────────┐
  │ Durable State Store │              │ In-Memory Only      │
  │ • task progress     │              │ • orchestrator ctx  │
  │ • pending questions │              │ • workspace files   │
  │ • output artifacts  │              │ • no persistence    │
  │ • conversation hx   │              │                     │
  └─────────────────────┘              └─────────────────────┘
```
