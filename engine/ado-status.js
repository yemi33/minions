#!/usr/bin/env node
/**
 * engine/ado-status.js — CLI shim for querying PR and build status.
 *
 * Agents steered to "check on the builds" or "is CI green for PR #123" should
 * use this instead of raw curl + azureauth calls. All ADO auth and retry logic
 * is handled by ado.js internally.
 *
 * Usage:
 *   node engine/ado-status.js <prNumber>
 *   node engine/ado-status.js <prNumber> --live
 *   node engine/ado-status.js <prNumber> --project MyProject
 *   node engine/ado-status.js <prNumber> --live --project MyProject
 *
 * Output: JSON to stdout. Exit 0 on success, 1 on error/not-found.
 *
 * Cached (default): reads pull-requests.json maintained by the engine (~3 min stale).
 * Live (--live):    makes fresh ADO API calls — use when engine isn't running or you
 *                   just pushed and need up-to-the-moment build status.
 */

'use strict';

const path = require('path');
const shared = require('./shared');
const { safeJsonArr, projectPrPath, getProjects } = shared;

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const prNumberArg = args.find(a => /^\d+$/.test(a));
const live = args.includes('--live');
const projectIdx = args.indexOf('--project');
const projectName = projectIdx >= 0 ? args[projectIdx + 1] : null;

if (!prNumberArg) {
  console.error([
    'Usage: node engine/ado-status.js <prNumber> [--live] [--project <name>]',
    '',
    '  <prNumber>          PR number to look up (required)',
    '  --live              Make a fresh ADO API call instead of reading cached state',
    '  --project <name>    Scope search to one project (optional)',
    '',
    'Output: JSON with fields: prNumber, title, branch, status, reviewStatus,',
    '        buildStatus, buildErrorLog (if failing), mergeConflict, url, project, source',
    '',
    'buildStatus values: passing | failing | running | none',
    'reviewStatus values: approved | changes-requested | waiting | pending',
  ].join('\n'));
  process.exit(1);
}

const prNumber = parseInt(prNumberArg, 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig() {
  // Avoid pulling in queries.js to keep startup fast; read config directly.
  const configPath = path.join(__dirname, '..', 'config.json');
  try { return JSON.parse(require('fs').readFileSync(configPath, 'utf8')); }
  catch { return {}; }
}

function findInCache(projects) {
  for (const project of projects) {
    const prs = safeJsonArr(projectPrPath(project));
    const pr = prs.find(p => p.prNumber === prNumber || p.id === `PR-${prNumber}`);
    if (!pr) continue;
    const out = {
      prNumber: pr.prNumber || prNumber,
      id: pr.id,
      title: pr.title || '',
      branch: pr.branch || '',
      status: pr.status || 'unknown',
      reviewStatus: pr.reviewStatus || 'pending',
      buildStatus: pr.buildStatus || 'none',
      url: pr.url || '',
      project: project.name,
      source: 'cached',
    };
    if (pr.buildErrorLog) out.buildErrorLog = pr.buildErrorLog;
    if (pr._mergeConflict) out.mergeConflict = true;
    return out;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = getConfig();
  const allProjects = getProjects(config).filter(p => p.repoHost === 'ado' || !p.repoHost);
  const projects = projectName
    ? allProjects.filter(p => p.name === projectName)
    : allProjects;

  if (projects.length === 0) {
    const msg = projectName
      ? `Project "${projectName}" not found in config.json`
      : 'No ADO projects configured in config.json';
    console.error(msg);
    process.exit(1);
  }

  if (!live) {
    // Fast path: read engine-maintained pull-requests.json
    const result = findInCache(projects);
    if (result) { console.log(JSON.stringify(result, null, 2)); return; }
    console.error(`PR #${prNumber} not found in cached pull-requests.json`);
    console.error('Tip: try --live for a fresh ADO API call, or check the PR number is correct.');
    process.exit(1);
  }

  // Live path: call ADO API via ado.js (handles auth, retry, circuit breaking)
  const ado = require('./ado');

  // Try each project until we find the PR
  for (const project of projects) {
    try {
      const result = await ado.fetchSinglePrBuildStatus(project, prNumber);
      if (result) { console.log(JSON.stringify(result, null, 2)); return; }
    } catch (e) {
      // 404 or similar — PR not in this project, try the next one
      if (!e.message?.includes('404') && !e.message?.includes('not found')) {
        console.error(`Error querying ${project.name}: ${e.message}`);
      }
    }
  }

  // Live lookup failed — fall back to cache
  const cached = findInCache(projects);
  if (cached) {
    cached._liveFailed = true;
    cached.source = 'cached (live lookup failed — check ADO auth)';
    console.log(JSON.stringify(cached, null, 2));
    return;
  }

  console.error(`PR #${prNumber} not found (tried live ADO API and cached pull-requests.json).`);
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
