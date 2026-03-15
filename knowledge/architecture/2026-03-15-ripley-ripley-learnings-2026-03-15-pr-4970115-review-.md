---
source: ripley-2026-03-15.md
agent: ripley
category: architecture
date: 2026-03-15
---

# Ripley Learnings — 2026-03-15 (PR-4970115 Review)

## Task
Reviewed PR-4970115: feat(PL-W017): add mirrored OfficeAgent message protocol types for Bebop cowork

## Findings

### Codebase Pattern: Feature types directory
- Bebop features can have a `types/` subdirectory for type definitions, even though it's not listed in CONTRIBUTING.md's feature anatomy. Precedent: `src/features/conversations/types/Conversation.ts` (source: apps/bebop/src/features/conversations/types/Conversation.ts)
- The existing `Conversation.ts` does NOT use `readonly` on properties, while the new `messageProtocol.ts` does. The new file follows CLAUDE.md's immutable data preference better. (source: apps/bebop/src/features/conversations/types/Conversation.ts:4-8)

### Architecture: Cowork Protocol Types
- The mirrored types file (`apps/bebop/src/features/cowork/types/messageProtocol.ts`) contains a mix of actual OfficeAgent mirrors AND proposed new protocol extensions. (source: PR-4970115)
- **Actual mirrors**: MessageSchema, Message<T>, QueryStatusType, QueryErrorCode, FileInfo, QueryStatusPayload, ErrorPayload — these have real OfficeAgent counterparts with source line references.
- **Proposed extensions**: `cot_stream`, `ask_user_question`, `user_answer` message types; `CoTStreamEvent` discriminated union; `SessionInitPayload`; `AskUserQuestionPayload`; `UserAnswerPayload` — these don't exist in OfficeAgent yet. (source: knowledge/architecture/2026-03-15-ripley-ripley-learnings-2026-03-15.md — CoT is file-based only, ask_user_question is tool not protocol)

### Convention: String literal unions over enums
- The PR uses `type CoworkMessageType = 'session_init' | 'llm_request' | ...` instead of TypeScript enums. This is consistent with modern TS best practices and avoids enum runtime overhead. (source: apps/bebop/src/features/cowork/types/messageProtocol.ts:27-37)

### Gotcha: az CLI reviewer vote syntax
- `az repos pr reviewer add --vote 5` does NOT work — the `--vote` flag is not recognized by `az repos pr reviewer add`. Must use REST API directly: `PUT /pullRequests/{id}/reviewers/{reviewerId}` with `{ vote: 5 }` body. (source: az CLI error output during this review)

### Convention: ADO reviewer vote values
- Vote 10 = approved, 5 = approved with suggestions, 0 = no vote, -5 = waiting for author, -10 = rejected. Use the PR reviewer PUT API endpoint. (source: ADO REST API response during this review)

## Verdict
APPROVE WITH SUGGESTIONS (vote: 5). Clean types-only file following Bebop conventions. Main suggestion: clarify which types are mirrors vs proposed extensions in the file header.
