# Design: Replacing File-Based State with a Structured Database

> Author: Rebecca (Architect) | Date: 2026-04-07 | Status: Proposal

## Executive Summary

Minions persists all runtime state as flat JSON files guarded by file-lock-based concurrency (`mutateJsonFileLocked`). This analysis evaluates five options for migrating to a structured database, benchmarks each against the current approach, and delivers a phased recommendation.

**Verdict:** Stay with improved file-based state short-term. Adopt `node:sqlite` (`DatabaseSync`) as the medium-term target once it exits experimental status, migrating the highest-pain state files first.

---

## 1. Current State Architecture

### 1.1 State Files Inventory

| File | Size (live) | Records | Access Pattern | Contention | Pain Level |
|------|-------------|---------|----------------|------------|------------|
| `engine/dispatch.json` | 380 KB | 102 completed + 2 active | R/W every tick; 10+ reads/tick (2s cache) | **High** — engine + dashboard + lifecycle | High |
| `engine/log.json` | 292 KB | 2,162 entries | Append-only (buffered flush every 500ms) | Medium — log buffer serializes | Medium |
| `engine/cooldowns.json` | 511 KB | 125 keys | R/W on dispatch failure + retry | Low — infrequent writes | High (bloated) |
| `engine/metrics.json` | 5 KB | Per-agent stats | R/W on PR approval/merge | Low | Low |
| `engine/control.json` | 169 B | Single object | R/W on start/stop/heartbeat | Low | Low |
| `projects/*/work-items.json` | 370 KB | 180 items | R/W every 1-2 ticks; dashboard reads on-demand | **High** — engine + lifecycle + dashboard | High |
| `projects/*/pull-requests.json` | 241 KB | 128 PRs | R/W on the `prPollStatusEvery × tickInterval` wall-clock cadence (default ≈12min); lifecycle writes | Medium | Medium |
| `engine/pipeline-runs.json` | 36 KB | Pipeline state | R/W on pipeline execution | Low | Low |
| `engine/schedule-runs.json` | 115 B | Last-run times | R every 10 ticks; W on schedule execution | Low | Low |

**Total live state:** ~1.8 MB across 9+ JSON files.

(source: `engine/shared.js:233-252` for locking, `engine/queries.js:57-61` for paths, live file sizes from `ls -la engine/*.json`)

### 1.2 Concurrency Model

All mutations go through `mutateJsonFileLocked()` (source: `engine/shared.js:233-252`):

```
acquire .lock file (exclusive create via fs.openSync 'wx')
  → read JSON file (full parse)
  → apply mutation function
  → write entire file (atomic rename via safeWrite)
  → create .backup sidecar
release .lock file
```

Key properties:
- **Synchronous blocking** — `withFileLock` spins with `sleepMs(25)` until lock acquired or 5s timeout (source: `engine/shared.js:175-231`)
- **Whole-file granularity** — updating one field in one work item rewrites all 180 items (370 KB)
- **Stale lock recovery** — locks older than 60s are force-removed (source: `engine/shared.js:173`, `LOCK_STALE_MS`)
- **Read caching** — only `dispatch.json` has a 2s TTL cache (source: `engine/queries.js:82-91`)

### 1.3 Read vs Write Ratio

| Consumer | Reads/tick | Writes/tick | Pattern |
|----------|-----------|-------------|---------|
| Engine tick cycle | ~15 | ~3 | Heavy read, selective write |
| Dashboard (per page load) | ~8 | 0 | Read-only display |
| Dashboard (user action) | ~2 | ~2 | Read-modify-write |
| PR polling (every `prPollStatusEvery × tickInterval`, default ≈12min) | ~4 | ~2 | Batch read-modify-write |
| Consolidation (every 10 ticks) | ~3 | ~2 | Read inbox files, write notes.md |

**Read:write ratio is approximately 8:1.** This strongly favors a system that can serve reads without locking (e.g., WAL mode).

---

## 2. Option Evaluation

### 2.1 `node:sqlite` (DatabaseSync) — Node 22.5+

**Current status:** Available in Node v24.12.0 (this machine). Marked `ExperimentalWarning`. Synchronous API via `DatabaseSync`.

**Benchmark results** (measured on this machine):

