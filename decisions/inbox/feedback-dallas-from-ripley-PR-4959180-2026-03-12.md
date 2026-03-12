# Review Feedback for Dallas

**PR:** PR-4959180 — Add cowork route to bebop webapp
**Reviewer:** Ripley
**Date:** 2026-03-12

## What the reviewer found

# Ripley Findings — 2026-03-12

## Task: Review PR-4959180 (Add /cowork route to Bebop webapp)

### Verdict: APPROVE

### Codebase Learnings

1. **Bebop route pattern**: New routes in Bebop follow a thin-route pattern under `apps/bebop/src/routes/`. Layout routes are prefixed with `_mainLayout.` (e.g., `_mainLayout.cowork.tsx`). Each route file exports a `Route` created via `createFileRoute` from `@tanstack/react-router`.

2. **Route registration**: `routeTree.gen.ts` is the generated route tree. When adding a new route, it must be registered in multiple places: `FileRoutesByFullPath`, `FileRoutesByTo`, `FileRoutesById`, `FileRouteTypes`, the `@tanstack/react-router` module declaration, and the parent's `RouteChildren` interface + object. Alphabetical ordering is maintained.

3. **Translation prefetching**: Routes that render chat UI prefetch translations in the `loader` function using `getTranslations` with specific namespaces (`CopilotChatInput`, `CopilotLexicalInput`, `CopilotLexicalTextFormatting`). The component then calls `useHydrateTranslations`.

4. **Conversation reset pattern**: Chat routes generate a `resetToken` (via `crypto.randomUUID()`) in the loader. The component uses this token in a `useEffect` to call `resetMessages` (from `resetMessagesAtom` via jotai), ensuring a fresh conversation state on each navigation. The `RealtimeVoiceProvider` is also keyed on `resetToken`.

5. **Main branch is `master`**, not `main`. Use `git diff master...` for PR diffs.

### Patterns to Follow
- When adding Bebop routes: copy `_mainLayout.index.tsx` as a template, change the route path, title, and description.
- Always include the explanatory comment on `useEffect` for conversation reset — the cowork route missed this.

### Gotchas
- `git diff main...` won't work — the branch is `master`.
- `routeTree.gen.ts` is auto-generated but checked in. Don't hand-edit carelessly; follow the exact structure.


## Action Required

Read this feedback carefully. When you work on similar tasks in the future, avoid the patterns flagged here. If you are assigned to fix this PR, address every point raised above.
