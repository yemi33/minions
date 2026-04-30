# Docs Playbook

> Agent: {{agent_name}} ({{agent_role}}) | Task: {{item_name}} | ID: {{item_id}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}
Project path: {{project_path}}

## Mission

Update, expand, or rewrite project documentation. Targets include READMEs, CLAUDE.md,
files under `docs/`, JSDoc/TSDoc on exported APIs, and inline comments where they add
real WHY value (not WHAT — the code already says what). Keep voice consistent with the
project's existing docs.

## Task

**{{item_name}}**

{{item_description}}

{{additional_context}}

{{references}}

{{acceptance_criteria}}

## Steps

### 1. Read the doc(s) and the code they describe

- Open the doc(s) being changed end-to-end before writing.
- Read the source they describe — function signatures, exported symbols, config keys,
  CLI flags, file paths. Don't trust the existing doc; trust the code.
- For project-level docs (README, CLAUDE.md, /docs/*.md), skim adjacent docs so your
  voice and structure match.

### 2. Confirm doc reflects current code

For every claim in the doc you're touching, verify it against current code:

- Does the function still exist with that signature?
- Are the file paths correct?
- Are the listed flags / config keys still accepted?
- Are removed features still being documented?
- Are new features (visible in code) missing from the doc?

If the doc describes vapor, delete the section. If real features are missing, add them.

### 3. Write or update concisely

- Match the project's existing voice — read 2-3 nearby docs to calibrate tone.
- Prefer concrete examples over abstract description.
- For code comments: follow the project's "Default to writing no comments" rule
  (CLAUDE.md). Add comments only where they explain WHY a non-obvious choice was made,
  never to restate WHAT the code does.
- For project-level docs: the bar is "would a new contributor understand this?"
- Keep tables, lists, and code blocks formatted consistently with surrounding docs.

### 4. Verify

- Re-read the changed doc end-to-end after editing — does it still flow?
- If the project has doc-validation tests (lint, link-check, snippet-execution), run
  them. Otherwise run `npm test` (or the project's documented test command) to make
  sure nothing else broke.
- For docs with embedded code samples, mentally execute each sample against current
  code — stale samples are worse than missing ones.

## Acceptance

- Doc accurately reflects current code (no vapor, no missing features).
- Voice and structure match the rest of the project's docs.
- For inline code comments: follow project conventions; add comments only where they
  explain WHY, never WHAT.
- For project-level docs: a new contributor could read it and understand the topic.
- Existing tests still pass; any doc-validation tests pass.

## Git Workflow

You are already running in a git worktree on branch `{{branch_name}}`. Do NOT create
additional worktrees — the engine pre-created one for you. Do NOT remove the worktree —
the engine handles cleanup automatically.

Commit only the doc files (and any helper assets they reference). Do not bundle
unrelated code changes into a docs PR.

```bash
git add <doc files>
git commit -m "{{commit_message}}"
git push -u origin {{branch_name}}
```

PR creation is MANDATORY for docs tasks — docs go through the same review flow as code.
Use the appropriate repo-host tooling for PR creation. For Azure DevOps, prefer the
`az` CLI first and use the ADO MCP only as a fallback.

## Rules

- Do NOT modify product code unless the task explicitly asks for it.
- Do NOT add comments that restate what the code does.
- Do NOT invent features that don't exist; verify against current code.
- Read `notes.md` for all team rules before starting.

## When to Stop

Your task is complete once the doc accurately reflects current code, the PR is created
with the changed doc files, and any doc-validation tests pass. Do not continue editing
adjacent docs that weren't part of the task.

## Team Decisions
{{notes_content}}
