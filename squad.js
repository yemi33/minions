#!/usr/bin/env node
/**
 * Squad Init — Link a project to the central squad
 *
 * Usage:
 *   node squad.js <project-dir>           Add a project interactively
 *   node squad.js <project-dir> --remove  Remove a project
 *   node squad.js --list                  List linked projects
 *
 * This adds the project to ~/.squad/config.json's projects array.
 * The squad engine and dashboard run centrally from ~/.squad/.
 * Each project just needs its own work-items.json and pull-requests.json.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { ENGINE_DEFAULTS, DEFAULT_AGENTS, DEFAULT_CLAUDE } = require('./engine/shared');

const SQUAD_HOME = __dirname;
const CONFIG_PATH = path.join(SQUAD_HOME, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {
    return { projects: [], engine: {}, claude: {}, agents: {} };
  }
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
    const head = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || git symbolic-ref HEAD', { cwd: targetDir, encoding: 'utf8', timeout: 5000 }).trim();
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
  return org && project && repoName
    ? `https://${org}.visualstudio.com/DefaultCollection/${project}/_git/${repoName}/pullrequest/`
    : '';
}

function buildProjectEntry({ name, description, localPath, repoHost, repositoryId, org, project, repoName, mainBranch }) {
  return {
    name,
    description: description || '',
    localPath: (localPath || '').replace(/\\/g, '/'),
    repoHost: repoHost || 'ado',
    repositoryId: repositoryId || '',
    adoOrg: org || '',
    adoProject: project || '',
    repoName: repoName || name,
    mainBranch: mainBranch || 'main',
    prUrlBase: buildPrUrlBase({ repoHost, org, project, repoName }),
    workSources: {
      pullRequests: { enabled: true, path: '.squad/pull-requests.json', cooldownMinutes: 30 },
      workItems: { enabled: true, path: '.squad/work-items.json', cooldownMinutes: 0 },
    }
  };
}

function ensureProjectStateFiles(projectPath) {
  const squadDir = path.join(projectPath, '.squad');
  if (!fs.existsSync(squadDir)) fs.mkdirSync(squadDir, { recursive: true });
  for (const f of ['pull-requests.json', 'work-items.json']) {
    const fp = path.join(squadDir, f);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, '[]');
  }
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

  console.log('\n  Link Project to Squad');
  console.log('  ─────────────────────────────');
  console.log(`  Squad home: ${SQUAD_HOME}`);
  console.log(`  Project:    ${target}\n`);

  const detected = autoDiscover(target);
  if (detected._found.length > 0) {
    console.log(`  Auto-detected: ${detected._found.join(', ')}\n`);
  }

  const name = await ask('Project name', detected.name || path.basename(target));
  const description = await ask('Description (what this repo contains/does)', detected.description || '');
  const repoHost = await ask('Repo host (ado/github)', detected.repoHost || 'ado');
  const org = await ask('Organization', detected.org || '');
  const project = await ask('Project', detected.project || '');
  const repoName = await ask('Repo name', detected.repoName || name);
  const repositoryId = await ask('Repository ID (GUID, optional)', '');
  const mainBranch = await ask('Main branch', detected.mainBranch || 'main');

  rl.close();

  config.projects.push(buildProjectEntry({ name, description, localPath: target, repoHost, repositoryId, org, project, repoName, mainBranch }));
  saveConfig(config);
  ensureProjectStateFiles(target);

  console.log(`\n  Linked "${name}" (${target})`);
  console.log(`  Total projects: ${config.projects.length}`);
  console.log(`\n  Start the squad from anywhere:`);
  console.log(`    node ${SQUAD_HOME}/engine.js         # Engine`);
  console.log(`    node ${SQUAD_HOME}/dashboard.js      # Dashboard`);
  console.log(`    node ${SQUAD_HOME}/engine.js status   # Status\n`);
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
  console.log(`\n  Squad Projects (${projects.length})\n`);
  if (projects.length === 0) {
    console.log('  No projects linked. Run: node squad.js <project-dir>\n');
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
           'Program Files (x86)', '.cache', '.npm', '.yarn', '.nuget', 'worktrees'].includes(base)) return;

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
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const scanRoot = root ? path.resolve(root) : homeDir;
  const maxDepth = depth !== undefined ? (parseInt(depth, 10) || 3) : 3;

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

  for (const repo of toAdd) {
    config.projects.push(buildProjectEntry({
      name: repo.name, description: repo.description, localPath: repo.path,
      repoHost: repo.host, org: repo.org, project: repo.project,
      repoName: repo.repoName, mainBranch: repo.mainBranch,
    }));
    ensureProjectStateFiles(repo.path);
    console.log(`  + ${repo.name} (${repo.path})`);
  }

  saveConfig(config);
  console.log(`\n  Done. ${config.projects.length} total project(s) linked.`);
  console.log(`  Run "node squad.js list" to verify.\n`);
  rl.close();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

async function initSquad({ skipScan = false, scanRoot, scanDepth } = {}) {
  const config = loadConfig();
  if (!config.projects) config.projects = [];
  if (!config.engine) config.engine = { ...ENGINE_DEFAULTS };
  if (!config.claude) config.claude = { ...DEFAULT_CLAUDE };
  if (!config.agents || Object.keys(config.agents).length === 0) {
    config.agents = { ...DEFAULT_AGENTS };
  }
  saveConfig(config);
  console.log(`\n  Squad initialized at ${SQUAD_HOME}`);
  console.log(`  Config, agents, and engine defaults created.\n`);

  if (skipScan) {
    console.log('  Skipping repo scan (--skip-scan). Run "node squad.js scan" later to link projects.\n');
    rl.close();
    return;
  }

  // Auto-chain into scan
  console.log('  Now let\'s find your repos...\n');
  await scanAndAdd({ root: scanRoot, depth: scanDepth });
}

const commands = {
  init: () => {
    const skipScanFlag = rest.includes('--skip-scan');
    const initArgs = rest.filter(arg => arg !== '--skip-scan');
    const [scanRoot, scanDepth] = initArgs;
    initSquad({ skipScan: skipScanFlag, scanRoot, scanDepth })
      .catch(e => { console.error(e); process.exit(1); });
  },
  add: () => {
    const dir = rest[0];
    if (!dir) { console.log('Usage: node squad add <project-dir>'); process.exit(1); }
    addProject(dir).catch(e => { console.error(e); process.exit(1); });
  },
  remove: () => {
    const dir = rest[0];
    if (!dir) { console.log('Usage: node squad remove <project-dir>'); process.exit(1); }
    removeProject(dir);
  },
  list: () => listProjects(),
  scan: () => scanAndAdd({ root: rest[0], depth: rest[1] })
    .catch(e => { console.error(e); process.exit(1); }),
};

if (cmd && commands[cmd]) {
  commands[cmd]();
} else {
  console.log('\n  Squad — Central AI dev team manager\n');
  console.log('  Usage: node squad <command>\n');
  console.log('  Commands:');
  console.log('    init                    Initialize squad (no projects)');
  console.log('    scan [dir] [depth]      Scan for git repos and multi-select to add');
  console.log('    add <project-dir>       Link a single project');
  console.log('    remove <project-dir>    Unlink a project');
  console.log('    list                    List linked projects\n');
  console.log('  After init, also use:');
  console.log('    node ~/.squad/engine.js          Start engine');
  console.log('    node ~/.squad/dashboard.js        Start dashboard\n');
}
