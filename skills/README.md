# Squad Skills

Agent-discovered reusable workflows, written as Claude Code-compatible skills. Any agent can create a skill when it discovers a repeatable pattern. All agents see the skill index in their system prompt and can invoke them.

## Format

Each skill is a markdown file with Claude Code skill frontmatter:

```markdown
---
name: short-descriptive-name
description: What this skill does and when to use it
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
argument-hint: "[optional] [parameter] [hints]"
trigger: when should an agent use this skill
author: agent-name
created: YYYY-MM-DD
project: project-name or "any"
---

# Skill: Short Title

## When to Use
<describe the situation that triggers this workflow>

## Steps
1. First step
2. Second step
3. ...

## Notes
<gotchas, variations, things to watch out for>
```

## Key Fields

- `name` — unique identifier (lowercase with hyphens)
- `description` — plain English description (used by Claude Code for skill discovery)
- `allowed-tools` — which tools the skill may use (Claude Code permission scoping)
- `trigger` — when an agent should invoke this skill (injected into prompt index)
- `author` — which agent created it
- `project` — which project it applies to, or "any"

## Two Skill Locations

### Squad-wide skills (`~/.squad/skills/`)
- Shared across all agents and all projects
- No PR required — agents write directly
- Best for: cross-project workflows, team conventions, tool patterns

### Project-specific skills (`<project>/.claude/skills/`)
- Scoped to a single repo, available to anyone working in that repo
- **Requires a PR** since it modifies the repo (worktree + branch + PR)
- Best for: repo-specific build steps, test patterns, deployment workflows
- Automatically available in Claude Code sessions within that project

## How It Works

1. Agent discovers a repeatable pattern during a task
2. Agent writes a skill file to the appropriate location:
   - Squad-wide: `~/.squad/skills/<name>.md` (direct write)
   - Project-specific: `<project>/.claude/skills/<name>.md` (via PR)
3. Engine detects new skills and adds them to the index
4. Index is injected into every agent's system prompt
5. Future agents see "Available Skills" and follow them when the trigger matches
6. Skills are also compatible with Claude Code's `/skill-name` invocation

## Compatibility

Skills use the same frontmatter format as Claude Code skills (`~/.claude/skills/`).
- Squad-wide skills can be copied to `~/.claude/skills/` for personal use
- Project-specific skills are already in the Claude Code discovery path
