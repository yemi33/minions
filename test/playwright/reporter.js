/**
 * Custom summary reporter — prints a clean pass/fail summary and writes
 * test-results.json for regression tracking between runs.
 */

const fs = require('fs');
const path = require('path');

class SummaryReporter {
  constructor() {
    this.results = [];
    this.suites = {};
    this.start = Date.now();
  }

  onTestEnd(test, result) {
    const suite = test.titlePath().slice(1, -1).join(' > ') || 'Root';
    const entry = {
      suite,
      title: test.title,
      status: result.status,
      duration: result.duration,
      error: result.status === 'failed' ? (result.error?.message || '').split('\n')[0].slice(0, 200) : undefined,
    };
    this.results.push(entry);
    if (!this.suites[suite]) this.suites[suite] = [];
    this.suites[suite].push(entry);
  }

  onEnd(result) {
    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    const skipped = this.results.filter(r => r.status === 'skipped').length;
    const total = this.results.length;
    const duration = ((Date.now() - this.start) / 1000).toFixed(1);

    console.log('\n' + '═'.repeat(60));
    console.log('  MINIONS DASHBOARD — E2E TEST SUMMARY');
    console.log('═'.repeat(60));

    for (const [suite, tests] of Object.entries(this.suites)) {
      const suitePassed = tests.filter(t => t.status === 'passed').length;
      const suiteFailed = tests.filter(t => t.status === 'failed').length;
      const icon = suiteFailed > 0 ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m';
      console.log(`\n  ${icon} ${suite} (${suitePassed}/${tests.length})`);
      for (const t of tests) {
        const s = t.status === 'passed' ? '\x1b[32m  PASS\x1b[0m'
          : t.status === 'failed' ? '\x1b[31m  FAIL\x1b[0m'
          : '\x1b[33m  SKIP\x1b[0m';
        console.log(`    ${s} ${t.title}`);
        if (t.error) console.log(`         \x1b[31m→ ${t.error}\x1b[0m`);
      }
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`  \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m  (${total} total, ${duration}s)`);
    console.log('═'.repeat(60) + '\n');

    // Write last-run results
    const engineDir = path.join(__dirname, '..', '..', 'engine');
    const resultsPath = path.join(engineDir, 'test-results.json');
    const baselinePath = path.join(engineDir, 'test-baseline.json');

    const output = {
      timestamp: new Date().toISOString(),
      passed, failed, skipped, total,
      duration: parseFloat(duration),
      results: this.results,
    };

    // Regression check: compare against accepted baseline (not last run)
    const baseline = (() => { try { return JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { return null; } })();
    if (baseline && baseline.results) {
      const baselinePassed = new Set(baseline.results.filter(r => r.status === 'passed').map(r => `${r.suite} > ${r.title}`));
      const regressions = this.results.filter(r =>
        r.status === 'failed' && baselinePassed.has(`${r.suite} > ${r.title}`)
      );
      const newTests = this.results.filter(r => !baseline.results.some(b => b.suite === r.suite && b.title === r.title));

      if (regressions.length > 0) {
        console.log('\x1b[31m⚠ REGRESSIONS vs baseline:\x1b[0m');
        for (const r of regressions) console.log(`  - ${r.suite} > ${r.title}`);
        console.log('');
        output.regressions = regressions.map(r => `${r.suite} > ${r.title}`);
      } else {
        console.log('\x1b[32m✓ No regressions vs baseline.\x1b[0m');
      }
      if (newTests.length > 0) {
        console.log(`\x1b[36m  ${newTests.length} new test(s) not yet in baseline — run npm run test:e2e:accept to update.\x1b[0m`);
      }
      console.log('');
    } else {
      console.log('\x1b[33m  No baseline found — run npm run test:e2e:accept after a clean run to set one.\x1b[0m\n');
    }

    try { fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2)); } catch {}
  }
}

module.exports = SummaryReporter;
