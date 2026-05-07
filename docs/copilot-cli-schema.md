# GitHub Copilot CLI — Behavior & Schema Reference

> **Spike output for plan item P-8f2c4d9b.** Authoritative reference for the
> Copilot adapter implementation in P-1d4a8e7c. Every claim in this document is
> grounded in real CLI invocations against `copilot.exe` v1.0.36 on Windows
> (WinGet install, `%LOCALAPPDATA%\Microsoft\WinGet\Links\copilot.exe`).
> Captured samples live alongside this file as
> `copilot-output-sample-{default,claude,gpt4o}.jsonl`.

---

## TL;DR — Adapter Decisions

| Decision | Value | Why |
|---|---|---|
| `capabilities.promptViaArg` | **`false`** | Stdin works in non-interactive mode and dodges the Windows ARG_MAX (~32 KB) limit that breaks `-p "<long-prompt>"` outright (`CreateProcess` rejects it before Copilot even starts). |
| `capabilities.modelDiscovery` | **`true`** | `GET https://api.githubcopilot.com/models` with a `gh auth token` Bearer returns HTTP 200 + a 24-model JSON catalog. |
| `capabilities.streaming` | **`true`** | `--stream on` (default) emits `assistant.message_delta` events incrementally; `--stream off` suppresses deltas but the final `assistant.message` always arrives. |
| `capabilities.sessionResume` | **`true`** | `--resume <session-id>` documented, and every `result` event emits `sessionId`. |
| `capabilities.resumePromptCarryover` | **`true`** | Command Center resume turns should prepend the browser's recent Q&A transcript because Copilot's session store is opaque to Minions and can resume without enough conversational context. |
| `capabilities.systemPromptFile` | **`false`** | No `--system-prompt-file` flag exists. Inject system prompt via a `<system>` block prepended to stdin. |
| `capabilities.effortLevels` | **`true`** | `--effort` accepts `low|medium|high|xhigh` (no `max`). Adapter must map `'max' → 'xhigh'`. |
| `capabilities.costTracking` | **`false`** | `result.usage` contains `premiumRequests` (count, not USD), no token counts, no cost. |
| `capabilities.modelShorthands` | **`false`** | The Copilot CLI requires full model IDs (`claude-sonnet-4.5`, `gpt-5.4`). Minions may accept internal aliases (`haiku`, `sonnet`, `opus`), but the adapter translates them to Copilot model IDs before invoking the CLI. |
| `capabilities.budgetCap` | **`false`** | No `--max-budget-usd` flag. |
| `capabilities.bareMode` | **`false`** | No `--bare`. Closest equivalent is `--no-custom-instructions` (suppresses AGENTS.md only, not all auto-discovery). |
| `capabilities.fallbackModel` | **`false`** | No `--fallback-model` flag. |
| `capabilities.sessionPersistenceControl` | **`false`** | Copilot manages session state internally in `~/.copilot/session-state/`. Engine cannot opt out without `--config-dir`. |

| Default | Value |
|---|---|
| `copilotStreamMode` (default config field) | `'on'` — preserves incremental UX; the adapter parser tolerates either mode. |
| `copilotDisableBuiltinMcps` | `true` — github-mcp-server bypasses Minions' `pull-requests.json` tracking; default OFF. |
| `copilotSuppressAgentsMd` | `true` — Minions injects its own playbook prompt; AGENTS.md auto-load conflicts with that. |
| `copilotReasoningSummaries` | `false` — opt-in; only some models honor it. |

---

## 1. Binary Resolution

### Standalone `copilot` (Windows / WinGet)

```text
PS> where.exe copilot
C:\Users\yemishin\AppData\Local\Microsoft\WinGet\Links\copilot.exe

PS> copilot --version
GitHub Copilot CLI 1.0.36.
```

