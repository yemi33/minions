# Intelligent Command Center (Haiku Triage)

## Overview

The Command Center input box uses a Haiku LLM call to interpret natural language commands before creating work items. This replaces rigid keyword matching with contextual understanding.

## Flow

```
User types natural language (e.g., "ok ripley's plan - review it")
    |
    v
Frontend: cmdSubmit() -> cmdTriageAndSubmit() -> POST /api/triage
    |
    v
Backend: builds compact context + system prompt -> spawns Haiku (spawn-agent.js)
    |
    v
Haiku returns structured JSON:
  { intent, type, title, description, agents, priority, project, ... }
    |
    v
Frontend routes to existing: cmdSubmitWorkItem / cmdSubmitNote / cmdSubmitPlan
    |
    v
Existing API endpoints (/api/work-items, /api/notes, etc.) -- UNCHANGED
```

## Key Files

- **`dashboard.js`** — `getTriageContext()` builds ~1-2KB context (agents, projects, recent work items, plans, active dispatches). `POST /api/triage` spawns Haiku with a structured system prompt and 30s timeout.
- **`dashboard.html`** — `cmdTriageAndSubmit(raw)` calls the triage API with a 35s frontend timeout. Falls back silently to `cmdParseInput()` regex parser on any failure.

## Intents

| Intent | Trigger | Routes to |
|--------|---------|-----------|
| `work-item` | Default. Types: ask, explore, fix, review, test, implement | `cmdSubmitWorkItem()` -> `/api/work-items` |
| `note` | "remember", "note", "don't forget", `/note`, `/decide` | `cmdSubmitNote()` -> `/api/notes` |
| `plan` | "plan", "design", "architect", "prd", `/plan` | `cmdSubmitPlan()` -> `/api/plan` |

## Context Sent to Haiku

- Agent names, IDs, status, and current task (truncated)
- Project names and descriptions
- Last 10 work items (ID, title, type, status, assignee)
- Plan filenames from `plans/` directory
- Active dispatch queue entries

## Explicit Syntax Still Works

Power user shortcuts are preserved in the Haiku system prompt rules:
- `@agent` — assign to agent
- `@everyone` / `@all` — fan-out
- `#project` — tag project
- `!high` / `!urgent` / `!low` — priority
- `/plan`, `/note`, `/decide` — force intent

## Fallback

If Haiku fails, times out, or returns invalid JSON, the frontend silently falls back to the existing `cmdParseInput()` regex parser. The user never sees an error — they just get the old keyword-matching behavior.

## Commands to Try

Try these in the Command Center to see triage in action:

**Work items (implement, explore, fix, test):**
```
fix the auth bug in the login page @dallas !high #office-bohemia
→ { intent: "work-item", type: "fix", agents: ["dallas"], priority: "high", project: "office-bohemia" }

explore how the 1JS framework loads experiences
→ { intent: "work-item", type: "explore", title: "Explore how 1JS framework loads experiences" }

build and test dallas's latest PR
→ { intent: "work-item", type: "test", title: "Build and test Dallas's latest PR" }
```

**Notes (team context, FYI, decisions):**
```
/note sachin is the eng who owns the Sydney NDJSON streaming backend
→ { intent: "note", title: "Sachin is the eng who owns the Sydney NDJSON streaming backend" }

/decide all PRs must have a test plan section
→ { intent: "note", title: "All PRs must have a test plan section" }
```

**Plans (feature work, multi-step projects):**
```
/plan implement claude cowork UX in bebop with OfficeAgent capabilities #office-bohemia #OfficeAgent
→ { intent: "plan", title: "Implement Claude Cowork UX...", projects: ["office-bohemia", "OfficeAgent"] }

make a plan for adding progression UI to the cowork route --stack
→ { intent: "plan", branchStrategy: "shared-branch" }
```

**Fan-out (parallel dispatch to all agents):**
```
explore all codebases and document architecture @everyone
→ { intent: "work-item", type: "explore", fanout: true }
```

**Agent assignment:**
```
@rebecca design the API schema for the new agent protocol
→ { intent: "work-item", type: "explore", agents: ["rebecca"] }

ok ripley's plan - review it
→ Haiku infers: review Ripley's plan (matches against recent plans in context)
```

## Design Decisions

- **Haiku, not Sonnet** — triage is a classification task; Haiku is sufficient and faster
- **30s backend timeout** — spawn startup on Windows takes ~10s; actual inference is fast
- **Regex preview stays** — `cmdRenderMeta()` still runs on keystroke using the regex parser for live chip preview. The Haiku triage only fires on submit
- **Button disabled during triage** — prevents double-submit during the async wait
- **`windowsHide: true`** — all spawn calls use this to prevent terminal windows popping up on Windows
