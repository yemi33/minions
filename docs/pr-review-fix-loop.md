# PR Review & Fix Loop

How the engine manages the lifecycle of a PR from creation through review, fix, and re-review.

## 1. Implement agent creates PR

- Agent pushes code, output contains PR URL
- `syncPrsFromOutput()` (lifecycle.js) extracts URL via regex, creates `pull-requests.json` entry, links to work item via `addPrLink()`

## 2. Engine discovers PR needs review

- `discoverFromPrs()` (engine.js) runs each tick (~60s)
- Gates: `status === 'active'` + `reviewStatus === 'pending'` + not reviewed since last push + not dispatched + not on cooldown
- Pre-dispatch: `checkLiveReviewStatus()` hits GitHub/ADO API to catch stale cached status
- Routes to reviewer via `resolveAgent('review')`, dispatches with `review.md` playbook

## 3. Review completes

- `updatePrAfterReview()` (lifecycle.js) re-checks live vote from platform (may have changed during execution)
- Sets `reviewStatus` to `approved` / `changes-requested` / `waiting`
- Stores `minionsReview: { reviewer, reviewedAt, note }`
- Creates feedback file for author agent

## 4. Fix dispatch (3 independent triggers, at most one per tick)

### A. Review feedback (`changes-requested`)

- Gate: `reviewStatus === 'changes-requested'` + `!awaitingReReview` + not dispatched + not on cooldown
- Routes to PR author via `_author_` routing token
- `review_note` = reviewer's feedback
- Sets `fixDispatched = true` — prevents trigger B from also firing this tick

### B. Human comments (`humanFeedback.pendingFix`)

- Gate: `pendingFix || coalescedFeedback` + `!awaitingReReview` + `!fixDispatched`
- Agent comments filtered out via `/\bMinions\s*\(/i` regex on comment body
- Coalesces multiple comments arriving during cooldown into single fix
- Routes to author

### C. Build failures (`buildStatus === 'failing'`)

- Gate: `buildFixAttempts < maxBuildFixAttempts` (default 3) + grace period expired
- **Grace period** (`_buildFixPushedAt`): after fix dispatches, waits `buildFixGracePeriod` (default 10min, configurable in `ENGINE_DEFAULTS`) for CI to run before re-dispatching. Cleared when poller detects build status transition (CI actually ran).
- **Error logs**: GitHub fetches annotations (failures only, not warnings) + Actions job log (always). ADO fetches build timeline + failed task logs. Both fetch up to 3 failing pipelines.
- **Escalation**: after 3 failed attempts, writes inbox alert, sets `buildFixEscalated = true`, stops auto-dispatch. Counter resets when build recovers.

## 5. Fix completes

- `updatePrAfterFix()` (lifecycle.js) sets `reviewStatus = 'waiting'` + `fixedAt = ts()`
- Clears `humanFeedback.pendingFix`
- `awaitingReReview` gate (`waiting` + `fixedAt`) blocks all fix dispatch until reviewer acts

## 6. Re-review cycle

- Poller (~3min): detects new commit (`head.sha` changed) → sets `lastPushedAt`
- Platform review state drives next action:
  - Reviewer approves → `approved` → done
  - Reviewer re-requests changes → `changes-requested` → triggers another fix
  - No reviewer action yet → stays `waiting` → engine waits

## 7. Build fix cycle after fix push

- Fix agent pushes → `_buildFixPushedAt` stamped
- Poller detects new commit → CI starts → `buildStatus` transitions (`failing` → `running`)
- `_buildFixPushedAt` cleared on any transition
- If CI passes → `buildFixAttempts` reset, `buildErrorLog` cleared → done
- If CI fails again → fresh error logs fetched → new fix dispatches immediately (grace already cleared by transition)

## Race prevention

| Scenario | Guard |
|---|---|
| Simultaneous review + fix | `activePrIds` — skip PR if any dispatch in-flight |
| Duplicate fix (review + human) | `fixDispatched` flag — only one fix per PR per tick |
| Branch write conflict | `isBranchActive()` mutex |
| Fix while awaiting re-review | `awaitingReReview` (waiting + fixedAt) |
| Build fix before CI runs | `_buildFixPushedAt` grace period (10min) |
| Duplicate dispatch | `dispatchKey` dedup + cooldown |
| Stale review status | Pre-dispatch live API check |
| Orphan detection | Heartbeat timeout + output scan |

## Key files

| File | Functions |
|---|---|
| `engine.js` | `discoverFromPrs()` — discovery + dispatch logic |
| `engine/lifecycle.js` | `syncPrsFromOutput()`, `updatePrAfterReview()`, `updatePrAfterFix()` |
| `engine/github.js` | `pollPrStatus()`, `pollPrHumanComments()`, `fetchGhBuildErrorLog()` |
| `engine/ado.js` | `pollPrStatus()`, `pollPrHumanComments()`, `fetchAdoBuildErrorLog()` |
| `engine/dispatch.js` | `addToDispatch()` — dedup by work item ID and dispatchKey |
| `engine/cooldown.js` | `isBranchActive()`, cooldown management |
| `playbooks/review.md` | Reviewer playbook |
| `playbooks/fix.md` | Fix agent playbook |

## PR state fields

| Field | Set by | Purpose |
|---|---|---|
| `status` | Poller | `active` / `merged` / `abandoned` |
| `reviewStatus` | Poller + post-completion | `pending` / `approved` / `changes-requested` / `waiting` |
| `buildStatus` | Poller | `none` / `passing` / `failing` / `running` |
| `buildErrorLog` | Poller | Actual CI error output for fix agents |
| `buildFixAttempts` | Discovery (on dispatch) | Counter for escalation cap |
| `buildFixEscalated` | Discovery (on cap) | Stops auto-dispatch |
| `_buildFixPushedAt` | Discovery (on dispatch) | Grace period timestamp |
| `_buildFailNotified` | Discovery | Dedup for inbox alert |
| `lastPushedAt` | Poller (new commit) | Tracks latest push for re-review logic |
| `lastReviewedAt` | `updatePrAfterReview()` | Prevents re-dispatch if reviewed |
| `minionsReview` | Post-completion hooks | `{ reviewer, reviewedAt, note, fixedAt }` |
| `humanFeedback` | `pollPrHumanComments()` | `{ pendingFix, feedbackContent, lastProcessedCommentDate }` |
