/**
 * engine/ado.js — Azure DevOps integration for Minions engine.
 * Extracted from engine.js: ADO token management, PR status polling, human comment polling.
 */

const path = require('path');
const shared = require('./shared');
const { exec, execAsync, getAdoOrgBase, log, ts, dateStamp, PR_STATUS, createThrottleTracker } = shared;
const { getPrs } = require('./queries');
const { mutateJsonFileLocked } = shared;

// Lazy require to avoid circular dependency — only needed for engine().handlePostMerge
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// Lazy require for dispatch module (avoids circular dependency via engine)
let _dispatch = null;
function dispatchModule() { if (!_dispatch) _dispatch = require('./dispatch'); return _dispatch; }

const stripRefsHeads = s => (s || '').replace('refs/heads/', '');
const getAdoPrUrl = (project, prNumber) => {
  if (project.prUrlBase) return `${project.prUrlBase}${prNumber}`;
  const repoPath = encodeURIComponent(project.repoName || project.repositoryId || '');
  return `https://dev.azure.com/${project.adoOrg}/${project.adoProject}/_git/${repoPath}/pullrequest/${prNumber}`;
};
const ADO_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGitHubProject(project) {
  return String(project?.repoHost || '').toLowerCase() === 'github';
}

function isAdoGuid(value) {
  return ADO_GUID_RE.test(String(value || '').trim());
}

function getAdoRepositoryLookupKey(project) {
  const repositoryId = String(project?.repositoryId || '').trim();
  if (repositoryId) return repositoryId;
  return String(project?.repoName || '').trim();
}

function getAdoRepositoryId(project) {
  return getAdoRepositoryLookupKey(project);
}

function getConfiguredAdoRepositoryGuid(project) {
  const repositoryId = String(project?.repositoryId || '').trim();
  return isAdoGuid(repositoryId) ? repositoryId : '';
}

function getAdoProjectLabel(project) {
  return project?.name || project?.repoName || `${project?.adoOrg || 'unknown-org'}/${project?.adoProject || 'unknown-project'}`;
}

function logMissingAdoRepository(project, purpose) {
  log('error', `${purpose} disabled for project ${getAdoProjectLabel(project)}: missing project.repositoryId and project.repoName; configure one so Azure DevOps repository API calls can target the repo`);
}

function adoConfigPath() {
  return path.join(shared.MINIONS_DIR, 'config.json');
}

function sameAdoProject(a, b) {
  if (!a || !b) return false;
  if (a.name && b.name && a.name === b.name) return true;
  if (a.localPath && b.localPath && path.resolve(a.localPath) === path.resolve(b.localPath)) return true;
  return String(a.adoOrg || '') === String(b.adoOrg || '')
    && String(a.adoProject || '') === String(b.adoProject || '')
    && String(a.repoName || '') === String(b.repoName || '')
    && String(a.repoHost || 'ado').toLowerCase() === String(b.repoHost || 'ado').toLowerCase();
}

function persistAdoRepositoryGuid(project, guid, repoName) {
  if (!isAdoGuid(guid)) return;
  const previous = String(project?.repositoryId || '').trim();
  project.repositoryId = guid;
  if (!project.repoName && repoName) project.repoName = repoName;
  if (previous === guid) return;

  try {
    let persisted = false;
    mutateJsonFileLocked(adoConfigPath(), (config) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
      if (!Array.isArray(config.projects)) return config;
      const target = config.projects.find(p => sameAdoProject(p, project));
      if (!target) return config;
      target.repositoryId = guid;
      if (!target.repoName && repoName) target.repoName = repoName;
      persisted = true;
      return config;
    }, { defaultValue: { projects: [] }, skipWriteIfUnchanged: true });
    if (persisted) {
      log('info', `Resolved ADO repository GUID for ${getAdoProjectLabel(project)}: ${previous || project.repoName || 'unknown'} → ${guid}`);
    } else {
      log('warn', `Resolved ADO repository GUID for ${getAdoProjectLabel(project)} but could not find the project in config.json to persist it`);
    }
  } catch (e) {
    log('warn', `Resolved ADO repository GUID for ${getAdoProjectLabel(project)} but failed to persist it: ${e.message}`);
  }
}

