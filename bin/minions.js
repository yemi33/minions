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
let force = rest.includes('--force');
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

  console.log('');

  // Show changelog for upgrades
  if (isUpgrade && installedVersion && installedVersion !== pkgVersion) {
    showChangelog(installedVersion);
  }

  // Run preflight checks (warn only — don't block init)
  try {
    const { runPreflight, printPreflight } = require(path.join(MINIONS_HOME, 'engine', 'preflight'));
    const { results } = runPreflight();
    printPreflight(results, { label: 'Preflight checks' });
  } catch {}

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
  console.log('  Dashboard: http://localhost:7331');

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

  // Check npm registry for latest version (best-effort, non-blocking)
  try {
    const latest = execSync('npm view @yemi33/minions version', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (latest && latest !== pkg) {
      console.log(`\n  Latest on npm:     ${latest}`);
      console.log('  To update: npm update -g @yemi33/minions && minions init --force');
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
  });
  child.on('exit', code => process.exit(code || 0));
}

// ─── Command routing ────────────────────────────────────────────────────────

const engineCmds = new Set([
  'start', 'stop', 'status', 'pause', 'resume',
  'queue', 'sources', 'discover', 'dispatch',
  'spawn', 'work', 'cleanup', 'mcp-sync', 'plan',
  'kill', 'complete',
]);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
  Minions — Central AI dev team manager

  Setup:
    minions init                     Bootstrap ~/.minions/ (first time)
    minions update                   Update to latest version (npm update + init --force)
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
  try {
    execSync('npm update -g @yemi33/minions', { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    console.error('  npm update failed:', e.message);
    process.exit(1);
  }
  // Re-exec the NEW binary (just installed) so the updated code runs init --force
  execSync('minions init --force', { stdio: 'inherit', timeout: 120000 });
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  showVersion();
} else if (cmd === 'add' || cmd === 'remove' || cmd === 'list' || cmd === 'scan') {
  delegate('minions.js', [cmd, ...rest]);
} else if (cmd === 'restart') {
  // Start both engine and dashboard — the go-to command after a reboot
  ensureInstalled();
  // Stop engine if running
  try { execSync(`node "${path.join(MINIONS_HOME, 'engine.js')}" stop`, { stdio: 'ignore', cwd: MINIONS_HOME }); } catch {}
  // Kill existing dashboard
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8', timeout: 10000, windowsHide: true });
      for (const line of out.split('\n')) {
        if (line.includes('dashboard.js') && line.includes('minions')) {
          const pid = line.split(',').pop()?.trim();
          if (pid && pid !== String(process.pid)) try { process.kill(parseInt(pid)); } catch {}
        }
      }
    } else {
      try { execSync('lsof -ti:7331 | xargs kill -9 2>/dev/null', { timeout: 5000 }); } catch {}
    }
  } catch {}
  const engineProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'engine.js'), 'start'], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  engineProc.unref();
  console.log(`\n  Engine started (PID: ${engineProc.pid})`);
  const dashProc = spawn(process.execPath, [path.join(MINIONS_HOME, 'dashboard.js')], {
    cwd: MINIONS_HOME, stdio: 'ignore', detached: true, windowsHide: true
  });
  dashProc.unref();
  console.log(`  Dashboard started (PID: ${dashProc.pid})`);
  console.log('  Dashboard: http://localhost:7331\n');
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
  // Kill dashboard
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8', timeout: 10000, windowsHide: true });
      for (const line of out.split('\n')) {
        if (line.includes('minions') && (line.includes('engine.js') || line.includes('dashboard.js') || line.includes('spawn-agent.js'))) {
          const pid = line.split(',').pop()?.trim();
          if (pid && pid !== String(process.pid)) {
            try { process.kill(parseInt(pid)); } catch {}
          }
        }
      }
    } else {
      try { execSync('lsof -ti:7331 | xargs kill -9 2>/dev/null', { timeout: 5000 }); } catch {}
    }
  } catch {}
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
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8', timeout: 10000, windowsHide: true });
      for (const line of out.split('\n')) {
        if (line.includes('minions') && (line.includes('engine.js') || line.includes('dashboard.js') || line.includes('spawn-agent.js'))) {
          const pid = line.split(',').pop()?.trim();
          if (pid && pid !== String(process.pid)) try { process.kill(parseInt(pid)); } catch {}
        }
      }
    } else {
      try { execSync('pkill -f "minions.*engine.js" 2>/dev/null', { timeout: 5000 }); } catch {}
      try { execSync('pkill -f "minions.*dashboard.js" 2>/dev/null', { timeout: 5000 }); } catch {}
      try { execSync('lsof -ti:7331 | xargs kill -9 2>/dev/null', { timeout: 5000 }); } catch {}
    }
  } catch {}
  console.log('  Killed all processes');

  // 2. Remove minions-authored skills from ~/.claude/skills/
  try {
    const claudeSkills = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'skills');
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

  console.log('\n  Minions uninstalled. Your project repos were not touched.\n');
} else if (cmd === 'doctor') {
  ensureInstalled();
  const { doctor } = require(path.join(MINIONS_HOME, 'engine', 'preflight'));
  doctor(MINIONS_HOME).then(ok => process.exit(ok ? 0 : 1));
} else if (cmd === 'dash' || cmd === 'dashboard') {
  delegate('dashboard.js', rest);
} else if (engineCmds.has(cmd)) {
  delegate('engine.js', [cmd, ...rest]);
} else {
  console.log(`  Unknown command: ${cmd}`);
  console.log('  Run "minions help" for usage.\n');
  process.exit(1);
}

