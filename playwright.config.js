const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/playwright',
  timeout: 20000,
  retries: 1,
  workers: 1, // Sequential — avoids state conflicts on shared dashboard
  reporter: [
    ['list'],
    ['html', { outputFolder: 'test/playwright/report', open: 'never' }],
    ['./test/playwright/reporter.js'],
  ],
  use: {
    baseURL: 'http://localhost:7331',
    headless: true,
    screenshot: 'only-on-failure',   // screenshot on every failure
    video: 'retain-on-failure',       // video for failed tests only (saves disk)
    trace: 'retain-on-failure',       // trace (time-travel debugger) for failures
    actionTimeout: 8000,
    navigationTimeout: 10000,
  },
});
