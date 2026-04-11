# Verification: Fix silent state-loss bugs in dispatch persistence, lifecycle races, and checkpoint handling

**Plan:** minions-2026-04-01-5.json
**Date:** 2026-04-11
**Verified by:** Ripley

## Results Summary

| Item | PR | Verdict |
|------|-----|---------|
| P-b3c9e4f6: needs-human-review skip filter | PR-55 (merged) | PASS |
| P-f7a2d8e1: dispatch persistence gate | PR-57 (merged) | PASS |
| P-d5e1a7b3: TOCTOU races in lifecycle | PR-56 (merged) | PASS |
| P-a8f4c2d9: fan-out checkpoint handling | PR-58 (merged) | REGRESSION |
| P-e6b0d3a5: checkpoint cleanup + _pendingReason | PR-60 (merged) | REGRESSION |
| P-c1d7f9e8: resolveWiPath export | PR-59 (closed) | NOT MERGED |

**Tests:** 1463 passed, 0 failed, 2 skipped

## Regressions

Two items (P-a8f4c2d9, P-e6b0d3a5) were correctly merged but their changes were
subsequently lost during engine.js refactors that rewrote `discoverCentralWorkItems`
to use a mutations Map pattern. The original direct-item-mutation code was not carried
forward.

Affected features:
1. Fan-out checkpoint.json reading (engine.js:2484-2487 missing `worktreePath`)
2. Checkpoint file deletion after consumption (no `unlinkSync` calls remain)
3. `_pendingReason` clearing on fan-out/single-agent dispatch

See full report in `prd/guides/verify-minions-2026-04-01-5.md` (runtime, gitignored).
