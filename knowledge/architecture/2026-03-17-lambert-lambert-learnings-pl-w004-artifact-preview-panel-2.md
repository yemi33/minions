---
source: lambert-PL-W004-2026-03-17.md
agent: lambert
category: architecture
date: 2026-03-17
---

# Lambert Learnings — PL-W004 Artifact Preview Panel — 2026-03-17

## Task: Implement Artifact Preview Panel — Tabbed Display and Sandbox

### Outcome: Already Implemented — No New PR Required

The artifact preview panel was **already fully implemented** on branch `user/yemishin/cowork-artifact-preview` (PR-4970334, status: approved). All acceptance criteria are met.

## Acceptance Criteria Verification

| Criteria | Status | Source |
|----------|--------|--------|
| HTML artifacts render in sandboxed iframe | PASS | `apps/bebop/src/features/cowork/components/artifacts/DocumentPreview.tsx:21` — `sandbox="allow-same-origin"` attribute on iframe |
| DOCX/PPTX/XLSX show download link with file type icon | PASS | `apps/bebop/src/features/cowork/components/artifacts/DownloadButton.tsx:19-25` — FILE_TYPE_ICONS maps per ArtifactType; lines 53-61 provide download anchor with correct MIME type |
| Multiple artifacts display with tab switching | PASS | `apps/bebop/src/features/cowork/components/artifacts/ArtifactPanel.tsx:57-70` — tab bar rendered when `artifacts.length > 1`, semantic `role="tablist"` and `aria-selected` |
| Artifact appears when agent completes file generation | PASS | `apps/bebop/src/features/cowork/atoms/artifactAtoms.ts:34-40` — `appendArtifactAtom` auto-selects first artifact on arrival |
| artifactUrl populated from ArtifactGenerated message | PASS | `apps/bebop/src/features/cowork/hooks/useDemoCoworkSession.ts` — maps `payload.downloadUrl` to `Artifact.url` on `artifact_ready` events |

## Implementation Architecture (as-built)

### Components (source: `apps/bebop/src/features/cowork/components/artifacts/`)

- **ArtifactPanel.tsx** (94 lines): Tabbed container with 3 states — loading (spinner), empty (placeholder), display (tabs + content). Uses Jotai atoms for all state. No manual memoization (React Compiler handles it).
- **DocumentPreview.tsx** (27 lines): Sandboxed iframe with `sandbox="allow-same-origin"` and `referrerPolicy="no-referrer"`. HTML-only preview.
- **DownloadButton.tsx** (66 lines): File type card with emoji icons, labels, and MIME-typed download link. Supports docx, pptx, xlsx, pdf, html.
- **ArtifactPanel.module.css** (199 lines): CSS Modules with `@layer application`. Uses `--gnrc-*` design tokens. Custom tab bar (no Fluent UI Tab component), scrollbar-hidden overflow, 0.15s transitions.

### State Management (source: `apps/bebop/src/features/cowork/atoms/artifactAtoms.ts`)

- `artifactListAtom`: Base atom — `Artifact[]`
- `selectedArtifactIdAtom`: Base atom — `string | null`
- `selectedArtifactAtom`: Derived atom — returns selected or first artifact
- `artifactLoadingAtom`: Base atom — boolean
- `appendArtifactAtom`: Write-only — appends + auto-selects first
- `removeArtifactAtom`: Write-only — removes + clears selection if needed
- `clearArtifactsAtom`: Write-only — resets all artifact state

### Types (source: `apps/bebop/src/features/cowork/types/coworkTypes.ts:75-82`)

```typescript
type ArtifactType = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'html'
interface Artifact {
  readonly id: string
  readonly name: string
  readonly type: ArtifactType
  readonly url?: string
}
```

## Patterns Discovered

1. **Artifact display bifurcation**: HTML artifacts preview inline (sandboxed iframe), binary files show download card. Decision point is `isPreviewable()` which checks `artifact.type === 'html'`. (source: `ArtifactPanel.tsx:18-20`)

2. **Auto-selection on first arrival**: The `appendArtifactAtom` checks list length after append — if it was the first artifact, it auto-selects. Derived `selectedArtifactAtom` falls back to `artifacts[0]` if selection is stale. (source: `artifactAtoms.ts:34-40,13-26`)

3. **CSS Modules with @layer application**: Bebop cowork components use `@layer application { ... }` wrapper for all styles, with generic design tokens `--gnrc-*` for colors, spacing, typography. No Fluent UI React Tab components — custom semantic HTML buttons with `role="tab"`. (source: `ArtifactPanel.module.css:1`)

4. **Wire-to-UI type mapping via adapter**: Artifact data arrives as `FileInfo` from OfficeAgent wire protocol (with `path`, `fileName`, `fileType`, `fileUrl`), gets mapped to UI `Artifact` type (with `id`, `name`, `type`, `url`) in the message adapter layer. (source: `types/messageProtocol.ts` vs `types/coworkTypes.ts`)

## Gotchas

- **Cowork feature does NOT exist on master**: The entire `apps/bebop/src/features/cowork/` directory is absent from master (verified 2026-03-17). All code lives on feature branches and E2E consolidation branches. PR-4970334 targets master but hasn't merged yet.

- **Sandbox restriction is `allow-same-origin` only**: No `allow-scripts`, `allow-forms`, or `allow-popups`. This means agent-generated HTML cannot execute JavaScript. If future requirements need interactive HTML artifacts (e.g., Chart.js visualizations), the sandbox policy must be relaxed — but this is a security decision.

- **Emoji icons instead of Fluent UI icons**: File type icons use Unicode emoji (📄📊📑🌐) instead of Fluent UI icon components. This works but may not match the design system. Future refinement could use `@fluentui/react-icons` (Document16Regular, Presentation16Regular, etc.).

- **No PDF preview**: PDF artifacts are treated as download-only (same as DOCX/PPTX/XLSX). If PDF inline preview is needed, an `<object>` or `<embed>` element could be used instead of iframe.

## Existing PR Reference

- **PR-4970334**: `feat(cowork): add artifact preview panel with tabbed display and sandboxed iframe` — branch `user/yemishin/cowork-artifact-preview`, status: **approved**
- **PR-4972663**: E2E consolidation PR that merges this and 7 other cowork PRs — branch `e2e/cowork-w025`, status: pending
