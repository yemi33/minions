## Engine Rules (apply to all tasks)

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
- If you discover a repeatable workflow, output it as a ```skill block (the engine auto-extracts it).
- Do TDD where it makes sense — write failing tests first, then implement, then verify tests pass. Especially for bug fixes (write a test that reproduces the bug) and new utility functions.
