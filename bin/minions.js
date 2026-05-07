#!/usr/bin/env node
/**
 * Minions CLI — Central AI dev team manager
 *
 * Usage:
 *   minions init [--skip-scan]       Bootstrap ~/.minions/ with default config and agents
 *   minions init --force             Update engine code + add new files (preserves config & customizations)
 *   minions add <project-dir>        Link a project (interactive)
 *   minions remove <project-dir>     Unlink a project
 *   minions list                     List linked projects
 *   minions start                    Start the engine
 *   minions stop                     Stop the engine
 *   minions status                   Show engine status
 *   minions pause / resume           Pause/resume dispatching
 *   minions dash                     Start the dashboard
 *   minions work <title> [opts-json] Add a work item
 *   minions spawn <agent> <prompt>   Manually spawn an agent
 *   minions dispatch                 Force a dispatch cycle
 *   minions discover                 Dry-run work discovery
 *   minions cleanup                  Run cleanup manually
 *   minions plan <file|text> [proj]  Run a plan
 *   minions version                  Show installed and package versions
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const DASH_PORT = 7331;

/** Returns PIDs (as strings) of processes LISTENING on `port`. Empty on no match
 *  or when the platform tool (netstat/findstr/lsof) is unavailable. */
function getListeningPids(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port} " | findstr LISTENING`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid) && pid !== '0' && pid !== String(process.pid)) pids.add(pid);
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti:${port}`, { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Kill process(es) listening on a given port. Works cross-platform. */
function killByPort(port) {
  const pids = getListeningPids(port);
  if (process.platform === 'win32') {
    for (const pid of pids) try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000, windowsHide: true }); } catch {}
  } else {
    for (const pid of pids) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  }
}

const isPortListening = (port) => getListeningPids(port).length > 0;

/**
 * Read the engine's recorded PID from engine/control.json. Returns null if
 * the file is missing/corrupt or the PID isn't a positive integer.
 */
function readEnginePid(minionsHome) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(minionsHome, 'engine', 'control.json'), 'utf8'));
    const pid = Number(data && data.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/**
 * Force-kill a single process by PID — does NOT recurse into children.
 * This preserves the engine→agent invariant: agents are independent processes
 * spawned as children of the engine, but they must survive engine restarts so
 * they can be re-attached on next start (CLAUDE.md timeouts/liveness section).
 * Tree-kill (`taskkill /T`, `pgrep -P` walk) would orphan in-flight work.
 */
function killPidOnly(pid) {
  if (!pid || pid === process.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

/** Kill minions processes by command-line pattern matching (wmic on Windows, pkill on Unix). */
function killMinionsProcesses(patterns) {
  try {
    if (process.platform === 'win32') {
      // Use PowerShell Get-CimInstance (works on Win11 where wmic is removed)
      let out;
      try {
        out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"', { encoding: 'utf8', timeout: 10000, windowsHide: true });
      } catch {
        // Fallback to wmic for older Windows
        try { out = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8', timeout: 10000, windowsHide: true }); } catch { return; }
      }
      for (const line of out.split('\n')) {
        if (patterns.some(p => line.includes(p))) {
          const pidMatch = line.match(/(\d{2,})/);
          const pid = pidMatch ? pidMatch[1] : null;
          if (pid && pid !== String(process.pid)) try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000, windowsHide: true }); } catch {}
        }
      }
    } else {
      for (const p of patterns) {
        try { execSync(`pkill -f "${p}" 2>/dev/null`, { timeout: 5000 }); } catch {}
      }
    }
  } catch {}
}

/** Spawn a detached dashboard. When `suppressOpen` is true, the new dashboard
 *  skips its auto-open of the browser — the existing tab will SSE-reconnect. */
function spawnDashboard(suppressOpen) {
  const env = suppressOpen ? { ...process.env, MINIONS_NO_AUTO_OPEN: '1' } : process.env;
  const proc = spawn(process.execPath, [path.join(MINIONS_HOME, 'dashboard.js')], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true, env
  });
  proc.unref();
  return proc;
}

const DEFAULT_MINIONS_HOME = path.join(os.homedir(), '.minions');
const ROOT_POINTER_PATH = path.join(os.homedir(), '.minions-root');
const LEGACY_DEFAULT_SQUAD_HOME = path.join(os.homedir(), '.squad');
const LEGACY_ROOT_POINTER_PATH = path.join(os.homedir(), '.squad-root');

function isInstalledRoot(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'engine.js')) &&
    fs.existsSync(path.join(dir, 'dashboard.js')) &&
    fs.existsSync(path.join(dir, 'minions.js'));
}

function isLegacyInstalledRoot(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'engine.js')) &&
    fs.existsSync(path.join(dir, 'dashboard.js')) &&
    fs.existsSync(path.join(dir, 'squad.js'));
}

function readRootPointer() {
  try {
    const p = fs.readFileSync(ROOT_POINTER_PATH, 'utf8').trim();
    return p ? path.resolve(p) : null;
  } catch { return null; }
}

function readLegacyRootPointer() {
  try {
    const p = fs.readFileSync(LEGACY_ROOT_POINTER_PATH, 'utf8').trim();
    return p ? path.resolve(p) : null;
  } catch { return null; }
}

function saveRootPointer(root) {
  try { fs.writeFileSync(ROOT_POINTER_PATH, root); } catch {}
}

function findLegacySquadRoot() {
  const candidates = [
    process.env.SQUAD_HOME ? path.resolve(process.env.SQUAD_HOME) : null,
    path.join(process.cwd(), '.squad'),
    readLegacyRootPointer(),
    LEGACY_DEFAULT_SQUAD_HOME,
  ].filter(Boolean);
  for (const c of candidates) {
    if (isLegacyInstalledRoot(c) || isInstalledRoot(c)) return c;
  }
  return null;
}

function copyLegacyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyLegacyTree(srcPath, destPath);
      continue;
    }
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function migrateLegacyInstallIfNeeded(targetHome) {
  if (isInstalledRoot(targetHome)) return null;
  const legacyRoot = findLegacySquadRoot();
  if (!legacyRoot) return null;
  const src = path.resolve(legacyRoot);
  const dest = path.resolve(targetHome);
  if (src === dest) return null;

  const targetHasFiles = fs.existsSync(dest) && fs.readdirSync(dest).length > 0;
  if (targetHasFiles && !isInstalledRoot(dest)) return null;

  copyLegacyTree(src, dest);

  const legacyCli = path.join(dest, 'squad.js');
  const newCli = path.join(dest, 'minions.js');
  if (fs.existsSync(legacyCli) && !fs.existsSync(newCli)) fs.renameSync(legacyCli, newCli);

  const legacyBin = path.join(dest, 'bin', 'squad.js');
  const newBin = path.join(dest, 'bin', 'minions.js');
  if (fs.existsSync(legacyBin) && !fs.existsSync(newBin)) fs.renameSync(legacyBin, newBin);

  const legacyVersion = path.join(dest, '.squad-version');
  const newVersion = path.join(dest, '.minions-version');
  if (fs.existsSync(legacyVersion) && !fs.existsSync(newVersion)) fs.renameSync(legacyVersion, newVersion);

  saveRootPointer(dest);
  try { if (fs.existsSync(LEGACY_ROOT_POINTER_PATH)) fs.unlinkSync(LEGACY_ROOT_POINTER_PATH); } catch {}

  const migrationLog = path.join(dest, 'migration.log');
  const line = `${new Date().toISOString()} migrated legacy install ${src} -> ${dest}\n`;
  try { fs.appendFileSync(migrationLog, line); } catch {}

  return { from: src, to: dest };
}

function resolveMinionsHome(forInit = false) {
  const envHome = process.env.MINIONS_HOME ? path.resolve(process.env.MINIONS_HOME) : null;
  if (envHome) return envHome;

  if (forInit) return DEFAULT_MINIONS_HOME;

  const pointerRoot = readRootPointer();
  if (isInstalledRoot(pointerRoot)) return pointerRoot;

  if (isInstalledRoot(DEFAULT_MINIONS_HOME)) return DEFAULT_MINIONS_HOME;

  return DEFAULT_MINIONS_HOME;
}

const [cmd, ...rest] = process.argv.slice(2);
let force = rest.includes('--force');
const skipScan = rest.includes('--skip-scan');
const skipStart = rest.includes('--skip-start') || rest.includes('--no-start');
const MINIONS_HOME = resolveMinionsHome(cmd === 'init');
process.env.MINIONS_HOME = MINIONS_HOME;
const POST_UPDATE_INIT_TIMEOUT_MS = 120000;
const POST_UPDATE_RESTART_TIMEOUT_MS = 60000;

function isSubpath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ─── Version tracking ───────────────────────────────────────────────────────

function getPkgVersion() {
  try { return require(path.join(PKG_ROOT, 'package.json')).version; } catch { return '0.0.0'; }
}

function getInstalledVersion() {
  try {
    const vFile = path.join(MINIONS_HOME, '.minions-version');
    return fs.readFileSync(vFile, 'utf8').trim();
  } catch { return null; }
}

function saveInstalledVersion(version) {
  fs.writeFileSync(path.join(MINIONS_HOME, '.minions-version'), version);
  // Persist source commit so dashboard can detect repo-based installs
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: PKG_ROOT, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (commit) fs.writeFileSync(path.join(MINIONS_HOME, '.minions-commit'), commit);
  } catch {}
}

// ─── Init / Upgrade ─────────────────────────────────────────────────────────

function init() {
  // Safety guard: avoid recursive copy if user HOME is inside package root.
  // This can happen in tests or unusual shell setups.
  if (isSubpath(PKG_ROOT, MINIONS_HOME)) {
    console.error(`\n  ERROR: Refusing to initialize Minions home inside package directory.`);
    console.error(`  Package root: ${PKG_ROOT}`);
    console.error(`  Minions home:   ${MINIONS_HOME}`);
    console.error('  Set HOME/USERPROFILE to a location outside this repo and run `minions init` again.\n');
    process.exit(1);
  }

  const migration = migrateLegacyInstallIfNeeded(MINIONS_HOME);
  if (migration) {
    console.log(`\n  Migrated legacy Squad install:`);
    console.log(`  ${migration.from} → ${migration.to}`);
  }

  const isUpgrade = fs.existsSync(path.join(MINIONS_HOME, 'engine.js'));
  const pkgVersion = getPkgVersion();
  const installedVersion = getInstalledVersion();

  if (isUpgrade && !force && !migration) {
    console.log(`\n  Minions is installed at ${MINIONS_HOME}`);
    if (installedVersion) console.log(`  Installed version: ${installedVersion}`);
    console.log(`  Package version:   ${pkgVersion}`);
    console.log('\n  To upgrade: minions init --force\n');
    return;
  }

  if (isUpgrade) {
    console.log(`\n  Upgrading Minions at ${MINIONS_HOME}`);
    if (installedVersion) console.log(`  ${installedVersion} → ${pkgVersion}`);
    else console.log(`  → ${pkgVersion}`);
  } else {
    console.log(`\n  Bootstrapping Minions to ${MINIONS_HOME}...`);
  }

  fs.mkdirSync(MINIONS_HOME, { recursive: true });

  // Track what we do for the summary
  const actions = { created: [], updated: [], skipped: [] };

  // Files/dirs to never copy from the package
  const excludeTop = new Set([
    'bin', 'node_modules', '.git', '.claude', 'package-lock.json',
    '.npmignore', '.gitignore', '.github',
  ]);

  // Files that are always overwritten (engine code + version metadata)
  const alwaysUpdate = (name) =>
    name.endsWith('.js') || name.endsWith('.html') || name === 'package.json';

  // Files that should be added if missing but never overwritten (user customizations)
  const neverOverwrite = (name) =>
    name === 'config.json';

  // Copy with smart merge logic
  copyDir(PKG_ROOT, MINIONS_HOME, excludeTop, alwaysUpdate, neverOverwrite, isUpgrade, actions);

  // Create config from template if it doesn't exist
  const configPath = path.join(MINIONS_HOME, 'config.json');
  if (!fs.existsSync(configPath)) {
    const tmpl = path.join(MINIONS_HOME, 'config.template.json');
    if (fs.existsSync(tmpl)) {
      fs.copyFileSync(tmpl, configPath);
      actions.created.push('config.json');
    }
  }

  // Ensure runtime directories exist
  const dirs = ['engine', 'notes/inbox', 'notes/archive', 'identity', 'plans', 'knowledge'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(MINIONS_HOME, d), { recursive: true });
  }

  // Run minions.js init to populate config with defaults (agents, engine settings)
  const initArgs = ['init'];
  if (isUpgrade || skipScan) initArgs.push('--skip-scan');
  execSync(`node "${path.join(MINIONS_HOME, 'minions.js')}" ${initArgs.join(' ')}`, { stdio: 'inherit' });

  // Save version
  saveInstalledVersion(pkgVersion);
  saveRootPointer(MINIONS_HOME);

  // Generate install ID on fresh init (tells dashboard to clear stale browser state)
  const installIdPath = path.join(MINIONS_HOME, '.install-id');
  if (!isUpgrade || !fs.existsSync(installIdPath)) {
    const crypto = require('crypto');
    fs.writeFileSync(installIdPath, crypto.randomBytes(8).toString('hex'));
  }

  console.log('');

  // Show changelog for upgrades
  if (isUpgrade && installedVersion && installedVersion !== pkgVersion) {
    showChangelog(installedVersion);
  }

  // Run preflight checks (warn only — don't block init).
  // includeAllRegistered: probe every registered runtime adapter (claude AND
  // copilot today) so the user sees availability of both, even if their
  // current config only references one. Missing optional runtimes surface as
  // warns, not failures.
  try {
    const { runPreflight, printPreflight } = require(path.join(MINIONS_HOME, 'engine', 'preflight'));
    let preflightConfig = null;
    try { preflightConfig = JSON.parse(fs.readFileSync(path.join(MINIONS_HOME, 'config.json'), 'utf8')); }
    catch { /* config may not exist on first init — fine, preflight handles null */ }
    const { results } = runPreflight({ config: preflightConfig, includeAllRegistered: true });
    printPreflight(results, { label: 'Preflight checks' });
  } catch {}

  // Update flow passes --skip-start so it can perform a single visible restart afterwards.
  if (isUpgrade && skipStart) return;

  // Auto-start on fresh install; direct force-upgrade restarts automatically.
  // Probe before kill so we can suppress the new dashboard's auto-open when an
  // existing tab is already live (it'll SSE-reconnect to the new dashboard).
  const dashWasUp = isPortListening(DASH_PORT);
  if (isUpgrade) {
    try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME, timeout: 10000, windowsHide: true }); } catch {}
    // Free the dashboard port too — without this the new dashboard EADDRINUSE-dies
    // silently and the user keeps running stale code from the old dashboard process.
    killByPort(DASH_PORT);
  }
  console.log(isUpgrade
    ? `\n  Upgrade complete (${pkgVersion}). Restarting engine and dashboard...\n`
    : '\n  Starting engine and dashboard...\n');
  const engineProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'engine.js'), 'start'], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  engineProc.unref();
  console.log(`  Engine started (PID: ${engineProc.pid})`);

  const dashProc = spawnDashboard(dashWasUp);
  console.log(`  Dashboard started (PID: ${dashProc.pid})`);
  console.log(`  Dashboard: http://localhost:${DASH_PORT}`);

  // Next steps guidance
  console.log(`
  Next steps:
    minions work "Explore the codebase"   Give your first task
    minions status                         Check engine state
    minions dash                           Open the dashboard
    minions doctor                         Verify everything is working
    minions --help                         See all commands
`);
}

