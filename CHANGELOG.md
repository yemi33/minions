# Changelog

## 0.1.62 (2026-03-19)

### Engine
- engine.js
- engine/cli.js
- engine/consolidation.js

### Dashboard
- dashboard.js

### Documentation
- auto-discovery.md
- command-center.md
- self-improvement.md

## 0.1.61 (2026-03-19)

### Documentation
- README.md
- auto-discovery.md
- command-center.md
- human-vs-automated.md
- self-improvement.md

## 0.1.60 (2026-03-19)

### Engine
- engine/check-status.js

### Other
- squad.js
- test/unit.test.js

## 0.1.59 (2026-03-19)

### Engine
- engine.js
- engine/lifecycle.js
- engine/shared.js

### Other
- .claude/skills/run-tests/SKILL.md
- test/squad-tests.js
- test/unit.test.js

## 0.1.58 (2026-03-19)

### Engine
- engine.js
- engine/ado-mcp-wrapper.js
- engine/ado.js
- engine/check-status.js
- engine/cli.js
- engine/consolidation.js
- engine/github.js
- engine/lifecycle.js
- engine/llm.js
- engine/queries.js
- engine/shared.js
- engine/spawn-agent.js

### Dashboard
- dashboard.html
- dashboard.js

### Playbooks
- ask.md
- build-and-test.md
- explore.md
- fix.md
- implement-shared.md
- implement.md
- plan-to-prd.md
- plan.md
- review.md
- test.md
- verify.md
- work-item.md

### Agents
- agents/dallas/charter.md
- agents/lambert/charter.md
- agents/ralph/charter.md
- agents/rebecca/charter.md
- agents/ripley/charter.md

### Documentation
- README.md
- auto-discovery.md
- blog-first-successful-dispatch.md
- command-center.md
- distribution.md
- engine-restart.md
- human-vs-automated.md
- plan-lifecycle.md
- self-improvement.md

### Other
- .github/workflows/publish.yml
- TODO.md
- bin/squad.js
- config.template.json
- playwright.config.js
- routing.md
- squad.js
- team.md
- test/playwright/accept-baseline.js
- test/playwright/dashboard.spec.js
- test/playwright/reporter.js
- test/pre-commit-hook.js
- test/squad-tests.js

## 0.1.57 (2026-03-18)

### Engine
- engine.js
- engine/ado-mcp-wrapper.js
- engine/ado.js
- engine/check-status.js
- engine/cli.js
- engine/consolidation.js
- engine/github.js
- engine/lifecycle.js
- engine/llm.js
- engine/queries.js
- engine/shared.js
- engine/spawn-agent.js

### Dashboard
- dashboard.html
- dashboard.js

### Playbooks
- ask.md
- build-and-test.md
- explore.md
- fix.md
- implement-shared.md
- implement.md
- plan-to-prd.md
- plan.md
- review.md
- test.md
- verify.md
- work-item.md

### Agents
- agents/dallas/charter.md
- agents/lambert/charter.md
- agents/ralph/charter.md
- agents/rebecca/charter.md
- agents/ripley/charter.md

### Documentation
- README.md
- auto-discovery.md
- blog-first-successful-dispatch.md
- command-center.md
- distribution.md
- engine-restart.md
- human-vs-automated.md
- plan-lifecycle.md
- self-improvement.md

### Other
- .github/workflows/publish.yml
- TODO.md
- bin/squad.js
- config.template.json
- playwright.config.js
- routing.md
- squad.js
- team.md
- test/playwright/accept-baseline.js
- test/playwright/dashboard.spec.js
- test/playwright/reporter.js
- test/pre-commit-hook.js
- test/squad-tests.js

All notable changes to Squad are documented here. Versions are auto-published to npm on each sync.

## 0.2.x (2026-03-15)

### Upgrade System
- **Smart upgrade** — `squad init --force` now copies new files, updates engine code, and preserves user customizations
- **Version tracking** — `.squad-version` file tracks installed version for upgrade detection
- **`squad version`** — shows installed vs package version, prompts to upgrade if outdated
- **Upgrade summary** — shows what was updated, added, and preserved during upgrade
- **New files auto-added** — new playbooks, charters, and docs added in updates are automatically installed

### Engine
- **`/plan` command** — full pipeline: feature description → PRD items → agent dispatch across projects
- **Shared feature branches** — dependency-aware dispatch ensures agents work on the same branch
- **Human PR feedback loop** — `@squad` comments on PRs trigger agent fix tasks
- **Squad-level PRD** — multi-project PRD support
- **`/ask` command** — ask questions via Command Center, get answers in inbox
- **Auto-detect user questions** — drop `ask-*.md` files in inbox, engine routes to an agent
- **Solo reviewer skip** — `@squad` keyword not required when you're the only reviewer
- **Knowledge base** — categorized agent learnings stored in `knowledge/` (architecture, conventions, reviews, etc.)
- **Command Center** — persistent multi-turn Sonnet sessions with full squad awareness and tool access
- **Zombie engine elimination** — EPERM file lock fixes, stale PID detection, Windows-safe atomic writes
- **ADO token auto-refresh** — handles expired Azure DevOps authentication tokens
- **Cooldown system** — prevents re-dispatching recently completed work
- **Post-merge cleanup** — automatically marks work items done when PRs merge
- **Fan-out timeout** — configurable timeout for parallel multi-agent dispatches

### Dashboard
- **Responsive layout** — tablet and mobile breakpoints
- **Mention popup** — Tab cycling, wrap-around navigation, repositioned below input
- **Ghost-style send button** — cleaner Command Center UI
- **Platform-aware launches** — browser and file manager commands adapt to OS
- **Health check endpoint** — `/api/health` for monitoring

### Distribution
- **npm package `@yemi33/squad`** — install with `npm install -g @yemi33/squad`
- **Unified CLI** — single `squad` command for all operations
- **GitHub Action** — auto-publishes to npm on every push to master
- **ADO integration docs** — Azure DevOps MCP server setup instructions in README

## 0.1.0 (2026-03-11)

### Initial Release
- Five autonomous agents: Ripley (Lead), Dallas (Engineer), Lambert (Analyst), Rebecca (Architect), Ralph (Engineer)
- Engine with 60s tick cycle, auto-discovery from PRs/PRDs/work items, priority-based dispatch
- Web dashboard with live output streaming, agent cards, work items, PRD tracker, PR tracker
- Playbooks: implement, review, fix, explore, test, build-and-test, plan-to-prd, work-item
- Self-improvement loop: learnings inbox → consolidated notes, per-agent history, review feedback, quality metrics, auto-extracted skills
- Git worktree workflow for all code changes
- MCP server auto-sync from Claude Code settings
- Fan-out dispatch for parallel multi-agent tasks
- Heartbeat monitoring and automated cleanup
