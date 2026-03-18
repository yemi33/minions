---
name: e2e-tests
description: Run the Playwright E2E test suite, interpret results, add tests for new features, and manage the regression baseline
allowed-tools: Bash, Read, Edit, Write, Grep
trigger: when the user wants to run tests, check for regressions, add tests for a new feature, or regenerate the baseline
scope: squad
project: any
---

# Squad Dashboard E2E Test Suite

## Overview

**119 tests across 24 groups** covering every button, section, modal, form, and API endpoint in the dashboard.

| File | Purpose |
|------|---------|
| `test/playwright/dashboard.spec.js` | All test specs |
| `test/playwright/reporter.js` | Custom summary reporter + regression tracking |
| `test/playwright/accept-baseline.js` | Accepts last run as new regression baseline |
| `playwright.config.js` | Playwright config (headless, retries, reporters) |
| `engine/test-results.json` | Results from last run |
| `engine/test-baseline.json` | Accepted baseline for regression comparison |

---

## Running Tests

```bash
npm run test:e2e            # Full suite, headless, with summary
npm run test:e2e:headed     # Watch it run in a browser window
npm run test:e2e:video      # Record video of every test (full walkthrough)
npm run test:e2e:ui         # Playwright interactive UI mode
npm run test:e2e:report     # Open HTML report (screenshots, traces, timeline)
npm run test:all            # API tests + E2E together
```

**Filters (faster iteration):**
```bash
npx playwright test --grep "Command Center"   # Run one section
npx playwright test --grep "Work Items|PRD"   # Run multiple sections
npx playwright test dashboard.spec.js:53      # Run from specific line
```

---

## Reading the Output

The custom reporter prints a grouped summary:

```
  ✓ Page Load (7/7)
    PASS dashboard loads with correct title
    PASS all section headings render

  ✗ Work Items (3/4)
    PASS section renders
    FAIL retry button calls API   → expect(received).toBe(200)
```

- **PASS** — test passed
- **FAIL** — test failed (error shown on next line)
- **SKIP** — test skipped (usually means required data doesn't exist, e.g. no PRD items)

### Regression line at the bottom
```
✓ No regressions vs baseline.
  3 new test(s) not yet in baseline — run npm run test:e2e:accept to update.
```
or
```
⚠ REGRESSIONS vs baseline:
  - Work Items > retry button calls API
```

---

## When a New Feature Is Added

### Step 1 — Add tests for the new feature

Open `test/playwright/dashboard.spec.js` and add a `test.describe` block:

```javascript
test.describe('My New Feature', () => {
  test('feature button is visible', async ({ page }) => {
    await load(page);
    await expect(page.locator('#my-feature-btn')).toBeVisible();
  });

  test('clicking button triggers expected action', async ({ page }) => {
    await load(page);
    await page.locator('#my-feature-btn').click();
    const resp = await page.waitForResponse(r => r.url().includes('/api/my-feature'));
    expect(resp.status()).toBe(200);
  });
});
```

**Common patterns:**
```javascript
// Wait for dashboard to load
await load(page);

// Click a button and wait for API response
const resp = await page.waitForResponse(r => r.url().includes('/api/endpoint'));
await page.locator('button:has-text("Action")').click();
await resp;

// Check modal opens
await page.locator('[onclick*="openModal"]').click();
await expect(page.locator('#modal')).toBeVisible({ timeout: 3000 });
await page.keyboard.press('Escape');

// Skip if no data exists yet
const status = await GET('/api/status');
if (!status.json.myNewData?.length) { test.skip(); return; }

// Create test data, verify, clean up
const r = await POST('/api/my-resource', { name: 'E2E Test' });
// ... test ...
await POST('/api/my-resource/delete', { id: r.json.id });
```

### Step 2 — Run the tests

```bash
npm run test:e2e
```

The reporter will say:
```
  2 new test(s) not yet in baseline — run npm run test:e2e:accept to update.
```

### Step 3 — Fix any failures, then accept the new baseline

Once all tests pass (including your new ones):

```bash
npm run test:e2e:accept
```

This copies `engine/test-results.json` → `engine/test-baseline.json`. Future runs compare against this.

If some tests are intentionally skipped or failing (e.g. feature is partial):
```bash
npm run test:e2e:accept-force   # Accept even with failures
```

---

## Investigating Failures

### View the HTML report (recommended)
```bash
npm run test:e2e:report
```
The report contains:
- Screenshot at point of failure
- **Playwright Trace** — step-by-step timeline of every action with DOM snapshots, network requests
- Video of the test run (for failed tests)

### View a trace
```bash
npx playwright show-trace test-results/path/to/trace.zip
```

### Run with visible browser
```bash
npm run test:e2e:headed
```

### Debug a specific failing test
```bash
npx playwright test --grep "test name" --debug
```

### Record video for everything
```bash
npm run test:e2e:video
# Videos saved to test-results/ directory
```

---

## Baseline Management

| Command | When to use |
|---------|-------------|
| `npm run test:e2e:accept` | After adding new features + tests, all passing |
| `npm run test:e2e:accept-force` | To document known failures as "acceptable" |

**Never accept a baseline with regressions** — only accept after fixing or intentionally acknowledging failures.

The baseline file (`engine/test-baseline.json`) should be committed to git so the whole team tracks the same regression point.

---

## Test Groups Reference

| Group | Tests | What it covers |
|-------|-------|---------------|
| Page Load | 7 | Title, header, all sections, count badges |
| Engine Status | 4 | Badge text, log, auto-refresh |
| Command Center | 8 | Input, CC drawer, @ mentions, history, Ctrl+Enter |
| Agents | 7 | Cards, detail panel, tabs, ESC, overlay close |
| Work Items | 5 | Render, archive toggle, create/verify/delete lifecycle |
| PRD | 5 | Progress bar, list/graph toggle, edit modal |
| Pull Requests | 5 | Table, status badges, see-all modal, pagination |
| Plans | 6 | Tabs, cards, action buttons, view modal, revise |
| Notes Inbox | 3 | Create/display, delete, KB promotion flow |
| Team Notes | 5 | Modal open, content, edit/cancel cycle, Q&A |
| Knowledge Base | 5 | Category tabs, switching, sweep button, items |
| Skills & MCP | 3 | Both sections render, skill opens modal |
| Dispatch Queue | 2 | Stats, active/pending |
| Engine Log | 2 | Renders, has content |
| Metrics | 2 | Content renders |
| Recent Completions | 2 | Section and items |
| Settings | 4 | Open modal, engine config, routing editor, save |
| Modal System | 7 | Hidden/visible, ESC, bg click, edit/save/cancel, Q&A |
| API Contracts | 11 | All endpoints, CORS, path traversal blocked |
| Work Item CRUD | 3 | Full lifecycle, retry, archive |
| Notes CRUD | 2 | Create/delete |
| Plan Flow | 3 | Create, pause, dashboard appearance |
| PRD Flow | 3 | Field shape, update item, remove item |
| Visual Baseline | 5 | No broken images, no JS errors, no NaN, no stuck loading |
| Keyboard Shortcuts | 3 | ESC panel, ESC modal, Ctrl+Enter |
