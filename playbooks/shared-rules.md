## Context Window Awareness

Your context window may be compacted or summarized mid-task by Claude's automatic context management. This is normal and expected for long-running tasks. Do NOT interpret compacted or truncated context as a signal to stop early, wrap up prematurely, or skip remaining work. Continue working toward your stated objective regardless of context window state — re-read key files if needed to recover context.

## Engine Rules (apply to all tasks)

- Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
- Do NOT remove worktrees — the engine handles cleanup automatically.
- Do NOT checkout branches in the main working tree — use worktrees or `git diff`/`git show`.
- Read `notes.md` for team rules and decisions before starting.
- If you discover a repeatable workflow, output it as a ```skill block (the engine auto-extracts it).
- Do TDD where it makes sense — write failing tests first, then implement, then verify tests pass. Especially for bug fixes (write a test that reproduces the bug) and new utility functions.
