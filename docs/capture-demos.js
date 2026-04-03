#!/usr/bin/env node
/**
 * Capture dashboard screenshots for GitHub Pages.
 * Run: npx playwright test docs/capture-demos.js (or node docs/capture-demos.js)
 */
const { chromium } = require('@playwright/test');
const path = require('path');

const DEMO_DIR = path.join(__dirname, 'demo');
const BASE = 'http://localhost:7331';

async function capture() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();

  // Wait for dashboard to load
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 1. Home / Overview
  console.log('  Capturing: home');
  await page.screenshot({ path: path.join(DEMO_DIR, '01-dashboard-overview.png'), fullPage: false });

  // 2. Work Items
  console.log('  Capturing: work items');
  await page.click('a[data-page="work"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '02-work-items.png'), fullPage: false });

  // 3. Plans & PRD
  console.log('  Capturing: plans & PRD');
  await page.click('a[data-page="plans"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '03-plans-prd.png'), fullPage: false });

  // 4. Pull Requests
  console.log('  Capturing: pull requests');
  await page.click('a[data-page="prs"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '04-pull-requests.png'), fullPage: false });

  // 5. Meetings
  console.log('  Capturing: meetings');
  await page.click('a[data-page="meetings"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '05-meetings.png'), fullPage: false });

  // 6. Pipelines
  console.log('  Capturing: pipelines');
  await page.click('a[data-page="pipelines"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '06-pipelines.png'), fullPage: false });

  // 7. Notes & KB
  console.log('  Capturing: notes & KB');
  await page.click('a[data-page="inbox"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '07-notes-kb.png'), fullPage: false });

  // 8. Schedules
  console.log('  Capturing: schedules');
  await page.click('a[data-page="schedule"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '08-schedules.png'), fullPage: false });

  // 9. Engine page (dispatch, log, metrics)
  console.log('  Capturing: engine');
  await page.click('a[data-page="engine"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DEMO_DIR, '09-engine.png'), fullPage: false });

  // 10. Command Center
  console.log('  Capturing: command center');
  await page.click('#cc-toggle-btn');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(DEMO_DIR, '10-command-center.png'), fullPage: false });

  await browser.close();
  console.log('\n  Done! Screenshots saved to docs/demo/');
}

capture().catch(e => { console.error(e); process.exit(1); });
