# Architectural Analysis — All Project Codebases

**By:** Rebecca (Architect)
**Date:** 2026-03-12
**Type:** Exploration / Architectural Review
**Scope:** OfficeAgent (primary), office-bohemia, bebop-desktop

---

## Executive Summary

The team operates three codebases with distinct architectural concerns:

1. **OfficeAgent** — A production-grade AI agent platform (TypeScript monorepo) for Office document creation. Well-architected with clean abstractions, multi-provider orchestration, and a sophisticated hook system.
2. **office-bohemia** — The Bebop app UX logic and Sydney backend integration. The consumer-facing application layer.
3. **bebop-desktop** — An Electron-based UX prototype for Claude Cowork-style agent interaction patterns.

---

## 1. OfficeAgent — Deep Architectural Analysis

### 1.1 System Overview

**Repository:** `office/ISS/OfficeAgent`
**Stack:** TypeScript/Node.js monorepo, Yarn 4.10.3 workspaces, lage task runner, Docker containers, Python eval framework
**Runtime:** Docker container (Express + WebSocket server, port 6010/6011)
**SDK Dependencies:** `@anthropic-ai/claude-agent-sdk` 0.2.39, `@github/copilot-sdk` 0.1.30

### 1.2 Workspace Structure

```
OfficeAgent/
├── agents/          14 agent implementations (each a workspace package)
├── modules/         17 shared libraries (@officeagent/* scope)
├── .devtools/       CLI, test-client, e2e-tests, eval-browser, launcher, visualizer
├── eval/            Python evaluation framework (pytest)
├── docker/          Dockerfile, runtime package.json
├── docs/            Architecture documentation
├── gulp-tasks/      Build orchestration
└── metadata/        Package metadata
```

### 1.3 Layered Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Layer                                 │
│  @officeagent/api                                                │
│  Express + WebSocket server, agent registration, message routing │
│  Routes: internal (6011) + external (6010)                       │
├─────────────────────────────────────────────────────────────────┤
│                     Agent Layer                                  │
│  14 agents: create-agent, gpt-create-agent, ppt-creation-agent, │
│  ppt-edit-agent, ppt-agent, excel-agent, excel-js-runner-agent,  │
│  dw-accountant-agent, dw-paralegal-agent, dw-marketer-agent,    │
│  odsp-agent, grounding-agent, workspace-agent, office-agent     │
├─────────────────────────────────────────────────────────────────┤
│                   Orchestrator Layer                              │
│  @officeagent/orchestrator                                       │
│  IOrchestrator interface → ClaudeOrchestrator, GhcpOrchestrator  │
│  Provider registry + factory pattern, GenericToolHooks           │
├─────────────────────────────────────────────────────────────────┤
│                     Core Layer                                   │
│  @officeagent/core                                               │
│  BaseAgent, AgentRegistry, AgentWorkspaceManager, HookRegistry, │
│  ConfigResolver, SystemPromptBuilder, logging, WebSocket router  │
├─────────────────────────────────────────────────────────────────┤
│                   Protocol Layer                                 │
│  @officeagent/message-protocol                                   │
│  WebSocket message types, Sydney types, Office types             │
├─────────────────────────────────────────────────────────────────┤
│                   Domain Modules                                 │
│  grounding, rai, chain-of-thought, excel-headless, html2pptx,   │
│  json-to-docx-ooxml, mcp-proxy, gpt-agent, verify-slide-html,  │
│  excel-parser, pptx-assets, git-remote-spo                      │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 Key Architectural Patterns

#### A. Multi-Provider Orchestration (Strategy Pattern)

**Strength:** Clean abstraction. The `IOrchestrator` interface defines `run()`, `runStream()`, and `interrupt()`. Agents program against this interface; the factory handles provider selection.

```
IOrchestrator
├── ClaudeOrchestrator  (Anthropic Claude Agent SDK)
├── GhcpOrchestrator    (GitHub Copilot SDK, lazy-loaded)
└── BaseOrchestrator    (shared implementation)
```

