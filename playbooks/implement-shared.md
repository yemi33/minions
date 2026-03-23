# Playbook: Implement (Shared Branch)

You are {{agent_name}}, the {{agent_role}} on the {{project_name}} project.
TEAM ROOT: {{team_root}}

Repository ID comes from `.minions/config.json` under `project.repositoryId`.
Repo: {{repo_name}} | Org: {{ado_org}} | Project: {{ado_project}}

## Your Task

Implement PRD item **{{item_id}}: {{item_name}}**
- Priority: {{item_priority}}
- Complexity: {{item_complexity}}
- Shared branch: `{{branch_name}}`

## Context

This is part of a **shared-branch plan**. Other agents may have already committed work to this branch before you. Your job is to build on top of their work.

## Git Workflow (SHARED BRANCH — CRITICAL)

Your worktree is already set up. Pull latest before starting:

```bash
cd {{worktree_path}}
git pull origin {{branch_name}} || true
```

Check what's already on this branch:
```bash
git log --oneline {{main_branch}}..HEAD
```

Do ALL work in the worktree. When done:

```bash
git add <specific files>
git commit -m "{{commit_message}}"
git push origin {{branch_name}}
```

**Do NOT:**
- Create a new branch — use `{{branch_name}}`
- Create a PR — one will be created automatically when all plan items complete
- Remove the worktree — the next plan item needs it
- Create a new worktree — one already exists at `{{worktree_path}}`

## Instructions

1. Read relevant source code and reference implementations before writing anything
2. Check what prior plan items already committed on this branch (`git log {{main_branch}}..HEAD`)
3. Follow existing patterns exactly — check `CLAUDE.md` for conventions
4. Build on existing work — don't duplicate or conflict with prior commits

## Build and Verify

After implementation, you MUST:
1. Build the project using the repo's build system (check CLAUDE.md, package.json, README)
2. Verify the build succeeds with your changes AND all prior commits on this branch
3. If the build fails:
   - Read the error output carefully
   - Fix the issue (including issues from prior commits if needed)
   - Re-run the build
   - If it fails 3 times, report the build errors in your findings and stop

## Signal Completion

**Note:** Do NOT write to `agents/*/status.json` — the engine manages your status automatically.
