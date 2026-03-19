#!/usr/bin/env node
/**
 * Record dashboard demo as GIFs using Playwright video + ffmpeg.
 * Run: node test/record-demo.js
 */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:7331';
const OUT = path.join(__dirname, 'demo-screenshots');
const VIDS = path.join(__dirname, 'demo-videos-tmp');

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function recordGif(name, fn) {
  console.log(`  Recording: ${name}...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    recordVideo: { dir: VIDS, size: { width: 1400, height: 900 } }
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await delay(4000); // Wait for data load

  await fn(page);

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  // Convert webm to gif with ffmpeg
  const gifPath = path.join(OUT, `${name}.gif`);
  try {
    execSync(`ffmpeg -y -i "${videoPath}" -vf "fps=10,scale=1200:-1:flags=lanczos" -loop 0 "${gifPath}"`, {
      stdio: 'pipe', timeout: 60000, windowsHide: true
    });
    console.log(`    -> ${name}.gif (${Math.round(fs.statSync(gifPath).size / 1024)}KB)`);
  } catch (e) {
    console.log(`    -> ffmpeg failed: ${e.message.slice(0, 100)}`);
    // Fallback: save a screenshot instead
    const browser2 = await chromium.launch({ headless: true });
    const ctx2 = await browser2.newContext({ viewport: { width: 1400, height: 900 } });
    const pg2 = await ctx2.newPage();
    await pg2.goto(BASE);
    await delay(4000);
    await fn(pg2);
    await pg2.screenshot({ path: path.join(OUT, `${name}.png`) });
    await browser2.close();
  }
}

async function main() {
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (fs.existsSync(VIDS)) fs.rmSync(VIDS, { recursive: true });
  fs.mkdirSync(VIDS, { recursive: true });

  console.log('Recording dashboard demo GIFs...\n');

  // 1. Dashboard Overview — scroll through the page
  await recordGif('01-dashboard-overview', async (page) => {
    await delay(2000);
    await page.evaluate(() => window.scrollBy(0, 400));
    await delay(1500);
    await page.evaluate(() => window.scrollBy(0, 400));
    await delay(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(1000);
  });

  // 2. Command Center — type a plan request
  await recordGif('02-command-center', async (page) => {
    const input = await page.$('#cmd-input');
    if (input) {
      await input.click();
      await delay(500);
      await page.keyboard.type('Create a plan to add user authentication with OAuth2', { delay: 40 });
      await delay(2000);
      // Clear and type a work item
      await input.fill('');
      await delay(300);
      await page.keyboard.type('Fix the login page CSS on mobile', { delay: 40 });
      await delay(1500);
      await input.fill('');
    }
    await delay(500);
  });

  // 3. Work Items — scroll to table, hover over items
  await recordGif('03-work-items', async (page) => {
    const wi = await page.$('text=WORK ITEMS');
    if (wi) await wi.scrollIntoViewIfNeeded();
    await delay(1500);
    // Hover over retry button
    const retry = await page.$('text=Retry');
    if (retry) {
      await retry.hover();
      await delay(1500);
    }
    await delay(1000);
  });

  // 4. Plans & Doc Chat — open plan, show modal
  await recordGif('04-plan-docchat', async (page) => {
    const plans = await page.$('text=PLANS');
    if (plans) await plans.scrollIntoViewIfNeeded();
    await delay(1000);
    const card = await page.$('.plan-card');
    if (card) {
      await card.click();
      await delay(2500);
      // Type in doc chat
      const docInput = await page.$('input[placeholder*="Ask about"], textarea[placeholder*="Ask about"]');
      if (docInput) {
        await docInput.click();
        await page.keyboard.type('What are the security implications?', { delay: 40 });
        await delay(2000);
      }
      await page.keyboard.press('Escape');
      await delay(500);
    }
  });

  // 5. PRD Progress — show dependency graph
  await recordGif('05-prd-progress', async (page) => {
    const prd = await page.$('text=PRD');
    if (prd) await prd.scrollIntoViewIfNeeded();
    await delay(2000);
    // Scroll slightly to show full PRD section
    await page.evaluate(() => window.scrollBy(0, 200));
    await delay(2000);
  });

  // 6. Inbox & Metrics
  await recordGif('06-inbox-metrics', async (page) => {
    const inbox = await page.$('text=INBOX');
    if (inbox) await inbox.scrollIntoViewIfNeeded();
    await delay(2000);
    const dispatch = await page.$('text=DISPATCH');
    if (dispatch) await dispatch.scrollIntoViewIfNeeded();
    await delay(1500);
    const metrics = await page.$('text=METRICS');
    if (metrics) await metrics.scrollIntoViewIfNeeded();
    await delay(1500);
  });

  // Cleanup temp videos
  try { fs.rmSync(VIDS, { recursive: true }); } catch {}

  const files = fs.readdirSync(OUT).sort();
  console.log(`\nDone! ${files.length} files saved to test/demo-screenshots/:`);
  for (const f of files) {
    const kb = Math.round(fs.statSync(path.join(OUT, f)).size / 1024);
    console.log(`  ${f} (${kb}KB)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
