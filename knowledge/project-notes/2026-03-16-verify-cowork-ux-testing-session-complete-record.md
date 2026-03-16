---
source: verify-cowork-session-2026-03-16.md
agent: verify
category: project-notes
date: 2026-03-16
---

# Cowork UX Testing Session — Complete Record

**Date:** 2026-03-16
**PR:** [PR 4972663](https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663)
**Branch:** `e2e/cowork-w025` (office-bohemia), also pushed as `e2e/cowork-w025-demo-fixes`
**Worktrees:** OB: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob` | OfficeAgent: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15`

---

## What Was Done

### 1. Full PR Test Suite — 173 unit tests + 5 UI smoke tests passing
- message-protocol: 113, cowork-demo: 49, augloop-transport: 11
- UI: feature gate, redirect, cowork layout, localStorage persistence, three-panel content

### 2. Bug Fix: Input Box Flashing
- **Root cause:** `useConnectionResilience` returned new function objects every render → infinite re-render loop
- **Fix:** `useCallback` + `useRef` for stable function identity in `useConnectionResilience.ts` + `[]` deps in `CoworkLayout.tsx`

### 3. Demo WebSocket Hook (`useDemoCoworkSession`)
- Singleton WebSocket connecting to mock AugLoop server (`ws://localhost:11040/ws`)
- Session init deferred until user's first message (no auto-fire)
- Dispatches mock server events to Jotai atoms (CoT → chat, progression → steps, artifacts → panel)
- SSR-safe (`typeof window` guards)

### 4. AskUserCard Component
- Interactive question card with selectable option chips, following [bebop-desktop InputForm](https://dev.azure.com/open-studio/Prototypes/_git/bebop-desktop?version=GBrylawren%2Ftask-sidepane) design
- Single-select auto-submits on click (150ms delay), freeform input, Skip button
- Slide-up fade animation, static summary after answering, keyboard accessible

### 5. Live Progression Panel
- Step list with status icons (checkmark/spinner/circle) and detail text
- CSS for step items matching Fluent design tokens

### 6. Merged master to resolve yarn.lock conflict

---

## Files Changed (pushed to PR)

| File | Change |
|---|---|
| `components/AskUserCard/AskUserCard.tsx` | NEW — interactive question card |
| `components/AskUserCard/AskUserCard.module.css` | NEW — card styles |
| `hooks/useDemoCoworkSession.ts` | NEW — singleton WebSocket demo hook |
| `hooks/useConnectionResilience.ts` | FIX — useCallback + useRef for stable identity |
| `components/CoworkLayout/CoworkLayout.tsx` | MOD — demo hook, live progression steps |
| `components/CoworkLayout/CoworkLayout.module.css` | MOD — step list styles |
| `components/CoworkChatPanel/CoworkChatPanel.tsx` | MOD — demo hook, AskUserCard rendering |
| `atoms/coworkAtoms.ts` | MOD — ActiveQuestion interface + activeQuestionAtom |

---

## Demo Runbook

### Setup (3 terminals)

**Terminal 1 — Mock server:**
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo"
npx ts-node src/demo-server.ts --scenario=full_interactive --speed=0.5
```

**Terminal 2 — Bebop:**
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop"
yarn dev
```

**Browser:** `https://m365.cloud.dev.microsoft:3001/bebop/cowork?EnableBebopCowork=on`

### Flow
1. Type anything → Send → session_init fires
2. AskUserCard appears with options → click one
3. CoT + progression + artifacts stream in

### Restart: Ctrl+C mock server → re-run → Ctrl+Shift+R browser

### Scenarios
- `full_interactive` — question → answer → doc creation (recommended)
- `document_creation` — skips question, immediate streaming
- `simple` — minimal 2-event CoT
- `error` — mid-stream failure

---

## Gotchas

1. **Must use `yarn dev`** — SSR needs auth proxy (not `yarn dev:no-auth`)
2. **`Failed to fetch dynamically imported module`** — stale Vite cache. Kill server → `yarn dev` → Ctrl+Shift+R
3. **URL must include `/cowork`** — not `/bebop/?EnableBebopCowork=on`
4. **Guard browser APIs for SSR** — `typeof window === 'undefined'` (WebSocket crashes SSR)
5. **MSAL tokens expire ~1hr** — hard-refresh to re-login
6. **Mock server is one-shot** — restart after each scenario run
7. **Port conflicts** — kill stale node: `powershell -Command "Get-Process node | Stop-Process -Force"`
8. **Demo hook is NOT production code** — revert to `useCoworkSession` before merging
9. **Bebop typecheck fails (19 errors)** — cross-PR conflicts, Vite dev works (esbuild skips tsc)
10. **Duplicate messages** — `full_interactive` fires some fixtures twice (mock server quirk)

---

## Code Review Findings

### Protocol Type Alignment — Critical Mismatches
| Area | Bebop | OfficeAgent | Severity |
|---|---|---|---|
| SessionInit payload | `agentId`, `prompt`, `flights?` | `settings` (OfficePySettings) | CRITICAL |
| SessionInitResponse | `sessionId`, `agentId`, `version` | `containerInstanceId`, `officeAgentVersion?` | CRITICAL |
| FileInfo | `fileId`, `fileName`, `fileType` | `path`, `content?`, `filename?` | CRITICAL |
| Error payload | `{ message, code? }` | `{ errorMsg }` | HIGH |
| CoT events | `label`, numeric timestamp | `stepLabel`, ISO 8601, required turnNumber | HIGH |

### Feature Gate Inconsistency
- `featureGates.ts` uses ECS key `'bebop.cowork.enabled'`
- Route uses `'EnableBebopCowork'` query param / localStorage
- These are completely disconnected

### Test Coverage Gap
- Only 1 test file for entire cowork feature (26 files, ~3,578 lines)
- That test (`featureGates.test.ts`) doesn't run (`import.meta.env` in Jest CJS)
- `cowork-component` package has 0 test files

---

## Test Report
Full detailed report: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/test-report-pr4972663.md`