| Operation | `node:sqlite` | File-based (current) |
|-----------|---------------|---------------------|
| Insert 1,000 rows (transaction) | 4.6 ms | N/A (no equivalent) |
| Single SELECT by status (200 rows) | 0.13 ms | 2.9 ms (full parse) + 0.06 ms (filter) |
| 100 individual UPDATEs (no txn) | 48.7 ms | ~270 ms (100x full rewrite) |
| 100 UPDATEs in transaction | 0.7 ms | N/A |
| SELECT all 1,000 rows | 0.7 ms | 2.9 ms (parse 370 KB) |

**Dependency story:** Zero npm dependencies. Ships with Node.js. No native addon build step.

**Cross-platform:** SQLite is compiled into Node itself — works identically on Windows, macOS, Linux.

**Concurrency model:**
- WAL mode allows concurrent readers with one writer (verified working — source: benchmark tests above)
- `DatabaseSync` is synchronous, matching the current blocking model exactly
- Transactions replace file locks — `BEGIN EXCLUSIVE` provides the same mutual exclusion
- Row-level updates eliminate whole-file rewrites

**Migration complexity:** High. ~40+ `safeJson` read sites across `engine.js`, `dashboard.js`, `queries.js`, `lifecycle.js`. ~20+ `mutateJsonFileLocked` write sites. Each needs conversion to prepared statements.

**JSON support:** SQLite JSON1 extension works — `json_extract()`, `json_each()` verified functional for dependency resolution queries.

**Pros:**
- Zero dependencies (built into Node)
- WAL mode eliminates read-write contention
- Row-level operations (no more 370 KB rewrites for one field change)
- Indexed queries (find pending items by status without scanning all items)
- Transactions provide stronger atomicity than file locks
- Single `.db` file replaces 9+ JSON files + 9 `.backup` + 9 `.lock` files

