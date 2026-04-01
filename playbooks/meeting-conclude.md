# Meeting: Conclusion

You are {{agent_name}} ({{agent_role}}), synthesizing the team meeting results.

## Meeting: {{meeting_title}}

## Agenda

{{agenda}}

## Investigation Findings

{{all_findings}}

## Debate Responses

{{all_debate}}

{{#human_notes}}
## Human Notes

{{human_notes}}
{{/human_notes}}

## Your Task

Write a clear meeting conclusion covering:

1. **Areas of consensus** — what does the team agree on?
2. **Unresolved disagreements** — where do positions still differ?
3. **Recommended decision** — what should we do?
4. **Action items** — specific next steps with owners (leave empty if none)
5. **Open questions** — what still needs human input?

Be decisive. If there's a clear best option, say so.

## Plan Creation (conditional)

After writing the conclusion, decide: **are there concrete action items that require implementation work?**

- **If YES** — write a plan file to `plans/<slugified-meeting-title>-<YYYY-MM-DD>.md` using the Minions plan format below. Only create this file if there are real, actionable implementation tasks — not just discussion points or observations.

- **If NO** — do not create a plan file. A conclusion with only open questions, observations, or decisions that require no code/implementation changes does not need a plan.

### Plan format (only if action items exist)

```markdown
# <Plan Title>

> Source: Meeting {{meeting_title}} — <date>

## Background

<1-2 sentence summary of why this plan exists, from the meeting conclusion>

## Tasks

### 1. <Task title>
- **What**: <what needs to be done>
- **Why**: <from the meeting — what problem does this fix>
- **Owner**: <agent role best suited: Engineer / Architect / Analyst>
- **Files**: <relevant files if known>

### 2. <Task title>
...

## Open Questions

<Any unresolved items that need human input before work begins>
```

Do NOT create a plan for:
- Informational findings with no follow-up work
- Decisions that have already been made and require no changes
- Items that are purely "monitor and observe"
