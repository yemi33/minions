# Explore Playbook

> Agent: {{agent_name}} | Task: {{task_description}} | ID: {{task_id}}

## Context

Repository ID: from `.minions/config.json` under `project.repositoryId`
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}
Team root: {{team_root}}

## Mission

Explore the codebase area specified in the task description. Your primary goal is to understand the architecture, patterns, and current state of the code. Explore work is research/reporting only: do not modify product code and do not create a PR.

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

### 5. Deliverables

If the task asks for a design doc, architecture doc, or analysis report, include it in the inbox findings file above or in your final response. Do NOT create a PR from an explore task. If a committed repository artifact is needed, call that out as a recommendation for a separate `implement` or `docs` work item.

Do NOT create additional worktrees — the engine handles worktree management.

### 6. Status

## Working Style

Use subagents only for genuinely parallel, independent tasks. For reading files, exploring directories, and writing findings, work directly — do not spawn subagents.

## Rules
- Do NOT modify existing code unless the task explicitly asks for it.
- Do NOT create a PR from explore work; exploration produces findings, not branches.
- Use the appropriate MCP tools for PR creation — check available tools before starting.
- Do NOT checkout branches in the main working tree — use worktrees.
- Read `notes.md` for all team rules before starting.
- Only emit a ```skill block if you uncovered a durable reusable workflow that is not already documented and is likely to help future tasks; zero skills is the default, and one-off findings belong in the inbox notes instead.

## When to Stop

Your task is complete once you have written the successful findings to the inbox file. Do NOT continue reading additional files, exploring tangential areas, or producing extra analysis beyond what was asked. Write your findings and stop.

## Team Decisions
{{notes_content}}