WinGet installs a shim into `%LOCALAPPDATA%\Microsoft\WinGet\Links\` and adds
that dir to PATH. The adapter's `resolveBinary()` should:

1. Check PATH (`where copilot` / `which copilot`) — the standalone path.
2. If not found, fall back to the `gh copilot` extension (see §1.1).
3. Cache the resolved path to `engine/copilot-caps.json` (mirrors
   `engine/claude-caps.json` shape).
4. Never attempt npm-style resolution — Copilot is **not** an npm package.

### `gh copilot` extension (fallback / unconfirmed on this host)

The `gh-copilot` extension is documented at
<https://docs.github.com/en/copilot/github-copilot-in-the-cli>. On this test
machine `gh extension list` returned empty, so this path was **not exercised
empirically**. The adapter contract still needs to support it for hosts without
the WinGet standalone install:

```text
gh extension install github/gh-copilot
gh copilot --help    # subcommand of gh
```

When falling back to the extension form, the adapter must return:

```js
{ bin: '<path-to-gh.exe>', native: true, leadingArgs: ['copilot'] }
```

so that `engine/spawn-agent.js` invokes `gh copilot <flags>` rather than
`copilot <flags>`. **Important caveat**: the `gh copilot` extension is the
older "explain/suggest" UX and may not support the same flag set as the
standalone `copilot` v1.0.36 (especially `--output-format json`, `--autopilot`,
`--allow-all`). Until empirically validated, treat the `gh copilot` path as
**best-effort** — the adapter should detect missing flags via stderr probe and
warn at preflight.

### Recommended `resolveBinary()` cache shape

```json
{
  "copilotBin": "C:\\Users\\yemishin\\AppData\\Local\\Microsoft\\WinGet\\Links\\copilot.exe",
  "copilotIsNative": true,
  "leadingArgs": [],
  "version": "1.0.36",
  "resolvedAt": "2026-04-28T04:00:00Z"
}
```

---

## 2. Prompt Delivery — `promptViaArg: false` (stdin)

### Empirical results

```powershell
# Test A: stdin without -p — works.
"Say only the word: pong" |
  copilot --output-format json -s --allow-all --no-ask-user --autopilot --log-level error
# EXIT=0; user.message.data.content = "Say only the word: pong\r\n"; assistant replied "pong".

