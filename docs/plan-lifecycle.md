# Plan Lifecycle

How plans go from idea to verified, running code.

## Pipeline

```
/plan "feature description"
  → agent writes plan JSON (plan-*.json)
  → engine chains plan → PRD (plan-to-prd)
  → agent converts plan into structured PRD items with acceptance criteria
  → engine materializes PRD items as work items (PL-W001, PL-W002, ...)
  → engine dispatches work items respecting dependency order
  → agents implement each item, create PRs
  → engine auto-reviews PRs, handles feedback loops
  → all items done → engine creates VERIFY task
  → verify agent builds everything, starts webapp, writes testing guide
```

## Dependency Management

### Dispatch Gating

PRD items can declare `depends_on: ["P001", "P003"]`. The engine won't dispatch an item until all its dependencies have status `done`. This prevents agents from starting work before prerequisite code exists.

### Branch Merging at Spawn

When an agent is spawned for a work item with dependencies, the engine merges the dependency PR branches into the worktree **before the agent starts**. This solves the problem where dependencies have PRs but haven't been merged to `main` yet.

```
Agent gets work item PL-W006 (plan item P009)
  depends_on: ["P006", "P007"]

spawnAgent():
  1. Create worktree from main:
     git worktree add ../worktrees/work/PL-W006 -b work/PL-W006 main

  2. Resolve dependencies:
     P006 → work item PL-W001 → PR-4970100 → branch work/PL-W001
     P007 → work item PL-W002 → PR-4970101 → branch work/PL-W002

  3. Merge dependency branches:
     git fetch origin work/PL-W001 work/PL-W002
     git merge origin/work/PL-W001 --no-edit
     git merge origin/work/PL-W002 --no-edit

  4. Agent starts with all dependency changes present
```

If a merge conflict occurs, it's logged as a warning. The agent will see conflict markers and can resolve them, or the task will fail and get retried after the dependency PRs are merged to `main`.

### Resolution Chain

```
depends_on: ["P-43e5ac28"]
  → find work items where id = "P-43e5ac28" (across all projects)
  → find PRs where prdItems includes "P-43e5ac28"
  → extract branch names from those PRs
  → fetch + merge into worktree
```

## Plan Completion

When all PRD items reach `done` or `failed` status, `checkPlanCompletion()` fires:

1. **Completion summary** written to `notes/inbox/` with results, timing, and PR list
2. **Verification task** created (type `verify`, priority `high`) — see below
3. **PR work item** created for shared-branch plans (to merge the feature branch)
4. **Plan archived** to `plans/archive/`

## Verification Task

The verification task (`planItemId: "VERIFY"`) is the final step. It:

1. **Creates one worktree per affected project** with all PR branches merged in — not separate worktrees per branch. This means the agent builds and tests from a single directory per project with all changes combined.

2. **Builds and tests** every affected project from its worktree.

3. **Starts the webapp** on localhost if applicable, and keeps it running so the user can see it.

4. **Writes a manual testing guide** (`notes/inbox/verify-*.md`) with:
   - Build/test status table per project
   - Feature-by-feature testing steps based on acceptance criteria
   - Integration points to verify across projects
   - Known issues
   - Quick smoke test checklist
   - Exact restart commands with absolute paths

### Verification Worktree Setup

```
# project-a — 3 PRs merged into one worktree
cd ~/project-a
git fetch origin "work/PL-W001" "work/PL-W002" "work/PL-W003" "main"
git worktree add "../worktrees/verify-my-plan-2026-03-15" "origin/main"
cd "../worktrees/verify-my-plan-2026-03-15"
git merge "origin/work/PL-W001" --no-edit
git merge "origin/work/PL-W002" --no-edit
git merge "origin/work/PL-W003" --no-edit

# project-b — 2 PRs merged into one worktree
cd ~/project-b
git fetch origin "feat/PL-W004" "feat/PL-W005" "master"
git worktree add "../worktrees/verify-my-plan-2026-03-15" "origin/master"
cd "../worktrees/verify-my-plan-2026-03-15"
git merge "origin/feat/PL-W004" --no-edit
git merge "origin/feat/PL-W005" --no-edit
```

The verify agent and the user can then build and run from these paths.

## Human Feedback on PRs

After PRs are created, humans can leave comments containing `@minions` to trigger fix tasks. If you're the only human commenting, any comment triggers a fix — no keyword needed. See `pollPrHumanComments()` in `engine/ado.js`.

## Routing

| Type | Preferred | Fallback |
|------|-----------|----------|
| plan | ripley | rebecca |
| plan-to-prd | lambert | rebecca |
| implement | dallas | ralph |
| implement:large | rebecca | dallas |
| review | ripley | lambert |
| fix | _author_ | dallas |
| verify | dallas | ralph |
| test | dallas | ralph |

## Key Files

| File | Purpose |
|------|---------|
| `plans/*.json` | Active plan files with PRD items |
| `plans/archive/` | Completed/archived plans |
| `playbooks/verify.md` | Verification task playbook |
| `playbooks/implement.md` | Implementation playbook |
| `playbooks/plan-to-prd.md` | Plan → PRD conversion playbook |
| `engine/lifecycle.js` | `checkPlanCompletion`, completion hooks, PRD sync |
| `engine.js` | `spawnAgent` (dependency merging), `resolveDependencyBranches` |
