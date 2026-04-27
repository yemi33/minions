# RFC: `completion.json` — Structured Agent Control-Plane Protocol

> Author: Dallas (Engineer) | Date: 2026-04-27 | Status: **awaiting-approval**
> Plan: `minions-2026-04-27.json` | Plan item: `P-7a8b9c1d` (SEC-07 / C1)
> Note: this RFC lives in `docs/` rather than `plans/` because the repo's `.gitignore` excludes `plans/`. The task description explicitly allowed "or similar".

## TL;DR

Replace stdout regex-scraping with a per-dispatch `completion.json` written by each agent into an engine-owned location. The engine reads that file post-run as the source of truth for PR links, completion status, failure class, review verdict, decomposition output, declared skills, and the learnings inbox path. The current ` ```completion ` fenced block (already parsed by `parseStructuredCompletion`) becomes the legacy fallback during a one-week dual-mode period and is then retired.

This closes a class of spoofable-stdout attacks where agent output (or content quoted by an agent — error logs, file reads, copied PR templates) accidentally contains literal completion sentinels, ` ```skill ` blocks, `VERDICT: APPROVE` strings, GitHub/ADO PR URLs, or `===ACTIONS===` markers, and is mis-treated as a control-plane signal.

**No engine code or playbook code is modified by this item.** This RFC is the design; implementation is a follow-up plan.

---

## 1. Problem

The engine reconstructs control-plane state from the unstructured stdout of `claude` CLI subprocesses. Eight call sites in `engine/lifecycle.js` and one in `engine/timeout.js` regex-match the agent's output stream:

