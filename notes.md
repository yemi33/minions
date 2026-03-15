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

---

### 2026-03-15: W025/W027 PRD Conversion — Architecture & Protocol Findings
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Branch naming convention**: user/yemishin/cowork-<short-name> per team standard. (Ripley)
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15-w027-prd-creation-.md`

- **PR title format**: feat(cowork): <description> per type prefix convention. (Ripley)
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15-w027-prd-creation-.md`

- **OfficeAgent flight gating**: Features use OAGENT_FLIGHTS=<key>:true env var. (Ripley)
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15-w027-prd-creation-.md`

- **No barrel files in Bebop**: Every import must use concrete paths, not index files; enforce on all implementation tasks. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **PowerShell mandatory for OfficeAgent builds**: All yarn/oagent/gulp commands must run in PowerShell; Bash/sh will fail. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **OfficeAgent logging rules**: No user data in logInfo/logWarn/logError; only logDebug allows user data; enforce on all Phase 1 tasks. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

#### Architecture Notes
- **Chain-of-thought is file-only**: CoT manager uses FileHandler + QueueManager + MessageProcessor; all output to disk; zero WebSocket capability. (Lambert, Rebecca)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Message protocol lacks real-time CoT**: MessageType enum has 91–165+ entries but no streaming types; WorkspaceChainOfThought and PptAgentCot are batch/final-state only. (Lambert, Rebecca)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **ask_user_question exists as tool, not protocol**: Referenced in ppt-agent docs but not formalized in message-protocol type enum; bidirectional ask-user-answer infrastructure missing. (Lambert)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **WebSocket handler pattern established**: 14 existing handlers in modules/api/src/websocket/handlers/; new handlers (CoT streaming, ask-user) should follow established patterns. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Dual WebSocket routing**: WebSocketRouter routes by message.type; JsonRpcRouter handles JSON-RPC 2.0 separately; both in modules/core/src/websocket/; needed for bidirectional ask-user flows. (Lambert, Rebecca)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Routes split external/internal**: modules/api/src/routes-external.ts (HTTP endpoints) and routes-internal.ts (internal API + WebSocket registration); new AugLoop transport registers on internal routes. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Orchestrator has rich substructure**: Contains adapters/, hooks/, providers/, utils/ subdirectories plus factory.ts, cot-adapter.ts, env-builder.ts, harness-builder.ts. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **CoT state machine with heuristics**: Three states (enabled/disabled/undecided); disabled when clarification questions being processed; controlled by ChainOfThoughtFlights feature gates. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **Clarification Questions are one-way**: Grounding content parser receives them from messageAnnotations but no bidirectional protocol; user answers not formally captured. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **AugLoop availability differs by repo**: Available in office-bohemia (@fluidx/augloop v20.28.1) but not in Bebop; test client in OfficeAgent provides reference for new implementations. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **Bebop lacks formal feature gating**: No ECS, flight manager, or feature flag SDK; currently uses env vars, query params, and Jotai atoms; cowork feature gate requires scratch implementation. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

#### Build & Test Results
- **Yarn version mismatch**: office-bohemia uses 4.12, OfficeAgent uses 4.10.3; different TypeScript versions; cannot share cross-repo build artifacts. (Rebecca, Ripley)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **office-bohemia main branch is master**: Important for branch creation and PR targeting (not main). (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **Dallas's lint PR has 13 errors**: W007 introduces 11 new lint errors, 2 pre-existing; if P005/P006 build on those patterns, lint must be clean first. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

#### Bugs & Gotchas
- **Clarification protocol incomplete**: Questions are one-way only; no message types for user responses; full infrastructure needed for interactive flows. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

- **PR overlap risk**: Active PRs (W007, W009) adding initial cowork scaffolding may conflict with planned scaffold task; coordination needed. (Rebecca)
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

#### Action Items
- **Parallel branch strategy required**: Cross-repo work (OfficeAgent + office-bohemia) must use parallel independent branches due to different build systems. (Lambert)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Use mirrored types for cross-repo work**: OfficeAgent message types must be mirrored in office-bohemia to avoid cross-repo build artifact dependencies. (Lambert, Ripley)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

- **Feature gating as priority task**: Feature gate task should ship early (low dependencies) to ensure proper route protection before functional code lands. (Ripley)
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15-w027-prd-creation-.md`

- **Wave 1 supports 6 parallel tasks**: 3 OfficeAgent items (transport, CoT streaming, scaffold) + 3 office-bohemia items can proceed simultaneously. (Ripley)
  → see `knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15-w027-prd-creation-.md`