**Cons:**
- **Experimental API** — could change between Node versions with no migration path
- State files become opaque (can't `cat dispatch.json` for debugging)
- Schema migrations needed as data model evolves
- No async API yet (acceptable — current code is sync anyway)
- `ExperimentalWarning` printed on first import (suppressible with `--no-warnings=ExperimentalWarning`)

**Risk assessment:** The experimental status is the **only** serious blocker. The API surface is small (`DatabaseSync`, `prepare`, `exec`, `get`, `all`, `run`) and mirrors `better-sqlite3` closely — likely to stabilize without breaking changes. But "likely" is not "guaranteed."

### 2.2 LevelDB / LMDB (Embedded Key-Value)

**Dependency story:** npm packages with native C/C++ addons. `level` (LevelDB wrapper) or `lmdb-js`.

**Cross-platform:** Requires native build toolchain (node-gyp, C++ compiler). Windows support historically fragile.

**Concurrency model:**
- LMDB: MVCC with zero-copy reads — excellent read performance
- LevelDB: Single-process lock; read-free but writes serialize

**Migration complexity:** Medium-high. Key-value model doesn't naturally support the relational queries needed (e.g., "find all pending work items for project X with unmet dependencies").

**Pros:**
- Battle-tested in production
- LMDB: extremely fast reads with memory-mapped I/O
- Supports ordered iteration (useful for log entries)

**Cons:**
- **Breaks zero-dependency principle** (hard stop)
- Native addon build complexity on Windows
- Key-value model is a poor fit for relational queries on work items
- Adds ~15-50 MB to install footprint

**Verdict:** Disqualified by the zero-dependency constraint.

### 2.3 Better-SQLite3

**Dependency story:** npm package with native C addon. Prebuilt binaries available for most platforms via `prebuild-install`.

**Cross-platform:** Good — prebuilt binaries for Windows/macOS/Linux. Fallback to node-gyp if no prebuild.

**Concurrency model:** Identical to `node:sqlite` — synchronous, WAL mode, same SQLite engine underneath.

**Migration complexity:** Same as `node:sqlite` — the API is nearly identical (`db.prepare().run()`, `.get()`, `.all()`).

**Pros:**
- Most popular SQLite binding for Node.js (14M weekly downloads)
- Stable, well-maintained, extensive documentation
- Synchronous API (perfect match)
- Full SQLite feature set including JSON1

**Cons:**
- **Breaks zero-dependency principle** (hard stop)
- Native addon (prebuilt binaries help but don't eliminate all build issues)
- ~8 MB added to node_modules

**Verdict:** Disqualified by the zero-dependency constraint. However, if `node:sqlite` stabilizes with an API modeled on `better-sqlite3` (which it is), then `better-sqlite3` serves as a proven reference implementation.

### 2.4 Improved File-Based Approach

Keep JSON files but address the worst pain points structurally.

**Specific improvements:**

| Improvement | Targets | Effort | Impact |
|-------------|---------|--------|--------|
| **Split dispatch.json** into `dispatch/pending.json`, `dispatch/active.json`, `dispatch/completed/` (per-entry files) | dispatch.json (380 KB) | Medium | Reduces lock contention — pending/active/completed are independently lockable |
| **Cap and rotate cooldowns.json** — delete entries older than 7 days | cooldowns.json (511 KB) | Low | 511 KB → ~20 KB |
| **Per-entity files for completed dispatches** — `dispatch/completed/{id}.json` | dispatch.json completed array | Medium | Eliminates growing array; reads become `readdir + filter` |
| **Add read caches** — extend 2s TTL cache from dispatch.json to work-items.json and pull-requests.json | queries.js | Low | 60-80% fewer disk reads per tick |
| **JSON Lines for log.json** — append-only `.jsonl` format | log.json (292 KB) | Low | Eliminates parse-entire-file-to-append; rotation becomes `tail -n 2000` |
| **Structured directory layout** — `state/{entity}/{id}.json` | All state files | High | Per-entity locking, but dramatically increases file count |

**Dependency story:** Zero — pure Node.js.

**Cross-platform:** Identical to current.

**Concurrency model:** Same file locks, but with finer granularity (per-entity instead of per-file).

**Migration complexity:** Low-medium. Read/write APIs stay the same shape; internal storage layout changes.

**Pros:**
- Zero risk — no new dependencies or experimental APIs
- Human-readable state (critical for debugging)
- Incremental migration (one file at a time)
- Preserves existing backup/restore pattern

**Cons:**
- Doesn't solve the fundamental problem: whole-file read-modify-write for arrays
- Per-entity files create thousands of small files (OS inode pressure on large deployments)
- No indexed queries — filtering still requires scanning all files
- Read caches add TTL staleness risk

### 2.5 Hybrid: JSON Lines + Indexed Views

A creative zero-dep option: use append-only JSON Lines files as the write log, with periodic compaction into indexed JSON snapshots.

**How it works:**
1. Writes append to `state/{entity}.jsonl` (no locking needed for appends)
2. Reads come from a cached in-memory index (rebuilt from JSONL on startup)
3. Periodic compaction rewrites the JSONL file, discarding superseded entries

**Pros:**
- Append-only writes are naturally lock-free
- In-memory index serves reads instantly
- Human-readable (JSONL is `cat`-able)
- Zero dependencies

**Cons:**
- Requires custom index implementation (error-prone)
- Compaction logic is complex to get right under concurrent access
- Crash recovery requires replaying the full JSONL file
- Reinventing a (bad) database

**Verdict:** Too much complexity for marginal gain. If we're going to build database-like infrastructure, use an actual database.

---

## 3. Recommendation

### Phase 1: Quick Wins (Now — 1-2 days effort)

Stay with files. Fix the two highest-pain issues immediately:

1. **Cap `cooldowns.json`** — Add a cleanup sweep that deletes entries older than 7 days. This file is 511 KB with 125 keys, most of which are stale. Implement in `engine/cooldown.js` cleanup function. (source: `engine/cooldown.js`)

2. **Cap `dispatch.json` completed array** more aggressively — Currently capped at 100 entries (source: `engine/dispatch.js:112-114`). Reduce to 50 or archive to `dispatch/completed/` directory. The 380 KB file is mostly completed entries.

3. **Add read caches to `work-items.json` and `pull-requests.json`** — Same 2s TTL pattern as dispatch.json (source: `engine/queries.js:82-91`). These are read 8+ times per tick but only written 1-2 times.

4. **Convert `log.json` to append-only JSONL** — Eliminates the parse-entire-file-to-append pattern in `_flushLogBuffer()` (source: `engine/shared.js:49-59`). Log rotation becomes `readFile → keep last 2000 lines → writeFile` instead of `parse JSON array → splice → stringify → write`.

### Phase 2: `node:sqlite` Migration (When API stabilizes — estimated Node 26 LTS)

Monitor `node:sqlite` stability. When it exits experimental:

**Migration order** (highest pain first):

| Priority | State File | Why First |
|----------|-----------|-----------|
| 1 | `engine/log.json` | Append-heavy, benefits most from indexed queries, lowest risk (read-only by dashboard) |
| 2 | `engine/dispatch.json` | Most contended file, benefits from row-level operations, eliminates completed array growth |
| 3 | `engine/cooldowns.json` | Bloated key-value store, natural fit for TTL-indexed table |
| 4 | `projects/*/work-items.json` | Core entity, benefits from indexed status/project/type queries |
| 5 | `projects/*/pull-requests.json` | Similar to work items, lower contention |
| 6 | `engine/metrics.json` | Small, low contention — migrate for consistency |
| 7 | `engine/control.json` | Tiny, single-object — migrate last for consistency |

**Migration architecture:**

```
┌─────────────────────────────────────────────────┐
│                  StateStore API                  │
│  (drop-in replacement for mutateJsonFileLocked)  │
├─────────────────────────────────────────────────┤
│  getWorkItems(filter?)  → WorkItem[]             │
│  mutateWorkItem(id, fn) → WorkItem               │
│  getDispatch()          → DispatchQueue           │
│  mutateDispatch(fn)     → DispatchQueue           │
│  appendLog(entry)       → void                    │
│  ...                                              │
├─────────────────────────────────────────────────┤
│          Backend: SQLite (DatabaseSync)           │
│  ┌─────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ WAL mode│ │ Prepared │ │ JSON data column  │  │
│  │         │ │statements│ │ + indexed columns │  │
│  └─────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Key design decisions for the SQLite schema:**

1. **Hybrid column strategy** — Store frequently-queried fields as indexed columns (`id`, `status`, `type`, `project`), keep the full object in a `data TEXT` column as JSON. This allows SQL `WHERE` on hot fields while preserving schema flexibility.

2. **Single database file** — All state in one `.db` file in `engine/minions.db`. WAL mode enables concurrent reads. Transactions replace file locks.

3. **Prepared statement cache** — Create all prepared statements at startup, reuse throughout process lifetime. This avoids the 0.7ms-per-prepare overhead measured in benchmarks.

4. **Migration layer** — On first startup with SQLite, read existing JSON files, populate tables, rename JSON files to `.json.migrated`. On rollback, the `.migrated` files can be renamed back.

5. **Debug tooling** — Add `minions db` CLI command that opens an interactive SQLite shell on `engine/minions.db` for debugging (replaces `cat dispatch.json`).

**Proposed schema (core tables):**

```sql
-- Dispatch queue entries
CREATE TABLE dispatch (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL CHECK(queue IN ('pending','active','completed')),
  type TEXT NOT NULL,
  agent TEXT,
  task TEXT,
  meta TEXT,          -- JSON blob
  created_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result TEXT,
  reason TEXT
);
CREATE INDEX idx_dispatch_queue ON dispatch(queue);
CREATE INDEX idx_dispatch_agent ON dispatch(agent);

-- Work items
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  type TEXT,
  title TEXT,
  priority TEXT,
  data TEXT,          -- Full JSON blob
  created TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_wi_status ON work_items(status);
CREATE INDEX idx_wi_project ON work_items(project);
CREATE INDEX idx_wi_project_status ON work_items(project, status);

-- Pull requests
CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT,
  branch TEXT,
  agent TEXT,
  data TEXT,          -- Full JSON blob
  created TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_pr_status ON pull_requests(status);
CREATE INDEX idx_pr_project ON pull_requests(project);

-- Engine log (append-only)
CREATE TABLE engine_log (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT,
  meta TEXT            -- JSON blob
);
CREATE INDEX idx_log_timestamp ON engine_log(timestamp);
CREATE INDEX idx_log_level ON engine_log(level);

-- Cooldowns (TTL-based)
CREATE TABLE cooldowns (
  key TEXT PRIMARY KEY,
  failures INTEGER DEFAULT 0,
  last_failure TEXT,
  cooldown_until TEXT,
  data TEXT
);
CREATE INDEX idx_cd_until ON cooldowns(cooldown_until);

-- Metrics
CREATE TABLE metrics (
  agent TEXT PRIMARY KEY,
  data TEXT            -- JSON blob with token usage, quality, etc.
);

-- Key-value store for small state (control, schedule-runs, etc.)
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### Phase 3: Advanced Optimizations (Post-migration)

Once on SQLite, unlock capabilities impossible with file-based state:

1. **Dashboard SSE from SQLite triggers** — Use `sqlite3_update_hook` (if exposed) or polling with `WHERE updated_at > ?` instead of file-watching
2. **Dependency resolution via SQL** — Replace in-memory graph traversal with recursive CTEs
3. **Metrics aggregation** — `SELECT agent, SUM(tokens) FROM dispatch WHERE completed_at > ? GROUP BY agent`
4. **Log analysis** — `SELECT level, COUNT(*) FROM engine_log WHERE timestamp > ? GROUP BY level`
5. **Automatic compaction** — `DELETE FROM engine_log WHERE rowid < (SELECT MAX(rowid) - 2000 FROM engine_log)`

---

## 4. What NOT to Do

1. **Don't migrate to SQLite while the API is experimental.** A Node.js upgrade that changes `DatabaseSync` parameters or removes the module would be catastrophic for a state storage layer.

2. **Don't use an async SQLite API** (if one is added to Node). The current codebase is fundamentally synchronous — `mutateJsonFileLocked` is called from synchronous code paths. Mixing sync and async state access is a recipe for race conditions.

3. **Don't split into per-entity files** at scale. Going from 9 files to potentially thousands (one per work item, per dispatch entry) creates inode pressure, `readdir` performance issues, and makes atomic multi-entity operations harder (need to lock multiple files).

4. **Don't add npm dependencies** for state storage. The zero-dependency principle is a genuine architectural strength — it means `git clone && node engine.js` works everywhere with zero setup.

5. **Don't build a custom database.** The JSON Lines + compaction + in-memory index approach is literally reimplementing SQLite badly. Use the real thing when it's stable.

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `node:sqlite` API breaks on Node upgrade | Medium (experimental) | High — state inaccessible | Phase 2 only after API stabilizes; keep JSON export/import |
| File-based approach hits scaling limit | Low (current data tiny) | Medium — slower ticks | Phase 1 caching + capping buys years of headroom |
| SQLite `.db` corruption | Very low (SQLite is ACID) | High — state lost | WAL mode + periodic `.db` backup to `.db.backup` |
| Migration bugs lose state | Medium | High | Dual-write period: write to both JSON and SQLite for 1 week |
| Dashboard performance degrades during migration | Low | Low | Read API stays the same shape; backend changes only |

---

## 6. Decision Matrix

| Criterion | Files (current) | Files (improved) | `node:sqlite` | `better-sqlite3` | LevelDB/LMDB |
|-----------|----------------|------------------|---------------|-------------------|---------------|
| Zero dependencies | **Yes** | **Yes** | **Yes** | No | No |
| Cross-platform | **Yes** | **Yes** | **Yes** | Mostly | Fragile on Win |
| Concurrency | File locks | File locks (finer) | WAL + transactions | WAL + transactions | MVCC |
| Row-level ops | No | Partial | **Yes** | **Yes** | Yes (KV) |
| Indexed queries | No | No | **Yes** | **Yes** | No |
| Human-readable | **Yes** | **Yes** | No | No | No |
| API stability | Stable | Stable | **Experimental** | Stable | Stable |
| Migration effort | None | Low | High | High | High |
| Debugging ease | **Excellent** | **Excellent** | Needs tooling | Needs tooling | Poor |

---

## 7. Summary

**Short-term (this week):** Implement Phase 1 quick wins — cap cooldowns, add read caches, reduce dispatch completed cap. Zero risk, immediate improvement.

**Medium-term (Node 26 LTS timeframe):** Adopt `node:sqlite` with the hybrid column schema. Migrate log.json first (lowest risk), then dispatch.json (highest pain), then work-items.json. Use a dual-write period for safety.

**The current file-based system is not broken.** At 180 work items and 128 PRs, we're well within the comfortable range for JSON files. The biggest issues (511 KB cooldowns.json, 380 KB dispatch.json) are capping/rotation problems, not fundamental architecture problems. Fix those first.

SQLite is the right long-term answer, but only when `node:sqlite` is no longer experimental. The API is excellent, the performance is superior, and it maintains the zero-dependency principle. Patience here avoids a painful migration if the API changes.