async function resolveAdoBuildRepositoryGuid(project, token, orgBase, purpose, opts = {}) {
  const configured = getConfiguredAdoRepositoryGuid(project);
  if (configured) return configured;

  const lookupKey = getAdoRepositoryLookupKey(project);
  if (!lookupKey) {
    logMissingAdoRepository(project, purpose);
    return null;
  }

  try {
    const repoUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodeURIComponent(lookupKey)}?api-version=7.1`;
    const repoData = await adoFetch(repoUrl, token, opts);
    const guid = String(repoData?.id || '').trim();
    if (!isAdoGuid(guid)) {
      log('error', `${purpose} disabled for project ${getAdoProjectLabel(project)}: ADO repository lookup for "${lookupKey}" did not return a repository GUID`);
      return null;
    }
    persistAdoRepositoryGuid(project, guid, repoData?.name || project.repoName || '');
    return guid;
  } catch (e) {
    log('warn', `${purpose} could not resolve repository GUID for project ${getAdoProjectLabel(project)} from "${lookupKey}": ${e.message}`);
    return null;
  }
}

function markBuildStatusStale(pr, detail) {
  pr._buildStatusStale = true;
  if (detail) pr._buildStatusDetail = detail;
}

function clearBuildStatusStale(pr) {
  if (pr._buildStatusStale) delete pr._buildStatusStale;
  if (pr._buildStatusDetail) delete pr._buildStatusDetail;
}

function applyAdoPrMetadata(pr, prData) {
  if (!pr || !prData) return false;
  let updated = false;

  const sourceBranch = stripRefsHeads(prData.sourceRefName);
  if (sourceBranch && (pr.branch !== sourceBranch || pr._branchResolutionError || pr._pendingReason === shared.PR_PENDING_REASON.MISSING_BRANCH)) {
    pr.branch = sourceBranch;
    if (pr._branchResolutionError) delete pr._branchResolutionError;
    if (pr._pendingReason === shared.PR_PENDING_REASON.MISSING_BRANCH) delete pr._pendingReason;
    updated = true;
  }

  const title = String(prData.title || '').trim();
  const storedTitle = title.slice(0, 120);
  if (storedTitle && pr.title !== storedTitle) {
    pr.title = storedTitle;
    updated = true;
  }

  const description = typeof prData.description === 'string' ? prData.description : '';
  if (description && (pr.description == null || pr.description === '')) {
    pr.description = description.slice(0, 500);
    updated = true;
  }

  const author = String(prData.createdBy?.displayName || '').trim();
  if (author && pr.agent === 'human') {
    pr.agent = author;
    updated = true;
  }

  return updated;
}

// ── Build/Review Status Helpers ───────────────────────────────────────────────

/** Classify an array of ADO build records into a single status string. */
function classifyBuildStatus(prBuilds) {
  if (!prBuilds.length) return 'none';
  // partiallySucceeded = warnings, not failures — counts as passing
  const hasFailed = prBuilds.some(b => b.result === 'failed' || b.result === 'canceled');
  const allDone = prBuilds.every(b => b.status === 'completed');
  const allPassed = prBuilds.every(b => b.result === 'succeeded' || b.result === 'partiallySucceeded');
  const hasRunning = prBuilds.some(b => b.status === 'inProgress' || b.status === 'notStarted');
  if (hasFailed && allDone) return 'failing';
  if (allDone && allPassed) return 'passing';
  if (hasRunning) return 'running';
  return 'none';
}

/** Map ADO reviewer vote array to a review status string. */
function votesToReviewStatus(votes) {
  if (votes.some(v => v === -10)) return 'changes-requested';
  if (votes.some(v => v >= 5)) return 'approved';
  if (votes.some(v => v === -5)) return 'waiting';
  return 'pending';
}

// ─── ADO Token Cache ─────────────────────────────────────────────────────────

let _adoTokenCache = { token: null, expiresAt: 0 };
let _adoTokenFailedUntil = 0; // backoff: skip azureauth calls until this timestamp

// ─── ADO Throttle State ─────────────────────────────────────────────────────
// Tracks rate-limiting (HTTP 429/503) from ADO API responses.
// Uses shared createThrottleTracker factory: backoffMs starts at 60s, doubles, caps at 32 min.
const _adoThrottle = createThrottleTracker({ label: 'ado', baseBackoffMs: 60000, maxBackoffMs: 32 * 60000 });

// ─── Auth Failure Tracking ──────────────────────────────────────────────────
// Set when pollPrStatus encounters auth errors mid-loop. The engine checks this
// to bypass the normal 6-tick cadence and re-poll on the next tick.
let _adoPollHadAuthFailure = false;

/** Check if auth failure during PR poll means an early re-poll is needed. */
function needsAdoPollRetry() { return _adoPollHadAuthFailure; }

/** Detect auth-related errors from adoFetch (HTML redirect, 401, 403). */
function isAdoAuthError(err) {
  const msg = err?.message || '';
  return msg.includes('auth redirect') || msg.includes('HTML instead of JSON') || /ADO API (401|403)/.test(msg);
}

async function getAdoToken() {
  if (_adoTokenCache.token && Date.now() < _adoTokenCache.expiresAt) {
    return _adoTokenCache.token;
  }
  // If recent fetch failed, don't retry until backoff expires (avoids repeated browser popups)
  if (Date.now() < _adoTokenFailedUntil) return null;
  try {
    // azureauth supports multiple --mode flags as an ordered fallback chain:
    // tries IWA (Integrated Windows Auth) first, falls back to broker if unavailable.
    // Uses execAsync to avoid blocking the event loop on Windows (spawnSync ETIMEDOUT).
    const token = (await execAsync('azureauth ado token --mode iwa --mode broker --output token --timeout 1', {
      timeout: 15000, encoding: 'utf-8', windowsHide: true    })).trim();
    if (token && token.startsWith('eyJ')) {
      _adoTokenCache = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
      _adoTokenFailedUntil = 0;
      return token;
    }
  } catch (e) {
    log('warn', `Failed to get ADO token: ${e.message}`);
  }
  // Back off for 10 minutes to avoid spamming browser auth popups
  _adoTokenFailedUntil = Date.now() + 10 * 60 * 1000;
  return null;
}

async function adoFetch(url, token, opts = {}) {
  const _retryCount = typeof opts === 'number' ? opts : (opts._retryCount || 0); // backward compat
  const method = (typeof opts === 'object' && opts.method) || 'GET';
  const body = (typeof opts === 'object' && opts.body) || undefined;
  const timeout = (typeof opts === 'object' && Number.isFinite(opts.timeout)) ? opts.timeout : 30000;
  const MAX_RETRIES = 1;
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
    body,
  });
  // ── Throttle detection: intercept 429/503 BEFORE generic !res.ok ──
  if (res.status === 429 || res.status === 503) {
    const retryAfterSec = parseInt(res.headers.get('Retry-After'), 10);
    const retryAfterMs = (retryAfterSec > 0) ? retryAfterSec * 1000 : 0;
    _adoThrottle.recordThrottle(retryAfterMs);
    const state = _adoThrottle.getState();
    throw new Error(`ADO API throttled (${res.status}): retry after ${Math.round((state.retryAfter - Date.now()) / 1000)}s`);
  }
  if (!res.ok) throw new Error(`ADO API ${method} ${res.status}: ${res.statusText}`);
  const text = await res.text();
  if (!text || text.trimStart().startsWith('<')) {
    _adoTokenCache = { token: null, expiresAt: 0 };
    if (_retryCount < MAX_RETRIES) {
      const freshToken = await getAdoToken();
      if (freshToken) {
        log('info', 'ADO token expired mid-session — refreshed and retrying');
        return adoFetch(url, freshToken, { ...opts, _retryCount: _retryCount + 1 });
      }
    }
    throw new Error(`ADO returned HTML instead of JSON (likely auth redirect) for ${url.split('?')[0]}`);
  }
  const json = JSON.parse(text);
  // ── Success decay: decrement consecutiveHits, reset when fully recovered ──
  _adoThrottle.recordSuccess();
  return json;
}

/** Fetch raw text from ADO API (for build logs which aren't JSON). */
async function adoFetchText(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  // ── Throttle detection: intercept 429/503 BEFORE generic !res.ok ──
  if (res.status === 429 || res.status === 503) {
    const retryAfterSec = parseInt(res.headers.get('Retry-After'), 10);
    const retryAfterMs = (retryAfterSec > 0) ? retryAfterSec * 1000 : 0;
    _adoThrottle.recordThrottle(retryAfterMs);
    const state = _adoThrottle.getState();
    throw new Error(`ADO API throttled (${res.status}): retry after ${Math.round((state.retryAfter - Date.now()) / 1000)}s`);
  }
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  return res.text();
}

const BUILD_ERROR_LOG_MAX_LINES = 150;

/**
 * Fetch actual build/compiler error logs from ADO when a build fails.
 * Extracts buildId from the failed status's targetUrl, queries the build timeline
 * for failed tasks, and fetches their logs.
 * Returns truncated log text or null if unavailable.
 */
async function fetchAdoBuildErrorLog(orgBase, project, failedStatus, token, pr, seenBuildIds) {
  try {
    // Use pre-resolved buildId if available (from builds API query), else parse from targetUrl
    let buildId = failedStatus?._buildId || null;
    if (!buildId) {
      const targetUrl = failedStatus?.targetUrl || '';
      const buildIdMatch = targetUrl.match(/buildId=(\d+)/);
      if (buildIdMatch) buildId = buildIdMatch[1];
    }
    if (!buildId) {
      // Fallback: query recent failed builds for this PR's source branch
      try {
        const branch = pr?.branch || stripRefsHeads(pr?.sourceRefName);
        if (branch) {
          const buildsUrl = `${orgBase}/${project.adoProject}/_apis/build/builds?branchName=refs/heads/${encodeURIComponent(branch)}&statusFilter=completed&resultFilter=failed&$top=3&api-version=7.1`;
          const builds = await adoFetch(buildsUrl, token);
          const fresh = (builds?.value || []).find(b => !seenBuildIds?.has(String(b.id)));
          if (fresh?.id) {
            buildId = String(fresh.id);
            log('debug', `Found buildId ${buildId} via branch query for ${branch}`);
          }
        }
      } catch (e) { log('debug', `Branch-based build lookup failed: ${e.message}`); }
    }
    if (!buildId) {
      log('debug', `No buildId from targetUrl or branch query: ${targetUrl.slice(0, 120)}`);
      return null;
    }
    if (seenBuildIds?.has(buildId)) return null; // already fetched this build
    if (seenBuildIds) seenBuildIds.add(buildId);

    // Fetch build timeline to find failed tasks
    const timelineUrl = `${orgBase}/${project.adoProject}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
    const timeline = await adoFetch(timelineUrl, token);
    if (!timeline?.records) return null;

    // Find failed records that have logs
    const failedRecords = timeline.records.filter(r =>
      r.result === 'failed' && r.log?.id
    );
    if (failedRecords.length === 0) return null;

    // Fetch logs for failed tasks (cap at 10 to cover multi-stage pipelines)
    const logParts = [];
    for (const record of failedRecords.slice(0, 10)) {
      try {
        const logUrl = `${orgBase}/${project.adoProject}/_apis/build/builds/${buildId}/logs/${record.log.id}?api-version=7.1`;
        const text = await adoFetchText(logUrl, token);
        if (text) {
          logParts.push(`--- ${record.name || 'Task'} ---\n${text}`);
        }
      } catch { /* skip individual log fetch failures */ }
    }

    if (logParts.length === 0) return null;

    // Join and truncate to last N lines
    const combined = logParts.join('\n\n');
    const lines = combined.split('\n');
    if (lines.length > BUILD_ERROR_LOG_MAX_LINES) {
      return `... (truncated, showing last ${BUILD_ERROR_LOG_MAX_LINES} lines)\n` +
        lines.slice(-BUILD_ERROR_LOG_MAX_LINES).join('\n');
    }
    return combined;
  } catch (e) {
    log('warn', `Failed to fetch ADO build error log: ${e.message}`);
    return null;
  }
}