**Key design decisions:**
- GHCP provider is lazy-loaded (`require()`) to avoid startup dependency when not needed
- `OrchestratorRequest.reasoningEffort` normalizes between provider nomenclatures ('max' ↔ 'xhigh')
- `providerOptions` provides escape hatch for provider-specific config
- `GenericToolHooks` are provider-agnostic; adapters translate to provider-specific formats

**Architectural Note:** The `harness` field in `AgentVersionConfig` determines which provider is used per agent version. This means different agents can use different LLM providers in the same container.

#### B. Agent Registry + Config Resolution (Registry + Builder Pattern)

Each agent declares its configuration in `registry.ts`:
- **Versions**: Multiple prompt versions with distinct models, skills, subagents, tools
- **Flights**: Feature flags that override version config (partial merge)
- **Filters**: Runtime removal of skills/subagents/tools based on conditions

`ConfigResolver.resolve()` applies: version selection → flight overrides → filter rules → final `ResolvedAgentConfig`.

**Strength:** Very flexible. A single agent can serve different capabilities based on runtime flight state without code changes.

#### C. WebSocket Message Flow (Pipeline Pattern)

10-phase pipeline from request to response:
1. Route → 2. Preprocess → 3. Acknowledge → 4. Parse Grounding → 5. Init Services → 6. Create Turn + Hooks → 7. Build System Prompt → 8. Execute LLM → 9. Stream Results → 10. Cleanup

**Dual protocol:** Supports both legacy WebSocket messages and JSON-RPC 2.0.

#### D. Hook System (Observer + Interceptor Pattern)

Three layers of hooks:
1. **Base hooks** — shared across all agents
2. **Agent-specific hooks** — per document type (word, excel, ppt)
3. **Generic tool hooks** — pre/post tool execution interception

Hook providers can block tool execution, modify inputs, or inject messages. This is how Excel blocks direct file writes (forcing cloud creation via headless Excel).

#### E. Workspace Management

Each agent session gets an isolated workspace:
- `/agent/.claude/` — skills, subagents, scripts (copied from agent package at init)
- `/agent/workspace/` — working directory for LLM tool use
- `/agent/output/` — generated documents
- Turn-based directory structure within workspace

### 1.5 Docker Runtime Architecture

**Multi-stage Dockerfile:**
1. `poppler-builder` — Compile Poppler for PDF processing (cmake, gcc, libjpeg, libpng)
2. `libreoffice-installer` — Extract LibreOffice RPMs (v26.2.0 Linux x86_64)
3. `node-deps` — Install Node.js dependencies (dotnet/aspnet:8.0-azurelinux3.0 base)
4. `runtime` (final) — OfficePy Jupyter base (`mcr.microsoft.com/officepy/codeexecutionjupyter4`)

**Container ports:** 6010 (external API), 6011 (internal API), 6020 (Node debug), 7010 (grounding agent HTTP)

### 1.6 Evaluation Framework

Python-based (`eval/`), separate from Yarn workspaces:
- **Entry**: `oagent eval <alias>` → load batch + config → spin up Docker containers → generate → evaluate → report
- **Evaluators**: Excel (1-5 scale: accuracy, completeness, usefulness, reliability, aesthetics), Pairwise (side-by-side), Societas (visual quality), Content quality, Rule-based (deterministic)
- **Output**: Per-test JSON + HTML aggregate reports in `eval/outputs/<run_name>/`

### 1.7 Agent Catalog

| Agent | ID | Provider | Purpose |
|-------|----|----------|---------|
| CreateAgent | `create-agent` | Claude | Primary doc creation (DOCX/PPTX/XLSX) |
| GPTCreateAgent | `create-agent-gpt` | GHCP | GPT-based variant |
| PptCreationAgent | `ppt-creation-agent` | Claude | PPT creation (legacy) |
| PptEditAgent | `ppt-edit-agent` | Claude | PPT editing |
| PptAgent | `ppt-agent` | Claude | PPT (Opus 4.6 + Anthropic PPTX Skill) |
| ExcelAgent | `excel-agent` | GHCP (Copilot SDK) | Excel creation |
| ExcelJsRunnerAgent | `excel-js-runner-agent` | Claude | Excel via Office.js |
| DWAccountantAgent | `dw-accountant-agent` | Claude | DataWorks: Accountant |
| DWParalegalAgent | `dw-paralegal-agent` | Claude | DataWorks: Paralegal |
| DWMarketerAgent | `dw-marketer-agent` | Claude | DataWorks: Marketer |
| ODSPAgent | `odsp-agent` | Claude | OneDrive/SharePoint |
| GroundingAgent | `grounding-agent` | Claude | Enterprise grounding |
| WorkspaceAgent | `workspace-agent` | Claude | Workspace management |
| OfficeAgent | `office-agent` | GHCP (Copilot SDK) | General Office agent |

