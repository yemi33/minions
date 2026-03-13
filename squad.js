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

  const name = await ask('Project name', path.basename(target));
  const description = await ask('Description (what this repo contains/does)', '');
  const adoOrg = await ask('ADO organization', '');
  const adoProject = await ask('ADO project', '');
  const repoName = await ask('Repo name', name);
  const repoId = await ask('ADO repository ID (GUID)', '');
  const mainBranch = await ask('Main branch', 'main');

  rl.close();

  const project = {
    name,
    description,
    localPath: target.replace(/\\/g, '/'),
    repositoryId: repoId,
    adoOrg,
    adoProject,
    repoName,
    mainBranch,
    prUrlBase: adoOrg && adoProject && repoName
      ? `https://${adoOrg}.visualstudio.com/DefaultCollection/${adoProject}/_git/${repoName}/pullrequest/`
      : '',
    workSources: {
      prd: {
        enabled: true,
        path: 'docs/prd-gaps.json',
        itemFilter: { status: ['missing', 'planned'] },
        cooldownMinutes: 30
      },
      pullRequests: {
        enabled: true,
        path: '.squad/pull-requests.json',
        cooldownMinutes: 30
      },
      workItems: {
        enabled: true,
        path: '.squad/work-items.json',
        cooldownMinutes: 0
      }
    }
  };

  config.projects.push(project);
  saveConfig(config);

  // Create project-local state files if needed
  const squadDir = path.join(target, '.squad');
  if (!fs.existsSync(squadDir)) fs.mkdirSync(squadDir, { recursive: true });

  const stateFiles = {
    'pull-requests.json': '[]',
    'work-items.json': '[]',
  };
  for (const [f, content] of Object.entries(stateFiles)) {
    const fp = path.join(squadDir, f);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  }

  console.log(`\n  Linked "${name}" (${target})`);
  console.log(`  Total projects: ${config.projects.length}`);
  console.log(`\n  Project state files created in ${squadDir}`);
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
}

function listProjects() {
  const config = loadConfig();
  const projects = config.projects || [];
  console.log(`\n  Squad Projects (${projects.length})\n`);
  if (projects.length === 0) {
    console.log('  No projects linked. Run: node squad.js <project-dir>\n');
    return;
  }
  for (const p of projects) {
    const exists = fs.existsSync(p.localPath);
    console.log(`  ${p.name}`);
    if (p.description) console.log(`    Desc: ${p.description}`);
    console.log(`    Path: ${p.localPath} ${exists ? '' : '(NOT FOUND)'}`);
    console.log(`    ADO:  ${p.adoOrg}/${p.adoProject}/${p.repoName}`);
    console.log(`    ID:   ${p.repositoryId || 'none'}`);
    console.log('');
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);

function initSquad() {
  const config = loadConfig();
  if (!config.projects) config.projects = [];
  if (!config.engine) config.engine = { tickInterval: 60000, staleThreshold: 1800000, maxConcurrent: 3, inboxConsolidateThreshold: 5, agentTimeout: 600000, maxTurns: 100 };
  if (!config.claude) config.claude = { binary: 'claude', outputFormat: 'json', allowedTools: 'Edit,Write,Read,Bash,Glob,Grep,Agent,WebFetch,WebSearch' };
  if (!config.agents || Object.keys(config.agents).length === 0) {
    config.agents = {
      ripley:  { name: 'Ripley',  emoji: '🏗️',  role: 'Lead / Explorer', skills: ['architecture', 'codebase-exploration', 'design-review'] },
      dallas:  { name: 'Dallas',  emoji: '🔧',  role: 'Engineer', skills: ['implementation', 'typescript', 'docker', 'testing'] },
      lambert: { name: 'Lambert', emoji: '📊',  role: 'Analyst', skills: ['gap-analysis', 'requirements', 'documentation'] },
      rebecca: { name: 'Rebecca', emoji: '🧠',  role: 'Architect', skills: ['system-design', 'api-design', 'scalability', 'implementation'] },
      ralph:   { name: 'Ralph',   emoji: '⚙️',   role: 'Engineer', skills: ['implementation', 'bug-fixes', 'testing', 'scaffolding'] },
    };
  }
  saveConfig(config);
  console.log(`\n  Squad initialized at ${SQUAD_HOME}`);
  console.log(`  Projects: ${config.projects.length}`);
  console.log(`\n  Add a project:`);
  console.log(`    node squad add <project-dir>\n`);
}

const commands = {
  init: () => initSquad(),
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
};

if (cmd && commands[cmd]) {
  commands[cmd]();
} else {
  console.log('\n  Squad — Central AI dev team manager\n');
  console.log('  Usage: node squad <command>\n');
  console.log('  Commands:');
  console.log('    init                    Initialize squad (no projects)');
  console.log('    add <project-dir>       Link a project');
  console.log('    remove <project-dir>    Unlink a project');
  console.log('    list                    List linked projects\n');
  console.log('  After init, also use:');
  console.log('    node ~/.squad/engine.js          Start engine');
  console.log('    node ~/.squad/dashboard.js        Start dashboard\n');
}
