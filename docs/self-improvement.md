# Self-Improvement Loop

How the squad learns from its own work and gets better over time.

## Overview

The squad has four self-improvement mechanisms that form a continuous feedback loop:

```
Agent completes task
  │
  ├─ 1. Learnings Inbox        → notes.md (all future agents see it)
  ├─ 2. Per-Agent History       → history.md (agent sees its own past)
  ├─ 3. Review Feedback Loop    → author gets reviewer's findings
  └─ 4. Quality Metrics         → engine/metrics.json (tracks performance)
```

## 1. Learnings Inbox → notes.md

**The core loop.** Every playbook instructs agents to write findings to `notes/inbox/`. The engine consolidates these into `notes.md`, which is injected into every future playbook prompt.

### Flow

```
Agent finishes task
  → writes notes/inbox/<agent>-<date>.md
  → engine checks inbox on next tick (~60s)
  → consolidateInbox() fires (threshold: 1 file)
  → spawns Claude Haiku for LLM-powered summarization
  → Haiku reads all inbox notes + existing notes.md
  → produces deduplicated, categorized digest
  → digest appended to notes.md
  → originals moved to notes/archive/
  → notes.md injected into every future agent prompt
```

### LLM-Powered Consolidation (Primary)

The engine spawns Claude Haiku to read all inbox notes and produce a smart digest. Haiku is chosen for speed (~10s) and low cost while being capable enough for summarization.

**What Haiku does:**
- Reads full content of every inbox note (up to 8KB each)
- Cross-references against existing notes.md to avoid repeating known knowledge
- Extracts only actionable insights: patterns, conventions, gotchas, build results, architectural decisions
- Deduplicates — if multiple agents report the same finding, merges into one entry
- Groups by category: Patterns & Conventions, Build & Test Results, PR Review Findings, Bugs & Gotchas, Architecture Notes, Action Items
- Attributes each insight to the source agent(s)
- Writes a descriptive title summarizing what was learned

**Example output:**
```markdown
### 2026-03-13: PR-4964594 Build & Lint Analysis
**By:** Engine (LLM-consolidated)

#### Build & Test Results
- **Build and tests passing** for progression UI feature _(rebecca)_

#### Bugs & Gotchas
- **Barrel file violation**: index.ts under src/features/progression/ violates no-barrel-files rule — use concrete paths _(rebecca)_
- **11 lint errors**: unnecessary conditionals and missing curly braces in progressionAtoms.ts and ProgressionCard.tsx _(rebecca)_

#### Patterns & Conventions
- **Jotai for local state**: appropriate for synchronous UI state in Bebop features _(rebecca)_

_Processed 1 note, 4 insights extracted, 1 duplicate removed._
```

**Async execution:** The LLM call doesn't block the engine tick loop. A `_consolidationInFlight` flag prevents concurrent runs.

**Timeout:** 3 minutes max. If Haiku doesn't respond, the engine kills the process and falls back to regex.

### Regex Fallback Consolidation

If the LLM call fails (timeout, error, malformed output), the engine falls back to pattern-matching extraction:

- **Numbered items**: `1. **Bold key**: explanation` — captured via regex
- **Bullet items**: `- **Bold key**: explanation` — captured via regex
- **Important lines**: standalone sentences containing must/never/always/convention/pattern/gotcha
- **Deduplication**: fingerprint-based (lowercased, stripped, 70% word overlap threshold)
- **Cross-reference**: checks against existing notes.md to skip known insights

Fallback entries are labeled `**By:** Engine (regex fallback)` so you can tell which method was used.

### Auto-Pruning

When `notes.md` exceeds 50KB, the engine prunes old consolidation sections, keeping the header and last 8 consolidations. This prevents the file from growing unbounded while retaining recent institutional knowledge.

## 2. Per-Agent History

Each agent maintains a `history.md` file that tracks its last 20 tasks. This is injected into the agent's system prompt so it knows what it did recently.

### Flow

```
Agent finishes task
  → engine calls updateAgentHistory()
  → prepends entry to agents/<name>/history.md
  → trims to 20 entries
  → next time agent spawns: history.md injected into system prompt
```

### What's tracked per entry

- Timestamp
- Task description
- Type (implement, review, fix, explore)
- Result (success/error)
- Project name
- Branch name
- Dispatch ID

### Why it matters