// ─── Shared PR Polling Loop ──────────────────────────────────────────────────

/**
 * Iterate active PRs across all projects. Calls `callback(project, pr, prNum, orgBase, adoRepositoryId)`
 * for each active PR. If callback returns truthy, the PR file is saved after the project loop.
 */
async function forEachActivePr(config, token, callback) {
  const projects = shared.getProjects(config);
  let totalUpdated = 0;

  for (const project of projects) {
    if (isGitHubProject(project)) continue;
    if (!project.adoOrg || !project.adoProject) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => shared.PR_POLLABLE_STATUSES.has(pr.status)
      && shared.isPrCompatibleWithProject(project, pr, pr.url || ''));
    if (activePrs.length === 0) continue;

    const adoRepositoryId = getAdoRepositoryId(project);
    if (!adoRepositoryId) {
      logMissingAdoRepository(project, 'ADO PR polling');
      continue;
    }

    let projectUpdated = 0;
    const updatedRecords = [];
    const orgBase = getAdoOrgBase(project);

    // Parallelize PR polling within each project (max 5 concurrent to avoid rate limits)
    const CONCURRENCY = 5;
    for (let i = 0; i < activePrs.length; i += CONCURRENCY) {
      const batch = activePrs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (pr) => {
        const prNum = shared.getPrNumber(pr);
        if (!prNum) return false;
        const before = shared.snapshotPrRecord(pr);
        const updated = await callback(project, pr, prNum, orgBase, adoRepositoryId);
        if (updated) return { before, after: shared.snapshotPrRecord(pr) };
        return false;
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          projectUpdated++;
          updatedRecords.push(r.value);
        }
        if (r.status === 'rejected') log('warn', `PR poll error: ${r.reason?.message || r.reason}`);
      }
    }

    if (projectUpdated > 0) {
      mutateJsonFileLocked(shared.projectPrPath(project), (currentPrs) => {
        // Merge back only fields changed by callbacks; preserve concurrent disk updates.
        for (const { before, after } of updatedRecords) {
          const updatedPrNumber = shared.getPrNumber(after);
          const idx = currentPrs.findIndex(p =>
            p.id === after.id
            || (updatedPrNumber != null && shared.getPrNumber(p) === updatedPrNumber)
          );
          if (idx >= 0) {
            // Never downgrade reviewStatus from 'approved' — it's a permanent terminal state
            // The disk version may have been set to 'approved' by another writer after we read
            if (currentPrs[idx].reviewStatus === 'approved' && after.reviewStatus !== 'approved') {
              after.reviewStatus = 'approved';
            }
            shared.applyPrFieldDelta(currentPrs[idx], before, after);
          }
          // Don't push if not found — it was deleted by another writer, respect that
        }
        // Remove duplicates — prefer merged/abandoned over active
        const bestById = new Map();
        const statusRank = { merged: 3, abandoned: 2, closed: 2, active: 1 };
        for (const p of currentPrs) {
          const existing = bestById.get(p.id);
          if (!existing || (statusRank[p.status] || 0) > (statusRank[existing.status] || 0)) {
            bestById.set(p.id, p);
          }
        }
        return [...bestById.values()];
      }, { defaultValue: [] });
      totalUpdated += projectUpdated;
    }
  }

  return totalUpdated;
}

// ─── PR Status Polling ───────────────────────────────────────────────────────

