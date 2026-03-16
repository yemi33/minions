# Command Center

The Command Center (CC) is a conversational AI interface in the dashboard that has full visibility into the squad's state and can both answer questions and take actions.

## Access

Click the **CC** button in the top-right header of the dashboard. A slide-out chat drawer opens on the right side.

## How It Works

The CC is powered by Sonnet with multi-turn tool access. Each message you send:

1. **Builds a system prompt** with the full squad state (agents, plans, PRs, work items, config, routing, skills, KB, notes, dispatch history)
2. **Sends your message** along with conversation history (last 10 messages) to Sonnet
3. **Sonnet can use tools** to dig deeper — reading files, searching the codebase, looking up agent outputs
4. **Parses the response** for action blocks and displays the conversational answer
5. **Executes any actions** (dispatching work, managing plans, etc.) via dashboard API calls

## What It Knows

The CC has full context injected on every message:

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

## Tool Access (Read-Only)

The CC can use tools to look beyond the pre-loaded context:

- **Read** — Open any file (agent output logs, code, config, plans)
- **Glob** — Find files by pattern (e.g., `agents/*/output.log`)
- **Grep** — Search file contents (find functions, search agent outputs)
- **WebFetch/WebSearch** — Look up external resources

Key file paths the CC knows about:
- Agent outputs: `agents/{id}/output.log` (latest) or `output-{dispatch-id}.log` (archived)
- Plans: `plans/*.md` (source) and `plans/*.json` (PRDs)
- Work items: `work-items.json` (central) or `{project}/.squad/work-items.json`
- Knowledge: `knowledge/{category}/*.md`

The CC cannot write files or run commands — it's strictly read-only for information gathering.

## Actions

When you ask the CC to *do* something, it includes structured action blocks in its response. The dashboard frontend parses and executes them via API calls.

| Action | What It Does | Example Prompt |
|--------|-------------|----------------|
| `dispatch` | Create a work item | "Have dallas fix the login bug in OfficeAgent" |
| `note` | Save a decision/reminder | "Remember that we need to migrate to v3 API" |
| `plan` | Create an implementation plan | "Plan out the GitHub integration feature" |
| `cancel` | Stop a running agent | "Cancel whatever ripley is doing" |
| `retry` | Retry failed work items | "Retry the three failed tasks" |
| `pause-plan` | Pause a PRD | "Pause the officeagent PRD" |
| `approve-plan` | Approve a PRD | "Approve the new plan" |
| `edit-prd-item` | Edit a PRD item | "Change P003's priority to high" |
| `remove-prd-item` | Remove a PRD item | "Remove P011 from the plan" |
| `delete-work-item` | Delete a work item | "Delete work item W025" |

Multiple actions can be taken in a single response.

## Example Prompts

**Questions:**
- "What's blocking progress right now?"
- "What did dallas do on the last PR?"
- "What was ripley's old plan about?"
- "Why did P011 fail?"
- "How many items are left in the officeagent PRD?"
- "Who should handle API design work?"

**Actions:**
- "Retry all failed tasks"
- "Have rebecca explore the auth module in office-bohemia"
- "Create a plan to add GitHub PR support, parallel branches"
- "Pause the current PRD and start a new plan for v2"
- "Cancel lambert and reassign the review to ripley"

**Multi-step:**
- "Read dallas's output log and tell me what went wrong, then retry if it was a transient error"
- "Check what's left in the PRD, then dispatch the highest priority missing item"

## Architecture

```
User message
    |
    v
POST /api/command-center
    |
    +-- Build system prompt (full squad state)
    +-- Inject conversation history (last 10 messages)
    +-- Call Sonnet via callLLM() with:
    |     model: sonnet
    |     maxTurns: 5
    |     allowedTools: Read, Glob, Grep, WebFetch, WebSearch
    |     timeout: 180s
    |
    v
Parse response
    |
    +-- Extract display text (markdown)
    +-- Extract action blocks (```action {...}```)
    |
    v
Dashboard frontend
    +-- Render chat message
    +-- Execute each action via dashboard API
    +-- Show action status (success/fail)
```

## vs Command Bar

The existing command bar at the top of the dashboard still works for quick commands. The CC is for when you need deeper reasoning or conversation.

| | Command Bar | Command Center |
|---|---|---|
| Model | Haiku (fast, cheap) | Sonnet (smart, multi-turn) |
| Tools | None | Read, Glob, Grep, Web |
| Mode | Classify and dispatch | Conversational + actions |
| Context | Squad state summary | Full state + file access |
| Best for | Quick dispatches | Questions, reasoning, multi-step |
