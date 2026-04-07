# Changelog

## 0.1.512 (2026-04-07)

### Fixes
-  decomposed items count as done in PRD progress and plan status

## 0.1.511 (2026-04-07)

### Features
-  abort and retrigger buttons for active pipeline runs

### Fixes
-  decomposed badge uses static style (no pulse animation)
-  PRD regeneration uses unique filename instead of reusing old name
-  PRD filenames are unique — engine generates collision-free name
-  PRD view shows all projects, not just the first one
-  bug report shows feedback inside modal, not hidden toast

### Other
- simplify: remove dead g.project field, fix archived PRD view too

## 0.1.504 (2026-04-07)

### Features
-  9 live output tests + render [steering-failed] in live stream

### Fixes
-  live output reads only tail bytes from disk, increase cap to 64KB

## 0.1.502 (2026-04-07)

### Features
-  explicitly-assigned work items bypass concurrency cap
- strengthen CC dispatch contract with domain terminology mapping

### Fixes
-  correct stale dispatch priority comment
-  comprehensive steering failure handling with user-visible feedback

## 0.1.498 (2026-04-07)

### Features
-  sidebar tooltips for Schedules and Pipelines

### Fixes
-  sidebar badges for plans, meetings, and pipelines

## 0.1.496 (2026-04-07)