| # | Site | What it scrapes | Spoof surface |
|---|------|-----------------|---------------|
| 1 | `syncPrsFromOutput` (`lifecycle.js:704`) | PR numbers + URLs from `tool_result`, assistant text, `result` events; regex on `github.com/.../pull/N`, `dev.azure.com/.../pullrequest/N`, "PR created" phrases | Any agent that quotes a URL (e.g. linking the PR being reviewed, copying a build log, citing an existing issue body) creates a phantom new-PR record |
| 2 | `parseReviewVerdict` (`lifecycle.js:883`) | `VERDICT: APPROVE` / `VERDICT: REQUEST_CHANGES` regex | An agent that quotes another verdict (e.g. "the previous reviewer wrote VERDICT: APPROVE but I disagree") flips review status |
| 3 | `isReviewBailout` (`lifecycle.js:907`) | `bailing out` / `already posted` regex | Any tool stderr or quoted error containing those phrases turns a real failure into a silent no-op |
| 4 | `handleDecompositionResult` (`lifecycle.js:1535`) | First ` ```json ` fenced block parsed for sub-items | An agent that includes a sample JSON block earlier in its reasoning poisons the parent → children mapping |
| 5 | `extractSkillsFromOutput` (`lifecycle.js:1278`) | All ` ```skill ` fenced blocks | Highest-value attack: agent reads a doc/inbox note containing a ` ```skill ` block and quotes it, the engine writes it to `~/.claude/skills/` |
| 6 | `parseStructuredCompletion` (`lifecycle.js:1494`) | Last ` ```completion ` fenced block, parsed as `key: value` | An agent that includes a ` ```completion ` block in a quoted file (e.g. another playbook) overrides its own real status |
| 7 | `classifyFailure` (`lifecycle.js:2096`) | Failure-class regexes on combined stdout/stderr (`max_turns`, `permission denied`, `merge conflict`, …) | An agent that quotes one error class while genuinely failing on another gets the wrong recovery recipe |
| 8 | `checkForLearnings` (`lifecycle.js:1266`) | Filesystem scan for `notes/inbox/*<agentId>*<date>*` | Not stdout-based, but date-collisions cause cross-task attribution |
| 9 | `checkTimeouts` (`engine/timeout.js:189-219`) | Tail of `live-output.log` for `"type":"result"` and `[process-exit]` markers — completion-via-output detection for hung dispatches | Lower-risk: this is the claude CLI's own output, not agent-authored content |

Sites 1–8 are agent-spoofable (intentionally or accidentally). Site 9 is claude-CLI-emitted and stays on stdout — see §6.

The current ` ```completion ` fenced block (Site 6) was a half-step toward structured completion: it gives a status field but is still parsed from stdout, still spoofable by quoted text, and only carries six string fields. `completion.json` is the full step.

## 2. Goals & Non-Goals

**Goals.**
1. Make every control-plane signal an *intentional* write by the agent to a known location, not a string match against stdout.
2. Preserve all data lifecycle.js currently extracts (sites 1–8).
3. Cross-platform — works on Windows, macOS, Linux without shell-quoting hazards.
4. Migration with a dual-mode read window so already-running agents and queued dispatches don't fail.
5. Zero new dependencies — file write + JSON parse, same toolbox as the rest of Minions.

**Non-goals.**
1. Replacing `live-output.log` for liveness/heartbeat tracking. The CLI's own stream-json output is still the authoritative liveness signal (`"type":"result"`, `subtype:"success"` etc.) — see §6.
2. Replacing `safeWrite`/`mutateJsonFileLocked` for engine state files. `completion.json` is one-shot, write-once, agent-authored — no concurrent writers.
3. Hardening against a *malicious* agent. An attacker who controls the agent process could write any completion.json. The threat model is *accidental spoofing by quoted text* and *forward compatibility with structured tool outputs*.

## 3. File Location & Write Protocol

### 3.1 Location

`engine/tmp/completion-<dispatchId>.json` (absolute path injected via env var `MINIONS_COMPLETION_PATH`).

Why not `<worktree>/.minions-completion.json`?
- Read-only tasks (`explore`, `ask`, `meeting-*`, `plan-to-prd`) run with `cwd=rootDir` — writing into the user's repo would pollute the working tree and fight `.gitignore` per-project.
- A worktree-local path makes lifecycle bookkeeping race with worktree cleanup (worktrees are removed in `runPostCompletionHooks` itself).
- Engine-owned `engine/tmp/` is already gitignored (`.gitignore:30`), already used for prompts, PIDs, and sidecar files, and survives the worktree removal that happens later in the same hook.

Why per-dispatch ID? `dispatchId` is unique, monotonic, and already on the dispatch item — no collisions across concurrent agents on shared branches, and the engine cleans up `engine/tmp/` on tick 10 of `cleanup.js` so old completion files don't accumulate.

### 3.2 Injection

The engine sets the env var pre-spawn, alongside the existing `MINIONS_ADO_TOKEN` injection in `engine.js:865`:

```js
childEnv.MINIONS_COMPLETION_PATH = path.join(ENGINE_DIR, 'tmp', `completion-${dispatchId}.json`);
```

Agents read `process.env.MINIONS_COMPLETION_PATH` directly — no template variable, no playbook substitution, no shell quoting. Cross-platform: Node, Python, bash, and PowerShell all read env vars natively.

### 3.3 Write Protocol — Atomic Temp + Rename

```js
// pseudocode every playbook executes before final exit
const tmp = process.env.MINIONS_COMPLETION_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(completion, null, 2));
fs.renameSync(tmp, process.env.MINIONS_COMPLETION_PATH);
```

`fs.renameSync` is atomic on POSIX and on NTFS for same-volume renames (which `engine/tmp/` always is). The engine never observes a partial file — either the rename has happened (full JSON) or it hasn't (engine falls through to legacy stdout parse).

The agent must not write the file in pieces. Empty, truncated, or malformed JSON triggers fallback to the legacy stdout parser during dual-mode (§5) and a hard failure post-flip.

### 3.4 Cleanup

`engine/cleanup.js` (every 10 ticks) gains a sweep over `engine/tmp/completion-*.json` older than 24h. The `runPostCompletionHooks` flow already removes the worktree but leaves `engine/tmp/` files for diagnostics — completion files are tiny (<10 KB typical) so a 24h window is generous and matches the existing temp-prompt retention.

## 4. Schema

### 4.1 Top-Level Object

```jsonc
{
  "schemaVersion": 1,                     // bump on breaking schema changes
  "dispatchId": "dallas-implement-mohs8s8r7dy6",
  "agentId": "dallas",
  "writtenAt": "2026-04-27T22:42:00.000Z",

  // ── Always required ──────────────────────────────────────────────────────
  "status": "done",                       // see §4.2
  "summary": "Added /api/bot endpoint and wired Teams inbox.",  // ≤500 chars
  "filesChanged": ["engine/teams.js", "dashboard.js"],          // optional, hint only

  // ── PR control plane (replaces sites 1, 4 for fix/implement/verify) ─────
  "prs": [
    {
      "number": 1234,
      "url": "https://github.com/yemi33/minions/pull/1234",
      "branch": "feat/P-7a8b9c1d-rfc-completion-json",
      "title": "feat: RFC for completion.json control-plane",
      "host": "github",                   // "github" | "ado"
      "action": "created"                 // "created" | "updated" | "linked"
    }
  ],

  // ── Review control plane (replaces sites 2, 3 for review tasks) ─────────
  "review": {
    "verdict": "approve",                 // "approve" | "request-changes" | "bail"
    "bailReason": null,                   // string when verdict==="bail"
    "comments": []                        // optional inline comments [{file,line,body}]
  },

  // ── Decomposition (replaces site 4 for decompose tasks) ─────────────────
  "decomposition": {
    "subItems": [
      {
        "id": "P-7a8b9c1d-1",
        "title": "...",
        "type": "implement",              // "implement" | "implement:large"
        "estimated_complexity": "medium",
        "depends_on": [],
        "acceptance_criteria": [],
        "scope_boundaries": []
      }
    ]
  },

  // ── Failure classification (replaces site 7 when status !== "done") ─────
  "failure": {
    "class": "build-failure",             // FAILURE_CLASS value from shared.js
    "reason": "npm test exited 1 — 3 failing in test/unit.test.js",
    "details": "..."                      // optional verbose context (≤2000 chars)
  },

  // ── Learnings (replaces site 8) ─────────────────────────────────────────
  "learnings": {
    "inboxFile": "notes/inbox/dallas-P-7a8b9c1d-2026-04-27-2242.md"
  },

  // ── Skills (replaces site 5) ────────────────────────────────────────────
  // Replaces ```skill fenced-block scraping. Each entry is a fully formed
  // skill manifest. The engine never re-parses agent prose for skills.
  "skills": [
    {
      "name": "skill-name-here",
      "description": "When to trigger",
      "scope": "minions",                 // "minions" | "project"
      "project": null,                    // string when scope==="project"
      "body": "---\nname: skill-name-here\n---\n\n# Title\n..."
    }
  ],

  // ── Optional checks (build-and-test playbook + verify) ──────────────────
  "checks": {
    "build": "pass",                      // "pass" | "fail" | "skipped" | "n/a"
    "tests": "pass",
    "lint": "pass"
  },

  // ── Meeting output (replaces collectMeetingFindings text scrape) ────────
  // Only set by meeting-investigate / meeting-debate / meeting-conclude.
  "meeting": {
    "round": "investigate",               // "investigate" | "debate" | "conclude"
    "content": "<full markdown content>"
  }
}
```

### 4.2 `status` Values

| Value | When | Engine action |
|-------|------|---------------|
| `done` | Work complete; PR pushed (if applicable) | Mark WI `done`, sync PRD |
| `partial` | Some progress; agent ran out of turns or hit a known stop point | Auto-retry per `RECOVERY_RECIPES` (`engine/recovery.js`) |
| `failed` | Hard failure; no recovery attempted by agent | Use `failure.class` to pick recipe |
| `noop` | Idempotent bail (review already posted, plan already shipped, etc.) | Mark WI `done` without retry, no failure metric |
| `needs-review` | Agent could not classify; flag for human | Set WI `needs-human-review` |

`noop` collapses the current `isReviewBailout` (lifecycle.js:907), the `verify-plan-already-shipped` family of skills, and the "shared-branch redispatch" skill into a single explicit signal. Any agent that detects "the work is already done" returns `status: "noop"` and a one-line `summary` — the engine takes the success path without retry.

### 4.3 Cardinality & Required Fields by Task Type

| Task type | Required | Forbidden |
|-----------|----------|-----------|
| `implement`, `implement:large` | `status`, `summary`, `prs[]` (≥1 if status===done unless `noop`) | `review`, `decomposition`, `meeting` |
| `fix` | `status`, `summary`, `prs[]` (≥1 if status===done unless `noop`) | `decomposition`, `meeting` |
| `review` | `status`, `summary`, `review.verdict` | `decomposition`, `meeting` |
| `decompose` | `status`, `summary`, `decomposition.subItems` (≥1 if status===done) | `prs`, `review`, `meeting` |
| `verify` | `status`, `summary`, `prs[]`, `checks` | `review`, `decomposition`, `meeting` |
| `meeting-*` | `status`, `summary`, `meeting.round`, `meeting.content` | `prs`, `review`, `decomposition` |
| `plan-to-prd` | `status`, `summary` (PRD file existence is checked separately, see lifecycle.js:1721) | `review`, `decomposition`, `meeting` |
| `explore`, `ask`, `test`, `docs` | `status`, `summary` | `prs`, `review`, `decomposition`, `meeting` |

Validation lives in a new `validateCompletion(obj, taskType)` in `engine/shared.js` and runs in `runPostCompletionHooks` *before* any field is consumed.

## 5. Engine Read Path & Migration

### 5.1 New Helper

```js
// engine/lifecycle.js (new — replaces parseStructuredCompletion as primary)
function readCompletionFile(dispatchItem) {
  const p = path.join(ENGINE_DIR, 'tmp', `completion-${dispatchItem.id}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    const valid = validateCompletion(obj, dispatchItem.type);
    if (!valid.ok) {
      log('warn', `completion.json for ${dispatchItem.id}: ${valid.reason} — falling back to stdout parse`);
      return null;
    }
    return obj;
  } catch (err) {
    log('warn', `completion.json read failed for ${dispatchItem.id}: ${err.message}`);
    return null;
  }
}
```

`runPostCompletionHooks` calls `readCompletionFile` *once* at entry and threads the resulting object through the existing call sites:

| Old call (regex on stdout) | New call (read from completion) | Fallback |
|----------------------------|----------------------------------|----------|
| `syncPrsFromOutput(stdout)` | `syncPrsFromCompletion(completion.prs)` | If `completion === null`, call old `syncPrsFromOutput`. **Never call both** — duplicate-PR detection on `id`/`url` already exists at `lifecycle.js:833` and would block, but the warn log noise is unwanted. |
| `parseReviewVerdict(text)` | `completion?.review?.verdict` | Old regex |
| `isReviewBailout(text)` | `completion?.review?.verdict === 'bail'` or `completion?.status === 'noop'` | Old regex |
| `handleDecompositionResult(stdout)` | `completion?.decomposition?.subItems` | Old regex on first ` ```json ` block |
| `extractSkillsFromOutput(stdout)` | `completion?.skills` | Old ` ```skill ` regex (still needed for inbox-file skill scan at `lifecycle.js:2017` — see §5.4) |
| `classifyFailure(code, stdout, stderr)` | `completion?.failure?.class` if present and valid `FAILURE_CLASS` | Old regex chain |
| `checkForLearnings(agentId)` | `fs.existsSync(completion.learnings.inboxFile)` | Old date+agent file scan |
| `parseStructuredCompletion(stdout)` | Subsumed entirely | Kept as deprecated shim during dual-mode (see §5.3) |
| `collectMeetingFindings(output)` | `completion?.meeting?.content` | Old `parseStreamJsonOutput` text |

### 5.2 Single Source of Truth — Conflict Resolution

When `completion.json` is present and validates: **completion.json wins, no fallback merging.** The engine logs a warning if stdout regex would have produced a different signal than completion.json (e.g., regex finds a PR URL but `completion.prs` is empty), but does not act on it. Mixing sources defeats the security goal.

When `completion.json` is absent or invalid: full fallback to stdout regex on every site, identical behavior to today.

### 5.3 Phased Migration

| Phase | Window | Behavior | Flip criterion |
|-------|--------|----------|----------------|
| **0. Preparation** (no flag) | Day 0 | Engine writes `MINIONS_COMPLETION_PATH` env var. Engine reads completion.json *opportunistically* (uses it when present, falls back to regex when absent). Playbooks updated to write the file. `parseStructuredCompletion`'s ` ```completion ` block continues to be parsed and merged with `completion.json` during this phase only — agents who upgrade slowly still work. | — |
| **1. Dual-mode** | Day 0 → Day 7 | Same as Phase 0, plus new metric `_engine.completionFile.{parsed,fallback,invalid}` per agent in `metrics.json`. Daily KB sweep posts a digest of fallback rates. | ≥95% of dispatches in the last 24h produce a parseable completion.json |
| **2. Strict** (gated by `engine.requireCompletionFile = false` → `true`) | Day 7 → Day 10 | When the flag is `true`, missing/invalid completion.json marks the dispatch `failed` with `failure.class = 'config-error'` (no retry, see `RECOVERY_RECIPES`). Default still `false`. | All permanent agents observed clean for 3 consecutive days |
| **3. Default flip** | Day 10 | `engine.requireCompletionFile` default becomes `true`. Stdout regex parsers (`syncPrsFromOutput`, `parseReviewVerdict`, etc.) become deprecated shims, registered in `docs/deprecated.json` with a `cleanup` date 3 days out (per the existing `/cleanup-deprecated` skill convention). | — |
| **4. Removal** | Day 13 | Stdout regex parsers deleted; ` ```completion ` block support removed. Only `completion.json` is read. | — |

Day 0 is the day the implementation PR merges, not the day this RFC is approved.

The flag name `engine.requireCompletionFile` mirrors existing engine flags (`autoFixBuilds`, `evalLoop`, `adoPollEnabled`).

### 5.4 What Does *Not* Switch

These paths stay on stdout / live-output.log:

1. **`engine/timeout.js` completion-via-output detection** (`timeout.js:189-219`). The signal there is the claude CLI's own `"type":"result"` event, emitted by the binary even if the agent crashed before writing completion.json. Removing it would mean orphan/hung agents are never reaped. This stays as the heartbeat mechanism.
2. **Per-tick liveness via `live-output.log` mtime** (`timeout.js:178`). Same reason — completion.json is written once at exit, not as a heartbeat.
3. **`parseStreamJsonOutput` for `resultSummary`** in `parseAgentOutput` (`lifecycle.js:1483`). This extracts the human-readable summary from the CLI's stream-json. Even after the flip, `completion.summary` is *also* extracted, but the stream-json text remains the canonical "what did the agent say last" — used in dashboards, agent history, Teams notifications. The two coexist: `completion.summary` is for routing decisions, the stream-json text is for display.
4. **Inbox-file skill scan** (`lifecycle.js:2013-2024`). Some agents write skills into their inbox findings file (a deliberate human-discoverable artifact). The completion file deprecates inline ` ```skill ` blocks in stdout, but the inbox file scan is opt-in and stays — it's a different surface (a real file the agent intentionally wrote, not regex-scraped from stdout).

### 5.5 Backward Compatibility

- Agents that fail to write completion.json during Phase 1–2 silently fall back. Phase 3 fails them, but the deprecation tracker (`docs/deprecated.json`) flags this 3 days in advance and the daily fallback-rate digest gives operators visibility.
- The legacy ` ```completion ` block in `playbooks/fix.md` and `playbooks/implement-shared.md` is removed in Phase 0 (replaced by completion.json instructions). The `parseStructuredCompletion` reader is removed in Phase 4.
- `docs/deprecated.json` entries (added in the implementation PR, not this RFC):

```json
{
  "id": "stdout-regex-pr-scrape",
  "summary": "syncPrsFromOutput stdout regex superseded by completion.json prs[]",
  "deprecated": "Day 10",
  "reason": "Spoofable surface — agents that quote PR URLs created phantom PR records.",
  "locations": [
    "engine/lifecycle.js:704 syncPrsFromOutput",
    "engine/lifecycle.js:734 createdPattern, createdIdPattern",
    "engine/lifecycle.js:748 prHeaderPattern (inbox scan)"
  ],
  "cleanup": "Delete syncPrsFromOutput; keep syncPrsFromCompletion."
}
```

(One entry per site 1–7 above; site 8 is unaffected.)

## 6. Threat Model & What's Closed

| Spoof vector | Closed? | How |
|--------------|---------|-----|
| Agent quotes a PR URL it didn't create → phantom PR record | ✅ | `prs[]` is an explicit list; quoted URLs in prose are ignored |
| Agent quotes "VERDICT: APPROVE" while disagreeing → flipped review | ✅ | `review.verdict` is explicit |
| Tool stderr contains "bailing out" → real failure becomes silent no-op | ✅ | `noop` is opt-in |
| Agent reads a doc with a ` ```skill ` block and quotes it → arbitrary skill written to `~/.claude/skills/` | ✅ | `skills[]` is explicit; ` ```skill ` regex removed in Phase 4 |
| Agent quotes a previous ` ```completion ` block → wrong status | ✅ | ` ```completion ` parser removed in Phase 4 |
| Agent quotes one error class while failing on another → wrong recovery recipe | ✅ | `failure.class` is explicit; if missing or invalid, falls through to `FAILURE_CLASS.UNKNOWN` (safe default) |
| Decompose agent emits a ` ```json ` block earlier in reasoning → corrupted children | ✅ | `decomposition.subItems` is explicit |
| Hung/orphaned agent never reaches the write site → no completion.json | ⚠️ | Engine's existing live-output.log heartbeat reaper (`timeout.js`) catches this; dispatch is marked failed via stdout completion-via-output signal |
| Malicious agent writes a fake completion.json (e.g. claims `noop` to avoid retry) | ❌ | Out of scope — see §2 non-goals. An adversarial agent owns its own write path regardless. |

The key shift: **the agent's intent is now in a place no quoted text can reach.** Stdout becomes display-only.

## 7. Playbook Changes

### 7.1 Centralized Instruction in `shared-rules.md`

`playbooks/shared-rules.md` is auto-injected into every playbook (per `engine/playbook.js`). The completion-write block lives there once, so per-playbook diffs are minimal.

```markdown
## Completion Protocol — Required Before Exit

Before your final message, write a JSON object to the absolute path in the
`MINIONS_COMPLETION_PATH` environment variable. The engine reads this file
as the source of truth — fields not declared here are NOT detected even if
they appear in your stdout.

Schema reference: docs/rfc-completion-json.md §4.

Required for every task:
  status, summary

Required for your task type (see §4.3):
  - implement / implement:large / fix / verify  → prs[]
  - review                                      → review.verdict
  - decompose                                   → decomposition.subItems
  - meeting-*                                   → meeting.round, meeting.content

Write atomically — temp file + rename:

  // From a Bash tool call:
  cat > "$MINIONS_COMPLETION_PATH.tmp" <<'JSON'
  { "schemaVersion": 1, "status": "done", "summary": "...", "prs": [ ... ] }
  JSON
  mv "$MINIONS_COMPLETION_PATH.tmp" "$MINIONS_COMPLETION_PATH"

  // From PowerShell:
  $json | Out-File -Encoding UTF8 "$env:MINIONS_COMPLETION_PATH.tmp"
  Move-Item "$env:MINIONS_COMPLETION_PATH.tmp" $env:MINIONS_COMPLETION_PATH -Force

If you cannot write completion.json (e.g. you bailed before any work), the
engine falls back to stdout parsing during the dual-mode period. After the
flip date, missing/invalid completion.json marks your dispatch failed.

Do NOT include sensitive data (tokens, API keys) — completion.json is read
by the engine and may surface in dashboard views and Teams notifications.
```

### 7.2 Per-Playbook Removals

The current ` ```completion ` block in `playbooks/fix.md:85-93` and `playbooks/implement-shared.md:86-93` is removed in Phase 0 (the new shared-rules block supersedes it).

`playbooks/decompose.md` already has a dedicated ` ```json ` block instruction; it is replaced with a one-liner that references the `decomposition.subItems` field of completion.json.

`playbooks/review.md` already documents `VERDICT: APPROVE`/`REQUEST_CHANGES`. Phase 0 keeps the human-readable verdict in stdout (for inline dashboard display) AND requires `review.verdict` in completion.json. Phase 4 makes completion.json the only source.

`playbooks/meeting-investigate.md`, `meeting-debate.md`, `meeting-conclude.md` add `meeting.round` + `meeting.content` to completion.json. The transcript inbox write at `meeting.js:365` continues to use the same content.

### 7.3 No-PR Tasks

`explore`, `ask`, `test`, `docs`, `plan-to-prd`, and the read-only legs of `meeting-*` simply omit `prs[]`. They still write completion.json with `status` + `summary`. This makes "I had nothing to push" an explicit signal instead of inferred from "no PR URL found in stdout" (which today triggers the auto-retry-then-needs-review chain at `lifecycle.js:1943-1984`).

## 8. Validation & Testing

The implementation PR ships:

1. **Unit tests** in `test/unit.test.js`:
   - `validateCompletion` accepts valid shapes for each task type.
   - Rejects missing required fields, wrong cardinality, unknown enum values.
   - Rejects payloads >256 KB (DoS guard).
2. **Behavioral tests**:
   - Stub `engine/tmp/completion-<id>.json` with each task-type fixture; assert `runPostCompletionHooks` updates work-items.json, pull-requests.json, and PRD JSON consistently.
   - Stub *no* completion.json + the same stdout the regex path expects; assert identical end state (regression gate during Phase 0–2).
   - Stub an invalid JSON; assert fallback to regex path with a `warn` log entry.
3. **Migration regression**: replay 50 random completed dispatches from `engine/dispatch.json` history, assert that the regex path and the (synthetic) completion.json path produce the same `WI_STATUS` and same set of PR records.

## 9. Open Questions

1. **Schema versioning & forward-compat.** `schemaVersion: 1` is declared but no upgrade story. Recommend: add a `validateCompletion(obj, taskType, { strict: false })` mode where unknown top-level fields are tolerated with a warn log, so v2 fields don't break v1 readers.
2. **Multi-PR dispatches** (e.g. cross-repo features). The `prs[]` array supports this natively. The current regex path *also* supports this but mis-attributes when URLs from multiple repos appear in close proximity. completion.json fixes that for free.
3. **Resumed dispatches.** If an agent is killed mid-task and resumed via `--resume` (engine.js:1104), and the resumed run writes a *new* completion.json, the rename clobbers the original. This is the intended behavior — only the final run's completion is read — but worth a note in the implementation PR.
4. **CC and doc-chat**. Command-Center and doc-chat use the `direct: true` LLM path that bypasses spawn-agent.js. They don't use dispatch IDs the same way. **Recommendation: out of scope.** CC's ` ===ACTIONS=== ` block lives in dashboard.js and operates on a different threat model (user-typed prompts, not agent-quoted text). Don't bundle it.

## 10. Acceptance Criteria for the Implementation Plan

When this RFC is approved and the follow-up plan is drafted, the implementation must satisfy:

1. `MINIONS_COMPLETION_PATH` is set on every spawned agent process (`engine.js` and `engine/spawn-agent.js`).
2. `engine/shared.js` exports `validateCompletion(obj, taskType)`.
3. `engine/lifecycle.js` adds `readCompletionFile(dispatchItem)` and threads its return value through `runPostCompletionHooks`.
4. Every regex-based site listed in §1 has a completion-aware path with stdout fallback (Phase 0–2) or no fallback (Phase 4).
5. `playbooks/shared-rules.md` carries the §7.1 instruction; `fix.md` / `implement-shared.md` drop their inline ` ```completion ` block.
6. `engine.requireCompletionFile` is added to `ENGINE_DEFAULTS` (`shared.js`) defaulting to `false`.
7. Metrics: `_engine.completionFile.{parsed,fallback,invalid}` counters added per agent.
8. Tests per §8 land green; `npm test` passes with 0 new failures.
9. `docs/deprecated.json` gains entries for each retired regex site, with the cleanup date set 3 days after the Phase 4 flip.

## 11. References

- `engine/lifecycle.js:1494` — current `parseStructuredCompletion` (legacy ` ```completion ` block reader, half-step toward this design).
- `engine/lifecycle.js:704` — `syncPrsFromOutput` (Site 1, primary attack surface).
- `engine/lifecycle.js:1278` — `extractSkillsFromOutput` (Site 5, highest-value attack surface).
- `engine/timeout.js:189` — completion-via-output detection (stays on stdout per §6).
- `engine.js:865` — existing env-var injection pattern (`MINIONS_ADO_TOKEN`).
- `engine/cleanup.js` — temp-file sweep (extended in implementation PR).
- `playbooks/shared-rules.md` — auto-injected into every playbook.
- `docs/deprecated.json` — deprecation tracker driving `/cleanup-deprecated`.
- `docs/design-state-storage.md` — precedent for design-doc-in-`docs/` rather than `plans/`.