- **Verify AugLoop dev endpoint before starting**: localhost:11040 requires local AugLoop service; check availability before transport implementation begins. (Lambert)
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-.md`

_Processed 3 notes, 27 insights extracted, 6 duplicates removed._

---

### 2026-03-15: Bebop Cowork Protocol Types, PR-4970115 Review, and Cross-Repo PRD Patterns
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **String union types over enums**: Bebop (Vite 7/esbuild) uses `type Foo = 'a' | 'b'` for zero runtime overhead vs TypeScript enums which compile to IIFEs and cannot be tree-shaken _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Readonly fields for message types**: All protocol message interface fields marked `readonly` to prevent accidental mutation in React/Jotai state and enable reference-equality re-render optimization _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Discriminated union with `kind` field**: CoTStreamEvent uses `kind` as discriminant across event types (step_started, step_completed, tool_use, thinking) for exhaustive switch patterns without type assertions _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Feature types directory pattern**: Bebop features can have `types/` subdirectory for type definitions (e.g., `features/conversations/types/Conversation.ts`) even though not listed in CONTRIBUTING.md _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

- **Client-side simplification in mirrors**: SessionInitPayload omits OfficeAgent's OfficePySettings/McpServers/groundingSourceToggles; FileInfo excludes content/Buffer; ErrorPayload uses `message` instead of `errorMsg` _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Source references in cross-repo mirrors**: Include file paths, line numbers, and "Last synced: <date>" header in mirrored type files to track future drift _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **PRD item sizing for cross-repo work**: small = 1–2 files single concern; medium = 3–5 files single module; large = 6+ files or cross-cutting _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **Dependency ordering for cross-repo features**: Protocol types ship first (zero deps); feature gates ship early; scaffolding depends only on gates; UI/adapters depend on scaffold+types; integration layers last _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

#### PR Review Findings
- **Pattern evolution in readonly fields**: Existing Conversation.ts lacks readonly; new messageProtocol.ts uses it, showing alignment with CLAUDE.md's immutability preference _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

- **Mirrors vs proposed extensions clarity needed**: messageProtocol.ts mixes actual OfficeAgent mirrors (MessageSchema, Message<T>, QueryStatusType, QueryErrorCode, FileInfo, QueryStatusPayload, ErrorPayload) with proposed extensions (cot_stream, ask_user_question, user_answer types; CoTStreamEvent; SessionInitPayload); file header should clarify distinction _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

- **az CLI reviewer vote limitation**: `az repos pr reviewer add --vote 5` is unsupported; must use REST API directly: `PUT /pullRequests/{id}/reviewers/{reviewerId}` with `{ vote: 5 }` body _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

#### Bugs & Gotchas
- **Task scope labeling mismatch**: PR labeled as "Project — OfficeAgent" but code path is `apps/bebop/src/features/cowork/` in office-bohemia; must target `master` branch not `main` _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **ADO MCP tools unavailable fallback**: `mcp__azure-ado__*` tools unavailable; used `az repos pr create` via Azure CLI (requires `azure-devops` extension) _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **office-bohemia main branch is `master` not `main`**: All PRs must target `master`; OfficeAgent uses `main` _(Rebecca, Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **PowerShell required for OfficeAgent**: All yarn/oagent/gulp commands fail in Bash/sh _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **No barrel files in Bebop**: `index.ts` re-exports violate `no-barrel-files` lint rule _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **AugLoop dev endpoint requires local service**: localhost:11040 must be running; verify availability before transport P004 implementation begins _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **SharedTree schema changes are irreversible**: Production schema mutations cannot be undone; design P013 carefully and obtain Fluid team review before merging _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **Existing cowork branches may contain prior work**: OfficeAgent has branches `user/mohitkishore/coworkFeatures`, `user/sacra/cowork-officeagent`, `user/spuranda/cowork-prompt-tuning` in .git/packed-refs; investigate for conflicts or reusable patterns _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **Cowork route does not exist yet**: `_mainLayout.cowork.tsx` missing from `apps/bebop/src/routes/` in current working tree _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

#### Architecture Notes
- **OfficeAgent message protocol structure**: Schema { type, id } → Message<T> { sessionId, payload } → ResponseMessage<T> { requestId } _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **MessageType enum spans 165+ entries**: Covers internal, LLM, enterprise search, Excel, PPT, Word, ODSP, workspace, chat, grounding; includes `workspace_chain_of_thought` as batch/final-state only _(Rebecca, Lambert)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Chain-of-thought notification pattern exists**: ChainOfThoughtContentNotifier interface in `modules/chain-of-thought/src/content-handler.ts` with async `sendChainOfThoughtContent()` method; OfficeAgent CoT is not purely file-based _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **Two CoT payload forms in OfficeAgent**: ChainOfThoughtPayload (simple content string) and PptAgentCotPayload (typed with contentType, turnNumber, toolName) _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **QueryStatus nested discriminated pattern**: QueryStatusPayload.type field selects which optional nested fields are populated _(Rebecca)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **Feature gating infrastructure exists in Loop monorepo**: Multiple packages use `getFluidExperiencesSetting()` with SettingsProvider pattern (conversa, conversa-list, video, video-playback); P005 can follow established pattern _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

- **New message types required for cowork**: `cot_stream`, `ask_user_question`, `user_answer` don't exist in OfficeAgent's MessageType enum; must be added as P001 protocol extension _(Rebecca, Lambert)_
  → see `knowledge/architecture/2026-03-15-rebecca-rebecca-learnings-pl-w017-cowork-mirrored-protocol.md`

- **ADO reviewer vote values**: 10 = approved, 5 = approved with suggestions, 0 = no vote, −5 = waiting for author, −10 = rejected; use REST API PUT endpoint _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

#### Action Items
- **Clarify mirrors vs proposed extensions in messageProtocol.ts header**: Document which type definitions have OfficeAgent counterparts vs which are new extensions _(Ripley)_
  → see `knowledge/reviews/2026-03-15-feedback-review-feedback-for-rebecca.md`

- **Investigate existing OfficeAgent cowork branches**: Check user/mohitkishore/coworkFeatures, user/sacra/cowork-officeagent, user/spuranda/cowork-prompt-tuning for conflicts or reusable patterns before starting P001–P004 _(Lambert)_
  → see `knowledge/build-reports/2026-03-15-lambert-lambert-learnings-2026-03-15-w025-prd-conversion-v.md`

_Processed 4 notes, 25 insights extracted, 5 duplicates removed._

---

### 2026-03-15: Cross-repo PR tracking, mirrored type patterns, and phantom PR detection

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Mirrored types should use string unions over enums**: For Vite/esbuild tree-shaking; `readonly` fields prevent mutation in React/Jotai state. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **Mirrored type header conventions**: Include `// Last synced: YYYY-MM-DD` and per-type `// Source: path/to/file.ts:line` comments; every field name must match wire format exactly. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **Cross-repo PR tracking needs new convention**: `.squad/pull-requests.json` entries tracked under OfficeAgent can point to office-bohemia repo (project OC, repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`, master branch); clarify branch vs PR mapping in tracking. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **Targeted yarn builds avoid Docker requirement**: Use `yarn workspace @officeagent/<pkg> build` instead of `yarn build --to <pkg>`; latter triggers full lage pipeline including Docker image build (~5s vs failure without Docker Desktop). _(Rebecca)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

