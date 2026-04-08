## Engine Rules (apply to all tasks)

- Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
- Do NOT remove worktrees — the engine handles cleanup automatically.
- Do NOT checkout branches in the main working tree — use worktrees or `git diff`/`git show`.
- Read `notes.md` for team rules and decisions before starting.
- If you discover a repeatable workflow, output it as a ```skill block (the engine auto-extracts it).