# Test B: -p "<40_000-char string>" — Windows OS rejects spawn.
$big = "x" * 40000
copilot -p $big --output-format json -s --allow-all --no-ask-user --autopilot --log-level error
# Program 'copilot.exe' failed to run:
#   The filename or extension is too long.
#   (CreateProcess ARG_MAX limit, ~32 KB on Windows)
```

### Decision

Set `capabilities.promptViaArg = false`. The adapter **does not** emit
`--prompt <text>` in args; instead, `engine/spawn-agent.js` pipes the final
prompt (system block prepended) via stdin. This:

- Sidesteps the Windows 32 KB ARG_MAX cliff for any prompt that bundles
  `pinned.md`, `notes.md`, knowledge-base entries, and a playbook (Minions
  prompts routinely run 20–60 KB).
- Mirrors the proven Claude path (also `promptViaArg: false`).
- Eliminates the need to investigate `--prompt @tmpfile` syntax (open question
  in the PRD) — that flag does not appear in `copilot --help` output for v1.0.36.
  The `@<path>` prefix syntax is only documented for `--additional-mcp-config`,
  not `--prompt`.

### `buildPrompt(promptText, sysPromptText)` — recommended impl

Copilot has no `--system-prompt-file`. Inject the system prompt as a `<system>`
block prepended to the user prompt, mirroring the convention used by
[Anthropic's tool-use docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use):

```js
function buildPrompt(promptText, sysPromptText) {
  const user = promptText == null ? '' : String(promptText);
  if (!sysPromptText) return user;
  return `<system>\n${sysPromptText}\n</system>\n\n${user}`;
}
```

Combined with `--no-custom-instructions` (default-on per
`copilotSuppressAgentsMd`), this guarantees the prompt the agent sees is exactly
what Minions sent.

---

## 3. Required Headless Flag Set

Empirically confirmed flags for non-interactive Copilot invocations:

| Flag | Required? | Effect |
|---|---|---|
| `--output-format json` | **required** | Switches stdout to JSONL (one event per line). Default is `text`. |
| `-s` / `--silent` | recommended | Suppresses chatty stats lines; only the agent JSONL stream remains. |
| `--allow-all` | **required** | Equivalent to `--allow-all-tools --allow-all-paths --allow-all-urls`. Without this the CLI prompts for every tool/path use, which deadlocks in stdin/stdout mode. |
| `--no-ask-user` | **required** | Removes the `ask_user` tool. Without it the agent can stall waiting for human input. |
| `--autopilot` | for multi-turn agency | Enables `task_complete`-driven multi-turn loop. **Without it** the session ends after one assistant response (see §3.1). |
| `--log-level error` | recommended | Suppresses INFO/DEBUG diagnostics that aren't part of the JSONL stream. |
| `--no-custom-instructions` | gated by config | Disables AGENTS.md auto-load. Default-on for Minions (`copilotSuppressAgentsMd: true`). |
| `--disable-builtin-mcps` | gated by config | Disables `github-mcp-server`. Default-on for Minions (`copilotDisableBuiltinMcps: true`) to prevent split-brain PR creation. |
| `--no-color` | optional | Cosmetic; safe to omit when `--output-format json`. |
| `--plain-diff` | optional | Cosmetic; the agent's diff rendering doesn't appear in JSONL stream anyway. |
| `--max-autopilot-continues N` | optional | Maps from `opts.maxTurns`. |
| `--effort <level>` | optional | Choices: `low|medium|high|xhigh`. **No `max`** — adapter must map `'max' → 'xhigh'`. |
| `--model <id>` | optional | Full model ID (see §6 for the catalog). |
| `--resume=<session-id>` | optional | Maps from `opts.sessionId`. Note the `=` syntax — `--resume <id>` is also accepted but `--resume` standalone enters interactive picker. |
| `--stream on` / `--stream off` | optional | Default is `on`. See §4. |
| `--enable-reasoning-summaries` | optional | Maps from `opts.reasoningSummaries`; only Anthropic models populate `assistant.reasoning_delta`. |
| `--add-dir <path>` | injected by spawn-agent | Same role as on the Claude path — registers extra read-allowed dirs (skill discovery). |
| `-v` / `--verbose` | **never emit** | Does not exist on Copilot. The Claude adapter emits `--verbose`; the Copilot adapter MUST NOT. |

### 3.1 `--autopilot` vs single-shot

| Mode | Terminal event | When to use |
|---|---|---|
| `--autopilot` | `session.task_complete` → `result` | Multi-turn agent work (implement / fix / review). The agent calls the `task_complete` tool with a summary and Copilot ends the session. |
| no `--autopilot` | `assistant.turn_end` → `result` | One-shot Q&A. Fewer events; no `session.task_complete`, no `session.info`. Closer match for CC / doc-chat use cases that don't need multi-turn. |

The Minions agent path (engine.js dispatch) uses autopilot. CC and doc-chat in
`engine/llm.js` should also use autopilot — they need tool use even when only
one assistant turn is expected — but the parser must tolerate the absence of
`session.task_complete` because some early-exit paths skip it.

---

## 4. Streaming — `--stream on` vs `--stream off`

Empirical comparison (single 4-character `pong` reply):

| Property | `--stream on` (default) | `--stream off` |
|---|---|---|
| `assistant.message_delta` events | **1+** (delta-coded; chunks the response as tokens arrive) | **0** (suppressed) |
| `assistant.message` (final) | **1** | **1** |
| Other events | identical | identical |
| Stdout shape | one JSON object per line | one JSON object per line |
| Time-to-first-token | low | high (waits for full response) |

### Parser implications

```js
// Pseudocode — accumulate deltas, but ALWAYS use assistant.message as truth.
let buffered = '';
for (const ev of events) {
  if (ev.type === 'assistant.message_delta') {
    buffered += ev.data.deltaContent;
    emit({ kind: 'partial-text', text: buffered });
  } else if (ev.type === 'assistant.message') {
    // Authoritative final content. Replace buffered text — never concat.
    emit({ kind: 'final-text', text: ev.data.content, messageId: ev.data.messageId });
    buffered = '';
  }
}
```

The parser must handle three cases:
1. `--stream on`, response < 1 chunk: zero deltas, one message. (Common for short replies — see the gpt-4.1 sample.)
2. `--stream on`, response with deltas: N deltas + 1 message (treat message as truth).
3. `--stream off`: zero deltas, one message.

### Recommendation

Default `copilotStreamMode = 'on'` so the engine's streaming UI (live-output.log
tailing, dashboard progress feed) gets incremental updates. The parser tolerates
both, so users who want bandwidth-efficient batch responses can flip to `off`.

---

## 5. JSONL Event Schema

Captured against three model invocations:
- `copilot-output-sample-default.jsonl` — `gpt-5.4` (Copilot's default; OpenAI Codex variant)
- `copilot-output-sample-claude.jsonl` — `claude-sonnet-4.5`
- `copilot-output-sample-gpt4o.jsonl` — `gpt-4.1` (note: `gpt-4o` itself is no longer in the API catalog; closest enabled OpenAI model is `gpt-4.1`)

### 5.1 Event Type Inventory

| Event type | Default (gpt-5.4) | Claude Sonnet 4.5 | GPT-4.1 | Stream-on only? | Notes |
|---|:-:|:-:|:-:|:-:|---|
| `session.mcp_server_status_changed` | ✓ | ✓ | ✓ | no | Per-server connect/disconnect transitions. `data.status` is one of `connecting`/`connected`/`disabled`/`error`. |
| `session.mcp_servers_loaded` | ✓ | ✓ | ✓ | no | Snapshot of all MCP servers + their final status. |
| `session.skills_loaded` | ✓ | ✓ | ✓ | no | List of discovered skills (`source: builtin|project|plugin`). |
| `session.tools_updated` | ✓ | ✓ | ✓ | no | Diagnostic; `data` only has `{ model }` — does **not** list available tools. |
| `session.info` | ✓ | ✓ | – | no (autopilot only) | `infoType: autopilot_continuation` — emitted between turns when autopilot continues. |
| `session.task_complete` | ✓ | ✓ | ✓ | no (autopilot only) | Terminal-of-session signal in autopilot mode. `data.success: bool`, `data.summary: string`. |
| `user.message` | ✓ | ✓ | ✓ | no | Echo of the user prompt, with `transformedContent` showing what the agent actually saw (datetime + reminder block prepended). |
| `assistant.turn_start` | ✓ | ✓ | ✓ | no | Per-turn delimiter. |
| `assistant.turn_end` | ✓ | ✓ | ✓ | no | Per-turn delimiter; pairs with `turn_start`. |
| `assistant.reasoning` | ✓ | ✓ | – | no | Encrypted reasoning blob (`reasoningOpaque`). Absent for non-reasoning models like GPT-4.1. |
| `assistant.reasoning_delta` | – | ✓ | – | yes | **Anthropic-only.** Streamed reasoning text — Claude exposes plain `reasoningText`, OpenAI does not. |
| `assistant.message_delta` | ✓ | ✓ | ✓ | **yes** | Per-token streamed delta. Only emitted with `--stream on`. |
| `assistant.message` | ✓ | ✓ | ✓ | no | Authoritative final assistant content for the turn. |
| `tool.execution_start` | ✓ | ✓ | ✓ | no | Tool call begin. `data.toolName`, `data.arguments`. |
| `tool.execution_complete` | ✓ | ✓ | ✓ | no | Tool call end. `data.success: bool`, `data.result.{content, detailedContent}`. |
| `result` | ✓ | ✓ | ✓ | no | Final aggregate. `data.usage`, `sessionId`, `exitCode`. |
| `function` | (in stdin-no-`-p` test) | – | – | no | Observed once in an early stdin test; appears to be a meta event for tool invocation. **Treat as ignorable** unless future spike re-confirms its semantics. |

All events share the envelope `{ type, data, id, timestamp, parentId, ephemeral? }`.
`ephemeral: true` marks events that the Copilot UI hides from the persistent
session log (e.g., deltas, MCP loading noise). The parser should ignore the
`ephemeral` flag — it's a UI hint, not a parser hint.

### 5.2 Provider-Driven Schema Variation

This is the **biggest gotcha for the parser** — `assistant.message.data` carries
provider-specific fields:

| Field on `assistant.message.data` | Default (gpt-5.4 / Codex) | Claude Sonnet 4.5 | GPT-4.1 |
|---|:-:|:-:|:-:|
| `messageId` | ✓ | ✓ | ✓ |
| `content` | ✓ | ✓ | ✓ |
| `interactionId` | ✓ | ✓ | ✓ |
| `requestId` | ✓ | ✓ | ✓ |
| `outputTokens` | ✓ (52) | ✓ | ✓ |
| `toolRequests` | ✓ | ✓ | ✓ |
| `reasoningOpaque` | ✓ | ✓ | – |
| `reasoningText` | – | ✓ | – |
| `encryptedContent` | ✓ | – | – |
| `phase` | ✓ (`final_answer`) | – | – |

### 5.3 Defensive Parser Rules

1. **Whitelist the events you care about**, route everything else to a
   `type: 'ignore'` bucket. The schema clearly has provider-specific extensions,
   and Copilot's release cadence means new event types will appear without
   warning.
2. **Never assume optional fields exist.** `outputTokens` is consistently
   present, but `reasoningText`/`reasoningOpaque`/`encryptedContent`/`phase`
   are provider-dependent. Prefer `?.` access; default missing numerics to
   `null`, not `0`.
3. **Use `assistant.message.data.content` as the authoritative response.**
   Do not concatenate `assistant.message_delta` deltas into your final result —
   they're a streaming hint, not the source of truth.
4. **The terminal signal differs by mode.** In autopilot, watch for
   `session.task_complete` (and then `result`); in single-shot, watch for
   `result` directly (no `task_complete`).
5. **`exitCode` lives on the `result` event**, not on the process. The CLI
   process always returns 0 even when the agent failed mid-turn — surface
   `result.exitCode !== 0` as the actual failure signal.

### 5.4 Result / Usage Shape (no cost tracking)

```json
{
  "type": "result",
  "timestamp": "2026-04-28T04:11:36.109Z",
  "sessionId": "8a216c49-e51c-4eef-9405-bf83298fced2",
  "exitCode": 0,
  "usage": {
    "premiumRequests": 2,
    "totalApiDurationMs": 5485,
    "sessionDurationMs": 9103,
    "codeChanges": {
      "linesAdded": 0,
      "linesRemoved": 0,
      "filesModified": []
    }
  }
}
```

**Critical**: Copilot does **not** emit `total_cost_usd` or per-token counts
(input/output/cache_*). The closest proxy is `premiumRequests` — a unitless
count of premium-tier requests consumed in the session. The adapter's
`parseOutput()` must map this onto the engine's usage shape with NULLs (not
zeros) for fields Copilot doesn't expose, so dashboard cost telemetry can
distinguish "Copilot didn't tell us" from "this turn cost $0":

```js
{
  costUsd: null,          // ← not 0; Copilot doesn't report this
  inputTokens: null,
  outputTokens: <sum of assistant.message.data.outputTokens>,  // recovered from per-turn events
  cacheRead: null,
  cacheCreation: null,
  durationMs: result.usage.totalApiDurationMs ?? 0,
  numTurns: <count of assistant.turn_end events>,
  // Copilot-specific extension:
  premiumRequests: result.usage.premiumRequests ?? 0,
}
```

---

## 6. Model Discovery

`GET https://api.githubcopilot.com/models` with a Bearer token works.
Empirical result on this host:

