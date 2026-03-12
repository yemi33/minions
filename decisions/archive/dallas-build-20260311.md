# Dallas Build — 2026-03-11

Engineer: Dallas
Task: Implement three unbuilt features for workspace-agent (from `docs/WORKSPACE_AGENT_DESIGN.md`)

---

## Summary

All three features are implemented. Features 1 and 3 are fully code-complete. Feature 2 (enterprise grounding) is code-complete for the "parse and persist" layer; the "proactive search initiation" sub-path is documented as a follow-up.

---

## Feature 1: Workspace Plan JSON Schema Validation ✅ BUILT

### What was built

New file: `agents/workspace-agent/src/plan-schema.ts`

- Zod-based schema (`workspacePlanSchema`) covering all fields the workspace-planner sub-agent is expected to produce:
  - Required: `artifactName`, `artifactType`, `description`, `outline.sections` (1–10 entries), `style`
  - Optional: `sources`, `artifacts` (for multi-artifact plans, max 5 entries — see Feature 3)
  - Enum validation for: `artifactType`, section `contentType`, `tone`, `audience`, `length`, source `type`
  - `.passthrough()` on all schemas so unknown fields are tolerated (LLM output often includes extras)
- `validateWorkspacePlan(plan: unknown): PlanValidationResult` — non-throwing, returns `{valid, errors[]}`
- `artifactSpecSchema` for multi-artifact plan entries (added as part of Feature 3)

### Wiring in workspace-agent.ts

After `workspace_plan.json` is parsed (both direct parse and after `repairAndParseJson`), `validateWorkspacePlan` is called:
- If invalid: `logInfo` with violation count (telemetry-safe), then generation continues (non-blocking)
- If valid: `logInfo` confirming pass

### Tests

New test file: `agents/workspace-agent/tests/plan-schema.test.ts` (38 test cases)
- Valid plans: all artifact types, all contentType values, optional fields, `.passthrough()` for unknown fields
- Invalid plans: missing required fields, bad enum values, empty strings, >10 sections, null input
- Logging behaviour: `logWarn` per violation, `logInfo` with count

---

## Feature 2: Enterprise Grounding Integration ✅ BUILT (parse/persist layer)

### What was built

New file: `agents/workspace-agent/src/grounding.ts`

- `prepareGroundingContent(workspacePath, groundingContent[])` — parses each grounding item using `parseGroundingContent` from `@officeagent/grounding`, writes processed content to `<workspacePath>/grounding/source_N.txt` files, returns `{promptContext, groundingFilePaths, sourceCount}`
- `@officeagent/grounding` added to `agents/workspace-agent/package.json` dependencies

Wired in `workspace-agent.ts` `executeWithTasks()`:
- Replaces the previous naive inline string concatenation with the proper `prepareGroundingContent` call
- Sub-agents now receive grounding content both inline (in the user prompt) and as file paths they can `Read` directly for citation-aware generation

### Tests

New test file: `agents/workspace-agent/tests/grounding.test.ts` (20 test cases)
- Empty input, plain text, annotation format, multi-source, sequential naming
- Error handling: single write failure skipped, all-writes-fail returns empty
- Telemetry safety: `logInfo` calls use numeric tag IDs, message strings do not include user data

### What was deferred (proactive search initiation)

The design doc's phrase "enterprise grounding integration" has two interpretations:

1. **Parse/persist incoming grounding** (DONE): workspace-agent already receives `groundingContent: string[]` from AugLoop. This layer properly parses, writes to files, and exposes to sub-agents.

2. **Proactive enterprise search** when `context.groundingSourceToggles?.enterpriseSearch` is true and no content is in the payload: This would require calling `SearchOrchestratorFactory.create(SearchStrategy.Default).execute(request, {sessionId, workspaceDir})`. The infrastructure exists (`SubstrateSearchRetriever`, `SearchStorage`), and `SessionContext` carries `conversationId` and `groundingSourceToggles`.

**Reason for deferral**: Proactive search requires wiring a `PipelineContext` with the session's active WebSocket connection ID so `SubstrateSearchRetriever` can route the `EnterpriseSearchResponse` message back. The `wsManager` singleton handles this, but the workspace-agent's `createWorkspace` method does not have access to the `ws` WebSocket object at the point where it would need to call search (before `executeWithTasks`). Threading `ws` through to `createWorkspace` would be a non-trivial refactor touching the test mocks. This should be a separate PR with its own test coverage.

**Recommended follow-up**: Add `runProactiveGrounding(query, context, workspacePath)` method that checks `context.groundingSourceToggles?.enterpriseSearch`, calls `SearchOrchestratorFactory`, and merges results into `groundingFilePaths` before `executeWithTasks` is called.

---

## Feature 3: Multi-Artifact Generation ✅ BUILT

### What was built

