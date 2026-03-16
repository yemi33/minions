---
source: ripley-explore-W033-2026-03-16.md
agent: ripley
category: build-reports
date: 2026-03-16
---

# Ripley Exploration — W033: OfficeAgent Codebase Summary

**Date:** 2026-03-16
**Agent:** Ripley (Lead / Explorer)
**Task:** Explore OfficeAgent codebase and provide comprehensive summary

---

## Area Explored

Full OfficeAgent monorepo at `C:\Users\yemishin\OfficeAgent\` — all agents, modules, devtools, docs, docker, and eval framework.

---

## Architecture

### High-Level Overview

OfficeAgent is an AI agent platform for Office document creation (DOCX, PPTX, XLSX, PDF). It runs in Docker containers with dual LLM provider support (Anthropic Claude SDK + Azure OpenAI/GitHub Copilot SDK).

**Tech Stack:**
- TypeScript/Node.js 24+ monorepo (Yarn 4.10.3 workspaces + Lage task runner)
- Python eval framework (pytest)
- Docker multi-stage builds (poppler + LibreOffice + Node)
- WebSocket + JSON-RPC 2.0 protocol
- Express HTTP server

### Three-Tier Agent Architecture

| Tier | Description | Examples | Model |
|------|-------------|----------|-------|
| **Tier 1: Full** | Multi-version, sub-agents, 20+ flights, Claude SDK | create-agent (4 versions, 21 flights) | claude-sonnet-4-5, claude-opus-4-6 |
| **Tier 2: Copilot** | GitHub Copilot SDK, simpler config | excel-agent, office-agent, gpt-create-agent | gpt-5, gpt-52-reasoning |
| **Tier 3: Minimal** | No LLM, direct conversion/execution | ppt-creation-agent, ppt-edit-agent, odsp-agent, excel-js-runner-agent | None |

(source: `agents/*/src/registry.ts` across all 14+ agents)

### Agent Inventory (15 agents)

| Agent | Model | Versions | Flights | Has CLAUDE.md |
|-------|-------|----------|---------|---------------|
| create-agent | claude-sonnet-4-5 / opus-4-6 | 4 | 21 | ✅ |
| gpt-create-agent | gpt-5 | 1 | 0 | ✅ |
| dw-accountant-agent | claude-sonnet-4-5 | 1 | 2 | ✅ |
| dw-paralegal-agent | claude-sonnet-4-5 | 2 | 2 | ✅ |
| dw-marketer-agent | claude-sonnet-4-5 | 1 | 0 | ❌ |
| excel-agent | gpt-52-reasoning | 1 | 1 | ✅ |
| excel-js-runner-agent | (none) | 0 | 0 | ❌ |
| grounding-agent | claude-opus-4-6 | 1 | 2 | ❌ |
| odsp-agent | (none) | 0 | 0 | ✅ |
| office-agent | claude-opus-4-6 | 1 | 1 | ✅ |
| ppt-agent | claude-opus-4-6 | 1 | 1 | ❌ |
| ppt-creation-agent | (none) | 0 | 0 | ✅ |
| ppt-edit-agent | (none) | 0 | 0 | ✅ |
| workspace-agent | claude-sonnet-4-5 | 2 | 1 | ✅ |

(source: `agents/*/src/registry.ts` for all entries)

### Module Architecture (17 modules)

**Core Platform:**
- **@officeagent/core** — Agent management, logging (PII-safe), WebSocket management, utilities (source: `modules/core/src/index.ts`)
- **@officeagent/api** — HTTP routes, WebSocket handlers (14+), handler registry, agent registration (source: `modules/api/src/index.ts`)
- **@officeagent/message-protocol** — 160+ message types, JSON-RPC 2.0 types, WebSocket contract (source: `modules/message-protocol/src/types/message-type.ts`)
- **@officeagent/orchestrator** — Provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` (source: `modules/orchestrator/src/types.ts:23-62`)

**Document Generation:**
- **@officeagent/html2pptx** — HTML to PPTX conversion
- **@officeagent/json-to-docx-ooxml** — JSON to DOCX conversion
- **@officeagent/pptx-assets** — PowerPoint asset management
- **@officeagent/verify-slide-html** — Slide HTML validation
- **@officeagent/excel-headless** — Headless Excel execution
- **@officeagent/excel-parser** — Excel file parsing

