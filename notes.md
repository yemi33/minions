# Squad Notes

## Active Notes

### 2026-03-14: Loop Pages Skill
**By:** yemishin
**What:** You can use the loop-mcp-server to read and modify Loop files given to you.

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

---

### 2026-03-14: SharePoint Loop page access — URL extraction, ID construction, and CSP limitations

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **SharePoint `:fl:` URL nav parameter extraction**: Decode the nav parameter (URL-decode → base64-decode → parse as query string) to extract `d` (driveId), `f` (itemId), `s` (site path), `a` (app type). _(Dallas, Ripley)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md and knowledge/conventions/2026-03-14-ripley-ripley-learnings-2026-03-14.md
- **PageId construction from odspMetadata**: Build pageId as base64(domain + ',' + driveId + ',' + itemId) from workspace odspMetadata, not URL nav params. _(Dallas, Ripley)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md and knowledge/conventions/2026-03-14-ripley-ripley-learnings-2026-03-14.md
- **WorkspaceId construction format**: Build workspaceId as ODSP| + base64(domain + ',' + driveId) for Loop MCP operations. _(Ripley)_
  → see knowledge/conventions/2026-03-14-ripley-ripley-learnings-2026-03-14.md
- **Dogfood environment context**: sharepoint-df.com is Microsoft's dogfood SharePoint environment; standard Loop API endpoints may not route correctly for dogfood content. _(Ripley)_
  → see knowledge/conventions/2026-03-14-ripley-ripley-learnings-2026-03-14.md
- **SharePoint Loop page access workflow**: (1) Decode nav parameter to extract IDs, (2) Extract workspace podId from `x.w` field, (3) Call `list_pages` with workspace podId, (4) Construct pageId from odspMetadata, (5) Call `get_page` with constructed pageId. _(Dallas)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md

#### Bugs & Gotchas
- **DriveId mismatch between URL and workspace listing**: DriveId in URL nav params may differ from workspace listing results (e.g., `...MH9F...` vs `...MG9F...`); always use `list_pages` odspMetadata to avoid 404 errors. _(Dallas)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md
- **CSP containers inaccessible via all available tools**: Shared content storage containers (CSP_*) return errors across all access methods—Loop MCP API (403 accessDenied), WebFetch (401 Unauthorized), URL decoder (format mismatch for `:fl:` URLs). _(Dallas, Ripley)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md and knowledge/conventions/2026-03-14-ripley-ripley-learnings-2026-03-14.md
- **uuidgen unavailable on Windows**: Use `require('crypto').randomUUID()` in Node.js instead of the `uuidgen` command. _(Dallas)_
  → see knowledge/conventions/2026-03-14-dallas-dallas-learnings-2026-03-14-w023-.md

_Processed 3 notes, 8 insights extracted, 5 duplicates removed._

---

### 2026-03-15: Loop ID construction corrected; Bebop and OfficeAgent architecture mapped; PR naming conventions defined

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **PR naming standard**: Use type prefix (feat, fix, design) and branch convention `user/yemishin/<feature name or bug description>`. _(yemishin)_
  → see `knowledge/reviews/2026-03-15-yemishin-generated-pr-title-should-have-type-of-pr-feat-fix.md`

- **Windows bash escaping in Node.js**: Avoid `String.raw` template literals inline with bash `-e`; use forward slashes or heredocs for Windows paths in Node.js eval commands. _(Dallas)_
  → see `knowledge/project-notes/2026-03-15-dallas-dallas-learnings-w024-2026-03-14-.md`

- **Bebop feature-first pattern**: Co-locate components, hooks, atoms, and server functions under `apps/bebop/src/features/cowork/`; avoid barrel files. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **Protocol adapter pattern**: Explicit adapter layer required to bridge OfficeAgent messages to Bebop state model; avoid tight coupling. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **Dual state model in UI**: Combine Jotai (local UI) with SharedTree DDS (collaborative state) to match Bebop's existing TanStack Query + Jotai split. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

#### Architecture Notes
- **Loop ID construction corrected**: WorkspaceId = raw base64-encoded `w` field from nav parameter (NOT `ODSP|base64(domain,driveId)`, which returns 422); pageId = base64(domain,driveId,itemId) with comma separator. _(Dallas)_
  → see `knowledge/project-notes/2026-03-15-dallas-dallas-learnings-w024-2026-03-14-.md`

- **Bebop streaming dual-mode**: Token-by-token via `writeAtCursor` + authoritative markdown snapshots via `snapshot`; responses serialized as HTML + inline `<script type="application/json">` metadata. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **OfficeAgent CoT is file-based only**: `trackChainOfThought()` writes to `.claude/cot.jsonl`; streaming to clients not implemented (no WebSocket types exist yet). _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **Loop Components are Fluid-based, not Office Add-ins**: Loaded via CDN manifest (2x/week) with `registrationId` and discovery; require dependency injection (token providers, code loaders, Fluid services). _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **OfficeAgent WebSocket protocol structure**: Messages use `Message<T> { type, id, sessionId, payload }`; key types: `llm_request/response`, `query_status`, `telemetry`, `mcp_request/response`; buffer limit 99MB. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **Workspace Agent pattern**: Two-phase design (`@workspace-planner` → `@workspace-generator`) with file-based handoff via `workspace_plan.json`; all artifacts as web experiences (HTML). _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **AugLoop integration status**: Only in test code (`.devtools/test-client`), not production; endpoints: Dev `localhost:11040`, Prod `augloop.svc.cloud.microsoft`. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

#### Bugs & Gotchas
- **Cowork feature is entirely greenfield**: No protocol, routing, or UI exists in either office-bohemia or OfficeAgent codebase. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **CoT streaming to clients requires new WebSocket types**: Currently only file-based; adding real-time CoT to UI requires extending OfficeAgent message protocol. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **AugLoop for agent communication is unbuilt**: Test integration exists but production AugLoop transport for agent orchestration needs implementation from scratch. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **Cross-repo builds are independent pipelines**: office-bohemia (Yarn 4.12, different TS version) and OfficeAgent (Yarn 4.10.3) cannot share build artifacts. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

- **SharedTree schema changes require versioning strategy**: Once deployed, schema mutations demand careful migration planning; design schema first. _(Ripley)_
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md`

_Processed 3 notes, 17 insights extracted, 1 duplicate removed._