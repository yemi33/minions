# Squad Notes

## Active Notes

### 2026-03-12: Rebecca W003 Findings — Progression UI & Ask-User-Question Design
**By:** Persisted from inbox (rebecca-W003-2026-03-12.md)
**What:** # Rebecca W003 Findings — Progression UI & Ask-User-Question Design

**Date:** 2026-03-12
**Task:** W003 — Design doc for progression UI and ask-user-question UI
**PR:** PR-4959405 (office-bohemia)

## What I Learned

### bebop-desktop Patterns

1. **ChainOfThoughtCard is the core progression component** — It renders a list of `CoTProcessingStep` objects per message, each with `Pending → InProgress → Complete` status transitions. Steps are streamed progressively with configurable timin

---


### 2026-03-12: Ralph — Learnings from office-bohemia Exploration
**By:** Persisted from inbox (ralph-2026-03-12.md)
**What:** # Ralph — Learnings from office-bohemia Exploration

**Date:** 2026-03-12

## Key Learnings

1. **office-bohemia is the Microsoft Loop monorepo** — ~227 packages, Yarn 4.12, Lage 2.14, TypeScript 5.9, Node 24+. Main branch is `master`.

2. **Two main apps with different stacks:**
   - **Bebop** (M365 Copilot App): TanStack Start + React 19 + Vite 7 + Nitro + SSR/RSC + React Compiler
   - **Loop App**: React 18 + Webpack + Cloudpack + Fluent UI SPA

3. **Bebop feature-first pattern is

---


### 2026-03-11: Use Azure DevOps (ADO) for all git/repo operations
**By:** yemishin
**What:** All repo operations (branches, PRs, commits, work items, code search) must use `mcp__azure-ado__*` MCP tools. NEVER use GitHub CLI (`gh`) or GitHub API.
**Why:** All repos live in Azure DevOps, not GitHub.

---

### 2026-03-11: All features and bug fixes require a PR for review
**By:** yemishin
**What:** All features and bug fixes MUST go through a pull request via `mcp__azure-ado__repo_create_pull_request`. No direct commits to main. After creating a PR, add it to the project's `.squad/pull-requests.json` so it appears on the dashboard.
**Why:** Enforce code review for all changes.

---

### 2026-03-11: Post comments directly on ADO PRs
**By:** yemishin
**What:** All agent reviews, implementation notes, and sign-offs must be posted as ADO PR thread comments using `mcp__azure-ado__repo_create_pull_request_thread`. Local `.squad/decisions/inbox/` files are backup records — the PR is the primary comment surface.
**Why:** Comments need to live on the PRs, not just in local files.

---

### 2026-03-11: Use git worktrees — NEVER checkout on main
**By:** yemishin
**What:** Agents MUST use `git worktree add` for feature branches. NEVER `git checkout` in the main working tree. Pattern: `git worktree add ../worktrees/feature-name -b feature/branch-name`
**Why:** Checking out branches in the main working tree wipes squad state files.

---

### 2026-03-12: Use Figma MCP to inspect designs
**By:** yemishin
**What:** Agents can use the Figma MCP server to inspect design files when implementing UI features. Use this to reference actual designs rather than guessing layouts, spacing, colors, or component structure.
**Why:** Ensures implementations match the designer's intent. Especially relevant for bebop-desktop (prototype UIs) and office-bohemia (Bebop app UX).

---


---

### 2026-03-12: Consolidated from 5 inbox items
**By:** Engine (auto-consolidation)

#### Review Findings (2)
- **feedback-dallas-from-ripley-PR-4959180-2026-03-12.md**: **PR:** PR-4959180 — Add cowork route to bebop webapp

#### Other (3)
- **dallas-2026-03-12.md**: - **office-bohemia** (OC/office-bohemia)
- **ralph-fanout-W002-2026-03-12.md**: **Date:** 2026-03-12
- **ripley-2026-03-12.md**: 1. **Bebop route pattern**: New routes in Bebop follow a thin-route pattern under `apps/bebop/src/routes/`. Layout routes are prefixed with `_mainLayo



---

### 2026-03-12: Consolidated from 5 inbox items
**By:** Engine (auto-consolidation)

#### Review Findings (1)

#### Other (4)
- **lambert-2026-03-12.md**: 1. **Bebop thin-route pattern is highly uniform**: Route files under `apps/bebop/src/routes/` follow a strict template — `head()` for meta, `loader()`
- **rebecca-2026-03-12.md**: **Date:** 2026-03-12
- **rebecca-fanout-W002-2026-03-12.md**: **By:** Rebecca (Architect)
- **ripley-2026-03-12.md**: 1. **Bebop thin-route pattern**: New routes in Bebop follow a thin-route pattern under `apps/bebop/src/routes/`. Layout routes are prefixed with `_mai



---

### 2026-03-13: Consolidated from 5 inbox items
**By:** Engine (auto-consolidation)

#### Other (5)
- **dallas-W005-2026-03-12.md**: **Date:** 2026-03-12
- **dallas-W006-2026-03-13.md**: **Date:** 2026-03-13
- **lambert-2026-03-12.md**: 1. **Bebop MessageTemplates pattern**: The `MessageTemplates` interface in `bebop-conversation-orchestrator` uses a render-function-per-message-type p
- **lambert-2026-03-13.md**: 1. **ADO PR status codes**: `status: 1` = active, `status: 2` = abandoned, `status: 3` = completed/merged. The `mergeStatus` field is separate — `merg
- **ralph-2026-03-13.md**: **Date:** 2026-03-13

