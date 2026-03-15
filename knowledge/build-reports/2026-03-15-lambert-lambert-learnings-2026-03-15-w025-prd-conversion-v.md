---
source: lambert-2026-03-15.md
agent: lambert
category: build-reports
date: 2026-03-15
---

# Lambert Learnings — 2026-03-15 (W025 PRD Conversion v2)

## PRD Output
- Wrote `plans/officeagent-2026-03-15.json` with 17 items (P001-P017), 10 open questions
- Strategy: `parallel` (cross-repo work demands independent branches)
- 4 OfficeAgent items (P001-P004, P017), 13 office-bohemia items (P005-P016)

## Corrections to Plan Claims

### 1. CoT is NOT purely file-based — ChainOfThoughtContentNotifier exists
The plan states CoT "currently only writes to file." This is **partially wrong**. The `ChainOfThoughtContentNotifier` interface exists in `modules/chain-of-thought/src/content-handler.ts` with an async `sendChainOfThoughtContent()` method designed to push updates to clients. The `ChainOfThoughtContentHandler` class has a `notifier` field. (source: `modules/chain-of-thought/src/content-handler.ts`)

**Impact:** P002 (CoT WebSocket streaming) is about wiring the existing notifier to a WebSocket handler, not building the notification infrastructure from scratch. Reduces scope.

### 2. Feature gating DOES exist in the Loop monorepo
The plan and prior notes state "Bebop lacks formal feature gating." This is wrong at the monorepo level. Multiple packages use `getFluidExperiencesSetting()` from `@fluidx/utilities` with a `SettingsProvider` pattern. (source: `packages/conversa/src/featuregates/FeatureGates.ts`, also in `packages/conversa-list/`, `packages/video/`, `packages/video-playback/`)

**Impact:** P005 (Bebop cowork feature gate) can follow an established pattern, not invent one from scratch.

### 3. Existing cowork branches in OfficeAgent
The plan doesn't mention that OfficeAgent already has cowork-related branches: `user/mohitkishore/coworkFeatures`, `user/sacra/cowork-officeagent`, `user/spuranda/cowork-prompt-tuning`. These are in `.git/packed-refs`. No active source code on main, but **someone has been working on this**. (source: OfficeAgent `.git/packed-refs`, `.git/FETCH_HEAD`)

**Impact:** Added Q008 to open questions. These branches may contain work to build on or may conflict.

### 4. Cowork route does NOT exist yet
The plan mentions "PR-4959180 prototyped a cowork route" but `_mainLayout.cowork.tsx` does NOT exist in the current office-bohemia working tree. (source: `apps/bebop/src/routes/` directory listing — no cowork route found)

### 5. MessageType enum has 165 entries, includes workspace_chain_of_thought
The existing `workspace_chain_of_thought` type is a batch/final-state type, not a streaming type. New `chain_of_thought_update` type needed for incremental events. (source: `modules/message-protocol/src/types/message-type.ts`)

## Patterns Established

### PRD item sizing for cross-repo work
- **small** = 1-2 files, single concern (type definitions, config) — e.g., P001, P005, P007
- **medium** = 3-5 files, single module boundary — e.g., P002, P003, P009
- **large** = 6+ files or cross-cutting concerns — e.g., P004, P008, P011, P013

### Dependency ordering for cross-repo features
- Protocol types (P001, P007) ship first with zero deps — they're the contract
- Feature gates (P005, P017) ship early to protect routes before functional code lands
- Scaffolding (P006) depends only on gates
- UI components (P008, P010) and protocol adapters (P009) depend on scaffold + types
- Integration layers (P011, P012) come last since they compose everything
- Collaborative state (P013) and annotation integration (P014) are deferrable to v2

### Mirrored types pattern for cross-repo TypeScript
When two repos can't share build artifacts (different Yarn/TS versions), mirror type definitions with a source-reference comment header. The implementing agent creates types in both repos following the same interface. Future sync is manual — flag drift as a maintenance concern.

## Gotchas

- **office-bohemia main branch is `master`**, not `main` — every PR must target master
- **PowerShell required for OfficeAgent** — all yarn/oagent/gulp commands fail in Bash/sh
- **No barrel files in Bebop** — `index.ts` re-exports violate `no-barrel-files` lint rule
- **AugLoop dev endpoint (localhost:11040)** requires a local AugLoop service running — verify availability before P004 implementation begins
- **SharedTree schema changes are irreversible in production** — design schema in P013 carefully, get Fluid team review before merging

```skill
---
name: cross-repo-prd-conversion
description: Convert a cross-repo plan into a parallel-strategy PRD with mirrored types and dependency ordering
allowed-tools: Read, Glob, Grep, Bash, Write, Agent
trigger: when converting a plan that spans multiple repos with different build systems into implementable PRD items
scope: squad
project: any
---

# Cross-Repo PRD Conversion

## When to Use
When a plan spans 2+ repos that cannot share build artifacts (different package managers, TS versions, or build systems).

## Steps

1. **Identify repo boundaries** — List which repos are involved and confirm they have independent build pipelines (check Yarn version, TS version, package manager in each)
2. **Choose parallel strategy** — Cross-repo work MUST use `parallel` branch strategy since items can't share a single feature branch across repos
3. **Extract protocol/type items first** — Any shared types between repos become TWO items: one per repo. Add source-reference comments for future sync tracking
4. **Feature gates ship early** — Create feature gate items with zero dependencies in each repo. All subsequent items depend on their repo's gate
5. **Scaffold before UI** — Feature module scaffolding depends only on gates. UI components depend on scaffold + types
6. **Integration layers last** — Items that compose features across repos (Loop Component wrapper, host testing) depend on all their constituent parts
7. **Defer collaborative state** — SharedTree/DDS items are high-risk due to schema versioning constraints. Mark as low priority unless explicitly required for v1
8. **Validate claims against codebase** — Use Explore agents to verify every claim in the plan (existing interfaces, file locations, patterns). Plans frequently overstate gaps or miss existing infrastructure
9. **Add open questions for ambiguities** — Flag auth flows, host targeting, existing branch conflicts, and team dependencies

## Notes
- Mirror types must include a comment header referencing the source repo and file path
- Always check for existing feature branches in target repos (git packed-refs, FETCH_HEAD) — prior work may exist
- office-bohemia uses `master` as main branch, not `main`
- OfficeAgent requires PowerShell for builds
```
