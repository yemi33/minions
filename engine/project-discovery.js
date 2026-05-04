/**
 * Shared project metadata discovery for CLI and dashboard project linking.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync: defaultExecFileSync } = require('child_process');

function decodeUrlSegment(segment) {
  try { return decodeURIComponent(String(segment || '')); } catch { return String(segment || ''); }
}

function stripGitSuffix(value) {
  return String(value || '').replace(/\.git$/i, '');
}

function encodePathSegment(segment) {
  return encodeURIComponent(String(segment || '')).replace(/%2F/gi, '/');
}

function normalizeRemoteForUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (/^git@ssh\.dev\.azure\.com:/i.test(raw)) {
    return raw.replace(/^git@ssh\.dev\.azure\.com:/i, 'ssh://git@ssh.dev.azure.com/');
  }
  return raw;
}

function urlWithoutCredentials(url) {
  url.username = '';
  url.password = '';
  return url;
}

function sanitizeUrlString(value) {
  try {
    const url = urlWithoutCredentials(new URL(normalizeRemoteForUrl(value)));
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value || '').trim();
  }
}

function isAdoRemoteUrl(remoteUrl) {
  return /(dev\.azure\.com|visualstudio\.com|ssh\.dev\.azure\.com)/i.test(String(remoteUrl || ''));
}

function adoRemoteFromParts({ url, org, project, repoName, orgUrl, repoPathParts, collection = '' }) {
  const safeRepo = stripGitSuffix(repoName);
  const remoteUrl = sanitizeUrlString(`${url.origin}/${repoPathParts.join('/')}`).replace(/\.git$/i, '');
  return {
    repoHost: 'ado',
    org: decodeUrlSegment(org),
    project: decodeUrlSegment(project),
    repoName: stripGitSuffix(decodeUrlSegment(safeRepo)),
    orgUrl,
    collection,
    remoteUrl,
    prUrlBase: deriveAdoPrUrlBase({ repoUrl: remoteUrl, orgUrl, project, repoName: safeRepo }),
  };
}

function parseAdoRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw || !isAdoRemoteUrl(raw)) return null;

  let url;
  try {
    url = urlWithoutCredentials(new URL(normalizeRemoteForUrl(raw)));
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const encodedParts = url.pathname.split('/').filter(Boolean);
  const decodedParts = encodedParts.map(decodeUrlSegment);

  if (host === 'dev.azure.com') {
    const gitIndex = decodedParts.findIndex(p => p.toLowerCase() === '_git');
    if (gitIndex < 2 || !decodedParts[gitIndex + 1]) return null;
    const org = decodedParts[0];
    const project = decodedParts[1];
    const repoName = decodedParts[gitIndex + 1];
    return adoRemoteFromParts({
      url,
      org,
      project,
      repoName,
      orgUrl: `https://dev.azure.com/${encodePathSegment(org)}`,
      repoPathParts: encodedParts.slice(0, gitIndex + 2),
    });
  }

  if (host.endsWith('.visualstudio.com')) {
    const org = host.slice(0, -'.visualstudio.com'.length);
    let offset = 0;
    let collection = '';
    if ((decodedParts[0] || '').toLowerCase() === 'defaultcollection') {
      offset = 1;
      collection = 'DefaultCollection';
    }
    const gitIndex = decodedParts.findIndex((p, i) => i >= offset && p.toLowerCase() === '_git');
    if (gitIndex < offset + 1 || !decodedParts[gitIndex + 1]) return null;
    const project = decodedParts[offset];
    const repoName = decodedParts[gitIndex + 1];
    const orgUrl = collection
      ? `https://${org}.visualstudio.com/${collection}`
      : `https://${org}.visualstudio.com`;
    return adoRemoteFromParts({
      url,
      org,
      project,
      repoName,
      orgUrl,
      repoPathParts: encodedParts.slice(0, gitIndex + 2),
      collection,
    });
  }

  if (host === 'ssh.dev.azure.com') {
    if ((decodedParts[0] || '').toLowerCase() !== 'v3' || decodedParts.length < 4) return null;
    const [, org, project, repoName] = decodedParts;
    const orgUrl = `https://dev.azure.com/${encodePathSegment(org)}`;
    return {
      repoHost: 'ado',
      org,
      project,
      repoName: stripGitSuffix(repoName),
      orgUrl,
      collection: '',
      remoteUrl: `https://dev.azure.com/${encodePathSegment(org)}/${encodePathSegment(project)}/_git/${encodePathSegment(stripGitSuffix(repoName))}`,
      prUrlBase: deriveAdoPrUrlBase({ orgUrl, project, repoName }),
    };
  }

  return null;
}

function parseGitHubRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  const match = raw.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (!match) return null;
  return {
    repoHost: 'github',
    org: decodeUrlSegment(match[1]),
    repoName: stripGitSuffix(decodeUrlSegment(match[2])),
  };
}

function deriveAdoPrUrlBase({ repoUrl, orgUrl, project, repoName }) {
  const candidate = sanitizeUrlString(repoUrl || '');
  if (candidate && /\/_git\//i.test(candidate)) {
    return `${candidate.replace(/\.git$/i, '').replace(/\/$/, '')}/pullrequest/`;
  }
  if (orgUrl && project && repoName) {
    return `${String(orgUrl).replace(/\/$/, '')}/${encodePathSegment(project)}/_git/${encodePathSegment(stripGitSuffix(repoName))}/pullrequest/`;
  }
  return '';
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  return JSON.parse(text);
}

function normalizeAzRepoResult(repo, fallback) {
  if (!repo || typeof repo !== 'object') return null;
  const repoUrl = repo.webUrl || repo.remoteUrl || fallback.remoteUrl || '';
  const parsedUrl = parseAdoRemoteUrl(repoUrl);
  const project = repo.project?.name || parsedUrl?.project || fallback.project || '';
  const repoName = repo.name || parsedUrl?.repoName || fallback.repoName || '';
  const org = parsedUrl?.org || fallback.org || '';
  const orgUrl = parsedUrl?.orgUrl || fallback.orgUrl || '';
  return {
    ...fallback,
    ...(parsedUrl || {}),
    org,
    orgUrl,
    project,
    repoName,
    repositoryId: String(repo.id || fallback.repositoryId || '').trim(),
    remoteUrl: repoUrl || parsedUrl?.remoteUrl || fallback.remoteUrl || '',
    prUrlBase: deriveAdoPrUrlBase({ repoUrl, orgUrl, project, repoName }) || parsedUrl?.prUrlBase || fallback.prUrlBase || '',
  };
}

function runAzJson(execFileSync, args, timeoutMs) {
  return parseJsonOutput(execFileSync('az', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }));
}

function resolveAdoRemoteMetadata(remote, options = {}) {
  if (!remote) return null;
  const execFileSync = options.execFileSync || defaultExecFileSync;
  const timeoutMs = options.adoLookupTimeoutMs || 10000;
  if (options.resolveAdo !== false && remote.orgUrl && remote.project && remote.repoName) {
    const baseArgs = [
      'repos', 'show',
      '--repository', remote.repoName,
      '--organization', remote.orgUrl,
      '--project', remote.project,
      '--output', 'json',
    ];
    try {
      const repo = runAzJson(execFileSync, baseArgs, timeoutMs);
      const normalized = normalizeAzRepoResult(repo, remote);
      if (normalized) return normalized;
    } catch { /* fall back to parsed remote metadata */ }

    try {
      const repos = runAzJson(execFileSync, [
        'repos', 'list',
        '--organization', remote.orgUrl,
        '--project', remote.project,
        '--output', 'json',
      ], timeoutMs);
      const match = Array.isArray(repos)
        ? repos.find(repo => {
          const name = String(repo?.name || '').toLowerCase();
          const parsed = parseAdoRemoteUrl(repo?.remoteUrl || repo?.webUrl || '');
          return name === String(remote.repoName || '').toLowerCase()
            || parsed?.remoteUrl === remote.remoteUrl
            || parsed?.repoName?.toLowerCase() === String(remote.repoName || '').toLowerCase();
        })
        : null;
      const normalized = normalizeAzRepoResult(match, remote);
      if (normalized) return normalized;
    } catch { /* fall back to parsed remote metadata */ }
  }
  return { ...remote, repositoryId: remote.repositoryId || '', prUrlBase: remote.prUrlBase || deriveAdoPrUrlBase(remote) };
}

