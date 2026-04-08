# Verification Report & Testing Guide

**Date:** {{date}}
**Plan:** {{source_plan}}
**Verified by:** {{agent_name}}

## What Was Built

For each completed plan item, summarize:
- **Item ID:** what it implements
- **Key changes:** files modified, features added, behaviors changed
- **PR:** link to the individual PR

## Verification Results

### Build Status

| Project | Worktree Path | Build | Tests | Notes |
|---------|--------------|-------|-------|-------|
| name | path | PASS/FAIL | X pass, Y fail, Z skip | error details if any |

### Automated Test Results
- Total: X passed, Y failed, Z skipped
- Notable failures: (list any, with error messages)
- Test coverage notes: (are the new features covered by tests?)

### What Was Verified
For each plan item, state what you actually checked:
- Did the build pass with this change included?
- Did existing tests pass?
- Were there new tests for the new functionality?
- Any runtime errors observed?

### What Could NOT Be Verified Automatically
List anything that requires human judgment:
- UI/UX changes that need visual inspection
- Behaviors that depend on external services
- Performance characteristics
- Edge cases not covered by tests

## Manual Testing Guide

**How to run:** (server URL, emulator command, APK path, or N/A)
**Restart Command:** `cd <absolute-worktree-path> && <command>` (if applicable)

### <Feature Name> (Plan Item ID)
**What changed:** brief description
**How to test:**
1. Step-by-step instructions
2. With concrete actions (URLs, buttons, inputs)
3. And expected outcomes

**Acceptance criteria check:**
- [ ] (from plan item acceptance criteria)
- [ ] (from plan item acceptance criteria)

### <Next Feature> ...

## Integration Points

Cross-project or cross-feature interactions to verify:
- e.g., "Service A calls Service B — verify the API contract"

## Known Issues
- Build warnings, test failures, merge conflicts, unimplemented items

## Quick Smoke Test
A minimal 5-step checklist to verify the core functionality:
1. ...
2. ...
3. ...
4. ...
5. ...
