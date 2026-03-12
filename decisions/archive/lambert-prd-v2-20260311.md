# PRD v2 -- UX-Focused Gap Analysis

**Author:** Lambert (Analyst)
**Date:** 2026-03-11
**Deliverable:** `docs/prd-gaps.json` v2.0.0

## Summary

PRD v2 shifts focus from platform capabilities (v1) to user experience, UI polish, interaction design, and frontend quality. After exploring all UX surfaces in the codebase, 18 missing features were identified.

## Key Findings

1. **No web UI exists.** The test client is a headless Node.js CLI tool. There is no browser-based chat interface for end users or demos.

2. **CLI progress is a static spinner.** The oagent generate command shows "Generating document..." for 30-120 seconds with no stage-level progress, even though chain-of-thought already produces rich progress messages inside the container.

3. **Error messages are generic.** All failures produce "Something went wrong. Please try again in a moment or start a new chat." regardless of cause. Error subtypes (error_max_turns, error_during_execution) are available but discarded during summarization.

4. **No conversation continuity in CLI.** The generate command is single-shot. Multi-turn protocols exist in the WebSocket layer but are not exposed to CLI users.

5. **Eval browser has no accessibility.** No ARIA labels, insufficient color contrast, no responsive layout, no error handling for API failures.

6. **Chain-of-thought translation adds latency.** Every progress message for non-English users triggers a separate Claude Haiku API call for translation instead of using pre-translated templates.

## High-Priority Items (5)

| ID | Name | Complexity |
|----|------|-----------|
| M101 | Web-based chat UI for document generation | large |
| M102 | Real-time progress streaming in CLI | medium |
| M103 | Actionable error messages with recovery guidance | medium |
| M105 | Conversation continuity and iterative refinement | medium |
| M109 | CLI onboarding wizard and first-run experience | medium |

## Medium-Priority Items (7)

M104 (document preview), M106 (eval accessibility), M108 (eval error handling), M110 (generation cancellation), M111 (ETA in progress), M114 (localization quality), M117 (retry for transient failures)

## Low-Priority Items (6)

M107 (eval responsive design), M112 (visualizer modernization), M113 (CLI formatting consistency), M115 (debug timeline polish), M116 (CLI help discoverability), M118 (generation history)

## Open Questions (7)

Q101-Q107 covering: web UI strategy, CLI audience, progress message templating, design system, accessibility standards, REPL mode, and cancellation protocol.