### Fixes
-  new PRs trigger red dot notification on Pull Requests page
- lock timeout retry with backoff to prevent tick cascade failures (#389)
- GitHub PR poll backoff for inaccessible repos (closes #377) (#386)
-  reconcile agent completions during engine downtime (closes #376) (#385)
-  settings button shows modal immediately with loading state
-  CC respects user scroll position — no auto-scroll when reading history
-  steering feedback — toast notification, ensure polling resumes
-  remove pipelines/ from git tracking — user-local config

## 0.1.488 (2026-04-07)

### Fixes
-  augment dispatched work items with agent from active dispatch

## 0.1.487 (2026-04-07)

### Features
-  steering shows acknowledgment status — Sent → waiting → acknowledged

### Fixes
-  CC always delegates exploration to agents instead of doing it itself

## 0.1.485 (2026-04-07)

### Fixes
-  remove redundant project listing from page title

## 0.1.484 (2026-04-07)

### Fixes
-  toast renders HTML links and persists 15s for clickable content
-  harden bug filing — proper escaping, error handling, direct UI button

## 0.1.482 (2026-04-07)

### Features
-  file bugs as GitHub issues from CC or doc-chat
- Buffer log() writes to reduce lock contention
- Cache getStatus() JSON serialization and add mtime-based invalidation
- Add mtime-based caching to getPrdInfo()
- Optimize getAgentStatus() to read only head+tail of live-output.log
- Fix unlocked metrics.json in lifecycle.js post-merge hook
- Fix unlocked metrics.json read-modify-write in trackEngineUsage
- Limit SSE initial live-stream payload to last 64KB

### Fixes
-  bug filing targets minions repo, not user's project
-  stamp dispatched_to on already-dispatched early-exit path
-  add optional chaining for config.agents in updatePrAfterReview
-  pass config to updatePrAfterReview to fix test failure

### Other
- docs: document bug filing feature in README and CLAUDE.md

## 0.1.473 (2026-04-07)

### Fixes
-  agent card click feels instant — show panel before API loads
-  steering audit — prevent double-kill, clean up temp files, fix leaks
-  steering resume improvements — better error logging, heartbeat restart
-  prevent slow work item modal on large descriptions
-  only cache sessionId for steering when actually resuming same branch

## 0.1.468 (2026-04-07)

### Fixes
-  plan-to-prd and plan tasks skip worktree creation
-  plan execute uses mutateJsonFileLocked for atomic check-and-insert

## 0.1.466 (2026-04-07)

### Fixes
-  prevent duplicate plan-to-prd execution for already-converted plans
-  extend heartbeat timeout for Agent (subagent) tool calls — 30min
-  extend heartbeat timeout for any Bash tool call (10min default)
-  clear stale session.json on resume failure, hang kill, and orphan

## 0.1.462 (2026-04-07)

### Fixes
-  show 'shared branch' label in work item PR column when no PR yet
-  plan card click opens modal immediately with loading state
-  remove non-functional Discuss & Revise button from plan cards
-  steering no longer causes pending/active flip

## 0.1.458 (2026-04-07)

### Fixes
-  steering resume failure no longer burns retry slots or flips status
-  shared-branch worktree creates branch from main if not found
-  pre-dispatch live vote check prevents reviewing approved PRs

## 0.1.455 (2026-04-07)

### Fixes
-  agents write one inbox file per task, not two

## 0.1.454 (2026-04-07)

### Fixes
-  CC network error shows Reload Page button for guaranteed recovery

## 0.1.452 (2026-04-07)

### Features
-  notification dot on Notes & KB sidebar when sweep completes/fails

### Fixes
-  remove duplicate retry logic causing dispatch double-queueing
-  plan archive/unarchive now optimistic — immediate UI feedback
-  meeting conclude timeout synthesizes conclusion instead of null
-  track ADO head commit for push detection — unblocks re-review cycle
-  block all fix dispatches while awaiting re-review after a fix
-  prevent double-dispatch — dedup by work item ID and dispatchKey
-  pipeline agent is optional — set only when user explicitly requests
-  remove hardcoded agent assignments from all pipeline JSONs
-  pipeline tasks don't hardcode agent — any available agent picks up work

## 0.1.441 (2026-04-06)

### Fixes
-  auto-reload page when dashboard restarts
-  safeFetch compat — drop AbortSignal.any, avoid opts mutation

## 0.1.439 (2026-04-06)

### Features
-  version check interval on settings page
-  configurable version check interval, default 1 hour
- Dashboard robustness — raw string fixes, plan steering clarity, safeWrite race fix
- Low-priority cleanup: dedupe regex, consolidate streaming parse, add path validation alignment
- Fix 6 medium bugs: dispatch pruning, null guards, skill regex, meeting advancement, CLI PID check, pipeline retry
- Convert remaining lifecycle.js safeWrite calls to mutateJsonFileLocked

### Fixes
-  prevent HTTP/1.1 connection exhaustion with safeFetch timeout
-  KB sweep failed state visible for 60s, auto-release stale guard
-  agent detail fetch error shows retry and close buttons
-  New Session fully resets command center state
-  show processing dots on note card during active doc-chat
-  prevent triple dispatch on same PR — 3 root causes
-  don't show 'update available' when running from git repo
-  CC network error shows helpful message + New Session button
-  clicking outside command center dismisses it
-  PR dedup prefers merged/abandoned over active regardless of order
-  extract skills from inbox notes, not just agent stdout
-  deduplicate PR entries during poll write-back
-  agent inbox notes include work item ID and time in filename
-  Notes & KB sidebar notifies on inbox changes and notes.md edits
-  live output no longer clobbered by steering send
-  plan-to-prd playbook — don't include verify item, engine adds it
-  steering messages right-aligned with immediate feedback
-  CC retry now drains queued messages after success
-  address review feedback — pipeline.js socket leak and magic numbers

## 0.1.417 (2026-04-06)

### Features
- Fix notes.md race condition and null guards in consolidation.js
- Replace 5 raw status strings with WI_STATUS constants
- Fix null crashes in lifecycle.js syncPrsFromOutput and createReviewFeedbackForAuthor

### Fixes
-  restart kills zombie dashboard via port-based detection

## 0.1.414 (2026-04-06)

### Fixes
-  use shell exec for npm view — execFile can't run .cmd on Windows

## 0.1.413 (2026-04-06)

### Fixes
-  auto-recover timed-out agents that created PRs before dying
-  resolve npm path from Node binary dir — not PATH

## 0.1.411 (2026-04-06)

### Fixes
-  steering messages retry instead of being silently dropped

### Other
- refactor: simplify steering — remove redundant session read, fix TOCTOU

## 0.1.409 (2026-04-06)

### Fixes
-  npm version check — use npm.cmd on Windows, log errors, expose in API

## 0.1.408 (2026-04-06)

### Fixes
-  minions update auto-restarts engine + dashboard after upgrading

## 0.1.407 (2026-04-06)

### Features
- Add missing return in mutateJsonFileLocked metrics callbacks
- Fix SSE resource leak in handleAgentLiveStream
- Add projects[0] length guards in engine.js

### Fixes
-  npm version check uses npm view instead of raw https.get
-  re-check npm registry every 4 hours via setInterval
-  PR delete is optimistic — row removed immediately, reverted on failure
-  PR delete searches all project files, not just the first project

## 0.1.403 (2026-04-06)

### Fixes
-  version check works on pure npm installs without package.json in ~/.minions

## 0.1.402 (2026-04-06)

### Features
-  pipeline stages detect and link inbox notes as artifacts

### Fixes
-  prevent auto-review of human PRs + add unlink button
-  reconcilePrs only auto-tracks PRs linked to minions work items
-  auto-detect main branch when configured mainBranch doesn't exist
-  engine restart button shows toast + green checkmark, suppresses stale banner 30s

## 0.1.397 (2026-04-06)

### Fixes
-  close stale publish PRs before creating new one
-  prevent body-level scrolling — lock layout to viewport

## 0.1.395 (2026-04-06)

### Other
- revert: remove version info from sidebar

## 0.1.394 (2026-04-06)

### Features
-  show version info at bottom of sidebar navigation
-  track dashboard version — detect stale dashboard code separately
- Replace magic strings in pipeline.js with STAGE_TYPE/PIPELINE_STATUS/MEETING_STATUS constants (#244)
- Fix spawn-agent.js direct proc.kill() — use cross-platform helpers (#243)

### Fixes
-  pin sidebar version to bottom — visible without scrolling
-  show 'minions update' as primary upgrade command in version banner

## 0.1.388 (2026-04-06)

### Fixes
-  move version banner next to engine badge + add 10 tests

## 0.1.387 (2026-04-06)

### Fixes
-  version check — bust require cache, check HTTP status from npm

## 0.1.386 (2026-04-06)

### Fixes
-  cache git rev-parse in version check — was spawning every 4s

## 0.1.385 (2026-04-06)

### Features
-  npm update check — show when newer version is available
-  show engine version and stale-code warning in dashboard

## 0.1.383 (2026-04-06)

### Fixes
-  SyntaxError — await in non-async discoverWork function
-  branch regex missed W- and PL- work item IDs — wrong PR agent attribution

## 0.1.381 (2026-04-06)

### Fixes
-  clear failReason on all retry-to-pending paths
-  clear failReason and noPr on no-PR retry reset
-  PR duplicate race condition — convert safeWrite to mutateJsonFileLocked (#240)

### Other
- [E2E] Fix review re-dispatch loop, dashboard write races, crash bugs, and failing tests (#232)

## 0.1.378 (2026-04-06)

### Features
- Fix 3 crash bugs: fanAgentId, null dereferences, cleanDispatchEntries (#228)

### Fixes
-  preserve horizontal scroll position on PR and work item tables

## 0.1.376 (2026-04-06)

### Features
- dashboard write locking for work-items.json (#227)

### Fixes
-  show red notification dot on Notes & KB when note is created
-  medium bugs — KB declaration, meeting phantom archive, lifecycle race (#216)

## 0.1.373 (2026-04-06)

### Features
- Fix review re-dispatch infinite loop (#226)
- Add subagent guidance and health check preamble to playbooks (#225)
- Fix 2 failing source-pattern test assertions (#224)

### Fixes
-  critical engine bugs — pipeline async, lifecycle null guard, scheduler (#215)
-  restore dispatched_to on work items when marking done after retry
-  copy button preserves markdown formatting

## 0.1.368 (2026-04-06)

### Fixes
-  dashboard audit pass 2 — CC error handling, charter edits, archived PRDs (#214)

## 0.1.367 (2026-04-06)

### Fixes
-  low-severity dashboard polish — null guards, event params, UI gaps (#213)
-  medium dashboard bugs — settings reset, work items, schedules, plans (#212)
-  XSS vulnerabilities across dashboard components (#211)

## 0.1.364 (2026-04-06)

### Fixes
-  critical dashboard bugs — plan pause, PRD tautology, inbox null guard (#210)

## 0.1.363 (2026-04-06)

### Features
- fix 3 runtime bugs — fan-out branch, dispatch cleanup, pipelines page (#204)
- Null-safe safeJson wrappers + dashboard crash guards (#203)
-  pipeline plan stage uses LLM to generate structured plan from meeting
-  show 'Converting to PRD' status instead of 'In Progress' during plan conversion

### Fixes
-  archived PRD picker uses file key instead of positional index
-  check pull-requests.json for existing PRs before no-PR retry
-  smart no-PR handling — distinguish MCP stall from intentional no-PR

## 0.1.356 (2026-04-06)

### Fixes
-  add MCP startup timeout — kill agent if no output after 3 minutes

## 0.1.355 (2026-04-06)

### Fixes
-  pipeline plan stage includes only meeting conclusion, not full transcript
-  pipeline plans include full meeting content, conclusion playbook requires concrete details
-  pipeline template regex now matches hyphenated stage IDs
-  pipeline Continue button shows immediate feedback
-  skip meeting modal re-render when data unchanged

## 0.1.350 (2026-04-06)

### Fixes
-  preserve scroll position in meeting modal during live-poll refresh
-  remove settings Reset button when modal closes
-  comprehensive status mutation guards — prevent done items from being reverted

### Other
- docs: update CLAUDE.md with constants, best practices, latest architecture

## 0.1.346 (2026-04-04)

### Fixes
-  settings reset CONFIG_PATH error + status shown beneath buttons
-  move settings status message to header actions bar next to buttons

## 0.1.344 (2026-04-04)

### Fixes
-  move Reset to Defaults button to settings modal header + fix getConfig error

## 0.1.343 (2026-04-04)

### Fixes
-  remove duplicate selfRefVars declaration in playbook.js

## 0.1.342 (2026-04-04)

### Fixes
- MM)

## 0.1.341 (2026-04-04)

### Features
-  add Reset to Defaults button in settings modal

### Fixes
- MM)
-  work items table shows date (YYYY-MM-DD) instead of time-only
-  CC stop button kills LLM process immediately + fix text/copy overlap

## 0.1.337 (2026-04-03)

### Fixes
-  completed dispatch stat shows actual count instead of capped 20
-  CC session auto-invalidated when system prompt changes after restart
-  clear stale buildStatus when PRs are merged or abandoned

## 0.1.334 (2026-04-03)

### Features
- Fix PR write races in ado.js and github.js

### Fixes
-  guarantee test cleanup via finally block in test harness

## 0.1.332 (2026-04-03)

### Fixes
-  retry doesn't revert completed work items + restore skipPr guard

## 0.1.331 (2026-04-03)

### Fixes
-  standardize PR created field to ISO format

## 0.1.330 (2026-04-03)

### Fixes
-  resolve all 25 lifecycle.js test failures
-  remove orphan statuses, add validation, replace in-progress with dispatched

## 0.1.328 (2026-04-03)

### Fixes
-  import PR_STATUS in engine.js — was causing discoverWork to fail

## 0.1.327 (2026-04-03)

### Fixes
-  eliminate all legacy done-status writers, add CANCELLED to WI_STATUS
-  stop writing legacy done aliases, add migration, keep read compat

## 0.1.325 (2026-04-03)

### Fixes
-  guard retry-counter write path against unreadable work items file
-  7 bugs from engine audit — runtime crashes, race conditions, stale state
-  scan skips NugetCache, OneDrive, .vs, packages + validates .git/HEAD

### Other
- refactor: final magic string replacements in engine, lifecycle, cleanup

## 0.1.321 (2026-04-03)

### Fixes
-  project scan finds git repos — .git was in skipDirs

### Other
- refactor: replace magic strings in remaining engine files with constants

## 0.1.319 (2026-04-03)

### Other
- refactor: replace magic strings in engine.js with constants

## 0.1.318 (2026-04-03)

### Fixes
-  scan modal shows actual home directory instead of ~
-  deduplicate PRs in pull-requests.json on write
-  show reviewer names in dashboard Signed Off By column

### Other
- refactor: use constants in lifecycle.js and timeout.js
- refactor: extract status/type/result constants to shared.js
- cleanup: remove evaluate.md (re-created by agents), fix stale references
- perf: CC message handling — debounce localStorage, cap array, batch scroll

## 0.1.312 (2026-04-03)

### Fixes
-  truncate work item title tooltip + description in modal to prevent UI lag
-  wrap all tickInner phases in try-catch for resilient dispatch

### Other
- refactor: simplify tick resilience — safe() helper, per-spawn catch, discovery guard

## 0.1.309 (2026-04-03)

### Fixes
-  per-item try-catch in discovery loops — one bad item no longer blocks tick

## 0.1.308 (2026-04-03)

### Features
- Fix PR write race conditions in lifecycle.js

## 0.1.306 (2026-04-03)

### Features
- Add null guards to dashboard.js request handlers

### Fixes
-  normalize acceptanceCriteria to array (string from doc-chat crashed tick)

## 0.1.304 (2026-04-03)

### Features
-  add Stop button to CC and doc-chat to abort in-flight requests

## 0.1.303 (2026-04-03)

### Fixes
-  meeting sort uses createdAt field (not created)
-  sort team meetings by timestamp descending (newest first)
-  PR dedup strict equality, work-items parse logging, undefined minionsVerdict

## 0.1.300 (2026-04-03)

### Fixes
-  re-apply verify workflow — defer archiving until verify completes
-  work item agent column falls back to item.agent field
-  CC workType descriptions restored + verify for maintenance/merge tasks

### Other
- resolve lifecycle.js conflict — accept agent changes

## 0.1.297 (2026-04-03)

### Features
- fix 7 bugs across cooldown, spawn-agent, playbook, scheduler, consolidation

### Fixes
-  remove orphaned test runner calls for functions lost in merge conflict resolution

## 0.1.295 (2026-04-03)

### Features
- fix engine.js race conditions — worktree TOCTOU, self-heal, dispatch dedup
- fix dashboard.js race conditions, input validation, and watcher leaks
- fix cleanup.js — worktree TOCTOU, readdirSync isolation, KB restore verify
- harden shared.js — backup verification, lock TOCTOU, docs
-  all doc-chats use Sonnet with full tools (agent change)

### Fixes
-  address PR-124 review feedback — safeJson regression, read-only lock, filter cleanup
-  address review feedback on PR-122
-  add behavioral tests for CRITICAL propagation and stale lock ENOENT
-  CRITICAL errors in safeJson now propagate to callers
-  defer plan archiving until verify completes, add 20 verify tests
-  enforce worktree isolation — 4 code paths fixed
- ' not 'Evaluate:'
-  cross-platform compatibility — signal handling, paths, home dir
-  engine sidebar badge only triggers on new dispatch errors

### Other
- resolve merge conflicts — accept agent changes, keep worktree isolation fix

## 0.1.285 (2026-04-03)

### Fixes
-  scan default path uses os.homedir() not env vars
-  render proper thinking layout immediately — no flash of unstyled text
-  thinking indicator layout — text ... dots ... elapsed time right-aligned
-  thinking indicator shows immediately when user sends message

## 0.1.281 (2026-04-03)

### Other
- refactor: remove duplicate thinking indicator — single source via updateStreamDiv

## 0.1.280 (2026-04-03)

### Features
-  thinking indicator shows progressive phases with elapsed timer

### Fixes
-  doc chat elapsed time no longer overlaps copy button

## 0.1.278 (2026-04-03)

### Features
-  sending a new CC message aborts the current request instead of queuing
-  CC streaming shows cumulative tool list with loading dots

### Fixes
-  thinking indicator persists alongside streamed text until done
-  queued messages show as individual bubbles always at the bottom
-  queued messages show as pinned indicator at bottom of chat
-  queued message pill shows on user side (right-aligned)
-  queued messages show as fresh user bubbles when processing starts
-  restore CC message queuing + scroll to queued message when processing
-  remove 'minions up' alias, keep 'minions restart' only
-  agent and engine usage tables both have 7 columns for alignment
-  streaming CC was popping user messages from _ccMessages
-  process remaining SSE buffer after stream ends + fallback finalization
-  Thinking... indicator shows alongside tool calls until text arrives
-  use safeJson instead of JSON.parse(safeRead()) in trigger-verify handler

## 0.1.265 (2026-04-03)

### Features
-  CC streaming shows tool use activity during multi-turn responses

### Fixes
-  clean up remaining evaluate references in comments and log messages

## 0.1.263 (2026-04-03)

### Features
-  real-time token streaming for CC via partial JSON extraction

### Fixes
-  all CC messages go through ccAddMessage — no more duplicated styling
-  streaming CC done event includes copy button matching ccAddMessage
-  streaming CC message bubble matches ccAddMessage styling
-  CC stream clears ccInFlight on client disconnect + defensive thinking.remove
-  remove last evaluate references — eval loop now creates review items

## 0.1.257 (2026-04-03)

### Features
-  streaming CC responses — text appears as it arrives via SSE

### Fixes
-  streaming CC handler now has full parity with non-streaming
-  remove dead 'data.actions' code from streaming CC path — caused ReferenceError
-  CC messages no longer show as "queued" after page refresh

## 0.1.253 (2026-04-03)

### Fixes
-  sanitize dispatch ID in temp filenames for Windows compatibility

## 0.1.252 (2026-04-03)

### Features
-  add 10 missing CC action types for full dashboard parity
-  add 'pin' action to CC — pin critical context to all agents
-  mandatory test validation before PR creation in implement and fix playbooks

### Fixes
-  don't hardcode npm test — agents must read project conventions

## 0.1.248 (2026-04-03)

### Fixes
-  skip worktrees in project scan, make scan optional during init

## 0.1.245 (2026-04-03)

### Features
-  minions uninstall --confirm — full removal command
-  capture-demos seeds mock data for richer screenshots
-  add capture-demos skill for regenerating GitHub Pages screenshots

### Fixes
-  set GH_TOKEN for gh CLI in publish workflow
-  publish workflow uses PR instead of direct push, CLI shows 'minions dash'
-  CLI audit — kill dashboard on restart, expose kill/complete, update help
-  clean _pendingReason on all status→done transitions, not just updateWorkItemStatus

### Other
- rename back to Minions Mission Control
- docs: fix quick start — use 'minions dash' not raw URL
- docs: update GitHub Pages with all features + fresh screenshots
- docs: fix outdated references across all documentation

## 0.1.233 (2026-04-03)

### Fixes
-  combine nuke and reset into single 'minions nuke --confirm'

## 0.1.232 (2026-04-03)

### Fixes
-  only show _pendingReason on actually pending items

## 0.1.231 (2026-04-03)

### Fixes
-  log CC failures to engine log for debugging

## 0.1.230 (2026-04-03)

### Fixes
-  remove all 'evaluate' work type — eval loop uses 'review' exclusively

## 0.1.229 (2026-04-03)

### Fixes
- consolidate temp agent metrics into one row

## 0.1.228 (2026-04-03)

### Features
-  scan for projects UI — modal with checkbox multi-select

### Fixes
-  CC system prompt now defaults to delegating work to agents

## 0.1.226 (2026-04-03)

### Features
- add evaluate type to routing and playbooks (#70)
- fix cooldown context accumulation bloat (#71)
- wire dead test and extract progress bar helper (#64)

### Fixes
-  silence git stderr noise during repo scan

## 0.1.224 (2026-04-03)

### Fixes
-  route 'minions scan' command to minions.js (was missing from CLI router)

## 0.1.223 (2026-04-03)

### Fixes
-  changelog uses commit messages instead of file lists

## 0.1.222 (2026-04-03)

### Other
- bin/minions.js

## 0.1.221 (2026-04-02)

### Other
- bin/minions.js

## 0.1.220 (2026-04-02)

### Documentation
- README.md

## 0.1.219 (2026-04-02)

### Other
- bin/minions.js

## 0.1.218 (2026-04-02)

### Engine
- engine.js
- engine/cli.js

### Other
- bin/minions.js
- minions.js
- team.md

## 0.1.217 (2026-04-02)

### Engine
- engine/preflight.js

## 0.1.216 (2026-04-02)

### Engine
- engine/preflight.js

### Other
- test/unit.test.js

## 0.1.215 (2026-04-02)

### Dashboard
- dashboard.js

## 0.1.214 (2026-04-02)

### Other
- bin/minions.js

## 0.1.213 (2026-04-02)

### Other
- bin/minions.js

## 0.1.212 (2026-04-02)

### Dashboard
- dashboard.js

## 0.1.211 (2026-04-02)

### Dashboard
- dashboard/js/settings.js

## 0.1.210 (2026-04-02)

### Dashboard
- dashboard/js/settings.js

## 0.1.209 (2026-04-02)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.208 (2026-04-02)

### Dashboard
- dashboard/layout.html

## 0.1.207 (2026-04-02)

### Engine
- engine.js
- engine/lifecycle.js
- engine/queries.js
- engine/shared.js
- engine/timeout.js

### Dashboard
- dashboard.js
- dashboard/js/refresh.js
- dashboard/js/render-plans.js
- dashboard/js/settings.js

## 0.1.206 (2026-04-02)

### Other
- minions.js

## 0.1.205 (2026-04-02)

### Engine
- engine/queries.js

### Dashboard
- dashboard/js/render-agents.js

## 0.1.204 (2026-04-02)

### Other
- minions.js

## 0.1.203 (2026-04-02)

### Other
- minions.js

## 0.1.202 (2026-04-02)

### Other
- minions.js

## 0.1.201 (2026-04-02)

### Engine
- engine/ado.js
- engine/github.js
- engine/lifecycle.js
- engine/preflight.js
- engine/queries.js
- engine/shared.js
- engine/spawn-agent.js

### Dashboard
- dashboard.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js

### Documentation
- README.md

### Other
- minions.js
- test/unit.test.js

## 0.1.189 (2026-04-02)

### Dashboard
- dashboard/js/render-plans.js

### Playbooks
- meeting-conclude.md

## 0.1.188 (2026-04-02)

### Dashboard
- dashboard/js/refresh.js

## 0.1.187 (2026-04-02)

### Engine
- engine/playbook.js

## 0.1.186 (2026-04-02)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.185 (2026-04-02)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.184 (2026-04-02)

### Dashboard
- dashboard.js

## 0.1.183 (2026-04-02)

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.182 (2026-04-02)

### Engine
- engine/lifecycle.js
- engine/shared.js

### Dashboard
- dashboard.js
- dashboard/js/render-pipelines.js

### Other
- test/unit.test.js

## 0.1.181 (2026-04-02)

### Engine
- engine/pipeline.js

## 0.1.180 (2026-04-02)

### Engine
- engine.js
- engine/ado.js
- engine/cleanup.js
- engine/lifecycle.js
- engine/meeting.js
- engine/routing.js
- engine/shared.js
- engine/spawn-agent.js

### Dashboard
- dashboard/js/render-dispatch.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-meetings.js
- dashboard/js/render-pinned.js
- dashboard/js/render-pipelines.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/render-prs.js
- dashboard/js/render-schedules.js
- dashboard/js/render-work-items.js
- dashboard/js/state.js

### Other
- test/unit.test.js

## 0.1.179 (2026-04-02)

### Dashboard
- dashboard/styles.css

## 0.1.178 (2026-04-02)

### Dashboard
- dashboard/layout.html
- dashboard/styles.css

## 0.1.177 (2026-04-02)

### Engine
- engine/cli.js

### Dashboard
- dashboard.js

## 0.1.176 (2026-04-02)

### Engine
- engine/meeting.js

### Dashboard
- dashboard/js/settings.js

## 0.1.175 (2026-04-02)

### Engine
- engine/cli.js

### Dashboard
- dashboard/js/refresh.js
- dashboard/layout.html

### Other
- minions.js

## 0.1.174 (2026-04-02)

### Dashboard
- dashboard/js/refresh.js

## 0.1.173 (2026-04-02)

### Engine
- engine/lifecycle.js
- engine/shared.js

### Dashboard
- dashboard/js/render-pipelines.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js

## 0.1.171 (2026-04-02)

### Dashboard
- dashboard/js/utils.js
- dashboard/styles.css

## 0.1.170 (2026-04-02)

### Engine
- engine/pipeline.js

### Dashboard
- dashboard/js/command-center.js
- dashboard/js/render-pipelines.js
- dashboard/layout.html
- dashboard/styles.css

## 0.1.169 (2026-04-02)

### Engine
- engine/lifecycle.js

## 0.1.168 (2026-04-02)

### Engine
- engine.js
- engine/lifecycle.js
- engine/playbook.js
- engine/shared.js

### Dashboard
- dashboard.js
- dashboard/js/render-work-items.js
- dashboard/js/settings.js

### Other
- routing.md
- test/unit.test.js

## 0.1.167 (2026-04-02)

### Engine
- engine.js

### Other
- CLAUDE.md
- minions.js

## 0.1.166 (2026-04-02)

### Engine
- engine.js

## 0.1.165 (2026-04-02)

### Engine
- engine.js

## 0.1.164 (2026-04-02)

### Engine
- engine/lifecycle.js

## 0.1.163 (2026-04-02)

### Engine
- engine/lifecycle.js

## 0.1.162 (2026-04-02)

### Other
- test/unit.test.js

## 0.1.160 (2026-04-02)

### Engine
- engine/lifecycle.js

## 0.1.159 (2026-04-02)

### Engine
- engine/queries.js

## 0.1.158 (2026-04-02)

### Engine
- engine/shared.js

## 0.1.157 (2026-04-02)

### Engine
- engine.js
- engine/ado.js
- engine/github.js
- engine/shared.js

### Other
- pipelines/daily-standup.json
- test/unit.test.js

## 0.1.156 (2026-04-02)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js

### Other
- test/unit.test.js

## 0.1.155 (2026-04-02)

### Engine
- engine.js
- engine/lifecycle.js
- engine/playbook.js
- engine/queries.js

### Dashboard
- dashboard.html
- dashboard.js
- dashboard/js/command-center.js
- dashboard/js/modal-qa.js
- dashboard/js/modal.js
- dashboard/js/refresh.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-pipelines.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/render-work-items.js
- dashboard/styles.css

### Playbooks
- implement.md

### Documentation
- deprecated.json

### Other
- test/unit.test.js

## 0.1.152 (2026-04-02)

### Dashboard
- dashboard.js

## 0.1.151 (2026-04-02)

### Engine
- engine.js
- engine/lifecycle.js

### Dashboard
- dashboard/js/command-center.js
- dashboard/js/render-meetings.js

### Playbooks
- work-item.md

## 0.1.150 (2026-04-01)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.149 (2026-04-01)

### Engine
- engine.js
- engine/meeting.js
- engine/shared.js

### Other
- test/unit.test.js

## 0.1.148 (2026-04-01)

### Engine
- engine.js
- engine/lifecycle.js
- engine/shared.js

### Dashboard
- dashboard/js/command-center.js
- dashboard/js/render-work-items.js
- dashboard/layout.html
- dashboard/styles.css

### Other
- .github/workflows/pr-tests.yml
- test/unit.test.js

## 0.1.146 (2026-04-01)

### Engine
- engine.js
- engine/ado.js
- engine/cleanup.js
- engine/cooldown.js
- engine/github.js
- engine/lifecycle.js
- engine/meeting.js
- engine/playbook.js
- engine/routing.js
- engine/shared.js
- engine/timeout.js

### Dashboard
- dashboard/js/render-other.js
- dashboard/js/render-work-items.js
- dashboard/pages/engine.html
- dashboard/styles.css

### Playbooks
- evaluate.md
- fix.md
- implement.md

### Other
- CLAUDE.md
- routing.md
- test/unit.test.js

## 0.1.143 (2026-04-01)

### Engine
- engine/shared.js

### Other
- test/unit.test.js

## 0.1.142 (2026-04-01)

### Engine
- engine/cleanup.js

### Dashboard
- dashboard.js
- dashboard/js/render-meetings.js
- dashboard/js/render-plans.js

### Playbooks
- build-and-test.md
- explore.md
- fix.md
- implement.md
- test.md
- work-item.md

## 0.1.141 (2026-04-01)

### Dashboard
- dashboard/pages/pipelines.html
- dashboard/pages/schedule.html

## 0.1.140 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/command-center.js
- dashboard/js/render-pipelines.js

## 0.1.139 (2026-04-01)

### Dashboard
- dashboard/js/render-pipelines.js

## 0.1.138 (2026-04-01)

### Dashboard
- dashboard/pages/pipelines.html

## 0.1.137 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/refresh.js
- dashboard/pages/inbox.html
- dashboard/pages/pipelines.html

## 0.1.136 (2026-04-01)

### Dashboard
- dashboard/pages/engine.html
- dashboard/pages/home.html
- dashboard/pages/meetings.html
- dashboard/pages/plans.html
- dashboard/pages/prs.html
- dashboard/pages/schedule.html
- dashboard/pages/work.html

### Other
- test/unit.test.js

## 0.1.135 (2026-04-01)

### Dashboard
- dashboard/pages/tools.html

## 0.1.134 (2026-04-01)

### Dashboard
- dashboard/pages/plans.html

## 0.1.133 (2026-04-01)

### Dashboard
- dashboard/pages/plans.html

## 0.1.132 (2026-04-01)

### Engine
- engine.js
- engine/lifecycle.js

## 0.1.131 (2026-04-01)

### Engine
- engine.js
- engine/ado.js
- engine/pipeline.js

### Dashboard
- dashboard.js
- dashboard/js/refresh.js
- dashboard/js/render-pipelines.js
- dashboard/layout.html
- dashboard/pages/pipelines.html

## 0.1.130 (2026-04-01)

### Engine
- engine/lifecycle.js
- engine/shared.js
- engine/timeout.js

### Dashboard
- dashboard.js

## 0.1.129 (2026-04-01)

### Engine
- engine/github.js
- engine/preflight.js
- engine/spawn-agent.js

### Dashboard
- dashboard/js/modal.js
- dashboard/js/render-agents.js

## 0.1.128 (2026-04-01)

### Engine
- engine.js
- engine/dispatch.js
- engine/lifecycle.js
- engine/timeout.js

### Dashboard
- dashboard.js
- dashboard/js/render-work-items.js

### Other
- test/unit.test.js

## 0.1.127 (2026-04-01)

### Engine
- engine.js
- engine/meeting.js

### Dashboard
- dashboard/js/render-kb.js
- dashboard/js/render-schedules.js

## 0.1.126 (2026-04-01)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard/js/detail-panel.js
- dashboard/js/render-meetings.js
- dashboard/js/render-work-items.js
- dashboard/js/settings.js

## 0.1.125 (2026-04-01)

### Dashboard
- dashboard/js/render-schedules.js

## 0.1.124 (2026-04-01)

### Dashboard
- dashboard/js/render-schedules.js
- dashboard/styles.css

## 0.1.123 (2026-04-01)

### Engine
- engine/ado-mcp-wrapper.js

### Dashboard
- dashboard.js
- dashboard/js/detail-panel.js
- dashboard/js/modal-qa.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-plans.js
- dashboard/js/utils.js
- dashboard/styles.css

## 0.1.122 (2026-04-01)

### Other
- test/unit.test.js

## 0.1.121 (2026-04-01)

### Dashboard
- dashboard.js

## 0.1.120 (2026-04-01)

### Dashboard
- dashboard/js/settings.js

## 0.1.119 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.118 (2026-04-01)

### Playbooks
- plan-to-prd.md

## 0.1.117 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/refresh.js
- dashboard/pages/plans.html

## 0.1.116 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/command-center.js

## 0.1.115 (2026-04-01)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.114 (2026-04-01)

### Dashboard
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-meetings.js
- dashboard/js/render-pinned.js
- dashboard/js/render-prs.js
- dashboard/js/render-schedules.js
- dashboard/js/render-work-items.js
- dashboard/js/utils.js

## 0.1.113 (2026-04-01)

### Dashboard
- dashboard/styles.css

## 0.1.112 (2026-04-01)

### Engine
- engine/ado.js
- engine/github.js
- engine/lifecycle.js

### Dashboard
- dashboard.js
- dashboard/js/live-stream.js
- dashboard/js/modal-qa.js
- dashboard/js/utils.js

## 0.1.110 (2026-04-01)

### Dashboard
- dashboard/js/render-schedules.js

## 0.1.109 (2026-04-01)

### Dashboard
- dashboard/js/utils.js

## 0.1.108 (2026-04-01)

### Dashboard
- dashboard/js/render-kb.js

## 0.1.107 (2026-04-01)

### Dashboard
- dashboard/styles.css

## 0.1.106 (2026-04-01)

### Engine
- engine/consolidation.js

### Other
- prd/_test-idempotency.json.bak

## 0.1.105 (2026-04-01)

### Dashboard
- dashboard/js/render-inbox.js

### Other
- test/unit.test.js

## 0.1.104 (2026-04-01)

### Engine
- engine/lifecycle.js

## 0.1.103 (2026-04-01)

### Engine
- engine/lifecycle.js
- engine/meeting.js
- engine/shared.js

### Other
- test/unit.test.js

## 0.1.102 (2026-04-01)

### Engine
- engine/scheduler.js

### Other
- test/unit.test.js

## 0.1.101 (2026-04-01)

### Engine
- engine.js
- engine/ado.js
- engine/cleanup.js
- engine/consolidation.js
- engine/dispatch.js
- engine/github.js
- engine/lifecycle.js
- engine/preflight.js
- engine/queries.js
- engine/shared.js

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.97 (2026-04-01)

### Engine
- engine/ado.js
- engine/github.js

### Dashboard
- dashboard.js
- dashboard/js/render-prd.js
- dashboard/js/render-prs.js

## 0.1.96 (2026-04-01)

### Engine
- engine.js
- engine/ado.js
- engine/github.js
- engine/queries.js

### Dashboard
- dashboard.js
- dashboard/js/detail-panel.js
- dashboard/js/live-stream.js
- dashboard/js/modal-qa.js
- dashboard/js/render-agents.js
- dashboard/js/render-inbox.js
- dashboard/js/render-meetings.js
- dashboard/js/render-pinned.js
- dashboard/js/render-work-items.js
- dashboard/js/utils.js

### Playbooks
- meeting-conclude.md

## 0.1.95 (2026-04-01)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.94 (2026-04-01)

### Dashboard
- dashboard/js/render-prs.js

## 0.1.93 (2026-04-01)

### Dashboard
- dashboard/js/render-prd.js

## 0.1.92 (2026-04-01)

### Engine
- engine/lifecycle.js
- engine/shared.js

### Dashboard
- dashboard/js/render-other.js

## 0.1.91 (2026-04-01)

### Dashboard
- dashboard/styles.css

## 0.1.90 (2026-04-01)

### Dashboard
- dashboard/js/command-center.js

## 0.1.89 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/command-center.js
- dashboard/js/render-meetings.js

## 0.1.88 (2026-04-01)

### Dashboard
- dashboard.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js

## 0.1.87 (2026-04-01)

### Engine
- engine.js
- engine/consolidation.js
- engine/dispatch.js
- engine/lifecycle.js
- engine/meeting.js
- engine/playbook.js
- engine/shared.js

### Other
- test/unit.test.js
- tools/generate-pixel-art.js
- tools/pixel-robot.bmp

## 0.1.86 (2026-03-31)

### Dashboard
- dashboard/js/render-prd.js

## 0.1.85 (2026-03-31)

### Dashboard
- dashboard.js

## 0.1.84 (2026-03-31)

### Dashboard
- dashboard/js/render-kb.js

## 0.1.83 (2026-03-31)

### Engine
- engine/lifecycle.js

## 0.1.82 (2026-03-31)

### Engine
- engine/lifecycle.js

### Dashboard
- dashboard.js
- dashboard/js/command-center.js

### Playbooks
- implement.md

## 0.1.81 (2026-03-31)

### Dashboard
- dashboard.js
- dashboard/js/render-schedules.js

## 0.1.80 (2026-03-31)

### Engine
- engine/queries.js

### Dashboard
- dashboard.js
- dashboard/js/modal-qa.js
- dashboard/js/render-plans.js

## 0.1.79 (2026-03-31)

### Dashboard
- dashboard/js/render-prd.js

## 0.1.78 (2026-03-31)

### Engine
- engine.js

## 0.1.77 (2026-03-31)

### Engine
- engine/lifecycle.js

## 0.1.76 (2026-03-31)

### Engine
- engine/lifecycle.js
- engine/meeting.js
- engine/shared.js
- engine/timeout.js

### Dashboard
- dashboard/js/live-stream.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js

## 0.1.75 (2026-03-31)

### Dashboard
- dashboard.js

## 0.1.74 (2026-03-31)

### Dashboard
- dashboard/js/render-meetings.js

## 0.1.73 (2026-03-31)

### Dashboard
- dashboard/js/refresh.js
- dashboard/js/state.js
- dashboard/styles.css

## 0.1.72 (2026-03-31)

### Dashboard
- dashboard/js/live-stream.js

## 0.1.71 (2026-03-31)

### Dashboard
- dashboard/js/refresh.js

## 0.1.70 (2026-03-31)

### Other
- test/unit.test.js

## 0.1.69 (2026-03-31)

### Dashboard
- dashboard/js/command-center.js

## 0.1.68 (2026-03-31)

### Dashboard
- dashboard.js

## 0.1.67 (2026-03-31)

### Dashboard
- dashboard/js/command-center.js
- dashboard/layout.html

## 0.1.66 (2026-03-31)

### Dashboard
- dashboard.js
- dashboard/js/refresh.js

## 0.1.65 (2026-03-31)

### Engine
- engine.js
- engine/lifecycle.js
- engine/meeting.js
- engine/playbook.js

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/js/refresh.js
- dashboard/js/render-meetings.js
- dashboard/layout.html
- dashboard/pages/meetings.html

### Playbooks
- meeting-conclude.md
- meeting-debate.md
- meeting-investigate.md

### Other
- routing.md

## 0.1.64 (2026-03-31)

### Playbooks
- implement.md

### Agents
- agents/dallas/charter.md
- agents/lambert/charter.md
- agents/ralph/charter.md
- agents/rebecca/charter.md
- agents/ripley/charter.md

### Other
- skills/.gitkeep

## 0.1.63 (2026-03-31)

### Engine
- engine/scheduler.js

## 0.1.62 (2026-03-30)

### Dashboard
- dashboard/js/command-center.js
- dashboard/js/command-history.js
- dashboard/js/command-input.js
- dashboard/js/command-parser.js
- dashboard/js/detail-panel.js
- dashboard/js/live-stream.js
- dashboard/js/modal-qa.js
- dashboard/js/modal.js
- dashboard/js/refresh.js
- dashboard/js/render-agents.js
- dashboard/js/render-dispatch.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-other.js
- dashboard/js/render-pinned.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/render-prs.js
- dashboard/js/render-schedules.js
- dashboard/js/render-skills.js
- dashboard/js/render-work-items.js
- dashboard/js/settings.js
- dashboard/js/state.js
- dashboard/js/utils.js

## 0.1.61 (2026-03-30)

### Engine
- engine.js
- engine/cleanup.js
- engine/dispatch.js
- engine/timeout.js

### Other
- test/unit.test.js

## 0.1.60 (2026-03-30)

### Engine
- engine.js
- engine/cooldown.js
- engine/playbook.js
- engine/routing.js

### Other
- test/unit.test.js

## 0.1.59 (2026-03-30)

### Engine
- engine.js
- engine/ado.js
- engine/cli.js
- engine/consolidation.js
- engine/github.js
- engine/lifecycle.js
- engine/llm.js
- engine/preflight.js
- engine/queries.js
- engine/shared.js
- engine/spawn-agent.js

### Dashboard
- dashboard.js
- dashboard/js/command-center.js
- dashboard/js/live-stream.js
- dashboard/js/modal-qa.js
- dashboard/js/refresh.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-plans.js
- dashboard/js/render-prs.js
- dashboard/js/render-work-items.js
- dashboard/js/settings.js

## 0.1.58 (2026-03-30)

### Engine
- engine.js

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.57 (2026-03-30)

### Engine
- engine.js

## 0.1.56 (2026-03-30)

### Other
- bin/minions.js

## 0.1.55 (2026-03-30)

### Engine
- engine/cli.js

### Dashboard
- dashboard.js
- dashboard/js/refresh.js

## 0.1.54 (2026-03-30)

### Engine
- engine.js

## 0.1.53 (2026-03-30)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.52 (2026-03-30)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.51 (2026-03-30)

### Other
- test/unit.test.js

## 0.1.50 (2026-03-30)

### Dashboard
- dashboard/js/render-prd.js

## 0.1.49 (2026-03-30)

### Dashboard
- dashboard/js/render-prd.js

## 0.1.48 (2026-03-30)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.47 (2026-03-30)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.46 (2026-03-29)

### Dashboard
- dashboard/js/render-plans.js

## 0.1.45 (2026-03-29)

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/layout.html
- dashboard/pages/plans.html

### Other
- test/unit.test.js

## 0.1.44 (2026-03-29)

### Other
- test/unit.test.js

## 0.1.43 (2026-03-29)

### Engine
- engine/github.js

### Dashboard
- dashboard.js

## 0.1.42 (2026-03-29)

### Dashboard
- dashboard.js

## 0.1.41 (2026-03-29)

### Engine
- engine/queries.js

## 0.1.40 (2026-03-29)

### Dashboard
- dashboard.js
- dashboard/js/render-plans.js
- dashboard/pages/plans.html

## 0.1.39 (2026-03-29)

### Engine
- engine.js

### Dashboard
- dashboard.js
- dashboard/js/render-prs.js
- dashboard/pages/prs.html

## 0.1.38 (2026-03-29)

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/layout.html
- dashboard/pages/inbox.html
- dashboard/pages/schedule.html
- dashboard/pages/tools.html

## 0.1.37 (2026-03-28)

### Dashboard
- dashboard.js
- dashboard/js/refresh.js

## 0.1.36 (2026-03-28)

### Dashboard
- dashboard.js

## 0.1.35 (2026-03-28)

### Dashboard
- dashboard/js/render-work-items.js

## 0.1.34 (2026-03-28)

### Dashboard
- dashboard/js/render-work-items.js
- dashboard/pages/work.html

## 0.1.33 (2026-03-28)

### Dashboard
- dashboard.js

## 0.1.32 (2026-03-28)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.31 (2026-03-28)

### Dashboard
- dashboard/js/settings.js

## 0.1.30 (2026-03-28)

### Dashboard
- dashboard/js/render-work-items.js

## 0.1.29 (2026-03-28)

### Dashboard
- dashboard.js

## 0.1.28 (2026-03-28)

### Engine
- engine.js

### Dashboard
- dashboard/js/detail-panel.js

## 0.1.27 (2026-03-28)

### Engine
- engine.js

## 0.1.26 (2026-03-28)

### Engine
- engine.js

### Dashboard
- dashboard.js
- dashboard/js/detail-panel.js
- dashboard/js/live-stream.js

## 0.1.25 (2026-03-28)

### Engine
- engine.js
- engine/lifecycle.js

### Other
- test/unit.test.js

## 0.1.24 (2026-03-28)

### Engine
- engine.js

## 0.1.23 (2026-03-28)

### Other
- test/unit.test.js

## 0.1.22 (2026-03-28)

### Dashboard
- dashboard.js
- dashboard/js/render-inbox.js

## 0.1.21 (2026-03-28)

### Dashboard
- dashboard.js
- dashboard/js/settings.js

## 0.1.20 (2026-03-28)

### Dashboard
- dashboard/js/settings.js

## 0.1.19 (2026-03-28)

### Other
- CLAUDE.md
- test/unit.test.js

## 0.1.18 (2026-03-28)

### Dashboard
- dashboard/js/render-inbox.js

## 0.1.17 (2026-03-28)

### Engine
- engine.js

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/js/refresh.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-pinned.js
- dashboard/js/render-work-items.js
- dashboard/pages/home.html
- dashboard/pages/inbox.html

## 0.1.16 (2026-03-28)

### Dashboard
- dashboard/js/render-other.js

## 0.1.15 (2026-03-28)

### Dashboard
- dashboard/js/command-center.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/render-work-items.js
- dashboard/js/utils.js

## 0.1.14 (2026-03-26)

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/js/modal-qa.js
- dashboard/js/render-agents.js
- dashboard/js/render-dispatch.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/settings.js

### Other
- test/playwright/dashboard.spec.js

## 0.1.13 (2026-03-26)

### Dashboard
- dashboard-build.js
- dashboard.js
- dashboard/js/command-center.js
- dashboard/js/command-history.js
- dashboard/js/command-input.js
- dashboard/js/command-parser.js
- dashboard/js/detail-panel.js
- dashboard/js/live-stream.js
- dashboard/js/modal-qa.js
- dashboard/js/modal.js
- dashboard/js/refresh.js
- dashboard/js/render-agents.js
- dashboard/js/render-dispatch.js
- dashboard/js/render-inbox.js
- dashboard/js/render-kb.js
- dashboard/js/render-other.js
- dashboard/js/render-plans.js
- dashboard/js/render-prd.js
- dashboard/js/render-prs.js
- dashboard/js/render-schedules.js
- dashboard/js/render-skills.js
- dashboard/js/render-work-items.js
- dashboard/js/settings.js
- dashboard/js/state.js
- dashboard/js/utils.js
- dashboard/layout.html
- dashboard/pages/engine.html
- dashboard/pages/home.html
- dashboard/pages/inbox.html
- dashboard/pages/plans.html
- dashboard/pages/prd.html
- dashboard/pages/prs.html
- dashboard/pages/schedule.html
- dashboard/pages/work.html
- dashboard/styles.css

### Other
- test/unit.test.js

## 0.1.12 (2026-03-26)

### Engine
- engine.js
- engine/ado.js
- engine/cli.js
- engine/github.js
- engine/lifecycle.js

### Dashboard
- dashboard.html
- dashboard.js

### Other
- TODO.md
- routing.md
- test/unit.test.js

## 0.1.11 (2026-03-26)

### Engine
- engine.js
- engine/lifecycle.js
- engine/scheduler.js

### Dashboard
- dashboard.html
- dashboard.js

### Other
- test/unit.test.js

## 0.1.9 (2026-03-26)

### Engine
- engine.js
- engine/ado.js
- engine/cli.js
- engine/github.js
- engine/lifecycle.js
- engine/scheduler.js
- engine/shared.js

### Dashboard
- dashboard.html
- dashboard.js

### Playbooks
- decompose.md

### Documentation
- README.md

### Other
- CLAUDE.md
- TODO.md
- routing.md
- test/playwright/dashboard.spec.js

## 0.1.8 (2026-03-25)

### Engine
- engine.js
- engine/cli.js
- engine/preflight.js
- engine/shared.js
- engine/spawn-agent.js

### Documentation
- README.md
- auto-discovery.md

### Other
- CLAUDE.md
- bin/minions.js
- config.template.json
- test/unit.test.js

## 0.1.7 (2026-03-24)

### Documentation
- README.md

## 0.1.6 (2026-03-24)

### Other
- test/unit.test.js

## 0.1.5 (2026-03-24)

### Engine
- engine.js

## 0.1.4 (2026-03-24)

### Engine
- engine.js
- engine/ado.js
- engine/github.js
- engine/lifecycle.js

## 0.1.3 (2026-03-24)

### Engine
- engine/lifecycle.js

### Dashboard
- dashboard.html
- dashboard.js

## 0.1.1 (2026-03-23)

### Engine
- engine.js
- engine/ado.js
- engine/cli.js
- engine/consolidation.js
- engine/github.js
- engine/lifecycle.js
- engine/llm.js
- engine/queries.js
- engine/shared.js

### Dashboard
- dashboard.html
- dashboard.js

### Playbooks
- build-and-test.md
- explore.md
- fix.md
- implement-shared.md
- implement.md
- plan-to-prd.md
- plan.md
- review.md
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
- human-vs-automated.md
- index.html
- plan-lifecycle.md
- self-improvement.md

### Other
- .claude/skills/cleanup-deprecated/SKILL.md
- .claude/skills/run-tests/SKILL.md
- .github/workflows/publish.yml
- CLAUDE.md
- TODO.md
- bin/minions.js
- config.template.json
- minions.js
- package-lock.json
- team.md
- test/demo.html
- test/minions-tests.js
- test/playwright/dashboard.spec.js
- test/playwright/reporter.js
- test/pre-commit-hook.js
- test/seed-demo-data.js
- test/unit.test.js

## 0.1.119 (2026-03-21)

### Engine
- engine/lifecycle.js

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.118 (2026-03-21)

### Engine
- engine.js
- engine/lifecycle.js

## 0.1.117 (2026-03-21)

### Dashboard
- dashboard.html

## 0.1.116 (2026-03-21)

### Dashboard
- dashboard.js

## 0.1.115 (2026-03-21)

### Engine
- engine.js
- engine/llm.js

### Dashboard
- dashboard.html
- dashboard.js

### Other
- test/unit.test.js

## 0.1.114 (2026-03-21)

### Engine
- engine/queries.js

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.113 (2026-03-21)

### Engine
- engine.js
- engine/lifecycle.js
- engine/queries.js

### Dashboard
- dashboard.html
- dashboard.js

### Playbooks
- plan-to-prd.md

### Documentation
- deprecated.json
- index.html

### Other
- .claude/skills/cleanup-deprecated/SKILL.md
- CLAUDE.md
- TODO.md
- test/demo.html
- test/seed-demo-data.js
- test/unit.test.js

## 0.1.112 (2026-03-21)

### Engine
- engine/ado.js

### Dashboard
- dashboard.html
- dashboard.js

### Other
- test/unit.test.js

## 0.1.111 (2026-03-20)

### Engine
- engine.js

## 0.1.110 (2026-03-20)

### Engine
- engine.js

## 0.1.109 (2026-03-20)

### Engine
- engine.js

## 0.1.108 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.107 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.106 (2026-03-20)

### Engine
- engine/queries.js

### Other
- test/unit.test.js

## 0.1.105 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.104 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.103 (2026-03-20)

### Other
- bin/minions.js
- test/unit.test.js

## 0.1.102 (2026-03-20)

### Dashboard
- dashboard.html

## 0.1.101 (2026-03-20)

### Dashboard
- dashboard.html
- dashboard.js

## 0.1.100 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.99 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.98 (2026-03-20)

### Engine
- engine/lifecycle.js

### Other
- test/unit.test.js

## 0.1.97 (2026-03-20)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.96 (2026-03-20)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.95 (2026-03-20)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard.html
- dashboard.js

### Documentation
- README.md
- auto-discovery.md

### Other
- test/unit.test.js

## 0.1.94 (2026-03-20)

### Engine
- engine.js
- engine/shared.js

### Dashboard
- dashboard.html
- dashboard.js

### Documentation
- README.md
- auto-discovery.md

### Other
- test/unit.test.js

## 0.1.93 (2026-03-20)

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.92 (2026-03-19)

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.91 (2026-03-19)

### Engine
- engine.js

### Other
- test/unit.test.js

## 0.1.90 (2026-03-19)

### Documentation
- auto-discovery.md

## 0.1.89 (2026-03-19)

### Other
- bin/minions.js
- test/unit.test.js

## 0.1.88 (2026-03-19)

### Engine
- engine/shared.js

### Other
- minions.js
- test/unit.test.js

## 0.1.87 (2026-03-19)

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.86 (2026-03-19)

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.85 (2026-03-19)

### Dashboard
- dashboard.html

## 0.1.84 (2026-03-19)

### Dashboard
- dashboard.html

### Other
- test/unit.test.js

## 0.1.83 (2026-03-19)

### Other
- bin/minions.js
- test/unit.test.js

## 0.1.81 (2026-03-19)

### Engine
- engine.js
- engine/cli.js
- engine/queries.js

### Documentation
- README.md
- auto-discovery.md
- engine-restart.md

### Other
- test/unit.test.js

## 0.1.80 (2026-03-19)

### Engine
- engine.js
- engine/lifecycle.js

### Other
- test/unit.test.js

## 0.1.79 (2026-03-19)

### Dashboard
- dashboard.html
- dashboard.js

### Documentation
- 01-dashboard-overview.gif
- 02-command-center.gif
- 03-work-items.gif
- 04-plan-docchat.gif
- 05-prd-progress.gif
- 06-inbox-metrics.gif
- index.html

### Other
- bin/minions.js
- minions.js

## 0.1.78 (2026-03-19)

### Other
- minions.js

## 0.1.77 (2026-03-19)

### Other
- minions.js

## 0.1.76 (2026-03-19)

### Dashboard
- dashboard.js

## 0.1.75 (2026-03-19)

### Other
- minions.js

## 0.1.74 (2026-03-19)

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.73 (2026-03-19)

### Other
- test/demo-screenshots/01-dashboard-overview.gif
- test/demo-screenshots/02-command-center.gif
- test/demo-screenshots/03-work-items.gif
- test/demo-screenshots/04-plan-docchat.gif
- test/demo-screenshots/05-prd-progress.gif
- test/demo-screenshots/06-inbox-metrics.gif
- test/seed-demo-data.js

## 0.1.72 (2026-03-19)

### Engine
- engine/queries.js

### Other
- test/demo-screenshots/01-dashboard-overview.gif
- test/demo-screenshots/02-command-center.gif
- test/demo-screenshots/03-work-items.gif
- test/demo-screenshots/04-plan-docchat.gif
- test/demo-screenshots/05-prd-progress.gif
- test/demo-screenshots/06-inbox-metrics.gif
- test/demo.html
- test/record-demo.js

## 0.1.71 (2026-03-19)

### Other
- test/demo-screenshots/01-dashboard-overview.png
- test/demo-screenshots/02-dashboard-workitems-prd.png
- test/demo-screenshots/03-dashboard-bottom.png
- test/demo-screenshots/04-cc-plan-request.png
- test/demo-screenshots/05-cc-work-item.png
- test/demo-screenshots/06-work-items-table.png
- test/demo-screenshots/07-work-item-retry-button.png
- test/demo-screenshots/08-plans-section.png
- test/demo-screenshots/09-plan-detail-modal.png
- test/demo-screenshots/10-prd-progress.png
- test/demo-screenshots/11-inbox-section.png
- test/demo-screenshots/12-dispatch-queue.png
- test/demo-screenshots/13-agent-metrics.png
- test/demo-screenshots/14-full-page.png
- test/demo.html
- test/record-demo.js
- test/scenarios.md
- test/seed-demo-data.js

## 0.1.70 (2026-03-19)

### Engine
- engine.js
- engine/lifecycle.js

### Other
- test/unit.test.js

## 0.1.69 (2026-03-19)

### Engine
- engine.js
- engine/queries.js
- engine/shared.js

### Dashboard
- dashboard.js

## 0.1.68 (2026-03-19)

### Engine
- engine/queries.js

### Dashboard
- dashboard.html
- dashboard.js

## 0.1.67 (2026-03-19)

### Engine
- engine.js

### Dashboard
- dashboard.js

### Other
- test/unit.test.js

## 0.1.66 (2026-03-19)

### Engine
- engine.js

### Dashboard
- dashboard.html
- dashboard.js

### Other
- test/unit.test.js

## 0.1.65 (2026-03-19)

### Dashboard
- dashboard.html
- dashboard.js

## 0.1.64 (2026-03-19)

### Engine
- engine.js
- engine/cli.js
- engine/lifecycle.js

### Dashboard
- dashboard.js

### Playbooks
- plan-to-prd.md

### Other
- test/unit.test.js

## 0.1.63 (2026-03-19)

### Engine
- engine/ado.js
- engine/github.js

### Other
- test/unit.test.js

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
- minions.js
- test/unit.test.js

## 0.1.59 (2026-03-19)

### Engine
- engine.js
- engine/lifecycle.js
- engine/shared.js

### Other
- .claude/skills/run-tests/SKILL.md
- test/minions-tests.js
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
- bin/minions.js
- config.template.json
- playwright.config.js
- routing.md
- minions.js
- team.md
- test/playwright/accept-baseline.js
- test/playwright/dashboard.spec.js
- test/playwright/reporter.js
- test/pre-commit-hook.js
- test/minions-tests.js

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
- bin/minions.js
- config.template.json
- playwright.config.js
- routing.md
- minions.js
- team.md
- test/playwright/accept-baseline.js
- test/playwright/dashboard.spec.js
- test/playwright/reporter.js
- test/pre-commit-hook.js
- test/minions-tests.js

All notable changes to Minions are documented here. Versions are auto-published to npm on each sync.

## 0.2.x (2026-03-15)

### Upgrade System
- **Smart upgrade** — `minions init --force` now copies new files, updates engine code, and preserves user customizations
- **Version tracking** — `.minions-version` file tracks installed version for upgrade detection
- **`minions version`** — shows installed vs package version, prompts to upgrade if outdated
- **Upgrade summary** — shows what was updated, added, and preserved during upgrade
- **New files auto-added** — new playbooks, charters, and docs added in updates are automatically installed

### Engine
- **`/plan` command** — full pipeline: feature description → PRD items → agent dispatch across projects
- **Shared feature branches** — dependency-aware dispatch ensures agents work on the same branch
- **Human PR feedback loop** — `@minions` comments on PRs trigger agent fix tasks
- **Minions-level PRD** — multi-project PRD support
- **`/ask` command** — ask questions via Command Center, get answers in inbox
- **Auto-detect user questions** — drop `ask-*.md` files in inbox, engine routes to an agent
- **Solo reviewer skip** — `@minions` keyword not required when you're the only reviewer
- **Knowledge base** — categorized agent learnings stored in `knowledge/` (architecture, conventions, reviews, etc.)
- **Command Center** — persistent multi-turn Sonnet sessions with full minions awareness and tool access
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
- **npm package `@yemi33/minions`** — install with `npm install -g @yemi33/minions`
- **Unified CLI** — single `minions` command for all operations
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

