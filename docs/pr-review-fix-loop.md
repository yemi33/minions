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

## 4. Fix dispatch trigger order

`discoverFromPrs()` evaluates PR auto-fix triggers in a fixed order during each discovery pass:

1. Review feedback (`changes-requested`) — `engine.js:2166-2180`
2. Human feedback (`humanFeedback.pendingFix` or coalesced feedback) — `engine.js:2191-2226`
3. Build failure (`buildStatus === 'failing'`) — `engine.js:2229-2271`
4. Merge conflict (`_mergeConflict`) — `engine.js:2299-2317`

When multiple problems coexist, earlier triggers get the first chance to enqueue work. The local `fixDispatched` flag is declared before the fix triggers (`engine.js:2168`) and set after review-feedback, human-feedback, and build-failure dispatches (`engine.js:2180`, `engine.js:2226`, `engine.js:2271`). Conflict fixes run last and explicitly require `!fixDispatched` (`engine.js:2301`), so any earlier successful fix dispatch suppresses the conflict fix for that PR in the same discovery pass. Build fixes are evaluated after review and human feedback, but the build-fix condition itself is not gated by `!fixDispatched` (`engine.js:2238`).

### A. Review feedback (`changes-requested`)

- Gate: `reviewStatus === 'changes-requested'` + `!awaitingReReview` + `!evalEscalated` + not dispatched + not on cooldown
- Routes to PR author via `_author_` routing token
- `review_note` = reviewer's feedback
- Sets `fixDispatched = true` — prevents human-feedback and conflict fixes from also firing this pass
- **Review-loop escalation**: after `evalMaxIterations` review→fix cycles (default 3), `_evalEscalated` is set on the PR and *only this trigger plus review/re-review* stop. Triggers B (human comments), C (build failures), and the merge-conflict fix path keep running. The dashboard PR row distinguishes the two states with separate badges (review badge `review-escalated` vs. build badge `build-escalated`).

### B. Human comments (`humanFeedback.pendingFix`)

- Gate: `pendingFix || coalescedFeedback` + `!awaitingReReview` + `!fixDispatched`
- Agent comments filtered out via `/\bMinions\s*\(/i` regex on comment body
- Coalesces multiple comments arriving during cooldown into single fix
- Routes to author
- Not gated by `_evalEscalated` — humans can always force more fixes via PR comments even after the review loop escalates.

### C. Build failures (`buildStatus === 'failing'`)

- Gate: `buildFixAttempts < maxBuildFixAttempts` (default 3) + grace period expired
- **Grace period** (`_buildFixPushedAt`): after fix dispatches, waits `buildFixGracePeriod` (default 10min, configurable in `ENGINE_DEFAULTS`) for CI to run before re-dispatching. Cleared when poller detects build status transition (CI actually ran).
- **Error logs**: GitHub fetches annotations (failures only, not warnings) + Actions job log (always). ADO queries builds API directly (not status checks), fetches build timeline → failed task logs (up to 10 per build, up to 10 failing pipelines).
- **Build-fix escalation**: after 3 failed attempts, writes an inbox alert, sets `buildFixEscalated = true`, and stops *only this trigger* (auto-dispatch for build fixes). The counter resets when the build recovers. Independent of `_evalEscalated`.
- Not gated by `_evalEscalated` — build-fix is mechanical and runs even if the review loop has escalated.
- Sets `fixDispatched = true` after dispatch so the later conflict trigger is suppressed in the same pass.

### D. Merge conflicts (`_mergeConflict`)

- Gate: `autoFixConflicts` + `status === 'active'` + `_mergeConflict` + `!fixDispatched`
- Routes to the PR author to resolve target-branch conflicts
- Runs after review, human, and build triggers; if any earlier trigger enqueued a fix for this PR, the conflict fix waits for a later discovery pass

## 5. Fix completes

- `updatePrAfterFix()` (lifecycle.js) sets `reviewStatus = 'waiting'` + `fixedAt = ts()`
- Clears `humanFeedback.pendingFix`
- `awaitingReReview` gate (`waiting` + `fixedAt`) blocks all fix dispatch until reviewer acts

## 6. Re-review cycle

- Poller (wall-clock cadence from `prPollStatusEvery × tickInterval`, default ~12min): detects new commit (`head.sha` changed) → sets `lastPushedAt`
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
| Duplicate fix (review + human + conflict) | `fixDispatched` flag — later human/conflict triggers skip after earlier fix dispatches in the same PR pass |
| Branch write conflict | `isBranchActive()` mutex |
| Fix while awaiting re-review | `awaitingReReview` (waiting + fixedAt) |
| Build fix before CI runs | `_buildFixPushedAt` grace period (10min) |
| Duplicate dispatch | `dispatchKey` dedup + cooldown |
| Stale review status | Pre-dispatch live API check |
| Orphan detection | Stale-orphan timeout + output scan |

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
| `buildFixAttempts` | Discovery (on dispatch) | Counter for build-fix escalation cap |
| `buildFixEscalated` | Discovery (on cap) | Stops *build-fix* auto-dispatch only (review/re-review and other fix triggers continue) |
| `_reviewFixCycles` | Discovery (on dispatch) | Counter for review→fix cycle cap (`evalMaxIterations`) |
| `_evalEscalated` | Discovery (on cap) | Stops *review/re-review and review-feedback fix* auto-dispatch only (build-fix, conflict-fix, and human-feedback fix continue). Cleared when reviewer eventually approves the PR. |
| `_buildFixPushedAt` | Discovery (on dispatch) | Grace period timestamp |
| `_buildFailNotified` | Discovery | Dedup for inbox alert |
| `lastPushedAt` | Poller (new commit) | Tracks latest push for re-review logic |
| `lastReviewedAt` | `updatePrAfterReview()` | Prevents re-dispatch if reviewed |
| `minionsReview` | Post-completion hooks | `{ reviewer, reviewedAt, note, fixedAt }` |
| `humanFeedback` | `pollPrHumanComments()` | `{ pendingFix, feedbackContent, lastProcessedCommentDate }` |

## Platform differences

| | GitHub | ADO |
|---|---|---|
| **Build status API** | `/commits/{sha}/check-runs` | `_apis/build/builds` (not status checks — those show stale codecoverage postbacks) |
| **Commit tracking** | `head.sha` (source branch tip) | `lastMergeCommit.commitId` (merge commit that builds use as sourceVersion) |
| **Passing** | success, skipped, neutral | succeeded, partiallySucceeded (warnings, not failures) |
| **Error logs** | Annotations (failures only) + Actions job log (always) | Build timeline → failed task logs (up to 10 tasks, up to 10 pipelines) |
| **Push detection** | `head.sha` change | `lastMergeCommit.commitId` change |

### ADO lessons learned

- Don't trust `/pullRequests/{id}/statuses` — shows stale codecoverage postbacks, not actual build results
- Builds use the merge commit hash as `sourceVersion`, not the source branch commit — compare against `lastMergeCommit.commitId`
- `partiallySucceeded` counts as passing (warnings, not failures)
- A stale but passing build is still valid — don't re-trigger builds that already passed
