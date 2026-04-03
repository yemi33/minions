# Command Center

The Command Center (CC) is the minions's conversational AI brain. It powers the dashboard's chat panel, document editing modals, and plan steering — all through a single persistent Sonnet session with full minions awareness.

## Access

Click the **CC** button in the top-right header of the dashboard. A slide-out chat drawer opens on the right side.

## Persistent Sessions

CC maintains a true multi-turn session using Claude CLI's `--resume` flag. Unlike a typical stateless API call, each message resumes the same conversation — Claude retains full history including tool calls, intermediate reasoning, and file contents from prior turns.

**Session lifecycle:**
- **Created** on first message (or after expiry/new-session)
- **Resumed** on subsequent messages via `--resume <sessionId>`
- **Expires** after 2 hours of inactivity
- **Persisted** to `engine/cc-session.json` — survives dashboard restarts
- **Frontend messages** saved to `localStorage` — survive page refresh

Click **New Session** in the drawer header to start fresh.

### Fresh State Each Turn

The system prompt is baked into the session at creation (persona, rules, action format, tool access). Dynamic minions state is injected as a preamble in each user message, so CC always sees current data even in a resumed session.

```
Turn 1: system prompt (static) + [Current Minions State] + user message
Turn 2+: [Updated Minions State] + user message  (system prompt already in session)
```

## What It Knows

Full minions context is injected every turn:

| Context | Details |
|---------|---------|
| Agents | Statuses, current tasks, full charters (expertise/roles) |
| Routing | Who's preferred/fallback for each work type |
| Config | Tick interval, max concurrent, timeouts, max turns |
| Work items | Active, pending, failed across all projects with failure reasons |
| Pull requests | Status, review status, build status, branch, URL |
| Plans | Full `.md` plan contents + PRD JSON summaries + archived plans |
| PRD items | All items with status, priority, dependencies |
| Dispatch | Active agents + last 15 completions with result summaries |
| Skills | All reusable agent workflows with triggers |
| Knowledge base | Recent entries (architecture, conventions, build reports, reviews) |
| Team notes | Recent consolidated notes |

## Tool Access

CC can use tools to look beyond the pre-loaded context:

- **Bash** — Run shell commands (git, build tools, scripts)
- **Read** — Open any file (agent output logs, code, config, plans)
- **Write** — Create or overwrite files
- **Edit** — Make targeted edits to existing files
- **Glob** — Find files by pattern (e.g., `agents/*/output.log`)
- **Grep** — Search file contents (find functions, search agent outputs)
- **WebFetch/WebSearch** — Look up external resources

## Unified Brain

All LLM-powered features in the dashboard route through the same CC session:

| Feature | Endpoint | How It Works |
|---------|----------|-------------|
| **CC chat panel** | `POST /api/command-center` | Direct CC interaction |
| **Doc chat modal** | `POST /api/doc-chat` | Routes through CC via `ccDocCall()` |
| **Doc steer** | `POST /api/steer-document` | Routes through CC via `ccDocCall()` |
| **Plan revision** | `POST /api/plans/revise` | Routes through CC via `ccDocCall()` |

This means:
- A question in the doc chat modal shares context with the CC panel
- CC remembers what you discussed in a document editing session
- Doc modals can cross-reference other minions knowledge, PRs, work items
- All turns accumulate in the same session

## Actions

When you ask CC to *do* something, it includes structured action blocks in its response.

| Action | What It Does | Example Prompt |
|--------|-------------|----------------|
| `dispatch` | Create a work item | "Have dallas fix the login bug" |
| `note` | Save a decision/reminder | "Remember we need to migrate to v3" |
| `plan` | Create an implementation plan | "Plan the GitHub integration feature" |
| `cancel` | Stop a running agent | "Cancel whatever ripley is doing" |
| `retry` | Retry failed work items | "Retry the three failed tasks" |
| `pause-plan` | Pause a PRD | "Pause the officeagent PRD" |
| `approve-plan` | Approve a PRD | "Approve the new plan" |
| `edit-prd-item` | Edit a PRD item | "Change P003's priority to high" |
| `remove-prd-item` | Remove a PRD item | "Remove P011 from the plan" |
| `delete-work-item` | Delete a work item | "Delete work item W025" |

## Error Handling

- **Frontend timeout**: 10-minute `AbortSignal` on the fetch — prevents infinite "thinking" spinner
- **Backend timeout**: 5-minute kill timer on the claude process
- **Resume failure**: If `--resume` fails (corrupted/deleted session), automatically retries with a fresh session
- **Concurrency guard**: Only one CC call at a time — concurrent requests get a 429 "CC is busy" response
- **Phase indicators**: Thinking indicator shows progressive phases ("Thinking..." → "Analyzing..." → "Timing out soon...")

## Architecture

```
User message (CC panel, doc modal, or steer)
    │
    ▼
POST /api/command-center  (or /api/doc-chat, /api/steer-document)
    │
    ├── Validate session (expiry check)
    ├── Build dynamic state preamble (buildCCStatePreamble)
    ├── callLLM() with sessionId (resume) or without (new)
    │     model: sonnet
    │     maxTurns: 25 (CC) or 10 (doc-plan) or 1 (doc-other)
    │     allowedTools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
    │     timeout: 600s (CC) or 300s (doc-plan) or 60s (doc-other)
    │
    ▼
spawn-agent.js
    │
    ├── If --resume: skip system prompt file, pass -p --resume <id>
    ├── If new: pass -p --system-prompt-file <file>
    │
    ▼
claude CLI (persistent session on disk)
    │
    ▼
Parse response
    ├── Extract sessionId from stream-json result
    ├── Extract ===ACTIONS=== block (CC)
    ├── Extract ---DOCUMENT--- block (doc chat/steer)
    ├── Update cc-session.json
    │
    ▼
Frontend
    ├── Render chat message
    ├── Execute actions / apply doc edits
    ├── Save sessionId + messages to localStorage
```

## Key Files

| File | Role |
|------|------|
| `engine/llm.js` | `callLLM()` — single LLM function with optional `sessionId` for resume |
| `engine/spawn-agent.js` | Spawns claude CLI; skips system prompt on `--resume` |
| `engine/shared.js` | `parseStreamJsonOutput()` extracts `sessionId` from result |
| `engine/cc-session.json` | Persisted session state (sessionId, turnCount, timestamps) |
| `dashboard.js` | CC endpoint, `buildCCStatePreamble()`, `ccDocCall()`, `parseCCActions()` |
| `dashboard.html` | Frontend: localStorage persistence, session indicator, New Session button |

## Command Bar

The command bar at the top of the dashboard routes all input to the CC panel. Typing in the command bar opens the CC drawer and sends the message as a CC turn.

