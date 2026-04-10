## Context Window Awareness

Your context window may be compacted or summarized mid-task by Claude's automatic context management. This is normal and expected for long-running tasks. Do NOT interpret compacted or truncated context as a signal to stop early, wrap up prematurely, or skip remaining work. Continue working toward your stated objective regardless of context window state — re-read key files if needed to recover context.

## Engine Rules (apply to all tasks)

**Context compaction:** Your context window may be compacted mid-task by Claude's infrastructure. If you notice your earlier conversation history appears truncated or summarized, this is normal and expected. Do not interpret compaction as a signal to stop early or wrap up. Continue working toward your task objective — all relevant instructions and state remain available.

- Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
- Do NOT remove worktrees — the engine handles cleanup automatically.
- Do NOT checkout branches in the main working tree — use worktrees or `git diff`/`git show`.
- Read `notes.md` for team rules and decisions before starting.
- **Check minions state before starting fresh.** Before researching from scratch, check what the team already knows:
  - `notes.md` — consolidated team knowledge, decisions, and context
  - `knowledge/` — categorized KB entries (architecture, conventions, build-reports, reviews)
  - `notes/inbox/` — recent agent findings not yet consolidated
  - Previous agent output in `agents/*/live-output.log` for related tasks
  - Work item descriptions and `resultSummary` for prior completed work on the same topic
  - `pinned.md` — critical context flagged by the human teammate
  This avoids duplicating research another agent already completed.
- If you discover a repeatable workflow, output it as a fenced skill block. The engine auto-extracts it to `~/.claude/skills/<name>/SKILL.md`. Required format:
  ````
  ```skill
  ---
  name: skill-name-here
  description: One-line description of when to trigger this skill
  scope: minions
  ---

  Instructions for the skill go here.
  ```
  ````
  The `name` and `description` fields are required. `scope` defaults to `minions` (global). Use `scope: project` + `project: ProjectName` for project-specific skills.
- Do TDD where it makes sense — write failing tests first, then implement, then verify tests pass. Especially for bug fixes (write a test that reproduces the bug) and new utility functions.