```http
GET https://api.githubcopilot.com/models
Authorization: Bearer <gh-cli-token>

200 OK
{ "data": [ <24 model objects> ] }
```

### Token resolution

The adapter should resolve the bearer in this priority:

1. `process.env.GH_TOKEN`
2. `process.env.COPILOT_GITHUB_TOKEN`
3. (Optional best-effort) shell out to `gh auth token` — already works on
   this host since `gh auth status` shows an active session.

`gh auth token` is the authoritative path on developer machines — but spawning
`gh` adds an extra dependency. The adapter should attempt env vars first and
only fall back to `gh auth token` if both are unset, **never required at
listModels-time** (return `null` and let the dashboard fall back to free-text).

### Response shape (24 models on the test account)

```json
{
  "data": [
    {
      "id": "claude-sonnet-4.5",
      "name": "Claude Sonnet 4.5",
      "vendor": "Anthropic",
      "object": "model",
      "version": "claude-sonnet-4.5",
      "preview": false,
      "model_picker_enabled": true,
      "model_picker_category": "powerful",
      "policy": { "state": "enabled", "terms": "..." },
      "supported_endpoints": ["/v1/messages", "/chat/completions"],
      "capabilities": {
        "type": "chat",
        "tokenizer": "o200k_base",
        "family": "claude-sonnet-4.5",
        "limits": { "max_context_window_tokens": 200000, "max_output_tokens": 16000, ... },
        "supports": {
          "streaming": true,
          "tool_calls": true,
          "vision": true,
          "structured_outputs": true,
          "parallel_tool_calls": true,
          "reasoning_effort": ["low", "medium", "high"],
          "adaptive_thinking": true,
          "max_thinking_budget": 32000,
          "min_thinking_budget": 1024
        }
      }
    }
  ]
}
```

