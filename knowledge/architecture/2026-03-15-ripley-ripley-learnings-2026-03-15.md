---
source: ripley-2026-03-15.md
agent: ripley
category: architecture
date: 2026-03-15
---

# Ripley Learnings — 2026-03-15

## Task: W025 — Claude Cowork UX Plan (OfficeAgent + Bebop + AugLoop + 1JS)

### Codebase Findings

#### Bebop Streaming Architecture
- Bebop's chat streams via `getSydneyStream.ts` using a dual-mode token processing pipeline: `writeAtCursor` (token-by-token) and `snapshot` (authoritative markdown blocks). (source: `office-bohemia/apps/bebop/src/features/conversation/serverFunctions/utils/getSydneyStream.ts`)
- Responses are serialized as HTML + inline `<script type="application/json" data-type="...">` tags for metadata (conversation state, server metrics, trace results). (source: `office-bohemia/apps/bebop/src/features/conversation/serverFunctions/utils/emitResultToStream.ts`)
- NO chain-of-thought, progression, or agent planning features exist in Bebop today — it's purely keyword intent detection → Sydney chat → markdown streaming. (source: search across `apps/bebop/src/features/`)

#### OfficeAgent Chain-of-Thought System
- CoT is file-based: `trackChainOfThought()` queues messages asynchronously, writes to `.claude/cot.jsonl`. (source: `OfficeAgent/modules/chain-of-thought/src/manager.ts`)
- CoT events are NOT streamed to clients via WebSocket today — only written to disk. A `ChainOfThoughtContentNotifier` callback exists but is optional. (source: `OfficeAgent/modules/chain-of-thought/src/types.ts`)
- The `cotAdapter.ts` in the orchestrator module converts Copilot SDK flat messages to Claude SDK nested shape for CoT tracking. (source: `OfficeAgent/modules/orchestrator/src/cot-adapter.ts`)

#### AugLoop Integration Status
- AugLoop integration only exists in OfficeAgent's `.devtools/test-client/src/augloop-client.ts` — NOT in production agent code. (source: `OfficeAgent/.devtools/test-client/src/augloop-client.ts`)
- AugLoop endpoints: Dev `localhost:11040`, Prod `augloop.svc.cloud.microsoft`, Gov/Gallatin variants. (source: same file)
- The `docs/pptx/augloop-to-office-agent.md` doc describes a workflow where AugLoop acts as WebSocket proxy to OfficePy containers, with SDS caching for container URLs. (source: `OfficeAgent/docs/pptx/augloop-to-office-agent.md`)
- In office-bohemia, `@1js/scc-service-voice-realtime-augloop` is used for voice but NOT for agent communication. (source: `office-bohemia/packages/` dependency scan)

#### Loop Component Hosting Model (1JS)
- Loop Components are NOT Office Add-ins (taskpanes/ribbons). They're Fluid-based collaborative components loaded via `getLoopComponent()` or `getLoopComponentInSourcelessIframeV2()` from `@ms/office-web-host`. (source: `office-bohemia/docs/partner-guide/hosting/OfficeWebHost.md`)
- Components are discovered via a manifest (CDN-delivered, 2x/week). Each component has a `registrationId`, URL patterns, and `settingName` for Control Tower flight gating. (source: `office-bohemia/docs/partner-guide/hosting/LoopComponentsManifest.md`)
- Dependency injection via `dependencySynthesizer` provides token providers, code loaders, and Fluid container services. Required providers include `HTMLViewable` and `LoopComponentUrl`. (source: same OfficeWebHost.md)
- Two-phase iframe loading supported: `partialLoadOnly` → `resumeLoad()` for performance. (source: same)

#### OfficeAgent WebSocket Protocol
- Message base: `Message<T> { type, id, sessionId, payload }` with `ResponseMessage<T>` adding `requestId`. (source: `OfficeAgent/modules/message-protocol/src/types/core.ts`)
- Key message types: `llm_request/response`, `query_status` (file progress), `telemetry`, `mcp_request/response`. No `chain_of_thought` or `ask_user_question` types exist yet. (source: `OfficeAgent/modules/message-protocol/src/types/message-type.ts`)
- WebSocket Manager validates buffer size (99MB limit), handles `NoClient`, `NotConnected`, `PayloadTooLarge` failure modes. (source: `OfficeAgent/modules/core/src/websocket/websocket-manager.ts`)
- LLM proxy handler bridges WebSocket↔HTTP with SSE streaming, 60-min timeout, 429 rate limiting. (source: `OfficeAgent/modules/api/src/websocket/handlers/llm-proxy-handler.ts`)

#### Workspace Agent Design Pattern
- Two-phase sub-agent: Phase 1 `@workspace-planner` (outline), Phase 2 `@workspace-generator` (execute). (source: `OfficeAgent/docs/WORKSPACE_AGENT_DESIGN.md`)
- All artifacts rendered as web experience (HTML), not native Office formats. (source: same)
- File-based handoff between phases via `workspace_plan.json`. (source: same)
- Incremental response flow with `isPartial` flag for progress updates. (source: same)

### Patterns Established

- **Cowork feature must follow Bebop's feature-first pattern**: `apps/bebop/src/features/cowork/` with co-located components, hooks, atoms, server functions. No barrel files.
- **Protocol adapter pattern**: OfficeAgent messages → Bebop state model requires explicit adapter layer (not tight coupling)
- **Dual state model**: Jotai for local UI, SharedTree DDS for collaborative (matches Bebop's TanStack Query + Jotai split)
- **Loop Component = embeddable surface**: Not an Office Add-in; loaded via manifest + Loop Loader SDK

### Gotchas

- **"Cowork" doesn't exist anywhere yet** — no protocol, no UI, no routing. This is entirely greenfield across both repos.
- **CoT is file-only today** — streaming CoT to client requires new WebSocket message types in OfficeAgent
- **AugLoop is test-only** — production AugLoop transport needs to be built from scratch
- **Cross-repo builds are independent** — office-bohemia uses Yarn 4.12 + Lage, OfficeAgent uses Yarn 4.10.3 + Lage. Different TypeScript versions, different build pipelines.
- **SharedTree schema changes are expensive** — once deployed, schema migrations require careful versioning. Design the schema first.
