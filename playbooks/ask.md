# Ask Playbook

> Agent: {{agent_name}} | Question from user | ID: {{task_id}}

## Context

Team root: {{team_root}}
{{scope_section}}

## Mission

The user has asked a question. Answer it thoroughly and clearly, writing your response to the inbox so they can read it.

## Question

{{question}}

## Steps

### 1. Understand the Question
- Read the question carefully
- If it references specific files, code, or concepts — go read them first
- If it references a project, use the project context above to orient yourself

### 2. Research
- Read relevant source files, docs, configs, or history as needed
- Use the codebase — don't guess when you can look
- If the question is about "this" (ambiguous reference), check recent git history and agent activity for context

### 3. Write Your Answer
Write your answer to `{{team_root}}/notes/inbox/{{agent_id}}-answer-{{task_id}}-{{date}}.md` with:

- **Question**: (restate briefly)
- **Answer**: (clear, direct answer)
- **References**: (files, links, or code snippets that support the answer)

Keep it concise but complete. Write for a senior engineer who wants the real answer, not fluff.

### 4. Status
**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.

## Rules
- Do NOT modify any code unless the question explicitly asks you to.
- Do NOT create PRs or branches — this is a read-only task.
- Do NOT checkout branches in the main working tree.
- Read `notes.md` for all team rules before starting.

## Team Decisions
{{notes_content}}