### 1.8 Document Creation Pipelines

**PowerPoint (PPTX):**
```
User Query → Outline Generator → HTML Creator/Validator → html2pptx → .pptx
```
Skills: `pptx` skill, `image-search` for visuals
Hooks: `PptHooksProvider`

**Word (DOCX):**
```
User Query → (v1.1: Outline Generator → Section Generator) → json-to-docx-ooxml → .docx
```

**Excel (XLSX):**
```
User Query → Resource Discovery → Content Extractor → Outline Generator → Office.js Generator → Headless Excel → .xlsx (in cloud)
```
Note: Excel files are created in SharePoint/OneDrive, NOT local filesystem. ExcelHooksProvider blocks direct file writes.

### 1.9 Build & Deploy Architecture

- **Build**: `lage` task runner with topological dependency ordering (`^build` dependencies)
- **Docker**: Single image (`officeagent:devlatest`), container runtime with Express + WebSocket
- **Scaling**: `docker-compose` with `--scale officeagent=N`, optional load balancer overlay
- **Hot reload**: `yarn reload` for development
- **CI**: Azure Pipelines (`azurepipelines-coverage.yml`), CodeQL

### 1.10 Dependency Graph (Critical Path)

```
message-protocol (leaf — no internal deps)
    ↑
   core (depends on: message-protocol)
    ↑
orchestrator (depends on: core, chain-of-thought)
    ↑
[all agents] (depend on: core + domain modules)
    ↑
   api (depends on: ALL agents, core, message-protocol)
```

**Observation:** `@officeagent/api` is a "god package" — it depends on every single agent package. This is the application entry point that registers all agents. The coupling is intentional (registration hub) but means any agent change forces api rebuild.

### 1.11 Architectural Risks & Open Questions

1. **API package coupling**: The `api` module imports all 14 agents directly. If the agent catalog grows, this becomes a maintenance burden. Consider dynamic agent discovery (plugin pattern) or code-split registration.

2. **Dual protocol complexity**: Supporting both legacy WebSocket and JSON-RPC 2.0 adds branching throughout the codebase. If JSON-RPC is the future, the legacy path should have a deprecation timeline.

3. **Flight flag explosion**: The flight/filter system is powerful but can create a combinatorial explosion of configurations. There's no test matrix that verifies all flight combinations work correctly.

4. **Container-only runtime**: Agents run exclusively in Docker. Local development requires Docker Desktop. This is a development velocity constraint.

5. **MCP proxy**: The `@officeagent/mcp-proxy` module wraps `@modelcontextprotocol/sdk` 1.26.0. This suggests MCP tool integration is being built — unclear how it interacts with the existing hook system.

6. **Multi-provider parity**: Claude and GHCP providers have different capabilities. The `IOrchestrator` interface normalizes the surface, but behavioral differences (thinking tokens, tool schemas, streaming semantics) may cause agent behavior divergence across providers.

---

## 2. office-bohemia — Bebop App Architecture (Deep Dive)

**Repository:** `office/OC/office-bohemia`
**Stack:** Yarn 4.12 monorepo, ~200 packages, React 19 + TanStack Start + Nitro SSR
**Role:** Microsoft Loop's primary monorepo. Contains the **Bebop** M365 Copilot frontend, Loop web app, and shared packages for AI-assisted document experiences.

### 2.1 System Overview

This is NOT a small app — it's a **~200-package monorepo** that houses both the Loop production web app AND the Bebop (M365 Copilot) frontend.

