# Playbook: Plan → PRD

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

## Your Task

A user has provided a plan. Analyze it against the codebase and produce a structured PRD that the minions engine will automatically pick up and dispatch as implementation work.

## The Plan

{{plan_content}}

## Instructions

1. **Read the plan carefully** — understand the goals, scope, and requirements
2. **Check for an existing PRD** — if the engine provides `existing_prd_json` below, a PRD already exists for this plan. See "Reusing an Existing PRD" section for how to preserve item IDs and done statuses. If no existing PRD is provided, this is a fresh run — all items start as `"missing"`.
3. **Explore the codebase** at `{{project_path}}` — understand the existing structure to write accurate descriptions and acceptance criteria. Do NOT use observations about existing PRs or partial work to set item statuses — status is determined only by existing PRD items (step 2), not codebase state
4. **Break the plan into discrete, implementable items** — each should be a single PR's worth of work
5. **Estimate complexity** — `small` (< 1 file), `medium` (2-5 files), `large` (6+ files or cross-cutting)
6. **Order by dependency** — items that others depend on come first
7. **Use unique item IDs** — generate a short uuid for each item (e.g. `P-a3f9b2c1`). Do not use sequential `P001`/`P002` — IDs must be globally unique across all PRDs to avoid collisions. **If reusing an existing PRD, keep all existing IDs — only generate new UUIDs for genuinely new items.**
8. **Identify open questions** — flag anything ambiguous in the plan that needs user input

## Output

Write the PRD to: `{{team_root}}/prd/{{prd_filename}}`

**CRITICAL: Use the exact filename above.** The engine pre-generates a unique filename to avoid collisions with existing or archived PRDs. Do NOT change or rename it.

This file is NOT checked into the repo. The engine reads it on every tick and dispatches implementation work automatically.

```json
{
  "version": "plan-{{date}}",
  "project": "{{project_name}}",
  "source_plan": "{{plan_file}}",
  "generated_by": "{{agent_id}}",
  "generated_at": "{{date}}",
  "plan_summary": "Short title (max ~80 chars, shown in dashboard tiles)",
  "status": "awaiting-approval",
  "requires_approval": true,
  "branch_strategy": "shared-branch|parallel",
  "feature_branch": "feat/plan-short-name",
  "missing_features": [
    {
      "id": "P-<uuid>",
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
- IDs must be `P-<uuid>` format (e.g. `P-a3f9b2c1`) — globally unique, never sequential
- **`status` is `"missing"` for new items** — do not set `done`, `complete`, `implemented`, or any other value based on codebase observations. The only exception is when reusing an existing PRD (see below) — items already `"done"` in the existing PRD carry forward as `"done"`. Pre-setting any other status on new items causes them to be silently skipped by the engine.
- **Do NOT include a "verify" or "test" or "integration test" item** — the engine automatically creates a verify task when all PRD items are done. Adding one manually creates a duplicate that blocks plan completion.
- **`project` field is REQUIRED** — set it to the project name where the code changes go (e.g., `"OfficeAgent"`, `"office-bohemia"`). Cross-repo plans must route each item to the correct project. The engine materializes items into that project's work queue.
- `depends_on` lists IDs of items that must be done first
- Keep descriptions actionable — an implementing agent should know exactly what to build
- Include `acceptance_criteria` so reviewers know when it's done
- Aim for 5-25 items depending on plan scope. If more than 25, group related work

## Reusing an Existing PRD

When the engine detects an existing PRD for this plan (`source_plan` match), it passes the content below. If this section is empty or absent, skip to normal generation (all items `"missing"` with new UUIDs).

<existing-prd>
{{existing_prd_json}}
</existing-prd>

**When an existing PRD is provided:**

1. **Parse the existing PRD JSON** — extract all `missing_features` items with their `id`, `status`, and metadata
2. **Preserve item IDs** — match existing items to current plan items by name/description similarity. Each plan item that corresponds to an existing PRD item MUST reuse that item's `P-<id>`. Do NOT generate new IDs for items that already exist.
3. **Preserve done items** — any existing item with `"status": "done"` carries forward as `"done"` with the same ID, description, and acceptance criteria. Do NOT reset done items to `"missing"`
4. **Carry forward in-progress items** — items with `"status": "missing"` or other non-done statuses keep their existing ID and reset to `"missing"`
5. **New items only** — only generate new `P-<uuid>` IDs for items in the plan that have no match in the existing PRD
6. **Removed items** — if an existing PRD item has no match in the current plan, drop it from the output
7. **Preserve plan-level fields** — keep `branch_strategy`, `feature_branch`, and `project` from the existing PRD unless the plan explicitly changes them

This ensures re-running plan-to-prd on the same plan produces a clean update (new items added, completed items preserved, IDs stable) rather than a full reset with orphaned duplicates.

## Updating an Existing PRD (Diff-Aware)

If the task description contains `mode: diff-aware-update`, you are updating an existing PRD because the plan was revised. Follow the same reuse rules above, plus these additional diff-aware rules:

**Additional diff-aware rules** (on top of the reuse rules above):
- **Done + modified** (plan added requirements/changed scope) → set `"status": "updated"` with same ID (engine re-opens the work item and dispatches to existing branch)
- **Pending/failed items** → reset to `"missing"` with updated description if the plan changed their scope

## Important

- Write ONLY the single `.json` PRD file to `{{team_root}}/prd/` — do NOT write any `.md` files there
- Do NOT create a git branch, worktree, or PR — this playbook writes minions-internal state only
- Do NOT modify any files in the project repo
- The engine will dispatch implementation agents automatically once the JSON file exists
- For `shared-branch`: agents commit to a single branch — one PR is created automatically when all items are done
- For `parallel`: each agent creates its own branch and PR

## When to Stop

Your task is complete once you have written the PRD JSON file to `{{team_root}}/prd/{{prd_filename}}`. The engine will detect the file and begin dispatching work. Do NOT create branches, PRs, or modify project code. Stop after writing the JSON file.