function copyDir(src, dest, excludeTop, alwaysUpdate, neverOverwrite, isUpgrade, actions, relPath = '') {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeTop.size > 0 && excludeTop.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const rel = relPath ? `${relPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      // Don't pass top-level excludes to subdirectories
      copyDir(srcPath, destPath, new Set(), alwaysUpdate, neverOverwrite, isUpgrade, actions, rel);
    } else {
      const exists = fs.existsSync(destPath);

      if (!exists) {
        // New file — always copy
        fs.copyFileSync(srcPath, destPath);
        actions.created.push(rel);
      } else if (neverOverwrite(entry.name)) {
        // User config — never overwrite
        actions.skipped.push(rel);
      } else if (alwaysUpdate(entry.name)) {
        // Engine code — always overwrite
        const srcContent = fs.readFileSync(srcPath);
        const destContent = fs.readFileSync(destPath);
        if (!srcContent.equals(destContent)) {
          fs.copyFileSync(srcPath, destPath);
          actions.updated.push(rel);
        }
      } else if (force) {
        // --force: overwrite .md, .json (except config), templates
        const srcContent = fs.readFileSync(srcPath);
        const destContent = fs.readFileSync(destPath);
        if (!srcContent.equals(destContent)) {
          fs.copyFileSync(srcPath, destPath);
          actions.updated.push(rel);
        }
      } else {
        // Default: don't overwrite user files
        actions.skipped.push(rel);
      }
    }
  }
}

function showChangelog(fromVersion) {
  const changelogPath = path.join(MINIONS_HOME, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return;

  const content = fs.readFileSync(changelogPath, 'utf8');
  // Show a brief hint rather than dumping the whole changelog
  console.log('\n  What\'s new: see CHANGELOG.md or run:');
  console.log(`    cat ${changelogPath}\n`);
}

function formatPackageCliCommand(args) {
  const initScript = path.join(PKG_ROOT, 'bin', 'minions.js');
  return `node "${initScript}" ${args.join(' ')}`;
}

function runPackageCli(args, timeout) {
  const initScript = path.join(PKG_ROOT, 'bin', 'minions.js');
  return spawnSync(process.execPath, [initScript, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MINIONS_HOME },
    stdio: 'inherit',
    timeout,
    windowsHide: true,
  });
}

function runPostUpdateInit() {
  const args = ['init', '--force', '--skip-start'];
  const result = runPackageCli(args, POST_UPDATE_INIT_TIMEOUT_MS);

  if (!result.error && result.status === 0) return;

  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (timedOut) {
    console.error(`\n  ERROR: Post-update initialization timed out after ${POST_UPDATE_INIT_TIMEOUT_MS / 1000}s.`);
  } else {
    const detail = result.error ? result.error.message : `exit code ${result.status}`;
    console.error(`\n  ERROR: Post-update initialization failed (${detail}).`);
  }
  console.error('  The npm package update completed, but runtime files were not fully synchronized.');
  console.error('  After npm finishes settling, run:');
  console.error(`    ${formatPackageCliCommand(args)}`);
  console.error(`    ${formatPackageCliCommand(['restart'])}\n`);
  process.exit(1);
}

function runPostUpdateRestart() {
  const args = ['restart'];
  const result = runPackageCli(args, POST_UPDATE_RESTART_TIMEOUT_MS);

  if (!result.error && result.status === 0) return;

  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (timedOut) {
    console.error(`\n  ERROR: Post-update restart timed out after ${POST_UPDATE_RESTART_TIMEOUT_MS / 1000}s.`);
  } else {
    const detail = result.error ? result.error.message : `exit code ${result.status}`;
    console.error(`\n  ERROR: Post-update restart failed (${detail}).`);
  }
  console.error('  Runtime files were synchronized, but the engine/dashboard were not restarted.');
  console.error('  Run this command to finish the update without using the Windows command shim:');
  console.error(`    ${formatPackageCliCommand(args)}\n`);
  process.exit(1);
}

// ─── Version command ────────────────────────────────────────────────────────

function showVersion() {
  const pkg = getPkgVersion();
  const installed = getInstalledVersion();
  console.log(`\n  Package version:   ${pkg}`);
  console.log(`  Runtime root:      ${MINIONS_HOME}`);
  if (installed) {
    console.log(`  Installed version: ${installed}`);
    if (installed !== pkg) {
      console.log('\n  Update available! Run: minions update');
    } else {
      console.log('  Up to date.');
    }
  } else {
    console.log('  Not installed yet. Run: minions init');
  }

  // Check npm registry for latest version (best-effort, non-blocking)
  try {
    const latest = execSync('npm view @yemi33/minions version', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (latest && latest !== pkg) {
      console.log(`\n  Latest on npm:     ${latest}`);
      console.log('  To update: minions update');
    }
  } catch {} // offline or npm not available — skip silently

  console.log('');
}

// ─── Delegate: run commands against installed ~/.minions/ ─────────────────────

function ensureInstalled() {
  if (!fs.existsSync(path.join(MINIONS_HOME, 'engine.js'))) {
    console.log('\n  Minions is not installed. Run: minions init\n');
    process.exit(1);
  }
}

function delegate(script, args) {
  ensureInstalled();
  const child = spawn(process.execPath, [path.join(MINIONS_HOME, script), ...args], {
    stdio: 'inherit',
    cwd: MINIONS_HOME,
    env: { ...process.env, MINIONS_HOME },
  });
  child.on('exit', code => process.exit(code || 0));
}

// ─── Command routing ────────────────────────────────────────────────────────

const engineCmds = new Set([
  'start', 'stop', 'status', 'pause', 'resume',
  'queue', 'sources', 'discover', 'dispatch',
  'spawn', 'work', 'cleanup', 'mcp-sync', 'plan',
  'kill', 'complete', 'config',
]);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
  Minions — Central AI dev team manager

  Setup:
    minions init                     Bootstrap ~/.minions/ (first time)
    minions update                   Update to latest version (npm update + one restart)
    minions version                  Show installed vs package version
    minions doctor                   Check prerequisites and runtime health
    minions add <project-dir>        Link a project (interactive)
    minions remove <project-dir>     Unlink a project
    minions list                     List linked projects

  Engine:
    minions restart                   Start engine + dashboard (use after reboot)
    minions start                    Start engine daemon only
    minions stop                     Stop the engine
    minions status                   Show agents, projects, queue
    minions pause / resume           Pause/resume dispatching
    minions dispatch                 Force a dispatch cycle
    minions discover                 Dry-run work discovery
    minions queue                    Show dispatch queue (pending/active/completed)
    minions sources                  Show work source status per project
    minions work <title> [opts]      Add a work item
    minions spawn <agent> <prompt>   Manually spawn an agent
    minions plan <file|text> [proj]  Run a plan
    minions kill                     Kill all active agents and reset to pending
    minions complete <dispatch-id>   Manually mark a dispatch as completed
    minions cleanup                  Clean temp files, worktrees, zombies
    minions nuke --confirm           Factory reset (delete state, reset config to defaults)
    minions uninstall --confirm      Remove everything + uninstall npm package

  Dashboard:
    minions dash                     Start web dashboard (default :7331)

  Runtime root: ${MINIONS_HOME}
`);
} else if (cmd === 'init') {
  init();
} else if (cmd === 'update') {
  console.log('\n  Updating Minions...\n');
  // Dev/symlink installs: PKG_ROOT === MINIONS_HOME — npm update is a no-op (symlink already
  // points to the repo), and `minions init --force` would fail (cwd/.minions is inside PKG_ROOT).
  // Just sync the version file and restart.
  const isSymlinkedDevInstall = path.resolve(PKG_ROOT) === path.resolve(MINIONS_HOME);
  if (isSymlinkedDevInstall) {
    saveInstalledVersion(getPkgVersion());
    console.log(`  Version synced to ${getPkgVersion()} (dev/symlink install — pull from git to update code)`);
  } else {
    try {
      execSync('npm update -g @yemi33/minions', { stdio: 'inherit', timeout: 120000 });
    } catch (e) {
      console.error('  npm update failed:', e.message);
      process.exit(1);
    }
    // Equivalent to `minions init --force --skip-start`, but avoids recursing through
    // the global shim while npm is still settling the updated install.
    runPostUpdateInit();
  }
  // Restart engine + dashboard so they pick up the new code
  console.log('\n  Restarting engine and dashboard...\n');
  runPostUpdateRestart();
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  showVersion();
} else if (cmd === 'add' || cmd === 'remove' || cmd === 'list' || cmd === 'scan') {
  delegate('minions.js', [cmd, ...rest]);
} else if (cmd === 'restart') {
  // Start both engine and dashboard — the go-to command after a reboot.
  // `--cli` / `--model` flags forward to `engine.js start` so the runtime
  // fleet flips before the daemon spawns (P-6b3f9c2e AC: works on restart).
  ensureInstalled();
  // Probe before kill so we can suppress the new dashboard's auto-open when an
  // existing tab is already live (it'll SSE-reconnect to the new dashboard).
  const dashWasUp = isPortListening(DASH_PORT);
  // Layered kill — each step is best-effort, layered so the next still runs if
  // one fails. Goal: the old engine is gone before we spawn a new one, even if
  // PowerShell is unavailable, the engine is hung, or its cmdline doesn't match.
  const oldEnginePid = readEnginePid(MINIONS_HOME);
  // 1. Graceful stop — short timeout so a hung engine can't block what follows.
  try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME, timeout: 10000, windowsHide: true }); } catch {}
  // 2. Force-kill the recorded engine PID (NOT the tree — agent children must
  //    survive so the new engine can re-attach them via PID files).
  killPidOnly(oldEnginePid);
  // 3. Free dashboard port (catches orphan dashboards with no recorded PID).
  killByPort(DASH_PORT);
  // 4. Belt-and-suspenders cmdline match for anything still alive.
  killMinionsProcesses(['engine.js', 'dashboard.js']);
  const engineProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'engine.js'), 'start', ...rest], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  engineProc.unref();
  console.log(`\n  Engine started (PID: ${engineProc.pid})`);
  const dashProc = spawnDashboard(dashWasUp);
  console.log(`  Dashboard started (PID: ${dashProc.pid})`);
  console.log(`  Dashboard: http://localhost:${DASH_PORT}\n`);
} else if (cmd === 'nuke') {
  ensureInstalled();
  if (!rest.includes('--confirm')) {
    console.log(`
  Factory reset — kills all processes and deletes all runtime state.

  DELETED:
    - Work items, dispatch queue, PRDs, plans, pipelines
    - Agent history, sessions, output logs
    - Notes, knowledge base, pinned notes
    - Metrics, cooldowns, schedules, meetings
    - Project state (PR tracking, per-project work items)

  RESET to defaults:
    - config.json (engine settings, agents — project links removed)
    - routing.md

  PRESERVED:
    - Agent charters
    - Playbooks

  Run: minions nuke --confirm
`);
    process.exit(0);
  }

  console.log('\n  Minions Factory Reset\n');

  // 1. Kill all processes
  try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME }); } catch {}
  killByPort(DASH_PORT);
  killMinionsProcesses(['engine.js', 'dashboard.js', 'spawn-agent.js']);
  console.log('  Killed all processes');

  // 2. Delete runtime state
  const glob = (dir, pattern) => { try { return fs.readdirSync(dir).filter(f => pattern.test(f)).map(f => path.join(dir, f)); } catch { return []; } };
  const rm = (f) => { try { fs.unlinkSync(f); } catch {} };
  const rmDir = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
  const engineDir = path.join(MINIONS_HOME, 'engine');

  // Engine state
  for (const f of ['dispatch.json', 'control.json', 'log.json', 'metrics.json', 'cooldowns.json', 'schedule-runs.json', 'kb-checkpoint.json', 'cc-session.json', 'doc-sessions.json', 'pipeline-runs.json']) rm(path.join(engineDir, f));
  glob(engineDir, /^pid-.*\.pid$/).forEach(rm);
  rmDir(path.join(engineDir, 'tmp'));

  // Work items + PRs
  rm(path.join(MINIONS_HOME, 'work-items.json'));
  rm(path.join(MINIONS_HOME, 'work-items-archive.json'));
  rm(path.join(MINIONS_HOME, 'pull-requests.json'));

  // Plans + PRDs + Pipelines + Meetings
  rmDir(path.join(MINIONS_HOME, 'plans'));
  rmDir(path.join(MINIONS_HOME, 'prd'));
  rmDir(path.join(MINIONS_HOME, 'pipelines'));
  rmDir(path.join(MINIONS_HOME, 'meetings'));
  fs.mkdirSync(path.join(MINIONS_HOME, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(MINIONS_HOME, 'prd'), { recursive: true });

  // Notes + KB
  rm(path.join(MINIONS_HOME, 'notes.md'));
  rm(path.join(MINIONS_HOME, 'pinned.md'));
  rmDir(path.join(MINIONS_HOME, 'notes'));
  rmDir(path.join(MINIONS_HOME, 'knowledge'));
  fs.mkdirSync(path.join(MINIONS_HOME, 'notes', 'inbox'), { recursive: true });

  // Agent state (preserve charters)
  const agentsDir = path.join(MINIONS_HOME, 'agents');
  try {
    for (const agent of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, agent);
      if (!fs.statSync(agentDir).isDirectory()) continue;
      for (const f of fs.readdirSync(agentDir)) {
        if (f === 'charter.md') continue;
        rm(path.join(agentDir, f));
      }
    }
  } catch {}

  // Projects state
  rmDir(path.join(MINIONS_HOME, 'projects'));
  fs.mkdirSync(path.join(MINIONS_HOME, 'projects'), { recursive: true });

  // 3. Reset config.json and routing.md to defaults
  const tmplPath = path.join(MINIONS_HOME, 'config.template.json');
  const configPath = path.join(MINIONS_HOME, 'config.json');
  if (fs.existsSync(tmplPath)) {
    fs.copyFileSync(tmplPath, configPath);
  } else {
    fs.writeFileSync(configPath, JSON.stringify({ projects: [], engine: {}, claude: {}, agents: {} }, null, 2));
  }
  // Re-run init to populate defaults (agents, engine settings)
  try { execSync(`node "${path.join(MINIONS_HOME, 'minions.js')}" init --skip-scan`, { stdio: 'inherit' }); } catch {}

  console.log('\n  Factory reset complete. Run "minions init" to link projects and start fresh.\n');
} else if (cmd === 'uninstall') {
  if (!rest.includes('--confirm')) {
    console.log(`
  Uninstall Minions — removes EVERYTHING.

  This will:
    1. Kill all running engine, dashboard, and agent processes
    2. Delete the entire ${MINIONS_HOME} directory (all state, config, agents, knowledge)
    3. Remove extracted skills from ~/.claude/skills/ (minions-authored only)
    4. Uninstall the npm package (@yemi33/minions)

  This is irreversible. Your project repos are NOT affected.

  Run: minions uninstall --confirm
`);
    process.exit(0);
  }

  console.log('\n  Uninstalling Minions...\n');

  // 1. Kill all processes
  try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME, timeout: 10000 }); } catch {}
  killByPort(DASH_PORT);
  killMinionsProcesses(['engine.js', 'dashboard.js', 'spawn-agent.js']);
  console.log('  Killed all processes');

  // 2. Remove minions-authored skills from ~/.claude/skills/
  try {
    const claudeSkills = path.join(os.homedir(), '.claude', 'skills');
    if (fs.existsSync(claudeSkills)) {
      for (const dir of fs.readdirSync(claudeSkills)) {
        const skillFile = path.join(claudeSkills, dir, 'SKILL.md');
        try {
          const content = fs.readFileSync(skillFile, 'utf8');
          if (content.includes('Auto-extracted skill') || content.includes('author:')) {
            fs.rmSync(path.join(claudeSkills, dir), { recursive: true, force: true });
          }
        } catch {}
      }
      console.log('  Cleaned minions skills from ~/.claude/skills/');
    }
  } catch {}

  // 3. Delete ~/.minions entirely
  if (fs.existsSync(MINIONS_HOME)) {
    fs.rmSync(MINIONS_HOME, { recursive: true, force: true });
    console.log('  Deleted ' + MINIONS_HOME);
  }

  // 4. Uninstall npm package
  console.log('  Uninstalling npm package...');
  try { execSync('npm uninstall -g @yemi33/minions', { stdio: 'inherit', timeout: 60000 }); } catch {}

  console.log('\n  Minions uninstalled. Your project repos were not touched.');
  console.log('\n  To re-install later, run:');
  console.log('    npm install -g @yemi33/minions && minions init\n');
} else if (cmd === 'doctor') {
  ensureInstalled();
  const { doctor } = require(path.join(MINIONS_HOME, 'engine', 'preflight'));
  doctor(MINIONS_HOME).then(ok => process.exit(ok ? 0 : 1));
} else if (cmd === 'dash' || cmd === 'dashboard') {
  ensureInstalled();
  // If dashboard is already running, just open the browser
  const net = require('net');
  const sock = new net.Socket();
  let handled = false;
  sock.setTimeout(1000);
  sock.on('connect', () => {
    sock.destroy();
    if (handled) return;
    handled = true;
    const url = `http://localhost:${DASH_PORT}`;
    console.log(`\n  Dashboard already running: ${url}\n`);
    try {
      const openCmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
      execSync(openCmd, { stdio: 'ignore', windowsHide: true });
    } catch {}
  });
  sock.on('error', () => {
    sock.destroy();
    if (handled) return;
    handled = true;
    delegate('dashboard.js', rest);
  });
  sock.on('timeout', () => {
    sock.destroy();
    if (handled) return;
    handled = true;
    delegate('dashboard.js', rest);
  });
  sock.connect(DASH_PORT, '127.0.0.1');
} else if (engineCmds.has(cmd)) {
  delegate('engine.js', [cmd, ...rest]);
} else {
  console.log(`  Unknown command: ${cmd}`);
  console.log('  Run "minions help" for usage.\n');
  process.exit(1);
}
