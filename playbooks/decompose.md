# Playbook: Task Decomposition

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

## Your Task

A work item has been flagged as too large for a single agent dispatch. Analyze the item and break it into 2-5 smaller, independently implementable sub-tasks.

## Work Item

- **ID:** {{item_id}}
- **Title:** {{item_name}}
- **Description:** {{item_description}}
- **Complexity:** {{item_complexity}}
- **Project:** {{project_name}} (`{{project_path}}`)

{{#acceptance_criteria}}
## Acceptance Criteria

{{acceptance_criteria}}
{{/acceptance_criteria}}

## Working Style

Use subagents only for genuinely parallel, independent tasks. For codebase exploration, reading files, and writing the decomposition output, work directly — do not spawn subagents.

## Instructions

1. **Explore the codebase** at `{{project_path}}` — understand the existing structure, patterns, and dependencies
2. **Analyze the work item** — identify distinct units of work that can be implemented as separate PRs
3. **Break into 2-5 sub-tasks** — each should be:
   - Small or medium complexity (not large)
   - A single PR's worth of work
   - Independently testable
   - Clear enough for another agent to implement without ambiguity
4. **Order by dependency** — if sub-task B needs sub-task A's code, declare `depends_on`
5. **Generate unique IDs** — use format `{{item_id}}-a`, `{{item_id}}-b`, etc.

## Output

Write the decomposition result as a JSON code block in your response:

```json
{
  "parent_id": "{{item_id}}",
  "sub_items": [
    {
      "id": "{{item_id}}-a",
      "name": "Short descriptive name",
      "objective": "One-sentence goal — what this sub-task achieves in the overall plan.",
      "description": "What to build, where, and how. Be specific enough that an engineer can implement without further exploration.",
      "expected_output": "What 'done' looks like — artifact produced, PR shape, file format, or observable behavior.",
      "scope_boundaries": ["What is explicitly OUT of scope for this sub-task", "Another exclusion"],
      "estimated_complexity": "small|medium",
      "depends_on": [],
      "acceptance_criteria": ["Verifiable criterion 1", "Verifiable criterion 2"]
    }
  ]
}
```

Keep the total number of sub-items between 2 and 5. If the task genuinely cannot be broken down further, output a single sub-item that matches the original.

{{pr_create_instructions}}

{{pr_comment_instructions}}

## When to Stop

Your task is complete once you have output the JSON decomposition block. The engine parses it from your output. Do NOT begin implementing the sub-items. Stop after outputting the JSON.