### Models seen on this account (snapshot)

```text
claude-haiku-4.5      Claude Haiku 4.5             Anthropic     enabled
claude-opus-4.5       Claude Opus 4.5              Anthropic     enabled
claude-opus-4.6       Claude Opus 4.6              Anthropic     enabled
claude-opus-4.6-1m    Claude Opus 4.6 (1M ctx)     Anthropic     enabled
claude-opus-4.7       Claude Opus 4.7              Anthropic     enabled
claude-sonnet-4       Claude Sonnet 4              Anthropic     enabled
claude-sonnet-4.5     Claude Sonnet 4.5            Anthropic     enabled
claude-sonnet-4.6     Claude Sonnet 4.6            Anthropic     enabled
gpt-3.5-turbo         GPT 3.5 Turbo                Azure OpenAI  (no policy)
gpt-3.5-turbo-0613    GPT 3.5 Turbo                Azure OpenAI  (no policy)
gpt-4.1               GPT-4.1                      Azure OpenAI  enabled
gpt-4.1-2025-04-14    GPT-4.1                      Azure OpenAI  enabled
gpt-4o-mini           GPT-4o mini                  Azure OpenAI  (no policy)
gpt-4o-mini-2024-07-18 GPT-4o mini                 Azure OpenAI  (no policy)
gpt-5-mini            GPT-5 mini                   Azure OpenAI  enabled
gpt-5.2               GPT-5.2                      OpenAI        enabled
gpt-5.2-codex         GPT-5.2-Codex                OpenAI        enabled
gpt-5.3-codex         GPT-5.3-Codex                OpenAI        enabled
gpt-5.4               GPT-5.4                      OpenAI        enabled  (account default)
gpt-5.4-mini          GPT-5.4 mini                 OpenAI        (no policy)
gpt-5.5               GPT-5.5                      OpenAI        enabled
text-embedding-3-small        Embedding V3 small  Azure OpenAI  (no streaming)
text-embedding-3-small-inference                  Azure OpenAI  (no streaming)
text-embedding-ada-002        Embedding V2 Ada    Azure OpenAI  (no streaming)
```

