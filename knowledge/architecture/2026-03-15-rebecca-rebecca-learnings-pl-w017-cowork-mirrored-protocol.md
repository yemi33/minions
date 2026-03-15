---
source: rebecca-PL-W017-2026-03-15.md
agent: rebecca
category: architecture
date: 2026-03-15
---

# Rebecca Learnings — PL-W017 (Cowork Mirrored Protocol Types)

## Task
Create mirrored OfficeAgent message protocol types in office-bohemia for Bebop cowork feature.

## What Was Done
- Reviewed existing implementation on branch `feat/PL-W007-cowork-protocol-types` (previously created but no PR was filed)
- Created PR-4970115 targeting `master` in office-bohemia
- File: `apps/bebop/src/features/cowork/types/messageProtocol.ts`

## Architecture Decisions

### String union types over enums
- Bebop uses Vite 7 + esbuild which cannot tree-shake TypeScript enums (they compile to IIFEs)
- String union types (`type Foo = 'a' | 'b'`) are erased at compile time — zero runtime cost
- (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts:25-36`)

### Readonly fields for immutability
- All message interface fields marked `readonly` to prevent accidental mutation in React/Jotai state
- Enables reference-equality checks for re-render optimization
- (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts:42-58`)

### Discriminated union for CoTStreamEvent
- Uses `kind` field as discriminant across 4 event types: `step_started`, `step_completed`, `tool_use`, `thinking`
- Enables exhaustive `switch` in UI components without type assertions
- (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts:110-158`)

### Client-side simplification
- `SessionInitPayload` intentionally simpler than OfficeAgent's `SessionInitMessagePayload` — container-internal fields (OfficePySettings, McpServers, groundingSourceToggles) excluded
- `FileInfo` omits `content` and `Buffer` — client only needs metadata
- `ErrorPayload` uses `message` instead of OfficeAgent's `errorMsg` for cleaner client naming
- (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts:64-80`)

## Patterns Discovered

### Cross-repo type mirroring
- When two repos (OfficeAgent/office-bohemia) have incompatible build systems, types must be manually mirrored
- Include source references with file paths and line numbers in comments for future sync
- Use `Last synced: <date>` header to track drift
- (source: `apps/bebop/src/features/cowork/types/messageProtocol.ts:1-15`)

### OfficeAgent message protocol structure
- Base: `Schema { type, id }` → `Message<T> { sessionId, payload }` → `ResponseMessage<T> { requestId }`
- MessageType enum has 165+ entries spanning internal, LLM, enterprise search, Excel, PPT, Word, ODSP, workspace, chat, grounding
- CoT exists in two forms: `ChainOfThoughtPayload` (simple content string) and `PptAgentCotPayload` (typed with contentType, turnNumber, toolName)
- QueryStatus uses nested discriminated pattern: `QueryStatusPayload.type` selects which optional fields are populated
- (source: `modules/message-protocol/src/types/core.ts`, `modules/message-protocol/src/types/message-type.ts`)

### New message types needed for cowork
- `cot_stream`, `ask_user_question`, `user_answer` don't exist in OfficeAgent's `MessageType` enum yet
- These must be added to OfficeAgent as part of P001 (CoT streaming protocol extension)
- The mirrored types anticipate this future protocol extension
- (source: `modules/message-protocol/src/types/message-type.ts` — types absent)

## Gotchas

### Task scope mismatch
- Task was scoped to "Project — OfficeAgent" with OfficeAgent repositoryId, but the file path (`apps/bebop/src/features/cowork/`) is in office-bohemia
- PR needed to target `master` (office-bohemia's main branch), not `main` (OfficeAgent's main branch)
- Repository ID for office-bohemia: `74031860-e0cd-45a1-913f-10bbf3f82555`
- (source: `.squad/config.json`)

### ADO MCP tools unavailable
- `mcp__azure-ado__*` tools were not available in this session
- Fell back to `az repos pr create` via Azure CLI (required installing `azure-devops` extension first)
- `az repos pr comment create` doesn't exist — used `az repos pr update --description` instead
- (source: az CLI session)

### Existing worktree reuse
- Branch `feat/PL-W007-cowork-protocol-types` already had the implementation committed and pushed
- Rather than creating a duplicate branch, reused the existing work after architectural review
- (source: `git worktree list` output)

## PR
- **PR-4970115**: https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4970115
- Branch: `feat/PL-W007-cowork-protocol-types` → `master`
- Repository: office-bohemia (`74031860-e0cd-45a1-913f-10bbf3f82555`)
