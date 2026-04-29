/**
 * engine/issues.js — GitHub issue creation helpers.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync: _execFileSync } = require('child_process');

const DEFAULT_REPO = 'yemi33/minions';
const DEFAULT_LABELS = ['bug'];

class GitHubIssueError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = 'GitHubIssueError';
    this.statusCode = statusCode;
  }
}

function normalizeLabels(labels, defaultLabels = DEFAULT_LABELS) {
  let raw;
  if (labels == null) raw = defaultLabels;
  else if (Array.isArray(labels)) raw = labels;
  else if (typeof labels === 'string') raw = labels.split(',');
  else raw = [];

  const seen = new Set();
  const out = [];
  for (const label of raw) {
    const value = String(label || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function ghMessage(err) {
  if (!err) return '';
  return [err.message, err.stdout, err.stderr]
    .filter(Boolean)
    .map(String)
    .join('\n');
}

function conciseGhMessage(errOrText) {
  const text = typeof errOrText === 'string' ? errOrText : ghMessage(errOrText);
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function isAuthError(errOrText) {
  return /(authentication|auth login|not authenticated|bad credentials|http 401|requires authentication)/i.test(
    typeof errOrText === 'string' ? errOrText : ghMessage(errOrText)
  );
}

function isLabelUnavailableError(errOrText) {
  const msg = typeof errOrText === 'string' ? errOrText : ghMessage(errOrText);
  return /label/i.test(msg) && /(not found|not exist|unavailable|invalid|could not add|could not resolve|does not exist)/i.test(msg);
}

function extractIssueUrl(output) {
  const match = String(output || '').match(/https:\/\/github\.com\/\S+\/issues\/\d+/);
  return match ? match[0] : null;
}

function runGh(execFileSync, args, timeout) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
}

function listRepoLabels({ repo, execFileSync }) {
  const output = runGh(execFileSync, ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000'], 15000);
  const parsed = JSON.parse(output || '[]');
  if (!Array.isArray(parsed)) {
    throw new GitHubIssueError('GitHub label list returned an unexpected response shape');
  }
  const labelsByLower = new Map();
  for (const item of parsed) {
    if (!item || typeof item.name !== 'string') continue;
    labelsByLower.set(item.name.toLowerCase(), item.name);
  }
  return labelsByLower;
}

function resolveLabels({ labels, repo, execFileSync }) {
  const requested = normalizeLabels(labels);
  if (requested.length === 0) {
    return { requested, labelsToApply: [], labelsSkipped: [], validationUnavailable: false };
  }

  try {
    const available = listRepoLabels({ repo, execFileSync });
    const labelsToApply = [];
    const labelsSkipped = [];
    for (const label of requested) {
      const matched = available.get(label.toLowerCase());
      if (matched) labelsToApply.push(matched);
      else labelsSkipped.push(label);
    }
    return { requested, labelsToApply, labelsSkipped, validationUnavailable: false };
  } catch (e) {
    if (e instanceof GitHubIssueError) throw e;
    if (isAuthError(e)) throw new GitHubIssueError('GitHub auth required. Run: gh auth login', 401);
    return { requested, labelsToApply: requested, labelsSkipped: [], validationUnavailable: true };
  }
}

function buildWarning(labelsSkipped, filedWithoutLabels) {
  if (!labelsSkipped.length) return undefined;
  const base = `Skipped unavailable GitHub label(s): ${labelsSkipped.join(', ')}.`;
  return filedWithoutLabels ? `${base} Filed without labels.` : base;
}

function createIssueWithLabels({ title, bodyFile, repo, labels, execFileSync }) {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile];
  if (labels.length > 0) args.push('--label', labels.join(','));
  const output = runGh(execFileSync, args, 30000);
  const url = extractIssueUrl(output);
  if (!url) {
    throw new GitHubIssueError(`Issue may not have been created: ${conciseGhMessage(output)}`);
  }
  return { url, output: String(output || '').trim() };
}

function createGitHubIssue({
  title,
  description = '',
  labels,
  repo = DEFAULT_REPO,
  tmpDir,
  execFileSync = _execFileSync,
} = {}) {
  if (!title) throw new GitHubIssueError('title required', 400);

  try {
    runGh(execFileSync, ['--version'], 5000);
  } catch (e) {
    throw new GitHubIssueError('gh CLI not found. Install from https://cli.github.com/');
  }

  const issueBody = `${description || ''}\n\n---\n_Filed via Minions dashboard_`;
  const dir = tmpDir || path.join(__dirname, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const bodyFile = path.join(dir, `bug-body-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(bodyFile, issueBody);

  let resolved;
  try {
    resolved = resolveLabels({ labels, repo, execFileSync });
    const created = createIssueWithLabels({
      title,
      bodyFile,
      repo,
      labels: resolved.labelsToApply,
      execFileSync,
    });
    const filedWithoutLabels = resolved.requested.length > 0 && resolved.labelsToApply.length === 0;
    return {
      ok: true,
      url: created.url,
      output: created.output,
      labelsRequested: resolved.requested,
      labelsApplied: resolved.labelsToApply,
      labelsSkipped: resolved.labelsSkipped,
      warning: buildWarning(resolved.labelsSkipped, filedWithoutLabels),
    };
  } catch (e) {
    if (e instanceof GitHubIssueError) throw e;
    if (isAuthError(e)) throw new GitHubIssueError('GitHub auth required. Run: gh auth login', 401);
    if (resolved && resolved.labelsToApply.length > 0 && isLabelUnavailableError(e)) {
      try {
        const created = createIssueWithLabels({ title, bodyFile, repo, labels: [], execFileSync });
        const skipped = normalizeLabels([...resolved.labelsSkipped, ...resolved.labelsToApply], []);
        return {
          ok: true,
          url: created.url,
          output: created.output,
          labelsRequested: resolved.requested,
          labelsApplied: [],
          labelsSkipped: skipped,
          warning: buildWarning(skipped, true),
        };
      } catch (retryErr) {
        if (isAuthError(retryErr)) throw new GitHubIssueError('GitHub auth required. Run: gh auth login', 401);
        throw new GitHubIssueError(`GitHub issue creation failed after retrying without labels: ${conciseGhMessage(retryErr)}`);
      }
    }
    throw new GitHubIssueError(`GitHub issue creation failed: ${conciseGhMessage(e)}`);
  } finally {
    try { fs.unlinkSync(bodyFile); } catch {}
  }
}

module.exports = {
  DEFAULT_LABELS,
  GitHubIssueError,
  normalizeLabels,
  isLabelUnavailableError,
  createGitHubIssue,
};
