---
source: dallas-OFF-W018-2026-03-16.md
agent: dallas
category: build-reports
date: 2026-03-16
---

# Dallas — OFF-W018: Restart Three Failed W025 Tasks (Assessment)

**Date:** 2026-03-16
**Task:** Verify state of three failed W025 PRD tasks and assess readiness for retry
**Status:** Assessment complete — all three tasks have clear paths to completion

---

## Three Failed Tasks Identified

| ID | Plan Item | Title | Assigned To | Fail Reason |
|----|-----------|-------|-------------|-------------|
| PL-W006 | P009 | OfficeAgent protocol adapter (Bebop client) | Rebecca | Orphaned — no process, silent for 1204s |
| PL-W007 | P010 | Artifact preview panel | Dallas | Orphaned — no process, silent for 1248s |
| PL-W012 | P015 | Cowork telemetry hooks | Ralph | Orphaned — no process, silent for 1207s |

All three failed due to process death (orphaned), not code errors. All target office-bohemia repo (Bebop app).

---

## Current State Assessment

### PL-W006: OfficeAgent Protocol Adapter (Rebecca's work)
**Worktree:** `C:/Users/yemishin/worktrees/feat-PL-W006-adapter`
**Branch:** `user/yemishin/cowork-protocol-adapter`
**State:** ✅ Code written, ⚠️ NOT COMMITTED, ⚠️ 3 issues found

**Files present (all untracked):**
- `server/augloopTransport.ts` — Complete, 375 lines. WebSocket lifecycle, reconnect, auth refresh. Excellent quality.
- `server/messageAdapter.ts` — Complete, 315 lines. Pure functions mapping OfficeAgent messages to Jotai atoms. Excellent quality.
- `server/streamingBridge.ts` — 95% complete, 236 lines. Missing transport registration in activeTransports map.
- `serverFunctions/coworkSession.ts` — 85% complete, 180 lines. Uses `.validator()` instead of correct `.inputValidator()` method.
- `types/messageProtocol.ts` — Complete, 236 lines. Proper mirrored types with string unions, readonly fields, source references.
- `types/coworkTypes.ts` — Complete, 109 lines. Clean UI-layer type hierarchy.
- `hooks/useCoworkStream.ts` — 95% complete, 219 lines. JSDoc mentions `isConnected` not in return value.
- `atoms/coworkAtoms.ts` — Complete, 117 lines. Proper Jotai patterns.

