---
source: feedback-dallas-from-lambert-PR-4970128-2026-03-16.md
agent: feedback
category: reviews
date: 2026-03-16
---

# Review Feedback for Dallas

**PR:** PR-4970128 — feat(PL-W015): add CoT streaming and ask-user-question protocol types
**Reviewer:** Lambert
**Date:** 2026-03-16

## What the reviewer found

# Lambert Learnings — 2026-03-16

## PR-4970959: feat(cowork): SharedTree DDS schema and adapter for collaborative sessions

### Patterns Discovered

1. **SchemaFactoryBeta is the standard for SharedTree schemas**: All Loop packages (copilot, conversa, recap, tablero) use `SchemaFactoryBeta` from `@fluidframework/tree/beta` with scoped namespace pattern `com.microsoft.loopcomponent.<feature>`. This is not a concern despite `Beta` in the name — it's the established convention. (source: `packages/copilot/src/model/sharedTree/CopilotHistoryTreeSchema.ts:3`, `packages/conversa/src/schema/SharedTreeSchema.ts:22`, `packages/recap/src/model/sharedTree/RecapTreeSchema.ts:1`, `packages/tablero-data-model/src/treeDataModel/schema/factory.ts:1`)

2. **SharedTree → Jotai snapshot projection pattern**: The adapter projects tree nodes into plain JS snapshot objects, then pushes those snapshots into Jotai atoms via a `syncFromSnapshotAtom`. This prevents React components from holding SharedTree node references (which break on detach/GC). Pattern: Tree change → `#projectTreeToSnapshot()` → `emit('stateChange', snapshot)` → Jotai atom set. (source: PR-4970959, `packages/cowork-component/src/sharedTree/coworkTreeAdapter.ts`)

3. **Dual-mode adapter factory pattern**: `CoworkTreeAdapter.fromTreeView(treeView)` for connected SharedTree mode, `CoworkTreeAdapter.localOnly(sessionId)` for offline/fallback. UI layer doesn't know which mode is active — all writes go through adapter methods. (source: PR-4970959, `packages/cowork-component/src/sharedTree/coworkTreeAdapter.ts`)

4. **`allowUnknownOptionalFields: true` for schema evolution**: All node types in cowork schema use this option for forward-compatible evolution. New optional fields can be added without breaking existing documents. Combined with explicit `schemaVersion` in `ArbitraryProperties` for migration support. (source: PR-4970959, `packages/cowork-component/src/sharedTree/coworkSchema.ts`)

5. **ADO REST API comment + vote workflow on Windows**: Write review body to temp file → build JSON payload with Node.js → POST via curl with `@$TEMP/file.json`. Vote via PUT to `/pullRequests/{id}/reviewers/{vsid}` with `{"vote": 5}`. VSID from `/connectionData?api-version=6.0-preview`. (source: this review session)

### Gotchas

- **Participants map not cleared in connected-mode `resetSession`**: The `resetSession` method clears messages, progressionSteps, and artifacts arrays but forgets to iterate and delete entries from the participants map. Local-only path correctly resets to empty. (source: PR-4970959, `coworkTreeAdapter.ts` resetSession method)

- **Double `as unknown as T` casts in snapshot sync**: `syncFromSnapshotAtom` uses `snapshot.messages as unknown as ChatMessage[]` to bridge snapshot types to feature types. Violates CLAUDE.md no-assertions rule. Types are structurally identical, so either reuse snapshot types directly or write explicit mappers. (source: PR-4970959, `apps/bebop/src/features/cowork/atoms/coworkAtoms.ts`)

- **Node.js `EventEmitter` in browser package**: `cowork-component` extends Node.js `EventEmitter` via `events` polyfill. Other Fluid packages use `@fluidframework/core-interfaces` event system. The polyfill works but adds ~3KB bundle weight. (source: PR-4970959, `coworkTreeAdapter.ts:3`)

- **Windows `/dev/stdin` incompatible with Node.js**: Piped data to `node -e` fails on Windows. Use temp file intermediaries: write to `$TEMP/file.json`, then `require('fs').readFileSync(process.env.TEMP + '/file.json')`. (source: this review session)

### Conventions

- SharedTree schema packages should be under `packages/` with `@fluidx/` scope, following `cowork-component` as template
- Package `index.ts` barrel files are acceptable in `packages/` (lint rule is Bebop-specific `apps/bebop/`)
- New SharedTree schemas MUST have unit tests before production deployment — schema changes are irreversible

## PR-4970115: feat(PL-W017) — Mirrored OfficeAgent Message Protocol Types

### Patterns Discovered

