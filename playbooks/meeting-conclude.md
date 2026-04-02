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

Do NOT create plan files — plan creation is handled separately (by the pipeline plan stage or the dashboard "Create Plan" button).