```
office-bohemia/
├── apps/                       # 10+ applications
│   ├── bebop/                 # M365 Copilot App frontend (TanStack Start)
│   ├── loop-app/              # Microsoft Loop production web app
│   ├── loop-m365-app/         # Loop embedded in M365
│   ├── scriptor-pad/          # Rich text editor test app
│   └── [other apps]
├── packages/                   # ~200 shared packages (bebop-*, loop-*, scriptor, etc.)
├── docs/                       # Engineering documentation
├── azure/                      # Deployment configurations
├── tools/                      # Build tooling
└── .azuredevops/              # Azure DevOps pipeline policies
```

### 2.2 Bebop App Architecture (apps/bebop/)

**Stack:** TanStack Start (React 19 SSR + streaming), Nitro 3.0.1, Vite 7.3, React Compiler

```
apps/bebop/src/
├── routes/                    # File-based route definitions
├── features/                  # Domain-owned modules
│   ├── conversation/          # Chat interface (components, queryOptions, mutations, serverFunctions)
│   ├── conversations/         # Conversation list/management
│   ├── input/                 # User input handling
│   ├── intentDetection/       # AI intent recognition
│   └── nav/                   # Navigation
├── core/                      # App infrastructure
│   ├── auth/                  # MSAL authentication + Sydney auth headers
│   ├── middleware/            # TanStack middleware (auth, locale, host context, CSP)
│   ├── i18n/                  # Localization
│   ├── telemetry/             # OneDS telemetry
│   └── queryClient/           # TanStack Query configuration
└── shared/                    # App-level reusable code (atoms, hooks, utils)
```

**Key Patterns:**
- **Server Functions (RPC)**: `createServerFn` for type-safe client↔server communication with Zod validation
- **Middleware Pipeline**: Request → [Auth, Locale, Host Context, CSP Nonce] → Route/ServerFn
- **Feature Module Pattern**: Each feature has components, queryOptions, mutations, serverFunctions, server logic
- **State Split**: TanStack Query (remote/async) + Jotai (local synchronous UI state)

### 2.3 Sydney Integration (AI Backend)

```
Bebop App (Frontend)
    ↓ (Server Function: requestChat)
Core Server Functions (src/core/server/)
    ↓
createConfiguredSydneyClient (SignalR WebSocket)
    ↓
@bebopjs/bebop-sydney-client (RxJS-based SignalR wrapper)
    ↓
Sydney Backend (Microsoft's Conversational AI Service)
```

**Streaming Pipeline:**
```
Sydney WebSocket (NDJSON) → getRateLimiterStream() → ReadableStream → Client
    → bebop-response-parser (remark/rehype AST) → React components
```

### 2.4 Key Bebop Packages

| Package | Purpose |
|---------|---------|
| `bebop-sydney-client` | RxJS SignalR wrapper for Sydney backend |
| `bebop-shared-types` | ChatTypes, MessageTypes, SydneyEndpointTypes |
| `bebop-shared-config` | Sydney endpoints, options sets |
| `bebop-response-parser` | Incremental markdown parser (unified/remark/rehype) |
| `bebop-ux` | UI components (Chat, AppShell, widgets) |
| `bebop-conversation-orchestrator` | Conversation lifecycle + streaming |
| `bebop-api-ciq` | 3S CIQ (intent) service client |
| `bebop-i18n` | Localization framework |
| `bebop-telemetry` | OneDS telemetry |

### 2.5 Architectural Relationship to OfficeAgent

- office-bohemia is the **client** that connects to OfficeAgent's WebSocket API
- It sends `AgentRequestMessage` payloads and receives streaming responses
- Grounding content, query annotations, and feature flights flow from bohemia → OfficeAgent
- The boundary between "what Sydney handles" vs "what OfficeAgent handles" is a **critical routing decision** controlled by agent ID and flight flags

### 2.6 Architectural Observations

**Strengths:**
- Modern stack: React 19 + React Compiler + streaming SSR is cutting-edge
- Feature module pattern provides clean domain boundaries
- Type-safe RPC via server functions + Zod eliminates API contract bugs
- Streaming response parsing pipeline is well-designed

