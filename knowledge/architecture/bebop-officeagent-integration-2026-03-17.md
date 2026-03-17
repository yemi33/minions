---
title: Bebop ↔ OfficeAgent Integration For Cowork
category: architecture
date: 2026-03-17
source: inbox/bebop-officeagent-integration-2026-03-17.md
---

# Bebop ↔ OfficeAgent Integration For Cowork

**Date:** 2026-03-17

---

## 1. Architecture Diagram

High-level system architecture showing how Bebop reaches OfficeAgent and Grounding Agent through AugLoop.

### Flow Steps

1. **Bebop UI** captures user query and sends it to the Bebop backend (BFF).
2. **Bebop Backend** forwards the request to AugLoop (API Gateway / WebSocket Proxy) via API call.
3. **AugLoop** uses a two-step protocol to communicate with the OfficeAgent container. All messages use the Sydney message format (`@augloop-types/sydney`):
   - **Step 1 — WebSocket:** AugLoop connects to `ws://host:6010/ws` and sends a `SessionInit` message to initialize the agent(s). This must complete first before any document generation request.
   - **Step 2 — HTTP:** AugLoop sends `POST /generateDocument` to the same container on port `:6010`. This triggers document generation. The endpoint will reject the request if `SessionInit` has not completed ("Agent not initialized" error).
4. **WebSocket Server** receives messages and passes them to the `wsRouter` (singleton message router).
5. **`wsRouter`** dispatches messages by type:
   - `SessionInit` → `AgentManager` → initializes requested agents from the `AgentRegistry` (13 agents available)
   - `GroundingAgentRequest` → Grounding Agent WS Handler (direct grounding)
   - Other types → specialized WS handlers (LLMProxy, EnterpriseSearch, RAI, WebSearch, ImageSearch)
6. **HTTP endpoint `POST /generateDocument`** routes to OfficeAgent for document generation. Only AugLoop calls this endpoint in production; the `oagent` CLI and E2E test runner also call it for local dev/testing.
7. **Agents** use their configured orchestrator (Claude SDK or GHCP/Copilot SDK) to execute skills and tools.
8. **Grounding Agent** runs on internal port `:7010` and can be called via WebSocket (from AugLoop) or HTTP (from other agents within the container).
9. **External services** (Claude API, GitHub Copilot SDK, Bing, Microsoft Substrate) are called by the orchestrators and grounding skills as needed.

---

## 2. Sequence Diagram — Office-Agent Document Generation

Office-Agent (GHCP harness) generates documents in a single-tier architecture — no sub-agents, one research call, direct tool execution.

### Flow Steps — Office-Agent Document Generation (GHCP)

1. **Bebop** sends a document creation request (e.g., "Create a Q4 sales deck") to AugLoop.
2. **AugLoop** connects via WebSocket and sends `SessionInit` with `agentId: "office-agent,grounding-agent"`.
3. **Multi-Agent Init:** OfficeAgent initializes with `harness: 'ghcp'` and creates a `GhcpOrchestrator`. GroundingAgent starts its HTTP server on `:7010`.
4. **AugLoop** sends `POST /generateDocument` with the user query and grounding toggles.
5. **Request Interceptors** run on the first turn only:
   - Reads `CLARIFICATION.md` for each skill to check if clarification is needed
   - Detects intent (docx? pptx? xlsx?)
   - If clarification needed → sends `presentationConfig.json` back to Bebop (theme picker, multi-choice UI)
   - Waits for user response, then continues. Interceptors are disabled for remaining turns.
6. **System prompt** is rendered via EJS with skill paths (`docxSkillPath`, `pptxSkillPath`, `xlsxSkillPath`, `researchSkillPath`), RAI guidelines, and workspace dirs injected.
7. **GhcpOrchestrator** runs with `claude-opus-4-6`, `maxTurns: 2000`, `maxThinkingTokens: 32768`, and tools: `[Read, Write, Edit, Bash, Glob, Grep, Skill, Task]`.
8. **Research** (ONE invocation allowed):
   - Orchestrator reads `research/SKILL.md` and runs `node research.ts` via Bash
   - `research.ts` sends `POST localhost:7010/v1/invoke` to GroundingAgent
   - GroundingAgent runs enterprise-search + web-search, returns `groundingContent`
   - Results written to `grounding_results.md` in workspace, read by orchestrator
9. **Document Creation:** Orchestrator reads the appropriate `SKILL.md` and executes directly (no sub-agents):
   - **PPTX:** Designs slides in JavaScript → runs PptxGenJS → writes `.pptx`
   - **DOCX:** Builds document in JavaScript → runs docx-js → writes `.docx`
   - **XLSX:** Writes Office.js code → runs `excel_headless.js create` → cloud file created
10. **Output Detection:** OfficeAgent scans `/agent/workspace/output/` for `.docx`, `.pptx`, `.xlsx` files.
11. **Sanitization:** `python sanitize_office_document.py` removes banned relationships (oleObject, embeddings, etc.).
12. **Notification:** Sends `TaskUpdate` notifications (CoT progress, artifacts) and `ArtifactGenerated` with `{filename, path, type}` via WebSocket.
13. **HTTP response** returns `{filePath, fileName, fileSize}` to AugLoop, which delivers the document to Bebop.
