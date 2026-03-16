---
source: command-center-cowork-weave-architecture-full-reference-2026-03-16.md
agent: command
category: architecture
date: 2026-03-16
---

# Cowork Weave Architecture — Full Reference (2026-03-16)

**By:** command-center
**Date:** 2026-03-16

# Cowork Weave Architecture — Full Reference

**Document Created:** 2026-03-14 | **Added to KB:** 2026-03-16
**Based on:** HAR file analysis (cowork_weave.har) + codebase analysis of Sydney and 1JS/midgard repos

## What Is Cowork Weave?
Cowork is a DA++ (Declarative Agent Plus Plus) autonomous digital coworker in Microsoft 365 Copilot. The "Weave" variant is the production version.

- **Agent Name:** Cowork | **Custom Experience:** Weave
- **GPT ID:** T_7e151bfa-7eaa-0802-049f-5d3b98c95e04.weave
- **Backend:** MCS Aether Runtime (Power Platform) — NOT Sydney/TuringBot
- **LLM:** Anthropic Claude (toolu_01... tool IDs) + GPT 5.x options
- **Teams App ID:** 253b14fd-bf42-45e3-91f3-16389f5ce8f2
- **Type:** DeclarativeCopilot
- **Required Client Features:** CustomExperience, FluxV3

## Architecture Overview

```
m365.cloud.microsoft (Copilot Chat Host)
  ├── Coworker CDN (Azure FrontDoor) — Module Federation
  │     home-view.js, workflow-*.js, ask-user-*.js, RecentTaskList.js
  ├── MCS Aether Runtime — /v1/skills, /v1/messages, /v1/subscribe (SSE), /v1/mru/subscribe (SSE)
  ├── Substrate Search API — People/Files context
  └── MS Graph API — Users
```

## Client-Side 1JS Packages (3-layer)

```
m365-chat-coworker-agent  ← auth, theme, 7 token providers (invisible)
  └── scc-cowork-agent    ← nav frame, homepage, breadcrumb
       └── mcs-coworker   ← federation shell → loads CDN bundles
            └── CDN Bundles (chat responses, thinking indicators, ask-user cards, side panel)
```

### Package Locations
- `midgard/packages/mcs-coworker/` — federation shell, loads CDN
- `midgard/packages/m365-chat-coworker-agent/` — auth/tokens/theme wiring
- `midgard/packages/scc-cowork-agent/` — standalone entry, homepage, CoworkCard

### CDN URL
`https://coworker-h2exa6fggpeqapef.b01.azurefd.net/coworker`
(overridable via ECS flags: featureFlags.coworkerCdnUrl, featureFlags.coworkerVersion)

## Backend: MCS Aether Runtime
**Base URL:** `https://mcsaetherruntime.cus-ia302.gateway.prod.island.powerapps.com`

### Key Endpoints
- `GET /v1/skills` — skills catalog (pdf, docx, xlsx, pptx, calendar-management, daily-briefing, email, enterprise-search, meeting-intel)
- `POST /v1/messages` — send user input / ask_user_answer cards
- `GET /v1/subscribe` — SSE: thinking indicators, progress steps, tool results, ask_user_question
- `GET /v1/mru/subscribe` — SSE: most recently used task history

### ask_user_answer Format
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

### Conversation ID Format
`{tenantId}:{userId}:{sessionId}` — server-side state, client is stateless

## Session Persistence & Long-Running Tasks
- 202 Accepted responses — fire-and-forget, async processing via SSE
- SSE reconnection replays current state including pending ask_user_question cards
- Server holds all state; client just renders whatever SSE sends
- Tasks run autonomously for minutes (observed: 261s between user interactions)
- Lazy-loading: ask-user-question.js not fetched until agent first needs user input (~90s in)
- MRU subscribe streams task history for resumption across sessions

## Token Providers (7 total)
graph, copilotStudio, coworker, powerPlatform, apiHub, substrate, spo

## MOS Catalog Registration
- Published via Nexus Portal as UAP (Unified Application Package)
- MOS assigns TitleId → immediate indexing via shoulder tap to SSA
- NO entry in Sydney repo — backend is Aether, not TuringBot
- Ring progression: SDF → MSIT → Production → Government clouds