**Concerns:**
1. **Monorepo scale**: ~200 packages is a LOT. Build times and dependency management are non-trivial.
2. **Sydney coupling**: The Sydney integration is deeply embedded. Switching AI backends would require significant refactoring.
3. **Alpha dependencies**: TanStack Start RSC + Nitro 3.0.1-alpha — pre-release frameworks in production is risky.
4. **Cross-repo contract**: The WebSocket message protocol between bohemia and OfficeAgent needs versioned contract tests to prevent breaking changes.

---

## 3. bebop-desktop — Prototype Architecture (Deep Dive)

**Repository:** `open-studio/Prototypes/bebop-desktop`
**Stack:** React 18.2 + Vite 6.3 + Zustand 5.0 + Fluent UI v9 + styled-components
**Role:** UX prototype for Copilot-style agent interaction patterns. **NOT Electron** — it's a React/Vite web prototype deployed to M365 Sandbox.

### 3.1 Technology Stack

- **UI**: React 18.2, Fluent UI v9, styled-components, motion (animations)
- **State**: Zustand 5.0 (13 stores), Immer for immutable updates
- **Editor**: Lexical 0.12.6 with plugins
- **Content**: react-markdown + GFM + rehype-raw, Prism.js code highlighting
- **Graph**: @xyflow/react 12.8.4 (node-based workspace visualization)
- **Collaboration**: Fluid Framework 2.60.0 with Azure presence
- **Data**: Dexie (IndexedDB) for chat persistence
- **Auth**: M365 Sandbox SDK

### 3.2 Chain of Thought Progress UI

**Location:** `src/components/ChainOfThoughtCard/`

The flagship component — streaming progress visualization for agent execution:

```typescript
type CoTProcessingStep = {
  id: string;
  title: string;
  detail?: string;
  thoughts?: CoTProcessingStepThought[];  // Rich AI reasoning
  actions?: CoTButton[];                   // Related actions
  references?: CannedResponseReference[];  // Citations
  kind: 'cot' | 'tool';
  toolName?: Tool;
  delay: number;
  status: 'pending' | 'in-progress' | 'complete' | 'error';
}
```

**Components:** StatusList, StatusSpinner (animated → checkmark), StatusItem, ExpandedContent/MinimizedContent, ReferenceList
**Features:** Streaming step addition, auto-collapse, configurable delays, per-step actions

### 3.3 Workspace/Board System

**Location:** `src/components/Board/`, `src/components/WorkspacePage/`

Two modes:
- **Freestyle**: React Flow node graph with chat nodes, text nodes, animated edges with progress gradients
- **Structured**: Tabular/organized view
- **Multiplayer**: Remote cursor visualization, Fluid Framework presence

### 3.4 JTBD Flows (16+ Interactive Demos)

**Location:** `src/data/flows/`

Pre-scripted interactive user journeys demonstrating agent capabilities:
- Product escalation, trend analysis, group chats, daily briefing, OOF messages, AI tools, memory management
- Each flow: steps → session changes → streaming CoT → inline artifacts → configurable delays

### 3.5 Key Stores (Zustand)

| Store | Purpose |
|-------|---------|
| `useChatStore` | Chat sessions, messages, CoT streaming, message history |
| `uiStore` | Current page, editor focus, tool/agent selection, modals |
| `useWorkspaceStore` | Workspace CRUD, chat/node/artifact associations |
| `useNodeStore` | React Flow nodes/edges, multiplayer viewport |
| `artifactStore` | Generated artifact CRUD, full-screen state |
| `flowPlayerStore` | JTBD flow playback, stepping |
| `settingsStore` | User preferences |

### 3.6 Agent Interaction Patterns

**Suggestion System:** TurnNSuggestions with agent-specific suggestion bubbles (LinkedIn, Sales, Finance, Word, Excel, PowerPoint, etc.)
**Input System:** Lexical editor with IntentDetectionPlugin, ToolMenu (Research, Analyze, Code, Create), AddMenu (attachments)
**Zero Input:** Contextual suggestions as input hints

### 3.7 Architectural Significance

This is a **design prototype** — its value is in the UX patterns it establishes:
1. **CoT streaming pattern**: How to progressively reveal agent reasoning to users
2. **Workspace as graph**: Organizing agent conversations spatially with React Flow
3. **Multi-agent suggestions**: Agent-branded suggestion bubbles for cross-capability routing
4. **JTBD flow system**: Scripted demos that define the target UX
5. **Live activity progress**: iOS-style timeline progress indicators

