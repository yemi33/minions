#!/usr/bin/env node
/**
 * Accepts the last test run as the new regression baseline.
 * Run this after adding new tests or new features to update the comparison point.
 *
 * Usage: npm run test:e2e:accept
 */
const fs = require('fs');
const path = require('path');

const engineDir = path.join(__dirname, '..', '..', 'engine');
const resultsPath = path.join(engineDir, 'test-results.json');
const baselinePath = path.join(engineDir, 'test-baseline.json');

if (!fs.existsSync(resultsPath)) {
  console.error('No test-results.json found. Run npm run test:e2e first.');
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const failed = results.results.filter(r => r.status === 'failed');

if (failed.length > 0) {
  console.log(`\x1b[33m⚠ Warning: ${failed.length} test(s) are failing in the last run:\x1b[0m`);
  for (const f of failed) console.log(`  - ${f.suite} > ${f.title}`);
  console.log('');
  const args = process.argv.slice(2);
  if (!args.includes('--force')) {
    console.log('Baseline not updated. Fix failing tests first, or use --force to accept anyway.');
    process.exit(1);
  }
  console.log('--force specified, accepting with failures.\n');
}

fs.writeFileSync(baselinePath, JSON.stringify({ ...results, acceptedAt: new Date().toISOString() }, null, 2));
console.log(`\x1b[32m✓ Baseline updated: ${results.passed} passing, ${results.failed} failing, ${results.skipped} skipped\x1b[0m`);
console.log(`  Saved to: ${baselinePath}`);
