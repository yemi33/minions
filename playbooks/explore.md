# Explore Playbook

> Agent: {{agent_name}} | Task: {{task_description}} | ID: {{task_id}}

## Context

Repository ID: from `.squad/config.json` under `project.repositoryId`
ADO org: {{ado_org}}, project: {{ado_project}}, repo: {{repo_name}}
Team root: {{team_root}}

## Mission

Explore the codebase area specified in the task description. Your goal is to understand the architecture, patterns, and current state of the code, then document your findings for the team.

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
Write your findings to `.squad/decisions/inbox/{{agent_name}}-explore-{{task_id}}-{{date}}.md` with these sections:
- **Area Explored**: what you looked at
- **Architecture**: how it works
- **Patterns**: conventions and patterns found
- **Dependencies**: what depends on what
- **Gaps**: anything missing, broken, or unclear
- **Recommendations**: suggestions for the team

### 5. Status
**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Rules
- Do NOT modify any code. This is read-only exploration.
- Do NOT use `gh` CLI or GitHub API. This repo uses Azure DevOps.
- Do NOT checkout branches in the main working tree.
- Read `decisions.md` for all team rules before starting.

## Team Decisions
{{decisions_content}}