1. **Bebop `types/` subdirectory is established pattern**: `features/conversations/types/Conversation.ts` exists on master, confirming `features/<name>/types/` is valid for feature-scoped type definitions even though not listed in Bebop CONTRIBUTING.md. (source: `git show origin/master:apps/bebop/src/features/conversations/types/` listing)

2. **cowork feature directory is greenfield on master**: `apps/bebop/src/features/cowork/` does not exist on master as of 2026-03-16. This PR creates the first file in that directory. (source: `git show origin/master:apps/bebop/src/features/cowork/` → fatal: path does not exist)

3. **Wire format field names verified correct in this PR**: FileInfo uses `path`, `filename`, `size` (correct per OfficeAgent `modules/message-protocol/src/types/core.ts:291-316`). QueryStatusPayload uses `error` not `errorMessage`. ErrorPayload uses `message` not `errorMsg`. Improvement over PR-4970405 which had incorrect field names. (source: PR-4970115 diff, cross-referenced with knowledge/conventions/2026-03-16-ripley-ripley-learnings-2026-03-16-pr-4970405-review-.md)

4. **ADO REST API vote via `az rest`**: `az rest --method put --url ".../reviewers/{vsid}?api-version=7.1" --body '{"vote": 5}'` correctly sets vote. VSID from `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id`. (source: PR-4970115 vote PUT response, VSID=1c41d604-e345-64a9-a731-c823f28f9ca8)

### Gotchas

- **Mirrors vs proposed extensions mixed without clear markers**: messageProtocol.ts contains both 1:1 OfficeAgent mirrors (MessageSchema, Message<T>, FileInfo, QueryStatusPayload, ErrorPayload) and proposed types (CoTStreamEvent, AskUserQuestionPayload, SessionInitPayload) that don't exist on OfficeAgent main. No section break distinguishes them. (source: PR-4970115, apps/bebop/src/features/cowork/types/messageProtocol.ts)

- **cot_stream, ask_user_question, user_answer message types are uncommitted in OfficeAgent**: These only exist in the `feat/PL-W001` worktree. Both repos must land their respective changes before wire communication works. (source: knowledge base cross-reference)

### Conventions

- When reviewing mirrored type files, verify field names against actual OfficeAgent source — silent `undefined` from JSON deserialization is the hardest bug to find
- PR review on ADO requires two separate REST calls: POST thread (comment) + PUT reviewer (vote)

## PR-4970128: feat(PL-W015): add CoT streaming and ask-user-question protocol types

### Patterns Discovered

1. **CoT streaming event model**: New `CoTStreamEvent` discriminated union uses `kind` field with 6 values (`step_started`, `step_completed`, `tool_use`, `thinking`, `text`, `ask_user_question`). The `thinking`, `text`, `tool_use` kinds align with existing `PptAgentCotContentType` in `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:279`. (source: PR-4970128, `modules/message-protocol/src/types/chain-of-thought-stream.ts`)

2. **New MessageType enum values added cleanly**: `ChainOfThoughtUpdate = 'chain_of_thought_update'`, `AskUserQuestion = 'ask_user_question'`, `UserAnswer = 'user_answer'` appended to the end of the enum at `modules/message-protocol/src/types/message-type.ts:166-170`. These extend the existing 165+ entry enum without conflicting. (source: PR-4970128)

3. **Bidirectional ask-user protocol formalized**: `AskUserQuestionPayload` supports structured options + freeform text + timeout with default answer. `UserAnswerPayload` references back via `questionId` correlation. This formalizes what was previously only a Claude tool reference in ppt-agent docs. (source: `modules/message-protocol/src/types/ask-user-question.ts`)

4. **ChainOfThoughtUpdatePayload wraps event + sequenceNumber**: The payload includes a `sequenceNumber` field for ordering — important for WebSocket delivery where messages may arrive out of order. Distinct from existing `ChainOfThoughtPayload` (core.ts:266) which only has `content: string`. (source: `modules/message-protocol/src/types/chain-of-thought-stream.ts:120-127`)

### Gotchas

- **Optional `stepId` on both step_started and step_completed**: If both omit `stepId`, there's no reliable way to correlate which step completed. Consumers will need to fall back to ordering-based correlation. (source: `chain-of-thought-stream.ts` lines ~53 and ~65)

- **Two CoT payload families now coexist**: `PptAgentCotPayload` (flat: contentType + content + turnNumber + toolName) vs `ChainOfThoughtUpdatePayload` (wrapped: event discriminated union + sequenceNumber). They serve different transport paths but represent overlapping concepts. Future unification should be considered. (source: `ppt-agent/messages.ts:286` vs `chain-of-thought-stream.ts:120`)

- **`az rest` fails with Unicode in ADO connectionData response on Windows**: The `\u221e` character causes `charmap` codec error. Use `node -e` with `https` module instead. (source: direct experience during review)


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
