# Self-Improvement Loop

How the squad learns from its own work and gets better over time.

## Overview

The squad has four self-improvement mechanisms that form a continuous feedback loop:

```
Agent completes task
  │
  ├─ 1. Learnings Inbox        → decisions.md (all future agents see it)
  ├─ 2. Per-Agent History       → history.md (agent sees its own past)
  ├─ 3. Review Feedback Loop    → author gets reviewer's findings
  └─ 4. Quality Metrics         → engine/metrics.json (tracks performance)
```

## 1. Learnings Inbox → decisions.md

**The core loop.** Every playbook instructs agents to write findings to `decisions/inbox/`. The engine consolidates these into `decisions.md`, which is injected into every future playbook prompt.

### Flow

```
Agent finishes task
  → writes decisions/inbox/<agent>-<date>.md
  → engine checks inbox on each tick
  → at 5+ files: consolidateInbox() runs
  → items categorized (reviews, feedback, learnings, other)
  → summary appended to decisions.md
  → originals moved to decisions/archive/
  → decisions.md injected into every future agent prompt
```

### Smart Consolidation

The engine doesn't just dump files — it categorizes them:
- **Reviews** — files containing "review" or PR references
- **Feedback** — review feedback files for authors
- **Learnings** — build summaries, explorations, implementation notes
- **Other** — everything else

Each category gets a header with item count and one-line summaries.

### Auto-Pruning

When `decisions.md` exceeds 50KB, the engine prunes old consolidation sections, keeping the header and last 8 consolidations. This prevents the file from growing unbounded while retaining recent institutional knowledge.

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
  → writes decisions/inbox/ripley-review-pr123-2026-03-12.md
  → engine detects review completion
  → updatePrAfterReview() runs
  → createReviewFeedbackForAuthor() runs
  → creates decisions/inbox/feedback-dallas-from-ripley-pr123-2026-03-12.md
  → next consolidation: feedback appears in decisions.md
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

Without this, review findings only exist in the inbox file under the reviewer's name. The author never explicitly sees them unless they happen to read the consolidated decisions.md. The feedback loop ensures the author gets a direct, targeted learning from every review.

## 4. Quality Metrics

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
                         │    decisions.md       │
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

## Configuration

| Setting | Default | What it controls |
|---------|---------|-----------------|
| `engine.inboxConsolidateThreshold` | 5 | Files needed before consolidation triggers |
| decisions.md max size | 50KB | Auto-prunes old sections above this |
| Agent history entries | 20 | Max entries kept in history.md |
| Metrics file | `engine/metrics.json` | Auto-created on first completion |

## Files

| File | Purpose | Written by |
|------|---------|-----------|
| `decisions/inbox/*.md` | Agent findings drop-box | Agents |
| `decisions/archive/*.md` | Archived inbox files | Engine (consolidation) |
| `decisions.md` | Accumulated team knowledge | Engine (consolidation) |
| `agents/<name>/history.md` | Per-agent task history | Engine (post-completion) |
| `engine/metrics.json` | Quality metrics per agent | Engine (post-completion + review) |
| `decisions/inbox/feedback-*.md` | Review feedback for authors | Engine (post-review) |