**Issues requiring fixes:**
1. **CRITICAL**: `streamingBridge.ts` — Transport not registered in `activeTransports` map (source: streamingBridge.ts, coworkSession.ts)
2. **CRITICAL**: `coworkSession.ts` — Uses `.validator()` instead of `.inputValidator()` (source: reference pattern at `conversation/serverFunctions/chat.ts`)
3. **MEDIUM**: `useCoworkStream.ts` — JSDoc mismatch (says `isConnected` but doesn't export it)

**TypeScript check:** ✅ No cowork-specific errors (only pre-existing monorepo `erasableSyntaxOnly` errors in `1p-loop-types`)

### PL-W007: Artifact Preview Panel (Dallas's work)
**Worktree:** `C:/Users/yemishin/worktrees/feat-PL-W007-artifacts`
**Branch:** `user/yemishin/cowork-artifact-preview`
**State:** ✅ Code written, ⚠️ NOT COMMITTED (scaffold committed, artifacts not)

**Files present (untracked/modified):**
- `atoms/artifactAtoms.ts` — Complete. Jotai atoms for artifact list, selection, loading.
- `components/artifacts/ArtifactPanel.tsx` — Complete. Tabbed container with accessibility (ARIA roles). Shows tabs only when >1 artifact.
- `components/artifacts/ArtifactPanel.module.css` — Complete. CSS layer with `--gnrc-*` tokens matching monorepo conventions.
- `components/artifacts/DocumentPreview.tsx` — Complete. Sandboxed iframe with `allow-same-origin`, `no-referrer`.
- `components/artifacts/DownloadButton.tsx` — Complete. File type icons, MIME types, proper download attribute.
- `components/CoworkLayout/CoworkLayout.tsx` — Modified to integrate ArtifactPanel.
- `atoms/coworkAtoms.ts` — Modified to reset artifact state on session end.

**Issues:** None. All files are production-ready.

**TypeScript check:** ✅ No cowork-specific errors

### PL-W012: Cowork Telemetry Hooks (Ralph's work)
**Worktree:** `C:/Users/yemishin/worktrees/feat-PL-W012-telemetry`
**Branch:** `user/yemishin/cowork-telemetry`
**State:** ❌ NO WORK DONE. Branch is at same commit as master.

**Required implementation:**
- `apps/bebop/src/features/cowork/hooks/useCoworkTelemetry.ts` — Track time-to-first-progression, agent RTT, user interactions
- Wire into `@bebopjs/bebop-telemetry` infrastructure
- Track Web Vitals for /cowork route
- Include flight state in telemetry events

---

## Dependencies (All Complete ✅)

| PRD Item | Title | PR | Status |
|----------|-------|----|--------|
| PL-W015 (P001) | CoT + ask-user protocol types | PR-4970128 | ✅ Approved |
| PL-W001 (P002) | CoT WebSocket streaming | PR-4970168 | ✅ Approved |
| PL-W002 (P003) | Ask-user-question handler | PR-4970145 | ✅ Approved |
| PL-W003 (P004) | AugLoop transport module | PR-4970163 | ✅ Approved |
| PL-W016 (P005) | Bebop cowork feature gate | PR-4970130 | ✅ Approved |
| PL-W004 (P006) | Cowork feature scaffold | PR-4970170 | ✅ Approved |

All dependency PRs exist and are approved. None are merged to main/master yet.

---

## Recommended Actions for Re-dispatch

### PL-W006 (Protocol Adapter) — NEEDS FIXES + COMMIT
1. Fix `.validator()` → `.inputValidator()` in `coworkSession.ts`
2. Add `registerTransport()` call in `streamingBridge.ts` after session init
3. Fix JSDoc in `useCoworkStream.ts` or add `isConnected` to return
4. Git add + commit all untracked files
5. Push branch and create PR targeting `master`
**Estimated effort:** ~30 minutes (fixes only, code is 90% done)

### PL-W007 (Artifact Preview) — NEEDS COMMIT ONLY
1. Git add all untracked/modified files
2. Commit with message: `feat(cowork): add artifact preview panel with tabbed display and sandboxed iframes`
3. Push branch and create PR targeting `master`
**Estimated effort:** ~10 minutes (code is 100% done)

### PL-W012 (Telemetry) — NEEDS FULL IMPLEMENTATION
1. Create `useCoworkTelemetry.ts` hook following `@bebopjs/bebop-telemetry` patterns
2. Track: time-to-first-progression-step, agent RTT, send/answer/download events, Web Vitals
3. Include `cowork.enabled` flight state in events
4. Commit, push, create PR targeting `master`
**Estimated effort:** ~1 hour (full implementation needed)

---

## Build Status

- **PL-W006 worktree:** TypeScript ✅ (no cowork errors)
- **PL-W007 worktree:** TypeScript ✅ (no cowork errors)
- **PL-W012 worktree:** N/A (no code to build)

---

## Findings

### Patterns Discovered
- **Orphaned processes lose all uncommitted work**: All three tasks had worktrees created and code written, but processes died before committing. Rebecca's PL-W006 has 8 complete files that were never committed. (source: git status in each worktree)
- **office-bohemia pre-existing TS errors**: The monorepo has ~16+ `TS1294: erasableSyntaxOnly` errors in `1p-loop-types` package. These are NOT from our code and don't block builds. (source: `yarn workspace @bebopjs/bebop tsc --noEmit`)
- **Server function validator method**: Bebop uses `.inputValidator()` not `.validator()` on `createServerFn` chains. (source: `apps/bebop/src/features/conversation/serverFunctions/chat.ts`)

### Gotchas
- **office-bohemia main branch is `master`** not `main` — all PRs must target `master` (source: git branch -r)
- **No barrel files** — Bebop enforces `no-barrel-files` lint rule (source: apps/bebop/CONTRIBUTING.md)
- **PowerShell required** for yarn commands in office-bohemia (source: CLAUDE.md)