## Discovery Flow
/getGptList → Entity Serve → checks requiredClientFeatures: ["CustomExperience", "FluxV3"]
→ reads customExperience.name = "Weave" → loads mcs-coworker federation shell

## Cowork Weave vs Sydney Cowork
| Aspect | Cowork Weave | Cowork (Sydney) |
|--------|-------------|------------------|
| Backend | MCS Aether Runtime | Sydney/TuringBot |
| LLM | Claude (toolu_01...) + GPT 5.x | Claude Sonnet 4.6 / GPT-5 |
| Skills | /v1/skills | DeepWork tools + NotebookBerry |
| Streaming | SSE /v1/subscribe | Sydney chat streaming |
| Code (client) | midgard/packages/{mcs-coworker, m365-chat-coworker-agent, scc-cowork-agent} | Same packages |

---

# Squad W025 Gap Analysis vs Cowork Weave

## Architecture Alignment
| Cowork Weave | Squad W025 | Status |
|---|---|---|
| MCS Aether Runtime | OfficeAgent orchestrator | ✅ Equivalent |
| SSE /v1/subscribe | AugLoop WebSocket (P004) | ✅ WebSocket = same model |
| ask_user_question / ask_user_answer | P001/P007 + P003 ask-user handler | ✅ Direct analog |
| Side panel progress steps | P008 progression card components | ✅ Same concept |
| mcs-coworker (federation shell) | P011 Loop Component wrapper | ✅ Loop Component IS the federation shell |
| CDN bundles (independently deployable) | Bebop cowork feature module (P006) | ✅ Loop Loader SDK = stronger story |
| m365-chat-coworker-agent (auth/tokens) | PL-W009 host integration demo | 🔴 Token providers not specified per host |
| /v1/mru/subscribe (task history) | NOT IN PRD | 🔴 Gap — no MRU equivalent |
| Conversation ID persistence | SharedTree DDS (P013) | 🟡 DDS is stronger but handshake undefined |
| Lazy-loading ask-user cards | NOT specified | 🟡 Bundle size matters for Loop Component |
| requiredClientFeatures gating | P005 + PL-W014 feature gates | ✅ Well-aligned |
| Server-side state (stateless client) | SharedTree DDS (P013) | ✅ DDS is actually better (collaborative) |

## Key Insight: 1JS Hosting
Loop Component approach is STRONGER than Weave's midgard packages:
- Word, Excel, PowerPoint, Teams, Outlook — all native via Loop Loader SDK
- Not tied to M365 Chat release train
- Weave can only embed in M365 Chat; ours can go anywhere

## 🔴 Gap 1: Token providers not specified for 1JS hosts
Weave injects 7 token providers. Our P012 (host integration demo) doesn't specify how OfficeAgent auth tokens surface across different 1JS hosts (Word vs Teams vs Outlook each have different auth contexts).

## 🔴 Gap 2: No MRU / task history equivalent
Weave has /v1/mru/subscribe for persistent task history + resumption. Our PRD has no equivalent item. SharedTree DDS gives us the persistence layer but we haven't designed:
- Task list UX
- OfficeAgent API for MRU
- Resume-task flow

## 🟡 Gap 3: Session persistence handshake undefined
Weave: {tenantId}:{userId}:{sessionId} as conversation ID, client is stateless.
Ours: SharedTree DDS is equivalent but how does the Loop Component know which DDS tree to bind to on reconnect?

## 🟡 Gap 4: Lazy-loading strategy
Weave lazy-loads ask-user-question.js only when first needed. Our P003 doesn't mention lazy-loading. For a Loop Component, bundle size is critical.

## What Weave Validates
1. toolu_01... invocation IDs in P001/P007 are correct — production pattern
2. SSE vs WebSocket is non-issue — same fire-and-forget + push model
3. Stateless client principle confirmed — our DDS approach is stronger
4. Feature gating via requiredClientFeatures is the right pattern — P005/PL-W014 are aligned

## Resources
- DA++ Wiki: https://aka.ms/da/wiki
- CDN: https://coworker-h2exa6fggpeqapef.b01.azurefd.net/coworker
- Aether Runtime: https://mcsaetherruntime.cus-ia302.gateway.prod.island.powerapps.com
- 1JS Repo: https://dev.azure.com/office/Office/_git/1JS?path=/midgard