async function pollPrStatus(config) {
  _adoPollHadAuthFailure = false; // reset before polling — set again if errors recur

  const token = await getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR status poll — no ADO token available');
    // Don't set _adoPollHadAuthFailure — getAdoToken() has its own 10-min backoff,
    // and setting the flag would hammer pollPrStatus() every tick with no useful work.
    return;
  }

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase, adoRepositoryId) => {
    try {
    const encodedRepoId = encodeURIComponent(adoRepositoryId);
    const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodedRepoId}/pullrequests/${prNum}`;
    let updated = false;

    const prData = await adoFetch(`${repoBase}?api-version=7.1`, token);

    if (applyAdoPrMetadata(pr, prData)) updated = true;

    let newStatus = pr.status;
    if (prData.status === 'completed') newStatus = PR_STATUS.MERGED;
    else if (prData.status === 'abandoned') newStatus = PR_STATUS.ABANDONED;
    else if (prData.status === 'active') newStatus = PR_STATUS.ACTIVE;

    if (pr.status !== newStatus) {
      log('info', `PR ${pr.id} status: ${pr.status} → ${newStatus}`);
      pr.status = newStatus;
      updated = true;

      if (newStatus === PR_STATUS.MERGED || newStatus === PR_STATUS.ABANDONED) {
        if (pr.reviewStatus === 'waiting') {
          pr.reviewStatus = newStatus === PR_STATUS.MERGED ? 'approved' : 'pending';
          log('info', `PR ${pr.id} reviewStatus: waiting → ${pr.reviewStatus} (${newStatus})`);
        }
        // Clear stale build status — checks won't be polled after close
        if (pr.buildStatus && pr.buildStatus !== 'none') {
          delete pr.buildStatus;
          delete pr.buildFailReason;
          delete pr.buildErrorLog;
          delete pr._buildFailNotified;
          delete pr._buildStatusStale;
          delete pr._buildStatusDetail;
          delete pr.buildFixAttempts;
          delete pr.buildFixEscalated;
        }
        // Cancel any pending review/fix dispatches — they're stale now that the PR is closed
        try {
          dispatchModule().cancelPendingDispatchesForPr(pr.id);
        } catch (e) { log('warn', `Cancel dispatches for ${pr.id}: ${e.message}`); }
        await engine().handlePostMerge(pr, project, config, newStatus);
      }
    }

    // Track head commit changes to detect new pushes (used for review re-dispatch gating)
    // Use lastMergeCommit (the merge commit), not lastMergeSourceCommit (source branch tip)
    const headCommit = prData.lastMergeCommit?.commitId || prData.lastMergeSourceCommit?.commitId || '';
    if (headCommit && pr._adoHeadCommit !== headCommit) {
      if (pr._adoHeadCommit) { // skip first detection — only track changes
        pr.lastPushedAt = ts();
      }
      pr._adoHeadCommit = headCommit;
      updated = true;
    }
    // Track source commit separately — detects actual author pushes vs target branch updates
    const sourceCommit = prData.lastMergeSourceCommit?.commitId || '';
    if (sourceCommit && pr._adoSourceCommit !== sourceCommit) {
      pr._adoSourceCommit = sourceCommit;
      updated = true;
    }

    const reviewers = prData.reviewers || [];
    const votes = reviewers.map(r => r.vote).filter(v => v !== undefined);
    let newReviewStatus = pr.reviewStatus || 'pending';
    // Once approved, it stays approved permanently
    if (pr.reviewStatus === 'approved') {
      newReviewStatus = 'approved';
      // Re-approve: ADO resets votes when target branch (master) advances, even though
      // the source branch is unchanged. Re-apply the approval vote via API.
      if (!votes.some(v => v >= 5) && sourceCommit && pr._adoSourceCommit === sourceCommit) {
        try {
          const identityData = await adoFetch(`${orgBase}/_apis/connectionData?api-version=7.1`, token).catch(() => null);
          const myId = identityData?.authenticatedUser?.id;
          if (myId) {
            await adoFetch(`${repoBase}/reviewers/${myId}?api-version=7.1`, token, {
              method: 'PUT', body: JSON.stringify({ vote: 10 })
            });
            log('info', `PR ${pr.id}: re-applied approval vote (ADO reset due to target branch update)`);
          }
        } catch (e) { log('warn', `PR ${pr.id}: failed to re-apply approval: ${e.message}`); }
      }
    } else if (votes.length > 0) {
      if (votes.some(v => v === -10)) {
        if (pr.reviewStatus === 'waiting' && pr.minionsReview?.fixedAt && (!pr.lastPushedAt || pr.lastPushedAt <= pr.minionsReview.fixedAt)) {
          newReviewStatus = 'waiting';
        } else {
          newReviewStatus = 'changes-requested';
        }
      }
      else if (votes.some(v => v >= 5)) newReviewStatus = 'approved';
      else if (votes.some(v => v === -5)) newReviewStatus = 'waiting';
      else newReviewStatus = 'pending';
    }

    // Store human reviewer names who approved or requested changes
    const reviewedBy = reviewers
      .filter(r => r.vote >= 5 || r.vote === -10)
      .map(r => r.displayName)
      .filter(Boolean);
    // Fallback: if PR was merged and no decisive votes, use completedBy
    if (!reviewedBy.length && newStatus === PR_STATUS.MERGED && prData.closedBy?.displayName) {
      reviewedBy.push(prData.closedBy.displayName);
    }
    if (JSON.stringify(pr.reviewedBy || []) !== JSON.stringify(reviewedBy)) {
      pr.reviewedBy = reviewedBy; updated = true;
    }

    if (pr.reviewStatus !== newReviewStatus) {
      log('info', `PR ${pr.id} reviewStatus: ${pr.reviewStatus} → ${newReviewStatus}`);
      pr.reviewStatus = newReviewStatus;
      updated = true;
      shared.trackReviewMetric(pr, newReviewStatus, config);
      if (newReviewStatus === 'approved') {
        delete pr._reviewFixCycles;
        delete pr._evalEscalated;
        // Teams notification for PR approval — non-blocking, edge-triggered (only on transition)
        try {
          const teams = require('./teams');
          const prFilePath = shared.projectPrPath(project);
          teams.teamsNotifyPrEvent(pr, 'pr-approved', project, prFilePath).catch(() => {});
        } catch {}
      }
    }

    if (newStatus !== PR_STATUS.ACTIVE) return updated;

    // Query builds API directly — /statuses is unreliable (stale codecoverage postbacks).
    // refs/pull/{id}/merge scopes server-side to this PR; sourceVersion narrows to the current
    // merge commit (same ref accumulates builds across all prior pushes to the PR).
    const prNumber = pr.prNumber;
    const mergeCommitId = prData.lastMergeCommit?.commitId;
    let buildStatus = pr.buildStatus || 'none';
    let buildFailReason = pr.buildFailReason || '';
    let buildStatusResolved = true;
    let buildStatusStaleDetail = '';

    if (prNumber && mergeCommitId) {
      const buildRepositoryGuid = await resolveAdoBuildRepositoryGuid(project, token, orgBase, 'ADO build polling');
      if (!buildRepositoryGuid) {
        buildStatusResolved = false;
        buildStatusStaleDetail = 'ADO Builds API requires a repository GUID; repository GUID could not be resolved from project.repositoryId/project.repoName';
      } else {
        try {
          const mergeRef = encodeURIComponent(`refs/pull/${prNumber}/merge`);
          const buildsUrl = `${orgBase}/${project.adoProject}/_apis/build/builds?branchName=${mergeRef}&repositoryId=${encodeURIComponent(buildRepositoryGuid)}&repositoryType=TfsGit&$top=25&api-version=7.1`;
          const buildsData = await adoFetch(buildsUrl, token);
          const allBuilds = buildsData?.value || [];
          const prBuilds = allBuilds.filter(b => b.sourceVersion === mergeCommitId);
          buildStatus = 'none';
          buildFailReason = '';

          if (prBuilds.length > 0) {
            buildStatus = classifyBuildStatus(prBuilds);
            if (buildStatus === 'failing') {
              const failed = prBuilds.find(b => b.result === 'failed');
              buildFailReason = failed?.definition?.name || 'Build failed';
            }
          } else if (allBuilds.length > 0 && pr.buildStatus) {
            // Stale merge-commit fallback — ADO returned builds for this PR's merge ref
            // but none target the current `mergeCommitId`. Most likely the target branch
            // moved, ADO recomputed the merge commit, but no new source-side changes
            // triggered a rebuild. Preserve the previous `pr.buildStatus` so the tracker
            // reflects the last known truth instead of flipping to a spurious 'none'.
            // Also log a warn so stale states are detectable in engine logs. Issue #1233.
            const sampleSv = (allBuilds[0]?.sourceVersion || '').slice(0, 8);
            log('warn', `PR ${pr.id} build: merge-commit mismatch — ${allBuilds.length} build(s) on merge ref, none target current merge commit ${String(mergeCommitId).slice(0, 8)} (sample sourceVersion ${sampleSv}); preserving previous buildStatus '${pr.buildStatus}'`);
            buildStatus = pr.buildStatus;
            if (pr.buildFailReason) buildFailReason = pr.buildFailReason;
          }
        } catch (e) {
          buildStatusResolved = false;
          buildStatusStaleDetail = `ADO build query failed: ${e.message}`;
          log('warn', `ADO build query for ${pr.id}: ${e.message}; preserving previous buildStatus '${pr.buildStatus || 'none'}'`);
        }
      }
    } else {
      buildStatus = 'none';
      buildFailReason = '';
    }

    // Record actual poll time — makes lastBuildCheck reflect when the engine last
    // talked to ADO, not when the agent was dispatched. Issue #1233.
    pr.lastBuildCheck = ts();
    updated = true;

    if (buildStatusResolved) {
      if (pr._buildStatusStale || pr._buildStatusDetail) {
        clearBuildStatusStale(pr);
        updated = true;
      }
    } else {
      markBuildStatusStale(pr, buildStatusStaleDetail);
      updated = true;
    }

    if (buildStatusResolved) {
      if (pr.buildStatus !== buildStatus) {
        log('info', `PR ${pr.id} build: ${pr.buildStatus || 'none'} → ${buildStatus}${buildFailReason ? ' (' + buildFailReason + ')' : ''}`);
        pr.buildStatus = buildStatus;
        if (buildFailReason) pr.buildFailReason = buildFailReason;
        else delete pr.buildFailReason;
        // Build transitioned — clear grace period and auto-complete flag
        delete pr._buildFixPushedAt;
        if (buildStatus === 'failing') delete pr._autoCompleted;
        if (buildStatus !== 'failing') {
          delete pr._buildFailNotified;
          delete pr._buildStatusStale;
          delete pr._buildStatusDetail;
          // Preserve buildErrorLog + buildFixAttempts through transient 'none'/'running'
          // transitions — only clear on confirmed 'passing' recovery. Issue #1232: 'none'
          // can also occur when ADO recomputes the merge commit after a target-branch
          // update but no new builds have been triggered yet (filter by sourceVersion
          // returns []), which previously wiped the last known error log and caused
          // fix agents to be dispatched blind.
          if (buildStatus === 'passing') {
            delete pr.buildErrorLog;
            // Reset build fix retry counter on recovery — allows fresh auto-fix cycles if build breaks again
            if (pr.buildFixAttempts) { delete pr.buildFixAttempts; delete pr.buildFixEscalated; }
          }
        }
        updated = true;

        if (buildStatus === 'failing') {
          // Teams notification for build failure — non-blocking
          try {
            const teams = require('./teams');
            const prFilePath = shared.projectPrPath(project);
            teams.teamsNotifyPrEvent(pr, 'build-failed', project, prFilePath).catch(() => {});
          } catch {}
        }
      }
    }

    // Auto-complete: set auto-complete on PR when builds green + review approved
    if (pr.status === PR_STATUS.ACTIVE && pr.reviewStatus === 'approved' && pr.buildStatus === 'passing' && !pr._autoCompleted) {
      const autoComplete = config.engine?.autoCompletePrs === true; // opt-in
      if (autoComplete) {
        try {
          const mergeStrategy = config.engine?.prMergeMethod === 'merge' ? 1 : config.engine?.prMergeMethod === 'rebase' ? 2 : 3; // 3 = squash
          const identityUrl = `${orgBase}/_apis/connectionData?api-version=7.1`;
          const identity = await adoFetch(identityUrl, token).catch(() => null);
          const autoCompleteUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodedRepoId}/pullrequests/${prNum}?api-version=7.1`;
          await adoFetch(autoCompleteUrl, token, {
            method: 'PATCH',
            body: JSON.stringify({
              autoCompleteSetBy: { id: identity?.authenticatedUser?.id },
              completionOptions: { mergeStrategy, deleteSourceBranch: true, transitionWorkItems: true }
            })
          });
          pr._autoCompleted = true;
          log('info', `Auto-complete set on PR ${pr.id}: builds green + review approved`);
          updated = true;
        } catch (e) {
          log('warn', `Auto-complete failed for PR ${pr.id}: ${e.message}`);
        }
      }
    }

    // Merge conflict detection
    if (prData.mergeStatus === 'conflicts') {
      if (!pr._mergeConflict) {
        pr._mergeConflict = true;
        log('info', `PR ${pr.id} has merge conflicts — will dispatch fix if not already in progress`);
        updated = true;
      }
    } else if (pr._mergeConflict) {
      delete pr._mergeConflict;
      delete pr._conflictFixedAt; // ADO confirmed clean — allow re-dispatch if conflicts recur
      updated = true;
    }

    return updated;
    } catch (err) {
      // Auth errors → mark build status stale so dashboard shows uncertainty
      // and engine re-polls on next tick instead of waiting 6 ticks
      if (isAdoAuthError(err)) {
        markBuildStatusStale(pr, `ADO auth error: ${err.message}`);
        _adoPollHadAuthFailure = true;
        log('warn', `PR ${pr.id}: build status marked stale (auth error: ${err.message})`);
        return true; // count as updated to persist the stale flag
      }
      throw err; // re-throw non-auth errors for forEachActivePr to handle
    }
  });

  if (totalUpdated > 0) {
    log('info', `PR status poll: updated ${totalUpdated} PR(s)`);
  }
}

