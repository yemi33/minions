/**
 * engine/preflight.js — Prerequisite and health checks for Minions.
 * Used by `minions init`, `minions start`, and `minions doctor`.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Resolve the Claude Code CLI binary path.
 * Returns the path if found, null otherwise.
 * Reuses the same search logic as spawn-agent.js.
 */
function findClaudeBinary() {
  const searchPaths = [
    path.join(process.env.npm_config_prefix || '', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ];
  for (const p of searchPaths) {
    if (p && fs.existsSync(p)) return p;
  }
  // Fallback: parse the shell wrapper
  try {
    const which = execSync('bash -c "which claude"', { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const wrapper = execSync(`bash -c "cat '${which}'"`, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = wrapper.match(/node_modules\/@anthropic-ai\/claude-code\/cli\.js/);
    if (m) {
      const basedir = path.dirname(which.replace(/^\/c\//, 'C:/').replace(/\//g, path.sep));
      const resolved = path.join(basedir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {}
  return null;
}

/**
 * Run prerequisite checks. Returns { passed, results } where results is an
 * array of { name, ok, message } objects.
 *
 * Options:
 *   - warnOnly: if true, missing items don't cause passed=false (for init)
 *   - verbose: include extra detail in messages
 */
function runPreflight(opts = {}) {
  const results = [];
  let allOk = true;

  // 1. Node.js version >= 18
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0], 10);
  if (major >= 18) {
    results.push({ name: 'Node.js', ok: true, message: `v${nodeVersion}` });
  } else {
    results.push({ name: 'Node.js', ok: false, message: `v${nodeVersion} — requires >= 18. Upgrade at https://nodejs.org` });
    allOk = false;
  }

  // 2. Git available
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    results.push({ name: 'Git', ok: true, message: gitVersion.replace('git version ', 'v') });
  } catch {
    results.push({ name: 'Git', ok: false, message: 'not found — install from https://git-scm.com' });
    allOk = false;
  }

  // 3. Claude Code CLI
  const claudeBin = findClaudeBinary();
  if (claudeBin) {
    results.push({ name: 'Claude Code CLI', ok: true, message: path.basename(path.dirname(path.dirname(claudeBin))) });
  } else {
    results.push({ name: 'Claude Code CLI', ok: false, message: 'not found — install with: npm install -g @anthropic-ai/claude-code' });
    allOk = false;
  }

  // 4. Anthropic API key or Claude Max (best-effort warning)
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  if (hasApiKey) {
    results.push({ name: 'Anthropic auth', ok: true, message: 'ANTHROPIC_API_KEY set' });
  } else {
    // Not fatal — user may have Claude Max subscription
    results.push({ name: 'Anthropic auth', ok: 'warn', message: 'ANTHROPIC_API_KEY not set — agents need an API key or Claude Max subscription' });
  }

  return { passed: allOk, results };
}

/**
 * Print preflight results to console. Returns true if all critical checks passed.
 */
function printPreflight(results, { label = 'Preflight checks' } = {}) {
  console.log(`\n  ${label}:\n`);
  let allOk = true;
  for (const r of results) {
    const icon = r.ok === true ? '\u2713' : r.ok === 'warn' ? '!' : '\u2717';
    const prefix = r.ok === true ? '  ' : r.ok === 'warn' ? '  ' : '  ';
    console.log(`${prefix} ${icon} ${r.name}: ${r.message}`);
    if (r.ok === false) allOk = false;
  }
  console.log('');
  return allOk;
}

/**
 * Run preflight and print results. Exits with code 1 if fatal checks fail
 * and exitOnFail is true.
 */
function checkOrExit({ exitOnFail = false, label = 'Preflight checks' } = {}) {
  const { passed, results } = runPreflight();
  const ok = printPreflight(results, { label });
  if (!ok && exitOnFail) {
    console.error('  Fix the issues above before continuing.\n');
    process.exit(1);
  }
  return ok;
}

/**
 * Run extended doctor checks (preflight + runtime health).
 * Requires minionsHome path for runtime checks.
 */
function doctor(minionsHome) {
  const { passed, results } = runPreflight();

  // Runtime checks
  const runtimeResults = [];

  // Check if minions is installed
  const engineJs = path.join(minionsHome, 'engine.js');
  if (fs.existsSync(engineJs)) {
    runtimeResults.push({ name: 'Minions installed', ok: true, message: minionsHome });
  } else {
    runtimeResults.push({ name: 'Minions installed', ok: false, message: `not found at ${minionsHome} — run: minions init` });
  }

  // Check config.json
  const configPath = path.join(minionsHome, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const projects = config.projects || [];
    const real = projects.filter(p => p.name && !p.name.startsWith('YOUR_'));
    if (real.length > 0) {
      runtimeResults.push({ name: 'Projects configured', ok: true, message: `${real.length} project(s)` });
    } else {
      runtimeResults.push({ name: 'Projects configured', ok: false, message: 'no projects — run: minions add <dir>' });
    }

    // Check project paths exist
    for (const p of real) {
      if (p.localPath && !fs.existsSync(p.localPath)) {
        runtimeResults.push({ name: `Project "${p.name}"`, ok: false, message: `path not found: ${p.localPath}` });
      }
    }

    // Check agents
    const agents = config.agents || {};
    if (Object.keys(agents).length > 0) {
      runtimeResults.push({ name: 'Agents configured', ok: true, message: `${Object.keys(agents).length} agent(s)` });
    } else {
      runtimeResults.push({ name: 'Agents configured', ok: false, message: 'no agents in config.json' });
    }
  } catch {
    runtimeResults.push({ name: 'Config', ok: false, message: `missing or invalid — run: minions init` });
  }

  // Check engine status
  const controlPath = path.join(minionsHome, 'engine', 'control.json');
  try {
    const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    if (control.state === 'running' && control.pid) {
      let alive = false;
      try {
        if (process.platform === 'win32') {
          const out = execSync(`tasklist /FI "PID eq ${control.pid}" /NH`, { encoding: 'utf8', windowsHide: true, timeout: 3000 });
          alive = out.includes(String(control.pid)) && out.toLowerCase().includes('node');
        } else {
          process.kill(control.pid, 0);
          alive = true;
        }
      } catch {}
      runtimeResults.push({ name: 'Engine', ok: alive, message: alive ? `running (PID ${control.pid})` : `stale PID ${control.pid} — run: minions start` });
    } else {
      runtimeResults.push({ name: 'Engine', ok: 'warn', message: `${control.state || 'stopped'} — run: minions start` });
    }
  } catch {
    runtimeResults.push({ name: 'Engine', ok: 'warn', message: 'not started — run: minions start' });
  }

  // Check dashboard (try HTTP)
  const http = require('http');
  const dashCheck = new Promise(resolve => {
    const req = http.get('http://localhost:7331/api/health', { timeout: 2000 }, res => {
      resolve({ name: 'Dashboard', ok: true, message: 'running on http://localhost:7331' });
    });
    req.on('error', () => resolve({ name: 'Dashboard', ok: 'warn', message: 'not reachable on :7331 — run: minions dash' }));
    req.on('timeout', () => { req.destroy(); resolve({ name: 'Dashboard', ok: 'warn', message: 'not reachable on :7331 — run: minions dash' }); });
  });

  return dashCheck.then(dashResult => {
    runtimeResults.push(dashResult);

    // Check playbooks
    const playbooksDir = path.join(minionsHome, 'playbooks');
    const required = ['implement.md', 'review.md', 'fix.md'];
    const missing = required.filter(f => !fs.existsSync(path.join(playbooksDir, f)));
    if (missing.length === 0) {
      runtimeResults.push({ name: 'Playbooks', ok: true, message: `${required.length} required playbooks present` });
    } else {
      runtimeResults.push({ name: 'Playbooks', ok: false, message: `missing: ${missing.join(', ')} — run: minions init --force` });
    }

    // Check port 7331 availability (only if dashboard isn't running)
    if (dashResult.ok !== true) {
      // Dashboard isn't running, port should be free
      runtimeResults.push({ name: 'Port 7331', ok: 'warn', message: 'dashboard not running — port status unknown' });
    }

    // Print all
    const allResults = [...results, ...runtimeResults];
    const ok = printPreflight(allResults, { label: 'Minions Doctor' });

    const criticalFails = allResults.filter(r => r.ok === false).length;
    const warnings = allResults.filter(r => r.ok === 'warn').length;
    if (criticalFails === 0 && warnings === 0) {
      console.log('  All checks passed.\n');
    } else if (criticalFails === 0) {
      console.log(`  ${warnings} warning(s), no critical issues.\n`);
    } else {
      console.log(`  ${criticalFails} issue(s) to fix, ${warnings} warning(s).\n`);
    }

    return ok;
  });
}

module.exports = { findClaudeBinary, runPreflight, printPreflight, checkOrExit, doctor };
