# Review Feedback for Rebecca

**PR:** PR-4970405 — feat(cowork): add OfficeAgent protocol adapter for Bebop client
**Reviewer:** Ripley
**Date:** 2026-03-16

## What the reviewer found

# Ripley Learnings — 2026-03-16 (PR-4970405 Review)

## Task
Review PR-4970405: feat(cowork): add OfficeAgent protocol adapter for Bebop client (actual content: Cowork Agent Loop Component package)

## Findings

### PR Title/Content Mismatch
The PR title says "protocol adapter for Bebop client" but the actual changeset creates `packages/cowork-component` — a Loop Component package, not a protocol adapter. (source: PR-4970405 diff vs title)

### Loop Component Registration ID Convention
Existing Loop Components use namespaced registration IDs:
- `@fluidx/video` (source: `packages/video/src/LoopRegistrationId.ts:1`)
- `@ms/youtube`, `@ms/figma`, `@ms/google-docs`
- `@fluidx/bing-acf-loop`, `@fluidx/mcp-app-loop`

PR-4970405 uses bare `cowork-agent` without namespace prefix. Should follow `@fluidx/cowork-agent` pattern. (source: `packages/cowork-component/src/CoworkComponentFactory.ts:10`)

### manifest-entry.ts Pattern Does Not Exist in Repo
Zero existing Loop Component packages have a `manifest-entry.ts` file. Components register through NpmCodeLoader + SharedLoopComponentFactory only. The URL unfurling patterns and creation menu metadata in this PR's `manifest-entry.ts` don't plug into any existing infrastructure. (source: repo-wide grep for "manifest-entry" — zero matches)

### Missing @fluidframework/synthesize Dependency
`dependencies.ts` imports `IFluidDependencySynthesizer` from `@fluidframework/synthesize/legacy` but this dependency is not declared in `package.json`. Compare `packages/loop-starter-component/package.json:42` which correctly declares it. (source: `packages/cowork-component/src/dependencies.ts:1` vs `packages/cowork-component/package.json`)

### Type Assertion Violations in CoworkDependencyContainer
Three `as` assertion violations in `dependencies.ts`:
- `return local as T;` (~line 149)
- `(this.#parent as unknown as CoworkDependencyContainer).resolve<T>(type)` (~line 153)
- `(this.#parent as unknown as CoworkDependencyContainer).has(type)` (~line 161)

The double casts indicate the class doesn't properly implement `IFluidDependencySynthesizer`. (source: `packages/cowork-component/src/dependencies.ts`)

### Non-Fluid Loop Component Pattern (Verified)
Non-Fluid Loop Components follow this established pattern:
1. Component class implements `ProvideHTMLViewable` (source: `packages/loop-starter-component/src/LoopStarterComponent.ts`)
2. View class implements `HTMLView` with `render(element: HTMLElement)` (source: `packages/loop-starter-component/src/view/LoopStarterComponentView.tsx`)
3. Factory: `export const loopExport = new SharedLoopComponentFactory(ComponentClass)` (source: same)
4. NpmCodeLoader: `canLoad()` + `load()` with dynamic import (source: `packages/video/src/NpmCodeLoader.ts`)
5. Package entry point is `NpmCodeLoader.ts` (source: package.json `main` field convention)

### React 18 is Correct for Loop Component Packages
Loop Component packages target React 18 because they run in Loop App hosts (React 18). Bebop (React 19) is a separate app. The PR correctly uses `react: ^18.3.0`. (source: `packages/cowork-component/package.json` dependencies)

### suspend/resume Pattern
The suspend/resume implementation re-renders with a `suspended` prop rather than unmounting the React tree. This preserves React state during visibility changes. Clean approach not seen in other Loop Components but architecturally sound for agent session continuity. (source: `packages/cowork-component/src/CoworkComponentView.tsx`)

### ADO Vote Fallback Pattern
When `mcp__azure-ado__*` tools are unavailable:
1. Post thread: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=OC repositoryId={id} pullRequestId={prId} --http-method POST --in-file $TEMP/review.json`
2. Set vote: `az devops invoke --area git --resource pullRequestReviewers --route-parameters project=OC repositoryId={id} pullRequestId={prId} reviewerId={vsid} --http-method PUT --in-file $TEMP/vote.json`
3. Get VSID: `az repos pr show --id {prId}` → parse `reviewers[].id` or `createdBy.id`
(source: PR-4970405 review workflow)

## Verdict
APPROVE WITH SUGGESTIONS (vote: 5). Package structure follows established Loop Component patterns. Missing dependency and type assertion violations need fixing before merge.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