### Adapter mapping (for `listModels()`)

```js
function listModels() {
  // ... HTTP GET as above, on any error return null (non-fatal)
  return data
    .filter(m => m.capabilities?.type === 'chat')           // drop embeddings
    .filter(m => m.policy?.state === 'enabled' || m.preview) // drop disabled
    .map(m => ({
      id: m.id,
      name: m.name,
      provider: m.vendor,
    }));
}
```

### Subscription-tier note

`policy.state` is `"enabled"` or **absent** (no key) — never explicitly
`"disabled"` in this snapshot. Models the user lacks entitlement for simply
omit the policy block. The adapter should treat missing `policy.state` as
"hide from default picker" but still expose them via free-text override —
matches the `model_picker_enabled` field semantics.

`gpt-4o` is no longer present as a top-level model — only `gpt-4o-mini` remains
(and is unlisted in the picker). The plan's `copilot-output-sample-gpt4o.jsonl`
is named for the spec but actually captures `gpt-4.1`, the closest enabled
OpenAI model. **The adapter implementer (P-1d4a8e7c) should reference
`gpt-4.1` as the canonical OpenAI test model** — if `gpt-4o` returns to the
catalog, treat it as a future regression.

---

## 7. Verifying `--no-custom-instructions` and `--disable-builtin-mcps`

