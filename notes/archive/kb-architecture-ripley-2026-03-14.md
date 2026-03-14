# Ripley Learnings — 2026-03-14

## What I Learned

### AugLoop ↔ OfficeAgent Connection Pattern
- AugLoop is the orchestration platform that sits between clients (Bebop) and agent containers (OfficeAgent)
- The `OfficeAgentAsync` workflow in AugLoop is stateful and polling-based
- All agent-to-client communication goes through `OfficeAgentPollingResult` annotations
- The `contentOrigin` field on `OfficeAgentPollingResult` discriminates between message types
- `CreateAgentDocumentGenerationStrategy` is the core bridge class in augloop-workflows that manages the WebSocket connection to the agent container

### Cowork Agent Architecture
- New agent type: `cowork-agent` in OfficeAgent repo, extends `BaseAgent`
- Uses Claude Agent SDK directly (like other Tier 1 agents)
- Novel: derives progress from Claude's `TodoWrite` tool calls via `ProgressStateManager`
- Custom MCP tool (`ask_user_question`) for interactive Q&A, flight-gated
- Built-in `AskUserQuestion` tool denied via PreToolUse hook (no stdin in Docker)
- Reuses the existing `OfficeAgentAsync` workflow — no new AugLoop workflow needed

### ADO API Pattern for Fetching PR File Contents
- Use the Items API with `versionDescriptor.version` and `versionDescriptor.versionType=branch` to fetch files from a specific branch
- Format: `/_apis/git/repositories/{repoId}/items?path={path}&versionDescriptor.version={branchName}&versionDescriptor.versionType=branch`
- The Iterations API shows PR push history with descriptions

## Gotchas
- augloop-workflows is a 31GB repo — don't try to clone it
- Cowork message types are currently raw strings cast to `MessageType` (not yet in the published enum)
- The `onFirstMessage` callback pattern on cowork handlers auto-resolves the ChatResponse ACK — cowork agents don't send a dedicated ACK

## Conventions
- AugLoop handlers follow the `IMessageHandler` interface pattern with `handle(message, context, tracker)`
- Agent message types are defined in `@officeagent/message-protocol` (OfficeAgent repo) AND mirrored as local types in augloop-workflows handlers
- Flight gates control feature rollout: e.g., `OfficeAgent.CoworkAgent.EnableAskUserInteractive`
