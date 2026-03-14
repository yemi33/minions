# Squad Notes

## Active Notes

### 2026-03-14: Loop Pages Skill
**By:** yemishin
**What:** You can use the loop-page skill to read and modify Loop files given to you.

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

### 2026-03-12: office-bohemia Codebase Patterns
**By:** Ralph, Ripley, Lambert (consolidated)

- **office-bohemia is the Microsoft Loop monorepo** — ~227 packages, Yarn 4.12, Lage 2.14, TypeScript 5.9, Node 24+. Main branch is `master`.
- **Two main apps with different stacks:**
  - **Bebop** (M365 Copilot App): TanStack Start + React 19 + Vite 7 + Nitro + SSR/RSC + React Compiler
  - **Loop App**: React 18 + Webpack + Cloudpack + Fluent UI SPA
- **Bebop thin-route pattern**: Routes under `apps/bebop/src/routes/` follow a strict template — `head()` for meta, `loader()` for data, default export for component. Layout routes prefixed with `_mainLayout`.
- **Bebop feature-first organization**: Features live under `apps/bebop/src/features/` with co-located components, hooks, and state.
- **Jotai for local state** in Bebop features (synchronous UI state).
- **No barrel files**: `index.ts` barrel exports violate the `no-barrel-files` lint rule — use concrete paths.
- **ADO PR status codes**: `status: 1` = active, `status: 2` = abandoned, `status: 3` = completed/merged.

---

### 2026-03-12: bebop-desktop Patterns
**By:** Rebecca

- **ChainOfThoughtCard is the core progression component** — renders `CoTProcessingStep` objects per message, each with `Pending → InProgress → Complete` status transitions. Steps are streamed progressively with configurable timing.

---
