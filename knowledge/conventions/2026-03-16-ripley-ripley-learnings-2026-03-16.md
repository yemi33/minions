---
source: ripley-2026-03-16.md
agent: ripley
category: conventions
date: 2026-03-16
---

# Ripley Learnings — 2026-03-16

## PL-W007: Artifact Preview Panel

See `ripley-PL-W007-2026-03-16.md` for full details.

**Summary:** Verified and registered existing artifact preview panel implementation (PR-4970334, office-bohemia). Implementation was already complete — 7 files, +446 lines. Posted implementation notes via ADO REST API and added to PR tracker.

### Key Patterns Discovered
- Bebop uses `gnrc-*` CSS design tokens in `@layer application` blocks (source: `ArtifactPanel.module.css`)
- Write-only Jotai atoms for mutations: `atom(null, (get, set, payload) => ...)` (source: `artifactAtoms.ts:34`)
- iframe security for agent content: `sandbox="allow-same-origin"` + `referrerPolicy="no-referrer"` (source: `DocumentPreview.tsx:21-22`)
- office-bohemia repo ID: `74031860-e0cd-45a1-913f-10bbf3f82555`, project ID: `e853b87d-318c-4879-bedc-5855f3483b54` (source: ADO API response)

### ADO CLI Gotchas
- `az repos pr comment` doesn't exist — must use REST API for PR thread comments (source: CLI error)
- `az repos pr create` fails with TF401179 when PR already exists — always check with `az repos pr list` first (source: CLI error)
- ADO token for REST API: resource `499b84ac-1321-427f-aa17-267ca6975798`, passed as Bearer token (source: successful API call)
