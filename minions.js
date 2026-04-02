#!/usr/bin/env node
/**
 * Minions Init — Link a project to the central minions
 *
 * Usage:
 *   node minions.js <project-dir>           Add a project interactively
 *   node minions.js <project-dir> --remove  Remove a project
 *   node minions.js --list                  List linked projects
 *
 * This adds the project to ~/.minions/config.json's projects array.
 * The minions engine and dashboard run centrally from ~/.minions/.
 * Each project just needs its own work-items.json and pull-requests.json.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { ENGINE_DEFAULTS, DEFAULT_AGENTS, DEFAULT_CLAUDE } = require('./engine/shared');

const MINIONS_HOME = __dirname;
const CONFIG_PATH = path.join(MINIONS_HOME, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {
    return { projects: [], engine: {}, claude: {}, agents: {} };
  }
}

function cleanupPlaceholderProjects(config) {
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  const filtered = projects.filter(p => {
    const name = String(p?.name || '').trim();
    return name && name !== 'YOUR_PROJECT_NAME';
  });
  const removed = projects.length - filtered.length;
  if (removed > 0) config.projects = filtered;
  return removed;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q, def) {
  return new Promise(resolve => {
    rl.question(`  ${q}${def ? ` [${def}]` : ''}: `, ans => resolve(ans.trim() || def || ''));
  });
}

function autoDiscover(targetDir) {
  const result = { _found: [] };

  // 1. Detect main branch from git
  try {
    let head = '';
    try {
      head = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: targetDir, encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      head = execSync('git symbolic-ref HEAD', { cwd: targetDir, encoding: 'utf8', timeout: 5000 }).trim();
    }
    const branch = head.replace('refs/remotes/origin/', '').replace('refs/heads/', '');
    if (branch) { result.mainBranch = branch; result._found.push('main branch'); }
  } catch {}

  // 2. Detect repo host, org, project, repo name from git remote URL
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: targetDir, encoding: 'utf8', timeout: 5000 }).trim();
    if (remoteUrl.includes('github.com')) {
      result.repoHost = 'github';
      // https://github.com/org/repo.git or git@github.com:org/repo.git
      const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) { result.org = m[1]; result.repoName = m[2]; }
      result._found.push('GitHub remote');
    } else if (remoteUrl.includes('visualstudio.com') || remoteUrl.includes('dev.azure.com')) {
      result.repoHost = 'ado';
      // https://org.visualstudio.com/project/_git/repo or https://dev.azure.com/org/project/_git/repo
      const m1 = remoteUrl.match(/https:\/\/([^.]+)\.visualstudio\.com[^/]*\/([^/]+)\/_git\/([^/\s]+)/);
      const m2 = remoteUrl.match(/https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/\s]+)/);
      const m = m1 || m2;
      if (m) { result.org = m[1]; result.project = m[2]; result.repoName = m[3]; }
      result._found.push('Azure DevOps remote');
    }
  } catch {}

  // 3. Read description from CLAUDE.md first line or README.md first paragraph
  try {
    const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      // Look for a description-like first line or paragraph (skip headings)
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      if (lines[0] && lines[0].length < 200) {
        result.description = lines[0].trim();
        result._found.push('description from CLAUDE.md');
      }
    }
  } catch {}
  if (!result.description) {
    try {
      const readmePath = path.join(targetDir, 'README.md');
      if (fs.existsSync(readmePath)) {
        const content = fs.readFileSync(readmePath, 'utf8').slice(0, 2000);
        const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
        if (lines[0] && lines[0].length < 200) {
          result.description = lines[0].trim();
          result._found.push('description from README.md');
        }
      }
    } catch {}
  }

  // 4. Detect project name
  try {
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) { result.name = pkg.name.replace(/^@[^/]+\//, ''); result._found.push('name from package.json'); }
    }
  } catch {}

  return result;
}

// ─── Shared Helpers (used by both addProject and scanAndAdd) ─────────────────

function buildPrUrlBase({ repoHost, org, project, repoName }) {
  if (repoHost === 'github') {
    return org && repoName ? `https://github.com/${org}/${repoName}/pull/` : '';
  }
  if (repoHost === 'ado' && org && project && repoName) {
    return `https://dev.azure.com/${org}/${project}/_git/${repoName}/pullrequest/`;
  }
  return '';
}

function buildProjectEntry({ name, description, localPath, repoHost, repositoryId, org, project, repoName, mainBranch }) {
  // Sanitize name for use as directory name in projects/<name>/
  const safeName = (name || 'project').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
  return {
    name: safeName,
    description: description || '',
    localPath: (localPath || '').replace(/\\/g, '/'),
    repoHost: repoHost || 'github',
    repositoryId: repositoryId || '',
    adoOrg: org || '',
    adoProject: project || '',
    repoName: repoName || name,
    mainBranch: mainBranch || 'main',
    prUrlBase: buildPrUrlBase({ repoHost, org, project, repoName }),
  };
}


// ─── Commands ────────────────────────────────────────────────────────────────

async function addProject(targetDir) {
  const target = path.resolve(targetDir);
  if (!fs.existsSync(target)) {
    console.log(`  Error: Directory not found: ${target}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.projects) config.projects = [];

  // Check if already linked
  const existing = config.projects.find(p => path.resolve(p.localPath) === target);
  if (existing) {
    console.log(`  "${existing.name}" is already linked at ${target}`);
    const update = await ask('Update its configuration? (y/N)', 'N');
    if (update.toLowerCase() !== 'y') { rl.close(); return; }
    config.projects = config.projects.filter(p => path.resolve(p.localPath) !== target);
  }

  console.log('\n  Link Project to Minions');
  console.log('  ─────────────────────────────');
  console.log(`  Minions home: ${MINIONS_HOME}`);
  console.log(`  Project:    ${target}\n`);

  const detected = autoDiscover(target);
  if (detected._found.length > 0) {
    console.log(`  Auto-detected: ${detected._found.join(', ')}\n`);
  }

  const name = await ask('Project name', detected.name || path.basename(target));
  const description = await ask('Description (what this repo contains/does)', detected.description || '');
  const repoHost = await ask('Repo host (github/ado)', detected.repoHost || 'github');
  const org = await ask('Organization', detected.org || '');
  const project = await ask('Project', detected.project || '');
  const repoName = await ask('Repo name', detected.repoName || name);
  const repositoryId = await ask('Repository ID (GUID, optional)', '');
  const mainBranch = await ask('Main branch', detected.mainBranch || 'main');

  rl.close();

  config.projects.push(buildProjectEntry({ name, description, localPath: target, repoHost, repositoryId, org, project, repoName, mainBranch }));
  saveConfig(config);

  console.log(`\n  Linked "${name}" (${target})`);
  console.log(`  Total projects: ${config.projects.length}`);
  console.log(`\n  Start the minions from anywhere:`);
  console.log(`    node ${MINIONS_HOME}/engine.js         # Engine`);
  console.log(`    node ${MINIONS_HOME}/dashboard.js      # Dashboard`);
  console.log(`    node ${MINIONS_HOME}/engine.js status   # Status\n`);
}

function removeProject(targetDir) {
  const target = path.resolve(targetDir);
  const config = loadConfig();
  const before = (config.projects || []).length;
  config.projects = (config.projects || []).filter(p => path.resolve(p.localPath) !== target);
  const after = config.projects.length;

  if (before === after) {
    console.log(`  No project linked at ${target}`);
  } else {
    saveConfig(config);
    console.log(`  Removed project at ${target}`);
    console.log(`  Remaining projects: ${config.projects.length}`);
  }
  rl.close();
}

function listProjects() {
  const config = loadConfig();
  const projects = config.projects || [];
  console.log(`\n  Minions Projects (${projects.length})\n`);
  if (projects.length === 0) {
    console.log('  No projects linked. Run: node minions.js <project-dir>\n');
    rl.close();
    return;
  }
  for (const p of projects) {
    const exists = fs.existsSync(p.localPath);
    console.log(`  ${p.name}`);
    if (p.description) console.log(`    Desc: ${p.description}`);
    console.log(`    Path: ${p.localPath} ${exists ? '' : '(NOT FOUND)'}`);
    console.log(`    Repo: ${p.adoOrg}/${p.adoProject}/${p.repoName} (${p.repoHost || 'ado'})`);
    console.log(`    ID:   ${p.repositoryId || 'none'}`);
    console.log('');
  }
  rl.close();
}

// ─── Scan & Multi-Select ─────────────────────────────────────────────────────

function findGitRepos(rootDir, maxDepth = 3) {
  const repos = [];
  const visited = new Set();

  function walk(dir, depth) {
    if (depth > maxDepth || visited.has(dir)) return;
    visited.add(dir);
    try {
      // Skip common non-project dirs
      const base = path.basename(dir);
      if (['node_modules', '.git', '.hg', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files',
           'Program Files (x86)', '.cache', '.npm', '.yarn', '.nuget', 'worktrees', '.minions'].includes(base)) return;
      // Skip minions home directory itself
      if (path.resolve(dir) === path.resolve(MINIONS_HOME)) return;

      const gitDir = path.join(dir, '.git');
      if (fs.existsSync(gitDir)) {
        repos.push(dir);
        return; // Don't recurse into git repos (they may have nested submodules)
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          walk(path.join(dir, entry.name), depth + 1);
        }
      }
    } catch {} // permission errors, etc.
  }

  walk(rootDir, 0);
  return repos;
}

async function scanAndAdd({ root, depth } = {}) {
  let scanRoot;
  if (root) {
    scanRoot = path.resolve(root);
  } else {
    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const answer = await ask('Where are your projects?', homeDir);
    scanRoot = path.resolve(answer);
  }
  if (!fs.existsSync(scanRoot)) {
    console.log(`  Directory not found: ${scanRoot}\n`);
    rl.close();
    return;
  }
  const maxDepth = depth !== undefined ? (parseInt(depth, 10) || 4) : 4;

  console.log(`\n  Scanning for git repos in: ${scanRoot}`);
  console.log(`  Max depth: ${maxDepth}\n`);

  const repos = findGitRepos(scanRoot, maxDepth);
  if (repos.length === 0) {
    console.log('  No git repositories found.\n');
    rl.close();
    return;
  }

  const config = loadConfig();
  const linkedPaths = new Set((config.projects || []).map(p => path.resolve(p.localPath)));

  // Enrich repos with auto-discovered metadata
  const enriched = repos.map(repoPath => {
    const detected = autoDiscover(repoPath);
    const alreadyLinked = linkedPaths.has(path.resolve(repoPath));
    return {
      path: repoPath,
      name: detected.name || detected.repoName || path.basename(repoPath),
      host: detected.repoHost || '?',
      org: detected.org || '',
      project: detected.project || '',
      repoName: detected.repoName || path.basename(repoPath),
      mainBranch: detected.mainBranch || 'main',
      description: detected.description || '',
      linked: alreadyLinked,
    };
  });

  console.log(`  Found ${enriched.length} git repo(s):\n`);
  enriched.forEach((r, i) => {
    const tag = r.linked ? ' (already linked)' : '';
    const hostTag = r.host === 'ado' ? 'ADO' : r.host === 'github' ? 'GitHub' : 'git';
    console.log(`  ${String(i + 1).padStart(3)}. ${r.name} [${hostTag}]${tag}`);
    console.log(`       ${r.path}`);
  });

  console.log('\n  Enter numbers to add (comma-separated, ranges ok, e.g. "1,3,5-7")');
  console.log('  Or "all" to add all unlinked repos, "q" to quit.\n');

  const answer = await ask('Select repos', '');
  if (!answer || answer.toLowerCase() === 'q') {
    console.log('  Cancelled.\n');
    rl.close();
    return;
  }

  // Parse selection
  let indices;
  if (answer.toLowerCase() === 'all') {
    indices = enriched.map((_, i) => i).filter(i => !enriched[i].linked);
  } else {
    indices = [];
    for (const part of answer.split(',')) {
      const trimmed = part.trim();
      const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1]) - 1;
        const end = parseInt(rangeMatch[2]) - 1;
        for (let i = start; i <= end; i++) indices.push(i);
      } else {
        const n = parseInt(trimmed) - 1;
        if (!isNaN(n)) indices.push(n);
      }
    }
  }

  // Filter valid, unlinked selections
  const toAdd = [...new Set(indices)]
    .filter(i => i >= 0 && i < enriched.length && !enriched[i].linked)
    .map(i => enriched[i]);

  if (toAdd.length === 0) {
    console.log('  Nothing to add.\n');
    rl.close();
    return;
  }

  console.log(`\n  Adding ${toAdd.length} project(s)...\n`);

  const existingNames = new Set((config.projects || []).map(p => p.name));
  for (const repo of toAdd) {
    // Deduplicate names — append -2, -3 etc. if name already taken
    let name = repo.name;
    if (existingNames.has(name)) {
      let i = 2;
      while (existingNames.has(name + '-' + i)) i++;
      name = name + '-' + i;
    }
    existingNames.add(name);
    config.projects.push(buildProjectEntry({
      name, description: repo.description, localPath: repo.path,
      repoHost: repo.host, org: repo.org, project: repo.project,
      repoName: repo.repoName, mainBranch: repo.mainBranch,
    }));
    console.log(`  + ${name} (${repo.path})`);
  }

  saveConfig(config);
  console.log(`\n  Done. ${config.projects.length} total project(s) linked.`);
  console.log(`  Run "node minions.js list" to verify.\n`);
  rl.close();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

async function initMinions({ skipScan = false, scanRoot, scanDepth } = {}) {
  const config = loadConfig();
  if (!config.projects) config.projects = [];
  const removedPlaceholders = cleanupPlaceholderProjects(config);
  // Merge defaults — fills in new fields from upgrades while preserving user customizations
  if (!config.engine) config.engine = {};
  for (const [k, v] of Object.entries(ENGINE_DEFAULTS)) {
    if (config.engine[k] === undefined) config.engine[k] = v;
  }
  if (!config.claude) config.claude = {};
  for (const [k, v] of Object.entries(DEFAULT_CLAUDE)) {
    if (config.claude[k] === undefined) config.claude[k] = v;
  }
  if (!config.agents || Object.keys(config.agents).length === 0) {
    config.agents = { ...DEFAULT_AGENTS };
  }
  saveConfig(config);
  console.log(`\n  Minions initialized at ${MINIONS_HOME}`);
  console.log(`  Config, agents, and engine defaults created.\n`);

  // Preflight checks (skip if called from bin/minions.js which runs its own)
  if (!skipScan) {
    let preflightOk = true;
    try { execSync('git --version', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }); console.log('  ✓ Git found'); }
    catch { console.log('  ✗ Git not found — agents need git for worktrees and PRs'); preflightOk = false; }
    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'where claude 2>NUL' : 'which claude 2>/dev/null';
      execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      console.log('  ✓ Claude Code CLI found');
    } catch { console.log('  ✗ Claude Code CLI not found — install: npm i -g @anthropic-ai/claude-code (or native installer)'); preflightOk = false; }
    const nodeVer = parseInt(process.versions.node);
    if (nodeVer >= 18) { console.log('  ✓ Node.js ' + process.versions.node); }
    else { console.log('  ✗ Node.js ' + process.versions.node + ' — version 18+ required'); preflightOk = false; }
    if (!preflightOk) console.log('\n  Some prerequisites missing — agents may fail until resolved.\n');
    else console.log('');
  }
  if (removedPlaceholders > 0) {
    console.log(`  Removed ${removedPlaceholders} placeholder project entr${removedPlaceholders === 1 ? 'y' : 'ies'} from config.\n`);
  }

  if (skipScan) {
    console.log('  Skipping repo scan (--skip-scan). Run "node minions.js scan" later to link projects.\n');
    rl.close();
  } else {
    // Auto-chain into scan (scanAndAdd closes rl)
    console.log('  Now let\'s find your repos...\n');
    await scanAndAdd({ root: scanRoot, depth: scanDepth });
  }
}

function nukeMinions() {
  console.log('\n  Minions Factory Reset');
  console.log('  ===================\n');

  // 1. Kill engine process
  const controlPath = path.join(MINIONS_HOME, 'engine', 'control.json');
  try {
    const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    if (control.pid) {
      try {
        process.kill(control.pid);
        console.log(`  Killed engine (PID: ${control.pid})`);
      } catch { console.log(`  Engine process ${control.pid} already dead`); }
    }
  } catch {}

  // 2. Kill dashboard (port 7331)
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const out = execSync('netstat -ano | findstr :7331 | findstr LISTENING', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(p => p && p !== '0'))];
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, timeout: 5000 }); console.log(`  Killed dashboard (PID: ${pid})`); } catch {}
      }
    } else {
      const { execSync } = require('child_process');
      try { execSync('lsof -ti:7331 | xargs kill -9 2>/dev/null', { timeout: 5000 }); console.log('  Killed dashboard'); } catch {}
    }
  } catch {}

  // 3. Kill all agent processes (PID files in engine/tmp/)
  const pidDir = path.join(MINIONS_HOME, 'engine', 'tmp');
  try {
    const pidFiles = fs.readdirSync(pidDir).filter(f => f.endsWith('.pid'));
    for (const f of pidFiles) {
      try {
        const pid = parseInt(fs.readFileSync(path.join(pidDir, f), 'utf8').trim());
        if (pid) { try { process.kill(pid); console.log(`  Killed agent process (PID: ${pid})`); } catch {} }
      } catch {}
    }
  } catch {}

  // 4. Kill any remaining minions-related node processes
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      // Find node processes with minions in their command line
      const out = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', { encoding: 'utf8', timeout: 10000, windowsHide: true });
      for (const line of out.split('\n')) {
        if (line.includes('minions') && (line.includes('engine.js') || line.includes('dashboard.js') || line.includes('spawn-agent.js'))) {
          const pid = line.split(',').pop()?.trim();
          if (pid && pid !== String(process.pid)) {
            try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true, timeout: 5000 }); console.log(`  Killed minions process (PID: ${pid})`); } catch {}
          }
        }
      }
    }
  } catch {}

  // 5. Delete runtime state (NOT the source code)
  console.log('\n  Cleaning runtime state...');
  const runtimeDirs = ['projects', 'plans', 'prd', 'knowledge', 'skills', 'notes', 'identity'];
  const runtimeFiles = ['config.json', 'work-items.json', 'notes.md', 'routing.md'];
  const engineRuntimeFiles = ['control.json', 'dispatch.json', 'log.json', 'metrics.json', 'cooldowns.json', 'kb-checkpoint.json', 'cc-session.json', 'doc-sessions.json'];

  for (const dir of runtimeDirs) {
    const p = path.join(MINIONS_HOME, dir);
    if (fs.existsSync(p)) { try { fs.rmSync(p, { recursive: true, force: true }); console.log(`  Deleted ${dir}/`); } catch {} }
  }
  for (const f of runtimeFiles) {
    const p = path.join(MINIONS_HOME, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); console.log(`  Deleted ${f}`); } catch {} }
  }
  const engineDir = path.join(MINIONS_HOME, 'engine');
  for (const f of engineRuntimeFiles) {
    const p = path.join(engineDir, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); console.log(`  Deleted engine/${f}`); } catch {} }
  }
  // Clean engine/tmp/
  const tmpDir = path.join(engineDir, 'tmp');
  if (fs.existsSync(tmpDir)) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); console.log('  Deleted engine/tmp/'); } catch {} }
  // Clean agent history and output logs (preserve charters)
  const agentsDir = path.join(MINIONS_HOME, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const agent of fs.readdirSync(agentsDir)) {
      const agentDir = path.join(agentsDir, agent);
      try { if (!fs.statSync(agentDir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(agentDir)) {
        if (f === 'charter.md') continue; // preserve charters
        try { fs.unlinkSync(path.join(agentDir, f)); } catch {}
      }
    }
    console.log('  Cleaned agent state (charters preserved)');
  }

  console.log('  Factory reset complete. Run "minions init" to start fresh.\n');
  rl.close();
}

const commands = {
  init: () => {
    const skipScanFlag = rest.includes('--skip-scan');
    const initArgs = rest.filter(arg => arg !== '--skip-scan');
    const [scanRoot, scanDepth] = initArgs;
    initMinions({ skipScan: skipScanFlag, scanRoot, scanDepth })
      .catch(e => { console.error(e); process.exit(1); });
  },
  add: () => {
    const dir = rest[0];
    if (!dir) { console.log('Usage: node minions add <project-dir>'); process.exit(1); }
    addProject(dir).catch(e => { console.error(e); process.exit(1); });
  },
  remove: () => {
    const dir = rest[0];
    if (!dir) { console.log('Usage: node minions remove <project-dir>'); process.exit(1); }
    removeProject(dir);
  },
  list: () => listProjects(),
  scan: () => scanAndAdd({ root: rest[0], depth: rest[1] })
    .catch(e => { console.error(e); process.exit(1); }),
  nuke: () => nukeMinions(),
};

if (cmd && commands[cmd]) {
  commands[cmd]();
} else {
  console.log('\n  Minions — Central AI dev team manager\n');
  console.log('  Usage: node minions <command>\n');
  console.log('  Commands:');
  console.log('    init                    Initialize minions and scan for repos');
  console.log('    scan [dir] [depth]      Scan for git repos and multi-select to add');
  console.log('    add <project-dir>       Link a single project');
  console.log('    remove <project-dir>    Unlink a project');
  console.log('    list                    List linked projects');
  console.log('    nuke                    Factory reset — kill all processes, delete ~/.minions/\n');
}