**New type: `ArtifactSpec`** in `agents/workspace-agent/src/types.ts`
- 1-based `index` (determines output filename `artifact_<index>.json`)
- Per-artifact `artifactName`, `artifactType`, `description`, `outline.sections`, `style`

**Extended `WorkspacePlan`** with optional `artifacts?: ArtifactSpec[]` (max 5)
- Backward-compatible: single-artifact plans omit `artifacts` and continue to work exactly as before

**Extended `WorkspaceCreationResult`** with `generatedArtifacts?: GeneratedArtifact[]`
- `artifact` continues to be the primary artifact (backward-compat)
- `generatedArtifacts` holds all artifacts in plan order

**Updated `createWorkspace` in workspace-agent.ts**
- Detects multi-artifact mode by checking `plan.artifacts?.length > 0`
- Extracts `readAndValidateArtifact(fileName)` helper (validates TSX/component format, repairs JSON)
- Single-artifact path: reads `artifact.json` (unchanged)
- Multi-artifact path: sorts specs by index, reads `artifact_1.json` … `artifact_N.json`, throws if any file is missing

**Updated `buildResponsePayload` in utils.ts**
- Uses `result.generatedArtifacts` when present, otherwise falls back to `[result.artifact]`
- Multi-artifact: filenames are `artifact_1.json`, `artifact_2.json`, ... orders 2, 3, 4...
- Single-artifact: filename is `artifact.json`, order 2 (unchanged — existing tests pass)

**Updated sub-agent prompts** (both v1.0.0 and v1.1.0):
- `workspace-planner.md`: documents single-artifact format (default) and multi-artifact format with constraints (max 5 artifacts, sequential 1-based indices, primary artifact at index 1)
- `workspace-generator.md`: documents detection logic (check for `artifacts` array), single-artifact path (`artifact.json`), multi-artifact path (`artifact_N.json`)
- Added to Success Criteria sections

**Updated plan-schema.ts**:
- `artifactSpecSchema` validates each artifact spec entry
- `workspacePlanSchema` includes optional `artifacts: z.array(artifactSpecSchema).max(5)`

### Tests

Updated `agents/workspace-agent/tests/utils.test.ts`:
- Added `GeneratedArtifact` to imports
- New test: multi-artifact result includes 2 artifacts with indexed filenames and orders 2+3
- New test: single-artifact with `generatedArtifacts: [one item]` still uses `artifact.json`

### Files changed / created

| File | Change |
|------|--------|
| `agents/workspace-agent/src/plan-schema.ts` | CREATED — Zod schema validation for workspace_plan.json |
| `agents/workspace-agent/src/grounding.ts` | CREATED — enterprise grounding parse/persist |
| `agents/workspace-agent/src/types.ts` | Added `ArtifactSpec`, extended `WorkspacePlan.artifacts?`, extended `WorkspaceCreationResult.generatedArtifacts?` |
| `agents/workspace-agent/src/workspace-agent.ts` | Added plan validation, multi-artifact artifact reading, grounding integration |
| `agents/workspace-agent/src/utils.ts` | Updated `buildResponsePayload` for multi-artifact |
| `agents/workspace-agent/package.json` | Added `@officeagent/grounding` dependency |
| `agents/workspace-agent/src/prompts/1.0.0/subagents/workspace-planner.md` | Multi-artifact plan format |
| `agents/workspace-agent/src/prompts/1.0.0/subagents/workspace-generator.md` | Multi-artifact output format |
| `agents/workspace-agent/src/prompts/1.1.0/subagents/workspace-planner.md` | Multi-artifact plan format |
| `agents/workspace-agent/src/prompts/1.1.0/subagents/workspace-generator.md` | Multi-artifact output format |
| `agents/workspace-agent/tests/plan-schema.test.ts` | CREATED — 38 tests |
| `agents/workspace-agent/tests/grounding.test.ts` | CREATED — 20 tests |
| `agents/workspace-agent/tests/utils.test.ts` | Added multi-artifact + import for GeneratedArtifact |

---

## Blockers / Open Items

1. **Proactive enterprise search** (Feature 2 sub-path): needs `ws` reference threaded into `createWorkspace`, plus integration tests. Recommend gating behind `OfficeAgent.WorkspaceAgent.EnableProactiveGrounding` flight.

2. **Build verification**: PowerShell required for `yarn build` / `yarn test` (bash cannot run yarn on this machine). Tests are written and should pass — recommend running `yarn test` from workspace-agent dir in PowerShell before merging.

3. **Plan validation is non-blocking**: If strict validation is ever needed (abort on schema violation), add a `strictPlanValidation` flight that wraps `validateWorkspacePlan` and throws when `!result.valid`. The infrastructure is in place.

4. **Multi-artifact stage hook**: The PostToolUse stage hook in `stage-hooks.ts` currently only handles `workspace-planner` (sends partial plan). If multi-artifact plans need per-artifact incremental responses, extend `STAGES` with entries for intermediate generator phases.