**AI & Intelligence:**
- **@officeagent/chain-of-thought** — CoT tracking, file-based persistence, message processing (source: `modules/chain-of-thought/src/index.ts`)
- **@officeagent/grounding** — 4-stage pipeline: Preprocessor → Retriever → Postprocessor → Storage (source: `modules/grounding/`)
- **@officeagent/rai** — Responsible AI validation
- **@officeagent/gpt-agent** — GPT agent abstraction

**Integration:**
- **@officeagent/mcp-proxy** — MCP (Model Context Protocol) proxy
- **@officeagent/git-remote-spo** — SharePoint git remote

### Key Design Patterns

1. **Registry-First Design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. (source: `agents/create-agent/src/registry.ts:1-623`)

2. **Orchestrator Abstraction**: `IOrchestrator` interface with `run()` (batch) and `runStream()` (streaming) methods. Factory pattern selects `ClaudeOrchestrator` or `GhcpOrchestrator` at runtime. (source: `modules/orchestrator/src/factory.ts`)

3. **Handler Registry**: `HandlerRegistry` in API module maps message types to handlers, supporting regular and SSE streaming responses. (source: `modules/api/src/internal/registry/handler-registry.ts:91-180+`)

4. **Versioned Prompts**: Prompts under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. (source: `agents/create-agent/src/prompts/`)

5. **Flight System**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. (source: `agents/create-agent/src/registry.ts` — 21 flight configs)

6. **Hook System**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn). (source: `modules/core/src/agent/`)

7. **Provider-Agnostic CoT**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), works with any provider. (source: `modules/chain-of-thought/src/types.ts:31-45`)

### Data Flow

```
Client → WebSocket (port 6010)
  → WebSocketRouter (routes by message.type)
  → HandlerRegistry (maps type → handler)
  → Agent (selected by OAGENT_AGENTID)
    → Orchestrator (Claude or GHCP)
      → LLM Provider (Anthropic API / Azure OpenAI)
    → Tools (MCP, Office.js, Python scripts)
    → Chain-of-Thought tracking (file-based)
  → Response → WebSocket → Client
```

Internal port 6011 handles agent-to-agent communication. Port 7010 serves grounding.

### Docker Setup

Multi-stage Dockerfile:
1. **poppler-builder** — PDF processing
2. **libreoffice-installer** — Document conversion
3. **node-deps** — Runtime npm packages (separate from yarn workspace)
4. **final** — Node 24 + all tooling

Ports: 6010 (external API), 6011 (internal), 6020 (debug), 7010 (grounding)
Health check: `curl http://localhost:6010/health`
(source: `docker/Dockerfile`, `docker-compose.yml`)

---

## Patterns

### Code Conventions
- **Logging**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry). `logDebug` is local-only, OK for user data. No `console.*` in production. (source: `CLAUDE.md:59-63`)
- **PowerShell required**: All yarn/oagent/gulp commands must run in PowerShell. Bash fails. (source: `CLAUDE.md:7`)
- **Package scope**: `@officeagent/` for library modules, `@officeagent-tools/` for devtools (source: `package.json` workspaces)
- **Testing**: Jest with ts-jest for TypeScript (`**/tests/**/*.test.ts`), pytest for Python (`tests/test_*.py`). Coverage CI-only. (source: `CLAUDE.md:39-41`, `jest.config.js`, `pytest.ini`)
- **Version**: All packages at `1.1.1130` (source: all `package.json` files)

### Agent Development Pattern
```
agents/<name>/
  src/
    registry.ts          # AgentRegistryConfig export
    <agent-name>.ts      # Main implementation
    prompts/
      <version>/
        system-prompt.md  # EJS template
        rai.md            # Responsible AI guidelines
        skills/           # Skill definitions (SKILL.md)
        subagents/        # Sub-agent prompts
        scripts/          # Script definitions
        intent-detection/ # Intent classification
        overwrites/       # Flight-conditional overrides
  tests/
  package.json
  CLAUDE.md              # Agent-specific guidance
```
(source: `agents/create-agent/` as reference implementation)

