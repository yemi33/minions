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


---

### 2026-03-14: OfficeAgent three-tier agent architecture with registry-first design and orchestrator abstraction
**By:** Engine (LLM-consolidated)

#### Build & Test Results
- **PR-4964594 Dallas progression feature**: Build PASS (106 lage tasks, 3m 1s), Tests PASS (13.13s), Lint FAIL (13 errors: 11 from PR, 2 pre-existing). _(Rebecca)_

#### PR Review Findings
- **Lint errors in progression feature**: 6 errors in `progressionAtoms.ts` (unnecessary conditionals, missing curly braces), 3 in `ProgressionCard.tsx` (unnecessary conditionals/optional chains), 1 in `UserQuestionBanner.tsx` (should use optional chain), 1 in `index.ts` (barrel file violates `no-barrel-files` rule). _(Rebecca)_

#### Architecture Notes
- **Three-tier agent pattern**: OfficeAgent uses Full Claude SDK agents (multi-version, sub-agents, 20+ flights), Copilot SDK agents (simpler, GhcpOrchestrator), and Minimal agents (no LLM, direct conversion). _(Ripley)_
- **Orchestrator abstraction**: `@officeagent/orchestrator` provides provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` implementations using factory pattern. _(Ripley)_
- **Registry-first design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. _(Ripley)_
- **Versioned prompts with EJS templates**: Prompts organized under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. _(Ripley)_
- **Skills vs sub-agents distinction**: Skills are direct instructions + scripts (shared context window); sub-agents are isolated Claude instances with own system prompt (parallel, focused). _(Ripley)_
- **Hook system**: `HookRegistry` with per-agent-type providers (Base, Word, Excel, PowerPoint) for performance tracking, CoT streaming, and output validation. _(Ripley)_
- **Flight system for feature gating**: OAGENT_FLIGHTS environment variable enables per-version feature flags that override version, model, subagents, scripts, and entire prompt files. _(Ripley)_
- **Grounding pipeline (4-stage)**: Preprocessor → Retriever → Postprocessor → Storage with entity-specific extractors (Email, File, Chat, Meeting, People, Calendar, Transcript). _(Ripley)_
- **Docker setup**: Multi-stage build with poppler + LibreOffice + Node 24, ports 6010 (external API), 6011 (internal), 6020 (debug), 7010 (grounding); hot reload via `yarn reload`. _(Ripley)_

#### Action Items
- **Dallas's PR-4964594 lint fixes**: Add curly braces to 6 errors in `progressionAtoms.ts`, remove unnecessary conditionals/optional chains (3 in ProgressionCard, 1 in UserQuestionBanner), remove barrel file `index.ts`, run `yarn lint --fix --to bebop`. _(Rebecca)_

_Processed 2 notes, 12 insights extracted, 1 duplicate removed._

---

### 2026-03-14: W008 build results and OfficeAgent architecture deep-dive

**By:** Engine (LLM-consolidated)

#### Build & Test Results
- **W008 PR-4964594 results**: Build PASS (3m 1s, 106 tasks succeeded), unit tests PASS (13.13s), lint FAIL with 13 errors _(Rebecca)_

#### PR Review Findings
- **Dallas's lint violations**: 6 in `progressionAtoms.ts` (unnecessary conditionals, missing braces), 3 in `ProgressionCard.tsx` (unnecessary conditionals/optional chains), 1 in `UserQuestionBanner.tsx` (missing optional chain), 1 in `index.ts` barrel file (violates no-barrel-files rule) _(Rebecca)_
- **Barrel file performance**: Bebop CONTRIBUTING.md requires concrete module paths to avoid build performance regressions _(Rebecca)_

#### Architecture Notes
- **OfficeAgent registry-first design**: Every agent exports versioned `agentRegistry` configuration (identity, tools, skills, subagents, scripts, flights) with dynamic version/flight selection _(Ripley)_
- **OfficeAgent orchestrator abstraction**: `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` implementations; factory selects provider at runtime _(Ripley)_
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

---

### 2026-03-14: Loop page access patterns and platform constraints
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Loop page ID format**: Base64 encoding of (domain, driveId, itemId); workspace podId adds `ODSP|` prefix to same encoding _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md
- **Loop API environments**: prod (`prod.api.loop.cloud.microsoft`), SDF (`sdf.api.loop.cloud.microsoft`), EU (`eu.prod.api.loop.cloud.microsoft`) _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md
- **Loop API token scope**: Tokens for `https://api.loop.cloud.microsoft` work only for user's Copilot workspace, not other content storage containers _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md

#### Bugs & Gotchas
- **Loop CSP access limitation**: Shared content storage containers (CSP_*) are not accessible via Loop API without explicit ODSP-level access; Azure CLI app lacks SharePoint delegated permissions _(Ralph)_
  → see knowledge/project-notes/2026-03-14-ralph-w018-ux-options-loop-page-access-blocked-.md
- **DriveId shell escaping**: DriveIds with `b!` prefix cause shell escaping issues—use heredocs or node/python instead of inline commands _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md
- **Windows platform constraints**: python3 unavailable (Microsoft Store stub only), `/dev/stdin` incompatible with Node.js, `uuidgen` absent; use `node -e` for UUID generation _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md
- **Background command retrieval**: Short background commands may not be retrievable via TaskOutput if they complete quickly—prefer synchronous execution _(Ralph)_
  → see knowledge/conventions/2026-03-14-ralph-ralph-learnings-2026-03-14.md

#### Action Items
- **Prefer Loop MCP server for shared workspace access**: Use Loop MCP server instead of direct API calls to access Loop pages in shared/team workspaces _(yemishin)_
  → see knowledge/project-notes/2026-03-14-yemishin-use-the-loop-mcp-server-to-read-docs.md

_Processed 3 notes, 8 insights extracted, 0 duplicates removed._