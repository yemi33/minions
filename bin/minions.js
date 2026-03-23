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
const { spawn, execSync } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
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

function findNearestLocalMinionsRoot(startDir) {
  let cur = path.resolve(startDir || process.cwd());
  while (true) {
    const candidate = path.join(cur, '.minions');
    if (isInstalledRoot(candidate)) return candidate;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
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

  if (forInit) return path.join(process.cwd(), '.minions');

  const localRoot = findNearestLocalMinionsRoot(process.cwd());
  if (localRoot) return localRoot;

  const pointerRoot = readRootPointer();
  if (isInstalledRoot(pointerRoot)) return pointerRoot;

  return DEFAULT_MINIONS_HOME;
}

const [cmd, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
const skipScan = rest.includes('--skip-scan');
const MINIONS_HOME = resolveMinionsHome(cmd === 'init');

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

  // Files that are always overwritten (engine code)
  const alwaysUpdate = (name) =>
    name.endsWith('.js') || name.endsWith('.html');

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

  // Print summary
  console.log('');
  if (actions.updated.length > 0) {
    console.log(`  Updated (${actions.updated.length}):`);
    for (const f of actions.updated) console.log(`    ↑ ${f}`);
  }
  if (actions.created.length > 0) {
    console.log(`  Added (${actions.created.length}):`);
    for (const f of actions.created) console.log(`    + ${f}`);
  }
  if (actions.skipped.length > 0 && !isUpgrade) {
    // Only show skipped on fresh install if something unexpected happened
  } else if (actions.skipped.length > 0) {
    console.log(`  Preserved (${actions.skipped.length} user-customized files)`);
  }

  // Show changelog for upgrades
  if (isUpgrade && installedVersion && installedVersion !== pkgVersion) {
    showChangelog(installedVersion);
  }

  // Auto-start on fresh install; force-upgrade restarts automatically.
  if (isUpgrade) {
    try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME }); } catch {}
  }
  console.log(isUpgrade
    ? `\n  Upgrade complete (${pkgVersion}). Restarting engine and dashboard...\n`
    : '\n  Starting engine and dashboard...\n');
  const engineProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'engine.js'), 'start'], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  engineProc.unref();
  console.log(`  Engine started (PID: ${engineProc.pid})`);

  const dashProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'dashboard.js')], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  dashProc.unref();
  console.log(`  Dashboard started (PID: ${dashProc.pid})`);
  console.log('  Dashboard: http://localhost:7331\n');
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

// ─── Version command ────────────────────────────────────────────────────────

function showVersion() {
  const pkg = getPkgVersion();
  const installed = getInstalledVersion();
  console.log(`\n  Package version:   ${pkg}`);
  console.log(`  Runtime root:      ${MINIONS_HOME}`);
  if (installed) {
    console.log(`  Installed version: ${installed}`);
    if (installed !== pkg) {
      console.log('\n  Update available! Run: minions init --force');
    } else {
      console.log('  Up to date.');
    }
  } else {
    console.log('  Not installed yet. Run: minions init');
  }
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
  });
  child.on('exit', code => process.exit(code || 0));
}

// ─── Command routing ────────────────────────────────────────────────────────

const engineCmds = new Set([
  'start', 'stop', 'status', 'pause', 'resume',
  'queue', 'sources', 'discover', 'dispatch',
  'spawn', 'work', 'cleanup', 'mcp-sync', 'plan',
]);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
  Minions — Central AI dev team manager

  Setup:
    minions init [--skip-scan]       Bootstrap ~/.minions/ (first time)
    minions init --force             Upgrade engine code + add new files (auto-skip scan)
    minions version                  Show installed vs package version
    minions add <project-dir>        Link a project (interactive)
    minions remove <project-dir>     Unlink a project
    minions list                     List linked projects

  Engine:
    minions start                    Start engine daemon
    minions stop                     Stop the engine
    minions status                   Show agents, projects, queue
    minions pause / resume           Pause/resume dispatching
    minions dispatch                 Force a dispatch cycle
    minions discover                 Dry-run work discovery
    minions work <title> [opts]      Add a work item
    minions spawn <agent> <prompt>   Manually spawn an agent
    minions plan <file|text> [proj]  Run a plan
    minions cleanup                  Clean temp files, worktrees, zombies

  Dashboard:
    minions dash                     Start web dashboard (default :7331)

  Runtime root: ${MINIONS_HOME}
`);
} else if (cmd === 'init') {
  init();
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  showVersion();
} else if (cmd === 'add' || cmd === 'remove' || cmd === 'list') {
  delegate('minions.js', [cmd, ...rest]);
} else if (cmd === 'dash' || cmd === 'dashboard') {
  delegate('dashboard.js', rest);
} else if (engineCmds.has(cmd)) {
  delegate('engine.js', [cmd, ...rest]);
} else {
  console.log(`  Unknown command: ${cmd}`);
  console.log('  Run "minions help" for usage.\n');
  process.exit(1);
}

