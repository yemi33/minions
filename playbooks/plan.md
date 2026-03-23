# Playbook: Feature Plan

> Agent: {{agent_name}} | Task: {{task_description}} | ID: {{task_id}}

## Context

Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}
Project path: {{project_path}}

## Mission

A user has described a feature they want built. Your job is to create a detailed implementation plan that a separate agent will later convert into a structured PRD for automatic dispatch to the agent pool.

## The Feature Request

{{plan_content}}

## Steps

### 1. Understand the Request
- Read the feature description carefully
- Identify the core goal, constraints, and success criteria
- Note any ambiguities that need to be called out

### 2. Explore the Codebase
- Read `CLAUDE.md` at repo root and relevant directories
- Map the areas of code that this feature will touch
- Identify existing patterns, conventions, and extension points
- Note dependencies and potential conflicts with in-progress work

### 3. Design the Approach
- Outline the high-level architecture for the feature
- Identify what needs to be created vs modified
- Consider edge cases, error handling, and backwards compatibility
- Note any prerequisites or migrations needed

### 4. Break Down into Work Items
- Decompose into discrete, PR-sized chunks of work
- Order by dependency (foundations first)
- Estimate complexity: `small` (1 file), `medium` (2-5 files), `large` (6+ files)
- Each item should be independently testable

### 5. Write the Plan

Write the plan to: `{{team_root}}/plans/{{plan_file}}`

Use this format:

```markdown
# Plan: {{plan_title}}

**Project:** {{project_name}}
**Author:** {{agent_name}}
**Date:** {{date}}

## Goal
What this feature achieves and why it matters.

## Codebase Analysis
What exists today, what needs to change, key files involved.

## Approach
High-level design decisions and rationale.

## Work Breakdown

### Phase 1: Foundation
1. **Item name** (complexity: small/medium/large)
   - What to build
   - Files to create/modify
   - Acceptance criteria

### Phase 2: Core Implementation
2. **Item name** ...

### Phase 3: Polish & Integration
3. **Item name** ...

## Risks & Open Questions
- Risk or question that needs user input

## Dependencies
- External dependencies or prerequisites
```

## Important

- Do NOT create a git branch, worktree, or PR — this playbook writes minions-internal state only
- Do NOT modify any files in the project repo
- The engine will automatically chain this plan into a PRD conversion step
- Focus on being thorough but actionable — the PRD agent needs clear items to convert

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Team Notes
{{notes_content}}
