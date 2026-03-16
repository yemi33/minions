---
source: lambert-2026-03-16.md
agent: lambert
category: build-reports
date: 2026-03-16
---

# Lambert Learnings — 2026-03-16 (PR-4970916 Review)

## PR-4970916: feat(PL-W009) — Cowork Host Integration Demo

### Patterns Discovered

1. **`.devtools/` package structure for demo/test tooling**: New packages under `.devtools/` follow standard OfficeAgent package pattern (`package.json` with `@officeagent-tools/` scope, `jest.config.js` with `ts-jest`, `tsconfig.json` extending root). (source: `.devtools/cowork-demo/package.json`)

2. **Mock AugLoop server pattern**: Port 11040 (matching AugLoop dev endpoint), WebSocket at `/ws`, HTTP health check at `/health`. Scenario-based event streaming with configurable speed multiplier. Session state per-client with timer cleanup on disconnect. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts`)

3. **Canned fixture pattern for protocol testing**: Fixtures use `readonly` interface fields, include `delay_ms` for timing simulation, and provide `build*Message()` functions that return `Record<string, unknown>` matching wire format. Timing sequences are monotonically non-decreasing (validated by tests). (source: `.devtools/cowork-demo/src/fixtures/cot-events.ts`)

4. **Host environment simulation**: 4 host presets (standalone, iframe_word, iframe_teams, iframe_generic) with different constraints (dimensions, auth, theme, cross-origin). Callback-based event system with unsubscribe functions. Dispose is idempotent. (source: `.devtools/cowork-demo/src/mock-transport/host-environment.ts`)

5. **Mock token provider for auth testing**: Generates JWT-like tokens with inspectable claims (sub, aud, iss, iat, exp, jti). Supports simulated failures, auto-refresh on expiry, and configurable delays. (source: `.devtools/cowork-demo/src/mock-transport/mock-token-provider.ts`)

### Verification Results

- **MessageType enum values verified against source**: `SessionInit='session_init'`, `SessionInitResponse='session_init_response'`, `PptAgentCot='ppt_agent_cot'`, `QueryStatus='query_status'`, `Ping='ping'`, `Pong='pong'` — all match `modules/message-protocol/src/types/message-type.ts:13-164`. (source: `modules/message-protocol/src/types/message-type.ts`)

- **PptAgentCotPayload wire format verified**: Fields `contentType`, `content`, `turnNumber`, `toolName` match exactly at `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:286-295`. (source: `modules/message-protocol/src/types/agents/ppt-agent/messages.ts:286-295`)

### Gotchas

- **`createMockTokenProvider` is duplicated**: A simpler version exists in `mock-augloop-server.ts` (~line 113) alongside the full implementation in `mock-token-provider.ts`. The simpler one is unused externally but could cause confusion. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts:113`, `.devtools/cowork-demo/src/mock-transport/mock-token-provider.ts`)

- **Ask-user events wrapped in `QueryStatus` type**: `buildAskUserMessage` uses `MessageType.QueryStatus` because `AskUserQuestion` doesn't exist on `main` yet — only on uncommitted `feat/PL-W001` branch. This is a pragmatic workaround but should be updated when PL-W001 lands. (source: `.devtools/cowork-demo/src/fixtures/ask-user-events.ts:73`)

- **Timer leak in `full_interactive` scenario**: The 30s timeout timer in `runFullInteractiveScenario` is never cleared if the user answers before timeout. Minor — only affects the `full_interactive` scenario. (source: `.devtools/cowork-demo/src/mock-transport/mock-augloop-server.ts`, `runFullInteractiveScenario` function)

- **ADO MCP tools unavailable fallback**: `mcp__azure-ado__*` tools were not available during this review. Used `az devops invoke` with temp files as fallback. `/dev/stdin` does not work on Windows for `--in-file` — must write to a temp file first. (source: Windows platform constraint)

### ADO API Patterns

- **Post PR thread comment**: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=ISS repositoryId=<id> pullRequestId=<id> --http-method POST --in-file /tmp/review.json` (source: PR-4970916 review workflow)

- **Set reviewer vote**: `az devops invoke --area git --resource pullRequestReviewers --route-parameters project=ISS repositoryId=<id> pullRequestId=<id> reviewerId=<vsid> --http-method PUT --in-file /tmp/vote.json` with body `{"vote":10}` for approve. (source: PR-4970916 review workflow)

- **VSID from prior session**: `1c41d604-e345-64a9-a731-c823f28f9ca8` is the authenticated user's VSID for ADO vote operations. (source: ADO connectionData API)
