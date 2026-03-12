# Squad Decisions

## Active Decisions

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
- **feedback-ralph-from-ripley-PR-4959180-2026-03-12.md**: **PR:** PR-4959180 — 2026-03-12.md\nripley-2026-03-12.md","is_error":false}]},"parent_tool_use_id":null,"session_id":"0b4bb381-c0ff-4e6f-b959-ea06ce9d

#### Other (3)
- **dallas-2026-03-12.md**: - **office-bohemia** (OC/office-bohemia)
- **ralph-fanout-W002-2026-03-12.md**: **Date:** 2026-03-12
- **ripley-2026-03-12.md**: 1. **Bebop route pattern**: New routes in Bebop follow a thin-route pattern under `apps/bebop/src/routes/`. Layout routes are prefixed with `_mainLayo

