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

async function adoFetch(url, token, _retryCount = 0) {
  const MAX_RETRIES = 1;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`ADO API ${res.status}: ${res.statusText}`);
  const text = await res.text();
  if (!text || text.trimStart().startsWith('<')) {
    // Invalidate cached token — it's likely expired
    _adoTokenCache = { token: null, expiresAt: 0 };
    if (_retryCount < MAX_RETRIES) {
      const freshToken = await getAdoToken();
      if (freshToken) {
        log('info', 'ADO token expired mid-session — refreshed and retrying');
        return adoFetch(url, freshToken, _retryCount + 1);
      }
    }
    throw new Error(`ADO returned HTML instead of JSON (likely auth redirect) for ${url.split('?')[0]}`);
  }
  return JSON.parse(text);
}

/** Fetch raw text from ADO API (for build logs which aren't JSON). */
async function adoFetchText(url, token) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
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
async function fetchAdoBuildErrorLog(orgBase, project, failedStatus, token) {
  try {
    // Extract buildId from the targetUrl (e.g. .../_build/results?buildId=12345)
    const targetUrl = failedStatus?.targetUrl || '';
    const buildIdMatch = targetUrl.match(/buildId=(\d+)/);
    if (!buildIdMatch) {
      log('debug', `No buildId in targetUrl: ${targetUrl.slice(0, 120)}`);
      return null;
    }
    const buildId = buildIdMatch[1];

    // Fetch build timeline to find failed tasks
    const timelineUrl = `${orgBase}/${project.adoProject}/_apis/build/builds/${buildId}/timeline?api-version=7.1`;
    const timeline = await adoFetch(timelineUrl, token);
    if (!timeline?.records) return null;

    // Find failed records that have logs
    const failedRecords = timeline.records.filter(r =>
      r.result === 'failed' && r.log?.id
    );
    if (failedRecords.length === 0) return null;

    // Fetch logs for failed tasks (cap at 3 to limit API calls)
    const logParts = [];
    for (const record of failedRecords.slice(0, 3)) {
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
  const token = await getAdoToken();
  if (!token) {
    log('warn', 'Skipping PR status poll — no ADO token available');
    return;
  }

  const totalUpdated = await forEachActivePr(config, token, async (project, pr, prNum, orgBase) => {
    const repoBase = `${orgBase}/${project.adoProject}/_apis/git/repositories/${project.repositoryId}/pullrequests/${prNum}`;
    let updated = false;

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
        }
        await engine().handlePostMerge(pr, project, config, newStatus);
      }
    }

    // Track head commit changes to detect new pushes (used for review re-dispatch gating)
    const headCommit = prData.lastMergeSourceCommit?.commitId || prData.sourceRefName || '';
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
    if (votes.length > 0) {
      if (votes.some(v => v === -10)) {
        // Don't re-trigger 'changes-requested' if fix agent already responded (waiting state).
        // Only re-trigger if there's been a new push since the fix (reviewer re-reviewed).
        if (pr.reviewStatus === 'waiting' && pr.minionsReview?.fixedAt && (!pr.lastPushedAt || pr.lastPushedAt <= pr.minionsReview.fixedAt)) {
          newReviewStatus = 'waiting'; // fix was submitted, same vote still present — wait for re-review
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
      }
    }

    if (newStatus !== PR_STATUS.ACTIVE) return updated;

    const statusData = await adoFetch(`${repoBase}/statuses?api-version=7.1`, token);

    const latest = new Map();
    for (const s of statusData.value || []) {
      const key = (s.context?.genre || '') + '/' + (s.context?.name || '');
      if (!latest.has(key)) latest.set(key, s);
    }

    const buildStatuses = [...latest.values()].filter(s => {
      const ctx = ((s.context?.genre || '') + '/' + (s.context?.name || '')).toLowerCase();
      return /\bcodecoverage\b/.test(ctx) || /\bbuild\b/.test(ctx) ||
             /\bdeploy\b/.test(ctx) || /(?:^|\/)ci(?:\/|$)/.test(ctx);
    });

    let buildStatus = 'none';
    let buildFailReason = '';

    if (buildStatuses.length > 0) {
      const states = buildStatuses.map(s => s.state).filter(Boolean);
      const hasFailed = states.some(s => s === 'failed' || s === 'error');
      const allDone = states.every(s => s === 'succeeded' || s === 'notApplicable');
      const hasQueued = buildStatuses.some(s => !s.state);

      if (hasFailed) {
        buildStatus = 'failing';
        const failed = buildStatuses.find(s => s.state === 'failed' || s.state === 'error');
        buildFailReason = failed?.description || failed?.context?.name || 'Build failed';
      } else if (allDone && !hasQueued) {
        buildStatus = 'passing';
      } else {
        buildStatus = 'running';
      }
    }

    if (pr.buildStatus !== buildStatus) {
      log('info', `PR ${pr.id} build: ${pr.buildStatus || 'none'} → ${buildStatus}${buildFailReason ? ' (' + buildFailReason + ')' : ''}`);
      pr.buildStatus = buildStatus;
      if (buildFailReason) pr.buildFailReason = buildFailReason;
      else delete pr.buildFailReason;
      if (buildStatus !== 'failing') {
        delete pr._buildFailNotified;
        delete pr.buildErrorLog;
      }
      updated = true;

      // Fetch actual compiler/build error logs when transitioning to failing
      if (buildStatus === 'failing') {
        const failedStatusObj = buildStatuses.find(s => s.state === 'failed' || s.state === 'error');
        const errorLog = await fetchAdoBuildErrorLog(orgBase, project, failedStatusObj, token);
        if (errorLog) {
          pr.buildErrorLog = errorLog;
          log('info', `PR ${pr.id}: fetched ${errorLog.split('\n').length} lines of build error log`);
        }
      }
    }

    return updated;
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

    for (const thread of threads) {
      for (const comment of (thread.comments || [])) {
        if (!comment.content || comment.commentType === 'system') continue;
        if (/\bMinions\s*\(/i.test(comment.content)) continue; // skip minions's own comments

        const entry = {
          threadId: thread.id,
          commentId: comment.id,
          author: comment.author?.displayName || 'Human',
          content: comment.content,
          date: comment.publishedDate
        };
        allHumanComments.push(entry);

        // Track which comments are new (for triggering — any new comment triggers a fix)
        const commentMs = comment.publishedDate ? new Date(comment.publishedDate).getTime() : 0;
        if (commentMs && commentMs > cutoffMs) {
          newHumanComments.push(entry);
        }
      }
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
        // PR already tracked — write link to pr-links.json if we can extract an ID
        if (confirmedItemId) {
          addPrLink(prId, confirmedItemId);
          const existing = existingPrs.find(p => p.id === prId);
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
};

