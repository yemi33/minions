---
source: ripley-2026-03-16.md
agent: ripley
category: conventions
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16 (PR-4970334 Review)

## PR Review: feat(cowork): add artifact preview panel

**PR-4970334** in office-bohemia (repo `74031860-e0cd-45a1-913f-10bbf3f82555`), branch `user/yemishin/cowork-artifact-preview` targeting `master`.

### Patterns Discovered

- **Artifact types in cowork feature**: `ArtifactType = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'html'` defined in `apps/bebop/src/features/cowork/types.ts`. HTML artifacts are previewed in sandboxed iframes; binary files get download cards. (source: PR-4970334, `types.ts`)

- **Write-only atom pattern in Bebop Jotai**: Cowork uses `atom(null, (get, set, arg) => ...)` for mutations (`appendArtifactAtom`, `removeArtifactAtom`, `clearArtifactsAtom`). This encapsulates state updates and prevents external mutation of base atoms. (source: PR-4970334, `artifactAtoms.ts`)

- **Derived atom with fallback**: `selectedArtifactAtom` reads both list and selection atoms, falling back to first item if selection is null or stale. This is a clean pattern for tab-selection UIs. (source: PR-4970334, `artifactAtoms.ts:13-26`)

- **CSS Modules with @layer application**: Bebop CSS modules wrap all rules in `@layer application {}`. This controls cascade specificity ordering. (source: PR-4970334, `ArtifactPanel.module.css`)

- **Design tokens in Bebop CSS**: Variables follow `--gnrc-*` naming convention (e.g., `--gnrc-color-text-primary`, `--gnrc-padding-relaxed-small`, `--gnrc-font-size-200`). (source: PR-4970334, `ArtifactPanel.module.css`)

- **Cross-repo PR branch naming**: This PR uses `user/yemishin/cowork-artifact-preview` which follows the `user/yemishin/<feature>` convention. (source: PR-4970334)

### Gotchas

- **Sandbox security constraint**: `sandbox="allow-same-origin"` on iframes is safe only when `allow-scripts` is NOT present. If both are combined in a future edit, sandbox protections are effectively nullified. (source: PR-4970334, `DocumentPreview.tsx`)

- **Jotai v2 get-after-set semantics**: In `appendArtifactAtom`, `get(artifactListAtom)` after `set(artifactListAtom, ...)` returns the new value in Jotai v2. This is non-obvious and differs from some other state management libraries. (source: PR-4970334, `artifactAtoms.ts:34-40`)

- **office-bohemia PR diff not available via az CLI**: `az repos pr diff` is not a valid command. Must use REST API to fetch individual file contents from commit/branch. Workflow: get commit list from `/pullRequests/{id}/commits`, then fetch files via `/items?path=...&versionDescriptor.version=...`. (source: direct experience during this review)

- **Cross-repo PR review from OfficeAgent repo**: PR-4970334 is in office-bohemia but was dispatched for review from OfficeAgent context. The branch doesn't exist in OfficeAgent's remote — must use ADO REST API to fetch files directly from office-bohemia's repo ID `74031860-e0cd-45a1-913f-10bbf3f82555`. (source: direct experience)

### Review Verdict
- **APPROVE with suggestions** (vote: 5)
- 5 non-blocking suggestions: sandbox comment, Jotai semantics comment, aria-live on states, emoji→Fluent icons, tab overflow UX
