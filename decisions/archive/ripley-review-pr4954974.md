# Review: PR-4954974 — feat(eval): automated CI regression gate

**Reviewer:** Ripley (Lead/Explorer)
**Date:** 2026-03-11
**Branch:** feature/m010-ci-eval-gate
**Author:** Rebecca

## Verdict: Approve with Comments

The core gate logic is correct and well-tested. One functional bug must be fixed before merge.

## Issues

### 1. BUG (must fix): `$${{ parameters.skipGate }}` in run-eval-gate.yml line 18
Double dollar sign is an ADO escape — produces literal string instead of boolean value. The pipeline `skipGate` parameter will never work. Fix: change `$${{` to `${{`.

### 2. Dead code: `pr-eval-gate-job.yml` template (should fix)
52-line template file is never referenced. The eval gate job is inlined in `build-container-pr.yml`. Remove the template or refactor to use it. The template also has a missing `get-officepy-version.yml` step that would cause it to fail if referenced.

### 3. Pipeline artifact fragility (suggestion)
`targetPath` points to a single file. If the gate script errors before writing the report, publish fails silently. Consider pointing to the directory instead.

### 4. No integration tests for `main()` (suggestion)
Unit tests cover helper functions well (11 tests). Missing: tests for `--skip` (exit 2), `--report-only` flow, and error exit code 3.

## Strengths
- Threshold logic is correct (baseline regression, absolute minimums, missing scores, default tolerance)
- Clean exit codes (0/1/2/3)
- Multiple emergency override paths
- Report-only mode for threshold checking without eval runs
- Comprehensive score extraction for all evaluator types
- Good documentation and baseline config with guidelines

## ADO Threads Posted
- Main review thread (id: 61959448)
- Inline on run-eval-gate.yml line 18 — `$$` bug (id: 61959453)
- Inline on pr-eval-gate-job.yml — dead template (id: 61959456)