// ─── Poll Human Comments on PRs ──────────────────────────────────────────────

async function pollPrHumanComments(config) {
  const token = await getAdoToken();
  if (!token) return;

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase, adoRepositoryId) => {
    const threadsUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodeURIComponent(adoRepositoryId)}/pullrequests/${prNum}/threads?api-version=7.1`;
    const threadsData = await adoFetch(threadsUrl, token);
    const threads = threadsData.value || [];

    const cutoffStr = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
    const cutoffMs = new Date(cutoffStr).getTime() || 0;

    // Collect ALL human comments on the PR for full context
    const allHumanComments = [];
    const newHumanComments = [];
    const ignoredAuthors = (config.engine?.ignoredCommentAuthors || []).map(a => a.toLowerCase());

    for (const thread of threads) {
      // Skip resolved/closed threads — only process active (1) and pending (6)
      if (thread.status && thread.status !== 'active' && thread.status !== 1 && thread.status !== 6) continue;
      for (const comment of (thread.comments || [])) {
        if (!comment.content || comment.commentType === 'system') continue;
        const content = comment.content;
        // Skip bots, CI noise, and ignored authors
        const authorName = (comment.author?.displayName || '').toLowerCase();
        if (ignoredAuthors.some(a => authorName.includes(a))) continue;
        if (/\b(bot|service|build|pipeline|codecov|sonar)\b/i.test(authorName)) continue;
        if (/^#{1,3}\s*(Coverage|Build|Test|Deploy|Pipeline)\s*(Report|Status|Result|Summary)/i.test(content)) continue;
        // Detect agent comments (included in context, but don't trigger fix)
        const isAgent = /\bMinions\s*\(/i.test(content) || /\bby\s+Minions\b/i.test(content) || /\[minions\]/i.test(content);

        const entry = {
          threadId: thread.id,
          commentId: comment.id,
          author: comment.author?.displayName || 'Human',
          content: comment.content,
          date: comment.publishedDate,
          _isAgent: isAgent
        };
        allHumanComments.push(entry);

        // Only non-agent new comments trigger a fix (agent reviews trigger via vote)
        const commentMs = comment.publishedDate ? new Date(comment.publishedDate).getTime() : 0;
        if (commentMs && commentMs > cutoffMs && !isAgent) {
          newHumanComments.push(entry);
        }
      }
    }

    // Update cutoff even if only agent comments are new
    const allNewDates = allHumanComments.filter(c => (new Date(c.date).getTime() || 0) > cutoffMs).map(c => c.date);
    if (allNewDates.length > 0 && newHumanComments.length === 0) {
      pr.humanFeedback = { ...(pr.humanFeedback || {}), lastProcessedCommentDate: allNewDates.sort().pop() };
      return true;
    }
    if (newHumanComments.length === 0) return false;

    // Sort all comments chronologically and build full context for the fix agent
    allHumanComments.sort((a, b) => a.date.localeCompare(b.date));
    newHumanComments.sort((a, b) => a.date.localeCompare(b.date));
    const latestDate = newHumanComments[newHumanComments.length - 1].date;

    // Provide ALL comments as context — the agent needs full thread context to fix properly
    const feedbackContent = allHumanComments
      .map(c => {
        const isNew = (new Date(c.date).getTime() || 0) > cutoffMs;
        return `${isNew ? '**[NEW]** ' : ''}**${c.author}** (${c.date}):\n${c.content.replace(/@minions\s*/gi, '').trim()}`;
      })
      .join('\n\n---\n\n');

    pr.humanFeedback = {
      lastProcessedCommentDate: latestDate,
      pendingFix: true,
      feedbackContent
    };

    log('info', `PR ${pr.id}: ${newHumanComments.length} new comment(s), ${allHumanComments.length} total — full thread context provided`);
    return true;
  });

  if (totalUpdated > 0) {
    log('info', `PR comment poll: found human feedback on ${totalUpdated} PR(s)`);
  }
}

// ─── PR Reconciliation Sweep ─────────────────────────────────────────────────

/**
 * Reconcile PRs: find active ADO PRs created by the minions that aren't tracked
 * in pull-requests.json, and add them. Matches PRs to work items by branch name.
 */
async function reconcilePrs(config) {
  const token = await getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR reconciliation — no ADO token available');
    return;
  }

  const projects = shared.getProjects(config);
  const branchPatterns = [/^refs\/heads\/work\//i, /^refs\/heads\/feat\//i, /^refs\/heads\/user\/yemishin\//i];
  let totalAdded = 0;

  for (const project of projects) {
    if (isGitHubProject(project)) continue;
    if (!project.adoOrg || !project.adoProject) continue;
    const adoRepositoryId = getAdoRepositoryId(project);
    if (!adoRepositoryId) {
      logMissingAdoRepository(project, 'ADO PR reconciliation');
      continue;
    }

    const orgBase = shared.getAdoOrgBase(project);
    const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodeURIComponent(adoRepositoryId)}/pullrequests?searchCriteria.status=active&api-version=7.1`;

    let prData;
    try {
      prData = await adoFetch(url, token);
    } catch (err) {
      log('warn', `PR reconciliation failed for ${project.name}: ${err.message}`);
      continue;
    }

    const adoPrs = (prData.value || []).filter(pr => {
      const ref = pr.sourceRefName || '';
      return branchPatterns.some(pat => pat.test(ref));
    });

    if (adoPrs.length === 0) continue;

    const prPath = shared.projectPrPath(project);
    const existingPrs = shared.safeJson(prPath) || [];
    shared.normalizePrRecords(existingPrs, project);
    const existingIds = new Set(existingPrs.map(p => p.id));
    let projectAdded = 0;
    let metadataUpdated = 0;

    // Load work items to match branches to work item IDs
    const wiPath = shared.projectWorkItemsPath(project);
    const workItems = shared.safeJson(wiPath) || [];
    const centralWiPath = path.join(shared.MINIONS_DIR, 'work-items.json');
    const centralItems = shared.safeJson(centralWiPath) || [];
    const allItems = [...workItems, ...centralItems];

    let projectUpdated = 0;
    for (const adoPr of adoPrs) {
      const prUrl = getAdoPrUrl(project, adoPr.pullRequestId);
      const prId = shared.getCanonicalPrId(project, adoPr.pullRequestId, prUrl);
      const branch = stripRefsHeads(adoPr.sourceRefName);
      const title = adoPr.title || '';
      // Extract item ID from branch name or PR title (e.g., feat(P-2cafdc2a): ...)
      const branchMatch = branch.match(/(P-[a-z0-9]{6,})/i) || branch.match(/(W-[a-z0-9]{6,})/i) || branch.match(/(PL-[a-z0-9]{6,})/i);
      const titleMatch = title.match(/\((P-[a-z0-9]{6,})\)/) || title.match(/\((W-[a-z0-9]{6,})\)/) || title.match(/\((PL-[a-z0-9]{6,})\)/);
      const linkedItemId = branchMatch?.[1] || titleMatch?.[1] || null;
      const linkedItem = linkedItemId ? allItems.find(i => i.id === linkedItemId) : null;
      const confirmedItemId = linkedItem ? linkedItemId : null;

      if (existingIds.has(prId)) {
        const existing = existingPrs.find(p => p.id === prId);
        // Backfill prNumber for existing records missing it
        if (existing && existing.prNumber == null) {
          existing.prNumber = adoPr.pullRequestId;
        }
        if (existing && !existing.branch && branch) {
          existing.branch = branch;
          if (existing._branchResolutionError) delete existing._branchResolutionError;
          if (existing._pendingReason === shared.PR_PENDING_REASON.MISSING_BRANCH) delete existing._pendingReason;
          metadataUpdated++;
        }
        // PR already tracked — write link to pr-links.json if we can extract an ID
        if (confirmedItemId) {
          shared.upsertPullRequestRecord(prPath, existing || {
            id: prId,
            prNumber: adoPr.pullRequestId,
            title: (adoPr.title || `PR #${adoPr.pullRequestId}`).slice(0, 120),
            agent: (linkedItem?.dispatched_to || adoPr.createdBy?.displayName || 'unknown').toLowerCase(),
            branch,
            reviewStatus: 'pending',
            status: 'active',
            created: adoPr.creationDate || ts(),
            url: prUrl,
            prdItems: [],
          }, { project, itemId: confirmedItemId });
          if (existing && !(existing.prdItems || []).includes(confirmedItemId)) {
            existing.prdItems = Array.isArray(existing.prdItems) ? existing.prdItems : [];
            existing.prdItems.push(confirmedItemId);
          }
          projectUpdated++;
        }
        continue;
      }

      // Only auto-track PRs that are linked to a minions work item.
      // PRs on feat/ or work/ branches without a work item ID (P-xxx, W-xxx, PL-xxx)
      // are human-authored and should not be auto-tracked or auto-reviewed.
      if (!confirmedItemId) continue;

      const entry = {
        id: prId,
        prNumber: adoPr.pullRequestId,
        title: (adoPr.title || `PR #${adoPr.pullRequestId}`).slice(0, 120),
        agent: (linkedItem?.dispatched_to || adoPr.createdBy?.displayName || 'unknown').toLowerCase(),
        branch,
        reviewStatus: 'pending',
        status: 'active',
        created: adoPr.creationDate || ts(),
        url: prUrl,
        prdItems: [confirmedItemId],
      };
      const upserted = shared.upsertPullRequestRecord(prPath, entry, { project, itemId: confirmedItemId });
      existingPrs.push(upserted.record || entry);
      existingIds.add(prId);
      projectAdded++;
      log('info', `PR reconciliation: added ${prId} (branch: ${branch}, linked to ${confirmedItemId}) to ${project.name}`);
    }

    // Backfill prNumber from pr.id for any PR missing it (e.g. created before prNumber was stored)
    for (const pr of existingPrs) {
      if (pr.prNumber == null) {
        const derived = shared.getPrNumber(pr);
        if (derived) pr.prNumber = derived;
      }
    }

    // Backfill prdItems from pr-links for any PR with empty array
    const backfilled = shared.backfillPrPrdItems(existingPrs, shared.getPrLinks());

    if (projectAdded > 0 || projectUpdated > 0 || backfilled > 0 || metadataUpdated > 0) {
      mutateJsonFileLocked(prPath, (currentPrs) => {
        // Merge reconciled PRs into the locked copy by ID
        for (const pr of existingPrs) {
          const idx = currentPrs.findIndex(p => p.id === pr.id);
          if (idx >= 0) currentPrs[idx] = pr;
          else currentPrs.push(pr);
        }
        return currentPrs;
      }, { defaultValue: [] });
      totalAdded += projectAdded;
      if (projectUpdated > 0) log('info', `PR reconciliation: linked ${projectUpdated} existing PR(s) to PRD items in ${project.name}`);
    }
  }

  if (totalAdded > 0) {
    log('info', `PR reconciliation: added ${totalAdded} missing PR(s) across projects`);
  }
}

