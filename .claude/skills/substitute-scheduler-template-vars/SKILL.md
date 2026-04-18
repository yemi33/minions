---
created: 2026-04-18
author: Ralph
name: substitute-scheduler-template-vars
description: When adding a new schedule-time template variable (like {{date}}) that must land in the work item before dispatch, extend resolveScheduleTemplateVars in engine/scheduler.js rather than relying on renderPlaybook — playbook render is single-pass and can't reach vars embedded inside task_description.
allowed-tools: Bash, Read, Edit, Grep
trigger: adding schedule-time template vars to engine/scheduler.js
scope: project
project: minions
---

# Scheduler Template Variable Substitution

## Why
`engine/playbook.js::renderPlaybook` is single-pass. When `task_description` is built from `item.title + '\n\n' + item.description` (source: `engine.js:2405`), any `{{var}}` embedded in the schedule's title/description survives substitution and surfaces as "unresolved template variables" warnings plus literal `{{var}}` strings in agent filenames.

## Steps
1. Add/extend `resolveScheduleTemplateVars(str)` in `engine/scheduler.js`. Currently handles `{{date}}`; pattern: `str.replace(/\{\{var\}\}/g, valueProducer())`. Guard non-string inputs with `if (typeof str !== 'string' || str.length === 0) return str;`.
2. Apply it to **both** `sched.title` and `sched.description || sched.title` in the work item emit block — task_description concatenates both, so missing either leaks.
3. Export the helper from `module.exports`.
4. Prefer `shared.dateStamp()` over inline `new Date().toISOString().slice(0,10)` — same output, consistent with `renderPlaybook`'s `{{date}}` source.
5. Add source-level tests for the helper (happy, multi-occurrence, no-op, undefined/null/empty) AND a behavioral test via `discoverScheduledWork`. The behavioral test MUST snapshot/restore `SCHEDULE_RUNS_PATH` with `_captureFileState`/`_restoreFileState` because the scheduler writes through `__dirname`, not `MINIONS_TEST_DIR`.

## Notes
- Don't fix this with multi-pass substitution in `renderPlaybook` — it'll resolve literal `{{...}}` inside agent-authored text (code samples in acceptance criteria, quoted playbook snippets in KB entries).
- Only vars known at schedule time belong here. `{{agent_id}}`, `{{project_name}}`, etc. aren't known yet and must stay in `renderPlaybook`.
