/**
 * engine/ado.js — Azure DevOps integration for Minions engine.
 * Extracted from engine.js: ADO token management, PR status polling, human comment polling.
 */

const path = require('path');
const shared = require('./shared');
const { exec, execAsync, getAdoOrgBase, addPrLink, log, ts, dateStamp, PR_STATUS } = shared;
const { getPrs } = require('./queries');
const { mutateJsonFileLocked } = shared;

// Lazy require to avoid circular dependency — only needed for engine().handlePostMerge
let _engine = null;
function engine() {
  if (!_engine) _engine = require('../engine');
  return _engine;
}

// ─── ADO Token Cache ─────────────────────────────────────────────────────────

let _adoTokenCache = { token: null, expiresAt: 0 };
let _adoTokenFailedUntil = 0; // backoff: skip azureauth calls until this timestamp

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
  const MAX_RETRIES = 1;
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body,
  });
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
  return JSON.parse(text);
}

/** Fetch raw text from ADO API (for build logs which aren't JSON). */
async function adoFetchText(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
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
        const branch = pr?.branch || pr?.sourceRefName?.replace('refs/heads/', '');
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
 * Iterate active PRs across all projects. Calls `callback(project, pr, prNum, orgBase)`
 * for each active PR. If callback returns truthy, the PR file is saved after the project loop.
 */
async function forEachActivePr(config, token, callback) {
  const projects = shared.getProjects(config);
  let totalUpdated = 0;

  for (const project of projects) {
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const prs = getPrs(project);
    const activePrs = prs.filter(pr => pr.status === PR_STATUS.ACTIVE);
    if (activePrs.length === 0) continue;

    let projectUpdated = 0;
    const orgBase = getAdoOrgBase(project);

    // Parallelize PR polling within each project (max 5 concurrent to avoid rate limits)
    const CONCURRENCY = 5;
    for (let i = 0; i < activePrs.length; i += CONCURRENCY) {
      const batch = activePrs.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (pr) => {
        const prNum = (pr.id || '').replace('PR-', '');
        if (!prNum) return false;
        return callback(project, pr, prNum, orgBase);
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) projectUpdated++;
        if (r.status === 'rejected') log('warn', `PR poll error: ${r.reason?.message || r.reason}`);
      }
    }

    if (projectUpdated > 0) {
      mutateJsonFileLocked(shared.projectPrPath(project), (currentPrs) => {
        // Only merge back PRs that the callback actually modified — not the entire
        // stale snapshot, which would overwrite concurrent writes from other code paths
        for (const updatedPr of activePrs) {
          const idx = currentPrs.findIndex(p => p.id === updatedPr.id);
          if (idx >= 0) currentPrs[idx] = updatedPr;
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
    _adoPollHadAuthFailure = true; // trigger retry on next tick
    return;
  }

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    try {
    const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}`;
    let updated = false;

    // Clear stale flag — we're attempting a fresh poll
    if (pr._buildStatusStale) { delete pr._buildStatusStale; updated = true; }

    const prData = await adoFetch(`${repoBase}?api-version=7.1`, token);

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
          delete pr.buildFixAttempts;
          delete pr.buildFixEscalated;
        }
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

    const reviewers = prData.reviewers || [];
    const votes = reviewers.map(r => r.vote).filter(v => v !== undefined);
    let newReviewStatus = pr.reviewStatus || 'pending';
    // Once approved, it stays approved permanently
    if (pr.reviewStatus === 'approved') {
      newReviewStatus = 'approved';
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
      // Update author metrics when verdict changes to approved/rejected
      if (newReviewStatus === 'approved' || newReviewStatus === 'changes-requested') {
        const authorId = (pr.agent || '').toLowerCase();
        if (authorId) {
          try {
            const metricsPath = path.join(__dirname, 'metrics.json');
            mutateJsonFileLocked(metricsPath, (metrics) => {
              if (!metrics[authorId]) metrics[authorId] = {};
              if (newReviewStatus === 'approved') metrics[authorId].prsApproved = (metrics[authorId].prsApproved || 0) + 1;
              else metrics[authorId].prsRejected = (metrics[authorId].prsRejected || 0) + 1;
              return metrics;
            });
          } catch (err) { log('warn', `Metrics update: ${err.message}`); }
        }
        if (newReviewStatus === 'approved') {
          delete pr._reviewFixCycles;
          delete pr._evalEscalated;
        }
      }
    }

    if (newStatus !== PR_STATUS.ACTIVE) return updated;

    // Query builds API directly — status checks (/statuses) are unreliable (stale codecoverage postbacks)
    // Use the merge commit hash to find builds for this PR
    const mergeCommitId = prData.lastMergeCommit?.commitId;
    let buildStatus = 'none';
    let buildFailReason = '';
    let buildStatuses = []; // for error log fetching

    if (mergeCommitId) {
      try {
        // Find builds for this PR — filter by source branch to avoid scanning all org builds
        const sourceBranch = prData.sourceRefName || '';
        const branchFilter = sourceBranch ? `&branchName=${sourceBranch}` : '';
        const buildsUrl = `${orgBase}/${project.adoProject}/_apis/build/builds?$top=10${branchFilter}&api-version=7.1`;
        const buildsData = await adoFetch(buildsUrl, token);
        // Match by exact merge commit — only current builds, not stale
        const prBuilds = (buildsData?.value || []).filter(b => b.sourceVersion === mergeCommitId);

        if (prBuilds.length > 0) {
          // partiallySucceeded = warnings, not failures — counts as passing
          const hasFailed = prBuilds.some(b => b.result === 'failed' || b.result === 'canceled');
          const allDone = prBuilds.every(b => b.status === 'completed');
          const allPassed = prBuilds.every(b => b.result === 'succeeded' || b.result === 'partiallySucceeded');
          const hasRunning = prBuilds.some(b => b.status === 'inProgress' || b.status === 'notStarted');

          if (hasFailed && allDone) {
            buildStatus = 'failing';
            const failed = prBuilds.find(b => b.result === 'failed');
            buildFailReason = failed?.definition?.name || 'Build failed';
            // Build fake status objects for error log fetching
            buildStatuses = prBuilds.filter(b => b.result === 'failed').map(b => ({
              state: 'failed', targetUrl: `${orgBase}/${project.adoProject}/_build/results?buildId=${b.id}`,
              _buildId: String(b.id),
            }));
          } else if (allDone && allPassed) {
            buildStatus = 'passing';
          } else if (hasRunning) {
            buildStatus = 'running';
          }
        }
      } catch (e) { log('warn', `ADO build query for ${pr.id}: ${e.message}`); }
    }

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
        delete pr.buildErrorLog;
        // Reset build fix retry counter on recovery — allows fresh auto-fix cycles if build breaks again
        if (pr.buildFixAttempts) { delete pr.buildFixAttempts; delete pr.buildFixEscalated; }
      }
      updated = true;

      // Fetch actual compiler/build error logs when transitioning to failing
      if (buildStatus === 'failing') {
        const failedStatusObjs = buildStatuses.filter(s => s.state === 'failed' || s.state === 'error').slice(0, 10);
        const logParts = [];
        const seenBuildIds = new Set();
        for (const failedStatusObj of failedStatusObjs) {
          const errorLog = await fetchAdoBuildErrorLog(orgBase, project, failedStatusObj, token, pr, seenBuildIds);
          if (errorLog) logParts.push(errorLog);
        }
        if (logParts.length > 0) {
          pr.buildErrorLog = logParts.join('\n\n');
          log('info', `PR ${pr.id}: fetched error logs from ${logParts.length} failing pipeline(s)`);
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
          const autoCompleteUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}?api-version=7.1`;
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
      updated = true;
    }

    return updated;
    } catch (err) {
      // Auth errors → mark build status stale so dashboard shows uncertainty
      // and engine re-polls on next tick instead of waiting 6 ticks
      if (isAdoAuthError(err)) {
        pr._buildStatusStale = true;
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

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    const threadsUrl = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}/threads?api-version=7.1`;
    const threadsData = await adoFetch(threadsUrl, token);
    const threads = threadsData.value || [];

    const cutoffStr = pr.humanFeedback?.lastProcessedCommentDate || pr.created || '1970-01-01';
    const cutoffMs = new Date(cutoffStr).getTime() || 0;

    // Collect ALL human comments on the PR for full context
    const allHumanComments = [];
    const newHumanComments = [];
    const ignoredAuthors = (config.engine?.ignoredCommentAuthors || []).map(a => a.toLowerCase());

    for (const thread of threads) {
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
      return false;
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
    if (!project.adoOrg || !project.adoProject || !project.repositoryId) continue;

    const orgBase = shared.getAdoOrgBase(project);
    const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests?searchCriteria.status=active&api-version=7.1`;

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
    const existingIds = new Set(existingPrs.map(p => p.id));
    let projectAdded = 0;

    // Load work items to match branches to work item IDs
    const wiPath = shared.projectWorkItemsPath(project);
    const workItems = shared.safeJson(wiPath) || [];
    const centralWiPath = path.join(shared.MINIONS_DIR, 'work-items.json');
    const centralItems = shared.safeJson(centralWiPath) || [];
    const allItems = [...workItems, ...centralItems];

    let projectUpdated = 0;
    for (const adoPr of adoPrs) {
      const prId = `PR-${adoPr.pullRequestId}`;
      const branch = (adoPr.sourceRefName || '').replace('refs/heads/', '');
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
        // PR already tracked — write link to pr-links.json if we can extract an ID
        if (confirmedItemId) {
          addPrLink(prId, confirmedItemId);
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

      const prUrl = project.prUrlBase ? project.prUrlBase + adoPr.pullRequestId : '';
      existingPrs.push({
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
      });
      addPrLink(prId, confirmedItemId);
      existingIds.add(prId);
      projectAdded++;
      log('info', `PR reconciliation: added ${prId} (branch: ${branch}, linked to ${confirmedItemId}) to ${project.name}`);
    }

    // Backfill prNumber from pr.id for any PR missing it (e.g. created before prNumber was stored)
    for (const pr of existingPrs) {
      if (pr.prNumber == null) {
        const derived = parseInt((pr.id || '').replace(/^PR-/, ''), 10);
        if (derived) pr.prNumber = derived;
      }
    }

    // Backfill prdItems from pr-links for any PR with empty array
    const prLinks = shared.getPrLinks();
    let backfilled = 0;
    for (const pr of existingPrs) {
      const linked = prLinks[pr.id];
      if (linked && !(pr.prdItems || []).includes(linked)) {
        pr.prdItems = Array.isArray(pr.prdItems) ? pr.prdItems : [];
        pr.prdItems.push(linked);
        backfilled++;
      }
    }

    if (projectAdded > 0 || projectUpdated > 0 || backfilled > 0) {
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
    const prNum = (pr.id || '').replace(/^PR-/, '');
    const url = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}?api-version=7.1`;
    const result = await execAsync(`curl -s --max-time 4 -H "Authorization: Bearer ${token}" "${url}"`, { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    const prData = JSON.parse(result);
    const votes = (prData.reviewers || []).map(r => r.vote).filter(v => v !== undefined);
    if (votes.length === 0) return 'pending';
    if (votes.some(v => v === -10)) return 'changes-requested';
    if (votes.some(v => v >= 5)) return 'approved';
    if (votes.some(v => v === -5)) return 'waiting';
    return 'pending';
  } catch (e) {
    log('warn', `Live review check for ${pr.id}: ${e.message}`);
    return null;
  }
}

module.exports = {
  getAdoToken,
  adoFetch,
  pollPrStatus,
  pollPrHumanComments,
  reconcilePrs,
  checkLiveReviewStatus,
  needsAdoPollRetry,
  isAdoAuthError, // exported for testing
};

