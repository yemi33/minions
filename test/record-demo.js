#!/usr/bin/env node
/**
 * Record dashboard demo screenshots using Playwright.
 * Run: node test/record-demo.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:7331';
const OUT = path.join(__dirname, 'demo-screenshots');

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
let shotNum = 0;
async function shot(page, name, opts = {}) {
  shotNum++;
  const filename = `${String(shotNum).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, filename), fullPage: opts.fullPage || false });
  console.log(`  [${shotNum}] ${filename}`);
}

async function main() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Navigating to dashboard...');
  await page.goto(BASE);
  await delay(5000);

  // ── Scenario 5: Dashboard Overview ──────────────────────────────────
  console.log('\n--- Scenario 5: Dashboard Overview ---');
  await shot(page, 'dashboard-overview');

  await page.evaluate(() => window.scrollBy(0, 500));
  await delay(500);
  await shot(page, 'dashboard-workitems-prd');

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(500);
  await shot(page, 'dashboard-bottom');

  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(300);

  // ── Scenario 1: Command Center ──────────────────────────────────────
  console.log('\n--- Scenario 1: Command Center ---');
  // CC input is directly visible on the page
  const ccInput = await page.$('#cmd-input');
  if (ccInput) {
    await ccInput.click();
    await delay(300);
    await ccInput.fill('Create a plan to add user authentication with OAuth2 and role-based access control');
    await delay(500);
    await shot(page, 'cc-plan-request');
    await ccInput.fill('');
    await delay(200);

    // Show different CC commands
    await ccInput.fill('Fix the login page CSS on mobile devices');
    await delay(500);
    await shot(page, 'cc-work-item');
    await ccInput.fill('');
  } else {
    console.log('  CC input not found');
  }

  // ── Scenario 2: Work Items ──────────────────────────────────────────
  console.log('\n--- Scenario 2: Work Items ---');
  // Scroll to work items
  const wiHeader = await page.$('text=WORK ITEMS');
  if (wiHeader) {
    await wiHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'work-items-table');

    // Click retry on the failed item
    const retryBtn = await page.$('text=Retry');
    if (retryBtn) {
      await shot(page, 'work-item-retry-button');
    }
  }

  // ── Scenario 4: Plans & PRD ─────────────────────────────────────────
  console.log('\n--- Scenario 4: Plans & PRD ---');
  // Scroll to plans section
  const plansHeader = await page.$('text=PLANS');
  if (plansHeader) {
    await plansHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'plans-section');

    // Click on the plan card
    const planCard = await page.$('.plan-card');
    if (planCard) {
      await planCard.click();
      await delay(2000);
      await shot(page, 'plan-detail-modal');

      // Close modal
      try { await page.keyboard.press('Escape'); } catch {}
      await delay(500);
    }
  }

  // PRD section
  const prdHeader = await page.$('text=PRD');
  if (prdHeader) {
    await prdHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'prd-progress');
  }

  // ── Scenario 7: Knowledge Base & Inbox ──────────────────────────────
  console.log('\n--- Scenario 7: Knowledge Base & Inbox ---');
  // Find inbox section
  const inboxHeader = await page.$('text=INBOX');
  if (inboxHeader) {
    await inboxHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'inbox-section');
  }

  // Find dispatch queue
  const dispHeader = await page.$('text=DISPATCH');
  if (dispHeader) {
    await dispHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'dispatch-queue');
  }

  // Find metrics
  const metricsHeader = await page.$('text=METRICS');
  if (metricsHeader) {
    await metricsHeader.scrollIntoViewIfNeeded();
    await delay(500);
    await shot(page, 'agent-metrics');
  }

  // ── Full page ───────────────────────────────────────────────────────
  console.log('\n--- Full Page ---');
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(300);
  await shot(page, 'full-page', { fullPage: true });

  await browser.close();

  // Summary
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
  console.log(`\nDone! ${files.length} screenshots saved to test/demo-screenshots/`);
  for (const f of files) {
    const kb = Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    console.log(`  ${f} (${kb}KB)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