function execGit(execFileSync, targetDir, args, timeout = 5000) {
  return String(execFileSync('git', args, {
    cwd: targetDir,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })).trim();
}

function discoverProjectMetadata(targetDir, options = {}) {
  const execFileSync = options.execFileSync || defaultExecFileSync;
  const result = { _found: [] };

  try {
    let head = '';
    try {
      head = execGit(execFileSync, targetDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    } catch {
      head = execGit(execFileSync, targetDir, ['symbolic-ref', 'HEAD']);
    }
    const branch = head.replace('refs/remotes/origin/', '').replace('refs/heads/', '');
    if (branch) {
      result.mainBranch = branch;
      result._found.push('main branch');
    }
  } catch {}

  try {
    const remoteUrl = execGit(execFileSync, targetDir, ['remote', 'get-url', 'origin']);
    const github = parseGitHubRemoteUrl(remoteUrl);
    if (github) {
      Object.assign(result, github);
      result._found.push('GitHub remote');
    } else {
      const adoRemote = parseAdoRemoteUrl(remoteUrl);
      if (adoRemote) {
        const ado = resolveAdoRemoteMetadata(adoRemote, options);
        Object.assign(result, ado);
        result._found.push(ado.repositoryId ? 'Azure DevOps remote + repository metadata' : 'Azure DevOps remote');
      }
    }
  } catch {}

  try {
    const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
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

  try {
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        result.name = pkg.name.replace(/^@[^/]+\//, '');
        result._found.push('name from package.json');
      }
      if (!result.description && pkg.description) result.description = String(pkg.description).slice(0, 200);
    }
  } catch {}

  return result;
}

function buildPrUrlBase({ repoHost, org, project, repoName, prUrlBase }) {
  if (prUrlBase) return prUrlBase;
  if (repoHost === 'github') {
    return org && repoName ? `https://github.com/${org}/${repoName}/pull/` : '';
  }
  if (repoHost === 'ado' && org && project && repoName) {
    return `https://dev.azure.com/${org}/${encodePathSegment(project)}/_git/${encodePathSegment(repoName)}/pullrequest/`;
  }
  return '';
}

function buildProjectEntry({ name, description, localPath, repoHost, repositoryId, org, project, repoName, mainBranch, prUrlBase }) {
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
    prUrlBase: buildPrUrlBase({ repoHost, org, project, repoName, prUrlBase }),
    workSources: {
      pullRequests: { enabled: true, cooldownMinutes: 30 },
      workItems: { enabled: true, cooldownMinutes: 0 },
    },
  };
}

function buildScanResult(repoPath, detected = {}, linked = false) {
  return {
    path: repoPath.replace(/\\/g, '/'),
    name: detected.name || detected.repoName || path.basename(repoPath),
    host: detected.repoHost || 'git',
    org: detected.org || '',
    project: detected.project || '',
    repoName: detected.repoName || path.basename(repoPath),
    repositoryId: detected.repositoryId || '',
    mainBranch: detected.mainBranch || 'main',
    description: detected.description || '',
    prUrlBase: detected.prUrlBase || '',
    linked,
  };
}

module.exports = {
  parseAdoRemoteUrl,
  parseGitHubRemoteUrl,
  resolveAdoRemoteMetadata,
  discoverProjectMetadata,
  buildPrUrlBase,
  buildProjectEntry,
  buildScanResult,
};
