# Playbook: Analyze and Generate PRD

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.squad/config.json` under `project.repositoryId`.
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}

## Your Task

Generate a new PRD (Product Requirements Document) focused on: **{{focus_area}}**

## Instructions

1. Explore the codebase for gaps in the focus area
2. Read relevant source code, docs, agent CLAUDE.md files
3. Plan the new PRD contents before writing

## Git Workflow (WORKTREE — CRITICAL)

```bash
cd {{team_root}}
git worktree add ../worktrees/prd-{{next_version}} -b prd/{{next_version}} main
cd ../worktrees/prd-{{next_version}}
```

Do ALL work in the worktree. NEVER commit directly to main.

1. Archive the current PRD:
   ```bash
   cp docs/prd-gaps.json docs/archive/prd-gaps-v{{next_version}}.json
   ```

2. Write a new `docs/prd-gaps.json` with:
   - version: `{{next_version}}.0.0`
   - 15-20 missing features focused on {{focus_area}}
   - Use field names: `name` (not title), `estimated_complexity` (not size)
   - All items start with status: `"missing"`
   - Include open questions

3. Commit and push:
   ```bash
   git add docs/prd-gaps.json docs/archive/
   git commit -m "feat(squad): PRD v{{next_version}} — {{focus_area}} gap analysis"
   git push -u origin prd/{{next_version}}
   ```

## Create PR on ADO

Use `mcp__azure-ado__repo_create_pull_request`:
- repositoryId: `{{repo_id}}`
- sourceRefName: `refs/heads/prd/{{next_version}}`
- targetRefName: `refs/heads/main`
- title: `feat(squad): PRD v{{next_version}} — {{focus_area}} gap analysis`
- labels: `["squad:{{agent_id}}"]`

## Clean Up Worktree

```bash
cd {{team_root}}
git worktree remove ../worktrees/prd-{{next_version}} --force
```

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
