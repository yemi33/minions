---
name: capture-demos
description: Capture fresh Playwright screenshots of every dashboard page for the GitHub Pages site
---

# Capture Demo Screenshots

Regenerate the dashboard screenshots used on the GitHub Pages site (https://yemi33.github.io/minions/).

## Prerequisites

- Dashboard must be running on port 7331 (`minions dash` or `node dashboard.js`)
- Playwright chromium must be installed (`npx playwright install chromium`)

## Steps

1. Verify the dashboard is healthy:
   ```bash
   curl -s http://localhost:7331/api/health | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).status))"
   ```

2. Run the capture script:
   ```bash
   node docs/capture-demos.js
   ```

3. Verify screenshots were created:
   ```bash
   ls -la docs/demo/*.png
   ```

4. Commit and push:
   ```bash
   git add docs/demo/*.png
   git commit -m "docs: refresh demo screenshots"
   git push
   ```

## What It Captures

10 screenshots (1400x900, dark theme):

| # | Page | File |
|---|------|------|
| 1 | Home (agent cards, project bar) | `01-dashboard-overview.png` |
| 2 | Work Items (paginated table) | `02-work-items.png` |
| 3 | Plans & PRD (cards, dependency graph) | `03-plans-prd.png` |
| 4 | Pull Requests (sorted tracker) | `04-pull-requests.png` |
| 5 | Meetings (multi-agent rounds) | `05-meetings.png` |
| 6 | Pipelines (stage flow, progress) | `06-pipelines.png` |
| 7 | Notes & KB (inbox, categories) | `07-notes-kb.png` |
| 8 | Schedules (cron builder) | `08-schedules.png` |
| 9 | Engine (dispatch, metrics) | `09-engine.png` |
| 10 | Command Center (side panel) | `10-command-center.png` |

## When to Run

- After significant UI changes (new pages, layout updates, style changes)
- Before a major release
- When the GitHub Pages site looks outdated

## Script Location

`docs/capture-demos.js` — edit to add new pages or change viewport settings.