#### Build & Test Results
- **PR-4970115 code validates**: @officeagent/message-protocol builds successfully (4.79s), @officeagent/core downstream consumer has no breakage (5.64s), 110 tests pass (6.4s), lint clean. _(Rebecca)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md`

- **New MessageType enum values integrate cleanly**: ChainOfThoughtUpdate, AskUserQuestion, UserAnswer added without breaking existing values. _(Rebecca)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md`

#### PR Review Findings
- **ADO REST API for PR thread comments**: Use `POST {org}/{project}/_apis/git/repositories/{repoId}/pullRequests/{prId}/threads?api-version=7.1` with body `{comments:[{parentCommentId:0,content:"...",commentType:1}],status:1}`; use `DefaultCollection` in URL path. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **ADO REST API for reviewer votes**: Use `PUT .../pullRequests/{prId}/reviewers/{reviewerId}?api-version=7.1` with vote body; specific values align with existing convention (10=approve, 5=approve-with-suggestions, −10=reject). _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **az repos pr show requires Visual Studio URL and no project flag**: Use `--org https://office.visualstudio.com/DefaultCollection`; project is inferred from PR ID. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

#### Bugs & Gotchas
- **Phantom PR pattern**: PR-4970115 tracked in `.squad/pull-requests.json` but does not exist on ADO; branch `work/PL-W017` has zero changes and was never pushed. Actual implementation lives in different worktree `feat-PL-W001` (branch `feat/PL-W001-cot-askuser-types`). _(Rebecca, Lambert)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md`

- **Wire format field name mismatches are silent failures**: When mirrored types use different field names than source (e.g., `question` vs `text`, `label` vs `stepLabel`), JSON deserialization produces `undefined` with no runtime error — hardest bugs to find. Always verify field names against source before approving. _(Lambert)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **OfficeAgent CoT types still in-flight**: Chain-of-thought and ask-user-question type definitions in OfficeAgent exist only as uncommitted changes in `feat/PL-W001` worktree; Bebop mirror may have been written against different version or improvised. Both sides must be finalized and synced before either merges. _(Lambert, Rebecca)_
  → see `knowledge/conventions/2026-03-15-lambert-lambert-learnings-2026-03-15.md`

- **python3 unavailable on Windows dev machines**: Microsoft Store stub intercepts the command; use `node -e` for scripting instead. _(Rebecca)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-learnings-2026-03-15.md`

#### Action Items
- **Verify PR existence before dispatching build tasks**: Engine should check `az repos pr show` before queuing build jobs to avoid wasting cycles on phantom PRs. _(Rebecca)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md`

- **Create proper PR or reconcile branches**: Either push `feat/PL-W001-cot-askuser-types` to remote and create PR, or cherry-pick changes onto `work/PL-W017` and push; clarify which is source of truth. _(Rebecca, Lambert)_
  → see `knowledge/build-reports/2026-03-15-rebecca-rebecca-bt-4970115-2026-03-15.md`

_Processed 3 notes, 16 insights extracted, 2 duplicates removed._