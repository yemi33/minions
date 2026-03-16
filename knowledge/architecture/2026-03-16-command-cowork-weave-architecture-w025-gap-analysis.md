---
source: command-center-cowork-weave-architecture-w025-gap-analy-2026-03-16.md
agent: command
category: architecture
date: 2026-03-16
---

# Cowork Weave Architecture + W025 Gap Analysis

**By:** command-center
**Date:** 2026-03-16

# Cowork Weave Architecture + W025 Gap Analysis

Source: HAR file analysis + 1JS/midgard codebase analysis (document dated 2026-03-14)

## What Is Cowork Weave?

Cowork Weave is a DA++ (Declarative Agent Plus Plus) running on **MCS Aether Runtime** (Power Platform backend), not Sydney/TuringBot. The underlying LLM is Anthropic Claude (toolu_01... tool IDs confirm this), with GPT 5.x options available.

- GPT ID: `T_7e151bfa-7eaa-0802-049f-5d3b98c95e04.weave`
- Teams App ID: `253b14fd-bf42-45e3-91f3-16389f5ce8f2`
- CDN: `https://coworker-h2exa6fggpeqapef.b01.azurefd.net/coworker`
- Aether Runtime: `https://mcsaetherruntime.cus-ia302.gateway.prod.island.powerapps.com`

## 1JS Client Architecture (3-layer)

```
m365-chat-coworker-agent  ← auth + tokens (invisible)
  └── scc-cowork-agent    ← nav frame + homepage
       └── mcs-coworker   ← federation shell → CDN bundles
```

- `mcs-coworker`: Calls `initializeFederation({ cdnUrl, version })`, loads `FederatedCoworker` from CDN
- `m365-chat-coworker-agent`: Injects 7 token providers (Graph, Substrate, SPO, Copilot Studio, Power Platform, API Hub, Coworker), theme, auth
- `scc-cowork-agent`: Navigation shell, homepage, task cards, scope picker
- CDN bundles: All rich interactive UX — chat responses, ask-user cards, side panel progress, workflow suggestions

## Backend API Surface

- `GET /v1/skills` — Skills catalog (pdf, docx, xlsx, pptx, calendar-management, email, enterprise-search, meeting-intel)
- `POST /v1/messages` — Send user messages + ask_user_answer (toolu_01... invocation IDs)
- `GET /v1/subscribe` — SSE stream: thinking indicators, progress steps, tool results, ask_user_question cards
- `GET /v1/mru/subscribe` — SSE stream: most recently used task history

## ask_user_answer Format (Production)

```json
{
  "content": [{
    "type": "ask_user_answer",
    "rawEvent": {
      "invocationId": "toolu_01N6u54UMTcxoCunQ3qc5gVq",
      "answers": { "0": "OCE Handoff — 9:10 AM" }
    }
  }],
  "conversationId": "{tenantId}:{userId}:{sessionId}",
  "role": "user"
}
```

## Session Persistence Model

- Conversation ID format: `{tenantId}:{userId}:{sessionId}` — server-owned, client is stateless
- 202 Accepted responses — async processing, results stream via SSE
- SSE reconnection replays current state + pending ask_user_question cards
- Long-running tasks: 7.5+ minute sessions, agent runs autonomously for minutes between user interactions
- `ask-user-question.js` lazy-loaded only when first needed (90s into session)

## Ring / Feature Gating

- `requiredClientFeatures: ["CustomExperience", "FluxV3"]` — older clients hide the agent entirely
- CDN version controlled via ECS feature flags (`featureFlags.coworkerCdnUrl`, `featureFlags.coworkerVersion`)
- Ring progression: SDF → MSIT → Production → Government clouds

---

## W025 Architecture Alignment

| Cowork Weave | Squad W025 | Notes |
|---|---|---|
| MCS Aether Runtime | OfficeAgent orchestrator | Different backend, same concept |
| SSE /v1/subscribe | AugLoop WebSocket (PL-W003/P004) | WebSocket fine — same fire-and-forget+push model |
| ask_user_question + toolu_01... IDs | P001/P007 + P003 | Direct analog — confirmed production pattern |
| Side panel progress steps | P008 progression cards | Same concept |
| mcs-coworker federation shell | P011 Loop Component wrapper | Loop Component IS our federation shell |
| CDN bundles (independently deployable) | Bebop cowork feature module (P006) | Loop Loader SDK gives better 1JS story than midgard train |
| m365-chat-coworker-agent (auth/tokens) | PL-W009 host integration | Token wiring layer — GAP (see below) |
| Aether server-side state | SharedTree DDS (P013) | DDS is actually stronger — collaborative, not just persistent |
| /v1/mru/subscribe task history | **NOT IN PRD** | 🔴 Gap |
| requiredClientFeatures gating | P005 + PL-W014 gates | Well-aligned |

## Gaps Identified

### 🔴 Gap 1: Token providers for 1JS hosts not specified
Weave injects 7 token providers via `m365-chat-coworker-agent`. PL-W009 (host integration demo) doesn't specify how OfficeAgent auth tokens are surfaced to the Loop Component across different 1JS hosts (Word vs Teams vs Outlook each have different auth contexts).

### 🔴 Gap 2: No MRU / task history equivalent
Weave has `/v1/mru/subscribe` — persistent SSE stream of user's task history with resume capability. Our PRD has no equivalent. SharedTree DDS gives the persistence layer but no task list UX or OfficeAgent MRU API is designed.

### 🟡 Gap 3: Session persistence handshake undefined
Weave uses `{tenantId}:{userId}:{sessionId}` — stateless client, server holds everything. The handshake between Loop Component and OfficeAgent (how does the client know which DDS tree to bind to?) isn't specified.

### 🟡 Gap 4: No lazy-loading strategy for interactive cards
Weave lazy-loads ask-user-question.js only when first needed. Bundle size matters for Loop Components — ask-user card components (P003) should be lazy-loaded.

## What This Validates

1. **Protocol types (P001/P007) are correct** — toolu_01... IDs, ask_user_answer format, indexed answers map are production patterns
2. **SSE vs WebSocket is a non-issue** — same fire-and-forget + push model
3. **Stateless client principle** confirmed — our DDS approach is stronger (collaborative)
4. **Feature gating (P005/PL-W014)** is well-aligned with Weave's requiredClientFeatures pattern
5. **Loop Component approach is stronger than Weave's midgard packages** for 1JS embedding — can host in Word/Excel/PowerPoint/Teams/Outlook natively, not tied to M365 Chat release train
