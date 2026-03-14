You are a knowledge manager for a software engineering squad. Your job is to consolidate agent notes into team memory.

## Inbox Notes to Process

<note file="ralph-2026-03-14.md">
# Ralph Learnings — 2026-03-14

## W018: Loop Page Access Attempt

### What I Learned
- **Loop pages in shared content storage containers** (CSP_*) are not accessible via the Loop API unless the user has explicit ODSP-level access to that container
- The Azure CLI app registration does **not** have SharePoint delegated permissions — `user_impersonation` scope is rejected by SPO REST API
- The Loop API token (resource `https://api.loop.cloud.microsoft`) works for the user's **Copilot workspace** but returns 403 for other content storage containers
- The Graph API `/shares/` endpoint with base64-encoded sharing URLs also requires underlying SP permissions
- The `sharepoint-df.com` domain is Microsoft's dogfood environment; it works the same as production but is separate infrastructure

### Patterns Discovered
- **Loop page ID format**: `base64(domain,driveId,itemId)` URL-encoded
- **Loop workspace podId format**: `base64(ODSP|domain|driveId|itemId)` — the workspace is identified by its storage root
- **Nav parameter in Loop URLs**: base64-encoded query string containing `s` (site path), `d` (driveId), `f` (itemId), `a` (app), `p` (container type)

### Gotchas for Future Agents
1. **DriveIds with `b!` prefix** cause shell escaping issues — always use heredocs or node/python to handle them, never echo or inline in shell commands
2. **python3** is not available on this Windows machine (only the Microsoft Store stub) — use `node` instead for encoding/decoding operations
3. **`/dev/stdin`** doesn't work with Node.js on Windows — use heredocs piped to the script instead
4. **`uuidgen`** is not available — use `node -e "const c=require('crypto');process.stdout.write(c.randomUUID())"` instead
5. **Background commands** may not be retrievable via TaskOutput if they complete too quickly — prefer synchronous execution for short commands

### Conventions
- Loop API environments: prod (`prod.api.loop.cloud.microsoft`), SDF (`sdf.api.loop.cloud.microsoft`), EU (`eu.prod.api.loop.cloud.microsoft`)
- Content storage containers use CSP GUIDs, not workspace podIds

</note>

<note file="ralph-explore-W018-2026-03-14.md">
# W018 — UX Options Loop Page (Access Blocked)

**Agent:** Ralph
**Date:** 2026-03-14
**Task:** Read and note the UX options document from Loop page

## Area Explored

Attempted to read a Loop page containing UX options:
- **URL:** `https://microsoft.sharepoint-df.com/:fl:/g/contentstorage/CSP_96f34ace-61d2-44c7-a207-5b80b73efd94/IQDaw7fOButDQrWkoH1kPJSNAfCUh9LKU0f38qtLhWJ9tzI`
- **Content Storage:** `CSP_96f34ace-61d2-44c7-a207-5b80b73efd94`
- **Domain:** `microsoft.sharepoint-df.com` (dogfood environment)
- **DriveId:** `b!zkrzltJhx0SiB1uAtz79lGAy6khYQgRCnwEHmvDvZWAeSDQNI9QNQadhSQ1cV9w2`
- **ItemId:** `01MGZQ4C62YO344BXLINBLLJFAPVSDZFEN`

## Status: BLOCKED — Access Denied

Could **not** read the page content. Tried all available methods:

| Method | Result |
|--------|--------|
| Loop API (prod) | 403 Forbidden — ODSP `accessDenied` |
| Loop API (SDF) | 403 Forbidden — ODSP `accessDenied` |
| Graph API v1.0 `/drives/{driveId}/items/{itemId}` | `accessDenied` |
| Graph API `/shares/{encodedUrl}/driveItem` | `accessDenied` |
| Graph Canary endpoint | Tenant not allowed |
| SharePoint REST API v2.0 | `invalidScope` — Azure CLI app not authorized for SPO |
| WebFetch (direct URL) | 401 Unauthorized |

### Root Cause
The Azure CLI app registration (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) does not have delegated SharePoint permissions (e.g., `Sites.Read.All`, `Files.Read.All`) for content storage containers. The `user_impersonation` scope from `az account get-access-token` is not accepted by SharePoint Online for direct API calls.