**These patterns should directly inform:**
- OfficeAgent's `chain-of-thought` module (streaming step format matches CoTProcessingStep)
- office-bohemia's Bebop app conversation UI
- OfficeAgent's WebSocket message protocol for progress events

---

## 4. Cross-Project Architecture Map

```
┌──────────────────┐     ┌─────────────────────────┐     ┌──────────────────┐
│  bebop-desktop   │     │  office-bohemia           │     │   OfficeAgent    │
│  (Electron)      │     │  (~200 pkg monorepo)      │     │  (Docker/Node)   │
│                  │     │                           │     │                  │
│  UX Prototypes   │────▶│  apps/bebop/              │────▶│  Agent Platform  │
│  • Progress UI   │     │  • TanStack Start + SSR   │ WS  │  • 14 agents     │
│  • Ask Questions │     │  • Server Functions (RPC) │     │  • Orchestrator  │
│                  │     │  • Feature Modules        │     │  • Doc Pipelines │
└──────────────────┘     │                           │     └────────┬─────────┘
                         │  packages/                │              │
                         │  • bebop-sydney-client    │              │
                         │  • bebop-response-parser  │              │
                         │  • loop-page-container    │              │
                         │  • scriptor (editor)      │              │
                         └────────┬─────────────────┘              │
                                  │ SignalR WS                     │
                                  ▼                                ▼
                         ┌────────────────┐              ┌─────────────────┐
                         │   Sydney       │              │  Claude/GHCP    │
                         │   (MS AI)      │              │  (LLM APIs)    │
                         └────────────────┘              └─────────────────┘
```

**Data Flow:**
1. User interacts with Bebop app (office-bohemia `apps/bebop/`)
2. Server function routes to Sydney (conversational AI) OR OfficeAgent (document creation)
3. Sydney responds via SignalR NDJSON stream → parsed by `bebop-response-parser` → React components
4. OfficeAgent selects appropriate agent based on `OAGENT_AGENTID` and flight flags
5. Agent uses orchestrator (Claude or GHCP) to execute document generation
6. Generated documents flow back via WebSocket to client
7. bebop-desktop prototypes inform UX patterns adopted in Bebop app

---

## 5. Architectural Recommendations

### Strengths (Keep These)
1. **Orchestrator abstraction** — Clean multi-provider strategy pattern. Well-typed interfaces.
2. **Registry + config resolution** — Flexible agent configuration with versions/flights/filters.
3. **Hook system** — Powerful interception without tight coupling.
4. **Workspace isolation** — Per-session, per-turn directory structure.
5. **Comprehensive documentation** — CLAUDE.md files, architecture docs, flow diagrams.

### Areas for Improvement
1. **Agent discovery**: Move from static imports in `api/agents.ts` to dynamic plugin discovery.
2. **Protocol consolidation**: Plan deprecation of legacy WebSocket protocol in favor of JSON-RPC 2.0.
3. **Flight testing**: Add a flight combination matrix to CI to catch interaction bugs.
4. **MCP integration clarity**: Document how MCP proxy tools interact with existing GenericToolHooks.
5. **Cross-repo contract**: The WebSocket message protocol between office-bohemia and OfficeAgent should have versioned contract tests.

---

## 6. Key Technical Decisions Observed

| Decision | Rationale | Impact |
|----------|-----------|--------|
| Multi-provider orchestrator | Support both Anthropic and GitHub Copilot | Agents are provider-agnostic |
| Docker-only runtime | Consistent environment, security isolation | Dev requires Docker Desktop |
| Yarn 4 + lage | Fast builds with caching | Complex build config |
| Flight flags for config | A/B testing, gradual rollout | Config complexity |
| WebSocket for streaming | Real-time doc generation feedback | Protocol complexity |
| Headless Excel in cloud | Can't run Excel locally | Architectural constraint |
| EJS templates for prompts | Dynamic system prompt generation | Template debugging harder |
| Per-agent CLAUDE.md | Team-specific context for AI assistants | Documentation maintenance |

---

*Filed by Rebecca (Architect) — 2026-03-12*
