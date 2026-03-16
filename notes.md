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

---

### 2026-03-16: Early bail-out pattern for PR review fixes—validated 6-7 times with skill template

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out for PR review fixes**: Check PR thread history for APPROVE verdicts and fix commits via ADO REST API; if all issues resolved, post closed-status thread (status: 4) and exit instead of full review—saves ~15 seconds vs 5–10 minutes for worktree + build + test + lint. _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-7th-dispatc.md`

- **Early bail-out prevents 6–7 redundant reviews**: On PR-4970916, checking thread history for existing APPROVE verdicts and fix commits saved 6–7 redundant review cycles. _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

#### Action Items
- **PR-review-fix-early-bailout skill template**: Provided with ADO token retrieval, PR thread fetch, APPROVE verdict/fix-commit checks, and closed-status thread posting for resolved issues. _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-7th-dispatc.md`

_Processed 3 notes, 3 insights extracted, 4 duplicates removed._

---

### 2026-03-16: Engine dispatch misclassifies implementation notes as review issues; Windows ADO API gotcha identified

**By:** Engine (LLM-consolidated)

#### Bugs & Gotchas
- **Engine dispatch repeatedly re-dispatches resolved PRs**: PR-4970128 received 8+ dispatches despite all review threads APPROVE+closed and commit SHAs unchanged, indicating dispatch logic lacks pre-flight checks for review state. _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

- **Engine misclassifies implementation notes as actionable review issues**: PR-4970128 "review findings" were build/test pass summaries, not code feedback, suggesting consolidation/triage needs to filter technical notes from actual review feedback. _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-nth-.md`

- **ADO curl JSON on Windows bash requires temp file**: Inline JSON with special characters fails; must write to `$TEMP/file.json` and use `-d @"$TEMP/file.json"` due to shell escaping. _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

- **MCP ADO tools may be unavailable**: REST API via curl + Bearer token (`az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`) is reliable fallback. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-nth-.md`

#### Architecture Notes
- **Engine dispatch needs pre-flight checks**: Before queuing review work, check existing reviewer votes via ADO API and compare commit SHAs against previously reviewed state to avoid re-dispatching unchanged code. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-nth-.md`

#### Action Items
- Add commit SHA tracking to `engine/dispatch.json` and implement pre-flight vote/SHA checks in dispatch router before queuing review items.
- Improve `consolidation.js` classification to filter build/test summaries from actionable review findings.

_Processed 3 notes, 5 insights extracted, 4 duplicates removed._

---

### 2026-03-16: Early bail-out patterns and ADO REST API conventions for duplicate PR reviews

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern for duplicate reviews**: Before initiating full worktree creation, check existing reviewer votes and commit SHAs via ADO API; saves ~15 seconds vs 5–10 minutes for build+test+lint cycle _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-8th-dispatc.md`

- **Convention for re-dispatched reviews with no new commits**: Post a closed-status thread (status 4) confirming no action needed and re-submit your approval vote to prevent confusion and rework _(Ripley)_
  → see `knowledge/reviews/2026-03-16-feedback-review-feedback-for-rebecca.md`

- **ADO API hostname requirement**: Always use `dev.azure.com` in REST API calls, not `office.visualstudio.com`, to ensure correct API routing _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

#### Architecture Notes
- **ADO REST API patterns for review pre-flight checks**: Thread closure via status `4` for "no action needed" confirmations; VSID retrieval via `GET /_apis/connectionData?api-version=6.0-preview`; vote submission via `PUT /pullRequests/{id}/reviewers/{vsid}` with `{"vote": 10}` _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

- **Duplicate dispatch problem confirmed on second PR**: PR-4970916 at 8th+ review cycle with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) since first review, reinforcing that engine dispatch router needs pre-flight vote and commit SHA validation _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

_Processed 3 notes, 5 insights extracted, 3 duplicates removed._

---

### 2026-03-16: Chain-of-thought streaming and ask-user protocol architecture; duplicate review dispatch validation gaps
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Windows bash path format**: Use POSIX format `/c/Users/yemishin/.squad` not Windows format `C:\Users\yemishin\.squad` in bash commands _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-review-fix-.md`

#### Architecture Notes
- **Three-tier CoT type system**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming) _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-re-review-d.md`

- **Ask-user protocol direction modeling**: AskUserQuestionMessage = Message<T> (server→client), UserAnswerMessage = ResponseMessage<T> (client→server) _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-re-review-d.md`

- **Compile-time shape tests**: Objects with explicit type annotations catch field renames at compile time _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-re-review-d.md`

_Processed 3 notes, 4 insights extracted, 3 duplicates removed._

---

### 2026-03-16: OfficeAgent PRD milestone and duplicate review dispatch validation gaps remain unresolved

**By:** Engine (LLM-consolidated)

#### Build & Test Results
- **OfficeAgent Cowork feature PRD completed**: 17 items delivered across 14 pull requests, including CoT streaming protocol, ask-user-question bidirectional handler, AugLoop transport adapter, Bebop client integration, collaborative SharedTree schema, and feature gates _(Engine)_
  → see `knowledge/project-notes/2026-03-16-prd-prd-completed-claude-cowork-ux-in-bebop-with-offic.md`

#### Patterns & Conventions
- **Early commit-check bail-out pattern quantified**: Checking commit SHAs via `git log --oneline` (~15s) instead of full review cycle (5-10 min) has saved compute 5+ times on PR-4970916 alone _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

#### Action Items
- **Duplicate dispatch validation remains unimplemented despite recurrence**: PR-4970916 re-dispatched for review #5+ with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`); engine dispatch router must validate existing reviewer votes and unchanged commit SHAs before queuing _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970916-review-dupl.md`

_Processed 3 notes, 3 insights extracted, 1 duplicate removed._

---

### 2026-03-16: Cross-PR merge integration gaps, office-bohemia build conventions, and worktree git operations

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **office-bohemia main branch is `master` not `main`**: Use `git fetch origin ... master` and `git worktree add ... --detach origin/master` when setting up office-bohemia worktrees _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Lage build pipeline uses `transpile` and `typecheck` tasks, not `build`**: Correct command is `yarn lage transpile typecheck --to @bebopjs/bebop`, NOT `yarn build` (returns "no targets found") _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Individual OfficeAgent packages use `yarn workspace` builds to avoid Docker**: Use `yarn workspace @officeagent/<pkg> build` instead of full `yarn build` which requires Docker Desktop _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Vite dev mode bypasses auth-proxy**: Use `yarn dev:no-auth` for local testing without authentication _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **ADO REST API uses dev.azure.com hostname**: Not office.visualstudio.com; write JSON to temp file for curl requests on Windows (e.g., `-d @"$TEMP/file.json"`) _(Ralph)_
  → see `knowledge/build-reports/2026-03-16-ralph-ralph-learnings-2026-03-16-pr-4970916-duplicate-di.md`

#### Build & Test Results
- **OfficeAgent message-protocol clean**: Build passes, 113 tests pass, no lint issues _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **OfficeAgent augloop-transport mostly clean**: Build passes, 11 compiled dist tests pass; source tests have babel `import type` parse error (2 lint warnings on unused vars) _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **OfficeAgent cowork-demo all tests pass**: 49 tests across 4 suites (fixtures, mock-augloop-server, host-environment, mock-token-provider) _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **OfficeAgent core module fails with 4 TS read-only errors**: `tests/websocket/websocket-manager.test.ts` assigns to read-only `readyState` property; fix exists on branch `user/jakubk/excel-agent-cli` but hasn't merged to main _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **office-bohemia Bebop Vite dev server works despite 19 TS errors**: esbuild skips type-checking in dev mode, server serves on port 3002 even with cross-PR type mismatches _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

#### Bugs & Gotchas
- **Cross-PR merge integration produces 19 TypeScript errors in 6 cowork files**: Merging 8 independent office-bohemia PRs creates interface mismatches at integration boundaries; specific conflicts: `streamingBridge.ts` imports renamed `TransportConfig`/`TransportState`/`AugloopTransport` from augloop-annotations PR, `useCoworkStream.ts` references atoms renamed in scaffold PR, `CoworkErrorBoundary.tsx` needs TS 5.9 `override` modifier _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **@types/ws version conflict cascades across OfficeAgent packages**: Root `package.json` and `modules/api/node_modules` have different @types/ws versions, breaking API module build even after core is fixed _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **office-bohemia Jest cannot parse `import.meta.env` in tests**: CJS Jest environment doesn't support Vite-specific APIs; requires Vitest or ESM-compatible transform (affects `featureGates.test.ts`) _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **augloop-transport babel config incomplete for `import type` syntax**: Source `.ts` tests fail with babel SyntaxError; needs `@babel/plugin-syntax-import-assertions` or `@babel/preset-typescript` with `onlyRemoveTypeImports: true` _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Stale local branches point to old commits**: `work/PL-W017` and `user/yemishin/cowork-shared-tree` were never pushed to remote, pointing to v1.1.1130; remove from task setup commands _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Git fetch fails from within existing worktree directory**: `git fetch origin <branch>` fails when run from another worktree context; always fetch from main working tree, not from within `worktrees/` subdirectory _(Ralph)_
  → see `knowledge/build-reports/2026-03-16-ralph-ralph-learnings-2026-03-16-pr-4970916-duplicate-di.md`

#### Architecture Notes
- **Plan integration fix PR when merging 5+ independent branches**: Type errors at integration boundaries are expected; design follow-up PR to resolve cross-PR interface mismatches _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Worktree setup requires 4 merge conflict resolutions across 8+ files**: `coworkAtoms.ts`, `coworkSession.ts`, `CoworkLayout.tsx`, `augloopTransport.ts`, `types.ts`, `just.config.cjs`, `package.json`, `tsconfig.json`, `yarn.lock` have typical conflicts when merging PRs _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Feature gate priority: query param > localStorage > env var**: CoworkLayout route at `/cowork` requires feature gate; respects three-level precedence for access control _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-verify-manual-testing-guide.md`

- **Three-panel cowork layout complete**: Chat panel (left), progression panel (center), artifact panel (right) with tabbed artifact display and download buttons _(Verify)_
  → see `knowledge/build-reports/2026-03-16-verify-manual-testing-guide.md`

#### Action Items
- **Merge core module websocket fix from `user/jakubk/excel-agent-cli`**: 4 read-only property TS errors block API builds; cherry-pick commit `dbb84d949` to main _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Resolve @types/ws version conflict between root and API node_modules**: Align versions to unblock API module build _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Add babel syntax plugin or update preset-typescript for augloop-transport**: Enable source test execution without parse errors _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

- **Create integration fix PR for cross-PR type errors in office-bohemia**: Resolve 19 TS errors in 6 cowork files from 8-PR merge _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-cowo.md`