/**
 * Fetch live review status for a single PR from ADO (async).
 * Returns 'approved', 'changes-requested', 'waiting', or 'pending'.
 * Returns null if the check fails (token unavailable, API error).
 * Used as a pre-dispatch gate to avoid dispatching reviews for already-approved PRs.
 */
async function checkLiveReviewStatus(pr, project) {
  try {
    const token = await getAdoToken();
    if (!token) return null;
    const orgBase = shared.getAdoOrgBase(project);
    const prNum = shared.getPrNumber(pr);
    if (!prNum) return null;
    const adoRepositoryId = getAdoRepositoryId(project);
    if (!adoRepositoryId) {
      logMissingAdoRepository(project, 'ADO live review check');
      return null;
    }
    const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodeURIComponent(adoRepositoryId)}/pullrequests/${prNum}?api-version=7.1`;
    // SEC-02: use in-process adoFetch rather than a shell-out — keeps the bearer
    // token out of the process argv list where any local process could read it.
    // 4s timeout preserves the original request-cancellation semantics via AbortSignal.
    const prData = await adoFetch(url, token, { timeout: 4000 });
    if (!prData) return null;
    const votes = (prData.reviewers || []).map(r => r.vote).filter(v => v !== undefined);
    if (votes.length === 0) return 'pending';
    return votesToReviewStatus(votes);
  } catch (e) {
    log('warn', `Live review check for ${pr.id}: ${e.message}`);
    return null;
  }
}

/**
 * Cheap pre-dispatch freshness check for build status and merge-conflict state.
 * Mirrors checkLiveReviewStatus — fetches PR data once, classifies builds for the
 * current merge commit, and reports whether ADO still considers the PR conflicted.
 *
 * Returns null if the check can't run (no token, no PR number, network error) so
 * callers can fall back to cached state. Otherwise returns:
 *   {
 *     buildStatus: 'failing' | 'passing' | 'running' | 'none' | null,
 *     mergeConflict: boolean,
 *     buildStatusStale?: boolean,
 *     buildStatusDetail?: string,
 *   }
 *
 * `buildStatus` is null when ADO has builds on the merge ref but none target the
 * current merge commit (target-branch advance with no source-side rebuild yet —
 * matches pollPrStatus's "preserve previous buildStatus" semantics from issue
 * #1233; the caller must trust the cached value).
 */
async function checkLiveBuildAndConflict(pr, project) {
  try {
    const token = await getAdoToken();
    if (!token) return null;
    const orgBase = shared.getAdoOrgBase(project);
    const prNum = shared.getPrNumber(pr);
    if (!prNum) return null;
    const adoRepositoryLookupKey = getAdoRepositoryLookupKey(project);
    if (!adoRepositoryLookupKey) {
      logMissingAdoRepository(project, 'ADO live build/conflict check');
      return null;
    }
    const encodedRepoId = encodeURIComponent(adoRepositoryLookupKey);
    const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodedRepoId}`;
    const prUrl = `${repoBase}/pullrequests/${prNum}?api-version=7.1`;
    // 4s timeout — same budget as checkLiveReviewStatus. This is a pre-dispatch
    // gate; we'd rather miss a freshness signal and fall back to cache than
    // block dispatch on a slow ADO call.
    const prData = await adoFetch(prUrl, token, { timeout: 4000 });
    if (!prData) return null;

    // Conflict signal — ADO reports `mergeStatus: 'conflicts'` when the merge
    // would conflict; anything else means clean (or recomputing).
    const mergeConflict = prData.mergeStatus === 'conflicts';

    // Build signal — only meaningful when the PR is still open. We replicate
    // pollPrStatus's narrowing logic so the live check and the cached poll
    // agree on what 'failing' / 'passing' / 'running' / 'none' mean.
    let buildStatus = null;
    let buildStatusStale = false;
    let buildStatusDetail = '';
    if (prData.status === 'active') {
      const mergeCommitId = prData.lastMergeCommit?.commitId;
      if (mergeCommitId) {
        const buildRepositoryGuid = await resolveAdoBuildRepositoryGuid(project, token, orgBase, 'ADO live build check', { timeout: 4000 });
        if (!buildRepositoryGuid) {
          buildStatusStale = true;
          buildStatusDetail = 'ADO Builds API requires a repository GUID; repository GUID could not be resolved from project.repositoryId/project.repoName';
        } else {
          try {
            const mergeRef = encodeURIComponent(`refs/pull/${prNum}/merge`);
            const buildsUrl = `${orgBase}/${project.adoProject}/_apis/build/builds?branchName=${mergeRef}&repositoryId=${encodeURIComponent(buildRepositoryGuid)}&repositoryType=TfsGit&$top=25&api-version=7.1`;
            const buildsData = await adoFetch(buildsUrl, token, { timeout: 4000 });
            const allBuilds = buildsData?.value || [];
            const prBuilds = allBuilds.filter(b => b.sourceVersion === mergeCommitId);
            if (prBuilds.length > 0) {
              buildStatus = classifyBuildStatus(prBuilds);
            } else if (allBuilds.length === 0) {
              buildStatus = 'none';
            }
            // else: merge-commit mismatch — leave buildStatus null so caller
            // falls back to cached state (issue #1233).
          } catch (e) {
            buildStatusStale = true;
            buildStatusDetail = `ADO live build query failed: ${e.message}`;
            log('warn', `Live build check builds query for ${pr.id}: ${e.message}`);
          }
        }
      } else {
        // No merge commit yet — likely conflict or fresh PR. Treat as 'none'
        // so a stale 'failing' cache can be cleared by the caller.
        buildStatus = 'none';
      }
    }

    return {
      buildStatus,
      mergeConflict,
      ...(buildStatusStale ? { buildStatusStale, buildStatusDetail } : {}),
    };
  } catch (e) {
    log('warn', `Live build/conflict check for ${pr.id}: ${e.message}`);
    return null;
  }
}

