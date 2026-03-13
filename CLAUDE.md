# Squad — Project Instructions

## Repository Remotes

- **origin** (`yemishin_microsoft/squad`) — The org repo. This is the personal "save all progress" repo containing full session history, decisions, notes, and work items. Push everything here.
- **personal** (`yemi33/squad`) — The distribution repo for others. Must contain only the barebones engine needed to get started and customize. All session-specific data is stripped during sync (see `/sync-to-personal` skill).

When syncing to personal, the following are stripped: agent history, decisions (archive + inbox + summary), work items, and notes. What remains is the engine, dashboard, playbooks, agent charters, skills, docs, and config template — everything a first-time user needs to clone and run.

## Build & Run

```bash
node engine.js start    # Start engine (ticks every 60s)
node dashboard.js       # Dashboard at http://localhost:7331
node engine.js stop     # Stop engine
node engine.js status   # Show current state
```

No dependencies — uses only Node.js built-ins.

## Key Files

- `engine.js` — Engine daemon (dispatch, discovery, agent spawn, cleanup)
- `dashboard.js` + `dashboard.html` — Web dashboard (single-file HTML served by Node)
- `squad.js` — CLI for init/add/remove projects
- `config.json` — Machine-specific project config (not distributed; use `config.template.json`)
- `playbooks/*.md` — Task templates with `{{variables}}`
- `agents/*/charter.md` — Agent role definitions
- `routing.md` — Dispatch routing rules