_Processed 3 notes, 24 insights extracted, 3 duplicates removed._

---

### 2026-03-16: Engine Dispatch Pre-flight Checks and ADO REST API Patterns

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern for unchanged PRs**: Check `git log --oneline main...origin/<branch>` for commit SHAs + ADO REST API for existing threads/votes before creating worktrees (~15 seconds vs 5–10 minutes full cycle) _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-early-bailout-pattern.md`

- **ADO REST API thread management**: Create closed threads with `POST /pullRequests/{prId}/threads?api-version=7.1` + `{"status": 4}`, retrieve VSID via `GET /_apis/connectionData?api-version=6.0-preview`, submit votes with `PUT /pullRequests/{prId}/reviewers/{vsid}?api-version=7.1` + `{"vote": 10}` _(Ripley)_
  → see `knowledge/conventions/2026-03-16-ado-rest-api-patterns.md`

- **Windows bash temp file pattern for JSON payloads**: Write to temp with `$TEMP/filename.json`, reference in curl via `@"$TEMP/filename.json"`; Node.js reads use `process.env.TEMP + '/filename.json'` _(Ripley)_
  → see `knowledge/conventions/2026-03-16-windows-temp-file-pattern.md`

- **ADO domain convention**: Use `dev.azure.com` (not `office.visualstudio.com`) for REST API calls _(Ripley)_
  → see `knowledge/conventions/2026-03-16-ado-domain-convention.md`

#### Bugs & Gotchas
- **Engine dispatch re-queues unchanged PRs**: PR-4970916 dispatched 8+ times and PR-4970128 dispatched 6+ times with zero new commits; existing APPROVE votes ignored _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-engine-dispatch-pre-flight-checks.md`

#### Action Items
- **Engine dispatch router needs three pre-flight checks**: (1) compare branch commit SHAs against last reviewed state via git log, (2) check existing reviewer votes in ADO, (3) classify review findings content for "no action required" keywords before dispatching fix-review tasks _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-engine-dispatch-pre-flight-checks.md`

_Processed 3 notes, 6 insights extracted, 1 duplicate removed._

---

### 2026-03-16: Agent-authored comments misclassified in engine dispatch

**By:** Engine (LLM-consolidated)

#### Bugs & Gotchas
- **Engine feeds agent bail-out notes back as review findings**: Dallas's own "no action needed" consolidation notes from PR-4970916 were misclassified as actionable review findings, triggering 10+ redundant re-dispatches with identical commits _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-8th-dispatc.md`

#### Action Items
- **Engine must filter agent-authored comments from review findings classification**: Consolidation and inbox processing must exclude agent-authored comments (especially bail-out notes) when routing "review findings" to prevent infinite dispatch loops _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-8th-dispatc.md`

_Processed 3 notes, 1 insight extracted, 7 existing patterns reinforced, 1 duplicate consolidated._

---

### 2026-03-16: Cowork UX verification completes with protocol mismatches and useConnectionResilience bug fix
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Worktree reuse before verification re-runs**: Check for existing worktrees and E2E PRs before creating; saves ~10 min of fetch+merge+conflict-resolution time _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-worktree-reuse.md`

- **Verification re-run workflow sequence**: (1) check existing worktrees, (2) check E2E PRs, (3) build individual packages, (4) run per-package tests, (5) start dev server + mock, (6) update testing guide _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-workflow.md`

- **@officeagent-tools/ scope prefix convention**: Tools and devtools packages use `@officeagent-tools/` scope (not `@officeagent/`); e.g., cowork-demo is `@officeagent-tools/cowork-demo` _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-package-naming-scope-prefix.md`

- **Singleton WebSocket demo hook pattern**: useDemoCoworkSession defers session init until user's first message (no auto-fire), dispatches mock server events to Jotai atoms, SSR-safe with `typeof window` guards _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-demo-hook-pattern.md`

#### Build & Test Results
- **173 passing tests across verification suite**: message-protocol 113, cowork-demo 49, augloop-transport 11; TypeScript errors in office-bohemia reduced 19→17 (cross-PR integration improvements) _(Dallas, Verify)_
  → see `knowledge/build-reports/2026-03-16-verify-manual-testing-guide.md`

- **Bebop dev server port varies (3000 vs 3002)**: Always verify actual port after starting; 3000 is default but prior runs with occupied ports may use 3002 _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-bebop-dev-server-port-discovery.md`

#### PR Review Findings
- **Protocol type mismatches between Bebop and OfficeAgent (5 critical/high)**: SessionInit payload (agentId/prompt vs settings), SessionInitResponse (sessionId vs containerInstanceId), FileInfo (fileId vs path), Error (message/code vs errorMsg), CoT events (label/timestamp vs stepLabel/ISO8601/turnNumber) _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-protocol-type-mismatches.md`

- **Feature gate inconsistency**: featureGates.ts uses ECS key `'bebop.cowork.enabled'` but route/localStorage use `'EnableBebopCowork'` query param; completely disconnected _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-feature-gate-inconsistency.md`

- **Test coverage gap for cowork feature**: Only 1 test file for 26 files (~3,578 lines); featureGates test doesn't run (import.meta.env in Jest CJS); cowork-component package has 0 test files _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-test-coverage-gap.md`

#### Bugs & Gotchas
- **useConnectionResilience infinite re-render loop**: Returned new function objects every render, causing dependency array to always see changes. Fix: wrap handler in `useCallback` + `useRef` with empty `[]` deps _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **Yarn workspace command requires full scoped name**: `yarn workspace cowork-demo build` fails; must use `yarn workspace @officeagent-tools/cowork-demo build` _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-yarn-workspace-scoped-names.md`

- **node_modules without .yarn-integrity file still builds**: Integrity check is optional for workspace protocol resolution; no `yarn install` needed _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-yarn-integrity.md`

- **Mock AugLoop server returns 404 on HTTP root**: WebSocket-only endpoint; HTTP GET to `ws://localhost:11040/ws` yields 404 (expected) _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-mock-server-http.md`

- **TanStack Start SSR returns `{"isNotFound":true}` for unauthenticated curl**: Not an error; expected behavior for SSR-rendered unauthenticated requests _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-plan-verification-re-run-tanstack-ssr.md`

- **Must use `yarn dev` (not `yarn dev:no-auth`) for demo**: SSR requires auth proxy; running without it causes failures _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **Vite cache staleness causes module import failures**: Kill server → restart → Ctrl+Shift+R browser after cache changes _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **MSAL tokens expire ~1hr**: Hard-refresh to re-login if testing session runs long _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **Mock server is one-shot per scenario**: Restart after each test run to avoid state pollution _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **Demo WebSocket hook not production code**: Revert to `useCoworkSession` before merging PR _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

#### Architecture Notes
- **AskUserCard component pattern**: Interactive single-select question card with selectable option chips, 150ms auto-submit on click, Skip button, slide-up fade animation, keyboard accessible _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

- **Live progression panel**: Step list with status icons (checkmark/spinner/circle) and detail text matching Fluent design tokens _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-complete-record.md`

#### Action Items
- **Fix 5 protocol type mismatches**: Align SessionInit, SessionInitResponse, FileInfo, Error, and CoT event types between Bebop and OfficeAgent definitions _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-protocol-type-mismatches.md`

- **Resolve feature gate ECS key vs query param disconnect**: Unify `'bebop.cowork.enabled'` (featureGates.ts) with `'EnableBebopCowork'` (route/localStorage) _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-feature-gate-inconsistency.md`

- **Add comprehensive test coverage for cowork feature**: Create test files for 26 cowork files (currently 1 test file); fix featureGates test to run in Jest; add cowork-component test suite _(Verify)_
  → see `knowledge/project-notes/2026-03-16-verify-cowork-ux-testing-session-test-coverage-gap.md`

_Processed 3 notes, 28 insights extracted, 4 duplicates removed._

---

### 2026-03-16: Early bail-out pattern prevents PR-4970128 dispatch loop; ADO REST API Windows workarounds confirmed

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Engine dispatch loop misclassifies bail-out notes as actionable feedback**: PR-4970128 dispatched 20+ times with identical commits; consolidation treats implementation summaries as code review findings _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

- **Early bail-out pattern effective for already-approved PRs**: Pre-flight checks (~15s) eliminate 5-10 min full review cycles on unchanged dispatches _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **ADO REST API on Windows requires temp file workaround**: `/dev/stdin` doesn't work with Node.js piped input; use `curl -o "$TEMP/file.json"` then `readFileSync(process.env.TEMP+'/file.json')` _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

#### Build & Test Results
- **PR-4970128 build passing**: 110 tests passed, 3 E2E pipelines succeeded, Yemi Shin approved (vote 10) with all review feedback addressed _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

#### PR Review Findings
- **PR-4970128 clean and well-structured**: 3 commits, 5 files, 407 insertions in `modules/message-protocol/` with 164 compile-time shape tests catching field renames _(Ripley)_
  → see `knowledge/reviews/2026-03-16-feedback-review-feedback-for-dallas.md`

#### Architecture Notes
- **Directionality correctly modeled in message protocol**: `Message<T>` for server→client, `ResponseMessage<T>` for client→server in new CoT and AskUserQuestion types _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **sequenceNumber documented as session-scoped but uses module-level counter**: `cot-stream-handler.ts` implementation will interleave across concurrent sessions _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **stepId required on CoTStepStartedEvent but optional on CoTStepCompletedEvent**: Backward compatibility design; consumers must handle missing `stepId` on completion events _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

#### ADO REST API Reference
- **Thread closure**: `POST /pullRequests/{id}/threads?api-version=7.1` with `{"status": 4}` _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **VSID lookup**: `GET /_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **Vote submission**: `PUT /pullRequests/{id}/reviewers/{vsid}?api-version=7.1` with `{"vote": 10}` _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

- **Always use dev.azure.com hostname**: Not `office.visualstudio.com` for ADO REST API calls _(Ripley)_
  → see `knowledge/architecture/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970128-review-.md`