### `--no-custom-instructions` (AGENTS.md auto-load)

Constructed test: created `AGENTS.md` in cwd with content
`Always end every response with the marker: __AGENTS_LOADED__`, then ran:

```text
# A) Default behavior — AGENTS.md is loaded
PS> "Just say hello." | copilot --output-format json -s --allow-all --no-ask-user --autopilot --log-level error
{"type":"assistant.message", ..., "content": "Hello. __AGENTS_LOADED__"}      ← marker present

# B) With --no-custom-instructions
PS> "Just say hello." | copilot --output-format json -s --allow-all --no-ask-user --autopilot --log-level error --no-custom-instructions
{"type":"assistant.message", ..., "content": ""}                              ← no marker; AGENTS.md ignored
```

**Confirmed**: `--no-custom-instructions` suppresses AGENTS.md auto-load. The
flag does **not** affect skills loading (project skills under `.claude/skills/`
still appear in `session.skills_loaded`) — it's narrowly scoped to AGENTS-style
custom instruction files.

### `--disable-builtin-mcps` (github-mcp-server)

```text
# Default — server connects, status: "connected"
{"type":"session.mcp_servers_loaded","data":{"servers":[{"name":"github-mcp-server","status":"connected","source":"builtin"}]}}

# With --disable-builtin-mcps — server appears, status: "disabled"
{"type":"session.mcp_servers_loaded","data":{"servers":[{"name":"github-mcp-server","status":"disabled","source":"builtin"}]}}
```

**Confirmed**: the flag flips `status` from `"connected"` to `"disabled"`. The
server is still *registered* (Copilot inventories it for diagnostics), but the
agent cannot use its tools. This is the desired behavior — Minions wants the
server invisible to the agent so all GitHub mutations route through the
project's `pull-requests.json` tracker rather than spawning ghost PRs.

> **Tooltip text for the dashboard `copilotDisableBuiltinMcps` toggle**
> (per P-7a5c1f8e):
>
> > When OFF, agents can autonomously create PRs / labels / comments via the
> > github-mcp-server, bypassing Minions' `pull-requests.json` tracking. Leave
> > this ON unless you have a specific reason to expose the server.

---

## 8. Effort Level Mapping

```text
PS> copilot --help | findstr /C:"reasoning-effort"
  --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                        "low", "medium", "high", "xhigh")
```

Only four valid values: `low`, `medium`, `high`, `xhigh`. The Claude adapter
accepts `'max'` (verbatim) — Copilot does **not**. The adapter must map
`'max' → 'xhigh'` and pass everything else verbatim:

```js
function _mapEffort(level) {
  if (level === 'max') return 'xhigh';
  return level;
}
```

Per the model catalog (§6), Anthropic models advertise
`reasoning_effort: ["low", "medium", "high"]` — note the absence of `xhigh`.
OpenAI Codex variants advertise the full four-level set. Passing
`--effort xhigh --model claude-sonnet-4.5` is unverified; the safe behavior is
to honor whatever the user requests and let Copilot reject it at API-layer if
unsupported (the parser will surface that as an error event).

---

## 9. ARG_MAX on Windows — confirmed cliff at 32 KB

```text
PS> $big = "x" * 40000
PS> copilot -p $big --output-format json ...

Program 'copilot.exe' failed to run:
  An error occurred trying to start process 'copilot.exe' ...
  The filename or extension is too long.
```

Windows' `CreateProcess` enforces `CommandLine ≤ 32 768` chars (lpCommandLine
limit, `MAX_COMMAND_LINE_LENGTH` ≈ 32 KB inclusive of all argv concatenation).
A 40 KB `--prompt` arg is rejected before the binary even starts.