Additionally, the Loop API token (resource `https://api.loop.cloud.microsoft`) returns ODSP-level `accessDenied`, indicating the user's Loop API permissions don't extend to this specific content storage container (it's not the user's Copilot workspace).

## What We Know

From the task description:
- The document **outlines UX options** (no further details available without page access)
- It lives in a shared content storage container (CSP), not the user's personal Copilot workspace

## Recommendations

1. **Share the page content directly** — copy/paste the UX options into the task or a text file so agents can process it
2. **Grant Loop API access** — the content storage may need explicit sharing with the user's account, or the page link sharing settings may need to be updated
3. **Use a different auth flow** — a browser-based OAuth flow with proper SharePoint scopes (not Azure CLI) would be needed for programmatic access to this content storage

## Gaps

- **Loop page content unread** — cannot summarize or analyze UX options without access
- **No alternative auth path available** — all agent-accessible token acquisition methods lack SharePoint content storage permissions

## Learnings

### Loop Page Access via Azure CLI Limitations
- Azure CLI's `user_impersonation` scope is **rejected** by SharePoint REST API for direct content storage access
- Loop API access depends on ODSP-level permissions — being authenticated isn't enough; the user needs explicit access to the specific content storage container
- The Graph `/shares/` endpoint with encoded sharing URLs also fails if the underlying SharePoint permissions aren't in place
- For Loop pages in **shared/team workspaces** (not the user's Copilot workspace), the Loop API `POST /pages/{id}` will return 403 even with a valid token

</note>

<note file="ripley-2026-03-14.md">
# Ripley Learnings — 2026-03-14

## What I Learned

### AugLoop ↔ OfficeAgent Connection Pattern
- AugLoop is the orchestration platform that sits between clients (Bebop) and agent containers (OfficeAgent)
- The `OfficeAgentAsync` workflow in AugLoop is stateful and polling-based
- All agent-to-client communication goes through `OfficeAgentPollingResult` annotations
- The `contentOrigin` field on `OfficeAgentPollingResult` discriminates between message types
- `CreateAgentDocumentGenerationStrategy` is the core bridge class in augloop-workflows that manages the WebSocket connection to the agent container

### Cowork Agent Architecture
- New agent type: `cowork-agent` in OfficeAgent repo, extends `BaseAgent`
- Uses Claude Agent SDK directly (like other Tier 1 agents)
- Novel: derives progress from Claude's `TodoWrite` tool calls via `ProgressStateManager`
- Custom MCP tool (`ask_user_question`) for interactive Q&A, flight-gated
- Built-in `AskUserQuestion` tool denied via PreToolUse hook (no stdin in Docker)
- Reuses the existing `OfficeAgentAsync` workflow — no new AugLoop workflow needed

### ADO API Pattern for Fetching PR File Contents
- Use the Items API with `versionDescriptor.version` and `versionDescriptor.versionType=branch` to fetch files from a specific branch
- Format: `/_apis/git/repositories/{repoId}/items?path={path}&versionDescriptor.version={branchName}&versionDescriptor.versionType=branch`
- The Iterations API shows PR push history with descriptions

## Gotchas
- augloop-workflows is a 31GB repo — don't try to clone it
- Cowork message types are currently raw strings cast to `MessageType` (not yet in the published enum)
- The `onFirstMessage` callback pattern on cowork handlers auto-resolves the ChatResponse ACK — cowork agents don't send a dedicated ACK

## Conventions
- AugLoop handlers follow the `IMessageHandler` interface pattern with `handle(message, context, tracker)`
- Agent message types are defined in `@officeagent/message-protocol` (OfficeAgent repo) AND mirrored as local types in augloop-workflows handlers
- Flight gates control feature rollout: e.g., `OfficeAgent.CoworkAgent.EnableAskUserInteractive`

</note>

<note file="ripley-explore-W015-2026-03-14.md">
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

5. **Multi-turn via conversation state**: OfficeAgent tracks `ConversationState` per conversation. Turn > 1 triggers chat history fetch and agent state resume. AugLoop's stateful workflow (`stateExpiryMs:
</note>

## Existing Team Notes (for deduplication — do NOT repeat what's already here)

<existing_notes>
...
estrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` implementations; factory selects provider at runtime _(Ripley)_
- **OfficeAgent versioned prompts**: Organized under `src/prompts/<version>/` including system prompt, RAI, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites _(Ripley)_
- **OfficeAgent skills vs subagents**: Skills are shared-context instructions; subagents are isolated Claude instances for parallel execution of focused pipeline steps (e.g., DOCX outline → multiple section generators) _(Ripley)_
- **OfficeAgent hook system**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn) enabling CoT streaming and performance instrumentation _(Ripley)_
- **OfficeAgent flight system**: Feature-flag toggles via `OAGENT_FLIGHTS=<key>:true` that override version, model, subagents, scripts, RAI, and prompt files per version _(Ripley)_
- **OfficeAgent grounding pipeline**: 4-stage processing (Preprocessor → Retriever → Postprocessor → Storage) with entity extractors for email, file, chat, meeting, people, calendar, transcript _(Ripley)_
- **OfficeAgent three-tier agents**: Tier 1 (Create-agent: full Claude SDK, 20+ flights), Tier 2 (Copilot SDK agents importing shared services), Tier 3 (minimal agents, no LLM logic) _(Ripley)_

#### Gaps
- **OfficeAgent documentation**: CLAUDE.md missing for 6 agents; README outdated (lists 7 agents vs. 14+ actual) _(Ripley)_
- **OfficeAgent testing**: Coverage data only visible in CI; no documented local coverage or smoke-test command _(Ripley)_

#### Action Items
- **Dallas's lint fixes**: Fix 6 errors in `progressionAtoms.ts`, 3 in `ProgressionCard.tsx`, 1 in `UserQuestionBanner.tsx`; remove/restructure `index.ts` barrel file _(Rebecca)_
- **Dallas's quick-fix**: Run `yarn lint --fix --to bebop` to auto-repair 6 fixable linting errors _(Rebecca)_

_Processed 2 notes, 14 insights extracted, 2 duplicates removed._
</existing_notes>

## Instructions

Read every inbox note carefully. Produce a consolidated digest following these rules:

1. **Extract actionable knowledge only**: patterns, conventions, gotchas, warnings, build results, architectural decisions, review findings. Skip boilerplate (dates, filenames, task IDs).

2. **Deduplicate aggressively**: If an insight already exists in the existing team notes, skip it entirely. If multiple agents report the same finding, merge into one entry and credit all agents.

3. **Write concisely**: Each insight should be 1-2 sentences max. Use **bold key** at the start of each bullet.

4. **Group by category**: Use these exact headers (only include categories that have content):
   - `#### Patterns & Conventions`
   - `#### Build & Test Results`
   - `#### PR Review Findings`
   - `#### Bugs & Gotchas`
   - `#### Architecture Notes`
   - `#### Action Items`

5. **Attribute sources**: End each bullet with _(agentName)_ or _(agent1, agent2)_ if multiple.

6. **Write a descriptive title**: First line must be a single-line title summarizing what was learned. Do NOT use generic text like "Consolidated from N items".

7. **Reference the knowledge base**: Each note is being filed into the knowledge base at these paths. After each insight bullet, add a reference link so readers know where to find the full detail:
- `ralph-2026-03-14.md` → `knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md`
- `ralph-explore-W018-2026-03-14.md` → `knowledge/project-notes/2026-03-14-ralph-w018-ux-options-loop-page-access-blocked-.md`
- `ripley-2026-03-14.md` → `knowledge/architecture/2026-03-14-ripley-ripley-learnings-2026-03-14.md`
- `ripley-explore-W015-2026-03-14.md` → `knowledge/architecture/2026-03-14-ripley-w015-sachin-s-cowork-prs-officeagent-augloop-conne.md`
   Format: `→ see knowledge/category/filename.md` on a new line after the insight, indented.

## Output Format

Respond with ONLY the markdown below — no preamble, no explanation, no code fences:

### YYYY-MM-DD: <descriptive title>
**By:** Engine (LLM-consolidated)

#### Category Name
- **Bold key**: insight text _(agent)_
  → see `knowledge/category/filename.md`

_Processed N notes, M insights extracted, K duplicates removed._

Use today's date: 2026-03-14