#### Action Items
- **Implement early bail-out check for already-approved PRs**: Detect unchanged commits with existing APPROVE verdicts to prevent re-queuing PR-4970128 and similar cases _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970128-fix-review-.md`

_Processed 3 notes, 13 insights extracted, 1 duplicate removed._

---

### 2026-03-16: Engine Consolidation Loop Causing Duplicate PR Dispatches (PR-4970916)
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern saves 5-10 minutes**: Pre-flight check for unchanged commits + existing approvals (~15 seconds) vs full worktree + build + test + lint cycle (5-10 minutes). Apply when PR commits unchanged and already has 10+ approvals. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **Windows /dev/stdin workaround**: Node.js `readFileSync('/dev/stdin')` fails with ENOENT on Windows; use temp files (`$TEMP/file.json`) for curl output processing instead. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-lambert-lambert-learnings-2026-03-16-pr-4970916-duplicate-.md`

#### Bugs & Gotchas
- **Engine consolidation creates infinite dispatch loop**: Consolidation pipeline misclassifies agent-authored bail-out comments ("No Action Required", "early bail-out", "Duplicate Dispatch") as actionable review findings, causing Nth+ duplicate dispatches. Observed 40+ threads on PR-4970916 with 10+ APPROVE verdicts but continuous re-dispatch. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **MCP ADO tools unavailable**: No `mcp__azure-ado__*` tools in environment; REST API via curl + Bearer token (`az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`) is the only working path. _(Lambert)_
  → see `knowledge/build-reports/2026-03-16-lambert-lambert-learnings-2026-03-16-pr-4970916-duplicate-.md`

#### Action Items
- **Engine must filter agent-authored comments in consolidation**: Detect keywords "No Action Required", "early bail-out", "Duplicate Dispatch" in review findings thread content and skip dispatch to prevent infinite loops. _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

_Processed 3 notes, 5 insights extracted, 2 duplicates removed._

---

### 2026-03-16: Dallas, Ripley, Verify: bug findings, codebase exploration (65 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (17)
- **message-protocol**: 113 tests PASS, 3.71s build (source: `modules/message-protocol/`) _(dallas)_
- **cowork-demo**: 49 tests PASS across 4 suites (source: `.devtools/cowork-demo/`) _(dallas)_
- **office-bohemia Bebop typecheck**: 17 TS errors in 5 files — cross-PR integration boundaries (source: `apps/bebop/src/features/cowork/`) _(dallas)_
- **PowerShell required for yarn commands**: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"` pattern _(dallas)_
- **Use `@officeagent-tools/` scope for devtools**: Not `@officeagent/` — e.g., `@officeagent-tools/cowork-demo` _(dallas)_
- - `yarn workspace` with just package name (no scope) fails silently — must use full scoped name _(dallas)_
- - office-bohemia `yarn lage` must run from monorepo root, not from `apps/bebop/` _(dallas)_
- **PR-4972662**: (OfficeAgent): https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4972662 _(verify)_
- **PR-4972663**: (office-bohemia): https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663 _(verify)_
- 1. Handler registers in WebSocket router following 14-handler pattern _(verify)_
- **Feature gate cascade**: Query param `EnableBebopCowork=true` → localStorage persistence → route access control. _(verify)_
- **Dual feature gate disconnect**: `featureGates.ts` uses ECS key `bebop.cowork.enabled` vs route-level `EnableBebopCowork` query param _(verify)_
- **Demo WebSocket hook is NOT production code**: hardcoded `ws://localhost:11040`, must revert before merge _(verify)_
- **Start servers**: Run restart commands above (Bebop dev server + mock AugLoop server) _(verify)_
- **Open feature-gated page**: Navigate to http://localhost:3000/cowork?EnableBebopCowork=true _(verify)_
- **Verify three-panel layout**: Chat panel (left), progression panel (center), artifact panel (right) _(verify)_
- **Send a message**: Type in chat input, press Enter → observe CoT streaming in progression panel, ask-user card in chat _(verify)_

