---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (Plan Verification Re-run)

## Context
Re-ran plan verification for Claude Cowork UX (officeagent-2026-03-15.json). Worktrees and E2E PRs already existed from prior verification runs. Focused on rebuilding, retesting, and updating the manual testing guide.

## Findings

### Worktree Reuse Saves Significant Time
Prior verification runs had already created both worktrees (`verify-officeagent-2026-03-15` for OA, `verify-officeagent-2026-03-15-ob` for OB) and E2E PRs (PR-4972662, PR-4972663). Checking for existing worktrees before creating new ones saved ~10 minutes of fetch+merge+conflict-resolution time. (source: `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15/.git`, `C:/Users/yemishin/worktrees/verify-officeagent-2026-03-15-ob/.git`)

### TypeScript Errors Down from 19 to 17
office-bohemia typecheck now shows 17 errors in 5 files (down from 19 in 6 files). Files affected: `pas.config.ts:1`, `CoworkErrorBoundary.tsx:32`, `useCoworkStream.ts:15` (8 errors), `streamingBridge.ts:22` (5 errors), `transportRegistry.ts:9`. The reduction suggests some cross-PR integration issues were resolved in master merge commits. (source: `yarn lage typecheck --to @bebopjs/bebop` output)

### Bebop Dev Server Port Assignment
Vite dev server binds to port 3000 when available (not 3002 as documented in prior guide). Port 3002 was from a prior run where 3000/3001 were occupied. Always verify actual port after starting. (source: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000`)

### node_modules Present But No Integrity File
Both worktrees had `node_modules/` directories with packages but no `.yarn-integrity` file. Yarn workspace builds still succeeded — integrity check is optional for workspace protocol resolution. No `yarn install` needed. (source: `ls node_modules/.yarn-integrity` returned "need install" but builds passed)

### cowork-demo Package Name Convention
The cowork-demo package uses `@officeagent-tools/cowork-demo` (not `@officeagent/cowork-demo`). Tools/devtools packages use the `@officeagent-tools/` scope prefix. (source: `.devtools/cowork-demo/package.json:2`)

### All Cowork Test Suites Passing
- message-protocol: 113 tests, 2 suites, 5.15s
- augloop-transport: 11 tests pass (1 suite fails on babel `import type` — pre-existing)
- cowork-demo: 49 tests, 4 suites, 24.7s
Total: 173 passing tests across plan items. (source: `yarn workspace @officeagent/message-protocol test`, `yarn workspace @officeagent/augloop-transport test`, cowork-demo `npx jest`)

## Patterns

### Verification Re-run Workflow
1. Check if worktrees exist before creating
2. Check if E2E PRs exist before creating
3. Build individual packages (avoid Docker requirement)
4. Run tests per package
5. Start dev server + mock server
6. Update existing testing guide (don't recreate)

## Gotchas
- `yarn workspace cowork-demo build` fails — must use full scoped name `@officeagent-tools/cowork-demo`
- Mock AugLoop server at ws://localhost:11040/ws returns 404 on HTTP root (expected — WebSocket only)
- TanStack Start SSR returns `{"isNotFound":true}` for unauthenticated curl requests — this is expected behavior, not an error
