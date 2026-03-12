# Explore Playbook

> Agent: {{agent_name}} | Task: {{task_description}} | ID: {{task_id}}

## Context

Repository ID: from `.squad/config.json` under `project.repositoryId`
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}
Team root: {{team_root}}

## Mission

Explore the codebase area specified in the task description. Your primary goal is to understand the architecture, patterns, and current state of the code. If the task asks you to produce a deliverable (design doc, architecture doc, analysis report), create it and commit it to the repo via PR.

## Steps

### 1. Read Project Documentation
- Read `CLAUDE.md` at repo root and in relevant agent/module directories
- Read `docs/BEST_PRACTICES.md` if it exists
- Read any README.md files in the target area

### 2. Explore Code Structure
- Map the directory structure of the target area
- Identify key files: entry points, registries, configs, tests
- Note patterns: how agents are structured, how modules connect, how prompts are organized

### 3. Analyze Architecture
- How does data flow through the system?
- What are the dependencies between components?
- Where are the extension points?
- What conventions are followed?

### 4. Document Findings
Write your findings to `{{team_root}}/decisions/inbox/{{agent_id}}-explore-{{task_id}}-{{date}}.md` with these sections:
- **Area Explored**: what you looked at
- **Architecture**: how it works
- **Patterns**: conventions and patterns found
- **Dependencies**: what depends on what
- **Gaps**: anything missing, broken, or unclear
- **Recommendations**: suggestions for the team

### 5. Create Deliverable (if the task asks for one)
If the task asks you to write a design doc, architecture doc, or any durable artifact:
1. Create a git worktree: `git worktree add ../worktrees/explore-{{task_id}} -b feat/{{task_id}}-<short-desc> {{main_branch}}`
2. Write the document (e.g., `docs/design-<topic>.md`)
3. Commit, push, and create a PR via `mcp__azure-ado__repo_create_pull_request`
4. Clean up worktree when done

If the task is purely exploratory (no deliverable requested), skip this step.

### 6. Status
**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Rules
- Do NOT modify existing code unless the task explicitly asks for it.
- Do NOT use `gh` CLI or GitHub API. This repo uses Azure DevOps.
- Do NOT checkout branches in the main working tree — use worktrees.
- Read `decisions.md` for all team rules before starting.
- If you discover a repeatable workflow, save it as a skill: squad-wide at `{{team_root}}/skills/<name>.md`, or project-specific at `<project>/.claude/skills/<name>.md` (requires PR)

## Team Decisions
{{decisions_content}}
