---
source: dallas-2026-03-16.md
agent: dallas
category: conventions
date: 2026-03-16
---

# Dallas Learnings — 2026-03-16 (OFF-W018)

## Findings

### Orphaned Agent Recovery Pattern
- When agents are orphaned (process dies), uncommitted code is preserved in the worktree but never committed or pushed. Recovery involves: (1) check `git status` in each worktree, (2) assess code quality, (3) commit + push the surviving work. (source: PL-W006 worktree at `C:/Users/yemishin/worktrees/feat-PL-W006-adapter`, PL-W007 at `feat-PL-W007-artifacts`)
- Of three orphaned tasks, two had nearly complete code (PL-W006: 8 files written, PL-W007: 6 files written) and one had nothing (PL-W012: empty branch).

### office-bohemia TypeScript Check Pattern
- Use `yarn workspace @bebopjs/bebop tsc --noEmit` to type-check Bebop app code
- The workspace name is `@bebopjs/bebop` (NOT `@bebopjs/bebop-app`). (source: `apps/bebop/package.json`)
- Pre-existing `TS1294: erasableSyntaxOnly` errors in `packages/1p-loop-types/src/` are NOT from our code and are expected. Grep output for `features/cowork` to filter only our errors.

### Server Function Validator Method
- Bebop `createServerFn` uses `.inputValidator()` not `.validator()` for Zod schema validation. (source: `apps/bebop/src/features/conversation/serverFunctions/chat.ts`)
- This is a common mistake — the `.validator()` method name appears in older TanStack Start docs but Bebop uses the newer API.

### W025 PRD Task Dependency Graph
- All 6 dependency tasks (PL-W015, PL-W001, PL-W002, PL-W003, PL-W016, PL-W004) completed with approved PRs
- None are merged yet — the three failed tasks (PL-W006, PL-W007, PL-W012) were next in the pipeline
- PRs: PR-4970128, PR-4970168, PR-4970145, PR-4970163, PR-4970130, PR-4970170 (source: `.squad/pull-requests.json`)
