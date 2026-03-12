# Runbooks

Agent-discovered reusable workflows. Any agent can create a runbook when it discovers a repeatable pattern. All agents see the runbook index in their system prompt and can follow the steps.

## Format

Each runbook is a markdown file with this structure:

```markdown
---
name: short-descriptive-name
trigger: when should an agent use this runbook
author: agent-name
created: YYYY-MM-DD
project: project-name or "any"
---

# Runbook: Short Title

## When to Use
<describe the situation that triggers this workflow>

## Steps
1. First step
2. Second step
3. ...

## Notes
<gotchas, variations, things to watch out for>
```

## How It Works

1. Agent discovers a repeatable pattern during a task
2. Agent writes a runbook file to `~/.squad/runbooks/<name>.md`
3. Engine detects new runbooks and adds them to the index
4. Index is injected into every agent's system prompt
5. Future agents see "Available Runbooks" and follow them when the trigger matches

## Examples

- `fix-yarn-lock-conflict.md` — how to resolve yarn.lock merge conflicts
- `add-new-agent.md` — steps to scaffold a new agent in OfficeAgent
- `deploy-docker-hotfix.md` — emergency hotfix deployment procedure
