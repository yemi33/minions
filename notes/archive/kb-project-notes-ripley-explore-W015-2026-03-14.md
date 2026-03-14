# W015: Sachin's Cowork PRs — OfficeAgent ↔ AugLoop Connection Analysis

**Date:** 2026-03-14
**Agent:** Ripley (Lead / Explorer)
**Task:** Analyze PR-4961660 (OfficeAgent) and PR-4961631 (augloop-workflows) from Sachin

---

## Area Explored

Two coordinated draft PRs from Sachin Rao implementing the "Cowork Agent" prototype:
- **PR-4961660** (OfficeAgent): `user/sacra/cowork-officeagent` → New `cowork-agent` agent package
- **PR-4961631** (augloop-workflows): `user/sacra/cowork-augloop` → AugLoop handler integration for cowork messages

Both are **draft/WIP**, active, with 4 iterations each:
1. Initial WIP
2. AskUserQuestion and multiturn
3. Add docx skill
4. Progress update support

---

## Architecture: How OfficeAgent and AugLoop Connect

### The Full Data Flow

```
[Bebop UX] → [AugLoop Platform] → [augloop-workflows handler] → [OfficeAgent Docker container] → [Claude SDK]
     ↑                                      ↑                              ↓
     └──────── OfficeAgentPollingResult ←────┘←── WebSocket messages ←─────┘
```

### Layer 1: AugLoop Platform (augloop-workflows repo)

AugLoop is the **orchestration platform**. It:
- Receives signals from clients (e.g., Bebop UX) of type `OfficeAgentAsyncSignal`
- Routes them to registered workflows defined in `workflows-manifest.json`
- The `OfficeAgentAsync` workflow is stateful, polling-based (client polls for `OfficeAgentPollingResult` annotations)

The **`CreateAgentDocumentGenerationStrategy`** class is the core bridge:
- It manages a WebSocket connection to the OfficeAgent Docker container
- It registers message handlers for every message type the agent sends back
- It translates agent WS messages → `OfficeAgentPollingResult` annotations that the client can poll

### Layer 2: OfficeAgent Container (OfficeAgent repo)

The OfficeAgent Docker container runs individual agents. The new `cowork-agent`:
- Extends `BaseAgent` from `@officeagent/core`
- Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to run Claude queries
- Communicates back to AugLoop via WebSocket messages
- Has its own message types: `cowork_request`, `cowork_response`, `cowork_progress_update`, `cowork_ask_user`, `cowork_chain_of_thought`

### Layer 3: Bebop UX (office-bohemia repo) — **YOUR WORK**

The UX layer needs to:
1. Send `OfficeAgentAsyncSignal` to AugLoop with `agentId: 'cowork-agent'`
2. Poll for `OfficeAgentPollingResult` annotations
3. Parse the `contentOrigin` field to determine message type:
   - `CoworkProgressUpdate` → Render progress steps UI
   - `CoworkAskUser` → Render question + options UI
   - `CoworkChainOfThought` → Render real-time reasoning
   - `CoworkResponse` → Render final markdown response
4. For AskUser responses: send back via the augloop signal mechanism

---

## Key Types for UX Integration

### Progress Updates (from `CoworkProgressUpdatePayload`)
```typescript
interface CoworkProgressStep {
    id: string;           // e.g. 'review-calendar'
    label: string;        // e.g. 'Review this week's calendar'
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
    updates?: CoworkProgressSubUpdate[];
}

interface CoworkProgressSubUpdate {
    title: string;        // ~50 chars
    description?: string; // ~200 chars
    status: 'pending' | 'in-progress' | 'completed';
}

interface CoworkProgressUpdatePayload {
    steps: CoworkProgressStep[];
    progressPercent: number;  // 0-100
}
```

### AskUser Questions (from `CoworkAskUserPayload`)
```typescript
interface CoworkAskUserPayload {
    questionId: string;   // UUID for correlation
    question: string;
    options?: Array<{
        id: string;
        label: string;
        description?: string;
    }>;
    allowFreeText?: boolean;
}

// User's response
interface CoworkAskUserResponsePayload {
    questionId: string;
    selectedOptionId?: string;
    freeTextResponse?: string;
}
```

### Chain of Thought (from `CoworkChainOfThoughtPayload`)
```typescript
interface CoworkChainOfThoughtPayload {
    content: string;  // Real-time reasoning text
}
```

### Final Response (from `CoworkResponsePayload`)
```typescript
interface CoworkResponsePayload {
    success: boolean;
    content?: string;   // Markdown
    error?: string;
}
```

---

## How the ProgressStateManager Works (Important for UX)

The `ProgressStateManager` in the OfficeAgent container **derives progress steps from the LLM's TodoWrite calls**:

1. Claude's system prompt instructs it to call `TodoWrite` at the start of every request to create a plan
2. The `ProgressStateManager.onToolCall()` intercepts `TodoWrite` tool calls and rebuilds progress steps
3. It enriches steps with sub-updates from search tool calls and thinking text
4. It emits `CoworkProgressUpdate` messages via WebSocket after every change
5. `computeProgressPercent()` = (completed + inProgress * 0.5) / total * 100

**UX implication**: The progress UI receives a complete list of steps with every update (not deltas). Each message is a full snapshot of the plan state.

---

## How AskUser Works End-to-End

1. Claude decides it needs to ask the user a question
2. Claude calls `mcp__CoworkUserInteraction__ask_user_question` (custom MCP tool, flight-gated: `OfficeAgent.CoworkAgent.EnableAskUserInteractive`)
3. The MCP tool handler sends `CoworkAskUser` message via WebSocket
4. `UserInteractionManager.waitForAnswer()` creates a pending promise (5-minute timeout)
5. AugLoop's `CoworkAskUserHandler` receives it, wraps as `OfficeAgentPollingResult` with `contentOrigin: 'CoworkAskUser'`
6. Client polls and gets the question
7. **Client sends response back** (as a new signal or via the stateful workflow mechanism)
8. AugLoop forwards to container, `CoworkAgent.handleAskUserResponse()` resolves the pending promise
9. Claude gets the answer and continues

