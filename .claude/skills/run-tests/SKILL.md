---
name: run-tests
description: Run the full Minions test suite (unit + integration) and report results
---

# Run Tests

Run the Minions test suite and validate system stability.

## Usage

Invoke this skill to run all tests. It supports three modes:

- **Unit tests only** (fast, no dependencies): `node test/unit.test.js`
- **Integration tests** (requires dashboard on port 7331): `node test/minions-tests.js`
- **Full suite**: `npm test` (runs unit tests by default)

## Steps

1. Run unit tests:
   ```bash
   cd <minions-dir> && node test/unit.test.js
   ```

2. Check the exit code:
   - Exit 0 = all tests passed
   - Exit 1 = one or more tests failed

3. If integration tests are needed (dashboard must be running):
   ```bash
   node test/minions-tests.js
   ```

4. For CI pipelines, use:
   ```bash
   npm test
   ```
   This runs unit tests and exits with appropriate code.

5. Results are written to `engine/test-results.json` for programmatic consumption.

## Test Coverage

The unit test suite covers:
- **shared.js**: File I/O, ID generation, branch sanitization, output parsing, KB classification, skill frontmatter
- **queries.js**: All state readers (config, dispatch, agents, work items, PRs, skills, KB, PRD)
- **engine.js**: Routing parser, dependency cycle detection
- **lifecycle.js**: Output parsing, PRD sync
- **Config/Playbooks**: Validation of all required files
- **State Integrity**: Dispatch structure, work item consistency, metrics validity
- **Edge Cases**: Concurrent writes, large data, malformed inputs, null guards

## CI Integration

Add to your CI pipeline:
```yaml
- script: node test/unit.test.js
  displayName: 'Minions Unit Tests'
  workingDirectory: $(minionsDir)
```

