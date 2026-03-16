# Cowork Demo Runbook

**Date:** 2026-03-16
**PR:** [PR 4972663](https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663)
**Worktrees:**
- office-bohemia: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob`
- OfficeAgent: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15`

---

## Quick Start (3 terminals)

### Terminal 1 — Mock AugLoop server
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo"
npx ts-node src/demo-server.ts --scenario=full_interactive --speed=0.5
```

### Terminal 2 — Bebop dev server (with auth proxy)
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop"
yarn dev
```
First visit redirects to Microsoft login — complete the MSAL auth flow.

### Browser
```
https://m365.cloud.dev.microsoft:3001/bebop/cowork?EnableBebopCowork=on
```

### How the demo works
1. Page loads → WebSocket connects → input enabled ("Type a message...")
2. Type anything and Send → triggers `session_init` on mock server
3. Mock server fires `ask_user_question` → **AskUserCard** appears with option chips
4. Click an option (or type custom answer) → answer sent back → document creation starts
5. CoT messages stream into chat, progression steps fill center panel, artifact appears

---

## Restarting the Demo (fresh run)

The mock server is **one-shot per connection**. After the scenario plays out, you need:

1. **Ctrl+C** in the mock server terminal
2. Re-run: `npx ts-node src/demo-server.ts --scenario=full_interactive --speed=0.5`
3. **Ctrl+Shift+R** in the browser (hard refresh clears Jotai state)
4. Navigate back to `/bebop/cowork?EnableBebopCowork=on`

---

## Available Scenarios

| Scenario | `--scenario=` | Flow |
|---|---|---|
| Full interactive | `full_interactive` | Ask-user question → wait for answer → CoT + progression + artifact |
| Document creation | `document_creation` | Skips question, streams CoT + progression + artifact immediately |
| Simple | `simple` | Minimal 2-event CoT only |
| Error | `error` | CoT then mid-stream failure |
| Ask user only | `ask_user` | Just the question/answer, no doc creation |

Speed: `--speed=0.5` = 2x faster. Default `1.0` = real-time delays.

---

## What Was Built

### Session Summary

| # | What | Files |
|---|---|---|
| 1 | **173 unit tests passing** | message-protocol (113), cowork-demo (49), augloop-transport (11) |
| 2 | **5 UI smoke tests passing** | Feature gate, redirect, layout, localStorage, three-panel |
| 3 | **Input flashing bug fix** | `useConnectionResilience.ts`, `CoworkLayout.tsx` — added `useCallback` + `useRef` for stable function identity |
| 4 | **Demo WebSocket hook** | `useDemoCoworkSession.ts` — singleton WebSocket connecting to mock server |
| 5 | **Live progression panel** | `CoworkLayout.tsx` + CSS — renders step list with status icons |
| 6 | **AskUserCard component** | `AskUserCard.tsx` + CSS — interactive question card with option chips, following bebop-desktop InputForm design |

### AskUserCard Details
- **Design reference:** `src/components/input-form.tsx` from [bebop-desktop](https://dev.azure.com/open-studio/Prototypes/_git/bebop-desktop?version=GBrylawren%2Ftask-sidepane)
- Single-select: click an option → highlights → auto-submits after 150ms
- Freeform "Something else" input → submit on Enter
- "Skip" button → dismisses without answering
- Slide-up fade animation
- After answering: shows static summary of question + chosen answer
- Keyboard accessible (Enter/Space, aria attributes)

### Files Created
- `components/AskUserCard/AskUserCard.tsx`
- `components/AskUserCard/AskUserCard.module.css`
- `hooks/useDemoCoworkSession.ts`

### Files Modified
- `hooks/useConnectionResilience.ts` — `useCallback` + `useRef` fix for flashing
- `components/CoworkLayout/CoworkLayout.tsx` — demo hook, live progression steps
- `components/CoworkLayout/CoworkLayout.module.css` — step list styles
- `components/CoworkChatPanel/CoworkChatPanel.tsx` — demo hook, AskUserCard rendering
- `atoms/coworkAtoms.ts` — `ActiveQuestion` interface + `activeQuestionAtom`

---

## Gotchas

1. **Must use `yarn dev`**, not `yarn dev:no-auth` or `npx vite dev` — SSR needs auth proxy
2. **MSAL tokens expire ~1 hour** — hard-refresh browser to re-trigger login
3. **`az login` expires ~60 min** — re-run if az commands fail
4. **Guard browser APIs for SSR** — `typeof window === 'undefined'` check required (WebSocket crashes SSR otherwise → `SSR stream transform exceeded maximum lifetime`)
5. **Vite HMR cache corruption** — `Failed to fetch dynamically imported module` error after many file saves. Fix: kill dev server, restart `yarn dev`, hard-refresh browser
6. **URL must include `/cowork` path** — `/bebop/cowork?EnableBebopCowork=on` not `/bebop/?EnableBebopCowork=on`
7. **Port conflicts** — kill stale node processes before starting: `powershell.exe -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"`
8. **Mock server must be running before page load** — WebSocket connects on mount
9. **Duplicate messages** — `full_interactive` scenario fires some fixtures twice (mock server quirk)
10. **Demo hook is NOT production code** — hardcoded `ws://localhost:11040`. Revert `CoworkLayout.tsx` and `CoworkChatPanel.tsx` back to `useCoworkSession` before merging
11. **Bebop typecheck fails (19 errors)** — cross-PR merge conflicts. Vite dev mode works (esbuild skips type-checking)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Failed to fetch dynamically imported module` | Kill dev server → `yarn dev` → Ctrl+Shift+R |
| `{"isNotFound":true}` blank page | Using wrong server. Must use `yarn dev` (auth proxy on :3001) |
| Input says "Connecting..." forever | Mock server not running, or wrong port |
| Nothing happens after Send | Mock server scenario exhausted. Restart mock server + hard-refresh |
| Cowork shows Bebop homepage | Wrong URL. Need `/bebop/cowork?EnableBebopCowork=on` |
| SSR timeout / ECONNRESET | Browser API used without `typeof window` guard. Check recent code changes |
