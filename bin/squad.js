#!/usr/bin/env node
/**
 * Squad CLI — Central AI dev team manager
 *
 * Usage:
 *   squad init                     Bootstrap ~/.squad/ with default config and agents
 *   squad init --force             Update engine code + add new files (preserves config & customizations)
 *   squad add <project-dir>        Link a project (interactive)
 *   squad remove <project-dir>     Unlink a project
 *   squad list                     List linked projects
 *   squad start                    Start the engine
 *   squad stop                     Stop the engine
 *   squad status                   Show engine status
 *   squad pause / resume           Pause/resume dispatching
 *   squad dash                     Start the dashboard
 *   squad work <title> [opts-json] Add a work item
 *   squad spawn <agent> <prompt>   Manually spawn an agent
 *   squad dispatch                 Force a dispatch cycle
 *   squad discover                 Dry-run work discovery
 *   squad cleanup                  Run cleanup manually
 *   squad plan <file|text> [proj]  Run a plan
 *   squad version                  Show installed and package versions
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const SQUAD_HOME = path.join(require('os').homedir(), '.squad');
const PKG_ROOT = path.resolve(__dirname, '..');

const [cmd, ...rest] = process.argv.slice(2);
const force = rest.includes('--force');

// ─── Version tracking ───────────────────────────────────────────────────────

function getPkgVersion() {
  try { return require(path.join(PKG_ROOT, 'package.json')).version; } catch { return '0.0.0'; }
}

function getInstalledVersion() {
  try {
    const vFile = path.join(SQUAD_HOME, '.squad-version');
    return fs.readFileSync(vFile, 'utf8').trim();
  } catch { return null; }
}

function saveInstalledVersion(version) {
  fs.writeFileSync(path.join(SQUAD_HOME, '.squad-version'), version);
}

// ─── Init / Upgrade ─────────────────────────────────────────────────────────

function init() {
  const isUpgrade = fs.existsSync(path.join(SQUAD_HOME, 'engine.js'));
  const pkgVersion = getPkgVersion();
  const installedVersion = getInstalledVersion();

  if (isUpgrade && !force) {
    console.log(`\n  Squad is installed at ${SQUAD_HOME}`);
    if (installedVersion) console.log(`  Installed version: ${installedVersion}`);
    console.log(`  Package version:   ${pkgVersion}`);
    console.log('\n  To upgrade: squad init --force\n');
    return;
  }

  if (isUpgrade) {
    console.log(`\n  Upgrading Squad at ${SQUAD_HOME}`);
    if (installedVersion) console.log(`  ${installedVersion} → ${pkgVersion}`);
    else console.log(`  → ${pkgVersion}`);
  } else {
    console.log(`\n  Bootstrapping Squad to ${SQUAD_HOME}...`);
  }

  fs.mkdirSync(SQUAD_HOME, { recursive: true });

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
    name === 'config.json' || name === 'config.template.json';

  // Copy with smart merge logic
  copyDir(PKG_ROOT, SQUAD_HOME, excludeTop, alwaysUpdate, neverOverwrite, isUpgrade, actions);

  // Create config from template if it doesn't exist
  const configPath = path.join(SQUAD_HOME, 'config.json');
  if (!fs.existsSync(configPath)) {
    const tmpl = path.join(SQUAD_HOME, 'config.template.json');
    if (fs.existsSync(tmpl)) {
      fs.copyFileSync(tmpl, configPath);
      actions.created.push('config.json');
    }
  }

  // Ensure runtime directories exist
  const dirs = ['engine', 'notes/inbox', 'notes/archive', 'identity', 'plans', 'knowledge'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(SQUAD_HOME, d), { recursive: true });
  }

  // Run squad.js init to populate config with defaults (agents, engine settings)
  execSync(`node "${path.join(SQUAD_HOME, 'squad.js')}" init`, { stdio: 'inherit' });

  // Save version
  saveInstalledVersion(pkgVersion);

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

  if (!isUpgrade) {
    console.log('\n  Next steps:');
    console.log('    squad add ~/my-project    Link your first project');
    console.log('    squad start               Start the engine');
    console.log('    squad dash                Open the dashboard\n');
  } else {
    console.log(`\n  Upgrade complete (${pkgVersion}). Restart the engine: squad stop && squad start\n`);
  }
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
  const changelogPath = path.join(SQUAD_HOME, 'CHANGELOG.md');
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
  if (installed) {
    console.log(`  Installed version: ${installed}`);
    if (installed !== pkg) {
      console.log('\n  Update available! Run: squad init --force');
    } else {
      console.log('  Up to date.');
    }
  } else {
    console.log('  Not installed yet. Run: squad init');
  }
  console.log('');
}

// ─── Delegate: run commands against installed ~/.squad/ ─────────────────────

function ensureInstalled() {
  if (!fs.existsSync(path.join(SQUAD_HOME, 'engine.js'))) {
    console.log('\n  Squad is not installed. Run: squad init\n');
    process.exit(1);
  }
}

function delegate(script, args) {
  ensureInstalled();
  const child = spawn(process.execPath, [path.join(SQUAD_HOME, script), ...args], {
    stdio: 'inherit',
    cwd: SQUAD_HOME,
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
  Squad — Central AI dev team manager

  Setup:
    squad init                     Bootstrap ~/.squad/ (first time)
    squad init --force             Upgrade engine code + add new files
    squad version                  Show installed vs package version
    squad add <project-dir>        Link a project (interactive)
    squad remove <project-dir>     Unlink a project
    squad list                     List linked projects

  Engine:
    squad start                    Start engine daemon
    squad stop                     Stop the engine
    squad status                   Show agents, projects, queue
    squad pause / resume           Pause/resume dispatching
    squad dispatch                 Force a dispatch cycle
    squad discover                 Dry-run work discovery
    squad work <title> [opts]      Add a work item
    squad spawn <agent> <prompt>   Manually spawn an agent
    squad plan <file|text> [proj]  Run a plan
    squad cleanup                  Clean temp files, worktrees, zombies

  Dashboard:
    squad dash                     Start web dashboard (default :7331)

  Home: ${SQUAD_HOME}
`);
} else if (cmd === 'init') {
  init();
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  showVersion();
} else if (cmd === 'add' || cmd === 'remove' || cmd === 'list') {
  delegate('squad.js', [cmd, ...rest]);
} else if (cmd === 'dash' || cmd === 'dashboard') {
  delegate('dashboard.js', rest);
} else if (engineCmds.has(cmd)) {
  delegate('engine.js', [cmd, ...rest]);
} else {
  console.log(`  Unknown command: ${cmd}`);
  console.log('  Run "squad help" for usage.\n');
  process.exit(1);
}