**The built-in AskUserQuestion tool is DENIED** (via PreToolUse hook) because it requires stdin, which doesn't exist in Docker.

---

## Cowork Agent Capabilities

### Skills (defined in registry)
- **calendar-review** — Analyze meetings, find conflicts, identify focus time
- **people-lookup** — Find colleagues, org structure, management chains
- **email-review** — Review emails, summarize threads
- **docx** — Create Word documents (DOCX) with full OOXML manipulation (has python scripts, XSD schemas, comment/redline support)

### Scripts
- **enterprise-search.js** — Search calendar events, emails, people, files, chat, transcripts via Microsoft Graph
- **fetch-user-context.js** — Get user profile, recent contacts, upcoming meetings

### Model
- Default: `anthropic-claude-opus-4-6`
- Flight: `OfficeAgent.CoworkAgent.EnableSonnet45` switches to Sonnet 4.5

---

## Patterns

1. **Reuses existing augloop machinery**: The cowork-agent rides the existing `OfficeAgentAsync` workflow and `CreateAgentDocumentGenerationStrategy`. No new workflow was needed — just new message handlers registered in `initializeMessageHandlers()`.

2. **contentOrigin discriminator**: All cowork messages flow through the same `OfficeAgentPollingResult` annotation type, differentiated by `contentOrigin` string values (`CoworkProgressUpdate`, `CoworkAskUser`, `CoworkChainOfThought`, `CoworkResponse`).

3. **Agent ID routing**: The `agentId` field in `IDocumentGenerationStrategyParams` determines which container agent handles the request. The strategy sends a session_init with this ID.

4. **First-message ACK pattern**: Cowork handlers each have an `onFirstMessage` callback that auto-resolves the `ChatResponse` ACK, since the cowork agent doesn't send a dedicated ACK like document-generation agents do.

5. **Multi-turn via conversation state**: OfficeAgent tracks `ConversationState` per conversation. Turn > 1 triggers chat history fetch and agent state resume. AugLoop's stateful workflow (`stateExpiryMs: 82800000` = 23 hours) maintains the polling session.

---

## Dependencies

```
Bebop UX (office-bohemia)
    ↓ sends OfficeAgentAsyncSignal
AugLoop Platform
    ↓ routes to OfficeAgentAsync workflow
augloop-workflows (utils/office-agent)
    ↓ CreateAgentDocumentGenerationStrategy
    ↓ registers CoworkProgressHandler, CoworkAskUserHandler,
    ↓   CoworkChainOfThoughtHandler, CoworkResponseHandler
    ↓ WebSocket connection to container
OfficeAgent container (agents/cowork-agent)
    ↓ CoworkAgent extends BaseAgent
    ↓ Claude Agent SDK → Claude API
    ↓ WebSocketMessengerService sends structured messages
    ↓ ProgressStateManager derives progress from TodoWrite
```

---

## Gaps & Open Questions

1. **No description in either PR** — Both have template-only descriptions with no actual content. WIP state.
2. **augloop-workflows manifest unchanged** — No new workflow entry; cowork reuses `OfficeAgentAsync`. This works but means there's no dedicated cowork workflow with potentially different timeouts or token requirements.
3. **How does the client send AskUserResponse back?** — The cowork_ask_user_response message type is defined, but the client→AugLoop→container flow for sending the answer isn't fully clear from these PRs alone. Likely uses the existing signal mechanism (new signal with the response payload).
4. **Document generation**: The cowork agent can produce DOCX files. The handler scans the output dir for .docx/.pptx/.xlsx files and sends them via `DocumentGenerated` query status. The UX may need to handle document download/preview.
5. **No unit tests for augloop handlers** — The test file `create-agent-websocket-strategy.test.ts` was edited but no dedicated cowork handler tests.

---

## Recommendations for UX Work

### What Yemi needs to build in Bebop:

1. **Cowork route/page** — Already exists (`_mainLayout.cowork.tsx` from PR-4959180). This is the entry point.

2. **Polling/signal integration** — Use the existing AugLoop signal mechanism to:
   - Send `OfficeAgentAsyncSignal` with `agentId: 'cowork-agent'`
   - Poll for `OfficeAgentPollingResult` annotations

3. **Message parsing by contentOrigin** — Build a dispatcher that reads `contentOrigin` from polling results:
   ```typescript
   switch (result.contentOrigin) {
       case 'CoworkProgressUpdate': // JSON payload → CoworkProgressUpdatePayload
       case 'CoworkAskUser':        // JSON payload → CoworkAskUserPayload
       case 'CoworkChainOfThought': // raw text → reasoning display
       case 'CoworkResponse':       // JSON payload → CoworkResponsePayload
   }
   ```

4. **Progress UI component** — Render `CoworkProgressStep[]` with:
   - Step label + status (pending/in-progress/completed/failed)
   - Expandable sub-updates within each step
   - Overall progress bar from `progressPercent`

5. **AskUser UI component** — Render questions with:
   - Question text
   - Selectable option buttons (if `options` is provided)
   - Free-text input (if `allowFreeText` is true)
   - Send response back as `CoworkAskUserResponsePayload`

6. **Chain of Thought display** — Stream reasoning text as it arrives

7. **Final response rendering** — Markdown content from `CoworkResponsePayload`

8. **Document download** — Handle `DocumentGenerated` status for .docx files