**Mitigation** (already adopted): pipe via stdin (§2). Stdin is unaffected by
ARG_MAX; tested with the same 40 KB string via PowerShell `|` and Copilot
processed it without complaint (full prompt arrived in
`user.message.data.content`).

Linux/macOS ARG_MAX is far higher (typically 128 KB to 2 MB), but stdin is
still preferred — keeps the adapter cross-platform and avoids surprise on
edge cases like `xargs`-style chaining.

---

## 10. Summary — Adapter Wire-Up Checklist for P-1d4a8e7c

When implementing `engine/runtimes/copilot.js`:

1. `capabilities` block exactly matches the table at the top of this doc.
2. `resolveBinary()`:
   - PATH → standalone first; cache to `engine/copilot-caps.json` with
     `{ copilotBin, copilotIsNative, leadingArgs: [] }`.
   - `gh extension list | grep gh-copilot` → fallback with
     `leadingArgs: ['copilot']`. Mark the result as `bestEffort: true` so
     preflight can warn.
   - **Never** probe npm. Document this in the file header.
3. `buildArgs(opts)` always emits:
   `--output-format json -s --allow-all --no-ask-user --autopilot --log-level error`
   plus the conditional flags from §3, plus `--no-custom-instructions` /
   `--disable-builtin-mcps` per `opts.suppressAgentsMd` / `opts.disableBuiltinMcps`.
   **Never** emit `--verbose`.
4. `buildPrompt()` injects `<system>...</system>\n\n` block when sysprompt is
   non-empty; passthrough otherwise (§2).
5. `resolveModel()` translates Minions internal aliases before the CLI boundary:
   `'haiku'` → `'claude-haiku-4.5'`, `'sonnet'` → `'claude-sonnet-4.5'`, and
   `'opus'` → `'claude-opus-4.5'`. All other model IDs pass through unchanged.
   Keep `capabilities.modelShorthands` false because aliases are never passed
   to the Copilot CLI.
6. `_mapEffort()` private helper does `'max' → 'xhigh'`; pass through otherwise.
7. `parseOutput(raw)` produces:
   - `text`: concatenation of all `assistant.message.data.content` (multi-turn
     autopilot).
   - `usage`: shape per §5.4 — `costUsd: null`, `outputTokens: <sum>`,
     `premiumRequests: <result.usage.premiumRequests>`, durations from
     `result.usage`.
   - `sessionId`: from the `result` event.
   - `model`: from any `session.tools_updated` event (`data.model`).
8. `parseStreamChunk(line)` returns the parsed JSON or `null` if line is empty
   / non-JSON. **Defensive**: any event whose `type` is not in the §5.1 inventory
   should still parse cleanly — let the consumer decide to ignore.
9. `parseError(rawOutput)` patterns:
   - `auth-failure`: `/not authenticated|copilot login|401|403/i`
   - `rate-limit`: `/rate limit|too many requests|429/i`
   - `unknown-model`: `/unknown model|model not found|model.*invalid/i`
   - `crash`: `/internal error|panic|uncaught/i`
10. `listModels()` per §6 — return `null` on any failure (network, parse, auth).
    `modelsCache` path: `engine/copilot-models.json`.

When the spike's findings disagree with the plan text, **this document wins**
(the plan was written before empirical confirmation). The notable deltas:
- `gpt-4o` is no longer in the catalog → use `gpt-4.1` for OpenAI tests.
- `--prompt @tmpfile` syntax is **not** supported on `copilot --prompt` (only
  on `--additional-mcp-config`). Open question #3 in the PRD is closed: stdin
  is the answer.
- `--verbose` does not exist; do not port the Claude adapter's `verbose: true`
  default into the Copilot adapter.

---

## Provenance

- Test host: Windows 11, PowerShell 7+, `copilot.exe` 1.0.36 from WinGet.
- GitHub account: `yemi33` (active `gh auth` session, scopes:
  `gist read:org repo workflow`).
- All JSONL samples reproducible via the commands documented in each section.
- Spike completed: 2026-04-28.
