# Playbook: Plan → PRD

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

## Your Task

A user has provided a plan. Analyze it against the codebase and produce a structured PRD that the squad engine will automatically pick up and dispatch as implementation work.

## The Plan

{{plan_content}}

## Instructions

1. **Read the plan carefully** — understand the goals, scope, and requirements
2. **Explore the codebase** at `{{project_path}}` — identify what already exists vs what's missing
3. **Break the plan into discrete, implementable items** — each should be a single PR's worth of work
4. **Estimate complexity** — `small` (< 1 file), `medium` (2-5 files), `large` (6+ files or cross-cutting)
5. **Order by dependency** — items that others depend on come first (lower ID = higher priority)
6. **Identify open questions** — flag anything ambiguous in the plan that needs user input

## Output

Write the PRD to: `{{team_root}}/prd/{{project_name_lower}}-{{date}}.json`

**If that file already exists**, append a counter: `{{project_name_lower}}-{{date}}-2.json`, `-3.json`, etc. Do NOT overwrite an existing PRD file — the engine tracks work items by filename.

This file is NOT checked into the repo. The engine reads it on every tick and dispatches implementation work automatically.

```json
{
  "version": "plan-{{date}}",
  "project": "{{project_name}}",
  "source_plan": "{{plan_file}}",
  "generated_by": "{{agent_id}}",
  "generated_at": "{{date}}",
  "plan_summary": "Short title (max ~80 chars, shown in dashboard tiles)",
  "status": "approved",
  "requires_approval": false,
  "branch_strategy": "shared-branch|parallel",
  "feature_branch": "feat/plan-short-name",
  "missing_features": [
    {
      "id": "P001",
      "name": "Short feature name",
      "description": "What needs to be built and why",
      "project": "ProjectName",
      "status": "missing",
      "estimated_complexity": "small|medium|large",
      "priority": "high|medium|low",
      "depends_on": [],
      "acceptance_criteria": [
        "Criterion 1",
        "Criterion 2"
      ]
    }
  ],
  "open_questions": [
    "Question about ambiguity in the plan"
  ]
}
```

## Branch Strategy

Choose one of the following strategies based on how the items relate to each other:

- **`shared-branch`** — All items share a single feature branch. Agents work sequentially, respecting `depends_on` order. One PR is created at the end with all changes. **Use this when items build on each other** (most common for feature plans).
- **`parallel`** — Each item gets its own branch and PR. Items are dispatched independently. **Use this when items are fully independent** and can be reviewed/merged separately.

{{branch_strategy_hint}}

When using `shared-branch`:
- Generate a `feature_branch` name: `feat/plan-<short-kebab-description>` (max 60 chars, lowercase)
- Use `depends_on` to express the ordering — items execute in dependency order
- Each item should be able to build on the prior items' work

When using `parallel`:
- Omit `feature_branch` (the engine generates per-item branches)
- `depends_on` is still respected but items can dispatch concurrently if no deps

Rules for items:
- IDs are `P001`, `P002`, etc. (P for plan-derived)
- All items start with `status: "missing"` — the engine picks these up automatically
- **`project` field is REQUIRED** — set it to the project name where the code changes go (e.g., `"OfficeAgent"`, `"office-bohemia"`). Cross-repo plans must route each item to the correct project. The engine materializes items into that project's work queue.
- `depends_on` lists IDs of items that must be done first
- Keep descriptions actionable — an implementing agent should know exactly what to build
- Include `acceptance_criteria` so reviewers know when it's done
- Aim for 5-25 items depending on plan scope. If more than 25, group related work

## Important

- Write ONLY the single `.json` PRD file to `{{team_root}}/prd/` — do NOT write any `.md` files there
- Do NOT create a git branch, worktree, or PR — this playbook writes squad-internal state only
- Do NOT modify any files in the project repo
- The engine will dispatch implementation agents automatically once the JSON file exists
- For `shared-branch`: agents commit to a single branch — one PR is created automatically when all items are done
- For `parallel`: each agent creates its own branch and PR

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