Without history, an agent has no memory. It might:
- Re-explore code it already explored yesterday
- Repeat mistakes it made last session
- Not know that it already has a PR open for a similar feature

With history, the agent sees "I already implemented M005 yesterday (success)" and can build on that context.

## 3. Review Feedback Loop

When a reviewer (e.g., Ripley) reviews a PR and writes findings, the engine automatically creates a feedback file for the PR author (e.g., Dallas) in the inbox.

### Flow

```
Ripley reviews Dallas's PR
  → writes notes/inbox/ripley-review-pr123-2026-03-12.md
  → engine detects review completion
  → updatePrAfterReview() runs
  → createReviewFeedbackForAuthor() runs
  → creates notes/inbox/feedback-dallas-from-ripley-pr123-2026-03-12.md
  → next consolidation: feedback appears in notes.md
  → Dallas's next task: he sees what Ripley flagged
```

### What the feedback file contains

```markdown
# Review Feedback for Dallas

**PR:** PR-123 — Add retry logic
**Reviewer:** Ripley
**Date:** 2026-03-12

## What the reviewer found
<full content of Ripley's review>

## Action Required
Read this feedback carefully. When you work on similar tasks
in the future, avoid the patterns flagged here.
```

### Why it matters

Without this, review findings only exist in the inbox file under the reviewer's name. The author never explicitly sees them unless they happen to read the consolidated notes.md. The feedback loop ensures the author gets a direct, targeted learning from every review.

## 4. Human Feedback on PRs

Humans can leave comments on ADO PRs containing `@squad` to trigger fix tasks. The engine polls PR threads every ~6 minutes and dispatches fixes to the PR's author agent.

### Flow

```
Human comments on PR with "@squad fix the error handling here"
  → pollPrHumanComments() detects new @squad comment
  → sets pr.humanFeedback.pendingFix = true with comment text
  → discoverFromPrs() sees pendingFix flag
  → dispatches fix task to PR author agent
  → author agent fixes and pushes
  → PR goes back into normal review cycle
```

### How it works

- **Trigger:** If you're the only human commenter, **any** comment triggers a fix. If multiple humans are commenting, `@squad` keyword is required to avoid noise
- **Agent detection:** Comments matching `/\bSquad\s*\(/i` are skipped (agent signature pattern)
- **Dedup:** Only comments newer than `pr.humanFeedback.lastProcessedCommentDate` are processed
- **Multiple comments:** All new `@squad` comments are concatenated into a single fix task
- **After fix:** `pendingFix` is cleared; PR re-enters normal review cycle

## 5. Quality Metrics

The engine tracks per-agent performance metrics in `engine/metrics.json`. Updated after every task completion and PR review.

### Metrics tracked

| Metric | Updated when |
|--------|-------------|
| `tasksCompleted` | Agent exits with code 0 |
| `tasksErrored` | Agent exits with non-zero code |
| `prsCreated` | Agent completes an implement task |
| `prsApproved` | Reviewer approves the agent's PR |
| `prsRejected` | Reviewer requests changes on the agent's PR |
| `reviewsDone` | Agent completes a review task |
| `lastTask` | Every completion |
| `lastCompleted` | Every completion |

### Where metrics are visible

- **CLI:** `node engine.js status` shows a metrics table
- **Dashboard:** "Agent Metrics" section with approval rates color-coded (green ≥70%, red <70%)

### Sample output

```
Metrics:
  Agent        Done   Err    PRs    Approved   Rejected   Reviews
  ----------------------------------------------------------
  dallas       12     1      8      6 (75%)    2          0
  ripley       0      0      0      0 (-)      0          10
  ralph        5      0      4      3 (75%)    1          0
  rebecca      3      0      2      2 (100%)   0          0
  lambert      2      0      0      0 (-)      0          4
```

### Future use

Metrics are currently informational — displayed in status and dashboard. Planned uses:
- **Routing adaptation:** If an agent's approval rate drops below a threshold, deprioritize them for implementation tasks
- **Auto-escalation:** If an agent errors 3 times in a row, pause their dispatch and alert
- **Capacity planning:** Track throughput per agent to optimize `maxConcurrent`

## How It All Connects