### Build Pipeline
- **Lage tasks**: build → depends on ^build (upstream deps), plus lint, test, clean
- **Individual package builds**: `yarn workspace @officeagent/<pkg> build` (avoids Docker requirement)
- **Full build**: `yarn build` (requires Docker Desktop running)
- **Hot reload**: `yarn reload` copies built code into running container
(source: `lage.config.js`, `package.json:scripts`)

---

## Dependencies

### Module Dependency Graph (simplified)
```
message-protocol  ← (no deps, foundational)
  ↑
core              ← depends on message-protocol
  ↑
chain-of-thought  ← depends on core
  ↑
orchestrator      ← depends on core, chain-of-thought, claude-sdk, copilot-sdk
  ↑
api               ← depends on ALL modules + ALL agents
  ↑
agents/*          ← depend on core, message-protocol, orchestrator
```

### External Dependencies
- **Anthropic Claude SDK**: `@anthropic-ai/claude-agent-sdk` (primary LLM)
- **GitHub Copilot SDK**: `@github/copilot-sdk` (alternative LLM)
- **Office document**: pptxgenjs, docx, openpyxl, chart.js
- **PDF processing**: poppler (vendored), LibreOffice
- **Runtime**: Express, ws (WebSocket), jszip, uuid, sharp
(source: `docker/package.json`, `modules/orchestrator/package.json`)

---

## Gaps

1. **CLAUDE.md missing for 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent lack documentation. (source: verified by checking all 14 `agents/*/CLAUDE.md`)

2. **README outdated**: Root README.md lists 7 agents but repo has 15. (source: `README.md` vs actual `agents/` directory listing)

3. **No local coverage command**: Coverage data only visible in CI (`TF_BUILD=true`). No documented way to generate coverage locally. (source: `CLAUDE.md:41`, `jest.config.js`)

4. **CoT is file-based only**: `trackChainOfThought()` writes to disk. No WebSocket streaming to clients exists in production code. New CoT streaming types were added in PR-4970128 but not yet wired. (source: `modules/chain-of-thought/src/manager.ts`, knowledge base PR reviews)

5. **AugLoop integration is test-only**: AugLoop endpoints exist only in `.devtools/test-client`, not in production modules. (source: `.devtools/test-client/`)

6. **Cross-repo type drift**: Bebop (office-bohemia) mirrors of OfficeAgent types have 5 critical field mismatches (SessionInit, FileInfo, Error payloads). (source: knowledge base — PR-4972663 review findings)

---

## Recommendations

1. **Add CLAUDE.md to remaining 4 agents** — dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent need basic documentation for onboarding. Low effort, high value.

2. **Update README.md** — Root README lists 7 agents but 15 exist. Add the missing 8 agents with descriptions.

3. **Wire CoT streaming to WebSocket** — The type definitions exist (PR-4970128 merged ChainOfThoughtUpdatePayload). Next step: implement a WebSocket handler that bridges `ChainOfThoughtContentNotifier` to the client protocol.

4. **Add local coverage script** — Add `yarn coverage` command that generates HTML coverage reports without requiring CI environment.

5. **Reconcile cross-repo protocol types** — Bebop's mirrored types must align with OfficeAgent's wire format before the cowork feature can ship.

6. **Track existing cowork branches** — Branches `user/mohitkishore/coworkFeatures`, `user/sacra/cowork-officeagent`, `user/spuranda/cowork-prompt-tuning` exist in git history. May contain reusable patterns or conflicts.

---

## Source References

Every finding above includes inline `(source: ...)` references. Key files for verification:

- Root config: `C:\Users\yemishin\OfficeAgent\CLAUDE.md`, `package.json`, `lage.config.js`
- Agent registries: `agents/*/src/registry.ts` (all 15)
- Module entry points: `modules/*/src/index.ts`
- Orchestrator types: `modules/orchestrator/src/types.ts:23-62`
- Message protocol: `modules/message-protocol/src/types/message-type.ts:10-165`
- Handler registry: `modules/api/src/internal/registry/handler-registry.ts:91-180+`
- CoT types: `modules/chain-of-thought/src/types.ts:31-45`
- Docker: `docker/Dockerfile`, `docker-compose.yml`
- Build: `lage.config.js`, `jest.config.js`, `pytest.ini`
