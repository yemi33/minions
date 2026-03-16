---
source: verify-session-summary-2026-03-16.md
agent: verify
category: project-notes
date: 2026-03-16
---

# Cowork UX Testing Session Summary

**Date:** 2026-03-16
**PR:** [PR 4972663](https://office.visualstudio.com/DefaultCollection/OC/_git/office-bohemia/pullrequest/4972663) — [E2E] Claude Cowork UX (8 PRs merged)
**Worktrees:**
- office-bohemia: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob`
- OfficeAgent: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15`

---

## What We Completed

### 1. Full PR Test Suite — All Passing
- **173 unit tests** across 3 OfficeAgent packages (message-protocol: 113, cowork-demo: 49, augloop-transport: 11)
- **5 UI smoke tests** via Playwright through the auth proxy (homepage, feature gate redirect, cowork layout, localStorage persistence, three-panel content)

### 2. Bug Fix — Input Box Flashing
- **Symptom:** Chat input placeholder rapidly toggled between "Connecting..." and "Type a message..."
- **Root cause:** `useConnectionResilience` returned new function objects every render (no `useCallback`). The `useEffect` in `CoworkLayout` depended on `[connect, disconnect]`, so it re-fired every render → called `connect()` → updated atom → re-render → infinite loop.
- **Fix:** Added `useRef` for config callbacks + `useCallback` for all returned functions in `useConnectionResilience.ts`. Changed `CoworkLayout.tsx` effect to `[]` deps.
- **Files changed:**
  - `apps/bebop/src/features/cowork/hooks/useConnectionResilience.ts`
  - `apps/bebop/src/features/cowork/components/CoworkLayout/CoworkLayout.tsx`

### 3. Demo Wiring — Mock Server → Bebop Chat
Wired the Bebop cowork UI to the OfficeAgent mock AugLoop WebSocket server for live interactive testing.
- **Files created:**
  - `apps/bebop/src/features/cowork/hooks/useDemoCoworkSession.ts` — singleton WebSocket hook connecting to mock server
- **Files modified:**
  - `apps/bebop/src/features/cowork/components/CoworkLayout/CoworkLayout.tsx` — swapped to demo hook, added live progression step rendering
  - `apps/bebop/src/features/cowork/components/CoworkLayout/CoworkLayout.module.css` — added step list CSS
  - `apps/bebop/src/features/cowork/components/CoworkChatPanel/CoworkChatPanel.tsx` — swapped to demo hook, fixed `send` vs `sendMessage` mismatch

### 4. Test Report & Documentation
- Full test report: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/test-report-pr4972663.md`
- Detailed results: `C:/Users/yemishin/.squad/notes/inbox/verify-results-2026-03-16.md`

---

## How to Get Testing Working

### Prerequisites
1. Both worktrees checked out and dependencies installed (`yarn`)
2. `az login` completed (tokens expire ~60min, re-run if auth fails)
3. SSL certs and host entry for `m365.cloud.dev.microsoft` set up per Bebop README

### Step-by-Step Startup

**Terminal 1 — Mock AugLoop server:**
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.devtools/cowork-demo"
npx ts-node src/demo-server.ts --scenario=full_interactive --speed=0.5
```
Runs on `ws://localhost:11040/ws`. Health check: `http://localhost:11040/health`.

**Terminal 2 — Bebop dev server with auth proxy:**
```bash
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/apps/bebop"
yarn dev
```
This starts both the Vite dev server (port 3000) and the HTTPS auth proxy (port 3001). First visit will redirect to Microsoft login — complete the MSAL auth flow in the browser.

**Browser:**
Navigate to:
```
https://m365.cloud.dev.microsoft:3001/bebop/cowork?EnableBebopCowork=on
```
The mock server auto-sends an ask-user question on connect. Type any response (e.g. "Executive Summary") and hit Send to trigger the full document creation flow with CoT events, progression steps, and artifact generation.

### Available Mock Scenarios
Start the mock server with `--scenario=SCENARIO`:

| Scenario | Flow |
|---|---|
| `full_interactive` | Ask-user question → wait for answer → CoT + progression + artifact (recommended) |
| `document_creation` | Skips question, immediately streams CoT + progression + artifact |
| `simple` | Minimal 2-event CoT only |
| `error` | CoT then mid-stream failure (tests error UI) |
| `ask_user` | Just the question/answer flow |

Speed: `--speed=0.5` = 2x faster. Default `1.0` = real-time delays.

### Running Unit Tests
```bash
# All three suites
cd "C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15"
powershell.exe -Command "yarn workspace @officeagent/message-protocol test"   # 113 tests
powershell.exe -Command "yarn workspace @officeagent-tools/cowork-demo test"  # 49 tests
powershell.exe -Command "yarn workspace @officeagent/augloop-transport test"  # 11 tests (compiled)
```

---

## Gotchas

### 1. MUST use `yarn dev`, NOT `yarn dev:no-auth` or `npx vite dev`
The Bebop app is a TanStack Start SSR app. Without the auth proxy, the SSR middleware rejects all requests (missing `x-ms-userinfo` header) and returns `{"isNotFound":true}` — a blank JSON page, not HTML. The auth proxy on port 3001 injects MSAL tokens and proxies to Vite on port 3000. **There is no way to test the UI without the auth proxy.**

### 2. MSAL token expiry
The auth proxy's MSAL token expires after ~1 hour. When requests start failing with 302 redirects to `login.microsoftonline.com`, hard-refresh the browser to re-trigger the login flow. The proxy caches the new token automatically.

### 3. `az login` token expiry
Azure CLI tokens also expire (~60 min). If `az` commands fail with auth errors, re-run `az login`. Do NOT use `--use-device-code` (blocked by this org).

### 4. WebSocket doesn't exist in SSR
The `useDemoCoworkSession` hook has `typeof window === 'undefined'` guards. Without them, the SSR crashes with `WebSocket is not defined` and Vite returns an SSR timeout error (`SSR stream transform exceeded maximum lifetime`). If you add any new client-only code to the cowork feature, always guard browser APIs.

### 5. Vite HMR cache corruption
After many rapid file saves, Vite's in-memory module graph can get stale, causing `Failed to fetch dynamically imported module` errors. Fix: kill the dev server and restart `yarn dev`. Hard-refresh (Ctrl+Shift+R) the browser after restart.

### 6. Feature gate URL must include `/cowork` path
The gate query param goes on the cowork route, not the homepage:
- Wrong: `https://m365.cloud.dev.microsoft:3001/bebop/?EnableBebopCowork=on` (shows Bebop homepage)
- Right: `https://m365.cloud.dev.microsoft:3001/bebop/cowork?EnableBebopCowork=on` (shows three-panel cowork UI)

### 7. Port conflicts
Vite picks the first available port starting at 3000. If something else is on 3000, it'll use 3001/3002/etc., which conflicts with the auth proxy on 3001. Kill stale node processes before starting: `powershell.exe -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force"`.

### 8. Mock server must be running before page load
The `useDemoCoworkSession` hook connects to `ws://localhost:11040/ws` on mount. If the mock server isn't running, the WebSocket fails silently and `connectionStatusAtom` stays on `'error'` — the input shows "Connecting..." and stays disabled. Start the mock server first, then navigate to the cowork page.

### 9. Duplicate ask-user question
The `full_interactive` scenario sends the ask-user question twice (mock server quirk — it fires the question fixture on connect, then the document_creation scenario also includes it). This shows as two identical agent messages in the chat. Not a Bebop bug.

### 10. Stale state across navigations
Jotai atoms persist in memory across client-side navigations and HMR reloads. If you see old messages from a previous session, hard-refresh (Ctrl+Shift+R) the page. The `resetCoworkSessionAtom` fires on mount but HMR doesn't always trigger a full remount.

### 11. Bebop typecheck fails (19 errors)
The PR merges 8 independent branches with cross-interface mismatches. `tsc` will fail, but Vite dev mode works because esbuild transpiles without type-checking. Don't run `yarn build --to bebop` expecting it to pass — use `yarn dev` for testing.

### 12. Demo hook is NOT production code
The `useDemoCoworkSession` hook directly connects to `ws://localhost:11040` with hardcoded URL. It's wired in place of `useCoworkSession` for testing only. Before merging, revert `CoworkLayout.tsx` and `CoworkChatPanel.tsx` back to use `useCoworkSession`.
