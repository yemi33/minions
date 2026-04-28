# Explore Playbook

> Agent: {{agent_name}} | Task: {{task_description}} | ID: {{task_id}}

## Context

Repository ID: from `.minions/config.json` under `project.repositoryId`
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
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
After the requested exploration succeeds, write your findings to `{{team_root}}/notes/inbox/{{agent_id}}-explore-{{task_id}}-{{date}}.md` with these sections:
- **Area Explored**: what you looked at
- **Architecture**: how it works
- **Patterns**: conventions and patterns found
- **Dependencies**: what depends on what
- **Gaps**: anything missing, broken, or unclear
- **Recommendations**: suggestions for the team
- **Source References**: for EVERY finding, include the source — file paths, line numbers, PR URLs, API endpoints, config keys. Format: `(source: path/to/file.ts:42)` or `(source: PR-12345)`. This is critical — other agents and humans need to verify your findings.

If exploration is blocked or fails before you can produce sourced findings, do **not** write an inbox note. Report the blocker in your final response instead.

### 5. Create Deliverable (if the task asks for one)
If the task asks you to write a design doc, architecture doc, or any durable artifact:
1. Write the document in the current working directory (e.g., `docs/design-<topic>.md`)
2. Commit, push, and create a PR:
   {{pr_create_instructions}}

Do NOT create additional worktrees — the engine handles worktree management.
If the task is purely exploratory (no deliverable requested), skip this step.

### 6. Status

## Working Style

Use subagents only for genuinely parallel, independent tasks. For reading files, exploring directories, and writing findings, work directly — do not spawn subagents.

## Rules
- Do NOT modify existing code unless the task explicitly asks for it.
- Use the appropriate MCP tools for PR creation — check available tools before starting.
- Do NOT checkout branches in the main working tree — use worktrees.
- Read `notes.md` for all team rules before starting.
- Only emit a ```skill block if you uncovered a durable reusable workflow that is not already documented and is likely to help future tasks; zero skills is the default, and one-off findings belong in the inbox notes instead.

## When to Stop

Your task is complete once you have written the successful findings to the inbox file. Do NOT continue reading additional files, exploring tangential areas, or producing extra analysis beyond what was asked. Write your findings and stop.

## Team Decisions
{{notes_content}}
