#!/usr/bin/env node
/**
 * Squad CLI — Central AI dev team manager
 *
 * Usage:
 *   squad init                     Bootstrap ~/.squad/ with default config and agents
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
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const SQUAD_HOME = path.join(require('os').homedir(), '.squad');
const PKG_ROOT = path.resolve(__dirname, '..');

const [cmd, ...rest] = process.argv.slice(2);

// ─── Init: bootstrap ~/.squad/ from package templates ───────────────────────

function init() {
  if (fs.existsSync(path.join(SQUAD_HOME, 'engine.js'))) {
    console.log(`\n  Squad already installed at ${SQUAD_HOME}`);
    console.log('  To reinitialize config: squad init --force\n');
    if (!rest.includes('--force')) return;
  }

  console.log(`\n  Bootstrapping Squad to ${SQUAD_HOME}...\n`);
  fs.mkdirSync(SQUAD_HOME, { recursive: true });

  // Copy all package files to ~/.squad/
  const exclude = new Set([
    'bin', 'node_modules', '.git', '.claude', 'package.json',
    'package-lock.json', 'LICENSE', '.npmignore', '.gitignore',
  ]);

  copyDir(PKG_ROOT, SQUAD_HOME, exclude);

  // Create config from template if it doesn't exist
  const configPath = path.join(SQUAD_HOME, 'config.json');
  if (!fs.existsSync(configPath)) {
    const tmpl = path.join(SQUAD_HOME, 'config.template.json');
    if (fs.existsSync(tmpl)) {
      fs.copyFileSync(tmpl, configPath);
    }
  }

  // Ensure runtime directories exist
  const dirs = [
    'engine', 'notes/inbox', 'notes/archive',
    'identity', 'plans',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(SQUAD_HOME, d), { recursive: true });
  }

  // Run squad.js init to populate config with defaults
  execSync(`node "${path.join(SQUAD_HOME, 'squad.js')}" init`, { stdio: 'inherit' });

  console.log('\n  Next steps:');
  console.log('    squad add ~/my-project    Link your first project');
  console.log('    squad start               Start the engine');
  console.log('    squad dash                Open the dashboard\n');
}

function copyDir(src, dest, exclude) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDir(srcPath, destPath, new Set()); // only exclude at top level
    } else {
      // Don't overwrite user-modified files (except on --force)
      if (fs.existsSync(destPath) && !rest.includes('--force')) {
        // Always update engine code files
        if (!entry.name.endsWith('.js') && !entry.name.endsWith('.html')) continue;
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
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