```
                         ┌──────────────────────┐
                         │    notes.md       │
                         │  (institutional       │
                         │   knowledge)          │
                         └──────┬───────────────┘
                                │ injected into every playbook
                                ▼
┌──────────┐           ┌──────────────────┐           ┌──────────┐
│ history  │──injects──│   Agent works    │──writes──→│  inbox/  │
│ .md      │           │   on task        │           │  *.md    │
│ (past    │           └────────┬─────────┘           └────┬─────┘
│  tasks)  │                    │                          │
└──────────┘                    │ on completion            │ consolidateInbox()
     ▲                          ▼                          ▼
     │                 ┌──────────────────┐         ┌──────────┐
     └─updateHistory───│   Engine         │─prune──→│decisions  │
                       │   post-hooks     │         │  .md     │
                       └────────┬─────────┘         └──────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
             ┌──────────┐ ┌──────────┐ ┌──────────┐
             │ metrics  │ │ feedback │ │ history  │
             │ .json    │ │ for      │ │ .md      │
             │          │ │ author   │ │ updated  │
             └──────────┘ └──────────┘ └──────────┘
```

## 5. Skills — Agent-Discovered Workflows

When an agent discovers a repeatable multi-step procedure, it can save it as a **skill** — a structured, reusable workflow compatible with Claude Code's skill system. Skills are stored in two locations:

- **Squad-wide:** `~/.squad/skills/<name>.md` — shared across all agents, no PR required
- **Project-specific:** `<project>/.claude/skills/<name>/SKILL.md` — scoped to one repo, requires a PR

### Flow

```
Agent discovers repeatable pattern during task
  → writes skills/<name>.md with frontmatter (name, description, trigger, allowed-tools)
  → engine detects new skill files on next tick
  → builds skill index (name + trigger + file path)
  → index injected into every agent's system prompt
  → future agents see "Available Skills" and follow matching ones
  → skills are also invocable via Claude Code's /skill-name command
```

### Skill Format

```markdown
---
name: fix-yarn-lock-conflict
description: Resolves yarn.lock merge conflicts by regenerating the lockfile
trigger: when merging branches that both modified yarn.lock
allowed-tools: Bash, Read, Write
author: dallas
created: 2026-03-12
project: any
---

# Skill: Fix Yarn Lock Conflicts

## When to Use
When a git merge or rebase produces conflicts in yarn.lock.

## Steps
1. Delete yarn.lock
2. Run `yarn install` to regenerate
3. Stage the new yarn.lock
4. Continue the merge/rebase

## Notes
- Never manually edit yarn.lock
- Always run `yarn build` after regenerating to verify
```

### How it differs from notes.md

| | notes.md | Skills |
|---|---|---|
| **Format** | Free-form prose, appended by engine | Structured with frontmatter, one file per workflow |
| **Granularity** | Rules, conventions, findings | Step-by-step procedures |
| **Authored by** | Engine (consolidation) | Agents directly |
| **Trigger** | Always injected (all context) | Agent matches trigger to current situation |
| **Lifespan** | Grows forever (pruned at 50KB) | Permanent, individually editable |
| **Claude Code** | Not directly invocable | Invocable via `/skill-name` |

### When agents should create skills

- Multi-step procedures they had to figure out (build setup, deployment, migration)
- Error recovery patterns (how to fix a specific class of failure)
- Project-specific workflows that aren't documented elsewhere
- Cross-repo coordination steps

## Configuration

| Setting | Default | What it controls |
|---------|---------|-----------------|
| `engine.inboxConsolidateThreshold` | 1 | Files needed before consolidation triggers |
| Consolidation model | Haiku | LLM used for summarization (fast, cheap) |
| Consolidation timeout | 3 min | Max time for LLM call before fallback |
| notes.md max size | 50KB | Auto-prunes old sections above this |
| Agent history entries | 20 | Max entries kept in history.md |
| Metrics file | `engine/metrics.json` | Auto-created on first completion |

## Files

| File | Purpose | Written by |
|------|---------|-----------|
| `notes/inbox/*.md` | Agent findings drop-box | Agents |
| `notes/archive/*.md` | Archived inbox files | Engine (consolidation) |
| `notes.md` | Accumulated team knowledge | Engine (consolidation) |
| `agents/<name>/history.md` | Per-agent task history | Engine (post-completion) |
| `engine/metrics.json` | Quality metrics per agent | Engine (post-completion + review) |
| `notes/inbox/feedback-*.md` | Review feedback for authors | Engine (post-review) |
