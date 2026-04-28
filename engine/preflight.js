/**
 * engine/preflight.js — Prerequisite and health checks for Minions.
 * Used by `minions init`, `minions start`, and `minions doctor`.
 *
 * Per-runtime binary + model-discovery checks (P-9e8a3f1d) — for every distinct
 * CLI in use across `engine.defaultCli`, `engine.ccCli`, and `agents.<id>.cli`,
 * we resolve the adapter from the registry and run its `resolveBinary()`. The
 * cache is warmed via `listModels()` when the runtime supports discovery.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Resolve the Claude Code CLI binary path. Legacy helper preserved for back-
 * compat — the runtime registry's `resolveRuntime('claude').resolveBinary()`
 * is now the canonical resolver. This wrapper only exists so external tooling
 * that still calls `findClaudeBinary()` keeps working until cleanup ships.
 *
 * Returns the path if found, null otherwise.
 */
function findClaudeBinary() {
  const searchPaths = [
    // npm global (npm_config_prefix)
    process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js') : '',
    // Windows: %APPDATA%\npm
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js') : '',
    // Unix global
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    // Homebrew (macOS)
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    // nvm (current node version)
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    // fnm / volta — sibling to the node binary
    path.join(path.dirname(process.execPath), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ].filter(p => {
    if (!p) {
      if (process.env.MINIONS_DEBUG) console.log('[preflight] Dropped empty CLI search path entry');
      return false;
    }
    return true;
  });
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // Fallback: which/where → resolve wrapper to cli.js, or detect native binary
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where claude 2>NUL' : 'which claude 2>/dev/null';
    const which = execSync(cmd, { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim().split('\n')[0].trim();
    if (which) {
      const whichNative = isWin ? which : which.replace(/^\/([a-zA-Z])\//, (_, d) => d.toUpperCase() + ':/').replace(/\//g, path.sep);
      try {
        const resolved = fs.realpathSync(whichNative);
        if (resolved.endsWith('cli.js') && fs.existsSync(resolved)) return resolved;
      } catch {}
      try {
        const wrapper = fs.readFileSync(whichNative, 'utf8');
        const m = wrapper.match(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js/);
        if (m) {
          const candidate = path.join(path.dirname(whichNative), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch {
        // Can't read as text — it's a compiled native binary
      }
      // Native installer binary on PATH — use directly
      return whichNative;
    }
  } catch { /* optional */ }
  // Last resort: npm root -g
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const candidate = path.join(globalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* optional */ }
  return null;
}

// ─── Runtime fleet enumeration (P-9e8a3f1d) ─────────────────────────────────

/**
 * Collect the unique set of CLI runtimes that any part of the fleet would
 * spawn given a config. Mirrors the union scanned by
 * `shared.runtimeConfigWarnings` so unknown-CLI warnings and binary checks
 * always cover the same surface.
 *
 * Without a config (legacy callers), returns just `['claude']` — the
 * historical default.
 */
function _distinctRuntimes(config) {
  const set = new Set();
  if (!config || typeof config !== 'object') {
    set.add('claude');
    return Array.from(set);
  }
  const engine = config.engine || {};
  set.add(engine.defaultCli ? String(engine.defaultCli) : 'claude');
  if (engine.ccCli) set.add(String(engine.ccCli));
  for (const agent of Object.values(config.agents || {})) {
    if (agent && agent.cli) set.add(String(agent.cli));
  }
  return Array.from(set).sort();
}

/**
 * Try to resolve a runtime's binary via the registry. Returns a preflight
 * result entry — never throws. Unknown-runtime errors collapse to a single
 * warn entry so the rest of the loop keeps running.
 */
function _checkRuntimeBinary(runtimeName) {
  let adapter;
  try {
    adapter = require('./runtimes').resolveRuntime(runtimeName);
  } catch (e) {
    return {
      name: `Runtime: ${runtimeName}`,
      ok: false,
      message: `unknown runtime — ${e.message}`,
    };
  }
  let resolved = null;
  try { resolved = adapter.resolveBinary({ env: process.env }); }
  catch { /* defensive — treat any throw as "not found" so the loop keeps running */ }
  if (resolved && resolved.bin) {
    const shim = resolved.native === false ? ' (node shim)' : '';
    const lead = Array.isArray(resolved.leadingArgs) && resolved.leadingArgs.length
      ? ` (leadingArgs: ${resolved.leadingArgs.join(' ')})` : '';
    return {
      name: `Runtime: ${runtimeName}`,
      ok: true,
      message: `${resolved.bin}${shim}${lead}`,
    };
  }
  const hint = (typeof adapter.installHint === 'string' && adapter.installHint)
    ? adapter.installHint
    : `${runtimeName} CLI binary not found on PATH`;
  return {
    name: `Runtime: ${runtimeName}`,
    ok: false,
    message: `not found — ${hint}`,
  };
}

/**
 * Fire-and-forget cache warm. We never await: cache warming is a side effect
 * for the next dashboard / doctor read, not something runPreflight should
 * block on. Errors are swallowed — discovery is best-effort.
 *
 * Silent no-op when the runtime can't enumerate models (Claude has no public
 * mechanism, hence `capabilities.modelDiscovery: false`) or when the user
 * explicitly disabled discovery via `engine.disableModelDiscovery`. Those
 * branches live inside `model-discovery.getRuntimeModels`, so we just delegate.
 */
function _warmModelCache(runtimeName, config) {
  if (!runtimeName) return;
  let md;
  try { md = require('./model-discovery'); }
  catch { return; /* legacy installs may not have model-discovery yet */ }
  Promise.resolve()
    .then(() => md.getRuntimeModels(runtimeName, { config }))
    .catch(() => { /* swallow — best effort */ });
}

/**
 * Run prerequisite checks. Returns { passed, results } where results is an
 * array of { name, ok, message } objects.
 *
 * Options:
 *   - warnOnly: if true, missing items don't cause passed=false (for init)
 *   - verbose: include extra detail in messages
 *   - config:  fleet config for runtime checks + runtime-config warnings
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

  // 3. Per-runtime binary check (P-9e8a3f1d). Legacy single-runtime callers
  //    (no config passed) still get exactly one entry — for `claude` — so the
  //    historical "3 results" shape is preserved.
  const runtimes = _distinctRuntimes(opts.config);
  for (const runtimeName of runtimes) {
    const r = _checkRuntimeBinary(runtimeName);
    if (r.ok === false) allOk = false;
    results.push(r);
    // Warm the model cache in the background — silent no-op when the
    // runtime can't enumerate or the user disabled discovery.
    if (opts.config) _warmModelCache(runtimeName, opts.config);
  }

  // Auth is handled by each runtime CLI itself (Claude API key, GH_TOKEN for
  // Copilot, etc.) — preflight doesn't probe credentials.

  // 4. Runtime fleet config warnings (P-3b8e5f1d) — only when the caller hands
  //    us the config. checkOrExit() / cli start() / doctor() pass it; legacy
  //    callers don't, in which case we skip silently.
  if (opts && opts.config && typeof opts.config === 'object') {
    try {
      const shared = require('./shared');
      let runtimeNames = [];
      try { runtimeNames = require('./runtimes').listRuntimes(); }
      catch { /* registry may be missing during partial installs */ }
      const warns = shared.runtimeConfigWarnings(opts.config, runtimeNames);
      for (const w of warns) {
        results.push({ name: `Runtime config (${w.id})`, ok: 'warn', message: w.message });
      }
    } catch { /* defensive — preflight must never throw */ }
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
    const icon = r.ok === true ? '✓' : r.ok === 'warn' ? '!' : '✗';
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

// ─── Doctor extras (P-9e8a3f1d) ─────────────────────────────────────────────

const _FEATURE_FLAG_DEFAULTS = {
  claudeBareMode: false,
  claudeFallbackModel: undefined,
  copilotDisableBuiltinMcps: true,
  copilotSuppressAgentsMd: true,
  copilotStreamMode: 'on',
  copilotReasoningSummaries: false,
  maxBudgetUsd: undefined,
  disableModelDiscovery: false,
};

/**
 * Build the fleet-defaults summary entries surfaced by `minions doctor`.
 * Three classes of output:
 *   1. `Fleet` — `defaultCli` + `defaultModel`
 *   2. `CC overrides` — only when `ccCli` or `ccModel` is set
 *   3. `Active fleet flags` — only when any feature flag deviates from default
 */
function _fleetSummaryResults(config) {
  const results = [];
  if (!config || typeof config !== 'object') return results;
  const engine = config.engine || {};
  const defaultCli = engine.defaultCli ? String(engine.defaultCli) : 'claude';
  const defaultModel = engine.defaultModel ? String(engine.defaultModel) : '(runtime default)';
  results.push({ name: 'Fleet', ok: true, message: `defaultCli=${defaultCli}  defaultModel=${defaultModel}` });

  const ccBits = [];
  if (engine.ccCli) ccBits.push(`ccCli=${engine.ccCli}`);
  if (engine.ccModel) ccBits.push(`ccModel=${engine.ccModel}`);
  if (ccBits.length > 0) {
    results.push({ name: 'CC overrides', ok: true, message: ccBits.join('  ') });
  }

  const nonDefault = [];
  for (const [k, def] of Object.entries(_FEATURE_FLAG_DEFAULTS)) {
    if (engine[k] === undefined) continue;
    if (engine[k] !== def) nonDefault.push(`${k}=${JSON.stringify(engine[k])}`);
  }
  if (nonDefault.length > 0) {
    results.push({ name: 'Active fleet flags', ok: true, message: nonDefault.join('  ') });
  }
  return results;
}

/**
 * Build the per-runtime model-discovery entries surfaced by `minions doctor`.
 * Emits one entry per distinct runtime in the fleet:
 *   - "discovery disabled (engine.disableModelDiscovery)" — fleet-wide opt-out
 *   - "discovery unavailable (no enumeration mechanism)" — adapter doesn't support it
 *   - "<N> models cached" — listModels returned a non-empty array
 *   - "discovery unavailable (...)" — listModels returned null/threw (no token, transient API error)
 */
async function _modelDiscoveryResults(config) {
  const results = [];
  if (!config || typeof config !== 'object') return results;
  let md;
  try { md = require('./model-discovery'); } catch { return results; }
  let registry;
  try { registry = require('./runtimes'); } catch { return results; }
  const fleetDisabled = config.engine && config.engine.disableModelDiscovery === true;
  const runtimes = _distinctRuntimes(config);
  for (const runtimeName of runtimes) {
    let adapter;
    try { adapter = registry.resolveRuntime(runtimeName); }
    catch { continue; /* unknown-cli warning was already emitted by runtimeConfigWarnings */ }

    if (fleetDisabled) {
      results.push({ name: `Models: ${runtimeName}`, ok: 'warn', message: 'discovery disabled (engine.disableModelDiscovery)' });
      continue;
    }
    if (!adapter.capabilities || adapter.capabilities.modelDiscovery !== true) {
      results.push({ name: `Models: ${runtimeName}`, ok: 'warn', message: 'discovery unavailable (no enumeration mechanism)' });
      continue;
    }
    try {
      const out = await md.getRuntimeModels(runtimeName, { config });
      if (Array.isArray(out.models) && out.models.length > 0) {
        results.push({ name: `Models: ${runtimeName}`, ok: true, message: `${out.models.length} models cached` });
      } else {
        results.push({ name: `Models: ${runtimeName}`, ok: 'warn', message: 'discovery unavailable (API returned no models — check token)' });
      }
    } catch (e) {
      results.push({ name: `Models: ${runtimeName}`, ok: 'warn', message: `discovery error — ${e && e.message ? e.message : 'unknown'}` });
    }
  }
  return results;
}

/**
 * Run extended doctor checks (preflight + runtime health + fleet summary +
 * per-runtime model discovery).
 * Requires minionsHome path for runtime checks.
 */
function doctor(minionsHome) {
  // Read config first so preflight can include runtime-fleet warnings.
  const configPathForPreflight = path.join(minionsHome, 'config.json');
  let preflightConfig = null;
  try { preflightConfig = JSON.parse(fs.readFileSync(configPathForPreflight, 'utf8')); }
  catch { /* missing/invalid config is its own check below */ }
  const { passed, results } = runPreflight({ config: preflightConfig });

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

    // Check Teams integration — supports client secret OR certificate auth
    const teams = config.teams;
    if (teams && teams.enabled === true) {
      const hasSecret = !!teams.appId && !!teams.appPassword;
      const hasCert = !!teams.appId && !!teams.certPath && !!teams.privateKeyPath && !!teams.tenantId;
      if (!hasSecret && !hasCert) {
        const missing = [
          !teams.appId && 'appId',
          !teams.appPassword && !teams.certPath && 'appPassword or certPath+privateKeyPath+tenantId',
        ].filter(Boolean).join(', ');
        runtimeResults.push({ name: 'Teams integration', ok: 'warn', message: `enabled but missing: ${missing}` });
      } else {
        const authMode = hasCert ? 'certificate' : 'client secret';
        runtimeResults.push({ name: 'Teams integration', ok: true, message: `configured (${authMode})` });
      }
    } else {
      runtimeResults.push({ name: 'Teams integration', ok: 'warn', message: 'disabled — see docs/teams-setup.md' });
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
      } catch { /* process may be dead */ }
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

  return dashCheck.then(async dashResult => {
    runtimeResults.push(dashResult);

    // Check playbooks
    const playbooksDir = path.join(minionsHome, 'playbooks');
    let playbooks = [];
    try { playbooks = fs.readdirSync(playbooksDir).filter(f => f.endsWith('.md')); } catch { /* dir may not exist */ }
    if (playbooks.length > 0) {
      runtimeResults.push({ name: 'Playbooks', ok: true, message: `${playbooks.length} playbooks found` });
    } else {
      runtimeResults.push({ name: 'Playbooks', ok: false, message: 'no playbooks found in playbooks/ — run: minions init --force' });
    }

    // Check port 7331 availability (only if dashboard isn't running)
    if (dashResult.ok !== true) {
      runtimeResults.push({ name: 'Port 7331', ok: 'warn', message: 'dashboard not running — port status unknown' });
    }

    // Fleet defaults + per-runtime model discovery (P-9e8a3f1d). Both depend
    // on the config that we already loaded above; re-using `preflightConfig`
    // avoids a second JSON.parse round-trip.
    const fleetSummary = _fleetSummaryResults(preflightConfig);
    runtimeResults.push(...fleetSummary);
    const modelResults = await _modelDiscoveryResults(preflightConfig);
    runtimeResults.push(...modelResults);

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

module.exports = {
  findClaudeBinary,
  runPreflight,
  printPreflight,
  checkOrExit,
  doctor,
  // Exposed for unit tests (P-9e8a3f1d) — engine code MUST go through
  // runPreflight/doctor, never these helpers directly.
  _distinctRuntimes,
  _checkRuntimeBinary,
  _warmModelCache,
  _fleetSummaryResults,
  _modelDiscoveryResults,
};
