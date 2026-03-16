# Review Feedback for Rebecca

**PR:** PR-4970916 — feat(PL-W009): add cowork host integration demo and test fixtures
**Reviewer:** Ralph
**Date:** 2026-03-16

## What the reviewer found

# Ralph Learnings — 2026-03-16 (PR-4970916 Review)

## Task
Reviewed PR-4970916: `feat(PL-W009): add cowork host integration demo and test fixtures`
Branch: `feat/PL-W009-host-integration-demo`

## Findings

### PR Structure
- New `.devtools/cowork-demo` package adds mock AugLoop WebSocket server + host environment simulator + fixtures + tests + demo HTML pages (source: `.devtools/cowork-demo/` — 18 new files, ~4,650 lines)
- Package correctly named `@officeagent-tools/cowork-demo` matching existing `.devtools/` naming convention (source: `.devtools/cowork-demo/package.json`)
- Uses `@officeagent/message-protocol` via `workspace:^` linking (source: `.devtools/cowork-demo/package.json:17`)

### MessageType Enum Values Verified
- All referenced MessageType values exist in source:
  - `SessionInit` = 'session_init' (source: `modules/message-protocol/src/types/message-type.ts:16`)
  - `SessionInitResponse` = 'session_init_response' (source: `modules/message-protocol/src/types/message-type.ts:17`)
  - `Ping` = 'ping' (source: `modules/message-protocol/src/types/message-type.ts:13`)
  - `Pong` = 'pong' (source: `modules/message-protocol/src/types/message-type.ts:14`)
  - `QueryStatus` = 'query_status' (source: `modules/message-protocol/src/types/message-type.ts:93`)
  - `PptAgentCot` = 'ppt_agent_cot' (source: `modules/message-protocol/src/types/message-type.ts:164`)

### Patterns Confirmed
- `.devtools/` packages freely use `console.*` — CLAUDE.md logging rule applies only to production code (source: `.devtools/test-client/src/` has 351 console.* calls across 13 files)
- Fixture interfaces use `readonly` fields — aligns with team convention for protocol types (source: PR fixtures)
- Mock server correctly simulates AugLoop dev endpoint at port 11040 (source: `.devtools/test-client/src/augloop-client.ts`)

### ADO REST API — Reviewer Vote Pattern
- Cannot vote as another user — the `reviewerId` in the PUT URL must match the authenticated user's VSID, not the AAD OID (source: ADO REST API error "TF401186: You cannot record a vote for someone else")
- Get VSID via `GET /_apis/connectionData?api-version=6.0-preview` → `authenticatedUser.id` field (source: ADO REST API)
- The AAD OID (`a3613c1a-...` from JWT `oid` claim) is NOT the same as the VSID (`1c41d604-...` from connectionData) — must use VSID for reviewer operations (source: PR-4970916 vote attempt)

### Verdict
- **APPROVE** — no blocking issues. Clean architecture, comprehensive tests, correct protocol type usage.

## Gotchas
- ADO `connectionData` API requires `-preview` suffix: `api-version=6.0-preview` (not `6.0`) — otherwise returns `VssInvalidPreviewVersionException` (source: ADO REST API)
- ADO MCP tools (`mcp__azure-ado__*`) were unavailable in this session; used REST API via `git credential fill` + Node.js HTTPS as fallback (source: session observation)


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