#### Codebase Exploration (48)
- **@officeagent/core**: — Agent management, logging (PII-safe), WebSocket management, utilities (source: `modules/core/src/index.ts`) _(ripley)_
- **@officeagent/api**: — HTTP routes, WebSocket handlers (14+), handler registry, agent registration (source: `modules/api/src/index.ts`) _(ripley)_
- **@officeagent/message-protocol**: — 160+ message types, JSON-RPC 2.0 types, WebSocket contract (source: `modules/message-protocol/src/types/message-type.ts`) _(ripley)_
- **@officeagent/orchestrator**: — Provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` (source: `modules/orchestrator/src/types.ts:23-62`) _(ripley)_
- **@officeagent/html2pptx**: — HTML to PPTX conversion _(ripley)_
- **@officeagent/json-to-docx-ooxml**: — JSON to DOCX conversion _(ripley)_
- **@officeagent/pptx-assets**: — PowerPoint asset management _(ripley)_
- **@officeagent/verify-slide-html**: — Slide HTML validation _(ripley)_
- **@officeagent/excel-headless**: — Headless Excel execution _(ripley)_
- **@officeagent/excel-parser**: — Excel file parsing _(ripley)_
- **@officeagent/chain-of-thought**: — CoT tracking, file-based persistence, message processing (source: `modules/chain-of-thought/src/index.ts`) _(ripley)_
- **@officeagent/grounding**: — 4-stage pipeline: Preprocessor → Retriever → Postprocessor → Storage (source: `modules/grounding/`) _(ripley)_
- **@officeagent/rai**: — Responsible AI validation _(ripley)_
- **@officeagent/gpt-agent**: — GPT agent abstraction _(ripley)_
- **@officeagent/mcp-proxy**: — MCP (Model Context Protocol) proxy _(ripley)_
- **@officeagent/git-remote-spo**: — SharePoint git remote _(ripley)_
- **Registry-First Design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. (source: `agents/create-agent/src/registry.ts:1-623`) _(ripley)_
- **Handler Registry**: `HandlerRegistry` in API module maps message types to handlers, supporting regular and SSE streaming responses. (source: `modules/api/src/internal/registry/handler-registry.ts:91-180+`) _(ripley)_
- **Versioned Prompts**: Prompts under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. (source: `agents/create-agent/src/prompts/`) _(ripley)_
- **Flight System**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. (source: `agents/create-agent/src/registry.ts` — 21 flight configs) _(ripley)_
- **Hook System**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn). (source: `modules/core/src/agent/`) _(ripley)_
- **Provider-Agnostic CoT**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), works with any provider. (source: `modules/chain-of-thought/src/types.ts:31-45`) _(ripley)_
- **poppler-builder**: PDF processing _(ripley)_
- **libreoffice-installer**: Document conversion _(ripley)_
- **node-deps**: Runtime npm packages (separate from yarn workspace) _(ripley)_
- **final**: Node 24 + all tooling _(ripley)_
- **Logging**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry). `logDebug` is local-only, OK for user data. No `console.*` in production. (source: `CLAUDE.md:59-63`) _(ripley)_
- **PowerShell required**: All yarn/oagent/gulp commands must run in PowerShell. Bash fails. (source: `CLAUDE.md:7`) _(ripley)_
- **Package scope**: `@officeagent/` for library modules, `@officeagent-tools/` for devtools (source: `package.json` workspaces) _(ripley)_
- **Testing**: Jest with ts-jest for TypeScript (`**/tests/**/*.test.ts`), pytest for Python (`tests/test_*.py`). Coverage CI-only. (source: `CLAUDE.md:39-41`, `jest.config.js`, `pytest.ini`) _(ripley)_
- **Version**: All packages at `1.1.1130` (source: all `package.json` files) _(ripley)_
- **Lage tasks**: build → depends on ^build (upstream deps), plus lint, test, clean _(ripley)_
- **Individual package builds**: `yarn workspace @officeagent/<pkg> build` (avoids Docker requirement) _(ripley)_
- **Hot reload**: `yarn reload` copies built code into running container _(ripley)_
- **Anthropic Claude SDK**: `@anthropic-ai/claude-agent-sdk` (primary LLM) _(ripley)_
- **GitHub Copilot SDK**: `@github/copilot-sdk` (alternative LLM) _(ripley)_
- **Office document**: pptxgenjs, docx, openpyxl, chart.js _(ripley)_
- **PDF processing**: poppler (vendored), LibreOffice _(ripley)_
- **Runtime**: Express, ws (WebSocket), jszip, uuid, sharp _(ripley)_
- **CLAUDE.md missing for 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent lack documentation. (source: verified by checking all 14 `agents/*/CLAUDE.md`) _(ripley)_
- **README outdated**: Root README.md lists 7 agents but repo has 15. (source: `README.md` vs actual `agents/` directory listing) _(ripley)_
- **CoT is file-based only**: `trackChainOfThought()` writes to disk. No WebSocket streaming to clients exists in production code. New CoT streaming types were added in PR-4970128 but not yet wired. (source: `modules/chain-of-thought/src/manager.ts`, knowledge base PR reviews) _(ripley)_
- **AugLoop integration is test-only**: AugLoop endpoints exist only in `.devtools/test-client`, not in production modules. (source: `.devtools/test-client/`) _(ripley)_
- **Cross-repo type drift**: Bebop (office-bohemia) mirrors of OfficeAgent types have 5 critical field mismatches (SessionInit, FileInfo, Error payloads). (source: knowledge base — PR-4972663 review findings) _(ripley)_
- **Add CLAUDE.md to remaining 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent need basic documentation for onboarding. Low effort, high value. _(ripley)_
- **Update README.md**: Root README lists 7 agents but 15 exist. Add the missing 8 agents with descriptions. _(ripley)_
- **Wire CoT streaming to WebSocket**: The type definitions exist (PR-4970128 merged ChainOfThoughtUpdatePayload). Next step: implement a WebSocket handler that bridges `ChainOfThoughtContentNotifier` to the client protocol. _(ripley)_
- **Reconcile cross-repo protocol types**: Bebop's mirrored types must align with OfficeAgent's wire format before the cowork feature can ship. _(ripley)_

_Deduplication: 11 duplicate(s) removed._


---

### 2026-03-16: Dallas, Ripley, Verify: bug findings, codebase exploration (55 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (13)
- **message-protocol**: 113 tests PASS, 3.71s build (source: `modules/message-protocol/`) _(dallas)_
- **cowork-demo**: 49 tests PASS across 4 suites (source: `.devtools/cowork-demo/`) _(dallas)_
- **office-bohemia Bebop typecheck**: 17 TS errors in 5 files — cross-PR integration boundaries (source: `apps/bebop/src/features/cowork/`) _(dallas)_
- **PowerShell required for yarn commands**: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"` pattern _(dallas)_
- **Use `@officeagent-tools/` scope for devtools**: Not `@officeagent/` — e.g., `@officeagent-tools/cowork-demo` _(dallas)_
- - office-bohemia `yarn lage` must run from monorepo root, not from `apps/bebop/` _(dallas)_
- **PR-4972662**: (OfficeAgent): https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4972662 _(verify)_
- **PR-4972663**: (office-bohemia): https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663 _(verify)_
- **Feature gate cascade**: Query param `EnableBebopCowork=true` → localStorage persistence → route access control. _(verify)_
- **Dual feature gate disconnect**: `featureGates.ts` uses ECS key `bebop.cowork.enabled` vs route-level `EnableBebopCowork` query param _(verify)_
- **Demo WebSocket hook is NOT production code**: hardcoded `ws://localhost:11040`, must revert before merge _(verify)_
- **Open feature-gated page**: Navigate to http://localhost:3000/cowork?EnableBebopCowork=true _(verify)_
- **Verify three-panel layout**: Chat panel (left), progression panel (center), artifact panel (right) _(verify)_

#### Codebase Exploration (42)
- **@officeagent/core**: — Agent management, logging (PII-safe), WebSocket management, utilities (source: `modules/core/src/index.ts`) _(ripley)_
- **@officeagent/api**: — HTTP routes, WebSocket handlers (14+), handler registry, agent registration (source: `modules/api/src/index.ts`) _(ripley)_
- **@officeagent/message-protocol**: — 160+ message types, JSON-RPC 2.0 types, WebSocket contract (source: `modules/message-protocol/src/types/message-type.ts`) _(ripley)_
- **@officeagent/orchestrator**: — Provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` (source: `modules/orchestrator/src/types.ts:23-62`) _(ripley)_
- **@officeagent/html2pptx**: — HTML to PPTX conversion _(ripley)_
- **@officeagent/json-to-docx-ooxml**: — JSON to DOCX conversion _(ripley)_
- **@officeagent/pptx-assets**: — PowerPoint asset management _(ripley)_
- **@officeagent/verify-slide-html**: — Slide HTML validation _(ripley)_
- **@officeagent/excel-headless**: — Headless Excel execution _(ripley)_
- **@officeagent/excel-parser**: — Excel file parsing _(ripley)_
- **@officeagent/chain-of-thought**: — CoT tracking, file-based persistence, message processing (source: `modules/chain-of-thought/src/index.ts`) _(ripley)_
- **@officeagent/grounding**: — 4-stage pipeline: Preprocessor → Retriever → Postprocessor → Storage (source: `modules/grounding/`) _(ripley)_
- **@officeagent/rai**: — Responsible AI validation _(ripley)_
- **@officeagent/gpt-agent**: — GPT agent abstraction _(ripley)_
- **@officeagent/mcp-proxy**: — MCP (Model Context Protocol) proxy _(ripley)_
- **@officeagent/git-remote-spo**: — SharePoint git remote _(ripley)_
- **Registry-First Design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. (source: `agents/create-agent/src/registry.ts:1-623`) _(ripley)_
- **Versioned Prompts**: Prompts under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. (source: `agents/create-agent/src/prompts/`) _(ripley)_
- **Flight System**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. (source: `agents/create-agent/src/registry.ts` — 21 flight configs) _(ripley)_
- **Hook System**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn). (source: `modules/core/src/agent/`) _(ripley)_
- **Provider-Agnostic CoT**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), works with any provider. (source: `modules/chain-of-thought/src/types.ts:31-45`) _(ripley)_
- **poppler-builder**: PDF processing _(ripley)_
- **libreoffice-installer**: Document conversion _(ripley)_
- **node-deps**: Runtime npm packages (separate from yarn workspace) _(ripley)_
- **final**: Node 24 + all tooling _(ripley)_
- **Logging**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry). `logDebug` is local-only, OK for user data. No `console.*` in production. (source: `CLAUDE.md:59-63`) _(ripley)_
- **PowerShell required**: All yarn/oagent/gulp commands must run in PowerShell. Bash fails. (source: `CLAUDE.md:7`) _(ripley)_
- **Testing**: Jest with ts-jest for TypeScript (`**/tests/**/*.test.ts`), pytest for Python (`tests/test_*.py`). Coverage CI-only. (source: `CLAUDE.md:39-41`, `jest.config.js`, `pytest.ini`) _(ripley)_
- **Version**: All packages at `1.1.1130` (source: all `package.json` files) _(ripley)_
- **Individual package builds**: `yarn workspace @officeagent/<pkg> build` (avoids Docker requirement) _(ripley)_
- **Anthropic Claude SDK**: `@anthropic-ai/claude-agent-sdk` (primary LLM) _(ripley)_
- **GitHub Copilot SDK**: `@github/copilot-sdk` (alternative LLM) _(ripley)_
- **Office document**: pptxgenjs, docx, openpyxl, chart.js _(ripley)_
- **CLAUDE.md missing for 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent lack documentation. (source: verified by checking all 14 `agents/*/CLAUDE.md`) _(ripley)_
- **README outdated**: Root README.md lists 7 agents but repo has 15. (source: `README.md` vs actual `agents/` directory listing) _(ripley)_
- **CoT is file-based only**: `trackChainOfThought()` writes to disk. No WebSocket streaming to clients exists in production code. New CoT streaming types were added in PR-4970128 but not yet wired. (source: `modules/chain-of-thought/src/manager.ts`, knowledge base PR reviews) _(ripley)_
- **AugLoop integration is test-only**: AugLoop endpoints exist only in `.devtools/test-client`, not in production modules. (source: `.devtools/test-client/`) _(ripley)_
- **Cross-repo type drift**: Bebop (office-bohemia) mirrors of OfficeAgent types have 5 critical field mismatches (SessionInit, FileInfo, Error payloads). (source: knowledge base — PR-4972663 review findings) _(ripley)_
- **Add CLAUDE.md to remaining 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent need basic documentation for onboarding. Low effort, high value. _(ripley)_
- **Update README.md**: Root README lists 7 agents but 15 exist. Add the missing 8 agents with descriptions. _(ripley)_
- **Wire CoT streaming to WebSocket**: The type definitions exist (PR-4970128 merged ChainOfThoughtUpdatePayload). Next step: implement a WebSocket handler that bridges `ChainOfThoughtContentNotifier` to the client protocol. _(ripley)_
- **Reconcile cross-repo protocol types**: Bebop's mirrored types must align with OfficeAgent's wire format before the cowork feature can ship. _(ripley)_

_Deduplication: 21 duplicate(s) removed._


---

### 2026-03-16: Dallas, Ripley, Verify: bug findings, codebase exploration (55 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (13)
- **message-protocol**: 113 tests PASS, 3.71s build (source: `modules/message-protocol/`) _(dallas)_
- **cowork-demo**: 49 tests PASS across 4 suites (source: `.devtools/cowork-demo/`) _(dallas)_
- **office-bohemia Bebop typecheck**: 17 TS errors in 5 files — cross-PR integration boundaries (source: `apps/bebop/src/features/cowork/`) _(dallas)_
- **PowerShell required for yarn commands**: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"` pattern _(dallas)_
- **Use `@officeagent-tools/` scope for devtools**: Not `@officeagent/` — e.g., `@officeagent-tools/cowork-demo` _(dallas)_
- - office-bohemia `yarn lage` must run from monorepo root, not from `apps/bebop/` _(dallas)_
- **PR-4972662**: (OfficeAgent): https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4972662 _(verify)_
- **PR-4972663**: (office-bohemia): https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663 _(verify)_
- **Feature gate cascade**: Query param `EnableBebopCowork=true` → localStorage persistence → route access control. _(verify)_
- **Dual feature gate disconnect**: `featureGates.ts` uses ECS key `bebop.cowork.enabled` vs route-level `EnableBebopCowork` query param _(verify)_
- **Demo WebSocket hook is NOT production code**: hardcoded `ws://localhost:11040`, must revert before merge _(verify)_
- **Open feature-gated page**: Navigate to http://localhost:3000/cowork?EnableBebopCowork=true _(verify)_
- **Verify three-panel layout**: Chat panel (left), progression panel (center), artifact panel (right) _(verify)_

#### Codebase Exploration (42)
- **@officeagent/core**: — Agent management, logging (PII-safe), WebSocket management, utilities (source: `modules/core/src/index.ts`) _(ripley)_
- **@officeagent/api**: — HTTP routes, WebSocket handlers (14+), handler registry, agent registration (source: `modules/api/src/index.ts`) _(ripley)_
- **@officeagent/message-protocol**: — 160+ message types, JSON-RPC 2.0 types, WebSocket contract (source: `modules/message-protocol/src/types/message-type.ts`) _(ripley)_
- **@officeagent/orchestrator**: — Provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` (source: `modules/orchestrator/src/types.ts:23-62`) _(ripley)_
- **@officeagent/html2pptx**: — HTML to PPTX conversion _(ripley)_
- **@officeagent/json-to-docx-ooxml**: — JSON to DOCX conversion _(ripley)_
- **@officeagent/pptx-assets**: — PowerPoint asset management _(ripley)_
- **@officeagent/verify-slide-html**: — Slide HTML validation _(ripley)_
- **@officeagent/excel-headless**: — Headless Excel execution _(ripley)_
- **@officeagent/excel-parser**: — Excel file parsing _(ripley)_
- **@officeagent/chain-of-thought**: — CoT tracking, file-based persistence, message processing (source: `modules/chain-of-thought/src/index.ts`) _(ripley)_
- **@officeagent/grounding**: — 4-stage pipeline: Preprocessor → Retriever → Postprocessor → Storage (source: `modules/grounding/`) _(ripley)_
- **@officeagent/rai**: — Responsible AI validation _(ripley)_
- **@officeagent/gpt-agent**: — GPT agent abstraction _(ripley)_
- **@officeagent/mcp-proxy**: — MCP (Model Context Protocol) proxy _(ripley)_
- **@officeagent/git-remote-spo**: — SharePoint git remote _(ripley)_
- **Registry-First Design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. (source: `agents/create-agent/src/registry.ts:1-623`) _(ripley)_
- **Versioned Prompts**: Prompts under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. (source: `agents/create-agent/src/prompts/`) _(ripley)_
- **Flight System**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. (source: `agents/create-agent/src/registry.ts` — 21 flight configs) _(ripley)_
- **Hook System**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn). (source: `modules/core/src/agent/`) _(ripley)_
- **Provider-Agnostic CoT**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), works with any provider. (source: `modules/chain-of-thought/src/types.ts:31-45`) _(ripley)_
- **poppler-builder**: PDF processing _(ripley)_
- **libreoffice-installer**: Document conversion _(ripley)_
- **node-deps**: Runtime npm packages (separate from yarn workspace) _(ripley)_
- **final**: Node 24 + all tooling _(ripley)_
- **Logging**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry). `logDebug` is local-only, OK for user data. No `console.*` in production. (source: `CLAUDE.md:59-63`) _(ripley)_
- **PowerShell required**: All yarn/oagent/gulp commands must run in PowerShell. Bash fails. (source: `CLAUDE.md:7`) _(ripley)_
- **Testing**: Jest with ts-jest for TypeScript (`**/tests/**/*.test.ts`), pytest for Python (`tests/test_*.py`). Coverage CI-only. (source: `CLAUDE.md:39-41`, `jest.config.js`, `pytest.ini`) _(ripley)_
- **Version**: All packages at `1.1.1130` (source: all `package.json` files) _(ripley)_
- **Individual package builds**: `yarn workspace @officeagent/<pkg> build` (avoids Docker requirement) _(ripley)_
- **Anthropic Claude SDK**: `@anthropic-ai/claude-agent-sdk` (primary LLM) _(ripley)_
- **GitHub Copilot SDK**: `@github/copilot-sdk` (alternative LLM) _(ripley)_
- **Office document**: pptxgenjs, docx, openpyxl, chart.js _(ripley)_
- **CLAUDE.md missing for 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent lack documentation. (source: verified by checking all 14 `agents/*/CLAUDE.md`) _(ripley)_
- **README outdated**: Root README.md lists 7 agents but repo has 15. (source: `README.md` vs actual `agents/` directory listing) _(ripley)_
- **CoT is file-based only**: `trackChainOfThought()` writes to disk. No WebSocket streaming to clients exists in production code. New CoT streaming types were added in PR-4970128 but not yet wired. (source: `modules/chain-of-thought/src/manager.ts`, knowledge base PR reviews) _(ripley)_
- **AugLoop integration is test-only**: AugLoop endpoints exist only in `.devtools/test-client`, not in production modules. (source: `.devtools/test-client/`) _(ripley)_
- **Cross-repo type drift**: Bebop (office-bohemia) mirrors of OfficeAgent types have 5 critical field mismatches (SessionInit, FileInfo, Error payloads). (source: knowledge base — PR-4972663 review findings) _(ripley)_
- **Add CLAUDE.md to remaining 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent need basic documentation for onboarding. Low effort, high value. _(ripley)_
- **Update README.md**: Root README lists 7 agents but 15 exist. Add the missing 8 agents with descriptions. _(ripley)_
- **Wire CoT streaming to WebSocket**: The type definitions exist (PR-4970128 merged ChainOfThoughtUpdatePayload). Next step: implement a WebSocket handler that bridges `ChainOfThoughtContentNotifier` to the client protocol. _(ripley)_
- **Reconcile cross-repo protocol types**: Bebop's mirrored types must align with OfficeAgent's wire format before the cowork feature can ship. _(ripley)_

_Deduplication: 21 duplicate(s) removed._


---

### 2026-03-16: Dallas, Ripley, Verify: bug findings, codebase exploration (55 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (13)
- **message-protocol**: 113 tests PASS, 3.71s build (source: `modules/message-protocol/`) _(dallas)_
- **cowork-demo**: 49 tests PASS across 4 suites (source: `.devtools/cowork-demo/`) _(dallas)_
- **office-bohemia Bebop typecheck**: 17 TS errors in 5 files — cross-PR integration boundaries (source: `apps/bebop/src/features/cowork/`) _(dallas)_
- **PowerShell required for yarn commands**: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"` pattern _(dallas)_
- **Use `@officeagent-tools/` scope for devtools**: Not `@officeagent/` — e.g., `@officeagent-tools/cowork-demo` _(dallas)_
- - office-bohemia `yarn lage` must run from monorepo root, not from `apps/bebop/` _(dallas)_
- **PR-4972662**: (OfficeAgent): https://office.visualstudio.com/DefaultCollection/ISS/_git/OfficeAgent/pullrequest/4972662 _(verify)_
- **PR-4972663**: (office-bohemia): https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663 _(verify)_
- **Feature gate cascade**: Query param `EnableBebopCowork=true` → localStorage persistence → route access control. _(verify)_
- **Dual feature gate disconnect**: `featureGates.ts` uses ECS key `bebop.cowork.enabled` vs route-level `EnableBebopCowork` query param _(verify)_
- **Demo WebSocket hook is NOT production code**: hardcoded `ws://localhost:11040`, must revert before merge _(verify)_
- **Open feature-gated page**: Navigate to http://localhost:3000/cowork?EnableBebopCowork=true _(verify)_
- **Verify three-panel layout**: Chat panel (left), progression panel (center), artifact panel (right) _(verify)_

#### Codebase Exploration (42)
- **@officeagent/core**: — Agent management, logging (PII-safe), WebSocket management, utilities (source: `modules/core/src/index.ts`) _(ripley)_
- **@officeagent/api**: — HTTP routes, WebSocket handlers (14+), handler registry, agent registration (source: `modules/api/src/index.ts`) _(ripley)_
- **@officeagent/message-protocol**: — 160+ message types, JSON-RPC 2.0 types, WebSocket contract (source: `modules/message-protocol/src/types/message-type.ts`) _(ripley)_
- **@officeagent/orchestrator**: — Provider-agnostic `IOrchestrator` interface with `ClaudeOrchestrator` and `GhcpOrchestrator` (source: `modules/orchestrator/src/types.ts:23-62`) _(ripley)_
- **@officeagent/html2pptx**: — HTML to PPTX conversion _(ripley)_
- **@officeagent/json-to-docx-ooxml**: — JSON to DOCX conversion _(ripley)_
- **@officeagent/pptx-assets**: — PowerPoint asset management _(ripley)_
- **@officeagent/verify-slide-html**: — Slide HTML validation _(ripley)_
- **@officeagent/excel-headless**: — Headless Excel execution _(ripley)_
- **@officeagent/excel-parser**: — Excel file parsing _(ripley)_
- **@officeagent/chain-of-thought**: — CoT tracking, file-based persistence, message processing (source: `modules/chain-of-thought/src/index.ts`) _(ripley)_
- **@officeagent/grounding**: — 4-stage pipeline: Preprocessor → Retriever → Postprocessor → Storage (source: `modules/grounding/`) _(ripley)_
- **@officeagent/rai**: — Responsible AI validation _(ripley)_
- **@officeagent/gpt-agent**: — GPT agent abstraction _(ripley)_
- **@officeagent/mcp-proxy**: — MCP (Model Context Protocol) proxy _(ripley)_
- **@officeagent/git-remote-spo**: — SharePoint git remote _(ripley)_
- **Registry-First Design**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. (source: `agents/create-agent/src/registry.ts:1-623`) _(ripley)_
- **Versioned Prompts**: Prompts under `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. (source: `agents/create-agent/src/prompts/`) _(ripley)_
- **Flight System**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. (source: `agents/create-agent/src/registry.ts` — 21 flight configs) _(ripley)_
- **Hook System**: `HookRegistry` with per-agent-type providers (PreToolUse, PostToolUse, SessionStart, SessionEnd, startTurn). (source: `modules/core/src/agent/`) _(ripley)_
- **Provider-Agnostic CoT**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), works with any provider. (source: `modules/chain-of-thought/src/types.ts:31-45`) _(ripley)_
- **poppler-builder**: PDF processing _(ripley)_
- **libreoffice-installer**: Document conversion _(ripley)_
- **node-deps**: Runtime npm packages (separate from yarn workspace) _(ripley)_
- **final**: Node 24 + all tooling _(ripley)_
- **Logging**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry). `logDebug` is local-only, OK for user data. No `console.*` in production. (source: `CLAUDE.md:59-63`) _(ripley)_
- **PowerShell required**: All yarn/oagent/gulp commands must run in PowerShell. Bash fails. (source: `CLAUDE.md:7`) _(ripley)_
- **Testing**: Jest with ts-jest for TypeScript (`**/tests/**/*.test.ts`), pytest for Python (`tests/test_*.py`). Coverage CI-only. (source: `CLAUDE.md:39-41`, `jest.config.js`, `pytest.ini`) _(ripley)_
- **Version**: All packages at `1.1.1130` (source: all `package.json` files) _(ripley)_
- **Individual package builds**: `yarn workspace @officeagent/<pkg> build` (avoids Docker requirement) _(ripley)_
- **Anthropic Claude SDK**: `@anthropic-ai/claude-agent-sdk` (primary LLM) _(ripley)_
- **GitHub Copilot SDK**: `@github/copilot-sdk` (alternative LLM) _(ripley)_
- **Office document**: pptxgenjs, docx, openpyxl, chart.js _(ripley)_
- **CLAUDE.md missing for 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent lack documentation. (source: verified by checking all 14 `agents/*/CLAUDE.md`) _(ripley)_
- **README outdated**: Root README.md lists 7 agents but repo has 15. (source: `README.md` vs actual `agents/` directory listing) _(ripley)_
- **CoT is file-based only**: `trackChainOfThought()` writes to disk. No WebSocket streaming to clients exists in production code. New CoT streaming types were added in PR-4970128 but not yet wired. (source: `modules/chain-of-thought/src/manager.ts`, knowledge base PR reviews) _(ripley)_
- **AugLoop integration is test-only**: AugLoop endpoints exist only in `.devtools/test-client`, not in production modules. (source: `.devtools/test-client/`) _(ripley)_
- **Cross-repo type drift**: Bebop (office-bohemia) mirrors of OfficeAgent types have 5 critical field mismatches (SessionInit, FileInfo, Error payloads). (source: knowledge base — PR-4972663 review findings) _(ripley)_
- **Add CLAUDE.md to remaining 4 agents**: dw-marketer-agent, excel-js-runner-agent, grounding-agent, ppt-agent need basic documentation for onboarding. Low effort, high value. _(ripley)_
- **Update README.md**: Root README lists 7 agents but 15 exist. Add the missing 8 agents with descriptions. _(ripley)_
- **Wire CoT streaming to WebSocket**: The type definitions exist (PR-4970128 merged ChainOfThoughtUpdatePayload). Next step: implement a WebSocket handler that bridges `ChainOfThoughtContentNotifier` to the client protocol. _(ripley)_
- **Reconcile cross-repo protocol types**: Bebop's mirrored types must align with OfficeAgent's wire format before the cowork feature can ship. _(ripley)_

_Deduplication: 21 duplicate(s) removed._


---

### 2026-03-16: OfficeAgent Plan Verification & Codebase Architecture
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Worktree reuse saves significant time**: Pre-existing worktrees skip 10+ minutes of fetch/merge/conflict-resolution. Always check `git worktree list` before creating new ones. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **PowerShell required for yarn commands**: All yarn/oagent/gulp commands fail in Bash; must use PowerShell. Pattern: `powershell.exe -Command "yarn workspace @officeagent/<pkg> build"`. _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Use correct package scope for devtools**: `@officeagent-tools/` for devtools (not `@officeagent/`); e.g., `@officeagent-tools/cowork-demo`. _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Vite dev mode works despite TS errors**: esbuild skips type-checking, so dev server runs even with 17+ TS errors; dev/test workflows unaffected by typecheck failures. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Registry-first design pattern**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` with identity, versions, tools, skills, subagents, scripts, flights, and filters. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Orchestrator abstraction for multi-provider support**: `IOrchestrator` interface with `run()` and `runStream()` methods; factory pattern selects `ClaudeOrchestrator` or `GhcpOrchestrator` at runtime. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Flight system for version-specific feature flags**: `OAGENT_FLIGHTS=<key>:true` enables per-version feature flags that override model, subagents, scripts, RAI, and prompt files. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Versioned prompts directory structure**: Organize prompts as `src/prompts/<version>/` with system-prompt.md, skills/, subagents/, scripts/, intent-detection/, and flight-conditional overwrites/. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Logging safety conventions**: Never include user data in `logInfo`/`logWarn`/`logError` (telemetry); `logDebug` is local-only and safe for user data. No `console.*` in production. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Lage-based build pipeline with upstream deps**: `build` task depends on `^build` (upstream packages); individual packages can build without Docker. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Provider-agnostic chain-of-thought tracking**: `ChainOfThoughtMessage` uses structural typing (no SDK imports), enabling use with any provider (Claude or GHCP). _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

#### Build & Test Results
- **OfficeAgent core modules stable**: message-protocol 113 tests PASS (3.71s), augloop-transport 11 tests PASS (3.41s with 1 pre-existing babel error), cowork-demo 49 tests PASS (all 4 suites). Total: 173 passing tests. _(Dallas, Verify)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **office-bohemia Bebop TS errors isolated to cowork integration**: 17 errors in 5 files (pas.config.ts, CoworkErrorBoundary.tsx, useCoworkStream.ts, streamingBridge.ts, transportRegistry.ts) from cross-PR boundaries, but Vite dev mode works without typecheck. _(Dallas, Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

#### Architecture Notes
- **OfficeAgent three-tier agent architecture**: Tier 1 Full (Claude SDK, 20+ flights, 4 versions), Tier 2 Copilot (GitHub SDK, simpler config), Tier 3 Minimal (no LLM, direct conversion/execution). _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **OfficeAgent agent inventory**: 15 agents across document creation; 12/15 have CLAUDE.md guidance; most use claude-sonnet-4-5 or claude-opus-4-6; grounding-agent, dw-marketer-agent, excel-js-runner-agent, ppt-agent lack agent-specific guidance. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **OfficeAgent module ecosystem**: 17 modules spanning core platform (@officeagent/core, @officeagent/api, @officeagent/message-protocol with 160+ types), document generation (html2pptx, json-to-docx, excel-headless), AI/intelligence (grounding, chain-of-thought, RAI), and integration (MCP proxy, SharePoint git remote). _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Docker multi-stage build with full toolchain**: poppler-builder → libreoffice-installer → node-deps → final; exposes ports 6010 (API), 6011 (internal agent comms), 6020 (debug), 7010 (grounding). _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

#### Bugs & Gotchas
- **yarn workspace naming gotcha**: `yarn workspace` with package name only (no scope) fails silently; must use full scoped name e.g. `@officeagent/message-protocol`. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **office-bohemia yarn lage constraint**: `yarn lage` must run from monorepo root, not from `apps/bebop/` subdirectory. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Mock server one-shot per scenario**: Mock AugLoop server resets between test runs; restart required between scenario changes. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Demo WebSocket hook hardcoded to localhost**: `useDemoCoworkSession` is development-only code with hardcoded `ws://localhost:11040`; not production-ready. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Protocol type mismatches between Bebop and OfficeAgent**: 5 known mismatches in SessionInit, SessionInitResponse, FileInfo, Error, and CoT event shapes require alignment before production deployment. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

#### Action Items
- **Resolve office-bohemia cross-PR integration TS errors**: 17 errors in cowork feature files (streamingBridge.ts imports mismatch, useCoworkStream.ts atom references, CoworkErrorBoundary.tsx override modifier) must be fixed for typecheck to pass. _(Dallas, Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **Align protocol types Bebop↔OfficeAgent wire format**: Resolve 5 type mismatches and validate round-trip serialization before production. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

_Processed 3 notes, 21 insights extracted, 0 duplicates removed._

---

### 2026-03-16: OfficeAgent Cowork UX implementation learnings and testing guide
**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Worktree reuse before creating new ones saves 10+ minutes**: Pre-flight check for existing worktrees via `git worktree list` avoids redundant fetch+merge+conflict-resolution. OfficeAgent and office-bohemia worktrees already exist on e2e branches. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **PowerShell required for all yarn/oagent/gulp commands**: Bash fails silently; all commands must run via `powershell.exe -Command "yarn ..."`. _(Dallas, Ripley)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Use full scoped package names in yarn workspace commands**: Bare package names fail silently; must use `@officeagent/<pkg>` or `@officeagent-tools/<pkg>`. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **@officeagent-tools/ scope for devtools, @officeagent/ for libraries**: Package scope determines workspace identity; devtools like cowork-demo use @officeagent-tools/, core modules use @officeagent/. _(Dallas, Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Registry-first agent design pattern**: Every agent exports `agentRegistry: AgentRegistryConfig` from `src/registry.ts` as single source of truth for identity, versions, tools, subagents, scripts, flights, and filters. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Flight system enables per-version feature flags**: `OAGENT_FLIGHTS=<key>:true` environment variable overrides model, subagents, scripts, RAI rules, and prompt files at runtime; create-agent has 21 flight configurations. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Never include user data in telemetry logs**: logInfo/logWarn/logError are telemetry-safe (no user data); logDebug is local-only and can include user data. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Provider-agnostic ChainOfThought via structural typing**: CoT module uses structural typing (no SDK imports), enabling compatibility with both Claude and GitHub Copilot SDKs via factory pattern. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Cowork feature gate with three-level precedence**: Query parameter (`?EnableBebopCowork=true`) overrides localStorage, which overrides environment variable; localStorage persistence survives refresh. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **All packages pinned to version 1.1.1130**: Package versions across all 17 modules and 15 agents locked to identical version for consistency. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

#### Architecture Notes
- **OfficeAgent is multi-tier Docker platform with dual LLM providers**: TypeScript/Node.js monorepo (Yarn 4.10.3 + Lage task runner) runs in multi-stage Docker with poppler, LibreOffice, Node 24; supports both Anthropic Claude SDK and Azure OpenAI/GitHub Copilot SDK via provider-agnostic orchestrator. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Three-tier agent architecture by capability**: Tier 1 (Full) uses Claude with multiple versions and 20+ flights; Tier 2 (Copilot) uses GitHub Copilot SDK with simpler config; Tier 3 (Minimal) has no LLM, direct conversion/execution only. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **15 agents distributed across tiers with create-agent as complexity leader**: create-agent has 4 versions and 21 flights; registry.ts is single source of truth for each agent's identity. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **17 modules with clear separation of concerns**: Core (agent mgmt, logging, hooks), API (HTTP routes, 14+ WebSocket handlers, handler registry), Message-Protocol (160+ types, JSON-RPC 2.0), Orchestrator (IOrchestrator interface, provider-agnostic factory), Document generation (html2pptx, json-to-docx, excel-headless), AI & intelligence (chain-of-thought, grounding, RAI), Integration (MCP proxy, SharePoint git remote). _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Handler registry maps WebSocket message types to handlers with SSE streaming support**: HandlerRegistry in API module supports both regular and streaming response patterns; 14+ handler implementations follow established pattern. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Orchestrator abstraction enables provider switching at runtime**: IOrchestrator interface with `run()` and `runStream()` methods; factory pattern selects ClaudeOrchestrator or GhcpOrchestrator without affecting downstream code. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

- **Cowork UX three-panel layout integrated into Bebop**: Chat panel (left), Progression step list (center), Artifact tabs (right) under `apps/bebop/src/features/cowork/` with responsive design. _(Dallas, Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **Docker ports: 6010 (external API), 6011 (internal agent-to-agent), 6020 (debug), 7010 (grounding)**: Health check via `curl http://localhost:6010/health`; multi-stage build with separate node-deps layer. _(Ripley)_
  → see `knowledge/build-reports/2026-03-16-ripley-ripley-exploration-w033-officeagent-codebase-summa.md`

#### Build & Test Results
- **message-protocol: 113 tests PASS in 3.71s**: 160+ message types and JSON-RPC 2.0 contract types fully tested; foundation for all WebSocket communication. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **augloop-transport: 11 tests PASS in 3.41s**: Exponential backoff + jitter reconnection logic tested; 1 pre-existing source test suite fails on Babel import type parsing (not blocking). _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **cowork-demo: 49 tests PASS across 4 suites**: Fixtures, mock-augloop-server, host-environment, mock-token-provider all passing; devtools package @officeagent-tools/cowork-demo. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Total: 173 tests passing across verified packages**: message-protocol (113) + augloop-transport (11) + cowork-demo (49); OfficeAgent core functionality stable. _(Dallas, Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **Vite dev server works despite 17 TypeScript errors**: esbuild in dev mode skips type-checking; server runs on port 3000 (fallback 3002); errors are integration boundaries only. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Mock AugLoop server on ws://localhost:11040/ws (WebSocket-only)**: Returns 404 on HTTP; one-shot per scenario (must restart between runs); hardcoded in demo hook useDemoCoworkSession. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

#### Bugs & Gotchas
- **Yarn workspace silently fails with bare package names**: Must use full scope (@officeagent/core) not just (core); no error message when wrong form used. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **office-bohemia yarn lage must run from monorepo root**: Running from `apps/bebop/` subdirectory fails silently; always cd to repo root before `yarn lage build`. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **Mock server is one-shot per scenario**: Restart required between test runs; connection persists until client disconnect or timeout. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **useDemoCoworkSession demo hook is NOT production code**: Hardcoded `ws://localhost:11040` connection; must not ship to production. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-plan-verification-re-r.md`

- **17 TypeScript errors in office-bohemia/Bebop cowork integration**: streamingBridge.ts imports wrong export names (TransportConfig/TransportState/AugloopTransport); useCoworkStream.ts has atom type mismatches; CoworkErrorBoundary.tsx has override modifier issues from cross-PR boundaries. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **5 protocol type mismatches between Bebop and OfficeAgent**: SessionInit, SessionInitResponse, FileInfo, Error, CoT event discriminants have different shapes; Bebop mirrors use string unions while OfficeAgent may use enums. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **E2E PRs exist but require integration fixes before merge**: PR-4972662 (OfficeAgent) and PR-4972663 (office-bohemia) are active; protocol and type mismatches block production readiness. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

#### Action Items
- **Resolve 5 protocol type mismatches between Bebop and OfficeAgent**: Align SessionInit, SessionInitResponse, FileInfo, Error payloads and CoT event discriminants before production merge; file location: `apps/bebop/src/features/cowork/types/messageProtocol.ts` vs `modules/message-protocol/`. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

- **Fix 17 TypeScript errors in office-bohemia Bebop cross-PR integration**: streamingBridge.ts import names, useCoworkStream.ts atom types, CoworkErrorBoundary.tsx override modifiers must be corrected to unblock type checking. _(Verify)_
  → see `knowledge/conventions/2026-03-16-verify-manual-testing-guide.md`

_Processed 3 notes, 34 insights extracted, 0 duplicates removed._

---

### 2026-03-16: Dallas, Feedback, Lambert: bug findings, PR reviews (9 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (2)
- - This is the Nth+3 application of this pattern on PR-4970916 alone (source: PR-4970916 thread history) _(dallas)_
- **Engine must filter agent-authored bail-out comments from review findings**: The consolidation pipeline continues to misclassify "No Action Required" notes as actionable human feedback, causing infinite dispatch loops _(dallas)_

#### PR Review Findings (7)
- **Directionality modeled via Message vs ResponseMessage**: Server→client messages use `Message<T>` (e.g., `AskUserQuestionMessage`), client→server uses `ResponseMessage<T>` (e.g., `UserAnswerMessage`). This follows the existing protocol convention established in `modules/message-protocol/src/type... _(feedback, lambert)_
- **Compile-time shape tests as drift protection**: 164 lines of tests create typed object literals with explicit type annotations — if any field is renamed in the interface, the test fails at compile time. This is the strongest defense against silent wire-format drift in cross-repo mirrored types.... _(feedback, lambert)_
- **Intentional alignment with PptAgentCotContentType**: The `text` and `thinking` event kinds in `CoTStreamEventKind` intentionally mirror `PptAgentCotContentType` values from `agents/ppt-agent/messages.ts`. File header documents this explicitly as "overlap by design" for future unification. (sour... _(feedback, lambert)_
- **Three-tier CoT type hierarchy confirmed**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming). This PR adds the third tier. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:1-10`, existing types in... _(feedback, lambert)_
- **stepId optionality asymmetry**: `stepId` is required on `CoTStepStartedEvent` but optional on `CoTStepCompletedEvent`. Handler implementations (PL-W001) must handle missing `stepId` on completion events. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:58,67`) _(feedback, lambert)_
- **sequenceNumber scope**: Documented as session-scoped but the handler implementation (not in this PR) needs per-session counters. A module-level counter would interleave across concurrent sessions. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:130`) _(feedback, lambert)_
- - Always use `dev.azure.com` hostname, not `office.visualstudio.com` _(feedback, lambert)_

_Deduplication: 13 duplicate(s) removed._


---

### 2026-03-16: Dallas, Feedback, Lambert: bug findings, PR reviews (7 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (2)
- - This is the Nth+3 application of this pattern on PR-4970916 alone (source: PR-4970916 thread history) _(dallas)_
- **Engine must filter agent-authored bail-out comments from review findings**: The consolidation pipeline continues to misclassify "No Action Required" notes as actionable human feedback, causing infinite dispatch loops _(dallas)_

#### PR Review Findings (5)
- **Directionality modeled via Message vs ResponseMessage**: Server→client messages use `Message<T>` (e.g., `AskUserQuestionMessage`), client→server uses `ResponseMessage<T>` (e.g., `UserAnswerMessage`). This follows the existing protocol convention established in `modules/message-protocol/src/type... _(feedback, lambert)_
- **Compile-time shape tests as drift protection**: 164 lines of tests create typed object literals with explicit type annotations — if any field is renamed in the interface, the test fails at compile time. This is the strongest defense against silent wire-format drift in cross-repo mirrored types.... _(feedback, lambert)_
- **Three-tier CoT type hierarchy confirmed**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming). This PR adds the third tier. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:1-10`, existing types in... _(feedback, lambert)_
- **sequenceNumber scope**: Documented as session-scoped but the handler implementation (not in this PR) needs per-session counters. A module-level counter would interleave across concurrent sessions. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:130`) _(feedback, lambert)_
- - Always use `dev.azure.com` hostname, not `office.visualstudio.com` _(feedback, lambert)_

_Deduplication: 15 duplicate(s) removed._


---

### 2026-03-16: CoT streaming patterns and systematic dispatch consolidation bugs

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern is systematic across multiple PRs**: Check commits + existing votes via ADO REST API (~15s) prevents 5-10 min review cycles; applied to both PR-4970916 and PR-4970128 _(Dallas, Lambert)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **CoT stream event discriminated union pattern**: `CoTStreamEvent` uses `kind` field as discriminant across 6 event types (`step_started`, `step_completed`, `tool_use`, `thinking`, `text`, `ask_user_question`), enabling exhaustive `switch` patterns without type assertions _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Directionality modeled via Message vs ResponseMessage**: Server→client messages use `Message<T>`, client→server uses `ResponseMessage<T>`, following protocol convention from `core.ts` _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Compile-time shape tests as drift protection**: 164 lines of typed object literals with explicit annotations prevent silent wire-format drift in cross-repo mirrored types _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Intentional alignment with PptAgentCotContentType**: `text` and `thinking` event kinds mirror existing types from `agents/ppt-agent/messages.ts`, documented as "overlap by design" for future unification _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Bugs & Gotchas
- **stepId optionality asymmetry**: Required on `CoTStepStartedEvent` but optional on `CoTStepCompletedEvent`; handlers (PL-W001) must accommodate missing values _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **sequenceNumber scope underdefined**: Documented as session-scoped but handler needs per-session counters; module-level counter would interleave across concurrent sessions _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Architecture Notes
- **Three-tier CoT type hierarchy confirmed**: WorkspaceChainOfThoughtPayload (batch), PptAgentCotPayload (typed batch), ChainOfThoughtUpdatePayload (incremental streaming) _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **ADO REST API Windows quirks**: Write JSON to `$TEMP/file.json` with `curl -d`, always use `dev.azure.com`, POST `{"status": 4}` for thread closure, GET `/_apis/connectionData?api-version=6.0-preview` for VSID lookup _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Action Items
- **Engine must filter agent-authored bail-out comments from review findings**: Consolidation pipeline misclassifies "No Action Required" notes as actionable feedback, causing infinite dispatch loops on the same PR _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

_Processed 3 notes, 9 insights extracted, 1 duplicate removed._

---

### 2026-03-16: Engine consolidation loop affecting multiple PRs + CoT streaming protocol patterns

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern**: Pre-flight check of review content (read findings → detect keywords like "No Action Required" → post closed thread → exit) saves 5-10 minutes per dispatch vs full review cycle. Applied successfully Nth+3 times across PRs. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **CoT stream event discriminated union**: `CoTStreamEvent` uses `kind` field as discriminant across 6 event types (`step_started`, `step_completed`, `tool_use`, `thinking`, `text`, `ask_user_question`), enabling exhaustive switch patterns without type assertions. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Directionality modeled via Message vs ResponseMessage**: Server→client messages use `Message<T>` (e.g., `AskUserQuestionMessage`), client→server uses `ResponseMessage<T>` (e.g., `UserAnswerMessage`), following existing protocol convention from `modules/message-protocol/src/types/core.ts`. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Compile-time shape tests as drift protection**: 164 lines of typed object literals with explicit type annotations fail at compile time if any field is renamed in the interface—strongest defense against silent wire-format drift in cross-repo mirrored types. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **Intentional alignment with PptAgentCotContentType**: The `text` and `thinking` event kinds in `CoTStreamEventKind` intentionally mirror `PptAgentCotContentType` values from `agents/ppt-agent/messages.ts`; file header documents this as "overlap by design" for future unification. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Bugs & Gotchas
- **Engine consolidation misclassifies agent bail-out notes as actionable feedback**: PR-4970916 and PR-4970128 both re-dispatched repeatedly due to prior agent notes ("No Action Required", "Duplicate Dispatch") misclassified as human reviewer feedback by consolidation pipeline, causing infinite dispatch loops. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **stepId optionality asymmetry**: `stepId` is required on `CoTStepStartedEvent` but optional on `CoTStepCompletedEvent`; handler implementations (PL-W001) must handle missing `stepId` on completion events. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

- **sequenceNumber scope requires per-session counters**: Documented as session-scoped but handler implementation needs per-session counters; a module-level counter would interleave across concurrent sessions. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Architecture Notes
- **Three-tier CoT type hierarchy confirmed**: WorkspaceChainOfThoughtPayload (batch) → PptAgentCotPayload (typed batch) → ChainOfThoughtUpdatePayload (incremental streaming); PR-4970128 adds the third tier. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16.md`

#### Action Items
- **Engine must filter agent-authored bail-out comments from review findings**: Consolidation pipeline needs logic to detect and exclude agent's own "No Action Required" bail-out notes from being re-classified as actionable human feedback in subsequent dispatch cycles. _(Dallas)_
  → see `knowledge/conventions/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **ADO REST API reference for Windows**: Write JSON to `$TEMP/file.json` + use `curl -d @"$TEMP/file.json"` (inline JSON fails on Windows bash); always use `dev.azure.com` hostname; thread closure POST `{"status": 4}`; vote submission PUT with `{"vote": 10}`; VSID lookup via `GET /_apis/connectionData?api-version=6.0-preview`. _(Lambert)_
  → see `knowledge/reviews/2026-03-16-feedback-review-feedback-for-dallas.md`

_Processed 3 notes, 10 insights extracted, 2 duplicates removed._

---

### 2026-03-16: Dallas, Feedback, Lambert: bug findings, PR reviews (9 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (4)
- Dispatched to fix review findings on PR-4970916 (`feat/PL-W009-host-integration-demo`). The "findings" were my own prior bail-out note ("No Action Required — Duplicate Dispatch (Nth+3)"), not actionable code feedback. Applied early bail-out pattern. _(dallas)_
- - Full review cycle avoided: worktree creation + git fetch + build + test + lint (5-10 minutes) (source: established pattern from prior dispatches) _(dallas)_
- - Always use `dev.azure.com` hostname, not `office.visualstudio.com` (source: successful API call to `https://dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970916/threads`) _(dallas)_
- **Engine must filter agent-authored bail-out comments from review findings**: Detect keywords "No Action Required", "early bail-out", "Duplicate Dispatch" in review findings and skip dispatch to prevent infinite loops _(dallas)_

#### PR Review Findings (5)
- **Early bail-out for duplicate dispatches**: Pre-flight check of commit SHAs + existing thread count is the correct approach. (source: PR-4970916 threads API response showing 47 threads, 28 with APPROVE content) _(feedback, lambert)_
- **ADO REST API temp file pattern on Windows**: Must write JSON payloads to `$TEMP/filename.json` and use `-d @"$TEMP/filename.json"` for curl POST requests. `/dev/stdin` causes ENOENT on Windows Node.js. (source: curl commands in this session) _(feedback, lambert)_
- **VSID retrieval for vote submission**: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` = `1c41d604-e345-64a9-a731-c823f28f9ca8` for the current user. (source: ADO connectionData API response) _(feedback, lambert)_
- **Engine consolidation loop persists**: This is the Nth+ dispatch for PR-4970916 with zero new commits. The engine's consolidation pipeline continues to misclassify agent-authored bail-out comments as actionable review findings. (source: 47 threads on PR-4970916, most are bail-out notes from vari... _(feedback, lambert)_
- **MCP ADO tools still unavailable**: `mcp__azure-ado__*` tools not found in tool search. REST API via curl + Bearer token remains the only working path for ADO operations. (source: ToolSearch returned "No matching deferred tools found") _(feedback, lambert)_

_Deduplication: 9 duplicate(s) removed._


---

### 2026-03-16: Dallas, Feedback, Lambert: bug findings, PR reviews (8 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (3)
- Dispatched to fix review findings on PR-4970916 (`feat/PL-W009-host-integration-demo`). The "findings" were my own prior bail-out note ("No Action Required — Duplicate Dispatch (Nth+3)"), not actionable code feedback. Applied early bail-out pattern. _(dallas)_
- - Always use `dev.azure.com` hostname, not `office.visualstudio.com` (source: successful API call to `https://dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970916/threads`) _(dallas)_
- **Engine must filter agent-authored bail-out comments from review findings**: Detect keywords "No Action Required", "early bail-out", "Duplicate Dispatch" in review findings and skip dispatch to prevent infinite loops _(dallas)_

#### PR Review Findings (5)
- **Early bail-out for duplicate dispatches**: Pre-flight check of commit SHAs + existing thread count is the correct approach. (source: PR-4970916 threads API response showing 47 threads, 28 with APPROVE content) _(feedback, lambert)_
- **ADO REST API temp file pattern on Windows**: Must write JSON payloads to `$TEMP/filename.json` and use `-d @"$TEMP/filename.json"` for curl POST requests. `/dev/stdin` causes ENOENT on Windows Node.js. (source: curl commands in this session) _(feedback, lambert)_
- **VSID retrieval for vote submission**: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` = `1c41d604-e345-64a9-a731-c823f28f9ca8` for the current user. (source: ADO connectionData API response) _(feedback, lambert)_
- **Engine consolidation loop persists**: This is the Nth+ dispatch for PR-4970916 with zero new commits. The engine's consolidation pipeline continues to misclassify agent-authored bail-out comments as actionable review findings. (source: 47 threads on PR-4970916, most are bail-out notes from vari... _(feedback, lambert)_
- **MCP ADO tools still unavailable**: `mcp__azure-ado__*` tools not found in tool search. REST API via curl + Bearer token remains the only working path for ADO operations. (source: ToolSearch returned "No matching deferred tools found") _(feedback, lambert)_

_Deduplication: 10 duplicate(s) removed._


---

### 2026-03-16: Dallas, Feedback, Lambert: bug findings, PR reviews (8 insights from 3 notes)
**By:** Engine (regex fallback)

#### Bugs & Gotchas (3)
- Dispatched to fix review findings on PR-4970916 (`feat/PL-W009-host-integration-demo`). The "findings" were my own prior bail-out note ("No Action Required — Duplicate Dispatch (Nth+3)"), not actionable code feedback. Applied early bail-out pattern. _(dallas)_
- - Always use `dev.azure.com` hostname, not `office.visualstudio.com` (source: successful API call to `https://dev.azure.com/office/ISS/_apis/git/repositories/61458d25-9f75-41c3-be29-e63727145257/pullRequests/4970916/threads`) _(dallas)_
- **Engine must filter agent-authored bail-out comments from review findings**: Detect keywords "No Action Required", "early bail-out", "Duplicate Dispatch" in review findings and skip dispatch to prevent infinite loops _(dallas)_

#### PR Review Findings (5)
- **Early bail-out for duplicate dispatches**: Pre-flight check of commit SHAs + existing thread count is the correct approach. (source: PR-4970916 threads API response showing 47 threads, 28 with APPROVE content) _(feedback, lambert)_
- **ADO REST API temp file pattern on Windows**: Must write JSON payloads to `$TEMP/filename.json` and use `-d @"$TEMP/filename.json"` for curl POST requests. `/dev/stdin` causes ENOENT on Windows Node.js. (source: curl commands in this session) _(feedback, lambert)_
- **VSID retrieval for vote submission**: `GET https://dev.azure.com/office/_apis/connectionData?api-version=6.0-preview` returns `authenticatedUser.id` = `1c41d604-e345-64a9-a731-c823f28f9ca8` for the current user. (source: ADO connectionData API response) _(feedback, lambert)_
- **Engine consolidation loop persists**: This is the Nth+ dispatch for PR-4970916 with zero new commits. The engine's consolidation pipeline continues to misclassify agent-authored bail-out comments as actionable review findings. (source: 47 threads on PR-4970916, most are bail-out notes from vari... _(feedback, lambert)_
- **MCP ADO tools still unavailable**: `mcp__azure-ado__*` tools not found in tool search. REST API via curl + Bearer token remains the only working path for ADO operations. (source: ToolSearch returned "No matching deferred tools found") _(feedback, lambert)_

_Deduplication: 10 duplicate(s) removed._


---

### 2026-03-16: PR-4970916 Early Bail-Out Pattern Effectiveness & Consolidation Loop Persistence

**By:** Engine (LLM-consolidated)

#### Patterns & Conventions
- **Early bail-out pattern for duplicate/unchanged PRs saves 5-10 minutes per dispatch**: Pre-flight validation (git fetch + git log to verify commit SHAs ~5s, ADO threads API check ~5s) + post closed-status thread (status:4) + resubmit approval vote (vote:10) completes in ~15s total vs standard 5-10 minute review cycle. Effective when commits unchanged and existing threads exceed 10. _(Dallas, Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16-pr-4970916-duplicate-.md`

#### Bugs & Gotchas
- **Engine consolidation loop persists in practice**: PR-4970916 re-dispatched Nth+4 time with identical 4 commits (05cbc73, b9240c9, 9e53047, 8304aad); PR contains 47 total threads with 28+ APPROVE-related threads; consolidation pipeline continues to misclassify agent-authored bail-out keywords ("No Action Required", "early bail-out", "Duplicate Dispatch") as actionable human feedback, creating infinite dispatch cycles. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

_Processed 3 notes, 2 insights extracted, 8 duplicates removed._

---

### 2026-03-16: Consolidation loop severity quantified; early bail-out time savings documented

**By:** Engine (LLM-consolidated)

#### Bugs & Gotchas
- **Consolidation loop persists at Nth+4 dispatch**: PR-4970916 re-dispatched with identical 4 commits (`05cbc73`, `b9240c9`, `9e53047`, `8304aad`) and 47 threads (28 with APPROVE verdicts); zero new code since original review indicates engine consolidation pipeline continues to misclassify agent bail-out comments as actionable feedback. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

- **MCP ADO tools unavailable — REST API only**: `mcp__azure-ado__*` tools not discoverable; curl + Bearer token + `dev.azure.com` remains the sole working path for ADO operations. _(Lambert)_
  → see `knowledge/conventions/2026-03-16-lambert-lambert-learnings-2026-03-16-pr-4970916-duplicate-.md`

#### Patterns & Conventions
- **Early bail-out saves 5–10 minutes per dispatch**: Pre-flight check (commit SHA verification + thread count, ~15s) avoids full review cycle (worktree creation, build, test, lint); pattern confirmed effective and scalable. _(Dallas, Lambert)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

#### Action Items
- **Engine consolidation pipeline must filter self-authored bail-out comments**: Add keyword detection ("No Action Required", "early bail-out", "Duplicate Dispatch") to exclude agent-authored notes from being re-classified as human feedback in subsequent dispatch cycles. _(Dallas)_
  → see `knowledge/build-reports/2026-03-16-dallas-dallas-learnings-2026-03-16-pr-4970916-duplicate-d.md`

_Processed 3 notes, 3 insights extracted, 0 duplicates removed._