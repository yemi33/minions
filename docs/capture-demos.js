#!/usr/bin/env node
/**
 * Capture dashboard screenshots for GitHub Pages.
 * Seeds demo data, captures all pages, then cleans up.
 *
 * Run: node docs/capture-demos.js
 * Requires: dashboard running on :7331, playwright chromium installed
 */
const { chromium } = require('@playwright/test');
const { execSync } = require('child_process');
const path = require('path');

const DEMO_DIR = path.join(__dirname, 'demo');
const BASE = 'http://localhost:7331';
const ROOT = path.resolve(__dirname, '..');

async function capture() {
  // Seed demo data
  console.log('  Seeding demo data...');
  execSync(`node "${path.join(ROOT, 'test', 'seed-demo-data.js')}"`, { stdio: 'inherit' });

  // Wait for dashboard to pick up seeded data
  await new Promise(r => setTimeout(r, 5000));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // 1. Home / Overview (agents should show as working from seeded dispatches)
    console.log('  Capturing: home');
    await page.screenshot({ path: path.join(DEMO_DIR, '01-dashboard-overview.png'), fullPage: false });

    // 2. Work Items
    console.log('  Capturing: work items');
    await page.click('a[data-page="work"]');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(DEMO_DIR, '02-work-items.png'), fullPage: false });

    // 3. Plans & PRD (seeded PRD with dependency graph)
    console.log('  Capturing: plans & PRD');
    await page.click('a[data-page="plans"]');
    await page.waitForTimeout(2000);
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

    // 10. Command Center with mock conversation
    console.log('  Capturing: command center');
    await page.click('#cc-toggle-btn');
    await page.waitForTimeout(500);

    // Inject mock CC messages into the DOM for the screenshot
    await page.evaluate(() => {
      const el = document.getElementById('cc-messages');
      if (!el) return;
      el.innerHTML = '';

      function addMsg(role, html) {
        const div = document.createElement('div');
        div.className = 'cc-msg cc-msg-' + role;
        div.innerHTML = html;
        el.appendChild(div);
      }

      addMsg('user', 'Create a plan to add OAuth2 authentication to OfficeAgent with JWT tokens and role-based access control.');

      addMsg('assistant', '<div class="md-content">' +
        '<p>I\'ll create a plan for OAuth2 authentication with RBAC. Let me check the current auth setup first.</p>' +
        '<p>After reviewing the codebase, here\'s what I\'m dispatching:</p>' +
        '<ul>' +
        '<li><strong>Plan created:</strong> <code>auth-plan.md</code> with 5 features (OAuth2, RBAC, rate limiting, sessions, audit logging)</li>' +
        '<li><strong>Dispatched to Lambert</strong> for PRD generation</li>' +
        '</ul>' +
        '<p>The plan is now in <strong>Plans &amp; PRD</strong> awaiting your approval. Once approved, Dallas and Rebecca will start implementing in parallel.</p>' +
        '</div>' +
        '<div style="margin-top:8px;padding:6px 10px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.2);border-radius:6px;font-size:11px;color:var(--green)">' +
        '&#x2713; Created plan: auth-plan.md &nbsp; &#x2713; Dispatched: Lambert &rarr; plan-to-prd</div>');

      addMsg('user', 'What\'s the status of the auth implementation?');

      addMsg('assistant', '<div class="md-content">' +
        '<p>Here\'s the current status:</p>' +
        '<table style="width:100%;font-size:12px">' +
        '<tr><td style="color:var(--green)">&#x2713; Done</td><td>OAuth2 Middleware</td><td style="color:var(--muted)">Dallas &mdash; PR-4520 merged</td></tr>' +
        '<tr><td style="color:var(--green)">&#x2713; Done</td><td>Role-Based Access Control</td><td style="color:var(--muted)">Rebecca &mdash; PR-4521 in review</td></tr>' +
        '<tr><td style="color:var(--blue)">&#x25CB; Active</td><td>API Rate Limiting</td><td style="color:var(--muted)">Dallas &mdash; working now</td></tr>' +
        '<tr><td style="color:var(--blue)">&#x25CB; Active</td><td>Session Management</td><td style="color:var(--muted)">Rebecca &mdash; working now</td></tr>' +
        '<tr><td style="color:var(--muted)">&#x25CB; Pending</td><td>Audit Logging</td><td style="color:var(--muted)">Blocked on RBAC</td></tr>' +
        '</table>' +
        '<p><strong>2/5 done, 2 active, 1 pending.</strong> On track for completion today.</p>' +
        '</div>');

      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(DEMO_DIR, '10-command-center.png'), fullPage: false });

  } finally {
    await browser.close();

    // Clean up demo data
    console.log('  Cleaning demo data...');
    execSync(`node "${path.join(ROOT, 'test', 'seed-demo-data.js')}" --clean`, { stdio: 'inherit' });
  }

  console.log('\n  Done! Screenshots saved to docs/demo/');
}

capture().catch(e => { console.error(e); process.exit(1); });