async function fetchAdoPrMetadata(prNum, adoOrg, adoProj, adoRepo) {
  const token = await getAdoToken();
  if (!token) return null;
  const orgBase = getAdoOrgBase({ adoOrg });
  const url = `${orgBase}/${encodeURIComponent(adoProj)}/_apis/git/repositories/${encodeURIComponent(adoRepo)}/pullrequests/${encodeURIComponent(String(prNum))}?api-version=7.1`;
  const pr = await adoFetch(url, token);
  if (!pr) return null;
  return {
    title: pr.title || '',
    description: pr.description || '',
    branch: stripRefsHeads(pr.sourceRefName),
    author: pr.createdBy?.displayName || '',
  };
}

/**
 * Fetch live PR and build status for a single PR number.
 * Used by engine/ado-status.js so agents can check CI without raw curl calls.
 * Returns { prNumber, title, branch, status, reviewStatus, buildStatus,
 *           buildStatusStale?, buildStatusDetail?, buildErrorLog?,
 *           mergeConflict, url, project } or null on auth failure.
 */
async function fetchSinglePrBuildStatus(project, prNumber) {
  const token = await getAdoToken();
  if (!token) return null;

  const orgBase = getAdoOrgBase(project);
  const adoRepositoryLookupKey = getAdoRepositoryLookupKey(project);
  if (!adoRepositoryLookupKey) {
    logMissingAdoRepository(project, 'ADO single PR status fetch');
    return null;
  }
  const encodedRepoId = encodeURIComponent(adoRepositoryLookupKey);
  const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodedRepoId}`;

  // Fetch PR metadata and resolve the Builds API repository GUID in parallel.
  const [prData, buildRepositoryGuid] = await Promise.all([
    adoFetch(`${repoBase}/pullrequests/${prNumber}?api-version=7.1`, token),
    resolveAdoBuildRepositoryGuid(project, token, orgBase, 'ADO single PR status fetch'),
  ]);
  if (!prData) return null;

  let buildsData = null;
  let buildStatusStale = false;
  let buildStatusDetail = '';
  if (buildRepositoryGuid) {
    try {
      const mergeRef = encodeURIComponent(`refs/pull/${prNumber}/merge`);
      const buildsUrl = `${orgBase}/${project.adoProject}/_apis/build/builds?branchName=${mergeRef}&repositoryId=${encodeURIComponent(buildRepositoryGuid)}&repositoryType=TfsGit&$top=25&api-version=7.1`;
      buildsData = await adoFetch(buildsUrl, token);
    } catch (e) {
      buildStatusStale = true;
      buildStatusDetail = `ADO build query failed: ${e.message}`;
      log('warn', `fetchSinglePrBuildStatus builds query for PR #${prNumber}: ${e.message}`);
    }
  } else {
    buildStatusStale = true;
    buildStatusDetail = 'ADO Builds API requires a repository GUID; repository GUID could not be resolved from project.repositoryId/project.repoName';
  }

  const mergeCommitId = prData.lastMergeCommit?.commitId;
  const prBuilds = mergeCommitId
    ? (buildsData?.value || []).filter(b => b.sourceVersion === mergeCommitId)
    : [];

  let buildStatus = buildStatusStale ? null : classifyBuildStatus(prBuilds);
  let buildErrorLog = null;

  if (buildStatus === 'failing') {
    try {
      const failedBuilds = prBuilds.filter(b => b.result === 'failed').map(b => ({
        state: 'failed', _buildId: String(b.id),
        targetUrl: `${orgBase}/${project.adoProject}/_build/results?buildId=${b.id}`,
      }));
      const logParts = [];
      const seenBuildIds = new Set();
      const pr = { id: shared.getCanonicalPrId(project, prNumber, getAdoPrUrl(project, prNumber)), branch: stripRefsHeads(prData.sourceRefName) };
      for (const fb of failedBuilds.slice(0, 3)) {
        const errorLog = await fetchAdoBuildErrorLog(orgBase, project, fb, token, pr, seenBuildIds);
        if (errorLog) logParts.push(errorLog);
      }
      if (logParts.length > 0) buildErrorLog = logParts.join('\n\n');
    } catch (e) { log('warn', `fetchSinglePrBuildStatus error log for PR #${prNumber}: ${e.message}`); }
  }

  const votes = (prData.reviewers || []).map(r => r.vote).filter(v => v !== undefined);
  const prUrl = getAdoPrUrl(project, prNumber);

  return {
    prNumber,
    title: prData.title || '',
    branch: stripRefsHeads(prData.sourceRefName),
    status: prData.status || 'unknown',
    reviewStatus: votesToReviewStatus(votes),
    buildStatus,
    ...(buildStatusStale ? { buildStatusStale, buildStatusDetail } : {}),
    ...(buildErrorLog ? { buildErrorLog } : {}),
    mergeConflict: prData.mergeStatus === 'conflicts',
    url: prUrl,
    project: project.name,
    source: 'live',
  };
}

