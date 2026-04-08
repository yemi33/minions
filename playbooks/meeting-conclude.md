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

Write a clear, **self-contained** meeting conclusion. Someone reading ONLY this conclusion (not the findings or debate) must understand exactly what was decided and what to do next.

1. **Top priorities** — numbered list of the specific items the team agreed to work on. For each:
   - What the problem is (concrete: file names, function names, error messages)
   - What the fix should be (concrete: "change X to Y", "add guard in Z")
   - Estimated complexity (small/medium/large)

2. **Deferred items** — what was discussed but explicitly deprioritized, and why

3. **Unresolved disagreements** — where positions still differ (if any)

4. **Open questions for human** — what needs human input before proceeding (if any)

**Be concrete, not vague.** Do NOT write "fix 3 bugs" — write which 3 bugs, in which files, with what fix. The conclusion is used as input to create an implementation plan, so it must contain enough detail to act on without re-reading the entire meeting.

Do NOT create plan files — plan creation is handled separately (by the pipeline plan stage or the dashboard "Create Plan" button).

## When to Stop

Your task is complete once you have written the conclusion with action items. Do NOT create plan files or begin implementation. Stop after writing the conclusion.
