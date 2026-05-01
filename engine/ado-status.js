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
const { safeJson, safeJsonArr, projectPrPath, getProjects } = shared;

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
    '        buildStatus, buildStatusStale/detail (if stale), buildErrorLog (if failing), mergeConflict, url, project, source',
    '',
    'buildStatus values: passing | failing | running | none',
    'reviewStatus values: approved | changes-requested | waiting | pending',
  ].join('\n'));
  process.exit(1);
}

const prNumber = parseInt(prNumberArg, 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function findInCache(projects) {
  for (const project of projects) {
    const prs = safeJsonArr(projectPrPath(project));
    shared.normalizePrRecords(prs, project);
    const pr = prs.find(p => p.prNumber === prNumber || p.id === shared.getCanonicalPrId(project, prNumber) || shared.getPrDisplayId(p) === `PR-${prNumber}`);
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
    if (pr._buildStatusStale) {
      out.buildStatusStale = true;
      if (pr._buildStatusDetail) out.buildStatusDetail = pr._buildStatusDetail;
    }
    if (pr._mergeConflict) out.mergeConflict = true;
    return out;
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Use safeJson directly — pulling in queries.js would load all cached state unnecessarily
  const config = safeJson(path.join(__dirname, '..', 'config.json')) || {};
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
    const result = findInCache(projects);
    if (result) { console.log(JSON.stringify(result, null, 2)); return; }
    console.error(`PR #${prNumber} not found in cached pull-requests.json`);
    console.error('Tip: try --live for a fresh ADO API call, or check the PR number is correct.');
    process.exit(1);
  }

  // Live path: query all projects in parallel, return first match
  const ado = require('./ado');
  const settled = await Promise.allSettled(
    projects.map(p => ado.fetchSinglePrBuildStatus(p, prNumber))
  );

  const found = settled.find(r => r.status === 'fulfilled' && r.value);
  if (found) { console.log(JSON.stringify(found.value, null, 2)); return; }

  // Log unexpected errors (not 404s — those just mean PR isn't in that project)
  for (const { status, reason } of settled) {
    if (status === 'rejected' && !reason?.message?.includes('404') && !reason?.message?.includes('not found')) {
      console.error(`ADO query error: ${reason.message}`);
    }
  }

  // Fall back to cache with a note that live lookup failed
  const cached = findInCache(projects);
  if (cached) {
    cached.source = 'cached (live lookup failed — check ADO auth)';
    console.log(JSON.stringify(cached, null, 2));
    return;
  }

  console.error(`PR #${prNumber} not found (tried live ADO API and cached pull-requests.json).`);
  process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