// ─── ADO Throttle Queries ────────────────────────────────────────────────────

/** Returns true if ADO is throttled and retryAfter hasn't elapsed. Auto-clears when retryAfter passes. */
const isAdoThrottled = () => _adoThrottle.isThrottled();

/** Returns a snapshot of the current throttle state. Calls isAdoThrottled() for a fresh value. */
const getAdoThrottleState = () => _adoThrottle.getState();

/**
 * Query ADO for an open PR on a specific branch.
 * Used as a last-resort fallback when an agent completes without logging a PR URL
 * but a PR may already exist from a prior orphaned dispatch.
 * @param {object} project — project config with adoOrg, adoProject, repositoryId, prUrlBase
 * @param {string} branch — source branch name (without refs/heads/ prefix)
 * @returns {{ prNumber: number, url: string }|null}
 */
async function findOpenPrOnBranch(project, branch) {
  if (!project.adoOrg || !project.adoProject || !branch) return null;
  const adoRepositoryId = getAdoRepositoryId(project);
  if (!adoRepositoryId) {
    logMissingAdoRepository(project, 'ADO branch PR lookup');
    return null;
  }
  if (isAdoThrottled()) {
    log('debug', `[ado] Skipping branch PR lookup for ${project.name || project.repoName || 'unknown project'}:${branch} — throttled`);
    return null;
  }
  const token = await getAdoToken();
  if (!token) return null;
  const orgBase = shared.getAdoOrgBase(project);
  const sourceRef = encodeURIComponent(`refs/heads/${branch}`);
  const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${encodeURIComponent(adoRepositoryId)}/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${sourceRef}&api-version=7.1`;
  const data = await adoFetch(url, token);
  const pr = (data.value || [])[0];
  if (!pr) return null;
  const prNumber = pr.pullRequestId;
  const prUrl = getAdoPrUrl(project, prNumber);
  return { prNumber, url: prUrl };
}

/** Reset throttle state — exported for testing only. */
function _resetAdoThrottle() {
  _adoThrottle._reset();
}

/** Set throttle state directly — exported for testing only. */
function _setAdoThrottleForTest(state) {
  _adoThrottle._setForTest(state);
}

/** Inject a token into the cache — exported for testing only.
 *  Lets tests exercise functions that call getAdoToken() without invoking azureauth.
 *  Pass null to force getAdoToken() to return null synchronously (no exec). */
function _setAdoTokenForTest(token) {
  if (token == null) {
    // Clear cache AND set a future failure backoff so getAdoToken short-circuits
    // to null without spawning azureauth — otherwise tests would hang on the
    // 15s execAsync timeout or open a real auth popup.
    _adoTokenCache = { token: null, expiresAt: 0 };
    _adoTokenFailedUntil = Date.now() + 60 * 60 * 1000;
  } else {
    _adoTokenCache = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
    _adoTokenFailedUntil = 0;
  }
}

module.exports = {
  getAdoToken,
  adoFetch,
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
  checkLiveReviewStatus,
  checkLiveBuildAndConflict,
  needsAdoPollRetry,
  isAdoAuthError, // exported for testing
  isAdoThrottled,
  getAdoThrottleState,
  fetchAdoPrMetadata,
  fetchSinglePrBuildStatus,
  findOpenPrOnBranch,
  _resetAdoThrottle, // exported for testing
  _setAdoThrottleForTest, // exported for testing
  _setAdoTokenForTest, // exported for testing
};
